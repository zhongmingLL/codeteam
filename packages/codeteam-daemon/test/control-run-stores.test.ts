import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreateBacklogItemInput, Message } from "../src/control/stores/types.ts";
import { ControlError, type ControlStore, openControlStore } from "../src/index.ts";

const NOW = 1_700_000_000_000;

const dirs: string[] = [];
let now: number;
let store: ControlStore;

function createBacklog(overrides: Partial<CreateBacklogItemInput> = {}) {
	return store.backlog.create({
		id: "backlog-1",
		userId: "user-1",
		title: "Backlog",
		summary: "Summary",
		priority: "p1",
		tags: ["feature:F004"],
		createdByKind: "user",
		createdById: "user-1",
		...overrides,
	});
}

function createThread(id = "thread-1") {
	return store.threads.create({ id, title: "Thread" });
}

function createWorkTask(input: { id?: string; threadId: string; backlogId: string; ownerProfileId?: string | null }) {
	return store.tasks.create({
		id: input.id ?? "task-1",
		kind: "work",
		threadId: input.threadId,
		title: "Task",
		why: "Why",
		ownerProfileId: input.ownerProfileId ?? "profile-coder",
		createdBy: "user",
		userId: "user-1",
		backlogItemId: input.backlogId,
	});
}

function createSession(input: {
	id: string;
	threadId: string;
	taskId: string;
	profileId: string;
	role: string;
	seq?: number;
}) {
	return store.sessions.create({
		...input,
		effectiveToolPolicy: "default",
		provider: "test",
		model: "model",
		modelFamily: "family",
		seq: input.seq ?? 0,
	});
}

function createSourceMessage(threadId: string): Message {
	return store.messages.append({
		threadId,
		authorKind: "user",
		authorId: "user-1",
		kind: "chat",
		bodyMd: "source",
	});
}

function baseWork() {
	const backlog = createBacklog();
	const thread = createThread();
	const task = createWorkTask({ threadId: thread.id, backlogId: backlog.id });
	const session = createSession({
		id: "session-coder",
		threadId: thread.id,
		taskId: task.id,
		profileId: "profile-coder",
		role: "coder",
	});
	const source = createSourceMessage(thread.id);
	return { backlog, thread, task, session, source };
}

beforeEach(() => {
	const dataDir = mkdtempSync(join(tmpdir(), "codeteam-run-"));
	dirs.push(dataDir);
	now = NOW;
	store = openControlStore({ dataDir, clock: () => now });
	store.seedIdentity({
		eval: { provider: "test", model: "eval-model", modelFamily: "test-family" },
		compress: { provider: "test", model: "compress-model", modelFamily: "test-family" },
	});
	store.profiles.create({
		id: "profile-coder",
		role: "coder",
		displayName: "Coder",
		provider: "test",
		model: "model",
		modelFamily: "family",
		toolPolicyProfile: "default",
	});
});

afterEach(() => {
	store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codeteam run / task / credential stores", () => {
	it("creates work and tracking tasks with CAS status/disposition", () => {
		const { backlog, thread, task } = baseWork();
		expect(task).toMatchObject({ kind: "work", status: "todo", backlogItemId: backlog.id, threadId: thread.id });
		expect(() =>
			store.tasks.create({
				id: "bad-work",
				kind: "work",
				threadId: thread.id,
				title: "Bad",
				why: "Why",
				createdBy: "user",
			}),
		).toThrow(ControlError);
		expect(() =>
			store.tasks.create({
				id: "bad-pr",
				kind: "pr_tracking",
				threadId: thread.id,
				title: "PR",
				why: "Why",
				createdBy: "user",
			}),
		).toThrow(ControlError);
		const pr = store.tasks.create({
			id: "task-pr",
			kind: "pr_tracking",
			threadId: thread.id,
			subjectKey: "pr:owner/repo#1",
			title: "PR",
			why: "Why",
			createdBy: "user",
		});
		expect(pr.kind).toBe("pr_tracking");
		now += 1000;
		const doing = store.tasks.setStatus(task.id, "doing", { expectedUpdatedAt: NOW });
		expect(doing.status).toBe("doing");
		expect(() => store.tasks.setStatus(task.id, "blocked", { expectedUpdatedAt: NOW })).toThrow(ControlError);
		const canceled = store.tasks.setDisposition(task.id, "canceled");
		expect(canceled).toMatchObject({ status: "done", disposition: "canceled" });
		expect(store.tasks.list({ threadId: thread.id })).toHaveLength(2);
	});

	it("creates and passes stage snapshots", () => {
		const { task } = baseWork();
		const stage = store.stages.create({ id: "stage-1", taskId: task.id, lane: "impl" });
		expect(stage.status).toBe("active");
		now += 1000;
		const passed = store.stages.pass(stage.id);
		expect(passed).toMatchObject({ status: "passed", endedAt: now });
		expect(store.stages.pass(stage.id).status).toBe("passed");
		expect(store.stages.listByTask(task.id)).toHaveLength(1);
	});

	it("creates, terminals, and event-logs runs with one running writer", () => {
		const { task, session, source } = baseWork();
		const queue = store.queue.admit({
			threadId: "thread-1",
			sourceId: source.id,
			sourceKind: "conversation_input",
			targets: ["profile-coder"],
			sourceCategory: "a2a",
			orderKey: "1",
		});
		const run = store.runs.create({
			id: "run-1",
			taskId: task.id,
			queueEntryId: queue.id,
			role: "coder",
			agentSessionId: session.id,
			sourceId: source.id,
			recipientProfileId: "profile-coder",
			provider: "test",
			model: "model",
			modelFamily: "family",
		});
		expect(run.status).toBe("running");
		expect(() =>
			store.runs.create({
				id: "run-2",
				taskId: task.id,
				queueEntryId: queue.id,
				role: "coder",
				agentSessionId: session.id,
				sourceId: source.id,
				recipientProfileId: "profile-coder",
				provider: "test",
				model: "model",
				modelFamily: "family",
			}),
		).toThrow(ControlError);
		const event = store.runs.appendEvent(run.id, "message", { text: "hello" });
		expect(event.seq).toBe(1);
		expect(store.runs.appendEvent(run.id, "gate", { gate: "review" }).seq).toBe(2);
		expect(store.runs.listEvents(run.id)).toHaveLength(2);
		now += 1000;
		const completed = store.runs.terminal(run.id, { status: "completed" });
		expect(completed).toMatchObject({ status: "completed", terminalAt: now });
		expect(store.runs.terminal(run.id, { status: "completed" }).status).toBe("completed");
		expect(() => store.runs.terminal(run.id, { status: "failed" })).toThrow(ControlError);
		expect(store.runs.list({ taskId: task.id, status: "completed" })).toHaveLength(1);
	});

	it("appends thread events with thread-scoped sequence", () => {
		createThread();
		const first = store.threadEvents.append("thread-1", "backlog_item_dispatched", { backlogItemId: "b1" });
		const second = store.threadEvents.append("thread-1", "workflow_sop_updated", { version: 1 });
		expect([first.seq, second.seq]).toEqual([1, 2]);
		expect(store.threadEvents.list("thread-1")).toHaveLength(2);
	});

	it("creates and terminalizes invocation credentials without exposing token material", () => {
		const { task, session, source, thread } = baseWork();
		const queue = store.queue.admit({
			threadId: thread.id,
			sourceId: source.id,
			sourceKind: "conversation_input",
			targets: ["profile-coder"],
			sourceCategory: "a2a",
			orderKey: "1",
		});
		const run = store.runs.create({
			id: "run-1",
			taskId: task.id,
			queueEntryId: queue.id,
			role: "coder",
			agentSessionId: session.id,
			sourceId: source.id,
			recipientProfileId: "profile-coder",
			provider: "test",
			model: "model",
			modelFamily: "family",
		});
		const credential = store.credentials.create({
			id: "cred-1",
			tokenHash: "a".repeat(64),
			tokenSalt: "salt-01234567890",
			runId: run.id,
			taskId: task.id,
			role: "coder",
			agentSessionId: session.id,
			agentProfileId: "profile-coder",
			threadId: thread.id,
			userId: "user-1",
			ownerAuthProvenance: "strict",
			toolPolicy: { tools: ["read"] },
		});
		expect(credential).toMatchObject({ state: "active", disposition: null });
		expect(store.credentials.getByRun(run.id)?.id).toBe(credential.id);
		expect(() =>
			store.credentials.create({
				id: "cred-2",
				tokenHash: "b".repeat(64),
				tokenSalt: "salt-98765432100",
				runId: run.id,
				taskId: task.id,
				role: "coder",
				agentSessionId: session.id,
				agentProfileId: "profile-coder",
				threadId: thread.id,
				userId: "user-1",
				ownerAuthProvenance: "strict",
				toolPolicy: {},
			}),
		).toThrow(ControlError);
		expect(store.credentials.listActiveBySession(session.id)).toHaveLength(1);
		const terminal = store.credentials.terminalize(credential.id, "completed");
		expect(terminal).toMatchObject({ state: "terminal", disposition: "completed" });
		expect(store.credentials.terminalize(credential.id, "completed").state).toBe("terminal");
		expect(() => store.credentials.terminalize(credential.id, "failed")).toThrow(ControlError);
		expect(store.credentials.listActiveBySession(session.id)).toHaveLength(0);
	});

	it("binds a coder run and a pr_tracking task to managed work", () => {
		const { backlog, task, session, source, thread } = baseWork();
		store.sops.upsert({
			backlogItemId: backlog.id,
			featureId: "F004",
			stage: "kickoff",
			batonHolder: "profile-coder",
			resumeCapsule: { goal: "ship", done: [], currentFocus: "runs" },
			checks: {
				remoteMainSynced: "unknown",
				qualityGatePassed: "unknown",
				reviewApproved: "unknown",
				visionGuardDone: "unknown",
			},
			updatedBy: "profile-coder",
		});
		const identity = store.sops.workIdentity(backlog.id, backlog.userId);
		const queue = store.queue.admit({
			threadId: thread.id,
			sourceId: source.id,
			sourceKind: "conversation_input",
			targets: ["profile-coder"],
			sourceCategory: "a2a",
			orderKey: "1",
		});
		const run = store.runs.create({
			id: "run-1",
			taskId: task.id,
			queueEntryId: queue.id,
			role: "coder",
			agentSessionId: session.id,
			sourceId: source.id,
			recipientProfileId: "profile-coder",
			provider: "test",
			model: "model",
			modelFamily: "family",
		});
		const bound = store.work.bindRun({ runId: run.id, workId: identity.workId, attemptId: identity.attemptId });
		expect(bound.workId).toBe(identity.workId);
		expect(
			store.work.bindRun({ runId: run.id, workId: identity.workId, attemptId: identity.attemptId }).boundAt,
		).toBe(bound.boundAt);
		expect(store.work.getRunBinding(run.id)?.attemptId).toBe(identity.attemptId);
		const pr = store.tasks.create({
			id: "task-pr",
			kind: "pr_tracking",
			threadId: thread.id,
			subjectKey: "pr:owner/repo#1",
			title: "PR",
			why: "Why",
			createdBy: "user",
		});
		expect(
			store.work.bindTask({ taskId: pr.id, workId: identity.workId, attemptId: identity.attemptId }).workId,
		).toBe(identity.workId);
		expect(() =>
			store.work.bindTask({ taskId: task.id, workId: identity.workId, attemptId: identity.attemptId }),
		).toThrow(ControlError);
	});

	it("cuts over multiple queue targets into separate runs and binds the coder run", () => {
		const { backlog, task, session, source, thread } = baseWork();
		store.sops.upsert({
			backlogItemId: backlog.id,
			featureId: "F004",
			stage: "kickoff",
			batonHolder: "profile-coder",
			resumeCapsule: { goal: "ship", done: [], currentFocus: "cutover" },
			checks: {
				remoteMainSynced: "unknown",
				qualityGatePassed: "unknown",
				reviewApproved: "unknown",
				visionGuardDone: "unknown",
			},
			updatedBy: "profile-coder",
		});
		const evalSession = createSession({
			id: "session-eval",
			threadId: thread.id,
			taskId: task.id,
			profileId: "profile:eval",
			role: "reviewer",
			seq: 1,
		});
		const queue = store.queue.admit({
			threadId: thread.id,
			sourceId: source.id,
			sourceKind: "conversation_input",
			targets: ["profile-coder", "profile:eval"],
			sourceCategory: "a2a",
			orderKey: "1",
		});
		store.queue.claim(queue.id, { claimId: "claim-1" });
		const coderCutover = store.cutoverQueueEntry({
			queueEntryId: queue.id,
			claimId: "claim-1",
			targetProfileId: "profile-coder",
			taskId: task.id,
			role: "coder",
			agentSessionId: session.id,
			provider: "test",
			model: "model",
			modelFamily: "family",
			responseBody: "working",
		});
		expect(coderCutover.run.status).toBe("running");
		expect(coderCutover.responseMessage).toMatchObject({ kind: "agent_response", authorId: "profile-coder" });
		expect(coderCutover.queueEntry).toMatchObject({ status: "queued", targets: ["profile:eval"] });
		expect(coderCutover.runEvent.seq).toBe(1);
		expect(store.work.getRunBinding(coderCutover.run.id)).not.toBeNull();
		expect(
			store.work.getAttempt(store.sops.workIdentity(backlog.id, backlog.userId).attemptId)?.executorProfileId,
		).toBe("profile-coder");
		expect(store.messages.get(source.id)?.dispatchRefs).toHaveLength(1);
		store.queue.claim(queue.id, { claimId: "claim-2" });
		const evalCutover = store.cutoverQueueEntry({
			queueEntryId: queue.id,
			claimId: "claim-2",
			targetProfileId: "profile:eval",
			taskId: task.id,
			role: "reviewer",
			agentSessionId: evalSession.id,
			provider: "test",
			model: "model",
			modelFamily: "family",
			responseBody: "reviewing",
		});
		expect(evalCutover.run.status).toBe("running");
		expect(evalCutover.queueEntry).toBeNull();
		expect(store.runs.get(evalCutover.run.id)?.queueEntryId).toBeNull();
		expect(store.messages.get(source.id)?.dispatchRefs).toHaveLength(2);
		expect(store.messages.listThread(thread.id).map((message) => message.seq)).toEqual([1, 2, 3]);
		expect(store.runs.list({ taskId: task.id })).toHaveLength(2);
	});

	it("does not create run/message resources when cutover validation fails", () => {
		const { task, session, source, thread } = baseWork();
		const queue = store.queue.admit({
			threadId: thread.id,
			sourceId: source.id,
			sourceKind: "conversation_input",
			targets: ["profile-coder"],
			sourceCategory: "a2a",
			orderKey: "1",
		});
		store.queue.claim(queue.id, { claimId: "claim-1" });
		expect(() =>
			store.cutoverQueueEntry({
				queueEntryId: queue.id,
				claimId: "claim-1",
				targetProfileId: "profile:eval",
				taskId: task.id,
				role: "reviewer",
				agentSessionId: session.id,
				provider: "test",
				model: "model",
				modelFamily: "family",
			}),
		).toThrow(ControlError);
		expect(store.runs.list({ taskId: task.id })).toHaveLength(0);
		expect(store.messages.listThread(thread.id)).toHaveLength(1);
		expect(store.queue.get(queue.id)?.status).toBe("claimed");
	});
});
