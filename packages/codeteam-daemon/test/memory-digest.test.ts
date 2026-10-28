import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ControlStore, openControlStore } from "../src/index.ts";
import { buildSessionDigest } from "../src/memory/digest.ts";
import { ControlEvidenceReader } from "../src/memory/sources/control.ts";

const NOW = 1_700_000_000_000;
const HEAD = "b".repeat(40);
const BASE = "a".repeat(40);
const MERGE = "c".repeat(40);
const dirs: string[] = [];
let store: ControlStore | null = null;

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codeteam-memory-digest-"));
	dirs.push(dir);
	return dir;
}

function seed(dataDir: string): void {
	store = openControlStore({ dataDir, clock: () => NOW });
	store.seedIdentity({
		eval: { provider: "test", model: "eval-model", modelFamily: "eval-family" },
		compress: { provider: "test", model: "compress-model", modelFamily: "compress-family" },
	});
	store.profiles.create({
		id: "profile-coder",
		role: "coder",
		displayName: "Coder",
		provider: "test",
		model: "model-a",
		modelFamily: "family-a",
		toolPolicyProfile: "default",
	});
	store.profiles.create({
		id: "profile-reviewer",
		role: "reviewer",
		displayName: "Reviewer",
		provider: "test",
		model: "model-b",
		modelFamily: "family-b",
		toolPolicyProfile: "default",
	});
	store.backlog.create({
		id: "backlog-1",
		userId: "user-1",
		title: "W6a",
		summary: "Memory digest",
		priority: "p1",
		tags: ["feature:F012"],
		createdByKind: "user",
		createdById: "user-1",
	});
	store.threads.create({ id: "thread-1", title: "W6a", backlogItemId: "backlog-1" });
	store.database
		.prepare(
			"INSERT INTO tasks (id, kind, thread_id, title, why, status, created_by, backlog_item_id, related_feature_id, created_at, updated_at) VALUES (?, 'work', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run("task-1", "thread-1", "W6a task", "Implement memory digest", "doing", "user", "backlog-1", "F012", NOW, NOW);
	store.sessions.create({
		id: "sess-author",
		threadId: "thread-1",
		taskId: "task-1",
		profileId: "profile-coder",
		role: "coder",
		effectiveToolPolicy: "default",
		provider: "test",
		model: "model-a",
		modelFamily: "family-a",
		seq: 1,
	});
	store.sessions.create({
		id: "sess-reviewer",
		threadId: "thread-1",
		taskId: "task-1",
		profileId: "profile-reviewer",
		role: "reviewer",
		effectiveToolPolicy: "default",
		provider: "test",
		model: "model-b",
		modelFamily: "family-b",
		seq: 1,
	});
	store.database
		.prepare(
			"INSERT INTO queue_entries (id, thread_id, source_id, source_kind, targets_json, author_intent_json, priority, source_category, order_key, status, enqueued_at, updated_at) VALUES (?, ?, ?, 'test', '[\"profile-coder\"]', '{}', 'normal', 'test', '1', 'queued', ?, ?)",
		)
		.run("queue-1", "thread-1", "msg-1", NOW, NOW);
	store.database
		.prepare(
			`INSERT INTO runs (id, task_id, queue_entry_id, role, agent_session_id, source_id, recipient_profile_id, provider, model, model_family, status, execution_kind, started_at, terminal_at, usage_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ordinary', ?, ?, '{}')`,
		)
		.run(
			"run-1",
			"task-1",
			"queue-1",
			"coder",
			"sess-author",
			"msg-1",
			"profile-coder",
			"test",
			"model-a",
			"family-a",
			"completed",
			NOW,
			NOW + 1000,
		);
	const insertEvent = store.database.prepare(
		"INSERT INTO run_events (id, run_id, seq, kind, payload_json, ts) VALUES (?, 'run-1', ?, ?, ?, ?)",
	);
	insertEvent.run("event-1", 1, "message", JSON.stringify({ messageId: "msg-1" }), NOW + 10);
	insertEvent.run("event-2", 2, "tool_call", JSON.stringify({ toolName: "memory_recall" }), NOW + 20);
	insertEvent.run(
		"event-3",
		3,
		"error",
		JSON.stringify({ code: "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" }),
		NOW + 30,
	);
	store.database.exec("PRAGMA foreign_keys = OFF");
	store.database
		.prepare(
			`INSERT INTO reviews (id, task_id, run_id, head_sha, base_sha, author_session_id, author_model, author_model_family, reviewer_session_id, reviewer_model, reviewer_model_family, review_mode, verdict, findings_json, created_at, author_profile_id, reviewer_profile_id, risk_class, policy_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			"review-1",
			"task-1",
			"run-1",
			HEAD,
			BASE,
			"sess-author",
			"model-a",
			"family-a",
			"sess-reviewer",
			"model-b",
			"family-b",
			"cross_family",
			"changes_requested",
			"[]",
			NOW,
			"profile-coder",
			"profile-reviewer",
			"code",
			"{}",
		);
	store.database.exec("PRAGMA foreign_keys = ON");
	store.database
		.prepare(
			"INSERT INTO findings (id, review_id, finding_index, severity, file, line, claim, evidence_kind, falsifier, falsifier_expected, required_action) VALUES (?, ?, 0, 'P2', ?, 9, ?, 'code_reading', ?, 'nonzero', ?)",
		)
		.run(
			"finding-1",
			"review-1",
			"src/memory/digest.ts",
			"Digest must redact events",
			"rg token",
			"Redact summaries",
		);
	store.database
		.prepare(
			"INSERT INTO verifications (id, finding_id, head_sha, producing_review_id, status, reason, command, cwd, exit_code, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			"verify-1",
			"finding-1",
			HEAD,
			"review-1",
			"confirmed",
			"reproduced",
			"pnpm test digest",
			"/repo",
			0,
			30,
			NOW,
		);
	store.database
		.prepare(
			`INSERT INTO merges (id, task_id, base_sha, head_sha, merge_sha, policy, approved_by, receipt_ref, created_at, executed_by, gate_evidence_ref, status, hard_gate)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'service:merge-owner', ?, 'succeeded', 0)`,
		)
		.run("merge-1", "task-1", BASE, HEAD, MERGE, "routine", "operator", "receipt:merge-1", NOW, "gate:merge-1");
}

afterEach(() => {
	store?.close();
	store = null;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session digest", () => {
	it("projects canonical run/session/task/review/verification/merge truth with source refs", () => {
		const dataDir = tempDir();
		seed(dataDir);
		const reader = ControlEvidenceReader.open({ path: join(dataDir, "control.db") });
		try {
			const result = buildSessionDigest({ reader, runId: "run-1" });
			if (!result.found) throw new Error(`expected digest: ${result.reason}`);
			expect(result.digest).toMatchObject({
				runId: "run-1",
				sessionId: "sess-author",
				taskId: "task-1",
				threadId: "thread-1",
				role: "coder",
				status: "completed",
			});
			expect(result.digest.task).toMatchObject({ title: "W6a task", status: "doing" });
			expect(result.digest.eventCounts).toEqual({ message: 1, tool_call: 1, error: 1 });
			expect(result.digest.events.map((event) => event.kind)).toEqual(["message", "tool_call", "error"]);
			expect(result.digest.reviews[0]).toMatchObject({
				id: "review-1",
				verdict: "changes_requested",
				findingCount: 1,
			});
			expect(result.digest.verifications[0]).toMatchObject({
				id: "verify-1",
				command: "pnpm test digest",
				exitCode: 0,
			});
			expect(result.digest.merges[0]).toMatchObject({ id: "merge-1", mergeSha: MERGE, status: "succeeded" });
			expect(result.digest.sourceRefs).toEqual(
				expect.arrayContaining([
					"run:run-1",
					"session:sess-author",
					"task:task-1",
					"review:review-1",
					"verification:verify-1",
					"merge:merge-1",
				]),
			);
			const event = result.digest.events.find((entry) => entry.kind === "error");
			expect(event?.summary).not.toContain("ghp_");
			expect(event?.summary).toContain("[REDACTED:github_token]");
		} finally {
			reader?.close();
		}
	});

	it("redacts verification commands and task text at the digest outlet", () => {
		const dataDir = tempDir();
		seed(dataDir);
		const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
		store!.database
			.prepare("UPDATE verifications SET command = ? WHERE id = 'verify-1'")
			.run(`NPM_TOKEN=${secret} pnpm test`);
		store!.database
			.prepare("UPDATE tasks SET title = ?, why = ? WHERE id = 'task-1'")
			.run(`Task ${secret}`, `Why ${secret}`);
		const reader = ControlEvidenceReader.open({ path: join(dataDir, "control.db") });
		try {
			const result = buildSessionDigest({ reader, runId: "run-1" });
			if (!result.found) throw new Error("expected digest");
			expect(result.digest.verifications[0]?.command).toContain("[REDACTED:github_token]");
			expect(result.digest.verifications[0]?.command).not.toContain(secret);
			expect(result.digest.task?.title).toContain("[REDACTED:github_token]");
			expect(result.digest.task?.title).not.toContain(secret);
			expect(result.digest.task?.why).toContain("[REDACTED:github_token]");
			expect(result.digest.task?.why).not.toContain(secret);
		} finally {
			reader?.close();
		}
	});

	it("resolves a session to its latest run and bounds the event list", () => {
		const dataDir = tempDir();
		seed(dataDir);
		const reader = ControlEvidenceReader.open({ path: join(dataDir, "control.db") });
		try {
			const result = buildSessionDigest({ reader, sessionId: "sess-author", maxEvents: 1 });
			if (!result.found) throw new Error("expected digest");
			expect(result.digest.runId).toBe("run-1");
			expect(result.digest.events).toHaveLength(1);
			expect(result.digest.eventCounts).toMatchObject({ message: 1, tool_call: 1, error: 1 });
		} finally {
			reader?.close();
		}
	});

	it("degrades when the merges table is absent", () => {
		const dataDir = tempDir();
		seed(dataDir);
		store!.database.exec("DROP TABLE merges");
		const reader = ControlEvidenceReader.open({ path: join(dataDir, "control.db") });
		try {
			const result = buildSessionDigest({ reader, runId: "run-1" });
			if (!result.found) throw new Error("expected digest");
			expect(result.digest.merges).toEqual([]);
		} finally {
			reader?.close();
		}
	});

	it("fails closed when the control DB or run is unavailable", () => {
		const dataDir = tempDir();
		seed(dataDir);
		const reader = ControlEvidenceReader.open({ path: join(dataDir, "control.db") });
		try {
			expect(buildSessionDigest({ reader, runId: "missing-run" })).toEqual({
				found: false,
				reason: "run_not_found",
			});
		} finally {
			reader?.close();
		}
		expect(buildSessionDigest({ reader: null, runId: "run-1" })).toEqual({
			found: false,
			reason: "control_db_absent",
		});
	});
});
