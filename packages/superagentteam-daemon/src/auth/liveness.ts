import { ControlError } from "../control/errors.ts";
import type { InvocationCredential } from "../control/stores/types.ts";

export type InvocationLiveness = "active" | "candidate" | "stale_invocation";

export interface InvocationLivenessEvidence {
	readonly runId: string;
	readonly workerAlive?: boolean | null;
	readonly lastRunEventAt?: number | null;
	readonly staleAfterMs?: number;
	readonly now?: number;
}

export const DEFAULT_LIVENESS_STALE_MS = 5 * 60 * 1000;

export function assessInvocationLiveness(
	credential: InvocationCredential,
	evidence: InvocationLivenessEvidence,
): InvocationLiveness {
	if (credential.state !== "active") {
		throw new ControlError("invalid_state", `credential ${credential.id} is terminal`);
	}
	const now = evidence.now ?? Date.now();
	const staleAfterMs = evidence.staleAfterMs ?? DEFAULT_LIVENESS_STALE_MS;
	const heartbeatStale = now - credential.lastRefreshAt >= staleAfterMs;
	if (evidence.workerAlive === true) return "active";
	const runIdMatches = evidence.runId === credential.runId;
	if (evidence.workerAlive === false) {
		const eventFresh =
			evidence.lastRunEventAt !== null &&
			evidence.lastRunEventAt !== undefined &&
			now - evidence.lastRunEventAt < staleAfterMs;
		if (runIdMatches && !eventFresh) return "stale_invocation";
		return "candidate";
	}
	return heartbeatStale ? "candidate" : "active";
}
