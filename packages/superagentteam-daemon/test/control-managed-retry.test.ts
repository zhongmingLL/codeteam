import { afterEach, describe, expect, it } from "vitest";
import { type AgentExecutor, DispatchService, ManagedWorkService } from "../src/index.ts";
import { createW5AFixture, type W5AFixture } from "./helpers/w5a-fixture.ts";
import { addCoderProfile, seedWork } from "./helpers/w5d-fixture.ts";

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
		return { bodyMd: "retry done" };
	},
};

function queueWake(base: W5AFixture, target: string, body: string) {
	const source = base.store.messages.append({
		threadId: "thread-1",
		taskId: "task-1",
		authorKind: "user",
		authorId: "user-1",
		kind: "chat",
		bodyMd: body,
	});
	return base.store.queue.admit({
		threadId: "thread-1",
		sourceId: source.id,
		sourceKind: "conversation_input",
		targets: [target],
		sourceCategory: "test",
		orderKey: source.id,
	});
}

describe("W5d managed-work sticky retry", () => {
	it("consumes a conflicting retry target and blocks the operator without starting a run", async () => {
		const base = fixture();
		const identity = seedWork(base);
		base.store.work.bindAttempt(identity.attemptId, "profile:coder");
		const other = addCoderProfile(base);
		const entry = queueWake(base, other.profileId, "retry with another profile");
		const dispatch = new DispatchService(
			base.store,
			executor,
			base.now,
			{},
			{
				managedWork: new ManagedWorkService(base.store),
			},
		);
		const result = await dispatch.drain();
		expect(result.runs).toHaveLength(0);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "managed_work_executor_conflict", targetProfileId: other.profileId }),
		);
		expect(base.store.queue.get(entry.id)?.status).toBe("withdrawn");
		expect(base.store.runs.list({ taskId: "task-1" })).toHaveLength(0);
		const inbox = base.store.inbox.list({ taskId: "task-1" });
		expect(inbox).toHaveLength(1);
		expect(inbox[0]?.payload).toMatchObject({
			kind: "managed_work_binding_conflict",
			boundProfileId: "profile:coder",
			requestedProfileId: other.profileId,
		});
		expect(
			base.store.audit.listSubject("task:task-1").some((entry) => entry.action === "work_binding_conflict"),
		).toBe(true);
	});

	it("starts a retry with the bound profile and persists the run binding", async () => {
		const base = fixture();
		const identity = seedWork(base);
		base.store.work.bindAttempt(identity.attemptId, "profile:coder");
		const entry = queueWake(base, "profile:coder", "retry with bound profile");
		const dispatch = new DispatchService(
			base.store,
			executor,
			base.now,
			{},
			{
				managedWork: new ManagedWorkService(base.store),
			},
		);
		const result = await dispatch.drain();
		expect(result.errors).toEqual([]);
		expect(result.runs).toHaveLength(1);
		expect(base.store.queue.get(entry.id)).toBeNull();
		const run = result.runs[0]!;
		expect(base.store.work.getRunBinding(run.id)).toMatchObject(identity);
		expect(base.store.runs.get(run.id)?.status).toBe("completed");
	});
});
