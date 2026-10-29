import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { Handoff, Run } from "../control/stores/types.ts";

export type HandoffResolutionStatus = "consumed" | "waiting" | "unverified" | "released" | "skipped";

export interface HandoffResolution {
	readonly handoffId: string;
	readonly status: HandoffResolutionStatus;
	readonly runId?: string;
	readonly evidenceRef?: string;
	readonly reason?: string;
}

export interface HandoffTerminalResolverOptions {
	readonly store: ControlStore;
	readonly clock?: () => number;
}

interface CompletionCandidate {
	readonly runId: string;
	readonly profileId: string;
	readonly evidenceRef: string;
	readonly result: Record<string, unknown>;
	readonly at: number;
}

interface Verification {
	readonly verified: boolean;
	readonly evidenceRef?: string;
	readonly reason?: string;
}

function candidateFor(handoff: Handoff, runId: string): CompletionCandidate | null {
	const value = handoff.completionCandidates[runId];
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.runId !== "string" || typeof record.profileId !== "string") return null;
	if (typeof record.evidenceRef !== "string") return null;
	const result =
		record.result && typeof record.result === "object" && !Array.isArray(record.result)
			? (record.result as Record<string, unknown>)
			: {};
	return {
		runId: record.runId,
		profileId: record.profileId,
		evidenceRef: record.evidenceRef,
		result,
		at: typeof record.at === "number" ? record.at : 0,
	};
}

function allCandidates(handoff: Handoff): CompletionCandidate[] {
	const candidates: CompletionCandidate[] = [];
	for (const runId of Object.keys(handoff.completionCandidates)) {
		const candidate = candidateFor(handoff, runId);
		if (candidate) candidates.push(candidate);
	}
	return candidates;
}

export class HandoffTerminalResolver {
	private readonly store: ControlStore;
	private readonly clock: () => number;

	constructor(options: HandoffTerminalResolverOptions) {
		this.store = options.store;
		this.clock = options.clock ?? Date.now;
	}

	onRunTerminal(run: Run): readonly HandoffResolution[] {
		const resolutions: HandoffResolution[] = [];
		for (const claim of this.store.handoffs.listActiveClaimsByRun(run.id)) {
			const handoff = this.store.handoffs.get(claim.handoffId);
			if (!handoff || (handoff.status !== "pending" && handoff.status !== "claimed")) continue;
			const candidate = candidateFor(handoff, run.id);
			if (candidate) {
				const resolution = this.resolveHandoff(handoff.id, run.id);
				resolutions.push(resolution);
				if (
					resolution.status === "unverified" &&
					run.status !== "completed" &&
					run.status !== "running"
				) {
					const reason = `holder_run_${run.status}_candidate_unverified`;
					if (handoff.mode === "parallel") {
						this.store.handoffs.recordParallelUnfinished({
							handoffId: handoff.id,
							profileId: claim.profileId,
							runId: run.id,
							reason,
						});
					}
					this.store.handoffs.releaseClaim(handoff.id, claim.profileId, reason);
					this.store.audit.append({
						actor: "system:handoff-resolver",
						action: "handoff_holder_released",
						subject: `handoff:${handoff.id}`,
						args: { runId: run.id, profileId: claim.profileId, reason },
					});
					resolutions.push({ handoffId: handoff.id, status: "released", runId: run.id, reason });
				}
				continue;
			}
			if (handoff.status !== "claimed") continue;
			const reason = `holder_run_${run.status}_without_candidate`;
			if (handoff.mode === "parallel") {
				this.store.handoffs.recordParallelUnfinished({
					handoffId: handoff.id,
					profileId: claim.profileId,
					runId: run.id,
					reason,
				});
			}
			this.store.handoffs.releaseClaim(handoff.id, claim.profileId, reason);
			this.store.audit.append({
				actor: "system:handoff-resolver",
				action: "handoff_holder_released",
				subject: `handoff:${handoff.id}`,
				args: { runId: run.id, profileId: claim.profileId, reason },
			});
			resolutions.push({ handoffId: handoff.id, status: "released", runId: run.id, reason });
		}
		return resolutions;
	}

	resolvePending(taskId?: string): readonly HandoffResolution[] {
		const resolutions: HandoffResolution[] = [];
		for (const handoff of this.store.handoffs.list({ taskId, status: "claimed" })) {
			resolutions.push(this.resolveHandoff(handoff.id));
		}
		return resolutions;
	}

	resolveHandoff(handoffId: string, triggerRunId?: string): HandoffResolution {
		const handoff = this.store.handoffs.get(handoffId);
		if (!handoff) throw new ControlError("not_found", `handoff ${handoffId} not found`);
		if (handoff.status !== "claimed") {
			return { handoffId, status: "skipped", reason: `handoff_${handoff.status}` };
		}
		const candidates = allCandidates(handoff);
		if (candidates.length === 0) {
			return { handoffId, status: "waiting", reason: "no_completion_candidate" };
		}
		const claims = this.store.handoffs.listClaims(handoff.id).filter((claim) => claim.status === "active");
		const activeProfiles = new Set(claims.map((claim) => claim.profileId));
		if (handoff.mode === "single") {
			const candidate = [...candidates].sort((left, right) => right.at - left.at)[0]!;
			if (!activeProfiles.has(candidate.profileId)) {
				return { handoffId, status: "waiting", reason: "candidate_claim_not_active", runId: candidate.runId };
			}
			return this.verifyAndCommit(handoff, candidate);
		}
		const verifiedByProfile = new Map<string, { candidate: CompletionCandidate; verification: Verification }>();
		for (const candidate of candidates) {
			if (!activeProfiles.has(candidate.profileId)) continue;
			const verification = this.verify(handoff, candidate);
			if (!verification.verified) {
				this.recordUnverified(handoff, candidate, verification);
				continue;
			}
			const previous = verifiedByProfile.get(candidate.profileId);
			if (!previous || candidate.at >= previous.candidate.at) {
				verifiedByProfile.set(candidate.profileId, { candidate, verification });
			}
		}
		const missing = handoff.holderProfileIds.filter((profileId) => !verifiedByProfile.has(profileId));
		if (missing.length > 0) {
			return {
				handoffId,
				status: "waiting",
				reason: `parallel_holders_pending:${missing.join(",")}`,
				runId: triggerRunId,
			};
		}
		const selected =
			(triggerRunId ? verifiedByProfile.get(candidateFor(handoff, triggerRunId)?.profileId ?? "") : null) ??
			[...verifiedByProfile.values()].sort((left, right) => right.candidate.at - left.candidate.at)[0];
		if (!selected) return { handoffId, status: "waiting", reason: "parallel_verified_candidate_missing" };
		return this.commit(handoff, selected.candidate, selected.verification, [...verifiedByProfile.keys()]);
	}

	private verifyAndCommit(handoff: Handoff, candidate: CompletionCandidate): HandoffResolution {
		const verification = this.verify(handoff, candidate);
		if (!verification.verified) {
			this.recordUnverified(handoff, candidate, verification);
			return {
				handoffId: handoff.id,
				status: "unverified",
				runId: candidate.runId,
				reason: verification.reason,
			};
		}
		return this.commit(handoff, candidate, verification, [candidate.profileId]);
	}

	private verify(handoff: Handoff, candidate: CompletionCandidate): Verification {
		const kind = handoff.terminalPredicate.kind;
		if (kind === "run_completed") {
			const run = this.store.runs.get(candidate.runId);
			if (!run) return { verified: false, reason: "candidate_run_not_found" };
			if (run.status !== "completed") return { verified: false, reason: `candidate_run_${run.status}` };
			return { verified: true, evidenceRef: `run:${run.id}:completed` };
		}
		if (kind === "review_delivered") {
			const headSha = handoff.terminalPredicate.headSha;
			if (typeof headSha !== "string" || headSha.trim() === "") {
				return { verified: false, reason: "review_delivered_missing_head_sha" };
			}
			const review = this.store.reviews
				.listByTask(handoff.taskId)
				.find(
					(candidateReview) =>
						candidateReview.runId === candidate.runId &&
						candidateReview.reviewerProfileId === candidate.profileId &&
						candidateReview.headSha === headSha,
				);
			if (!review) return { verified: false, reason: "review_delivered_record_not_found" };
			return { verified: true, evidenceRef: `review:${review.id}` };
		}
		return { verified: false, reason: `unsupported_terminal_predicate:${String(kind)}` };
	}

	private commit(
		handoff: Handoff,
		candidate: CompletionCandidate,
		verification: Verification,
		verifiedProfiles: readonly string[],
	): HandoffResolution {
		const evidenceRef = verification.evidenceRef ?? candidate.evidenceRef;
		const committed = this.store.handoffs.commitCompletion({
			handoffId: handoff.id,
			profileId: candidate.profileId,
			runId: candidate.runId,
			evidenceRef,
			result: {
				...candidate.result,
				terminalPredicate: handoff.terminalPredicate,
				candidateEvidenceRef: candidate.evidenceRef,
				verifiedBy: "system:handoff-resolver",
				verificationEvidenceRef: evidenceRef,
			},
			verified: true,
			verifiedProfiles,
		});
		this.store.messages.append({
			threadId: committed.holderThreadId,
			taskId: committed.taskId,
			authorKind: "system",
			authorId: "system:handoff-resolver",
			kind: "status",
			bodyMd: `Handoff ${committed.id} consumed after server-owned terminal verification (${evidenceRef}).`,
		});
		return { handoffId: committed.id, status: "consumed", runId: candidate.runId, evidenceRef };
	}

	private recordUnverified(handoff: Handoff, candidate: CompletionCandidate, verification: Verification): void {
		const subject = `handoff:${handoff.id}`;
		const duplicate = this.store.audit
			.listSubject(subject, 20)
			.some(
				(entry) =>
					entry.action === "handoff_completion_unverified" &&
					entry.args.runId === candidate.runId &&
					entry.args.reason === verification.reason,
			);
		if (duplicate) return;
		this.store.audit.append({
			actor: "system:handoff-resolver",
			action: "handoff_completion_unverified",
			subject,
			args: { runId: candidate.runId, profileId: candidate.profileId, reason: verification.reason },
		});
	}
}
