import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import { type Clock, changesOf, mapStoreError, nonEmpty } from "./helpers.ts";
import type { WorkAdmission, WorkAttempt } from "./types.ts";

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
}
