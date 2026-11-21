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

function agentConfig(): AgentConfig {
	return {
		id: "a1",
		mentionPatterns: ["@a1"],
		displayName: "Agent A1",
		contextWindow: 128_000,
		roleId: "worker",
		roleDescription: "events test",
		restrictions: [],
		strengths: [],
		accountRef: "main",
		defaultModel: "m1",
		sessionChain: true,
		enabled: true,
	};
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string): Promise<string> {
	const decoder = new TextDecoder();
	let buffer = "";
	const deadline = Date.now() + 5_000;
	while (!buffer.includes(marker)) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${marker}`);
		const { value, done } = await reader.read();
		if (done) throw new Error(`stream ended before ${marker}`);
		buffer += decoder.decode(value, { stream: true });
	}
	return buffer;
}

describe("F016c-M2 S1 SSE invalidation", () => {
	let root: string;
	let dataDir: string;
	let installationRoot: string;
	let projectDir: string;
	let daemon: DaemonHandle | null;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "f016c-m2-events-"));
		dataDir = join(root, "data");
		installationRoot = join(root, "install");
		projectDir = join(root, "project");
		mkdirSync(installationRoot);
		mkdirSync(projectDir);
		initOperatorCredential({ dataDir });
		const catalog: AgentCatalog = { version: 1, agents: [agentConfig()] };
		writeFileSync(join(dataDir, "agent-catalog.json"), JSON.stringify(catalog));
		writeFileSync(join(dataDir, "accounts.json"), JSON.stringify([ACCOUNT]));
		daemon = null;
	});

	afterEach(async () => {
		await daemon?.stop();
		daemon = null;
		rmSync(root, { recursive: true, force: true });
	});

	async function start(eventHeartbeatMs = 15_000): Promise<string> {
		daemon = await startDaemon({
			installationRoot,
			dataDir,
			runningRevision: "f016c-m2-s1",
			controlPlane: false,
			hubOrigin: HUB_ORIGIN,
			eventHeartbeatMs,
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

	async function createThread(base: string, auth: { cookie: string; csrfToken: string }): Promise<string> {
		const response = await fetch(`${base}/api/threads`, {
			method: "POST",
			headers: {
				cookie: auth.cookie,
				"x-csrf-token": auth.csrfToken,
				origin: HUB_ORIGIN,
				"content-type": "application/json",
			},
			body: JSON.stringify({ projectPath: projectDir, idempotencyKey: "events-thread" }),
		});
		expect(response.status).toBe(201);
		return ((await response.json()) as { id: string }).id;
	}

	it("opens an authenticated stream and invalidates on a committed message", async () => {
		const base = await start();
		const auth = await login(base);
		const threadId = await createThread(base, auth);
		const response = await fetch(`${base}/api/events?threadId=${encodeURIComponent(threadId)}`, {
			headers: { cookie: auth.cookie },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const reader = response.body!.getReader();
		try {
			expect(await readUntil(reader, "event: ready")).toContain(threadId);

			const post = await fetch(`${base}/api/messages`, {
				method: "POST",
				headers: {
					cookie: auth.cookie,
					"x-csrf-token": auth.csrfToken,
					origin: HUB_ORIGIN,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					threadId,
					content: "event please",
					idempotencyKey: "event-message",
					targets: ["a1"],
				}),
			});
			expect(post.status).toBe(202);

			const change = await readUntil(reader, "event: change");
			expect(change).toContain('"topics":["messages","queue","thread"]');
		} finally {
			await reader.cancel();
		}
	});

	it("sends heartbeat comments and rejects missing/foreign threads", async () => {
		const base = await start(100);
		const auth = await login(base);
		const threadId = await createThread(base, auth);
		const response = await fetch(`${base}/api/events?threadId=${encodeURIComponent(threadId)}`, {
			headers: { cookie: auth.cookie },
		});
		const reader = response.body!.getReader();
		try {
			expect(await readUntil(reader, ": ping")).toContain(": ping");
		} finally {
			await reader.cancel();
		}

		expect((await fetch(`${base}/api/events?threadId=${encodeURIComponent(threadId)}`)).status).toBe(401);
		daemon!.a2aControlPlane!.runtime.threads.create({
			id: "thread:foreign",
			projectPath: projectDir,
			createdBy: "operator:other",
			now: Date.now(),
		});
		const foreign = await fetch(`${base}/api/events?threadId=thread%3Aforeign`, {
			headers: { cookie: auth.cookie },
		});
		expect(foreign.status).toBe(403);
		const missing = await fetch(`${base}/api/events?threadId=thread%3Amissing`, {
			headers: { cookie: auth.cookie },
		});
		expect(missing.status).toBe(404);
	});
});
