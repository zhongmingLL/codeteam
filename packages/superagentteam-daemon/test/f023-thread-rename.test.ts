import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ThreadStore } from "../src/domains/thread/store.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";

const dirs: string[] = [];

function makeStore(): { db: F018Database; threads: ThreadStore } {
	const dir = mkdtempSync(join(tmpdir(), "f023-rename-"));
	dirs.push(dir);
	const db = new F018Database({ path: join(dir, "f018.db") });
	return { db, threads: new ThreadStore(db.db) };
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("F023 thread rename store", () => {
	it("updates title/titleSource/updatedAt without touching lastActiveAt", () => {
		const { db, threads } = makeStore();
		const thread = threads.create({
			id: "thread:1",
			projectPath: "/tmp/project",
			title: "Old title",
			titleSource: "system",
			createdBy: "operator:1",
			now: 100,
		});

		const renamed = threads.updateTitle(thread.id, "New title", "user", 200);

		expect(renamed).toMatchObject({
			id: thread.id,
			title: "New title",
			titleSource: "user",
			lastActiveAt: 100,
			updatedAt: 200,
		});
		expect(threads.get(thread.id)).toMatchObject({ title: "New title", titleSource: "user", lastActiveAt: 100 });
		db.close();
	});

	it("does not rename missing or soft-deleted threads", () => {
		const { db, threads } = makeStore();
		const thread = threads.create({
			id: "thread:1",
			projectPath: "/tmp/project",
			createdBy: "operator:1",
			now: 100,
		});
		threads.softDelete(thread.id, 150);

		expect(threads.updateTitle(thread.id, "Hidden", "user", 200)).toBeNull();
		expect(threads.updateTitle("thread:missing", "Hidden", "user", 200)).toBeNull();
		db.close();
	});
});
