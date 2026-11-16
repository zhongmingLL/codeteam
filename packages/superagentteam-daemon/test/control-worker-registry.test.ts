import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mintInvocationCredential } from "../src/index.ts";
import { createW5BFixture, type W5BFixture } from "./helpers/w5b-fixture.ts";

let fixture: W5BFixture | null = null;

afterEach(async () => {
	await fixture?.cleanup();
	fixture = null;
});

describe("W5b worker registry", () => {
	it("registers role/capacity, heartbeats the lease, and projects bound sessions", () => {
		fixture = createW5BFixture();
		const { runtime, store } = fixture;
		const worker = runtime.registry.register({ workerId: "worker-1", role: "coder" });
		expect(worker.state).toBe("starting");
		expect(worker.capacity).toBe(1);
		const session = runtime.registry.bindSession("session-coder", "worker-1");
		expect(session.workerId).toBe("worker-1");
		expect(session.workerBindingState).toBe("attached");
		fixture.advance(500);
		const online = runtime.registry.heartbeat("worker-1");
		expect(online.state).toBe("online");
		const snapshot = runtime.registry.snapshot("worker-1");
		expect(snapshot).toMatchObject({
			workerId: "worker-1",
			role: "coder",
			capacity: 1,
			activeRuns: 0,
			activeSessions: 0,
			boundSessions: 1,
			availableSlots: 0,
		});
		expect(store.audit.latest("worker:worker-1", "worker_registered")?.args).toMatchObject({
			heartbeatIntervalMs: 1_000,
			leaseMs: 2_000,
		});
	});

	it("rejects a second session when an RPC worker is at capacity", () => {
		fixture = createW5BFixture();
		const { runtime, store } = fixture;
		runtime.registry.register({ workerId: "worker-1", role: "coder" });
		runtime.registry.heartbeat("worker-1");
		runtime.registry.bindSession("session-coder", "worker-1");
		store.sessions.create({
			id: "session-coder-2",
			threadId: "thread-w5b",
			taskId: "task-w5b",
			profileId: "profile:coder",
			role: "coder",
			effectiveToolPolicy: "default",
			provider: "test",
			model: "fake",
			modelFamily: "test",
			seq: 1,
			userId: "user-1",
		});
		expect(() => runtime.registry.bindSession("session-coder-2", "worker-1")).toThrowError(/capacity/i);
	});

	it("never revives a stale worker and routes the session to re-attach", () => {
		fixture = createW5BFixture();
		const { runtime } = fixture;
		runtime.registry.register({ workerId: "worker-1", role: "coder" });
		runtime.registry.heartbeat("worker-1");
		runtime.registry.bindSession("session-coder", "worker-1");
		fixture.advance(3_000);
		const stale = runtime.registry.markStale("worker-1", "test_stale");
		expect(stale.state).toBe("stale");
		expect(() => runtime.registry.heartbeat("worker-1")).toThrowError(/stale/);
		const resolution = runtime.registry.resolveSessionWorker("session-coder");
		expect(resolution.kind).toBe("reattach");
	});

	it("treats an expired online lease as re-attach before a sweep runs", () => {
		fixture = createW5BFixture();
		const { runtime } = fixture;
		runtime.registry.register({ workerId: "worker-1", role: "coder" });
		runtime.registry.heartbeat("worker-1");
		runtime.registry.bindSession("session-coder", "worker-1");
		fixture.advance(3_000);
		expect(runtime.registry.snapshot("worker-1")?.state).toBe("online");
		const resolution = runtime.registry.resolveSessionWorker("session-coder");
		expect(resolution.kind).toBe("reattach");
	});

	it("marks stale worker runs interrupted, session re_attach_pending, and queues one retry", async () => {
		fixture = createW5BFixture();
		const { runtime, store } = fixture;
		runtime.registry.register({ workerId: "worker-1", role: "coder" });
		runtime.registry.heartbeat("worker-1");
		runtime.registry.bindSession("session-coder", "worker-1");
		const source = fixture.createSource("worker stale test");
		const run = store.runs.create({
			id: "run-stale",
			taskId: "task-w5b",
			role: "coder",
			agentSessionId: "session-coder",
			sourceId: source.id,
			recipientProfileId: "profile:coder",
			provider: "test",
			model: "fake",
			modelFamily: "test",
			workerId: "worker-1",
			attempt: 1,
		});
		fixture.advance(3_000);
		const sweep = await runtime.sweepStale();
		expect(sweep.staleWorkerIds).toEqual(["worker-1"]);
		expect(sweep.interruptedRunIds).toContain(run.id);
		expect(sweep.reattachSessionIds).toContain("session-coder");
		expect(store.runs.get(run.id)?.status).toBe("interrupted");
		expect(store.sessions.get("session-coder")?.workerBindingState).toBe("re_attach_pending");
		expect(store.queue.pendingCount()).toBe(1);
		expect(store.audit.latest(`run:${run.id}`, "run_retry_queued")).toBeDefined();
		const second = await runtime.sweepStale();
		expect(second.interruptedRunIds).toEqual([]);
		expect(store.queue.pendingCount()).toBe(1);
	});

	it("recovers a running run with no live worker and retries it once", async () => {
		fixture = createW5BFixture();
		const { runtime, store } = fixture;
		const source = fixture.createSource("daemon restart test");
		const run = store.runs.create({
			id: "run-restart",
			taskId: "task-w5b",
			role: "coder",
			agentSessionId: "session-coder",
			sourceId: source.id,
			recipientProfileId: "profile:coder",
			provider: "test",
			model: "fake",
			modelFamily: "test",
			attempt: 1,
		});
		const minted = mintInvocationCredential(store, {
			runId: run.id,
			tokenDir: join(fixture.dataDir, "tokens"),
		});
		expect(existsSync(minted.tokenPath!)).toBe(true);
		const result = await runtime.recover();
		expect(result.interruptedRunIds).toContain(run.id);
		expect(store.runs.get(run.id)?.status).toBe("interrupted");
		expect(store.queue.pendingCount()).toBe(1);
		expect(existsSync(minted.tokenPath!)).toBe(false);
		const retry = store.queue.listPending()[0]!;
		expect(retry.sourceCategory).toBe("worker_retry");
		expect(retry.authorIntent["profile:coder"]).toMatchObject({ chainMetadata: { attempt: 2, retryOf: run.id } });
	});
});
