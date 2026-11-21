import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { InvocationCredentialStore } from "../src/domains/auth/store.ts";
import { InvocationAttemptStore, InvocationRecordStore, TurnExecutionStore } from "../src/domains/invocation/store.ts";
import { ResponseDraftStore } from "../src/domains/response/store.ts";
import { AgentSessionStore } from "../src/domains/session/store.ts";
import { WorkerBindingStore, WorkerStore } from "../src/domains/worker/store.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";

const dirs: string[] = [];

function makeWorld() {
	const dir = mkdtempSync(join(tmpdir(), "f018-r2-"));
	dirs.push(dir);
	const db = new F018Database({ path: join(dir, "f018.db") });
	db.db
		.prepare(
			"INSERT INTO threads (id, project_path, created_by, last_active_at, created_at, updated_at) VALUES ('t1', '/p', 'u1', 1, 1, 1)",
		)
		.run();
	return {
		db,
		sessions: new AgentSessionStore(db.db),
		drafts: new ResponseDraftStore(db.db),
		creds: new InvocationCredentialStore(db.db),
		workers: new WorkerStore(db.db),
		bindings: new WorkerBindingStore(db.db),
		records: new InvocationRecordStore(db.db),
		turns: new TurnExecutionStore(db.db),
		attempts: new InvocationAttemptStore(db.db),
	};
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seedTurnChain(world: ReturnType<typeof makeWorld>): { turnId: string; attemptId: string; sessionId: string } {
	world.records.create({
		invocationId: "inv1",
		threadId: "t1",
		userId: "u1",
		sourceRecordId: "s1",
		userMessageId: null,
		targetAgentIds: ["a1"],
		now: 10,
	});
	world.turns.createRunning({
		turnExecutionId: "te1",
		parentInvocationId: "inv1",
		threadId: "t1",
		userId: "u1",
		agentId: "a1",
		executionKind: "ordinary",
		causal: { triggerMessageId: "m1" },
		startedAt: 100,
	});
	const attempt = world.attempts.appendQueued({
		attemptId: "at1",
		parentInvocationId: "inv1",
		queueEntryId: "q1",
		threadId: "t1",
		targetAgentId: "a1",
		attempt: 1,
		now: 10,
	});
	const session = world.sessions.ensureActive({
		threadId: "t1",
		agentId: "a1",
		userId: "u1",
		workingDirectory: "/p",
		now: 1,
	});
	return { turnId: "te1", attemptId: attempt.record.attemptId, sessionId: session.id };
}

describe("AgentSession review-round fixes (0010)", () => {
	it("seq starts at 0; re-ensure after seal increments; workspace change typed-rejects", () => {
		const { sessions } = makeWorld();
		const first = sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/p",
			now: 1,
		});
		expect(first.seq).toBe(0);
		expect(() =>
			sessions.ensureActive({ threadId: "t1", agentId: "a1", userId: "u1", workingDirectory: "/other", now: 2 }),
		).toThrow(/workspace_changed/);
		expect(() =>
			sessions.ensureActive({ threadId: "t1", agentId: "a2", userId: "u1", workingDirectory: "/notproj", now: 2 }),
		).toThrow(/not_thread_project/);
		sessions.sealActive(first.id, "cb", 10);
		const next = sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/p",
			now: 11,
		});
		expect(next.seq).toBe(1);
	});

	it("messageCount: first visible output 0→1; later turns count at completion (0010 §6)", () => {
		const { sessions } = makeWorld();
		const s = sessions.ensureActive({ threadId: "t1", agentId: "a1", userId: "u1", workingDirectory: "/p", now: 1 });
		sessions.recordUserVisibleOutput(s.id, "te1");
		expect(sessions.get(s.id)?.messageCount).toBe(1);
		sessions.recordUserVisibleOutput(s.id, "te1"); // replay
		expect(sessions.get(s.id)?.messageCount).toBe(1);
		// With messageCount ≥ 1 the output path no longer counts; the turn is
		// counted at completion (recordCompletedTurn), deduped per turn.
		sessions.recordUserVisibleOutput(s.id, "te2");
		expect(sessions.get(s.id)?.messageCount).toBe(1);
		expect(sessions.get(s.id)?.lastCountedTurnExecutionId).toBe("te1");
		sessions.recordCompletedTurn(s.id, { turnExecutionId: "te2", userVisibleOutput: true, now: 2 });
		expect(sessions.get(s.id)?.messageCount).toBe(2);
		expect(sessions.get(s.id)?.lastCountedTurnExecutionId).toBe("te2");
	});

	it("3 consecutive resume failures seals the session", () => {
		const { sessions } = makeWorld();
		const s = sessions.ensureActive({ threadId: "t1", agentId: "a1", userId: "u1", workingDirectory: "/p", now: 1 });
		sessions.recordResumeFailureWithSeal(s.id, "resume_failed", 2);
		sessions.recordResumeFailureWithSeal(s.id, "resume_failed", 3);
		expect(sessions.get(s.id)?.status).toBe("active");
		const sealed = sessions.recordResumeFailureWithSeal(s.id, "resume_failed", 4);
		expect(sealed?.status).toBe("sealed");
	});
});

describe("Draft review-round fixes (0017)", () => {
	it("upsert keyed by turn: a mismatched attempt writes nothing, returns null", () => {
		const world = makeWorld();
		const seeded = seedTurnChain(world);
		world.db.db
			.prepare(
				"INSERT INTO messages (id, thread_id, seq, author_kind, author_id, body_md, created_at, updated_at) VALUES ('rm-r', 't1', 1, 'agent', 'a1', '', 1, 1)",
			)
			.run();
		world.attempts.markStarting(seeded.attemptId, { agentSessionId: seeded.sessionId, now: 20 });
		world.attempts.bindAppended(seeded.attemptId, {
			turnExecutionId: seeded.turnId,
			agentSessionId: seeded.sessionId,
			workerId: null,
			provider: "p",
			model: "m",
			modelFamily: "f",
			responseMessageId: "rm-r",
			now: 30,
		});
		world.drafts.create({
			attemptId: seeded.attemptId,
			turnExecutionId: seeded.turnId,
			parentInvocationId: "inv1",
			threadId: "t1",
			agentId: "a1",
			content: "orig",
			toolEvents: [],
			thinking: null,
			createdAt: 1,
			updatedAt: 1,
		});
		const wrong = world.drafts.upsert({
			attemptId: "atWRONG",
			turnExecutionId: seeded.turnId,
			parentInvocationId: "inv1",
			threadId: "t1",
			agentId: "a1",
			content: "WRONG",
			toolEvents: [],
			thinking: null,
			createdAt: 1,
			updatedAt: 9,
		});
		expect(wrong).toBeNull();
		expect(world.drafts.getByTurn(seeded.turnId)?.content).toBe("orig");
	});

	it("create validates attempt↔turn/parent/thread/agent alignment", () => {
		const world = makeWorld();
		const seeded = seedTurnChain(world);
		expect(() =>
			world.drafts.create({
				attemptId: seeded.attemptId,
				turnExecutionId: "teOTHER",
				parentInvocationId: "inv1",
				threadId: "t1",
				agentId: "a1",
				content: "",
				toolEvents: [],
				thinking: null,
				createdAt: 1,
				updatedAt: 1,
			}),
		).toThrow(/turn_mismatch/);
	});
});

describe("Credential review-round fixes (0007 §3.7)", () => {
	it("commitTerminal is canonical-first: running child rejects; disposition must match child", () => {
		const world = makeWorld();
		const seeded = seedTurnChain(world);
		world.creds.create({
			turnExecutionId: seeded.turnId,
			parentInvocationId: "inv1",
			threadId: "t1",
			agentId: "a1",
			agentSessionId: seeded.sessionId,
			userId: "u1",
			allowedTools: [],
			now: 10,
		});
		expect(() => world.creds.commitTerminal(seeded.turnId, "completed")).toThrow(/child_not_terminal/);
		world.turns.transitionTerminal(seeded.turnId, { status: "failed", endedAt: 200, terminalReason: "boom" });
		expect(() => world.creds.commitTerminal(seeded.turnId, "completed")).toThrow(/disposition_mismatch/);
		expect(world.creds.commitTerminal(seeded.turnId, "failed").outcome).toBe("terminalized");
	});

	it("create validates agentSession ownership (thread/agent/user)", () => {
		const world = makeWorld();
		const seeded = seedTurnChain(world);
		db2(world);
		function db2(w: ReturnType<typeof makeWorld>) {
			w.db.db
				.prepare(
					`INSERT INTO agent_sessions (id, thread_id, agent_id, user_id, seq, status, working_directory, created_at, updated_at)
					 VALUES ('sess-t2', 't1', 'a2', 'u1', 0, 'active', '/p', 1, 1)`,
				)
				.run();
		}
		expect(() =>
			world.creds.create({
				turnExecutionId: seeded.turnId,
				parentInvocationId: "inv1",
				threadId: "t1",
				agentId: "a1",
				agentSessionId: "sess-t2",
				userId: "u1",
				allowedTools: [],
				now: 10,
			}),
		).toThrow(/session_agent_mismatch/);
	});

	it("replay with different allowedTools conflicts", () => {
		const world = makeWorld();
		const seeded = seedTurnChain(world);
		world.creds.create({
			turnExecutionId: seeded.turnId,
			parentInvocationId: "inv1",
			threadId: "t1",
			agentId: "a1",
			agentSessionId: seeded.sessionId,
			userId: "u1",
			allowedTools: ["post_message"],
			now: 10,
		});
		expect(() =>
			world.creds.create({
				turnExecutionId: seeded.turnId,
				parentInvocationId: "inv1",
				threadId: "t1",
				agentId: "a1",
				agentSessionId: seeded.sessionId,
				userId: "u1",
				allowedTools: ["multi_mention"],
				now: 20,
			}),
		).toThrow(/allowed_tools_conflict/);
	});
});

describe("Worker/WorkerBinding stores (0007 §3.5.2)", () => {
	it("bind is 1:1 both ways; rebind bumps generation; stale-generation unbind no-ops", () => {
		const world = makeWorld();
		const s1 = world.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/p",
			now: 1,
		});
		world.workers.ensure({
			workerId: "w1",
			poolKey: { projectPath: "/p", accountRef: "main", provider: "p", model: "m" },
			now: 1,
			leaseTtlMs: 1000,
		});
		world.workers.ensure({
			workerId: "w2",
			poolKey: { projectPath: "/p", accountRef: "main", provider: "p", model: "m" },
			now: 1,
			leaseTtlMs: 1000,
		});
		const b1 = world.bindings.bind({ agentSessionId: s1.id, workerId: "w1", now: 10 });
		expect(b1.generation).toBe(1);
		// second session cannot take w1
		const s2 = world.sessions.ensureActive({
			threadId: "t1",
			agentId: "a2",
			userId: "u1",
			workingDirectory: "/p",
			now: 2,
		});
		expect(() => world.bindings.bind({ agentSessionId: s2.id, workerId: "w1", now: 11 })).toThrow(/other_session/);
		// stale release (gen 1) after rebind to w2 (gen 2) no-ops
		const b2 = world.bindings.bind({ agentSessionId: s1.id, workerId: "w2", now: 12 });
		expect(b2.generation).toBe(2);
		expect(world.bindings.unbind(s1.id, 1)).toBe(false);
		expect(world.bindings.getBySession(s1.id)?.workerId).toBe("w2");
		expect(world.bindings.unbind(s1.id, 2)).toBe(true);
		expect(world.bindings.getBySession(s1.id)).toBeNull();
	});

	it("checkCapacity caps live workers at 8; reapExpired marks stale + reattach_pending", () => {
		const world = makeWorld();
		const key = { projectPath: "/p", accountRef: "main", provider: "p", model: "m" };
		expect(world.workers.checkCapacity(key).ok).toBe(true);
		for (let i = 1; i <= 8; i++) {
			world.workers.ensure({ workerId: `w${i}`, poolKey: key, now: 1, leaseTtlMs: 60_000 });
			world.workers.markOnline(`w${i}`, 100 + i, 2);
		}
		expect(world.workers.checkCapacity(key)).toEqual({ ok: false, reason: "worker_capacity" });
		// expire all leases → reap frees capacity
		expect(world.workers.reapExpired(999_999)).toBe(8);
		expect(world.workers.checkCapacity(key).ok).toBe(true);
		const s = world.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/p",
			now: 1,
		});
		world.workers.ensure({ workerId: "w9", poolKey: key, now: 3, leaseTtlMs: 60_000 });
		world.workers.markOnline("w9", 109, 4);
		world.bindings.bind({ agentSessionId: s.id, workerId: "w9", now: 5 });
		world.workers.reapExpired(999_999);
		expect(world.bindings.getBySession(s.id)?.state).toBe("reattach_pending");
	});
});

describe("004 down rebuilds attempts without session/worker FKs", () => {
	it("after migrateDown, invocation_attempts FK list has no agent_sessions/workers", () => {
		const dir = mkdtempSync(join(tmpdir(), "f018-down-"));
		dirs.push(dir);
		const db = new F018Database({ path: join(dir, "f018.db"), noMigrate: true });
		db.migrateUp();
		db.migrateDown(); // drops 006 (thread read state) first
		db.migrateDown(); // drops 005 (multi_mention)
		db.migrateDown(); // drops 004 tables
		const fks = (db.db.prepare("PRAGMA foreign_key_list(invocation_attempts)").all() as Array<{ table: string }>).map(
			(r) => r.table,
		);
		expect(fks).not.toContain("agent_sessions");
		expect(fks).not.toContain("workers");
		expect(fks).toContain("threads");
		db.close();
	});
});

describe("round-2 fixes", () => {
	it("revoked/replaced bypass disposition equality; running child still rejects", () => {
		const world = makeWorld();
		const seeded = seedTurnChain(world);
		world.creds.create({
			turnExecutionId: seeded.turnId,
			parentInvocationId: "inv1",
			threadId: "t1",
			agentId: "a1",
			agentSessionId: seeded.sessionId,
			userId: "u1",
			allowedTools: [],
			now: 10,
		});
		// running → revoked still rejected (canonical-first terminal gate)
		expect(() => world.creds.commitTerminal(seeded.turnId, "revoked")).toThrow(/child_not_terminal/);
		// interrupted child → revoked OK (orphan repair)
		world.turns.transitionTerminal(seeded.turnId, { status: "interrupted", endedAt: 200, terminalReason: "x" });
		expect(world.creds.commitTerminal(seeded.turnId, "revoked").outcome).toBe("terminalized");
	});

	it("replaced on canceled child with valid successor succeeds; wrong-parent successor rejects", () => {
		const world = makeWorld();
		const seeded = seedTurnChain(world);
		world.creds.create({
			turnExecutionId: seeded.turnId,
			parentInvocationId: "inv1",
			threadId: "t1",
			agentId: "a1",
			agentSessionId: seeded.sessionId,
			userId: "u1",
			allowedTools: [],
			now: 10,
		});
		world.turns.transitionTerminal(seeded.turnId, { status: "canceled", endedAt: 200, terminalReason: "op" });
		// successor in a different parent → typed reject
		world.db.db
			.prepare(
				"INSERT INTO threads (id, project_path, created_by, last_active_at, created_at, updated_at) VALUES ('t2', '/p', 'u1', 1, 1, 1)",
			)
			.run();
		world.records.create({
			invocationId: "inv2",
			threadId: "t2",
			userId: "u1",
			sourceRecordId: "s2",
			userMessageId: null,
			targetAgentIds: ["a1"],
			now: 10,
		});
		world.turns.createRunning({
			turnExecutionId: "te-out",
			parentInvocationId: "inv2",
			threadId: "t2",
			userId: "u1",
			agentId: "a1",
			executionKind: "ordinary",
			causal: { triggerMessageId: "m2" },
			startedAt: 300,
		});
		expect(() =>
			world.creds.commitTerminal(seeded.turnId, "replaced", { replacedByTurnExecutionId: "te-out" }),
		).toThrow(/successor_parent_mismatch/);
		// same-parent successor → replaced succeeds
		world.turns.createRunning({
			turnExecutionId: "te-ok",
			parentInvocationId: "inv1",
			threadId: "t1",
			userId: "u1",
			agentId: "a1",
			executionKind: "ordinary",
			causal: { triggerMessageId: "m3" },
			startedAt: 300,
		});
		const res = world.creds.commitTerminal(seeded.turnId, "replaced", { replacedByTurnExecutionId: "te-ok" });
		expect(res.outcome).toBe("terminalized");
	});

	it("completed turn resets consecutive resume failures", () => {
		const { sessions } = makeWorld();
		const s = sessions.ensureActive({ threadId: "t1", agentId: "a1", userId: "u1", workingDirectory: "/p", now: 1 });
		sessions.recordResumeFailureWithSeal(s.id, "f", 2);
		sessions.recordUserVisibleOutput(s.id, "te1"); // counts the first turn
		sessions.recordCompletedTurn(s.id, { turnExecutionId: "te1", userVisibleOutput: true, now: 3 }); // replay — still resets
		expect(sessions.get(s.id)?.consecutiveResumeFailures).toBe(0);
	});

	it("bind moving a session onto another session's worker is a typed conflict", () => {
		const world = makeWorld();
		const key = { projectPath: "/p", accountRef: "main", provider: "p", model: "m" };
		world.workers.ensure({ workerId: "wA", poolKey: key, now: 1, leaseTtlMs: 1000 });
		world.workers.ensure({ workerId: "wB", poolKey: key, now: 1, leaseTtlMs: 1000 });
		const s1 = world.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/p",
			now: 1,
		});
		const s2 = world.sessions.ensureActive({
			threadId: "t1",
			agentId: "a2",
			userId: "u1",
			workingDirectory: "/p",
			now: 2,
		});
		world.bindings.bind({ agentSessionId: s1.id, workerId: "wA", now: 10 });
		// s2 tries to MOVE onto wA (already s1's) → typed, not raw UNIQUE
		expect(() => world.bindings.bind({ agentSessionId: s2.id, workerId: "wA", now: 11 })).toThrow(/other_session/);
		// s1 rebinds to wB (free) → generation bump works
		const b = world.bindings.bind({ agentSessionId: s1.id, workerId: "wB", now: 12 });
		expect(b.generation).toBe(2);
	});

	it("ensure with same id but different poolKey is a typed conflict", () => {
		const world = makeWorld();
		world.workers.ensure({
			workerId: "w1",
			poolKey: { projectPath: "/p", accountRef: "main", provider: "p", model: "m" },
			now: 1,
			leaseTtlMs: 1000,
		});
		expect(() =>
			world.workers.ensure({
				workerId: "w1",
				poolKey: { projectPath: "/OTHER", accountRef: "main", provider: "p", model: "m" },
				now: 2,
				leaseTtlMs: 1000,
			}),
		).toThrow(/pool_key_conflict/);
	});
});
