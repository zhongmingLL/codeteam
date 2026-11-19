import type { ControlMigration } from "./index.ts";

/**
 * F018 R1-b execution + queue schema (0007 §4.1-§4.3.1, 0011).
 *
 - invocation_queue + queue_admissions (§4.1): durable statuses are
 *   queued|claimed only; admission receipt keeps replay working after live
 *   row deletion. R-01 (0018): queue_admissions carries thread_id and the
 *   parent-unique is (thread_id, source_record_id) — v1 messageIds are
 *   globally unique so behavior is unchanged, but the key no longer depends
 *   on that accident.
 * - invocation_records (§4.2): message-level fan-out parent.
 * - turn_executions (§4.3): child canonical core + causal.
 * - invocation_attempts (§4.3.1): append-only target delivery/retry ledger
 *   with delivery_state CHECKs, settlement projection, and the
 *   one-active-delivery-per-session partial unique index.
 */
export const INVOCATION_QUEUE_STATEMENTS = [
	`CREATE TABLE invocation_queue (
		version INTEGER NOT NULL CHECK (version = 1),
		queue_entry_id TEXT PRIMARY KEY,
		thread_id TEXT NOT NULL,
		source_record_id TEXT NOT NULL,
		message_id TEXT,
		origin_record_id TEXT,
		attempt INTEGER NOT NULL CHECK (attempt >= 1),
		owner_json TEXT NOT NULL CHECK (json_valid(owner_json) AND json_type(owner_json) = 'object'),
		kind TEXT NOT NULL CHECK (kind IN ('conversation_input', 'message_wake')),
		from_json TEXT NOT NULL CHECK (json_valid(from_json) AND json_type(from_json) = 'object'),
		targets_json TEXT NOT NULL
			CHECK (json_valid(targets_json) AND json_type(targets_json) = 'array'),
		payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
		execution_json TEXT NOT NULL CHECK (json_valid(execution_json) AND json_type(execution_json) = 'object'),
		priority TEXT NOT NULL CHECK (priority IN ('urgent', 'normal')),
		position INTEGER NOT NULL CHECK (position >= 0),
		status TEXT NOT NULL CHECK (status IN ('queued', 'claimed')),
		claim_id TEXT,
		claim_owner TEXT,
		claimed_at INTEGER,
		claim_expires_at INTEGER,
		claimed_target_keys_json TEXT
			CHECK (claimed_target_keys_json IS NULL OR
				(json_valid(claimed_target_keys_json) AND json_type(claimed_target_keys_json) = 'array')),
		enqueued_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		CHECK (status = 'queued' OR
			(claim_id IS NOT NULL AND claim_owner IS NOT NULL AND claimed_at IS NOT NULL
			 AND claim_expires_at IS NOT NULL AND claimed_target_keys_json IS NOT NULL)),
		CHECK (status <> 'queued' OR
			(claim_id IS NULL AND claim_owner IS NULL AND claimed_at IS NULL
			 AND claim_expires_at IS NULL AND claimed_target_keys_json IS NULL)),
		FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT,
		FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE RESTRICT
	) STRICT`,
	`CREATE UNIQUE INDEX invocation_queue_source_attempt
		ON invocation_queue(thread_id, source_record_id, attempt)`,
	`CREATE INDEX invocation_queue_pending
		ON invocation_queue(thread_id, status, priority, position, enqueued_at, queue_entry_id)
		WHERE json_array_length(targets_json) > 0`,
	`CREATE UNIQUE INDEX invocation_queue_claim
		ON invocation_queue(claim_id) WHERE claim_id IS NOT NULL`,
	`CREATE TABLE queue_admissions (
		thread_id TEXT NOT NULL,
		source_record_id TEXT NOT NULL,
		attempt INTEGER NOT NULL CHECK (attempt >= 1),
		queue_entry_id TEXT NOT NULL,
		fingerprint TEXT NOT NULL,
		admitted_at INTEGER NOT NULL,
		PRIMARY KEY (thread_id, source_record_id, attempt)
	) STRICT`,
] as const;

export const INVOCATION_RECORDS_STATEMENTS = [
	`CREATE TABLE invocation_records (
		invocation_id TEXT PRIMARY KEY,
		thread_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		source_record_id TEXT NOT NULL UNIQUE,
		user_message_id TEXT,
		target_agent_ids_json TEXT NOT NULL
			CHECK (json_valid(target_agent_ids_json) AND json_type(target_agent_ids_json) = 'array'
				AND json_array_length(target_agent_ids_json) > 0),
		status TEXT NOT NULL CHECK (
			status IN ('queued', 'running', 'completed', 'partial_failed', 'failed', 'canceled')
		),
		successful_agent_ids_json TEXT NOT NULL DEFAULT '[]'
			CHECK (json_valid(successful_agent_ids_json) AND json_type(successful_agent_ids_json) = 'array'),
		usage_by_agent_json TEXT NOT NULL DEFAULT '{}'
			CHECK (json_valid(usage_by_agent_json) AND json_type(usage_by_agent_json) = 'object'),
		usage_recorded_at INTEGER,
		retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
		terminal_reason TEXT,
		created_at INTEGER NOT NULL,
		started_at INTEGER,
		ended_at INTEGER,
		CHECK (status IN ('queued', 'running') OR ended_at IS NOT NULL),
		CHECK (status IN ('queued', 'failed', 'canceled') OR started_at IS NOT NULL),
		CHECK (status NOT IN ('completed', 'partial_failed')
			OR json_array_length(successful_agent_ids_json) > 0),
		FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT,
		FOREIGN KEY (user_message_id) REFERENCES messages(id) ON DELETE RESTRICT
	) STRICT`,
	`CREATE INDEX invocation_records_thread_status
		ON invocation_records(thread_id, status)`,
] as const;

export const TURN_EXECUTIONS_STATEMENTS = [
	`CREATE TABLE turn_executions (
		turn_execution_id TEXT PRIMARY KEY,
		parent_invocation_id TEXT NOT NULL,
		thread_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		agent_id TEXT NOT NULL,
		execution_kind TEXT NOT NULL CHECK (execution_kind IN ('ordinary', 'routing_guard')),
		causal_json TEXT NOT NULL
			CHECK (json_valid(causal_json) AND json_type(causal_json) = 'object'),
		status TEXT NOT NULL CHECK (
			status IN ('running', 'completed', 'failed', 'interrupted', 'canceled')
		),
		terminal_reason TEXT,
		started_at INTEGER NOT NULL,
		ended_at INTEGER,
		CHECK (status = 'running' OR ended_at IS NOT NULL),
		CHECK (status = 'running' OR terminal_reason IS NOT NULL OR status = 'completed'),
		FOREIGN KEY (parent_invocation_id)
			REFERENCES invocation_records(invocation_id) ON DELETE RESTRICT,
		FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT
	) STRICT`,
	`CREATE INDEX turn_executions_invocation
		ON turn_executions(parent_invocation_id, agent_id)`,
	`CREATE INDEX turn_executions_running
		ON turn_executions(status, started_at)`,
] as const;

export const INVOCATION_ATTEMPTS_STATEMENTS = [
	`CREATE TABLE invocation_attempts (
		attempt_id TEXT PRIMARY KEY,
		parent_invocation_id TEXT NOT NULL,
		queue_entry_id TEXT NOT NULL,
		thread_id TEXT NOT NULL,
		target_agent_id TEXT NOT NULL,
		attempt INTEGER NOT NULL CHECK (attempt >= 1),
		turn_execution_id TEXT UNIQUE,
		delivery_state TEXT NOT NULL CHECK (delivery_state IN (
			'queued', 'starting', 'appended', 'handled',
			'failed', 'interrupted', 'canceled'
		)),
		terminal_reason TEXT,
		agent_session_id TEXT,
		worker_id TEXT,
		provider TEXT,
		model TEXT,
		model_family TEXT,
		usage_json TEXT
			CHECK (usage_json IS NULL OR
				(json_valid(usage_json) AND json_type(usage_json) = 'object')),
		settlement TEXT
			CHECK (settlement IS NULL OR settlement IN ('streaming', 'response_pending', 'settled')),
		response_message_id TEXT UNIQUE,
		delivery_boundary_seq INTEGER
			CHECK (delivery_boundary_seq IS NULL OR delivery_boundary_seq >= 0),
		prompt_delivered_at INTEGER,
		created_at INTEGER NOT NULL,
		started_at INTEGER,
		ended_at INTEGER,
		CHECK (delivery_state IN ('queued', 'starting', 'appended') OR ended_at IS NOT NULL),
		CHECK (delivery_state IN ('queued', 'starting') OR started_at IS NOT NULL
			OR (delivery_state IN ('failed', 'canceled') AND turn_execution_id IS NULL)),
		CHECK (delivery_state NOT IN ('appended', 'handled') OR turn_execution_id IS NOT NULL),
		CHECK (delivery_state NOT IN ('failed', 'interrupted', 'canceled') OR terminal_reason IS NOT NULL),
		CHECK (turn_execution_id IS NOT NULL OR delivery_state IN ('queued', 'starting', 'failed', 'canceled')),
		CHECK (settlement IS NULL OR response_message_id IS NOT NULL),
		CHECK (settlement IS NULL OR delivery_state NOT IN ('queued', 'starting')),
		CHECK (settlement <> 'streaming' OR delivery_state = 'appended'),
		CHECK (settlement <> 'response_pending' OR delivery_state NOT IN ('queued', 'starting', 'appended')),
		CHECK (settlement <> 'settled' OR delivery_state NOT IN ('queued', 'starting', 'appended')),
		CHECK (response_message_id IS NULL OR delivery_state NOT IN ('queued', 'starting')),
		CHECK (delivery_boundary_seq IS NULL OR delivery_state NOT IN ('queued', 'starting')),
		CHECK (prompt_delivered_at IS NULL OR delivery_boundary_seq IS NOT NULL),
		CHECK (prompt_delivered_at IS NULL OR worker_id IS NOT NULL),
		CHECK (prompt_delivered_at IS NULL OR prompt_delivered_at >= started_at),
		CHECK (delivery_state <> 'handled' OR prompt_delivered_at IS NOT NULL),
		UNIQUE (parent_invocation_id, target_agent_id, attempt),
		FOREIGN KEY (parent_invocation_id)
			REFERENCES invocation_records(invocation_id) ON DELETE RESTRICT,
		FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT,
		FOREIGN KEY (turn_execution_id)
			REFERENCES turn_executions(turn_execution_id) ON DELETE SET NULL,
		FOREIGN KEY (response_message_id) REFERENCES messages(id) ON DELETE RESTRICT
	) STRICT`,
	`CREATE INDEX invocation_attempts_latest
		ON invocation_attempts(parent_invocation_id, target_agent_id, attempt DESC)`,
	`CREATE INDEX invocation_attempts_delivery_state
		ON invocation_attempts(delivery_state, started_at)`,
	`CREATE INDEX invocation_attempts_settlement
		ON invocation_attempts(settlement) WHERE settlement = 'response_pending'`,
	`CREATE UNIQUE INDEX invocation_attempts_one_active_per_session
		ON invocation_attempts(agent_session_id)
		WHERE delivery_state IN ('starting', 'appended') AND agent_session_id IS NOT NULL`,
] as const;

export const INVOCATION_QUEUE_DOWNS = [
	`DROP TABLE IF EXISTS queue_admissions`,
	`DROP TABLE IF EXISTS invocation_queue`,
] as const;

export const invocationQueueMigration: ControlMigration = {
	version: 3,
	name: "invocation-queue",
	up: [
		...INVOCATION_QUEUE_STATEMENTS,
		...INVOCATION_RECORDS_STATEMENTS,
		...TURN_EXECUTIONS_STATEMENTS,
		...INVOCATION_ATTEMPTS_STATEMENTS,
	],
	down: [
		`DROP TABLE IF EXISTS invocation_attempts`,
		`DROP TABLE IF EXISTS turn_executions`,
		`DROP TABLE IF EXISTS invocation_records`,
		...INVOCATION_QUEUE_DOWNS,
	],
};
