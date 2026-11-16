import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeSecretFile } from "../auth/tokens.ts";
import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import { newId } from "../control/stores/helpers.ts";
import type { AgentSession, Task, Worker } from "../control/stores/types.ts";
import { buildWorkerSystemPrompt } from "./prompt.ts";
import type { WorkerRegistry } from "./registry.ts";
import { RpcConnection } from "./rpc-client.ts";
import { allowedToolsForRole } from "./tool-policy.ts";

export interface WorkerHarnessOptions {
	readonly store: ControlStore;
	readonly registry: WorkerRegistry;
	readonly dataDir: string;
	readonly cliPath: string;
	readonly workerAgentDir: string;
	readonly sessionDir: string;
	readonly controlSocketPath: string;
	readonly extensionPath?: string;
	readonly promptTimeoutMs?: number;
	readonly offline?: boolean;
	readonly extraArgs?: readonly string[];
	readonly env?: Record<string, string | undefined>;
	readonly clock?: () => number;
}

export interface WorkerHandle {
	readonly worker: Worker;
	readonly session: AgentSession;
	readonly connection: RpcConnection;
	readonly tokenFile: string;
	readonly reattach: "none" | "session_file" | "fresh";
	readonly degradedReason: string | null;
}

export interface EnsureWorkerInput {
	readonly sessionId: string;
	readonly task: Task;
	readonly runId: string;
}

export interface EnsureWorkerResult {
	readonly handle: WorkerHandle;
	readonly reattached: boolean;
	readonly degradedReason: string | null;
}

interface SpawnInput extends EnsureWorkerInput {
	readonly forceFresh: boolean;
	readonly degradedReason: string | null;
}

export class WorkerHarness {
	readonly options: WorkerHarnessOptions;
	readonly store: ControlStore;
	readonly registry: WorkerRegistry;
	private readonly handles = new Map<string, WorkerHandle>();
	private readonly locks = new SessionLock();

	constructor(options: WorkerHarnessOptions) {
		this.options = options;
		this.store = options.store;
		this.registry = options.registry;
	}

	getHandle(workerId: string): WorkerHandle | null {
		return this.handles.get(workerId) ?? null;
	}

	activeWorkerIds(): string[] {
		return [...this.handles.keys()];
	}

	writeToken(handle: WorkerHandle, token: string): void {
		mkdirSync(dirname(handle.tokenFile), { recursive: true, mode: 0o700 });
		writeSecretFile(handle.tokenFile, token);
	}

	clearToken(handle: WorkerHandle): void {
		try {
			unlinkSync(handle.tokenFile);
		} catch {
			// Best effort; the file is inside the daemon data dir.
		}
	}

	async ensureWorker(input: EnsureWorkerInput): Promise<EnsureWorkerResult> {
		const resolution = this.registry.resolveSessionWorker(input.sessionId);
		if (resolution.kind === "attached") {
			const handle = this.handles.get(resolution.worker.id);
			if (handle) return { handle, reattached: false, degradedReason: null };
			this.registry.markStale(resolution.worker.id, "worker_process_missing");
			this.registry.markSessionReattachPending(input.sessionId);
			return this.spawn({
				...input,
				forceFresh: false,
				degradedReason: null,
			});
		}
		if (resolution.kind === "reattach") {
			if (resolution.previousWorker && resolution.previousWorker.state === "online") {
				this.registry.markStale(resolution.previousWorker.id, "session_reattach_requested");
			}
			await this.releaseWorker(resolution.previousWorker?.id, "session_reattach", { keepBinding: true }).catch(
				() => {},
			);
			return this.spawn({
				...input,
				forceFresh: false,
				degradedReason: null,
			});
		}
		return this.spawn({ ...input, forceFresh: false, degradedReason: null });
	}

	async prompt(
		handle: WorkerHandle,
		input: { runId: string; token: string; prompt: string; timeoutMs?: number; signal?: AbortSignal },
	): Promise<{ aborted: boolean }> {
		return await this.locks.run(handle.session.id, async () => {
			this.writeToken(handle, input.token);
			try {
				return await handle.connection.promptAndWait(input.prompt, {
					timeoutMs: input.timeoutMs ?? this.options.promptTimeoutMs ?? 30 * 60 * 1000,
					signal: input.signal,
				});
			} finally {
				this.clearToken(handle);
			}
		});
	}

	async releaseWorker(
		workerId: string | undefined,
		reason: string,
		options: { keepBinding?: boolean } = {},
	): Promise<void> {
		if (!workerId) return;
		const handle = this.handles.get(workerId);
		this.handles.delete(workerId);
		if (handle) {
			this.clearToken(handle);
			await handle.connection.finish(reason).catch(() => {});
		}
		const worker = this.store.workers.get(workerId);
		if (worker && worker.state !== "retired") this.registry.retire(workerId, reason);
		if (!options.keepBinding && worker) {
			for (const session of this.store.sessions.list()) {
				if (session.workerId === workerId && session.status === "active") {
					this.registry.markSessionReattachPending(session.id);
				}
			}
		}
	}

	async releaseAll(reason = "shutdown"): Promise<void> {
		for (const workerId of [...this.handles.keys()]) {
			await this.releaseWorker(workerId, reason, { keepBinding: true });
		}
	}

	private async spawn(input: SpawnInput): Promise<EnsureWorkerResult> {
		const session = this.store.sessions.get(input.sessionId);
		if (!session) throw new ControlError("not_found", `agent session ${input.sessionId} not found`);
		const workerId = makeWorkerId(session.id);
		const now = this.options.clock?.() ?? Date.now();
		this.registry.register({ workerId, role: session.role, state: "starting" });
		const tokenFile = join(this.options.dataDir, "worker-runs", workerId, "token");
		const binding = sessionBinding(session);
		const sessionFile =
			!input.forceFresh && binding.sessionFile && existsSync(binding.sessionFile) ? binding.sessionFile : null;
		const usedSessionFile = sessionFile !== null;
		const degradedReason =
			input.degradedReason ??
			(!input.forceFresh && binding.sessionFile && !sessionFile && session.workerBindingState === "re_attach_pending"
				? `Previous pi session file is missing: ${binding.sessionFile}`
				: null);
		const args = this.workerArgs(session, workerId, sessionFile, input.forceFresh);
		const connection = new RpcConnection({
			cliPath: this.options.cliPath,
			cwd: input.task.worktree ?? process.cwd(),
			env: {
				...(this.options.env ?? process.env),
				PI_CODING_AGENT_DIR: this.options.workerAgentDir,
				CODETEAM_WORKER_ID: workerId,
				CODETEAM_CONTROL_SOCKET: this.options.controlSocketPath,
				CODETEAM_TOKEN_FILE: tokenFile,
				CODETEAM_HEARTBEAT_MS: String(this.registry.config.heartbeatIntervalMs),
			},
			args,
		});
		try {
			mkdirSync(this.options.workerAgentDir, { recursive: true, mode: 0o700 });
			mkdirSync(this.options.sessionDir, { recursive: true, mode: 0o700 });
			mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
			await connection.start();
			const state = await connection.getState();
			const piSessionId = typeof state.sessionId === "string" ? state.sessionId : null;
			const piSessionFile = typeof state.sessionFile === "string" ? state.sessionFile : sessionFile;
			const restoredIdMismatch =
				usedSessionFile &&
				binding.piSessionId !== null &&
				piSessionId !== null &&
				binding.piSessionId !== piSessionId;
			const effectiveDegradedReason = restoredIdMismatch
				? `${degradedReason ? `${degradedReason} ` : ""}Pi session id changed from ${binding.piSessionId} to ${piSessionId}.`
				: degradedReason;
			const online = this.registry.markOnline(workerId, connection.pid);
			const boundSession = this.registry.bindSession(session.id, workerId);
			this.store.sessions.updateRuntimeBinding(session.id, {
				piSessionId,
				nativeSessionBinding: {
					sessionFile: piSessionFile,
					piSessionId,
					workerId,
					degradedReason: effectiveDegradedReason,
				},
			});
			const handle: WorkerHandle = {
				worker: online,
				session: boundSession,
				connection,
				tokenFile,
				reattach: usedSessionFile ? "session_file" : input.forceFresh || effectiveDegradedReason ? "fresh" : "none",
				degradedReason: effectiveDegradedReason,
			};
			this.handles.set(workerId, handle);
			connection.onExit((exit) => {
				if (exit.expected) return;
				this.handles.delete(workerId);
				this.registry.markStale(workerId, "worker_process_exited");
				this.registry.markSessionReattachPending(session.id);
				this.store.audit.append({
					actor: "system:worker",
					action: "worker_process_exited",
					subject: `worker:${workerId}`,
					args: { code: exit.code, signal: exit.signal, stderrTail: connection.stderrTail.slice(-2000) },
				});
			});
			this.store.audit.append({
				actor: "system:worker",
				action: effectiveDegradedReason
					? "session_reattach_failed"
					: usedSessionFile
						? "session_reattached"
						: "worker_started",
				subject: usedSessionFile ? `session:${session.id}` : `worker:${workerId}`,
				args: {
					workerId,
					sessionId: session.id,
					piSessionId,
					sessionFile: piSessionFile,
					degradedReason: effectiveDegradedReason,
					at: now,
				},
			});
			return { handle, reattached: usedSessionFile && !restoredIdMismatch, degradedReason: effectiveDegradedReason };
		} catch (error) {
			await connection.finish("startup_failed").catch(() => {});
			this.registry.retire(workerId, "startup_failed");
			const message = error instanceof Error ? error.message : String(error);
			if (sessionFile && !input.forceFresh) {
				this.store.audit.append({
					actor: "system:worker",
					action: "session_reattach_failed",
					subject: `session:${session.id}`,
					args: { workerId, sessionFile, error: message, at: now },
				});
				return this.spawn({
					...input,
					forceFresh: true,
					degradedReason: `Previous pi session could not be re-attached: ${message}`,
				});
			}
			throw new WorkerStartError("worker_start_failed", message, { cause: error });
		}
	}

	private workerArgs(
		session: AgentSession,
		workerId: string,
		sessionFile: string | null,
		forceFresh: boolean,
	): string[] {
		const args = [
			"--mode",
			"rpc",
			"--no-extensions",
			"--extension",
			this.options.extensionPath ?? resolveWorkerExtensionPath(),
			"--no-context-files",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-mcp",
			"--approve",
			"--provider",
			session.provider,
			"--model",
			session.model,
			"--session-dir",
			this.options.sessionDir,
			"--tools",
			allowedToolsForRole(session.role).join(","),
			"--append-system-prompt",
			buildWorkerSystemPrompt(session.role),
			"--name",
			`codeteam ${workerId}`,
		];
		if (this.options.offline !== false) args.push("--offline");
		if (sessionFile && !forceFresh) {
			args.push("--session", sessionFile);
		} else {
			args.push("--session-id", freshPiSessionId(session));
		}
		args.push(...(this.options.extraArgs ?? []));
		return args;
	}
}

export class WorkerStartError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkerStartError";
		this.code = code;
	}
}

class SessionLock {
	private readonly tails = new Map<string, Promise<void>>();

	async run<T>(key: string, callback: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => gate);
		this.tails.set(key, tail);
		await previous;
		try {
			return await callback();
		} finally {
			release();
			if (this.tails.get(key) === tail) this.tails.delete(key);
		}
	}
}

function makeWorkerId(sessionId: string): string {
	const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
	return `rpc-${safe.slice(0, 48)}-${newId().slice(0, 8)}`;
}

function freshPiSessionId(session: AgentSession): string {
	const safe = session.id.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
	return `ct-${safe.slice(0, 40)}-${newId().slice(0, 8)}`;
}

function sessionBinding(session: AgentSession): { sessionFile: string | null; piSessionId: string | null } {
	const value = session.nativeSessionBinding;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { sessionFile: session.piSessionId, piSessionId: session.piSessionId };
	}
	const record = value as { sessionFile?: unknown; piSessionId?: unknown };
	return {
		sessionFile: typeof record.sessionFile === "string" ? record.sessionFile : session.piSessionId,
		piSessionId: typeof record.piSessionId === "string" ? record.piSessionId : session.piSessionId,
	};
}

export function resolveWorkerExtensionPath(): string {
	const here = fileURLToPath(import.meta.url);
	const dir = dirname(here);
	const js = join(dir, "worker-extension.js");
	if (existsSync(js)) return js;
	const ts = join(dir, "worker-extension.ts");
	if (existsSync(ts)) return ts;
	throw new ControlError("not_found", "codeteam worker extension not found");
}
