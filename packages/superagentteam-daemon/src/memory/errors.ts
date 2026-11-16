export type MemoryErrorCode =
	| "memory_unavailable"
	| "memory_busy"
	| "memory_isolation_violation"
	| "memory_schema_incomplete"
	| "memory_schema_ahead"
	| "invalid_input"
	| "not_found"
	| "index_failed"
	| "path_denied"
	| "secret_redacted"
	| "max_file_bytes"
	| "parse_error";

export class MemoryError extends Error {
	readonly code: MemoryErrorCode;
	readonly details: Record<string, unknown> | null;

	constructor(code: MemoryErrorCode, message: string, options?: ErrorOptions & { details?: Record<string, unknown> }) {
		super(message, options);
		this.name = "MemoryError";
		this.code = code;
		this.details = options?.details ?? null;
	}
}
