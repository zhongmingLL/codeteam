import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlError, type ControlStore, openControlStore, SopService } from "../src/index.ts";

const NOW = 1_700_000_000_000;
const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const MERGE = "c".repeat(40);
const dirs: string[] = [];
let store: ControlStore;
let sequence: number;

interface Case {
	readonly done: boolean;
	readonly operator: boolean;
	readonly merge: boolean;
	readonly vision: boolean;
	readonly stale?: boolean;
	readonly expected: "ok" | "error";
}

const cases: Case[] = [];
for (const done of [true, false]) {
	for (const operator of [true, false]) {
		for (const merge of [true, false]) {
			for (const vision of [true, false]) {
				cases.push({
					done,
					operator,
					merge,
					vision,
					expected: done && operator && merge && vision ? "ok" : "error",
				});
			}
		}
	}
}
cases.push({ done: true, operator: true, merge: true, vision: true, stale: true, expected: "error" });

function setupCase(input: Case) {
	sequence += 1;
	const backlog = store.backlog.create({
		id: `completion-${sequence}`,
		userId: "user-1",
		title: `Completion ${sequence}`,
		summary: "completion matrix",
		priority: "p2",
		tags: ["feature:F007"],
		createdByKind: "user",
		createdById: "operator:test",
		...(input.done ? { initialStatus: "done" as const, importReason: "matrix fixture" } : {}),
	});
	const thread = store.threads.create({
		id: `completion-thread-${sequence}`,
		backlogItemId: backlog.id,
		phase: "coding",
	});
	const task = store.tasks.create({
		id: `completion-task-${sequence}`,
		kind: "work",
		threadId: thread.id,
		title: `Completion task ${sequence}`,
		why: "completion matrix",
		ownerProfileId: "profile-coder",
		createdBy: "operator:test",
		userId: "user-1",
		backlogItemId: backlog.id,
	});
	if (input.merge) {
		store.database
			.prepare(
				"INSERT INTO merges (id, task_id, base_sha, head_sha, merge_sha, policy, approved_by, receipt_ref, executed_by, gate_evidence_ref, review_ref, status, hard_gate, created_at) VALUES (?, ?, ?, ?, ?, 'merge-gate', 'service:merge-owner', ?, 'service:merge-owner', 'audit:matrix', 'review:matrix', 'succeeded', 0, ?)",
			)
			.run(`merge-${sequence}`, task.id, BASE, HEAD, MERGE, `receipt-${sequence}`, NOW);
	}
	if (input.vision) {
		const verdict = store.messages.append({
			threadId: thread.id,
			authorKind: "agent",
			authorId: "profile:vision-guard",
			kind: "verdict",
			bodyMd: "accepted",
		});
		new SopService(store).recordEvidence({
			backlogItemId: backlog.id,
			checkName: "visionGuardDone",
			evidenceKind: "vision_guard",
			evidenceRef: `message:${verdict.id}`,
			subjectRevision: input.stale ? BASE : MERGE,
			recordedBy: "operator:test",
		});
	}
	return { backlog, thread, task };
}

function complete(input: Case, setup: ReturnType<typeof setupCase>) {
	return store.sops.upsert({
		backlogItemId: setup.backlog.id,
		featureId: "F007",
		stage: "completion",
		batonHolder: "operator",
		resumeCapsule: { goal: "matrix", done: [], currentFocus: "close" },
		checks: {
			remoteMainSynced: "unknown",
			qualityGatePassed: "unknown",
			reviewApproved: "unknown",
			visionGuardDone: "unknown",
		},
		updatedBy: input.operator ? "operator:test" : "profile-coder",
		completionSubjectRevision: MERGE,
	});
}

beforeEach(() => {
	const dataDir = mkdtempSync(join(tmpdir(), "codeteam-completion-"));
	dirs.push(dataDir);
	sequence = 0;
	store = openControlStore({ dataDir, clock: () => NOW });
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
});

afterEach(() => {
	store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SOP completion condition matrix", () => {
	it.each(cases)("done=$done operator=$operator merge=$merge vision=$vision stale=$stale -> $expected", (input) => {
		const setup = setupCase(input);
		if (input.expected === "ok") {
			expect(complete(input, setup).stage).toBe("completion");
			return;
		}
		let thrown: unknown;
		try {
			complete(input, setup);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ControlError);
		expect((thrown as ControlError).message).toMatch(/completion_gate_required/);
	});
});
