import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, AgentCatalog, AgentConfig } from "@superagentteam/shared/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type A2ARuntime, buildA2ARuntime } from "../src/domains/a2a/runtime.ts";
import { buildRegistry } from "../src/domains/agent/registry.ts";
import type { WorkerRpcConnection, WorkerSpawnPort } from "../src/domains/worker/pool.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";
import superagentteamA2AExtension from "../src/workers/a2a-extension.ts";

const dirs: string[] = [];
const ACCOUNT: AccountConfig = { ref: "main", provider: "pi", apiKeyRef: "KEY", models: ["m1"] };
const ALLOWED = ["post_message", "cross_post_message", "multi_mention", "thread_context"];

function agentConfig(id: string): AgentConfig {
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
	};
}

class NeverSpawnPort implements WorkerSpawnPort {
	async spawn(): Promise<{
		connection: WorkerRpcConnection;
		pid: number | null;
		piSessionId: string | null;
		piSessionFile: string | null;
		spawnMs: number;
	}> {
		throw new Error("unexpected_worker_spawn");
	}
}

function makeWorld(allowedTools: string[] = ALLOWED) {
	const dir = mkdtempSync(join(tmpdir(), "f018-r5a-"));
	dirs.push(dir);
	const fd = new F018Database({ path: join(dir, "f018.db") });
	const catalog: AgentCatalog = {
		version: 1,
		agents: [agentConfig("a1"), agentConfig("a2"), agentConfig("a3")],
	};
	const registry = buildRegistry(catalog, [ACCOUNT]);
	const socketPath = join(dir, "a2a.sock");
	const runtime = buildA2ARuntime({
		db: fd.db,
		registry,
		spawn: new NeverSpawnPort(),
		clock: () => 1_000,
		processStartedAt: 1,
		controlSocketPath: socketPath,
	});
	runtime.threads.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
	runtime.threads.create({ id: "t2", projectPath: "/p2", createdBy: "u1", now: 1 });
	const session = runtime.sessions.ensureActive({
		threadId: "t1",
		agentId: "a1",
		userId: "u1",
		workingDirectory: "/p",
		now: 1,
	});
	runtime.records.create({
		invocationId: "inv1",
		threadId: "t1",
		userId: "u1",
		sourceRecordId: "src1",
		userMessageId: null,
		targetAgentIds: ["a1"],
		now: 2,
	});
	runtime.turns.createRunning({
		turnExecutionId: "te1",
		parentInvocationId: "inv1",
		threadId: "t1",
		userId: "u1",
		agentId: "a1",
		executionKind: "ordinary",
		causal: { triggerMessageId: "m1", a2aDepth: 0 },
		startedAt: 3,
	});
	const minted = runtime.credentials.create({
		turnExecutionId: "te1",
		parentInvocationId: "inv1",
		threadId: "t1",
		agentId: "a1",
		agentSessionId: session.id,
		userId: "u1",
		allowedTools,
		now: 3,
	});
	const workerId = "w1";
	runtime.workerStore.ensure({
		workerId,
		poolKey: { projectPath: "/p", accountRef: "main", provider: "pi", model: "m1" },
		now: 4,
		leaseTtlMs: 300_000,
	});
	runtime.workerStore.markOnline(workerId, 4242, 4);
	runtime.bindings.bind({ agentSessionId: session.id, workerId, now: 4 });
	return { dir, runtime, socketPath, workerId, token: minted.token };
}

function call(socketPath: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.once("connect", () => {
			socket.write(`${JSON.stringify({ id: "req-1", ...request })}\n`);
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const index = buffer.indexOf("\n");
			if (index < 0) return;
			const line = buffer.slice(0, index);
			socket.destroy();
			try {
				resolve(JSON.parse(line) as Record<string, unknown>);
			} catch (error) {
				reject(error);
			}
		});
		socket.on("error", reject);
	});
}

const runtimes: A2ARuntime[] = [];

type MockTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<{ details: Record<string, unknown> }>;
};

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.control?.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe("F018 R5-a A2A control bridge", () => {
	it("dispatches post_message and replays the same piExtToolCallId", async () => {
		const w = makeWorld();
		runtimes.push(w.runtime);
		await w.runtime.control!.start();
		const request = {
			type: "a2a_call",
			workerId: w.workerId,
			token: w.token,
			toolName: "superagentteam_post_message",
			input: { targets: [{ kind: "agent", id: "a2" }], bodyMd: "hello from the worker" },
			piExtToolCallId: "call-1",
		};
		const first = await call(w.socketPath, request);
		expect(first.ok).toBe(true);
		const result = first.result as { message: { content: string }; queueEntryId: string; replayed: boolean };
		expect(result.message.content).toBe("hello from the worker");
		expect(result.queueEntryId).toBeTruthy();
		expect(result.replayed).toBe(false);

		const replay = await call(w.socketPath, request);
		expect((replay.result as { replayed: boolean }).replayed).toBe(true);
	});

	it("dispatches cross_post_message, multi_mention, and thread_context", async () => {
		const w = makeWorld();
		runtimes.push(w.runtime);
		await w.runtime.control!.start();
		const base = { type: "a2a_call", workerId: w.workerId, token: w.token };

		const cross = await call(w.socketPath, {
			...base,
			toolName: "superagentteam_cross_post_message",
			input: { threadId: "t2", bodyMd: "cross hello" },
			piExtToolCallId: "call-cross",
		});
		expect(cross.ok).toBe(true);
		expect((cross.result as { targetThreadId: string }).targetThreadId).toBe("t2");

		const multi = await call(w.socketPath, {
			...base,
			toolName: "superagentteam_multi_mention",
			input: {
				targets: [
					{ kind: "agent", id: "a2" },
					{ kind: "agent", id: "a3" },
				],
				question: "what now?",
				callbackTo: "a1",
			},
			piExtToolCallId: "call-multi",
		});
		expect(multi.ok).toBe(true);
		expect((multi.result as { targetAgentIds: string[] }).targetAgentIds).toEqual(["a2", "a3"]);

		const context = await call(w.socketPath, {
			...base,
			toolName: "superagentteam_thread_context",
			input: { limit: 10 },
			piExtToolCallId: "call-context",
		});
		expect(context.ok).toBe(true);
		expect((context.result as { threadId: string }).threadId).toBe("t1");
	});

	it("rejects invalid tokens, wrong workers, non-running turns, and unknown tools", async () => {
		const w = makeWorld();
		runtimes.push(w.runtime);
		await w.runtime.control!.start();
		const base = {
			type: "a2a_call",
			workerId: w.workerId,
			token: w.token,
			toolName: "superagentteam_post_message",
			input: { bodyMd: "denied" },
			piExtToolCallId: "call-denied",
		};
		const badToken = await call(w.socketPath, { ...base, token: "ct1.bad.bad" });
		expect(badToken.ok).toBe(false);
		expect((badToken.error as { code: string }).code).toBe("invalid_token");

		const badWorker = await call(w.socketPath, { ...base, workerId: "w-other" });
		expect((badWorker.error as { code: string }).code).toBe("worker_mismatch");

		const unknown = await call(w.socketPath, { ...base, toolName: "superagentteam_a2a_send" });
		expect((unknown.error as { code: string }).code).toBe("unknown_tool");

		w.runtime.turns.transitionTerminal("te1", { status: "failed", endedAt: 2_000, terminalReason: "test" });
		const stopped = await call(w.socketPath, base);
		expect((stopped.error as { code: string }).code).toBe("turn_not_running");
	});

	it("enforces the credential tool allowlist before dispatch", async () => {
		const w = makeWorld(["post_message"]);
		runtimes.push(w.runtime);
		await w.runtime.control!.start();
		const denied = await call(w.socketPath, {
			type: "a2a_call",
			workerId: w.workerId,
			token: w.token,
			toolName: "superagentteam_thread_context",
			input: { limit: 5 },
			piExtToolCallId: "call-allowlist",
		});
		expect(denied.ok).toBe(false);
		expect((denied.error as { code: string }).code).toBe("tool_not_allowed");
	});

	it("registers only the four v1 tools and executes through the extension", async () => {
		const w = makeWorld();
		runtimes.push(w.runtime);
		await w.runtime.control!.start();
		vi.stubEnv("SUPERAGENTTEAM_CONTROL_SOCKET", w.socketPath);
		vi.stubEnv("SUPERAGENTTEAM_CONTROL_TOKEN", w.token);
		vi.stubEnv("SUPERAGENTTEAM_WORKER_ID", w.workerId);
		const tools = new Map<string, MockTool>();
		superagentteamA2AExtension({
			on: () => {},
			registerTool: (tool) => {
				tools.set(tool.name, tool as MockTool);
			},
		});
		expect([...tools.keys()].sort()).toEqual([
			"superagentteam_cross_post_message",
			"superagentteam_multi_mention",
			"superagentteam_post_message",
			"superagentteam_thread_context",
		]);
		const executed = await tools.get("superagentteam_post_message")!.execute("tc-1", {
			bodyMd: "extension hello",
		});
		const result = executed.details.result as { message: { content: string } };
		expect(result.message.content).toBe("extension hello");
	});
});
