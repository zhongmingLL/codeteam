import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = join(process.cwd(), "dist/cli.js");
const dirs: string[] = [];
let dataDir: string;
let repo: string;

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
	dataDir = mkdtempSync(join(tmpdir(), "codeteam-cli-memory-"));
	repo = mkdtempSync(join(tmpdir(), "codeteam-cli-memory-repo-"));
	dirs.push(dataDir, repo);
	mkdirSync(join(repo, "docs", "features"), { recursive: true });
	writeFileSync(
		join(repo, "docs", "features", "F001.md"),
		"---\ntitle: CLI memory\nstatus: active\ntags: [memory]\n---\n\n# CLI memory\n\nMemory evidence recall from the CLI.\n",
	);
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("memory CLI", () => {
	it("indexes, reports status, recalls, reads and builds a trigger context", () => {
		const index = cliJson<{ status: string; counts: { file: number }; controlAvailable: boolean }>([
			"memory",
			"index",
			"--repo",
			repo,
		]);
		expect(index).toMatchObject({ status: "fresh", counts: { file: 1 }, controlAvailable: false });
		const status = cliJson<{ exists: boolean; coverage: { counts: { file: number }; reasons: string[] } }>([
			"memory",
			"status",
		]);
		expect(status.exists).toBe(true);
		expect(status.coverage.counts.file).toBe(1);
		expect(status.coverage.reasons).toContain("control_db_absent");
		const recall = cliJson<{ items: { anchor: string; match: string }[] }>(["memory", "recall", "memory"]);
		expect(recall.items[0]).toMatchObject({ anchor: "file:docs/features/F001.md" });
		const read = cliJson<{ found: boolean; content: string }>(["memory", "read", "file:docs/features/F001.md"]);
		expect(read.found).toBe(true);
		expect(read.content).toContain("Memory evidence recall");
		const trigger = cliJson<{ trigger: string; contextBlock: string; result: { items: unknown[] } }>([
			"memory",
			"trigger",
			"review",
			"--task-title",
			"CLI memory",
		]);
		expect(trigger.trigger).toBe("review");
		expect(trigger.result.items.length).toBeGreaterThan(0);
		expect(trigger.contextBlock).toContain("file:docs/features/F001.md");
	});

	it("reports a missing memory DB without pretending the source does not exist", () => {
		const recall = cliJson<{ items: unknown[]; coverage: { reasons: string[]; scope: string } }>([
			"memory",
			"recall",
			"memory",
		]);
		expect(recall.items).toEqual([]);
		expect(recall.coverage.scope).toBe("indexed_scope_only");
		expect(recall.coverage.reasons).toContain("memory_db_absent");
		const status = cliJson<{ exists: boolean; coverage: { reasons: string[] } }>(["memory", "status"]);
		expect(status.exists).toBe(false);
		expect(status.coverage.reasons).toContain("memory_db_absent");
	});

	it("fails closed for an unknown trigger and reports digest unavailability", () => {
		const invalid = rawCli(["memory", "trigger", "nope", "--json"]);
		expect(invalid.status).toBe(1);
		expect(invalid.stderr).toContain('"code":"invalid_input"');
		const digest = cliJson<{ found: boolean; reason: string }>(["memory", "digest", "--run", "missing-run"]);
		expect(digest).toEqual({ found: false, reason: "control_db_absent" });
	});
});
