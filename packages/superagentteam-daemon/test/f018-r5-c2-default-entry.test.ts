import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, AgentCatalog, AgentConfig } from "@superagentteam/shared/types";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemon } from "../src/daemon.ts";

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

function makeDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "f018-r5c2-"));
	dirs.push(dir);
	const catalog: AgentCatalog = { version: 1, agents: [agentConfig("a1")] };
	writeFileSync(join(dir, "agent-catalog.json"), JSON.stringify(catalog));
	writeFileSync(join(dir, "accounts.json"), JSON.stringify([ACCOUNT]));
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("F018 R5-c2 default daemon entry", () => {
	it("defaults to the A2A control plane when neither option is provided", async () => {
		const dir = makeDataDir();
		const daemon = await startDaemon({
			installationRoot: dir,
			dataDir: dir,
			runningRevision: "r5c2",
		});
		try {
			daemon.markReady();
			expect(daemon.controlPlane).toBeNull();
			expect(daemon.a2aControlPlane?.ready().started).toBe(true);
			expect(existsSync(join(dir, "f018.db"))).toBe(true);
			expect(existsSync(join(dir, "control.db"))).toBe(false);
		} finally {
			await daemon.stop();
		}
	});

	it("keeps explicit legacy opt-in and health-only opt-out", async () => {
		const legacyDir = makeDataDir();
		const legacy = await startDaemon({
			installationRoot: legacyDir,
			dataDir: legacyDir,
			runningRevision: "r5c2",
			controlPlane: {},
		});
		try {
			legacy.markReady();
			expect(legacy.controlPlane?.ready().started).toBe(true);
			expect(legacy.a2aControlPlane).toBeNull();
			expect(existsSync(join(legacyDir, "control.db"))).toBe(true);
		} finally {
			await legacy.stop();
		}

		const healthDir = makeDataDir();
		const health = await startDaemon({
			installationRoot: healthDir,
			dataDir: healthDir,
			runningRevision: "r5c2",
			controlPlane: false,
		});
		try {
			health.markReady();
			expect(health.controlPlane).toBeNull();
			expect(health.a2aControlPlane).toBeNull();
		} finally {
			await health.stop();
		}
	});
});
