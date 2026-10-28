import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SopChecks } from "../src/control/stores/types.ts";
import { ControlError, type ControlStore, openControlStore, SopService } from "../src/index.ts";

const NOW = 1_700_000_000_000;
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE = "c".repeat(40);

const dirs: string[] = [];
let now: number;
let store: ControlStore;
let sop: SopService;

const UNKNOWN_CHECKS: SopChecks = {
	remoteMainSynced: "unknown",
	qualityGatePassed: "unknown",
	reviewApproved: "unknown",
	visionGuardDone: "unknown",
};

function createBacklog(overrides: Record<string, unknown> = {}) {
	return store.backlog.create({
		id: "backlog-1",
		userId: "user-1",
		title: "W4",
		summary: "SOP and gates",
		priority: "p1",
		tags: ["feature:F007"],
		createdByKind: "user",
		createdById: "operator:test",
		...overrides,
	});
}

function sopInput(overrides: Record<string, unknown> = {}) {
	return {
		backlogItemId: "backlog-1",
		featureId: "F007",
		stage: "kickoff" as const,
		batonHolder: "profile-coder",
		resumeCapsule: { goal: "ship W4", done: [], currentFocus: "contract" },
		checks: UNKNOWN_CHECKS,
		updatedBy: "profile-coder",
		...overrides,
	};
}

function createDoneBacklogWithMerge() {
	const backlog = createBacklog({
		id: "backlog-done",
		initialStatus: "done",
		importReason: "operator imported done item",
	});
	const thread = store.threads.create({ id: "thread-done", backlogItemId: backlog.id, phase: "coding" });
	store.tasks.create({
		id: "task-done",
		kind: "work",
		threadId: thread.id,
		title: "W4 task",
		why: "deliver W4",
		ownerProfileId: "profile-coder",
		createdBy: "operator:test",
		userId: "user-1",
		backlogItemId: backlog.id,
	});
	store.database
		.prepare(
			"INSERT INTO merges (id, task_id, base_sha, head_sha, merge_sha, policy, approved_by, receipt_ref, executed_by, gate_evidence_ref, review_ref, status, hard_gate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'succeeded', 0, ?)",
		)
		.run(
			"merge-done",
			"task-done",
			BASE,
			HEAD,
			MERGE,
			"merge-gate",
			"service:merge-owner",
			"receipt:done",
			"service:merge-owner",
			"audit:gate",
			"review:test",
			NOW,
		);
	const verdict = store.messages.append({
		threadId: thread.id,
		authorKind: "agent",
		authorId: "profile:vision-guard",
		kind: "verdict",
		bodyMd: "accepted: W4 result matches the requested SOP",
	});
	return { backlog, thread, verdict };
}

beforeEach(() => {
	const dataDir = mkdtempSync(join(tmpdir(), "codeteam-sop-"));
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
	sop = new SopService(store);
});

afterEach(() => {
	store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codeteam SOP service", () => {
	it("projects verified checks only when the current revision matches the evidence", () => {
		createBacklog();
		store.sops.upsert(sopInput());
		store.sopEvidence.record({
			backlogItemId: "backlog-1",
			checkName: "remoteMainSynced",
			evidenceKind: "git_sync",
			evidenceRef: `git:${HEAD}`,
			subjectRevision: HEAD,
			recordedBy: "operator:test",
		});
		const fresh = sop.view("backlog-1", { currentRevisions: { remoteMainSynced: HEAD } });
		expect(fresh?.effectiveChecks.remoteMainSynced).toBe("verified");
		expect(fresh?.staleEvidence).toEqual([]);
		const stale = sop.view("backlog-1", { currentRevisions: { remoteMainSynced: BASE } });
		expect(stale?.effectiveChecks.remoteMainSynced).toBe("unknown");
		expect(stale?.staleEvidence).toEqual(["remoteMainSynced"]);
	});

	it("rejects mismatched check/evidence kinds and unresolvable refs", () => {
		createBacklog();
		expect(() =>
			sop.recordEvidence({
				backlogItemId: "backlog-1",
				checkName: "reviewApproved",
				evidenceKind: "git_sync",
				evidenceRef: `git:${HEAD}`,
				subjectRevision: HEAD,
				recordedBy: "operator:test",
			}),
		).toThrow(ControlError);
		expect(() =>
			sop.recordEvidence({
				backlogItemId: "backlog-1",
				checkName: "reviewApproved",
				evidenceKind: "review",
				evidenceRef: "review:missing",
				subjectRevision: HEAD,
				recordedBy: "operator:test",
			}),
		).toThrow(ControlError);
		expect(() =>
			sop.recordEvidence({
				backlogItemId: "backlog-1",
				checkName: "remoteMainSynced",
				evidenceKind: "git_sync",
				evidenceRef: `git:${BASE}`,
				subjectRevision: HEAD,
				recordedBy: "operator:test",
			}),
		).toThrow(ControlError);
	});

	it("enforces completion gate: backlog done, operator actor, merge receipt, fresh vision evidence", () => {
		const { backlog, verdict } = createDoneBacklogWithMerge();
		expect(() =>
			store.sops.upsert(sopInput({ backlogItemId: backlog.id, stage: "completion", updatedBy: "profile-coder" })),
		).toThrow(/completion_gate_required/);
		expect(() =>
			store.sops.upsert(
				sopInput({
					backlogItemId: backlog.id,
					stage: "completion",
					updatedBy: "operator:test",
				}),
			),
		).toThrow(/visionGuardDone evidence/);
		sop.recordEvidence({
			backlogItemId: backlog.id,
			checkName: "visionGuardDone",
			evidenceKind: "vision_guard",
			evidenceRef: `message:${verdict.id}`,
			subjectRevision: MERGE,
			recordedBy: "operator:test",
		});
		const completed = store.sops.upsert(
			sopInput({
				backlogItemId: backlog.id,
				stage: "completion",
				updatedBy: "operator:test",
				completionSubjectRevision: MERGE,
			}),
		);
		expect(completed.stage).toBe("completion");
		expect(store.sopEvidence.latest(backlog.id, "visionGuardDone")?.subjectRevision).toBe(MERGE);
	});

	it("does not create a work admission when a SOP is first created at completion", () => {
		const { backlog, verdict } = createDoneBacklogWithMerge();
		sop.recordEvidence({
			backlogItemId: backlog.id,
			checkName: "visionGuardDone",
			evidenceKind: "vision_guard",
			evidenceRef: `message:${verdict.id}`,
			subjectRevision: HEAD,
			recordedBy: "operator:test",
		});
		store.sops.upsert(
			sopInput({
				backlogItemId: backlog.id,
				stage: "completion",
				updatedBy: "operator:test",
				completionSubjectRevision: HEAD,
			}),
		);
		const count = store.database.prepare("SELECT COUNT(*) AS count FROM work_admissions").get() as { count: number };
		expect(count.count).toBe(0);
	});

	it("validates capsule size, next skill length, baton holder, and feature anchor immutability", () => {
		createBacklog();
		store.sops.upsert(sopInput());
		expect(() => store.sops.upsert(sopInput({ nextSkill: "x".repeat(129), expectedVersion: 1 }))).toThrow(
			ControlError,
		);
		expect(() => store.sops.upsert(sopInput({ batonHolder: "profile:missing", expectedVersion: 1 }))).toThrow(
			ControlError,
		);
		expect(() =>
			store.sops.upsert(
				sopInput({
					expectedVersion: 1,
					resumeCapsule: { goal: "ship", done: ["x".repeat(17_000)], currentFocus: "contract" },
				}),
			),
		).toThrow(ControlError);
		store.backlog.updateTags("backlog-1", ["feature:F007", "feature:F008"], "user", "operator:test");
		const updated = store.sops.upsert(sopInput({ featureId: "F008", expectedVersion: 1, stage: "impl" }));
		expect(updated.featureId).toBe("F007");
		expect(updated.stage).toBe("impl");
	});

	it("projects backlog audit newest-first with truncation cursor", () => {
		createBacklog();
		for (let index = 0; index < 3; index += 1) {
			store.audit.append({ actor: "operator:test", action: `event_${index}`, subject: "backlog:backlog-1" });
		}
		const view = store.backlog.getView("backlog-1", 2);
		expect(view?.audit).toHaveLength(2);
		expect(view?.auditTruncated).toBe(true);
		expect(view?.auditCursor).toBe(view?.audit[1]?.id);
		expect(view?.audit[0]?.action).toBe("event_2");
	});
});
