import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactGCService } from "../src/index.ts";
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

describe("W5c artifact GC", () => {
	it("only collects expired logs for done tasks, never protected evidence", () => {
		const base = fixture();
		const source = base.createSourceMessage();
		base.store.tasks.setStatus("task-1", "done");
		const old = base.now() - 10_000;
		const log = base.store.artifacts.put({
			taskId: "task-1",
			kind: "log",
			content: Buffer.from("old log"),
			mediaType: "text/plain",
			provenance: { sourceMessageId: source.id },
			createdAt: old,
		});
		const spec = base.store.artifacts.put({
			taskId: "task-1",
			kind: "spec",
			content: Buffer.from("spec evidence"),
			mediaType: "text/markdown",
			provenance: { sourceMessageId: source.id },
			createdAt: old,
		});
		const gc = new ArtifactGCService(base.store, {
			rootDir: join(base.dataDir, "artifacts"),
			logRetentionMs: 1_000,
			orphanTtlMs: 1_000,
		});

		const dryRun = gc.collect({ now: base.now(), dryRun: true });
		expect(dryRun.entries).toContainEqual(expect.objectContaining({ id: log.id, reason: "expired_log" }));
		expect(existsSync(log.path)).toBe(true);

		const report = gc.collect({ now: base.now(), dryRun: false });
		expect(report.entries.some((entry) => entry.id === log.id)).toBe(true);
		expect(base.store.artifacts.get(log.id)).toBeNull();
		expect(existsSync(log.path)).toBe(false);
		expect(base.store.artifacts.get(spec.id)).not.toBeNull();
		expect(existsSync(spec.path)).toBe(true);
	});

	it("collects unreferenced artifact files after the orphan TTL", () => {
		const base = fixture();
		const root = join(base.dataDir, "artifacts");
		const orphan = join(root, "orphan.txt");
		writeFileSync(orphan, "orphan");
		const old = new Date(base.now() - 10_000);
		utimesSync(orphan, old, old);
		const gc = new ArtifactGCService(base.store, { rootDir: root, logRetentionMs: 1_000, orphanTtlMs: 1_000 });

		const report = gc.collect({ now: base.now(), dryRun: false });
		expect(report.entries).toContainEqual(expect.objectContaining({ id: null, reason: "orphan_ttl" }));
		expect(existsSync(orphan)).toBe(false);
	});

	it("keeps recent logs and logs for non-terminal tasks", () => {
		const base = fixture();
		const source = base.createSourceMessage();
		const recent = base.store.artifacts.put({
			taskId: "task-1",
			kind: "log",
			content: Buffer.from("recent"),
			mediaType: "text/plain",
			provenance: { sourceMessageId: source.id },
			createdAt: base.now(),
		});
		const gc = new ArtifactGCService(base.store, {
			rootDir: join(base.dataDir, "artifacts"),
			logRetentionMs: 1_000,
			orphanTtlMs: 1_000,
		});
		expect(gc.collect({ now: base.now(), dryRun: false }).entries).toEqual([]);
		expect(base.store.artifacts.get(recent.id)).not.toBeNull();
	});
});
