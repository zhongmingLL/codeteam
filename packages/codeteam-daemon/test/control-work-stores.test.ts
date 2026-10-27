import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreateBacklogItemInput, SopChecks } from "../src/control/stores/types.ts";
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

function createTask(id = "task-1") {
	const thread = store.threads.create({ id: `thread-${id}` });
	const backlog = createBacklog({ id: `backlog-${id}`, tags: ["feature:F004"] });
	store.database
		.prepare(
			"INSERT INTO tasks (id, kind, thread_id, title, why, status, created_by, backlog_item_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(id, "work", thread.id, "Task", "Why", "todo", "user", backlog.id, NOW, NOW);
	return { thread, backlog, taskId: id };
}

function sopInput(overrides: Record<string, unknown> = {}) {
	return {
		backlogItemId: "backlog-1",
		featureId: "F004",
		stage: "kickoff" as const,
		batonHolder: "profile-coder",
		resumeCapsule: { goal: "ship W1", done: [], currentFocus: "schema" },
		checks: {
			remoteMainSynced: "unknown" as const,
			qualityGatePassed: "unknown" as const,
			reviewApproved: "unknown" as const,
			visionGuardDone: "unknown" as const,
		},
		updatedBy: "profile-coder",
		...overrides,
	};
}

beforeEach(() => {
	const dataDir = mkdtempSync(join(tmpdir(), "codeteam-work-"));
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

describe("codeteam work / SOP / artifact stores", () => {
	it("creates and lists backlog items, including system admission restrictions", () => {
		const item = createBacklog();
		expect(store.backlog.get(item.id)).toMatchObject({ status: "open", tags: ["feature:F004"] });
		expect(store.backlog.list({ status: "open" })).toHaveLength(1);
		expect(() =>
			store.backlog.create({
				id: "system-bad",
				userId: "user-1",
				title: "System",
				summary: "Summary",
				priority: "p1",
				tags: [],
				createdByKind: "system",
				createdById: "system:forge",
				initialStatus: "approved",
			}),
		).toThrow(ControlError);
		const system = store.backlog.create({
			id: "system-open",
			userId: "user-1",
			title: "System",
			summary: "Summary",
			priority: "p1",
			tags: [],
			createdByKind: "system",
			createdById: "system:forge",
		});
		expect(system.createdByKind).toBe("system");
	});

	it("runs the suggestion and direct-approval transitions with typed conflicts", () => {
		const item = createBacklog();
		const suggested = store.backlog.suggest(item.id, {
			catId: "profile-coder",
			why: "I can do it",
			plan: "do it",
			requestedPhase: "coding",
		});
		expect(suggested.status).toBe("suggested");
		expect(suggested.suggestion?.status).toBe("pending");
		expect(
			store.backlog.suggest(item.id, {
				catId: "profile-coder",
				why: "I can do it",
				plan: "do it",
				requestedPhase: "coding",
			}).status,
		).toBe("suggested");
		expect(() =>
			store.backlog.suggest(item.id, {
				catId: "profile:eval",
				why: "me too",
				plan: "me too",
				requestedPhase: "coding",
			}),
		).toThrow(ControlError);
		const approved = store.backlog.decideSuggestion(item.id, { decision: "approve", decidedBy: "user-1" });
		expect(approved.status).toBe("approved");
		const direct = createBacklog({ id: "backlog-direct" });
		expect(store.backlog.approve(direct.id, "user-1").status).toBe("approved");
	});

	it("locks the feature anchor tag once a SOP exists", () => {
		const item = createBacklog();
		store.sops.upsert(sopInput());
		expect(() => store.backlog.updateTags(item.id, [], "user", "user-1")).toThrow(ControlError);
		expect(store.backlog.updateTags(item.id, ["feature:F004", "area:runtime"], "user", "user-1").tags).toEqual([
			"feature:F004",
			"area:runtime",
		]);
		expect(() => store.backlog.updateTags(item.id, ["feature:F004"], "cat", "profile-coder")).toThrow(ControlError);
	});

	it("rejects work task creation without a backlog item using a typed error", () => {
		const thread = store.threads.create({ id: "thread-task-check", title: "Thread" });
		let thrown: unknown;
		try {
			store.tasks.create({
				kind: "work",
				threadId: thread.id,
				title: "Task",
				why: "Why",
				createdBy: "user",
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ControlError);
		expect((thrown as ControlError).code).toBe("backlog_not_imported");
		const tracking = store.tasks.create({
			kind: "pr_tracking",
			threadId: thread.id,
			subjectKey: "pr:owner/repo#1",
			title: "PR tracking",
			why: "Why",
			createdBy: "user",
		});
		expect(tracking.kind).toBe("pr_tracking");
	});

	it("creates a SOP with admission/attempt and updates it with version CAS", () => {
		const item = createBacklog();
		const created = store.sops.upsert(sopInput());
		expect(created).toMatchObject({ version: 1, stage: "kickoff", featureId: "F004" });
		const identity = store.sops.workIdentity(item.id, item.userId);
		expect(store.work.getAdmission(identity.workId)).toMatchObject({ producerRef: item.id });
		expect(store.work.getAttempt(identity.attemptId)).toMatchObject({ attemptNumber: 1, executorProfileId: null });
		expect(store.work.bindAttempt(identity.attemptId, "profile-coder").executorProfileId).toBe("profile-coder");
		expect(store.work.bindAttempt(identity.attemptId, "profile-coder").executorProfileId).toBe("profile-coder");
		expect(() => store.work.bindAttempt(identity.attemptId, "profile:eval")).toThrow(ControlError);
		const updated = store.sops.upsert(
			sopInput({
				stage: "impl",
				expectedVersion: 1,
				resumeCapsule: { goal: "ship W1", done: ["schema"], currentFocus: "stores" },
			}),
		);
		expect(updated.version).toBe(2);
		expect(updated.stage).toBe("impl");
		expect(() => store.sops.upsert(sopInput({ stage: "review", expectedVersion: 1 }))).toThrow(ControlError);
	});

	it("rejects verified SOP checks and completion before backlog done", () => {
		createBacklog();
		const verified = {
			remoteMainSynced: "verified",
			qualityGatePassed: "unknown",
			reviewApproved: "unknown",
			visionGuardDone: "unknown",
		} as unknown as SopChecks;
		expect(() => store.sops.upsert(sopInput({ checks: verified }))).toThrow(ControlError);
		expect(() => store.sops.upsert(sopInput({ stage: "completion" }))).toThrow(ControlError);
		const done = createBacklog({ id: "backlog-done", initialStatus: "done" });
		expect(store.sops.upsert(sopInput({ backlogItemId: done.id, stage: "completion" })).stage).toBe("completion");
	});

	it("dispatches an approved backlog item atomically and replays by attempt id", () => {
		const item = createBacklog();
		store.backlog.approve(item.id, "user-1");
		const result = store.dispatchBacklog({
			backlogItemId: item.id,
			targets: ["profile-coder"],
			threadPhase: "coding",
			dispatchAttemptId: "dispatch-1",
			kickoffBody: "Kickoff",
		});
		expect(result.backlog.status).toBe("dispatched");
		expect(result.thread.backlogItemId).toBe(item.id);
		expect(result.thread.phase).toBe("coding");
		expect(result.message).toMatchObject({ kind: "backlog_kickoff", authorKind: "system" });
		expect(result.queueEntry).toMatchObject({
			sourceId: result.message.id,
			sourceRecordId: item.id,
			sourceKind: "backlog_dispatch",
			targets: ["profile-coder"],
		});
		expect(result.audit?.action).toBe("backlog_dispatched");
		const replay = store.dispatchBacklog({
			backlogItemId: item.id,
			targets: ["profile-coder"],
			threadPhase: "coding",
			dispatchAttemptId: "dispatch-1",
		});
		expect(replay.thread.id).toBe(result.thread.id);
		expect(replay.message.id).toBe(result.message.id);
		expect(replay.queueEntry.id).toBe(result.queueEntry.id);
		expect(() =>
			store.dispatchBacklog({
				backlogItemId: item.id,
				targets: ["profile-coder"],
				threadPhase: "coding",
				dispatchAttemptId: "dispatch-2",
			}),
		).toThrow(ControlError);
		expect(store.backlog.markDone(item.id, "user-1").status).toBe("done");
	});

	it("does not create dispatch resources when the target is missing", () => {
		const item = createBacklog();
		store.backlog.approve(item.id, "user-1");
		const beforeThreads = store.threads.list().length;
		expect(() =>
			store.dispatchBacklog({
				backlogItemId: item.id,
				targets: ["missing-profile"],
				threadPhase: "coding",
			}),
		).toThrow(ControlError);
		expect(store.threads.list()).toHaveLength(beforeThreads);
		expect(store.backlog.get(item.id)?.status).toBe("approved");
	});

	it("stores artifacts content-addressed with 0600 files and provenance", () => {
		const { taskId } = createTask();
		const artifact = store.artifacts.put({
			taskId,
			kind: "test-report",
			content: Buffer.from("hello artifact"),
			mediaType: "text/plain",
			provenance: { sourceMessageId: "message-1" },
		});
		expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(statSync(artifact.path).mode & 0o777).toBe(0o600);
		expect(store.artifacts.get(artifact.id)).toMatchObject({ taskId, bytes: 14 });
		expect(store.artifacts.listByTask(taskId)).toHaveLength(1);
		expect(() =>
			store.artifacts.put({
				id: artifact.id,
				taskId,
				kind: "log",
				content: Buffer.from("duplicate"),
				mediaType: "text/plain",
				provenance: { sourceMessageId: "message-1" },
			}),
		).toThrow(ControlError);
		expect(() =>
			store.artifacts.put({
				taskId,
				kind: "log",
				content: Buffer.from("no source"),
				mediaType: "text/plain",
				provenance: {},
			}),
		).toThrow(ControlError);
	});

	it("creates, consumes, and expires typed inbox items", () => {
		const { taskId } = createTask();
		const steer = store.inbox.create({ taskId, kind: "steer", payload: { body: "stop" } });
		expect(store.inbox.list({ taskId, status: "pending" })).toHaveLength(1);
		expect(store.inbox.consume(steer.id)).toMatchObject({ status: "consumed", consumedAt: NOW });
		expect(() => store.inbox.consume(steer.id)).toThrow(ControlError);
		const guidance = store.inbox.create({ taskId, kind: "humanGuidance", payload: { body: "do this" } });
		expect(store.inbox.expire(guidance.id)).toMatchObject({ status: "expired", consumedAt: null });
	});

	it("appends and reads audit entries by subject", () => {
		const entry = store.audit.append({
			actor: "user:user-1",
			action: "test",
			subject: "subject:1",
			args: { value: 1 },
		});
		expect(store.audit.listSubject("subject:1")).toHaveLength(1);
		expect(store.audit.latest("subject:1", "test")?.id).toBe(entry.id);
		expect(() => store.database.prepare("UPDATE audit SET result = 'bad' WHERE id = ?").run(entry.id)).toThrow(
			/append_only/,
		);
	});
});
