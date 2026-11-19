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
import { collectTerminalDispositions } from "../src/domains/invocation/collector.ts";
import {
	ResponseRecoveryService,
	RouteResponseCommitter,
	TurnExecutionLifecycle,
} from "../src/domains/invocation/settlement.ts";
import { InvocationAttemptStore, InvocationRecordStore, TurnExecutionStore } from "../src/domains/invocation/store.ts";
import { AgentReadStateStore, MessageStore } from "../src/domains/message/store.ts";
import { QueueProcessor } from "../src/domains/queue/processor.ts";
import { QueueLedgerStore } from "../src/domains/queue/store.ts";
import { InvocationTracker } from "../src/domains/queue/tracker.ts";
import { ResponseDraftStore } from "../src/domains/response/store.ts";
import { AgentSessionStore } from "../src/domains/session/store.ts";
import { ThreadStore } from "../src/domains/thread/store.ts";
import type { WorkerRpcConnection, WorkerSpawnPort } from "../src/domains/worker/pool.ts";
import { WorkerPool } from "../src/domains/worker/pool.ts";
import { WorkerBindingStore, WorkerStore } from "../src/domains/worker/store.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";
import type { RpcEvent } from "../src/workers/rpc-client.ts";

const dirs: string[] = [];

function agentConfig(id: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		id,
		mentionPatterns: [`@${id}`],
		displayName: `Agent ${id}`,
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

class ScriptedConnection implements WorkerRpcConnection {
	private readonly listeners: Array<(event: RpcEvent) => void> = [];
	readonly promptCalls: string[] = [];
	script: RpcEvent[] = [];
	promptError: string | null = null;

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
		if (this.promptError) throw new Error(this.promptError);
		options.onAccepted?.();
		for (const event of this.script) {
			for (const listener of [...this.listeners]) listener(event);
		}
		return { aborted: false };
	}

	async finish(): Promise<void> {}
}

class MockSpawnPort implements WorkerSpawnPort {
	spawns = 0;
	lastConnection: ScriptedConnection | null = null;
	scriptFor: RpcEvent[] = [];
	promptError: string | null = null;

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
		this.lastConnection.promptError = this.promptError;
		return {
			connection: this.lastConnection,
			pid: 4242,
			piSessionId: `pi-${this.spawns}`,
			piSessionFile: `/tmp/sess-${this.spawns}.json`,
			spawnMs: 37,
		};
	}
}

function makeWorld(agents: AgentConfig[] = [agentConfig("a1"), agentConfig("a2")]) {
	const dir = mkdtempSync(join(tmpdir(), "f018-r2c-"));
	dirs.push(dir);
	const db = new F018Database({ path: join(dir, "f018.db") });
	db.db
		.prepare(
			"INSERT INTO threads (id, project_path, title, created_by, last_active_at, created_at, updated_at) VALUES ('t1', '/p', 'R2C Thread', 'u1', 1, 1, 1)",
		)
		.run();
	const catalog: AgentCatalog = { version: 1, agents };
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
	const settlementDeps = {
		db: db.db,
		turns,
		attempts,
		credentials,
		sessions,
		readState,
		messages,
		drafts,
		threads,
		clock,
	};
	const lifecycle = new TurnExecutionLifecycle(settlementDeps);
	const committer = new RouteResponseCommitter(settlementDeps);
	const recovery = new ResponseRecoveryService(settlementDeps);
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
		spawnPort,
		pool,
		ingress,
		processor,
		streamEvents,
		lifecycle,
		committer,
		recovery,
		settlementDeps,
		advance: (ms: number) => {
			clockNow += ms;
		},
	};
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function happyScript(text: string): RpcEvent[] {
	return [
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } },
		{
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text }], usage: { inputTokens: 7, outputTokens: 3 } },
		},
		{ type: "agent_settled", aborted: false },
	];
}

// ------------------------------------------------------------------
// T1 + T2 through the full flow
// ------------------------------------------------------------------
describe("T1/T2 full flow (0007 §3.6/§3.9)", () => {
	it("completed turn: child terminal, R committed from draft, draft deleted, ack, participant, parent completed, entry deleted", async () => {
		const w = makeWorld();
		const submitted = w.ingress.submit({ threadId: "t1", userId: "u1", body: "go @a1", now: 10 });
		w.spawnPort.scriptFor = [
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "pondering" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Final answer." } },
			{
				type: "tool_execution_start",
				toolCallId: "tc-9",
				toolName: "read_file",
				args: { path: "/x" },
			},
			{ type: "tool_execution_end", toolCallId: "tc-9", toolName: "read_file", result: { ok: true } },
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Final answer." }],
					usage: { inputTokens: 7, outputTokens: 3 },
				},
			},
			{ type: "agent_settled", aborted: false },
		];
		const result = await w.processor.drain("t1", "u1");
		expect(result.processed).toBe(1);

		const invocationId = `inv:t1:${submitted.message.id}`;
		const attempt = w.attempts.getLatest(invocationId, "a1")!;
		const turnId = attempt.turnExecutionId!;

		// T1: child terminal + attempt handled.
		expect(w.turns.get(turnId)?.status).toBe("completed");
		expect(attempt.deliveryState).toBe("handled");
		// T2: R terminal with the draft body, draft deleted, settled.
		const response = w.messages.get(attempt.responseMessageId!)!;
		expect(response.lifecycle?.kind).toBe("response");
		if (response.lifecycle?.kind === "response") {
			expect(response.lifecycle.status).toBe("completed");
			expect(response.lifecycle.endedAt).toBeTruthy();
		}
		expect(response.content).toBe("Final answer.");
		// Round-1 P1-3: the R carries the draft's FULL payload — thinking +
		// merged toolEvents survive the draft deletion.
		expect(response.thinking).toBe("pondering");
		expect(response.toolEvents).toHaveLength(1);
		expect(response.toolEvents?.[0]).toMatchObject({ toolCallId: "tc-9", status: "completed" });
		expect(w.drafts.getByTurn(turnId)).toBeNull();
		expect(attempt.settlement).toBe("settled");

		// Round-1 P2: re-commit after settle is idempotent — the settling tail
		// (refs + draft + pending) runs without rewriting the terminal R.
		const again = w.committer.commit({ turnExecutionId: turnId, content: "should not overwrite" });
		expect(again.outcome).toBe("already_terminal");
		expect(w.messages.get(attempt.responseMessageId!)?.content).toBe("Final answer.");
		// Input dispatchRef settled.
		const input = w.messages.get(submitted.message.id)!;
		if (input.lifecycle?.kind === "input") {
			expect(input.lifecycle.dispatchRefs[0]?.phase).toBe("settled");
		}
		// Ack: cursor advanced to the consumed boundary (promptDelivered ✓).
		expect(w.readState.get("t1", "a1")?.deliveryCursor).toBe(attempt.deliveryBoundarySeq);
		// Completed turn counts exactly once (0010 §6).
		expect(w.sessions.get(attempt.agentSessionId!)?.messageCount).toBe(1);
		// Participant added on first completed turn.
		expect(w.threads.listParticipants("t1")).toContain("a1");
		// T3: parent completed + queue anchor deleted.
		expect(w.records.get(invocationId)?.status).toBe("completed");
		expect(w.records.get(invocationId)?.successfulAgentIds).toEqual(["a1"]);
		expect(w.queue.get("t1", (await Promise.resolve(result)) && submitted.queueEntry.queueEntryId)).toBeNull();
	});

	it("T1 idempotent: same status → already_terminal, no double count; different status → conflict", async () => {
		const w = makeWorld();
		const submitted = w.ingress.submit({ threadId: "t1", userId: "u1", body: "go @a1", now: 10 });
		w.spawnPort.scriptFor = happyScript("once.");
		await w.processor.drain("t1", "u1");
		const attempt = w.attempts.getLatest(`inv:t1:${submitted.message.id}`, "a1")!;
		const turnId = attempt.turnExecutionId!;
		const session = w.sessions.get(attempt.agentSessionId!)!;
		const countAfterFirst = session.messageCount;

		const again = w.lifecycle.invokeTerminal({
			turnExecutionId: turnId,
			status: "completed",
			endedAt: 9999,
			userVisibleOutput: true,
		});
		expect(again.outcome).toBe("already_terminal");
		expect(w.sessions.get(session.id)?.messageCount).toBe(countAfterFirst);

		const conflict = w.lifecycle.invokeTerminal({
			turnExecutionId: turnId,
			status: "failed",
			endedAt: 9999,
			terminalReason: "nope",
			userVisibleOutput: false,
		});
		expect(conflict.outcome).toBe("terminal_conflict");
		expect(w.turns.get(turnId)?.status).toBe("completed");
	});

	it("ack is promptDelivered-gated: undelivered turns do not advance the cursor", async () => {
		const w = makeWorld();
		const submitted = w.ingress.submit({ threadId: "t1", userId: "u1", body: "go @a1", now: 10 });
		// Provider errors BEFORE accept → no promptDelivered → no ack; the
		// convergence terminalizes failed and the target replays.
		w.spawnPort.promptError = "connection refused";
		await w.processor.drain("t1", "u1");
		expect(w.readState.get("t1", "a1")).toBeNull();
		void submitted;
	});
});

// ------------------------------------------------------------------
// T2 guards
// ------------------------------------------------------------------
describe("T2 RouteResponseCommitter", () => {
	it("child still running → child_running, R stays processing, pending kept", async () => {
		const w = makeWorld();
		const submitted = w.ingress.submit({ threadId: "t1", userId: "u1", body: "go @a1", now: 10 });
		// Phase A/B only: dispatch with a noop port leaves the child running.
		const noopProcessor = new QueueProcessor({
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
			clock: () => 1000,
		});
		await noopProcessor.drain("t1", "u1");
		const invocationId = `inv:t1:${submitted.message.id}`;
		const attempt = w.attempts.getLatest(invocationId, "a1")!;
		const outcome = w.committer.commit({ turnExecutionId: attempt.turnExecutionId!, content: "early" });
		expect(outcome.outcome).toBe("child_running");
		const response = w.messages.get(attempt.responseMessageId!)!;
		if (response.lifecycle?.kind === "response") {
			expect(response.lifecycle.status).toBe("processing");
		}
	});
});

// ------------------------------------------------------------------
// T3 collector matrix
// ------------------------------------------------------------------
describe("T3 collector (§3.9 aggregation table)", () => {
	function view(
		agentId: string,
		childStatus: string | null,
		opts: { retryable?: boolean; attemptState?: string } = {},
	) {
		return {
			agentId,
			latestAttempt: opts.attemptState ? ({ deliveryState: opts.attemptState, terminalReason: "x" } as never) : null,
			child: childStatus ? ({ status: childStatus, terminalReason: "x" } as never) : null,
			retryablePending: opts.retryable ?? false,
		};
	}
	const parent = { retryCount: 0 } as never;

	it("all completed → completed", () => {
		const r = collectTerminalDispositions({
			parent,
			targets: [view("a1", "completed"), view("a2", "completed")],
		});
		expect(r.parentStatus).toBe("completed");
		expect(r.successfulAgentIds).toEqual(["a1", "a2"]);
	});

	it("mixed completed + failed → partial_failed with primaryTerminalError", () => {
		const r = collectTerminalDispositions({
			parent,
			targets: [view("a1", "completed"), view("a2", "failed")],
		});
		expect(r.parentStatus).toBe("partial_failed");
		expect(r.successfulAgentIds).toEqual(["a1"]);
		expect(r.primaryTerminalError).toBeTruthy();
	});

	it("all failed → failed; all canceled → canceled", () => {
		expect(
			collectTerminalDispositions({ parent, targets: [view("a1", "failed"), view("a2", "interrupted")] })
				.parentStatus,
		).toBe("failed");
		expect(
			collectTerminalDispositions({ parent, targets: [view("a1", "canceled"), view("a2", "canceled")] })
				.parentStatus,
		).toBe("canceled");
	});

	it("running child or retryablePending keeps the parent non-terminal", () => {
		expect(
			collectTerminalDispositions({ parent, targets: [view("a1", "completed"), view("a2", "running")] })
				.parentStatus,
		).toBe("running");
		expect(
			collectTerminalDispositions({
				parent,
				targets: [view("a1", "completed"), view("a2", "failed", { retryable: true })],
			}).parentStatus,
		).toBe("running");
	});

	it("prestart failure without a child reads delivery_state", () => {
		const r = collectTerminalDispositions({
			parent,
			targets: [view("a1", null, { attemptState: "failed" })],
		});
		expect(r.parentStatus).toBe("failed");
	});
});

// ------------------------------------------------------------------
// T4 recovery
// ------------------------------------------------------------------
describe("T4 ResponseRecoveryService", () => {
	it("crash window between T1 and T2: pending is settled from the durable draft", async () => {
		const w = makeWorld();
		const submitted = w.ingress.submit({ threadId: "t1", userId: "u1", body: "go @a1", now: 10 });
		// Run only through Phase A/B (noop port), then T1 by hand — crash
		// before T2 leaves settlement=response_pending with a live draft.
		const noopProcessor = new QueueProcessor({
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
			clock: () => 1000,
		});
		await noopProcessor.drain("t1", "u1");
		const invocationId = `inv:t1:${submitted.message.id}`;
		const attempt = w.attempts.getLatest(invocationId, "a1")!;
		w.drafts.upsert({
			attemptId: attempt.attemptId,
			turnExecutionId: attempt.turnExecutionId!,
			parentInvocationId: invocationId,
			threadId: "t1",
			agentId: "a1",
			content: "Recovered body.",
			toolEvents: [],
			thinking: null,
			createdAt: 10,
			updatedAt: 10,
		});
		// A completed child implies the prompt reached the provider via a
		// worker (store CHECKs + FK enforce both) — seed the carrier first.
		w.db
			.prepare(
				"INSERT INTO workers (id, project_path, account_ref, provider, model, state, heartbeat_at, lease_expires_at, created_at, updated_at) VALUES ('w-crash-window', '/p', 'main', 'pi', 'm1', 'online', 1, 99999, 1, 1)",
			)
			.run();
		w.attempts.bindWorker(attempt.attemptId, "w-crash-window");
		w.attempts.markPromptDelivered(attempt.attemptId, { deliveryBoundarySeq: 1, now: 1500 });
		const t1 = w.lifecycle.invokeTerminal({
			turnExecutionId: attempt.turnExecutionId!,
			status: "completed",
			endedAt: 2000,
			userVisibleOutput: true,
		});
		expect(t1.outcome).toBe("terminalized");
		expect(w.turns.listResponsePending().length).toBeGreaterThan(0);

		const result = w.recovery.runOnce();
		expect(result.settled).toBeGreaterThanOrEqual(1);
		const response = w.messages.get(attempt.responseMessageId!)!;
		expect(response.content).toBe("Recovered body.");
		if (response.lifecycle?.kind === "response") {
			expect(response.lifecycle.status).toBe("completed");
		}
		expect(w.drafts.getByTurn(attempt.turnExecutionId!)).toBeNull();
		expect(w.turns.listResponsePending()).toHaveLength(0);
	});

	it("response_missing: typed system message, attempt settled, no delivery_failure", () => {
		const w = makeWorld();
		// Seed a response_pending attempt with no R.
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
		w.attempts.appendQueued({
			attemptId: "att1",
			parentInvocationId: "inv1",
			queueEntryId: "q1",
			threadId: "t1",
			targetAgentId: "a1",
			attempt: 1,
			now: 10,
		});
		w.db
			.prepare(
				"INSERT INTO agent_sessions (id, thread_id, agent_id, user_id, seq, status, working_directory, created_at, updated_at) VALUES ('sess:t1:a1:0', 't1', 'a1', 'u1', 0, 'active', '/p', 1, 1)",
			)
			.run();
		w.attempts.markStarting("att1", { agentSessionId: "sess:t1:a1:0", now: 10 });
		// The FK forces the R row to exist at bind time; the reachable
		// response_missing shape is a SOFT-DELETED R.
		w.messages.append({
			id: "resp-void",
			threadId: "t1",
			from: { kind: "agent", agentId: "a1" },
			content: "",
			now: 10,
		});
		w.messages.softDelete("resp-void", "recovery-test", 15);
		w.attempts.bindAppended("att1", {
			turnExecutionId: "te1",
			agentSessionId: "sess:t1:a1:0",
			workerId: null,
			provider: "pi",
			model: "m1",
			modelFamily: null,
			responseMessageId: "resp-void",
			now: 10,
		});
		w.turns.transitionTerminal("te1", { status: "failed", endedAt: 20, terminalReason: "crash" });
		w.attempts.projectChildTerminal("att1", {
			turnExecutionId: "te1",
			childStatus: "failed",
			terminalReason: "crash",
			endedAt: 20,
		});
		const result = w.recovery.runOnce();
		expect(result.missing).toBeGreaterThanOrEqual(1);
		const system = w.messages.getByThread("t1", 10).find((message) => message.content.includes("response_missing"));
		expect(system?.from.kind).toBe("system");
		expect(w.turns.listResponsePending()).toHaveLength(0);
		// 烁烁 P2 (livelock) + 宪宪 P3 (real crash window): simulate the crash
		// between the marker append and the clear — marker EXISTS, pending is
		// STILL SET — then verify the retried sweep converges without hitting
		// the rm: message UNIQUE.
		w.db
			.prepare("UPDATE invocation_attempts SET settlement = 'response_pending' WHERE turn_execution_id = ?")
			.run("te1");
		const rerun = w.recovery.runOnce();
		expect(rerun.failures).toBe(0);
		expect(w.turns.listResponsePending()).toHaveLength(0);
		// Exactly one marker despite the retried sweep.
		const markers = w.messages
			.getByThread("t1", 50)
			.filter((message) => message.content.includes("response_missing"));
		expect(markers).toHaveLength(1);
	});
});
