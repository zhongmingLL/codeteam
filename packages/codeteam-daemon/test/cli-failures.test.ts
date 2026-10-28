import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initOperatorCredential } from "../src/auth/index.ts";

const CLI = join(process.cwd(), "dist/cli.js");
const dirs: string[] = [];
let dataDir: string;
let backlogId: string;
let threadId: string;
let taskId: string;

function cli(args: readonly string[]): string {
	const result = spawnSync(process.execPath, [CLI, "--data-dir", dataDir, ...args], {
		encoding: "utf8",
		env: { ...process.env, CODETEAM_DATA_DIR: dataDir },
	});
	if (result.status !== 0) {
		throw new Error(`cli ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

function cliJson<T>(args: readonly string[]): T {
	const line = cli([...args, "--json"])
		.split(/\r?\n/)
		.find((candidate) => candidate.trim() !== "");
	if (!line) throw new Error(`cli ${args.join(" ")} produced no JSON`);
	return JSON.parse(line) as T;
}

function cliFailure(args: readonly string[]): { code: string; message: string } {
	const result = spawnSync(process.execPath, [CLI, "--data-dir", dataDir, ...args], {
		encoding: "utf8",
		env: { ...process.env, CODETEAM_DATA_DIR: dataDir },
	});
	if (result.status === 0) throw new Error(`cli ${args.join(" ")} unexpectedly succeeded`);
	const line = result.stderr
		.split(/\r?\n/)
		.find((candidate) => candidate.trim().startsWith("{") && candidate.includes('"error"'));
	if (!line) throw new Error(`cli ${args.join(" ")} produced no JSON error: ${result.stderr}`);
	return JSON.parse(line).error as { code: string; message: string };
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "codeteam-cli-failure-"));
	dirs.push(dataDir);
	initOperatorCredential({ dataDir });
	cli(["profile", "seed"]);
	const backlog = cliJson<{ id: string }>([
		"backlog",
		"create",
		"--title",
		"Failure paths",
		"--summary",
		"CLI failure paths",
		"--tag",
		"feature:F007",
		"--priority",
		"p2",
	]);
	backlogId = backlog.id;
	cli(["backlog", "approve", backlogId]);
	const dispatched = cliJson<{ thread: { id: string } }>([
		"backlog",
		"dispatch",
		backlogId,
		"--to",
		"profile:eval",
		"--phase",
		"coding",
	]);
	threadId = dispatched.thread.id;
	const task = cliJson<{ id: string }>([
		"task",
		"create",
		"--backlog",
		backlogId,
		"--thread",
		threadId,
		"--title",
		"Failure task",
		"--why",
		"CLI failure paths",
		"--owner",
		"profile:eval",
	]);
	taskId = task.id;
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CLI failure paths", () => {
	it("rejects backlog done on an open item without a reason", () => {
		const open = cliJson<{ id: string }>([
			"backlog",
			"create",
			"--title",
			"Open item",
			"--summary",
			"no reason",
			"--tag",
			"feature:F007",
		]);
		const error = cliFailure(["backlog", "done", open.id]);
		expect(error.code).toBe("invalid_input");
		expect(error.message).toMatch(/reason/);
	});

	it("rejects approval reject without a note", () => {
		const approval = cliJson<{ id: string }>([
			"approval",
			"request",
			"--task",
			taskId,
			"--thread",
			threadId,
			"--kind",
			"blocker",
			"--idempotency-key",
			"reject-no-note",
		]);
		const error = cliFailure(["approval", "reject", approval.id]);
		expect(error.code).toBe("invalid_input");
		expect(error.message).toMatch(/note/);
	});

	it("rejects a stale approval decision", () => {
		const approval = cliJson<{ id: string }>([
			"approval",
			"request",
			"--task",
			taskId,
			"--thread",
			threadId,
			"--kind",
			"budget_pause",
			"--idempotency-key",
			"stale-approval",
			"--expires-at",
			"1",
		]);
		const error = cliFailure(["approval", "approve", approval.id]);
		expect(error.code).toBe("conflict");
		expect(error.message).toBe("approval_stale");
	});

	it("rejects an unknown approval requester", () => {
		const error = cliFailure([
			"approval",
			"request",
			"--task",
			taskId,
			"--thread",
			threadId,
			"--kind",
			"blocker",
			"--idempotency-key",
			"invalid-requester",
			"--requester",
			"profile:missing",
		]);
		expect(error.code).toBe("not_found");
		expect(error.message).toMatch(/active agent profile/);
	});

	it("rejects an invalid merge record status before touching the gate", () => {
		const error = cliFailure(["merge", "record", "--status", "bogus"]);
		expect(error.code).toBe("invalid_input");
		expect(error.message).toMatch(/--status/);
	});

	it("rejects an existing SOP update without expectedVersion", () => {
		const created = cliJson<{ stage: string }>([
			"sop",
			"update",
			backlogId,
			"--stage",
			"kickoff",
			"--baton",
			"profile:eval",
			"--focus",
			"first focus",
		]);
		expect(created.stage).toBe("kickoff");
		const error = cliFailure([
			"sop",
			"update",
			backlogId,
			"--stage",
			"impl",
			"--baton",
			"profile:eval",
			"--focus",
			"second focus",
		]);
		expect(error.code).toBe("invalid_input");
		expect(error.message).toMatch(/expectedVersion/);
	});

	it("rejects tailing an unknown thread", () => {
		const error = cliFailure(["thread", "tail", "thread-does-not-exist"]);
		expect(error.code).toBe("not_found");
		expect(error.message).toMatch(/thread/);
	});
});
