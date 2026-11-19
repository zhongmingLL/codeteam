import type { ControlMigration } from "./index.ts";

/**
 * F018 R1-a core schema: thread model (0009) + agent read state (0007 §4.5).
 * Greenfield only: the new-baseline database contains F018 tables only.
 */
export const CORE_STATEMENTS = [
	// threads (0009 §1): user-owned conversation aggregate.
	`CREATE TABLE threads (
		id TEXT PRIMARY KEY,
		project_path TEXT NOT NULL,
		title TEXT,
		title_source TEXT CHECK (title_source IS NULL OR title_source IN ('user', 'agent', 'system')),
		created_by TEXT NOT NULL,
		last_active_at INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		deleted_at INTEGER,
		CHECK (deleted_at IS NULL OR deleted_at >= 0)
	) STRICT`,
	`CREATE INDEX threads_owner_active ON threads(created_by, deleted_at, last_active_at)`,

	// thread_participants (0009 §1): routing/context membership, not ACL.
	`CREATE TABLE thread_participants (
		thread_id TEXT NOT NULL,
		agent_id TEXT NOT NULL,
		joined_at INTEGER NOT NULL,
		PRIMARY KEY (thread_id, agent_id),
		FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT
	) STRICT`,
	`CREATE INDEX thread_participants_thread_join ON thread_participants(thread_id, joined_at)`,

	// agent_read_state (0007 §4.5): per (thread, agent) delivery cursor.
	`CREATE TABLE agent_read_state (
		thread_id TEXT NOT NULL,
		agent_id TEXT NOT NULL,
		delivery_cursor INTEGER NOT NULL DEFAULT 0 CHECK (delivery_cursor >= 0),
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (thread_id, agent_id),
		FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
	) STRICT`,
] as const;

export const CORE_DOWNS = [
	`DROP TABLE IF EXISTS agent_read_state`,
	`DROP TABLE IF EXISTS thread_participants`,
	`DROP TABLE IF EXISTS threads`,
] as const;

export const coreMigration: ControlMigration = {
	version: 1,
	name: "core",
	up: [...CORE_STATEMENTS],
	down: [...CORE_DOWNS],
};
