import type { DatabaseSync } from "node:sqlite";
import { type Clock, jsonObject, mapStoreError, newId, nonEmpty, parseJsonObject } from "./helpers.ts";
import type { CreateEvalInput, Eval } from "./types.ts";

interface EvalRow {
	id: string;
	task_id: string;
	provider: string;
	model: string;
	role: string;
	metrics_json: string;
	created_at: number;
}

function mapEval(row: EvalRow): Eval {
	return {
		id: row.id,
		taskId: row.task_id,
		provider: row.provider,
		model: row.model,
		role: row.role,
		metrics: parseJsonObject(row.metrics_json),
		createdAt: row.created_at,
	};
}

export class EvalStore {
	private readonly database: DatabaseSync;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, clock: Clock) {
		this.database = database;
		this.clock = clock;
	}

	get(id: string): Eval | null {
		const row = this.database.prepare("SELECT * FROM evals WHERE id = ?").get(id) as EvalRow | undefined;
		return row ? mapEval(row) : null;
	}

	listByTask(taskId: string): Eval[] {
		const rows = this.database
			.prepare("SELECT * FROM evals WHERE task_id = ? ORDER BY created_at, id")
			.all(taskId) as unknown as EvalRow[];
		return rows.map(mapEval);
	}

	create(input: CreateEvalInput): Eval {
		const id = input.id ?? newId();
		try {
			this.database
				.prepare(
					"INSERT INTO evals (id, task_id, provider, model, role, metrics_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					nonEmpty(input.taskId, "taskId"),
					nonEmpty(input.provider, "provider"),
					nonEmpty(input.model, "model"),
					nonEmpty(input.role, "role"),
					jsonObject(input.metrics, "metrics"),
					this.clock(),
				);
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
		return this.get(id)!;
	}
}
