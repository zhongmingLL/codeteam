import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, AgentCatalog, AgentConfig } from "@superagentteam/shared/types";
import { afterEach, describe, expect, it } from "vitest";

import { buildA2ARuntime } from "../src/domains/a2a/runtime.ts";
import { buildRegistry } from "../src/domains/agent/registry.ts";
import { PiWorkerSpawnPort } from "../src/domains/worker/pi-spawn.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";

// F018 R3-d: opt-in live pi RPC E2E. The deterministic spawn-contract test is
// f018-r3-real-spawn.test.ts; this one proves the v1 runtime can drive the real
// coding-agent CLI through a provider. Run with:
//   SUPERAGENTTEAM_LIVE_PROVIDER=1 OPENROUTER_API_KEY=... \
//     npx vitest --run test/f018-r3-live.e2e.test.ts

const liveEnabled = process.env.SUPERAGENTTEAM_LIVE_PROVIDER === "1" && Boolean(process.env.OPENROUTER_API_KEY);
const liveModel = process.env.SUPERAGENTTEAM_LIVE_MODEL ?? "~deepseek/deepseek-flash-latest";
const REAL_CLI_PATH = join(import.meta.dirname, "..", "..", "coding-agent", "dist", "cli.js");

const dirs: string[] = [];

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
		accountRef: "live",
		defaultModel: liveModel,
		sessionChain: true,
		enabled: true,
	};
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!liveEnabled)("F018 R3-d live pi RPC E2E", () => {
	it("drives a real coding-agent worker and commits a response bubble", async () => {
		const dir = mkdtempSync(join(tmpdir(), "f018-r3d-live-"));
		dirs.push(dir);
		const projectPath = join(dir, "project");
		mkdirSync(projectPath, { recursive: true });
		const fd = new F018Database({ path: join(dir, "f018.db") });
		fd.db
			.prepare(
				"INSERT INTO threads (id, project_path, title, created_by, last_active_at, created_at, updated_at) VALUES ('t1', ?, 'Live', 'u1', 1, 1, 1)",
			)
			.run(projectPath);
		const catalog: AgentCatalog = { version: 1, agents: [agentConfig("a1")] };
		const account: AccountConfig = {
			ref: "live",
			provider: "openrouter",
			apiKeyRef: "OPENROUTER_API_KEY",
			models: [liveModel],
		};
		const runtime = buildA2ARuntime({
			db: fd.db,
			registry: buildRegistry(catalog, [account]),
			spawn: new PiWorkerSpawnPort({
				cliPath: REAL_CLI_PATH,
				sessionDir: join(dir, "sessions"),
				workerAgentDir: join(dir, "agent"),
				offline: true,
			}),
			clock: Date.now,
			processStartedAt: 1,
			promptTimeoutMs: 120_000,
		});
		const submitted = runtime.ingress.submit({
			threadId: "t1",
			userId: "u1",
			body: "Reply with exactly LIVE_R3_OK and nothing else. @a1",
			now: 10,
		});
		const drained = await runtime.processor.drain("t1", "u1");
		expect(drained.processed).toBe(1);
		const invocationId = `inv:t1:${submitted.message.id}`;
		expect(runtime.records.get(invocationId)?.status).toBe("completed");
		const attempt = runtime.attempts.getLatest(invocationId, "a1")!;
		expect(attempt.responseMessageId).toBeTruthy();
		expect(runtime.messages.get(attempt.responseMessageId!)?.content).toContain("LIVE_R3_OK");
	}, 180_000);
});
