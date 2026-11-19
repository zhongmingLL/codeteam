import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredMessage } from "@superagentteam/shared/types";
import { afterEach, describe, expect, it } from "vitest";
import { buildThreadPrompt, HistoryAssembler } from "../src/domains/history/assembler.ts";
import { AgentReadStateStore, MessageStore } from "../src/domains/message/store.ts";
import { AgentSessionStore } from "../src/domains/session/store.ts";
import { ThreadStore } from "../src/domains/thread/store.ts";
import { WorkerStore } from "../src/domains/worker/store.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";

const dirs: string[] = [];

function makeWorld() {
	const dir = mkdtempSync(join(tmpdir(), "f018-r2-"));
	dirs.push(dir);
	const db = new F018Database({ path: join(dir, "f018.db") });
	db.db
		.prepare(
			"INSERT INTO threads (id, project_path, title, created_by, last_active_at, created_at, updated_at) VALUES ('t1', '/proj/x', 'Demo thread', 'u1', 1, 1, 1)",
		)
		.run();
	const threads = new ThreadStore(db.db);
	const messages = new MessageStore(db.db);
	const readState = new AgentReadStateStore(db.db);
	const sessions = new AgentSessionStore(db.db);
	const workers = new WorkerStore(db.db);
	const assembler = new HistoryAssembler({ messages, readState });
	return { dir, db: db.db, threads, messages, readState, sessions, workers, assembler };
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let msgCounter = 0;
function appendMsg(
	messages: MessageStore,
	overrides: Partial<Parameters<MessageStore["append"]>[0]> = {},
): StoredMessage {
	msgCounter += 1;
	return messages.append({
		id: `m${msgCounter}`,
		threadId: "t1",
		from: { kind: "user", userId: "u1" },
		content: `body-${msgCounter}`,
		now: msgCounter * 100,
		...overrides,
	});
}

// ------------------------------------------------------------------
// 0010 §6: pi binding methods (deferred from R1-c, landed in R2-0)
// ------------------------------------------------------------------
describe("AgentSessionStore pi binding (0010 §6)", () => {
	it("bindPiSession persists first binding (both values required non-null)", () => {
		const w = makeWorld();
		const s = w.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/proj/x",
			now: 10,
		});
		expect(s.piSessionId).toBeNull();
		const bound = w.sessions.bindPiSession(s.id, {
			piSessionId: "pi-1",
			piSessionFile: "/tmp/pi-1.json",
			now: 20,
		});
		expect(bound.piSessionId).toBe("pi-1");
		expect(bound.piSessionFile).toBe("/tmp/pi-1.json");
	});

	it("bindPiSession replay with the same values is a no-op", () => {
		const w = makeWorld();
		const s = w.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/proj/x",
			now: 10,
		});
		w.sessions.bindPiSession(s.id, { piSessionId: "pi-1", piSessionFile: "/f1", now: 20 });
		const again = w.sessions.bindPiSession(s.id, { piSessionId: "pi-1", piSessionFile: "/f1", now: 30 });
		expect(again.piSessionId).toBe("pi-1");
	});

	it("bindPiSession with different values rejects invalid_input (must go through replacePiSession)", () => {
		const w = makeWorld();
		const s = w.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/proj/x",
			now: 10,
		});
		w.sessions.bindPiSession(s.id, { piSessionId: "pi-1", piSessionFile: "/f1", now: 20 });
		expect(() => w.sessions.bindPiSession(s.id, { piSessionId: "pi-2", piSessionFile: "/f2", now: 30 })).toThrowError(
			/invalid_input/,
		);
	});

	it("bindPiSession rejects when either value is null", () => {
		const w = makeWorld();
		const s = w.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/proj/x",
			now: 10,
		});
		expect(() =>
			w.sessions.bindPiSession(s.id, {
				piSessionId: "pi-1",
				piSessionFile: null as unknown as string,
				now: 20,
			}),
		).toThrowError(/invalid_input/);
	});

	it("replacePiSession clears the binding (pre-fresh) and rebinds after fresh", () => {
		const w = makeWorld();
		const s = w.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/proj/x",
			now: 10,
		});
		w.sessions.bindPiSession(s.id, { piSessionId: "pi-1", piSessionFile: "/f1", now: 20 });
		const cleared = w.sessions.replacePiSession(s.id, { piSessionId: null, piSessionFile: null, now: 30 });
		expect(cleared.piSessionId).toBeNull();
		expect(cleared.piSessionFile).toBeNull();
		const rebound = w.sessions.replacePiSession(s.id, { piSessionId: "pi-9", piSessionFile: "/f9", now: 40 });
		expect(rebound.piSessionId).toBe("pi-9");
	});

	it("replacePiSession rejects a mismatched pair and rejects rebinding while still bound", () => {
		const w = makeWorld();
		const s = w.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/proj/x",
			now: 10,
		});
		expect(() =>
			w.sessions.replacePiSession(s.id, {
				piSessionId: "pi-1",
				piSessionFile: null,
				now: 20,
			}),
		).toThrowError(/invalid_input/);
		w.sessions.bindPiSession(s.id, { piSessionId: "pi-1", piSessionFile: "/f1", now: 20 });
		// Still bound: replacing with non-null values is bindPiSession territory.
		expect(() =>
			w.sessions.replacePiSession(s.id, { piSessionId: "pi-2", piSessionFile: "/f2", now: 30 }),
		).toThrowError(/invalid_input/);
	});

	it("createNextActive requires no live active row and increments seq", () => {
		const w = makeWorld();
		const s1 = w.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/proj/x",
			now: 10,
		});
		w.sessions.bindPiSession(s1.id, { piSessionId: "pi-1", piSessionFile: "/f1", now: 20 });
		expect(() =>
			w.sessions.createNextActive({
				threadId: "t1",
				agentId: "a1",
				userId: "u1",
				workingDirectory: "/proj/x",
				now: 30,
			}),
		).toThrowError(/session_active_exists/);
		w.sessions.sealActive(s1.id, "resume_failures", 40);
		const s2 = w.sessions.createNextActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/proj/x",
			now: 50,
		});
		expect(s2.seq).toBe(1);
		expect(s2.status).toBe("active");
		expect(s2.piSessionId).toBeNull();
		// Old row preserved, sealed (0010 §6.1.2 reset semantics).
		const old = w.sessions.get(s1.id);
		expect(old?.status).toBe("sealed");
		expect(old?.sealReason).toBe("resume_failures");
	});

	it("reset flow: rewind + sealActive + createNextActive lands a fresh active session", () => {
		const w = makeWorld();
		const s1 = w.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/proj/x",
			now: 10,
		});
		w.readState.ack("t1", "a1", 42, 100);
		w.readState.rewind("t1", "a1", Math.max(0, 42 - 10), 200);
		w.sessions.sealActive(s1.id, "fresh", 200);
		const s2 = w.sessions.createNextActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/proj/x",
			now: 200,
		});
		expect(w.readState.get("t1", "a1")?.deliveryCursor).toBe(32);
		expect(w.sessions.getActive("t1", "a1")?.id).toBe(s2.id);
	});
});

// ------------------------------------------------------------------
// 0010 §6: messageCount semantics aligned to contract letter
// ------------------------------------------------------------------
describe("messageCount semantics (0010 §6)", () => {
	it("first user-visible output does 0→1 and marks the turn", () => {
		const w = makeWorld();
		const s = w.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/proj/x",
			now: 10,
		});
		const after = w.sessions.recordUserVisibleOutput(s.id, "te-1", 100);
		expect(after?.messageCount).toBe(1);
		expect(after?.lastCountedTurnExecutionId).toBe("te-1");
	});

	it("visible output with messageCount ≥ 1 does NOT count at output time", () => {
		const w = makeWorld();
		const s = w.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/proj/x",
			now: 10,
		});
		w.sessions.recordCompletedTurn(s.id, { turnExecutionId: "te-1", userVisibleOutput: true, now: 100 });
		const after = w.sessions.recordUserVisibleOutput(s.id, "te-2", 200);
		expect(after?.messageCount).toBe(1);
		expect(after?.lastCountedTurnExecutionId).toBe("te-1");
	});

	it("completed turn counts +1 when uncounted (also with no visible output)", () => {
		const w = makeWorld();
		const s = w.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/proj/x",
			now: 10,
		});
		const a = w.sessions.recordCompletedTurn(s.id, { turnExecutionId: "te-1", userVisibleOutput: false, now: 100 });
		expect(a?.messageCount).toBe(1);
		const b = w.sessions.recordCompletedTurn(s.id, { turnExecutionId: "te-2", userVisibleOutput: true, now: 200 });
		expect(b?.messageCount).toBe(2);
	});

	it("an already-counted turn does not double count at completion", () => {
		const w = makeWorld();
		const s = w.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/proj/x",
			now: 10,
		});
		// Session's first-ever visible output marks te-1 (0→1).
		w.sessions.recordUserVisibleOutput(s.id, "te-1", 100);
		const after = w.sessions.recordCompletedTurn(s.id, {
			turnExecutionId: "te-1",
			userVisibleOutput: true,
			now: 150,
		});
		expect(after?.messageCount).toBe(1);
	});

	it("completed turn resets consecutive resume failures", () => {
		const w = makeWorld();
		const s = w.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/proj/x",
			now: 10,
		});
		w.sessions.recordResumeFailure(s.id, 20);
		const after = w.sessions.recordCompletedTurn(s.id, {
			turnExecutionId: "te-1",
			userVisibleOutput: true,
			now: 100,
		});
		expect(after?.consecutiveResumeFailures).toBe(0);
	});

	it("recordResumeFailure increments and reports the failure count", () => {
		const w = makeWorld();
		const s = w.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/proj/x",
			now: 10,
		});
		const r1 = w.sessions.recordResumeFailure(s.id, 20);
		expect(r1.failures).toBe(1);
		const r2 = w.sessions.recordResumeFailure(s.id, 30);
		expect(r2.failures).toBe(2);
	});
});

// ------------------------------------------------------------------
// 0007 §3.5.1: HistoryAssembler
// ------------------------------------------------------------------
describe("HistoryAssembler (0007 §3.5.1)", () => {
	it("bootstrap without read state: last window, mode bootstrap, boundary at tail, no ack", () => {
		const w = makeWorld();
		for (let i = 0; i < 5; i += 1) appendMsg(w.messages);
		const win = w.assembler.loadHistory("t1", "a1", 3);
		expect(win?.mode).toBe("bootstrap");
		expect(win?.rows.map((r) => r.seq)).toEqual([3, 4, 5]);
		expect(win?.boundarySeq).toBe(5);
		// loadHistory never acks.
		expect(w.readState.get("t1", "a1")).toBeNull();
	});

	it("incremental: rows strictly after the cursor", () => {
		const w = makeWorld();
		for (let i = 0; i < 5; i += 1) appendMsg(w.messages);
		w.readState.ack("t1", "a1", 2, 100);
		const win = w.assembler.loadHistory("t1", "a1", 10);
		expect(win?.mode).toBe("incremental");
		expect(win?.rows.map((r) => r.seq)).toEqual([3, 4, 5]);
		expect(win?.boundarySeq).toBe(5);
	});

	it("targeted input (extra.targetAgentIds) is visible only to listed agents", () => {
		const w = makeWorld();
		appendMsg(w.messages); // broadcast
		appendMsg(w.messages, { from: { kind: "user", userId: "u1" }, extra: { targetAgentIds: ["a2"] } });
		appendMsg(w.messages); // broadcast
		const forA1 = w.assembler.loadHistory("t1", "a1", 10);
		const forA2 = w.assembler.loadHistory("t1", "a2", 10);
		expect(forA1?.rows.map((r) => r.seq)).toEqual([1, 3]);
		expect(forA2?.rows.map((r) => r.seq)).toEqual([1, 2, 3]);
	});

	it("dispatchRefs-targeted input is visible only to ref agents", () => {
		const w = makeWorld();
		appendMsg(w.messages, {
			lifecycle: {
				kind: "input",
				dispatchRefs: [
					{ target: { kind: "agent", id: "a2" }, queueEntryId: "q1", attempt: 1, phase: "dispatched", at: 1 },
				],
			},
		});
		const forA1 = w.assembler.loadHistory("t1", "a1", 10);
		const forA2 = w.assembler.loadHistory("t1", "a2", 10);
		expect(forA1?.rows).toHaveLength(0);
		expect(forA2?.rows.map((r) => r.seq)).toEqual([1]);
	});

	it("responses broadcast, but the author's own response is excluded", () => {
		const w = makeWorld();
		appendMsg(w.messages, {
			from: { kind: "agent", agentId: "a1" },
			lifecycle: {
				kind: "response",
				parentInvocationId: "inv1",
				turnExecutionId: "te1",
				target: { kind: "agent", id: "a1" },
				status: "completed",
				startedAt: 1,
			},
		});
		appendMsg(w.messages, {
			from: { kind: "agent", agentId: "a2" },
			lifecycle: {
				kind: "response",
				parentInvocationId: "inv2",
				turnExecutionId: "te2",
				target: { kind: "agent", id: "a2" },
				status: "completed",
				startedAt: 2,
			},
		});
		const forA1 = w.assembler.loadHistory("t1", "a1", 10);
		expect(forA1?.rows.map((r) => r.seq)).toEqual([2]);
		const forA3 = w.assembler.loadHistory("t1", "a3", 10);
		expect(forA3?.rows.map((r) => r.seq)).toEqual([1, 2]);
	});

	it("filtered-out messages still advance the boundary", () => {
		const w = makeWorld();
		appendMsg(w.messages);
		appendMsg(w.messages, { extra: { targetAgentIds: ["a2"] } });
		appendMsg(w.messages);
		const win = w.assembler.loadHistory("t1", "a1", 10);
		expect(win?.rows.map((r) => r.seq)).toEqual([1, 3]);
		// seq 2 was fetched (consumed) even though invisible to a1.
		expect(win?.boundarySeq).toBe(3);
	});

	it("a processing response caps the boundary before itself", () => {
		const w = makeWorld();
		appendMsg(w.messages);
		appendMsg(w.messages);
		appendMsg(w.messages, {
			from: { kind: "agent", agentId: "a2" },
			lifecycle: {
				kind: "response",
				parentInvocationId: "inv2",
				turnExecutionId: "te2",
				target: { kind: "agent", id: "a2" },
				status: "processing",
				startedAt: 3,
			},
		});
		appendMsg(w.messages);
		const win = w.assembler.loadHistory("t1", "a1", 10);
		// The processing placeholder (seq 3) IS fetched and visible (broadcast),
		// but the boundary may not advance past seq 2.
		expect(win?.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
		expect(win?.boundarySeq).toBe(2);
	});

	it("empty thread: empty window with boundary 0", () => {
		const w = makeWorld();
		const win = w.assembler.loadHistory("t1", "a1", 10);
		expect(win?.mode).toBe("bootstrap");
		expect(win?.rows).toHaveLength(0);
		expect(win?.boundarySeq).toBe(0);
	});
});

// ------------------------------------------------------------------
// 0020 R2: buildThreadPrompt
// ------------------------------------------------------------------
describe("buildThreadPrompt (0020 R2)", () => {
	it("renders thread header, participants and recent messages; no '# Task' heading", () => {
		const w = makeWorld();
		appendMsg(w.messages, { content: "hello team" });
		appendMsg(w.messages, {
			from: { kind: "agent", agentId: "a2" },
			content: "hi from a2",
		});
		const thread = w.threads.get("t1")!;
		const prompt = buildThreadPrompt({
			thread,
			participants: ["a1", "a2"],
			rows: w.messages.getByThread("t1", 10),
			selfAgentId: "a1",
		});
		expect(prompt).toContain("/proj/x");
		expect(prompt).toContain("Demo thread");
		expect(prompt).toContain("a1");
		expect(prompt).toContain("a2");
		expect(prompt).toContain("hello team");
		expect(prompt).toContain("hi from a2");
		expect(prompt).not.toContain("# Task");
	});
});

// ------------------------------------------------------------------
// R1 closeout handover: retireIdle time injection
// ------------------------------------------------------------------
describe("WorkerStore time injection", () => {
	it("retireIdle uses the injected clock; checkCapacity passes now through", () => {
		const w = makeWorld();
		const key = { projectPath: "/p", accountRef: "acc", provider: "pi", model: "m" };
		w.workers.ensure({ workerId: "w1", poolKey: key, now: 10, leaseTtlMs: 1000 });
		w.workers.ensure({ workerId: "w2", poolKey: key, now: 10, leaseTtlMs: 1000 });
		// w1 goes draining+idle; w2 stays starting.
		w.db.prepare("UPDATE workers SET state = 'draining', idle_since = 500 WHERE id = 'w1'").run();
		const evicted = w.workers.retireIdle(5000);
		expect(evicted).toBe(1);
		const retired = w.workers.get("w1");
		expect(retired?.state).toBe("retired");
		expect(retired?.retiredAt).toBe(5000);
		expect(w.workers.get("w2")?.state).toBe("starting");
		// Capacity check forwards the injected clock (below cap → ok, no eviction).
		expect(w.workers.checkCapacity(key, 6000).ok).toBe(true);
	});
});
