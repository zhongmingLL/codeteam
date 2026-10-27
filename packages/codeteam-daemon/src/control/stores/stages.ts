import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import { type Clock, changesOf, mapStoreError, newId, nonEmpty } from "./helpers.ts";
import type { CreateStageInput, Stage, StageLane, StageStatus } from "./types.ts";

interface StageRow {
	id: string;
	task_id: string;
	lane: StageLane;
	status: StageStatus;
	started_at: number;
	ended_at: number | null;
}

function mapStage(row: StageRow): Stage {
	return {
		id: row.id,
		taskId: row.task_id,
		lane: row.lane,
		status: row.status,
		startedAt: row.started_at,
		endedAt: row.ended_at,
	};
}

export class StageStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
	}

	get(id: string): Stage | null {
		const row = this.database.prepare("SELECT * FROM stages WHERE id = ?").get(id) as StageRow | undefined;
		return row ? mapStage(row) : null;
	}

	listByTask(taskId: string): Stage[] {
		const rows = this.database
			.prepare("SELECT * FROM stages WHERE task_id = ? ORDER BY started_at, id")
			.all(taskId) as unknown as StageRow[];
		return rows.map(mapStage);
	}

	create(input: CreateStageInput): Stage {
		const id = input.id ?? newId();
		try {
			this.database
				.prepare("INSERT INTO stages (id, task_id, lane, status, started_at) VALUES (?, ?, ?, 'active', ?)")
				.run(id, nonEmpty(input.taskId, "taskId"), input.lane, this.clock());
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
		return this.get(id)!;
	}

	pass(id: string, endedAt?: number): Stage {
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `stage ${id} not found`);
				if (current.status === "passed") return current;
				const result = this.database
					.prepare("UPDATE stages SET status = 'passed', ended_at = ? WHERE id = ? AND status = 'active'")
					.run(endedAt ?? this.clock(), id);
				if (changesOf(result) === 0) throw new ControlError("conflict", `stage ${id} changed state`);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}
}
