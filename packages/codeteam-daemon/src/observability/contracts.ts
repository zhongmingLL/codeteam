import type { RunEventKind } from "../control/stores/types.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type ToolCategory = "native" | "mcp" | "skill";
export type TraceSpanKind = "internal" | "server" | "client";
export type TraceAvailability = "available" | "trace_unavailable";
export type TraceUnavailableReason = "ring_miss" | "telemetry_disabled";
export type SpanStatusCode = "unset" | "ok" | "error";

export type TraceAttributeValue = string | number | boolean;
export type TraceAttributes = Readonly<Record<string, TraceAttributeValue>>;

export interface TraceSpanEvent {
	readonly name: string;
	readonly timeMs: number;
	readonly attributes?: TraceAttributes;
}

/**
 * Frozen read contract for local traces. The DTO is already redacted; callers
 * must never receive raw span objects or unredacted attributes.
 */
export interface TraceSpanDTO {
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly name: string;
	readonly kind: TraceSpanKind;
	readonly startTimeMs: number;
	readonly endTimeMs: number;
	readonly durationMs: number;
	readonly status: { readonly code: SpanStatusCode; readonly message?: string };
	readonly attributes: TraceAttributes;
	readonly events: readonly TraceSpanEvent[];
	readonly storedAt: number;
	readonly droppedAttributes: number;
}

export interface TraceQuery {
	readonly traceId?: string;
	/** Raw canonical runs.id. The store HMACs it before matching. */
	readonly invocationId?: string;
	readonly profileId?: string;
	readonly name?: string;
	readonly startMin?: number;
	readonly startMax?: number;
	/** Default 100, max 500. */
	readonly limit?: number;
}

export interface TraceQueryResult {
	readonly availability: TraceAvailability;
	readonly reason?: TraceUnavailableReason;
	readonly spans: readonly TraceSpanDTO[];
	readonly truncated: boolean;
}

export interface SpanExporter {
	export(span: TraceSpanDTO): void;
	shutdown?(): Promise<void>;
}

export interface TrajectoryMessageRef {
	readonly id: string;
	readonly kind: string;
	readonly authorKind: string;
	readonly authorId: string;
	readonly seq: number;
	readonly createdAt: number;
	readonly bodyDigest: string;
	readonly bodyBytes: number;
}

export interface TrajectoryStep {
	readonly seq: number;
	readonly at: number;
	readonly kind: RunEventKind;
	readonly summary: string;
	readonly attributes: TraceAttributes;
	readonly source:
		| { readonly kind: "run_event"; readonly id: string }
		| { readonly kind: "message"; readonly id: string };
}

/**
 * Frozen read contract for a single invocation trajectory. `inv` is the
 * canonical `inv:<runs.id>` join key. The projection is read-only and never
 * inlines message bodies, prompts, diffs, or file content.
 */
export interface InvocationTrajectory {
	readonly inv: `inv:${string}`;
	readonly run: {
		readonly id: string;
		readonly taskId: string;
		readonly status: string;
		readonly role: string;
		readonly agentSessionId: string;
		readonly provider: string;
		readonly model: string;
		readonly modelFamily: string;
		readonly attempt: number;
		readonly startedAt: number;
		readonly terminalAt: number | null;
		/** Bounded token/cost metadata; unknown usage keys are dropped by the projection. */
		readonly usage: Readonly<Record<string, string | number | boolean>> | null;
	};
	readonly task: { readonly id: string; readonly title: string; readonly status: string } | null;
	readonly thread: { readonly id: string; readonly title: string | null } | null;
	readonly queueEntry: {
		readonly id: string;
		readonly sourceKind: string;
		readonly priority: string;
		readonly status: string;
		readonly enqueuedAt: number;
	} | null;
	readonly sourceMessage: TrajectoryMessageRef | null;
	readonly responseMessage: TrajectoryMessageRef | null;
	readonly steps: readonly TrajectoryStep[];
	/** True is a possible-truncation signal (hit MAX_STEPS), not proof that data is missing. */
	readonly stepsTruncated: boolean;
	readonly trace: TraceQueryResult;
}

export interface ToolUsageQuery {
	/** Default 30; <= 0 means all-time (bounded by retention). */
	readonly days?: number;
	readonly from?: string;
	readonly to?: string;
	readonly profileId?: string;
	readonly category?: ToolCategory;
}

export interface ToolUsageReport {
	readonly period: { readonly from: string; readonly to: string };
	readonly summary: {
		readonly totalCalls: number;
		readonly byCategory: Record<ToolCategory, number>;
	};
	readonly topTools: ReadonlyArray<{ readonly name: string; readonly category: ToolCategory; readonly count: number }>;
	readonly daily: ReadonlyArray<{
		readonly date: string;
		readonly native: number;
		readonly mcp: number;
		readonly skill: number;
	}>;
	readonly byProfile: Readonly<Record<string, Record<ToolCategory, number>>>;
}

export interface ToolUsageRecordInput {
	/** Idempotency key; the canonical run_events.id. */
	readonly eventId: string;
	readonly runId: string;
	readonly profileId: string;
	readonly toolName: string;
	readonly toolInput?: Record<string, unknown>;
	readonly at?: number;
}

export interface ToolUsageRecordResult {
	readonly recorded: boolean;
	readonly count: number;
}

export interface LogTailQuery {
	/** Default 100, max 1000. */
	readonly limit?: number;
	readonly level?: LogLevel;
	/** Inclusive ISO timestamp lower bound. */
	readonly since?: string;
}

export interface LogEntry {
	readonly ts: string;
	readonly level: LogLevel;
	readonly event: string;
	/**
	 * JsonlLogStore defaults to strict field mode: unknown keys are redacted.
	 * Callers must use the allowlisted operational keys (ids, role/status,
	 * tokens/counts) and must never rely on an unknown key carrying content.
	 */
	readonly fields: Record<string, unknown>;
}

export interface LogTailResult {
	readonly entries: readonly LogEntry[];
	readonly truncated: boolean;
	readonly scannedFiles: number;
}

export type TelemetryComponentStatus = "ready" | "degraded" | "disabled";

export interface TelemetryReadiness {
	readonly status: TelemetryComponentStatus;
	readonly reason?: string;
	readonly trace: {
		readonly status: TelemetryComponentStatus;
		readonly spanCount: number;
		readonly maxSpans: number;
		readonly maxAgeMs: number;
		readonly reason?: string;
	};
	readonly metrics: {
		readonly status: TelemetryComponentStatus;
		readonly seriesCount: number;
		readonly reason?: string;
	};
	readonly logs: {
		readonly status: TelemetryComponentStatus;
		readonly fileCount: number;
		readonly reason?: string;
	};
	readonly otlp: {
		readonly status: "disabled" | "enabled" | "degraded";
		readonly reason?: string;
	};
}

/**
 * Top-level readiness combines the control plane and telemetry. Telemetry may be
 * intentionally disabled while the top level is "degraded"; consumers (W7a
 * Console) must render `telemetry.*` rather than infer health from this alone.
 */
export type ReadyStatus = "starting" | "ready" | "degraded" | "stopping" | "failed";
