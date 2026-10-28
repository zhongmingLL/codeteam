import type { ControlStore } from "../control/store.ts";
import type { ToolUsageStore } from "../control/stores/tool-usage.ts";
import type { RunEvent } from "../control/stores/types.ts";
import type { ObservabilityRuntime } from "../observability/runtime.ts";
import { classifyTool } from "../observability/tool-classification.ts";
import type { SpanContext, SpanHandle } from "../observability/tracer.ts";
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

export interface WorkerEventSinkOptions {
	readonly profileId: string;
	readonly toolUsage?: Pick<ToolUsageStore, "record">;
	readonly observability?: ObservabilityRuntime | null;
	readonly parentSpan?: SpanContext;
}

export class WorkerEventSink {
	private readonly store: ControlStore;
	private readonly runId: string;
	private readonly options: WorkerEventSinkOptions;
	private readonly toolNames: string[] = [];
	private readonly toolSpans = new Map<string, SpanHandle>();
	private readonly recordedToolCalls = new Set<string>();
	private readonly assistantTexts: string[] = [];
	private usage: Record<string, unknown> | null = null;
	private lastError: string | null = null;
	private writeErrors = 0;
	private toolUsageErrors = 0;

	constructor(store: ControlStore, runId: string, options: WorkerEventSinkOptions) {
		this.store = store;
		this.runId = runId;
		this.options = options;
	}

	handle(event: RpcEvent): void {
		switch (event.type) {
			case "message_end":
				this.handleMessageEnd(event);
				return;
			case "tool_execution_start":
				this.handleToolStart(event);
				return;
			case "tool_execution_end":
				this.handleToolEnd(event);
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

	get toolUsageWriteErrors(): number {
		return this.toolUsageErrors;
	}

	get errorMessage(): string | null {
		return this.lastError;
	}

	close(): void {
		for (const span of this.toolSpans.values()) {
			span.setAttribute("tool.result.status", "unknown");
			span.setStatus("error", "aborted");
			span.end();
		}
		this.toolSpans.clear();
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

	private handleToolStart(event: RpcEvent): void {
		const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
		const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : null;
		if (!this.toolNames.includes(toolName)) this.toolNames.push(toolName);
		const input = asObject(event.args);
		const appended = this.append("tool_call", {
			phase: "start",
			toolName,
			toolCallId,
			...(input ? { inputKeys: Object.keys(input).slice(0, 32) } : {}),
		});
		const classification = classifyTool(toolName, input ?? undefined);
		const recordable = !toolCallId || !this.recordedToolCalls.has(toolCallId);
		if (appended && recordable) {
			if (toolCallId) this.recordedToolCalls.add(toolCallId);
			try {
				this.options.toolUsage?.record({
					eventId: appended.id,
					runId: this.runId,
					profileId: this.options.profileId,
					toolName,
					...(input ? { toolInput: input } : {}),
				});
			} catch {
				this.toolUsageErrors += 1;
			}
		}
		const observability = this.options.observability;
		if (observability && this.options.parentSpan && toolCallId && !this.toolSpans.has(toolCallId)) {
			const span = observability.tracer.startToolSpan(this.options.parentSpan, {
				toolName,
				category: classification.category,
				toolCallId,
				inputKeys: input ? Object.keys(input).slice(0, 32) : undefined,
				invocationId: this.runId,
			});
			this.toolSpans.set(toolCallId, span);
		}
		observability?.metrics
			.counter("codeteam_tool_calls_total", {
				"tool.category": classification.category,
				"tool.name": classification.toolName,
				status: "started",
			})
			.add();
	}

	private handleToolEnd(event: RpcEvent): void {
		const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
		const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : null;
		const isError = event.isError === true;
		const durationMs = typeof event.durationMs === "number" ? event.durationMs : null;
		this.append("tool_result", { phase: "end", toolName, toolCallId, isError, durationMs });
		const classification = classifyTool(toolName);
		const span = toolCallId ? this.toolSpans.get(toolCallId) : undefined;
		if (span) {
			span.setAttribute("tool.result.status", isError ? "error" : "ok");
			if (durationMs !== undefined && durationMs !== null) span.setAttribute("tool.duration_ms", durationMs);
			span.setStatus(isError ? "error" : "ok");
			span.end();
			if (toolCallId) this.toolSpans.delete(toolCallId);
		}
		this.options.observability?.metrics
			.counter("codeteam_tool_calls_total", {
				"tool.category": classification.category,
				"tool.name": classification.toolName,
				status: isError ? "error" : "ok",
			})
			.add();
	}

	private append(kind: Parameters<ControlStore["runs"]["appendEvent"]>[1], payload: unknown): RunEvent | null {
		try {
			return this.store.runs.appendEvent(this.runId, kind, payload);
		} catch {
			this.writeErrors += 1;
			return null;
		}
	}
}

function asObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
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
