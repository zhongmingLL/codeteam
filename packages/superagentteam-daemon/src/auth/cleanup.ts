import type { ControlStore } from "../control/store.ts";

export const CREDENTIAL_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SweepCredentialTombstonesOptions {
	readonly now?: number;
	readonly ttlMs?: number;
}

export function sweepCredentialTombstones(store: ControlStore, options: SweepCredentialTombstonesOptions = {}): number {
	const now = options.now ?? Date.now();
	const ttlMs = options.ttlMs ?? CREDENTIAL_TOMBSTONE_TTL_MS;
	const cutoff = now - ttlMs;
	const deleted = store.credentials.deleteTerminalBefore(cutoff);
	if (deleted > 0) {
		store.audit.append({
			actor: "system:auth",
			action: "credential_tombstones_swept",
			subject: "invocation_credentials",
			args: { deleted, cutoff },
		});
	}
	return deleted;
}
