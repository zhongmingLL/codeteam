import { afterEach, describe, expect, it } from "vitest";
import { BudgetService, LocalCapacityProvider, StaticCapacityProvider, TaskReadinessService } from "../src/index.ts";
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

function approvedBacklog(base: W5AFixture, id: string, priority: "p0" | "p1" | "p2" | "p3", dependsOn?: string[]) {
	return base.store.backlog.create({
		id,
		userId: "user-1",
		title: id,
		summary: id,
		priority,
		tags: ["feature:F010"],
		createdByKind: "user",
		createdById: "user-1",
		initialStatus: "approved",
		importReason: "test",
		dependencies: dependsOn ? { dependsOn } : null,
	});
}

describe("W5c task readiness", () => {
	it("blocks dependents until every dependency is done, then admits in priority order", () => {
		const base = fixture();
		approvedBacklog(base, "dep-a", "p2");
		approvedBacklog(base, "dep-b", "p3");
		approvedBacklog(base, "dep-c", "p3", ["dep-a"]);
		const service = new TaskReadinessService(base.store, {
			capacity: new LocalCapacityProvider(base.store, { maxConcurrentRuns: 4 }),
		});

		const blocked = service.evaluateBacklog("dep-c", { now: base.now() });
		expect(blocked.ready).toBe(false);
		expect(blocked.reasons.map((reason) => reason.code)).toContain("dependency_unmet");
		expect(() =>
			base.store.dispatchBacklog({
				backlogItemId: "dep-c",
				targets: ["profile:coder"],
				threadPhase: "coding",
			}),
		).toThrowError(expect.objectContaining({ code: "dependency_unmet" }));

		base.store.backlog.overrideDone("dep-a", "test", "user-1");
		const ready = service.evaluateBacklog("dep-c", { now: base.now() });
		expect(ready.ready).toBe(true);
		expect(ready.priority).toBe("normal");

		approvedBacklog(base, "urgent-item", "p1");
		const ordered = service.listReadyBacklog({ now: base.now() });
		expect(ordered[0]?.id).toBe("urgent-item");
		expect(ordered.findIndex((decision) => decision.id === "dep-c")).toBeGreaterThan(0);
	});

	it("fails closed for missing dependencies and cycles", () => {
		const base = fixture();
		expect(() => approvedBacklog(base, "missing-dep", "p2", ["does-not-exist"])).toThrowError(
			expect.objectContaining({ code: "dependency_missing" }),
		);
		approvedBacklog(base, "corrupt-missing-dep", "p2");
		base.store.database
			.prepare("UPDATE backlog_items SET dependencies_json = ? WHERE id = ?")
			.run('{"dependsOn":["does-not-exist"]}', "corrupt-missing-dep");
		approvedBacklog(base, "cycle-a", "p2");
		approvedBacklog(base, "cycle-b", "p2");
		base.store.database
			.prepare("UPDATE backlog_items SET dependencies_json = ? WHERE id = ?")
			.run('{"dependsOn":["cycle-b"]}', "cycle-a");
		base.store.database
			.prepare("UPDATE backlog_items SET dependencies_json = ? WHERE id = ?")
			.run('{"dependsOn":["cycle-a"]}', "cycle-b");
		const service = new TaskReadinessService(base.store, { capacity: new StaticCapacityProvider(null) });

		expect(
			service.evaluateBacklog("corrupt-missing-dep", { now: base.now() }).reasons.map((reason) => reason.code),
		).toContain("dependency_missing");
		expect(service.evaluateBacklog("cycle-a", { now: base.now() }).reasons.map((reason) => reason.code)).toContain(
			"dependency_cycle",
		);
	});

	it("rejects a dependency update that would create a cycle", () => {
		const base = fixture();
		approvedBacklog(base, "edge-a", "p2");
		approvedBacklog(base, "edge-b", "p2");
		base.store.backlog.setDependencies("edge-a", ["edge-b"], "user-1");
		expect(() => base.store.backlog.setDependencies("edge-b", ["edge-a"], "user-1")).toThrowError(
			expect.objectContaining({ code: "dependency_cycle" }),
		);
		expect(base.store.backlog.setDependencies("edge-a", [], "user-1").dependencies).toBeNull();
	});

	it("treats unknown and exhausted worker capacity as blocked, never unlimited", () => {
		const base = fixture();
		const unknown = new TaskReadinessService(base.store, { capacity: new StaticCapacityProvider(null) });
		expect(unknown.evaluateTask("task-1", { now: base.now() }).reasons.map((reason) => reason.code)).toContain(
			"capacity_unknown",
		);

		const exhausted = new TaskReadinessService(base.store, {
			capacity: new StaticCapacityProvider({
				schemaVersion: 1,
				source: "w5b-registry",
				observedAt: base.now(),
				staleAfterMs: 1_000,
				slots: [{ slotId: "worker-1", role: "coder", status: "busy", capacity: 1, activeRuns: 1 }],
			}),
		});
		expect(exhausted.evaluateTask("task-1", { now: base.now() }).reasons.map((reason) => reason.code)).toContain(
			"capacity_exhausted",
		);

		const stale = new TaskReadinessService(base.store, {
			capacity: new StaticCapacityProvider({
				schemaVersion: 1,
				source: "w5b-registry",
				observedAt: base.now() - 10_000,
				staleAfterMs: 1_000,
				slots: [{ slotId: "worker-1", role: "coder", status: "available", capacity: 1, activeRuns: 0 }],
			}),
		});
		expect(stale.evaluateTask("task-1", { now: base.now() }).reasons.map((reason) => reason.code)).toContain(
			"capacity_unknown",
		);
	});

	it("counts canonical running runs in the local capacity projection", () => {
		const base = fixture();
		base.createRun({
			id: "run-running",
			sessionId: "session-coder",
			profileId: "profile:coder",
			role: "coder",
			sourceId: base.createSourceMessage("source-1").id,
		});
		base.createRun({
			id: "run-running-2",
			sessionId: "session-coder",
			profileId: "profile:coder",
			role: "coder",
			sourceId: base.createSourceMessage("source-2").id,
		});
		const service = new TaskReadinessService(base.store, {
			capacity: new LocalCapacityProvider(base.store, { maxConcurrentRuns: 1 }),
		});
		const decision = service.evaluateTask("task-1", { now: base.now() });
		expect(decision.ready).toBe(false);
		expect(decision.reasons.map((reason) => reason.code)).toContain("capacity_exhausted");
	});

	it("consumes W5b worker capacity snapshots when a registry exists", () => {
		const base = fixture();
		const now = base.now();
		base.store.workers.create({
			id: "worker-1",
			role: "coder",
			capacity: 1,
			heartbeatAt: now,
			leaseExpiresAt: now + 30_000,
		});
		base.store.workers.heartbeat("worker-1", { at: now, leaseMs: 30_000 });
		base.createRun({
			id: "run-worker",
			sessionId: "session-coder",
			profileId: "profile:coder",
			role: "coder",
			sourceId: base.createSourceMessage("worker capacity").id,
			workerId: "worker-1",
		});
		const service = new TaskReadinessService(base.store);
		expect(service.evaluateTask("task-1", { now }).reasons.map((reason) => reason.code)).toContain(
			"capacity_exhausted",
		);
		base.store.runs.terminal("run-worker", { status: "completed" });
		expect(service.evaluateTask("task-1", { now: now + 1 }).ready).toBe(true);
	});

	it("blocks a task whose budget is paused and a task with no worktree capacity", () => {
		const base = fixture();
		const budget = new BudgetService(base.store, base.now);
		budget.setLimits({ taskId: "task-1", tokensLimit: 0, actorRef: "user:user-1" });
		const service = new TaskReadinessService(base.store, {
			capacity: new LocalCapacityProvider(base.store, { maxConcurrentRuns: 4 }),
			worktree: { checkCapacity: () => ({ ok: false, code: "worktree_capacity_exhausted", message: "full" }) },
		});
		const decision = service.evaluateTask("task-1", { now: base.now() });
		expect(decision.reasons.map((reason) => reason.code)).toEqual(
			expect.arrayContaining(["budget_paused", "worktree_capacity_exhausted"]),
		);
	});
});
