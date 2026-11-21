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

describe("F016c-M1 S2 thread API", () => {
	let root: string;
	let dataDir: string;
	let installationRoot: string;
	let projectA: string;
	let projectB: string;
	let projectFile: string;
	let daemon: DaemonHandle | null;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "f016c-s2-threads-"));
		dataDir = join(root, "data");
		installationRoot = join(root, "install");
		projectA = join(root, "project-a");
		projectB = join(root, "project-b");
		projectFile = join(root, "not-a-directory");
		mkdirSync(installationRoot);
		mkdirSync(projectA);
		mkdirSync(projectB);
		writeFileSync(projectFile, "not a directory");
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
			runningRevision: "f016c-s2",
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
		body: Record<string, unknown>,
	): Promise<Response> {
		return fetch(`${base}/api/threads`, {
			method: "POST",
			headers: writeHeaders(auth),
			body: JSON.stringify(body),
		});
	}

	it("requires a session for thread reads", async () => {
		const base = await start();
		const response = await fetch(`${base}/api/threads`);
		expect(response.status).toBe(401);
		expect(((await response.json()) as { relogin_hint?: string }).relogin_hint).toContain("auth console-link");
	});

	it("creates a thread, replays the same idempotency key, and conflicts on a changed payload", async () => {
		const base = await start();
		const auth = await login(base);

		const first = await createThread(base, auth, {
			projectPath: projectA,
			title: "Thread A",
			idempotencyKey: "create-a",
		});
		expect(first.status).toBe(201);
		const firstThread = (await first.json()) as { id: string; createdBy: string; participants: string[] };
		expect(firstThread.id).toMatch(/^thread:[0-9a-f]{32}$/);
		expect(firstThread.createdBy).toMatch(/^operator:/);
		expect(firstThread.participants).toEqual([]);

		const replay = await createThread(base, auth, {
			projectPath: projectA,
			title: "Thread A",
			idempotencyKey: "create-a",
		});
		expect(replay.status).toBe(200);
		expect(((await replay.json()) as { id: string }).id).toBe(firstThread.id);

		const conflict = await createThread(base, auth, {
			projectPath: projectB,
			title: "Thread A",
			idempotencyKey: "create-a",
		});
		expect(conflict.status).toBe(409);
		expect(((await conflict.json()) as { error: string }).error).toBe("idempotency_conflict");
	});

	it("rejects invalid create requests before writing", async () => {
		const base = await start();
		const auth = await login(base);

		const missingKey = await createThread(base, auth, { projectPath: projectA });
		expect(missingKey.status).toBe(400);

		const emptyPath = await createThread(base, auth, { projectPath: "  ", idempotencyKey: "k1" });
		expect(emptyPath.status).toBe(400);

		const noCsrf = await fetch(`${base}/api/threads`, {
			method: "POST",
			headers: { cookie: auth.cookie, origin: HUB_ORIGIN, "content-type": "application/json" },
			body: JSON.stringify({ projectPath: projectA, idempotencyKey: "k2" }),
		});
		expect(noCsrf.status).toBe(403);
		expect(((await noCsrf.json()) as { error: string }).error).toBe("csrf_failed");

		const badOrigin = await fetch(`${base}/api/threads`, {
			method: "POST",
			headers: { ...writeHeaders(auth), origin: "http://evil.example" },
			body: JSON.stringify({ projectPath: projectA, idempotencyKey: "k3" }),
		});
		expect(badOrigin.status).toBe(403);

		const list = await fetch(`${base}/api/threads`, { headers: { cookie: auth.cookie } });
		expect(((await list.json()) as { threads: unknown[] }).threads).toEqual([]);
	});

	it("rejects relative, missing, and non-directory project paths", async () => {
		const base = await start();
		const auth = await login(base);
		const invalidPaths = ["relative/project", join(root, "missing-project"), projectFile];

		for (const [index, projectPath] of invalidPaths.entries()) {
			const response = await createThread(base, auth, {
				projectPath,
				idempotencyKey: `invalid-path-${index}`,
			});
			expect(response.status).toBe(422);
			expect(((await response.json()) as { error: string }).error).toBe("project_path_invalid");
		}
	});

	it("accepts the classic Hub create body shape without trusting body identity", async () => {
		const base = await start();
		const auth = await login(base);
		const response = await createThread(base, auth, {
			userId: "user:forged",
			idempotencyKey: "hub-shape",
			projectPath: projectA,
			temporaryTitle: "New conversation",
		});
		expect(response.status).toBe(201);
		const thread = (await response.json()) as {
			projectPath: string;
			title: string | null;
			titleSource?: string;
			createdBy: string;
		};
		expect(thread.projectPath).toBe(projectA);
		expect(thread.title).toBe("New conversation");
		expect(thread.titleSource).toBe("system");
		expect(thread.createdBy).not.toBe("user:forged");

		const deleted = await fetch(`${base}/api/threads?deleted=true`, { headers: { cookie: auth.cookie } });
		expect(deleted.status).toBe(200);
		expect(((await deleted.json()) as { threads: unknown[] }).threads).toEqual([]);
	});

	it("treats a different title attribution as a replay conflict", async () => {
		const base = await start();
		const auth = await login(base);
		const first = await createThread(base, auth, {
			projectPath: projectA,
			title: "Same title",
			idempotencyKey: "attribution",
		});
		expect(first.status).toBe(201);
		const conflict = await createThread(base, auth, {
			projectPath: projectA,
			temporaryTitle: "Same title",
			idempotencyKey: "attribution",
		});
		expect(conflict.status).toBe(409);
	});

	it("requires a real projectPath instead of inventing a default workspace", async () => {
		const base = await start();
		const auth = await login(base);
		const response = await createThread(base, auth, {
			idempotencyKey: "no-project",
			temporaryTitle: "New conversation",
		});
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string; message: string };
		expect(body.error).toBe("invalid_input");
		expect(body.message).toContain("projectPath is required");
	});

	it("allows a headless client to write with a valid CSRF token and no Origin", async () => {
		const base = await start();
		const auth = await login(base);
		const response = await fetch(`${base}/api/threads`, {
			method: "POST",
			headers: {
				cookie: auth.cookie,
				"x-csrf-token": auth.csrfToken,
				"content-type": "application/json",
			},
			body: JSON.stringify({ projectPath: projectA, idempotencyKey: "headless-1" }),
		});
		expect(response.status).toBe(201);
	});

	it("lists only the operator's threads and enforces the owner gate on detail", async () => {
		const foreign = new F018Database({ path: join(dataDir, "f018.db") });
		try {
			new ThreadStore(foreign.db).create({
				id: "thread:foreign",
				projectPath: projectB,
				title: "Foreign",
				createdBy: "operator:other",
				now: Date.now(),
			});
		} finally {
			foreign.close();
		}

		const base = await start();
		const auth = await login(base);
		const created = await createThread(base, auth, {
			projectPath: projectA,
			title: "Own",
			idempotencyKey: "own-1",
		});
		const own = (await created.json()) as { id: string };

		const list = await fetch(`${base}/api/threads`, { headers: { cookie: auth.cookie } });
		expect(list.status).toBe(200);
		const listBody = (await list.json()) as { threads: Array<{ id: string; title: string | null }> };
		expect(listBody.threads).toHaveLength(1);
		expect(listBody.threads[0]?.id).toBe(own.id);

		const detail = await fetch(`${base}/api/threads/${encodeURIComponent(own.id)}`, {
			headers: { cookie: auth.cookie },
		});
		expect(detail.status).toBe(200);

		const foreignDetail = await fetch(`${base}/api/threads/${encodeURIComponent("thread:foreign")}`, {
			headers: { cookie: auth.cookie },
		});
		expect(foreignDetail.status).toBe(403);

		const missing = await fetch(`${base}/api/threads/thread%3Amissing`, { headers: { cookie: auth.cookie } });
		expect(missing.status).toBe(404);
	});

	it("rejects malformed list limits and transport identity headers", async () => {
		const base = await start();
		const auth = await login(base);

		const badLimit = await fetch(`${base}/api/threads?limit=abc`, { headers: { cookie: auth.cookie } });
		expect(badLimit.status).toBe(400);

		const identity = await fetch(`${base}/api/threads`, {
			headers: { cookie: auth.cookie, authorization: "Bearer forged" },
		});
		expect(identity.status).toBe(403);
	});
});
