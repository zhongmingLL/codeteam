import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlStore } from "../src/index.ts";
import { ControlError, openControlStore } from "../src/index.ts";
import { assertHeadTraceable, assessReviewFreshness } from "../src/review/index.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const NEXT_HEAD = "c".repeat(40);
const NEXT_BASE = "d".repeat(40);

const dirs: string[] = [];
let store: ControlStore;
let context: ReturnType<typeof setup>;

function setup() {
	store.seedIdentity({
		eval: { provider: "test", model: "glm-5.3-flash", modelFamily: "glm" },
		compress: { provider: "test", model: "qwen3.8-flash", modelFamily: "qwen" },
	});
	store.profiles.create({
		id: "profile-coder",
		role: "coder",
		displayName: "Coder",
		provider: "test",
		model: "deepseek-flash",
		modelFamily: "deepseek",
		toolPolicyProfile: "default",
	});
	store.profiles.create({
		id: "profile-reviewer",
		role: "reviewer",
		displayName: "Reviewer",
		provider: "test",
		model: "glm-5.3-flash",
		modelFamily: "glm",
		toolPolicyProfile: "default",
	});
	const backlog = store.backlog.create({
		id: "backlog-1",
		userId: "user-1",
		title: "W3",
		summary: "W3 review",
		priority: "p1",
		tags: ["feature:F006"],
		createdByKind: "user",
		createdById: "user-1",
	});
	const thread = store.threads.create({ id: "thread-1", title: "W3 thread" });
	const task = store.tasks.create({
		id: "task-1",
		kind: "work",
		threadId: thread.id,
		title: "W3 task",
		why: "review evidence",
		ownerProfileId: "profile-coder",
		createdBy: "user",
		userId: "user-1",
		backlogItemId: backlog.id,
	});
	const authorSession = store.sessions.create({
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
	const reviewerSession = store.sessions.create({
		id: "session-reviewer",
		threadId: thread.id,
		taskId: task.id,
		profileId: "profile-reviewer",
		role: "reviewer",
		effectiveToolPolicy: "default",
		provider: "test",
		model: "glm-5.3-flash",
		modelFamily: "glm",
		seq: 1,
	});
	const source = store.messages.append({
		threadId: thread.id,
		authorKind: "user",
		authorId: "user-1",
		kind: "chat",
		bodyMd: "source",
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
		agentSessionId: authorSession.id,
		sourceId: source.id,
		recipientProfileId: "profile-coder",
		provider: "test",
		model: "deepseek-flash",
		modelFamily: "deepseek",
	});
	return { task, authorSession, reviewerSession, run };
}

function commitAudit(headSha: string) {
	store.audit.append({
		actor: "profile:coder",
		action: "commit_created",
		subject: `commit:${headSha}`,
		args: { headSha, taskId: context.task.id },
	});
}

function createReview(overrides: Record<string, unknown> = {}) {
	return store.reviews.create({
		id: "review-1",
		taskId: context.task.id,
		runId: context.run.id,
		headSha: HEAD,
		baseSha: BASE,
		authorSessionId: context.authorSession.id,
		authorModel: "deepseek-flash",
		authorModelFamily: "deepseek",
		reviewerSessionId: context.reviewerSession.id,
		reviewerModel: "glm-5.3-flash",
		reviewerModelFamily: "glm",
		authorProfileId: "profile-coder",
		reviewerProfileId: "profile-reviewer",
		riskClass: "code",
		reviewMode: "cross_family",
		verdict: "changes_requested",
		findings: [
			{
				severity: "P2",
				file: "src/bug.ts",
				line: 1,
				claim: "bug",
				evidenceKind: "static_check",
				falsifier: "grep -q BUG src/bug.ts",
				falsifierExpected: "zero",
				requiredAction: "fix",
			},
		],
		...overrides,
	});
}

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "codeteam-review-head-"));
	dirs.push(root);
	store = openControlStore({ dataDir: join(root, "data") });
	context = setup();
	commitAudit(HEAD);
});

afterEach(() => {
	store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("W3 head SHA binding and invalidation", () => {
	it("requires a commit audit and records base/profile/risk evidence", () => {
		expect(assertHeadTraceable(store, HEAD, context.task.id).action).toBe("commit_created");
		expect(() => assertHeadTraceable(store, NEXT_HEAD, context.task.id)).toThrow(ControlError);
		expect(() => createReview({ headSha: NEXT_HEAD })).toThrow(/commit audit|trace/i);

		const review = createReview();
		expect(review.baseSha).toBe(BASE);
		expect(review.authorProfileId).toBe("profile-coder");
		expect(review.reviewerProfileId).toBe("profile-reviewer");
		expect(review.riskClass).toBe("code");
		expect(review.policy).toEqual({});
	});

	it("invalidates the review and all verifications when head or base moves", () => {
		const review = createReview();
		const current = assessReviewFreshness({ review, currentHeadSha: HEAD, currentBaseSha: BASE });
		expect(current.status).toBe("current");
		expect(current.reviewValid).toBe(true);
		expect(current.requiresFastReReview).toBe(false);

		const headMoved = assessReviewFreshness({ review, currentHeadSha: NEXT_HEAD, currentBaseSha: BASE });
		expect(headMoved.status).toBe("stale_head");
		expect(headMoved.reviewValid).toBe(false);
		expect(headMoved.requiresFastReReview).toBe(true);
		expect(headMoved.invalidatesVerifications).toBe(true);

		const baseMoved = assessReviewFreshness({ review, currentHeadSha: HEAD, currentBaseSha: NEXT_BASE });
		expect(baseMoved.status).toBe("stale_base");
		expect(baseMoved.reviewValid).toBe(false);
		expect(baseMoved.requiresRebase).toBe(true);
		expect(baseMoved.requiresTargetedTest).toBe(true);
		expect(baseMoved.requiresFastReReview).toBe(true);

		const bothMoved = assessReviewFreshness({ review, currentHeadSha: NEXT_HEAD, currentBaseSha: NEXT_BASE });
		expect(bothMoved.status).toBe("stale_head_and_base");
		expect(bothMoved.invalidatesVerifications).toBe(true);
	});

	it("fails closed for legacy reviews without a base SHA", () => {
		const legacy = { headSha: HEAD, baseSha: null };
		const freshness = assessReviewFreshness({ review: legacy, currentHeadSha: HEAD, currentBaseSha: BASE });
		expect(freshness.status).toBe("stale_base");
		expect(freshness.reviewValid).toBe(false);
	});

	it("binds every verification to the finding's producing review and exact head", () => {
		const review = createReview();
		const finding = review.findings[0]!;
		expect(() =>
			store.reviews.verify({
				findingId: finding.id,
				headSha: NEXT_HEAD,
				producingReviewId: review.id,
				status: "confirmed",
				reason: "wrong head",
			}),
		).toThrow(ControlError);
		expect(() =>
			store.reviews.verify({
				findingId: finding.id,
				headSha: HEAD,
				producingReviewId: "other-review",
				status: "confirmed",
				reason: "wrong review",
			}),
		).toThrow(ControlError);
		expect(
			store.reviews.verify({
				findingId: finding.id,
				headSha: HEAD,
				producingReviewId: review.id,
				status: "confirmed",
				reason: "reproduced",
				command: "grep -q BUG src/bug.ts",
				exitCode: 0,
			}).status,
		).toBe("confirmed");
	});

	it("rejects profile/model lies and unknown family claims at the store boundary", () => {
		expect(() => createReview({ authorProfileId: "profile-other" })).toThrow(
			/profile does not match|author profile/i,
		);
		expect(() => createReview({ reviewerModelFamily: "qwen" })).toThrow(/model\/family does not match/i);

		const unknownSession = store.sessions.create({
			id: "session-reviewer-unknown",
			threadId: context.task.threadId,
			taskId: context.task.id,
			profileId: "profile-reviewer",
			role: "reviewer",
			effectiveToolPolicy: "default",
			provider: "test",
			model: "mystery-model",
			modelFamily: "mystery",
			seq: 2,
		});
		expect(() =>
			createReview({
				reviewerSessionId: unknownSession.id,
				reviewerModel: "mystery-model",
				reviewerModelFamily: "mystery",
			}),
		).toThrow(/model family/i);
	});
});
