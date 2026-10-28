import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import { type Clock, changesOf, jsonObject, mapStoreError, newId, nonEmpty, parseJsonObject } from "./helpers.ts";
import type {
	CreateScheduleSpecInput,
	RecordScheduleRunInput,
	ScheduleRun,
	ScheduleRunStatus,
	ScheduleSpec,
	ScheduleState,
} from "./types.ts";

interface ScheduleSpecRow {
	id: string;
	task_id: string;
	thread_id: string;
	factory_id: string;
	status: "active" | "paused";
	trigger_json: string;
	admission_json: string;
	run_spec_json: string;
	state_json: string;
	outcome_json: string;
	version: number;
	created_at: number;
	updated_at: number;
}

interface ScheduleRunRow {
	id: string;
	spec_id: string;
	occurrence_key: string;
	scheduled_for: number;
	status: ScheduleRunStatus;
	queue_entry_id: string | null;
	source_message_id: string | null;
	reason_json: string | null;
	created_at: number;
}

function mapSpec(row: ScheduleSpecRow): ScheduleSpec {
	return {
		id: row.id,
		taskId: row.task_id,
		threadId: row.thread_id,
		factoryId: row.factory_id,
		status: row.status,
		trigger: parseJsonObject(row.trigger_json) as unknown as ScheduleSpec["trigger"],
		admission: parseJsonObject(row.admission_json) as unknown as ScheduleSpec["admission"],
		runSpec: parseJsonObject(row.run_spec_json) as unknown as ScheduleSpec["runSpec"],
		state: parseJsonObject(row.state_json) as unknown as ScheduleState,
		outcome: parseJsonObject(row.outcome_json),
		version: row.version,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapRun(row: ScheduleRunRow): ScheduleRun {
	return {
		id: row.id,
		specId: row.spec_id,
		occurrenceKey: row.occurrence_key,
		scheduledFor: row.scheduled_for,
		status: row.status,
		queueEntryId: row.queue_entry_id,
		sourceMessageId: row.source_message_id,
		reason: row.reason_json ? parseJsonObject(row.reason_json) : null,
		createdAt: row.created_at,
	};
}

function validateTrigger(trigger: ScheduleSpec["trigger"]): void {
	if (!trigger || typeof trigger !== "object") throw new ControlError("invalid_input", "trigger is required");
	if (trigger.kind === "manual") return;
	if (trigger.kind !== "timer") throw new ControlError("invalid_input", "trigger.kind must be timer or manual");
	if (!Number.isSafeInteger(trigger.everyMs) || trigger.everyMs <= 0) {
		throw new ControlError("invalid_input", "trigger.everyMs must be a positive integer");
	}
	if (trigger.firstRunAt !== undefined && trigger.firstRunAt !== null && !Number.isSafeInteger(trigger.firstRunAt)) {
		throw new ControlError("invalid_input", "trigger.firstRunAt must be an integer");
	}
}

function validateAdmission(admission: ScheduleSpec["admission"]): void {
	if (!admission || typeof admission !== "object") throw new ControlError("invalid_input", "admission is required");
	if (!Array.isArray(admission.targets) || admission.targets.length === 0) {
		throw new ControlError("invalid_input", "admission.targets must be a non-empty array");
	}
	const targets = admission.targets.filter((target) => typeof target === "string" && target.trim() !== "");
	if (targets.length !== admission.targets.length || new Set(targets).size !== targets.length) {
		throw new ControlError("invalid_input", "admission.targets must be unique non-empty strings");
	}
	if (admission.priority !== "urgent" && admission.priority !== "normal") {
		throw new ControlError("invalid_input", "admission.priority must be urgent or normal");
	}
}

function validateRunSpec(runSpec: ScheduleSpec["runSpec"]): void {
	if (!runSpec || typeof runSpec !== "object" || typeof runSpec.bodyMd !== "string" || runSpec.bodyMd.trim() === "") {
		throw new ControlError("invalid_input", "runSpec.bodyMd is required");
	}
}

export class ScheduleStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
	}

	get(id: string): ScheduleSpec | null {
		const row = this.database.prepare("SELECT * FROM schedule_specs WHERE id = ?").get(id) as
			| ScheduleSpecRow
			| undefined;
		return row ? mapSpec(row) : null;
	}

	list(filter: { taskId?: string; status?: ScheduleSpec["status"] } = {}): ScheduleSpec[] {
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
			.prepare(`SELECT * FROM schedule_specs${where} ORDER BY created_at, id`)
			.all(...params) as unknown as ScheduleSpecRow[];
		return rows.map(mapSpec);
	}

	create(input: CreateScheduleSpecInput): ScheduleSpec {
		validateTrigger(input.trigger);
		validateAdmission(input.admission);
		validateRunSpec(input.runSpec);
		const id = input.id ?? `schedule_${newId()}`;
		const now = this.clock();
		const state: ScheduleState = {
			nextRunAt:
				input.state?.nextRunAt !== undefined
					? input.state.nextRunAt
					: input.trigger.kind === "timer"
						? (input.trigger.firstRunAt ?? now)
						: null,
			lastRunAt: input.state?.lastRunAt ?? null,
			generation: input.state?.generation ?? 0,
		};
		try {
			return this.transaction.run(() => {
				const task = this.database.prepare("SELECT thread_id FROM tasks WHERE id = ?").get(input.taskId) as
					| { thread_id?: string }
					| undefined;
				if (!task) throw new ControlError("not_found", `task ${input.taskId} not found`);
				if (task.thread_id !== input.threadId) {
					throw new ControlError("invalid_input", "schedule thread must match the task thread");
				}
				this.database
					.prepare(
						"INSERT INTO schedule_specs (id, task_id, thread_id, factory_id, status, trigger_json, admission_json, run_spec_json, state_json, outcome_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, '{}', 1, ?, ?)",
					)
					.run(
						id,
						nonEmpty(input.taskId, "taskId"),
						nonEmpty(input.threadId, "threadId"),
						nonEmpty(input.factoryId, "factoryId"),
						jsonObject(input.trigger, "trigger"),
						jsonObject(input.admission, "admission"),
						jsonObject(input.runSpec, "runSpec"),
						jsonObject(state, "state"),
						now,
						now,
					);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}

	setStatus(id: string, status: ScheduleSpec["status"], expectedVersion?: number): ScheduleSpec {
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `schedule spec ${id} not found`);
				if (current.status === status) return current;
				const now = this.clock();
				const result =
					expectedVersion === undefined
						? this.database
								.prepare(
									"UPDATE schedule_specs SET status = ?, version = version + 1, updated_at = ? WHERE id = ?",
								)
								.run(status, now, id)
						: this.database
								.prepare(
									"UPDATE schedule_specs SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
								)
								.run(status, now, id, expectedVersion);
				if (changesOf(result) === 0) throw new ControlError("version_conflict", `schedule spec ${id} changed`);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	updateProgress(
		id: string,
		input: { state: ScheduleState; outcome: Record<string, unknown>; expectedVersion: number },
	): ScheduleSpec {
		try {
			return this.transaction.run(() => {
				const now = this.clock();
				const result = this.database
					.prepare(
						"UPDATE schedule_specs SET state_json = ?, outcome_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
					)
					.run(
						jsonObject(input.state, "state"),
						jsonObject(input.outcome, "outcome"),
						now,
						id,
						input.expectedVersion,
					);
				if (changesOf(result) === 0) {
					if (!this.get(id)) throw new ControlError("not_found", `schedule spec ${id} not found`);
					throw new ControlError("version_conflict", `schedule spec ${id} changed`);
				}
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	getRun(specId: string, occurrenceKey: string): ScheduleRun | null {
		const row = this.database
			.prepare("SELECT * FROM schedule_runs WHERE spec_id = ? AND occurrence_key = ?")
			.get(specId, occurrenceKey) as ScheduleRunRow | undefined;
		return row ? mapRun(row) : null;
	}

	listRuns(specId: string, limit = 100): ScheduleRun[] {
		const rows = this.database
			.prepare("SELECT * FROM schedule_runs WHERE spec_id = ? ORDER BY scheduled_for, id LIMIT ?")
			.all(specId, Math.min(Math.max(limit, 1), 500)) as unknown as ScheduleRunRow[];
		return rows.map(mapRun);
	}

	recordRun(input: RecordScheduleRunInput): ScheduleRun {
		try {
			return this.transaction.run(() => {
				const existing = this.getRun(input.specId, input.occurrenceKey);
				if (existing) return existing;
				const id = `srun_${newId()}`;
				this.database
					.prepare(
						"INSERT INTO schedule_runs (id, spec_id, occurrence_key, scheduled_for, status, queue_entry_id, source_message_id, reason_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						id,
						input.specId,
						input.occurrenceKey,
						input.scheduledFor,
						input.status,
						input.queueEntryId ?? null,
						input.sourceMessageId ?? null,
						input.reason ? jsonObject(input.reason, "reason") : null,
						this.clock(),
					);
				return this.getRun(input.specId, input.occurrenceKey)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}
}
