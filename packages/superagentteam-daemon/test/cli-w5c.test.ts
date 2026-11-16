import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initOperatorCredential } from "../src/index.ts";

const CLI = join(process.cwd(), "dist/cli.js");
const dirs: string[] = [];
let dataDir: string;

function rawCli(args: readonly string[]) {
	return spawnSync(process.execPath, [CLI, "--data-dir", dataDir, ...args], {
		encoding: "utf8",
		env: { ...process.env, CODETEAM_DATA_DIR: dataDir },
	});
}

function cli(args: readonly string[]): string {
	const result = rawCli(args);
	if (result.status !== 0) {
		throw new Error(
			`cli ${args.join(" ")} exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
		);
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

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "codeteam-cli-w5c-"));
	dirs.push(dataDir);
	initOperatorCredential({ dataDir });
	cli(["profile", "seed"]);
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("W5c CLI surface", () => {
	it("sets budget, reports readiness, and materializes a schedule via the single tick entry", () => {
		const now = 1_700_000_000_000;
		const backlog = cliJson<{ id: string }>([
			"backlog",
			"create",
			"--title",
			"W5c CLI",
			"--summary",
			"readiness and schedule",
			"--tag",
			"feature:F010",
			"--priority",
			"p1",
		]);
		cli(["backlog", "approve", backlog.id]);
		const dispatched = cliJson<{ thread: { id: string }; message: { id: string } }>([
			"backlog",
			"dispatch",
			backlog.id,
			"--to",
			"profile:eval",
			"--phase",
			"coding",
		]);
		const task = cliJson<{ id: string }>([
			"task",
			"create",
			"--backlog",
			backlog.id,
			"--thread",
			dispatched.thread.id,
			"--title",
			"W5c CLI task",
			"--why",
			"exercise W5c CLI",
			"--owner",
			"profile:eval",
			"--budget-tokens",
			"10",
		]);
		const ready = rawCli(["task", "readiness", task.id, "--json"]);
		expect(ready.status).toBe(0);
		expect(JSON.parse(ready.stdout.trim())).toMatchObject({ ready: true });

		const budget = cliJson<{ budget: { tokensLimit: number } }>(["budget", "show", task.id]);
		expect(budget.budget.tokensLimit).toBe(10);

		const spec = cliJson<{ id: string }>([
			"schedule",
			"add",
			"--task",
			task.id,
			"--thread",
			dispatched.thread.id,
			"--every-ms",
			"1000",
			"--first-run-at",
			String(now),
			"--to",
			"profile:eval",
			"--body",
			"scheduled wake",
		]);
		const tick = cliJson<{ materialized: Array<{ queueEntryId: string }> }>([
			"schedule",
			"tick",
			"--at",
			String(now),
		]);
		expect(tick.materialized).toHaveLength(1);
		const shown = cliJson<{ runs: Array<{ status: string; queueEntryId: string }> }>(["schedule", "show", spec.id]);
		expect(shown.runs[0]).toMatchObject({ status: "queued", queueEntryId: tick.materialized[0]!.queueEntryId });

		cli(["budget", "set", task.id, "--tokens", "0"]);
		const blocked = rawCli(["task", "readiness", task.id, "--json"]);
		expect(blocked.status).toBe(3);
		const blockedJson = JSON.parse(blocked.stdout.trim()) as { reasons: Array<{ code: string }> };
		expect(blockedJson.reasons.map((reason) => reason.code)).toContain("budget_paused");
	});

	it("rejects dispatch when a backlog dependency is not done", () => {
		const first = cliJson<{ id: string }>([
			"backlog",
			"create",
			"--title",
			"dependency",
			"--summary",
			"first",
			"--tag",
			"feature:F010",
			"--priority",
			"p2",
		]);
		cli(["backlog", "approve", first.id]);
		const dependent = cliJson<{ id: string }>([
			"backlog",
			"create",
			"--title",
			"dependent",
			"--summary",
			"second",
			"--tag",
			"feature:F010",
			"--priority",
			"p2",
			"--depends-on",
			first.id,
		]);
		cli(["backlog", "approve", dependent.id]);
		const result = rawCli(["backlog", "dispatch", dependent.id, "--to", "profile:eval"]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("dependency_unmet");

		const cycle = rawCli(["backlog", "depend", first.id, "--on", dependent.id]);
		expect(cycle.status).not.toBe(0);
		expect(cycle.stderr).toContain("dependency_cycle");
	});
});
