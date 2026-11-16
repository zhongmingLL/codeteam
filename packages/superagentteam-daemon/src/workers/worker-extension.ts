import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { Type } from "typebox";
import { A2A_TOOL_SPECS } from "../a2a/tool-surface.ts";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const REQUEST_TIMEOUT_MS = 2_000;
const A2A_REQUEST_TIMEOUT_MS = 30_000;

interface ToolCallEvent {
	readonly toolName: string;
	readonly input: Record<string, unknown>;
}

interface ToolCallResult {
	readonly block?: boolean;
	readonly reason?: string;
}

interface ExtensionAPI {
	on(
		event: "tool_call",
		handler: (event: ToolCallEvent) => Promise<ToolCallResult | undefined> | ToolCallResult | undefined,
	): void;
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

class ControlClient {
	private readonly socketPath: string;
	private readonly workerId: string;
	private readonly tokenFile: string;
	private socket: Socket | null = null;
	private connecting: Promise<void> | null = null;
	private buffer = "";
	private requestSeq = 0;
	private pending = new Map<string, Pending>();
	private closed = false;

	constructor(socketPath: string, workerId: string, tokenFile: string) {
		this.socketPath = socketPath;
		this.workerId = workerId;
		this.tokenFile = tokenFile;
	}

	async connect(): Promise<void> {
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
				this.rejectPending(new Error("worker control socket closed"));
			});
		});
		return this.connecting;
	}

	close(): void {
		this.closed = true;
		this.socket?.destroy();
		this.socket = null;
		this.rejectPending(new Error("worker control client closed"));
	}

	async heartbeat(): Promise<void> {
		await this.request({ type: "heartbeat", workerId: this.workerId, pid: process.pid }, REQUEST_TIMEOUT_MS);
	}

	async toolPolicy(toolName: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null> {
		const token = readToken(this.tokenFile);
		if (!token) return null;
		try {
			return await this.request(
				{ type: "tool_policy", workerId: this.workerId, token, toolName, input },
				REQUEST_TIMEOUT_MS,
			);
		} catch {
			return null;
		}
	}

	async a2aCall(toolName: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
		const token = readToken(this.tokenFile);
		if (!token) throw new Error("a2a_tool_unavailable: no active run token");
		return await this.request(
			{ type: "a2a_call", workerId: this.workerId, token, toolName, input },
			A2A_REQUEST_TIMEOUT_MS,
		);
	}

	private async request(payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
		await this.connect();
		const socket = this.socket;
		if (!socket) throw new Error("worker control socket is unavailable");
		const id = `wreq-${++this.requestSeq}`;
		return await new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("worker control request timed out"));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			socket.write(`${JSON.stringify({ ...payload, id })}\n`, (error) => {
				if (!error) return;
				const pending = this.pending.get(id);
				if (!pending) return;
				clearTimeout(pending.timer);
				this.pending.delete(id);
				reject(error);
			});
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
			if (message.ok === true) pending.resolve(message);
			else {
				const error = message.error as { code?: unknown; message?: unknown } | undefined;
				const code = typeof error?.code === "string" ? error.code : "control_error";
				const reason = typeof error?.message === "string" ? error.message : "worker control error";
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

class ControlRequestError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "ControlRequestError";
		this.code = code;
	}
}

function readToken(path: string): string | null {
	try {
		const value = readFileSync(path, "utf8").trim();
		return value === "" ? null : value;
	} catch {
		return null;
	}
}

export default function codeteamWorkerExtension(pi: ExtensionAPI): void {
	const socketPath = process.env.CODETEAM_CONTROL_SOCKET ?? "";
	const workerId = process.env.CODETEAM_WORKER_ID ?? "";
	const tokenFile = process.env.CODETEAM_TOKEN_FILE ?? "";
	const heartbeatMs = Number(process.env.CODETEAM_HEARTBEAT_MS ?? "10000");
	if (socketPath === "" || workerId === "" || tokenFile === "") {
		process.stderr.write("codeteam worker extension: missing control socket, worker id, or token file\n");
		return;
	}
	const client = new ControlClient(socketPath, workerId, tokenFile);
	const beat = () => {
		void client.heartbeat().catch((error) => {
			process.stderr.write(
				`codeteam worker heartbeat failed: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		});
	};
	pi.on("session_start", beat);
	pi.on("agent_settled", beat);
	const timer = setInterval(beat, Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : 10_000);
	timer.unref?.();
	beat();

	pi.on("tool_call", async (event) => {
		const decision = await client.toolPolicy(event.toolName, event.input);
		if (decision === null) {
			if (READ_ONLY_TOOLS.has(event.toolName)) return;
			return { block: true, reason: "control plane unavailable: mutating tool denied" };
		}
		if (decision.allow === true) return;
		const code = typeof decision.code === "string" ? decision.code : "tool_denied";
		const reason = typeof decision.reason === "string" ? decision.reason : "tool denied by worker policy";
		return { block: true, reason: `${code}: ${reason}` };
	});

	for (const spec of A2A_TOOL_SPECS) {
		pi.registerTool({
			name: spec.name,
			label: `A2A ${spec.name}`,
			description: spec.description,
			promptGuidelines: [
				"Use codeteam_a2a_send for discussion; use codeteam_handoff_create for responsibility transfer.",
				"Targets are AgentProfile ids, not display names. Text @ does not route.",
			],
			parameters: Type.Unsafe(spec.inputSchema),
			async execute(_toolCallId, params) {
				const response = await client.a2aCall(spec.name, params);
				const result = response.result;
				return {
					content: [{ type: "text", text: JSON.stringify(result ?? response) }],
					details: { tool: spec.name, result: result ?? response },
				};
			},
		});
	}
}
