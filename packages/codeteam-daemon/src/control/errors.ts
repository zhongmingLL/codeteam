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
	| "capacity_exhausted"
	| "invalid_token"
	| "forbidden"
	| "backlog_not_imported"
	| "admission_blocked"
	| "dependency_missing"
	| "dependency_unmet"
	| "dependency_cycle"
	| "budget_paused"
	| "capacity_unknown"
	| "capacity_exhausted"
	| "worktree_capacity_exhausted"
	| "worktree_disk_low"
	| "worktree_disk_unknown"
	| "schedule_unknown_factory"
	| "path_outside_root"
	| "a2a_depth_exceeded"
	| "deployment_wait_pending"
	| "deployment_wait_outcome_pending"
	| "deployment_wait_conflict"
	| "deployment_wait_invalid"
	| "lifecycle_unauthorized"
	| "lifecycle_claim_held"
	| "lifecycle_state_invalid"
	| "lifecycle_identity_mismatch"
	| "lifecycle_executor_inside_target"
	| "lifecycle_record_invalid"
	| "lifecycle_health_failed"
	| "process_tree_unreadable"
	| "command_failed";

export class ControlError extends Error {
	readonly code: ControlErrorCode;
	readonly details: Record<string, unknown> | null;

	constructor(
		code: ControlErrorCode,
		message: string,
		options?: ErrorOptions & { details?: Record<string, unknown> },
	) {
		super(message, options);
		this.name = "ControlError";
		this.code = code;
		this.details = options?.details ?? null;
	}
}
