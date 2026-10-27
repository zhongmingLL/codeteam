import { readFileSync } from "node:fs";
import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { AgentSession, CreateFindingInput, Review, ReviewVerdict, Verification } from "../control/stores/types.ts";
import { runCommand } from "../policy/exec.ts";
import type { SandboxConfig } from "../policy/sandbox.ts";
import type { ToolPolicy } from "../policy/types.ts";
import {
	type BuildReviewRequestResult,
	buildReviewRequest,
	type ReviewArtifactRef,
	type ReviewRequestInput,
} from "./envelope.ts";
import { executeFalsifier, type FalsifierExecutionResult } from "./falsifier.ts";
import { assertWorktreeRelativePath, type FindingDowngrade, normalizeFindings } from "./findings.ts";
import { assertHeadTraceable, assessReviewFreshness, type ReviewFreshness } from "./head.ts";
import type { ReviewActor } from "./policy.ts";

const EXECUTABLE_EVIDENCE_KINDS = new Set(["red_test", "repro_command", "static_check"]);

export interface ReviewServiceOptions {
	readonly store: ControlStore;
	readonly verifierPolicy: ToolPolicy;
	readonly worktreeRoot: string;
	readonly clock?: () => number;
	readonly blockedTtlMs?: number;
	readonly sandbox?: SandboxConfig | boolean;
	readonly headResolver?: (worktreeRoot: string) => Promise<string | null>;
}

export interface RecordReviewInput extends ReviewRequestInput {
	readonly id?: string;
	readonly runId: string;
	readonly verdict: ReviewVerdict;
	readonly findings: readonly CreateFindingInput[];
}

export interface RecordReviewResult {
	readonly review: Review;
	readonly envelope: BuildReviewRequestResult["envelope"];
	readonly decision: BuildReviewRequestResult["decision"];
	readonly downgrades: readonly FindingDowngrade[];
}

export interface VerifyFindingInput {
	readonly findingId: string;
	readonly producingReviewId?: string;
}

export type VerifyFindingDisposition = "verified" | "not_executable" | "not_current";

export interface VerifyFindingResult {
	readonly disposition: VerifyFindingDisposition;
	readonly verification: Verification | null;
	readonly execution: FalsifierExecutionResult | null;
	readonly reason: string;
}

export class ReviewService {
	private readonly store: ControlStore;
	private readonly verifierPolicy: ToolPolicy;
	private readonly worktreeRoot: string;
	private readonly clock: () => number;
	private readonly blockedTtlMs: number | undefined;
	private readonly sandbox: SandboxConfig | boolean;
	private readonly headResolver: ((worktreeRoot: string) => Promise<string | null>) | undefined;

	constructor(options: ReviewServiceOptions) {
		this.store = options.store;
		this.verifierPolicy = options.verifierPolicy;
		this.worktreeRoot = options.worktreeRoot;
		this.clock = options.clock ?? Date.now;
		this.blockedTtlMs = options.blockedTtlMs;
		this.sandbox = options.sandbox ?? true;
		this.headResolver = options.headResolver;
	}

	buildRequest(input: ReviewRequestInput): BuildReviewRequestResult {
		return buildReviewRequest(this.store, this.resolveInput(input));
	}

	recordReview(input: RecordReviewInput): RecordReviewResult {
		const resolved = this.resolveInput(input);
		const run = this.store.runs.get(input.runId);
		if (!run) throw new ControlError("not_found", `run ${input.runId} not found`);
		if (run.taskId !== resolved.taskId) {
			throw new ControlError("invalid_input", `run ${run.id} belongs to task ${run.taskId}`);
		}
		if (run.agentSessionId !== resolved.author.sessionId) {
			throw new ControlError("invalid_input", `run ${run.id} is not bound to the author session`);
		}
		if (run.role !== "coder") throw new ControlError("invalid_input", `run ${run.id} is not a coder run`);

		const diffFiles = this.readDiffChangedFiles(resolved.taskId, resolved.diffArtifact);
		assertImpactSurfaceMatches(resolved.impactSurface.changedFiles, diffFiles);
		const built = buildReviewRequest(this.store, resolved);
		if (built.decision.status !== "allowed") {
			throw new ControlError(
				"forbidden",
				`review policy ${built.decision.status}: ${built.decision.violations.join(", ")}`,
			);
		}
		const normalized = normalizeFindings(input.findings, {
			verifierPolicy: this.verifierPolicy,
			worktreeRoot: this.worktreeRoot,
		});
		if (
			input.verdict === "approve" &&
			normalized.findings.some((finding) => finding.severity === "P1" || finding.severity === "P2")
		) {
			throw new ControlError("invalid_input", "an approve verdict cannot carry open P1/P2 findings");
		}
		const risk = built.envelope.policy.risk;
		const review = this.store.reviews.create({
			id: input.id,
			taskId: resolved.taskId,
			runId: run.id,
			headSha: resolved.headSha,
			baseSha: resolved.baseSha,
			authorSessionId: resolved.author.sessionId,
			authorModel: resolved.author.model,
			authorModelFamily: resolved.author.modelFamily,
			reviewerSessionId: resolved.reviewer.sessionId,
			reviewerModel: resolved.reviewer.model,
			reviewerModelFamily: resolved.reviewer.modelFamily,
			authorProfileId: resolved.author.profileId,
			reviewerProfileId: resolved.reviewer.profileId,
			riskClass: risk,
			reviewMode: built.decision.mode!,
			verdict: input.verdict,
			findings: [...normalized.findings],
			round: resolved.round ?? 1,
			stage: resolved.stage,
			previousReviewId: resolved.previousReviewId ?? null,
			envelope: built.envelope,
			decision: {
				status: built.decision.status,
				mode: built.decision.mode,
				violations: built.decision.violations,
				sameFamilyException: built.decision.sameFamilyException,
				requiresHumanGate: built.decision.requiresHumanGate,
				requiresVerifier: built.decision.requiresVerifier,
				risk,
			},
			policy: {
				...built.decision.policy,
				risk,
				mode: built.decision.mode,
				sameFamilyException: built.decision.sameFamilyException,
				reviewerContext: resolved.reviewerContext,
			},
		});
		if (normalized.downgrades.length > 0) {
			this.store.audit.append({
				actor: `review:${review.id}`,
				action: "review_findings_downgraded",
				subject: `review:${review.id}`,
				args: { downgrades: normalized.downgrades },
			});
		}
		return { review, envelope: built.envelope, decision: built.decision, downgrades: normalized.downgrades };
	}

	async verifyFinding(input: VerifyFindingInput): Promise<VerifyFindingResult> {
		const finding = this.store.reviews.getFinding(input.findingId);
		if (!finding) throw new ControlError("not_found", `finding ${input.findingId} not found`);
		const review = this.store.reviews.getReviewForFinding(input.findingId);
		if (!review) throw new ControlError("not_found", `review for finding ${input.findingId} not found`);
		if (input.producingReviewId && input.producingReviewId !== review.id) {
			throw new ControlError("invalid_input", `finding ${finding.id} belongs to review ${review.id}`);
		}
		assertHeadTraceable(this.store, review.headSha, review.taskId);
		if (!isExecutableFinding(finding)) {
			return {
				disposition: "not_executable",
				verification: null,
				execution: null,
				reason: "finding is not an open P1/P2 with executable evidence and falsifier",
			};
		}
		const currentHead = await this.resolveCurrentHead();
		if (currentHead !== review.headSha) {
			return {
				disposition: "not_current",
				verification: null,
				execution: null,
				reason: `worktree head ${currentHead ?? "unknown"} does not match review head ${review.headSha}`,
			};
		}
		let execution: FalsifierExecutionResult;
		try {
			execution = await executeFalsifier({
				finding,
				reviewId: review.id,
				policy: this.verifierPolicy,
				audit: {
					store: this.store,
					actorRef: `review:${review.id}`,
					producingReviewId: review.id,
					taskId: review.taskId,
				},
				now: this.clock,
				blockedTtlMs: this.blockedTtlMs,
				sandbox: this.sandbox,
			});
		} catch (error) {
			if (error instanceof ControlError && (error.code === "forbidden" || error.code === "invalid_input")) {
				return {
					disposition: "not_executable",
					verification: null,
					execution: null,
					reason: error.message,
				};
			}
			throw error;
		}
		const verification = this.store.reviews.verify({
			findingId: finding.id,
			headSha: review.headSha,
			producingReviewId: review.id,
			status: execution.status,
			reason: execution.reason,
			command: execution.command,
			cwd: execution.cwd,
			exitCode: execution.exitCode,
			durationMs: execution.durationMs,
			stdoutTail: execution.stdoutTail,
			stderrTail: execution.stderrTail,
			blockedExpiresAt: execution.blockedExpiresAt,
		});
		return { disposition: "verified", verification, execution, reason: execution.reason };
	}

	assessFreshness(reviewId: string, currentHeadSha: string, currentBaseSha: string | null): ReviewFreshness {
		const review = this.store.reviews.get(reviewId);
		if (!review) throw new ControlError("not_found", `review ${reviewId} not found`);
		const verificationHeadShas = review.findings.flatMap((finding) =>
			this.store.reviews.listVerifications(finding.id).map((verification) => verification.headSha),
		);
		return assessReviewFreshness({ review, currentHeadSha, currentBaseSha, verificationHeadShas });
	}

	private readDiffChangedFiles(taskId: string, ref: ReviewArtifactRef): string[] {
		const artifact = this.store.artifacts.get(ref.artifactId);
		if (!artifact) throw new ControlError("not_found", `diff artifact ${ref.artifactId} not found`);
		if (artifact.taskId !== taskId) {
			throw new ControlError("invalid_input", `diff artifact ${ref.artifactId} belongs to another task`);
		}
		if (!artifact.mediaType.toLowerCase().includes("diff")) {
			throw new ControlError("invalid_input", `artifact ${ref.artifactId} is not a diff`);
		}
		let diff: string;
		try {
			diff = readFileSync(artifact.path, "utf8");
		} catch (error) {
			throw new ControlError("not_found", `diff artifact ${ref.artifactId} is not readable`, { cause: error });
		}
		const files = parseDiffChangedFiles(diff);
		if (files.length === 0) throw new ControlError("invalid_input", "diff artifact contains no changed files");
		return files;
	}

	private async resolveCurrentHead(): Promise<string | null> {
		if (this.headResolver) return this.headResolver(this.worktreeRoot);
		const result = await runCommand(
			this.verifierPolicy,
			{ argv: ["git", "rev-parse", "HEAD"], cwd: this.verifierPolicy.cwd },
			{ sandbox: false },
		);
		if (result.exitCode !== 0) return null;
		const sha = result.stdout.trim();
		return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha) ? sha : null;
	}

	private resolveInput(input: ReviewRequestInput): ReviewRequestInput {
		const authorSession = this.store.sessions.get(input.author.sessionId);
		if (!authorSession) throw new ControlError("not_found", `author session ${input.author.sessionId} not found`);
		const reviewerSession = this.store.sessions.get(input.reviewer.sessionId);
		if (!reviewerSession) {
			throw new ControlError("not_found", `reviewer session ${input.reviewer.sessionId} not found`);
		}
		if (authorSession.role !== "coder") {
			throw new ControlError("invalid_input", `author session ${authorSession.id} is not a coder session`);
		}
		if (authorSession.taskId !== input.taskId || reviewerSession.taskId !== input.taskId) {
			throw new ControlError("invalid_input", "author and reviewer sessions must be bound to the review task");
		}
		assertActorMatchesSession(input.author, authorSession, "author");
		assertActorMatchesSession(input.reviewer, reviewerSession, "reviewer");
		return {
			...input,
			author: actorFromSession(authorSession),
			reviewer: actorFromSession(reviewerSession),
		};
	}
}

function isExecutableFinding(finding: Review["findings"][number]): boolean {
	return (
		(finding.severity === "P1" || finding.severity === "P2") &&
		EXECUTABLE_EVIDENCE_KINDS.has(finding.evidenceKind) &&
		finding.falsifier.trim() !== ""
	);
}

function parseDiffChangedFiles(diff: string): string[] {
	const files = new Set<string>();
	const gitLine = /^diff --git a\/(.+?) b\/(.+)$/;
	const plusLine = /^\+\+\+ b\/(.+)$/;
	for (const line of diff.split(/\r?\n/)) {
		const gitMatch = gitLine.exec(line);
		if (gitMatch) {
			addDiffPath(files, gitMatch[2]!);
			continue;
		}
		const plusMatch = plusLine.exec(line);
		if (plusMatch) addDiffPath(files, plusMatch[1]!);
	}
	return [...files];
}

function addDiffPath(files: Set<string>, path: string): void {
	assertWorktreeRelativePath(path, "diff path");
	files.add(path);
}

function assertImpactSurfaceMatches(impactFiles: readonly string[], diffFiles: readonly string[]): void {
	const impact = [...new Set(impactFiles)].sort();
	const actual = [...new Set(diffFiles)].sort();
	if (impact.length !== actual.length || impact.some((file, index) => file !== actual[index])) {
		throw new ControlError("invalid_input", "impactSurface.changedFiles must match the diff artifact changed files");
	}
}

function actorFromSession(session: AgentSession): ReviewActor {
	return {
		sessionId: session.id,
		profileId: session.profileId,
		model: session.model,
		modelFamily: session.modelFamily,
	};
}

function assertActorMatchesSession(actor: ReviewActor, session: AgentSession, label: string): void {
	if (
		actor.profileId !== session.profileId ||
		actor.model !== session.model ||
		actor.modelFamily !== session.modelFamily
	) {
		throw new ControlError("invalid_input", `${label} actor does not match session ${session.id}`);
	}
}
