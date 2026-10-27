import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlStore, ToolPolicy } from "../src/index.ts";
import { createToolPolicy, openControlStore } from "../src/index.ts";
import { type RecordReviewInput, ReviewService } from "../src/review/index.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const NEXT_HEAD = "c".repeat(40);

const dirs: string[] = [];
let root: string;
let worktree: string;
let store: ControlStore;
let service: ReviewService;
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
	store.audit.append({
		actor: "profile:coder",
		action: "commit_created",
		subject: `commit:${HEAD}`,
		args: { headSha: HEAD, taskId: task.id },
	});
	return { task, authorSession, reviewerSession, run };
}

function reviewInput(overrides: Partial<RecordReviewInput> = {}): RecordReviewInput {
	return {
		id: "review-service-1",
		taskId: context.task.id,
		runId: context.run.id,
		stage: "review",
		headSha: HEAD,
		baseSha: BASE,
		round: 1,
		diffArtifact: { artifactId: "artifact-diff", mediaType: "text/x-diff" },
		testEvidence: [{ kind: "test_report" as const, ref: "npm test", summary: "green" }],
		acceptanceCriteria: ["independent review", "falsifier closes findings"],
		impactSurface: {
			changedFiles: ["src/bug.ts"],
			changedSymbols: ["value"],
			callers: [],
			affectedTests: ["test/control-review-service.test.ts"],
		},
		constraints: { security: [], data: [], contract: [], other: [] },
		author: {
			sessionId: context.authorSession.id,
			profileId: "profile-coder",
			model: "deepseek-flash",
			modelFamily: "deepseek",
		},
		reviewer: {
			sessionId: context.reviewerSession.id,
			profileId: "profile-reviewer",
			model: "glm-5.3-flash",
			modelFamily: "glm",
		},
		reviewerContext: { fresh: true, blind: true, transcriptExcluded: true },
		risk: "code",
		verdict: "changes_requested",
		findings: [
			{
				severity: "P1",
				claim: "unverifiable",
				evidenceKind: "code_reading",
				falsifier: "",
				requiredAction: "add evidence",
			},
			{
				severity: "P2",
				file: "src/bug.ts",
				line: 1,
				claim: "seeded bug",
				evidenceKind: "static_check",
				falsifier: "grep -q BUG src/bug.ts",
				falsifierExpected: "zero",
				requiredAction: "fix",
			},
		],
		...overrides,
	};
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "codeteam-review-service-"));
	dirs.push(root);
	worktree = join(root, "worktree");
	const evidence = join(root, "evidence");
	const dataDir = join(root, "data");
	mkdirSync(join(worktree, "src"), { recursive: true });
	mkdirSync(evidence, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(join(worktree, "src", "bug.ts"), "// BUG: wrong value\n");
	store = openControlStore({ dataDir });
	context = setup();
	const verifierPolicy: ToolPolicy = createToolPolicy({
		role: "verifier",
		dataDir,
		worktreeRoot: worktree,
		evidenceRoot: evidence,
	});
	service = new ReviewService({ store, verifierPolicy, worktreeRoot: worktree });
});

afterEach(() => {
	store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("W3 review service", () => {
	it("records a review through policy, downgrades unverifiable findings, and audits the downgrade", () => {
		const result = service.recordReview(reviewInput());
		expect(result.review.baseSha).toBe(BASE);
		expect(result.review.authorProfileId).toBe("profile-coder");
		expect(result.review.reviewerProfileId).toBe("profile-reviewer");
		expect(result.review.riskClass).toBe("code");
		expect(result.review.reviewMode).toBe("cross_family");
		expect(result.review.findings.map((finding) => finding.severity)).toEqual(["P3", "P2"]);
		expect(result.downgrades).toHaveLength(1);
		expect(result.decision.mode).toBe("cross_family");
		expect(result.review.policy).toMatchObject({ risk: "code", mode: "cross_family" });
		const audit = store.audit.latest(`review:${result.review.id}`, "review_findings_downgraded");
		expect(audit?.args.downgrades).toEqual([expect.objectContaining({ from: "P1", to: "P3" })]);
	});

	it("verifies a finding through the real verifier policy and binds producing review + exact head", async () => {
		const result = service.recordReview(reviewInput());
		const finding = result.review.findings[1]!;
		const verified = await service.verifyFinding({ findingId: finding.id });
		expect(verified.execution.status).toBe("confirmed");
		expect(verified.verification).toMatchObject({
			findingId: finding.id,
			producingReviewId: result.review.id,
			headSha: HEAD,
			status: "confirmed",
			exitCode: 0,
		});
		expect(store.reviews.listVerifications(finding.id)).toHaveLength(1);
		const audit = store.audit.latest(`finding:${finding.id}`, "finding_verified");
		expect(audit?.args).toMatchObject({ producingReviewId: result.review.id, headSha: HEAD, status: "confirmed" });
	});

	it("invalidates the review when head moves and rejects actor/session lies", () => {
		const result = service.recordReview(reviewInput());
		expect(service.assessFreshness(result.review.id, HEAD, BASE).status).toBe("current");
		expect(service.assessFreshness(result.review.id, NEXT_HEAD, BASE).status).toBe("stale_head");

		expect(() =>
			service.recordReview(
				reviewInput({
					id: "review-actor-lie",
					author: {
						sessionId: context.authorSession.id,
						profileId: "profile-other",
						model: "deepseek-flash",
						modelFamily: "deepseek",
					},
				}),
			),
		).toThrow(/does not match session/i);
	});

	it("rejects an approve verdict while open P1/P2 findings remain", () => {
		expect(() => service.recordReview(reviewInput({ id: "review-approve", verdict: "approve" }))).toThrow(
			/open P1\/P2|approve verdict/i,
		);
	});
});
