import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentExecutor,
	BudgetService,
	ControlError,
	type DeploymentObservation,
	type DeploymentObserver,
	DeploymentWaitService,
	DispatchService,
} from "../src/index.ts";
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

function addSecondTask(base: W5AFixture) {
	base.store.tasks.create({
		id: "task-2",
		kind: "work",
		threadId: "thread-1",
		title: "W5d starvation guard",
		why: "W5d starvation guard",
		ownerProfileId: "profile:reviewer-a",
		createdBy: "user-1",
		userId: "user-1",
		backlogItemId: "backlog-1",
		worktree: base.dataDir,
	});
	base.store.sessions.create({
		id: "session-task-2",
		threadId: "thread-1",
		taskId: "task-2",
		profileId: "profile:reviewer-a",
		role: "reviewer",
		effectiveToolPolicy: "default",
		provider: "test",
		model: "model-reviewer",
		modelFamily: "test-family",
		seq: 0,
		userId: "user-1",
	});
}

function admitFor(base: W5AFixture, input: { taskId: string; body: string; orderKey: string; target: string }) {
	const source = base.store.messages.append({
		threadId: "thread-1",
		taskId: input.taskId,
		authorKind: "user",
		authorId: "user-1",
		kind: "chat",
		bodyMd: input.body,
	});
	return base.store.queue.admit({
		threadId: "thread-1",
		sourceId: source.id,
		sourceKind: "conversation_input",
		targets: [input.target],
		sourceCategory: "test",
		orderKey: input.orderKey,
	});
}

describe("W5d dispatch deferral does not starve the queue", () => {
	it("keeps draining past a budget-paused head entry", async () => {
		const base = fixture();
		addSecondTask(base);
		const budget = new BudgetService(base.store, base.now);
		budget.setLimits({ taskId: "task-1", tokensLimit: 0, actorRef: "user:user-1" });
		const paused = admitFor(base, { taskId: "task-1", body: "paused", orderKey: "1", target: "profile:coder" });
		const ready = admitFor(base, { taskId: "task-2", body: "ready", orderKey: "2", target: "profile:reviewer-a" });
		const service = new DispatchService(base.store, executor, base.now, {}, { budget });

		const result = await service.drain();

		expect(result.errors).toContainEqual(expect.objectContaining({ code: "budget_paused" }));
		expect(result.runs.map((run) => run.taskId)).toEqual(["task-2"]);
		expect(base.store.queue.get(paused.id)?.status).toBe("queued");
		expect(base.store.queue.get(ready.id)).toBeNull();
	});

	it("keeps draining past a deployment-wait head entry", async () => {
		const base = fixture();
		addSecondTask(base);
		const waiting = admitFor(base, { taskId: "task-1", body: "waiting", orderKey: "1", target: "profile:coder" });
		const ready = admitFor(base, { taskId: "task-2", body: "ready", orderKey: "2", target: "profile:reviewer-a" });
		const service = new DispatchService(
			base.store,
			executor,
			base.now,
			{},
			{
				deploymentWaitGuard: {
					assertCanStart(taskId: string) {
						if (taskId === "task-1") {
							throw new ControlError(
								"deployment_wait_pending",
								"deployment wait is still pending for task task-1",
							);
						}
					},
				},
			},
		);

		const result = await service.drain();

		expect(result.errors).toContainEqual(expect.objectContaining({ code: "deployment_wait_pending" }));
		expect(result.runs.map((run) => run.taskId)).toEqual(["task-2"]);
		expect(base.store.queue.get(waiting.id)?.status).toBe("queued");
		expect(base.store.queue.get(ready.id)).toBeNull();
	});
});

class StubObserver implements DeploymentObserver {
	observation: DeploymentObservation | null = {
		v: 1,
		subjectRef: `deployment:${"a".repeat(64)}:local`,
		bootId: "boot-1",
		bootSequence: 1,
		runningRevision: "a".repeat(40),
		readyServices: ["daemon"],
		observedAt: 1,
		inclusionProof: null,
	};

	subjectRef(): string {
		return `deployment:${"a".repeat(64)}:local`;
	}

	observe(): DeploymentObservation | null {
		return this.observation;
	}
}

describe("W5d dispatch defers a matched-but-undelivered wait", () => {
	it("keeps draining when delivery has not produced its queue entry yet", async () => {
		const base = fixture();
		addSecondTask(base);
		const observer = new StubObserver();
		const wait = new DeploymentWaitService(base.store, { observer, clock: base.now });
		wait.register({
			taskId: "task-1",
			predicate: { kind: "new_ready_boot", services: ["daemon"] },
			targetProfileIds: ["profile:coder"],
			actorRef: "user:user-1",
		});
		observer.observation = { ...observer.observation!, bootId: "boot-2", bootSequence: 2 };
		expect(wait.evaluate("task-1")?.status).toBe("matched");
		const waiting = admitFor(base, { taskId: "task-1", body: "matched", orderKey: "1", target: "profile:coder" });
		const ready = admitFor(base, { taskId: "task-2", body: "ready", orderKey: "2", target: "profile:reviewer-a" });
		const service = new DispatchService(base.store, executor, base.now, {}, { deploymentWaitGuard: wait });

		const result = await service.drain();

		expect(result.errors).toContainEqual(expect.objectContaining({ code: "deployment_wait_outcome_pending" }));
		expect(result.runs.map((run) => run.taskId)).toEqual(["task-2"]);
		expect(base.store.queue.get(waiting.id)?.status).toBe("queued");
		expect(base.store.queue.get(ready.id)).toBeNull();
	});
});
