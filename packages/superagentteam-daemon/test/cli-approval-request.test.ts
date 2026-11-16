import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openControlStore } from "../src/index.ts";

const CLI = join(process.cwd(), "dist/cli.js");
const dirs: string[] = [];
let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "codeteam-agent-request-"));
	dirs.push(dataDir);
	const store = openControlStore({ dataDir });
	store.seedIdentity({
		eval: { provider: "test", model: "glm-5.3-flash", modelFamily: "glm" },
		compress: { provider: "test", model: "qwen3.8-flash", modelFamily: "qwen" },
	});
	const backlog = store.backlog.create({
		id: "backlog-agent-request",
		userId: "user-1",
		title: "Agent request",
		summary: "agent approval request",
		priority: "p2",
		tags: ["feature:F007"],
		createdByKind: "user",
		createdById: "user-1",
	});
	const thread = store.threads.create({ id: "thread-agent-request", backlogItemId: backlog.id });
	store.tasks.create({
		id: "task-agent-request",
		kind: "work",
		threadId: thread.id,
		title: "Agent request",
		why: "agent approval request",
		createdBy: "user-1",
		backlogItemId: backlog.id,
	});
	store.close();
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agent-side approval request", () => {
	it("writes an approval without an operator credential when --requester is an active profile", () => {
		const result = spawnSync(
			process.execPath,
			[
				CLI,
				"--data-dir",
				dataDir,
				"approval",
				"request",
				"--task",
				"task-agent-request",
				"--thread",
				"thread-agent-request",
				"--kind",
				"blocker",
				"--idempotency-key",
				"agent-request-1",
				"--requester",
				"profile:eval",
				"--json",
			],
			{ encoding: "utf8", env: { ...process.env, CODETEAM_DATA_DIR: dataDir } },
		);
		expect(result.status).toBe(0);
		const approval = JSON.parse(result.stdout.trim()) as { requestedBy: string; kind: string; resolution: string };
		expect(approval).toMatchObject({ requestedBy: "profile:eval", kind: "blocker", resolution: "open" });
	});
});
