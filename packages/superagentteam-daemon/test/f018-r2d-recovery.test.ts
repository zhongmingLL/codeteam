import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, AgentCatalog, AgentConfig } from "@superagentteam/shared/types";
import { afterEach, describe, expect, it } from "vitest";
import type { A2ARuntime } from "../src/domains/a2a/runtime.ts";
import { buildA2ARuntime } from "../src/domains/a2a/runtime.ts";
import type { AgentRegistry } from "../src/domains/agent/registry.ts";
import { buildRegistry } from "../src/domains/agent/registry.ts";
import type { WorkerRpcConnection, WorkerSpawnPort } from "../src/domains/worker/pool.ts";
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
		_message: string,
		options: { timeoutMs: number; signal?: AbortSignal; onAccepted?: () => void },
	): Promise<{ aborted: boolean }> {
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
	/** Per-spawn overrides, popped in order; fall back to scriptFor/promptError. */
	perSpawn: Array<{ script?: RpcEvent[]; promptError?: string | null }> = [];

	async spawn(): Promise<{
		connection: WorkerRpcConnection;
		pid: number | null;
		piSessionId: string | null;
		piSessionFile: string | null;
		spawnMs: number;
	}> {
		this.spawns += 1;
		this.lastConnection = new ScriptedConnection();
		const override = this.perSpawn.shift();
		this.lastConnection.script = override?.script ?? this.scriptFor;
		this.lastConnection.promptError = override?.promptError ?? this.promptError;
		return {
			connection: this.lastConnection,
			pid: 4242,
			piSessionId: `pi-${this.spawns}`,
			piSessionFile: `/tmp/sess-${this.spawns}.json`,
			spawnMs: 30,
		};
	}
}

function makeWorld(agents: AgentConfig[] = [agentConfig("a1"), agentConfig("a2")]) {
	const dir = mkdtempSync(join(tmpdir(), "f018-r2d-"));
	dirs.push(dir);
	const db = new F018Database({ path: join(dir, "f018.db") });
	db.db
		.prepare(
			"INSERT INTO threads (id, project_path, title, created_by, last_active_at, created_at, updated_at) VALUES ('t1', '/p', 'R2D Thread', 'u1', 1, 1, 1)",
		)
		.run();
	const catalog: AgentCatalog = { version: 1, agents };
	const registry: AgentRegistry = buildRegistry(catalog, [ACCOUNT]);
	const spawnPort = new MockSpawnPort();
	let clockNow = 1000;
	const runtime: A2ARuntime = buildA2ARuntime({
		db: db.db,
		registry,
		spawn: spawnPort,
		clock: () => clockNow,
		// The "current process" starts after every stale child in tests.
		processStartedAt: 10_000,
	});
	return {
		dir,
		db: db.db,
		runtime,
		spawnPort,
		advance: (ms: number) => {
			clockNow += ms;
		},
		get now() {
			return clockNow;
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
			message: { role: "assistant", content: [{ type: "text", text }], usage: { inputTokens: 5, outputTokens: 2 } },
		},
		{ type: "agent_settled", aborted: false },
	];
}

// ------------------------------------------------------------------
// requestRetry / abandon (§3.9)
// ------------------------------------------------------------------
describe("requestRetry / abandon (0007 §3.9)", () => {
	it("retry re-adds failed targets to the SAME entry; next drain appends attempt+1", async () => {
		const w = makeWorld();
		// a1 succeeds; a2 fails AFTER the prompt was accepted (delivered error
		// → terminal failed, no replay — the retryable shape for requestRetry).
		w.spawnPort.perSpawn = [
			{ script: happyScript("from a1") },
			{
				script: [
					{ type: "message_end", message: { role: "assistant", content: [], errorMessage: "boom" } },
					{ type: "agent_settled", aborted: false },
				],
			},
		];
		const submitted = w.runtime.ingress.submit({ threadId: "t1", userId: "u1", body: "both @a1 @a2", now: 10 });
		const first = await w.runtime.processor.drain("t1", "u1", { maxEntries: 2 });
		expect(first.processed).toBeGreaterThanOrEqual(1);
		const invocationId = `inv:t1:${submitted.message.id}`;
		expect(w.runtime.records.get(invocationId)?.status).toBe("partial_failed");

		const retry = w.runtime.processor.requestRetry(invocationId);
		expect(retry.outcome).toBe("admitted");
		expect(retry.retriedAgents).toEqual(["a2"]);
		expect(w.runtime.records.get(invocationId)?.status).toBe("queued");
		// Entry requeued with a2 pending (a1 NOT re-added — already successful).
		const queued = w.runtime.queue.listQueued("t1");
		expect(queued).toHaveLength(1);
		expect(queued[0]!.targets.map((t) => t.id)).toEqual(["a2"]);

		// Retry succeeds → parent completed, old attempt rows immutable.
		w.spawnPort.perSpawn = [{ script: happyScript("a2 recovered") }];
		const second = await w.runtime.processor.drain("t1", "u1", { maxEntries: 2 });
		expect(second.processed).toBeGreaterThanOrEqual(1);
		expect(w.runtime.records.get(invocationId)?.status).toBe("completed");
		const a2Attempts = w.runtime.attempts
			.listByInvocation(invocationId)
			.filter((attempt) => attempt.targetAgentId === "a2");
		expect(a2Attempts).toHaveLength(2);
		expect(a2Attempts[0]!.deliveryState).toBe("failed");
		expect(a2Attempts[1]!.deliveryState).toBe("handled");
	});

	it("retry rejects completed parents and non-settled attempts; abandon converges to canceled", async () => {
		const w = makeWorld();
		w.spawnPort.scriptFor = happyScript("ok");
		const submitted = w.runtime.ingress.submit({ threadId: "t1", userId: "u1", body: "go @a1", now: 10 });
		await w.runtime.processor.drain("t1", "u1");
		const invocationId = `inv:t1:${submitted.message.id}`;
		expect(w.runtime.processor.requestRetry(invocationId).outcome).toBe("not_retryable");
		expect(w.runtime.processor.abandon(invocationId).outcome).toBe("not_abandonable");

		// Failed parent → retryable; abandon instead → canceled + entry deleted.
		w.spawnPort.perSpawn = [
			{
				script: [
					{ type: "message_end", message: { role: "assistant", content: [], errorMessage: "boom" } },
					{ type: "agent_settled", aborted: false },
				],
			},
		];
		const failed = w.runtime.ingress.submit({ threadId: "t1", userId: "u1", body: "again @a1", now: 20 });
		await w.runtime.processor.drain("t1", "u1");
		const failedId = `inv:t1:${failed.message.id}`;
		expect(w.runtime.records.get(failedId)?.status).toBe("failed");
		const abandoned = w.runtime.processor.abandon(failedId);
		expect(abandoned.outcome).toBe("abandoned");
		expect(w.runtime.records.get(failedId)?.status).toBe("canceled");
		const latest = w.runtime.attempts.getLatest(failedId, "a1");
		expect(w.runtime.queue.get("t1", latest!.queueEntryId)).toBeNull();
	});
});

// ------------------------------------------------------------------
// Startup reconciler + owner reaper (§3.10)
// ------------------------------------------------------------------
describe("startup reconciler + owner reaper (0007 §3.10)", () => {
	it("startup: pre-process running children converge to interrupted/process_restart; parents re-aggregate", async () => {
		const w = makeWorld();
		// Simulate a crash mid-flight: run the full dispatch, then flip the
		// terminal rows back to the mid-flight durable shape (running child +
		// appended attempt + processing R) — exactly what a pre-process crash
		// leaves behind.
		const submitted = w.runtime.ingress.submit({ threadId: "t1", userId: "u1", body: "go @a1", now: 10 });
		const invocationId = `inv:t1:${submitted.message.id}`;
		await w.runtime.processor.drain("t1", "u1");
		// Reopen as a stale pre-process child: flip the terminal rows back.
		w.db
			.prepare(
				"UPDATE turn_executions SET status = 'running', ended_at = NULL, terminal_reason = NULL WHERE turn_execution_id LIKE ?",
			)
			.run(`te:att:${invocationId}%`);
		w.db
			.prepare(
				"UPDATE invocation_attempts SET delivery_state = 'appended', settlement = 'streaming', ended_at = NULL, terminal_reason = NULL WHERE parent_invocation_id = ?",
			)
			.run(invocationId);
		w.db
			.prepare("UPDATE invocation_records SET status = 'running', ended_at = NULL WHERE invocation_id = ?")
			.run(invocationId);

		const result = w.runtime.startup.recover(w.now);
		expect(result.childrenInterrupted).toBeGreaterThanOrEqual(1);
		const attempt = w.runtime.attempts.getLatest(invocationId, "a1")!;
		expect(w.runtime.turns.get(attempt.turnExecutionId!)?.status).toBe("interrupted");
		expect(w.runtime.turns.get(attempt.turnExecutionId!)?.terminalReason).toBe("process_restart");
		expect(attempt.deliveryState).toBe("interrupted");
		// T4 settled the leftover processing R from the (empty) draft.
		expect(attempt.settlement).toBe("settled");
		// Parent re-aggregated to failed (0 completed, 1 interrupted).
		expect(w.runtime.records.get(invocationId)?.status).toBe("failed");
		expect(w.runtime.startup.startupRecoveryComplete).toBe(true);
	});

	it("reaper: a running child with no live worker converges to interrupted/owner_reaped", async () => {
		const w = makeWorld();
		const submitted = w.runtime.ingress.submit({ threadId: "t1", userId: "u1", body: "go @a1", now: 10 });
		await w.runtime.processor.drain("t1", "u1");
		const invocationId = `inv:t1:${submitted.message.id}`;
		// Reopen as running; no worker rows exist → no liveness evidence.
		w.db
			.prepare(
				"UPDATE turn_executions SET status = 'running', ended_at = NULL, terminal_reason = NULL WHERE turn_execution_id LIKE ?",
			)
			.run(`te:att:${invocationId}%`);
		w.db
			.prepare(
				"UPDATE invocation_attempts SET delivery_state = 'appended', settlement = 'streaming', ended_at = NULL WHERE parent_invocation_id = ?",
			)
			.run(invocationId);
		w.db
			.prepare("UPDATE invocation_records SET status = 'running', ended_at = NULL WHERE invocation_id = ?")
			.run(invocationId);

		// First sweep ARMS the provider finalization grace (no convergence).
		const armed = await w.runtime.reaper.runOnce(w.now);
		expect(armed.childrenInterrupted).toBe(0);
		expect(armed.deferred).toBeGreaterThanOrEqual(1);
		// Inside the grace window: still deferred.
		w.advance(60_000);
		const within = await w.runtime.reaper.runOnce(w.now);
		expect(within.childrenInterrupted).toBe(0);
		// Past the 5min grace: exact-owner absence converges.
		w.advance(300_000);
		const result = await w.runtime.reaper.runOnce(w.now);
		expect(result.childrenInterrupted).toBeGreaterThanOrEqual(1);
		const attempt = w.runtime.attempts.getLatest(invocationId, "a1")!;
		expect(w.runtime.turns.get(attempt.turnExecutionId!)?.terminalReason).toBe("provider_exited_without_terminal");
		// Further sweeps are no-ops (idempotent; in-flight guard).
		const again = await w.runtime.reaper.runOnce(w.now);
		expect(again.childrenInterrupted).toBe(0);
	});
});

// ------------------------------------------------------------------
// Round-1 P1 repro suite (宪宪)
// ------------------------------------------------------------------
describe("round-1 P1 repro (recovery edge shapes)", () => {
	it("P1-1: a running turn WITHOUT an attempt row still converges (no permanent zombie)", async () => {
		const w = makeWorld();
		// Seed a bare running turn with no attempt.
		w.runtime.records.create({
			invocationId: "inv-z",
			threadId: "t1",
			userId: "u1",
			sourceRecordId: "sz",
			userMessageId: null,
			targetAgentIds: ["a1"],
			now: 10,
		});
		w.runtime.turns.createRunning({
			turnExecutionId: "te-z",
			parentInvocationId: "inv-z",
			threadId: "t1",
			userId: "u1",
			agentId: "a1",
			executionKind: "ordinary",
			causal: { triggerMessageId: "mz" },
			startedAt: 20,
		});
		const armed = await w.runtime.reaper.runOnce(w.now);
		expect(armed.childrenInterrupted).toBe(0);
		w.advance(400_000);
		const result = await w.runtime.reaper.runOnce(w.now);
		expect(result.childrenInterrupted).toBe(1);
		expect(w.runtime.turns.get("te-z")?.status).toBe("interrupted");
	});

	it("P1-2: starting/queued attempts keep the parent NON-terminal through startup (§3.9 collector)", async () => {
		const w = makeWorld();
		// Parent with a1 = failed attempt, a2 = queued attempt (no child).
		w.runtime.records.create({
			invocationId: "inv-m",
			threadId: "t1",
			userId: "u1",
			sourceRecordId: "sm",
			userMessageId: null,
			targetAgentIds: ["a1", "a2"],
			now: 10,
		});
		w.runtime.records.markRunning("inv-m", 10);
		for (const [agentId, state] of [
			["a1", "failed"],
			["a2", "queued"],
		] as const) {
			w.runtime.attempts.appendQueued({
				attemptId: `att-m-${agentId}`,
				parentInvocationId: "inv-m",
				queueEntryId: "qm",
				threadId: "t1",
				targetAgentId: agentId,
				attempt: 1,
				now: 10,
			});
			if (state === "failed") {
				w.db
					.prepare(
						"UPDATE invocation_attempts SET delivery_state = 'failed', terminal_reason = 'x', ended_at = 11 WHERE attempt_id = ?",
					)
					.run(`att-m-${agentId}`);
			}
		}
		w.runtime.startup.recover(w.now);
		// a2's queued attempt (no child, not retryablePending-marked at the store
		// level here) keeps the parent running — NOT prematurely failed.
		expect(w.runtime.records.get("inv-m")?.status).toBe("running");
	});
});

// ------------------------------------------------------------------
// Round-2 P1 repro: fresh slot in the Phase A→B window
// ------------------------------------------------------------------
describe("round-2 P1 repro (stale-slot age gate)", () => {
	it("a FRESH slot without a turn row survives the sweep; an OLD one is released", async () => {
		const w = makeWorld();
		// An OLD slot (past the safety threshold, no turn row).
		w.runtime.tracker.start("t1", "a2", "u1", "te-old");
		w.advance(120_000); // > default 60s staleSlotMinAgeMs

		// NOW a fresh slot mid-dispatch (Phase A startAll ran; Phase B has
		// not created the TurnExecution row yet) — age 0 at sweep time.
		w.runtime.tracker.start("t1", "a1", "u1", "te-pending");
		const sweep = await w.runtime.reaper.runOnce(w.now);
		// The old slot is released; the fresh one survives.
		expect(sweep.staleSlotsReleased).toBeGreaterThanOrEqual(1);
		expect(w.runtime.tracker.isBusy("t1", "a2")).toBe(false);
		expect(w.runtime.tracker.isBusy("t1", "a1")).toBe(true);

		// An immediate second sweep still leaves the fresh slot alone.
		const again = await w.runtime.reaper.runOnce(w.now);
		expect(again.staleSlotsReleased).toBe(0);
		expect(w.runtime.tracker.isBusy("t1", "a1")).toBe(true);
	});
});

// ------------------------------------------------------------------
// E2E exit evidence via the composition root (mock provider)
// ------------------------------------------------------------------
describe("R2 exit evidence via buildA2ARuntime (E1/E13/E14-class)", () => {
	it("full runtime journey: submit → drain → response committed → read model clean", async () => {
		const w = makeWorld();
		w.spawnPort.scriptFor = happyScript("final e2e answer");
		const submitted = w.runtime.ingress.submit({ threadId: "t1", userId: "u1", body: "hello @a1", now: 10 });
		const result = await w.runtime.processor.drain("t1", "u1");
		expect(result.processed).toBe(1);
		const invocationId = `inv:t1:${submitted.message.id}`;
		const attempt = w.runtime.attempts.getLatest(invocationId, "a1")!;
		const response = w.runtime.messages.get(attempt.responseMessageId!)!;
		expect(response.content).toBe("final e2e answer");
		// Read model: cursor consumed, participant recorded, parent completed.
		expect(w.runtime.readState.get("t1", "a1")?.deliveryCursor).toBe(attempt.deliveryBoundarySeq);
		expect(w.runtime.threads.listParticipants("t1")).toContain("a1");
		expect(w.runtime.records.get(invocationId)?.status).toBe("completed");
		// Worker metrics consumed (snapshotMetrics consumer: the runtime).
		const metrics = w.runtime.pool.snapshotMetrics();
		expect(metrics.spawnCount).toBeGreaterThanOrEqual(1);
	});
});
