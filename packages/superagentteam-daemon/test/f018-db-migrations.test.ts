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
		expect(tables).toContain("invocation_queue");
		expect(tables).toContain("queue_admissions");
		expect(tables).toContain("invocation_records");
		expect(tables).toContain("turn_executions");
		expect(tables).toContain("invocation_attempts");
		// Greenfield guarantee: no task-first tables.
		for (const legacyTable of ["tasks", "runs", "handoffs", "custody_events", "budgets", "reviews", "merges"]) {
			expect(tables).not.toContain(legacyTable);
		}
	});

	it("applies pending migrations and is idempotent on re-run", () => {
		const { db } = makeDb();
		expect(db.migrateUp()).toBe(3);
		expect(db.migrateUp()).toBe(0);
		expect(db.appliedVersions().map((row) => row.name)).toEqual(["core", "messages", "invocation-queue"]);
	});

	it("rolls back the newest migration and re-applies it", () => {
		const { db } = makeDb();
		db.migrateUp();
		expect(db.migrateDown()).toBe(true);
		expect(db.appliedVersions().map((row) => row.name)).toEqual(["core", "messages"]);
		expect(db.migrateDown()).toBe(true);
		expect(db.appliedVersions().map((row) => row.name)).toEqual(["core"]);
		expect(db.migrateDown()).toBe(true);
		expect(db.appliedVersions()).toHaveLength(0);
		const tables = (
			db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
				name: string;
			}[]
		).map((row) => row.name);
		expect(tables).not.toContain("threads");
		expect(db.migrateUp()).toBe(3);
	});

	it("maps messages physical columns per 0007 §3.1.1 (author columns, mentions index)", () => {
		const { db } = makeDb();
		db.migrateUp();
		const cols = (db.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((r) => r.name);
		expect(cols).toContain("author_kind");
		expect(cols).toContain("author_id");
		expect(cols).not.toContain("from_json");
		const indexes = (
			db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'").all() as Array<{
				name: string;
			}>
		).map((r) => r.name);
		expect(indexes).toContain("messages_mentions_user");
	});

	it("creates nested parent directories with usable permissions", () => {
		const dir = mkdtempSync(join(tmpdir(), "f018-nested-"));
		dirs.push(dir);
		const db = new F018Database({ path: join(dir, "a", "b", "f018.db") });
		expect(db.appliedVersions().length).toBeGreaterThan(0);
		db.close();
	});

	it("enforces invocation schema constraints (0007 §4.1-§4.3.1 + R-01)", () => {
		const { db } = makeDb();
		db.migrateUp();
		expect(() =>
			db.db
				.prepare(
					"INSERT INTO invocation_queue (version, queue_entry_id, thread_id, source_record_id, attempt, owner_json, kind, from_json, targets_json, payload_json, execution_json, priority, position, status, enqueued_at, updated_at) VALUES (1, 'q1', 'nope', 's1', 1, '{}', 'message_wake', '{}', '[]', '{}', '{}', 'normal', 0, 'processing', 1, 1)",
				)
				.run(),
		).toThrow(/CHECK|FOREIGN/i);
		const admissionsSql = (
			db.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'queue_admissions'").get() as { sql: string }
		).sql;
		expect(admissionsSql).toContain("thread_id TEXT NOT NULL");
		const indexes = (
			db.db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'invocation_attempts'")
				.all() as Array<{ name: string }>
		).map((r) => r.name);
		expect(indexes).toContain("invocation_attempts_one_active_per_session");
		expect(() =>
			db.db
				.prepare(
					"INSERT INTO invocation_attempts (attempt_id, parent_invocation_id, queue_entry_id, thread_id, target_agent_id, attempt, delivery_state, created_at) VALUES ('a1', 'nope', 'q1', 'nope', 'agent1', 1, 'running', 1)",
				)
				.run(),
		).toThrow(/CHECK|FOREIGN/i);
		expect(() =>
			db.db
				.prepare(
					"INSERT INTO turn_executions (turn_execution_id, parent_invocation_id, thread_id, user_id, agent_id, execution_kind, causal_json, status, started_at) VALUES ('t1', 'nope', 'nope', 'u', 'a', 'ordinary', '{}', 'succeeded', 1)",
				)
				.run(),
		).toThrow(/CHECK|FOREIGN/i);
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
