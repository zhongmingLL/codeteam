import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { F018Database } from "../src/infrastructure/db/database.ts";
import { F018_MIGRATIONS } from "../src/infrastructure/db/migrations/index.ts";

const dirs: string[] = [];

function makeDb(): { db: F018Database; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "f018-db-"));
	dirs.push(dir);
	const db = new F018Database({ path: join(dir, "f018.db"), noMigrate: true });
	return { db, dir };
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("F018 greenfield migration harness", () => {
	it("registers migrations with contiguous versions and down statements", () => {
		expect(F018_MIGRATIONS.length).toBeGreaterThan(0);
		for (const [index, migration] of F018_MIGRATIONS.entries()) {
			expect(migration.version).toBe(index + 1);
			expect(migration.up.length).toBeGreaterThan(0);
			expect(migration.down.length).toBeGreaterThan(0);
		}
	});

	it("creates only F018 tables in a fresh baseline", () => {
		const { db } = makeDb();
		db.migrateUp();
		const tables = (
			db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
				name: string;
			}[]
		).map((row) => row.name);
		expect(tables).toContain("f018_schema_migrations");
		expect(tables).toContain("threads");
		expect(tables).toContain("thread_participants");
		expect(tables).toContain("agent_read_state");
		expect(tables).toContain("messages");
		// Greenfield guarantee: no task-first tables.
		for (const legacyTable of ["tasks", "runs", "handoffs", "custody_events", "budgets", "reviews", "merges"]) {
			expect(tables).not.toContain(legacyTable);
		}
	});

	it("applies pending migrations and is idempotent on re-run", () => {
		const { db } = makeDb();
		expect(db.migrateUp()).toBe(2);
		expect(db.migrateUp()).toBe(0);
		expect(db.appliedVersions().map((row) => row.name)).toEqual(["f018-core", "f018-messages"]);
	});

	it("rolls back the newest migration and re-applies it", () => {
		const { db } = makeDb();
		db.migrateUp();
		expect(db.migrateDown()).toBe(true);
		expect(db.appliedVersions().map((row) => row.name)).toEqual(["f018-core"]);
		expect(db.migrateDown()).toBe(true);
		expect(db.appliedVersions()).toHaveLength(0);
		const tables = (
			db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
				name: string;
			}[]
		).map((row) => row.name);
		expect(tables).not.toContain("threads");
				expect(db.migrateUp()).toBe(2);
	});

	it("enforces thread ownership columns at the schema level", () => {
		const { db } = makeDb();
		db.migrateUp();
		expect(() =>
			db.db
				.prepare(
					"INSERT INTO threads (id, project_path, title, title_source, last_active_at, created_at, updated_at) VALUES ('t1', '/p', NULL, NULL, 0, 0, 0)",
				)
				.run(),
		).toThrow(/NOT NULL|constraint/i);
		expect(() =>
			db.db
				.prepare(
					"INSERT INTO threads (id, project_path, created_by, last_active_at, created_at, updated_at, title_source) VALUES ('t1', '/p', 'u1', 1, 1, 1, 'bogus')",
				)
				.run(),
		).toThrow(/CHECK/i);
	});
});
