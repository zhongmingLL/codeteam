import { afterEach, describe, expect, it } from "vitest";
import { BudgetService, ProactiveScheduleService } from "../src/index.ts";
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

function timerSpec(base: W5AFixture) {
	const service = new ProactiveScheduleService(base.store, { maxCatchUp: 2 }, base.now);
	const spec = service.register({
		taskId: "task-1",
		threadId: "thread-1",
		factoryId: "task_wake",
		trigger: { kind: "timer", everyMs: 1_000, firstRunAt: base.now() },
		admission: { targets: ["profile:coder"], priority: "urgent" },
		runSpec: { bodyMd: "scheduled wake" },
	});
	return { service, spec };
}

describe("W5c F139 proactive schedule adapter", () => {
	it("materializes a timer occurrence as one Queue Entry and never starts a run directly", () => {
		const base = fixture();
		const { service, spec } = timerSpec(base);
		const result = service.tick(base.now());

		expect(result.materialized).toHaveLength(1);
		expect(base.store.runs.list({ taskId: "task-1" })).toHaveLength(0);
		const runs = base.store.schedules.listRuns(spec.id);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ status: "queued", scheduledFor: base.now() });
		const entry = base.store.queue.get(runs[0]!.queueEntryId!);
		expect(entry).toMatchObject({
			priority: "urgent",
			sourceKind: "message_wake",
			sourceCategory: "proactive_schedule:task_wake",
			targets: ["profile:coder"],
		});
		expect(base.store.messages.get(runs[0]!.sourceMessageId!)?.bodyMd).toBe("scheduled wake");

		expect(service.tick(base.now()).materialized).toHaveLength(0);
	});

	it("dedupes an occurrence and caps catch-up instead of storming", () => {
		const base = fixture();
		const { service, spec } = timerSpec(base);
		service.tick(base.now());
		const duplicate = service.materialize(spec.id, {
			occurrenceKey: `${spec.id}:${base.now()}`,
			scheduledFor: base.now(),
		});
		expect(duplicate.status).toBe("duplicate");

		const catchUp = service.tick(base.now() + 5_000);
		expect(catchUp.materialized).toHaveLength(2);
		expect(base.store.schedules.listRuns(spec.id)).toHaveLength(3);
		expect(base.store.schedules.get(spec.id)?.state.nextRunAt).toBe(base.now() + 3_000);
	});

	it("records skipped occurrences when paused, unready, or unknown-factory", () => {
		const base = fixture();
		const { service, spec } = timerSpec(base);
		service.pause(spec.id, "user:user-1");
		const paused = service.materialize(spec.id, { occurrenceKey: "paused-1", scheduledFor: base.now() });
		expect(paused.status).toBe("skipped");
		expect(paused.run.reason).toMatchObject({ code: "schedule_paused" });

		service.resume(spec.id, "user:user-1", base.now());
		new BudgetService(base.store, base.now).setLimits({
			taskId: "task-1",
			tokensLimit: 0,
			actorRef: "user:user-1",
		});
		const unready = service.materialize(spec.id, { occurrenceKey: "unready-1", scheduledFor: base.now() });
		expect(unready.status).toBe("skipped");
		expect(unready.run.reason).toMatchObject({ code: "task_not_ready" });

		expect(() =>
			service.register({
				taskId: "task-1",
				threadId: "thread-1",
				factoryId: "unknown_factory",
				trigger: { kind: "manual" },
				admission: { targets: ["profile:coder"], priority: "normal" },
				runSpec: { bodyMd: "x" },
			}),
		).toThrowError(expect.objectContaining({ code: "schedule_unknown_factory" }));
	});

	it("keeps manual schedules inert until explicitly materialized", () => {
		const base = fixture();
		const service = new ProactiveScheduleService(base.store, {}, base.now);
		const spec = service.register({
			taskId: "task-1",
			threadId: "thread-1",
			factoryId: "task_wake",
			trigger: { kind: "manual" },
			admission: { targets: ["profile:coder"], priority: "normal" },
			runSpec: { bodyMd: "manual wake" },
		});
		expect(service.tick(base.now()).materialized).toHaveLength(0);
		const manual = service.materialize(spec.id, { occurrenceKey: "manual-1", scheduledFor: base.now() });
		expect(manual.status).toBe("queued");
		expect(base.store.queue.get(manual.queueEntryId!)).not.toBeNull();
	});

	it("does not create a second schedule queue table", () => {
		const base = fixture();
		const tables = (
			base.store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as {
				name: string;
			}[]
		).map((row) => row.name);
		expect(tables.filter((name) => name.includes("schedule") && name.includes("queue"))).toEqual([]);
	});
});
