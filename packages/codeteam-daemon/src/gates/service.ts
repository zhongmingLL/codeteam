import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import { evaluateCompletionGate } from "./completion.ts";
import { type DesignGateInput, evaluateDesignGate } from "./design.ts";
import { diffNumstat, inspectWorktree, runGit } from "./git.ts";
import { evaluateReviewGate } from "./review.ts";
import { classifyRisk } from "./risk.ts";
import { evaluateRiskConsistency } from "./risk-consistency.ts";
import type { DiffFileStat } from "./types.ts";
import { type GateResult, gateCodes, gateResult, type RiskClassification } from "./types.ts";
import { evaluateVerifyGate } from "./verify.ts";
import { evaluateWorktreeGate, type WorktreeGateOptions } from "./worktree.ts";

export interface ReviewGateRequest {
	readonly taskId: string;
	readonly headSha: string;
	readonly baseSha: string | null;
}

export interface MergeGateRequest {
	readonly taskId: string;
	readonly repoPath: string;
	readonly worktreePath: string;
	readonly baseRef: string;
	readonly headSha: string;
	readonly prRef?: string | null;
	readonly declaredLane?: RiskClassification["lane"];
	readonly declaredAssurance?: RiskClassification["assurance"];
	readonly declaredAxes?: RiskClassification["axes"];
	readonly hardGate?: boolean;
	readonly approvalId?: string | null;
	readonly allowUnsyncedBase?: boolean;
	readonly allowPrimaryWorktree?: boolean;
}

export interface MergeGateEvaluation {
	readonly result: GateResult;
	readonly reviewRef: string | null;
	readonly risk: RiskClassification;
	readonly baseSha: string;
	readonly headSha: string;
	readonly hardGateRequired: boolean;
}

export interface GateTelemetry {
	readonly since: number;
	readonly total: number;
	readonly gates: Array<{
		gate: string;
		total: number;
		passed: number;
		blocked: number;
		advisory: number;
		passRate: number;
		blockCodes: Array<{ code: string; count: number }>;
		pruningCandidate: boolean;
	}>;
}

export class GateService {
	readonly store: ControlStore;

	constructor(store: ControlStore) {
		this.store = store;
	}

	review(request: ReviewGateRequest): GateResult {
		const task = this.store.tasks.get(request.taskId);
		if (!task) throw new ControlError("not_found", `task ${request.taskId} not found`);
		const reviews = this.store.reviews.listByTask(request.taskId);
		return evaluateReviewGate({
			taskId: request.taskId,
			taskOwnerProfileId: task.ownerProfileId,
			headSha: request.headSha,
			baseSha: request.baseSha,
			reviews,
			verifications: (findingId) => this.store.reviews.listVerifications(findingId),
		});
	}

	verify(request: ReviewGateRequest): GateResult {
		const task = this.store.tasks.get(request.taskId);
		if (!task) throw new ControlError("not_found", `task ${request.taskId} not found`);
		return evaluateVerifyGate({
			taskId: request.taskId,
			headSha: request.headSha,
			baseSha: request.baseSha,
			reviews: this.store.reviews.listByTask(request.taskId),
			verifications: (findingId) => this.store.reviews.listVerifications(findingId),
		});
	}

	worktree(repoPath: string, worktreePath: string, baseRef: string, options: WorktreeGateOptions = {}): GateResult {
		return evaluateWorktreeGate(inspectWorktree(repoPath, worktreePath, baseRef), options);
	}

	risk(
		repoPath: string,
		baseRef: string,
		headRef: string,
		declared: {
			lane?: RiskClassification["lane"];
			assurance?: RiskClassification["assurance"];
			axes?: RiskClassification["axes"];
		} = {},
	): {
		result: GateResult;
		risk: RiskClassification;
		files: readonly DiffFileStat[];
		baseSha: string;
		headSha: string;
	} {
		const diff = diffNumstat(repoPath, baseRef, headRef);
		const risk = classifyRisk({
			changedFiles: diff.files,
			declaredLane: declared.lane,
			declaredAssurance: declared.assurance,
			declaredAxes: declared.axes,
		});
		return {
			result: evaluateRiskConsistency(risk),
			risk,
			files: diff.files,
			baseSha: diff.baseSha,
			headSha: diff.headSha,
		};
	}

	design(input: DesignGateInput): GateResult {
		return evaluateDesignGate(input);
	}

	completion(backlogItemId: string, actor: string, acceptanceRef?: string | null): GateResult {
		const backlog = this.store.backlog.get(backlogItemId);
		if (!backlog) throw new ControlError("not_found", `backlog item ${backlogItemId} not found`);
		return evaluateCompletionGate({
			backlogStatus: backlog.status,
			actor,
			merge: this.store.merges.latestSucceededByBacklog(backlogItemId),
			visionEvidence: this.store.sopEvidence.latest(backlogItemId, "visionGuardDone"),
			acceptanceRef,
		});
	}

	merge(request: MergeGateRequest): MergeGateEvaluation {
		const task = this.store.tasks.get(request.taskId);
		if (!task) throw new ControlError("not_found", `task ${request.taskId} not found`);
		const diff = diffNumstat(request.repoPath, request.baseRef, request.headSha);
		const headSha = diff.headSha;
		const risk = classifyRisk({
			changedFiles: diff.files,
			declaredLane: request.declaredLane,
			declaredAssurance: request.declaredAssurance,
			declaredAxes: request.declaredAxes,
		});
		const worktree = evaluateWorktreeGate(inspectWorktree(request.repoPath, request.worktreePath, request.baseRef), {
			phase: "merge",
			allowUnsyncedBase: request.allowUnsyncedBase,
			allowPrimaryWorktree: request.allowPrimaryWorktree,
		});
		const reviews = this.store.reviews.listByTask(request.taskId);
		const review = evaluateReviewGate({
			taskId: request.taskId,
			taskOwnerProfileId: task.ownerProfileId,
			headSha,
			baseSha: diff.baseSha,
			reviews,
			verifications: (findingId) => this.store.reviews.listVerifications(findingId),
		});
		const verify = evaluateVerifyGate({
			taskId: request.taskId,
			headSha,
			baseSha: diff.baseSha,
			reviews,
			verifications: (findingId) => this.store.reviews.listVerifications(findingId),
		});
		const riskGate = evaluateRiskConsistency(risk);
		const currentReviews = reviews.filter((review) => review.headSha === headSha && review.baseSha === diff.baseSha);
		const approvingReview = currentReviews.find((review) => review.verdict === "approve") ?? null;
		const hardGateRequired =
			request.hardGate === true ||
			risk.assurance === "critical" ||
			currentReviews.some((review) => review.decision.requiresHumanGate === true);
		const fastLane = risk.lane === "docs" || risk.lane === "product_fast";
		const reviewResult =
			fastLane && review.findings.every((finding) => finding.code === "missing_current_review")
				? gateResult(
						"review",
						[
							{
								code: "review_optional_for_fast_lane",
								severity: "P3",
								message: `independent review is optional for ${risk.lane} lane under the product/docs fast lane`,
							},
						],
						[],
						`${risk.lane} lane: review optional`,
					)
				: review;
		const verifyResult = risk.lane === "docs" ? gateResult("verify", [], [], "docs lane: verify optional") : verify;
		const subResults = [worktree, reviewResult, verifyResult, riskGate];
		const findings = subResults.flatMap((result) => result.findings);
		const evidenceRefs = subResults.flatMap((result) => result.evidenceRefs);
		if (!fastLane && !approvingReview) {
			findings.push({
				code: "merge_review_ref_missing",
				severity: "P1",
				message: "merge receipt requires an approving review at the exact HEAD",
			});
		}
		if (runGit(["merge-base", "--is-ancestor", diff.baseSha, headSha], request.repoPath).status !== 0) {
			findings.push({
				code: "merge_head_not_based_on_base",
				severity: "P1",
				message: "candidate head is not a descendant of the gate base",
			});
		}
		if (hardGateRequired) {
			const approval = request.approvalId ? this.store.approvals.get(request.approvalId) : null;
			const accepted =
				approval?.resolution === "accepted" && approval.kind === "merge" && approval.taskId === request.taskId;
			if (!accepted) {
				findings.push({
					code: "merge_hard_gate_approval_required",
					severity: "P1",
					message: "hard-gate merge requires an accepted merge approval",
				});
			} else if (approval) {
				const payloadHead = typeof approval.payload.headSha === "string" ? approval.payload.headSha : null;
				const payloadPr = typeof approval.payload.prRef === "string" ? approval.payload.prRef : null;
				if (payloadHead && payloadHead !== headSha) {
					findings.push({
						code: "merge_approval_head_mismatch",
						severity: "P1",
						message: "merge approval does not cover the exact HEAD",
						evidenceRef: `approval:${approval.id}`,
					});
				}
				if (payloadPr && request.prRef && payloadPr !== request.prRef) {
					findings.push({
						code: "merge_approval_pr_mismatch",
						severity: "P1",
						message: "merge approval does not cover the requested PR",
						evidenceRef: `approval:${approval.id}`,
					});
				}
				evidenceRefs.push(`approval:${approval.id}`);
			}
		}
		for (const result of subResults) evidenceRefs.push(...result.evidenceRefs);
		const result = gateResult("merge", findings, [...new Set(evidenceRefs)], `merge gate for ${request.taskId}`);
		return {
			result,
			reviewRef: approvingReview?.id ?? null,
			risk,
			baseSha: diff.baseSha,
			headSha,
			hardGateRequired,
		};
	}

	record(result: GateResult, subjectRef: string): string {
		const audit = this.store.audit.append({
			actor: "system:gate",
			action: "gate_evaluated",
			subject: `gate:${result.gate}`,
			args: { gate: result.gate, status: result.status, subjectRef, codes: gateCodes(result) },
		});
		return audit.id;
	}

	telemetry(sinceDays = 30): GateTelemetry {
		const since = Date.now() - Math.max(sinceDays, 1) * 24 * 60 * 60 * 1000;
		const rows = this.store.database
			.prepare("SELECT args_json, ts FROM audit WHERE action = 'gate_evaluated' AND ts >= ?")
			.all(since) as Array<{ args_json: string; ts: number }>;
		const byGate = new Map<
			string,
			{ total: number; passed: number; blocked: number; advisory: number; codes: Map<string, number> }
		>();
		for (const row of rows) {
			let args: Record<string, unknown>;
			try {
				args = JSON.parse(row.args_json) as Record<string, unknown>;
			} catch {
				continue;
			}
			const gate = typeof args.gate === "string" ? args.gate : "unknown";
			const status = typeof args.status === "string" ? args.status : "unknown";
			const entry = byGate.get(gate) ?? { total: 0, passed: 0, blocked: 0, advisory: 0, codes: new Map() };
			entry.total += 1;
			if (status === "pass") entry.passed += 1;
			else if (status === "block") entry.blocked += 1;
			else if (status === "advisory") entry.advisory += 1;
			if (Array.isArray(args.codes)) {
				for (const code of args.codes) {
					if (typeof code !== "string") continue;
					entry.codes.set(code, (entry.codes.get(code) ?? 0) + 1);
				}
			}
			byGate.set(gate, entry);
		}
		const gates = [...byGate.entries()].map(([gate, entry]) => ({
			gate,
			total: entry.total,
			passed: entry.passed,
			blocked: entry.blocked,
			advisory: entry.advisory,
			passRate: entry.total === 0 ? 0 : entry.passed / entry.total,
			blockCodes: [...entry.codes.entries()]
				.map(([code, count]) => ({ code, count }))
				.sort((left, right) => right.count - left.count),
			pruningCandidate: entry.total >= 20 && entry.passed / entry.total >= 0.95 && entry.blocked === 0,
		}));
		return { since, total: rows.length, gates };
	}
}
