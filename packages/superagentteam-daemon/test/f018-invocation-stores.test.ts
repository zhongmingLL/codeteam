import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { InvocationAttemptStore, InvocationRecordStore, TurnExecutionStore } from "../src/domains/invocation/store.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";

const dirs: string[] = [];

function makeStores(): {
	db: F018Database;
	records: InvocationRecordStore;
	turns: TurnExecutionStore;
	attempts: InvocationAttemptStore;
} {
	const dir = mkdtempSync(join(tmpdir(), "f018-inv-"));
	dirs.push(dir);
	const db = new F018Database({ path: join(dir, "f018.db") });
	return {
		db,
		records: new InvocationRecordStore(db.db),
		turns: new TurnExecutionStore(db.db),
		attempts: new InvocationAttemptStore(db.db),
	};
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seedThread(db: F018Database): void {
	db.db
		.prepare(
			"INSERT INTO threads (id, project_path, created_by, last_active_at, created_at, updated_at) VALUES ('t1', '/p', 'u1', 1, 1, 1)",
		)
		.run();
}

function seedMessage(db: F018Database, id: string): void {
	db.db
		.prepare(
			"INSERT INTO messages (id, thread_id, seq, author_kind, author_id, body_md, created_at, updated_at) VALUES (?, 't1', 1, 'system', 'test', '', 1, 1)",
		)
		.run(id);
}

function seedTurn(turns: TurnExecutionStore, id: string, agentId: string): void {
	turns.createRunning({
		turnExecutionId: id,
		parentInvocationId: "inv1",
		threadId: "t1",
		userId: "u1",
		agentId,
		executionKind: "ordinary",
		causal: { triggerMessageId: "m1" },
		startedAt: 5,
	});
}

function seedParent(records: InvocationRecordStore): string {
	records.create({
		invocationId: "inv1",
		threadId: "t1",
		userId: "u1",
		sourceRecordId: "s1",
		userMessageId: null,
		targetAgentIds: ["a1", "a2"],
		now: 10,
	});
	return "inv1";
}

describe("InvocationRecordStore (0007 §3.2)", () => {
	it("creates idempotently by sourceRecordId and flips queued→running (G-02)", () => {
		const { db, records } = makeStores();
		seedThread(db);
		records.create({
			invocationId: "inv1",
			threadId: "t1",
			userId: "u1",
			sourceRecordId: "s1",
			userMessageId: null,
			targetAgentIds: ["a1"],
			now: 10,
		});
		const again = records.create({
			invocationId: "invX",
			threadId: "t1",
			userId: "u1",
			sourceRecordId: "s1",
			userMessageId: null,
			targetAgentIds: ["a2"],
			now: 20,
		});
		expect(again.invocationId).toBe("inv1");
		expect(records.markRunning("inv1", 30)).toBe(true);
		expect(records.markRunning("inv1", 40)).toBe(false);
		expect(records.get("inv1")?.status).toBe("running");
	});

	it("successful agents union monotonically; retry flips failed→queued with retryCount+1", () => {
		const { db, records } = makeStores();
		seedThread(db);
		seedParent(records);
		records.markRunning("inv1", 20);
		records.addSuccessfulAgents("inv1", ["a1"]);
		records.addSuccessfulAgents("inv1", ["a1", "a2"]);
		expect(records.get("inv1")?.successfulAgentIds).toEqual(["a1", "a2"]);
		records.setTerminal("inv1", "partial_failed", "some_error", 100);
		expect(records.admitRetry("inv1")).toBe(true);
		const r = records.get("inv1")!;
		expect(r.status).toBe("queued");
		expect(r.retryCount).toBe(1);
		expect(r.endedAt).toBeNull();
	});
});

describe("TurnExecutionStore (0007 §3.6)", () => {
	function baseInput(now = 100) {
		return {
			turnExecutionId: "te1",
			parentInvocationId: "inv1",
			threadId: "t1",
			userId: "u1",
			agentId: "a1",
			executionKind: "ordinary" as const,
			causal: { triggerMessageId: "m1" },
			startedAt: now,
		};
	}

	it("createRunning is idempotent on full identity; startedAt excluded from identity", () => {
		const { db, turns, records } = makeStores();
		seedThread(db);
		seedParent(records);
		expect(turns.createRunning(baseInput(100)).outcome).toBe("created");
		const replay = turns.createRunning(baseInput(999));
		expect(replay.outcome).toBe("replayed");
		expect(replay.record.startedAt).toBe(100);
		expect(() => turns.createRunning({ ...baseInput(), agentId: "a2" })).toThrow(/identity/);
	});

	it("terminal is first-write-wins; same status idempotent, different conflicts", () => {
		const { db, turns, records } = makeStores();
		seedThread(db);
		seedParent(records);
		turns.createRunning(baseInput());
		expect(turns.transitionTerminal("te1", { status: "completed", endedAt: 200 }).outcome).toBe("transitioned");
		expect(turns.transitionTerminal("te1", { status: "completed", endedAt: 300 }).outcome).toBe("already_terminal");
		expect(turns.transitionTerminal("te1", { status: "failed", endedAt: 300, terminalReason: "x" }).outcome).toBe(
			"conflict",
		);
	});

	it("non-completed terminal requires reason; interruptRunningBefore respects cutoff+exclusions", () => {
		const { db, turns, records } = makeStores();
		seedThread(db);
		seedParent(records);
		turns.createRunning(baseInput(50));
		turns.createRunning({ ...baseInput(), turnExecutionId: "te2", agentId: "a2", startedAt: 150 });
		expect(() => turns.transitionTerminal("te2", { status: "failed", endedAt: 200 })).toThrow(/reason/);
		const converged = turns.interruptRunningBefore(100, {
			endedAt: 190,
			terminalReason: "process_restart",
			excludedTurnExecutionIds: [],
		});
		expect(converged.map((t) => t.turnExecutionId)).toEqual(["te1"]);
		expect(turns.get("te2")?.status).toBe("running");
	});
});

describe("InvocationAttemptStore (0007 §4.3.1 / 0016 §4)", () => {
	function seedAttempt(attempts: InvocationAttemptStore, attemptId = "at1", target = "a1", n = 1) {
		return attempts.appendQueued({
			attemptId,
			parentInvocationId: "inv1",
			queueEntryId: "q1",
			threadId: "t1",
			targetAgentId: target,
			attempt: n,
			now: 10,
		});
	}

	it("append-only ledger: (parent,target,attempt) idempotent; different queue = conflict", () => {
		const { db, records, attempts } = makeStores();
		seedThread(db);
		seedParent(records);
		expect(seedAttempt(attempts).outcome).toBe("created");
		expect(seedAttempt(attempts).outcome).toBe("replayed");
		const clash = attempts.appendQueued({
			attemptId: "atX",
			parentInvocationId: "inv1",
			queueEntryId: "q2",
			threadId: "t1",
			targetAgentId: "a1",
			attempt: 1,
			now: 11,
		});
		expect(clash.outcome).toBe("conflict");
	});

	it("delivery lifecycle: queued→starting→appended→handled with bind idempotence", () => {
		const { db, records, turns, attempts } = makeStores();
		seedThread(db);
		seedParent(records);
		seedAttempt(attempts);
		seedTurn(turns, "te1", "a1");
		seedMessage(db, "rm1");
		attempts.markStarting("at1", { agentSessionId: "sess1", now: 20 });
		const appended = attempts.bindAppended("at1", {
			turnExecutionId: "te1",
			agentSessionId: "sess1",
			workerId: null,
			provider: "zhipu",
			model: "glm-5.3",
			modelFamily: "glm",
			responseMessageId: "rm1",
			now: 30,
		})!;
		expect(appended.deliveryState).toBe("appended");
		expect(appended.settlement).toBe("streaming");
		// idempotent re-bind with same identity
		expect(
			attempts.bindAppended("at1", {
				turnExecutionId: "te1",
				agentSessionId: "sess1",
				workerId: null,
				provider: "zhipu",
				model: "glm-5.3",
				modelFamily: "glm",
				responseMessageId: "rm1",
				now: 40,
			})!.deliveryState,
		).toBe("appended");
		// different identity fails closed
		expect(() =>
			attempts.bindAppended("at1", {
				turnExecutionId: "te2",
				agentSessionId: "sess1",
				workerId: null,
				provider: "zhipu",
				model: "glm-5.3",
				modelFamily: "glm",
				responseMessageId: "rm2",
				now: 41,
			}),
		).toThrow(/rebind/);
		attempts.bindWorker("at1", "w1");
		attempts.markPromptDelivered("at1", { deliveryBoundarySeq: 3, now: 45 });
		const projected = attempts.projectChildTerminal("at1", {
			turnExecutionId: "te1",
			childStatus: "completed",
			terminalReason: null,
			endedAt: 50,
		});
		expect(projected.outcome).toBe("transitioned");
		const done = attempts.get("at1")!;
		expect(done.deliveryState).toBe("handled");
		expect(done.settlement).toBe("response_pending");
	});

	it("projectChildTerminal is canonical-first: same status idempotent, different conflicts", () => {
		const { db, records, turns, attempts } = makeStores();
		seedThread(db);
		seedParent(records);
		seedAttempt(attempts);
		seedTurn(turns, "te1", "a1");
		seedMessage(db, "r");
		attempts.markStarting("at1", { agentSessionId: "s", now: 20 });
		attempts.bindAppended("at1", {
			turnExecutionId: "te1",
			agentSessionId: "s",
			workerId: null,
			provider: "p",
			model: "m",
			modelFamily: "f",
			responseMessageId: "r",
			now: 30,
		});
		attempts.projectChildTerminal("at1", {
			turnExecutionId: "te1",
			childStatus: "failed",
			terminalReason: "boom",
			endedAt: 40,
		});
		expect(
			attempts.projectChildTerminal("at1", {
				turnExecutionId: "te1",
				childStatus: "failed",
				terminalReason: "boom",
				endedAt: 45,
			}).outcome,
		).toBe("terminal_conflict");
	});

	it("queued→failed is target_invalid-only (controlled branch)", () => {
		const { db, records, attempts } = makeStores();
		seedThread(db);
		seedParent(records);
		seedAttempt(attempts);
		expect(() =>
			attempts.markPrestartTerminal("at1", { status: "failed", terminalReason: "generic", endedAt: 20 }),
		).toThrow(/target_invalid/);
		const ok = attempts.markPrestartTerminal("at1", {
			status: "failed",
			terminalReason: "target_invalid",
			endedAt: 20,
		});
		expect(ok?.deliveryState).toBe("failed");
	});

	it("retry appends attempt+1; old row immutable; latest wins", () => {
		const { db, records, attempts } = makeStores();
		seedThread(db);
		seedParent(records);
		seedAttempt(attempts, "at1", "a1", 1);
		attempts.markPrestartTerminal("at1", { status: "failed", terminalReason: "target_invalid", endedAt: 20 });
		const second = attempts.appendQueued({
			attemptId: "at2",
			parentInvocationId: "inv1",
			queueEntryId: "q1",
			threadId: "t1",
			targetAgentId: "a1",
			attempt: 2,
			now: 30,
		});
		expect(second.outcome).toBe("created");
		expect(attempts.get("at1")?.deliveryState).toBe("failed");
		expect(attempts.getLatest("inv1", "a1")?.attemptId).toBe("at2");
	});

	it("prompt delivery boundary: appended-only, idempotent same value, conflict different", () => {
		const { db, records, turns, attempts } = makeStores();
		seedThread(db);
		seedParent(records);
		seedAttempt(attempts);
		seedTurn(turns, "te1", "a1");
		seedMessage(db, "r");
		expect(() => attempts.markPromptDelivered("at1", { deliveryBoundarySeq: 5, now: 1 })).toThrow(/appended/);
		attempts.markStarting("at1", { agentSessionId: "s", now: 20 });
		attempts.bindAppended("at1", {
			turnExecutionId: "te1",
			agentSessionId: "s",
			workerId: "w1",
			provider: "p",
			model: "m",
			modelFamily: "f",
			responseMessageId: "r",
			now: 30,
		});
		attempts.markPromptDelivered("at1", { deliveryBoundarySeq: 7, now: 35 });
		expect(attempts.get("at1")?.deliveryBoundarySeq).toBe(7);
		expect(() => attempts.markPromptDelivered("at1", { deliveryBoundarySeq: 9, now: 36 })).toThrow(/boundary/);
	});
});
