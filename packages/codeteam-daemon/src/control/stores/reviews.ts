import type { DatabaseSync } from "node:sqlite";
import { assertHeadTraceable } from "../../review/head.ts";
import { assertModelFamilyClaim } from "../../review/model-family.ts";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import type { AuditStore } from "./audit.ts";
import { type Clock, jsonObject, mapStoreError, newId, nonEmpty, parseJsonObject } from "./helpers.ts";
import type {
	CreateReviewInput,
	CreateVerificationInput,
	Finding,
	Review,
	ReviewMode,
	ReviewRisk,
	ReviewVerdict,
	Verification,
	VerificationStatus,
} from "./types.ts";

interface ReviewRow {
	id: string;
	task_id: string;
	run_id: string;
	head_sha: string;
	base_sha: string | null;
	author_session_id: string;
	author_model: string;
	author_model_family: string;
	reviewer_session_id: string;
	reviewer_model: string;
	reviewer_model_family: string;
	author_profile_id: string | null;
	reviewer_profile_id: string | null;
	risk_class: ReviewRisk;
	review_mode: ReviewMode;
	verdict: ReviewVerdict;
	round: number;
	stage: string;
	previous_review_id: string | null;
	envelope_json: string;
	decision_json: string;
	policy_json: string;
	findings_json: string;
	created_at: number;
}

interface FindingRow {
	id: string;
	review_id: string;
	finding_index: number;
	severity: Finding["severity"];
	file: string | null;
	line: number | null;
	claim: string;
	evidence_kind: Finding["evidenceKind"];
	falsifier: string;
	falsifier_expected: Finding["falsifierExpected"];
	required_action: string;
}

interface VerificationRow {
	id: string;
	finding_id: string;
	head_sha: string;
	producing_review_id: string;
	status: VerificationStatus;
	reason: string;
	command: string | null;
	cwd: string | null;
	exit_code: number | null;
	duration_ms: number | null;
	stdout_tail: string | null;
	stderr_tail: string | null;
	blocked_expires_at: number | null;
	created_at: number;
}

interface SessionIdentityRow {
	profile_id: string;
	role: string;
	task_id: string | null;
	model: string;
	model_family: string;
}

function mapFinding(row: FindingRow): Finding {
	return {
		id: row.id,
		reviewId: row.review_id,
		findingIndex: row.finding_index,
		severity: row.severity,
		file: row.file,
		line: row.line,
		claim: row.claim,
		evidenceKind: row.evidence_kind,
		falsifier: row.falsifier,
		falsifierExpected: row.falsifier_expected,
		requiredAction: row.required_action,
	};
}

function mapVerification(row: VerificationRow): Verification {
	return {
		id: row.id,
		findingId: row.finding_id,
		headSha: row.head_sha,
		producingReviewId: row.producing_review_id,
		status: row.status,
		reason: row.reason,
		command: row.command,
		cwd: row.cwd,
		exitCode: row.exit_code,
		durationMs: row.duration_ms,
		stdoutTail: row.stdout_tail,
		stderrTail: row.stderr_tail,
		blockedExpiresAt: row.blocked_expires_at,
		createdAt: row.created_at,
	};
}

function validateHeadSha(value: string): string {
	const sha = nonEmpty(value, "headSha");
	if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) {
		throw new ControlError("invalid_input", "headSha must be 40 or 64 lowercase hex characters");
	}
	return sha;
}

function isReviewRisk(value: string): value is ReviewRisk {
	return value === "low_risk_docs" || value === "code" || value === "high_risk";
}

function assertSessionIdentity(
	row: SessionIdentityRow,
	profileId: string,
	model: string,
	modelFamily: string,
	label: string,
): void {
	if (row.profile_id !== profileId) {
		throw new ControlError("invalid_input", `${label} profile does not match session ${profileId}`);
	}
	if (row.model !== model || row.model_family !== modelFamily) {
		throw new ControlError("invalid_input", `${label} model/family does not match the session record`);
	}
	assertModelFamilyClaim(row.model, row.model_family);
}

export class ReviewStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;
	private readonly audit: AuditStore;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock, audit: AuditStore) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
		this.audit = audit;
	}

	get(id: string): Review | null {
		const row = this.database.prepare("SELECT * FROM reviews WHERE id = ?").get(id) as ReviewRow | undefined;
		if (!row) return null;
		return { ...this.mapReview(row), findings: this.getFindings(id) };
	}

	listByTask(taskId: string): Review[] {
		const rows = this.database
			.prepare("SELECT * FROM reviews WHERE task_id = ? ORDER BY created_at, id")
			.all(taskId) as unknown as ReviewRow[];
		return rows.map((row) => ({ ...this.mapReview(row), findings: this.getFindings(row.id) }));
	}

	getFindings(reviewId: string): Finding[] {
		const rows = this.database
			.prepare("SELECT * FROM findings WHERE review_id = ? ORDER BY finding_index")
			.all(reviewId) as unknown as FindingRow[];
		return rows.map(mapFinding);
	}

	getFinding(id: string): Finding | null {
		const row = this.database.prepare("SELECT * FROM findings WHERE id = ?").get(id) as FindingRow | undefined;
		return row ? mapFinding(row) : null;
	}

	getReviewForFinding(id: string): Review | null {
		const row = this.database
			.prepare(
				"SELECT reviews.* FROM reviews JOIN findings ON findings.review_id = reviews.id WHERE findings.id = ?",
			)
			.get(id) as ReviewRow | undefined;
		if (!row) return null;
		return { ...this.mapReview(row), findings: this.getFindings(row.id) };
	}

	isCurrent(
		review: Pick<Review, "headSha" | "baseSha">,
		currentHeadSha: string,
		currentBaseSha?: string | null,
	): boolean {
		if (review.headSha !== currentHeadSha) return false;
		if (currentBaseSha === undefined || currentBaseSha === null) return false;
		return review.baseSha !== null && review.baseSha === currentBaseSha;
	}

	listCurrentByTask(taskId: string, currentHeadSha: string, currentBaseSha?: string | null): Review[] {
		return this.listByTask(taskId).filter((review) => this.isCurrent(review, currentHeadSha, currentBaseSha));
	}

	create(input: CreateReviewInput): Review {
		const headSha = validateHeadSha(input.headSha);
		const baseSha = validateHeadSha(nonEmpty(input.baseSha, "baseSha"));
		const taskId = nonEmpty(input.taskId, "taskId");
		const runId = nonEmpty(input.runId, "runId");
		const authorSessionId = nonEmpty(input.authorSessionId, "authorSessionId");
		const reviewerSessionId = nonEmpty(input.reviewerSessionId, "reviewerSessionId");
		const authorProfileId = nonEmpty(input.authorProfileId, "authorProfileId");
		const reviewerProfileId = nonEmpty(input.reviewerProfileId, "reviewerProfileId");
		if (authorSessionId === reviewerSessionId) {
			throw new ControlError("invalid_input", "reviewer session must differ from author session");
		}
		if (authorProfileId === reviewerProfileId) {
			throw new ControlError("invalid_input", "reviewer profile must differ from author profile");
		}
		const riskClass = input.riskClass;
		if (!riskClass || !isReviewRisk(riskClass)) {
			throw new ControlError("invalid_input", "review risk class is required");
		}
		const round = input.round ?? 1;
		if (!Number.isInteger(round) || round < 1) {
			throw new ControlError("invalid_input", "review round must be a positive integer");
		}
		const stage = nonEmpty(input.stage ?? "review", "stage");
		const previousReviewId = input.previousReviewId ?? null;
		const envelopeJson = jsonObject(input.envelope ?? {}, "envelope");
		const decisionJson = jsonObject(input.decision ?? {}, "decision");
		const policyJson = jsonObject(input.policy ?? {}, "policy");
		const id = input.id ?? newId();
		const createdAt = input.createdAt ?? this.clock();
		const findings: Finding[] = input.findings.map((finding, index) => ({
			id: newId(),
			reviewId: id,
			findingIndex: index,
			severity:
				(finding.severity === "P1" || finding.severity === "P2") && finding.falsifier.trim() === ""
					? "P3"
					: finding.severity,
			file: finding.file ?? null,
			line: finding.line ?? null,
			claim: nonEmpty(finding.claim, "claim"),
			evidenceKind: finding.evidenceKind,
			falsifier: finding.falsifier,
			falsifierExpected: finding.falsifierExpected ?? null,
			requiredAction: nonEmpty(finding.requiredAction, "requiredAction"),
		}));
		try {
			return this.transaction.run(() => {
				const authorSession = this.readSessionIdentity(authorSessionId, "author", taskId, "coder");
				const reviewerSession = this.readSessionIdentity(reviewerSessionId, "reviewer", taskId);
				assertSessionIdentity(authorSession, authorProfileId, input.authorModel, input.authorModelFamily, "author");
				assertSessionIdentity(
					reviewerSession,
					reviewerProfileId,
					input.reviewerModel,
					input.reviewerModelFamily,
					"reviewer",
				);
				const sameFamily = authorSession.model_family === reviewerSession.model_family;
				if (riskClass === "low_risk_docs") {
					const expectedMode = sameFamily ? "same_family_fresh" : "cross_family";
					if (input.reviewMode !== expectedMode) {
						throw new ControlError(
							"invalid_input",
							`low-risk docs review must use ${expectedMode} for the recorded model families`,
						);
					}
				} else {
					if (sameFamily) {
						throw new ControlError("invalid_input", `${riskClass} review requires different model families`);
					}
					if (input.reviewMode !== "cross_family") {
						throw new ControlError("invalid_input", `${riskClass} review must use cross_family mode`);
					}
				}
				if (previousReviewId) {
					const previous = this.database
						.prepare("SELECT task_id FROM reviews WHERE id = ?")
						.get(previousReviewId) as { task_id: string } | undefined;
					if (!previous) throw new ControlError("not_found", `previous review ${previousReviewId} not found`);
					if (previous.task_id !== taskId) {
						throw new ControlError(
							"invalid_input",
							`previous review ${previousReviewId} belongs to another task`,
						);
					}
				}
				assertHeadTraceable({ audit: this.audit }, headSha, taskId);
				this.database
					.prepare(
						"INSERT INTO reviews (id, task_id, run_id, head_sha, base_sha, author_session_id, author_model, author_model_family, reviewer_session_id, reviewer_model, reviewer_model_family, author_profile_id, reviewer_profile_id, risk_class, review_mode, verdict, round, stage, previous_review_id, envelope_json, decision_json, policy_json, findings_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						id,
						taskId,
						runId,
						headSha,
						baseSha,
						authorSessionId,
						nonEmpty(input.authorModel, "authorModel"),
						nonEmpty(input.authorModelFamily, "authorModelFamily"),
						reviewerSessionId,
						nonEmpty(input.reviewerModel, "reviewerModel"),
						nonEmpty(input.reviewerModelFamily, "reviewerModelFamily"),
						authorProfileId,
						reviewerProfileId,
						riskClass,
						input.reviewMode,
						input.verdict,
						round,
						stage,
						previousReviewId,
						envelopeJson,
						decisionJson,
						policyJson,
						JSON.stringify(findings),
						createdAt,
					);
				for (const finding of findings) {
					this.database
						.prepare(
							"INSERT INTO findings (id, review_id, finding_index, severity, file, line, claim, evidence_kind, falsifier, falsifier_expected, required_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
						)
						.run(
							finding.id,
							id,
							finding.findingIndex,
							finding.severity,
							finding.file,
							finding.line,
							finding.claim,
							finding.evidenceKind,
							finding.falsifier,
							finding.falsifierExpected,
							finding.requiredAction,
						);
				}
				this.audit.append({
					actor: `profile:${reviewerSessionId}`,
					action: "review_recorded",
					subject: `review:${id}`,
					args: {
						taskId,
						headSha,
						baseSha,
						verdict: input.verdict,
						findings: findings.length,
						reviewMode: input.reviewMode,
						riskClass,
						authorProfileId,
						reviewerProfileId,
						round,
						stage,
						previousReviewId,
					},
				});
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}

	private readSessionIdentity(
		sessionId: string,
		label: string,
		taskId: string,
		expectedRole?: string,
	): SessionIdentityRow {
		const row = this.database
			.prepare("SELECT profile_id, role, task_id, model, model_family FROM agent_sessions WHERE id = ?")
			.get(sessionId) as SessionIdentityRow | undefined;
		if (!row) throw new ControlError("not_found", `${label} session ${sessionId} not found`);
		if (expectedRole && row.role !== expectedRole) {
			throw new ControlError("invalid_input", `${label} session ${sessionId} is not a ${expectedRole} session`);
		}
		if (row.task_id !== taskId) {
			throw new ControlError("invalid_input", `${label} session ${sessionId} is not bound to task ${taskId}`);
		}
		return row;
	}

	verify(input: CreateVerificationInput): Verification {
		const headSha = validateHeadSha(input.headSha);
		const id = newId();
		const createdAt = this.clock();
		try {
			return this.transaction.run(() => {
				const findingRow = this.database
					.prepare("SELECT review_id FROM findings WHERE id = ?")
					.get(input.findingId) as { review_id: string } | undefined;
				if (!findingRow) {
					throw new ControlError("not_found", `finding ${input.findingId} not found`);
				}
				if (findingRow.review_id !== input.producingReviewId) {
					throw new ControlError(
						"invalid_input",
						`finding ${input.findingId} belongs to review ${findingRow.review_id}`,
					);
				}
				const reviewRow = this.database
					.prepare("SELECT head_sha FROM reviews WHERE id = ?")
					.get(input.producingReviewId) as { head_sha: string } | undefined;
				if (!reviewRow) {
					throw new ControlError("not_found", `review ${input.producingReviewId} not found`);
				}
				if (reviewRow.head_sha !== headSha) {
					throw new ControlError(
						"invalid_input",
						`verification headSha ${headSha} does not match review head ${reviewRow.head_sha}`,
					);
				}
				this.database
					.prepare(
						"INSERT INTO verifications (id, finding_id, head_sha, producing_review_id, status, reason, command, cwd, exit_code, duration_ms, stdout_tail, stderr_tail, blocked_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						id,
						input.findingId,
						headSha,
						input.producingReviewId,
						input.status,
						nonEmpty(input.reason, "reason"),
						input.command ?? null,
						input.cwd ?? null,
						input.exitCode ?? null,
						input.durationMs ?? null,
						input.stdoutTail ?? null,
						input.stderrTail ?? null,
						input.blockedExpiresAt ?? null,
						createdAt,
					);
				this.audit.append({
					actor: `review:${input.producingReviewId}`,
					action: "finding_verified",
					subject: `finding:${input.findingId}`,
					args: {
						status: input.status,
						headSha,
						producingReviewId: input.producingReviewId,
						command: input.command ?? null,
						exitCode: input.exitCode ?? null,
						blockedExpiresAt: input.blockedExpiresAt ?? null,
					},
				});
				return {
					id,
					findingId: input.findingId,
					headSha,
					producingReviewId: input.producingReviewId,
					status: input.status,
					reason: input.reason,
					command: input.command ?? null,
					cwd: input.cwd ?? null,
					exitCode: input.exitCode ?? null,
					durationMs: input.durationMs ?? null,
					stdoutTail: input.stdoutTail ?? null,
					stderrTail: input.stderrTail ?? null,
					blockedExpiresAt: input.blockedExpiresAt ?? null,
					createdAt,
				};
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	listVerifications(findingId: string): Verification[] {
		const rows = this.database
			.prepare("SELECT * FROM verifications WHERE finding_id = ? ORDER BY created_at, id")
			.all(findingId) as unknown as VerificationRow[];
		return rows.map(mapVerification);
	}

	private mapReview(row: ReviewRow): Omit<Review, "findings"> {
		return {
			id: row.id,
			taskId: row.task_id,
			runId: row.run_id,
			headSha: row.head_sha,
			baseSha: row.base_sha,
			authorSessionId: row.author_session_id,
			authorModel: row.author_model,
			authorModelFamily: row.author_model_family,
			reviewerSessionId: row.reviewer_session_id,
			reviewerModel: row.reviewer_model,
			reviewerModelFamily: row.reviewer_model_family,
			authorProfileId: row.author_profile_id,
			reviewerProfileId: row.reviewer_profile_id,
			riskClass: row.risk_class,
			reviewMode: row.review_mode,
			verdict: row.verdict,
			round: row.round,
			stage: row.stage,
			previousReviewId: row.previous_review_id,
			envelope: parseJsonObject(row.envelope_json),
			decision: parseJsonObject(row.decision_json),
			policy: parseJsonObject(row.policy_json),
			createdAt: row.created_at,
		};
	}
}
