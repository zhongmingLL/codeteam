import type { AgentStreamEvent } from "@superagentteam/shared/types";

import type { RpcEvent } from "../../workers/rpc-client.ts";
import type { ResponseDraftStore } from "./store.ts";

// F018 R2-b ResponseEventSink (0007 §3.6.1 / 0017): streams provider events
// into response_drafts as full snapshots (throttled: provisional 100ms / 4KB,
// benchmarked in R2-d) and emits ephemeral AgentStreamEvents for the UI.
// First user-visible output triggers the session's 0→1 unseal-safety count.

const FLUSH_INTERVAL_MS = 100;
const FLUSH_PENDING_BYTES = 4 * 1024;

export interface ResponseEventSinkDeps {
	drafts: ResponseDraftStore;
	attemptId: string;
	turnExecutionId: string;
	parentInvocationId: string;
	threadId: string;
	agentId: string;
	createdAt: number;
	onStreamEvent?: (event: AgentStreamEvent) => void;
	onFirstVisibleOutput?: () => void;
	clock?: () => number;
}

interface ToolEventRecord {
	kind: "tool_call" | "tool_result";
	name: string;
	at: number;
	payload?: unknown;
}

export interface ResponseSummary {
	content: string;
	thinking: string | null;
	usage: Record<string, unknown> | null;
	toolEvents: ToolEventRecord[];
	errorMessage: string | null;
}

export class ResponseEventSink {
	private readonly deps: ResponseEventSinkDeps;
	private readonly clock: () => number;
	private text = "";
	private thinking: string | null = null;
	private toolEvents: ToolEventRecord[] = [];
	private usage: Record<string, unknown> | null = null;
	private errorMessage: string | null = null;
	private lastFlushAt = 0;
	private pendingBytes = 0;
	private firstVisibleFired = false;
	private finalContent: string | null = null;

	constructor(deps: ResponseEventSinkDeps) {
		this.deps = deps;
		this.clock = deps.clock ?? Date.now;
	}

	private emit(event: AgentStreamEvent): void {
		try {
			this.deps.onStreamEvent?.(event);
		} catch {
			// Ephemeral UI stream must never break the durable path.
		}
	}

	private maybeFirstVisible(): void {
		if (this.firstVisibleFired) return;
		this.firstVisibleFired = true;
		try {
			this.deps.onFirstVisibleOutput?.();
		} catch {
			// Counting must never break the stream path.
		}
	}

	private flush(final = false): void {
		const now = this.clock();
		if (!final && now - this.lastFlushAt < FLUSH_INTERVAL_MS && this.pendingBytes < FLUSH_PENDING_BYTES) return;
		this.lastFlushAt = now;
		this.pendingBytes = 0;
		const content = this.finalContent ?? this.text;
		this.deps.drafts.upsert({
			attemptId: this.deps.attemptId,
			turnExecutionId: this.deps.turnExecutionId,
			parentInvocationId: this.deps.parentInvocationId,
			threadId: this.deps.threadId,
			agentId: this.deps.agentId,
			content,
			toolEvents: this.toolEvents,
			thinking: this.thinking,
			createdAt: this.deps.createdAt,
			updatedAt: now,
		});
	}

	handle(event: RpcEvent): void {
		switch (event.type) {
			case "message_update":
				this.handleMessageUpdate(event);
				return;
			case "tool_execution_start":
			case "tool_execution_end": {
				const name = typeof event.toolName === "string" ? event.toolName : "unknown";
				const record: ToolEventRecord = {
					kind: event.type === "tool_execution_start" ? "tool_call" : "tool_result",
					name,
					at: this.clock(),
					payload: event.type === "tool_execution_end" ? event.result : event.args,
				};
				this.toolEvents.push(record);
				this.emit({
					type: record.kind,
					agentId: this.deps.agentId,
					turnExecutionId: this.deps.turnExecutionId,
					name,
					args: (event.args as unknown) ?? undefined,
					result: (event.result as unknown) ?? undefined,
					timestamp: record.at,
				} as AgentStreamEvent);
				this.pendingBytes += name.length + 64;
				this.flush();
				return;
			}
			case "message_end":
				this.handleMessageEnd(event);
				return;
			case "agent_settled":
				this.emit({
					type: "done",
					agentId: this.deps.agentId,
					turnExecutionId: this.deps.turnExecutionId,
					timestamp: this.clock(),
				});
				this.flush(true);
				return;
			case "extension_error": {
				const message =
					typeof event.error === "string" ? event.error : String((event.error as unknown) ?? "extension error");
				this.errorMessage = message;
				this.emit({
					type: "error",
					agentId: this.deps.agentId,
					turnExecutionId: this.deps.turnExecutionId,
					error: message,
					timestamp: this.clock(),
				});
				return;
			}
			default:
				return;
		}
	}

	private handleMessageUpdate(event: RpcEvent): void {
		const inner = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
		if (!inner || typeof inner.type !== "string") return;
		const delta = typeof inner.delta === "string" ? inner.delta : "";
		const timestamp = this.clock();
		if (inner.type === "text_delta" && delta) {
			this.text += delta;
			this.pendingBytes += delta.length;
			if (this.text.trim().length > 0) this.maybeFirstVisible();
			this.emit({
				type: "text",
				agentId: this.deps.agentId,
				turnExecutionId: this.deps.turnExecutionId,
				content: delta,
				timestamp,
			});
			this.flush();
			return;
		}
		if (inner.type === "thinking_delta" && delta) {
			this.thinking = (this.thinking ?? "") + delta;
			this.emit({
				type: "thinking",
				agentId: this.deps.agentId,
				turnExecutionId: this.deps.turnExecutionId,
				content: delta,
				timestamp,
			});
			return;
		}
	}

	private handleMessageEnd(event: RpcEvent): void {
		const message = event.message as
			| { role?: unknown; content?: unknown; usage?: unknown; errorMessage?: unknown }
			| undefined;
		if (!message || typeof message !== "object") return;
		if (message.usage && typeof message.usage === "object") {
			this.usage = message.usage as Record<string, unknown>;
		}
		if (typeof message.errorMessage === "string" && message.errorMessage) {
			this.errorMessage = message.errorMessage;
		}
		if (message.role === "assistant" && Array.isArray(message.content)) {
			const texts: string[] = [];
			for (const part of message.content) {
				const typed = part as { type?: unknown; text?: unknown };
				if (typed?.type === "text" && typeof typed.text === "string") texts.push(typed.text);
			}
			if (texts.length > 0) this.finalContent = texts.join("\n\n");
			if ((this.finalContent ?? "").trim().length > 0) this.maybeFirstVisible();
		}
		this.flush(true);
	}

	summary(): ResponseSummary {
		this.flush(true);
		return {
			content: this.finalContent ?? this.text,
			thinking: this.thinking,
			usage: this.usage,
			toolEvents: this.toolEvents,
			errorMessage: this.errorMessage,
		};
	}
}
