import { afterEach, describe, expect, it } from "vitest";
import { createObservabilityRuntime } from "../src/observability/runtime.ts";
import { WorkerEventSink } from "../src/workers/event-sink.ts";
import { createW5AFixture, type W5AFixture } from "./helpers/w5a-fixture.ts";

const fixtures: W5AFixture[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function fixture(): W5AFixture {
	const created = createW5AFixture();
	fixtures.push(created);
	return created;
}

describe("W6c worker event sink observability", () => {
	it("records tool usage once and emits a redacted tool span", () => {
		const base = fixture();
		const source = base.createSourceMessage();
		const run = base.createRun({
			id: "run-1",
			profileId: "profile:coder",
			role: "coder",
			sessionId: "session-coder",
			sourceId: source.id,
		});
		const observability = createObservabilityRuntime({ dataDir: base.dataDir, env: {}, now: () => base.now() });
		const runSpan = observability.tracer.startRunSpan(run);
		const sink = new WorkerEventSink(base.store, run.id, {
			profileId: "profile:coder",
			toolUsage: base.store.toolUsage,
			observability,
			parentSpan: runSpan.context,
		});
		const start = {
			type: "tool_execution_start",
			toolName: "mcp__fs__read",
			toolCallId: "call-1",
			args: { path: "secret.txt", content: "secret body" },
		};
		sink.handle(start);
		sink.handle(start);
		sink.handle({
			type: "tool_execution_end",
			toolName: "mcp__fs__read",
			toolCallId: "call-1",
			isError: false,
			durationMs: 12,
		});
		runSpan.setStatus("ok");
		runSpan.end();
		sink.close();

		const events = base.store.runs.listEvents(run.id);
		expect(events.map((event) => event.kind)).toEqual(["tool_call", "tool_call", "tool_result"]);
		expect(base.store.toolUsage.report({ days: 1 }).summary.byCategory).toEqual({ native: 0, mcp: 1, skill: 0 });
		const traces = observability.traces.query({ invocationId: run.id });
		expect(traces.availability).toBe("available");
		expect(traces.spans).toHaveLength(2);
		expect(JSON.stringify(traces)).not.toContain("secret.txt");
		expect(JSON.stringify(traces)).not.toContain("secret body");
		expect(traces.spans.some((span) => span.attributes["tool.name"] === "mcp__fs__read")).toBe(true);
		expect(traces.spans.some((span) => span.attributes["tool.input.keys"] === "path,content")).toBe(true);
		expect(observability.metrics.renderPrometheus()).toContain("codeteam_tool_calls_total");
		expect(observability.logs).not.toBeNull();
	});

	it("does not fail execution when tool usage cannot be recorded", () => {
		const base = fixture();
		const source = base.createSourceMessage();
		const run = base.createRun({
			id: "run-1",
			profileId: "profile:coder",
			role: "coder",
			sessionId: "session-coder",
			sourceId: source.id,
		});
		const sink = new WorkerEventSink(base.store, run.id, {
			profileId: "profile:coder",
			toolUsage: {
				record: () => {
					throw new Error("counter unavailable");
				},
			},
		});
		expect(() => sink.handle({ type: "tool_execution_start", toolName: "bash", toolCallId: "call-1" })).not.toThrow();
		expect(sink.toolUsageWriteErrors).toBe(1);
		expect(base.store.runs.listEvents(run.id)).toHaveLength(1);
		sink.close();
	});
});
