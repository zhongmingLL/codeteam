import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import type { AuditStore } from "./audit.ts";
import { type Clock, mapStoreError, newId, nonEmpty } from "./helpers.ts";
import type { CreateMergeInput, Merge } from "./types.ts";

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

	create(input: CreateMergeInput): Merge {
		const id = input.id ?? newId();
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
				this.database
					.prepare(
						"INSERT INTO merges (id, task_id, base_sha, head_sha, merge_sha, policy, approved_by, receipt_ref, approval_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						id,
						nonEmpty(input.taskId, "taskId"),
						validateSha(input.baseSha, "baseSha"),
						validateSha(input.headSha, "headSha"),
						validateSha(input.mergeSha, "mergeSha"),
						nonEmpty(input.policy, "policy"),
						nonEmpty(input.approvedBy, "approvedBy"),
						nonEmpty(input.receiptRef, "receiptRef"),
						input.approvalId ?? null,
						now,
					);
				this.audit.append({
					actor: `profile:${input.approvedBy}`,
					action: "merge_recorded",
					subject: `merge:${id}`,
					args: { taskId: input.taskId, headSha: input.headSha, mergeSha: input.mergeSha },
				});
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}
}
