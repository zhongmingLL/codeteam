export const SOP_CHECK_EVIDENCE_STATEMENTS: readonly string[] = [
	`CREATE TABLE sop_check_evidence (
		id TEXT PRIMARY KEY,
		backlog_item_id TEXT NOT NULL,
		check_name TEXT NOT NULL CHECK (check_name IN ('remoteMainSynced', 'qualityGatePassed', 'reviewApproved', 'visionGuardDone')),
		evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('git_sync', 'quality_gate', 'review', 'vision_guard')),
		evidence_ref TEXT NOT NULL,
		subject_revision TEXT NOT NULL,
		recorded_by TEXT NOT NULL,
		recorded_at INTEGER NOT NULL,
		CHECK (
			(check_name = 'remoteMainSynced' AND evidence_kind = 'git_sync') OR
			(check_name = 'qualityGatePassed' AND evidence_kind = 'quality_gate') OR
			(check_name = 'reviewApproved' AND evidence_kind = 'review') OR
			(check_name = 'visionGuardDone' AND evidence_kind = 'vision_guard')
		),
		FOREIGN KEY (backlog_item_id) REFERENCES backlog_items(id) ON DELETE CASCADE
	) STRICT`,
	`CREATE UNIQUE INDEX sop_check_evidence_dedupe
		ON sop_check_evidence(backlog_item_id, check_name, subject_revision, evidence_ref)`,
	`CREATE INDEX sop_check_evidence_latest
		ON sop_check_evidence(backlog_item_id, check_name, recorded_at DESC)`,
];
