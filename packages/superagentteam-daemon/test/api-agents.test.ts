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

describe("F016c-M1 S4 agents/cats/config API", () => {
	let root: string;
	let dataDir: string;
	let installationRoot: string;
	let daemon: DaemonHandle | null;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "f016c-s4-agents-"));
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
			runningRevision: "f016c-s4",
			controlPlane: false,
			hubOrigin: HUB_ORIGIN,
			a2aControlPlane: { pollIntervalMs: 3_600_000, sweepIntervalMs: 3_600_000 },
		});
		daemon.markReady();
		return new URL(daemon.healthUrl).origin;
	}

	async function login(base: string): Promise<{ cookie: string }> {
		const created = createConsoleToken({ dataDir, ttlMs: 60_000 });
		const exchange = await fetch(`${base}/auth/console?token=${encodeURIComponent(created.token)}`, {
			redirect: "manual",
		});
		const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
		await fetch(`${base}/api/session`, { headers: { cookie } });
		return { cookie };
	}

	it("projects canonical agents and the Hub cats alias without secrets", async () => {
		const base = await start();
		const auth = await login(base);
		const agentsResponse = await fetch(`${base}/api/agents`, { headers: { cookie: auth.cookie } });
		expect(agentsResponse.status).toBe(200);
		const agents = (await agentsResponse.json()) as {
			agents: Array<{ id: string; displayName: string; enabled: boolean; status: string; accountRef?: string }>;
		};
		expect(agents.agents).toHaveLength(2);
		expect(agents.agents[0]).toMatchObject({ id: "a1", displayName: "Agent a1", enabled: true, status: "idle" });
		expect(agents.agents[1]).toMatchObject({ id: "a2", enabled: false, status: "offline" });
		expect(agents.agents[0]).not.toHaveProperty("accountRef");

		const catsResponse = await fetch(`${base}/api/cats`, { headers: { cookie: auth.cookie } });
		expect(catsResponse.status).toBe(200);
		const cats = (await catsResponse.json()) as {
			cats: Array<{ id: string; catId: string; displayName: string; enabled: boolean; status: string }>;
		};
		expect(cats.cats).toHaveLength(2);
		expect(cats.cats[0]).toMatchObject({ id: "a1", catId: "a1", displayName: "Agent a1", enabled: true });
		expect(cats.cats[1]).toMatchObject({ id: "a2", catId: "a2", enabled: false });

		const config = await fetch(`${base}/api/config`, { headers: { cookie: auth.cookie } });
		expect(config.status).toBe(200);
		expect(await config.json()).toEqual({ config: { ui: { bubbleDefaults: {} } } });
	});

	it("reports working as a global summary when the tracker has an active slot", async () => {
		const base = await start();
		const auth = await login(base);
		daemon!.a2aControlPlane!.runtime.tracker.start("thread:probe", "a1", "operator:probe", "turn:probe");
		const response = await fetch(`${base}/api/agents`, { headers: { cookie: auth.cookie } });
		const body = (await response.json()) as { agents: Array<{ id: string; status: string }> };
		expect(body.agents.find((agent) => agent.id === "a1")?.status).toBe("working");
	});

	it("requires a session and rejects transport identity headers", async () => {
		const base = await start();
		expect((await fetch(`${base}/api/agents`)).status).toBe(401);
		const auth = await login(base);
		const identity = await fetch(`${base}/api/agents`, {
			headers: { cookie: auth.cookie, authorization: "Bearer forged" },
		});
		expect(identity.status).toBe(403);
	});
});
