import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentExecutor, DispatchService, openControlStore } from "../src/index.ts";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const dirs: string[] = [];
let dataDir: string;

function cli(args: readonly string[]) {
	return spawnSync(process.execPath, [CLI, "--data-dir", dataDir, ...args, "--json"], {
		encoding: "utf8",
		env: { ...process.env, CODETEAM_DATA_DIR: dataDir },
	});
}

function cliJson<T>(args: readonly string[]): T {
	const result = cli(args);
	if (result.status !== 0) {
		throw new Error(`cli ${args.join(" ")} exited ${result.status}\n${result.stderr}`);
	}
	return JSON.parse(result.stdout.trim()) as T;
}

class RejectingExecutor implements AgentExecutor {
	async execute(): Promise<never> {
		throw new Error("executor must not run before task prepare");
	}
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "codeteam-producer-"));
	dirs.push(dataDir);
	cliJson(["auth", "init"]);
	cliJson(["profile", "seed"]);
	cliJson([
		"profile",
		"add",
		"--id",
		"profile:coder",
		"--role",
		"coder",
		"--display-name",
		"Coder",
		"--provider",
		"test",
		"--model",
		"model-coder",
		"--family",
		"test-family",
	]);
	cliJson([
		"profile",
		"add",
		"--id",
		"profile:reviewer",
		"--role",
		"reviewer",
		"--display-name",
		"Reviewer",
		"--provider",
		"test",
		"--model",
		"model-reviewer",
		"--family",
		"test-family",
	]);
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CLI producer and provisioning entry", () => {
	it("binds backlog dispatch and thread post to a task, and defers until task prepare", async () => {
		const backlog = cliJson<{ id: string }>([
			"backlog",
			"create",
			"--title",
			"Producer binding",
			"--summary",
			"Task binding",
			"--tag",
			"feature:F015",
			"--priority",
			"p1",
		]);
		cliJson(["backlog", "approve", backlog.id]);
		const dispatched = cliJson<{
			thread: { id: string };
			task: { id: string };
			message: { id: string; taskId: string | null };
			queueEntry: { id: string };
		}>(["backlog", "dispatch", backlog.id, "--to", "profile:coder", "--phase", "coding", "--body", "Kickoff"]);
		expect(dispatched.message.taskId).toBe(dispatched.task.id);

		const store = openControlStore({ dataDir });
		try {
			expect(store.messages.get(dispatched.message.id)?.taskId).toBe(dispatched.task.id);
			const dispatch = new DispatchService(store, new RejectingExecutor());
			const deferred = await dispatch.drain({ maxEntries: 1 });
			expect(deferred.errors[0]).toMatchObject({ code: "dispatch_not_ready" });
			expect(store.queue.get(dispatched.queueEntry.id)?.status).toBe("queued");
			await dispatch.drain({ maxEntries: 1 });
			expect(
				store.audit
					.listSubject(`queue:${dispatched.queueEntry.id}`, 20)
					.filter((entry) => entry.action === "dispatch_deferred"),
			).toHaveLength(1);
			expect(
				store.audit
					.listSubject(`queue:${dispatched.queueEntry.id}`, 20)
					.some((entry) => entry.action === "dispatch_dead_lettered"),
			).toBe(false);

			const postWithoutTask = cli(["thread", "post", dispatched.thread.id, "please work", "--to", "profile:coder"]);
			expect(postWithoutTask.status).not.toBe(0);
			expect(postWithoutTask.stderr).toContain("--task");

			const prepared = cliJson<{
				task: { id: string; worktree: string };
				sessions: Array<{ id: string; profileId: string; role: string }>;
				lease: { id: string } | null;
			}>(["task", "prepare", dispatched.task.id, "--profile", "profile:coder", "--profile", "profile:reviewer"]);
			expect(prepared.task.worktree).toBeTruthy();
			expect(prepared.sessions.map((session) => session.profileId).sort()).toEqual([
				"profile:coder",
				"profile:reviewer",
			]);
			expect(prepared.lease).not.toBeNull();
			const replay = cliJson<{ sessions: Array<{ id: string }>; lease: { id: string } | null }>([
				"task",
				"prepare",
				dispatched.task.id,
				"--profile",
				"profile:coder",
				"--profile",
				"profile:reviewer",
			]);
			expect(replay.sessions.map((session) => session.id)).toEqual(prepared.sessions.map((session) => session.id));
			expect(replay.lease?.id).toBe(prepared.lease?.id);

			const posted = cliJson<{
				message: { id: string; taskId: string | null };
				queue: { targets: string[] } | null;
			}>([
				"thread",
				"post",
				dispatched.thread.id,
				"please review",
				"--to",
				"profile:reviewer",
				"--task",
				dispatched.task.id,
			]);
			expect(posted.message.taskId).toBe(dispatched.task.id);
			expect(posted.queue?.targets).toEqual(["profile:reviewer"]);
			expect(store.messages.get(posted.message.id)?.taskId).toBe(dispatched.task.id);
		} finally {
			store.close();
		}
	});
});
