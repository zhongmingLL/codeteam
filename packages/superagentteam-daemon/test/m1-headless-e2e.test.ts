import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("F016c-M1 headless end-to-end", () => {
	let root: string;
	let dataDir: string;
	let installationRoot: string;
	let daemon: DaemonHandle | null;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "f016c-m1-e2e-"));
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

	it("runs session → thread → message → queue/live → agents/config → legacy shell", async () => {
		daemon = await startDaemon({
			installationRoot,
			dataDir,
			runningRevision: "f016c-m1-e2e",
			controlPlane: false,
			hubOrigin: HUB_ORIGIN,
			a2aControlPlane: { pollIntervalMs: 3_600_000, sweepIntervalMs: 3_600_000 },
		});
		daemon.markReady();
		const base = new URL(daemon.healthUrl).origin;

		const token = createConsoleToken({ dataDir, ttlMs: 60_000 });
		const exchange = await fetch(`${base}/auth/console?token=${encodeURIComponent(token.token)}`, {
			redirect: "manual",
		});
		const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
		const sessionResponse = await fetch(`${base}/api/session`, { headers: { cookie } });
		expect(sessionResponse.status).toBe(200);
		const session = (await sessionResponse.json()) as { userId: string; csrfToken: string };
		expect(session.userId).toMatch(/^operator:/);
		const headers = {
			cookie,
			"x-csrf-token": session.csrfToken,
			origin: HUB_ORIGIN,
			"content-type": "application/json",
		};

		const created = await fetch(`${base}/api/threads`, {
			method: "POST",
			headers,
			body: JSON.stringify({ projectPath: "/tmp/m1-e2e-project", title: "E2E", idempotencyKey: "thread-e2e" }),
		});
		expect(created.status).toBe(201);
		const thread = (await created.json()) as { id: string; createdBy: string };
		expect(thread.createdBy).toBe(session.userId);

		const posted = await fetch(`${base}/api/messages`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				threadId: thread.id,
				content: "hello @a1",
				idempotencyKey: "message-e2e",
				targets: ["a1"],
			}),
		});
		expect(posted.status).toBe(202);
		const admission = (await posted.json()) as { status: string; userMessageId: string; entryId: string };
		expect(admission.status).toBe("queued");

		const messages = await fetch(`${base}/api/messages?threadId=${encodeURIComponent(thread.id)}`, {
			headers: { cookie },
		});
		const messageBody = (await messages.json()) as {
			messages: Array<{ id: string; content: string; type: string }>;
			hasMore: boolean;
		};
		expect(messageBody.hasMore).toBe(false);
		expect(messageBody.messages).toEqual([
			expect.objectContaining({ id: admission.userMessageId, content: "hello @a1", type: "user" }),
		]);

		const queue = await fetch(`${base}/api/threads/${encodeURIComponent(thread.id)}/queue`, {
			headers: { cookie },
		});
		const queueBody = (await queue.json()) as {
			queue: Array<{ queueEntryId: string; sourceRecordId: string; targetAgentIds: string[] }>;
			activeInvocations: unknown[];
		};
		expect(queueBody.queue).toEqual([
			expect.objectContaining({
				queueEntryId: admission.entryId,
				sourceRecordId: admission.userMessageId,
				targetAgentIds: ["a1"],
			}),
		]);
		expect(queueBody.activeInvocations).toEqual([]);

		const live = await fetch(`${base}/api/threads/${encodeURIComponent(thread.id)}/live`, {
			headers: { cookie },
		});
		expect(await live.json()).toEqual({ threadId: thread.id, invocations: [] });

		const agents = await fetch(`${base}/api/agents`, { headers: { cookie } });
		expect(((await agents.json()) as { agents: unknown[] }).agents).toHaveLength(1);
		const cats = await fetch(`${base}/api/cats`, { headers: { cookie } });
		const catsBody = (await cats.json()) as { cats: Array<{ id: string; catId: string }> };
		expect(catsBody.cats[0]).toMatchObject({ id: "a1", catId: "a1" });
		const config = await fetch(`${base}/api/config`, { headers: { cookie } });
		expect(await config.json()).toEqual({ config: { ui: { bubbleDefaults: {} } } });

		const backlog = await fetch(`${base}/api/backlog/items`, { headers: { cookie } });
		expect(await backlog.json()).toEqual({ items: [], disabled: true });

		expect(existsSync(join(dataDir, "control.db"))).toBe(false);
	});
});
