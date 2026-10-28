import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import { type Clock, changesOf, mapStoreError, newId, nonEmpty } from "./helpers.ts";
import type { CreateWorktreeLeaseInput, WorktreeLease, WorktreeLeaseListFilter } from "./types.ts";

interface WorktreeLeaseRow {
	id: string;
	task_id: string;
	run_id: string | null;
	path: string;
	status: WorktreeLease["status"];
	lease_expires_at: number | null;
	released_at: number | null;
	collected_at: number | null;
	last_used_at: number;
	created_at: number;
}

function mapLease(row: WorktreeLeaseRow): WorktreeLease {
	return {
		id: row.id,
		taskId: row.task_id,
		runId: row.run_id,
		path: row.path,
		status: row.status,
		leaseExpiresAt: row.lease_expires_at,
		releasedAt: row.released_at,
		collectedAt: row.collected_at,
		lastUsedAt: row.last_used_at,
		createdAt: row.created_at,
	};
}

export class WorktreeLeaseStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
	}

	get(id: string): WorktreeLease | null {
		const row = this.database.prepare("SELECT * FROM worktree_leases WHERE id = ?").get(id) as
			| WorktreeLeaseRow
			| undefined;
		return row ? mapLease(row) : null;
	}

	getByPath(path: string): WorktreeLease | null {
		const row = this.database.prepare("SELECT * FROM worktree_leases WHERE path = ?").get(path) as
			| WorktreeLeaseRow
			| undefined;
		return row ? mapLease(row) : null;
	}

	list(filter: WorktreeLeaseListFilter = {}): WorktreeLease[] {
		const clauses: string[] = [];
		const params: string[] = [];
		if (filter.taskId !== undefined) {
			clauses.push("task_id = ?");
			params.push(filter.taskId);
		}
		if (filter.status !== undefined) {
			clauses.push("status = ?");
			params.push(filter.status);
		}
		const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.database
			.prepare(`SELECT * FROM worktree_leases${where} ORDER BY created_at, id`)
			.all(...params) as unknown as WorktreeLeaseRow[];
		return rows.map(mapLease);
	}

	countActive(): number {
		const row = this.database
			.prepare("SELECT COUNT(*) AS count FROM worktree_leases WHERE status = 'leased'")
			.get() as { count?: number } | undefined;
		return row?.count ?? 0;
	}

	create(input: CreateWorktreeLeaseInput): WorktreeLease {
		const id = input.id ?? `wt_${newId()}`;
		const path = nonEmpty(input.path, "path");
		const now = this.clock();
		try {
			return this.transaction.run(() => {
				const task = this.database.prepare("SELECT id FROM tasks WHERE id = ?").get(input.taskId) as
					| { id?: string }
					| undefined;
				if (!task) throw new ControlError("not_found", `task ${input.taskId} not found`);
				if (input.runId !== undefined && input.runId !== null) {
					const run = this.database.prepare("SELECT task_id FROM runs WHERE id = ?").get(input.runId) as
						| { task_id?: string }
						| undefined;
					if (!run) throw new ControlError("not_found", `run ${input.runId} not found`);
					if (run.task_id !== input.taskId) {
						throw new ControlError("invalid_input", `run ${input.runId} does not belong to task ${input.taskId}`);
					}
				}
				this.database
					.prepare(
						"INSERT INTO worktree_leases (id, task_id, run_id, path, status, lease_expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, 'leased', ?, ?, ?)",
					)
					.run(id, input.taskId, input.runId ?? null, path, input.leaseExpiresAt ?? null, now, now);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}

	release(id: string): WorktreeLease {
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `worktree lease ${id} not found`);
				if (current.status === "released") return current;
				if (current.status !== "leased") {
					throw new ControlError("invalid_state", `worktree lease ${id} is ${current.status}`);
				}
				const now = this.clock();
				const result = this.database
					.prepare(
						"UPDATE worktree_leases SET status = 'released', released_at = ?, last_used_at = ? WHERE id = ? AND status = 'leased'",
					)
					.run(now, now, id);
				if (changesOf(result) === 0) throw new ControlError("version_conflict", `worktree lease ${id} changed`);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	markCollected(id: string): WorktreeLease {
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `worktree lease ${id} not found`);
				if (current.status === "collected") return current;
				const now = this.clock();
				const result = this.database
					.prepare(
						"UPDATE worktree_leases SET status = 'collected', collected_at = ?, last_used_at = ? WHERE id = ? AND status IN ('leased', 'released')",
					)
					.run(now, now, id);
				if (changesOf(result) === 0) throw new ControlError("version_conflict", `worktree lease ${id} changed`);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}
}
