import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { InvocationCredential, ThreadContextInput, TurnExecution } from "@superagentteam/shared/types";
import type { InvocationCredentialStore } from "../auth/store.ts";
import type { TurnExecutionStore } from "../invocation/store.ts";
import type { MultiMentionInput, MultiMentionOrchestrator } from "../multi-mention/orchestrator.ts";
import type { WorkerBindingStore, WorkerStore } from "../worker/store.ts";
import type { ThreadContextService } from "./thread-context.ts";
import {
	type A2AToolContext,
	A2AToolError,
	type A2AToolService,
	type CrossPostMessageInput,
	type PostMessageInput,
} from "./tool-service.ts";
import { A2A_V1_TOOL_NAMES, type A2A_V1ToolName } from "./tool-surface.ts";

// F018 R5-a: credential-scoped local control channel for the v1 pi extension.
// A worker process authenticates with its child-TurnExecution token; the
// server re-checks credential state, worker binding, and running turn before
// dispatching to the four A2A services. No task/role/run coordinates.

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_CONNECTIONS = 128;
const DEFAULT_LEASE_TTL_MS = 300_000;

export type A2AControlErrorCode =
	| "invalid_request"
	| "invalid_token"
	| "worker_mismatch"
	| "turn_not_running"
	| "unknown_tool"
	| "internal_error";

export class A2AControlError extends Error {
	readonly code: A2AControlErrorCode;

	constructor(code: A2AControlErrorCode, message?: string) {
		super(message ?? code);
		this.code = code;
		this.name = "A2AControlError";
	}
}

export interface A2AControlServerDeps {
	socketPath: string;
	credentials: InvocationCredentialStore;
	turns: TurnExecutionStore;
	workers: WorkerStore;
	bindings: WorkerBindingStore;
	a2aTools: A2AToolService;
	multiMention: MultiMentionOrchestrator;
	threadContext: ThreadContextService;
	clock?: () => number;
	leaseTtlMs?: number;
}

interface ControlRequest {
	id?: string;
	type?: string;
	workerId?: string;
	token?: string;
	toolName?: string;
	input?: Record<string, unknown>;
	piExtToolCallId?: string;
}

export function defaultA2AControlSocketPath(dataDir: string): string {
	if (process.platform === "win32") return `\\\\.\\pipe\\superagentteam-a2a-${process.pid}`;
	const preferred = join(dataDir, "a2a.sock");
	if (Buffer.byteLength(preferred, "utf8") <= 100) return preferred;
	const hash = createHash("sha256").update(dataDir).digest("hex").slice(0, 16);
	const user = typeof process.getuid === "function" ? String(process.getuid()) : "user";
	return join(tmpdir(), `superagentteam-a2a-${user}`, `a2a-${hash}.sock`);
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new A2AControlError("invalid_request", `${field} is required`);
	}
	return value;
}

function objectInput(value: unknown): Record<string, unknown> {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new A2AControlError("invalid_request", "input must be an object");
	}
	return value as Record<string, unknown>;
}

export class A2AControlServer {
	readonly socketPath: string;
	private readonly deps: A2AControlServerDeps;
	private readonly clock: () => number;
	private readonly leaseTtlMs: number;
	private server: Server | null = null;
	private readonly sockets = new Set<Socket>();
	private started = false;

	constructor(deps: A2AControlServerDeps) {
		this.deps = deps;
		this.socketPath = deps.socketPath;
		this.clock = deps.clock ?? Date.now;
		this.leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
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
			const onError = (error: Error): void => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = (): void => {
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
		const close = (): void => {
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
			const result = await this.handle(request);
			this.reply(socket, { id: request.id, ok: true, result });
		} catch (error) {
			if (error instanceof A2AControlError || error instanceof A2AToolError) {
				this.reply(socket, { id: request.id, ok: false, error: { code: error.code, message: error.message } });
				return;
			}
			this.reply(socket, {
				id: request.id,
				ok: false,
				error: {
					code: "internal_error",
					message: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	private async handle(request: ControlRequest): Promise<unknown> {
		if (request.type === "heartbeat") {
			const workerId = requiredString(request.workerId, "workerId");
			this.resolveWorker(request, false);
			this.deps.workers.heartbeat(workerId, this.clock(), this.leaseTtlMs);
			return { workerId };
		}
		if (request.type === "a2a_call") return this.handleA2ACall(request);
		throw new A2AControlError("invalid_request", `unknown control request type ${String(request.type)}`);
	}

	private handleA2ACall(request: ControlRequest): unknown {
		const toolName = requiredString(request.toolName, "toolName") as A2A_V1ToolName;
		if (!(A2A_V1_TOOL_NAMES as readonly string[]).includes(toolName)) {
			throw new A2AControlError("unknown_tool", `unknown A2A tool ${toolName}`);
		}
		const piExtToolCallId = requiredString(request.piExtToolCallId, "piExtToolCallId");
		const input = objectInput(request.input);
		const { credential, turn } = this.resolveWorker(request, true);
		const credentialTool = toolName.slice("superagentteam_".length);
		if (!credential.allowedTools.includes(credentialTool)) {
			throw new A2AToolError("tool_not_allowed", `credential does not allow ${toolName}`);
		}
		const ctx: A2AToolContext = {
			threadId: credential.threadId,
			userId: credential.userId,
			callerAgentId: credential.agentId,
			callerTurnExecutionId: credential.turnExecutionId,
			piExtToolCallId,
			triggerMessageId: turn.causal.triggerMessageId,
			a2aDepth: turn.causal.a2aDepth ?? 0,
			multiMentionCallbackDepth: turn.causal.multiMentionCallbackDepth ?? null,
			now: this.clock(),
		};
		switch (toolName) {
			case "superagentteam_post_message":
				return this.deps.a2aTools.postMessage(ctx, input as unknown as PostMessageInput);
			case "superagentteam_cross_post_message":
				return this.deps.a2aTools.crossPostMessage(ctx, input as unknown as CrossPostMessageInput);
			case "superagentteam_multi_mention":
				return this.deps.multiMention.create(ctx, input as unknown as MultiMentionInput);
			case "superagentteam_thread_context":
				return this.deps.threadContext.read(
					{
						threadId: credential.threadId,
						userId: credential.userId,
						callerAgentId: credential.agentId,
					},
					input as ThreadContextInput,
				);
		}
	}

	private resolveWorker(
		request: ControlRequest,
		requireRunningTurn: boolean,
	): { credential: InvocationCredential; turn: TurnExecution } {
		const workerId = requiredString(request.workerId, "workerId");
		const token = requiredString(request.token, "token");
		const verified = this.deps.credentials.verifyToken(token);
		if (!verified.ok) throw new A2AControlError("invalid_token", verified.reason);
		const credential = verified.credential;
		const binding = this.deps.bindings.getBySession(credential.agentSessionId);
		if (!binding || binding.workerId !== workerId) {
			throw new A2AControlError("worker_mismatch", "worker is not bound to this credential session");
		}
		const turn = this.deps.turns.get(credential.turnExecutionId);
		if (!turn) throw new A2AControlError("turn_not_running", "turn execution not found");
		if (requireRunningTurn && turn.status !== "running") {
			throw new A2AControlError("turn_not_running", `turn is ${turn.status}`);
		}
		return { credential, turn };
	}

	private reply(socket: Socket, payload: Record<string, unknown>): void {
		if (socket.destroyed) return;
		socket.write(`${JSON.stringify(payload)}\n`);
	}
}
