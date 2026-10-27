export const INVOCATION_ALLOWLIST_STATEMENTS: readonly string[] = [
	`ALTER TABLE invocation_credentials ADD COLUMN callback_allowlist_json TEXT CHECK (callback_allowlist_json IS NULL OR (json_valid(callback_allowlist_json) AND json_type(callback_allowlist_json) = 'array'))`,
	`CREATE UNIQUE INDEX invocation_credentials_token_hash ON invocation_credentials(token_hash)`,
];
