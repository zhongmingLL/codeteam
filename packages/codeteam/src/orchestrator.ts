import type { ControlPlane } from "./control-plane.ts";
import type { ReviewFinding, ReviewVerdict } from "./review/types.ts";
import type { Handoff, Task } from "./types.ts";
import type { FindingClosure } from "./verifier/closure.ts";
import { closeFindings } from "./verifier/closure.ts";
import type { FindingVerification } from "./verifier/types.ts";

export type Phase3ErrorCode =
	| "author_self_review"
	| "test_modified"
	| "review_loop"
	| "review_blocked"
	| "verifier_blocked"
	| "unclosed_finding";

export class Phase3Error extends Error {
	readonly code: Phase3ErrorCode;

	constructor(code: Phase3ErrorCode, message: string) {
		super(message);
		this.name = "Phase3Error";
		this.code = code;
	}
}

export interface ImplementRequest {
	taskId: string;
	iteration: number;
	objective: string;
	workdir: string;
	findings: ReviewFinding[];
}

export interface ImplementResult {
	diff: string;
	testReport: string;
	testFileUnchanged: boolean;
	agentInstanceId: string;
}

export interface ReviewRequest {
	taskId: string;
	iteration: number;
	workdir: string;
	diff: string;
	testReport: string;
	authorInstanceId: string;
	authorRunId: string;
	reviewerRunId: string;
	previousFindings: ReviewFinding[];
}

export interface ReviewResult {
	verdict: ReviewVerdict;
	agentInstanceId: string;
}

export interface VerifyRequest {
	taskId: string;
	workdir: string;
	findings: ReviewFinding[];
	revision: "initial" | "final";
}

export interface VerifyResult {
	verifications: FindingVerification[];
}

export interface Phase3Ports {
	implement(request: ImplementRequest): Promise<ImplementResult>;
	review(request: ReviewRequest): Promise<ReviewResult>;
	verify(request: VerifyRequest): Promise<VerifyResult>;
}

export interface Phase3Options {
	taskId: string;
	objective: string;
	initialWorkdir: string;
	workdir: string;
	plane: ControlPlane;
	ports: Phase3Ports;
	maxReviewRounds?: number;
}

export type Phase3Outcome = "awaiting_merge" | "blocked";

export interface Phase3Result {
	outcome: Phase3Outcome;
	task: Task;
	rounds: number;
	findings: ReviewFinding[];
	initialVerifications: FindingVerification[];
	finalVerifications: FindingVerification[];
	closures: FindingClosure[];
	mergeHandoff?: Handoff;
	blockerHandoff?: Handoff;
	authorInstanceId: string;
	reviewerInstanceId: string;
}

const DEFAULT_MAX_REVIEW_ROUNDS = 2;

function isBlocking(finding: ReviewFinding): boolean {
	return finding.severity === "P1" || finding.severity === "P2";
}

function statusFor(verifications: FindingVerification[], index: number): FindingVerification["status"] | undefined {
	return verifications.find((entry) => entry.audit.index === index)?.status;
}

function mergeInitialVerifications(
	existing: FindingVerification[],
	incoming: FindingVerification[],
): FindingVerification[] {
	const byIndex = new Map(existing.map((entry) => [entry.audit.index, entry]));
	for (const entry of incoming) {
		if (!byIndex.has(entry.audit.index)) byIndex.set(entry.audit.index, entry);
	}
	return [...byIndex.values()].sort((left, right) => left.audit.index - right.audit.index);
}

function summarizeVerifications(verifications: FindingVerification[]): Array<{ index: number; status: string }> {
	return verifications.map((entry) => ({ index: entry.audit.index, status: entry.status }));
}

export class Phase3Orchestrator {
	private readonly options: Required<Pick<Phase3Options, "maxReviewRounds">> & Phase3Options;
	private readonly plane: ControlPlane;
	private readonly allFindings: ReviewFinding[] = [];
	private initialVerifications: FindingVerification[] = [];
	private authorInstanceId = "";
	private reviewerInstanceId = "";
	private diff = "";
	private testReport = "";
	private round = 1;
	private lastAuthorRunId = "";

	constructor(options: Phase3Options) {
		this.options = { ...options, maxReviewRounds: options.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS };
		this.plane = options.plane;
	}

	async run(): Promise<Phase3Result> {
		const { taskId } = this.options;
		this.plane.createTask(taskId, "implement");

		const coderRun = this.plane.createRun(`coder-${taskId}-0`, taskId, "coder");
		const implementHandoff = this.plane.createHandoff({
			taskId,
			kind: "handoff",
			fromRole: "human",
			toRole: "coder",
			subject: `implement-${taskId}-0`,
			actionPair: "human->coder:implement",
			expectedArtifact: "working diff and test report",
			payload: { iteration: 0, objective: this.options.objective },
		});
		this.plane.claim(implementHandoff.id, coderRun.id);
		const initial = await this.runPort(coderRun.id, () =>
			this.options.ports.implement({
				taskId,
				iteration: 0,
				objective: this.options.objective,
				workdir: this.options.workdir,
				findings: [],
			}),
		);
		this.plane.complete(implementHandoff.id, coderRun.id, {
			diff: initial.diff,
			testReport: initial.testReport,
			agentInstanceId: initial.agentInstanceId,
		});
		this.requireUnchangedTests(initial);
		this.authorInstanceId = initial.agentInstanceId;
		this.lastAuthorRunId = coderRun.id;
		this.diff = initial.diff;
		this.testReport = initial.testReport;
		this.plane.advanceTask(taskId, "review");

		for (;;) {
			const review = await this.reviewRound();
			if (review.verdict.verdict === "blocked") {
				return this.block("review_blocked", review.verdict.findings);
			}
			this.allFindings.push(...review.verdict.findings);
			const blocking = review.verdict.findings.filter(isBlocking);
			if (blocking.length === 0) {
				this.plane.advanceTask(taskId, "verify");
				break;
			}

			this.plane.advanceTask(taskId, "verify");
			const verificationWorkdir = this.round === 1 ? this.options.initialWorkdir : this.options.workdir;
			const initialVerification = await this.verifyRound(this.allFindings, verificationWorkdir, "initial");
			this.initialVerifications = mergeInitialVerifications(this.initialVerifications, initialVerification);

			const blocked = blocking.filter((finding) => {
				const index = this.allFindings.indexOf(finding);
				return statusFor(initialVerification, index) === "blocked";
			});
			if (blocked.length > 0) return this.block("verifier_blocked", blocked);

			const confirmed = blocking.filter((finding) => {
				const index = this.allFindings.indexOf(finding);
				return statusFor(initialVerification, index) === "confirmed";
			});
			if (confirmed.length === 0) {
				const closures = closeFindings(this.allFindings, this.initialVerifications, initialVerification);
				return this.awaitMerge(closures, initialVerification);
			}
			if (this.round >= this.options.maxReviewRounds) return this.block("review_loop", confirmed);

			this.plane.advanceTask(taskId, "implement");
			await this.fixRound(confirmed);
			this.plane.advanceTask(taskId, "review");
			this.round += 1;
		}

		const finalVerification = await this.verifyRound(this.allFindings, this.options.workdir, "final");
		this.initialVerifications = mergeInitialVerifications(this.initialVerifications, finalVerification);
		const closures = closeFindings(this.allFindings, this.initialVerifications, finalVerification);
		const unresolved = closures.filter(
			(closure) =>
				isBlocking(closure.finding) && (closure.status === "still_confirmed" || closure.status === "blocked"),
		);
		if (unresolved.length > 0) {
			return this.block(
				"unclosed_finding",
				unresolved.map((closure) => closure.finding),
				closures,
				finalVerification,
			);
		}
		return this.awaitMerge(closures, finalVerification);
	}

	private async reviewRound(): Promise<ReviewResult> {
		const { taskId } = this.options;
		const reviewerRun = this.plane.createRun(`reviewer-${taskId}-${this.round}`, taskId, "reviewer");
		const handoff = this.plane.createHandoff({
			taskId,
			kind: "review_request",
			fromRole: "coder",
			toRole: "reviewer",
			subject: `review-${taskId}-${this.round}`,
			actionPair: "coder->reviewer:review",
			expectedArtifact: "typed review verdict",
			payload: {
				iteration: this.round,
				diff: this.diff,
				testReport: this.testReport,
				authorInstanceId: this.authorInstanceId,
				previousFindings: this.allFindings,
			},
		});
		this.plane.claim(handoff.id, reviewerRun.id);
		const review = await this.runPort(reviewerRun.id, () =>
			this.options.ports.review({
				taskId,
				iteration: this.round,
				workdir: this.options.workdir,
				diff: this.diff,
				testReport: this.testReport,
				authorInstanceId: this.authorInstanceId,
				authorRunId: this.lastAuthorRunId,
				reviewerRunId: reviewerRun.id,
				previousFindings: this.allFindings,
			}),
		);
		if (review.agentInstanceId === this.authorInstanceId) {
			this.plane.complete(handoff.id, reviewerRun.id, { error: "author_self_review" });
			this.block("author_self_review", review.verdict.findings);
			throw new Phase3Error(
				"author_self_review",
				`reviewer instance ${review.agentInstanceId} is the author instance; self-review is not allowed`,
			);
		}
		this.reviewerInstanceId = review.agentInstanceId;
		this.plane.complete(handoff.id, reviewerRun.id, { verdict: review.verdict });
		return review;
	}

	private async fixRound(findings: ReviewFinding[]): Promise<void> {
		const { taskId } = this.options;
		const fixRun = this.plane.createRun(`coder-${taskId}-${this.round + 1}`, taskId, "coder");
		const handoff = this.plane.createHandoff({
			taskId,
			kind: "verdict",
			fromRole: "reviewer",
			toRole: "coder",
			subject: `fix-${taskId}-${this.round}`,
			actionPair: "reviewer->coder:fix",
			expectedArtifact: "updated diff and test report",
			payload: { iteration: this.round, findings },
		});
		this.plane.claim(handoff.id, fixRun.id);
		const fix = await this.runPort(fixRun.id, () =>
			this.options.ports.implement({
				taskId,
				iteration: this.round,
				objective: this.options.objective,
				workdir: this.options.workdir,
				findings,
			}),
		);
		this.plane.complete(handoff.id, fixRun.id, {
			diff: fix.diff,
			testReport: fix.testReport,
			agentInstanceId: fix.agentInstanceId,
		});
		this.requireUnchangedTests(fix);
		this.authorInstanceId = fix.agentInstanceId;
		this.lastAuthorRunId = fixRun.id;
		this.diff = fix.diff;
		this.testReport = fix.testReport;
	}

	private async verifyRound(
		findings: ReviewFinding[],
		workdir: string,
		revision: "initial" | "final",
	): Promise<FindingVerification[]> {
		const { taskId } = this.options;
		const verifierRun = this.plane.createRun(`verifier-${taskId}-${this.round}-${revision}`, taskId, "verifier");
		const handoff = this.plane.createHandoff({
			taskId,
			kind: "verdict",
			fromRole: "reviewer",
			toRole: "verifier",
			subject: `verify-${taskId}-${this.round}-${revision}`,
			actionPair: "reviewer->verifier:verify",
			expectedArtifact: "finding verification",
			payload: { revision, findings },
		});
		this.plane.claim(handoff.id, verifierRun.id);
		const result = await this.runPort(verifierRun.id, () =>
			this.options.ports.verify({ taskId, workdir, findings, revision }),
		);
		this.plane.complete(handoff.id, verifierRun.id, { verifications: summarizeVerifications(result.verifications) });
		return result.verifications;
	}

	private requireUnchangedTests(result: ImplementResult): void {
		if (result.testFileUnchanged) return;
		this.block("test_modified", []);
		throw new Phase3Error("test_modified", "the implementation modified a test file");
	}

	private async runPort<T>(runId: string, operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			this.plane.finishRun(runId, "interrupted");
			this.plane.markTaskBlocked(this.options.taskId);
			throw error;
		}
	}

	private awaitMerge(closures: FindingClosure[] = [], finalVerification: FindingVerification[] = []): Phase3Result {
		const { taskId } = this.options;
		const handoff = this.plane.createHandoff({
			taskId,
			kind: "review_request",
			fromRole: "verifier",
			toRole: "human",
			subject: `merge-${taskId}`,
			actionPair: "verifier->human:merge",
			expectedArtifact: "human merge decision",
			payload: {
				diff: this.diff,
				testReport: this.testReport,
				findings: this.allFindings,
				closures,
			},
		});
		return {
			outcome: "awaiting_merge",
			task: this.plane.getTask(taskId),
			rounds: this.round,
			findings: this.allFindings,
			initialVerifications: this.initialVerifications,
			finalVerifications: finalVerification,
			closures,
			mergeHandoff: handoff,
			authorInstanceId: this.authorInstanceId,
			reviewerInstanceId: this.reviewerInstanceId,
		};
	}

	private block(
		code: Phase3ErrorCode,
		findings: ReviewFinding[],
		closures: FindingClosure[] = [],
		finalVerification: FindingVerification[] = [],
	): Phase3Result {
		const { taskId } = this.options;
		this.plane.markTaskBlocked(taskId);
		const handoff = this.plane.createHandoff({
			taskId,
			kind: "blocker",
			fromRole: "verifier",
			toRole: "human",
			subject: `blocker-${taskId}-${code}`,
			actionPair: "verifier->human:blocker",
			expectedArtifact: "human decision",
			payload: { code, findings, closures },
		});
		return {
			outcome: "blocked",
			task: this.plane.getTask(taskId),
			rounds: this.round,
			findings: this.allFindings,
			initialVerifications: this.initialVerifications,
			finalVerifications: finalVerification,
			closures,
			blockerHandoff: handoff,
			authorInstanceId: this.authorInstanceId,
			reviewerInstanceId: this.reviewerInstanceId,
		};
	}
}

export async function runPhase3(options: Phase3Options): Promise<Phase3Result> {
	return new Phase3Orchestrator(options).run();
}
