import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assertReadablePath,
	assertWritablePath,
	ControlError,
	createToolPolicy,
	evaluateCommand,
	type ToolPolicy,
} from "../src/index.ts";

const dirs: string[] = [];
let root: string;
let dataDir: string;
let worktree: string;
let evidence: string;
let policy: ToolPolicy;

function write(path: string, content = "x") {
	writeFileSync(path, content, { mode: 0o600 });
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "codeteam-policy-"));
	dirs.push(root);
	dataDir = join(root, "data");
	worktree = join(root, "worktree");
	evidence = join(root, "evidence");
	for (const dir of [dataDir, worktree, evidence]) mkdirSync(dir, { recursive: true, mode: 0o700 });
	mkdirSync(join(worktree, "src"));
	mkdirSync(join(worktree, ".ssh"));
	mkdirSync(join(worktree, "credentials"));
	mkdirSync(join(worktree, ".git", "objects"), { recursive: true });
	mkdirSync(join(dataDir, "tokens"));
	mkdirSync(join(dataDir, "artifacts"));
	write(join(worktree, "src", "a.ts"), "export const a = 1;\n");
	write(join(worktree, ".env"), "SECRET=1");
	write(join(worktree, "cert.pem"), "pem");
	write(join(worktree, ".ssh", "id_rsa"), "key");
	write(join(worktree, "credentials.json"), "{}");
	write(join(worktree, "credentials", "operator.key"), "key");
	write(join(worktree, ".git", "objects", "blob"), "blob");
	write(join(dataDir, "control.db"), "db");
	write(join(dataDir, "tokens", "run-1.token"), "token");
	write(join(dataDir, "artifacts", "a"), "artifact");
	write(join(root, "outside.txt"), "outside");
	symlinkSync(join(root, "outside.txt"), join(worktree, "link-out"));
	symlinkSync(join(root, "missing-target"), join(worktree, "dangling-out"));
	linkSync(join(root, "outside.txt"), join(worktree, "hard-out"));
	policy = createToolPolicy({ role: "coder", dataDir, worktreeRoot: worktree });
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codeteam tool policy", () => {
	it("allows allowlisted commands and returns a minimal environment", () => {
		const execution = evaluateCommand(policy, {
			argv: ["ls", "src"],
			env: { HOME: "/home/test", SECRET: "nope" },
		});
		expect(execution.argv).toEqual(["ls", "src"]);
		expect(execution.cwd).toBe(worktree);
		expect(execution.env.HOME).toBe("/home/test");
		expect(execution.env.SECRET).toBeUndefined();
		expect(execution.env.PATH).toBeDefined();
		expect(execution.timeoutMs).toBe(120_000);
	});

	it("denies commands outside the allowlist and shell metacharacters", () => {
		expect(() => evaluateCommand(policy, { argv: ["rm", "src/a.ts"] })).toThrow(ControlError);
		expect(() => evaluateCommand(policy, { argv: ["curl", "https://example.com"] })).toThrow(ControlError);
		for (const arg of ["a;b", "a|b", "a&b", "a>b", "a<b", "a`b", "a$b", "a\nb", "a#b"]) {
			expect(() => evaluateCommand(policy, { argv: ["ls", arg] })).toThrow(ControlError);
		}
	});

	it("denies node eval and non-test node invocations", () => {
		expect(() => evaluateCommand(policy, { argv: ["node", "-e", "process.exit(0)"] })).toThrow(ControlError);
		expect(() => evaluateCommand(policy, { argv: ["node", "script.js"] })).toThrow(ControlError);
		expect(evaluateCommand(policy, { argv: ["node", "--test"] }).argv).toEqual(["node", "--test"]);
	});

	it("restricts git to add/commit/status/diff and denies repo escape flags", () => {
		expect(evaluateCommand(policy, { argv: ["git", "status"] }).argv).toEqual(["git", "status"]);
		expect(evaluateCommand(policy, { argv: ["git", "diff"] }).argv).toEqual(["git", "diff"]);
		expect(evaluateCommand(policy, { argv: ["git", "add", "src/a.ts"] }).argv).toEqual(["git", "add", "src/a.ts"]);
		for (const sub of ["push", "remote", "config", "checkout", "reset"]) {
			expect(() => evaluateCommand(policy, { argv: ["git", sub] })).toThrow(ControlError);
		}
		expect(() => evaluateCommand(policy, { argv: ["git", "-C", "/tmp", "status"] })).toThrow(ControlError);
		expect(() => evaluateCommand(policy, { argv: ["git", "diff", "--no-index"] })).toThrow(ControlError);
	});

	it("denies git write primitives and validates commit message files", () => {
		for (const argv of [
			["git", "diff", "--output=/tmp/x"],
			["git", "diff", "--output", "/tmp/x"],
			["git", "diff", "-o/tmp/x"],
			["git", "diff", "--pathspec-from-file=/tmp/x"],
			["git", "diff", "--pathspec-file-nul"],
			["git", "diff", "--exec-path=/tmp"],
		]) {
			expect(() => evaluateCommand(policy, { argv })).toThrow(ControlError);
		}
		expect(() => evaluateCommand(policy, { argv: ["git", "commit", "-F", ".env"] })).toThrow(ControlError);
		expect(() => evaluateCommand(policy, { argv: ["git", "commit", "--file=.env"] })).toThrow(ControlError);
		expect(() => evaluateCommand(policy, { argv: ["git", "commit", "-F.env"] })).toThrow(ControlError);
		expect(evaluateCommand(policy, { argv: ["git", "commit", "--file=src/a.ts"] }).argv).toEqual([
			"git",
			"commit",
			"--file=src/a.ts",
		]);
		expect(evaluateCommand(policy, { argv: ["git", "commit", "-F", "src/a.ts"] }).argv).toEqual([
			"git",
			"commit",
			"-F",
			"src/a.ts",
		]);
	});

	it("exempts commit messages from the hash rule but keeps other shell metacharacters", () => {
		expect(evaluateCommand(policy, { argv: ["git", "commit", "-m", "fix #123"] }).argv).toEqual([
			"git",
			"commit",
			"-m",
			"fix #123",
		]);
		expect(evaluateCommand(policy, { argv: ["git", "commit", "--message=fix #123"] }).argv).toEqual([
			"git",
			"commit",
			"--message=fix #123",
		]);
		expect(() => evaluateCommand(policy, { argv: ["git", "commit", "-m", "fix; rm -rf /"] })).toThrow(ControlError);
	});

	it("denies path traversal and reads outside allowed roots", () => {
		expect(() => assertReadablePath(policy, "../outside.txt")).toThrow(ControlError);
		expect(() => assertReadablePath(policy, join(root, "outside.txt"))).toThrow(ControlError);
		expect(() => evaluateCommand(policy, { argv: ["cat", "../outside.txt"] })).toThrow(ControlError);
		expect(() => evaluateCommand(policy, { argv: ["ls", "link-out"] })).toThrow(ControlError);
	});

	it("denies secret paths, git internals, daemon data, and hardlinks", () => {
		for (const path of [
			".env",
			"cert.pem",
			".ssh/id_rsa",
			"credentials.json",
			"credentials/operator.key",
			".git/objects/blob",
			"hard-out",
			join(dataDir, "control.db"),
			join(dataDir, "tokens", "run-1.token"),
			join(dataDir, "artifacts", "a"),
		]) {
			expect(() => assertReadablePath(policy, path)).toThrow(ControlError);
		}
		expect(assertReadablePath(policy, "src/a.ts")).toBe(join(worktree, "src", "a.ts"));
	});

	it("keeps coder writes inside the worktree and away from denied paths", () => {
		expect(assertWritablePath(policy, "src/b.ts")).toBe(join(worktree, "src", "b.ts"));
		expect(() => assertWritablePath(policy, "../outside-new.txt")).toThrow(ControlError);
		expect(() => assertWritablePath(policy, join(root, "outside-new.txt"))).toThrow(ControlError);
		expect(() => assertWritablePath(policy, ".git/objects/new")).toThrow(ControlError);
		expect(() => assertWritablePath(policy, "dangling-out")).toThrow(ControlError);
		expect(() => assertWritablePath(policy, "hard-out")).toThrow(ControlError);
	});

	it("restricts reviewer writes to the evidence worktree", () => {
		const reviewer = createToolPolicy({
			role: "reviewer",
			dataDir,
			worktreeRoot: worktree,
			evidenceRoot: evidence,
		});
		expect(assertReadablePath(reviewer, "src/a.ts")).toBe(join(worktree, "src", "a.ts"));
		expect(assertWritablePath(reviewer, join(evidence, "finding.md"))).toBe(join(evidence, "finding.md"));
		expect(() => assertWritablePath(reviewer, "src/a.ts")).toThrow(ControlError);
		expect(() => createToolPolicy({ role: "reviewer", dataDir, worktreeRoot: worktree })).toThrow(ControlError);
	});
});
