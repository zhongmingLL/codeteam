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

function agentConfig(id: string, enabled = true): AgentConfig {
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
		enabled,
	};
}

describe("F016c-M1 S3 message API", () => {
	let root: string;
	let dataDir: string;
	let installationRoot: string;
	let daemon: DaemonHandle | null;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "f016c-s3-messages-"));
		dataDir = join(root, "data");
		installationRoot = join(root, "install");
		mkdirSync(installationRoot);
		initOperatorCredential({ dataDir });
		const catalog: AgentCatalog = { version: 1, agents: [agentConfig("a1"), agentConfig("a2", false)] };
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
			runningRevision: "f016c-s3",
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
		idempotencyKey = "thread-1",
	): Promise<{ id: string }> {
		const response = await fetch(`${base}/api/threads`, {
			method: "POST",
			headers: writeHeaders(auth),
			body: JSON.stringify({ projectPath: "/tmp/s3-project", idempotencyKey }),
		});
		expect(response.status).toBe(201);
		return (await response.json()) as { id: string };
	}

	async function postMessage(
		base: string,
		auth: { cookie: string; csrfToken: string },
		body: Record<string, unknown>,
	): Promise<Response> {
		return fetch(`${base}/api/messages`, {
			method: "POST",
			headers: writeHeaders(auth),
			body: JSON.stringify(body),
		});
	}

	it("requires a session and a thread id for reads", async () => {
		const base = await start();
		expect((await fetch(`${base}/api/messages?threadId=thread:x`)).status).toBe(401);
		const auth = await login(base);
		expect((await fetch(`${base}/api/messages`, { headers: { cookie: auth.cookie } })).status).toBe(400);
	});

	it("admits a message, returns the queue receipt, and projects MessageView without seq", async () => {
		const base = await start();
		const auth = await login(base);
		const thread = await createThread(base, auth);
		const empty = await fetch(`${base}/api/messages?threadId=${encodeURIComponent(thread.id)}`, {
			headers: { cookie: auth.cookie },
		});
		expect(await empty.json()).toEqual({ messages: [], hasMore: false });
		const response = await postMessage(base, auth, {
			threadId: thread.id,
			content: "hello @a1",
			idempotencyKey: "msg-1",
			targets: ["a1"],
		});
		expect(response.status).toBe(202);
		const admission = (await response.json()) as {
			status: string;
			userMessageId: string;
			entryId: string;
			queuePosition: number;
			merged: boolean;
			targetAgentIds: string[];
		};
		expect(admission.status).toBe("queued");
		expect(admission.userMessageId).toMatch(/^msg:[0-9a-f]{32}$/);
		expect(admission.entryId).toMatch(/^queue:/);
		expect(admission.queuePosition).toBe(0);
		expect(admission.merged).toBe(false);
		expect(admission.targetAgentIds).toEqual(["a1"]);

		const list = await fetch(`${base}/api/messages?threadId=${encodeURIComponent(thread.id)}`, {
			headers: { cookie: auth.cookie },
		});
		expect(list.status).toBe(200);
		const body = (await list.json()) as { messages: Array<Record<string, unknown>>; hasMore: boolean };
		expect(body.hasMore).toBe(false);
		expect(body.messages).toHaveLength(1);
		expect(body.messages[0]).toMatchObject({
			id: admission.userMessageId,
			threadId: thread.id,
			type: "user",
			content: "hello @a1",
			from: { kind: "user" },
		});
		expect(body.messages[0]).not.toHaveProperty("seq");
	});

	it("replays the same idempotency key and conflicts on a changed payload", async () => {
		const base = await start();
		const auth = await login(base);
		const thread = await createThread(base, auth);
		const first = await postMessage(base, auth, {
			threadId: thread.id,
			content: "same",
			idempotencyKey: "replay-1",
			targets: ["a1"],
		});
		const firstBody = (await first.json()) as { userMessageId: string };
		const replay = await postMessage(base, auth, {
			threadId: thread.id,
			content: "same",
			idempotencyKey: "replay-1",
			targets: ["a1"],
		});
		expect(replay.status).toBe(202);
		expect(((await replay.json()) as { userMessageId: string }).userMessageId).toBe(firstBody.userMessageId);
		const conflict = await postMessage(base, auth, {
			threadId: thread.id,
			content: "changed",
			idempotencyKey: "replay-1",
			targets: ["a1"],
		});
		expect(conflict.status).toBe(409);
		expect(((await conflict.json()) as { error: string }).error).toBe("idempotency_conflict");
	});

	it("paginates with a timestamp:id cursor and reports damaged cursors", async () => {
		const base = await start();
		const auth = await login(base);
		const thread = await createThread(base, auth);
		for (const index of [1, 2, 3]) {
			const response = await postMessage(base, auth, {
				threadId: thread.id,
				content: `message ${index}`,
				idempotencyKey: `page-${index}`,
				targets: ["a1"],
			});
			expect(response.status).toBe(202);
		}

		const firstPage = await fetch(`${base}/api/messages?threadId=${encodeURIComponent(thread.id)}&limit=2`, {
			headers: { cookie: auth.cookie },
		});
		const firstBody = (await firstPage.json()) as {
			messages: Array<{ id: string; content: string; timestamp: number }>;
			hasMore: boolean;
		};
		expect(firstBody.hasMore).toBe(true);
		expect(firstBody.messages.map((message) => message.content)).toEqual(["message 2", "message 3"]);

		const oldest = firstBody.messages[0]!;
		const before = `${oldest.timestamp}:${oldest.id}`;
		const secondPage = await fetch(
			`${base}/api/messages?threadId=${encodeURIComponent(thread.id)}&limit=2&before=${encodeURIComponent(before)}`,
			{ headers: { cookie: auth.cookie } },
		);
		const secondBody = (await secondPage.json()) as { messages: Array<{ content: string }>; hasMore: boolean };
		expect(secondBody.hasMore).toBe(false);
		expect(secondBody.messages.map((message) => message.content)).toEqual(["message 1"]);

		const damaged = await fetch(
			`${base}/api/messages?threadId=${encodeURIComponent(thread.id)}&before=not-a-cursor`,
			{ headers: { cookie: auth.cookie } },
		);
		expect(damaged.status).toBe(200);
		const damagedBody = (await damaged.json()) as { messages: unknown[]; query_warnings: string[] };
		expect(damagedBody.messages).toEqual([]);
		expect(damagedBody.query_warnings).toEqual(["invalid_cursor"]);

		const badLimit = await fetch(`${base}/api/messages?threadId=${encodeURIComponent(thread.id)}&limit=abc`, {
			headers: { cookie: auth.cookie },
		});
		expect(badLimit.status).toBe(400);
	});

	it("supports replyTo and validated rich extra", async () => {
		const base = await start();
		const auth = await login(base);
		const thread = await createThread(base, auth);
		const first = await postMessage(base, auth, {
			threadId: thread.id,
			content: "quoted",
			idempotencyKey: "quote-1",
			targets: ["a1"],
		});
		const firstBody = (await first.json()) as { userMessageId: string };
		const second = await postMessage(base, auth, {
			threadId: thread.id,
			content: "reply",
			idempotencyKey: "quote-2",
			targets: ["a1"],
			replyTo: firstBody.userMessageId,
			extra: { rich: { v: 1, blocks: [{ id: "card-1", kind: "card", v: 1 }] } },
		});
		expect(second.status).toBe(202);

		const list = await fetch(`${base}/api/messages?threadId=${encodeURIComponent(thread.id)}`, {
			headers: { cookie: auth.cookie },
		});
		const body = (await list.json()) as {
			messages: Array<{ replyTo?: string; extra?: { rich?: { v: number } } }>;
		};
		expect(body.messages[1]?.replyTo).toBe(firstBody.userMessageId);
		expect(body.messages[1]?.extra?.rich?.v).toBe(1);

		const badExtra = await postMessage(base, auth, {
			threadId: thread.id,
			content: "bad rich",
			idempotencyKey: "quote-3",
			targets: ["a1"],
			extra: { rich: { v: 2, blocks: [] } },
		});
		expect(badExtra.status).toBe(422);
		expect(((await badExtra.json()) as { error: string }).error).toBe("invalid_extra");

		const badReply = await postMessage(base, auth, {
			threadId: thread.id,
			content: "bad reply",
			idempotencyKey: "quote-4",
			targets: ["a1"],
			replyTo: "msg:missing",
		});
		expect(badReply.status).toBe(400);
	});

	it("enforces targets, CSRF, owner gate, and Hub field aliases", async () => {
		const base = await start();
		const auth = await login(base);
		const thread = await createThread(base, auth);

		const multi = await postMessage(base, auth, {
			threadId: thread.id,
			content: "multi",
			idempotencyKey: "targets-1",
			targets: ["a1", "a2"],
		});
		expect(multi.status).toBe(422);
		expect(((await multi.json()) as { error: string }).error).toBe("use_multi_mention");

		const disabled = await postMessage(base, auth, {
			threadId: thread.id,
			content: "disabled",
			idempotencyKey: "targets-2",
			targets: ["a2"],
		});
		expect(disabled.status).toBe(422);
		expect(((await disabled.json()) as { error: string }).error).toBe("agent_disabled");

		const unknown = await postMessage(base, auth, {
			threadId: thread.id,
			content: "unknown",
			idempotencyKey: "targets-3",
			targets: ["a9"],
		});
		expect(unknown.status).toBe(422);

		const noCsrf = await fetch(`${base}/api/messages`, {
			method: "POST",
			headers: { cookie: auth.cookie, origin: HUB_ORIGIN, "content-type": "application/json" },
			body: JSON.stringify({ threadId: thread.id, content: "x", idempotencyKey: "targets-4", targets: ["a1"] }),
		});
		expect(noCsrf.status).toBe(403);

		const hubAlias = await postMessage(base, auth, {
			threadId: thread.id,
			content: "hub alias",
			idempotencyKey: "targets-5",
			mentions: ["a1"],
		});
		expect(hubAlias.status).toBe(202);

		daemon!.a2aControlPlane!.runtime.threads.create({
			id: "thread:foreign",
			projectPath: "/tmp/foreign",
			createdBy: "operator:other",
			now: Date.now(),
		});
		const foreign = await postMessage(base, auth, {
			threadId: "thread:foreign",
			content: "foreign",
			idempotencyKey: "targets-6",
			targets: ["a1"],
		});
		expect(foreign.status).toBe(403);
		const foreignRead = await fetch(`${base}/api/messages?threadId=thread%3Aforeign`, {
			headers: { cookie: auth.cookie },
		});
		expect(foreignRead.status).toBe(403);
	});

	it("rejects dispatching from a legacy thread with no projectPath", async () => {
		const base = await start();
		const auth = await login(base);
		const thread = await createThread(base, auth, "thread-empty-path");
		daemon!.a2aControlPlane!.database.db.prepare("UPDATE threads SET project_path = '' WHERE id = ?").run(thread.id);
		const response = await postMessage(base, auth, {
			threadId: thread.id,
			content: "dispatch me",
			idempotencyKey: "empty-path-1",
			targets: ["a1"],
		});
		expect(response.status).toBe(422);
		expect(((await response.json()) as { error: string }).error).toBe("thread_project_path_required");
	});
});
