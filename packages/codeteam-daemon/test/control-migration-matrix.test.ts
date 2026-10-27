import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyControlMigrations,
	CONTROL_DATABASE_FILE,
	CONTROL_MIGRATIONS,
	CONTROL_TABLE_NAMES,
	ControlError,
	configureControlDatabase,
	getControlSchemaVersion,
	openControlStore,
} from "../src/index.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dataDir = mkdtempSync(join(tmpdir(), "codeteam-migrations-"));
	dirs.push(dataDir);
	return dataDir;
}

function openRaw(dataDir: string, migrations = CONTROL_MIGRATIONS.slice(0, 3)): DatabaseSync {
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const database = new DatabaseSync(join(dataDir, CONTROL_DATABASE_FILE));
	configureControlDatabase(database);
	if (migrations.length > 0) applyControlMigrations(database, migrations);
	return database;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codeteam control migration matrix", () => {
	it("builds every control table from an empty database", () => {
		const dataDir = tempDir();
		const store = openControlStore({ dataDir });
		expect(store.control.schemaVersion).toBe(CONTROL_MIGRATIONS.at(-1)?.version);
		const tables = new Set(
			(
				store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as {
					name: string;
				}[]
			).map((row) => row.name),
		);
		for (const table of CONTROL_TABLE_NAMES) expect(tables.has(table)).toBe(true);
		store.close();
	});

	it("migrates a database created at version 3 without losing thread and message rows", () => {
		const dataDir = tempDir();
		const database = openRaw(dataDir);
		database
			.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)")
			.run("thread-old", "Old thread", 1, 1);
		database
			.prepare(
				"INSERT INTO messages (id, thread_id, author_kind, author_id, kind, body_md, rich_blocks_json, dispatch_refs_json, seq, created_at, updated_at) VALUES (?, ?, 'user', ?, 'chat', ?, '[]', '[]', 1, ?, ?)",
			)
			.run("message-old", "thread-old", "user-1", "hello", 1, 1);
		expect(getControlSchemaVersion(database)).toBe(3);
		database.close();

		const store = openControlStore({ dataDir });
		expect(store.control.schemaVersion).toBe(CONTROL_MIGRATIONS.at(-1)?.version);
		expect(store.threads.get("thread-old")?.title).toBe("Old thread");
		expect(store.messages.get("message-old")?.bodyMd).toBe("hello");
		expect(
			store.database.prepare("SELECT name FROM sqlite_master WHERE name = 'invocation_credentials'").get(),
		).toBeDefined();
		store.close();
	});

	it("resumes from a partial migration set and keeps existing data", () => {
		const dataDir = tempDir();
		const database = openRaw(dataDir, CONTROL_MIGRATIONS.slice(0, 2));
		expect(getControlSchemaVersion(database)).toBe(2);
		database
			.prepare("INSERT INTO threads (id, title, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)")
			.run("thread-partial", "Partial", 2, 2);
		database.close();

		const store = openControlStore({ dataDir });
		expect(store.control.schemaVersion).toBe(CONTROL_MIGRATIONS.at(-1)?.version);
		expect(store.threads.get("thread-partial")?.title).toBe("Partial");
		store.close();
	});

	it("reruns cleanly after a failed migration and never records the failed version", () => {
		const dataDir = tempDir();
		const database = openRaw(dataDir, []);
		const applied = applyControlMigrations(database);
		expect(applied.applied).toHaveLength(CONTROL_MIGRATIONS.length);
		const again = applyControlMigrations(database);
		expect(again.applied).toHaveLength(CONTROL_MIGRATIONS.length);
		expect(
			(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count,
		).toBe(CONTROL_MIGRATIONS.length);
		expect(again.currentVersion).toBe(CONTROL_MIGRATIONS.at(-1)?.version);
		database.close();

		const crashDir = tempDir();
		const crashed = openRaw(crashDir, []);
		const failing = {
			version: CONTROL_MIGRATIONS.length + 1,
			name: "injected-crash",
			statements: ["CREATE TABLE crash_probe (id TEXT)", "INSERT INTO missing_table (id) VALUES ('x')"],
		};
		expect(() => applyControlMigrations(crashed, [...CONTROL_MIGRATIONS, failing])).toThrow(ControlError);
		expect(getControlSchemaVersion(crashed)).toBe(CONTROL_MIGRATIONS.at(-1)?.version);
		expect(crashed.prepare("SELECT name FROM sqlite_master WHERE name = 'crash_probe'").get()).toBeUndefined();
		crashed.close();

		const store = openControlStore({ dataDir: crashDir });
		expect(store.control.schemaVersion).toBe(CONTROL_MIGRATIONS.at(-1)?.version);
		store.close();
	});
});
