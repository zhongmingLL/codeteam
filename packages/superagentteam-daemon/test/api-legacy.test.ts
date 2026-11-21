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

describe("F016c-M1 S5 legacy surface shells", () => {
	let root: string;
	let dataDir: string;
	let installationRoot: string;
	let daemon: DaemonHandle | null;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "f016c-s5-legacy-"));
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
			runningRevision: "f016c-s5",
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
		return { cookie: auth.cookie, "x-csrf-token": auth.csrfToken, origin: HUB_ORIGIN };
	}

	async function createThread(base: string, auth: { cookie: string; csrfToken: string }): Promise<string> {
		const response = await fetch(`${base}/api/threads`, {
			method: "POST",
			headers: { ...writeHeaders(auth), "content-type": "application/json" },
			body: JSON.stringify({ projectPath: "/tmp/s5-project", idempotencyKey: "thread-1" }),
		});
		expect(response.status).toBe(201);
		return ((await response.json()) as { id: string }).id;
	}

	it("returns honest disabled reads for the classic shell endpoints", async () => {
		const base = await start();
		const auth = await login(base);
		const threadId = await createThread(base, auth);
		const cases: Array<[string, Record<string, unknown>]> = [
			["/api/backlog/items", { items: [] }],
			["/api/approval-hub/pending", { items: [], count: 0 }],
			["/api/approval-hub/settled", { items: [], count: 0 }],
			[`/api/tasks?threadId=${encodeURIComponent(threadId)}&kind=work`, { tasks: [] }],
			["/api/labels", { labels: [] }],
			["/api/config/cat-order", { catOrder: [] }],
			["/api/config/thread-attention", { aliases: {}, open: {}, groups: [] }],
			["/api/governance/health", { status: "ok" }],
			["/api/bootcamp/threads", { threads: [] }],
			["/api/artifacts", { artifacts: [], total: 0, complete: true, workLineage: "resolved" }],
			[`/api/threads/${encodeURIComponent(threadId)}/task-progress`, { taskProgress: {} }],
			[`/api/threads/${encodeURIComponent(threadId)}/active-pane`, { active: false }],
			[`/api/threads/${encodeURIComponent(threadId)}/artifacts`, { artifacts: [], total: 0, complete: true }],
			[
				`/api/threads/${encodeURIComponent(threadId)}/artifacts?view=works`,
				{ view: "works", artifacts: [], complete: true },
			],
		];
		for (const [path, shape] of cases) {
			const response = await fetch(`${base}${path}`, { headers: { cookie: auth.cookie } });
			expect(response.status, path).toBe(200);
			const body = (await response.json()) as Record<string, unknown>;
			expect(body.disabled, path).toBe(true);
			for (const [key, value] of Object.entries(shape)) expect(body[key], `${path} ${key}`).toEqual(value);
		}

		const sop = await fetch(`${base}/api/backlog/item-1/workflow-sop`, { headers: { cookie: auth.cookie } });
		expect(sop.status).toBe(404);
		expect(((await sop.json()) as { disabled: boolean }).disabled).toBe(true);
	});

	it("gates thread-scoped legacy reads and returns 501 for every legacy write", async () => {
		const base = await start();
		expect((await fetch(`${base}/api/labels`)).status).toBe(401);
		const auth = await login(base);
		const threadId = await createThread(base, auth);
		daemon!.a2aControlPlane!.runtime.threads.create({
			id: "thread:foreign",
			projectPath: "/tmp/foreign",
			createdBy: "operator:other",
			now: Date.now(),
		});

		for (const path of [
			"/api/threads/thread%3Aforeign/artifacts",
			"/api/threads/thread%3Aforeign/task-progress",
			"/api/threads/thread%3Aforeign/active-pane",
		]) {
			const response = await fetch(`${base}${path}`, { headers: { cookie: auth.cookie } });
			expect(response.status, path).toBe(403);
		}
		const missing = await fetch(`${base}/api/threads/thread%3Amissing/artifacts`, {
			headers: { cookie: auth.cookie },
		});
		expect(missing.status).toBe(404);

		const writes: Array<[string, string]> = [
			["POST", "/api/backlog/items"],
			["POST", "/api/approvals/item-1/approve"],
			["PATCH", "/api/messages/msg%3Ax/block-state"],
			["DELETE", "/api/messages/msg%3Ax"],
			["POST", `/api/threads/${encodeURIComponent(threadId)}/queue/steer`],
			["POST", "/api/labels"],
			["POST", "/api/workspace/open"],
		];
		for (const [method, path] of writes) {
			const response = await fetch(`${base}${path}`, {
				method,
				headers: { ...writeHeaders(auth), "content-type": "application/json" },
				body: method === "DELETE" ? undefined : "{}",
			});
			expect(response.status, `${method} ${path}`).toBe(501);
			const body = (await response.json()) as { error: string; disabled: boolean };
			expect(body.error).toBe("not_implemented");
			expect(body.disabled).toBe(true);
		}

		const foreignWrite = await fetch(`${base}/api/threads/thread%3Aforeign/queue/steer`, {
			method: "POST",
			headers: { ...writeHeaders(auth), "content-type": "application/json" },
			body: "{}",
		});
		expect(foreignWrite.status).toBe(403);

		const unknown = await fetch(`${base}/api/unknown`, { headers: { cookie: auth.cookie } });
		expect(unknown.status).toBe(404);
	});

	it("never creates or reads control.db", async () => {
		const base = await start();
		const auth = await login(base);
		const threadId = await createThread(base, auth);
		await fetch(`${base}/api/tasks?threadId=${encodeURIComponent(threadId)}`, { headers: { cookie: auth.cookie } });
		await fetch(`${base}/api/backlog/items`, { headers: { cookie: auth.cookie } });
		expect(existsSync(join(dataDir, "control.db"))).toBe(false);
	});
});
