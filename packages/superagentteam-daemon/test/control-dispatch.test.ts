import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutor, DispatchExecutionRequest } from "../src/index.ts";
import {
	type AgentExecutionResult,
	createA2AHandlers,
	DispatchService,
	resolveRunPrincipal,
	routeSerial,
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

class ManualExecutor implements AgentExecutor {
	readonly started: string[] = [];
	readonly pending = new Map<
		string,
		{ resolve: (result: AgentExecutionResult) => void; reject: (error: Error) => void }
	>();
	active = 0;
	maxActive = 0;

	async execute(request: DispatchExecutionRequest, signal: AbortSignal): Promise<AgentExecutionResult> {
		this.started.push(request.run.id);
		this.active += 1;
		this.maxActive = Math.max(this.maxActive, this.active);
		return new Promise<AgentExecutionResult>((resolve, reject) => {
			const finish = (fn: () => void): void => {
				signal.removeEventListener("abort", abort);
				this.active -= 1;
				this.pending.delete(request.run.id);
				fn();
			};
			const abort = (): void => finish(() => reject(new Error("aborted")));
			signal.addEventListener("abort", abort, { once: true });
			this.pending.set(request.run.id, {
				resolve: (result) => finish(() => resolve(result)),
				reject: (error) => finish(() => reject(error)),
			});
		});
	}

	resolve(runId: string, bodyMd: string, toolCalls: readonly string[] = []): void {
		const pending = this.pending.get(runId);
		if (!pending) throw new Error(`run ${runId} is not pending`);
		pending.resolve({ bodyMd, toolCalls });
	}

	reject(runId: string, error: Error): void {
		const pending = this.pending.get(runId);
		if (!pending) throw new Error(`run ${runId} is not pending`);
		pending.reject(error);
	}
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for dispatch state");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function queueMessage(fixtureValue: W5AFixture, _targets: string[], body = "work") {
	return fixtureValue.store.messages.append({
		threadId: "thread-1",
		taskId: "task-1",
		authorKind: "user",
		authorId: "user-1",
		kind: "chat",
		bodyMd: body,
	});
}

describe("W5a dispatch queue adapter", () => {
	it("drains one queue entry into parallel runs with one response bubble per run", async () => {
		const base = fixture();
		const source = queueMessage(base, ["profile:reviewer-a", "profile:reviewer-b"]);
		const entry = base.store.queue.admit({
			threadId: "thread-1",
			sourceId: source.id,
			sourceKind: "conversation_input",
			targets: ["profile:reviewer-a", "profile:reviewer-b"],
			sourceCategory: "a2a",
			orderKey: "1",
		});
		const executor = new ManualExecutor();
		const service = new DispatchService(base.store, executor, base.now);
		service.requestDrain();
		const draining = service.drain();
		await waitFor(() => executor.started.length === 2);
		expect(executor.maxActive).toBe(2);
		for (const runId of executor.started) executor.resolve(runId, `done ${runId}`);
		const result = await draining;

		expect(result.errors).toEqual([]);
		expect(result.runs).toHaveLength(2);
		expect(base.store.queue.get(entry.id)).toBeNull();
		const reviewerRuns = base.store.runs
			.list({ taskId: "task-1" })
			.filter((run) => run.recipientProfileId.startsWith("profile:reviewer-"));
		expect(reviewerRuns).toHaveLength(2);
		expect(reviewerRuns.every((run) => run.status === "completed")).toBe(true);
		expect(reviewerRuns.every((run) => run.queueEntryId === entry.id)).toBe(true);
		const responseMessages = base.store.messages
			.listThread("thread-1")
			.filter((message) => message.kind === "agent_response");
		expect(responseMessages).toHaveLength(2);
		expect(responseMessages.every((message) => message.bodyMd.startsWith("done "))).toBe(true);
		const settledRefs = base.store.messages.get(source.id)?.dispatchRefs ?? [];
		expect(settledRefs).toHaveLength(2);
		expect(settledRefs.every((ref) => (ref as { phase?: string }).phase === "settled")).toBe(true);
		for (const run of reviewerRuns) {
			const events = base.store.runs.listEvents(run.id);
			expect(events).toHaveLength(2);
			expect(events[1]!.payload).toMatchObject({ phase: "terminal", status: "completed" });
		}
	});

	it("returns the committed terminal result and does not rewrite the response bubble", async () => {
		const base = fixture();
		const source = queueMessage(base, ["profile:reviewer-a"]);
		base.store.queue.admit({
			threadId: "thread-1",
			sourceId: source.id,
			sourceKind: "conversation_input",
			targets: ["profile:reviewer-a"],
			sourceCategory: "a2a",
			orderKey: "1",
		});
		const executor = new ManualExecutor();
		const service = new DispatchService(base.store, executor, base.now);
		const draining = service.drain();
		await waitFor(() => executor.started.length === 1);
		executor.resolve(executor.started[0]!, "final body");
		const result = await draining;
		const run = result.runs[0]!;
		const messageId = run.responseMessageId!;
		const before = base.store.messages.get(messageId)!;
		const eventCount = base.store.runs.listEvents(run.id).length;
		const again = service.settleRun(run.id, { status: "completed", bodyMd: "overwrite" });
		expect(again.status).toBe("completed");
		expect(base.store.messages.get(messageId)?.bodyMd).toBe(before.bodyMd);
		expect(base.store.runs.listEvents(run.id)).toHaveLength(eventCount);
		const settledRefs = base.store.messages.get(source.id)?.dispatchRefs ?? [];
		expect(settledRefs).toHaveLength(1);
		expect(settledRefs[0]).toMatchObject({ phase: "settled", targetId: "profile:reviewer-a" });
	});

	it("guides a live run through inbox without creating another run", async () => {
		const base = fixture();
		const source = queueMessage(base, ["profile:reviewer-a"]);
		base.store.queue.admit({
			threadId: "thread-1",
			sourceId: source.id,
			sourceKind: "conversation_input",
			targets: ["profile:reviewer-a"],
			sourceCategory: "a2a",
			orderKey: "1",
		});
		const executor = new ManualExecutor();
		const service = new DispatchService(base.store, executor, base.now);
		const draining = service.drain();
		await waitFor(() => executor.started.length === 1);
		const runId = executor.started[0]!;
		const inbox = service.guideRun({
			runId,
			kind: "steer",
			payload: { text: "focus on security" },
			actorRef: "operator:user-1",
		});
		expect(inbox.status).toBe("pending");
		expect(base.store.inbox.list({ taskId: "task-1" }).filter((item) => item.runId === runId)).toHaveLength(1);
		expect(base.store.runs.list({ taskId: "task-1" })).toHaveLength(1);
		executor.resolve(runId, "guided");
		await draining;
	});

	it("stops a live run as canceled and writes the terminal body", async () => {
		const base = fixture();
		const source = queueMessage(base, ["profile:reviewer-a"]);
		base.store.queue.admit({
			threadId: "thread-1",
			sourceId: source.id,
			sourceKind: "conversation_input",
			targets: ["profile:reviewer-a"],
			sourceCategory: "a2a",
			orderKey: "1",
		});
		const executor = new ManualExecutor();
		const service = new DispatchService(base.store, executor, base.now);
		const draining = service.drain();
		await waitFor(() => executor.started.length === 1);
		const runId = executor.started[0]!;
		const stopped = await service.stopRun(runId, "operator:user-1");
		expect(stopped.status).toBe("canceled");
		const message = base.store.messages.get(stopped.responseMessageId!)!;
		expect(message.bodyMd).toContain("canceled");
		await draining;
		expect(base.store.runs.get(runId)?.status).toBe("canceled");
		expect(base.store.runs.listEvents(runId).map((event) => event.payload)).toContainEqual(
			expect.objectContaining({ phase: "terminal", status: "canceled" }),
		);
	});

	it("interrupts with abort plus a new run and keeps canceled semantics", async () => {
		const base = fixture();
		const source = queueMessage(base, ["profile:reviewer-a"]);
		base.store.queue.admit({
			threadId: "thread-1",
			sourceId: source.id,
			sourceKind: "conversation_input",
			targets: ["profile:reviewer-a"],
			sourceCategory: "a2a",
			orderKey: "1",
		});
		const executor = new ManualExecutor();
		const service = new DispatchService(base.store, executor, base.now);
		const draining = service.drain();
		await waitFor(() => executor.started.length === 1);
		const firstRun = executor.started[0]!;
		const interrupted = await service.interruptRun(firstRun, "operator:user-1");
		expect(interrupted.canceledRun.status).toBe("canceled");
		expect(interrupted.retryQueueEntryId).not.toBeNull();
		await waitFor(() => executor.started.length === 2);
		const secondRun = executor.started[1]!;
		executor.resolve(secondRun, "retry done");
		await draining;
		expect(base.store.runs.get(firstRun)?.status).toBe("canceled");
		expect(base.store.runs.get(secondRun)?.status).toBe("completed");
	});

	it("withdraws queued targets and never drains a withdrawn entry", async () => {
		const base = fixture();
		const source = queueMessage(base, ["profile:reviewer-a", "profile:reviewer-b"]);
		const entry = base.store.queue.admit({
			threadId: "thread-1",
			sourceId: source.id,
			sourceKind: "conversation_input",
			targets: ["profile:reviewer-a", "profile:reviewer-b"],
			sourceCategory: "a2a",
			orderKey: "1",
		});
		const executor = new ManualExecutor();
		const service = new DispatchService(base.store, executor, base.now);
		const one = service.cancelQueued(entry.id, "operator:user-1", "profile:reviewer-a");
		expect(one.status).toBe("queued");
		expect(one.targets).toEqual(["profile:reviewer-b"]);
		const two = service.cancelQueued(entry.id, "operator:user-1", "profile:reviewer-b");
		expect(two.status).toBe("withdrawn");
		const drained = await service.drain();
		expect(drained.runs).toHaveLength(0);
		expect(base.store.runs.list({ taskId: "task-1" })).toHaveLength(0);
	});

	it("settles executor failure into a failed run with a response bubble", async () => {
		const base = fixture();
		const source = queueMessage(base, ["profile:reviewer-a"]);
		base.store.queue.admit({
			threadId: "thread-1",
			sourceId: source.id,
			sourceKind: "conversation_input",
			targets: ["profile:reviewer-a"],
			sourceCategory: "a2a",
			orderKey: "1",
		});
		const executor = new ManualExecutor();
		const service = new DispatchService(base.store, executor, base.now);
		const draining = service.drain();
		await waitFor(() => executor.started.length === 1);
		const runId = executor.started[0]!;
		executor.reject(runId, new Error("boom"));
		const result = await draining;
		expect(result.errors).toEqual([]);
		const run = base.store.runs.get(runId)!;
		expect(run.status).toBe("failed");
		const message = base.store.messages.get(run.responseMessageId!)!;
		expect(message.bodyMd).toContain("Execution failed");
	});

	it("returns one schema correction for missing A2A tool calls without routing", async () => {
		const base = fixture();
		const source = queueMessage(base, ["profile:reviewer-a"]);
		base.store.queue.admit({
			threadId: "thread-1",
			sourceId: source.id,
			sourceKind: "conversation_input",
			targets: ["profile:reviewer-a"],
			sourceCategory: "a2a",
			orderKey: "1",
		});
		const executor = new ManualExecutor();
		const service = new DispatchService(base.store, executor, base.now);
		const draining = service.drain();
		await waitFor(() => executor.started.length === 1);
		const runId = executor.started[0]!;
		executor.resolve(runId, "请 reviewer-a 看一下", []);
		const result = await draining;
		expect(result.outcomes[0]?.schemaCorrection).toContain("codeteam_a2a_send");
		expect(base.store.queue.listPending()).toHaveLength(0);
		expect(base.store.handoffs.list()).toHaveLength(0);
		const audit = base.store.audit
			.listSubject(`run:${runId}`)
			.filter((entry) => entry.action === "missing_a2a_tool_call");
		expect(audit).toHaveLength(1);
	});

	it("dead-letters a bad target instead of starving later queue entries", async () => {
		const base = fixture();
		base.store.profiles.create({
			id: "profile:no-session",
			role: "reviewer",
			displayName: "No Session",
			provider: "test",
			model: "model-reviewer",
			modelFamily: "test-family",
			toolPolicyProfile: "default",
		});
		const badSource = queueMessage(base, ["profile:no-session"], "bad");
		const badEntry = base.store.queue.admit({
			threadId: "thread-1",
			sourceId: badSource.id,
			sourceKind: "conversation_input",
			targets: ["profile:no-session"],
			sourceCategory: "a2a",
			orderKey: "1",
		});
		const goodSource = queueMessage(base, ["profile:reviewer-a"], "good");
		base.store.queue.admit({
			threadId: "thread-1",
			sourceId: goodSource.id,
			sourceKind: "conversation_input",
			targets: ["profile:reviewer-a"],
			sourceCategory: "a2a",
			orderKey: "2",
		});
		const executor = new ManualExecutor();
		const service = new DispatchService(base.store, executor, base.now);
		const draining = service.drain();
		await waitFor(() => executor.started.length === 1);
		executor.resolve(executor.started[0]!, "good done");
		const result = await draining;
		expect(base.store.queue.get(badEntry.id)?.status).toBe("withdrawn");
		expect(result.errors).toContainEqual(
			expect.objectContaining({
				queueEntryId: badEntry.id,
				targetProfileId: "profile:no-session",
				code: "invalid_state",
			}),
		);
		expect(base.store.runs.list({ taskId: "task-1" })).toHaveLength(1);
		expect(base.store.runs.list({ taskId: "task-1" })[0]?.status).toBe("completed");
	});

	it("keeps earlier good targets when a later target is poisoned", async () => {
		const base = fixture();
		base.store.profiles.create({
			id: "profile:no-session",
			role: "reviewer",
			displayName: "No Session",
			provider: "test",
			model: "model-reviewer",
			modelFamily: "test-family",
			toolPolicyProfile: "default",
		});
		const source = base.createSourceMessage("mixed targets");
		const entry = base.store.queue.admit({
			threadId: "thread-1",
			sourceId: source.id,
			sourceKind: "conversation_input",
			targets: ["profile:reviewer-a", "profile:no-session"],
			sourceCategory: "a2a",
			orderKey: "1",
		});
		const executor = new ManualExecutor();
		const service = new DispatchService(base.store, executor, base.now);
		const draining = service.drain();
		await waitFor(() => executor.started.length === 1);
		executor.resolve(executor.started[0]!, "good target done");
		const result = await draining;
		expect(base.store.queue.get(entry.id)?.status).toBe("withdrawn");
		expect(result.errors).toContainEqual(
			expect.objectContaining({
				queueEntryId: entry.id,
				targetProfileId: "profile:no-session",
				code: "invalid_state",
			}),
		);
		const runs = base.store.runs.list({ taskId: "task-1" });
		expect(runs).toHaveLength(1);
		expect(runs[0]?.recipientProfileId).toBe("profile:reviewer-a");
		expect(runs[0]?.status).toBe("completed");
	});

	it("persists A2A depth in run chain metadata", async () => {
		const base = fixture();
		const source = base.createSourceMessage();
		const sourceRun = base.createRun({
			id: "run-source-depth",
			profileId: "profile:coder",
			role: "coder",
			sessionId: "session-coder",
			sourceId: source.id,
			chainMetadata: { a2aDepth: 2 },
		});
		const handlers = createA2AHandlers({
			store: base.store,
			principal: resolveRunPrincipal(base.store, sourceRun.id),
			clock: base.now,
		});
		handlers.send({ kind: "question", targets: ["profile:reviewer-a"], bodyMd: "depth" });
		const executor = new ManualExecutor();
		const service = new DispatchService(base.store, executor, base.now);
		const draining = service.drain();
		await waitFor(() => executor.started.length === 1);
		executor.resolve(executor.started[0]!, "ok");
		await draining;
		const targetRun = base.store.runs.list({ taskId: "task-1" }).find((run) => run.id !== sourceRun.id)!;
		expect(targetRun.chainMetadata).toMatchObject({ a2aDepth: 3, parentRunId: sourceRun.id });
	});

	it("routes serial work in order", async () => {
		const order: number[] = [];
		const results = await routeSerial([1, 2, 3], async (value) => {
			order.push(value);
			return value * 2;
		});
		expect(order).toEqual([1, 2, 3]);
		expect(results).toEqual([2, 4, 6]);
	});
});
