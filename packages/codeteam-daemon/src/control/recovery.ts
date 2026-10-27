import type { ControlStore } from "./store.ts";
import type { HandoffHolderClaim, LoopGuardSnapshotEntry } from "./stores/types.ts";

export interface RecoverControlPlaneOptions {
	readonly activeRunIds?: Iterable<string>;
	readonly now?: number;
}

export interface RecoveryInterruptedRun {
	readonly runId: string;
	readonly credentialId: string | null;
}

export type RecoveryClaimReleaseReason = "run_interrupted" | "lease_expired";

export interface RecoveryReleasedClaim {
	readonly handoffId: string;
	readonly profileId: string;
	readonly runId: string;
	readonly reason: RecoveryClaimReleaseReason;
}

export interface RecoveryReport {
	readonly interruptedRuns: readonly RecoveryInterruptedRun[];
	readonly expiredHandoffs: readonly string[];
	readonly releasedClaims: readonly RecoveryReleasedClaim[];
	readonly loopGuard: readonly LoopGuardSnapshotEntry[];
	readonly pendingQueueEntries: number;
	readonly drainRequested: boolean;
}

export function recoverControlPlane(store: ControlStore, options: RecoverControlPlaneOptions = {}): RecoveryReport {
	const now = options.now ?? Date.now();
	const activeRunIds = new Set(options.activeRunIds ?? []);
	return store.transaction.run(() => {
		const interruptedRuns: RecoveryInterruptedRun[] = [];
		const expiredHandoffs: string[] = [];
		const releasedClaims: RecoveryReleasedClaim[] = [];
		const staleClaims = store.handoffs.listStaleClaims(now);

		for (const run of store.runs.list({ status: "running" })) {
			if (activeRunIds.has(run.id)) continue;
			store.runs.terminal(run.id, { status: "interrupted", terminalAt: now });
			let credentialId: string | null = null;
			const credential = store.credentials.getByRun(run.id);
			if (credential && credential.state === "active") {
				store.credentials.terminalize(credential.id, "interrupted");
				credentialId = credential.id;
			}
			store.audit.append({
				actor: "system:recovery",
				action: "run_interrupted",
				subject: `run:${run.id}`,
				args: { reason: "startup_recovery", at: now },
			});
			interruptedRuns.push({ runId: run.id, credentialId });
		}

		for (const status of ["pending", "claimed"] as const) {
			for (const handoff of store.handoffs.list({ status })) {
				if (handoff.deadline >= now) continue;
				store.handoffs.expire(handoff.id, "system:recovery", "deadline_passed");
				expiredHandoffs.push(handoff.id);
			}
		}

		const interruptedRunIds = new Set(interruptedRuns.map((entry) => entry.runId));
		for (const runId of interruptedRunIds) {
			for (const claim of store.handoffs.listActiveClaimsByRun(runId)) {
				releaseClaimIfLive(store, claim, "run_interrupted", releasedClaims);
			}
		}

		for (const claim of staleClaims) {
			if (interruptedRunIds.has(claim.runId) || activeRunIds.has(claim.runId)) continue;
			releaseClaimIfLive(store, claim, "lease_expired", releasedClaims);
		}

		const pendingQueueEntries = store.queue.pendingCount();
		return {
			interruptedRuns,
			expiredHandoffs,
			releasedClaims,
			loopGuard: store.handoffs.loopGuardSnapshot(),
			pendingQueueEntries,
			drainRequested: pendingQueueEntries > 0,
		};
	});
}

function releaseClaimIfLive(
	store: ControlStore,
	claim: HandoffHolderClaim,
	reason: RecoveryClaimReleaseReason,
	released: RecoveryReleasedClaim[],
): void {
	const handoff = store.handoffs.get(claim.handoffId);
	if (!handoff || (handoff.status !== "pending" && handoff.status !== "claimed")) return;
	const current = store.handoffs
		.listClaims(claim.handoffId)
		.find((entry) => entry.profileId === claim.profileId && entry.generation === claim.generation);
	if (!current || current.status !== "active") return;
	store.handoffs.releaseClaim(claim.handoffId, claim.profileId, reason);
	released.push({
		handoffId: claim.handoffId,
		profileId: claim.profileId,
		runId: claim.runId,
		reason,
	});
}
