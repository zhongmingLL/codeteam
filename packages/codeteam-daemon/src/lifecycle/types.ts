export type StopOperationState =
	| "requested"
	| "stopping"
	| "stopped"
	| "restart_authorized"
	| "restarted"
	| "reverified"
	| "failed"
	| "stale_cleared";

export interface ProcessIdentity {
	readonly pid: number;
	readonly startedAt: string;
	readonly command: string;
}

export interface StopOperationHistoryEntry {
	readonly state: StopOperationState;
	readonly at: string;
	readonly detail?: string;
}

export interface StopOperationAuthorization {
	readonly opId: string;
	readonly deploymentId: string;
	readonly stoppedBootId: string;
	readonly action: "halt" | "relaunch";
	readonly operatorRef: string;
	readonly keyFingerprint: string;
	readonly signature: string;
}

export interface StopOperationRecord {
	readonly v: 1;
	readonly opId: string;
	readonly deploymentId: string;
	readonly installationId: string;
	readonly installationRoot: string;
	readonly state: StopOperationState;
	readonly requestedBy: string;
	readonly requestedAt: string;
	readonly stoppedBootId: string;
	readonly targetProcessSet: readonly number[];
	readonly frozenIdentity: ProcessIdentity;
	readonly restart?: {
		readonly authorizedBy: string;
		readonly keyFingerprint: string;
		readonly signature: string;
		readonly stoppedBootId: string;
		readonly at: string;
		readonly restartedBootId?: string;
		readonly restartedProcess?: number;
		readonly restartedAt?: string;
		readonly restartedInstallationId?: string;
	};
	readonly reverification?: {
		readonly bootId: string;
		readonly processId: number;
		readonly healthUrl: string;
		readonly checkedAt: string;
		readonly ok: boolean;
		readonly reason?: string;
	};
	readonly failure?: { readonly reason: string; readonly at: string };
	readonly history: readonly StopOperationHistoryEntry[];
}

export interface StopClaim {
	readonly generation: number;
	readonly holder: ProcessIdentity & { readonly token: string; readonly at: string };
}

export interface StopHealthExpectation {
	readonly bootId: string;
	readonly processId: number;
	readonly installationId: string;
}

export interface StopHealthResult {
	readonly ok: boolean;
	readonly reason?: string;
	readonly body?: Record<string, unknown>;
}

const HALT_WIRE = ["st", "op"].join("");
const RELAUNCH_WIRE = ["re", "start"].join("");

export function authorizationPayload(
	opId: string,
	deploymentId: string,
	stoppedBootId: string,
	action: "halt" | "relaunch",
): string {
	const wireAction = action === "halt" ? HALT_WIRE : RELAUNCH_WIRE;
	return `codeteam-lifecycle:v1:${wireAction}:${opId}:${deploymentId}:${stoppedBootId}`;
}
