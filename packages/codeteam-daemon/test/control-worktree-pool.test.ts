import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreePoolService } from "../src/index.ts";
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

function pool(
	base: W5AFixture,
	overrides: Partial<ConstructorParameters<typeof WorktreePoolService>[1]> = {},
): WorktreePoolService {
	return new WorktreePoolService(base.store, {
		rootDir: join(base.dataDir, "worktrees"),
		maxLeases: 2,
		minFreeBytes: 100,
		leaseTtlMs: 1_000,
		reclaimGraceMs: 10,
		releasedTtlMs: 10,
		orphanTtlMs: 10,
		diskFree: { availableBytes: () => 1_000 },
		...overrides,
	});
}

describe("W5c worktree pool and GC", () => {
	it("leases, enforces the pool limit, and removes a released lease", () => {
		const base = fixture();
		const service = pool(base, { maxLeases: 1 });
		const lease = service.acquire({ taskId: "task-1", now: base.now() });
		expect(existsSync(lease.path)).toBe(true);
		expect(service.checkCapacity()).toMatchObject({ ok: false, code: "worktree_capacity_exhausted" });
		expect(() => service.acquire({ taskId: "task-1", now: base.now() })).toThrowError(
			expect.objectContaining({ code: "worktree_capacity_exhausted" }),
		);
		service.release(lease.id, { remove: true });
		expect(existsSync(lease.path)).toBe(false);
		expect(base.store.worktreeLeases.get(lease.id)?.status).toBe("collected");
	});

	it("fails closed when disk free space is low or unreadable", () => {
		const base = fixture();
		const low = pool(base, { minFreeBytes: 100, diskFree: { availableBytes: () => 99 } });
		expect(low.checkCapacity()).toMatchObject({ ok: false, code: "worktree_disk_low" });
		const unknown = pool(base, {
			diskFree: {
				availableBytes: () => {
					throw new Error("statfs unavailable");
				},
			},
		});
		expect(unknown.checkCapacity()).toMatchObject({ ok: false, code: "worktree_disk_unknown" });
	});

	it("supports dry-run then real GC for released and expired terminal leases", () => {
		const base = fixture();
		const service = pool(base);
		const released = service.acquire({ taskId: "task-1", now: base.now() });
		service.release(released.id);
		base.store.tasks.setStatus("task-1", "done");
		const expired = service.acquire({ taskId: "task-1", ttlMs: 1, now: base.now() });
		const now = base.now() + 100;

		const dryRun = service.gc({ now, dryRun: true });
		expect(dryRun.dryRun).toBe(true);
		expect(dryRun.entries.map((entry) => entry.reason).sort()).toEqual(["expired_task_terminal", "released_ttl"]);
		expect(existsSync(released.path)).toBe(true);
		expect(existsSync(expired.path)).toBe(true);

		const collected = service.gc({ now, dryRun: false });
		expect(collected.entries).toHaveLength(2);
		expect(existsSync(released.path)).toBe(false);
		expect(existsSync(expired.path)).toBe(false);
		expect(base.store.worktreeLeases.get(released.id)?.status).toBe("collected");
		expect(base.store.worktreeLeases.get(expired.id)?.status).toBe("collected");
	});

	it("collects orphan directories only after the TTL", () => {
		const base = fixture();
		const service = pool(base);
		const orphan = join(base.dataDir, "worktrees", "orphan");
		mkdirSync(orphan, { recursive: true });
		writeFileSync(join(orphan, "file.txt"), "x");
		const old = new Date(base.now() - 1_000);
		utimesSync(orphan, old, old);

		const report = service.gc({ now: base.now(), dryRun: false });
		expect(report.entries).toContainEqual(expect.objectContaining({ id: null, reason: "orphan_ttl" }));
		expect(existsSync(orphan)).toBe(false);
	});

	it("reclaims an expired lease for an inactive non-done task after the grace period", () => {
		const base = fixture();
		const service = pool(base);
		base.store.tasks.setStatus("task-1", "doing");
		const lease = service.acquire({ taskId: "task-1", ttlMs: 1, now: base.now() });

		expect(service.gc({ now: base.now() + 5, dryRun: false }).entries.some((entry) => entry.id === lease.id)).toBe(
			false,
		);
		const collected = service.gc({ now: base.now() + 12, dryRun: false });
		expect(collected.entries).toContainEqual(
			expect.objectContaining({ id: lease.id, reason: "expired_task_inactive" }),
		);
		expect(base.store.worktreeLeases.get(lease.id)?.status).toBe("collected");
		expect(service.checkCapacity()).toMatchObject({ ok: true, activeLeases: 0 });
	});

	it("protects an expired non-done lease while a run is active", () => {
		const base = fixture();
		const service = pool(base);
		base.store.tasks.setStatus("task-1", "doing");
		const lease = service.acquire({ taskId: "task-1", ttlMs: 1, now: base.now() });
		const run = base.createRun({
			id: "run-active-lease",
			sessionId: "session-coder",
			profileId: "profile:coder",
			role: "coder",
			sourceId: base.createSourceMessage("active lease").id,
		});

		expect(service.gc({ now: base.now() + 100, dryRun: false }).entries.some((entry) => entry.id === lease.id)).toBe(
			false,
		);
		expect(existsSync(lease.path)).toBe(true);
		base.store.runs.terminal(run.id, { status: "interrupted" });
		expect(service.gc({ now: base.now() + 100, dryRun: false }).entries).toContainEqual(
			expect.objectContaining({ id: lease.id, reason: "expired_task_inactive" }),
		);
	});

	it("refuses to remove a lease path outside the pool root", () => {
		const base = fixture();
		const service = pool(base);
		const outside = join(base.dataDir, "outside");
		mkdirSync(outside);
		base.store.worktreeLeases.create({
			taskId: "task-1",
			path: outside,
			leaseExpiresAt: base.now() - 1,
		});
		base.store.worktreeLeases.release(base.store.worktreeLeases.list()[0]!.id);
		expect(() => service.gc({ now: base.now() + 100, dryRun: false })).toThrowError(
			expect.objectContaining({ code: "path_outside_root" }),
		);
	});
});
