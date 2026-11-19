import type { ControlMigration } from "./index.ts";

/**
 * F018 R1-a messages table: StoredMessage (0007 §3.1) as a greenfield v1
 * table. Legacy task-first message columns (task_id/control_ref/
 * dispatch_refs_json/rich_blocks_json/kind) are deliberately absent.
 */
export const F018_MESSAGES_STATEMENTS = [
	`CREATE TABLE messages (
		id TEXT PRIMARY KEY,
		thread_id TEXT NOT NULL,
		seq INTEGER NOT NULL CHECK (seq >= 0),
		from_json TEXT NOT NULL
			CHECK (json_valid(from_json) AND json_type(from_json) = 'object'),
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
] as const;

export const F018_MESSAGES_DOWNS = [
	`DROP TABLE IF EXISTS messages`,
] as const;

export const f018MessagesMigration: ControlMigration = {
	version: 2,
	name: "f018-messages",
	up: [...F018_MESSAGES_STATEMENTS],
	down: [...F018_MESSAGES_DOWNS],
};
