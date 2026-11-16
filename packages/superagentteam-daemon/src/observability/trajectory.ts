import { createHash } from "node:crypto";
import type { ControlStore } from "../control/store.ts";
import type { Message, RunEvent } from "../control/stores/types.ts";
import type {
	InvocationTrajectory,
	TraceAttributes,
	TraceQuery,
	TraceQueryResult,
	TrajectoryMessageRef,
	TrajectoryStep,
} from "./contracts.ts";

export interface TraceQuerySource {
	query(filter: TraceQuery): TraceQueryResult;
}

export interface TrajectoryServiceOptions {
	readonly store: ControlStore;
	/** Null means telemetry is disabled for this daemon. */
	readonly traces: TraceQuerySource | null;
}

const MAX_STEPS = 500;
const SAFE_METADATA = /^[a-zA-Z0-9_.:/@+-]{1,200}$/;
const SAFE_CODE = /^[a-zA-Z0-9_.:-]{1,120}$/;
const SAFE_USAGE_KEYS = new Set([
	"inputTokens",
	"outputTokens",
	"totalTokens",
	"promptTokens",
	"completionTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"cacheCreationTokens",
	"reasoningTokens",
	"cachedTokens",
	"requestCount",
	"costUsd",
	"cost",
	"durationMs",
	"model",
	"provider",
	"stopReason",
]);

/**
 * Read-only projection of a single invocation from the canonical control
 * tables. It never writes, never creates a second event ledger, and never
 * inlines prompt/message/diff/file content.
 */
export class TrajectoryService {
	private readonly store: ControlStore;
	private readonly traces: TraceQuerySource | null;

	constructor(options: TrajectoryServiceOptions) {
		this.store = options.store;
		this.traces = options.traces;
	}

	get(runId: string): InvocationTrajectory | null {
		const run = this.store.runs.get(runId);
		if (!run) return null;
		const task = this.store.tasks.get(run.taskId);
		const thread = task ? this.store.threads.get(task.threadId) : null;
		const queueEntry = run.queueEntryId ? this.store.queue.get(run.queueEntryId) : null;
		const source = this.store.messages.get(run.sourceId);
		const response = run.responseMessageId ? this.store.messages.get(run.responseMessageId) : null;
		const events = this.store.runs.listEvents(runId, MAX_STEPS);
		const steps = events.map((event) => projectStep(event));
		return {
			inv: `inv:${run.id}`,
			run: {
				id: run.id,
				taskId: run.taskId,
				status: run.status,
				role: run.role,
				agentSessionId: run.agentSessionId,
				provider: run.provider,
				model: run.model,
				modelFamily: run.modelFamily,
				attempt: run.attempt,
				startedAt: run.startedAt,
				terminalAt: run.terminalAt,
				usage: sanitizeUsage(run.usage),
			},
			task: task ? { id: task.id, title: task.title, status: task.status } : null,
			thread: thread ? { id: thread.id, title: thread.title } : null,
			queueEntry: queueEntry
				? {
						id: queueEntry.id,
						sourceKind: queueEntry.sourceKind,
						priority: queueEntry.priority,
						status: queueEntry.status,
						enqueuedAt: queueEntry.enqueuedAt,
					}
				: null,
			sourceMessage: source ? messageRef(source) : null,
			responseMessage: response ? messageRef(response) : null,
			steps,
			stepsTruncated: events.length === MAX_STEPS,
			trace: this.traces
				? this.traces.query({ invocationId: run.id, limit: 200 })
				: { availability: "trace_unavailable", reason: "telemetry_disabled", spans: [], truncated: false },
		};
	}
}

function messageRef(message: Message): TrajectoryMessageRef {
	return {
		id: message.id,
		kind: message.kind,
		authorKind: message.authorKind,
		authorId: message.authorId,
		seq: message.seq,
		createdAt: message.createdAt,
		bodyDigest: digest(message.bodyMd),
		bodyBytes: Buffer.byteLength(message.bodyMd),
	};
}

function projectStep(event: RunEvent): TrajectoryStep {
	const payload = asObject(event.payload);
	const attributes: Record<string, string | number | boolean> = {};
	const phase = safeString(payload?.phase);
	if (phase) attributes.phase = phase;
	const status = safeString(payload?.status);
	if (status) attributes.status = status;
	const reason = safeCode(payload?.reason);
	if (reason) attributes.reason = reason;
	const toolName = safeString(payload?.toolName);
	if (toolName) attributes.toolName = toolName;
	const toolCallId = safeString(payload?.toolCallId);
	if (toolCallId) attributes.toolCallId = toolCallId;
	const durationMs = finiteNumber(payload?.durationMs);
	if (durationMs !== undefined) attributes.durationMs = durationMs;
	if (typeof payload?.isError === "boolean") attributes.isError = payload.isError;
	const gate = safeString(payload?.gate);
	if (gate) attributes.gate = gate;
	const verdict = safeString(payload?.verdict);
	if (verdict) attributes.verdict = verdict;
	const check = safeString(payload?.check);
	if (check) attributes.check = check;
	const action = safeString(payload?.action);
	if (action) attributes.action = action;
	const handoffId = safeString(payload?.handoffId);
	if (handoffId) attributes.handoffId = handoffId;
	const reviewId = safeString(payload?.reviewId);
	if (reviewId) attributes.reviewId = reviewId;
	const inputKeys = payload?.inputKeys ?? payload?.input;
	if (Array.isArray(inputKeys)) {
		const keys = inputKeys
			.filter((item): item is string => typeof item === "string" && SAFE_METADATA.test(item))
			.slice(0, 32);
		if (keys.length > 0) attributes["tool.input.keys"] = keys.join(",");
	}
	if (typeof payload?.text === "string") {
		attributes.textDigest = digest(payload.text);
		attributes.textBytes = Buffer.byteLength(payload.text);
	}
	if (typeof payload?.error === "string") {
		attributes.errorDigest = digest(payload.error);
		attributes.errorBytes = Buffer.byteLength(payload.error);
	}
	return {
		seq: event.seq,
		at: event.ts,
		kind: event.kind,
		summary: summarize(event.kind, attributes),
		attributes: attributes as TraceAttributes,
		source: { kind: "run_event", id: event.id },
	};
}

function summarize(kind: RunEvent["kind"], attributes: Record<string, string | number | boolean>): string {
	const tool = attributes.toolName;
	const phase = attributes.phase;
	switch (kind) {
		case "tool_call":
			return tool ? `tool_call:${String(tool)}` : "tool_call";
		case "tool_result":
			return tool ? `tool_result:${String(tool)}${attributes.isError === true ? ":error" : ":ok"}` : "tool_result";
		case "message":
			return phase ? `message:${String(phase)}` : "message";
		case "error":
			return phase ? `error:${String(phase)}` : "error";
		case "gate":
			return attributes.gate ? `gate:${String(attributes.gate)}:${String(attributes.status ?? "unknown")}` : "gate";
		case "review":
			return attributes.verdict ? `review:${String(attributes.verdict)}` : "review";
		case "verification":
			return attributes.check
				? `verification:${String(attributes.check)}:${String(attributes.status ?? "unknown")}`
				: "verification";
		case "handoff":
			return attributes.action ? `handoff:${String(attributes.action)}` : "handoff";
		default:
			return kind;
	}
}

function asObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function safeString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 200 && SAFE_METADATA.test(value)
		? value
		: undefined;
}

function safeCode(value: unknown): string | undefined {
	return typeof value === "string" && SAFE_CODE.test(value) ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function sanitizeUsage(usage: Record<string, unknown> | null): Record<string, string | number | boolean> | null {
	if (!usage) return null;
	const result: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(usage)) {
		if (!SAFE_USAGE_KEYS.has(key)) continue;
		if (typeof value === "number" && Number.isFinite(value)) {
			result[key] = value;
			continue;
		}
		if (typeof value === "boolean") {
			result[key] = value;
			continue;
		}
		if (typeof value === "string" && SAFE_METADATA.test(value)) {
			result[key] = value;
		}
	}
	return Object.keys(result).length > 0 ? result : null;
}
