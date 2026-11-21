import type { ControlMigration } from "./index.ts";

/**
 * F022 M1-A: per-(user, thread) read cursor for the first-party Hub.
 * `last_read_seq` points at the highest messages.seq the operator has read;
 * unread is derived from messages, so no message copy or second truth store.
 */
export const THREAD_READ_STATE_STATEMENTS = [
	`CREATE TABLE thread_read_state (
		user_id TEXT NOT NULL,
		thread_id TEXT NOT NULL,
		last_read_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (user_id, thread_id),
		FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT
	) STRICT`,
] as const;

export const THREAD_READ_STATE_DOWNS = [`DROP TABLE IF EXISTS thread_read_state`] as const;

export const threadReadStateMigration: ControlMigration = {
	version: 6,
	name: "thread-read-state",
	up: [...THREAD_READ_STATE_STATEMENTS],
	down: [...THREAD_READ_STATE_DOWNS],
};
