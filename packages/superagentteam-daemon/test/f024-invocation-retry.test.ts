import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, AgentCatalog, AgentConfig } from "@superagentteam/shared/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConsoleToken } from "../src/api/console-link.ts";
import { initOperatorCredential } from "../src/auth/operator.ts";
import { ThreadStore } from "../src/domains/thread/store.ts";
import { type DaemonHandle, startDaemon } from "../src/index.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";

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

describe("F024 failed-invocation retry API", () => {
	let root: string;
	let dataDir: string;
	let installationRoot: string;
	let projectA: string;
	let projectB: string;
	let daemon: DaemonHandle | null;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "f024-retry-"));
		dataDir = join(root, "data");
		installationRoot = join(root, "install");
		projectA = join(root, "project-a");
		projectB = join(root, "project-b");
		mkdirSync(installationRoot);
		mkdirSync(projectA);
		mkdirSync(projectB);
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
			runningRevision: "f024",
			controlPlane: false,
			hubOrigin: HUB_ORIGIN,
			a2aControlPlane: { pollIntervalMs: 3_600_000, sweepIntervalMs: 3_600_000 },
		});
		daemon.markReady();
		return new URL(daemon.healthUrl).origin;
	}

	async function login(base: string): Promise<{ cookie: string; csrfToken: string }> {
		const created = createConsoleToken({ dataDir, ttlMs: 60_000 });
		const exchange = await fetch(`${base}/auth/console?token=${encodeURIComponent(created.token)}`, {
			redirect: "manual",
		});
		const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
		const session = await fetch(`${base}/api/session`, { headers: { cookie } });
		const body = (await session.json()) as { csrfToken: string };
		return { cookie, csrfToken: body.csrfToken };
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
		projectPath: string,
		key: string,
	) {
		const response = await fetch(`${base}/api/threads`, {
			method: "POST",
			headers: writeHeaders(auth),
			body: JSON.stringify({ projectPath, idempotencyKey: key }),
		});
		expect(response.status).toBe(201);
		return (await response.json()) as { id: string; createdBy: string };
	}

	function seedFailedInvocation(threadId: string, userId: string, agentId = "a1") {
		const runtime = daemon!.a2aControlPlane!.runtime;
		const now = Date.now();
		const submitted = runtime.ingress.submit({
			threadId,
			userId,
			body: "seed retry",
			targetAgentIds: [agentId],
			now,
		});
		const invocationId = `inv:${threadId}:${submitted.message.id}`;
		const created = runtime.records.create({
			invocationId,
			threadId,
			userId,
			sourceRecordId: submitted.message.id,
			userMessageId: submitted.message.id,
			targetAgentIds: [agentId],
			now: now + 1,
		});
		if (created.outcome !== "created") throw new Error(`seed create: ${created.outcome}`);
		runtime.records.markRunning(invocationId, now + 2);
		runtime.records.setTerminal(invocationId, "failed", "seed_failed", now + 3);
		const attemptId = `att:${invocationId}:${agentId}:1`;
		runtime.attempts.appendQueued({
			attemptId,
			parentInvocationId: invocationId,
			queueEntryId: submitted.queueEntry.queueEntryId,
			threadId,
			targetAgentId: agentId,
			attempt: 1,
			now: now + 4,
		});
		const responseMessageId = `resp:seed:${now}`;
		runtime.messages.append({
			id: responseMessageId,
			threadId,
			from: { kind: "agent", agentId },
			content: "",
			lifecycle: {
				kind: "response",
				parentInvocationId: invocationId,
				turnExecutionId: `te:seed:${now}`,
				target: { kind: "agent", id: agentId },
				status: "failed",
				startedAt: now,
				endedAt: now + 5,
			},
			now: now + 5,
		});
		daemon!
			.a2aControlPlane!.database.db.prepare(
				"UPDATE invocation_attempts SET delivery_state = 'failed', settlement = 'settled', terminal_reason = 'seed_failed', ended_at = ?, response_message_id = ? WHERE attempt_id = ?",
			)
			.run(now + 5, responseMessageId, attemptId);
		return { invocationId, queueEntryId: submitted.queueEntry.queueEntryId };
	}

	async function retry(
		base: string,
		auth: { cookie: string; csrfToken: string },
		threadId: string,
		invocationId: string,
	): Promise<Response> {
		return fetch(
			`${base}/api/threads/${encodeURIComponent(threadId)}/invocations/${encodeURIComponent(invocationId)}/retry`,
			{ method: "POST", headers: writeHeaders(auth), body: "{}" },
		);
	}

	it("retries failed targets through the same invocation and queue entry", async () => {
		const base = await start();
		const auth = await login(base);
		const thread = await createThread(base, auth, projectA, "retry-thread");
		const seeded = seedFailedInvocation(thread.id, thread.createdBy);

		const response = await retry(base, auth, thread.id, seeded.invocationId);
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ status: "retrying", retriedAgentIds: ["a1"] });

		const record = daemon!.a2aControlPlane!.runtime.records.get(seeded.invocationId);
		expect(record?.status).toBe("queued");
		expect(record?.retryCount).toBe(1);
		const entry = daemon!.a2aControlPlane!.runtime.queue.get(thread.id, seeded.queueEntryId);
		expect(entry?.status).toBe("queued");
		expect(entry?.targets).toEqual([{ kind: "agent", id: "a1" }]);
	});

	it("returns typed 409 for non-retryable and nothing-to-retry states", async () => {
		const base = await start();
		const auth = await login(base);
		const thread = await createThread(base, auth, projectA, "retry-409");
		const seeded = seedFailedInvocation(thread.id, thread.createdBy);

		expect((await retry(base, auth, thread.id, seeded.invocationId)).status).toBe(202);
		const second = await retry(base, auth, thread.id, seeded.invocationId);
		expect(second.status).toBe(409);
		expect(((await second.json()) as { error: string }).error).toBe("not_retryable");

		const runtime = daemon!.a2aControlPlane!.runtime;
		const now = Date.now();
		const submitted = runtime.ingress.submit({
			threadId: thread.id,
			userId: thread.createdBy,
			body: "no eligible attempt",
			targetAgentIds: ["a1"],
			now,
		});
		const invocationId = `inv:${thread.id}:${submitted.message.id}`;
		runtime.records.create({
			invocationId,
			threadId: thread.id,
			userId: thread.createdBy,
			sourceRecordId: submitted.message.id,
			userMessageId: submitted.message.id,
			targetAgentIds: ["a1"],
			now: now + 1,
		});
		runtime.records.markRunning(invocationId, now + 2);
		runtime.records.setTerminal(invocationId, "failed", "seed_no_attempt", now + 3);
		const nothing = await retry(base, auth, thread.id, invocationId);
		expect(nothing.status).toBe(409);
		expect(((await nothing.json()) as { error: string }).error).toBe("nothing_to_retry");
	});

	it("enforces thread/invocation ownership and CSRF", async () => {
		const foreignDb = new F018Database({ path: join(dataDir, "f018.db") });
		try {
			new ThreadStore(foreignDb.db).create({
				id: "thread:foreign",
				projectPath: projectB,
				createdBy: "operator:other",
				now: Date.now(),
			});
		} finally {
			foreignDb.close();
		}
		const base = await start();
		const auth = await login(base);
		const first = await createThread(base, auth, projectA, "retry-first");
		const second = await createThread(base, auth, projectB, "retry-second");
		const seeded = seedFailedInvocation(second.id, second.createdBy);

		const crossThread = await retry(base, auth, first.id, seeded.invocationId);
		expect(crossThread.status).toBe(404);
		expect(((await crossThread.json()) as { error: string }).error).toBe("invocation_not_found");

		const foreign = await retry(base, auth, "thread:foreign", "inv:foreign");
		expect(foreign.status).toBe(403);

		const missing = await retry(base, auth, first.id, "inv:missing");
		expect(missing.status).toBe(404);

		const noCsrf = await fetch(
			`${base}/api/threads/${encodeURIComponent(first.id)}/invocations/${encodeURIComponent(seeded.invocationId)}/retry`,
			{
				method: "POST",
				headers: { cookie: auth.cookie, origin: HUB_ORIGIN, "content-type": "application/json" },
				body: "{}",
			},
		);
		expect(noCsrf.status).toBe(403);
	});
});
