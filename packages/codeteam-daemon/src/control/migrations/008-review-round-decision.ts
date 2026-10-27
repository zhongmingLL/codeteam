export const REVIEW_ROUND_DECISION_STATEMENTS: readonly string[] = [
	`ALTER TABLE reviews ADD COLUMN round INTEGER NOT NULL DEFAULT 1 CHECK (round >= 1)`,
	`ALTER TABLE reviews ADD COLUMN stage TEXT NOT NULL DEFAULT 'review'`,
	`ALTER TABLE reviews ADD COLUMN previous_review_id TEXT`,
	`ALTER TABLE reviews ADD COLUMN envelope_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(envelope_json) AND json_type(envelope_json) = 'object')`,
	`ALTER TABLE reviews ADD COLUMN decision_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(decision_json) AND json_type(decision_json) = 'object')`,
	`ALTER TABLE verifications ADD COLUMN blocked_expires_at INTEGER CHECK (blocked_expires_at IS NULL OR blocked_expires_at >= 0)`,
	`CREATE INDEX reviews_previous ON reviews(previous_review_id)`,
];
