import { describe, expect, it } from "vitest";
import { ManualClock } from "./clock.ts";
import { ControlPlane } from "./control-plane.ts";
import { ControlPlaneError } from "./errors.ts";
import { SqliteControlStore } from "./sqlite-store.ts";

function createPlane(store: SqliteControlStore) {
	return new ControlPlane({
		clock: new ManualClock(1_000),
		store,
		loopLimit: 2,
		defaultDeadlineMs: 100,
	});
}

function createHandoff(plane: ControlPlane, subject = "review-diff-1") {
	return plane.createHandoff({
		taskId: "task-1",
		kind: "review_request",
		fromRole: "coder",
		toRole: "reviewer",
		subject,
		actionPair: "coder->reviewer:review",
		expectedArtifact: "diff",
	});
}

describe("sqlite control store", () => {
	it("restores terminal handoff and run state across control-plane instances", () => {
		const store = new SqliteControlStore(":memory:");
		const plane = createPlane(store);
		plane.createTask("task-1", "implement");
		plane.createRun("run-1", "task-1", "coder");
		const item = createHandoff(plane);
		plane.claim(item.id, "run-1");
		plane.complete(item.id, "run-1", { verdict: "approve" });

		const restored = createPlane(store);
		expect(restored.getTask("task-1").stage).toBe("implement");
		expect(restored.getRun("run-1").status).toBe("completed");
		const restoredHandoff = restored.getHandoff(item.id);
		expect(restoredHandoff.status).toBe("consumed");
		expect(restoredHandoff.attempt).toBe(1);
		expect(restoredHandoff.result).toEqual({ verdict: "approve" });
		expect(restoredHandoff.terminalAt).toBe(1_000);

		store.close();
	});

	it("restores an interrupted run as a pending, reclaimable handoff", () => {
		const store = new SqliteControlStore(":memory:");
		const plane = createPlane(store);
		plane.createTask("task-1", "implement");
		plane.createRun("run-1", "task-1", "coder");
		plane.createRun("run-2", "task-1", "coder");
		const item = createHandoff(plane);
		plane.claim(item.id, "run-1");
		plane.finishRun("run-1", "interrupted");

		const restored = createPlane(store);
		expect(restored.getRun("run-1").status).toBe("interrupted");
		expect(restored.getHandoff(item.id).status).toBe("pending");
		expect(restored.getHandoff(item.id).claimedByRunId).toBeUndefined();
		expect(restored.claim(item.id, "run-2").replayed).toBe(false);
		expect(restored.getHandoff(item.id).claimedByRunId).toBe("run-2");

		store.close();
	});

	it("rebuilds loop-guard counts from persisted handoffs", () => {
		const store = new SqliteControlStore(":memory:");
		const plane = createPlane(store);
		plane.createTask("task-1", "implement");
		createHandoff(plane);
		createHandoff(plane);

		const restored = createPlane(store);
		expect(() => createHandoff(restored)).toThrowError(ControlPlaneError);
		try {
			createHandoff(restored);
		} catch (error) {
			expect((error as ControlPlaneError).code).toBe("loop_guard");
		}

		store.close();
	});
});
