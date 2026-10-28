import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import { budgetLimitsHit } from "../control/stores/budgets.ts";
import type { Budget, BudgetCharge, BudgetLimitKind, Run } from "../control/stores/types.ts";

export interface BudgetStatus {
	readonly budget: Budget | null;
	readonly charges: readonly BudgetCharge[];
	readonly limitsHit: readonly BudgetLimitKind[];
	readonly paused: boolean;
	readonly pauseApprovalId: string | null;
}

export interface SetBudgetLimitsInput {
	readonly taskId: string;
	readonly tokensLimit?: number | null;
	readonly costLimit?: number | null;
	readonly wallTimeLimitMs?: number | null;
	readonly actorRef: string;
}

export interface ChargeRunResult {
	readonly charge: BudgetCharge;
	readonly status: BudgetStatus;
	readonly inserted: boolean;
}

interface UsageNumbers {
	readonly tokens: number;
	readonly cost: number;
	readonly wallTimeMs: number;
}

function usageNumber(usage: Record<string, unknown> | null, keys: readonly string[]): number | undefined {
	if (!usage) return undefined;
	for (const key of keys) {
		const value = usage[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	}
	return undefined;
}

function usageNumbers(run: Run, now: number): UsageNumbers {
	const usage = run.usage;
	const tokenParts = [
		usageNumber(usage, ["tokens", "totalTokens", "total_tokens"]),
		usageNumber(usage, ["inputTokens", "input_tokens"]),
		usageNumber(usage, ["outputTokens", "output_tokens"]),
	];
	const tokens = tokenParts[0] ?? (tokenParts[1] ?? 0) + (tokenParts[2] ?? 0);
	const cost = usageNumber(usage, ["cost", "costUsd", "cost_usd"]) ?? 0;
	const terminalAt = run.terminalAt ?? now;
	const wallTimeMs = usageNumber(usage, ["wallTimeMs", "wall_time_ms"]) ?? Math.max(0, terminalAt - run.startedAt);
	return { tokens, cost, wallTimeMs };
}

export class BudgetService {
	private readonly store: ControlStore;
	private readonly clock: () => number;

	constructor(store: ControlStore, clock: () => number = Date.now) {
		this.store = store;
		this.clock = clock;
	}

	status(taskId: string): BudgetStatus {
		const budgets = this.store.budgets.listByTask(taskId);
		if (budgets.length > 1) {
			throw new ControlError("invalid_state", `task ${taskId} has ambiguous budgets`);
		}
		const budget = budgets[0] ?? null;
		if (!budget) {
			return { budget: null, charges: [], limitsHit: [], paused: false, pauseApprovalId: null };
		}
		const limitsHit = budgetLimitsHit(budget);
		const openPause = this.store.approvals.list({ taskId, kind: "budget_pause", resolution: "open" })[0] ?? null;
		return {
			budget,
			charges: this.store.budgets.listCharges(budget.id),
			limitsHit,
			paused: limitsHit.length > 0 || openPause !== null,
			pauseApprovalId: openPause?.id ?? null,
		};
	}

	setLimits(input: SetBudgetLimitsInput): BudgetStatus {
		return this.store.transaction.run(() => {
			const task = this.store.tasks.get(input.taskId);
			if (!task) throw new ControlError("not_found", `task ${input.taskId} not found`);
			const existing = this.store.budgets.getByTask(input.taskId);
			const budget = existing
				? this.store.budgets.updateLimits({
						taskId: input.taskId,
						tokensLimit: input.tokensLimit,
						costLimit: input.costLimit,
						wallTimeLimitMs: input.wallTimeLimitMs,
					})
				: this.store.budgets.create({
						taskId: input.taskId,
						tokensLimit: input.tokensLimit ?? null,
						costLimit: input.costLimit ?? null,
						wallTimeLimitMs: input.wallTimeLimitMs ?? null,
					});
			const status = this.status(input.taskId);
			if (status.limitsHit.length === 0) {
				for (const approval of this.store.approvals.list({
					taskId: input.taskId,
					kind: "budget_pause",
					resolution: "open",
				})) {
					this.store.approvals.decide(approval.id, {
						resolution: "closed_without_decision",
						decidedBy: input.actorRef,
						note: "budget_limits_raised",
					});
				}
			}
			this.store.audit.append({
				actor: input.actorRef,
				action: "budget_limits_set",
				subject: `task:${input.taskId}`,
				args: {
					budgetId: budget.id,
					tokensLimit: budget.tokensLimit,
					costLimit: budget.costLimit,
					wallTimeLimitMs: budget.wallTimeLimitMs,
				},
			});
			return this.status(input.taskId);
		});
	}

	chargeRun(runId: string): ChargeRunResult | null {
		const run = this.store.runs.get(runId);
		if (!run) throw new ControlError("not_found", `run ${runId} not found`);
		if (run.status === "running") {
			throw new ControlError("invalid_state", `run ${runId} is still running`);
		}
		const budget = this.store.budgets.getByTask(run.taskId);
		if (!budget) return null;
		const usage = usageNumbers(run, this.clock());
		const result = this.store.budgets.charge({
			budgetId: budget.id,
			runId,
			tokens: usage.tokens,
			cost: usage.cost,
			wallTimeMs: usage.wallTimeMs,
		});
		const status = this.status(run.taskId);
		const pause = status.paused ? this.ensurePauseApproval(run.taskId, budget.id, status.limitsHit, run.id) : null;
		if (result.inserted) {
			this.store.audit.append({
				actor: "system:budget",
				action: "budget_charged",
				subject: `run:${run.id}`,
				args: {
					budgetId: budget.id,
					tokens: usage.tokens,
					cost: usage.cost,
					wallTimeMs: usage.wallTimeMs,
					limitsHit: status.limitsHit,
					pauseApprovalId: pause?.id ?? status.pauseApprovalId,
				},
			});
		}
		return { charge: result.charge, status: this.status(run.taskId), inserted: result.inserted };
	}

	sweep(taskId?: string): ChargeRunResult[] {
		const results: ChargeRunResult[] = [];
		for (const runId of this.store.budgets.listUnchargedTerminalRunIds(taskId)) {
			const charged = this.chargeRun(runId);
			if (charged) results.push(charged);
		}
		return results;
	}

	private ensurePauseApproval(
		taskId: string,
		budgetId: string,
		limitsHit: readonly BudgetLimitKind[],
		runId: string,
	): { id: string } | null {
		const open = this.store.approvals.list({ taskId, kind: "budget_pause", resolution: "open" })[0];
		if (open) return open;
		const task = this.store.tasks.get(taskId);
		if (!task) throw new ControlError("not_found", `task ${taskId} not found`);
		const prior = this.store.approvals.list({ taskId, kind: "budget_pause" }).length;
		const approval = this.store.approvals.create({
			threadId: task.threadId,
			taskId,
			kind: "budget_pause",
			idempotencyKey: `budget-pause:${taskId}:${budgetId}:${prior + 1}`,
			originRef: { kind: "budget", taskId, budgetId, limitsHit },
			cardRef: { kind: "budget_pause", taskId },
			payload: { taskId, budgetId, limitsHit, triggeredByRunId: runId },
			requestedBy: "system:budget",
		});
		this.store.audit.append({
			actor: "system:budget",
			action: "budget_paused",
			subject: `task:${taskId}`,
			args: { budgetId, limitsHit, approvalId: approval.id, runId },
		});
		return approval;
	}
}
