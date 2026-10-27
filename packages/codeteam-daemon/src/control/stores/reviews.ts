import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import type { AuditStore } from "./audit.ts";
import { type Clock, mapStoreError, newId, nonEmpty } from "./helpers.ts";
import type {
	CreateReviewInput,
	CreateVerificationInput,
	Finding,
	Review,
	ReviewMode,
	ReviewVerdict,
	Verification,
	VerificationStatus,
} from "./types.ts";

interface ReviewRow {
	id: string;
	task_id: string;
	run_id: string;
	head_sha: string;
	author_session_id: string;
	author_model: string;
	author_model_family: string;
	reviewer_session_id: string;
	reviewer_model: string;
	reviewer_model_family: string;
	review_mode: ReviewMode;
	verdict: ReviewVerdict;
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
	created_at: number;
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

	create(input: CreateReviewInput): Review {
		const headSha = validateHeadSha(input.headSha);
		if (input.authorSessionId === input.reviewerSessionId) {
			throw new ControlError("invalid_input", "reviewer session must differ from author session");
		}
		if (input.reviewMode === "cross_family" && input.authorModelFamily === input.reviewerModelFamily) {
			throw new ControlError("invalid_input", "cross-family review requires different model families");
		}
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
				this.database
					.prepare(
						"INSERT INTO reviews (id, task_id, run_id, head_sha, author_session_id, author_model, author_model_family, reviewer_session_id, reviewer_model, reviewer_model_family, review_mode, verdict, findings_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						id,
						nonEmpty(input.taskId, "taskId"),
						nonEmpty(input.runId, "runId"),
						headSha,
						nonEmpty(input.authorSessionId, "authorSessionId"),
						nonEmpty(input.authorModel, "authorModel"),
						nonEmpty(input.authorModelFamily, "authorModelFamily"),
						nonEmpty(input.reviewerSessionId, "reviewerSessionId"),
						nonEmpty(input.reviewerModel, "reviewerModel"),
						nonEmpty(input.reviewerModelFamily, "reviewerModelFamily"),
						input.reviewMode,
						input.verdict,
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
					actor: `profile:${input.reviewerSessionId}`,
					action: "review_recorded",
					subject: `review:${id}`,
					args: { taskId: input.taskId, headSha, verdict: input.verdict, findings: findings.length },
				});
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}

	verify(input: CreateVerificationInput): Verification {
		const headSha = validateHeadSha(input.headSha);
		const id = newId();
		const createdAt = this.clock();
		try {
			return this.transaction.run(() => {
				if (!this.database.prepare("SELECT id FROM findings WHERE id = ?").get(input.findingId)) {
					throw new ControlError("not_found", `finding ${input.findingId} not found`);
				}
				if (!this.database.prepare("SELECT id FROM reviews WHERE id = ?").get(input.producingReviewId)) {
					throw new ControlError("not_found", `review ${input.producingReviewId} not found`);
				}
				this.database
					.prepare(
						"INSERT INTO verifications (id, finding_id, head_sha, producing_review_id, status, reason, command, cwd, exit_code, duration_ms, stdout_tail, stderr_tail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
						createdAt,
					);
				this.audit.append({
					actor: `review:${input.producingReviewId}`,
					action: "finding_verified",
					subject: `finding:${input.findingId}`,
					args: { status: input.status, headSha },
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
			authorSessionId: row.author_session_id,
			authorModel: row.author_model,
			authorModelFamily: row.author_model_family,
			reviewerSessionId: row.reviewer_session_id,
			reviewerModel: row.reviewer_model,
			reviewerModelFamily: row.reviewer_model_family,
			reviewMode: row.review_mode,
			verdict: row.verdict,
			createdAt: row.created_at,
		};
	}
}
