export const WORK_SCHEMA_STATEMENTS: readonly string[] = [
	`CREATE TABLE backlog_items (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		project_id TEXT,
		title TEXT NOT NULL,
		summary TEXT NOT NULL,
		priority TEXT NOT NULL CHECK (priority IN ('p0', 'p1', 'p2', 'p3')),
		tags_json TEXT NOT NULL CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array'),
		status TEXT NOT NULL CHECK (status IN ('open', 'suggested', 'approved', 'dispatched', 'done')),
		created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('cat', 'user', 'system')),
		created_by_id TEXT NOT NULL,
		suggestion_json TEXT CHECK (suggestion_json IS NULL OR (json_valid(suggestion_json) AND json_type(suggestion_json) = 'object')),
		lease_json TEXT CHECK (lease_json IS NULL OR (json_valid(lease_json) AND json_type(lease_json) = 'object')),
		dependencies_json TEXT CHECK (dependencies_json IS NULL OR (json_valid(dependencies_json) AND json_type(dependencies_json) = 'object')),
		dispatched_thread_id TEXT,
		dispatched_thread_phase TEXT CHECK (dispatched_thread_phase IS NULL OR dispatched_thread_phase IN ('coding', 'research', 'brainstorm')),
		dispatch_attempt_id TEXT,
		pending_thread_id TEXT,
		kickoff_message_id TEXT,
		approved_at INTEGER,
		dispatched_at INTEGER,
		done_at INTEGER,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		FOREIGN KEY (dispatched_thread_id) REFERENCES threads(id) ON DELETE SET NULL,
		FOREIGN KEY (pending_thread_id) REFERENCES threads(id) ON DELETE SET NULL,
		FOREIGN KEY (kickoff_message_id) REFERENCES messages(id) ON DELETE SET NULL
	) STRICT`,
	`CREATE UNIQUE INDEX backlog_items_dispatch_attempt ON backlog_items(dispatch_attempt_id) WHERE dispatch_attempt_id IS NOT NULL`,
	`CREATE INDEX backlog_items_status_priority ON backlog_items(status, priority, created_at)`,
	`CREATE INDEX backlog_items_project ON backlog_items(project_id) WHERE project_id IS NOT NULL`,
	`CREATE TABLE workflow_sops (
		backlog_item_id TEXT PRIMARY KEY,
		feature_id TEXT NOT NULL,
		sop_definition_id TEXT NOT NULL DEFAULT 'development',
		stage TEXT NOT NULL CHECK (stage IN ('kickoff', 'impl', 'quality_gate', 'fresh_context', 'review', 'merge', 'completion')),
		baton_holder TEXT NOT NULL,
		next_skill TEXT,
		resume_capsule_json TEXT NOT NULL CHECK (json_valid(resume_capsule_json) AND json_type(resume_capsule_json) = 'object'),
		checks_json TEXT NOT NULL CHECK (json_valid(checks_json) AND json_type(checks_json) = 'object'),
		version INTEGER NOT NULL CHECK (version >= 1),
		updated_at INTEGER NOT NULL,
		updated_by TEXT NOT NULL,
		FOREIGN KEY (backlog_item_id) REFERENCES backlog_items(id) ON DELETE CASCADE
	) STRICT`,
	`CREATE TRIGGER workflow_sops_no_verified_insert
	BEFORE INSERT ON workflow_sops
	WHEN json_extract(NEW.checks_json, '$.remoteMainSynced') = 'verified'
		OR json_extract(NEW.checks_json, '$.qualityGatePassed') = 'verified'
		OR json_extract(NEW.checks_json, '$.reviewApproved') = 'verified'
		OR json_extract(NEW.checks_json, '$.visionGuardDone') = 'verified'
	BEGIN
		SELECT RAISE(ABORT, 'verified_requires_evidence');
	END`,
	`CREATE TRIGGER workflow_sops_no_verified_update
	BEFORE UPDATE OF checks_json ON workflow_sops
	WHEN json_extract(NEW.checks_json, '$.remoteMainSynced') = 'verified'
		OR json_extract(NEW.checks_json, '$.qualityGatePassed') = 'verified'
		OR json_extract(NEW.checks_json, '$.reviewApproved') = 'verified'
		OR json_extract(NEW.checks_json, '$.visionGuardDone') = 'verified'
	BEGIN
		SELECT RAISE(ABORT, 'verified_requires_evidence');
	END`,
	`CREATE TABLE work_admissions (
		work_id TEXT PRIMARY KEY,
		owner_user_id TEXT NOT NULL,
		producer_kind TEXT NOT NULL,
		producer_ref TEXT NOT NULL,
		initial_attempt_id TEXT NOT NULL,
		admitted_at INTEGER NOT NULL
	) STRICT`,
	`CREATE INDEX work_admissions_producer ON work_admissions(producer_kind, producer_ref)`,
	`CREATE TABLE work_attempts (
		attempt_id TEXT PRIMARY KEY,
		work_id TEXT NOT NULL,
		attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
		executor_profile_id TEXT,
		created_at INTEGER NOT NULL,
		executor_bound_at INTEGER,
		CHECK (executor_profile_id IS NULL OR executor_bound_at IS NOT NULL),
		UNIQUE (work_id, attempt_number),
		FOREIGN KEY (work_id) REFERENCES work_admissions(work_id) ON DELETE RESTRICT,
		FOREIGN KEY (executor_profile_id) REFERENCES agent_profiles(id) ON DELETE SET NULL
	) STRICT`,
	`CREATE INDEX work_attempts_work ON work_attempts(work_id, attempt_number)`,
	`CREATE TABLE run_managed_work_bindings (
		run_id TEXT PRIMARY KEY,
		work_id TEXT NOT NULL,
		attempt_id TEXT NOT NULL,
		bound_at INTEGER NOT NULL,
		FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
		FOREIGN KEY (work_id) REFERENCES work_admissions(work_id) ON DELETE RESTRICT,
		FOREIGN KEY (attempt_id) REFERENCES work_attempts(attempt_id) ON DELETE RESTRICT
	) STRICT`,
	`CREATE INDEX run_managed_work_bindings_work ON run_managed_work_bindings(work_id, attempt_id)`,
	`CREATE TABLE task_managed_work_bindings (
		task_id TEXT PRIMARY KEY,
		work_id TEXT NOT NULL,
		attempt_id TEXT NOT NULL,
		bound_at INTEGER NOT NULL,
		FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
		FOREIGN KEY (work_id) REFERENCES work_admissions(work_id) ON DELETE RESTRICT,
		FOREIGN KEY (attempt_id) REFERENCES work_attempts(attempt_id) ON DELETE RESTRICT
	) STRICT`,
	`CREATE INDEX task_managed_work_bindings_work ON task_managed_work_bindings(work_id, attempt_id)`,
	`CREATE TRIGGER task_managed_work_bindings_kind
	BEFORE INSERT ON task_managed_work_bindings
	WHEN (SELECT kind FROM tasks WHERE id = NEW.task_id) <> 'pr_tracking'
	BEGIN
		SELECT RAISE(ABORT, 'task_managed_work_requires_pr_tracking');
	END`,
	`CREATE TABLE artifacts (
		id TEXT PRIMARY KEY,
		task_id TEXT NOT NULL,
		run_id TEXT,
		kind TEXT NOT NULL CHECK (kind IN ('spec', 'plan', 'diff', 'test-report', 'review', 'verification', 'merge-receipt', 'log')),
		sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
		path TEXT NOT NULL,
		media_type TEXT NOT NULL,
		bytes INTEGER NOT NULL CHECK (bytes >= 0),
		provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json) AND json_type(provenance_json) = 'object'),
		approval_id TEXT,
		created_at INTEGER NOT NULL,
		FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
		FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL,
		FOREIGN KEY (approval_id) REFERENCES approvals(id) ON DELETE SET NULL
	) STRICT`,
	`CREATE INDEX artifacts_task_created ON artifacts(task_id, created_at)`,
	`CREATE INDEX artifacts_run ON artifacts(run_id) WHERE run_id IS NOT NULL`,
	`CREATE UNIQUE INDEX artifacts_approval ON artifacts(approval_id) WHERE approval_id IS NOT NULL`,
	`CREATE TABLE inbox (
		id TEXT PRIMARY KEY,
		task_id TEXT NOT NULL,
		run_id TEXT,
		kind TEXT NOT NULL CHECK (kind IN ('steer', 'followUp', 'humanGuidance')),
		payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
		status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'expired')),
		created_at INTEGER NOT NULL,
		consumed_at INTEGER,
		CHECK (status <> 'consumed' OR consumed_at IS NOT NULL),
		CHECK (status <> 'pending' OR consumed_at IS NULL),
		FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
		FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL
	) STRICT`,
	`CREATE INDEX inbox_task_status ON inbox(task_id, status, created_at)`,
];
