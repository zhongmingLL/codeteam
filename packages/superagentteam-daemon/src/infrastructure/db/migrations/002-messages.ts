import type { ControlMigration } from "./index.ts";

/**
 * F018 R1-a messages table: StoredMessage (0007 §3.1) greenfield v1 table.
 * Physical mapping per 0007 §3.1.1: author_kind + author_id map
 * StoredMessage.from (no `from` column); body_md = content; created_at =
 * timestamp; content_json/tool_events_json/lifecycle_json/extra_json =
 * contentBlocks/toolEvents/lifecycle/extra. Legacy task-first columns are
 * deliberately absent.
 */
export const MESSAGES_STATEMENTS = [
	`CREATE TABLE messages (
		id TEXT PRIMARY KEY,
		thread_id TEXT NOT NULL,
		seq INTEGER NOT NULL CHECK (seq >= 0),
		author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'agent', 'system')),
		author_id TEXT NOT NULL,
		body_md TEXT NOT NULL DEFAULT '',
		content_json TEXT
			CHECK (content_json IS NULL OR (json_valid(content_json) AND json_type(content_json) = 'array')),
		tool_events_json TEXT
			CHECK (tool_events_json IS NULL OR (json_valid(tool_events_json) AND json_type(tool_events_json) = 'array')),
		lifecycle_json TEXT
			CHECK (lifecycle_json IS NULL OR (json_valid(lifecycle_json) AND json_type(lifecycle_json) = 'object')),
		thinking TEXT,
		reply_to TEXT,
		mentions_user INTEGER NOT NULL DEFAULT 0 CHECK (mentions_user IN (0, 1)),
		deleted_at INTEGER,
		deleted_by TEXT,
		extra_json TEXT
			CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object')),
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		UNIQUE (thread_id, seq),
		FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT,
		FOREIGN KEY (reply_to) REFERENCES messages(id) ON DELETE RESTRICT
	) STRICT`,
	`CREATE INDEX messages_thread_seq ON messages(thread_id, seq)`,
	`CREATE INDEX messages_mentions_user ON messages(thread_id, created_at) WHERE mentions_user = 1`,
] as const;

export const MESSAGES_DOWNS = [`DROP TABLE IF EXISTS messages`] as const;

export const messagesMigration: ControlMigration = {
	version: 2,
	name: "messages",
	up: [...MESSAGES_STATEMENTS],
	down: [...MESSAGES_DOWNS],
};
