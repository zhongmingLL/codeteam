import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentExecutor,
	type DeploymentObservation,
	DeploymentObservationService,
	type DeploymentObserver,
	DeploymentWaitService,
	DispatchService,
	readBootLedger,
	startDaemon,
} from "../src/index.ts";
import { createW5AFixture, type W5AFixture } from "./helpers/w5a-fixture.ts";

const fixtures: W5AFixture[] = [];
const dirs: string[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): W5AFixture {
	const created = createW5AFixture();
	fixtures.push(created);
	return created;
}

class FakeObserver implements DeploymentObserver {
	subject = `deployment:${"a".repeat(64)}:local`;
	observation: DeploymentObservation | null = observation({});

	subjectRef(): string {
		return this.subject;
	}

	observe(): DeploymentObservation | null {
		return this.observation;
	}
}

function observation(overrides: Partial<DeploymentObservation>): DeploymentObservation {
	return {
		v: 1,
		subjectRef: `deployment:${"a".repeat(64)}:local`,
		bootId: "boot-1",
		bootSequence: 1,
		runningRevision: "a".repeat(40),
		readyServices: ["daemon"],
		observedAt: 1_700_000_000_000,
		inclusionProof: null,
		...overrides,
	};
}

function service(base: W5AFixture, observer: FakeObserver): DeploymentWaitService {
	return new DeploymentWaitService(base.store, { observer, clock: base.now });
}

const executor: AgentExecutor = {
	async execute() {
		return { bodyMd: "started after deployment wait" };
	},
};

describe("W5d deployment wait", () => {
	it("registers on the original Task, matches a new ready boot, and delivers once", () => {
		const base = fixture();
		const observer = new FakeObserver();
		const wait = service(base, observer);
		const state = wait.register({
			taskId: "task-1",
			predicate: { kind: "new_ready_boot", services: ["daemon"] },
			targetProfileIds: ["profile:coder"],
			actorRef: "user:user-1",
		});
		expect(state.status).toBe("waiting");
		expect(state.baseline.bootSequence).toBe(1);
		expect(base.store.tasks.get("task-1")?.deploymentWait).toMatchObject({ v: 1, status: "waiting" });

		observer.observation = observation({ bootId: "boot-2", bootSequence: 2 });
		const sweep = wait.sweep();
		expect(sweep.matched).toEqual(["task-1"]);
		expect(sweep.delivered).toEqual(["task-1"]);
		const delivered = wait.projection("task-1").state;
		expect(delivered?.status).toBe("matched");
		expect(delivered?.outcome).toMatchObject({ delivery: "delivered" });
		const entry = base.store.queue.get(delivered?.outcome?.queueEntryId ?? "");
		expect(entry).toMatchObject({
			targets: ["profile:coder"],
			sourceKind: "message_wake",
			sourceCategory: "deployment_wait",
		});
		expect(base.store.runs.list({ taskId: "task-1" })).toHaveLength(0);

		const replay = wait.sweep();
		expect(replay.delivered).toEqual([]);
		expect(base.store.queue.listPending()).toHaveLength(1);
		expect(() => wait.assertCanStart("task-1")).not.toThrow();
	});

	it("matches revision_included only on the exact running build sha", () => {
		const base = fixture();
		const observer = new FakeObserver();
		const wait = service(base, observer);
		wait.register({
			taskId: "task-1",
			predicate: { kind: "revision_included", revision: "b".repeat(40), services: ["daemon"] },
			targetProfileIds: ["profile:coder"],
			actorRef: "user:user-1",
		});
		expect(wait.evaluate("task-1")?.status).toBe("waiting");
		observer.observation = observation({ runningRevision: "b".repeat(40) });
		expect(wait.evaluate("task-1")?.status).toBe("matched");
	});

	it("keeps waiting on unknown or wrong-deployment observations and enforces start guard", () => {
		const base = fixture();
		const observer = new FakeObserver();
		const wait = service(base, observer);
		wait.register({
			taskId: "task-1",
			predicate: { kind: "new_ready_boot", services: ["daemon"] },
			targetProfileIds: ["profile:coder"],
			actorRef: "user:user-1",
		});
		expect(() => wait.assertCanStart("task-1")).toThrowError(
			expect.objectContaining({ code: "deployment_wait_pending" }),
		);
		observer.observation = null;
		expect(wait.evaluate("task-1")?.status).toBe("waiting");
		observer.observation = observation({
			subjectRef: `deployment:${"c".repeat(64)}:local`,
			bootSequence: 2,
			bootId: "boot-2",
		});
		expect(wait.evaluate("task-1")?.status).toBe("waiting");

		observer.observation = observation({ bootSequence: 2, bootId: "boot-2" });
		const matched = wait.evaluate("task-1");
		expect(matched?.status).toBe("matched");
		expect(() => wait.assertCanStart("task-1")).toThrowError(
			expect.objectContaining({ code: "deployment_wait_outcome_pending" }),
		);
		wait.deliver("task-1");
		expect(() => wait.assertCanStart("task-1")).not.toThrow();
	});

	it("is idempotent for the same wait and rejects a different wait on the same task", () => {
		const base = fixture();
		const observer = new FakeObserver();
		const wait = service(base, observer);
		const first = wait.register({
			taskId: "task-1",
			predicate: { kind: "new_ready_boot", services: ["daemon"] },
			targetProfileIds: ["profile:coder"],
			actorRef: "user:user-1",
		});
		expect(
			wait.register({
				taskId: "task-1",
				predicate: { kind: "new_ready_boot", services: ["daemon"] },
				targetProfileIds: ["profile:coder"],
				actorRef: "user:user-1",
			}).registeredAt,
		).toBe(first.registeredAt);
		expect(() =>
			wait.register({
				taskId: "task-1",
				predicate: { kind: "new_ready_boot", services: ["web"] },
				targetProfileIds: ["profile:coder"],
				actorRef: "user:user-1",
			}),
		).toThrowError(expect.objectContaining({ code: "deployment_wait_conflict" }));
	});

	it("does not create a second wait table", () => {
		const base = fixture();
		const tables = (
			base.store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as {
				name: string;
			}[]
		).map((row) => row.name);
		expect(tables).not.toContain("deployment_waits");
	});

	it("blocks a queued run while waiting and allows it after delivery", async () => {
		const base = fixture();
		const observer = new FakeObserver();
		const wait = service(base, observer);
		wait.register({
			taskId: "task-1",
			predicate: { kind: "new_ready_boot", services: ["daemon"] },
			targetProfileIds: ["profile:coder"],
			actorRef: "user:user-1",
		});
		const source = base.createSourceMessage("wait for deployment");
		const entry = base.store.queue.admit({
			threadId: "thread-1",
			sourceId: source.id,
			sourceKind: "conversation_input",
			targets: ["profile:coder"],
			sourceCategory: "test",
			orderKey: "1",
		});
		const dispatch = new DispatchService(base.store, executor, base.now, {}, { deploymentWaitGuard: wait });
		const blocked = await dispatch.drain();
		expect(blocked.runs).toHaveLength(0);
		expect(blocked.errors).toContainEqual(expect.objectContaining({ code: "deployment_wait_pending" }));
		expect(base.store.queue.get(entry.id)?.status).toBe("queued");

		observer.observation = observation({ bootId: "boot-2", bootSequence: 2 });
		wait.sweep();
		const started = await dispatch.drain();
		expect(started.errors).toEqual([]);
		expect(started.runs.length).toBeGreaterThanOrEqual(1);
	});

	it("observes a real daemon boot/ready/exit and reports unknown after stop", async () => {
		const root = mkdtempSync(join(tmpdir(), "codeteam-deployment-wait-"));
		dirs.push(root);
		const dataDir = join(root, "data");
		const installationRoot = join(root, "install");
		mkdirSync(installationRoot);
		const daemon = await startDaemon({
			installationRoot,
			dataDir,
			deploymentId: "local",
			runningRevision: "a".repeat(40),
			services: ["daemon"],
		});
		daemon.markReady();
		const observer = new DeploymentObservationService({ dataDir, installationRoot, deploymentId: "local" });
		const observed = observer.observe();
		expect(observed).toMatchObject({
			bootId: daemon.boot.bootId,
			bootSequence: 1,
			runningRevision: "a".repeat(40),
			readyServices: ["daemon"],
			subjectRef: `deployment:${daemon.boot.installationId}:local`,
		});
		await daemon.stop();
		expect(observer.observe()).toBeNull();
		expect(readBootLedger(join(dataDir, "boot-ledger.jsonl")).some((record) => record.event === "exited")).toBe(true);
	});
});

describe("W5d deployment wait operator cancel", () => {
	it("clears an unmatched wait so the task can start, and is idempotent", () => {
		const base = fixture();
		const observer = new FakeObserver();
		const wait = service(base, observer);
		const registered = wait.register({
			taskId: "task-1",
			predicate: { kind: "revision_included", revision: "b".repeat(40), services: ["daemon"] },
			targetProfileIds: ["profile:coder"],
			actorRef: "user:user-1",
		});
		expect(() => wait.assertCanStart("task-1")).toThrow(/deployment wait is still pending/);

		const canceled = wait.cancel({
			taskId: "task-1",
			actorRef: "operator:user-1",
			reason: "wrong sha after rollback",
		});
		expect(canceled?.status).toBe("terminal");
		expect(() => wait.assertCanStart("task-1")).not.toThrow();
		expect(wait.cancel({ taskId: "task-1", actorRef: "operator:user-1", reason: "again" })).toMatchObject({
			status: "terminal",
			generation: registered.generation,
		});
		const audit = base.store.audit
			.listSubject("task:task-1")
			.filter((item) => item.action === "deployment_wait_canceled");
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({ actor: "operator:user-1" });
	});

	it("rejects non-operator actors and empty reasons", () => {
		const base = fixture();
		const observer = new FakeObserver();
		const wait = service(base, observer);
		wait.register({
			taskId: "task-1",
			predicate: { kind: "new_ready_boot", services: ["daemon"] },
			targetProfileIds: ["profile:coder"],
			actorRef: "user:user-1",
		});
		expect(() => wait.cancel({ taskId: "task-1", actorRef: "system:dispatch", reason: "nope" })).toThrow(
			/operator principal/,
		);
		expect(() => wait.cancel({ taskId: "task-1", actorRef: "operator:user-1", reason: "  " })).toThrow(
			/reason is required/,
		);
		expect(wait.projection("task-1").state?.status).toBe("waiting");
	});

	it("allows a fresh generation after cancel but not after delivery", () => {
		const base = fixture();
		const observer = new FakeObserver();
		const wait = service(base, observer);
		const first = wait.register({
			taskId: "task-1",
			predicate: { kind: "revision_included", revision: "b".repeat(40), services: ["daemon"] },
			targetProfileIds: ["profile:coder"],
			actorRef: "user:user-1",
		});
		wait.cancel({ taskId: "task-1", actorRef: "operator:user-1", reason: "wrong sha" });
		const second = wait.register({
			taskId: "task-1",
			predicate: { kind: "revision_included", revision: "c".repeat(40), services: ["daemon"] },
			targetProfileIds: ["profile:coder"],
			actorRef: "user:user-1",
		});
		expect(second.generation).toBe(first.generation + 1);
		expect(second.status).toBe("waiting");
		expect(() => wait.assertCanStart("task-1")).toThrow(/still pending/);

		observer.observation = observation({ runningRevision: "c".repeat(40) });
		expect(wait.sweep(base.now()).delivered).toEqual(["task-1"]);
		expect(wait.projection("task-1").state?.status).toBe("matched");
		expect(() => wait.assertCanStart("task-1")).not.toThrow();
		expect(wait.cancel({ taskId: "task-1", actorRef: "operator:user-1", reason: "late cancel" })?.status).toBe(
			"terminal",
		);
		expect(() =>
			wait.register({
				taskId: "task-1",
				predicate: { kind: "new_ready_boot", services: ["daemon"] },
				targetProfileIds: ["profile:coder"],
				actorRef: "user:user-1",
			}),
		).toThrow(/already delivered/);
	});
});
