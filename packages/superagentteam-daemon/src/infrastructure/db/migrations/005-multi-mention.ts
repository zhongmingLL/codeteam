import type { ControlMigration } from "./index.ts";

/**
 * F018 R3 multi_mention durable state (0007 §3.8, DP-F018MM-1=B).
 *
 * The three tables carry the group lifecycle, per-target outcome pointers and
 * one callback delivery per request. `trigger_type` / `search_evidence_refs_json`
 * / `override_reason` are optional audit metadata from the model-facing input;
 * they do not affect the state machine.
 */
export const MULTI_MENTION_STATEMENTS = [
	`CREATE TABLE multi_mention_requests (
		request_id TEXT PRIMARY KEY,
		thread_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		initiator_agent_id TEXT NOT NULL,
		initiator_turn_execution_id TEXT NOT NULL,
		callback_to_agent_id TEXT NOT NULL,
		question TEXT NOT NULL,
		context TEXT,
		target_agent_ids_json TEXT NOT NULL
			CHECK (json_valid(target_agent_ids_json) AND json_type(target_agent_ids_json) = 'array'
				AND json_array_length(target_agent_ids_json) BETWEEN 2 AND 3),
		status TEXT NOT NULL CHECK (
			status IN ('pending', 'running', 'partial', 'done', 'timeout', 'failed')
		),
		timeout_minutes INTEGER NOT NULL CHECK (timeout_minutes BETWEEN 3 AND 20),
		expires_at INTEGER NOT NULL,
		parent_invocation_id TEXT,
		source_record_id TEXT NOT NULL UNIQUE,
		aggregate_message_id TEXT,
		trigger_type TEXT,
		search_evidence_refs_json TEXT,
		override_reason TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		ended_at INTEGER,
		CHECK (status IN ('pending', 'running', 'partial') OR ended_at IS NOT NULL),
		FOREIGN KEY (initiator_turn_execution_id)
			REFERENCES turn_executions(turn_execution_id) ON DELETE RESTRICT
	) STRICT`,
	`CREATE INDEX multi_mention_requests_expiry
		ON multi_mention_requests(status, expires_at)`,

	`CREATE TABLE multi_mention_responses (
		request_id TEXT NOT NULL,
		target_agent_id TEXT NOT NULL,
		turn_execution_id TEXT,
		response_message_id TEXT,
		status TEXT NOT NULL CHECK (status IN ('received', 'timeout', 'failed')),
		response_state TEXT NOT NULL DEFAULT 'pending'
			CHECK (response_state IN ('pending', 'terminal', 'missing')),
		reason TEXT,
		received_at INTEGER,
		PRIMARY KEY (request_id, target_agent_id),
		FOREIGN KEY (request_id) REFERENCES multi_mention_requests(request_id) ON DELETE CASCADE
	) STRICT`,

	`CREATE TABLE multi_mention_callbacks (
		request_id TEXT PRIMARY KEY,
		thread_id TEXT NOT NULL,
		callback_to_agent_id TEXT NOT NULL,
		aggregate_message_id TEXT NOT NULL,
		queue_entry_id TEXT,
		parent_invocation_id TEXT,
		turn_execution_id TEXT,
		callback_depth INTEGER NOT NULL CHECK (callback_depth BETWEEN 1 AND 2),
		status TEXT NOT NULL CHECK (
			status IN ('pending', 'queued', 'running', 'completed', 'failed', 'interrupted', 'canceled')
		),
		reason TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		ended_at INTEGER,
		CHECK (status IN ('pending', 'queued', 'running') OR ended_at IS NOT NULL),
		FOREIGN KEY (request_id) REFERENCES multi_mention_requests(request_id) ON DELETE CASCADE,
		FOREIGN KEY (aggregate_message_id) REFERENCES messages(id) ON DELETE RESTRICT,
		FOREIGN KEY (queue_entry_id) REFERENCES invocation_queue(queue_entry_id) ON DELETE SET NULL,
		FOREIGN KEY (parent_invocation_id) REFERENCES invocation_records(invocation_id) ON DELETE SET NULL,
		FOREIGN KEY (turn_execution_id) REFERENCES turn_executions(turn_execution_id) ON DELETE SET NULL
	) STRICT`,
] as const;

export const MULTI_MENTION_DOWNS = [
	`DROP TABLE IF EXISTS multi_mention_callbacks`,
	`DROP TABLE IF EXISTS multi_mention_responses`,
	`DROP TABLE IF EXISTS multi_mention_requests`,
] as const;

export const multiMentionMigration: ControlMigration = {
	version: 5,
	name: "multi-mention",
	up: [...MULTI_MENTION_STATEMENTS],
	down: [...MULTI_MENTION_DOWNS],
};
