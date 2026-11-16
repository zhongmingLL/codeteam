import { afterEach, describe, expect, it } from "vitest";
import { type CustodyProjection, projectCustody, WaitContractService } from "../src/index.ts";
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

function createRun(base: W5AFixture, id: string, profileId: string, role: string, sessionId: string) {
	const source = base.createSourceMessage(id);
	return base.createRun({ id, profileId, role, sessionId, sourceId: source.id });
}

function createHandoff(
	base: W5AFixture,
	overrides: {
		id?: string;
		mode?: "single" | "parallel";
		holders?: string[];
		kind?: "handoff" | "review_request" | "blocker";
		payload?: Record<string, unknown>;
	} = {},
) {
	const holders = overrides.holders ?? ["profile:reviewer-a"];
	return base.store.handoffs.create({
		id: overrides.id ?? "handoff-1",
		taskId: "task-1",
		kind: overrides.kind ?? "review_request",
		fromRole: "coder",
		toRole: "reviewer",
		subject: "Custody",
		subjectRef: "pr:owner/repo#1",
		actionFamily: overrides.kind === "blocker" ? "investigate" : "review",
		successorSlot: overrides.kind === "blocker" ? "investigator" : "reviewer",
		mode: overrides.mode ?? (holders.length > 1 ? "parallel" : "single"),
		parallelIntent: holders.length > 1 ? "independent" : null,
		ownerUserId: "user-1",
		canonicalActionKey: `action-${overrides.id ?? "handoff-1"}`,
		holderProfileIds: holders,
		holderThreadId: "thread-1",
		predecessorProfileId: "profile:coder",
		predecessorThreadId: "thread-1",
		claimOrigin: "structured_transfer",
		dispatchId: `dispatch-${overrides.id ?? "handoff-1"}`,
		terminalPredicate: { kind: "review_verdict" },
		expectedArtifact: "artifact:review",
		payload: overrides.payload ?? {},
		idempotencyKey: `idem-${overrides.id ?? "handoff-1"}`,
		deadline: base.now() + 100_000,
	});
}

function project(base: W5AFixture, handoffId: string): CustodyProjection {
	const handoff = base.store.handoffs.get(handoffId)!;
	return projectCustody(
		handoff,
		base.store.handoffs.custodyEvents(handoffId),
		base.store.handoffs.listClaims(handoffId),
	);
}

describe("W5a custody replay", () => {
	it("replays single holder claim and return to pending", () => {
		const base = fixture();
		const run = createRun(base, "run-reviewer-a", "profile:reviewer-a", "reviewer", "session-reviewer-a");
		const handoff = createHandoff(base);
		base.store.handoffs.claim({ handoffId: handoff.id, profileId: "profile:reviewer-a", runId: run.id });
		let projection = project(base, handoff.id);
		expect(projection.status).toBe("claimed");
		expect(projection.holderProfileIds).toEqual(["profile:reviewer-a"]);
		expect(projection.anomalies).toEqual([]);
		base.store.handoffs.releaseClaim(handoff.id, "profile:reviewer-a", "returned");
		projection = project(base, handoff.id);
		expect(projection.status).toBe("pending");
		expect(projection.holderProfileIds).toEqual([]);
		expect(projection.anomalies).toEqual([]);
		expect(base.store.handoffs.custodyEvents(handoff.id).map((event) => event.kind)).toEqual([
			"handoff.created",
			"handoff.claimed",
			"handoff.returned",
		]);
	});

	it("replays parallel holders and expiry independently of waits", () => {
		const base = fixture();
		const runA = createRun(base, "run-a", "profile:reviewer-a", "reviewer", "session-reviewer-a");
		const runB = createRun(base, "run-b", "profile:reviewer-b", "reviewer", "session-reviewer-b");
		const handoff = createHandoff(base, {
			id: "handoff-parallel",
			mode: "parallel",
			holders: ["profile:reviewer-a", "profile:reviewer-b"],
		});
		base.store.handoffs.claim({ handoffId: handoff.id, profileId: "profile:reviewer-a", runId: runA.id });
		base.store.handoffs.claim({ handoffId: handoff.id, profileId: "profile:reviewer-b", runId: runB.id });
		const projection = project(base, handoff.id);
		expect(projection.status).toBe("claimed");
		expect(projection.holderProfileIds).toEqual(["profile:reviewer-a", "profile:reviewer-b"]);
		expect(projection.anomalies).toEqual([]);
		base.store.handoffs.expire(handoff.id, "system:test", "deadline");
		const expired = project(base, handoff.id);
		expect(expired.expired).toBe(true);
		expect(expired.holderProfileIds).toEqual([]);
	});

	it("projects blocked handoffs with both on-resolve semantics and flags missing declaration", () => {
		const base = fixture();
		const completes = createHandoff(base, {
			id: "handoff-blocked-completes",
			kind: "blocker",
			payload: { blockedOnResolve: "completes" },
		});
		const completesProjection = project(base, completes.id);
		expect(completesProjection.blocked).toEqual({
			onResolve: "completes",
			ownerProfileId: "profile:coder",
		});
		expect(completesProjection.anomalies).toEqual([]);
		const bounces = createHandoff(base, {
			id: "handoff-blocked-bounces",
			kind: "blocker",
			payload: { blockedOnResolve: "bounces_back_to_owner" },
		});
		const bouncesProjection = project(base, bounces.id);
		expect(bouncesProjection.blocked?.onResolve).toBe("bounces_back_to_owner");
		expect(bouncesProjection.anomalies).toEqual([]);
		const missing = createHandoff(base, { id: "handoff-blocked-missing", kind: "blocker", payload: {} });
		const missingProjection = project(base, missing.id);
		expect(missingProjection.blocked).toBeNull();
		expect(missingProjection.anomalies).toContain("blocker handoff is missing blockedOnResolve");
	});
});

describe("W5a wait contract", () => {
	it("fails closed without source, SLA, expected signal, or exact owner fence", () => {
		const base = fixture();
		const service = new WaitContractService(base.store, base.now);
		const baseInput = {
			waitId: "wait-1",
			generation: 1,
			subjectRef: "task:task-1",
			kind: "timer" as const,
			waitSourceRef: "timer:1",
			ownerFence: { kind: "containing_task", taskId: "task-1" },
			slaUntil: base.now() + 10_000,
		};
		expect(() => service.arm({ ...baseInput, waitSourceRef: "" })).toThrow(/waitSourceRef/);
		expect(() => service.arm({ ...baseInput, slaUntil: undefined as unknown as number })).toThrow(/slaUntil/);
		expect(() => service.arm({ ...baseInput, waitSourceRef: "not-typed" })).toThrow(/<kind>:<id>/);
		expect(() =>
			service.arm({
				...baseInput,
				kind: "event",
				waitSourceRef: "github:pr:1",
				ownerFence: { kind: "containing_task", taskId: "task-1" },
			}),
		).toThrow(/expectedSignal/);
		expect(() => service.arm({ ...baseInput, ownerFence: { kind: "other" } })).toThrow(/ownerFence/);
		expect(() =>
			service.arm({
				...baseInput,
				ownerFence: { kind: "action_successor", handoffId: createHandoff(base, { id: "handoff-fence" }).id },
			}),
		).toThrow(/matching containing_task fence/);
		expect(() => service.arm({ ...baseInput, ownerFence: { kind: "containing_task", taskId: "missing" } })).toThrow(
			/not found/,
		);
	});

	it("arms containing_task and action_successor waits, and enforces user_cancel ownership", () => {
		const base = fixture();
		const service = new WaitContractService(base.store, base.now);
		const handoff = createHandoff(base, { id: "handoff-wait" });
		const taskWait = service.arm({
			waitId: "wait-task",
			generation: 1,
			subjectRef: "task:task-1",
			kind: "event",
			waitSourceRef: "github:pr:1",
			expectedSignal: "ci_complete",
			ownerFence: { kind: "containing_task", taskId: "task-1" },
			slaUntil: base.now() + 10_000,
		});
		expect(taskWait.status).toBe("active");
		const handoffWait = service.arm({
			waitId: "wait-handoff",
			generation: 1,
			subjectRef: `handoff:${handoff.id}`,
			kind: "managed_command",
			waitSourceRef: "command:pnpm-gate",
			expectedSignal: "exit_code=0",
			ownerFence: { kind: "action_successor", handoffId: handoff.id, leaseId: handoff.id },
			slaUntil: base.now() + 10_000,
		});
		expect(handoffWait.status).toBe("active");
		expect(() =>
			service.terminate({
				waitId: taskWait.waitId,
				generation: taskWait.generation,
				reason: "user_cancel",
				actor: { kind: "user", id: "user-2" },
				ownerUserId: "user-2",
				threadId: "thread-1",
			}),
		).toThrow(/owner/);
		const terminated = service.terminate({
			waitId: taskWait.waitId,
			generation: taskWait.generation,
			reason: "user_cancel",
			actor: { kind: "user", id: "user-1" },
			ownerUserId: "user-1",
			threadId: "thread-1",
		});
		expect(terminated.waitId).toBe("wait-task");
		expect(base.store.handoffs.get(handoff.id)?.status).toBe("pending");
	});

	it("requires expected signals for managed commands and never adjudicates handoff expiry", () => {
		const base = fixture();
		const service = new WaitContractService(base.store, base.now);
		const handoff = createHandoff(base, { id: "handoff-no-expire" });
		expect(() =>
			service.arm({
				waitId: "wait-command",
				generation: 1,
				subjectRef: `handoff:${handoff.id}`,
				kind: "managed_command",
				waitSourceRef: "command:test",
				ownerFence: { kind: "action_successor", handoffId: handoff.id },
				slaUntil: base.now() + 10_000,
			}),
		).toThrow(/expectedSignal/);
		service.arm({
			waitId: "wait-command",
			generation: 1,
			subjectRef: `handoff:${handoff.id}`,
			kind: "managed_command",
			waitSourceRef: "command:test",
			expectedSignal: "exit_code=0",
			ownerFence: { kind: "action_successor", handoffId: handoff.id },
			slaUntil: base.now() + 10_000,
		});
		base.advance(20_000);
		expect(base.store.handoffs.get(handoff.id)?.status).toBe("pending");
		expect(base.store.waits.listActive(`handoff:${handoff.id}`)).toHaveLength(1);
	});
});
