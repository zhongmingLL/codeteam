import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlError, type ControlStore, openControlStore, recoverControlPlane } from "../src/index.ts";

const NOW = 1_700_000_000_000;
const HEAD = "a".repeat(40);

const dirs: string[] = [];
let now: number;
let store: ControlStore;

function seed() {
	store.seedIdentity({
		eval: { provider: "test", model: "eval-model", modelFamily: "eval-family" },
		compress: { provider: "test", model: "compress-model", modelFamily: "test-family" },
	});
	for (const [id, role] of [
		["profile-coder", "coder"],
		["profile-reviewer", "reviewer"],
	] as const) {
		store.profiles.create({
			id,
			role,
			displayName: id,
			provider: "test",
			model: "model",
			modelFamily: "family",
			toolPolicyProfile: "default",
		});
	}
}

let sequence = 0;

function baseRun(profileId = "profile-coder", role = "coder") {
	sequence += 1;
	const suffix = String(sequence);
	const backlog = store.backlog.create({
		id: `backlog-${suffix}`,
		userId: "user-1",
		title: "Backlog",
		summary: "Summary",
		priority: "p1",
		tags: ["feature:F004"],
		createdByKind: "user",
		createdById: "user-1",
	});
	const thread = store.threads.create({ id: `thread-${suffix}`, title: "Thread" });
	const task = store.tasks.create({
		id: `task-${suffix}`,
		kind: "work",
		threadId: thread.id,
		title: "Task",
		why: "Why",
		ownerProfileId: profileId,
		createdBy: "user",
		userId: "user-1",
		backlogItemId: backlog.id,
	});
	const session = store.sessions.create({
		id: `session-${suffix}`,
		threadId: thread.id,
		taskId: task.id,
		profileId,
		role,
		effectiveToolPolicy: "default",
		provider: "test",
		model: "model",
		modelFamily: "family",
		seq: 0,
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
		targets: [profileId],
		sourceCategory: "a2a",
		orderKey: suffix,
	});
	const run = store.runs.create({
		id: `run-${suffix}`,
		taskId: task.id,
		queueEntryId: queue.id,
		role,
		agentSessionId: session.id,
		sourceId: source.id,
		recipientProfileId: profileId,
		provider: "test",
		model: "model",
		modelFamily: "family",
	});
	return { backlog, thread, task, session, source, queue, run };
}

function handoffInput(base: ReturnType<typeof baseRun>, overrides: Record<string, unknown> = {}) {
	sequence += 1;
	return {
		taskId: base.task.id,
		kind: "review_request" as const,
		fromRole: "coder",
		toRole: "reviewer",
		subject: "Review",
		subjectRef: `pr:owner/repo#${sequence}`,
		actionFamily: "review" as const,
		successorSlot: "reviewer" as const,
		mode: "single" as const,
		ownerUserId: "user-1",
		canonicalActionKey: `action-${sequence}`,
		holderProfileIds: ["profile-coder"],
		holderThreadId: base.thread.id,
		claimOrigin: "structured_transfer" as const,
		dispatchId: `dispatch-${sequence}`,
		terminalPredicate: { kind: "review_delivered", headSha: HEAD },
		expectedArtifact: "artifact-1",
		payload: {},
		idempotencyKey: `idem-${sequence}`,
		deadline: NOW + 100_000,
		...overrides,
	};
}

beforeEach(() => {
	const dataDir = mkdtempSync(join(tmpdir(), "codeteam-recovery-"));
	dirs.push(dataDir);
	now = NOW;
	store = openControlStore({ dataDir, clock: () => now });
	seed();
});

afterEach(() => {
	store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codeteam control plane recovery", () => {
	it("interrupts running runs and terminalizes their credentials", () => {
		const base = baseRun();
		const credential = store.credentials.create({
			tokenHash: "a".repeat(64),
			tokenSalt: "b".repeat(16),
			runId: base.run.id,
			taskId: base.task.id,
			role: "coder",
			agentSessionId: base.session.id,
			agentProfileId: "profile-coder",
			threadId: base.thread.id,
			userId: "user-1",
			ownerAuthProvenance: "strict",
			toolPolicy: {},
		});

		const report = recoverControlPlane(store, { now });

		expect(report.interruptedRuns).toEqual([{ runId: base.run.id, credentialId: credential.id }]);
		expect(store.runs.get(base.run.id)?.status).toBe("interrupted");
		expect(store.credentials.get(credential.id)?.state).toBe("terminal");
		expect(store.credentials.get(credential.id)?.disposition).toBe("interrupted");
		expect(store.audit.latest(`run:${base.run.id}`, "run_interrupted")).not.toBeNull();
		expect(report.pendingQueueEntries).toBeGreaterThan(0);
		expect(report.drainRequested).toBe(true);
	});

	it("leaves runs in the active worker set running", () => {
		const base = baseRun();
		const report = recoverControlPlane(store, { now, activeRunIds: [base.run.id] });
		expect(report.interruptedRuns).toHaveLength(0);
		expect(store.runs.get(base.run.id)?.status).toBe("running");
	});

	it("returns a stale single-holder claim to pending in the same generation", () => {
		const base = baseRun();
		const handoff = store.handoffs.create(handoffInput(base));
		store.handoffs.claim({ handoffId: handoff.id, profileId: "profile-coder", runId: base.run.id, leaseMs: 1_000 });
		now += 5_000;

		const report = recoverControlPlane(store, { now });

		const recovered = store.handoffs.get(handoff.id)!;
		expect(recovered.status).toBe("pending");
		expect(recovered.generation).toBe(1);
		expect(report.releasedClaims).toEqual([
			{ handoffId: handoff.id, profileId: "profile-coder", runId: base.run.id, reason: "run_interrupted" },
		]);
		const claims = store.handoffs.listClaims(handoff.id);
		expect(claims[0]?.status).toBe("released");
		expect(claims[0]?.releaseReason).toBe("run_interrupted");
	});

	it("releases a stale claim whose run already terminated as lease_expired", () => {
		const base = baseRun();
		const handoff = store.handoffs.create(handoffInput(base));
		store.handoffs.claim({ handoffId: handoff.id, profileId: "profile-coder", runId: base.run.id, leaseMs: 1_000 });
		store.runs.terminal(base.run.id, { status: "completed" });
		now += 5_000;

		const report = recoverControlPlane(store, { now });

		expect(store.handoffs.get(handoff.id)?.status).toBe("pending");
		expect(report.releasedClaims).toEqual([
			{ handoffId: handoff.id, profileId: "profile-coder", runId: base.run.id, reason: "lease_expired" },
		]);
	});

	it("expires handoffs past their explicit deadline and rejects late completion", () => {
		const base = baseRun();
		const handoff = store.handoffs.create(handoffInput(base, { deadline: NOW + 1_000 }));
		store.handoffs.claim({ handoffId: handoff.id, profileId: "profile-coder", runId: base.run.id });
		now += 2_000;

		const report = recoverControlPlane(store, { now, activeRunIds: [base.run.id] });

		expect(report.expiredHandoffs).toEqual([handoff.id]);
		expect(store.handoffs.get(handoff.id)?.status).toBe("expired");
		expect(() =>
			store.handoffs.commitCompletion({
				handoffId: handoff.id,
				profileId: "profile-coder",
				runId: base.run.id,
				evidenceRef: "evidence-late",
				result: { ok: true },
			}),
		).toThrow(ControlError);
	});

	it("prevents an interrupted run from completing the handoff it held", () => {
		const base = baseRun();
		const handoff = store.handoffs.create(handoffInput(base));
		store.handoffs.claim({ handoffId: handoff.id, profileId: "profile-coder", runId: base.run.id });

		recoverControlPlane(store, { now });

		expect(store.runs.get(base.run.id)?.status).toBe("interrupted");
		expect(() =>
			store.handoffs.commitCompletion({
				handoffId: handoff.id,
				profileId: "profile-coder",
				runId: base.run.id,
				evidenceRef: "evidence-late",
				result: { ok: true },
			}),
		).toThrow(ControlError);
	});

	it("keeps a parallel handoff claimed when only one holder is interrupted", () => {
		const coder = baseRun();
		const reviewer = baseRun("profile-reviewer", "reviewer");
		const handoff = store.handoffs.create(
			handoffInput(coder, {
				mode: "parallel",
				parallelIntent: "independent_review",
				holderProfileIds: ["profile-coder", "profile-reviewer"],
			}),
		);
		store.handoffs.claim({ handoffId: handoff.id, profileId: "profile-coder", runId: coder.run.id });
		store.handoffs.claim({ handoffId: handoff.id, profileId: "profile-reviewer", runId: reviewer.run.id });

		const report = recoverControlPlane(store, { now, activeRunIds: [reviewer.run.id] });

		expect(report.interruptedRuns.map((entry) => entry.runId)).toEqual([coder.run.id]);
		expect(store.handoffs.get(handoff.id)?.status).toBe("claimed");
		const claims = store.handoffs.listClaims(handoff.id);
		expect(claims.find((claim) => claim.profileId === "profile-coder")?.status).toBe("released");
		expect(claims.find((claim) => claim.profileId === "profile-reviewer")?.status).toBe("active");
	});

	it("is idempotent across repeated startup sweeps", () => {
		const base = baseRun();
		store.handoffs.create(handoffInput(base));
		recoverControlPlane(store, { now });

		const second = recoverControlPlane(store, { now });

		expect(second.interruptedRuns).toHaveLength(0);
		expect(second.expiredHandoffs).toHaveLength(0);
		expect(second.releasedClaims).toHaveLength(0);
	});

	it("requeues queue entries claimed by interrupted runs", () => {
		const base = baseRun();
		store.queue.claim(base.queue.id, { claimId: "claim-1", ownerRunId: base.run.id, ttlMs: 600_000 });

		const report = recoverControlPlane(store, { now });

		expect(report.requeuedQueueEntries).toEqual([base.queue.id]);
		expect(store.queue.get(base.queue.id)?.status).toBe("queued");
		expect(report.pendingQueueEntries).toBe(1);
		expect(report.drainRequested).toBe(true);
	});

	it("keeps queue claims owned by active runs even when the claim has expired", () => {
		const base = baseRun();
		store.queue.claim(base.queue.id, { claimId: "claim-1", ownerRunId: base.run.id, ttlMs: 1_000 });
		now += 5_000;

		const report = recoverControlPlane(store, { now, activeRunIds: [base.run.id] });

		expect(report.requeuedQueueEntries).toHaveLength(0);
		expect(store.queue.get(base.queue.id)?.status).toBe("claimed");
	});

	it("reports loop guard attempts and live handoffs per canonical action key", () => {
		const base = baseRun();
		const handoff = store.handoffs.create(handoffInput(base));
		const report = recoverControlPlane(store, { now });
		expect(report.loopGuard).toEqual([
			{ canonicalActionKey: store.handoffs.get(handoff.id)!.canonicalActionKey, attempts: 1, live: 1 },
		]);
	});
});
