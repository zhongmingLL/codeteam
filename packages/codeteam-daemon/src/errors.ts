export type DaemonErrorCode =
	| "data_dir_missing"
	| "invalid_installation_root"
	| "already_running"
	| "listen_failed"
	| "invalid_state"
	| "missing_services"
	| "undeclared_service";

export class DaemonError extends Error {
	readonly code: DaemonErrorCode;

	constructor(code: DaemonErrorCode, message: string) {
		super(message);
		this.name = "DaemonError";
		this.code = code;
	}
}
