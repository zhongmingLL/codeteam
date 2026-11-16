import type { Review, Verification } from "../control/stores/types.ts";
import { type GateFinding, type GateResult, gateResult } from "./types.ts";

export interface ReviewGateInput {
	readonly taskId: string;
	readonly taskOwnerProfileId: string | null;
	readonly headSha: string;
	readonly baseSha: string | null;
	readonly reviews: readonly Review[];
	readonly verifications: (findingId: string) => readonly Verification[];
	readonly now?: number;
}

const DEFAULT_BLOCKED_TTL_MS = 24 * 60 * 60 * 1000;

export function latestVerification(verifications: readonly Verification[]): Verification | null {
	if (verifications.length === 0) return null;
	return (
		[...verifications]
			.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
			.at(-1) ?? null
	);
}

export function verificationIsOpen(verification: Verification, now: number): "open" | "blocked" | "closed" {
	if (verification.status === "rejected") return "closed";
	if (verification.status === "confirmed") return "open";
	return now >= (verification.blockedExpiresAt ?? verification.createdAt + DEFAULT_BLOCKED_TTL_MS)
		? "open"
		: "blocked";
}

export function evaluateReviewGate(input: ReviewGateInput): GateResult {
	const findings: GateFinding[] = [];
	const evidenceRefs: string[] = [];
	const current = input.reviews.filter(
		(review) => review.headSha === input.headSha && review.baseSha !== null && review.baseSha === input.baseSha,
	);
	if (input.baseSha === null) {
		findings.push({ code: "review_base_sha_missing", severity: "P1", message: "review gate requires a base SHA" });
	}
	if (current.length === 0) {
		findings.push({
			code: "missing_current_review",
			severity: "P1",
			message: "no independent review covers the exact head/base",
		});
		return gateResult("review", findings, evidenceRefs, "no review covers the exact HEAD/base");
	}
	for (const review of current) evidenceRefs.push(`review:${review.id}`);
	const approvals = current.filter((review) => review.verdict === "approve");
	if (approvals.length === 0) {
		findings.push({ code: "review_not_approved", severity: "P1", message: "no current review approved the change" });
	}
	const now = input.now ?? Date.now();
	const advisory = new Set<string>();
	for (const review of current) {
		if (input.taskOwnerProfileId && review.reviewerProfileId === input.taskOwnerProfileId) {
			findings.push({
				code: "reviewer_is_task_owner",
				severity: "P1",
				message: "reviewer profile matches the task owner",
				evidenceRef: `review:${review.id}`,
			});
		}
		if (review.decision.requiresHumanGate === true && !advisory.has("human_review_required")) {
			advisory.add("human_review_required");
			findings.push({
				code: "human_review_required",
				severity: "P3",
				message: "review policy marks this risk class as requiring a human gate",
				evidenceRef: `review:${review.id}`,
			});
		}
		for (const finding of review.findings) {
			if (finding.severity !== "P1" && finding.severity !== "P2") continue;
			const latest = latestVerification(input.verifications(finding.id));
			if (!latest) {
				findings.push({
					code: "p1p2_without_verification",
					severity: finding.severity,
					message: `open ${finding.severity} finding has no falsifier verification`,
					evidenceRef: `finding:${finding.id}`,
				});
				continue;
			}
			evidenceRefs.push(`verification:${latest.id}`);
			const state = verificationIsOpen(latest, now);
			if (state === "closed") continue;
			if (state === "open") {
				findings.push({
					code: latest.status === "blocked" ? "verification_blocked_expired" : "finding_confirmed_open",
					severity: finding.severity,
					message:
						latest.status === "blocked"
							? `${finding.severity} falsifier is blocked and past its expiry`
							: `${finding.severity} finding is confirmed by its falsifier`,
					evidenceRef: `verification:${latest.id}`,
				});
			} else {
				findings.push({
					code: "verification_blocked",
					severity: "P2",
					message: `${finding.severity} falsifier is blocked; gate cannot close it yet`,
					evidenceRef: `verification:${latest.id}`,
				});
			}
		}
	}
	return gateResult(
		"review",
		findings,
		evidenceRefs,
		current.length === 0 ? "no current review" : `current reviews: ${current.length}`,
	);
}
