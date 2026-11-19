import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, AgentCatalog, AgentConfig, AgentStreamEvent } from "@superagentteam/shared/types";
import { afterEach, describe, expect, it } from "vitest";
import { OperatorMessageIngress } from "../src/domains/a2a/router.ts";
import type { AgentRegistry } from "../src/domains/agent/registry.ts";
import { buildRegistry } from "../src/domains/agent/registry.ts";
import { RunAgentTurn } from "../src/domains/agent/turn.ts";
import { InvocationCredentialStore } from "../src/domains/auth/store.ts";
import { HistoryAssembler } from "../src/domains/history/assembler.ts";
import { InvocationAttemptStore, InvocationRecordStore, TurnExecutionStore } from "../src/domains/invocation/store.ts";
import { AgentReadStateStore, MessageStore } from "../src/domains/message/store.ts";
import { QueueProcessor } from "../src/domains/queue/processor.ts";
import { QueueLedgerStore } from "../src/domains/queue/store.ts";
import { InvocationTracker } from "../src/domains/queue/tracker.ts";
import { ResponseEventSink } from "../src/domains/response/sink.ts";
import { ResponseDraftStore } from "../src/domains/response/store.ts";
import { AgentSessionStore } from "../src/domains/session/store.ts";
import { ThreadStore } from "../src/domains/thread/store.ts";
import type { WorkerRpcConnection, WorkerSpawnPort } from "../src/domains/worker/pool.ts";
import { WorkerPool } from "../src/domains/worker/pool.ts";
import { WorkerBindingStore, WorkerStore } from "../src/domains/worker/store.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";
import type { RpcEvent } from "../src/workers/rpc-client.ts";

const dirs: string[] = [];

function agentConfig(): AgentConfig {
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
	};
}

const ACCOUNT: AccountConfig = { ref: "main", provider: "pi", apiKeyRef: "KEY", models: ["m1"] };

/** Scripted in-process RPC connection (mock provider layer). */
class ScriptedConnection implements WorkerRpcConnection {
	private readonly listeners: Array<(event: RpcEvent) => void> = [];
	readonly promptCalls: string[] = [];
	readonly finishes: string[] = [];
	acceptedCount = 0;
	script: RpcEvent[] = [];

	onEvent(listener: (event: RpcEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index >= 0) this.listeners.splice(index, 1);
		};
	}

	async promptAndWait(
		message: string,
		options: { timeoutMs: number; signal?: AbortSignal; onAccepted?: () => void },
	): Promise<{ aborted: boolean }> {
		this.promptCalls.push(message);
		this.acceptedCount += 1;
		options.onAccepted?.();
		for (const event of this.script) {
			for (const listener of [...this.listeners]) listener(event);
		}
		return { aborted: false };
	}

	async finish(reason?: string): Promise<void> {
		this.finishes.push(reason ?? "");
	}
}

class MockSpawnPort implements WorkerSpawnPort {
	spawns = 0;
	lastConnection: ScriptedConnection | null = null;
	/** Pre-programmed event script handed to every spawned connection. */
	scriptFor: RpcEvent[] = [];

	async spawn(): Promise<{
		connection: WorkerRpcConnection;
		pid: number | null;
		piSessionId: string | null;
		piSessionFile: string | null;
		spawnMs: number;
	}> {
		this.spawns += 1;
		this.lastConnection = new ScriptedConnection();
		this.lastConnection.script = this.scriptFor;
		return {
			connection: this.lastConnection,
			pid: 4242,
			piSessionId: `pi-${this.spawns}`,
			piSessionFile: `/tmp/sess-${this.spawns}.json`,
			spawnMs: 37,
		};
	}
}

function makeWorld() {
	const dir = mkdtempSync(join(tmpdir(), "f018-r2b-"));
	dirs.push(dir);
	const db = new F018Database({ path: join(dir, "f018.db") });
	db.db
		.prepare(
			"INSERT INTO threads (id, project_path, title, created_by, last_active_at, created_at, updated_at) VALUES ('t1', '/p', 'R2B Thread', 'u1', 1, 1, 1)",
		)
		.run();
	const catalog: AgentCatalog = { version: 1, agents: [agentConfig()] };
	const registry: AgentRegistry = buildRegistry(catalog, [ACCOUNT]);
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
	const workerStore = new WorkerStore(db.db);
	const bindingStore = new WorkerBindingStore(db.db);
	const spawnPort = new MockSpawnPort();
	let clockNow = 1000;
	const clock = () => clockNow;
	const pool = new WorkerPool({ workers: workerStore, bindings: bindingStore, spawn: spawnPort, clock });
	const assembler = new HistoryAssembler({ messages, readState });
	const ingress = new OperatorMessageIngress({ db: db.db, registry, threads, messages, queue });
	const streamEvents: AgentStreamEvent[] = [];
	const runAgentTurn = new RunAgentTurn({
		db: db.db,
		assembler,
		pool,
		attempts,
		sessions,
		drafts,
		threads,
		turns,
		credentials,
		readState,
		messages,
		onStreamEvent: (event) => streamEvents.push(event),
		clock,
	});
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
		dispatchTarget: runAgentTurn,
		clock,
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
		workerStore,
		bindingStore,
		spawnPort,
		pool,
		assembler,
		ingress,
		runAgentTurn,
		processor,
		streamEvents,
		advance: (ms: number) => {
			clockNow += ms;
		},
	};
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------
// WorkerPool (0007 §3.5.2)
// ------------------------------------------------------------------
describe("WorkerPool (0007 §3.5.2)", () => {
	it("ensure spawns, binds, and reuses; release retires (warmTtl=0)", async () => {
		const w = makeWorld();
		const session = w.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/p",
			now: 10,
		});
		const key = { projectPath: "/p", accountRef: "main", provider: "pi", model: "m1" };
		const first = await w.pool.ensure(key, session);
		expect(w.spawnPort.spawns).toBe(1);
		expect(first.piSessionId).toBe("pi-1");
		expect(w.workerStore.get(first.workerId)?.state).toBe("online");
		expect(w.bindingStore.getBySession(session.id)?.state).toBe("attached");

		const second = await w.pool.ensure(key, session);
		expect(w.spawnPort.spawns).toBe(1); // reuse
		expect(second.workerId).toBe(first.workerId);

		await w.pool.release(first, "turn-complete");
		expect(w.workerStore.get(first.workerId)?.state).toBe("retired");
		expect(w.bindingStore.getBySession(session.id)).toBeNull();

		const third = await w.pool.ensure(key, session);
		expect(w.spawnPort.spawns).toBe(2);
		await w.pool.release(third, "turn-complete");

		const metrics = w.pool.snapshotMetrics();
		expect(metrics.spawnCount).toBe(2);
		expect(metrics.spawnMsTotal).toBe(74);
	});

	it("metrics track busy duration and capacity evictions", async () => {
		const w = makeWorld();
		const session = w.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/p",
			now: 10,
		});
		const key = { projectPath: "/p", accountRef: "main", provider: "pi", model: "m1" };
		const handle = await w.pool.ensure(key, session);
		w.advance(5000);
		await w.pool.release(handle, "done");
		expect(w.pool.snapshotMetrics().busyMsTotal).toBe(5000);

		// 8 draining+idle workers → capacity check evicts them.
		for (let i = 0; i < 8; i += 1) {
			w.workerStore.ensure({
				workerId: `drain-${i}`,
				poolKey: key,
				now: 100,
				leaseTtlMs: 1000,
			});
			w.db.prepare("UPDATE workers SET state = 'draining', idle_since = 100 WHERE id = ?").run(`drain-${i}`);
		}
		expect(w.pool.checkCapacity(key).ok).toBe(true);
		expect(w.pool.snapshotMetrics().evictedCount).toBe(8);
	});
});

// ------------------------------------------------------------------
// ResponseEventSink (0007 §3.6.1 / 0017)
// ------------------------------------------------------------------
describe("ResponseEventSink (0007 §3.6.1)", () => {
	function seedDrafts(w: ReturnType<typeof makeWorld>) {
		const session = w.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/p",
			now: 10,
		});
		const created = w.records.create({
			invocationId: "inv1",
			threadId: "t1",
			userId: "u1",
			sourceRecordId: "s1",
			userMessageId: null,
			targetAgentIds: ["a1"],
			now: 10,
		});
		expect(created.outcome).toBe("created");
		const turn = w.turns.createRunning({
			turnExecutionId: "te1",
			parentInvocationId: "inv1",
			threadId: "t1",
			userId: "u1",
			agentId: "a1",
			executionKind: "ordinary",
			causal: { triggerMessageId: "m1" },
			startedAt: 10,
		});
		expect(turn.outcome).toBe("created");
		const appended = w.attempts.appendQueued({
			attemptId: "att1",
			parentInvocationId: "inv1",
			queueEntryId: "q1",
			threadId: "t1",
			targetAgentId: "a1",
			attempt: 1,
			now: 10,
		});
		expect(appended.outcome).toBe("created");
		w.attempts.markStarting("att1", { agentSessionId: session.id, now: 10 });
		w.messages.append({
			id: "resp1",
			threadId: "t1",
			from: { kind: "agent", agentId: "a1" },
			content: "",
			now: 10,
		});
		w.attempts.bindAppended("att1", {
			turnExecutionId: "te1",
			agentSessionId: session.id,
			workerId: null,
			provider: "pi",
			model: "m1",
			modelFamily: null,
			responseMessageId: "resp1",
			now: 10,
		});
		w.drafts.create({
			attemptId: "att1",
			turnExecutionId: "te1",
			parentInvocationId: "inv1",
			threadId: "t1",
			agentId: "a1",
			content: "",
			toolEvents: [],
			thinking: null,
			createdAt: 10,
			updatedAt: 10,
		});
		return { session };
	}

	it("accumulates text deltas, captures usage, and finalizes from message_end", () => {
		const w = makeWorld();
		seedDrafts(w);
		const firstVisible: number[] = [];
		const events: AgentStreamEvent[] = [];
		const sink = new ResponseEventSink({
			drafts: w.drafts,
			attemptId: "att1",
			turnExecutionId: "te1",
			parentInvocationId: "inv1",
			threadId: "t1",
			agentId: "a1",
			createdAt: 10,
			onStreamEvent: (event) => events.push(event),
			onFirstVisibleOutput: () => firstVisible.push(1),
			clock: () => 100,
		});
		sink.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } });
		sink.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " world" } });
		sink.handle({
			type: "tool_execution_start",
			toolCallId: "tc-1",
			toolName: "read_file",
			args: { path: "/x" },
		});
		sink.handle({ type: "tool_execution_end", toolCallId: "tc-1", toolName: "read_file", result: { ok: true } });
		sink.handle({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Hello world FINAL" }],
				usage: { inputTokens: 10, outputTokens: 5 },
			},
		});
		sink.handle({ type: "agent_settled", aborted: false });
		const summary = sink.summary();
		expect(summary.content).toBe("Hello world FINAL");
		expect(summary.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
		// 0017 §5.2: start/end merge into ONE record per toolCallId.
		expect(summary.toolEvents).toHaveLength(1);
		expect(summary.toolEvents[0]).toMatchObject({
			toolCallId: "tc-1",
			name: "read_file",
			status: "completed",
			result: { ok: true },
		});
		expect(firstVisible).toHaveLength(1);
		const draft = w.drafts.getByTurn("te1");
		expect(draft?.content).toBe("Hello world FINAL");
		expect(events.some((event) => event.type === "text")).toBe(true);
		expect(events.some((event) => event.type === "done")).toBe(true);
		// Stream events carry toolId (pairing) and strictly increasing seq.
		const toolCall = events.find((event) => event.type === "tool_call");
		expect(toolCall && "toolId" in toolCall && toolCall.toolId).toBe("tc-1");
		const seqs = events.map((event) => event.seq);
		expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
		expect(new Set(seqs).size).toBe(seqs.length);
	});

	it("provider error message surfaces in the summary", () => {
		const w = makeWorld();
		seedDrafts(w);
		const sink = new ResponseEventSink({
			drafts: w.drafts,
			attemptId: "att1",
			turnExecutionId: "te1",
			parentInvocationId: "inv1",
			threadId: "t1",
			agentId: "a1",
			createdAt: 10,
			clock: () => 100,
		});
		sink.handle({
			type: "message_end",
			message: { role: "assistant", content: [], errorMessage: "boom" },
		});
		expect(sink.summary().errorMessage).toBe("boom");
	});
});

// ------------------------------------------------------------------
// RunAgentTurn end-to-end through the processor (mock provider)
// ------------------------------------------------------------------
describe("RunAgentTurn (0010 §6.1.1 steps 2-8)", () => {
	it("full flow: prompt built from history, delivery marked after accept, draft finalized, session bound, worker retired", async () => {
		const w = makeWorld();
		const submitted = w.ingress.submit({ threadId: "t1", userId: "u1", body: "please summarize @a1", now: 10 });
		// Script the provider response (handed to the connection at spawn).
		w.spawnPort.scriptFor = [
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Summary: all good." } },
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Summary: all good." }],
					usage: { inputTokens: 7, outputTokens: 3 },
				},
			},
			{ type: "agent_settled", aborted: false },
		];
		const result = await w.processor.drain("t1", "u1");
		expect(result.processed).toBe(1);
		expect(result.convergenceFailed).toEqual([]);

		const invocationId = `inv:t1:${submitted.message.id}`;
		const attempt = w.attempts.getLatest(invocationId, "a1")!;
		expect(attempt.promptDeliveredAt).toBeTruthy();
		expect(attempt.deliveryBoundarySeq).toBeGreaterThan(0);
		expect(attempt.workerId).toBeTruthy();

		// Prompt carries thread context, not task scaffolding.
		const prompt = w.spawnPort.lastConnection?.promptCalls[0] ?? "";
		expect(prompt).toContain("R2B Thread");
		expect(prompt).toContain("please summarize");
		expect(prompt).not.toContain("# Task");

		// R2-c: the durable body committed into the R message; the draft is
		// deleted by T2 after settlement.
		const turnId = attempt.turnExecutionId;
		expect(turnId).toBeTruthy();
		expect(w.drafts.getByTurn(turnId!)).toBeNull();
		const response = w.messages.get(attempt.responseMessageId!)!;
		expect(response.content).toBe("Summary: all good.");

		// First visible output counted the session 0→1.
		const session = w.sessions.get(attempt.agentSessionId!)!;
		expect(session.piSessionId).toBe("pi-1");
		expect(session.piSessionFile).toBe("/tmp/sess-1.json");
		expect(session.messageCount).toBe(1);
		expect(session.lastCountedTurnExecutionId).toBe(turnId);

		// Worker retired after the turn (warmTtl=0) + binding dropped.
		expect(w.workerStore.get(attempt.workerId!)?.state).toBe("retired");
		expect(w.bindingStore.getBySession(session.id)).toBeNull();

		// Ephemeral stream reached the observer.
		expect(w.streamEvents.some((event) => event.type === "text")).toBe(true);
		expect(w.streamEvents.some((event) => event.type === "done")).toBe(true);
	});

	it("provider error: clean throw → R2-a convergence terminalizes the chain", async () => {
		const w = makeWorld();
		w.ingress.submit({ threadId: "t1", userId: "u1", body: "explode please @a1", now: 10 });
		w.spawnPort.scriptFor = [
			{
				type: "message_end",
				message: { role: "assistant", content: [], errorMessage: "model exploded" },
			},
			{ type: "agent_settled", aborted: false },
		];
		const result = await w.processor.drain("t1", "u1");
		expect(result.processed).toBe(1);
		expect(result.convergenceFailed).toEqual([]);
		const queued = w.queue.listQueued("t1");
		const invocationId = `inv:t1:${queued[0]!.payload.sourceRecordId}`;
		const attempt = w.attempts.getLatest(invocationId, "a1")!;
		expect(attempt.deliveryState).toBe("failed");
		expect(attempt.terminalReason).toBe("provider_phase_failed");
		expect(attempt.settlement).toBe("settled");
	});

	it("toolCallClaims reserve: replay ok, divergent intent conflicts (strong CAS)", () => {
		const w = makeWorld();
		const session = w.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/p",
			now: 10,
		});
		w.records.create({
			invocationId: "inv1",
			threadId: "t1",
			userId: "u1",
			sourceRecordId: "s1",
			userMessageId: null,
			targetAgentIds: ["a1"],
			now: 10,
		});
		w.turns.createRunning({
			turnExecutionId: "te1",
			parentInvocationId: "inv1",
			threadId: "t1",
			userId: "u1",
			agentId: "a1",
			executionKind: "ordinary",
			causal: { triggerMessageId: "m1" },
			startedAt: 10,
		});
		const minted = w.credentials.create({
			turnExecutionId: "te1",
			parentInvocationId: "inv1",
			threadId: "t1",
			agentId: "a1",
			agentSessionId: session.id,
			userId: "u1",
			allowedTools: [],
			now: 10,
		});
		expect(minted.token).not.toBe("");
		const input = { piExtToolCallId: "call-1", intentHash: "h1", messageId: "m1", queueEntryId: null };
		expect(w.credentials.reserveToolCallClaim("te1", input, 20)).toEqual({ outcome: "reserved" });
		expect(w.credentials.reserveToolCallClaim("te1", input, 30)).toEqual({ outcome: "replayed" });
		expect(
			w.credentials.reserveToolCallClaim(
				"te1",
				{ piExtToolCallId: "call-1", intentHash: "h2", messageId: "m1", queueEntryId: null },
				40,
			),
		).toEqual({ outcome: "conflict" });
	});
});
