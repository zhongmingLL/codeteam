import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { ReviewMode, ReviewRisk } from "../control/stores/types.ts";
import { assertHeadTraceable, validateSha } from "./head.ts";
import {
	classifyReviewRisk,
	evaluateReviewPolicy,
	type ReviewActor,
	type ReviewerContext,
	type ReviewPolicyDecision,
} from "./policy.ts";

export interface ReviewArtifactRef {
	readonly artifactId: string;
	readonly mediaType: string;
	readonly revision?: string | null;
}

export interface ReviewTestEvidence {
	readonly kind: "test_report" | "ci" | "command";
	readonly ref: string;
	readonly summary?: string;
}

export interface ReviewImpactSurface {
	readonly changedFiles: readonly string[];
	readonly changedSymbols: readonly string[];
	readonly callers: readonly string[];
	readonly affectedTests: readonly string[];
}

export interface ReviewConstraints {
	readonly security: readonly string[];
	readonly data: readonly string[];
	readonly contract: readonly string[];
	readonly other: readonly string[];
}

export interface ReviewPriorFinding {
	readonly id: string;
	readonly severity: string;
	readonly claim: string;
	readonly requiredAction: string;
}

export interface ReviewRequestInput {
	readonly taskId: string;
	readonly stage: string;
	readonly headSha: string;
	readonly baseSha: string;
	readonly round?: number;
	readonly diffArtifact: ReviewArtifactRef;
	readonly testEvidence?: readonly ReviewTestEvidence[];
	readonly acceptanceCriteria: readonly string[];
	readonly impactSurface: ReviewImpactSurface;
	readonly constraints: ReviewConstraints;
	readonly previousFindings?: readonly ReviewPriorFinding[];
	readonly previousReviewId?: string;
	readonly author: ReviewActor;
	readonly reviewer: ReviewActor;
	readonly reviewerContext: ReviewerContext;
	readonly sensitivity?: {
		readonly security?: boolean;
		readonly data?: boolean;
	};
}

export interface ReviewRequestEnvelope {
	readonly v: 1;
	readonly taskId: string;
	readonly stage: string;
	readonly headSha: string;
	readonly baseSha: string;
	readonly round: number;
	readonly diffArtifact: ReviewArtifactRef;
	readonly testEvidence: readonly ReviewTestEvidence[];
	readonly acceptanceCriteria: readonly string[];
	readonly impactSurface: ReviewImpactSurface;
	readonly constraints: ReviewConstraints;
	readonly previousFindings: readonly ReviewPriorFinding[];
	readonly previousReviewId: string | null;
	readonly policy: {
		readonly risk: ReviewRisk;
		readonly mode: ReviewMode | null;
		readonly blind: true;
		readonly freshContext: boolean;
		readonly sameFamilyException: boolean;
	};
}

export interface BuildReviewRequestResult {
	readonly envelope: ReviewRequestEnvelope;
	readonly decision: ReviewPolicyDecision;
}

const FORBIDDEN_ENVELOPE_KEYS = new Set([
	"authormodel",
	"authormodelfamily",
	"authorsessionid",
	"authorprofileid",
	"authortranscript",
	"authorsummary",
	"provider",
	"persona",
	"chainofthought",
	"transcript",
]);

export function buildReviewRequest(store: ControlStore, input: ReviewRequestInput): BuildReviewRequestResult {
	const taskId = nonEmpty(input.taskId, "taskId");
	if (!store.tasks.get(taskId)) throw new ControlError("not_found", `task ${taskId} not found`);
	const stage = nonEmpty(input.stage, "stage");
	const headSha = validateSha(input.headSha, "headSha");
	const baseSha = validateSha(input.baseSha, "baseSha");
	const round = input.round ?? 1;
	if (!Number.isInteger(round) || round < 1) {
		throw new ControlError("invalid_input", "review round must be a positive integer");
	}
	const previousFindings = resolvePreviousFindings(store, taskId, round, input);
	nonEmpty(input.diffArtifact.artifactId, "diffArtifact.artifactId");
	nonEmpty(input.diffArtifact.mediaType, "diffArtifact.mediaType");
	if (input.acceptanceCriteria.length === 0 || input.acceptanceCriteria.some((item) => item.trim() === "")) {
		throw new ControlError("invalid_input", "acceptance criteria must be a non-empty list");
	}
	if (input.testEvidence?.some((item) => item.ref.trim() === "")) {
		throw new ControlError("invalid_input", "test evidence refs must not be empty");
	}
	const risk = classifyReviewRisk({
		changedFiles: input.impactSurface.changedFiles,
		securitySensitive: input.sensitivity?.security,
		dataSensitive: input.sensitivity?.data,
	});
	assertHeadTraceable(store, headSha, taskId);
	const decision = evaluateReviewPolicy({
		risk,
		author: input.author,
		reviewer: input.reviewer,
		reviewerContext: input.reviewerContext,
	});
	const envelope: ReviewRequestEnvelope = Object.freeze({
		v: 1 as const,
		taskId,
		stage,
		headSha,
		baseSha,
		round,
		diffArtifact: Object.freeze({ ...input.diffArtifact }),
		testEvidence: Object.freeze([...(input.testEvidence ?? [])]),
		acceptanceCriteria: Object.freeze([...input.acceptanceCriteria]),
		impactSurface: Object.freeze({
			changedFiles: Object.freeze([...input.impactSurface.changedFiles]),
			changedSymbols: Object.freeze([...input.impactSurface.changedSymbols]),
			callers: Object.freeze([...input.impactSurface.callers]),
			affectedTests: Object.freeze([...input.impactSurface.affectedTests]),
		}),
		constraints: Object.freeze({
			security: Object.freeze([...input.constraints.security]),
			data: Object.freeze([...input.constraints.data]),
			contract: Object.freeze([...input.constraints.contract]),
			other: Object.freeze([...input.constraints.other]),
		}),
		previousFindings: Object.freeze([...previousFindings]),
		previousReviewId: input.previousReviewId ?? null,
		policy: Object.freeze({
			risk,
			mode: decision.mode,
			blind: true as const,
			freshContext: input.reviewerContext.fresh,
			sameFamilyException: decision.sameFamilyException,
		}),
	});
	assertBlindEnvelope(envelope, input);
	return { envelope, decision };
}

function assertBlindEnvelope(envelope: ReviewRequestEnvelope, input: ReviewRequestInput): void {
	const forbiddenValues = [
		input.author.sessionId,
		input.author.profileId,
		input.author.model,
		input.author.modelFamily,
	].filter((value): value is string => typeof value === "string" && value.trim() !== "");
	const freeText = [
		...envelope.acceptanceCriteria,
		...envelope.testEvidence.flatMap((evidence) => [evidence.ref, evidence.summary ?? ""]),
		...envelope.constraints.security,
		...envelope.constraints.data,
		...envelope.constraints.contract,
		...envelope.constraints.other,
		...envelope.previousFindings.flatMap((finding) => [finding.claim, finding.requiredAction]),
	];
	walkKeys(envelope, "");
	for (const value of forbiddenValues) {
		if (freeText.includes(value)) {
			throw new ControlError("invalid_input", "blind review envelope contains author identity or transcript");
		}
	}
}

function resolvePreviousFindings(
	store: ControlStore,
	taskId: string,
	round: number,
	input: ReviewRequestInput,
): readonly ReviewPriorFinding[] {
	if (round === 1) {
		if ((input.previousFindings?.length ?? 0) > 0 || input.previousReviewId) {
			throw new ControlError("invalid_input", "previous findings are only allowed on a fix round");
		}
		return [];
	}
	if (!input.previousReviewId) {
		throw new ControlError("invalid_input", "a fix round requires previousReviewId");
	}
	const previous = store.reviews.get(input.previousReviewId);
	if (!previous || previous.taskId !== taskId) {
		throw new ControlError("invalid_input", "previousReviewId must reference a review for the same task");
	}
	if (previous.round >= round) {
		throw new ControlError("invalid_input", "previousReviewId must reference an earlier review round");
	}
	if (previous.verdict === "approve") {
		throw new ControlError("invalid_input", "previousReviewId must reference a non-approved review");
	}
	const expected = previous.findings
		.filter((finding) => finding.severity === "P1" || finding.severity === "P2")
		.map((finding) => ({
			id: finding.id,
			severity: finding.severity,
			claim: finding.claim,
			requiredAction: finding.requiredAction,
		}));
	if (input.previousFindings && !sameFindings(input.previousFindings, expected)) {
		throw new ControlError("invalid_input", "previousFindings must match the stored previous review findings");
	}
	return expected;
}

function sameFindings(left: readonly ReviewPriorFinding[], right: readonly ReviewPriorFinding[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((finding, index) => {
		const other = right[index];
		return (
			other !== undefined &&
			finding.id === other.id &&
			finding.severity === other.severity &&
			finding.claim === other.claim &&
			finding.requiredAction === other.requiredAction
		);
	});
}

function walkKeys(value: unknown, path: string): void {
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) walkKeys(item, `${path}[${index}]`);
		return;
	}
	if (value === null || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		if (FORBIDDEN_ENVELOPE_KEYS.has(key.toLowerCase())) {
			throw new ControlError("invalid_input", `blind review envelope contains forbidden key: ${path}.${key}`);
		}
		walkKeys(child, `${path}.${key}`);
	}
}

function nonEmpty(value: string, label: string): string {
	const trimmed = value.trim();
	if (trimmed === "") throw new ControlError("invalid_input", `${label} must not be empty`);
	return trimmed;
}
