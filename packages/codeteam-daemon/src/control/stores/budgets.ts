import type { DatabaseSync } from "node:sqlite";
import { mapStoreError, newId, nonEmpty } from "./helpers.ts";
import type { Budget, CreateBudgetInput } from "./types.ts";

interface BudgetRow {
	id: string;
	task_id: string;
	tokens_limit: number | null;
	tokens_used: number;
	cost_limit: number | null;
	cost_used: number;
	wall_time_limit_ms: number | null;
	wall_time_used_ms: number;
}

function mapBudget(row: BudgetRow): Budget {
	return {
		id: row.id,
		taskId: row.task_id,
		tokensLimit: row.tokens_limit,
		tokensUsed: row.tokens_used,
		costLimit: row.cost_limit,
		costUsed: row.cost_used,
		wallTimeLimitMs: row.wall_time_limit_ms,
		wallTimeUsedMs: row.wall_time_used_ms,
	};
}

export class BudgetStore {
	private readonly database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.database = database;
	}

	get(id: string): Budget | null {
		const row = this.database.prepare("SELECT * FROM budgets WHERE id = ?").get(id) as BudgetRow | undefined;
		return row ? mapBudget(row) : null;
	}

	listByTask(taskId: string): Budget[] {
		const rows = this.database
			.prepare("SELECT * FROM budgets WHERE task_id = ? ORDER BY id")
			.all(taskId) as unknown as BudgetRow[];
		return rows.map(mapBudget);
	}

	create(input: CreateBudgetInput): Budget {
		const id = input.id ?? newId();
		try {
			this.database
				.prepare(
					"INSERT INTO budgets (id, task_id, tokens_limit, tokens_used, cost_limit, cost_used, wall_time_limit_ms, wall_time_used_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					nonEmpty(input.taskId, "taskId"),
					input.tokensLimit ?? null,
					input.tokensUsed ?? 0,
					input.costLimit ?? null,
					input.costUsed ?? 0,
					input.wallTimeLimitMs ?? null,
					input.wallTimeUsedMs ?? 0,
				);
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
		return this.get(id)!;
	}
}
