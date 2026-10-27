export type ControlErrorCode =
	| "data_dir_missing"
	| "database_open_failed"
	| "invalid_busy_timeout"
	| "invalid_migration_set"
	| "migration_failed"
	| "schema_incomplete"
	| "schema_ahead"
	| "not_found"
	| "conflict"
	| "invalid_input"
	| "invalid_state"
	| "version_conflict"
	| "claim_conflict"
	| "invalid_token"
	| "forbidden";

export class ControlError extends Error {
	readonly code: ControlErrorCode;

	constructor(code: ControlErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ControlError";
		this.code = code;
	}
}
