import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import type { AuditStore } from "./audit.ts";
import { type Clock, mapStoreError, newId, nonEmpty } from "./helpers.ts";
import type { CreateMergeInput, Merge, MergeStatus } from "./types.ts";

export const MERGE_SERVICE_ACTOR = "service:merge-owner";

interface MergeRow {
	id: string;
	task_id: string;
	base_sha: string;
	head_sha: string;
	merge_sha: string;
	policy: string;
	approved_by: string;
	receipt_ref: string;
	approval_id: string | null;
	executed_by: string;
	gate_evidence_ref: string | null;
	review_ref: string | null;
	status: MergeStatus;
	failure_ref: string | null;
	hard_gate: number;
	strategy: string | null;
	repo: string | null;
	pr_ref: string | null;
	merged_at: number | null;
	created_at: number;
}

function mapMerge(row: MergeRow): Merge {
	return {
		id: row.id,
		taskId: row.task_id,
		baseSha: row.base_sha,
		headSha: row.head_sha,
		mergeSha: row.merge_sha,
		policy: row.policy,
		approvedBy: row.approved_by,
		receiptRef: row.receipt_ref,
		approvalId: row.approval_id,
		executedBy: row.executed_by,
		gateEvidenceRef: row.gate_evidence_ref,
		reviewRef: row.review_ref,
		status: row.status,
		failureRef: row.failure_ref,
		hardGate: row.hard_gate === 1,
		strategy: row.strategy,
		repo: row.repo,
		prRef: row.pr_ref,
		mergedAt: row.merged_at,
		createdAt: row.created_at,
	};
}

function validateSha(value: string, field: string): string {
	const sha = nonEmpty(value, field);
	if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) {
		throw new ControlError("invalid_input", `${field} must be 40 or 64 lowercase hex characters`);
	}
	return sha;
}

function validateStatus(value: MergeStatus | undefined): MergeStatus {
	const status = value ?? "succeeded";
	if (status !== "succeeded" && status !== "failed" && status !== "unknown") {
		throw new ControlError("invalid_input", `unsupported merge status ${String(status)}`);
	}
	return status;
}

export class MergeStore {
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

	get(id: string): Merge | null {
		const row = this.database.prepare("SELECT * FROM merges WHERE id = ?").get(id) as MergeRow | undefined;
		return row ? mapMerge(row) : null;
	}

	listByTask(taskId: string): Merge[] {
		const rows = this.database
			.prepare("SELECT * FROM merges WHERE task_id = ? ORDER BY created_at, id")
			.all(taskId) as unknown as MergeRow[];
		return rows.map(mapMerge);
	}

	latestSucceededByBacklog(backlogItemId: string): Merge | null {
		const row = this.database
			.prepare(
				"SELECT m.* FROM merges m JOIN tasks t ON t.id = m.task_id WHERE t.backlog_item_id = ? AND m.status = 'succeeded' AND m.executed_by = 'service:merge-owner' AND m.gate_evidence_ref IS NOT NULL ORDER BY m.created_at DESC, m.id DESC LIMIT 1",
			)
			.get(backlogItemId) as MergeRow | undefined;
		return row ? mapMerge(row) : null;
	}

	create(input: CreateMergeInput): Merge {
		const id = input.id ?? newId();
		const status = validateStatus(input.status);
		const executedBy = nonEmpty(input.executedBy ?? MERGE_SERVICE_ACTOR, "executedBy");
		const approvedBy = nonEmpty(input.approvedBy ?? executedBy, "approvedBy");
		const hardGate = input.hardGate ?? false;
		if (status === "succeeded" && executedBy !== MERGE_SERVICE_ACTOR) {
			throw new ControlError("forbidden", "succeeded merge receipt requires service:merge-owner");
		}
		if (status === "succeeded" && !input.gateEvidenceRef) {
			throw new ControlError("invalid_input", "succeeded merge receipt requires gateEvidenceRef");
		}
		if (status !== "succeeded" && (!input.failureRef || input.failureRef.trim() === "")) {
			throw new ControlError("invalid_input", `${status} merge receipt requires failureRef`);
		}
		if (hardGate && !input.approvalId) {
			throw new ControlError("invalid_input", "hard-gate merge requires an accepted approval");
		}
		if (!hardGate && input.approvalId) {
			throw new ControlError("invalid_input", "routine merge must not carry an approval");
		}
		const baseSha = validateSha(input.baseSha, "baseSha");
		const headSha = validateSha(input.headSha, "headSha");
		const mergeSha = validateSha(input.mergeSha, "mergeSha");
		const now = this.clock();
		try {
			return this.transaction.run(() => {
				if (input.approvalId) {
					const approval = this.database
						.prepare("SELECT resolution FROM approvals WHERE id = ?")
						.get(input.approvalId) as { resolution?: string } | undefined;
					if (!approval) throw new ControlError("not_found", `approval ${input.approvalId} not found`);
					if (approval.resolution !== "accepted") {
						throw new ControlError("invalid_state", "merge requires an accepted approval");
					}
				}
				if (input.reviewRef) {
					const review = this.database.prepare("SELECT head_sha FROM reviews WHERE id = ?").get(input.reviewRef) as
						| { head_sha?: string }
						| undefined;
					if (!review) throw new ControlError("not_found", `review ${input.reviewRef} not found`);
					if (review.head_sha !== headSha) {
						throw new ControlError("invalid_input", "merge review does not cover the exact headSha");
					}
				}
				this.database
					.prepare(
						"INSERT INTO merges (id, task_id, base_sha, head_sha, merge_sha, policy, approved_by, receipt_ref, approval_id, executed_by, gate_evidence_ref, review_ref, status, failure_ref, hard_gate, strategy, repo, pr_ref, merged_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						id,
						nonEmpty(input.taskId, "taskId"),
						baseSha,
						headSha,
						mergeSha,
						nonEmpty(input.policy, "policy"),
						approvedBy,
						nonEmpty(input.receiptRef, "receiptRef"),
						input.approvalId ?? null,
						executedBy,
						input.gateEvidenceRef ?? null,
						input.reviewRef ?? null,
						status,
						input.failureRef ?? null,
						hardGate ? 1 : 0,
						input.strategy ?? null,
						input.repo ?? null,
						input.prRef ?? null,
						input.mergedAt ?? (status === "succeeded" ? now : null),
						now,
					);
				this.audit.append({
					actor: executedBy,
					action: "merge_recorded",
					subject: `merge:${id}`,
					args: {
						taskId: input.taskId,
						headSha,
						mergeSha,
						status,
						executedBy,
						gateEvidenceRef: input.gateEvidenceRef ?? null,
						reviewRef: input.reviewRef ?? null,
						hardGate,
						failureRef: input.failureRef ?? null,
					},
				});
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}
}
