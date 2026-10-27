import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyControlMigrations,
	CONTROL_TABLE_NAMES,
	ControlError,
	type ControlMigration,
	configureControlDatabase,
	getControlSchemaVersion,
	openControlDatabase,
	resolveControlBusyTimeoutMs,
} from "../src/index.ts";

const NOW = 1_700_000_000_000;

function createDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	configureControlDatabase(db);
	applyControlMigrations(db);
	return db;
}

function seedCore(db: DatabaseSync): void {
	db.prepare("INSERT INTO roles (id, label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
		"coder",
		"Coder",
		"active",
		NOW,
		NOW,
	);
	db.prepare(
		"INSERT INTO agent_profiles (id, role, display_name, provider, model, model_family, tool_policy_profile, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run("profile-1", "coder", "Coder", "test", "model", "family", "default", "active", NOW, NOW);
	db.prepare(
		"INSERT INTO backlog_items (id, user_id, title, summary, priority, tags_json, status, created_by_kind, created_by_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run("backlog-1", "user-1", "Backlog", "Summary", "p1", "[]", "open", "user", "user-1", NOW, NOW);
	db.prepare("INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
		"thread-1",
		"Thread",
		NOW,
		NOW,
	);
	db.prepare(
		"INSERT INTO tasks (id, kind, thread_id, title, why, owner_profile_id, status, created_by, backlog_item_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run("task-1", "work", "thread-1", "Task", "Why", "profile-1", "todo", "user", "backlog-1", NOW, NOW);
	db.prepare("INSERT INTO stages (id, task_id, lane, status, started_at) VALUES (?, ?, ?, ?, ?)").run(
		"stage-1",
		"task-1",
		"impl",
		"active",
		NOW,
	);
	db.prepare(
		"INSERT INTO messages (id, thread_id, task_id, author_kind, author_id, kind, seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run("message-1", "thread-1", "task-1", "user", "user-1", "chat", 1, NOW, NOW);
	db.prepare(
		"INSERT INTO agent_sessions (id, thread_id, task_id, profile_id, role, stage_id, provider, model, model_family, status, seq, effective_tool_policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		"session-1",
		"thread-1",
		"task-1",
		"profile-1",
		"coder",
		"stage-1",
		"test",
		"model",
		"family",
		"active",
		0,
		"default",
		NOW,
		NOW,
	);
	db.prepare(
		"INSERT INTO queue_entries (id, thread_id, source_id, source_kind, targets_json, author_intent_json, priority, source_category, order_key, status, enqueued_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		"queue-1",
		"thread-1",
		"message-1",
		"conversation_input",
		'["profile-1"]',
		'{"profile-1":"next_work"}',
		"normal",
		"a2a",
		"1",
		"queued",
		NOW,
		NOW,
	);
	db.prepare(
		"INSERT INTO runs (id, task_id, queue_entry_id, stage_id, role, agent_session_id, source_id, recipient_profile_id, provider, model, model_family, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		"run-1",
		"task-1",
		"queue-1",
		"stage-1",
		"coder",
		"session-1",
		"message-1",
		"profile-1",
		"test",
		"model",
		"family",
		"running",
		NOW,
	);
}

function seedHandoff(db: DatabaseSync): void {
	db.prepare(
		"INSERT INTO handoffs (id, task_id, stage_id, kind, from_role, to_role, status, subject, subject_ref, action_family, successor_slot, mode, owner_user_id, canonical_action_key, holder_profile_ids_json, holder_thread_id, claim_origin, generation, revision, dispatch_id, terminal_predicate_json, expected_artifact, payload_json, idempotency_key, deadline, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		"handoff-1",
		"task-1",
		"stage-1",
		"review_request",
		"coder",
		"coder",
		"pending",
		"Review",
		"pr:owner/repo#1",
		"review",
		"reviewer",
		"single",
		"user-1",
		"action-1",
		'["profile-1"]',
		"thread-1",
		"structured_transfer",
		1,
		0,
		"dispatch-1",
		'{"kind":"review_delivered","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
		"artifact-1",
		"{}",
		"idem-1",
		NOW,
		NOW,
	);
}

describe("codeteam control schema", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("opens a 0600 control.db under a 0700 data dir with the required PRAGMAs", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "codeteam-control-"));
		dirs.push(dataDir);
		const control = openControlDatabase({ dataDir });
		try {
			expect(statSync(dataDir).mode & 0o777).toBe(0o700);
			expect(statSync(control.path).mode & 0o777).toBe(0o600);
			expect(control.schemaVersion).toBe(5);
			expect((control.database.prepare("PRAGMA journal_mode").get() as { journal_mode?: string }).journal_mode).toBe(
				"wal",
			);
			expect((control.database.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number }).foreign_keys).toBe(
				1,
			);
			expect((control.database.prepare("PRAGMA busy_timeout").get() as { timeout?: number }).timeout).toBe(5000);
			const tables = control.database
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
				.all()
				.map((row) => (row as { name: string }).name);
			for (const table of [...CONTROL_TABLE_NAMES, "schema_migrations"]) expect(tables).toContain(table);
		} finally {
			control.close();
		}
	});

	it("reopens an already migrated database without duplicating migrations", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "codeteam-control-"));
		dirs.push(dataDir);
		openControlDatabase({ dataDir }).close();
		const control = openControlDatabase({ dataDir });
		try {
			expect(getControlSchemaVersion(control.database)).toBe(5);
			expect(
				(control.database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number })
					.count,
			).toBe(5);
		} finally {
			control.close();
		}
	});

	it("closes idempotently", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "codeteam-control-"));
		dirs.push(dataDir);
		const control = openControlDatabase({ dataDir });
		control.close();
		expect(() => control.close()).not.toThrow();
	});

	it("rolls back a failed migration and can resume from the prior version", () => {
		const db = new DatabaseSync(":memory:");
		configureControlDatabase(db);
		const broken: readonly ControlMigration[] = [
			{ version: 1, name: "one", statements: ["CREATE TABLE test_one (id TEXT PRIMARY KEY) STRICT"] },
			{
				version: 2,
				name: "broken",
				statements: [
					"CREATE TABLE test_two (id TEXT PRIMARY KEY) STRICT",
					"CREATE TABLE test_one (id TEXT PRIMARY KEY) STRICT",
				],
			},
		];
		expect(() => applyControlMigrations(db, broken)).toThrow(ControlError);
		expect(getControlSchemaVersion(db)).toBe(1);
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'test_%' ORDER BY name")
			.all()
			.map((row) => (row as { name: string }).name);
		expect(tables).toEqual(["test_one"]);
		const fixed: readonly ControlMigration[] = [
			broken[0]!,
			{ version: 2, name: "fixed", statements: ["CREATE TABLE test_two (id TEXT PRIMARY KEY) STRICT"] },
		];
		expect(applyControlMigrations(db, fixed).currentVersion).toBe(2);
		expect(getControlSchemaVersion(db)).toBe(2);
		db.close();
	});

	it("rejects a schema that is ahead of the known migration set", () => {
		const db = createDb();
		db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(6, "future", NOW);
		expect(() => applyControlMigrations(db)).toThrow(/schema contains migration 6/);
		db.close();
	});

	it("fails closed when a recorded migration left a table missing", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "codeteam-control-"));
		dirs.push(dataDir);
		const control = openControlDatabase({ dataDir });
		control.database.exec("DROP TABLE audit");
		control.close();
		expect(() => openControlDatabase({ dataDir })).toThrow(/missing tables: audit/);
	});

	it("enforces foreign keys and the work-task backlog binding", () => {
		const db = createDb();
		seedCore(db);
		expect(() =>
			db
				.prepare(
					"INSERT INTO tasks (id, kind, thread_id, title, why, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run("task-no-backlog", "work", "thread-1", "No backlog", "Why", "todo", "user", NOW, NOW),
		).toThrow(/CHECK constraint failed/);
		expect(() =>
			db
				.prepare(
					"INSERT INTO tasks (id, kind, thread_id, subject_key, title, why, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run("task-pr", "pr_tracking", "thread-1", "pr:owner/repo#1", "PR", "Why", "todo", "user", NOW, NOW),
		).not.toThrow();
		expect(() =>
			db
				.prepare(
					"INSERT INTO messages (id, thread_id, author_kind, author_id, kind, seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run("message-bad-thread", "missing-thread", "user", "user-1", "chat", 2, NOW, NOW),
		).toThrow(/FOREIGN KEY constraint failed/);
		db.close();
	});

	it("deduplicates message seq per thread and rejects cross-thread replies", () => {
		const db = createDb();
		seedCore(db);
		expect(() =>
			db
				.prepare(
					"INSERT INTO messages (id, thread_id, author_kind, author_id, kind, seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run("message-dup", "thread-1", "user", "user-1", "chat", 1, NOW, NOW),
		).toThrow(/UNIQUE constraint failed/);
		db.prepare("INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
			"thread-2",
			"Other",
			NOW,
			NOW,
		);
		db.prepare(
			"INSERT INTO messages (id, thread_id, author_kind, author_id, kind, seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run("message-2", "thread-2", "user", "user-1", "chat", 1, NOW, NOW);
		expect(() =>
			db
				.prepare(
					"INSERT INTO messages (id, thread_id, author_kind, author_id, kind, seq, reply_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run("message-cross-reply", "thread-1", "user", "user-1", "chat", 3, "message-2", NOW, NOW),
		).toThrow(/reply_to_cross_thread/);
		db.close();
	});

	it("forbids approval rich blocks in messages", () => {
		const db = createDb();
		seedCore(db);
		expect(() =>
			db
				.prepare(
					"INSERT INTO messages (id, thread_id, author_kind, author_id, kind, seq, rich_blocks_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run("message-approval", "thread-1", "agent", "profile-1", "chat", 2, '[{"kind":"approval"}]', NOW, NOW),
		).toThrow(/approval_rich_block_forbidden/);
		db.close();
	});

	it("keeps one queue entry per source", () => {
		const db = createDb();
		seedCore(db);
		expect(() =>
			db
				.prepare(
					"INSERT INTO queue_entries (id, thread_id, source_id, source_kind, targets_json, author_intent_json, priority, source_category, order_key, status, enqueued_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
				)
				.run(
					"queue-2",
					"thread-1",
					"message-1",
					"conversation_input",
					'["profile-1"]',
					"{}",
					"normal",
					"a2a",
					"2",
					NOW,
					NOW,
				),
		).toThrow(/UNIQUE constraint failed/);
		db.close();
	});

	it("sets a run queue reference to null when its queue entry is deleted", () => {
		const db = createDb();
		seedCore(db);
		db.prepare("DELETE FROM queue_entries WHERE id = 'queue-1'").run();
		const row = db.prepare("SELECT queue_entry_id FROM runs WHERE id = 'run-1'").get() as
			| { queue_entry_id?: string | null }
			| undefined;
		expect(row?.queue_entry_id).toBeNull();
		db.close();
	});

	it("allows one run response per message", () => {
		const db = createDb();
		seedCore(db);
		db.prepare("UPDATE runs SET response_message_id = 'message-1' WHERE id = 'run-1'").run();
		expect(() =>
			db
				.prepare(
					"INSERT INTO runs (id, task_id, queue_entry_id, role, agent_session_id, source_id, recipient_profile_id, provider, model, model_family, status, response_message_id, started_at, terminal_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)",
				)
				.run(
					"run-2",
					"task-1",
					"queue-1",
					"coder",
					"session-1",
					"message-1",
					"profile-1",
					"test",
					"model",
					"family",
					"message-1",
					NOW,
					NOW,
				),
		).toThrow(/UNIQUE constraint failed/);
		db.close();
	});

	it("keeps at most one running run per source and recipient", () => {
		const db = createDb();
		seedCore(db);
		expect(() =>
			db
				.prepare(
					"INSERT INTO runs (id, task_id, queue_entry_id, role, agent_session_id, source_id, recipient_profile_id, provider, model, model_family, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					"run-2",
					"task-1",
					"queue-1",
					"coder",
					"session-1",
					"message-1",
					"profile-1",
					"test",
					"model",
					"family",
					"running",
					NOW,
				),
		).toThrow(/UNIQUE constraint failed/);
		expect(() =>
			db
				.prepare(
					"INSERT INTO runs (id, task_id, queue_entry_id, role, agent_session_id, source_id, recipient_profile_id, provider, model, model_family, status, started_at, terminal_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					"run-3",
					"task-1",
					"queue-1",
					"coder",
					"session-1",
					"message-1",
					"profile-1",
					"test",
					"model",
					"family",
					"completed",
					NOW,
					NOW,
				),
		).not.toThrow();
		db.close();
	});

	it("rejects verified SOP checks before W4 evidence exists", () => {
		const db = createDb();
		seedCore(db);
		expect(() =>
			db
				.prepare(
					"INSERT INTO workflow_sops (backlog_item_id, feature_id, stage, baton_holder, resume_capsule_json, checks_json, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					"backlog-1",
					"F004",
					"kickoff",
					"profile-1",
					'{"goal":"g","done":[],"currentFocus":"c"}',
					'{"remoteMainSynced":"verified"}',
					1,
					NOW,
					"profile-1",
				),
		).toThrow(/verified_requires_evidence/);
		expect(() =>
			db
				.prepare(
					"INSERT INTO workflow_sops (backlog_item_id, feature_id, stage, baton_holder, resume_capsule_json, checks_json, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					"backlog-1",
					"F004",
					"kickoff",
					"profile-1",
					'{"goal":"g","done":[],"currentFocus":"c"}',
					'{"remoteMainSynced":"attested"}',
					1,
					NOW,
					"profile-1",
				),
		).not.toThrow();
		db.close();
	});

	it("keeps audit, custody events, and wait terminations append-only", () => {
		const db = createDb();
		seedCore(db);
		seedHandoff(db);
		db.prepare(
			"INSERT INTO audit (id, actor, action, subject, args_json, result, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run("audit-1", "profile-1", "test", "subject", "{}", "ok", NOW);
		expect(() => db.prepare("UPDATE audit SET result = 'bad' WHERE id = 'audit-1'").run()).toThrow(/append_only/);
		expect(() => db.prepare("DELETE FROM audit WHERE id = 'audit-1'").run()).toThrow(/append_only/);
		db.prepare(
			"INSERT INTO custody_events (id, subject_ref, handoff_id, generation, seq, classification, kind, actor_ref, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"custody-1",
			"pr:owner/repo#1",
			"handoff-1",
			1,
			1,
			"state-changing",
			"handoff.created",
			"profile-1",
			"{}",
			NOW,
		);
		expect(() =>
			db.prepare("UPDATE custody_events SET kind = 'handoff.expired' WHERE id = 'custody-1'").run(),
		).toThrow(/append_only/);
		db.prepare(
			"INSERT INTO waits (id, wait_id, generation, subject_ref, kind, wait_source_ref, baseline_json, continuation_json, owner_fence_json, status, sla_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run("wait:1:g1", "wait-1", 1, "subject", "timer", "source", "{}", "{}", "{}", "active", NOW, NOW);
		db.prepare(
			"INSERT INTO wait_terminations (event_id, wait_id, generation, wait_kind, reason, actor_json, subject_ref, owner_user_id, thread_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run("term-1", "wait-1", 1, "timer", "test", "{}", "subject", "user-1", "thread-1", NOW);
		expect(() => db.prepare("DELETE FROM wait_terminations WHERE event_id = 'term-1'").run()).toThrow(/append_only/);
		db.close();
	});

	it("enforces one active wait series and expected signals for event waits", () => {
		const db = createDb();
		seedCore(db);
		db.prepare(
			"INSERT INTO waits (id, wait_id, generation, subject_ref, kind, wait_source_ref, baseline_json, continuation_json, owner_fence_json, status, sla_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run("wait:1:g1", "wait-1", 1, "subject", "timer", "source", "{}", "{}", "{}", "active", NOW, NOW);
		expect(() =>
			db
				.prepare(
					"INSERT INTO waits (id, wait_id, generation, subject_ref, kind, wait_source_ref, baseline_json, continuation_json, owner_fence_json, status, sla_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run("wait:1:g2", "wait-1", 2, "subject", "timer", "source", "{}", "{}", "{}", "active", NOW, NOW),
		).toThrow(/UNIQUE constraint failed/);
		expect(() =>
			db
				.prepare(
					"INSERT INTO waits (id, wait_id, generation, subject_ref, kind, wait_source_ref, baseline_json, continuation_json, owner_fence_json, status, sla_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run("wait:2:g1", "wait-2", 1, "subject", "event", "source", "{}", "{}", "{}", "active", NOW, NOW),
		).toThrow(/CHECK constraint failed/);
		db.close();
	});

	it("enforces handoff canonical action uniqueness while keeping kind and action_family distinct", () => {
		const db = createDb();
		seedCore(db);
		seedHandoff(db);
		expect(() =>
			db
				.prepare(
					"INSERT INTO handoffs (id, task_id, kind, from_role, to_role, status, subject, subject_ref, action_family, successor_slot, mode, owner_user_id, canonical_action_key, holder_profile_ids_json, holder_thread_id, claim_origin, generation, revision, dispatch_id, terminal_predicate_json, expected_artifact, payload_json, idempotency_key, deadline, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					"handoff-2",
					"task-1",
					"handoff",
					"coder",
					"coder",
					"pending",
					"Handoff",
					"pr:owner/repo#1",
					"review",
					"reviewer",
					"single",
					"user-1",
					"action-1",
					'["profile-1"]',
					"thread-1",
					"structured_transfer",
					1,
					0,
					"dispatch-2",
					'{"kind":"review_delivered","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
					"artifact-1",
					"{}",
					"idem-2",
					NOW,
					NOW,
				),
		).toThrow(/UNIQUE constraint failed/);
		expect(() =>
			db
				.prepare(
					"INSERT INTO handoffs (id, task_id, kind, from_role, to_role, status, subject, subject_ref, action_family, successor_slot, mode, owner_user_id, canonical_action_key, holder_profile_ids_json, holder_thread_id, claim_origin, generation, revision, dispatch_id, terminal_predicate_json, expected_artifact, payload_json, idempotency_key, deadline, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					"handoff-3",
					"task-1",
					"handoff",
					"coder",
					"coder",
					"pending",
					"Handoff",
					"pr:owner/repo#2",
					"review",
					"reviewer",
					"single",
					"user-1",
					"action-2",
					'["profile-1"]',
					"thread-1",
					"structured_transfer",
					1,
					0,
					"dispatch-3",
					'{"kind":"review_delivered","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
					"artifact-1",
					"{}",
					"idem-3",
					NOW,
					NOW,
				),
		).not.toThrow();
		db.close();
	});

	it("enforces approval open uniqueness and rejected notes", () => {
		const db = createDb();
		seedCore(db);
		const insert = db.prepare(
			"INSERT INTO approvals (id, thread_id, task_id, kind, idempotency_key, origin_ref_json, card_ref_json, resolution, payload_json, requested_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		insert.run(
			"approval-1",
			"thread-1",
			"task-1",
			"design_gate",
			"idem-a",
			"{}",
			"{}",
			"open",
			"{}",
			"user-1",
			NOW,
			NOW,
		);
		expect(() =>
			insert.run(
				"approval-2",
				"thread-1",
				"task-1",
				"design_gate",
				"idem-b",
				"{}",
				"{}",
				"open",
				"{}",
				"user-1",
				NOW,
				NOW,
			),
		).toThrow(/UNIQUE constraint failed/);
		expect(() =>
			db
				.prepare(
					"UPDATE approvals SET resolution = 'rejected', decided_at = ?, decided_note = NULL WHERE id = 'approval-1'",
				)
				.run(NOW),
		).toThrow(/CHECK constraint failed/);
		expect(() =>
			db
				.prepare(
					"UPDATE approvals SET resolution = 'rejected', decided_at = ?, decided_note = 'not now' WHERE id = 'approval-1'",
				)
				.run(NOW),
		).not.toThrow();
		db.close();
	});

	it("enforces one active work binding per run and pr_tracking-only task bindings", () => {
		const db = createDb();
		seedCore(db);
		db.prepare(
			"INSERT INTO work_admissions (work_id, owner_user_id, producer_kind, producer_ref, initial_attempt_id, admitted_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run("work-1", "user-1", "workflow_sop_v1", "backlog-1", "attempt-1", NOW);
		db.prepare("INSERT INTO work_attempts (attempt_id, work_id, attempt_number, created_at) VALUES (?, ?, ?, ?)").run(
			"attempt-1",
			"work-1",
			1,
			NOW,
		);
		expect(() =>
			db
				.prepare(
					"INSERT INTO task_managed_work_bindings (task_id, work_id, attempt_id, bound_at) VALUES (?, ?, ?, ?)",
				)
				.run("task-1", "work-1", "attempt-1", NOW),
		).toThrow(/task_managed_work_requires_pr_tracking/);
		db.prepare(
			"INSERT INTO tasks (id, kind, thread_id, subject_key, title, why, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run("task-pr", "pr_tracking", "thread-1", "pr:owner/repo#1", "PR", "Why", "todo", "user", NOW, NOW);
		expect(() =>
			db
				.prepare(
					"INSERT INTO task_managed_work_bindings (task_id, work_id, attempt_id, bound_at) VALUES (?, ?, ?, ?)",
				)
				.run("task-pr", "work-1", "attempt-1", NOW),
		).not.toThrow();
		db.close();
	});

	it("enforces review session independence and forge delivery uniqueness", () => {
		const db = createDb();
		seedCore(db);
		db.prepare(
			"INSERT INTO agent_sessions (id, thread_id, task_id, profile_id, role, stage_id, provider, model, model_family, status, seq, effective_tool_policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"session-2",
			"thread-1",
			"task-1",
			"profile-1",
			"coder",
			"stage-1",
			"test",
			"model",
			"family",
			"active",
			1,
			"default",
			NOW,
			NOW,
		);
		const head = "a".repeat(40);
		expect(() =>
			db
				.prepare(
					"INSERT INTO reviews (id, task_id, run_id, head_sha, author_session_id, author_model, author_model_family, reviewer_session_id, reviewer_model, reviewer_model_family, review_mode, verdict, findings_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					"review-1",
					"task-1",
					"run-1",
					head,
					"session-1",
					"m1",
					"f1",
					"session-1",
					"m2",
					"f2",
					"cross_family",
					"approve",
					"[]",
					NOW,
				),
		).toThrow(/CHECK constraint failed/);
		expect(() =>
			db
				.prepare(
					"INSERT INTO reviews (id, task_id, run_id, head_sha, author_session_id, author_model, author_model_family, reviewer_session_id, reviewer_model, reviewer_model_family, review_mode, verdict, findings_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					"review-1",
					"task-1",
					"run-1",
					head,
					"session-1",
					"m1",
					"f1",
					"session-2",
					"m2",
					"f2",
					"cross_family",
					"approve",
					"[]",
					NOW,
				),
		).not.toThrow();
		const insertDelivery = db.prepare(
			"INSERT INTO forge_deliveries (id, provider, repo, delivery_id, natural_key, status, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		insertDelivery.run("delivery-1", "github", "owner/repo", "d-1", "n-1", "received", NOW);
		expect(() => insertDelivery.run("delivery-2", "github", "owner/repo", "d-1", "n-2", "received", NOW)).toThrow(
			/UNIQUE constraint failed/,
		);
		db.close();
	});

	it("rejects an invalid busy timeout", () => {
		expect(() => resolveControlBusyTimeoutMs(0)).toThrow(ControlError);
		expect(() => resolveControlBusyTimeoutMs(-1)).toThrow(ControlError);
		expect(() => resolveControlBusyTimeoutMs(1.5)).toThrow(ControlError);
	});
});
