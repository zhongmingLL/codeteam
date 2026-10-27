import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ControlError } from "./errors.ts";
import { CONTROL_MIGRATIONS, CONTROL_TABLE_NAMES, type ControlMigration } from "./migrations/index.ts";

export const DEFAULT_CONTROL_BUSY_TIMEOUT_MS = 5000;
export const CONTROL_DATABASE_FILE = "control.db";

export interface ControlDatabase {
	readonly database: DatabaseSync;
	readonly path: string;
	readonly schemaVersion: number;
	close(): void;
}

export interface OpenControlDatabaseOptions {
	readonly dataDir?: string;
	readonly busyTimeoutMs?: number;
}

export interface AppliedControlMigrations {
	readonly applied: readonly { version: number; name: string; appliedAt: number }[];
	readonly currentVersion: number;
}

interface SchemaMigrationRow {
	version: number;
	name: string;
	applied_at: number;
}

export function resolveControlDataDir(dataDir?: string): string {
	const resolved = dataDir ?? process.env.CODETEAM_DATA_DIR;
	if (!resolved || resolved.trim() === "") {
		throw new ControlError("data_dir_missing", "CODETEAM_DATA_DIR is required");
	}
	try {
		mkdirSync(resolved, { recursive: true, mode: 0o700 });
		chmodSync(resolved, 0o700);
	} catch (error) {
		throw new ControlError("database_open_failed", `cannot prepare control data dir: ${String(error)}`, {
			cause: error,
		});
	}
	return resolved;
}

export function resolveControlBusyTimeoutMs(value?: number): number {
	const raw = value ?? process.env.CODETEAM_SQLITE_BUSY_TIMEOUT_MS;
	if (raw === undefined || raw === "") return DEFAULT_CONTROL_BUSY_TIMEOUT_MS;
	const parsed = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new ControlError("invalid_busy_timeout", "CODETEAM_SQLITE_BUSY_TIMEOUT_MS must be a positive integer");
	}
	return parsed;
}

export function configureControlDatabase(database: DatabaseSync, options: { busyTimeoutMs?: number } = {}): number {
	const busyTimeoutMs = resolveControlBusyTimeoutMs(options.busyTimeoutMs);
	database.exec("PRAGMA foreign_keys = ON");
	database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
	database.exec("PRAGMA journal_mode = WAL");
	database.exec("PRAGMA synchronous = NORMAL");
	return busyTimeoutMs;
}

function assertMigrationSet(migrations: readonly ControlMigration[]): void {
	if (migrations.length === 0) {
		throw new ControlError("invalid_migration_set", "at least one control migration is required");
	}
	for (const [index, migration] of migrations.entries()) {
		if (migration.version !== index + 1) {
			throw new ControlError("invalid_migration_set", "control migrations must be contiguous from version 1");
		}
		if (migration.name.trim() === "") {
			throw new ControlError("invalid_migration_set", `control migration ${migration.version} has no name`);
		}
	}
}

export function applyControlMigrations(
	database: DatabaseSync,
	migrations: readonly ControlMigration[] = CONTROL_MIGRATIONS,
): AppliedControlMigrations {
	assertMigrationSet(migrations);
	database.exec(
		"CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT",
	);
	const rows = database
		.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version")
		.all() as unknown as SchemaMigrationRow[];

	for (const [index, row] of rows.entries()) {
		const expected = migrations[index];
		if (!expected || expected.version !== row.version || expected.name !== row.name) {
			throw new ControlError(
				"schema_ahead",
				`control schema contains migration ${row.version}:${row.name}, which is not the expected migration`,
			);
		}
	}

	const applied: { version: number; name: string; appliedAt: number }[] = rows.map((row) => ({
		version: row.version,
		name: row.name,
		appliedAt: row.applied_at,
	}));

	for (const migration of migrations.slice(rows.length)) {
		let inTransaction = false;
		try {
			database.exec("BEGIN IMMEDIATE");
			inTransaction = true;
			for (const statement of migration.statements) database.exec(statement);
			const appliedAt = Date.now();
			database
				.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
				.run(migration.version, migration.name, appliedAt);
			database.exec("COMMIT");
			inTransaction = false;
			applied.push({ version: migration.version, name: migration.name, appliedAt });
		} catch (error) {
			if (inTransaction) {
				try {
					database.exec("ROLLBACK");
				} catch (rollbackError) {
					throw new ControlError(
						"migration_failed",
						`control migration ${migration.version}:${migration.name} failed and rollback failed`,
						{ cause: new AggregateError([error, rollbackError]) },
					);
				}
			}
			throw new ControlError(
				"migration_failed",
				`control migration ${migration.version}:${migration.name} failed: ${String(error)}`,
				{ cause: error },
			);
		}
	}

	return { applied, currentVersion: applied.at(-1)?.version ?? 0 };
}

export function getControlSchemaVersion(database: DatabaseSync): number {
	const table = database
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
		.get() as { name?: string } | undefined;
	if (!table) return 0;
	const row = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as
		| { version?: number }
		| undefined;
	return row?.version ?? 0;
}

export function verifyControlSchema(
	database: DatabaseSync,
	expected: { tables?: readonly string[]; version?: number } = {},
): void {
	const expectedTables = expected.tables ?? CONTROL_TABLE_NAMES;
	const expectedVersion = expected.version ?? CONTROL_MIGRATIONS.at(-1)?.version ?? 0;
	const rows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as {
		name: string;
	}[];
	const present = new Set(rows.map((row) => row.name));
	const missing = expectedTables.filter((table) => !present.has(table));
	if (missing.length > 0) {
		throw new ControlError("schema_incomplete", `control schema is missing tables: ${missing.join(", ")}`);
	}
	const version = getControlSchemaVersion(database);
	if (version !== expectedVersion) {
		throw new ControlError(
			"schema_incomplete",
			`control schema version ${version} does not match expected ${expectedVersion}`,
		);
	}
}

export function openControlDatabase(options: OpenControlDatabaseOptions = {}): ControlDatabase {
	const dataDir = resolveControlDataDir(options.dataDir);
	const busyTimeoutMs = resolveControlBusyTimeoutMs(options.busyTimeoutMs);
	const path = join(dataDir, CONTROL_DATABASE_FILE);
	let database: DatabaseSync | undefined;
	try {
		const fd = openSync(path, "a", 0o600);
		closeSync(fd);
		chmodSync(path, 0o600);
		database = new DatabaseSync(path, { timeout: busyTimeoutMs });
		configureControlDatabase(database, { busyTimeoutMs });
		const migrated = applyControlMigrations(database);
		verifyControlSchema(database);
		const opened = database;
		let closed = false;
		return {
			database: opened,
			path,
			schemaVersion: migrated.currentVersion,
			close(): void {
				if (closed) return;
				closed = true;
				try {
					opened.exec("PRAGMA wal_checkpoint(TRUNCATE)");
				} finally {
					opened.close();
				}
			},
		};
	} catch (error) {
		if (database) {
			try {
				database.close();
			} catch {
				// Preserve the original open/migration failure.
			}
		}
		if (error instanceof ControlError) throw error;
		throw new ControlError("database_open_failed", `cannot open control database: ${String(error)}`, {
			cause: error,
		});
	}
}
