import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryError } from "./errors.ts";

export const MEMORY_DATABASE_FILE = "memory.db";
export const DEFAULT_MEMORY_BUSY_TIMEOUT_MS = 5000;
export const DEFAULT_MEMORY_MAX_FILE_BYTES = 512 * 1024;
export const MEMORY_SCHEMA_VERSION = 1;

export interface MemoryDatabase {
	readonly database: DatabaseSync;
	readonly path: string;
	readonly schemaVersion: number;
	verifyIsolation(): { databaseCount: number; attached: string[] };
	close(): void;
}

export interface OpenMemoryDatabaseOptions {
	readonly path?: string;
	readonly dataDir?: string;
	readonly create?: boolean;
	readonly busyTimeoutMs?: number;
}

interface SchemaMigrationRow {
	version: number;
	name: string;
	applied_at: number;
}

const MEMORY_SCHEMA_STATEMENTS: readonly string[] = [
	`CREATE TABLE collections (
		id TEXT PRIMARY KEY,
		workspace_id TEXT NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('project')),
		display_name TEXT NOT NULL,
		root TEXT NOT NULL,
		sensitivity TEXT NOT NULL CHECK (sensitivity IN ('internal')),
		status TEXT NOT NULL CHECK (status IN ('active','stale','archived'))
	) STRICT`,
	`CREATE TABLE evidence_items (
		anchor TEXT PRIMARY KEY,
		workspace_id TEXT NOT NULL,
		collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
		kind TEXT NOT NULL CHECK (kind IN ('feature','decision','plan','lesson','architecture','thread','session','research','discussion','task','artifact','review','verification','merge')),
		status TEXT NOT NULL CHECK (status IN ('active','done','archived','review','invalidated','superseded','drifted','stale','historical','retired')),
		title TEXT NOT NULL,
		summary TEXT,
		keywords TEXT,
		content TEXT,
		source_kind TEXT NOT NULL CHECK (source_kind IN ('file','control')),
		source_ref TEXT NOT NULL,
		source_path TEXT,
		source_hash TEXT NOT NULL,
		source_updated_at INTEGER,
		provenance_tier TEXT CHECK (provenance_tier IN ('authoritative','derived','soft_clue')),
		provenance_source TEXT,
		drill_down_json TEXT CHECK (drill_down_json IS NULL OR json_valid(drill_down_json)),
		metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
		updated_at INTEGER NOT NULL,
		CHECK ((source_kind = 'file' AND source_path IS NOT NULL) OR (source_kind = 'control' AND source_path IS NULL)),
		UNIQUE (workspace_id, source_kind, source_ref)
	) STRICT`,
	`CREATE VIRTUAL TABLE evidence_fts USING fts5(
		title,
		summary,
		keywords,
		content,
		content='evidence_items',
		content_rowid='rowid',
		tokenize='trigram'
	)`,
	`CREATE TRIGGER evidence_items_fts_ai AFTER INSERT ON evidence_items BEGIN
		INSERT INTO evidence_fts(rowid, title, summary, keywords, content)
		VALUES (new.rowid, new.title, new.summary, new.keywords, new.content);
	END`,
	`CREATE TRIGGER evidence_items_fts_ad AFTER DELETE ON evidence_items BEGIN
		INSERT INTO evidence_fts(evidence_fts, rowid, title, summary, keywords, content)
		VALUES ('delete', old.rowid, old.title, old.summary, old.keywords, old.content);
	END`,
	`CREATE TRIGGER evidence_items_fts_au AFTER UPDATE ON evidence_items BEGIN
		INSERT INTO evidence_fts(evidence_fts, rowid, title, summary, keywords, content)
		VALUES ('delete', old.rowid, old.title, old.summary, old.keywords, old.content);
		INSERT INTO evidence_fts(rowid, title, summary, keywords, content)
		VALUES (new.rowid, new.title, new.summary, new.keywords, new.content);
	END`,
	`CREATE TABLE evidence_passages (
		passage_id TEXT PRIMARY KEY,
		anchor TEXT NOT NULL REFERENCES evidence_items(anchor) ON DELETE CASCADE,
		ordinal INTEGER NOT NULL,
		content TEXT NOT NULL,
		content_hash TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		UNIQUE (anchor, ordinal)
	) STRICT`,
	`CREATE VIRTUAL TABLE evidence_passage_fts USING fts5(
		content,
		content='evidence_passages',
		content_rowid='rowid',
		tokenize='trigram'
	)`,
	`CREATE TRIGGER evidence_passages_fts_ai AFTER INSERT ON evidence_passages BEGIN
		INSERT INTO evidence_passage_fts(rowid, content) VALUES (new.rowid, new.content);
	END`,
	`CREATE TRIGGER evidence_passages_fts_ad AFTER DELETE ON evidence_passages BEGIN
		INSERT INTO evidence_passage_fts(evidence_passage_fts, rowid, content)
		VALUES ('delete', old.rowid, old.content);
	END`,
	`CREATE TRIGGER evidence_passages_fts_au AFTER UPDATE ON evidence_passages BEGIN
		INSERT INTO evidence_passage_fts(evidence_passage_fts, rowid, content)
		VALUES ('delete', old.rowid, old.content);
		INSERT INTO evidence_passage_fts(rowid, content) VALUES (new.rowid, new.content);
	END`,
	`CREATE TABLE passage_vectors (
		passage_id TEXT PRIMARY KEY REFERENCES evidence_passages(passage_id) ON DELETE CASCADE,
		vector_blob BLOB NOT NULL,
		model TEXT NOT NULL,
		model_revision TEXT,
		created_at INTEGER NOT NULL
	) STRICT`,
	`CREATE TABLE index_runs (
		id TEXT PRIMARY KEY,
		workspace_id TEXT NOT NULL,
		source_kind TEXT NOT NULL CHECK (source_kind IN ('file','control','mixed')),
		mode TEXT NOT NULL DEFAULT 'incremental' CHECK (mode IN ('full','incremental')),
		started_at INTEGER NOT NULL,
		ended_at INTEGER,
		status TEXT NOT NULL CHECK (status IN ('indexing','fresh','degraded','interrupted','failed')),
		worker_pid INTEGER,
		source_count INTEGER NOT NULL DEFAULT 0,
		skipped_count INTEGER NOT NULL DEFAULT 0,
		error_count INTEGER NOT NULL DEFAULT 0,
		error_summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(error_summary_json) AND json_type(error_summary_json) = 'object')
	) STRICT`,
	`CREATE TABLE index_errors (
		id TEXT PRIMARY KEY,
		run_id TEXT NOT NULL REFERENCES index_runs(id) ON DELETE CASCADE,
		source_path TEXT,
		error_kind TEXT NOT NULL CHECK (error_kind IN ('path_denied','secret_redacted','max_file_bytes','parse_error','embedding_unavailable','vector_write_error')),
		detail TEXT,
		at INTEGER NOT NULL
	) STRICT`,
	`CREATE INDEX idx_evidence_workspace_kind ON evidence_items(workspace_id, kind, status)`,
	`CREATE INDEX idx_evidence_source ON evidence_items(source_kind, source_ref)`,
	`CREATE INDEX idx_evidence_collection ON evidence_items(collection_id)`,
	`CREATE INDEX idx_index_runs_latest ON index_runs(workspace_id, started_at DESC)`,
	`CREATE INDEX idx_index_errors_run ON index_errors(run_id)`,
];

export function resolveMemoryDatabasePath(options: { path?: string; dataDir?: string } = {}): string {
	const explicit = options.path ?? process.env.CODETEAM_MEMORY_DB;
	if (explicit && explicit.trim() !== "") return explicit;
	const dataDir = options.dataDir ?? process.env.CODETEAM_DATA_DIR;
	if (!dataDir || dataDir.trim() === "") {
		throw new MemoryError("memory_unavailable", "CODETEAM_MEMORY_DB or CODETEAM_DATA_DIR is required", {
			details: { reason: "memory_db_path_missing" },
		});
	}
	return join(dataDir, MEMORY_DATABASE_FILE);
}

export function resolveMemoryBusyTimeoutMs(value?: number): number {
	const raw = value ?? process.env.CODETEAM_SQLITE_BUSY_TIMEOUT_MS;
	if (raw === undefined || raw === "") return DEFAULT_MEMORY_BUSY_TIMEOUT_MS;
	const parsed = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new MemoryError("invalid_input", "CODETEAM_SQLITE_BUSY_TIMEOUT_MS must be a positive integer");
	}
	return parsed;
}

export function resolveMemoryMaxFileBytes(value?: number): number {
	const raw = value ?? process.env.CODETEAM_MEMORY_MAX_FILE_BYTES;
	if (raw === undefined || raw === "") return DEFAULT_MEMORY_MAX_FILE_BYTES;
	const parsed = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new MemoryError("invalid_input", "CODETEAM_MEMORY_MAX_FILE_BYTES must be a positive integer");
	}
	return parsed;
}

export function configureMemoryDatabase(database: DatabaseSync, options: { busyTimeoutMs?: number } = {}): number {
	const busyTimeoutMs = resolveMemoryBusyTimeoutMs(options.busyTimeoutMs);
	database.exec("PRAGMA foreign_keys = ON");
	database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
	database.exec("PRAGMA journal_mode = WAL");
	database.exec("PRAGMA synchronous = NORMAL");
	return busyTimeoutMs;
}

export function getMemorySchemaVersion(database: DatabaseSync): number {
	const table = database
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
		.get() as { name?: string } | undefined;
	if (!table) return 0;
	const row = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as
		| { version?: number }
		| undefined;
	return Number(row?.version ?? 0);
}

export function applyMemoryMigrations(database: DatabaseSync): number {
	database.exec(
		"CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT",
	);
	const rows = database
		.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version")
		.all() as unknown as SchemaMigrationRow[];
	if (rows.length > 0 && rows[0]?.version !== 1) {
		throw new MemoryError("memory_schema_ahead", "memory schema is not the expected v1");
	}
	if (rows.length > 1 || (rows.length === 1 && rows[0]?.name !== "memory-evidence-v1")) {
		throw new MemoryError("memory_schema_ahead", "memory schema contains unknown migrations");
	}
	if (rows.length === 1) return 1;
	database.exec("BEGIN IMMEDIATE");
	try {
		for (const statement of MEMORY_SCHEMA_STATEMENTS) database.exec(statement);
		database
			.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'memory-evidence-v1', ?)")
			.run(Date.now());
		database.exec("COMMIT");
	} catch (error) {
		try {
			database.exec("ROLLBACK");
		} catch {
			// Preserve the original migration failure.
		}
		throw new MemoryError("memory_schema_incomplete", `memory migration failed: ${String(error)}`, {
			cause: error,
		});
	}
	return 1;
}

export function verifyMemorySchema(database: DatabaseSync): void {
	const required = [
		"collections",
		"evidence_items",
		"evidence_fts",
		"evidence_passages",
		"evidence_passage_fts",
		"passage_vectors",
		"index_runs",
		"index_errors",
	];
	const rows = database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as unknown as {
		name: string;
	}[];
	const present = new Set(rows.map((row) => row.name));
	const missing = required.filter((name) => !present.has(name));
	if (missing.length > 0) {
		throw new MemoryError("memory_schema_incomplete", `memory schema is missing tables: ${missing.join(", ")}`);
	}
	const version = getMemorySchemaVersion(database);
	if (version !== MEMORY_SCHEMA_VERSION) {
		throw new MemoryError(
			"memory_schema_incomplete",
			`memory schema version ${version} is not ${MEMORY_SCHEMA_VERSION}`,
		);
	}
}

function assertIsolation(database: DatabaseSync): { databaseCount: number; attached: string[] } {
	const rows = database.prepare("PRAGMA database_list").all() as unknown as { name: string; file: string }[];
	const attached = rows.map((row) => row.name).filter((name) => name !== "main" && name !== "temp");
	if (attached.length > 0) {
		throw new MemoryError(
			"memory_isolation_violation",
			`memory database must not ATTACH other databases: ${attached.join(", ")}`,
			{
				details: { attached },
			},
		);
	}
	return { databaseCount: rows.length, attached: [] };
}

export function openMemoryDatabase(options: OpenMemoryDatabaseOptions = {}): MemoryDatabase {
	const path = resolveMemoryDatabasePath(options);
	const create = options.create ?? true;
	if (!create && !existsSync(path)) {
		throw new MemoryError("memory_unavailable", `memory database does not exist: ${path}`, {
			details: { reason: "memory_db_absent", path },
		});
	}
	if (create) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const fd = openSync(path, "a", 0o600);
		closeSync(fd);
		chmodSync(path, 0o600);
	}
	const busyTimeoutMs = resolveMemoryBusyTimeoutMs(options.busyTimeoutMs);
	let database: DatabaseSync | undefined;
	try {
		database = new DatabaseSync(path, { timeout: busyTimeoutMs });
		configureMemoryDatabase(database, { busyTimeoutMs });
		if (create) applyMemoryMigrations(database);
		verifyMemorySchema(database);
		assertIsolation(database);
		const opened = database;
		let closed = false;
		return {
			database: opened,
			path,
			schemaVersion: getMemorySchemaVersion(opened),
			verifyIsolation: () => assertIsolation(opened),
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
				// Preserve the original open failure.
			}
		}
		if (error instanceof MemoryError) throw error;
		throw new MemoryError("memory_unavailable", `cannot open memory database: ${String(error)}`, { cause: error });
	}
}
