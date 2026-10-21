import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandPolicy } from "./policy.ts";

describe("verifier command policy", () => {
	let workdir: string;
	let outsideDir: string;

	beforeEach(() => {
		workdir = mkdtempSync(join(tmpdir(), "codeteam-policy-"));
		outsideDir = mkdtempSync(join(tmpdir(), "codeteam-outside-"));
		writeFileSync(join(outsideDir, "secret.txt"), "outside secret\n");
		symlinkSync(join(outsideDir, "secret.txt"), join(workdir, "link.txt"));
	});

	afterEach(() => {
		rmSync(workdir, { recursive: true, force: true });
		rmSync(outsideDir, { recursive: true, force: true });
	});

	it("allows read-only commands in strict mode", () => {
		const policy = new CommandPolicy(workdir, "strict");
		const grep = policy.evaluate('grep -n "bad line" fixture.txt', workdir);
		expect(grep.allowed).toBe(true);
		expect(grep.command).toEqual({ executable: "grep", args: ["-n", "bad line", "fixture.txt"] });

		expect(policy.evaluate("diff -u a b", workdir).allowed).toBe(true);
		expect(policy.evaluate("ls", workdir).allowed).toBe(true);
	});

	it("disables node in strict mode and allows only node --test in repro mode", () => {
		const strict = new CommandPolicy(workdir, "strict");
		const repro = new CommandPolicy(workdir, "repro");
		expect(strict.evaluate("node --test", workdir).allowed).toBe(false);
		expect(repro.evaluate("node --test", workdir).allowed).toBe(true);
	});

	it("denies node -e, --eval, and code-loading flags in both modes", () => {
		for (const mode of ["strict", "repro"] as const) {
			const policy = new CommandPolicy(workdir, mode);
			for (const command of [
				'node -e "process.exit(1)"',
				'node --eval "process.exit(1)"',
				"node --require ./x --test",
				"node --import ./x --test",
			]) {
				expect(policy.evaluate(command, workdir).allowed, `${mode}: ${command}`).toBe(false);
			}
		}
	});

	it("denies rg preprocessor flags", () => {
		const policy = new CommandPolicy(workdir, "strict");
		for (const command of ["rg --pre ./pwn.sh x .", "rg --pre bash x .", "rg --pre-glob '*.txt' --pre bash x ."]) {
			const decision = policy.evaluate(command, workdir);
			expect(decision.allowed, command).toBe(false);
			expect(decision.reason).toContain("dangerous flag");
		}
	});

	it("denies dangerous and non-allowlisted executables", () => {
		const policy = new CommandPolicy(workdir, "strict");
		for (const command of [
			"rm -rf .",
			"bash -c 'echo hi'",
			"git push",
			"sudo ls",
			"/bin/rm -rf .",
			"curl https://example.com",
		]) {
			expect(policy.evaluate(command, workdir).allowed, command).toBe(false);
		}
	});

	it("denies shell composition and redirects outside quotes", () => {
		const policy = new CommandPolicy(workdir, "strict");
		for (const command of [
			"grep x file && rm file",
			"grep x file | cat",
			"grep x file > out",
			"grep x file; rm file",
			"cat $(pwd)",
			"cat `pwd`",
		]) {
			expect(policy.evaluate(command, workdir).allowed, command).toBe(false);
		}
	});

	it("denies path escapes, absolute paths, and nested secret paths", () => {
		const policy = new CommandPolicy(workdir, "strict");
		for (const command of [
			"cat ../secret",
			"cat /etc/passwd",
			"cat .env",
			"cat .env.local",
			"cat sub/.env",
			"cat nested/id_rsa",
			"cat a/credentials.json",
			"cat .git/config",
		]) {
			expect(policy.evaluate(command, workdir).allowed, command).toBe(false);
		}
	});

	it("denies symlinks that resolve outside the worktree", () => {
		const policy = new CommandPolicy(workdir, "strict");
		const decision = policy.evaluate("cat link.txt", workdir);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain("symlink");
	});

	it("denies attached flag paths", () => {
		const policy = new CommandPolicy(workdir, "strict");
		for (const command of [
			"rg -f/etc/hostname fixture.txt",
			"rg --file=/etc/hostname fixture.txt",
			"rg -flink.txt fixture.txt",
			"rg --file=link.txt fixture.txt",
			"grep -f/etc/passwd fixture.txt",
		]) {
			expect(policy.evaluate(command, workdir).allowed, command).toBe(false);
		}
	});

	it("handles backslash escapes in unquoted arguments", () => {
		const policy = new CommandPolicy(workdir, "strict");
		const decision = policy.evaluate("grep foo\\ bar fixture.txt", workdir);
		expect(decision.allowed).toBe(true);
		expect(decision.command?.args).toEqual(["foo bar", "fixture.txt"]);
	});

	it("denies a cwd outside the worktree", () => {
		const policy = new CommandPolicy(workdir, "strict");
		expect(policy.evaluate("ls", tmpdir()).allowed).toBe(false);
	});
});
