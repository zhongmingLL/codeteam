import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveRunPrincipal } from "../a2a/principal.ts";
import { A2A_TOOL_NAMES } from "../a2a/tool-surface.ts";
import { type A2ASendInput, A2AToolHandlers, type HandoffCreateInput } from "../a2a/tools.ts";
import { resolveInvocationToken } from "../auth/resolver.ts";
import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { AgentSession, Run, Task } from "../control/stores/types.ts";
import type { WorkerRegistry } from "./registry.ts";
import { evaluateWorkerToolCall, type WorkerToolCall } from "./tool-policy.ts";

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_CONNECTIONS = 128;

export interface WorkerControlServerOptions {
	readonly store: ControlStore;
	readonly registry: WorkerRegistry;
	readonly dataDir: string;
	readonly socketPath?: string;
	readonly clock?: () => number;
}

interface ControlRequest {
	readonly id?: string;
	readonly type?: string;
	readonly workerId?: string;
	readonly token?: string;
	readonly toolName?: string;
	readonly input?: Record<string, unknown>;
	readonly pid?: number;
}

export class WorkerControlServer {
	readonly store: ControlStore;
	readonly registry: WorkerRegistry;
	readonly dataDir: string;
	readonly socketPath: string;
	private readonly clock: () => number;
	private server: Server | null = null;
	private readonly sockets = new Set<Socket>();
	private started = false;

	constructor(options: WorkerControlServerOptions) {
		this.store = options.store;
		this.registry = options.registry;
		this.dataDir = options.dataDir;
		this.socketPath = options.socketPath ?? defaultSocketPath(options.dataDir);
		this.clock = options.clock ?? Date.now;
	}

	get isStarted(): boolean {
		return this.started;
	}

	async start(): Promise<string> {
		if (this.started) return this.socketPath;
		if (process.platform !== "win32") {
			const socketDir = dirname(this.socketPath);
			mkdirSync(socketDir, { recursive: true, mode: 0o700 });
			chmodSync(socketDir, 0o700);
			if (existsSync(this.socketPath)) {
				try {
					unlinkSync(this.socketPath);
				} catch {
					// A live server may still own the path; listen will fail closed.
				}
			}
		}
		const server = createServer((socket) => this.accept(socket));
		server.maxConnections = MAX_CONNECTIONS;
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(this.socketPath);
		});
		if (process.platform !== "win32") chmodSync(this.socketPath, 0o600);
		this.server = server;
		this.started = true;
		return this.socketPath;
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		const server = this.server;
		this.server = null;
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		if (process.platform !== "win32" && existsSync(this.socketPath)) {
			try {
				unlinkSync(this.socketPath);
			} catch {
				// Best effort cleanup.
			}
		}
	}

	private accept(socket: Socket): void {
		this.sockets.add(socket);
		let buffer = "";
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			this.sockets.delete(socket);
			socket.destroy();
		};
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			while (true) {
				const index = buffer.indexOf("\n");
				if (index < 0) break;
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
					close();
					return;
				}
				void this.handleLine(socket, line);
			}
			if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) close();
		});
		socket.on("close", () => this.sockets.delete(socket));
		socket.on("error", () => this.sockets.delete(socket));
	}

	private async handleLine(socket: Socket, line: string): Promise<void> {
		const trimmed = line.trim();
		if (trimmed === "") return;
		let request: ControlRequest;
		try {
			request = JSON.parse(trimmed) as ControlRequest;
		} catch {
			this.reply(socket, { ok: false, error: { code: "invalid_json", message: "invalid JSON request" } });
			return;
		}
		try {
			const response = await this.handle(request);
			this.reply(socket, { id: request.id, ...response });
		} catch (error) {
			const code = error instanceof ControlError ? error.code : "control_error";
			const message = error instanceof Error ? error.message : String(error);
			this.reply(socket, { id: request.id, ok: false, error: { code, message } });
		}
	}

	private async handle(request: ControlRequest): Promise<Record<string, unknown>> {
		if (request.type === "heartbeat") {
			const worker = this.registry.heartbeat(required(request.workerId, "workerId"), request.pid ?? null);
			return { ok: true, worker: { id: worker.id, state: worker.state, leaseExpiresAt: worker.leaseExpiresAt } };
		}
		if (request.type === "tool_policy") {
			const toolName = required(request.toolName, "toolName");
			const input = objectInput(request.input);
			const { workerId, binding, run, session, task } = this.resolveWorkerBinding(request);
			this.assertCredentialAllowsTool(binding.credentialId, toolName);
			this.registry.heartbeat(workerId);
			const decision = evaluateWorkerToolCall({ role: session.role, task, dataDir: this.dataDir, runId: run.id }, {
				toolName,
				input,
			} satisfies WorkerToolCall);
			if (!decision.allow) {
				this.store.audit.append({
					actor: "system:worker-control",
					action: "worker_tool_denied",
					subject: `run:${run.id}`,
					args: { workerId, toolName, code: decision.code ?? null, reason: decision.reason ?? null },
				});
			}
			return { ok: true, allow: decision.allow, code: decision.code ?? null, reason: decision.reason ?? null };
		}
		if (request.type === "a2a_call") {
			const toolName = required(request.toolName, "toolName");
			if (!(A2A_TOOL_NAMES as readonly string[]).includes(toolName)) {
				throw new ControlError("invalid_input", `unknown A2A tool ${toolName}`);
			}
			const input = objectInput(request.input);
			const { workerId, binding, run } = this.resolveWorkerBinding(request);
			this.assertCredentialAllowsTool(binding.credentialId, toolName);
			this.registry.heartbeat(workerId);
			const handlers = new A2AToolHandlers({
				store: this.store,
				principal: resolveRunPrincipal(this.store, run.id),
				clock: this.clock,
			});
			const result = this.invokeA2ATool(handlers, toolName, input);
			return { ok: true, result };
		}
		throw new ControlError("invalid_input", `unknown control request type ${String(request.type)}`);
	}

	private resolveWorkerBinding(request: ControlRequest): {
		workerId: string;
		binding: ReturnType<typeof resolveInvocationToken>;
		run: Run;
		session: AgentSession;
		task: Task;
	} {
		const workerId = required(request.workerId, "workerId");
		const token = required(request.token, "token");
		const binding = resolveInvocationToken(this.store, token, { now: this.clock() });
		const run = this.store.runs.get(binding.runId);
		if (!run || run.status !== "running") {
			throw new ControlError("invalid_state", `run ${binding.runId} is not running`);
		}
		if (run.workerId !== workerId) {
			throw new ControlError("forbidden", `run ${run.id} is not assigned to worker ${workerId}`);
		}
		const session = this.store.sessions.get(binding.agentSessionId);
		if (!session || session.workerId !== workerId) {
			throw new ControlError("forbidden", `session ${binding.agentSessionId} is not bound to worker ${workerId}`);
		}
		const task = this.store.tasks.get(run.taskId);
		if (!task) throw new ControlError("not_found", `task ${run.taskId} not found`);
		return { workerId, binding, run, session, task };
	}

	private assertCredentialAllowsTool(credentialId: string, toolName: string): void {
		const credential = this.store.credentials.get(credentialId);
		if (!credential) throw new ControlError("invalid_token", "invocation credential not found");
		const allowed = credential.toolPolicy.allowedTools;
		if (!Array.isArray(allowed) || allowed.length === 0) return;
		if (!allowed.some((entry) => entry === toolName)) {
			throw new ControlError("forbidden", `credential does not allow tool ${toolName}`);
		}
	}

	private invokeA2ATool(handlers: A2AToolHandlers, toolName: string, input: Record<string, unknown>): unknown {
		switch (toolName) {
			case "a2a_send":
				return handlers.send(input as unknown as A2ASendInput);
			case "handoff_create":
				return handlers.createHandoff(input as unknown as HandoffCreateInput);
			case "handoff_claim":
				return handlers.claimHandoff(requiredInputString(input, "handoffId"));
			case "handoff_complete": {
				const result = input.result;
				if (!result || typeof result !== "object" || Array.isArray(result)) {
					throw new ControlError("invalid_input", "result must be an object");
				}
				return handlers.completeHandoff(
					requiredInputString(input, "handoffId"),
					requiredInputString(input, "evidenceRef"),
					result as Record<string, unknown>,
				);
			}
			case "handoff_withdraw":
				return handlers.withdrawHandoff(
					requiredInputString(input, "handoffId"),
					requiredInputString(input, "reason"),
				);
			default:
				throw new ControlError("invalid_input", `unknown A2A tool ${toolName}`);
		}
	}

	private reply(socket: Socket, payload: Record<string, unknown>): void {
		if (socket.destroyed) return;
		socket.write(`${JSON.stringify(payload)}\n`);
	}
}

function required(value: string | undefined, field: string): string {
	if (!value || value.trim() === "") throw new ControlError("invalid_input", `${field} is required`);
	return value;
}

function objectInput(value: Record<string, unknown> | undefined): Record<string, unknown> {
	if (value === undefined) return {};
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ControlError("invalid_input", "tool input must be an object");
	}
	return value;
}

function requiredInputString(input: Record<string, unknown>, field: string): string {
	const value = input[field];
	if (typeof value !== "string" || value.trim() === "") {
		throw new ControlError("invalid_input", `${field} is required`);
	}
	return value;
}

export function defaultSocketPath(dataDir: string): string {
	if (process.platform === "win32") return `\\\\.\\pipe\\codeteam-worker-control-${process.pid}`;
	const preferred = join(dataDir, "wc.sock");
	if (Buffer.byteLength(preferred, "utf8") <= 100) return preferred;
	const hash = createHash("sha256").update(dataDir).digest("hex").slice(0, 16);
	const user = typeof process.getuid === "function" ? String(process.getuid()) : "user";
	return join(tmpdir(), `codeteam-wc-${user}`, `wc-${hash}.sock`);
}
