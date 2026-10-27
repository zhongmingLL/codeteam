import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ControlError, createToolPolicy, runCommand } from "../src/index.ts";

const repoRoot = process.env.CODETEAM_REAL_REPO;
const hasBwrap = spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
const enabled = Boolean(repoRoot) && existsSync(join(repoRoot ?? "", ".git")) && hasBwrap;

describe.skipIf(!enabled)("real repository sandbox first run", () => {
	it("runs the read-only matrix and the denial matrix against the real repo", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "codeteam-first-run-data-"));
		const evidence = mkdtempSync(join(tmpdir(), "codeteam-first-run-evidence-"));
		try {
			const policy = createToolPolicy({
				role: "reviewer",
				dataDir,
				worktreeRoot: repoRoot as string,
				evidenceRoot: evidence,
			});
			const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot as string, encoding: "utf8" }).trim();
			expect(head).toMatch(/^[0-9a-f]{40}$/);
			const matrix: string[][] = [
				["git", "status", "--short"],
				["git", "rev-parse", "HEAD"],
				["git", "diff", "--stat"],
				["ls", "packages"],
				["wc", "-l", "CODETEAM.md"],
			];
			for (const argv of matrix) {
				const result = await runCommand(policy, { argv }, { sandbox: true, timeoutMs: 30_000 });
				expect(result.exitCode, `${argv.join(" ")}: ${result.stderr}`).toBe(0);
			}
			await expect(
				runCommand(policy, { argv: ["rm", "-rf", "README.md"] }, { sandbox: true }),
			).rejects.toBeInstanceOf(ControlError);
			await expect(runCommand(policy, { argv: ["cat", ".git/config"] }, { sandbox: true })).rejects.toBeInstanceOf(
				ControlError,
			);
			const evidenceWrite = await runCommand(policy, { argv: ["ls"], cwd: evidence }, { sandbox: true });
			expect(evidenceWrite.exitCode).toBe(0);
			expect(evidenceWrite.stdout.trim()).toBe("");
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
			rmSync(evidence, { recursive: true, force: true });
		}
	});
});
