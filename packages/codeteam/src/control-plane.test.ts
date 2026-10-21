import { describe, expect, it } from "vitest";
import { ManualClock } from "./clock.ts";
import { ControlPlane } from "./control-plane.ts";
import { ControlPlaneError } from "./errors.ts";
import type { CreateHandoffInput } from "./types.ts";
import { canAdvance } from "./workflow.ts";

function expectCode(fn: () => unknown, code: ControlPlaneError["code"]): void {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(ControlPlaneError);
		expect((error as ControlPlaneError).code).toBe(code);
		return;
	}
	throw new Error(`expected ControlPlaneError(${code})`);
}

function setup() {
	const clock = new ManualClock(1_000);
	const plane = new ControlPlane({ clock, loopLimit: 2, defaultDeadlineMs: 100 });
	plane.createTask("task-1", "implement");
	plane.createRun("run-1", "task-1", "coder");
	plane.createRun("run-2", "task-1", "coder");
	return { clock, plane };
}

function handoff(plane: ControlPlane, overrides: Partial<CreateHandoffInput> = {}) {
	return plane.createHandoff({
		taskId: "task-1",
		kind: "review_request",
		fromRole: "coder",
		toRole: "reviewer",
		subject: "review-diff-1",
		actionPair: "coder->reviewer:review",
		expectedArtifact: "diff",
		deadlineMs: 100,
		...overrides,
	});
}

describe("codeteam control plane", () => {
	it("enforces single-slot CAS and replays the same claim", () => {
		const { plane } = setup();
		const item = handoff(plane);

		const first = plane.claim(item.id, "run-1");
		expect(first.replayed).toBe(false);
		expect(item.status).toBe("claimed");
		expect(item.claimedByRunId).toBe("run-1");
		expect(item.attempt).toBe(1);

		expectCode(() => plane.claim(item.id, "run-2"), "safe_wait");

		const replay = plane.claim(item.id, "run-1");
		expect(replay.replayed).toBe(true);
		expect(item.attempt).toBe(1);
	});

	it("commits exactly one terminal per handoff and run", () => {
		const { plane } = setup();
		const item = handoff(plane);

		plane.claim(item.id, "run-1");
		const first = plane.complete(item.id, "run-1", { verdict: "approve" });
		expect(first.status).toBe("consumed");
		expect(first.result).toEqual({ verdict: "approve" });
		expect(plane.getRun("run-1").status).toBe("completed");

		const replay = plane.complete(item.id, "run-1", { verdict: "changes_requested" });
		expect(replay.result).toEqual({ verdict: "approve" });
		expect(plane.getRun("run-1").status).toBe("completed");

		const lateFinish = plane.finishRun("run-1", "interrupted");
		expect(lateFinish.status).toBe("completed");

		expectCode(() => plane.claim(item.id, "run-2"), "terminal_handoff");
	});

	it("rejects a handoff without an expected artifact", () => {
		const { plane } = setup();
		expectCode(() => handoff(plane, { expectedArtifact: "   " }), "missing_expected_artifact");
	});

	it("rejects illegal stage transitions and keeps a typed plan-revision edge", () => {
		const { plane } = setup();

		expect(canAdvance("implement", "verify")).toBe(false);
		expect(canAdvance("implement", "review")).toBe(true);
		expectCode(() => plane.advanceTask("task-1", "verify"), "illegal_transition");
		expect(plane.getTask("task-1").stage).toBe("implement");

		expect(plane.requestStageChange("task-1", "spec_change").stage).toBe("plan");
		expect(plane.advanceTask("task-1", "implement").stage).toBe("implement");
		expect(plane.advanceTask("task-1", "review").stage).toBe("review");
	});

	it("marks lost runs interrupted and requeues their handoff", () => {
		const { plane } = setup();
		const item = handoff(plane);
		plane.claim(item.id, "run-1");

		const interrupted = plane.recoverInterruptedRuns(new Set(["run-2"]));
		expect(interrupted.map((run) => run.id)).toEqual(["run-1"]);
		expect(plane.getRun("run-1").status).toBe("interrupted");
		expect(item.status).toBe("pending");
		expect(item.claimedByRunId).toBeUndefined();

		const reclaimed = plane.claim(item.id, "run-2");
		expect(reclaimed.replayed).toBe(false);
		expect(item.claimedByRunId).toBe("run-2");
		expect(item.attempt).toBe(2);
	});

	it("expires overdue handoffs through the dirty-bit drain", () => {
		const { clock, plane } = setup();
		const item = handoff(plane);
		plane.claim(item.id, "run-1");
		plane.drain();

		clock.advance(101);
		plane.wake();
		const expired = plane.drain();
		expect(expired.map((entry) => entry.id)).toContain(item.id);
		expect(item.status).toBe("expired");
		expect(plane.getRun("run-1").status).toBe("interrupted");
		expect(plane.drain()).toEqual([]);
	});

	it("loop-guards by subject and action pair, not by message wording", () => {
		const { plane } = setup();
		handoff(plane, { payload: { wording: "please review" } });
		handoff(plane, { payload: { wording: "could you take another look" } });

		expectCode(() => handoff(plane, { payload: { wording: "yet another paraphrase" } }), "loop_guard");
		expect(() => handoff(plane, { subject: "review-diff-2" })).not.toThrow();
	});

	it("rejects cross-task claims", () => {
		const { plane } = setup();
		plane.createTask("task-2", "implement");
		plane.createRun("run-3", "task-2", "reviewer");
		const item = handoff(plane);

		expectCode(() => plane.claim(item.id, "run-3"), "task_mismatch");
	});
});
