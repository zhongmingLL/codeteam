import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, AgentCatalog, AgentConfig } from "@superagentteam/shared/types";
import { afterEach, describe, expect, it } from "vitest";

import { type A2ARuntime, buildA2ARuntime } from "../src/domains/a2a/runtime.ts";
import { buildRegistry } from "../src/domains/agent/registry.ts";
import { QueueProcessor } from "../src/domains/queue/processor.ts";
import type { WorkerRpcConnection, WorkerSpawnPort } from "../src/domains/worker/pool.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";

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

/** The restart tests use the noop processor; a real spawn would be a bug. */
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

function makeDatabase(): F018Database {
	const dir = mkdtempSync(join(tmpdir(), "f018-r4d2-"));
	dirs.push(dir);
	return new F018Database({ path: join(dir, "f018.db") });
}

function makeRegistry(): ReturnType<typeof buildRegistry> {
	const catalog: AgentCatalog = {
		version: 1,
		agents: [agentConfig("a1"), agentConfig("a2"), agentConfig("a3")],
	};
	return buildRegistry(catalog, [ACCOUNT]);
}

function buildRuntime(
	fd: F018Database,
	registry: ReturnType<typeof buildRegistry>,
	options: { readonly now: number; readonly processStartedAt: number },
): A2ARuntime {
	return buildA2ARuntime({
		db: fd.db,
		registry,
		spawn: new NeverSpawnPort(),
		clock: () => options.now,
		processStartedAt: options.processStartedAt,
	});
}

function makeNoopProcessor(
	runtime: A2ARuntime,
	registry: ReturnType<typeof buildRegistry>,
	db: F018Database["db"],
	now: number,
): QueueProcessor {
	return new QueueProcessor({
		db,
		registry,
		queue: runtime.queue,
		records: runtime.records,
		turns: runtime.turns,
		attempts: runtime.attempts,
		sessions: runtime.sessions,
		credentials: runtime.credentials,
		drafts: runtime.drafts,
		messages: runtime.messages,
		threads: runtime.threads,
		tracker: runtime.tracker,
		dispatchTarget: { async dispatch() {} },
		clock: () => now,
	});
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("F018 R4-d2 E20 restart / recovery E2E", () => {
	it("restores an expired claim and delivers a pending multi_mention callback exactly once", () => {
		const fd = makeDatabase();
		const registry = makeRegistry();
		const runtimeA = buildRuntime(fd, registry, { now: 1000, processStartedAt: 1 });
		runtimeA.threads.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
		runtimeA.threads.create({ id: "t2", projectPath: "/p", createdBy: "u1", now: 1 });
		runtimeA.records.create({
			invocationId: "inv-caller",
			threadId: "t1",
			userId: "u1",
			sourceRecordId: "src-caller",
			userMessageId: null,
			targetAgentIds: ["a1"],
			now: 1,
		});
		runtimeA.turns.createRunning({
			turnExecutionId: "te-caller",
			parentInvocationId: "inv-caller",
			threadId: "t1",
			userId: "u1",
			agentId: "a1",
			executionKind: "ordinary",
			causal: { triggerMessageId: "m-caller" },
			startedAt: 2,
		});

		// A completed group whose callback was created but never delivered.
		const request = runtimeA.multiMention.createRequest({
			requestId: "mm-restart",
			threadId: "t1",
			userId: "u1",
			initiatorAgentId: "a1",
			initiatorTurnExecutionId: "te-caller",
			callbackToAgentId: "a1",
			question: "restart callback",
			targetAgentIds: ["a2", "a3"],
			timeoutMinutes: 8,
			sourceRecordId: "src-mm",
			now: 1000,
		});
		expect(request.outcome).toBe("created");
		runtimeA.multiMention.setStatus("mm-restart", "running", 1000);
		runtimeA.multiMention.setStatus("mm-restart", "done", 1001);
		runtimeA.messages.append({
			id: "agg-mm",
			threadId: "t1",
			from: { kind: "system", service: "multi_mention" },
			content: "aggregate",
			now: 1002,
		});
		runtimeA.multiMention.createCallback({
			requestId: "mm-restart",
			threadId: "t1",
			callbackToAgentId: "a1",
			aggregateMessageId: "agg-mm",
			callbackDepth: 1,
			now: 1003,
		});
		expect(runtimeA.multiMention.getCallback("mm-restart")?.status).toBe("pending");

		// An expired claim from the previous process must return to queued.
		const enqueued = runtimeA.queue.enqueue(
			{
				threadId: "t2",
				sourceRecordId: "src-claim",
				messageId: null,
				attempt: 1,
				owner: { kind: "system", service: "test" },
				kind: "message_wake",
				from: { kind: "system", service: "test" },
				content: "claim",
				targets: [{ kind: "agent", id: "a1" }],
			},
			1000,
		);
		expect(enqueued.outcome).toBe("enqueued");
		const claimEntryId = enqueued.entry!.queueEntryId;
		expect(
			runtimeA.queue.claim("t2", claimEntryId, {
				claimId: "claim-restart",
				owner: "process-a",
				ttlMs: 50,
				targetKeys: ["agent:a1"],
				now: 1000,
			}).outcome,
		).toBe("claimed");

		// Restart: a fresh runtime on the same DB, with a new process cutoff.
		const runtimeB = buildRuntime(fd, registry, { now: 3000, processStartedAt: 2000 });
		const result = runtimeB.startup.recover(3000);

		expect(result.expiredClaimsRestored).toBeGreaterThanOrEqual(1);
		expect(runtimeB.queue.get("t2", claimEntryId)?.status).toBe("queued");

		const callback = runtimeB.multiMention.getCallback("mm-restart");
		expect(callback?.status).toBe("queued");
		expect(callback?.queueEntryId).not.toBeNull();
		const callbackEntries = runtimeB.queue
			.listQueued("t1")
			.filter((entry) => entry.payload.sourceRecordId === "agg-mm");
		expect(callbackEntries).toHaveLength(1);
		expect(callbackEntries[0]!.targets.map((target) => target.id)).toEqual(["a1"]);

		// Re-running startup must not redeliver the callback or create a
		// second aggregate/terminal message.
		const again = runtimeB.startup.recover(4000);
		expect(again.expiredClaimsRestored).toBe(0);
		const callbackEntriesAgain = runtimeB.queue
			.listQueued("t1")
			.filter((entry) => entry.payload.sourceRecordId === "agg-mm");
		expect(callbackEntriesAgain).toHaveLength(1);
		expect(runtimeB.multiMention.get("mm-restart")?.status).toBe("done");
		expect(runtimeB.messages.getByThread("t1", 50).filter((message) => message.id === "agg-mm")).toHaveLength(1);
	});

	it("leaves a current-process running child untouched (startup cutoff protection)", () => {
		const fd = makeDatabase();
		const registry = makeRegistry();
		const runtimeA = buildRuntime(fd, registry, { now: 1000, processStartedAt: 1 });
		runtimeA.threads.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
		runtimeA.records.create({
			invocationId: "inv-live",
			threadId: "t1",
			userId: "u1",
			sourceRecordId: "src-live",
			userMessageId: null,
			targetAgentIds: ["a1"],
			now: 1,
		});
		runtimeA.turns.createRunning({
			turnExecutionId: "te-live",
			parentInvocationId: "inv-live",
			threadId: "t1",
			userId: "u1",
			agentId: "a1",
			executionKind: "ordinary",
			causal: { triggerMessageId: "m-live" },
			startedAt: 2000,
		});

		// processStartedAt=1500 → startup cutoff=1501; a child started at
		// 2000 belongs to THIS process and must survive the sweep.
		const runtimeB = buildRuntime(fd, registry, { now: 3000, processStartedAt: 1500 });
		const result = runtimeB.startup.recover(3000);
		expect(result.childrenInterrupted).toBe(0);
		expect(runtimeB.turns.get("te-live")?.status).toBe("running");
	});

	it("settles a response_pending turn from its draft across restart without duplicate terminal writes", async () => {
		const fd = makeDatabase();
		const registry = makeRegistry();
		const runtimeA = buildRuntime(fd, registry, { now: 1000, processStartedAt: 1 });
		runtimeA.threads.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
		const submitted = runtimeA.ingress.submit({ threadId: "t1", userId: "u1", body: "go @a1", now: 10 });

		// Phase A/B through a noop dispatch leaves the durable crash shape:
		// running child + appended attempt + processing R + live draft.
		const noop = makeNoopProcessor(runtimeA, registry, fd.db, 1000);
		await noop.drain("t1", "u1");
		const invocationId = `inv:t1:${submitted.message.id}`;
		const attempt = runtimeA.attempts.getLatest(invocationId, "a1")!;
		expect(attempt.deliveryState).toBe("appended");
		expect(attempt.settlement).toBe("streaming");
		expect(runtimeA.turns.get(attempt.turnExecutionId!)?.status).toBe("running");
		runtimeA.drafts.upsert({
			attemptId: attempt.attemptId,
			turnExecutionId: attempt.turnExecutionId!,
			parentInvocationId: invocationId,
			threadId: "t1",
			agentId: "a1",
			content: "Recovered from the durable draft.",
			toolEvents: [],
			thinking: null,
			createdAt: 1000,
			updatedAt: 1000,
		});
		const messagesBefore = runtimeA.messages.getByThread("t1", 100).length;

		const runtimeB = buildRuntime(fd, registry, { now: 3000, processStartedAt: 2000 });
		const result = runtimeB.startup.recover(3000);

		expect(result.childrenInterrupted).toBe(1);
		const restartedAttempt = runtimeB.attempts.getLatest(invocationId, "a1")!;
		expect(runtimeB.turns.get(restartedAttempt.turnExecutionId!)?.status).toBe("interrupted");
		expect(runtimeB.turns.get(restartedAttempt.turnExecutionId!)?.terminalReason).toBe("process_restart");
		expect(restartedAttempt.deliveryState).toBe("interrupted");
		expect(restartedAttempt.settlement).toBe("settled");
		const response = runtimeB.messages.get(restartedAttempt.responseMessageId!)!;
		expect(response.content).toBe("Recovered from the durable draft.");
		// T2 mirrors the canonical child status; an interrupted child keeps
		// its recovered body but the R is interrupted, not completed.
		expect(response.lifecycle?.kind === "response" ? response.lifecycle.status : null).toBe("interrupted");
		expect(runtimeB.records.get(invocationId)?.status).toBe("failed");
		expect(runtimeB.turns.listResponsePending()).toHaveLength(0);

		const parentAfterFirst = runtimeB.records.get(invocationId)!;
		const messagesAfterFirst = runtimeB.messages.getByThread("t1", 100).length;
		expect(messagesAfterFirst).toBe(messagesBefore);

		// A second startup and a reaper sweep must not rewrite terminal state
		// or append a second response/aggregate.
		const second = runtimeB.startup.recover(4000);
		expect(second.childrenInterrupted).toBe(0);
		const reaper = await runtimeB.reaper.runOnce(4000);
		expect(reaper.childrenInterrupted).toBe(0);
		const parentAfterSecond = runtimeB.records.get(invocationId)!;
		expect(parentAfterSecond.status).toBe(parentAfterFirst.status);
		expect(parentAfterSecond.endedAt).toBe(parentAfterFirst.endedAt);
		expect(runtimeB.messages.getByThread("t1", 100).length).toBe(messagesAfterFirst);
		expect(runtimeB.messages.get(restartedAttempt.responseMessageId!)?.content).toBe(
			"Recovered from the durable draft.",
		);
	});
});
