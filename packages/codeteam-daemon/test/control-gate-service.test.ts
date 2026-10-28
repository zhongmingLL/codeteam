import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ControlStore, GateService, openControlStore } from "../src/index.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const dirs: string[] = [];
let store: ControlStore;
let service: GateService;
let taskId: string;
let reviewId: string;

function setup() {
	store.seedIdentity({
		eval: { provider: "test", model: "glm-5.3-flash", modelFamily: "glm" },
		compress: { provider: "test", model: "qwen3.8-flash", modelFamily: "qwen" },
	});
	for (const [id, role, model, family] of [
		["profile-coder", "coder", "deepseek-flash", "deepseek"],
		["profile-reviewer", "reviewer", "glm-5.3-flash", "glm"],
	] as const) {
		store.profiles.create({
			id,
			role,
			displayName: id,
			provider: "test",
			model,
			modelFamily: family,
			toolPolicyProfile: "default",
		});
	}
	const backlog = store.backlog.create({
		id: "backlog-gate",
		userId: "user-1",
		title: "W4 gate",
		summary: "gate wiring",
		priority: "p1",
		tags: ["feature:F007"],
		createdByKind: "user",
		createdById: "user-1",
	});
	const thread = store.threads.create({ id: "thread-gate" });
	taskId = "task-gate";
	store.tasks.create({
		id: taskId,
		kind: "work",
		threadId: thread.id,
		title: "Gate task",
		why: "gate wiring",
		ownerProfileId: "profile-coder",
		createdBy: "user",
		userId: "user-1",
		backlogItemId: backlog.id,
	});
	const author = store.sessions.create({
		id: "session-author",
		threadId: thread.id,
		taskId,
		profileId: "profile-coder",
		role: "coder",
		effectiveToolPolicy: "default",
		provider: "test",
		model: "deepseek-flash",
		modelFamily: "deepseek",
		seq: 0,
	});
	const reviewer = store.sessions.create({
		id: "session-reviewer",
		threadId: thread.id,
		taskId,
		profileId: "profile-reviewer",
		role: "reviewer",
		effectiveToolPolicy: "default",
		provider: "test",
		model: "glm-5.3-flash",
		modelFamily: "glm",
		seq: 1,
	});
	const source = store.messages.append({ threadId: thread.id, authorKind: "user", authorId: "user-1", kind: "chat" });
	const queue = store.queue.admit({
		threadId: thread.id,
		sourceId: source.id,
		sourceKind: "conversation_input",
		targets: ["profile-coder"],
		sourceCategory: "a2a",
		orderKey: "1",
	});
	const run = store.runs.create({
		id: "run-gate",
		taskId,
		queueEntryId: queue.id,
		role: "coder",
		agentSessionId: author.id,
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
		args: { headSha: HEAD, taskId },
	});
	const review = store.reviews.create({
		id: "review-gate",
		taskId,
		runId: run.id,
		headSha: HEAD,
		baseSha: BASE,
		authorSessionId: author.id,
		authorModel: "deepseek-flash",
		authorModelFamily: "deepseek",
		reviewerSessionId: reviewer.id,
		reviewerModel: "glm-5.3-flash",
		reviewerModelFamily: "glm",
		authorProfileId: "profile-coder",
		reviewerProfileId: "profile-reviewer",
		riskClass: "code",
		reviewMode: "cross_family",
		verdict: "approve",
		findings: [
			{
				severity: "P2",
				file: "src/a.ts",
				line: 1,
				claim: "bug",
				evidenceKind: "red_test",
				falsifier: "node --test",
				requiredAction: "fix",
			},
		],
	});
	reviewId = review.id;
	return review.findings[0]!;
}

beforeEach(() => {
	const dataDir = mkdtempSync(join(tmpdir(), "codeteam-gate-service-"));
	dirs.push(dataDir);
	store = openControlStore({ dataDir });
	service = new GateService(store);
	setup();
});

afterEach(() => {
	store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("GateService wiring", () => {
	it("uses stored reviews and verifications for review/verify gates", () => {
		const finding = store.reviews.getFindings(reviewId)[0]!;
		const blocked = service.review({ taskId, headSha: HEAD, baseSha: BASE });
		expect(blocked.status).toBe("block");
		expect(blocked.findings.map((item) => item.code)).toContain("p1p2_without_verification");
		store.reviews.verify({
			findingId: finding.id,
			headSha: HEAD,
			producingReviewId: reviewId,
			status: "rejected",
			reason: "fixed",
			command: "node --test",
			exitCode: 0,
		});
		const review = service.review({ taskId, headSha: HEAD, baseSha: BASE });
		const verify = service.verify({ taskId, headSha: HEAD, baseSha: BASE });
		expect(review.status).toBe("pass");
		expect(verify.status).toBe("pass");
	});

	it("derives gate telemetry and pruning candidates from audit", () => {
		for (let index = 0; index < 20; index += 1) {
			store.audit.append({
				actor: "system:gate",
				action: "gate_evaluated",
				subject: "gate:docs",
				args: { gate: "docs", status: "pass", subjectRef: "test", codes: [] },
			});
		}
		const telemetry = service.telemetry(30);
		const docs = telemetry.gates.find((gate) => gate.gate === "docs");
		expect(docs).toMatchObject({ total: 20, passed: 20, blocked: 0, pruningCandidate: true });
	});
});
