import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import { type Clock, changesOf, mapStoreError, newId, nonEmpty } from "./helpers.ts";
import type {
	Budget,
	BudgetCharge,
	BudgetLimitKind,
	ChargeBudgetInput,
	ChargeBudgetResult,
	CreateBudgetInput,
	UpdateBudgetLimitsInput,
} from "./types.ts";

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

interface BudgetChargeRow {
	id: string;
	budget_id: string;
	run_id: string;
	tokens: number;
	cost: number;
	wall_time_ms: number;
	created_at: number;
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

function mapCharge(row: BudgetChargeRow): BudgetCharge {
	return {
		id: row.id,
		budgetId: row.budget_id,
		runId: row.run_id,
		tokens: row.tokens,
		cost: row.cost,
		wallTimeMs: row.wall_time_ms,
		createdAt: row.created_at,
	};
}

function nonNegativeInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new ControlError("invalid_input", `${field} must be a non-negative integer`);
	}
	return value;
}

function nonNegativeNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new ControlError("invalid_input", `${field} must be a non-negative number`);
	}
	return value;
}

function optionalLimit(value: number | null | undefined, field: string, integer: boolean): number | null {
	if (value === undefined || value === null) return null;
	return integer ? nonNegativeInteger(value, field) : nonNegativeNumber(value, field);
}

export function budgetLimitsHit(budget: Budget): BudgetLimitKind[] {
	const hit: BudgetLimitKind[] = [];
	if (budget.tokensLimit !== null && budget.tokensUsed >= budget.tokensLimit) hit.push("tokens");
	if (budget.costLimit !== null && budget.costUsed >= budget.costLimit) hit.push("cost");
	if (budget.wallTimeLimitMs !== null && budget.wallTimeUsedMs >= budget.wallTimeLimitMs) hit.push("wall_time");
	return hit;
}

export class BudgetStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
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

	getByTask(taskId: string): Budget | null {
		const budgets = this.listByTask(taskId);
		if (budgets.length > 1) {
			throw new ControlError("invalid_state", `task ${taskId} has ambiguous budgets`);
		}
		return budgets[0] ?? null;
	}

	create(input: CreateBudgetInput): Budget {
		const id = input.id ?? newId();
		try {
			return this.transaction.run(() => {
				this.database
					.prepare(
						"INSERT INTO budgets (id, task_id, tokens_limit, tokens_used, cost_limit, cost_used, wall_time_limit_ms, wall_time_used_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						id,
						nonEmpty(input.taskId, "taskId"),
						optionalLimit(input.tokensLimit, "tokensLimit", true),
						nonNegativeInteger(input.tokensUsed ?? 0, "tokensUsed"),
						optionalLimit(input.costLimit, "costLimit", false),
						nonNegativeNumber(input.costUsed ?? 0, "costUsed"),
						optionalLimit(input.wallTimeLimitMs, "wallTimeLimitMs", true),
						nonNegativeInteger(input.wallTimeUsedMs ?? 0, "wallTimeUsedMs"),
					);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}

	updateLimits(input: UpdateBudgetLimitsInput): Budget {
		try {
			return this.transaction.run(() => {
				const current = this.getByTask(nonEmpty(input.taskId, "taskId"));
				if (!current) throw new ControlError("not_found", `budget for task ${input.taskId} not found`);
				const tokensLimit =
					input.tokensLimit === undefined
						? current.tokensLimit
						: optionalLimit(input.tokensLimit, "tokensLimit", true);
				const costLimit =
					input.costLimit === undefined ? current.costLimit : optionalLimit(input.costLimit, "costLimit", false);
				const wallTimeLimitMs =
					input.wallTimeLimitMs === undefined
						? current.wallTimeLimitMs
						: optionalLimit(input.wallTimeLimitMs, "wallTimeLimitMs", true);
				const result = this.database
					.prepare("UPDATE budgets SET tokens_limit = ?, cost_limit = ?, wall_time_limit_ms = ? WHERE id = ?")
					.run(tokensLimit, costLimit, wallTimeLimitMs, current.id);
				if (changesOf(result) === 0) throw new ControlError("not_found", `budget ${current.id} not found`);
				return this.get(current.id)!;
			});
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}

	listCharges(budgetId: string): BudgetCharge[] {
		const rows = this.database
			.prepare("SELECT * FROM budget_charges WHERE budget_id = ? ORDER BY created_at, id")
			.all(budgetId) as unknown as BudgetChargeRow[];
		return rows.map(mapCharge);
	}

	getChargeByRun(runId: string): BudgetCharge | null {
		const row = this.database.prepare("SELECT * FROM budget_charges WHERE run_id = ?").get(runId) as
			| BudgetChargeRow
			| undefined;
		return row ? mapCharge(row) : null;
	}

	listUnchargedTerminalRunIds(taskId?: string): string[] {
		const rows = this.database
			.prepare(
				`SELECT r.id AS run_id
				 FROM runs r
				 JOIN budgets b ON b.task_id = r.task_id
				 LEFT JOIN budget_charges c ON c.run_id = r.id
				 WHERE r.status IN ('completed', 'failed', 'canceled', 'interrupted')
				   AND c.id IS NULL
				   ${taskId === undefined ? "" : "AND r.task_id = ?"}
				 ORDER BY r.started_at, r.id`,
			)
			.all(...(taskId === undefined ? [] : [taskId])) as unknown as { run_id: string }[];
		return rows.map((row) => row.run_id);
	}

	charge(input: ChargeBudgetInput): ChargeBudgetResult {
		const budgetId = nonEmpty(input.budgetId, "budgetId");
		const runId = nonEmpty(input.runId, "runId");
		const tokens = nonNegativeInteger(input.tokens ?? 0, "tokens");
		const cost = nonNegativeNumber(input.cost ?? 0, "cost");
		const wallTimeMs = nonNegativeInteger(input.wallTimeMs ?? 0, "wallTimeMs");
		try {
			return this.transaction.run(() => {
				const budget = this.get(budgetId);
				if (!budget) throw new ControlError("not_found", `budget ${budgetId} not found`);
				if (!this.database.prepare("SELECT id FROM runs WHERE id = ?").get(runId)) {
					throw new ControlError("not_found", `run ${runId} not found`);
				}
				const existing = this.getChargeByRun(runId);
				if (existing) {
					if (
						existing.budgetId !== budgetId ||
						existing.tokens !== tokens ||
						existing.cost !== cost ||
						existing.wallTimeMs !== wallTimeMs
					) {
						throw new ControlError("conflict", `run ${runId} already has a different budget charge`);
					}
					return { charge: existing, budget: this.get(budgetId)!, inserted: false };
				}
				const id = newId();
				const now = this.clock();
				this.database
					.prepare(
						"INSERT INTO budget_charges (id, budget_id, run_id, tokens, cost, wall_time_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					)
					.run(id, budgetId, runId, tokens, cost, wallTimeMs, now);
				this.database
					.prepare(
						"UPDATE budgets SET tokens_used = tokens_used + ?, cost_used = cost_used + ?, wall_time_used_ms = wall_time_used_ms + ? WHERE id = ?",
					)
					.run(tokens, cost, wallTimeMs, budgetId);
				return { charge: this.getChargeByRun(runId)!, budget: this.get(budgetId)!, inserted: true };
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}
}
