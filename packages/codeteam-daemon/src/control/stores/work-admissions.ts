import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import { type Clock, changesOf, mapStoreError, nonEmpty } from "./helpers.ts";
import type { WorkAdmission, WorkAttempt, WorkRunBinding, WorkTaskBinding } from "./types.ts";

interface WorkAdmissionRow {
	work_id: string;
	owner_user_id: string;
	producer_kind: string;
	producer_ref: string;
	initial_attempt_id: string;
	admitted_at: number;
}

interface WorkAttemptRow {
	attempt_id: string;
	work_id: string;
	attempt_number: number;
	executor_profile_id: string | null;
	created_at: number;
	executor_bound_at: number | null;
}

function mapAdmission(row: WorkAdmissionRow): WorkAdmission {
	return {
		workId: row.work_id,
		ownerUserId: row.owner_user_id,
		producerKind: row.producer_kind,
		producerRef: row.producer_ref,
		initialAttemptId: row.initial_attempt_id,
		admittedAt: row.admitted_at,
	};
}

function mapAttempt(row: WorkAttemptRow): WorkAttempt {
	return {
		attemptId: row.attempt_id,
		workId: row.work_id,
		attemptNumber: row.attempt_number,
		executorProfileId: row.executor_profile_id,
		createdAt: row.created_at,
		executorBoundAt: row.executor_bound_at,
	};
}

export class WorkAdmissionStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
	}

	getAdmission(workId: string): WorkAdmission | null {
		const row = this.database.prepare("SELECT * FROM work_admissions WHERE work_id = ?").get(workId) as
			| WorkAdmissionRow
			| undefined;
		return row ? mapAdmission(row) : null;
	}

	getAttempt(attemptId: string): WorkAttempt | null {
		const row = this.database.prepare("SELECT * FROM work_attempts WHERE attempt_id = ?").get(attemptId) as
			| WorkAttemptRow
			| undefined;
		return row ? mapAttempt(row) : null;
	}

	listAttempts(workId: string): WorkAttempt[] {
		const rows = this.database
			.prepare("SELECT * FROM work_attempts WHERE work_id = ? ORDER BY attempt_number")
			.all(workId) as unknown as WorkAttemptRow[];
		return rows.map(mapAttempt);
	}

	bindAttempt(attemptId: string, profileId: string): WorkAttempt {
		const profile = nonEmpty(profileId, "profileId");
		try {
			return this.transaction.run(() => {
				const current = this.getAttempt(nonEmpty(attemptId, "attemptId"));
				if (!current) throw new ControlError("not_found", `work attempt ${attemptId} not found`);
				const exists = this.database.prepare("SELECT id FROM agent_profiles WHERE id = ?").get(profile);
				if (!exists) throw new ControlError("not_found", `agent profile ${profile} not found`);
				if (current.executorProfileId === profile) return current;
				if (current.executorProfileId !== null) {
					throw new ControlError(
						"conflict",
						`work attempt ${attemptId} is already bound to ${current.executorProfileId}`,
					);
				}
				const now = this.clock();
				const result = this.database
					.prepare(
						"UPDATE work_attempts SET executor_profile_id = ?, executor_bound_at = ? WHERE attempt_id = ? AND executor_profile_id IS NULL",
					)
					.run(profile, now, attemptId);
				if (changesOf(result) === 0) {
					throw new ControlError("conflict", `work attempt ${attemptId} was bound concurrently`);
				}
				return this.getAttempt(attemptId)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	getRunBinding(runId: string): WorkRunBinding | null {
		const row = this.database
			.prepare("SELECT run_id, work_id, attempt_id, bound_at FROM run_managed_work_bindings WHERE run_id = ?")
			.get(runId) as { run_id?: string; work_id?: string; attempt_id?: string; bound_at?: number } | undefined;
		return row?.run_id && row.work_id && row.attempt_id != null && row.bound_at != null
			? { runId: row.run_id, workId: row.work_id, attemptId: row.attempt_id, boundAt: row.bound_at }
			: null;
	}

	getTaskBinding(taskId: string): WorkTaskBinding | null {
		const row = this.database
			.prepare("SELECT task_id, work_id, attempt_id, bound_at FROM task_managed_work_bindings WHERE task_id = ?")
			.get(taskId) as { task_id?: string; work_id?: string; attempt_id?: string; bound_at?: number } | undefined;
		return row?.task_id && row.work_id && row.attempt_id != null && row.bound_at != null
			? { taskId: row.task_id, workId: row.work_id, attemptId: row.attempt_id, boundAt: row.bound_at }
			: null;
	}

	bindRun(input: { runId: string; workId: string; attemptId: string }): WorkRunBinding {
		try {
			return this.transaction.run(() => {
				const existing = this.getRunBinding(input.runId);
				if (existing) {
					if (existing.workId === input.workId && existing.attemptId === input.attemptId) return existing;
					throw new ControlError("conflict", `run ${input.runId} is bound to another work attempt`);
				}
				const run = this.database.prepare("SELECT task_id, role FROM runs WHERE id = ?").get(input.runId) as
					| { task_id?: string; role?: string }
					| undefined;
				if (!run?.task_id) throw new ControlError("not_found", `run ${input.runId} not found`);
				if (run.role !== "coder") throw new ControlError("invalid_input", "only primary coder runs bind work");
				const task = this.database
					.prepare("SELECT kind, backlog_item_id FROM tasks WHERE id = ?")
					.get(run.task_id) as { kind?: string; backlog_item_id?: string | null } | undefined;
				if (!task) throw new ControlError("not_found", `task ${run.task_id} not found`);
				if (task.kind !== "work") throw new ControlError("invalid_input", "only work tasks bind managed work");
				const admission = this.getAdmission(input.workId);
				const attempt = this.getAttempt(input.attemptId);
				if (!admission) throw new ControlError("not_found", `work admission ${input.workId} not found`);
				if (!attempt || attempt.workId !== input.workId) {
					throw new ControlError(
						"not_found",
						`work attempt ${input.attemptId} not found for work ${input.workId}`,
					);
				}
				if (task.backlog_item_id !== admission.producerRef) {
					throw new ControlError("conflict", "run task backlog does not match the work admission producer");
				}
				const now = this.clock();
				this.database
					.prepare(
						"INSERT INTO run_managed_work_bindings (run_id, work_id, attempt_id, bound_at) VALUES (?, ?, ?, ?)",
					)
					.run(input.runId, input.workId, input.attemptId, now);
				return { runId: input.runId, workId: input.workId, attemptId: input.attemptId, boundAt: now };
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	bindTask(input: { taskId: string; workId: string; attemptId: string }): WorkTaskBinding {
		try {
			return this.transaction.run(() => {
				const existing = this.getTaskBinding(input.taskId);
				if (existing) {
					if (existing.workId === input.workId && existing.attemptId === input.attemptId) return existing;
					throw new ControlError("conflict", `task ${input.taskId} is bound to another work attempt`);
				}
				const task = this.database.prepare("SELECT kind FROM tasks WHERE id = ?").get(input.taskId) as
					| { kind?: string }
					| undefined;
				if (!task) throw new ControlError("not_found", `task ${input.taskId} not found`);
				if (task.kind !== "pr_tracking") {
					throw new ControlError("invalid_input", "only pr_tracking tasks bind managed work");
				}
				const admission = this.getAdmission(input.workId);
				const attempt = this.getAttempt(input.attemptId);
				if (!admission) throw new ControlError("not_found", `work admission ${input.workId} not found`);
				if (!attempt || attempt.workId !== input.workId) {
					throw new ControlError(
						"not_found",
						`work attempt ${input.attemptId} not found for work ${input.workId}`,
					);
				}
				const now = this.clock();
				this.database
					.prepare(
						"INSERT INTO task_managed_work_bindings (task_id, work_id, attempt_id, bound_at) VALUES (?, ?, ?, ?)",
					)
					.run(input.taskId, input.workId, input.attemptId, now);
				return { taskId: input.taskId, workId: input.workId, attemptId: input.attemptId, boundAt: now };
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}
}
