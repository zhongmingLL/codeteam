import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlStore } from "../src/index.ts";
import { openControlStore } from "../src/index.ts";
import {
	buildReviewRequest,
	type ReviewActor,
	type ReviewerContext,
	type ReviewRequestInput,
} from "../src/review/index.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const author: ReviewActor = {
	sessionId: "session-coder",
	profileId: "profile-coder",
	model: "deepseek-flash",
	modelFamily: "deepseek",
};

const reviewer: ReviewActor = {
	sessionId: "session-reviewer",
	profileId: "profile-reviewer",
	model: "glm-5.3-flash",
	modelFamily: "glm",
};

const reviewerContext: ReviewerContext = { fresh: true, blind: true, transcriptExcluded: true };

const dirs: string[] = [];
let store: ControlStore;
let taskId: string;

function createTask() {
	store.profiles.create({
		id: "profile-coder",
		role: "coder",
		displayName: "Coder",
		provider: "test",
		model: "deepseek-flash",
		modelFamily: "deepseek",
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
	return store.tasks.create({
		id: "task-1",
		kind: "work",
		threadId: thread.id,
		title: "W3 task",
		why: "review evidence",
		ownerProfileId: "profile-coder",
		createdBy: "user",
		userId: "user-1",
		backlogItemId: backlog.id,
	}).id;
}

function request(overrides: Partial<ReviewRequestInput> = {}): ReviewRequestInput {
	return {
		taskId,
		stage: "review",
		headSha: HEAD,
		baseSha: BASE,
		round: 1,
		diffArtifact: { artifactId: "artifact-diff", mediaType: "text/x-diff", revision: "1" },
		testEvidence: [{ kind: "test_report", ref: "npm --prefix packages/codeteam-daemon test", summary: "green" }],
		acceptanceCriteria: ["reviewer is independent", "headSha is traceable"],
		impactSurface: {
			changedFiles: ["src/module.ts"],
			changedSymbols: ["moduleValue"],
			callers: ["recordReview"],
			affectedTests: ["test/control-review-policy.test.ts"],
		},
		constraints: { security: ["no author identity"], data: [], contract: ["ReviewPolicy"], other: [] },
		author,
		reviewer,
		reviewerContext,
		...overrides,
	};
}

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "codeteam-review-envelope-"));
	dirs.push(root);
	store = openControlStore({ dataDir: join(root, "data") });
	store.seedIdentity({
		eval: { provider: "test", model: "glm-5.3-flash", modelFamily: "glm" },
		compress: { provider: "test", model: "qwen3.8-flash", modelFamily: "qwen" },
	});
	taskId = createTask();
	store.audit.append({
		actor: "profile:coder",
		action: "commit_created",
		subject: `commit:${HEAD}`,
		args: { headSha: HEAD, taskId },
	});
});

afterEach(() => {
	store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("W3 blind review envelope", () => {
	it("contains only review evidence and never author identity, model, transcript, or summary", () => {
		const { envelope, decision } = buildReviewRequest(store, request());
		expect(decision.status).toBe("allowed");
		expect(decision.mode).toBe("cross_family");
		expect(envelope).toMatchObject({
			taskId: "task-1",
			stage: "review",
			headSha: HEAD,
			baseSha: BASE,
			round: 1,
		});
		expect(envelope.diffArtifact.artifactId).toBe("artifact-diff");
		expect(envelope.testEvidence).toHaveLength(1);
		expect(envelope.acceptanceCriteria).toHaveLength(2);
		expect(envelope.impactSurface.changedSymbols).toEqual(["moduleValue"]);
		expect(envelope.previousFindings).toEqual([]);

		const serialized = JSON.stringify(envelope);
		expect(serialized).not.toContain("SECRET AUTHOR TRANSCRIPT");
		expect(serialized).not.toContain("I already verified everything");
		expect(serialized).not.toContain("deepseek-flash");
		expect(serialized).not.toContain("session-coder");
		expect(serialized).not.toContain("profile-coder");
		expect(envelope).not.toHaveProperty("author");
		expect(envelope).not.toHaveProperty("authorModel");
		expect(envelope).not.toHaveProperty("authorSessionId");
	});

	it("only carries previous findings on a fix round with a stored previous review", () => {
		expect(() =>
			buildReviewRequest(
				store,
				request({
					previousFindings: [{ id: "finding-1", severity: "P2", claim: "old bug", requiredAction: "fix it" }],
				}),
			),
		).toThrow(/previous findings/i);

		expect(() => buildReviewRequest(store, request({ round: 2 }))).toThrow(/previousReviewId/i);
	});

	it("requires headSha to trace back to a coder commit audit", () => {
		expect(() => buildReviewRequest(store, request({ headSha: "c".repeat(40) }))).toThrow(/commit audit|trace/i);
	});

	it("derives low-risk docs from changed files and marks same_family_fresh", () => {
		const docs = buildReviewRequest(
			store,
			request({
				impactSurface: { ...request().impactSurface, changedFiles: ["docs/plans/0008.md"] },
				author: { ...author, model: "glm-5.3-flash", modelFamily: "glm" },
				reviewer: { ...reviewer, model: "glm-5.3-flash", modelFamily: "glm" },
				reviewerContext: { fresh: false, blind: true, transcriptExcluded: true },
			}),
		);
		expect(docs.envelope.policy.risk).toBe("low_risk_docs");
		expect(docs.decision.status).toBe("allowed");
		expect(docs.decision.mode).toBe("same_family_fresh");
	});

	it("rejects exact author identity in free-text evidence without substring false positives", () => {
		expect(() =>
			buildReviewRequest(store, request({ acceptanceCriteria: ["reviewer is independent", "deepseek-flash"] })),
		).toThrow(/author identity/i);
		expect(() =>
			buildReviewRequest(
				store,
				request({ acceptanceCriteria: ["reviewer is independent", "deepseek-flash-extra"] }),
			),
		).not.toThrow();
	});

	it("returns blocked or human_required instead of silently downgrading independence", () => {
		const sameFamily = buildReviewRequest(
			store,
			request({ reviewer: { ...reviewer, model: "deepseek-chat", modelFamily: "deepseek" } }),
		);
		expect(sameFamily.decision.status).toBe("blocked");
		expect(sameFamily.decision.mode).toBeNull();

		const highRisk = buildReviewRequest(
			store,
			request({
				impactSurface: {
					...request().impactSurface,
					changedFiles: ["src/auth/session.ts"],
				},
				reviewer: { ...reviewer, model: "deepseek-chat", modelFamily: "deepseek" },
			}),
		);
		expect(highRisk.decision.status).toBe("human_required");
		expect(highRisk.decision.requiresHumanGate).toBe(true);
	});
});
