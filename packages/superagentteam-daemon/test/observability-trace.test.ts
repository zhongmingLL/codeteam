import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRedactor } from "../src/observability/redaction.ts";
import { LocalTraceStore } from "../src/observability/trace-store.ts";
import { Tracer } from "../src/observability/tracer.ts";

const redactor = createRedactor({ salt: "trace-test-salt" });

function hexId(seed: string, length: number): string {
	return createHash("sha256").update(seed).digest("hex").slice(0, length);
}

function span(traceSeed: string, spanSeed: string, invocationId: string, storedAt: number, name = "codeteam.run") {
	return {
		traceId: hexId(traceSeed, 32),
		spanId: hexId(spanSeed, 16),
		name,
		kind: "internal" as const,
		startTimeMs: storedAt,
		endTimeMs: storedAt + 10,
		durationMs: 10,
		status: { code: "ok" as const },
		attributes: { "invocation.id": redactor.hmacId(invocationId), "profile.id": "profile:coder" },
		events: [],
		storedAt,
		droppedAttributes: 0,
	};
}

describe("W6c local trace ring", () => {
	it("evicts by age and capacity, newest first", () => {
		let now = 1_000;
		const store = new LocalTraceStore({
			maxSpans: 2,
			maxAgeMs: 100,
			now: () => now,
			hmacId: (id) => redactor.hmacId(id),
		});
		store.add(span("t1", "s1", "run-1", now));
		now += 10;
		store.add(span("t2", "s2", "run-2", now));
		now += 10;
		store.add(span("t3", "s3", "run-3", now));
		expect(store.stats().spanCount).toBe(2);
		expect(store.query({}).spans.map((item) => item.spanId)).toEqual([hexId("s3", 16), hexId("s2", 16)]);
		now += 200;
		expect(store.query({}).availability).toBe("trace_unavailable");
		expect(store.query({}).reason).toBe("ring_miss");
		expect(store.stats().spanCount).toBe(0);
	});

	it("matches raw invocation ids through HMAC without storing them", () => {
		const now = 1_000;
		const store = new LocalTraceStore({ now: () => now, hmacId: (id) => redactor.hmacId(id) });
		store.add(span("t1", "s1", "run-1", now));
		store.add(span("t2", "s2", "run-2", now));
		expect(store.query({ invocationId: "run-1" }).spans).toHaveLength(1);
		expect(store.query({ invocationId: "run-1" }).spans[0]?.attributes["invocation.id"]).toBe(
			redactor.hmacId("run-1"),
		);
		expect(store.query({ invocationId: "run-1" }).spans[0]?.attributes["invocation.id"]).not.toBe("run-1");
	});

	it("returns explicit trace_unavailable for a ring miss and telemetry disabled", () => {
		const store = new LocalTraceStore({ hmacId: (id) => redactor.hmacId(id) });
		expect(store.query({ invocationId: "missing" })).toMatchObject({
			availability: "trace_unavailable",
			reason: "ring_miss",
			spans: [],
		});
		const disabled = new LocalTraceStore({ disabledReason: "test" });
		expect(disabled.query({ invocationId: "missing" })).toMatchObject({
			availability: "trace_unavailable",
			reason: "telemetry_disabled",
		});
	});

	it("revalidates DTOs at the store boundary", () => {
		const now = 1_000;
		const store = new LocalTraceStore({ now: () => now });
		store.add({
			traceId: "c".repeat(32),
			spanId: "d".repeat(16),
			name: "codeteam.test",
			kind: "internal",
			startTimeMs: now,
			endTimeMs: now + 1,
			durationMs: 1,
			status: { code: "error", message: "raw error body with spaces" },
			attributes: { "tool.name": "bash", "invocation.id": "run-1", prompt: "raw prompt" },
			events: [{ name: "Bad Event", timeMs: now }],
			storedAt: now,
			droppedAttributes: 0,
		});
		const result = store.query({ traceId: "c".repeat(32) });
		expect(result.availability).toBe("available");
		const stored = result.spans[0]!;
		expect(stored.attributes.prompt).toBeUndefined();
		expect(stored.attributes["invocation.id"]).toBeUndefined();
		expect(stored.status.message).toBe("[redacted]");
		expect(stored.events).toHaveLength(0);
		expect(stored.droppedAttributes).toBe(3);
		store.add({
			...stored,
			traceId: "not-a-trace-id",
			name: "bad name with spaces",
		});
		expect(store.stats().spanCount).toBe(1);
	});

	it("marks truncated when more spans match than the limit", () => {
		const now = 1_000;
		const store = new LocalTraceStore({ now: () => now, hmacId: (id) => redactor.hmacId(id) });
		for (let index = 0; index < 5; index += 1) store.add(span("t", `s${index}`, "run-1", now + index));
		const result = store.query({ invocationId: "run-1", limit: 2 });
		expect(result.spans).toHaveLength(2);
		expect(result.truncated).toBe(true);
	});
});

describe("W6c tracer", () => {
	it("stores redacted run and tool spans with parent links", () => {
		let now = 1_000;
		const store = new LocalTraceStore({ now: () => now, hmacId: (id) => redactor.hmacId(id) });
		const tracer = new Tracer({ store, redactor, now: () => now });
		const runSpan = tracer.startSpan({
			name: "codeteam.run",
			attributes: {
				"invocation.id": "run-1",
				"profile.id": "profile:coder",
				"tool.name": "bash",
				prompt: "raw prompt",
			},
		});
		now += 5;
		const toolSpan = tracer.startToolSpan(runSpan.context, {
			toolName: "mcp__fs__read",
			category: "mcp",
			toolCallId: "call-1",
			inputKeys: ["path", "content"],
			invocationId: "run-1",
		});
		now += 7;
		toolSpan.setStatus("ok");
		const toolDto = toolSpan.end();
		runSpan.addEvent("run.step", { "event.kind": "tool_call", prompt: "raw" });
		runSpan.setStatus("ok");
		const runDto = runSpan.end();

		expect(runDto.attributes.prompt).toBeUndefined();
		expect(runDto.attributes["invocation.id"]).toBe(redactor.hmacId("run-1"));
		expect(runDto.droppedAttributes).toBe(2);
		expect(toolDto.parentSpanId).toBe(runDto.spanId);
		expect(toolDto.attributes["tool.call.id"]).toBe(redactor.hmacId("call-1"));
		expect(toolDto.attributes["tool.input.keys"]).toBe("path,content");
		expect(toolDto.durationMs).toBe(7);
		expect(store.stats().spanCount).toBe(2);
		expect(store.query({ invocationId: "run-1" }).spans).toHaveLength(2);
		expect(JSON.stringify(store.query({ invocationId: "run-1" }))).not.toContain("raw prompt");
	});

	it("does not throw when a span is ended twice", () => {
		const store = new LocalTraceStore({ now: () => 1_000, hmacId: (id) => redactor.hmacId(id) });
		const tracer = new Tracer({ store, redactor, now: () => 1_000 });
		const span = tracer.startSpan({ name: "codeteam.test" });
		span.end();
		expect(() => span.end()).toThrowError("span_already_ended");
	});
});
