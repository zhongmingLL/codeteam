export type ControlErrorCode =
	| "missing_expected_artifact"
	| "invalid_deadline"
	| "unknown_task"
	| "unknown_run"
	| "unknown_handoff"
	| "task_mismatch"
	| "safe_wait"
	| "terminal_handoff"
	| "run_terminal"
	| "not_claimed"
	| "illegal_transition"
	| "loop_guard";

export class ControlPlaneError extends Error {
	readonly code: ControlErrorCode;

	constructor(code: ControlErrorCode, message: string) {
		super(message);
		this.name = "ControlPlaneError";
		this.code = code;
	}
}
