import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, AgentCatalog, AgentConfig } from "@superagentteam/shared/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initOperatorCredential } from "../src/auth/operator.ts";
import { requireOperator } from "../src/cli/context.ts";
import { runCli } from "../src/cli/index.ts";
import { MessageStore } from "../src/domains/message/store.ts";
import { QueueLedgerStore } from "../src/domains/queue/store.ts";
import { ThreadStore } from "../src/domains/thread/store.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";

const dirs: string[] = [];
const ACCOUNT: AccountConfig = { ref: "main", provider: "pi", apiKeyRef: "KEY", models: ["m1"] };

function agentConfig(id: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
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
		...overrides,
	};
}

function makeDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "f018-r5c-"));
	dirs.push(dir);
	initOperatorCredential({ dataDir: dir });
	const catalog: AgentCatalog = {
		version: 1,
		agents: [agentConfig("a1"), agentConfig("a2", { enabled: false })],
	};
	writeFileSync(join(dir, "agent-catalog.json"), JSON.stringify(catalog));
	writeFileSync(join(dir, "accounts.json"), JSON.stringify([ACCOUNT]));
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("F018 R5-c v1 thread CLI", () => {
	it("creates, posts, shows, lists, and tails through f018.db without opening control.db", async () => {
		const dataDir = makeDataDir();
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const operator = requireOperator({ dataDir });

		await runCli(["thread", "create", "--id", "t1", "--project-path", "/p", "--title", "T", "--data-dir", dataDir]);
		await runCli(["thread", "post", "t1", "hello @a1", "--data-dir", dataDir]);
		await runCli(["thread", "post", "t1", "explicit", "--to", "a1", "--data-dir", dataDir]);
		await runCli(["thread", "show", "t1", "--json", "--data-dir", dataDir]);
		await runCli(["thread", "tail", "t1", "--json", "--data-dir", dataDir]);
		await runCli(["thread", "list", "--json", "--data-dir", dataDir]);
		stdout.mockRestore();

		expect(existsSync(join(dataDir, "control.db"))).toBe(false);
		const fd = new F018Database({ path: join(dataDir, "f018.db") });
		try {
			const threads = new ThreadStore(fd.db);
			const messages = new MessageStore(fd.db);
			const queue = new QueueLedgerStore(fd.db);
			const thread = threads.get("t1")!;
			expect(thread.createdBy).toBe(operator.id);
			expect(thread.title).toBe("T");
			expect(thread.projectPath).toBe("/p");
			const rows = messages.getByThread("t1", 20);
			expect(rows.map((message) => message.content)).toEqual(["hello @a1", "explicit"]);
			expect(rows.every((message) => message.extra?.targetAgentIds?.[0] === "a1")).toBe(true);
			const queued = queue.listQueued("t1");
			expect(queued).toHaveLength(2);
			expect(queued.every((entry) => entry.targets[0]?.id === "a1")).toBe(true);
		} finally {
			fd.close();
		}
	});

	it("rejects unknown or disabled explicit targets before admission", async () => {
		const dataDir = makeDataDir();
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await runCli(["thread", "create", "--id", "t1", "--project-path", "/p", "--data-dir", dataDir]);
		await expect(runCli(["thread", "post", "t1", "bad target", "--to", "a2", "--data-dir", dataDir])).rejects.toThrow(
			/agent_disabled/,
		);
		await expect(
			runCli(["thread", "post", "t1", "bad target", "--to", "nobody", "--data-dir", dataDir]),
		).rejects.toThrow(/agent_not_found/);
		const fd = new F018Database({ path: join(dataDir, "f018.db") });
		try {
			expect(new QueueLedgerStore(fd.db).listQueued("t1")).toHaveLength(0);
			expect(new MessageStore(fd.db).getByThread("t1", 10)).toHaveLength(0);
		} finally {
			fd.close();
		}
	});
});
