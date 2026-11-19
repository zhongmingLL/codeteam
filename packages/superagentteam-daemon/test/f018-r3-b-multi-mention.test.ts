import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, AgentCatalog, AgentConfig } from "@superagentteam/shared/types";
import { afterEach, describe, expect, it } from "vitest";

import { buildA2ARuntime, type A2ARuntime } from "../src/domains/a2a/runtime.ts";
import { A2AToolError, type A2AToolContext } from "../src/domains/a2a/tool-service.ts";
import { buildRegistry } from "../src/domains/agent/registry.ts";
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

function makeWorld(): { runtime: A2ARuntime; spawn: MockSpawnPort; fd: F018Database } {
	const dir = mkdtempSync(join(tmpdir(), "f018-r3b-"));
	dirs.push(dir);
	const fd = new F018Database({ path: join(dir, "f018.db") });
	const catalog: AgentCatalog = {
		version: 1,
		agents: [agentConfig("a1"), agentConfig("a2"), agentConfig("a3")],
	};
	const registry = buildRegistry(catalog, [ACCOUNT]);
	const spawn = new MockSpawnPort();
	const runtime = buildA2ARuntime({
		db: fd.db,
		registry,
		spawn,
		clock: () => 1000,
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
		allowedTools: ["multi_mention", "post_message"],
		now: 4,
	});
	return { runtime, spawn, fd };
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

	it("fan-out runs a2/a3, T3 records received responses and participants; group waits for R3-c aggregate", async () => {
		const w = makeWorld();
		const created = w.runtime.multiMentionOrchestrator.create(ctx(), multiMentionInput());
		expect(w.runtime.multiMention.get(created.requestId)?.status).toBe("pending");
		w.spawn.scripts = [happyScript("from a2"), happyScript("from a3")];
		const drained = await w.runtime.processor.drain("t1", "u1");
		expect(drained.processed).toBe(1);
		expect(drained.convergenceFailed).toEqual([]);
		const request = w.runtime.multiMention.get(created.requestId)!;
		expect(request.status).toBe("partial");
		expect(request.parentInvocationId).toBe(`inv:t1:${created.message.id}`);
		const responses = w.runtime.multiMention.listResponses(created.requestId);
		expect(responses).toHaveLength(2);
		expect(responses.map((response) => response.targetAgentId).sort()).toEqual(["a2", "a3"]);
		expect(responses.every((response) => response.status === "received")).toBe(true);
		expect(w.runtime.multiMention.allTargetsAccounted(created.requestId)).toBe(true);
		const parent = w.runtime.records.get(`inv:t1:${created.message.id}`)!;
		expect(parent.status).toBe("completed");
		expect(w.runtime.threads.listParticipants("t1")).toEqual(expect.arrayContaining(["a2", "a3"]));
		expect(w.runtime.queue.get("t1", created.queueEntryId)).toBeNull();
		const source = w.runtime.messages.get(created.message.id)!;
		if (source.lifecycle?.kind === "input") {
			expect(source.lifecycle.dispatchRefs).toHaveLength(2);
		} else {
			throw new Error("expected input lifecycle");
		}
	});
});
