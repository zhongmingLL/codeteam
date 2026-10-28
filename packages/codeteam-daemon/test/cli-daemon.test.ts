import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDaemonPaths, resolveInstallation, writeStateFile } from "../src/index.ts";

const CLI = join(process.cwd(), "dist/cli.js");
const dirs: string[] = [];
let dataDir: string;
let installationRoot: string;

function cli(args: readonly string[]) {
	return spawnSync(process.execPath, [CLI, "--data-dir", dataDir, ...args, "--json"], {
		encoding: "utf8",
		env: { ...process.env, CODETEAM_DATA_DIR: dataDir, CODETEAM_INSTALLATION_ROOT: installationRoot },
	});
}

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "codeteam-cli-daemon-"));
	dirs.push(root);
	dataDir = join(root, "data");
	installationRoot = join(root, "install");
	mkdirSync(installationRoot);
	const installation = resolveInstallation(installationRoot);
	writeStateFile(resolveDaemonPaths(dataDir).stateFile, {
		schemaVersion: 1,
		deploymentId: "local",
		installationId: installation.installationId,
		installationRoot: installation.realRoot,
		pid: 100,
		bootId: "boot-1",
		bootSequence: 1,
		runningRevision: "a".repeat(40),
		state: "ready",
		services: ["daemon"],
		healthPort: 1234,
		startedAt: "2026-10-28T00:00:00.000Z",
		updatedAt: "2026-10-28T00:00:00.000Z",
	});
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("W5d daemon CLI", () => {
	it("reports daemon state and lifecycle status at the operator surface", () => {
		const result = cli(["daemon", "status", "--installation-root", installationRoot]);
		expect(result.status).toBe(0);
		const body = JSON.parse(result.stdout.trim()) as {
			daemonState: { state: string; deploymentId: string; bootId: string };
			latestOperation: unknown;
		};
		expect(body.daemonState).toMatchObject({ state: "ready", deploymentId: "local", bootId: "boot-1" });
		expect(body.latestOperation).toBeNull();
	});
});
