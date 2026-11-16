import { ControlError } from "../control/errors.ts";
import type { ReviewMode, ReviewRisk } from "../control/stores/types.ts";
import { assertModelFamilyClaim } from "./model-family.ts";

export interface ReviewActor {
	readonly sessionId: string;
	readonly profileId: string;
	readonly model: string;
	readonly modelFamily: string;
}

export interface ReviewerContext {
	readonly fresh: boolean;
	readonly blind: boolean;
	readonly transcriptExcluded: boolean;
}

export interface ReviewPolicy {
	readonly requireDifferentAuthor: true;
	readonly requireDifferentProfile: true;
	readonly requireDifferentModelFamily: boolean;
	readonly allowSameFamilyForLowRiskDocs: true;
	readonly freshContext: boolean;
	readonly blind: boolean;
	readonly findingRequiresFalsifier: true;
}

export const REVIEW_POLICIES: Readonly<Record<ReviewRisk, ReviewPolicy>> = Object.freeze({
	low_risk_docs: Object.freeze({
		requireDifferentAuthor: true,
		requireDifferentProfile: true,
		requireDifferentModelFamily: false,
		allowSameFamilyForLowRiskDocs: true,
		freshContext: false,
		blind: true,
		findingRequiresFalsifier: true,
	}),
	code: Object.freeze({
		requireDifferentAuthor: true,
		requireDifferentProfile: true,
		requireDifferentModelFamily: true,
		allowSameFamilyForLowRiskDocs: true,
		freshContext: true,
		blind: true,
		findingRequiresFalsifier: true,
	}),
	high_risk: Object.freeze({
		requireDifferentAuthor: true,
		requireDifferentProfile: true,
		requireDifferentModelFamily: true,
		allowSameFamilyForLowRiskDocs: true,
		freshContext: true,
		blind: true,
		findingRequiresFalsifier: true,
	}),
});

export type ReviewPolicyStatus = "allowed" | "blocked" | "human_required";

export interface ReviewPolicyDecision {
	readonly status: ReviewPolicyStatus;
	readonly mode: ReviewMode | null;
	readonly violations: readonly string[];
	readonly sameFamilyException: boolean;
	readonly requiresHumanGate: boolean;
	readonly requiresVerifier: boolean;
	readonly policy: ReviewPolicy;
}

export interface ReviewPolicyContext {
	readonly risk: ReviewRisk;
	readonly author: ReviewActor;
	readonly reviewer: ReviewActor;
	readonly reviewerContext: ReviewerContext;
}

export function policyForRisk(risk: ReviewRisk): ReviewPolicy {
	const policy = REVIEW_POLICIES[risk];
	if (!policy) throw new ControlError("invalid_input", `unknown review risk: ${String(risk)}`);
	return policy;
}

export function classifyReviewRisk(input: {
	readonly changedFiles: readonly string[];
	readonly securitySensitive?: boolean;
	readonly dataSensitive?: boolean;
}): ReviewRisk {
	if (input.securitySensitive || input.dataSensitive) return "high_risk";
	if (input.changedFiles.length === 0) return "code";
	if (input.changedFiles.some(isHighRiskFile)) return "high_risk";
	return input.changedFiles.every(isDocsFile) ? "low_risk_docs" : "code";
}

const HIGH_RISK_PATH_PATTERNS: readonly RegExp[] = [
	/(^|\/)(auth|security|secrets?|credentials?|permissions?|sandbox|policy)(\/|\.|$)/i,
	/(^|\/)(migrations?|schema|database|db)(\/|\.|$)/i,
	/(^|\/)\.env(\.|$)/i,
	/\.(pem|key)$/i,
	/(^|\/)id_rsa/i,
	/(^|\/)tokens?(\/|\.|$)/i,
];

function isHighRiskFile(path: string): boolean {
	const normalized = path.replaceAll("\\", "/");
	return HIGH_RISK_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isDocsFile(path: string): boolean {
	const normalized = path.replaceAll("\\", "/").toLowerCase();
	if (normalized.startsWith("docs/")) return true;
	const base = normalized.split("/").pop() ?? normalized;
	const extension = base.includes(".") ? base.slice(base.lastIndexOf(".")) : "";
	if ([".md", ".mdx", ".rst", ".txt"].includes(extension)) return true;
	return ["readme", "changelog", "license", "contributing"].includes(base);
}

export function evaluateReviewPolicy(context: ReviewPolicyContext): ReviewPolicyDecision {
	const policy = policyForRisk(context.risk);
	const violations: string[] = [];
	if (context.author.sessionId === context.reviewer.sessionId) violations.push("same_session");
	if (context.author.profileId === context.reviewer.profileId) violations.push("same_profile");

	let authorFamily = context.author.modelFamily;
	let reviewerFamily = context.reviewer.modelFamily;
	try {
		authorFamily = assertModelFamilyClaim(context.author.model, context.author.modelFamily);
	} catch {
		violations.push("invalid_model_family:author");
	}
	try {
		reviewerFamily = assertModelFamilyClaim(context.reviewer.model, context.reviewer.modelFamily);
	} catch {
		violations.push("invalid_model_family:reviewer");
	}

	const sameFamily = authorFamily === reviewerFamily;
	if (sameFamily && policy.requireDifferentModelFamily) violations.push("different_model_family_required");
	if (policy.freshContext && !context.reviewerContext.fresh) violations.push("fresh_context_required");
	if (policy.blind && !context.reviewerContext.blind) violations.push("blind_context_required");
	if (policy.blind && !context.reviewerContext.transcriptExcluded) violations.push("transcript_not_excluded");

	let status: ReviewPolicyStatus = "allowed";
	if (violations.length > 0) status = context.risk === "high_risk" ? "human_required" : "blocked";
	const sameFamilyException = status === "allowed" && sameFamily;
	const mode: ReviewMode | null =
		status === "allowed" ? (sameFamilyException ? "same_family_fresh" : "cross_family") : null;

	return {
		status,
		mode,
		violations,
		sameFamilyException,
		requiresHumanGate: context.risk === "high_risk",
		requiresVerifier: true,
		policy,
	};
}

export function assertReviewPolicyAllowed(context: ReviewPolicyContext): ReviewPolicyDecision {
	const decision = evaluateReviewPolicy(context);
	if (decision.status !== "allowed") {
		throw new ControlError(
			"forbidden",
			`review policy ${decision.status}: ${decision.violations.join(", ") || "independent review unavailable"}`,
		);
	}
	return decision;
}
