import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreateBacklogItemInput } from "../src/control/stores/types.ts";
import { ControlError, type ControlStore, openControlStore } from "../src/index.ts";

const NOW = 1_700_000_000_000;
const HEAD = "a".repeat(40);

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

function createSession(input: {
	id: string;
	threadId: string;
	taskId: string;
	profileId: string;
	role: string;
	seq?: number;
	model?: string;
	modelFamily?: string;
}) {
	return store.sessions.create({
		...input,
		effectiveToolPolicy: "default",
		provider: "test",
		model: input.model ?? "deepseek-flash",
		modelFamily: input.modelFamily ?? "deepseek",
		seq: input.seq ?? 0,
	});
}

function baseRun() {
	const backlog = createBacklog();
	const thread = createThread();
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
	const session = createSession({
		id: "session-coder",
		threadId: thread.id,
		taskId: task.id,
		profileId: "profile-coder",
		role: "coder",
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
		agentSessionId: session.id,
		sourceId: source.id,
		recipientProfileId: "profile-coder",
		provider: "test",
		model: "deepseek-flash",
		modelFamily: "deepseek",
	});
	return { backlog, thread, task, session, source, queue, run };
}

function createEvalRun(base: ReturnType<typeof baseRun>) {
	const session = createSession({
		id: "session-eval",
		threadId: base.thread.id,
		taskId: base.task.id,
		profileId: "profile:eval",
		role: "reviewer",
		seq: 1,
		model: "glm-5.3-flash",
		modelFamily: "glm",
	});
	const run = store.runs.create({
		id: "run-eval",
		taskId: base.task.id,
		queueEntryId: base.queue.id,
		role: "reviewer",
		agentSessionId: session.id,
		sourceId: base.source.id,
		recipientProfileId: "profile:eval",
		provider: "test",
		model: "glm-5.3-flash",
		modelFamily: "glm",
	});
	return { session, run };
}

function handoffInput(overrides: Record<string, unknown> = {}) {
	return {
		taskId: "task-1",
		kind: "review_request" as const,
		fromRole: "coder",
		toRole: "reviewer",
		subject: "Review",
		subjectRef: "pr:owner/repo#1",
		actionFamily: "review" as const,
		successorSlot: "reviewer" as const,
		mode: "single" as const,
		ownerUserId: "user-1",
		canonicalActionKey: "action-1",
		holderProfileIds: ["profile-coder"],
		holderThreadId: "thread-1",
		claimOrigin: "structured_transfer" as const,
		dispatchId: "dispatch-1",
		terminalPredicate: { kind: "review_delivered", headSha: HEAD },
		expectedArtifact: "artifact-1",
		payload: {},
		idempotencyKey: "idem-1",
		deadline: NOW + 100_000,
		...overrides,
	};
}

beforeEach(() => {
	const dataDir = mkdtempSync(join(tmpdir(), "codeteam-governance-"));
	dirs.push(dataDir);
	now = NOW;
	store = openControlStore({ dataDir, clock: () => now });
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
});

afterEach(() => {
	store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codeteam governance stores", () => {
	it("runs a single handoff from pending to consumed with custody events", () => {
		const base = baseRun();
		const handoff = store.handoffs.create(handoffInput());
		expect(handoff.status).toBe("pending");
		expect(store.handoffs.custodyEvents(handoff.id).map((event) => event.kind)).toEqual(["handoff.created"]);
		const claimed = store.handoffs.claim({
			handoffId: handoff.id,
			profileId: "profile-coder",
			runId: base.run.id,
		});
		expect(claimed.status).toBe("claimed");
		expect(
			store.handoffs.claim({ handoffId: handoff.id, profileId: "profile-coder", runId: base.run.id }).status,
		).toBe("claimed");
		expect(() =>
			store.handoffs.recordCompletionCandidate({
				handoffId: handoff.id,
				profileId: "profile-coder",
				runId: base.run.id,
				evidenceRef: "evidence-1",
				result: { ok: true },
			}),
		).not.toThrow();
		expect(() =>
			store.handoffs.commitCompletion({
				handoffId: handoff.id,
				profileId: "profile-coder",
				runId: base.run.id,
				evidenceRef: "evidence-1",
				result: { ok: true },
			}),
		).toThrow(ControlError);
		const consumed = store.handoffs.commitCompletion({
			handoffId: handoff.id,
			profileId: "profile-coder",
			runId: base.run.id,
			evidenceRef: "evidence-1",
			result: { ok: true },
			verified: true,
		});
		expect(consumed.status).toBe("consumed");
		expect(store.handoffs.custodyEvents(handoff.id).map((event) => event.kind)).toEqual([
			"handoff.created",
			"handoff.claimed",
			"handoff.completion_candidate",
			"handoff.completed",
		]);
		expect(store.handoffs.listClaims(handoff.id).every((claim) => claim.status === "released")).toBe(true);
	});

	it("handles single-holder conflicts, parallel claims, withdraw, and expire", () => {
		const base = baseRun();
		const evalRun = createEvalRun(base);
		const single = store.handoffs.create(
			handoffInput({ canonicalActionKey: "single", idempotencyKey: "idem-single" }),
		);
		store.handoffs.claim({ handoffId: single.id, profileId: "profile-coder", runId: base.run.id });
		expect(() =>
			store.handoffs.claim({ handoffId: single.id, profileId: "profile:eval", runId: evalRun.run.id }),
		).toThrow(ControlError);
		store.handoffs.releaseClaim(single.id, "profile-coder", "test release");
		const parallel = store.handoffs.create(
			handoffInput({
				kind: "handoff",
				actionFamily: "implement",
				successorSlot: "implementer",
				mode: "parallel",
				parallelIntent: "independent",
				holderProfileIds: ["profile-coder", "profile:eval"],
				canonicalActionKey: "parallel",
				idempotencyKey: "idem-parallel",
			}),
		);
		store.handoffs.claim({ handoffId: parallel.id, profileId: "profile-coder", runId: base.run.id });
		const both = store.handoffs.claim({ handoffId: parallel.id, profileId: "profile:eval", runId: evalRun.run.id });
		expect(both.status).toBe("claimed");
		expect(store.handoffs.releaseClaim(parallel.id, "profile-coder", "released").status).toBe("claimed");
		expect(store.handoffs.releaseClaim(parallel.id, "profile:eval", "released").status).toBe("pending");
		const withdrawn = store.handoffs.create(
			handoffInput({ canonicalActionKey: "withdraw", idempotencyKey: "idem-withdraw" }),
		);
		expect(store.handoffs.withdraw(withdrawn.id, "user:user-1", "no longer needed").status).toBe("withdrawn");
		const expired = store.handoffs.create(
			handoffInput({ canonicalActionKey: "expire", idempotencyKey: "idem-expire" }),
		);
		expect(store.handoffs.expire(expired.id, "system:deadline", "deadline").status).toBe("expired");
	});

	it("runs timer/event waits with one active series and canonical terminations", () => {
		const base = baseRun();
		const wait = store.waits.create({
			waitId: "wait-1",
			generation: 1,
			subjectRef: base.task.id,
			kind: "timer",
			waitSourceRef: "timer:1",
			baseline: {},
			continuation: {},
			ownerFence: { kind: "containing_task", generation: 1 },
			slaUntil: NOW + 1000,
		});
		expect(store.waits.listActive(base.task.id)).toHaveLength(1);
		const termination = store.waits.terminate({
			waitId: "wait-1",
			generation: 1,
			reason: "timeout",
			actor: { kind: "system", id: "timer" },
			ownerUserId: "user-1",
			threadId: base.thread.id,
		});
		expect(store.waits.get(wait.id)?.status).toBe("terminated");
		expect(store.waits.listTerminations("wait-1")).toHaveLength(1);
		expect(termination.eventId).toBeTruthy();
		expect(() =>
			store.waits.terminate({
				waitId: "wait-1",
				generation: 1,
				reason: "again",
				actor: {},
				ownerUserId: "user-1",
				threadId: base.thread.id,
			}),
		).toThrow(ControlError);
		expect(() =>
			store.waits.create({
				waitId: "wait-event",
				generation: 1,
				subjectRef: base.task.id,
				kind: "event",
				waitSourceRef: "event:1",
				baseline: {},
				continuation: {},
				ownerFence: {},
				slaUntil: NOW + 1000,
			}),
		).toThrow(ControlError);
		store.waits.create({
			waitId: "wait-event",
			generation: 1,
			subjectRef: base.task.id,
			kind: "event",
			waitSourceRef: "event:1",
			expectedSignal: "pr.merged",
			baseline: {},
			continuation: {},
			ownerFence: {},
			slaUntil: NOW + 1000,
		});
		store.waits.create({
			waitId: "wait-renew",
			generation: 1,
			subjectRef: base.task.id,
			kind: "timer",
			waitSourceRef: "timer:2",
			baseline: {},
			continuation: {},
			ownerFence: {},
			slaUntil: NOW + 1000,
		});
		const renewed = store.waits.renew({
			waitId: "wait-renew",
			generation: 1,
			next: {
				waitId: "wait-renew",
				generation: 2,
				subjectRef: base.task.id,
				kind: "timer",
				waitSourceRef: "timer:2",
				baseline: {},
				continuation: {},
				ownerFence: {},
				slaUntil: NOW + 2000,
			},
			ownerUserId: "user-1",
			threadId: base.thread.id,
		});
		expect(renewed.generation).toBe(2);
		expect(store.waits.getBySeries("wait-renew", 1)?.status).toBe("terminated");
	});

	it("enforces approval decisions, stale expiry, and reservation-only effect refs", () => {
		const base = baseRun();
		const approval = store.approvals.create({
			id: "approval-1",
			threadId: base.thread.id,
			taskId: base.task.id,
			kind: "design_gate",
			idempotencyKey: "approval-idem-1",
			originRef: { kind: "message", threadId: base.thread.id, messageId: base.source.id },
			cardRef: { kind: "message", threadId: base.thread.id, messageId: base.source.id },
			payload: {},
			requestedBy: "user-1",
			expiresAt: NOW + 1000,
		});
		expect(approval.resolution).toBe("open");
		expect(() =>
			store.approvals.create({
				id: "approval-dup",
				threadId: base.thread.id,
				taskId: base.task.id,
				kind: "design_gate",
				idempotencyKey: "approval-idem-1",
				originRef: {},
				cardRef: {},
				requestedBy: "user-1",
			}),
		).toThrow(ControlError);
		const accepted = store.approvals.decide("approval-1", { resolution: "accepted", decidedBy: "user-1" });
		expect(accepted.resolution).toBe("accepted");
		expect(() =>
			store.approvals.materialize("approval-1", {
				state: "succeeded",
				effectRef: "wrong",
			}),
		).toThrow(ControlError);
		const materialized = store.approvals.materialize("approval-1", {
			state: "succeeded",
			effectRef: accepted.effectReservationRef ?? undefined,
		});
		expect(materialized.materialization.state).toBe("succeeded");
		expect(materialized.effectRef).toBe(accepted.effectReservationRef);
		const rejected = store.approvals.create({
			id: "approval-2",
			threadId: base.thread.id,
			taskId: base.task.id,
			kind: "spec_change",
			idempotencyKey: "approval-idem-2",
			originRef: {},
			cardRef: {},
			requestedBy: "user-1",
		});
		expect(() => store.approvals.decide(rejected.id, { resolution: "rejected", decidedBy: "user-1" })).toThrow(
			ControlError,
		);
		expect(
			store.approvals.decide(rejected.id, { resolution: "rejected", decidedBy: "user-1", note: "not now" })
				.resolution,
		).toBe("rejected");
		const stale = store.approvals.create({
			id: "approval-stale",
			threadId: base.thread.id,
			taskId: base.task.id,
			kind: "blocker",
			idempotencyKey: "approval-idem-stale",
			originRef: {},
			cardRef: {},
			requestedBy: "user-1",
			expiresAt: NOW - 1,
		});
		expect(store.approvals.isStale(stale)).toBe(true);
		expect(() => store.approvals.decide(stale.id, { resolution: "accepted", decidedBy: "user-1" })).toThrow(
			ControlError,
		);
	});

	it("records reviews, downgrades unverifiable findings, and verifies findings", () => {
		const base = baseRun();
		const evalRun = createEvalRun(base);
		const sameFamilySession = createSession({
			id: "session-eval-same-family",
			threadId: base.thread.id,
			taskId: base.task.id,
			profileId: "profile:eval",
			role: "reviewer",
			seq: 2,
			model: "deepseek-chat",
			modelFamily: "deepseek",
		});
		store.audit.append({
			actor: "profile:coder",
			action: "commit_created",
			subject: `commit:${HEAD}`,
			args: { headSha: HEAD, taskId: base.task.id },
		});
		const review = store.reviews.create({
			id: "review-1",
			taskId: base.task.id,
			runId: base.run.id,
			headSha: HEAD,
			baseSha: "b".repeat(40),
			authorSessionId: base.session.id,
			authorModel: "deepseek-flash",
			authorModelFamily: "deepseek",
			reviewerSessionId: evalRun.session.id,
			reviewerModel: "glm-5.3-flash",
			reviewerModelFamily: "glm",
			authorProfileId: "profile-coder",
			reviewerProfileId: "profile:eval",
			riskClass: "code",
			reviewMode: "cross_family",
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
					file: "src/a.ts",
					line: 10,
					claim: "real bug",
					evidenceKind: "red_test",
					falsifier: "node --test",
					requiredAction: "fix",
				},
			],
		});
		expect(review.findings.map((finding) => finding.severity)).toEqual(["P3", "P2"]);
		const finding = review.findings[1]!;
		expect(store.reviews.getFindings(review.id)).toHaveLength(2);
		const verification = store.reviews.verify({
			findingId: finding.id,
			headSha: HEAD,
			producingReviewId: review.id,
			status: "confirmed",
			reason: "reproduced",
			command: "node --test",
			exitCode: 1,
		});
		expect(verification.status).toBe("confirmed");
		expect(store.reviews.listVerifications(finding.id)).toHaveLength(1);
		expect(() =>
			store.reviews.create({
				id: "review-same-session",
				taskId: base.task.id,
				runId: base.run.id,
				headSha: HEAD,
				baseSha: "b".repeat(40),
				authorSessionId: base.session.id,
				authorModel: "deepseek-flash",
				authorModelFamily: "deepseek",
				reviewerSessionId: base.session.id,
				reviewerModel: "deepseek-flash",
				reviewerModelFamily: "deepseek",
				authorProfileId: "profile-coder",
				reviewerProfileId: "profile-coder",
				riskClass: "low_risk_docs",
				reviewMode: "same_family_fresh",
				verdict: "approve",
				findings: [],
			}),
		).toThrow(ControlError);
		expect(() =>
			store.reviews.create({
				id: "review-same-family",
				taskId: base.task.id,
				runId: base.run.id,
				headSha: HEAD,
				baseSha: "b".repeat(40),
				authorSessionId: base.session.id,
				authorModel: "deepseek-flash",
				authorModelFamily: "deepseek",
				reviewerSessionId: sameFamilySession.id,
				reviewerModel: "deepseek-chat",
				reviewerModelFamily: "deepseek",
				authorProfileId: "profile-coder",
				reviewerProfileId: "profile:eval",
				riskClass: "code",
				reviewMode: "cross_family",
				verdict: "approve",
				findings: [],
			}),
		).toThrow(ControlError);
	});

	it("records merge receipts, budgets, evals, and forge deliveries", () => {
		const base = baseRun();
		const evalRun = createEvalRun(base);
		store.audit.append({
			actor: "profile:coder",
			action: "commit_created",
			subject: `commit:${HEAD}`,
			args: { headSha: HEAD, taskId: base.task.id },
		});
		const review = store.reviews.create({
			id: "review-merge",
			taskId: base.task.id,
			runId: base.run.id,
			headSha: HEAD,
			baseSha: "b".repeat(40),
			authorSessionId: base.session.id,
			authorModel: "deepseek-flash",
			authorModelFamily: "deepseek",
			reviewerSessionId: evalRun.session.id,
			reviewerModel: "glm-5.3-flash",
			reviewerModelFamily: "glm",
			authorProfileId: "profile-coder",
			reviewerProfileId: "profile:eval",
			riskClass: "code",
			reviewMode: "cross_family",
			verdict: "approve",
			findings: [],
		});
		const approval = store.approvals.create({
			id: "merge-approval",
			threadId: base.thread.id,
			taskId: base.task.id,
			kind: "merge",
			idempotencyKey: "merge-approval-idem",
			originRef: {},
			cardRef: {},
			requestedBy: "user-1",
		});
		store.approvals.decide(approval.id, { resolution: "accepted", decidedBy: "user-1" });
		const merge = store.merges.create({
			id: "merge-1",
			taskId: base.task.id,
			baseSha: HEAD,
			headSha: HEAD,
			mergeSha: HEAD,
			policy: "merge-owner",
			executedBy: "service:merge-owner",
			gateEvidenceRef: "audit:test",
			reviewRef: review.id,
			hardGate: true,
			receiptRef: "receipt-1",
			approvalId: approval.id,
		});
		expect(merge.approvalId).toBe(approval.id);
		expect(() =>
			store.merges.create({
				id: "merge-2",
				taskId: base.task.id,
				baseSha: HEAD,
				headSha: HEAD,
				mergeSha: HEAD,
				policy: "merge-owner",
				executedBy: "service:merge-owner",
				gateEvidenceRef: "audit:test",
				reviewRef: review.id,
				hardGate: true,
				receiptRef: "receipt-2",
				approvalId: approval.id,
			}),
		).toThrow(ControlError);
		expect(
			store.budgets.create({ id: "budget-1", taskId: base.task.id, tokensLimit: 100, tokensUsed: 10 }).tokensUsed,
		).toBe(10);
		expect(
			store.evals.create({
				id: "eval-1",
				taskId: base.task.id,
				provider: "test",
				model: "model",
				role: "coder",
				metrics: { score: 1 },
			}).metrics.score,
		).toBe(1);
		const delivery = store.forgeDeliveries.record({
			id: "delivery-1",
			provider: "github",
			repo: "owner/repo",
			deliveryId: "d-1",
			naturalKey: "n-1",
		});
		expect(() =>
			store.forgeDeliveries.record({
				id: "delivery-2",
				provider: "github",
				repo: "owner/repo",
				deliveryId: "d-1",
				naturalKey: "n-2",
			}),
		).toThrow(ControlError);
		expect(store.forgeDeliveries.markProcessed(delivery.id).status).toBe("processed");
		expect(store.forgeDeliveries.listUnprocessed()).toHaveLength(0);
	});
});
