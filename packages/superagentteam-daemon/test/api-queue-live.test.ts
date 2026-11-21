import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, AgentCatalog, AgentConfig } from "@superagentteam/shared/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConsoleToken } from "../src/api/console-link.ts";
import { initOperatorCredential } from "../src/auth/operator.ts";
import { type DaemonHandle, startDaemon } from "../src/index.ts";

const HUB_ORIGIN = "http://localhost:3000";
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

describe("F016c-M1 S4 queue and live API", () => {
	let root: string;
	let dataDir: string;
	let installationRoot: string;
	let daemon: DaemonHandle | null;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "f016c-s4-queue-"));
		dataDir = join(root, "data");
		installationRoot = join(root, "install");
		mkdirSync(installationRoot);
		initOperatorCredential({ dataDir });
		const catalog: AgentCatalog = { version: 1, agents: [agentConfig("a1")] };
		writeFileSync(join(dataDir, "agent-catalog.json"), JSON.stringify(catalog));
		writeFileSync(join(dataDir, "accounts.json"), JSON.stringify([ACCOUNT]));
		daemon = null;
	});

	afterEach(async () => {
		await daemon?.stop();
		daemon = null;
		rmSync(root, { recursive: true, force: true });
	});

	async function start(): Promise<string> {
		daemon = await startDaemon({
			installationRoot,
			dataDir,
			runningRevision: "f016c-s4",
			controlPlane: false,
			hubOrigin: HUB_ORIGIN,
			a2aControlPlane: { pollIntervalMs: 3_600_000, sweepIntervalMs: 3_600_000 },
		});
		daemon.markReady();
		return new URL(daemon.healthUrl).origin;
	}

	async function login(base: string): Promise<{ cookie: string; csrfToken: string; userId: string }> {
		const created = createConsoleToken({ dataDir, ttlMs: 60_000 });
		const exchange = await fetch(`${base}/auth/console?token=${encodeURIComponent(created.token)}`, {
			redirect: "manual",
		});
		const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
		const session = await fetch(`${base}/api/session`, { headers: { cookie } });
		const body = (await session.json()) as { csrfToken: string; userId: string };
		return { cookie, csrfToken: body.csrfToken, userId: body.userId };
	}

	function writeHeaders(auth: { cookie: string; csrfToken: string }): Record<string, string> {
		return {
			cookie: auth.cookie,
			"x-csrf-token": auth.csrfToken,
			origin: HUB_ORIGIN,
			"content-type": "application/json",
		};
	}

	async function createThread(
		base: string,
		auth: { cookie: string; csrfToken: string },
		idempotencyKey = "thread-1",
	): Promise<string> {
		const response = await fetch(`${base}/api/threads`, {
			method: "POST",
			headers: writeHeaders(auth),
			body: JSON.stringify({ projectPath: "/tmp/s4-project", idempotencyKey }),
		});
		expect(response.status).toBe(201);
		return ((await response.json()) as { id: string }).id;
	}

	async function postMessage(
		base: string,
		auth: { cookie: string; csrfToken: string },
		threadId: string,
		idempotencyKey: string,
	): Promise<string> {
		const response = await fetch(`${base}/api/messages`, {
			method: "POST",
			headers: writeHeaders(auth),
			body: JSON.stringify({ threadId, content: "hello", idempotencyKey, targets: ["a1"] }),
		});
		expect(response.status).toBe(202);
		return ((await response.json()) as { userMessageId: string }).userMessageId;
	}

	function seedLive(threadId: string, userId: string): void {
		const runtime = daemon!.a2aControlPlane!.runtime;
		const now = Date.now();
		runtime.records.create({
			invocationId: "inv:1",
			threadId,
			userId,
			sourceRecordId: "src:1",
			userMessageId: null,
			targetAgentIds: ["a1"],
			now,
		});
		runtime.messages.append({
			id: "msg:response-1",
			threadId,
			from: { kind: "agent", agentId: "a1" },
			content: "working",
			lifecycle: {
				kind: "response",
				parentInvocationId: "inv:1",
				turnExecutionId: "turn:1",
				target: { kind: "agent", id: "a1" },
				status: "processing",
				startedAt: now,
			},
			now,
		});
		runtime.turns.createRunning({
			turnExecutionId: "turn:1",
			parentInvocationId: "inv:1",
			threadId,
			userId,
			agentId: "a1",
			executionKind: "ordinary",
			causal: { triggerMessageId: "msg:trigger" },
			startedAt: now,
		});
		daemon!
			.a2aControlPlane!.database.db.prepare(
				`INSERT INTO invocation_attempts
				 (attempt_id, parent_invocation_id, queue_entry_id, thread_id, target_agent_id, attempt,
				  turn_execution_id, delivery_state, settlement, response_message_id, created_at, started_at)
				 VALUES ('attempt:1', 'inv:1', 'queue:seed', ?, 'a1', 1, 'turn:1', 'appended', 'streaming', 'msg:response-1', ?, ?)`,
			)
			.run(threadId, now, now);
		runtime.tracker.start(threadId, "a1", userId, "turn:1");
	}

	it("returns the durable queue and live invocation for the owner", async () => {
		const base = await start();
		const auth = await login(base);
		const threadId = await createThread(base, auth);
		const messageId = await postMessage(base, auth, threadId, "queue-1");

		const queue = await fetch(`${base}/api/threads/${encodeURIComponent(threadId)}/queue`, {
			headers: { cookie: auth.cookie },
		});
		expect(queue.status).toBe(200);
		const queueBody = (await queue.json()) as {
			threadId: string;
			cap: { perKind: number };
			queue: Array<{
				queueEntryId: string;
				sourceRecordId: string;
				status: string;
				priority: string;
				position: number;
				targetAgentIds: string[];
				claimedBy: string | null;
			}>;
			entries: unknown[];
			activeInvocations: unknown[];
		};
		expect(queueBody.threadId).toBe(threadId);
		expect(queueBody.cap.perKind).toBe(5);
		expect(queueBody.queue).toHaveLength(1);
		expect(queueBody.entries).toHaveLength(1);
		expect(queueBody.queue[0]).toMatchObject({
			sourceRecordId: messageId,
			status: "queued",
			priority: "normal",
			position: 0,
			targetAgentIds: ["a1"],
			claimedBy: null,
		});
		expect(queueBody.activeInvocations).toEqual([]);

		seedLive(threadId, auth.userId);
		const live = await fetch(`${base}/api/threads/${encodeURIComponent(threadId)}/live`, {
			headers: { cookie: auth.cookie },
		});
		expect(live.status).toBe(200);
		const liveBody = (await live.json()) as {
			invocations: Array<{
				agentId: string;
				turnExecutionId: string;
				parentInvocationId: string;
				childStatus: string;
				responseStatus: string;
				evidenceRank: string;
			}>;
		};
		expect(liveBody.invocations).toHaveLength(1);
		expect(liveBody.invocations[0]).toMatchObject({
			agentId: "a1",
			turnExecutionId: "turn:1",
			parentInvocationId: "inv:1",
			childStatus: "running",
			responseStatus: "processing",
			evidenceRank: "record+tracker",
		});

		const queueWithLive = await fetch(`${base}/api/threads/${encodeURIComponent(threadId)}/queue`, {
			headers: { cookie: auth.cookie },
		});
		expect(((await queueWithLive.json()) as { activeInvocations: unknown[] }).activeInvocations).toHaveLength(1);
	});

	it("drops tracker evidence and filters terminal responses", async () => {
		const base = await start();
		const auth = await login(base);
		const threadId = await createThread(base, auth);
		seedLive(threadId, auth.userId);
		const runtime = daemon!.a2aControlPlane!.runtime;
		expect(runtime.tracker.complete(threadId, "a1", "turn:1")).toBe(true);

		const recordOnly = await fetch(`${base}/api/threads/${encodeURIComponent(threadId)}/live`, {
			headers: { cookie: auth.cookie },
		});
		expect(
			((await recordOnly.json()) as { invocations: Array<{ evidenceRank: string }> }).invocations[0]?.evidenceRank,
		).toBe("record-only");

		runtime.messages.updateLifecycle(
			"msg:response-1",
			{
				kind: "response",
				parentInvocationId: "inv:1",
				turnExecutionId: "turn:1",
				target: { kind: "agent", id: "a1" },
				status: "completed",
				startedAt: Date.now(),
				endedAt: Date.now(),
			},
			Date.now(),
		);
		const terminal = await fetch(`${base}/api/threads/${encodeURIComponent(threadId)}/live`, {
			headers: { cookie: auth.cookie },
		});
		expect(((await terminal.json()) as { invocations: unknown[] }).invocations).toEqual([]);
	});

	it("keeps a tracker-only slot visible without inventing a durable turn", async () => {
		const base = await start();
		const auth = await login(base);
		const threadId = await createThread(base, auth);
		daemon!.a2aControlPlane!.runtime.tracker.start(threadId, "a1", auth.userId, "turn:orphan");
		const response = await fetch(`${base}/api/threads/${encodeURIComponent(threadId)}/live`, {
			headers: { cookie: auth.cookie },
		});
		const body = (await response.json()) as {
			invocations: Array<{
				turnExecutionId: string;
				parentInvocationId: string;
				evidenceRank: string;
				responseStatus: string;
			}>;
		};
		expect(body.invocations).toEqual([
			expect.objectContaining({
				turnExecutionId: "turn:orphan",
				parentInvocationId: null,
				evidenceRank: "tracker-only",
				responseStatus: "missing",
			}),
		]);
	});

	it("enforces the session and owner gate on queue and live", async () => {
		const base = await start();
		expect((await fetch(`${base}/api/threads/thread%3Ax/queue`)).status).toBe(401);
		const auth = await login(base);
		const threadId = await createThread(base, auth);
		daemon!.a2aControlPlane!.runtime.threads.create({
			id: "thread:foreign",
			projectPath: "/tmp/foreign",
			createdBy: "operator:other",
			now: Date.now(),
		});
		for (const path of ["queue", "live"]) {
			const foreign = await fetch(`${base}/api/threads/thread%3Aforeign/${path}`, {
				headers: { cookie: auth.cookie },
			});
			expect(foreign.status).toBe(403);
			const missing = await fetch(`${base}/api/threads/thread%3Amissing/${path}`, {
				headers: { cookie: auth.cookie },
			});
			expect(missing.status).toBe(404);
		}
		const ownQueue = await fetch(`${base}/api/threads/${encodeURIComponent(threadId)}/queue`, {
			headers: { cookie: auth.cookie },
		});
		expect(ownQueue.status).toBe(200);
	});
});
