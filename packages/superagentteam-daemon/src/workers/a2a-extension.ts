import { connect, type Socket } from "node:net";
import { Type } from "typebox";
import { A2A_V1_TOOL_SPECS } from "../domains/a2a/tool-surface.ts";
import { envValue } from "../env.ts";

// F018 R5-a: v1 pi worker extension. It registers ONLY the four canonical
// `superagentteam_*` tools and forwards each call to the daemon's local A2A
// control socket. The credential token is a child-TurnExecution capability
// delivered through the worker environment; it never appears in model input.

const REQUEST_TIMEOUT_MS = 2_000;
const A2A_REQUEST_TIMEOUT_MS = 30_000;

interface ExtensionAPI {
	on(event: "session_start" | "agent_settled", handler: () => void): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		promptGuidelines?: string[];
		parameters: unknown;
		execute(
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }>;
	}): void;
}

interface Pending {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

class ControlRequestError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "ControlRequestError";
		this.code = code;
	}
}

class A2AControlClient {
	private readonly socketPath: string;
	private readonly workerId: string;
	private readonly token: string;
	private socket: Socket | null = null;
	private connecting: Promise<void> | null = null;
	private buffer = "";
	private requestSeq = 0;
	private readonly pending = new Map<string, Pending>();
	private closed = false;

	constructor(socketPath: string, workerId: string, token: string) {
		this.socketPath = socketPath;
		this.workerId = workerId;
		this.token = token;
	}

	close(): void {
		this.closed = true;
		this.socket?.destroy();
		this.socket = null;
		this.rejectPending(new Error("A2A control client closed"));
	}

	async heartbeat(): Promise<void> {
		await this.request({ type: "heartbeat" }, REQUEST_TIMEOUT_MS);
	}

	async a2aCall(toolName: string, input: Record<string, unknown>, piExtToolCallId: string): Promise<unknown> {
		const response = await this.request(
			{ type: "a2a_call", toolName, input, piExtToolCallId },
			A2A_REQUEST_TIMEOUT_MS,
		);
		return response.result;
	}

	private async connect(): Promise<void> {
		if (this.socket) return;
		if (this.connecting) return this.connecting;
		this.connecting = new Promise<void>((resolve, reject) => {
			const socket = connect(this.socketPath);
			socket.setEncoding("utf8");
			socket.once("connect", () => {
				this.socket = socket;
				this.connecting = null;
				resolve();
			});
			socket.on("data", (chunk: string) => this.consume(chunk));
			socket.on("error", (error) => {
				this.socket = null;
				this.connecting = null;
				this.rejectPending(error);
				if (!this.closed) reject(error);
			});
			socket.on("close", () => {
				this.socket = null;
				this.connecting = null;
				this.rejectPending(new Error("A2A control socket closed"));
			});
		});
		return this.connecting;
	}

	private async request(payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
		await this.connect();
		const socket = this.socket;
		if (!socket) throw new Error("A2A control socket is unavailable");
		const id = `a2a-${++this.requestSeq}`;
		return await new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("A2A control request timed out"));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			socket.write(
				`${JSON.stringify({ ...payload, id, workerId: this.workerId, token: this.token })}\n`,
				(error) => {
					if (!error) return;
					const pending = this.pending.get(id);
					if (!pending) return;
					clearTimeout(pending.timer);
					this.pending.delete(id);
					reject(error);
				},
			);
		});
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		while (true) {
			const index = this.buffer.indexOf("\n");
			if (index < 0) return;
			const line = this.buffer.slice(0, index).trim();
			this.buffer = this.buffer.slice(index + 1);
			if (line === "") continue;
			let message: Record<string, unknown>;
			try {
				message = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			const id = typeof message.id === "string" ? message.id : null;
			if (!id) continue;
			const pending = this.pending.get(id);
			if (!pending) continue;
			clearTimeout(pending.timer);
			this.pending.delete(id);
			if (message.ok === true) {
				pending.resolve(message);
			} else {
				const error = message.error as { code?: unknown; message?: unknown } | undefined;
				const code = typeof error?.code === "string" ? error.code : "control_error";
				const reason = typeof error?.message === "string" ? error.message : "A2A control error";
				pending.reject(new ControlRequestError(code, reason));
			}
		}
	}

	private rejectPending(error: Error): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			this.pending.delete(id);
			pending.reject(error);
		}
	}
}

export default function superagentteamA2AExtension(pi: ExtensionAPI): void {
	const socketPath = envValue(process.env, "CONTROL_SOCKET") ?? "";
	const workerId = envValue(process.env, "WORKER_ID") ?? "";
	const controlToken = envValue(process.env, "CONTROL_TOKEN") ?? "";
	const heartbeatMs = Number(envValue(process.env, "HEARTBEAT_MS") ?? "10000");
	if (socketPath === "" || workerId === "" || controlToken === "") {
		process.stderr.write("SuperAgentTeam A2A extension: missing control socket, worker id, or control token\n");
		return;
	}
	const client = new A2AControlClient(socketPath, workerId, controlToken);
	const beat = (): void => {
		void client.heartbeat().catch((error) => {
			process.stderr.write(
				`SuperAgentTeam A2A heartbeat failed: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		});
	};
	pi.on("session_start", beat);
	pi.on("agent_settled", beat);
	const timer = setInterval(beat, Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : 10_000);
	timer.unref?.();
	beat();

	for (const spec of A2A_V1_TOOL_SPECS) {
		pi.registerTool({
			name: spec.name,
			label: `A2A ${spec.name}`,
			description: spec.description,
			promptGuidelines: [
				"A2A targets are typed {kind:'agent', id}; text @ does not route.",
				"Use superagentteam_thread_context to read a bounded window before replying.",
			],
			parameters: Type.Unsafe(spec.inputSchema),
			async execute(toolCallId, params) {
				const piExtToolCallId = `${spec.name}:${toolCallId}`;
				const result = await client.a2aCall(spec.name, params, piExtToolCallId);
				return {
					content: [{ type: "text", text: JSON.stringify(result ?? null) }],
					details: { tool: spec.name, result: result ?? null },
				};
			},
		});
	}
}
