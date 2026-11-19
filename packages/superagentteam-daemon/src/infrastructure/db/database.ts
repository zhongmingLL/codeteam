import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolveDataDir } from "../../env.ts";
import { assertF018MigrationSet, F018_MIGRATIONS } from "./migrations/index.ts";

/**
 * F018 greenfield database harness.
 *
 * Mechanism provenance (per R1-a review agreement): the ordered-migration +
 * schema_migrations ledger + per-migration transaction pattern follows the
 * approach used by the legacy task-first harness in
 * `src/legacy/task-first/control/database.ts`. No legacy code was copied;
 * this implementation is written fresh against the F018 greenfield spec
 * (plan 0021 R1-a): a new-baseline database contains F018 tables only, with
 * up/down support and an empty starting ledger.
 */
export interface F018DatabaseOptions {
	/** Explicit database file path; defaults into resolveDataDir(). */
	readonly path?: string;
	/** Skip automatic migration to latest (used by down-migration tests). */
	readonly noMigrate?: boolean;
}

export interface F018MigrationStatus {
	version: number;
	name: string;
	applied_at: number;
}

function ensureParent(path: string, mode: 0o700): void {
	mkdirSync(dirname(path), { recursive: true, mode });
}

export class F018Database {
	readonly db: DatabaseSync;
	private readonly dbPath: string;

	constructor(options: F018DatabaseOptions = {}) {
		const path = options.path ?? `${resolveDataDir()}/f018.db`;
		ensureParent(path, 0o700);
		this.db = new DatabaseSync(path);
		this.dbPath = path;
		try {
			chmodSync(path, 0o600);
		} catch {
			// Best-effort permission tightening; the creating mode already
			// restricted the file on platforms that honor mkdirSync/open modes.
		}
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA busy_timeout = 5000");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.ensureLedger();
		if (!options.noMigrate) this.migrateUp();
	}

	get path(): string {
		return this.dbPath;
	}

	private ensureLedger(): void {
		this.db.exec(
			"CREATE TABLE IF NOT EXISTS f018_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT",
		);
	}

	appliedVersions(): F018MigrationStatus[] {
		const rows = this.db
			.prepare("SELECT version, name, applied_at FROM f018_schema_migrations ORDER BY version")
			.all() as Array<{ version: number; name: string; applied_at: number }>;
		return rows.map((row) => ({ version: row.version, name: row.name, applied_at: row.applied_at }));
	}

	/** Applies all pending migrations in order; each migration is one transaction. */
	migrateUp(): number {
		assertF018MigrationSet(F018_MIGRATIONS);
		const applied = new Set(this.appliedVersions().map((row) => row.version));
		let count = 0;
		for (const migration of F018_MIGRATIONS) {
			if (applied.has(migration.version)) continue;
			this.db.exec("BEGIN IMMEDIATE");
			try {
				for (const statement of migration.up) this.db.exec(statement);
				this.db
					.prepare("INSERT INTO f018_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
					.run(migration.version, migration.name, Date.now());
				this.db.exec("COMMIT");
				count += 1;
			} catch (error) {
				this.db.exec("ROLLBACK");
				throw error;
			}
		}
		return count;
	}

	/** Rolls back the newest applied migration (one transaction). Requires down statements. */
	migrateDown(): boolean {
		const rows = this.appliedVersions();
		const latest = rows.at(-1);
		if (!latest) return false;
		const migration = F018_MIGRATIONS.find((m) => m.version === latest.version);
		if (!migration) throw new Error(`f018_migration_unknown_version: ${latest.version}`);
		if (migration.down.length === 0) throw new Error(`f018_migration_no_down: ${migration.name}`);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const statement of migration.down) this.db.exec(statement);
			this.db.prepare("DELETE FROM f018_schema_migrations WHERE version = ?").run(migration.version);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		return true;
	}

	close(): void {
		this.db.close();
	}
}

/**
 * F018 R2-a: single-connection transaction wrapper for runtime multi-statement
 * units (Phase A / Phase B / ingress admission; 0007 §3.2). BEGIN IMMEDIATE
 * grabs the write lock up front. NOT nestable — callers must not start a
 * transaction inside another one.
 */
export function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	let result: T;
	try {
		result = fn();
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
	return result;
}
