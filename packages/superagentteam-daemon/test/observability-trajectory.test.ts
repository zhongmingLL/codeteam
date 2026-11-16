import { afterEach, describe, expect, it } from "vitest";
import { createRedactor } from "../src/observability/redaction.ts";
import { LocalTraceStore } from "../src/observability/trace-store.ts";
import { Tracer } from "../src/observability/tracer.ts";
import { TrajectoryService } from "../src/observability/trajectory.ts";
import { createW5AFixture, type W5AFixture } from "./helpers/w5a-fixture.ts";

const fixtures: W5AFixture[] = [];
const redactor = createRedactor({ salt: "trajectory-test-salt" });

afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function fixture(): W5AFixture {
	const created = createW5AFixture();
	fixtures.push(created);
	return created;
}

function seedRun(base: W5AFixture) {
	const source = base.createSourceMessage("raw source body");
	const response = base.store.messages.append({
		threadId: "thread-1",
		taskId: "task-1",
		authorKind: "agent",
		authorId: "profile:coder",
		kind: "agent_response",
		bodyMd: "raw response body",
	});
	const run = base.store.runs.create({
		id: "run-1",
		taskId: "task-1",
		role: "coder",
		agentSessionId: "session-coder",
		sourceId: source.id,
		recipientProfileId: "profile:coder",
		provider: "test",
		model: "model-coder",
		modelFamily: "test-family",
		responseMessageId: response.id,
		usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, detail: "raw prompt" },
	});
	base.store.runs.appendEvent(run.id, "message", { phase: "assistant", text: "raw assistant text" });
	base.store.runs.appendEvent(run.id, "tool_call", { phase: "start", toolName: "bash", toolCallId: "call-1" });
	base.store.runs.appendEvent(run.id, "tool_result", {
		phase: "end",
		toolName: "bash",
		toolCallId: "call-1",
		isError: false,
		durationMs: 12,
	});
	base.store.runs.appendEvent(run.id, "error", { phase: "extension_error", error: "secret stack" });
	base.store.runs.terminal(run.id, { status: "completed" });
	return { source, response, run: base.store.runs.get(run.id)! };
}

describe("W6c invocation trajectory", () => {
	it("projects only canonical tables and never inlines content", () => {
		const base = fixture();
		const seeded = seedRun(base);
		const traces = new LocalTraceStore({ hmacId: (id) => redactor.hmacId(id), now: () => base.now() });
		const tracer = new Tracer({ store: traces, redactor, now: () => base.now() });
		const span = tracer.startRunSpan(seeded.run);
		span.setStatus("ok");
		span.end();
		const service = new TrajectoryService({ store: base.store, traces });
		const before = base.store.database.prepare("SELECT COUNT(*) AS count FROM run_events").get() as { count: number };
		const trajectory = service.get("run-1")!;
		const after = base.store.database.prepare("SELECT COUNT(*) AS count FROM run_events").get() as { count: number };

		expect(trajectory.inv).toBe("inv:run-1");
		expect(trajectory.run.status).toBe("completed");
		expect(trajectory.run.usage).toEqual({ inputTokens: 12, outputTokens: 3, totalTokens: 15 });
		expect(trajectory.task?.id).toBe("task-1");
		expect(trajectory.thread?.id).toBe("thread-1");
		expect(trajectory.sourceMessage?.id).toBe(seeded.source.id);
		expect(trajectory.sourceMessage?.bodyBytes).toBe(Buffer.byteLength("raw source body"));
		expect(trajectory.responseMessage?.id).toBe(seeded.response.id);
		expect(trajectory.steps.map((step) => step.kind)).toEqual(["message", "tool_call", "tool_result", "error"]);
		expect(trajectory.steps.map((step) => step.seq)).toEqual([1, 2, 3, 4]);
		expect(trajectory.steps[0]?.attributes.textBytes).toBe(Buffer.byteLength("raw assistant text"));
		expect(trajectory.steps[3]?.attributes.errorBytes).toBe(Buffer.byteLength("secret stack"));
		expect(trajectory.trace.availability).toBe("available");
		expect(trajectory.trace.spans).toHaveLength(1);
		expect(before.count).toBe(after.count);
		const serialized = JSON.stringify(trajectory);
		expect(serialized).not.toContain("raw source body");
		expect(serialized).not.toContain("raw response body");
		expect(serialized).not.toContain("raw assistant text");
		expect(serialized).not.toContain("secret stack");
	});

	it("returns explicit trace_unavailable for disabled telemetry and ring miss", () => {
		const base = fixture();
		seedRun(base);
		const disabled = new TrajectoryService({ store: base.store, traces: null }).get("run-1")!;
		expect(disabled.trace).toMatchObject({ availability: "trace_unavailable", reason: "telemetry_disabled" });
		const empty = new LocalTraceStore({ hmacId: (id) => redactor.hmacId(id) });
		const missed = new TrajectoryService({ store: base.store, traces: empty }).get("run-1")!;
		expect(missed.trace).toMatchObject({ availability: "trace_unavailable", reason: "ring_miss" });
	});

	it("returns null for an unknown invocation", () => {
		const base = fixture();
		expect(new TrajectoryService({ store: base.store, traces: null }).get("missing")).toBeNull();
	});
});
