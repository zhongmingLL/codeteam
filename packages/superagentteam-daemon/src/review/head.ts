import { ControlError } from "../control/errors.ts";
import type { AuditStore } from "../control/stores/audit.ts";
import type { AuditEntry, Review } from "../control/stores/types.ts";

export type ReviewFreshnessStatus =
	| "current"
	| "stale_head"
	| "stale_base"
	| "stale_head_and_base"
	| "stale_verification";

export interface ReviewFreshness {
	readonly status: ReviewFreshnessStatus;
	readonly reviewValid: boolean;
	readonly requiresRebase: boolean;
	readonly requiresTargetedTest: boolean;
	readonly requiresFastReReview: boolean;
	readonly invalidatesVerifications: boolean;
	readonly reasons: readonly string[];
}

export interface ReviewFreshnessInput {
	readonly review: Pick<Review, "headSha" | "baseSha">;
	readonly currentHeadSha: string;
	readonly currentBaseSha: string | null;
	readonly verificationHeadShas?: readonly string[];
}

export interface HeadAuditSource {
	readonly audit: Pick<AuditStore, "latest">;
}

export function validateSha(value: string, label = "sha"): string {
	const sha = value.trim();
	if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) {
		throw new ControlError("invalid_input", `${label} must be 40 or 64 lowercase hex characters`);
	}
	return sha;
}

export function assertHeadTraceable(store: HeadAuditSource, headSha: string, taskId?: string): AuditEntry {
	const sha = validateSha(headSha, "headSha");
	const audit = store.audit.latest(`commit:${sha}`, "commit_created");
	if (!audit) {
		throw new ControlError("invalid_input", `headSha ${sha} is not traceable to a coder commit audit`);
	}
	const auditedSha = typeof audit.args.headSha === "string" ? audit.args.headSha : null;
	if (auditedSha !== null && auditedSha !== sha) {
		throw new ControlError("invalid_input", `commit audit for ${sha} records a different headSha`);
	}
	const auditedTaskId = typeof audit.args.taskId === "string" ? audit.args.taskId : null;
	if (taskId) {
		if (!auditedTaskId) {
			throw new ControlError("invalid_input", `commit audit for ${sha} is not bound to task ${taskId}`);
		}
		if (auditedTaskId !== taskId) {
			throw new ControlError("invalid_input", `commit audit for ${sha} belongs to task ${auditedTaskId}`);
		}
	}
	return audit;
}

export function assessReviewFreshness(input: ReviewFreshnessInput): ReviewFreshness {
	const currentHead = validateSha(input.currentHeadSha, "currentHeadSha");
	const currentBase = input.currentBaseSha === null ? null : validateSha(input.currentBaseSha, "currentBaseSha");
	const reasons: string[] = [];
	const headChanged = input.review.headSha !== currentHead;
	const baseMissing = input.review.baseSha === null;
	const baseChanged = baseMissing || input.review.baseSha !== currentBase;
	if (headChanged) reasons.push("head_changed");
	if (baseMissing) reasons.push("review_base_sha_missing");
	else if (baseChanged) reasons.push("base_changed");
	const verificationStale = (input.verificationHeadShas ?? []).some((sha) => sha !== currentHead);
	if (verificationStale) reasons.push("verification_head_stale");

	let status: ReviewFreshnessStatus;
	if (headChanged && baseChanged) status = "stale_head_and_base";
	else if (headChanged) status = "stale_head";
	else if (baseChanged) status = "stale_base";
	else if (verificationStale) status = "stale_verification";
	else status = "current";

	const reviewValid = !headChanged && !baseChanged;
	return {
		status,
		reviewValid,
		requiresRebase: baseChanged,
		requiresTargetedTest: headChanged || baseChanged,
		requiresFastReReview: headChanged || baseChanged,
		invalidatesVerifications: headChanged || baseChanged || verificationStale,
		reasons,
	};
}
