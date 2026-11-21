import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, AgentCatalog, AgentConfig } from "@superagentteam/shared/types";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { A2ADaemonControlPlane } from "../src/daemon-a2a.ts";
import { buildRegistry } from "../src/domains/agent/registry.ts";
import { InvocationRecordStore, TurnExecutionStore } from "../src/domains/invocation/store.ts";
import { ThreadStore } from "../src/domains/thread/store.ts";
import type { WorkerRpcConnection, WorkerSpawnPort } from "../src/domains/worker/pool.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";
import type { RpcEvent } from "../src/workers/rpc-client.ts";

const dirs: string[] = [];
const ACCOUNT: AccountConfig = { ref: "main", provider: "pi", apiKeyRef: "KEY", models: ["m1"] };

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
	tokens: string[] = [];

	async spawn(input: {
		workerId: string;
		poolKey: { projectPath: string; accountRef: string; provider: string; model: string };
		session: unknown;
		now: number;
		credentialToken: string;
	}): Promise<{
		connection: WorkerRpcConnection;
		pid: number | null;
		piSessionId: string | null;
		piSessionFile: string | null;
		spawnMs: number;
	}> {
		this.spawns += 1;
		this.tokens.push(input.credentialToken);
		const connection = new ScriptedConnection();
		connection.script = this.scripts.shift() ?? happyScript(`reply ${this.spawns}`);
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

function makeWorld(options: { processStartedAt?: number } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "f018-r5b-"));
	dirs.push(dir);
	const fd = new F018Database({ path: join(dir, "f018.db") });
	const catalog: AgentCatalog = { version: 1, agents: [agentConfig("a1")] };
	const registry = buildRegistry(catalog, [ACCOUNT]);
	const spawn = new MockSpawnPort();
	const control = new A2ADaemonControlPlane({
		dataDir: dir,
		registry,
		database: fd,
		spawn,
		controlSocketPath: join(dir, "a2a.sock"),
		pollIntervalMs: 60_000,
		sweepIntervalMs: 60_000,
		processStartedAt: options.processStartedAt ?? 1,
		clock: () => 1_000,
	});
	return { dir, fd, registry, spawn, control };
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("F018 R5-b A2A daemon control plane", () => {
	it("starts the control channel, drains across threads, and commits responses", async () => {
		const w = makeWorld();
		await w.control.start();
		try {
			w.control.runtime.threads.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
			w.control.runtime.threads.create({ id: "t2", projectPath: "/p", createdBy: "u1", now: 1 });
			for (const threadId of ["t1", "t2"]) {
				w.control.runtime.ingress.submit({
					threadId,
					userId: "u1",
					body: `go ${threadId}`,
					now: 10,
				});
			}
			const drained = await w.control.drainNow(2);
			expect(drained?.processed).toBe(2);
			expect(w.spawn.spawns).toBe(2);
			expect(w.spawn.tokens.every((token) => token.startsWith("ct1."))).toBe(true);
			const t1Messages = w.control.runtime.messages.getByThread("t1", 20);
			const t2Messages = w.control.runtime.messages.getByThread("t2", 20);
			expect(t1Messages.some((message) => message.content === "reply 1")).toBe(true);
			expect(t2Messages.some((message) => message.content === "reply 2")).toBe(true);
			expect(w.control.runtime.queue.countQueuedAll()).toBe(0);
		} finally {
			await w.control.close();
			w.fd.close();
		}
	});

	it("runs startup recovery for a pre-process running turn", async () => {
		const w = makeWorld({ processStartedAt: 100 });
		const threads = new ThreadStore(w.fd.db);
		const records = new InvocationRecordStore(w.fd.db);
		const turns = new TurnExecutionStore(w.fd.db);
		threads.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
		records.create({
			invocationId: "inv-old",
			threadId: "t1",
			userId: "u1",
			sourceRecordId: "src-old",
			userMessageId: null,
			targetAgentIds: ["a1"],
			now: 2,
		});
		turns.createRunning({
			turnExecutionId: "te-old",
			parentInvocationId: "inv-old",
			threadId: "t1",
			userId: "u1",
			agentId: "a1",
			executionKind: "ordinary",
			causal: { triggerMessageId: "m-old" },
			startedAt: 10,
		});
		await w.control.start();
		try {
			expect(turns.get("te-old")?.status).toBe("interrupted");
			expect(turns.get("te-old")?.terminalReason).toBe("process_restart");
			expect(w.control.ready().recoveredInterruptedRuns).toBe(1);
		} finally {
			await w.control.close();
			w.fd.close();
		}
	});

	it("is opt-in through startDaemon and closes cleanly", async () => {
		const w = makeWorld();
		const daemon = await startDaemon({
			installationRoot: w.dir,
			dataDir: w.dir,
			runningRevision: "r5b",
			a2aControlPlane: {
				registry: w.registry,
				database: w.fd,
				spawn: w.spawn,
				controlSocketPath: join(w.dir, "daemon-a2a.sock"),
				pollIntervalMs: 60_000,
				sweepIntervalMs: 60_000,
				processStartedAt: 1,
				clock: () => 1_000,
			},
		});
		try {
			daemon.markReady();
			expect(daemon.a2aControlPlane?.ready().started).toBe(true);
			expect(daemon.controlPlane).toBeNull();
		} finally {
			await daemon.stop();
			w.fd.close();
		}
	});
});
