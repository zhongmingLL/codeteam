import { afterEach, describe, expect, it } from "vitest";
import { type AgentExecutor, BudgetService, DispatchService } from "../src/index.ts";
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

const executor: AgentExecutor = {
	async execute() {
		return { bodyMd: "not used" };
	},
};

function runningRun(base: W5AFixture, id: string) {
	return base.store.runs.create({
		id,
		taskId: "task-1",
		role: "coder",
		agentSessionId: "session-coder",
		sourceId: base.createSourceMessage(id).id,
		recipientProfileId: "profile:coder",
		provider: "test",
		model: "model-coder",
		modelFamily: "test-family",
	});
}

describe("W5c dispatch budget settlement", () => {
	it("charges usage on terminal and pauses future admission", () => {
		const base = fixture();
		const budget = new BudgetService(base.store, base.now);
		budget.setLimits({ taskId: "task-1", tokensLimit: 100, actorRef: "user:user-1" });
		const service = new DispatchService(base.store, executor, base.now, {}, { budget });
		runningRun(base, "run-settled");
		service.settleRun("run-settled", {
			status: "completed",
			bodyMd: "done",
			usage: { tokens: 100 },
			actorRef: "system:test",
		});
		expect(budget.status("task-1").budget?.tokensUsed).toBe(100);
		expect(budget.status("task-1").paused).toBe(true);

		service.settleRun("run-settled", { status: "completed", usage: { tokens: 100 } });
		expect(budget.status("task-1").budget?.tokensUsed).toBe(100);
	});

	it("sweeps a terminal run that missed dispatch charging", () => {
		const base = fixture();
		const budget = new BudgetService(base.store, base.now);
		budget.setLimits({ taskId: "task-1", tokensLimit: 100, actorRef: "user:user-1" });
		const run = runningRun(base, "run-missed");
		base.store.runs.terminal(run.id, { status: "completed", usage: { tokens: 25 } });
		expect(budget.status("task-1").budget?.tokensUsed).toBe(0);
		expect(budget.sweep("task-1")).toHaveLength(1);
		expect(budget.status("task-1").budget?.tokensUsed).toBe(25);
	});

	it("defers a queued entry instead of starting a run for a paused task", async () => {
		const base = fixture();
		const budget = new BudgetService(base.store, base.now);
		budget.setLimits({ taskId: "task-1", tokensLimit: 0, actorRef: "user:user-1" });
		const source = base.createSourceMessage("paused wake");
		const entry = base.store.queue.admit({
			threadId: "thread-1",
			sourceId: source.id,
			sourceKind: "conversation_input",
			targets: ["profile:coder"],
			sourceCategory: "test",
			orderKey: "1",
		});
		const service = new DispatchService(base.store, executor, base.now, {}, { budget });
		const result = await service.drain();
		expect(result.runs).toHaveLength(0);
		expect(result.errors).toContainEqual(expect.objectContaining({ code: "budget_paused" }));
		expect(base.store.queue.get(entry.id)?.status).toBe("queued");
		expect(base.store.runs.list({ taskId: "task-1" })).toHaveLength(0);
		expect(
			base.store.audit.listSubject(`queue:${entry.id}`).some((item) => item.action === "dispatch_deferred"),
		).toBe(true);
	});
});
