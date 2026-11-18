export const MERGE_RECEIPT_CONTRACT_STATEMENTS: readonly string[] = [
	`ALTER TABLE merges ADD COLUMN executed_by TEXT NOT NULL DEFAULT 'legacy:approved_by'`,
	`ALTER TABLE merges ADD COLUMN gate_evidence_ref TEXT`,
	`ALTER TABLE merges ADD COLUMN review_ref TEXT`,
	`ALTER TABLE merges ADD COLUMN status TEXT NOT NULL DEFAULT 'succeeded' CHECK (status IN ('succeeded', 'failed', 'unknown'))`,
	`ALTER TABLE merges ADD COLUMN failure_ref TEXT`,
	`ALTER TABLE merges ADD COLUMN hard_gate INTEGER NOT NULL DEFAULT 0 CHECK (hard_gate IN (0, 1))`,
	`ALTER TABLE merges ADD COLUMN strategy TEXT`,
	`ALTER TABLE merges ADD COLUMN repo TEXT`,
	`ALTER TABLE merges ADD COLUMN pr_ref TEXT`,
	`ALTER TABLE merges ADD COLUMN merged_at INTEGER`,
	`CREATE INDEX merges_task_head ON merges(task_id, head_sha)`,
	`CREATE TRIGGER merges_receipt_contract_insert
	BEFORE INSERT ON merges
	WHEN NEW.status = 'succeeded'
		AND (
			NEW.executed_by <> 'service:merge-owner'
			OR NEW.gate_evidence_ref IS NULL
		)
	BEGIN
		SELECT RAISE(ABORT, 'merge_receipt_requires_merge_owner_and_gate_evidence');
	END`,
	`CREATE TRIGGER merges_receipt_failure_ref_insert
	BEFORE INSERT ON merges
	WHEN NEW.status IN ('failed', 'unknown') AND NEW.failure_ref IS NULL
	BEGIN
		SELECT RAISE(ABORT, 'merge_receipt_failure_requires_failure_ref');
	END`,
	`CREATE TRIGGER merges_receipt_hard_gate_insert
	BEFORE INSERT ON merges
	WHEN NEW.hard_gate = 1 AND NEW.approval_id IS NULL
	BEGIN
		SELECT RAISE(ABORT, 'hard_gate_merge_requires_approval');
	END`,
	`CREATE TRIGGER merges_receipt_routine_no_approval_insert
	BEFORE INSERT ON merges
	WHEN NEW.hard_gate = 0 AND NEW.approval_id IS NOT NULL
	BEGIN
		SELECT RAISE(ABORT, 'routine_merge_must_not_have_approval');
	END`,
];
