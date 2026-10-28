import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_RPC_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const DEFAULT_RPC_STDERR_BYTES = 8 * 1024;

export interface RpcConnectionOptions {
	readonly cliPath: string;
	readonly cwd: string;
	readonly env: Record<string, string | undefined>;
	readonly args?: readonly string[];
	readonly nodePath?: string;
	readonly maxFrameBytes?: number;
	readonly stderrBytes?: number;
}

export interface RpcEvent {
	readonly type: string;
	readonly [key: string]: unknown;
}

export interface RpcResponse {
	readonly id?: string;
	readonly type: "response";
	readonly command?: string;
	readonly success: boolean;
	readonly data?: unknown;
	readonly error?: string;
}

export interface RpcExitInfo {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly expected: boolean;
}

export class RpcProcessExitError extends Error {
	readonly exit: RpcExitInfo;
	readonly stderrTail: string;

	constructor(message: string, exit: RpcExitInfo, stderrTail: string) {
		super(message);
		this.name = "RpcProcessExitError";
		this.exit = exit;
		this.stderrTail = stderrTail;
	}
}

export class RpcProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpcProtocolError";
	}
}

export class RpcRequestError extends Error {
	readonly command: string | undefined;

	constructor(command: string | undefined, message: string) {
		super(message);
		this.name = "RpcRequestError";
		this.command = command;
	}
}

export class RpcTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpcTimeoutError";
	}
}

interface PendingRequest {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export class RpcConnection {
	readonly options: RpcConnectionOptions;
	private process: ChildProcess | null = null;
	private processAbort: AbortController | null = null;
	private pending = new Map<string, PendingRequest>();
	private eventListeners = new Set<(event: RpcEvent) => void>();
	private exitListeners = new Set<(exit: RpcExitInfo) => void>();
	private requestSeq = 0;
	private stdoutBuffer = "";
	private readonly decoder = new StringDecoder("utf8");
	private stderr = "";
	private expectedExit = false;
	private exitInfo: RpcExitInfo | null = null;
	private prompting = false;

	constructor(options: RpcConnectionOptions) {
		this.options = options;
	}

	get pid(): number | null {
		return this.process?.pid ?? null;
	}

	get stderrTail(): string {
		return this.stderr;
	}

	async start(): Promise<void> {
		if (this.process) throw new Error("RPC connection already started");
		const nodePath = this.options.nodePath ?? process.execPath;
		const controller = new AbortController();
		const child = spawn(nodePath, [this.options.cliPath, ...(this.options.args ?? [])], {
			cwd: this.options.cwd,
			env: Object.fromEntries(
				Object.entries(this.options.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
			),
			stdio: ["pipe", "pipe", "pipe"],
			signal: controller.signal,
		});
		this.process = child;
		this.processAbort = controller;
		this.expectedExit = false;
		this.exitInfo = null;
		child.stdout?.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
		child.stderr?.on("data", (chunk: Buffer) => this.consumeStderr(chunk));
		child.stdin?.on("error", (error) => this.failAll(new Error(`RPC stdin error: ${error.message}`)));
		child.once("error", (error) => {
			this.failAll(new Error(`RPC process error: ${error.message}`));
		});
		child.once("exit", (code, signal) => {
			const info: RpcExitInfo = { code, signal, expected: this.expectedExit };
			this.exitInfo = info;
			this.process = null;
			this.failAll(
				new RpcProcessExitError(
					`RPC process exited (code=${String(code)}, signal=${String(signal)})`,
					info,
					this.stderr,
				),
			);
			for (const listener of [...this.exitListeners]) listener(info);
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		const startupExit = this.exitInfo as RpcExitInfo | null;
		if (startupExit) {
			const info = startupExit;
			throw new RpcProcessExitError(
				`RPC process exited during startup (code=${String(info.code)}, signal=${String(info.signal)})`,
				info,
				this.stderr,
			);
		}
	}

	onEvent(listener: (event: RpcEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	onExit(listener: (exit: RpcExitInfo) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	async getState(): Promise<Record<string, unknown>> {
		const response = await this.request({ type: "get_state" }, 10_000);
		if (!response.data || typeof response.data !== "object") return {};
		return response.data as Record<string, unknown>;
	}

	async promptAndWait(
		message: string,
		options: { timeoutMs: number; signal?: AbortSignal },
	): Promise<{ aborted: boolean }> {
		if (this.prompting) throw new Error("RPC connection is already prompting");
		this.prompting = true;
		let accepted = false;
		let settledSeen = false;
		let resolveSettled!: (value: { aborted: boolean }) => void;
		let rejectSettled!: (error: Error) => void;
		const settled = new Promise<{ aborted: boolean }>((resolve, reject) => {
			resolveSettled = resolve;
			rejectSettled = reject;
		});
		const cleanup: Array<() => void> = [];
		const finish = (error?: Error, aborted = false) => {
			for (const off of cleanup.splice(0)) off();
			if (error) rejectSettled(error);
			else resolveSettled({ aborted });
		};
		cleanup.push(
			this.onEvent((event) => {
				if (event.type !== "agent_settled") return;
				if (!accepted) {
					settledSeen = true;
					return;
				}
				finish(undefined, event.aborted === true);
			}),
		);
		cleanup.push(
			this.onExit((exit) => {
				finish(
					new RpcProcessExitError(
						`RPC process exited during prompt (code=${String(exit.code)}, signal=${String(exit.signal)})`,
						exit,
						this.stderr,
					),
				);
			}),
		);
		const timer = setTimeout(() => {
			finish(new RpcTimeoutError(`RPC prompt timed out after ${options.timeoutMs}ms`));
			void this.finish("timeout").catch(() => {});
		}, options.timeoutMs);
		cleanup.push(() => clearTimeout(timer));
		const onAbort = () => {
			void this.abort().catch(() => {});
		};
		if (options.signal) {
			if (options.signal.aborted) onAbort();
			else {
				options.signal.addEventListener("abort", onAbort, { once: true });
				cleanup.push(() => options.signal?.removeEventListener("abort", onAbort));
			}
		}
		try {
			const response = await this.request({ type: "prompt", message }, 30_000);
			if (!response.success) {
				finish(new RpcRequestError("prompt", response.error ?? "prompt rejected"));
				return settled;
			}
			accepted = true;
			if (settledSeen) finish(undefined, false);
			return await settled;
		} catch (error) {
			finish(error instanceof Error ? error : new Error(String(error)));
			return settled;
		} finally {
			this.prompting = false;
		}
	}

	async abort(): Promise<void> {
		if (!this.process) return;
		await this.request({ type: "abort" }, 5_000).catch(() => {});
	}

	async request(command: Record<string, unknown>, timeoutMs: number): Promise<RpcResponse> {
		if (!this.process || !this.process.stdin || this.process.stdin.destroyed) {
			throw new RpcProcessExitError(
				"RPC process is not running",
				this.exitInfo ?? { code: null, signal: null, expected: false },
				this.stderr,
			);
		}
		const id = `req-${++this.requestSeq}`;
		const payload = `${JSON.stringify({ ...command, id })}\n`;
		return await new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new RpcTimeoutError(`RPC command ${String(command.type)} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.process?.stdin?.write(payload, (error) => {
				if (!error) return;
				const pending = this.pending.get(id);
				if (!pending) return;
				clearTimeout(pending.timer);
				this.pending.delete(id);
				reject(new Error(`failed to write RPC command: ${error.message}`));
			});
		});
	}

	async finish(reason = "requested", timeoutMs = 3_000): Promise<void> {
		const child = this.process;
		if (!child) return;
		this.expectedExit = true;
		if (this.prompting) await this.abort().catch(() => {});
		child.stdin?.end();
		this.processAbort?.abort();
		const exited = await new Promise<boolean>((resolve) => {
			if (child.exitCode !== null) {
				resolve(true);
				return;
			}
			const timer = setTimeout(() => resolve(false), timeoutMs);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve(true);
			});
		});
		if (!exited) {
			child.stdin?.destroy();
			this.processAbort?.abort();
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		this.process = null;
		this.processAbort = null;
		this.failAll(
			new RpcProcessExitError(
				`RPC process stopped: ${reason}`,
				{ code: null, signal: null, expected: true },
				this.stderr,
			),
		);
	}

	private consumeStdout(chunk: Buffer): void {
		this.stdoutBuffer += this.decoder.write(chunk);
		while (true) {
			const index = this.stdoutBuffer.indexOf("\n");
			if (index < 0) break;
			const line = this.stdoutBuffer.slice(0, index);
			this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
			if (Buffer.byteLength(line, "utf8") > (this.options.maxFrameBytes ?? DEFAULT_RPC_MAX_FRAME_BYTES)) {
				this.protocolFailure(
					`RPC frame exceeded ${String(this.options.maxFrameBytes ?? DEFAULT_RPC_MAX_FRAME_BYTES)} bytes`,
				);
				return;
			}
			this.handleLine(line);
		}
		if (Buffer.byteLength(this.stdoutBuffer, "utf8") > (this.options.maxFrameBytes ?? DEFAULT_RPC_MAX_FRAME_BYTES)) {
			this.protocolFailure(
				`RPC frame exceeded ${String(this.options.maxFrameBytes ?? DEFAULT_RPC_MAX_FRAME_BYTES)} bytes`,
			);
		}
	}

	private consumeStderr(chunk: Buffer): void {
		const limit = this.options.stderrBytes ?? DEFAULT_RPC_STDERR_BYTES;
		this.stderr += chunk.toString("utf8");
		if (this.stderr.length > limit) this.stderr = this.stderr.slice(-limit);
	}

	private handleLine(line: string): void {
		const trimmed = line.replace(/\r$/, "");
		if (trimmed.trim() === "") return;
		let message: unknown;
		try {
			message = JSON.parse(trimmed);
		} catch {
			this.protocolFailure("RPC stdout emitted invalid JSON");
			return;
		}
		if (!message || typeof message !== "object") {
			this.protocolFailure("RPC stdout emitted a non-object message");
			return;
		}
		if ((message as { type?: unknown }).type === "response") {
			const response = message as RpcResponse;
			if (response.id) {
				const pending = this.pending.get(response.id);
				if (pending) {
					clearTimeout(pending.timer);
					this.pending.delete(response.id);
					if (response.success) pending.resolve(response);
					else pending.reject(new RpcRequestError(response.command, response.error ?? "RPC request failed"));
				}
			}
			return;
		}
		for (const listener of [...this.eventListeners]) listener(message as RpcEvent);
	}

	private protocolFailure(message: string): void {
		const error = new RpcProtocolError(message);
		this.failAll(error);
		void this.finish("protocol_error").catch(() => {});
	}

	private failAll(error: Error): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			this.pending.delete(id);
			pending.reject(error);
		}
	}
}
