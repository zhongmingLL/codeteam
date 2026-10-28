import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	initOperatorCredential,
	openControlStore,
	resolveDaemonPaths,
	resolveInstallation,
	writeStateFile,
} from "../src/index.ts";

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

	it("cancels a stuck deployment wait at the operator surface", () => {
		const store = openControlStore({ dataDir });
		store.backlog.create({
			id: "backlog-1",
			userId: "user-1",
			title: "cli",
			summary: "cli",
			priority: "p1",
			tags: [],
			createdByKind: "user",
			createdById: "user-1",
		});
		store.threads.create({ id: "thread-1", title: "cli" });
		store.tasks.create({
			id: "task-1",
			kind: "work",
			threadId: "thread-1",
			title: "cli",
			why: "cli",
			createdBy: "user-1",
			userId: "user-1",
			backlogItemId: "backlog-1",
		});
		const task = store.tasks.get("task-1")!;
		store.tasks.setDeploymentWait(
			"task-1",
			{
				v: 1,
				generation: 1,
				subjectRef: `deployment:${"a".repeat(64)}:local`,
				ownerFence: { kind: "containing_task", taskId: "task-1" },
				baseline: { bootSequence: 1, bootId: "boot-1", capturedAt: 1 },
				continuation: {
					when: { kind: "new_ready_boot", services: ["daemon"] },
					deliver: { kind: "queue_entry", targetProfileIds: ["profile:coder"] },
					autoRenew: false,
				},
				status: "waiting",
				registeredAt: 1,
				updatedAt: 1,
			},
			{ expectedUpdatedAt: task.updatedAt },
		);
		store.close();
		initOperatorCredential({ dataDir });

		const result = cli(["deployment", "wait", "cancel", "task-1", "--reason", "wrong sha"]);
		expect(result.status).toBe(0);
		const body = JSON.parse(result.stdout.trim()) as { status: string; generation: number };
		expect(body).toMatchObject({ status: "terminal", generation: 1 });
	});
});
