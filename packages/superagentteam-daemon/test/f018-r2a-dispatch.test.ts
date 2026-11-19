import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, AgentCatalog, AgentConfig } from "@superagentteam/shared/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatorMessageIngress } from "../src/domains/a2a/router.ts";
import type { AgentRegistry } from "../src/domains/agent/registry.ts";
import { buildRegistry } from "../src/domains/agent/registry.ts";
import { InvocationCredentialStore } from "../src/domains/auth/store.ts";
import { InvocationAttemptStore, InvocationRecordStore, TurnExecutionStore } from "../src/domains/invocation/store.ts";
import { AgentReadStateStore, MessageStore } from "../src/domains/message/store.ts";
import type { PreparedDispatch } from "../src/domains/queue/processor.ts";
import { QueueProcessor } from "../src/domains/queue/processor.ts";
import { QueueLedgerStore } from "../src/domains/queue/store.ts";
import { InvocationTracker } from "../src/domains/queue/tracker.ts";
import { ResponseDraftStore } from "../src/domains/response/store.ts";
import { AgentSessionStore } from "../src/domains/session/store.ts";
import { ThreadStore } from "../src/domains/thread/store.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";

const dirs: string[] = [];

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		id: "a1",
		mentionPatterns: ["@a1"],
		displayName: "Agent One",
		contextWindow: 128_000,
		roleId: "worker",
		roleDescription: "does things",
		restrictions: [],
		strengths: [],
		accountRef: "main",
		defaultModel: "m1",
		sessionChain: true,
		enabled: true,
		...overrides,
	};
}

const ACCOUNT: AccountConfig = { ref: "main", provider: "pi", apiKeyRef: "KEY", models: ["m1"] };

function makeRegistry(
	agents: AgentConfig[],
	accounts: AccountConfig[] = [ACCOUNT],
	defaultAgentId?: string,
): AgentRegistry {
	const catalog: AgentCatalog = { version: 1, agents };
	return buildRegistry(catalog, accounts, defaultAgentId);
}

function makeWorld(agents: AgentConfig[] = [agentConfig(), agentConfig({ id: "a2", mentionPatterns: ["@a2"] })]) {
	const dir = mkdtempSync(join(tmpdir(), "f018-r2a-"));
	dirs.push(dir);
	const db = new F018Database({ path: join(dir, "f018.db") });
	db.db
		.prepare(
			"INSERT INTO threads (id, project_path, created_by, last_active_at, created_at, updated_at) VALUES ('t1', '/p', 'u1', 1, 1, 1)",
		)
		.run();
	const registry = makeRegistry(agents);
	const threads = new ThreadStore(db.db);
	const messages = new MessageStore(db.db);
	const readState = new AgentReadStateStore(db.db);
	const queue = new QueueLedgerStore(db.db);
	const records = new InvocationRecordStore(db.db);
	const turns = new TurnExecutionStore(db.db);
	const attempts = new InvocationAttemptStore(db.db);
	const sessions = new AgentSessionStore(db.db);
	const credentials = new InvocationCredentialStore(db.db);
	const drafts = new ResponseDraftStore(db.db);
	const tracker = new InvocationTracker();
	const ingress = new OperatorMessageIngress({ db: db.db, registry, threads, messages, queue });
	const dispatched: PreparedDispatch[] = [];
	const processor = new QueueProcessor({
		db: db.db,
		registry,
		queue,
		records,
		turns,
		attempts,
		sessions,
		credentials,
		drafts,
		messages,
		threads,
		tracker,
		dispatchTarget: {
			async dispatch(prepared: PreparedDispatch) {
				dispatched.push(prepared);
			},
		},
		clock: () => 1000,
	});
	return {
		dir,
		db: db.db,
		registry,
		threads,
		messages,
		readState,
		queue,
		records,
		turns,
		attempts,
		sessions,
		credentials,
		drafts,
		tracker,
		ingress,
		processor,
		dispatched,
	};
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------
// 0007 §3.0: OperatorMessageIngress
// ------------------------------------------------------------------
describe("OperatorMessageIngress (0007 §3.0)", () => {
	it("explicit @ resolves targets; message + queue entry commit atomically", () => {
		const w = makeWorld();
		const result = w.ingress.submit({ threadId: "t1", userId: "u1", body: "hello @a1 and @a2 please", now: 10 });
		expect(result.targetAgentIds).toEqual(["a1", "a2"]);
		expect(result.reason).toBe("current_message_mentions");
		const stored = w.messages.get(result.message.id);
		expect(stored?.extra?.targetAgentIds).toEqual(["a1", "a2"]);
		const entries = w.queue.listQueued("t1");
		expect(entries).toHaveLength(1);
		expect(entries[0]!.targets.map((t) => t.id)).toEqual(["a1", "a2"]);
		expect(entries[0]!.payload.messageId).toBe(result.message.id);
	});

	it("unmatched @tokens are plain text; implicit fallback still routes", () => {
		const w = makeWorld();
		const result = w.ingress.submit({ threadId: "t1", userId: "u1", body: "hey @stranger — anyone?", now: 10 });
		// No explicit match → implicit chain: no history → no participant → default agent (first).
		expect(result.reason).toBe("default_agent");
		expect(result.targetAgentIds).toEqual(["a1"]);
	});

	it("mention of a disabled agent is a typed reject; nothing is appended", () => {
		const w = makeWorld([agentConfig(), agentConfig({ id: "a2", mentionPatterns: ["@a2"], enabled: false })]);
		expect(() => w.ingress.submit({ threadId: "t1", userId: "u1", body: "hi @a2", now: 10 })).toThrowError(
			/agent_disabled/,
		);
		expect(w.messages.getByThread("t1", 10)).toHaveLength(0);
		expect(w.queue.listQueued("t1")).toHaveLength(0);
	});

	it("implicit chain: last user message targets win over deeper fallbacks", () => {
		const w = makeWorld();
		w.ingress.submit({ threadId: "t1", userId: "u1", body: "go @a2", now: 10 });
		const next = w.ingress.submit({ threadId: "t1", userId: "u1", body: "and now?", now: 20 });
		expect(next.reason).toBe("previous_user_mentions");
		expect(next.targetAgentIds).toEqual(["a2"]);
	});

	it("implicit chain: thread participant before default agent", () => {
		const w = makeWorld();
		w.threads.addParticipant("t1", "a2", 5);
		const result = w.ingress.submit({ threadId: "t1", userId: "u1", body: "anyone", now: 10 });
		expect(result.reason).toBe("thread_participant");
		expect(result.targetAgentIds).toEqual(["a2"]);
	});

	it("deleted or missing thread rejects post", () => {
		const w = makeWorld();
		w.threads.softDelete("t1", 5);
		expect(() => w.ingress.submit({ threadId: "t1", userId: "u1", body: "hi @a1", now: 10 })).toThrowError(
			/thread_deleted/,
		);
		expect(() => w.ingress.submit({ threadId: "tx", userId: "u1", body: "hi @a1", now: 10 })).toThrowError(
			/thread_not_found/,
		);
	});

	it("no_target typed reject when nothing resolves", () => {
		const empty = makeWorld([]);
		expect(() => empty.ingress.submit({ threadId: "t1", userId: "u1", body: "hello", now: 10 })).toThrowError(
			/no_target/,
		);
	});

	it("explicit mention of an agent without an account is an ingress typed reject", () => {
		// buildRegistry validates accountRefs at load time, so this state only
		// arises through a hand-built registry (defense-in-depth for R2-b
		// hot-reload paths).
		const w = makeWorld();
		const ghostAgent = agentConfig({ id: "a2", mentionPatterns: ["@a2"] });
		const handBuilt: AgentRegistry = {
			agents: new Map([["a2", ghostAgent]]),
			mentionIndex: new Map([["@a2", "a2"]]),
			accounts: new Map(),
			defaultAgentId: null,
			revision: 999,
		};
		const ingress = new OperatorMessageIngress({
			db: w.db,
			registry: handBuilt,
			threads: w.threads,
			messages: w.messages,
			queue: w.queue,
		});
		expect(() => ingress.submit({ threadId: "t1", userId: "u1", body: "hi @a2", now: 10 })).toThrowError(
			/account_not_found/,
		);
	});

	it("submit with the same messageId and identity replays idempotently", () => {
		const w = makeWorld();
		const first = w.ingress.submit({
			threadId: "t1",
			userId: "u1",
			body: "go @a1",
			messageId: "m-fix",
			now: 10,
		});
		const replay = w.ingress.submit({
			threadId: "t1",
			userId: "u1",
			body: "go @a1",
			messageId: "m-fix",
			now: 20,
		});
		expect(replay.message.id).toBe("m-fix");
		expect(replay.queueEntry.queueEntryId).toBe(first.queueEntry.queueEntryId);
		expect(w.queue.listQueued("t1")).toHaveLength(1);
		expect(() =>
			w.ingress.submit({ threadId: "t1", userId: "u1", body: "DIFFERENT @a2", messageId: "m-fix", now: 30 }),
		).toThrowError(/ingress_message_id_conflict/);
	});

	it("queue_full rolls the message back (admission is atomic)", () => {
		const w = makeWorld();
		for (let i = 0; i < 5; i += 1) {
			w.ingress.submit({ threadId: "t1", userId: "u1", body: `msg ${i} @a1`, now: 10 + i });
		}
		expect(() => w.ingress.submit({ threadId: "t1", userId: "u1", body: "overflow @a1", now: 99 })).toThrowError(
			/queue_full/,
		);
		// The rolled-back message left no orphan row.
		expect(w.messages.getByThread("t1", 10).filter((m) => m.content === "overflow @a1")).toHaveLength(0);
	});
});

// ------------------------------------------------------------------
// 0007 §3.4: InvocationTracker
// ------------------------------------------------------------------
describe("InvocationTracker (0007 §3.4)", () => {
	it("start preempts: old controller aborted, new slot registered", () => {
		const tracker = new InvocationTracker();
		const c1 = tracker.start("t1", "a1", "u1", "te1");
		const c2 = tracker.start("t1", "a1", "u1", "te2");
		expect(c1.signal.aborted).toBe(true);
		expect(c2.signal.aborted).toBe(false);
		expect(tracker.getExecutionId("t1", "a1")).toBe("te2");
	});

	it("complete is ownership-fenced; cancel releases immediately", () => {
		const tracker = new InvocationTracker();
		tracker.start("t1", "a1", "u1", "te1");
		expect(tracker.complete("t1", "a1", "te-old")).toBe(false);
		expect(tracker.isBusy("t1", "a1")).toBe(true);
		expect(tracker.complete("t1", "a1", "te1")).toBe(true);
		expect(tracker.isBusy("t1", "a1")).toBe(false);
		tracker.start("t1", "a2", "u1", "te2");
		expect(tracker.cancel("t1", "a2")).toBe(true);
		expect(tracker.getSlotState("t1", "a2")).toBe("absent");
	});

	it("startAll is all-or-nothing on busy slots", () => {
		const tracker = new InvocationTracker();
		tracker.start("t1", "a2", "u1", "te-x");
		const result = tracker.startAll(
			"t1",
			[
				{ agentId: "a1", turnExecutionId: "te1" },
				{ agentId: "a2", turnExecutionId: "te2" },
			],
			"u1",
		);
		expect("error" in result && result.error).toBe("slot_busy");
		expect(tracker.isBusy("t1", "a1")).toBe(false);
	});
});

// ------------------------------------------------------------------
// 0007 §3.2: QueueProcessor Phase A/B
// ------------------------------------------------------------------
describe("QueueProcessor (0007 §3.2)", () => {
	it("happy path: Phase A + Phase B leave a fully dispatched chain", async () => {
		const w = makeWorld();
		const submitted = w.ingress.submit({ threadId: "t1", userId: "u1", body: "do it @a1", now: 10 });
		const result = await w.processor.drain("t1", "u1");
		expect(result.processed).toBe(1);

		const invocationId = `inv:t1:${submitted.message.id}`;
		const parent = w.records.get(invocationId);
		expect(parent?.status).toBe("running");

		const attempt = w.attempts.getLatest(invocationId, "a1");
		expect(attempt?.deliveryState).toBe("appended");
		const turnId = attempt?.turnExecutionId;
		expect(turnId).toBe(`te:${attempt?.attemptId}`);
		expect(attempt?.settlement).toBe("streaming");
		expect(turnId).toBeTruthy();

		const turn = w.turns.get(turnId!);
		expect(turn?.status).toBe("running");

		const credential = w.credentials.getByTurn(turnId!);
		expect(credential?.state).toBe("active");

		const draft = w.drafts.getByTurn(turnId!);
		expect(draft?.attemptId).toBe(attempt?.attemptId);

		// Processing R + dispatchRef on the input message.
		const responseRow = w.messages.get(`resp:${attempt!.turnExecutionId}`);
		expect(responseRow?.lifecycle?.kind).toBe("response");
		const input = w.messages.get(submitted.message.id)!;
		expect(input.lifecycle?.kind).toBe("input");
		if (input.lifecycle?.kind === "input") {
			expect(input.lifecycle.dispatchRefs).toHaveLength(1);
			expect(input.lifecycle.dispatchRefs[0]?.turnExecutionId).toBe(attempt!.turnExecutionId);
		}

		// Target retired + claim released; nothing queued remains.
		expect(w.queue.listQueued("t1")).toHaveLength(0);
		expect(w.dispatched).toHaveLength(1);
		expect(w.dispatched[0]!.agentId).toBe("a1");
		expect(w.tracker.isBusy("t1", "a1")).toBe(false);
	});

	it("invalid target: attempt failed(target_invalid) + delivery_failure; sibling continues", async () => {
		// a2 is enabled in the registry at submit time, then removed (catalog
		// rotation) so the processor's preflight classifies it invalid.
		const w = makeWorld();
		const submitted = w.ingress.submit({ threadId: "t1", userId: "u1", body: "both @a1 @a2", now: 10 });
		// Catalog rotation between admission and dispatch: a2 vanishes.
		const rotated = makeRegistry([agentConfig()]);
		const processor = new QueueProcessor({
			db: w.db,
			registry: rotated,
			queue: w.queue,
			records: w.records,
			turns: w.turns,
			attempts: w.attempts,
			sessions: w.sessions,
			credentials: w.credentials,
			drafts: w.drafts,
			messages: w.messages,
			threads: w.threads,
			tracker: w.tracker,
			dispatchTarget: {
				async dispatch(prepared: PreparedDispatch) {
					w.dispatched.push(prepared);
				},
			},
			clock: () => 1000,
		});

		const result = await processor.drain("t1", "u1");
		expect(result.processed).toBe(1);

		const invocationId = `inv:t1:${submitted.message.id}`;
		const failed = w.attempts.getLatest(invocationId, "a2");
		expect(failed?.deliveryState).toBe("failed");
		expect(failed?.terminalReason).toBe("target_invalid");

		const failures = w.messages.getByThread("t1", 50).filter((m) => m.lifecycle?.kind === "delivery_failure");
		expect(failures).toHaveLength(1);
		expect(failures[0]!.content).toContain("agent_not_found");

		// Sibling a1 dispatched through the full Phase B chain.
		expect(w.dispatched.map((p) => p.agentId)).toEqual(["a1"]);
		const healthy = w.attempts.getLatest(invocationId, "a1");
		expect(healthy?.deliveryState).toBe("appended");
	});

	it("capacity shortage defers the whole entry; nothing is created", async () => {
		const w = makeWorld();
		w.ingress.submit({ threadId: "t1", userId: "u1", body: "go @a1", now: 10 });
		const processor = new QueueProcessor({
			db: w.db,
			registry: w.registry,
			queue: w.queue,
			records: w.records,
			turns: w.turns,
			attempts: w.attempts,
			sessions: w.sessions,
			credentials: w.credentials,
			drafts: w.drafts,
			messages: w.messages,
			threads: w.threads,
			tracker: w.tracker,
			dispatchTarget: {
				async dispatch() {},
			},
			capacity: { check: () => ({ ok: false, reason: "worker_capacity" }) },
			clock: () => 1000,
		});
		const result = await processor.drain("t1", "u1");
		expect(result.deferred).toBe(1);
		// No parent / attempt / R / delivery_failure; target stays queued.
		expect(w.records.byThreadSource("t1", w.queue.listQueued("t1")[0]!.payload.sourceRecordId)).toBeNull();
		expect(w.attempts.listActive()).toHaveLength(0);
		const messages = w.messages.getByThread("t1", 10);
		expect(messages.filter((m) => m.lifecycle?.kind === "delivery_failure")).toHaveLength(0);
		expect(w.queue.listQueued("t1")).toHaveLength(1);
	});

	it("Phase B failure: delivery_failure + attempt failed; target stays pending", async () => {
		const w = makeWorld();
		const submitted = w.ingress.submit({ threadId: "t1", userId: "u1", body: "go @a1", now: 10 });
		const createSpy = vi.spyOn(w.drafts, "create");
		createSpy.mockImplementationOnce(() => {
			throw new Error("draft boom");
		});
		const result = await w.processor.drain("t1", "u1");
		expect(result.processed).toBe(1);

		const invocationId = `inv:t1:${submitted.message.id}`;
		const attempt = w.attempts.getLatest(invocationId, "a1");
		expect(attempt?.deliveryState).toBe("failed");
		expect(attempt?.terminalReason).toBe("phase_b_failed");

		// The Phase B tx rolled back: no processing R / TurnExecution / draft.
		expect(w.turns.listByInvocation(invocationId)).toHaveLength(0);
		expect(attempt?.attemptId).toBeTruthy();
		expect(w.messages.get(`resp:te:${attempt!.attemptId}`)).toBeNull();

		const failures = w.messages.getByThread("t1", 50).filter((m) => m.lifecycle?.kind === "delivery_failure");
		expect(failures).toHaveLength(1);

		// Target was never retired → stays pending for the next drain.
		expect(w.queue.listQueued("t1")).toHaveLength(1);
		expect(w.dispatched).toHaveLength(0);
	});

	it("P1-2: port failure converges the chain and re-queues the target for replay", async () => {
		const w = makeWorld();
		const submitted = w.ingress.submit({ threadId: "t1", userId: "u1", body: "go @a1", now: 10 });
		const processor = new QueueProcessor({
			db: w.db,
			registry: w.registry,
			queue: w.queue,
			records: w.records,
			turns: w.turns,
			attempts: w.attempts,
			sessions: w.sessions,
			credentials: w.credentials,
			drafts: w.drafts,
			messages: w.messages,
			threads: w.threads,
			tracker: w.tracker,
			dispatchTarget: {
				async dispatch() {
					throw new Error("provider exploded");
				},
			},
			clock: () => 1000,
		});
		const result = await processor.drain("t1", "u1");
		expect(result.processed).toBe(1);
		const invocationId = `inv:t1:${submitted.message.id}`;
		// 0010 §6.1.3 row 6: attempt failed, turn failed, R failed (no
		// promptDelivered), settlement settled (nothing for T4 to recover).
		const attempt = w.attempts.getLatest(invocationId, "a1");
		expect(attempt?.deliveryState).toBe("failed");
		expect(attempt?.terminalReason).toBe("provider_phase_failed");
		expect(attempt?.settlement).toBe("settled");
		const turnId = attempt?.turnExecutionId;
		expect(turnId).toBeTruthy();
		expect(w.turns.get(turnId!)?.status).toBe("failed");
		// Round-2 P1-1: credential follows child truth (terminal, failed).
		const credential = w.credentials.getByTurn(turnId!);
		expect(credential?.state).toBe("terminal");
		expect(credential?.disposition).toBe("failed");
		// Round-2: the empty draft is dropped with the settlement.
		expect(w.drafts.getByTurn(turnId!)).toBeNull();
		const response = w.messages.get(`resp:${turnId}`);
		expect(response?.lifecycle?.kind).toBe("response");
		if (response?.lifecycle?.kind === "response") {
			expect(response.lifecycle.status).toBe("failed");
		}
		// No delivery_failure for provider-phase failures.
		const failures = w.messages.getByThread("t1", 50).filter((m) => m.lifecycle?.kind === "delivery_failure");
		expect(failures).toHaveLength(0);
		// The retired target is back on the entry → the bounded backoff can
		// re-dispatch (next drain appends attempt 2).
		const queued = w.queue.listQueued("t1");
		expect(queued).toHaveLength(1);
		expect(queued[0]!.targets.map((t) => t.id)).toEqual(["a1"]);
		// Slot released even though the port failed.
		expect(w.tracker.isBusy("t1", "a1")).toBe(false);
	});

	it("P1-1: Phase A failure releases the claim and defers (no claim-TTL stall)", async () => {
		const w = makeWorld();
		const submitted = w.ingress.submit({ threadId: "t1", userId: "u1", body: "go @a1", now: 10 });
		// Wrong userId → records.create throws invocation_owner_not_thread_owner
		// inside the Phase A transaction.
		const result = await w.processor.drain("t1", "attacker");
		expect(result.deferred).toBe(1);
		// Entry back to queued (claim released), no parent created.
		const queued = w.queue.listQueued("t1");
		expect(queued).toHaveLength(1);
		expect(queued[0]!.payload.messageId).toBe(submitted.message.id);
		expect(w.records.byThreadSource("t1", submitted.message.id)).toBeNull();
	});

	it("P1-3: multi-target dispatch records one dispatchRef per target", async () => {
		const w = makeWorld();
		const submitted = w.ingress.submit({ threadId: "t1", userId: "u1", body: "both @a1 @a2", now: 10 });
		const result = await w.processor.drain("t1", "u1");
		expect(result.processed).toBe(1);
		const input = w.messages.get(submitted.message.id)!;
		expect(input.lifecycle?.kind).toBe("input");
		if (input.lifecycle?.kind === "input") {
			const refTargets = input.lifecycle.dispatchRefs.map((r) => r.target.id).sort();
			expect(refTargets).toEqual(["a1", "a2"]);
		}
	});

	it("round-2: convergence failure is typed, not an escape (claim changed hands)", async () => {
		const w = makeWorld();
		w.ingress.submit({ threadId: "t1", userId: "u1", body: "go @a1", now: 10 });
		const processor = new QueueProcessor({
			db: w.db,
			registry: w.registry,
			queue: w.queue,
			records: w.records,
			turns: w.turns,
			attempts: w.attempts,
			sessions: w.sessions,
			credentials: w.credentials,
			drafts: w.drafts,
			messages: w.messages,
			threads: w.threads,
			tracker: w.tracker,
			dispatchTarget: {
				async dispatch(prepared: PreparedDispatch) {
					// Sabotage: the claim changes hands (e.g. TTL expiry +
					// re-claim) before the port throws → restoreTargets will
					// hit state_changed inside the convergence transaction.
					w.queue.releaseClaim(prepared.threadId, prepared.queueEntryId, prepared.claimId, 2000);
					throw new Error("provider exploded after claim loss");
				},
			},
			clock: () => 1000,
		});
		const result = await processor.drain("t1", "u1");
		expect(result.processed).toBe(1);
		// drain completes (no escape) and surfaces the convergence failure as
		// a typed field; the durable state stays inspectable/recoverable.
		expect(result.convergenceFailed).toEqual(["a1"]);
	});

	it("round-2: implicit chain skips currently-unroutable candidates", () => {
		const w = makeWorld([agentConfig(), agentConfig({ id: "a2", mentionPatterns: ["@a2"], enabled: false })]);
		// Last user message targeted a2; a2 is now disabled → the chain falls
		// through to the default agent (a1) instead of admitting a dead target.
		w.messages.append({
			id: "m-old",
			threadId: "t1",
			from: { kind: "user", userId: "u1" },
			content: "go @a2",
			lifecycle: { kind: "input", dispatchRefs: [] },
			extra: { targetAgentIds: ["a2"] },
			now: 1,
		});
		const result = w.ingress.submit({ threadId: "t1", userId: "u1", body: "and now?", now: 20 });
		expect(result.reason).toBe("default_agent");
		expect(result.targetAgentIds).toEqual(["a1"]);
	});

	it("round-2: replay with a deleted queue entry is a typed reject, not a fake success", () => {
		const w = makeWorld();
		const first = w.ingress.submit({
			threadId: "t1",
			userId: "u1",
			body: "go @a1",
			messageId: "m-gone",
			now: 10,
		});
		w.queue.deleteEntry("t1", first.queueEntry.queueEntryId);
		expect(() =>
			w.ingress.submit({ threadId: "t1", userId: "u1", body: "go @a1", messageId: "m-gone", now: 20 }),
		).toThrowError(/ingress_replay_entry_missing/);
	});

	it("busy target holds later entries (per-target ordering)", async () => {
		const w = makeWorld();
		const first = w.ingress.submit({ threadId: "t1", userId: "u1", body: "one @a1", now: 10 });
		const second = w.ingress.submit({ threadId: "t1", userId: "u1", body: "two @a1", now: 11 });
		// Simulate an in-flight slot for a1.
		w.tracker.start("t1", "a1", "u1", "te-inflight");
		const result = await w.processor.drain("t1", "u1", { maxEntries: 5 });
		expect(result.processed).toBe(0);
		expect(w.records.get(`inv:t1:${first.message.id}`)).toBeNull();
		expect(w.records.get(`inv:t1:${second.message.id}`)).toBeNull();
	});
});
