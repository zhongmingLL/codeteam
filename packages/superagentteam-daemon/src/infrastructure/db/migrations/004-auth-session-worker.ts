import type { ControlMigration } from "./index.ts";

/**
 * F018 R1-c auth/session/worker/draft schema (0007 §4.3.2/§4.4/§4.6,
 * 0010 §6, 0017 §3).
 *
 * Also completes the R1-b FK deferral: invocation_attempts gains
 * agent_session_id → agent_sessions and worker_id → workers FKs (SQLite
 * cannot ADD FOREIGN KEY, so 003 created them without; this migration
 * rebuilds invocation_attempts with the FKs included — R1-b noted this
 * exact follow-up in its migration header).
 */
export const AUTH_SESSION_WORKER_STATEMENTS = [
	// agent_sessions (0010): thread × agent durable execution identity,
	// single active per pair enforced by partial unique index.
	`CREATE TABLE agent_sessions (
		id TEXT PRIMARY KEY,
		thread_id TEXT NOT NULL,
		agent_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		seq INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0),
		last_counted_turn_execution_id TEXT,
		status TEXT NOT NULL CHECK (status IN ('active', 'sealing', 'sealed')),
		pi_session_id TEXT,
		pi_session_file TEXT,
		working_directory TEXT NOT NULL,
		message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
		consecutive_resume_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_resume_failures >= 0),
		seal_reason TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		sealed_at INTEGER,
		CHECK (status <> 'sealed' OR sealed_at IS NOT NULL),
		FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT
	) STRICT`,
	`CREATE UNIQUE INDEX agent_sessions_one_active
		ON agent_sessions(thread_id, agent_id) WHERE status = 'active'`,
	`CREATE UNIQUE INDEX agent_sessions_pair_seq ON agent_sessions(thread_id, agent_id, seq)`,

	// workers (0007 §4.6): ephemeral execution carrier, capacity=1.
	`CREATE TABLE workers (
		id TEXT PRIMARY KEY,
		project_path TEXT NOT NULL,
		account_ref TEXT NOT NULL,
		provider TEXT NOT NULL,
		model TEXT NOT NULL,
		state TEXT NOT NULL CHECK (state IN ('starting', 'online', 'draining', 'stale', 'retired')),
		capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity = 1),
		pid INTEGER,
		heartbeat_at INTEGER NOT NULL,
		lease_expires_at INTEGER NOT NULL,
		idle_since INTEGER,
		retired_at INTEGER,
		last_error TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		CHECK (state <> 'retired' OR retired_at IS NOT NULL)
	) STRICT`,
	`CREATE INDEX workers_state_lease ON workers(state, lease_expires_at)`,

	// worker_bindings (0007 §4.6): one session per worker, one worker per session.
	`CREATE TABLE worker_bindings (
		agent_session_id TEXT PRIMARY KEY,
		worker_id TEXT NOT NULL UNIQUE,
		generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
		state TEXT NOT NULL CHECK (state IN ('attached', 'idle', 'reattach_pending')),
		bound_at INTEGER NOT NULL,
		last_used_at INTEGER NOT NULL,
		FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
		FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
	) STRICT`,
	`CREATE INDEX worker_bindings_worker ON worker_bindings(worker_id)`,

	// response_drafts (0017 §3): single DraftRecord per attempt/turn.
	`CREATE TABLE response_drafts (
		attempt_id TEXT PRIMARY KEY,
		turn_execution_id TEXT NOT NULL UNIQUE,
		parent_invocation_id TEXT NOT NULL,
		thread_id TEXT NOT NULL,
		agent_id TEXT NOT NULL,
		content TEXT NOT NULL DEFAULT '',
		tool_events_json TEXT NOT NULL DEFAULT '[]'
			CHECK (json_valid(tool_events_json) AND json_type(tool_events_json) = 'array'),
		thinking TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		FOREIGN KEY (attempt_id) REFERENCES invocation_attempts(attempt_id) ON DELETE CASCADE,
		FOREIGN KEY (turn_execution_id) REFERENCES turn_executions(turn_execution_id) ON DELETE CASCADE,
		FOREIGN KEY (parent_invocation_id) REFERENCES invocation_records(invocation_id) ON DELETE RESTRICT,
		FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT
	) STRICT`,
	`CREATE INDEX response_drafts_thread ON response_drafts(thread_id, updated_at)`,

	// invocation_credentials (0007 §4.4): child TurnExecution capability.
	`CREATE TABLE invocation_credentials (
		credential_id TEXT PRIMARY KEY,
		token_hash TEXT NOT NULL UNIQUE,
		token_salt TEXT NOT NULL,
		turn_execution_id TEXT NOT NULL UNIQUE,
		parent_invocation_id TEXT NOT NULL,
		thread_id TEXT NOT NULL,
		agent_id TEXT NOT NULL,
		agent_session_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		allowed_tools_json TEXT NOT NULL
			CHECK (json_valid(allowed_tools_json) AND json_type(allowed_tools_json) = 'array'),
		tool_call_claims_json TEXT NOT NULL DEFAULT '{}'
			CHECK (json_valid(tool_call_claims_json) AND json_type(tool_call_claims_json) = 'object'),
		state TEXT NOT NULL CHECK (state IN ('active', 'terminal')),
		disposition TEXT CHECK (
			disposition IS NULL OR disposition IN ('completed', 'failed', 'interrupted', 'canceled', 'revoked', 'replaced')
		),
		replaced_by_turn_execution_id TEXT,
		expires_at INTEGER,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		CHECK (state <> 'terminal' OR disposition IS NOT NULL),
		CHECK (state <> 'active' OR disposition IS NULL),
		CHECK (state <> 'active' OR expires_at IS NULL),
		CHECK (replaced_by_turn_execution_id IS NULL OR disposition = 'replaced'),
		CHECK (disposition <> 'replaced' OR replaced_by_turn_execution_id IS NOT NULL),
		FOREIGN KEY (turn_execution_id) REFERENCES turn_executions(turn_execution_id) ON DELETE RESTRICT,
		FOREIGN KEY (parent_invocation_id) REFERENCES invocation_records(invocation_id) ON DELETE RESTRICT,
		FOREIGN KEY (replaced_by_turn_execution_id) REFERENCES turn_executions(turn_execution_id) ON DELETE RESTRICT,
		FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT,
		FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE RESTRICT
	) STRICT`,
] as const;

/** Rebuild invocation_attempts with the R1-b deferred FKs. */
export const ATTEMPTS_FK_REBUILD_STATEMENTS = [
	// Copy with FKs (column set identical to 003).
	`CREATE TABLE invocation_attempts_fk (
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
			CHECK (usage_json IS NULL OR (json_valid(usage_json) AND json_type(usage_json) = 'object')),
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
		FOREIGN KEY (response_message_id) REFERENCES messages(id) ON DELETE RESTRICT,
		FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE SET NULL,
		FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE SET NULL
	) STRICT`,
	`INSERT INTO invocation_attempts_fk SELECT * FROM invocation_attempts`,
	`DROP TABLE invocation_attempts`,
	`ALTER TABLE invocation_attempts_fk RENAME TO invocation_attempts`,
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

/** Rebuild invocation_attempts back to the 003 (no-session/worker-FK) shape. */
const ATTEMPTS_FK_ROLLBACK_STATEMENTS = [
	`CREATE TABLE invocation_attempts_nofk (
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
			CHECK (usage_json IS NULL OR (json_valid(usage_json) AND json_type(usage_json) = 'object')),
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
	`INSERT INTO invocation_attempts_nofk SELECT * FROM invocation_attempts`,
	`DROP TABLE invocation_attempts`,
	`ALTER TABLE invocation_attempts_nofk RENAME TO invocation_attempts`,
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

export const AUTH_SESSION_WORKER_DOWNS = [
	`DROP TABLE IF EXISTS invocation_credentials`,
	`DROP TABLE IF EXISTS response_drafts`,
	`DROP TABLE IF EXISTS worker_bindings`,
	`DROP TABLE IF EXISTS workers`,
	`DROP TABLE IF EXISTS agent_sessions`,
	...ATTEMPTS_FK_ROLLBACK_STATEMENTS,
] as const;

export const authSessionWorkerMigration: ControlMigration = {
	version: 4,
	name: "auth-session-worker-draft",
	up: [...AUTH_SESSION_WORKER_STATEMENTS, ...ATTEMPTS_FK_REBUILD_STATEMENTS],
	down: [...AUTH_SESSION_WORKER_DOWNS],
};
