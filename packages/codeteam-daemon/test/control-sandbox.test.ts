import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildSandboxArgv,
	type CommandExecution,
	createToolPolicy,
	runCommand,
	type ToolPolicy,
} from "../src/index.ts";

const hasBwrap = spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;

const dirs: string[] = [];
let root: string;
let dataDir: string;
let worktree: string;
let evidence: string;
let coder: ToolPolicy;

function execution(argv: string[], cwd: string): CommandExecution {
	return {
		argv,
		cwd,
		env: { PATH: "/usr/bin:/bin" },
		timeoutMs: 120_000,
		maxOutputBytes: 1_000_000,
	};
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "codeteam-sandbox-"));
	dirs.push(root);
	dataDir = join(root, "data");
	worktree = join(root, "worktree");
	evidence = join(root, "evidence");
	for (const dir of [dataDir, worktree, evidence]) mkdirSync(dir, { recursive: true });
	mkdirSync(join(worktree, "src"));
	writeFileSync(join(worktree, "src", "a.ts"), "export const a = 1;\n");
	coder = createToolPolicy({ role: "coder", dataDir, worktreeRoot: worktree });
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codeteam sandbox profile", () => {
	it("builds a bwrap profile that mounts only the worktree and system roots", () => {
		const argv = buildSandboxArgv(coder, execution(["ls", "src"], worktree));
		expect(argv[0]).toMatch(/bwrap$/);
		for (const flag of ["--die-with-parent", "--unshare-all", "--share-net", "--proc", "--dev", "--tmpfs"]) {
			expect(argv).toContain(flag);
		}
		expect(argv).toContain("--bind");
		expect(argv).toContain(worktree);
		expect(argv).toContain("--chdir");
		expect(argv.slice(-5)).toEqual(["--chdir", worktree, "--", "ls", "src"]);
		expect(argv.join(" ")).not.toContain(dataDir);
		expect(argv.join(" ")).not.toContain("credentials");
		expect(argv.join(" ")).not.toContain("control.db");
		expect(argv.join(" ")).not.toContain("artifacts");
	});

	it("makes reviewer worktrees read-only and evidence writable", () => {
		const reviewer = createToolPolicy({ role: "reviewer", dataDir, worktreeRoot: worktree, evidenceRoot: evidence });
		const argv = buildSandboxArgv(reviewer, execution(["ls", "src"], worktree));
		expect(hasBind(argv, "--ro-bind", worktree)).toBe(true);
		expect(hasBind(argv, "--bind", evidence)).toBe(true);
	});

	it("can disable shared networking explicitly", () => {
		const argv = buildSandboxArgv(coder, execution(["ls"], worktree), { shareNetwork: false });
		expect(argv).not.toContain("--share-net");
	});
});

function hasBind(argv: readonly string[], flag: string, path: string): boolean {
	for (let index = 0; index < argv.length - 1; index += 1) {
		if (argv[index] === flag && argv[index + 1] === path) return true;
	}
	return false;
}

describe.skipIf(!hasBwrap)("codeteam sandbox execution", () => {
	it("runs allowlisted commands inside bwrap", async () => {
		const result = await runCommand(coder, { argv: ["ls", "src"] }, { sandbox: true });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("a.ts");
	});

	it("keeps git working inside the sandbox", async () => {
		execFileSync("git", ["init", "-q"], { cwd: worktree });
		const result = await runCommand(coder, { argv: ["git", "status"] }, { sandbox: true });
		expect(result.exitCode).toBe(0);
	});
});
