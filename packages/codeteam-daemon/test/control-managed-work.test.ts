import { afterEach, describe, expect, it } from "vitest";
import { ManagedWorkService } from "../src/index.ts";
import { createW5AFixture, type W5AFixture } from "./helpers/w5a-fixture.ts";
import { addCoderProfile, createSecondBacklog, seedWork } from "./helpers/w5d-fixture.ts";

const fixtures: W5AFixture[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function fixture(): W5AFixture {
	const created = createW5AFixture();
	fixtures.push(created);
	return created;
}

function prTask(subjectKey = "pr:owner/repo#1") {
	return {
		threadId: "thread-1",
		subjectKey,
		title: "Track PR",
		why: "W5d binding",
		createdBy: "user-1",
		userId: "user-1",
	};
}

describe("W5d managed-work task binding", () => {
	it("creates a pr_tracking task and private binding in one transaction", () => {
		const base = fixture();
		const identity = seedWork(base);
		const service = new ManagedWorkService(base.store);
		const result = service.registerPrTracking({ task: prTask(), binding: identity });
		expect(result.created).toBe(true);
		expect(result.task.kind).toBe("pr_tracking");
		expect(result.binding).toMatchObject(identity);
		expect(base.store.work.getTaskBinding(result.task.id)).toMatchObject(identity);
		expect(JSON.stringify(result.task)).not.toContain(identity.workId);
		expect(JSON.stringify(result.task)).not.toContain(identity.attemptId);

		const replay = service.registerPrTracking({ task: prTask(), binding: identity });
		expect(replay.created).toBe(false);
		expect(replay.task.id).toBe(result.task.id);
		expect(replay.binding?.attemptId).toBe(identity.attemptId);
	});

	it("rejects a different binding and keeps missing binding as no-op", () => {
		const base = fixture();
		const identity = seedWork(base);
		const second = createSecondBacklog(base);
		const service = new ManagedWorkService(base.store);
		const registered = service.registerPrTracking({ task: prTask(), binding: identity });

		expect(() => service.registerPrTracking({ task: prTask(), binding: second })).toThrowError(
			expect.objectContaining({ code: "conflict" }),
		);
		expect(
			base.store.audit
				.listSubject(`task:${registered.task.id}`)
				.some((entry) => entry.action === "work_binding_conflict"),
		).toBe(true);

		const unbound = service.registerPrTracking({ task: prTask("pr:owner/repo#2") });
		expect(unbound.created).toBe(true);
		expect(unbound.binding).toBeNull();
		expect(service.registerPrTracking({ task: prTask("pr:owner/repo#2") }).created).toBe(false);
	});

	it("attributes tasks and runs without creating a second episode store", () => {
		const base = fixture();
		const identity = seedWork(base);
		const service = new ManagedWorkService(base.store);
		const bound = service.registerPrTracking({ task: prTask(), binding: identity });
		const unbound = service.registerPrTracking({ task: prTask("pr:owner/repo#2") });
		expect(service.attributeTask(bound.task.id)).toMatchObject({ kind: "managed_attributed", ...identity });
		expect(service.attributeTask(unbound.task.id)).toMatchObject({ kind: "managed_unattributed" });
		expect(service.attributeTask("task-1")).toMatchObject({ kind: "unmanaged_not_applicable" });

		const evidence = service.recordLifecycleEvidence({
			taskId: bound.task.id,
			evidenceKind: "merge",
			evidenceRef: "merge:1",
			actorRef: "system:test",
		});
		expect(evidence.kind).toBe("managed_attributed");
		const audit = base.store.audit
			.listSubject(`task:${bound.task.id}`)
			.find((entry) => entry.action === "work_lifecycle_evidence");
		expect(audit?.args).toMatchObject({
			workId: identity.workId,
			attemptId: identity.attemptId,
			evidenceKind: "merge",
		});

		const managedRun = base.createRun({
			id: "run-managed",
			sessionId: "session-coder",
			profileId: "profile:coder",
			role: "coder",
			sourceId: base.createSourceMessage("managed run").id,
		});
		base.store.work.bindRun({ runId: managedRun.id, ...identity });
		expect(service.attributeRun(managedRun.id)).toMatchObject({ kind: "managed_attributed", ...identity });

		const participantRun = base.createRun({
			id: "run-participant",
			sessionId: "session-reviewer-a",
			profileId: "profile:reviewer-a",
			role: "reviewer",
			sourceId: base.createSourceMessage("participant run").id,
		});
		expect(service.attributeRun(participantRun.id)).toMatchObject({
			kind: "unmanaged_not_applicable",
			reason: "participant_phase_b",
		});

		const unboundRun = base.createRun({
			id: "run-unbound",
			sessionId: "session-coder",
			profileId: "profile:coder",
			role: "coder",
			sourceId: base.createSourceMessage("unbound run").id,
		});
		expect(service.attributeRun(unboundRun.id)).toMatchObject({ kind: "managed_unattributed" });
	});

	it("cascades the private binding with the pr_tracking task", () => {
		const base = fixture();
		const identity = seedWork(base);
		const service = new ManagedWorkService(base.store);
		const bound = service.registerPrTracking({ task: prTask(), binding: identity });
		base.store.database.prepare("DELETE FROM tasks WHERE id = ?").run(bound.task.id);
		expect(base.store.work.getTaskBinding(bound.task.id)).toBeNull();
	});

	it("enforces sticky retry and preflight decisions", () => {
		const base = fixture();
		const identity = seedWork(base);
		base.store.work.bindAttempt(identity.attemptId, "profile:coder");
		const source = base.createSourceMessage("sticky run");
		const run = base.createRun({
			id: "run-sticky",
			sessionId: "session-coder",
			profileId: "profile:coder",
			role: "coder",
			sourceId: source.id,
		});
		base.store.work.bindRun({ runId: run.id, ...identity });
		const service = new ManagedWorkService(base.store);
		const other = addCoderProfile(base);

		expect(service.stickyRetryDecision({ runId: run.id, requestedProfileId: "profile:coder" })).toMatchObject({
			kind: "managed",
			profileId: "profile:coder",
		});
		expect(service.stickyRetryDecision({ runId: run.id, requestedProfileId: other.profileId })).toMatchObject({
			kind: "conflict",
			boundProfileId: "profile:coder",
		});
		expect(service.preflightRun({ taskId: "task-1", role: "coder", profileId: "profile:coder" })).toMatchObject({
			kind: "managed",
			matchesRequested: true,
		});
		expect(service.preflightRun({ taskId: "task-1", role: "coder", profileId: other.profileId })).toMatchObject({
			kind: "conflict",
			reason: "executor_conflict",
		});
		expect(
			service.preflightRun({ taskId: "task-1", role: "reviewer", profileId: "profile:reviewer-a" }),
		).toMatchObject({
			kind: "unmanaged",
			reason: "not_primary_implementer",
		});
	});
});
