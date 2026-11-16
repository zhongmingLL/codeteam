import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlStore } from "../src/index.ts";
import { openControlStore } from "../src/index.ts";

const HEAD = "a".repeat(40);

const dirs: string[] = [];
let now: number;
let store: ControlStore;

function seed() {
	store.seedIdentity({
		eval: { provider: "test", model: "eval-model", modelFamily: "eval-family" },
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
}

function base() {
	const backlog = store.backlog.create({
		id: "backlog-1",
		userId: "user-1",
		title: "Backlog",
		summary: "Summary",
		priority: "p1",
		tags: ["feature:F004"],
		createdByKind: "user",
		createdById: "user-1",
	});
	const thread = store.threads.create({ id: "thread-1", title: "Thread" });
	store.threads.linkBacklogItem(thread.id, { backlogItemId: backlog.id, phase: "coding" });
	const task = store.tasks.create({
		id: "task-1",
		kind: "work",
		threadId: thread.id,
		title: "Task",
		why: "Why",
		ownerProfileId: "profile-coder",
		createdBy: "user",
		userId: "user-1",
		backlogItemId: backlog.id,
	});
	const session = store.sessions.create({
		id: "session-coder",
		threadId: thread.id,
		taskId: task.id,
		profileId: "profile-coder",
		role: "coder",
		effectiveToolPolicy: "default",
		provider: "test",
		model: "deepseek-flash",
		modelFamily: "deepseek",
		seq: 0,
	});
	const source = store.messages.append({
		threadId: thread.id,
		authorKind: "user",
		authorId: "user-1",
		kind: "chat",
		bodyMd: "kickoff",
	});
	const queue = store.queue.admit({
		threadId: thread.id,
		sourceId: source.id,
		sourceKind: "conversation_input",
		targets: ["profile-coder"],
		sourceCategory: "a2a",
		orderKey: "1",
	});
	const run = store.runs.create({
		id: "run-coder",
		taskId: task.id,
		queueEntryId: queue.id,
		role: "coder",
		agentSessionId: session.id,
		sourceId: source.id,
		recipientProfileId: "profile-coder",
		provider: "test",
		model: "deepseek-flash",
		modelFamily: "deepseek",
	});
	return { backlog, thread, task, session, source, queue, run };
}

function reviewerSession(threadId: string, taskId: string) {
	return store.sessions.create({
		id: "session-reviewer",
		threadId,
		taskId,
		profileId: "profile:eval",
		role: "reviewer",
		effectiveToolPolicy: "default",
		provider: "test",
		model: "glm-5.3-flash",
		modelFamily: "glm",
		seq: 1,
	});
}

beforeEach(() => {
	const dataDir = mkdtempSync(join(tmpdir(), "codeteam-read-models-"));
	dirs.push(dataDir);
	now = 1_700_000_000_000;
	store = openControlStore({ dataDir, clock: () => now });
	seed();
});

afterEach(() => {
	store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codeteam console M0 read models", () => {
	it("summarizes threads with message, task, and queue counts", () => {
		const context = base();
		store.messages.append({
			threadId: context.thread.id,
			authorKind: "agent",
			authorId: "profile-coder",
			kind: "agent_response",
			bodyMd: "done",
			taskId: context.task.id,
		});
		const archived = store.threads.create({ id: "thread-2", title: "Archived" });
		store.threads.setStatus(archived.id, "archived");

		const summaries = store.readModels.threadSummaries();
		expect(summaries).toHaveLength(2);
		const first = summaries.find((entry) => entry.thread.id === context.thread.id)!;
		expect(first.messageCount).toBe(2);
		expect(first.lastMessageSeq).toBe(2);
		expect(first.lastMessageAt).toBe(now);
		expect(first.openTaskCount).toBe(1);
		expect(first.pendingQueueEntries).toBe(1);

		const archivedOnly = store.readModels.threadSummaries({ status: "archived" });
		expect(archivedOnly.map((entry) => entry.thread.id)).toEqual([archived.id]);
	});

	it("returns a thread timeline with ordered messages and thread events", () => {
		const context = base();
		store.messages.append({
			threadId: context.thread.id,
			authorKind: "agent",
			authorId: "profile-coder",
			kind: "agent_response",
			bodyMd: "second",
		});
		store.threadEvents.append(context.thread.id, "workflow_sop_updated", { stage: "impl" });

		const timeline = store.readModels.threadTimeline(context.thread.id)!;
		expect(timeline.messages.map((message) => message.seq)).toEqual([1, 2]);
		expect(timeline.events).toHaveLength(1);
		expect(timeline.events[0]?.kind).toBe("workflow_sop_updated");

		const page = store.readModels.threadTimeline(context.thread.id, { limit: 1 });
		expect(page?.messages.map((message) => message.seq)).toEqual([2]);
		expect(store.readModels.threadTimeline("missing-thread")).toBeNull();
	});

	it("collects task evidence from artifacts, reviews, merges, and approvals", () => {
		const context = base();
		const reviewer = reviewerSession(context.thread.id, context.task.id);
		store.artifacts.put({
			id: "artifact-diff",
			taskId: context.task.id,
			runId: context.run.id,
			kind: "diff",
			content: Buffer.from("diff --git a/file.ts b/file.ts\n"),
			mediaType: "text/x-diff",
			provenance: { sourceMessageId: context.source.id },
		});
		store.audit.append({
			actor: "profile:coder",
			action: "commit_created",
			subject: `commit:${HEAD}`,
			args: { headSha: HEAD, taskId: context.task.id },
		});
		store.reviews.create({
			id: "review-1",
			taskId: context.task.id,
			runId: context.run.id,
			headSha: HEAD,
			baseSha: "b".repeat(40),
			authorSessionId: context.session.id,
			authorModel: "deepseek-flash",
			authorModelFamily: "deepseek",
			reviewerSessionId: reviewer.id,
			reviewerModel: "glm-5.3-flash",
			reviewerModelFamily: "glm",
			authorProfileId: "profile-coder",
			reviewerProfileId: "profile:eval",
			riskClass: "code",
			reviewMode: "cross_family",
			verdict: "changes_requested",
			findings: [
				{
					severity: "P2",
					file: "src/a.ts",
					line: 10,
					claim: "real bug",
					evidenceKind: "red_test",
					falsifier: "node --test",
					requiredAction: "fix",
				},
			],
		});
		store.merges.create({
			id: "merge-1",
			taskId: context.task.id,
			baseSha: "b".repeat(40),
			headSha: HEAD,
			mergeSha: "c".repeat(40),
			policy: "merge-gate",
			executedBy: "service:merge-owner",
			gateEvidenceRef: "audit:test",
			reviewRef: "review-1",
			receiptRef: "receipt-1",
		});
		store.approvals.create({
			id: "approval-1",
			threadId: context.thread.id,
			taskId: context.task.id,
			kind: "merge",
			idempotencyKey: "approval-1",
			originRef: { kind: "review", reviewId: "review-1" },
			cardRef: { messageId: context.source.id },
			requestedBy: "profile-coder",
		});

		const evidence = store.readModels.taskEvidence(context.task.id)!;
		expect(evidence.task.id).toBe(context.task.id);
		expect(evidence.artifacts.map((artifact) => artifact.kind)).toEqual(["diff"]);
		expect(evidence.reviews).toHaveLength(1);
		expect(evidence.reviews[0]?.findings).toHaveLength(1);
		expect(evidence.merges.map((merge) => merge.id)).toEqual(["merge-1"]);
		expect(evidence.approvals.map((approval) => approval.id)).toEqual(["approval-1"]);
		expect(store.readModels.taskEvidence("missing-task")).toBeNull();
	});
});
