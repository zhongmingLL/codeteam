import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SmokeWorkspace {
	workdir: string;
	agentDir: string;
}

export function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function copySmokeFixture(fixture: string): SmokeWorkspace {
	const workdir = mkdtempSync(join(tmpdir(), "codeteam-smoke-"));
	const agentDir = mkdtempSync(join(tmpdir(), "codeteam-agent-"));
	cpSync(fixture, workdir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	return { workdir, agentDir };
}

export function runNodeTest(cwd: string): { exitCode: number; outputTail: string } {
	const result = spawnSync("node", ["--test"], {
		cwd,
		encoding: "utf8",
		timeout: 60_000,
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\r?\n/).slice(-30).join("\n");
	return { exitCode: result.status ?? 1, outputTail: output };
}
