import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandPolicy } from "./policy.ts";

describe("verifier command policy", () => {
	let workdir: string;

	beforeEach(() => {
		workdir = mkdtempSync(join(tmpdir(), "codeteam-policy-"));
	});

	afterEach(() => {
		rmSync(workdir, { recursive: true, force: true });
	});

	it("allows read-only commands and node --test in strict mode", () => {
		const policy = new CommandPolicy(workdir, "strict");
		const grep = policy.evaluate('grep -n "bad line" fixture.txt', workdir);
		expect(grep.allowed).toBe(true);
		expect(grep.command).toEqual({ executable: "grep", args: ["-n", "bad line", "fixture.txt"] });

		expect(policy.evaluate("node --test", workdir).allowed).toBe(true);
		expect(policy.evaluate("diff -u a b", workdir).allowed).toBe(true);
	});

	it("denies node -e in strict mode and allows it in repro mode", () => {
		const strict = new CommandPolicy(workdir, "strict");
		const repro = new CommandPolicy(workdir, "repro");
		const command = 'node -e "process.exit(1)"';
		expect(strict.evaluate(command, workdir).allowed).toBe(false);
		const allowed = repro.evaluate(command, workdir);
		expect(allowed.allowed).toBe(true);
		expect(allowed.command).toEqual({ executable: "node", args: ["-e", "process.exit(1)"] });
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

	it("denies path escapes, absolute paths, and secret paths", () => {
		const policy = new CommandPolicy(workdir, "strict");
		for (const command of [
			"cat ../secret",
			"cat /etc/passwd",
			"cat .env",
			"cat .env.local",
			"cat id_rsa",
			"cat credentials.json",
			"cat .git/config",
		]) {
			expect(policy.evaluate(command, workdir).allowed, command).toBe(false);
		}
	});

	it("denies a cwd outside the worktree", () => {
		const policy = new CommandPolicy(workdir, "strict");
		expect(policy.evaluate("ls", tmpdir()).allowed).toBe(false);
	});
});
