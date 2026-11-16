import type { TraceQuery, TraceQueryResult, TraceSpanDTO, TraceSpanEvent } from "./contracts.ts";
import { sanitizeEventName, sanitizeSpanName, sanitizeStatusMessage, TRACE_ATTRIBUTE_ALLOWLIST } from "./redaction.ts";

export const LOCAL_TRACE_DEFAULT_MAX_SPANS = 10_000;
export const LOCAL_TRACE_DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface LocalTraceStoreOptions {
	readonly maxSpans?: number;
	readonly maxAgeMs?: number;
	readonly now?: () => number;
	/** HMAC function used to match raw invocation ids without storing them. */
	readonly hmacId?: (id: string) => string;
	/** When set, queries return telemetry_disabled instead of ring_miss. */
	readonly disabledReason?: string;
}

export interface LocalTraceStoreStats {
	readonly spanCount: number;
	readonly maxSpans: number;
	readonly maxAgeMs: number;
	readonly oldestStoredAt: number | null;
	readonly newestStoredAt: number | null;
}

/**
 * In-memory, redacted trace ring. This is a cache, not a ledger: restart and
 * ring eviction are expected. Canonical trajectory truth always comes from the
 * control tables.
 *
 * `add()` revalidates the DTO at the store boundary. This is defense in depth:
 * even a caller that bypasses Tracer cannot inject unknown attributes, raw
 * status text, or malformed span names into the ring.
 */
export class LocalTraceStore {
	private readonly buffer: TraceSpanDTO[] = [];
	private readonly maxSpans: number;
	private readonly maxAgeMs: number;
	private readonly now: () => number;
	private readonly hmacId: ((id: string) => string) | null;
	private readonly disabledReason: string | null;

	constructor(options: LocalTraceStoreOptions = {}) {
		this.maxSpans = Math.max(1, options.maxSpans ?? LOCAL_TRACE_DEFAULT_MAX_SPANS);
		this.maxAgeMs = Math.max(1, options.maxAgeMs ?? LOCAL_TRACE_DEFAULT_MAX_AGE_MS);
		this.now = options.now ?? Date.now;
		this.hmacId = options.hmacId ?? null;
		this.disabledReason = options.disabledReason ?? null;
	}

	add(span: TraceSpanDTO): void {
		if (this.disabledReason) return;
		const sanitized = sanitizeSpan(span, this.now());
		if (!sanitized) return;
		this.evictExpired();
		while (this.buffer.length >= this.maxSpans) this.buffer.shift();
		this.buffer.push(sanitized);
	}

	query(filter: TraceQuery = {}): TraceQueryResult {
		if (this.disabledReason) {
			return {
				availability: "trace_unavailable",
				reason: "telemetry_disabled",
				spans: [],
				truncated: false,
			};
		}
		this.evictExpired();
		const limit = clampLimit(filter.limit);
		const invocationId = filter.invocationId && this.hmacId ? this.hmacId(filter.invocationId) : filter.invocationId;
		const matches: TraceSpanDTO[] = [];
		for (let index = this.buffer.length - 1; index >= 0; index -= 1) {
			const span = this.buffer[index]!;
			if (filter.traceId && span.traceId !== filter.traceId) continue;
			if (invocationId && span.attributes["invocation.id"] !== invocationId) continue;
			if (filter.profileId && span.attributes["profile.id"] !== filter.profileId) continue;
			if (filter.name && span.name !== filter.name) continue;
			if (filter.startMin !== undefined && span.startTimeMs < filter.startMin) continue;
			if (filter.startMax !== undefined && span.startTimeMs > filter.startMax) continue;
			matches.push(span);
		}
		if (matches.length === 0) {
			return { availability: "trace_unavailable", reason: "ring_miss", spans: [], truncated: false };
		}
		return {
			availability: "available",
			spans: matches.slice(0, limit),
			truncated: matches.length > limit,
		};
	}

	stats(): LocalTraceStoreStats {
		this.evictExpired();
		return {
			spanCount: this.buffer.length,
			maxSpans: this.maxSpans,
			maxAgeMs: this.maxAgeMs,
			oldestStoredAt: this.buffer.length > 0 ? this.buffer[0]!.storedAt : null,
			newestStoredAt: this.buffer.length > 0 ? this.buffer[this.buffer.length - 1]!.storedAt : null,
		};
	}

	clear(): void {
		this.buffer.length = 0;
	}

	private evictExpired(): void {
		const cutoff = this.now() - this.maxAgeMs;
		while (this.buffer.length > 0 && this.buffer[0]!.storedAt < cutoff) this.buffer.shift();
	}
}

function sanitizeSpan(span: TraceSpanDTO, now: number): TraceSpanDTO | null {
	if (!span.status || !span.attributes || !span.name) return null;
	if (!/^[0-9a-f]{32}$/.test(span.traceId) || !/^[0-9a-f]{16}$/.test(span.spanId)) return null;
	if (span.parentSpanId !== undefined && !/^[0-9a-f]{16}$/.test(span.parentSpanId)) return null;
	const name = sanitizeSpanName(span.name);
	if (!name) return null;
	if (!Number.isFinite(span.startTimeMs) || !Number.isFinite(span.endTimeMs)) return null;
	if (span.kind !== "internal" && span.kind !== "server" && span.kind !== "client") return null;
	if (span.status.code !== "unset" && span.status.code !== "ok" && span.status.code !== "error") return null;
	let dropped = span.droppedAttributes;
	const attributesResult = sanitizeAttributes(span.attributes);
	dropped += attributesResult.dropped;
	const events: TraceSpanEvent[] = [];
	const sourceEvents = Array.isArray(span.events) ? span.events : [];
	for (const event of sourceEvents.slice(0, 32)) {
		if (!event || typeof event !== "object") {
			dropped += 1;
			continue;
		}
		const eventName = sanitizeEventName(event.name);
		if (!eventName) {
			dropped += 1;
			continue;
		}
		const eventAttributes = event.attributes ? sanitizeAttributes(event.attributes) : null;
		if (eventAttributes) dropped += eventAttributes.dropped;
		events.push({
			name: eventName,
			timeMs: Number.isFinite(event.timeMs) ? event.timeMs : span.endTimeMs,
			...(eventAttributes && Object.keys(eventAttributes.attributes).length > 0
				? { attributes: eventAttributes.attributes }
				: {}),
		});
	}
	return {
		traceId: span.traceId,
		spanId: span.spanId,
		...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
		name,
		kind: span.kind,
		startTimeMs: span.startTimeMs,
		endTimeMs: span.endTimeMs,
		durationMs: Math.max(0, span.endTimeMs - span.startTimeMs),
		status: {
			code: span.status.code,
			...(span.status.message ? { message: sanitizeStatusMessage(span.status.message) } : {}),
		},
		attributes: attributesResult.attributes,
		events,
		storedAt: Number.isFinite(span.storedAt) ? span.storedAt : now,
		droppedAttributes: dropped,
	};
}

function sanitizeAttributes(attributes: Readonly<Record<string, string | number | boolean>>): {
	attributes: Record<string, string | number | boolean>;
	dropped: number;
} {
	const result: Record<string, string | number | boolean> = {};
	let dropped = 0;
	for (const [key, value] of Object.entries(attributes)) {
		const classification = TRACE_ATTRIBUTE_ALLOWLIST.get(key);
		if (!classification) {
			dropped += 1;
			continue;
		}
		if (classification === "number" && typeof value === "number" && Number.isFinite(value)) {
			result[key] = value;
			continue;
		}
		if (classification === "boolean" && typeof value === "boolean") {
			result[key] = value;
			continue;
		}
		if ((classification === "id" || classification === "string") && typeof value === "string") {
			if (value.length > 0 && value.length <= 256 && (classification !== "id" || /^[0-9a-f]{32}$/.test(value))) {
				result[key] = value;
				continue;
			}
		}
		dropped += 1;
	}
	return { attributes: result, dropped };
}

function clampLimit(limit: number | undefined): number {
	if (limit === undefined) return 100;
	if (!Number.isFinite(limit)) return 100;
	return Math.min(Math.max(Math.trunc(limit), 1), 500);
}
