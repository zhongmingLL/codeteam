import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type DaemonState = "requested" | "ready" | "stopping" | "stopped" | "failed";

export interface DaemonStateFile {
	schemaVersion: 1;
	deploymentId?: string;
	installationId: string;
	installationRoot: string;
	pid: number;
	bootId: string;
	bootSequence: number;
	runningRevision: string;
	state: DaemonState;
	services: string[];
	healthPort: number | null;
	startedAt: string;
	updatedAt: string;
}

export function writeStateFile(stateFile: string, state: DaemonStateFile): void {
	const tmp = `${stateFile}.tmp`;
	writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, stateFile);
}

export function readStateFile(stateFile: string): DaemonStateFile | null {
	if (!existsSync(stateFile)) return null;
	return JSON.parse(readFileSync(stateFile, "utf8")) as DaemonStateFile;
}
