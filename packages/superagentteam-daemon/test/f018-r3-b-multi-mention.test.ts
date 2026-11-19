import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, AgentCatalog, AgentConfig } from "@superagentteam/shared/types";
import { afterEach, describe, expect, it } from "vitest";

import { type A2ARuntime, buildA2ARuntime } from "../src/domains/a2a/runtime.ts";
import { type A2AToolContext, A2AToolError } from "../src/domains/a2a/tool-service.ts";
import { buildRegistry } from "../src/domains/agent/registry.ts";
import { MultiMentionOrchestrator } from "../src/domains/multi-mention/orchestrator.ts";
import { QUEUE_CAP_PER_KIND } from "../src/domains/queue/store.ts";
import type { WorkerRpcConnection, WorkerSpawnPort } from "../src/domains/worker/pool.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";
import type { RpcEvent } from "../src/workers/rpc-client.ts";

const dirs: string[] = [];
const ACCOUNT: AccountConfig = { ref: "main", provider: "pi", apiKeyRef: "KEY", models: ["m1"] };

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

class ScriptedConnection implements WorkerRpcConnection {
	private readonly listeners: Array<(event: RpcEvent) => void> = [];
	script: RpcEvent[] = [];

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
		options.onAccepted?.();
		for (const event of this.script) {
			for (const listener of [...this.listeners]) listener(event);
		}
		return { aborted: false };
	}

	async finish(): Promise<void> {}
}

class MockSpawnPort implements WorkerSpawnPort {
	scripts: RpcEvent[][] = [];
	spawns = 0;

	async spawn(): Promise<{
		connection: WorkerRpcConnection;
		pid: number | null;
		piSessionId: string | null;
		piSessionFile: string | null;
		spawnMs: number;
	}> {
		this.spawns += 1;
		const connection = new ScriptedConnection();
		connection.script = this.scripts.shift() ?? [];
		return {
			connection,
			pid: this.spawns,
			piSessionId: `pi-${this.spawns}`,
			piSessionFile: `/tmp/pi-${this.spawns}.json`,
			spawnMs: 1,
		};
	}
}

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

function makeWorld(allowedTools: string[] = ["multi_mention", "post_message"]): {
	runtime: A2ARuntime;
	spawn: MockSpawnPort;
	fd: F018Database;
	advance: (ms: number) => void;
	readonly now: number;
} {
	const dir = mkdtempSync(join(tmpdir(), "f018-r3b-"));
	dirs.push(dir);
	const fd = new F018Database({ path: join(dir, "f018.db") });
	const catalog: AgentCatalog = {
		version: 1,
		agents: [agentConfig("a1"), agentConfig("a2"), agentConfig("a3")],
	};
	const registry = buildRegistry(catalog, [ACCOUNT]);
	const spawn = new MockSpawnPort();
	let clockNow = 1000;
	const runtime = buildA2ARuntime({
		db: fd.db,
		registry,
		spawn,
		clock: () => clockNow,
		processStartedAt: 1,
	});
	runtime.threads.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
	const session = runtime.sessions.ensureActive({
		threadId: "t1",
		agentId: "a1",
		userId: "u1",
		workingDirectory: "/p",
		now: 1,
	});
	runtime.records.create({
		invocationId: "inv-caller",
		threadId: "t1",
		userId: "u1",
		sourceRecordId: "src-caller",
		userMessageId: null,
		targetAgentIds: ["a1"],
		now: 2,
	});
	runtime.turns.createRunning({
		turnExecutionId: "te-caller",
		parentInvocationId: "inv-caller",
		threadId: "t1",
		userId: "u1",
		agentId: "a1",
		executionKind: "ordinary",
		causal: { triggerMessageId: "m-caller" },
		startedAt: 3,
	});
	runtime.credentials.create({
		turnExecutionId: "te-caller",
		parentInvocationId: "inv-caller",
		threadId: "t1",
		agentId: "a1",
		agentSessionId: session.id,
		userId: "u1",
		allowedTools,
		now: 4,
	});
	return {
		runtime,
		spawn,
		fd,
		advance: (ms: number) => {
			clockNow += ms;
		},
		get now() {
			return clockNow;
		},
	};
}

function ctx(overrides: Partial<A2AToolContext> = {}): A2AToolContext {
	return {
		threadId: "t1",
		userId: "u1",
		callerAgentId: "a1",
		callerTurnExecutionId: "te-caller",
		piExtToolCallId: "mm-call-1",
		triggerMessageId: "m-caller",
		a2aDepth: 0,
		now: 100,
		...overrides,
	};
}

function multiMentionInput(overrides: Record<string, unknown> = {}) {
	return {
		targets: [
			{ kind: "agent" as const, id: "a2" },
			{ kind: "agent" as const, id: "a3" },
		],
		question: "What should we do?",
		context: "ctx",
		callbackTo: "a1",
		timeoutMinutes: 8,
		...overrides,
	};
}

function expectCode(error: unknown, code: string): void {
	expect(error).toBeInstanceOf(A2AToolError);
	expect((error as A2AToolError).code).toBe(code);
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("F018 R3-b multi_mention create", () => {
	it("creates one request + source message + queue entry and replays the same intent", () => {
		const w = makeWorld();
		const first = w.runtime.multiMentionOrchestrator.create(ctx(), multiMentionInput());
		expect(first.replayed).toBe(false);
		expect(first.status).toBe("pending");
		const request = w.runtime.multiMention.get(first.requestId)!;
		expect(request.status).toBe("pending");
		expect(request.targetAgentIds).toEqual(["a2", "a3"]);
		expect(request.callbackToAgentId).toBe("a1");
		expect(request.sourceRecordId).toBe(first.message.id);
		expect(first.message.threadId).toBe("t1");
		expect(first.message.from).toEqual({ kind: "agent", agentId: "a1" });
		expect(first.message.content).toContain("[Multi-Mention from Agent a1]");
		const entry = w.runtime.queue.get("t1", first.queueEntryId)!;
		expect(entry.kind).toBe("message_wake");
		expect(entry.owner).toEqual({ kind: "system", service: "multi_mention" });
		expect(entry.targets.map((target) => target.id)).toEqual(["a2", "a3"]);
		expect(entry.execution.multiMentionRequestId).toBe(first.requestId);
		expect(entry.execution.a2aDepth).toBe(1);

		const replay = w.runtime.multiMentionOrchestrator.create(ctx(), multiMentionInput());
		expect(replay.replayed).toBe(true);
		expect(replay.requestId).toBe(first.requestId);
		expect(replay.message.id).toBe(first.message.id);
		expect(replay.queueEntryId).toBe(first.queueEntryId);
		try {
			w.runtime.multiMentionOrchestrator.create(ctx(), multiMentionInput({ question: "Different?" }));
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "pi_ext_tool_call_conflict");
		}
	});

	it("validates targets/callback/timeout/cascade", () => {
		const w = makeWorld();
		try {
			w.runtime.multiMentionOrchestrator.create(
				ctx({ piExtToolCallId: "mm-one" }),
				multiMentionInput({ targets: [{ kind: "agent", id: "a2" }] }),
			);
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "multi_mention_invalid_targets");
		}
		try {
			w.runtime.multiMentionOrchestrator.create(
				ctx({ piExtToolCallId: "mm-callback-target" }),
				multiMentionInput({ callbackTo: "a2" }),
			);
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "multi_mention_invalid_callback");
		}
		try {
			w.runtime.multiMentionOrchestrator.create(
				ctx({ piExtToolCallId: "mm-timeout" }),
				multiMentionInput({ timeoutMinutes: 2 }),
			);
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "multi_mention_invalid_timeout");
		}
		try {
			w.runtime.multiMentionOrchestrator.create(
				ctx({ piExtToolCallId: "mm-depth", multiMentionCallbackDepth: 2 }),
				multiMentionInput(),
			);
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "multi_mention_cascade");
		}
	});

	it("enforces the multi_mention credential allowlist", () => {
		const w = makeWorld([]);
		try {
			w.runtime.multiMentionOrchestrator.create(ctx({ piExtToolCallId: "mm-no-tool" }), multiMentionInput());
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "tool_not_allowed");
		}
	});

	it("anti-cascade rejects a caller that is an active multi_mention target", () => {
		const w = makeWorld();
		const seeded = w.runtime.multiMention.createRequest({
			requestId: "mm-active",
			threadId: "t1",
			userId: "u1",
			initiatorAgentId: "a2",
			initiatorTurnExecutionId: "te-caller",
			callbackToAgentId: "a2",
			question: "seeded",
			targetAgentIds: ["a1", "a3"],
			timeoutMinutes: 8,
			sourceRecordId: "src-active",
			now: 10,
		});
		expect(seeded.outcome).toBe("created");
		w.runtime.multiMention.setStatus("mm-active", "running", 11);
		try {
			w.runtime.multiMentionOrchestrator.create(ctx({ piExtToolCallId: "mm-cascade" }), multiMentionInput());
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "multi_mention_cascade");
		}
	});

	it("fan-out runs a2/a3, T3 records responses, aggregate+callback close the group, participants join", async () => {
		const w = makeWorld();
		const created = w.runtime.multiMentionOrchestrator.create(ctx(), multiMentionInput());
		expect(w.runtime.multiMention.get(created.requestId)?.status).toBe("pending");
		w.spawn.scripts = [happyScript("from a2"), happyScript("from a3")];
		const drained = await w.runtime.processor.drain("t1", "u1");
		expect(drained.processed).toBe(1);
		expect(drained.convergenceFailed).toEqual([]);
		const request = w.runtime.multiMention.get(created.requestId)!;
		expect(request.status).toBe("done");
		expect(request.aggregateMessageId).toBeTruthy();
		expect(request.parentInvocationId).toBe(`inv:t1:${created.message.id}`);
		const responses = w.runtime.multiMention.listResponses(created.requestId);
		expect(responses).toHaveLength(2);
		expect(responses.map((response) => response.targetAgentId).sort()).toEqual(["a2", "a3"]);
		expect(responses.every((response) => response.status === "received")).toBe(true);
		expect(responses.every((response) => response.responseState === "terminal")).toBe(true);
		expect(w.runtime.multiMention.allTargetsAccounted(created.requestId)).toBe(true);
		const aggregate = w.runtime.messages.get(request.aggregateMessageId!)!;
		expect(aggregate.from).toEqual({ kind: "system", service: "multi_mention" });
		expect(aggregate.extra?.multiMention).toMatchObject({
			requestId: created.requestId,
			status: "done",
			callbackTo: "a1",
			allFailed: false,
		});
		const callback = w.runtime.multiMention.getCallback(created.requestId)!;
		expect(callback.status).toBe("queued");
		expect(callback.callbackToAgentId).toBe("a1");
		expect(callback.callbackDepth).toBe(1);
		expect(callback.queueEntryId).toBeTruthy();
		const callbackEntry = w.runtime.queue.get("t1", callback.queueEntryId!)!;
		expect(callbackEntry.kind).toBe("message_wake");
		expect(callbackEntry.targets.map((target) => target.id)).toEqual(["a1"]);
		expect(callbackEntry.execution.multiMentionCallbackDepth).toBe(1);
		const parent = w.runtime.records.get(`inv:t1:${created.message.id}`)!;
		expect(parent.status).toBe("completed");
		const childTurns = ["a2", "a3"].map((agentId) => {
			const attempt = w.runtime.attempts.getLatest(`inv:t1:${created.message.id}`, agentId)!;
			return w.runtime.turns.get(attempt.turnExecutionId!)!;
		});
		for (const child of childTurns) {
			expect(child.causal.a2aParentTurnExecutionId).toBe("te-caller");
			expect(child.causal.a2aTriggerMessageId).toBe(created.message.id);
			expect(child.causal.a2aDepth).toBe(1);
			expect(child.causal.multiMentionRequestId).toBe(created.requestId);
			expect(child.causal.multiMentionCallbackDepth).toBeUndefined();
			expect(w.runtime.credentials.getByTurn(child.turnExecutionId)?.allowedTools.sort()).toEqual(
				["cross_post_message", "multi_mention", "post_message", "thread_context"].sort(),
			);
		}
		expect(w.runtime.threads.listParticipants("t1")).toEqual(expect.arrayContaining(["a2", "a3"]));
		expect(w.runtime.queue.get("t1", created.queueEntryId)).toBeNull();
		const source = w.runtime.messages.get(created.message.id)!;
		if (source.lifecycle?.kind === "input") {
			expect(source.lifecycle.dispatchRefs).toHaveLength(2);
		} else {
			throw new Error("expected input lifecycle");
		}
	});

	it("delivers the callback child and closes the callback lifecycle", async () => {
		const w = makeWorld();
		const created = w.runtime.multiMentionOrchestrator.create(ctx(), multiMentionInput());
		w.spawn.scripts = [happyScript("from a2"), happyScript("from a3")];
		await w.runtime.processor.drain("t1", "u1");
		expect(w.runtime.multiMention.get(created.requestId)?.status).toBe("done");
		const queued = w.runtime.multiMention.getCallback(created.requestId)!;
		expect(queued.status).toBe("queued");
		w.spawn.scripts = [happyScript("callback from a1")];
		const drained = await w.runtime.processor.drain("t1", "u1");
		expect(drained.processed).toBe(1);
		const callback = w.runtime.multiMention.getCallback(created.requestId)!;
		expect(callback.status).toBe("completed");
		expect(callback.turnExecutionId).toBeTruthy();
		const turn = w.runtime.turns.get(callback.turnExecutionId!)!;
		expect(turn.causal.multiMentionRequestId).toBe(created.requestId);
		expect(turn.causal.multiMentionCallbackDepth).toBe(1);
	});

	it("keeps a received sibling when another target fails; allFailed stays false", async () => {
		const w = makeWorld();
		const created = w.runtime.multiMentionOrchestrator.create(ctx(), multiMentionInput());
		w.spawn.scripts = [
			happyScript("a2 ok"),
			[
				{ type: "message_end", message: { role: "assistant", content: [], errorMessage: "boom" } },
				{ type: "agent_settled", aborted: false },
			],
		];
		await w.runtime.processor.drain("t1", "u1");
		const request = w.runtime.multiMention.get(created.requestId)!;
		expect(request.status).toBe("done");
		const responses = w.runtime.multiMention.listResponses(created.requestId);
		expect(responses.find((response) => response.targetAgentId === "a2")?.status).toBe("received");
		expect(responses.find((response) => response.targetAgentId === "a3")?.status).toBe("failed");
		expect(w.runtime.multiMention.statusView(created.requestId)?.allFailed).toBe(false);
		const aggregate = w.runtime.messages.get(request.aggregateMessageId!)!;
		expect(aggregate.content).toContain("a2 ok");
		expect(aggregate.content).toContain("boom");
		expect(w.runtime.multiMention.getCallback(created.requestId)?.status).toBe("queued");
	});

	it("all failed targets still close with done + allFailed=true", async () => {
		const w = makeWorld();
		const created = w.runtime.multiMentionOrchestrator.create(ctx(), multiMentionInput());
		const failure: RpcEvent[] = [
			{ type: "message_end", message: { role: "assistant", content: [], errorMessage: "boom" } },
			{ type: "agent_settled", aborted: false },
		];
		w.spawn.scripts = [failure, failure];
		await w.runtime.processor.drain("t1", "u1");
		const request = w.runtime.multiMention.get(created.requestId)!;
		expect(request.status).toBe("done");
		expect(w.runtime.multiMention.statusView(created.requestId)?.allFailed).toBe(true);
		expect(w.runtime.multiMention.getCallback(created.requestId)?.status).toBe("queued");
	});

	it("settles an expired running request as timeout with a timeout aggregate + callback", () => {
		const w = makeWorld();
		const created = w.runtime.multiMentionOrchestrator.create(ctx(), multiMentionInput({ timeoutMinutes: 3 }));
		expect(w.runtime.multiMention.setStatus(created.requestId, "running", 1000).outcome).toBe("updated");
		w.advance(3 * 60_000);
		expect(w.runtime.multiMentionOrchestrator.settleExpired(w.now)).toBe(1);
		const request = w.runtime.multiMention.get(created.requestId)!;
		expect(request.status).toBe("timeout");
		const responses = w.runtime.multiMention.listResponses(created.requestId);
		expect(responses).toHaveLength(2);
		expect(responses.every((response) => response.status === "timeout")).toBe(true);
		expect(w.runtime.multiMention.statusView(created.requestId)?.allFailed).toBe(true);
		expect(w.runtime.messages.get(request.aggregateMessageId!)?.extra?.multiMention?.status).toBe("timeout");
		expect(w.runtime.multiMention.getCallback(created.requestId)?.status).toBe("queued");
	});

	it("recover fails a pending callback when callbackTo is disabled", () => {
		const w = makeWorld();
		const created = w.runtime.multiMention.createRequest({
			requestId: "mm-cb-fail",
			threadId: "t1",
			userId: "u1",
			initiatorAgentId: "a1",
			initiatorTurnExecutionId: "te-caller",
			callbackToAgentId: "a3",
			question: "callback failure",
			targetAgentIds: ["a1", "a2"],
			timeoutMinutes: 8,
			sourceRecordId: "src-cb-fail",
			now: 1000,
		});
		expect(created.outcome).toBe("created");
		w.runtime.multiMention.setStatus("mm-cb-fail", "running", 1000);
		w.runtime.multiMention.setStatus("mm-cb-fail", "done", 1001);
		const aggregate = w.runtime.messages.append({
			id: "agg-cb-fail",
			threadId: "t1",
			from: { kind: "system", service: "multi_mention" },
			content: "aggregate",
			now: 1002,
		});
		w.runtime.multiMention.createCallback({
			requestId: "mm-cb-fail",
			threadId: "t1",
			callbackToAgentId: "a3",
			aggregateMessageId: aggregate.id,
			callbackDepth: 1,
			now: 1003,
		});
		const disabledCatalog: AgentCatalog = {
			version: 1,
			agents: [agentConfig("a1"), agentConfig("a2"), agentConfig("a3", { enabled: false })],
		};
		const disabledRegistry = buildRegistry(disabledCatalog, [ACCOUNT]);
		const orchestrator = new MultiMentionOrchestrator({
			db: w.fd.db,
			registry: disabledRegistry,
			threads: w.runtime.threads,
			messages: w.runtime.messages,
			queue: w.runtime.queue,
			credentials: w.runtime.credentials,
			attempts: w.runtime.attempts,
			turns: w.runtime.turns,
			store: w.runtime.multiMention,
			clock: () => w.now,
		});
		const recovered = orchestrator.recover(1004);
		expect(recovered.callbacksDelivered).toBe(1);
		expect(w.runtime.multiMention.getCallback("mm-cb-fail")?.status).toBe("failed");
		expect(
			w.runtime.messages
				.getByThread("t1", 50)
				.some((message) => message.content.includes("multi_mention_callback_failed")),
		).toBe(true);
	});

	it("expires a group without losing a completed child whose response is still processing", () => {
		const w = makeWorld();
		const request = w.runtime.multiMention.createRequest({
			requestId: "mm-backfill",
			threadId: "t1",
			userId: "u1",
			initiatorAgentId: "a1",
			initiatorTurnExecutionId: "te-caller",
			callbackToAgentId: "a1",
			question: "backfill",
			targetAgentIds: ["a2", "a3"],
			timeoutMinutes: 3,
			parentInvocationId: "inv-mm",
			sourceRecordId: "src-mm",
			now: 1000,
		});
		expect(request.outcome).toBe("created");
		w.runtime.multiMention.setStatus("mm-backfill", "running", 1000);
		w.runtime.records.create({
			invocationId: "inv-mm",
			threadId: "t1",
			userId: "u1",
			sourceRecordId: "src-mm",
			userMessageId: null,
			targetAgentIds: ["a2", "a3"],
			now: 1000,
		});
		for (const agentId of ["a2", "a3"]) {
			const session = w.runtime.sessions.ensureActive({
				threadId: "t1",
				agentId,
				userId: "u1",
				workingDirectory: "/p",
				now: 1000,
			});
			const turnExecutionId = `te-${agentId}`;
			const responseMessageId = `resp:${turnExecutionId}`;
			w.runtime.turns.createRunning({
				turnExecutionId,
				parentInvocationId: "inv-mm",
				threadId: "t1",
				userId: "u1",
				agentId,
				executionKind: "ordinary",
				causal: { triggerMessageId: "m-mm" },
				startedAt: 1000,
			});
			w.runtime.turns.transitionTerminal(turnExecutionId, { status: "completed", endedAt: 1001 });
			w.runtime.messages.append({
				id: responseMessageId,
				threadId: "t1",
				from: { kind: "agent", agentId },
				content: `${agentId} partial`,
				lifecycle: {
					kind: "response",
					parentInvocationId: "inv-mm",
					turnExecutionId,
					target: { kind: "agent", id: agentId },
					status: "processing",
					startedAt: 1001,
				},
				now: 1001,
			});
			const attemptId = `att-${agentId}`;
			w.runtime.attempts.appendQueued({
				attemptId,
				parentInvocationId: "inv-mm",
				queueEntryId: "q-mm",
				threadId: "t1",
				targetAgentId: agentId,
				attempt: 1,
				now: 1000,
			});
			w.runtime.attempts.markStarting(attemptId, { agentSessionId: session.id, now: 1000 });
			w.runtime.attempts.bindAppended(attemptId, {
				turnExecutionId,
				agentSessionId: session.id,
				workerId: null,
				provider: "pi",
				model: "m1",
				modelFamily: null,
				responseMessageId,
				now: 1000,
			});
		}
		w.advance(3 * 60_000);
		expect(w.runtime.multiMentionOrchestrator.settleExpired(w.now)).toBe(1);
		const settled = w.runtime.multiMention.get("mm-backfill")!;
		expect(settled.status).toBe("done");
		const responses = w.runtime.multiMention.listResponses("mm-backfill");
		expect(responses.every((response) => response.status === "received")).toBe(true);
		expect(responses.every((response) => response.responseState === "pending")).toBe(true);
		expect(w.runtime.multiMention.statusView("mm-backfill")?.allFailed).toBe(false);
		expect(w.runtime.multiMention.markResponseTerminalByMessage("resp:te-a2")).toBe(true);
		expect(w.runtime.multiMention.getResponse("mm-backfill", "a2")?.responseState).toBe("terminal");
		expect(w.runtime.multiMention.getResponse("mm-backfill", "a3")?.responseState).toBe("pending");
	});

	it("rolls back create when the queue cap rejects admission", () => {
		const w = makeWorld();
		for (let index = 0; index < QUEUE_CAP_PER_KIND; index += 1) {
			const enqueued = w.runtime.queue.enqueue(
				{
					threadId: "t1",
					sourceRecordId: `src-cap-${index}`,
					messageId: null,
					owner: { kind: "system", service: "multi_mention" },
					kind: "message_wake",
					from: { kind: "system", service: "multi_mention" },
					content: "fill",
					targets: [{ kind: "agent", id: "a2" }],
				},
				1000 + index,
			);
			expect(enqueued.outcome).toBe("enqueued");
		}
		const requestsBefore = w.fd.db.prepare("SELECT COUNT(*) AS count FROM multi_mention_requests").get() as {
			count: number;
		};
		const messagesBefore = w.runtime.messages.getByThread("t1", 100).length;
		try {
			w.runtime.multiMentionOrchestrator.create(ctx({ piExtToolCallId: "mm-queue-full" }), multiMentionInput());
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "queue_full");
		}
		expect(
			(w.fd.db.prepare("SELECT COUNT(*) AS count FROM multi_mention_requests").get() as { count: number }).count,
		).toBe(requestsBefore.count);
		expect(w.runtime.messages.getByThread("t1", 100)).toHaveLength(messagesBefore);
	});
});
