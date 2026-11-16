import { afterEach, describe, expect, it } from "vitest";
import { BudgetService } from "../src/index.ts";
import { createW5AFixture, type W5AFixture } from "./helpers/w5a-fixture.ts";

const fixtures: W5AFixture[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function fixture(): W5AFixture {
	const created = createW5AFixture();
	fixtures.push(created);
	return created;
}

function completedRun(base: W5AFixture, input: { id: string; tokens?: number; cost?: number; wallTimeMs?: number }) {
	const source = base.createSourceMessage();
	const run = base.store.runs.create({
		id: input.id,
		taskId: "task-1",
		role: "coder",
		agentSessionId: "session-coder",
		sourceId: source.id,
		recipientProfileId: "profile:coder",
		provider: "test",
		model: "model-coder",
		modelFamily: "test-family",
		startedAt: base.now() - (input.wallTimeMs ?? 0),
	});
	return base.store.runs.terminal(run.id, {
		status: "completed",
		usage: {
			tokens: input.tokens ?? 0,
			cost: input.cost ?? 0,
			wallTimeMs: input.wallTimeMs ?? 0,
		},
	});
}

describe("W5c budget enforcement", () => {
	it("charges run usage idempotently and pauses at the first limit", () => {
		const base = fixture();
		const budget = new BudgetService(base.store, base.now);
		budget.setLimits({
			taskId: "task-1",
			tokensLimit: 100,
			costLimit: 1,
			wallTimeLimitMs: 1_000,
			actorRef: "user:user-1",
		});

		const first = completedRun(base, { id: "run-first", tokens: 60, cost: 0.5, wallTimeMs: 600 });
		const firstCharge = budget.chargeRun(first.id)!;
		expect(firstCharge.inserted).toBe(true);
		expect(firstCharge.status.budget?.tokensUsed).toBe(60);
		expect(firstCharge.status.paused).toBe(false);

		const second = completedRun(base, { id: "run-second", tokens: 40, cost: 0.5, wallTimeMs: 400 });
		const secondCharge = budget.chargeRun(second.id)!;
		expect(secondCharge.inserted).toBe(true);
		expect(secondCharge.status.budget?.tokensUsed).toBe(100);
		expect(secondCharge.status.limitsHit).toEqual(["tokens", "cost", "wall_time"]);
		expect(secondCharge.status.paused).toBe(true);
		expect(secondCharge.status.pauseApprovalId).toBeTruthy();

		const replay = budget.chargeRun(second.id)!;
		expect(replay.inserted).toBe(false);
		expect(replay.status.budget?.tokensUsed).toBe(100);
		expect(base.store.approvals.list({ taskId: "task-1", kind: "budget_pause" })).toHaveLength(1);
	});

	it("keeps a paused task blocked until limits are raised, then reopens admission", () => {
		const base = fixture();
		const budget = new BudgetService(base.store, base.now);
		budget.setLimits({ taskId: "task-1", tokensLimit: 10, actorRef: "user:user-1" });
		completedRun(base, { id: "run-over", tokens: 10 });
		budget.chargeRun("run-over");
		base.store.backlog.approve("backlog-1", "user-1");

		expect(() =>
			base.store.dispatchBacklog({
				backlogItemId: "backlog-1",
				targets: ["profile:coder"],
				threadPhase: "coding",
			}),
		).toThrowError(expect.objectContaining({ code: "budget_paused" }));

		const raised = budget.setLimits({ taskId: "task-1", tokensLimit: 20, actorRef: "user:user-1" });
		expect(raised.limitsHit).toEqual([]);
		expect(raised.paused).toBe(false);
		const approvals = base.store.approvals.list({ taskId: "task-1", kind: "budget_pause" });
		expect(approvals[0]?.resolution).toBe("closed_without_decision");
	});

	it("does not enforce a budget that was never configured", () => {
		const base = fixture();
		const run = completedRun(base, { id: "run-unbudgeted", tokens: 999 });
		expect(new BudgetService(base.store, base.now).chargeRun(run.id)).toBeNull();
	});

	it("sweeps terminal runs that missed a charge without double-counting", () => {
		const base = fixture();
		const budget = new BudgetService(base.store, base.now);
		budget.setLimits({ taskId: "task-1", tokensLimit: 100, actorRef: "user:user-1" });
		completedRun(base, { id: "run-sweep-1", tokens: 10 });
		completedRun(base, { id: "run-sweep-2", tokens: 20 });

		const swept = budget.sweep("task-1");
		expect(swept).toHaveLength(2);
		expect(budget.status("task-1").budget?.tokensUsed).toBe(30);
		expect(budget.sweep("task-1")).toHaveLength(0);
	});
});
