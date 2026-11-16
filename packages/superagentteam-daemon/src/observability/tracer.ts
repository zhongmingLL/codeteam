import { randomBytes } from "node:crypto";
import type { Run } from "../control/stores/types.ts";
import type { SpanExporter, TraceSpanDTO, TraceSpanEvent, TraceSpanKind } from "./contracts.ts";
import {
	type Redactor,
	redactTraceAttributes,
	sanitizeEventName,
	sanitizeSpanName,
	sanitizeStatusMessage,
} from "./redaction.ts";
import type { LocalTraceStore } from "./trace-store.ts";

export interface SpanContext {
	readonly traceId: string;
	readonly spanId: string;
}

export interface StartSpanInput {
	readonly name: string;
	readonly kind?: TraceSpanKind;
	readonly attributes?: Record<string, unknown>;
	readonly parent?: SpanContext;
}

export interface ToolSpanInput {
	readonly toolName: string;
	readonly category: string;
	readonly toolCallId?: string | null;
	readonly inputKeys?: readonly string[];
	/** Canonical runs.id; attached to the child span so invocation queries return the full trace. */
	readonly invocationId?: string;
}

export interface SpanHandle {
	readonly context: SpanContext;
	setAttribute(key: string, value: unknown): void;
	addEvent(name: string, attributes?: Record<string, unknown>): void;
	setStatus(code: "ok" | "error", message?: string): void;
	end(): TraceSpanDTO;
	isEnded(): boolean;
}

export interface TracerOptions {
	readonly store: LocalTraceStore;
	readonly redactor: Redactor;
	readonly now?: () => number;
	readonly exporter?: SpanExporter;
	readonly onExportError?: (error: unknown) => void;
}

export class Tracer {
	private readonly store: LocalTraceStore;
	private readonly redactor: Redactor;
	private readonly now: () => number;
	private readonly exporter: SpanExporter | null;
	private readonly onExportError: ((error: unknown) => void) | null;

	constructor(options: TracerOptions) {
		this.store = options.store;
		this.redactor = options.redactor;
		this.now = options.now ?? Date.now;
		this.exporter = options.exporter ?? null;
		this.onExportError = options.onExportError ?? null;
	}

	startSpan(input: StartSpanInput): SpanHandle {
		return new SpanHandleImpl({
			name: sanitizeSpanName(input.name) ?? "codeteam.span",
			kind: input.kind ?? "internal",
			parent: input.parent,
			attributes: input.attributes ?? {},
			store: this.store,
			redactor: this.redactor,
			now: this.now,
			exporter: this.exporter,
			onExportError: this.onExportError,
		});
	}

	startRunSpan(run: Run): SpanHandle {
		return this.startSpan({
			name: "codeteam.run",
			attributes: {
				"invocation.id": run.id,
				"task.id": run.taskId,
				"profile.id": run.recipientProfileId,
				role: run.role,
				provider: run.provider,
				model: run.model,
				model_family: run.modelFamily,
				"run.status": run.status,
				"run.attempt": run.attempt,
			},
		});
	}

	startToolSpan(parent: SpanContext | null, input: ToolSpanInput): SpanHandle {
		const attributes: Record<string, unknown> = {
			"tool.name": input.toolName,
			"tool.category": input.category,
		};
		if (input.invocationId) attributes["invocation.id"] = input.invocationId;
		if (input.toolCallId) attributes["tool.call.id"] = input.toolCallId;
		if (input.inputKeys && input.inputKeys.length > 0) attributes["tool.input.keys"] = input.inputKeys.join(",");
		return this.startSpan({
			name: "codeteam.tool",
			attributes,
			parent: parent ?? undefined,
		});
	}
}

interface SpanHandleOptions {
	readonly name: string;
	readonly kind: TraceSpanKind;
	readonly parent?: SpanContext;
	readonly attributes: Record<string, unknown>;
	readonly store: LocalTraceStore;
	readonly redactor: Redactor;
	readonly now: () => number;
	readonly exporter: SpanExporter | null;
	readonly onExportError: ((error: unknown) => void) | null;
}

class SpanHandleImpl implements SpanHandle {
	readonly context: SpanContext;
	private readonly name: string;
	private readonly kind: TraceSpanKind;
	private readonly startedMs: number;
	private readonly attributes: Record<string, string | number | boolean> = {};
	private readonly events: TraceSpanEvent[] = [];
	private readonly store: LocalTraceStore;
	private readonly redactor: Redactor;
	private readonly now: () => number;
	private readonly exporter: SpanExporter | null;
	private readonly onExportError: ((error: unknown) => void) | null;
	private dropped = 0;
	private status: { code: "unset" | "ok" | "error"; message?: string } = { code: "unset" };
	private ended = false;

	constructor(options: SpanHandleOptions) {
		this.name = options.name;
		this.kind = options.kind;
		this.startedMs = options.now();
		this.store = options.store;
		this.redactor = options.redactor;
		this.now = options.now;
		this.exporter = options.exporter;
		this.onExportError = options.onExportError;
		this.context = {
			traceId: options.parent?.traceId ?? randomBytes(16).toString("hex"),
			spanId: randomBytes(8).toString("hex"),
		};
		this.parentSpanId = options.parent?.spanId;
		const redacted = redactTraceAttributes(options.attributes, this.redactor);
		Object.assign(this.attributes, redacted.attributes);
		this.dropped += redacted.dropped;
	}

	private readonly parentSpanId: string | undefined;

	setAttribute(key: string, value: unknown): void {
		if (this.ended) return;
		const redacted = redactTraceAttributes({ [key]: value }, this.redactor);
		this.dropped += redacted.dropped;
		Object.assign(this.attributes, redacted.attributes);
	}

	addEvent(name: string, attributes?: Record<string, unknown>): void {
		if (this.ended) return;
		const safeName = sanitizeEventName(name);
		if (!safeName) {
			this.dropped += 1;
			return;
		}
		const redacted = redactTraceAttributes(attributes ?? {}, this.redactor);
		this.dropped += redacted.dropped;
		const event: TraceSpanEvent = {
			name: safeName,
			timeMs: this.now(),
			...(Object.keys(redacted.attributes).length > 0 ? { attributes: redacted.attributes } : {}),
		};
		this.events.push(event);
	}

	setStatus(code: "ok" | "error", message?: string): void {
		if (this.ended) return;
		this.status = {
			code,
			...(message !== undefined ? { message: sanitizeStatusMessage(message) } : {}),
		};
	}

	end(): TraceSpanDTO {
		if (this.ended) throw new Error("span_already_ended");
		this.ended = true;
		const endedMs = this.now();
		const dto: TraceSpanDTO = {
			traceId: this.context.traceId,
			spanId: this.context.spanId,
			...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
			name: this.name,
			kind: this.kind,
			startTimeMs: this.startedMs,
			endTimeMs: endedMs,
			durationMs: Math.max(0, endedMs - this.startedMs),
			status: this.status,
			attributes: { ...this.attributes },
			events: [...this.events],
			storedAt: endedMs,
			droppedAttributes: this.dropped,
		};
		this.store.add(dto);
		if (this.exporter) {
			try {
				this.exporter.export(dto);
			} catch (error) {
				this.onExportError?.(error);
			}
		}
		return dto;
	}

	isEnded(): boolean {
		return this.ended;
	}
}
