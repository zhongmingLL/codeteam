export const REVIEW_EVIDENCE_STATEMENTS: readonly string[] = [
	`ALTER TABLE reviews ADD COLUMN base_sha TEXT CHECK (base_sha IS NULL OR length(base_sha) IN (40, 64))`,
	`ALTER TABLE reviews ADD COLUMN author_profile_id TEXT`,
	`ALTER TABLE reviews ADD COLUMN reviewer_profile_id TEXT`,
	`ALTER TABLE reviews ADD COLUMN risk_class TEXT NOT NULL DEFAULT 'code' CHECK (risk_class IN ('low_risk_docs', 'code', 'high_risk'))`,
	`ALTER TABLE reviews ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(policy_json) AND json_type(policy_json) = 'object')`,
	`CREATE INDEX reviews_task_head_base ON reviews(task_id, head_sha, base_sha)`,
];
