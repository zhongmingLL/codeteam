import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentExecutor,
	createObservabilityRuntime,
	DispatchService,
	type ObservabilityRuntime,
	RetryableExecutionError,
} from "../src/index.ts";
import { createW5BFixture, type W5BFixture } from "./helpers/w5b-fixture.ts";

let fixture: W5BFixture | null = null;

afterEach(async () => {
	await fixture?.cleanup();
	fixture = null;
});

describe("W5b RPC executor", () => {
	it("emits a run span, tool spans, tool usage, and metrics through the executor", async () => {
		let observability: ObservabilityRuntime | null = null;
		fixture = createW5BFixture({
			observabilityFactory: (dataDir) => {
				observability = createObservabilityRuntime({ dataDir, env: {} });
				return observability;
			},
		});
		await fixture.runtime.start();
		const source = fixture.createSource("Observe this run.");
		fixture.enqueue({ sourceId: source.id });
		const drain = await fixture.dispatch.drain({ maxEntries: 1 });
		expect(drain.outcomes[0]?.status).toBe("completed");
		const run = fixture.store.runs.get(drain.runs[0]!.id)!;
		const traces = observability!.traces.query({ invocationId: run.id });
		expect(traces.availability).toBe("available");
		expect(traces.spans.map((span) => span.name)).toEqual(expect.arrayContaining(["codeteam.run", "codeteam.tool"]));
		expect(observability!.metrics.renderPrometheus()).toContain("codeteam_run_executions_total");
		expect(fixture.store.toolUsage.report({ days: 0 }).summary.totalCalls).toBeGreaterThan(0);
		await observability!.close();
	});

	it("executes through the dispatch chain, sticks the session, and isolates per-run tokens", async () => {
		fixture = createW5BFixture();
		await fixture.runtime.start();
		const { store, dispatch } = fixture;
		const firstSource = fixture.createSource("Implement the first task.");
		fixture.enqueue({ sourceId: firstSource.id });
		const firstDrain = await dispatch.drain();
		expect(firstDrain.outcomes[0]?.status).toBe("completed");
		const firstRun = store.runs.get(firstDrain.runs[0]!.id)!;
		expect(firstRun.workerId).not.toBeNull();
		expect(firstRun.attempt).toBe(1);
		const firstBody = store.messages.get(firstRun.responseMessageId!)!.bodyMd;
		expect(firstBody).toContain("FAKE_OK prompt=1");
		const firstToken = /token=([0-9a-f]+)/.exec(firstBody)?.[1];
		expect(firstToken).toBeDefined();
		expect(store.credentials.getByRun(firstRun.id)?.state).toBe("terminal");
		expect(store.credentials.getByRun(firstRun.id)?.disposition).toBe("completed");
		expect(existsSync(`${fixture.dataDir}/tokens/${firstRun.id}.token`)).toBe(false);
		const kinds = store.runs.listEvents(firstRun.id, 100).map((event) => event.kind);
		expect(kinds).toContain("tool_call");
		expect(kinds).toContain("tool_result");
		expect(kinds).toContain("message");

		const secondSource = fixture.createSource("Implement the second task.");
		fixture.enqueue({ sourceId: secondSource.id });
		const secondDrain = await dispatch.drain();
		const secondRun = store.runs.get(secondDrain.runs[0]!.id)!;
		expect(secondRun.workerId).toBe(firstRun.workerId);
		const secondBody = store.messages.get(secondRun.responseMessageId!)!.bodyMd;
		expect(secondBody).toContain("FAKE_OK prompt=2");
		const secondToken = /token=([0-9a-f]+)/.exec(secondBody)?.[1];
		expect(secondToken).toBeDefined();
		expect(secondToken).not.toBe(firstToken);
		expect(store.sessions.get("session-coder")?.workerId).toBe(firstRun.workerId);
		expect(store.sessions.get("session-coder")?.workerBindingState).toBe("attached");
	});

	it("turns worker crashes into interrupted runs, one retry, then a human dead-letter", async () => {
		fixture = createW5BFixture({ workerCrash: true });
		await fixture.runtime.start();
		const { store, dispatch } = fixture;
		const source = fixture.createSource("Crash the worker.");
		fixture.enqueue({ sourceId: source.id });
		const first = await dispatch.drain({ maxEntries: 1 });
		expect(first.outcomes[0]?.status).toBe("interrupted");
		const firstRun = store.runs.get(first.runs[0]!.id)!;
		expect(firstRun.status).toBe("interrupted");
		expect(store.queue.pendingCount()).toBe(1);
		expect(store.audit.latest(`run:${firstRun.id}`, "run_retry_queued")).toBeDefined();
		expect(store.sessions.get("session-coder")?.workerBindingState).toBe("re_attach_pending");

		const second = await dispatch.drain({ maxEntries: 1 });
		expect(second.outcomes[0]?.status).toBe("interrupted");
		const secondRun = store.runs.get(second.runs[0]!.id)!;
		expect(secondRun.attempt).toBe(2);
		expect(store.queue.pendingCount()).toBe(0);
		expect(store.audit.latest(`run:${secondRun.id}`, "run_dead_lettered")).toBeDefined();
		const escalation = store.inbox.list({ taskId: "task-w5b" });
		expect(escalation).toHaveLength(1);
		expect(escalation[0]?.kind).toBe("humanGuidance");
		expect(escalation[0]?.payload).toMatchObject({ kind: "dead_letter", attempts: 2 });
	});

	it("re-attaches a released session through the stored pi session file", async () => {
		fixture = createW5BFixture();
		await fixture.runtime.start();
		const { store, dispatch } = fixture;
		const firstSource = fixture.createSource("First run before re-attach.");
		fixture.enqueue({ sourceId: firstSource.id });
		const first = await dispatch.drain({ maxEntries: 1 });
		const firstRun = store.runs.get(first.runs[0]!.id)!;
		const workerId = firstRun.workerId!;
		const sessionFile = (store.sessions.get("session-coder")?.nativeSessionBinding as { sessionFile?: string })
			?.sessionFile;
		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(true);
		await fixture.runtime.harness.releaseWorker(workerId, "test_release");

		const secondSource = fixture.createSource("Second run after re-attach.");
		fixture.enqueue({ sourceId: secondSource.id });
		const second = await dispatch.drain({ maxEntries: 1 });
		const secondRun = store.runs.get(second.runs[0]!.id)!;
		expect(secondRun.workerId).not.toBe(workerId);
		expect(store.audit.latest("session:session-coder", "session_reattached")).toBeDefined();
		expect(store.sessions.get("session-coder")?.workerBindingState).toBe("attached");
		const lastArgs = readFileSync(fixture.argvFile, "utf8").trim().split("\n").at(-1)!;
		expect(lastArgs).toContain("--session");
		expect(lastArgs).toContain(sessionFile!);
	});

	it("falls back to a fresh session plus task capsule and records session_reattach_failed", async () => {
		fixture = createW5BFixture();
		await fixture.runtime.start();
		const { store, dispatch } = fixture;
		const firstSource = fixture.createSource("First run before losing the session file.");
		fixture.enqueue({ sourceId: firstSource.id });
		const first = await dispatch.drain({ maxEntries: 1 });
		const firstRun = store.runs.get(first.runs[0]!.id)!;
		const workerId = firstRun.workerId!;
		const sessionFile = (store.sessions.get("session-coder")?.nativeSessionBinding as { sessionFile?: string })
			?.sessionFile;
		expect(sessionFile).toBeDefined();
		unlinkSync(sessionFile!);
		await fixture.runtime.harness.releaseWorker(workerId, "test_release");

		const secondSource = fixture.createSource("Second run after losing the session file.");
		fixture.enqueue({ sourceId: secondSource.id });
		const second = await dispatch.drain({ maxEntries: 1 });
		const secondRun = store.runs.get(second.runs[0]!.id)!;
		const body = store.messages.get(secondRun.responseMessageId!)!.bodyMd;
		expect(body).toContain("capsule=yes");
		expect(body).toContain("Continuity degraded");
		expect(store.audit.latest(`session:session-coder`, "session_reattach_failed")).toBeDefined();
		const events = store.runs.listEvents(secondRun.id, 100);
		expect(events.some((event) => event.kind === "error")).toBe(true);
		const lastArgs = readFileSync(fixture.argvFile, "utf8").trim().split("\n").at(-1)!;
		expect(lastArgs).not.toContain("--session ");
		expect(lastArgs).toContain("--session-id");
	});

	it("drains a worker after its active run completes", async () => {
		fixture = createW5BFixture({ env: { FAKE_WORKER_DELAY_MS: "300" } });
		await fixture.runtime.start();
		const { store, dispatch } = fixture;
		const source = fixture.createSource("Drain after this run finishes.");
		fixture.enqueue({ sourceId: source.id });
		const drainPromise = dispatch.drain({ maxEntries: 1 });
		const running = await waitForRunningRun(store);
		const workerId = running.workerId!;
		const result = await fixture.runtime.drainWorker(workerId, 2_000);
		const drained = await drainPromise;
		expect(result.drained).toBe(true);
		expect(result.interruptedRunIds).toEqual([]);
		expect(drained.outcomes[0]?.status).toBe("completed");
		expect(store.workers.get(workerId)?.state).toBe("retired");
		expect(store.sessions.get("session-coder")?.workerBindingState).toBe("re_attach_pending");
	});

	it("forces a draining worker stale after the drain timeout", async () => {
		fixture = createW5BFixture({ workerHang: true });
		await fixture.runtime.start();
		const { store, dispatch } = fixture;
		const source = fixture.createSource("Hang until the drain timeout.");
		fixture.enqueue({ sourceId: source.id });
		const drainPromise = dispatch.drain({ maxEntries: 1 });
		const running = await waitForRunningRun(store);
		const workerId = running.workerId!;
		const result = await fixture.runtime.drainWorker(workerId, 100);
		const drained = await drainPromise;
		expect(result.drained).toBe(false);
		expect(result.interruptedRunIds).toContain(running.id);
		expect(drained.outcomes[0]?.status).toBe("interrupted");
		expect(store.runs.get(running.id)?.status).toBe("interrupted");
		expect(store.workers.get(workerId)?.state).toBe("retired");
		expect(store.queue.pendingCount()).toBe(1);
	});

	it("preserves retryable executor codes and queues a retry through the same queue", async () => {
		fixture = createW5BFixture();
		const { store } = fixture;
		const executor: AgentExecutor = {
			execute: async () => {
				throw new RetryableExecutionError("worker_timeout", "simulated timeout");
			},
		};
		const dispatch = new DispatchService(store, executor, fixture.now, fixture.runtime.dispatchHooks);
		const source = fixture.createSource("Retryable failure.");
		fixture.enqueue({ sourceId: source.id });
		const drain = await dispatch.drain({ maxEntries: 1 });
		expect(drain.outcomes[0]?.status).toBe("failed");
		const run = store.runs.get(drain.runs[0]!.id)!;
		const terminal = store.runs
			.listEvents(run.id, 100)
			.find((event) => (event.payload as { phase?: string }).phase === "terminal");
		expect((terminal?.payload as { reason?: string }).reason).toBe("worker_timeout");
		expect(store.queue.pendingCount()).toBe(1);
		expect(store.audit.latest(`run:${run.id}`, "run_retry_queued")).toBeDefined();
	});

	it("retries model errors within the bounded failure policy", async () => {
		fixture = createW5BFixture();
		const { store } = fixture;
		const executor: AgentExecutor = {
			execute: async () => {
				throw new RetryableExecutionError("model_error", "simulated model error");
			},
		};
		const dispatch = new DispatchService(store, executor, fixture.now, fixture.runtime.dispatchHooks);
		const source = fixture.createSource("Model error.");
		fixture.enqueue({ sourceId: source.id });
		const drain = await dispatch.drain({ maxEntries: 1 });
		expect(drain.outcomes[0]?.status).toBe("failed");
		const run = store.runs.get(drain.runs[0]!.id)!;
		const terminal = store.runs
			.listEvents(run.id, 100)
			.find((event) => (event.payload as { phase?: string }).phase === "terminal");
		expect((terminal?.payload as { reason?: string }).reason).toBe("model_error");
		expect(store.queue.pendingCount()).toBe(1);
		expect(store.audit.latest(`run:${run.id}`, "run_retry_queued")).toBeDefined();
	});
});

async function waitForRunningRun(store: W5BFixture["store"], timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const running = store.runs.list({ status: "running" })[0];
		if (running?.workerId) return running;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("no running run with a worker");
}
