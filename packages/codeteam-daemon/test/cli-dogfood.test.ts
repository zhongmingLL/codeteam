import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initOperatorCredential } from "../src/auth/index.ts";
import { openControlStore } from "../src/index.ts";

const CLI = join(process.cwd(), "dist/cli.js");
const dirs: string[] = [];
let dataDir: string;

function cli(args: readonly string[], expectStatus = 0): string {
	const result = spawnSync(process.execPath, [CLI, "--data-dir", dataDir, ...args], {
		encoding: "utf8",
		env: { ...process.env, CODETEAM_DATA_DIR: dataDir },
	});
	if (result.status !== expectStatus) {
		throw new Error(
			`cli ${args.join(" ")} exited ${result.status} (expected ${expectStatus})\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
		);
	}
	return result.stdout.trim();
}

function cliJson<T = Record<string, unknown>>(args: readonly string[]): T {
	const output = cli([...args, "--json"]);
	const firstLine = output.split(/\r?\n/).find((line) => line.trim() !== "");
	if (!firstLine) throw new Error(`cli ${args.join(" ")} produced no JSON`);
	return JSON.parse(firstLine) as T;
}

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
			GIT_CONFIG_NOSYSTEM: "1",
		},
	}).trim();
}

function createMergeRepo(): { repo: string; featureSha: string } {
	const repo = mkdtempSync(join(tmpdir(), "codeteam-dogfood-repo-"));
	dirs.push(repo);
	git(repo, ["init", "-b", "main"]);
	git(repo, ["config", "user.email", "test@example.com"]);
	git(repo, ["config", "user.name", "Test"]);
	mkdirSync(join(repo, "docs"), { recursive: true });
	writeFileSync(join(repo, "docs", "dogfood.md"), "base\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "base"]);
	git(repo, ["checkout", "-b", "feature", "-q"]);
	writeFileSync(join(repo, "docs", "dogfood.md"), "base\nfeature\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "feature"]);
	const featureSha = git(repo, ["rev-parse", "HEAD"]);
	git(repo, ["checkout", "main", "-q"]);
	return { repo, featureSha };
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "codeteam-dogfood-data-"));
	dirs.push(dataDir);
	initOperatorCredential({ dataDir });
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codeteam W4 CLI dogfood", () => {
	it("runs backlog -> thread -> agent reply -> approval -> merge -> SOP completion without Web", () => {
		cli(["profile", "seed"]);
		const profiles = cliJson<Array<{ id: string }>>(["profile", "list"]);
		expect(profiles.some((profile) => profile.id === "profile:eval")).toBe(true);
		const created = cliJson<{ id: string }>([
			"backlog",
			"create",
			"--title",
			"W4 dogfood",
			"--summary",
			"SOP and points gates",
			"--tag",
			"feature:F007",
			"--priority",
			"p1",
		]);
		const backlogId = created.id;
		cli(["backlog", "approve", backlogId]);
		const dispatched = cliJson<{ thread: { id: string }; message: { id: string }; queueEntry: { id: string } }>([
			"backlog",
			"dispatch",
			backlogId,
			"--to",
			"profile:eval",
			"--phase",
			"coding",
			"--body",
			"Kickoff",
		]);
		const threadId = dispatched.thread.id;
		const listed = cliJson<Array<{ id: string; backlogItemId: string }>>(["thread", "list", "--backlog", backlogId]);
		expect(listed.some((thread) => thread.id === threadId)).toBe(true);
		const shown = cliJson<{ messages: Array<{ kind: string }> }>(["thread", "show", threadId]);
		expect(shown.messages.some((message) => message.kind === "backlog_kickoff")).toBe(true);
		cli(["thread", "post", threadId, "please execute the dogfood", "--to", "profile:eval"]);
		const task = cliJson<{ id: string }>([
			"task",
			"create",
			"--backlog",
			backlogId,
			"--thread",
			threadId,
			"--title",
			"Dogfood task",
			"--why",
			"prove the CLI loop",
			"--owner",
			"profile:eval",
		]);
		const directed = cliJson<{ inbox: Array<{ taskId: string }> }>([
			"thread",
			"post",
			threadId,
			"@profile:eval please continue",
		]);
		expect(directed.inbox[0]?.taskId).toBe(task.id);
		const store = openControlStore({ dataDir });
		try {
			const pending = store.queue.listPending().find((entry) => entry.threadId === threadId);
			expect(pending).toBeDefined();
			store.queue.claim(pending!.id, { claimId: "dogfood-claim" });
			store.sessions.create({
				id: "dogfood-session",
				threadId,
				taskId: task.id,
				profileId: "profile:eval",
				role: "coder",
				effectiveToolPolicy: "default",
				provider: "test",
				model: "glm-5.3-flash",
				modelFamily: "glm",
				seq: 0,
			});
			store.cutoverQueueEntry({
				queueEntryId: pending!.id,
				claimId: "dogfood-claim",
				targetProfileId: "profile:eval",
				taskId: task.id,
				role: "coder",
				agentSessionId: "dogfood-session",
				provider: "test",
				model: "glm-5.3-flash",
				modelFamily: "glm",
				responseBody: "dogfood reply",
			});
		} finally {
			store.close();
		}
		const tail = cli(["thread", "tail", threadId, "--after-seq", "0", "--json"]);
		const messages = tail
			.split(/\r?\n/)
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as { kind: string; bodyMd: string });
		expect(messages.some((message) => message.kind === "agent_response" && message.bodyMd === "dogfood reply")).toBe(
			true,
		);
		const approval = cliJson<{ id: string }>([
			"approval",
			"request",
			"--task",
			task.id,
			"--thread",
			threadId,
			"--kind",
			"design_gate",
			"--idempotency-key",
			"dogfood-design-gate",
			"--payload-json",
			'{"stage":"dogfood"}',
		]);
		const approvals = cliJson<Array<{ id: string; resolution: string }>>(["approval", "list"]);
		expect(approvals.some((item) => item.id === approval.id && item.resolution === "open")).toBe(true);
		cli(["approval", "show", approval.id]);
		const approved = cliJson<{ resolution: string }>(["approval", "approve", approval.id]);
		expect(approved.resolution).toBe("accepted");
		const agentRequest = cliJson<{ requestedBy: string }>([
			"approval",
			"request",
			"--task",
			task.id,
			"--thread",
			threadId,
			"--kind",
			"blocker",
			"--idempotency-key",
			"dogfood-agent-request",
			"--requester",
			"profile:eval",
			"--payload-json",
			'{"reason":"agent escalation wiring"}',
		]);
		expect(agentRequest.requestedBy).toBe("profile:eval");
		const { repo, featureSha } = createMergeRepo();
		const merge = cliJson<{ receipt: { status: string; mergeSha: string; executedBy: string } }>([
			"merge",
			"execute",
			"--task",
			task.id,
			"--repo",
			repo,
			"--worktree",
			repo,
			"--base",
			"main",
			"--head",
			featureSha,
			"--allow-unsynced-base",
			"--pr",
			"local#1",
		]);
		expect(merge.receipt.status).toBe("succeeded");
		expect(merge.receipt.executedBy).toBe("service:merge-owner");
		cli(["backlog", "done", backlogId]);
		const verdict = cliJson<{ message: { id: string } }>([
			"thread",
			"post",
			threadId,
			"accepted",
			"--kind",
			"verdict",
		]);
		cli([
			"sop",
			"evidence",
			backlogId,
			"visionGuardDone",
			`message:${verdict.message.id}`,
			"--subject-revision",
			merge.receipt.mergeSha,
		]);
		const completed = cliJson<{ stage: string; version: number }>([
			"sop",
			"update",
			backlogId,
			"--stage",
			"completion",
			"--baton",
			"operator",
			"--focus",
			"close",
			"--subject-revision",
			merge.receipt.mergeSha,
		]);
		expect(completed.stage).toBe("completion");
		const view = cliJson<{ sop: { stage: string } }>(["sop", "show", backlogId]);
		expect(view.sop.stage).toBe("completion");
		const telemetry = cliJson<{ total: number }>(["gate", "telemetry"]);
		expect(telemetry.total).toBeGreaterThan(0);
	});
});
