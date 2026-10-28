import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ControlStore, openControlStore } from "../src/index.ts";
import { type MemoryDatabase, openMemoryDatabase } from "../src/memory/database.ts";
import { MemoryIndexer } from "../src/memory/indexer.ts";
import { ControlEvidenceReader } from "../src/memory/sources/control.ts";

const NOW = 1_700_000_000_000;
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const MERGE = "c".repeat(40);

const dirs: string[] = [];
let store: ControlStore | null = null;
let memory: MemoryDatabase | null = null;

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codeteam-memory-control-"));
	dirs.push(dir);
	return dir;
}

function seedControl(dataDir: string): void {
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
		summary: "Memory evidence",
		priority: "p1",
		tags: ["feature:F012"],
		createdByKind: "user",
		createdById: "user-1",
	});
	store.threads.create({ id: "thread-1", title: "W6a", backlogItemId: "backlog-1" });
	store.database
		.prepare(
			"INSERT INTO tasks (id, kind, thread_id, title, why, status, created_by, backlog_item_id, related_feature_id, repo, risk, lane, created_at, updated_at) VALUES (?, 'work', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			"task-1",
			"thread-1",
			"W6a task",
			"Implement memory evidence",
			"done",
			"user",
			"backlog-1",
			"F012",
			"codeteam",
			"code",
			"impl",
			NOW,
			NOW,
		);
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
	store.artifacts.put({
		id: "artifact-1",
		taskId: "task-1",
		kind: "test-report",
		mediaType: "text/markdown",
		content: Buffer.from("# Test report\n\nAll 42 tests pass with drill-down enabled.\n"),
		provenance: { sourceMessageId: "msg-1" },
		createdAt: NOW,
	});
	store.artifacts.put({
		id: "artifact-secret",
		taskId: "task-1",
		kind: "log",
		mediaType: "text/plain",
		content: Buffer.from("token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n"),
		provenance: { sourceMessageId: "msg-2" },
		createdAt: NOW + 1,
	});
	store.database.exec("PRAGMA foreign_keys = OFF");
	store.database
		.prepare(
			`INSERT INTO reviews (id, task_id, run_id, head_sha, base_sha, author_session_id, author_model, author_model_family, reviewer_session_id, reviewer_model, reviewer_model_family, review_mode, verdict, findings_json, created_at, author_profile_id, reviewer_profile_id, risk_class, policy_json, round, stage, previous_review_id, envelope_json, decision_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			1,
			"review",
			null,
			"{}",
			"{}",
		);
	store.database
		.prepare(
			"INSERT INTO findings (id, review_id, finding_index, severity, file, line, claim, evidence_kind, falsifier, falsifier_expected, required_action) VALUES (?, ?, 0, 'P2', ?, 42, ?, 'code_reading', ?, 'nonzero', ?)",
		)
		.run(
			"finding-1",
			"review-1",
			"src/memory/indexer.ts",
			"Secret scanner must skip values",
			"rg secret",
			"Skip the source and audit the pattern",
		);
	store.database
		.prepare(
			"INSERT INTO verifications (id, finding_id, head_sha, producing_review_id, status, reason, command, cwd, exit_code, duration_ms, stdout_tail, stderr_tail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			"verify-1",
			"finding-1",
			HEAD,
			"review-1",
			"confirmed",
			"reproduced with a fixture",
			"pnpm test memory",
			"/repo",
			0,
			120,
			"42 passed",
			null,
			NOW,
		);
	store.database
		.prepare(
			`INSERT INTO merges (id, task_id, base_sha, head_sha, merge_sha, policy, approved_by, receipt_ref, created_at, executed_by, gate_evidence_ref, status, hard_gate)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'service:merge-owner', ?, 'succeeded', 0)`,
		)
		.run("merge-1", "task-1", BASE, HEAD, MERGE, "routine", "operator", "receipt:merge-1", NOW, "gate:merge-1");
	store.database.exec("PRAGMA foreign_keys = ON");
}

afterEach(() => {
	memory?.close();
	memory = null;
	store?.close();
	store = null;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("control evidence adapter", () => {
	it("indexes tasks, artifacts, reviews, verifications and merges with canonical source refs", () => {
		const dataDir = tempDir();
		seedControl(dataDir);
		memory = openMemoryDatabase({ path: join(dataDir, "memory.db") });
		const summary = new MemoryIndexer(memory, { root: dataDir, dataDir, mode: "full", maxFileBytes: 4096 }).run();
		expect(summary.controlAvailable).toBe(true);
		expect(summary.controlTables).toEqual(
			expect.arrayContaining(["tasks", "artifacts", "reviews", "findings", "verifications", "merges"]),
		);
		expect(summary.counts.control).toBe(5);
		const audit = memory.database
			.prepare("SELECT source_path, detail FROM index_errors ORDER BY source_path")
			.all() as unknown as { source_path: string; detail: string }[];
		expect(audit).toContainEqual({ source_path: "artifact:artifact-secret", detail: "skipped:github_token" });
		const rows = memory.database
			.prepare(
				"SELECT anchor, kind, status, title, content, drill_down_json FROM evidence_items WHERE source_kind = 'control' ORDER BY anchor",
			)
			.all() as unknown as {
			anchor: string;
			kind: string;
			status: string;
			title: string;
			content: string;
			drill_down_json: string;
		}[];
		const byAnchor = new Map(rows.map((row) => [row.anchor, row]));
		expect(byAnchor.get("task:task-1")).toMatchObject({ kind: "task", status: "done", title: "W6a task" });
		expect(byAnchor.get("artifact:artifact-1")?.content).toContain("All 42 tests pass");
		expect(byAnchor.get("review:review-1")?.content).toContain("Secret scanner must skip values");
		expect(byAnchor.get("verification:verify-1")?.content).toContain("pnpm test memory");
		expect(byAnchor.get("merge:merge-1")?.content).toContain(MERGE);
		expect(JSON.parse(byAnchor.get("review:review-1")!.drill_down_json)).toMatchObject({
			kind: "control",
			table: "reviews",
			id: "review-1",
		});
		expect(byAnchor.has("artifact:artifact-secret")).toBe(false);
	});

	it("marks control evidence stale when the canonical row changes", () => {
		const dataDir = tempDir();
		seedControl(dataDir);
		const reader = ControlEvidenceReader.open({ path: join(dataDir, "control.db") });
		expect(reader).not.toBeNull();
		try {
			const source = {
				kind: "control" as const,
				ref: "task:task-1" as const,
				table: "tasks" as const,
				id: "task-1",
				sha256: "d".repeat(64),
				updatedAt: NOW,
			};
			expect(reader!.isStale(source)).toEqual({ stale: false, reasons: [] });
			store!.database.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(NOW + 1000, "task-1");
			expect(reader!.isStale(source)).toEqual({ stale: true, reasons: ["source_changed"] });
			expect(reader!.isStale({ ...source, id: "missing-task", ref: "task:missing-task" })).toEqual({
				stale: true,
				reasons: ["source_missing"],
			});
		} finally {
			reader!.close();
		}
	});

	it("degrades to file-only when the control DB is absent", () => {
		const dataDir = tempDir();
		writeFileSync(join(dataDir, "AGENTS.md"), "# Rules\n\nUse isolated stores.\n");
		memory = openMemoryDatabase({ path: join(dataDir, "memory.db") });
		const summary = new MemoryIndexer(memory, { root: dataDir, dataDir, mode: "full" }).run();
		expect(summary.controlAvailable).toBe(false);
		expect(summary.counts).toEqual({ file: 1, control: 0 });
		expect(summary.status).toBe("fresh");
	});
});
