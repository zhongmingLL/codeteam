import type { ControlStore } from "../control/store.ts";
import type { RpcEvent } from "./rpc-client.ts";

const MAX_EVENT_TEXT = 16 * 1024;

export interface WorkerEventSummary {
	bodyMd: string;
	usage: Record<string, unknown> | null;
	toolCalls: string[];
}

interface AssistantContentPart {
	readonly type?: unknown;
	readonly text?: unknown;
	readonly name?: unknown;
}

export class WorkerEventSink {
	private readonly store: ControlStore;
	private readonly runId: string;
	private readonly toolNames: string[] = [];
	private readonly assistantTexts: string[] = [];
	private usage: Record<string, unknown> | null = null;
	private lastError: string | null = null;
	private writeErrors = 0;

	constructor(store: ControlStore, runId: string) {
		this.store = store;
		this.runId = runId;
	}

	handle(event: RpcEvent): void {
		switch (event.type) {
			case "message_end":
				this.handleMessageEnd(event);
				return;
			case "tool_execution_start":
				this.appendTool("tool_call", event, { phase: "start" });
				return;
			case "tool_execution_end":
				this.appendTool("tool_result", event, {
					phase: "end",
					isError: event.isError === true,
					durationMs: typeof event.durationMs === "number" ? event.durationMs : null,
				});
				return;
			case "agent_settled":
				this.append("message", { phase: "settled", aborted: event.aborted === true });
				return;
			case "extension_error":
				this.append("error", {
					phase: "extension_error",
					extensionPath: typeof event.extensionPath === "string" ? event.extensionPath : null,
					event: typeof event.event === "string" ? event.event : null,
					error: truncate(typeof event.error === "string" ? event.error : String(event.error ?? "unknown")),
				});
				return;
			default:
				return;
		}
	}

	summary(fallback = ""): WorkerEventSummary {
		const bodyMd =
			this.assistantTexts.length > 0
				? this.assistantTexts.join("\n\n")
				: this.lastError
					? `Execution error: ${this.lastError}`
					: fallback;
		return {
			bodyMd,
			usage: this.usage,
			toolCalls: [...new Set(this.toolNames)],
		};
	}

	get eventWriteErrors(): number {
		return this.writeErrors;
	}

	get errorMessage(): string | null {
		return this.lastError;
	}

	private handleMessageEnd(event: RpcEvent): void {
		const message = event.message;
		if (!message || typeof message !== "object") return;
		const record = message as {
			role?: unknown;
			content?: unknown;
			usage?: unknown;
			stopReason?: unknown;
			errorMessage?: unknown;
		};
		if (record.role === "assistant") {
			if (typeof record.errorMessage === "string" && record.errorMessage !== "") {
				this.lastError = record.errorMessage;
			} else if (record.stopReason === "error") {
				this.lastError = "model stopped with an error";
			}
			const text = textOf(record.content);
			if (text !== "") this.assistantTexts.push(text);
			if (record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)) {
				this.usage = record.usage as Record<string, unknown>;
			}
			for (const part of Array.isArray(record.content) ? record.content : []) {
				const item = part as AssistantContentPart;
				if (item.type === "toolCall" && typeof item.name === "string" && !this.toolNames.includes(item.name)) {
					this.toolNames.push(item.name);
				}
			}
			this.append("message", {
				phase: "assistant",
				role: "assistant",
				text: truncate(text),
				usage: record.usage ?? null,
				stopReason: record.stopReason ?? null,
				errorMessage: record.errorMessage ?? null,
			});
		}
	}

	private appendTool(kind: "tool_call" | "tool_result", event: RpcEvent, extra: Record<string, unknown>): void {
		const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
		if (!this.toolNames.includes(toolName)) this.toolNames.push(toolName);
		this.append(kind, {
			...extra,
			toolName,
			toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : null,
		});
	}

	private append(kind: Parameters<ControlStore["runs"]["appendEvent"]>[1], payload: unknown): void {
		try {
			this.store.runs.appendEvent(this.runId, kind, payload);
		} catch {
			this.writeErrors += 1;
		}
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const item = part as AssistantContentPart;
			return item.type === "text" && typeof item.text === "string" ? item.text : "";
		})
		.filter((text) => text !== "")
		.join("\n");
}

function truncate(value: string): string {
	if (value.length <= MAX_EVENT_TEXT) return value;
	return `${value.slice(0, MAX_EVENT_TEXT)}\n…[truncated ${value.length - MAX_EVENT_TEXT} chars]`;
}
