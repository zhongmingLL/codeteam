import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonHandle, type openControlStore, startDaemon } from "../../src/index.ts";

export const CODETEAM_CLI_PATH = join(import.meta.dirname, "..", "..", "dist", "cli.js");
export const PI_CLI_PATH = join(import.meta.dirname, "..", "..", "..", "coding-agent", "dist", "cli.js");

export type Store = ReturnType<typeof openControlStore>;
export type ControlPlaneOptions = NonNullable<Exclude<Parameters<typeof startDaemon>[0]["controlPlane"], false>>;

export interface DispatchedBacklog {
	readonly backlog: { id: string };
	readonly thread: { id: string };
	readonly task: { id: string };
	readonly message: { id: string };
	readonly queueEntry: { id: string };
}

export interface ThreadPostResult {
	readonly message: { id: string; taskId: string | null };
	readonly queue: { id: string; targets: string[] } | null;
}

export interface ScheduleTickOutput {
	readonly materialized: Array<{
		readonly specId: string;
		readonly occurrenceKey: string;
		readonly sourceMessageId: string;
		readonly queueEntryId: string;
	}>;
	readonly skipped: Array<{ readonly specId: string; readonly reason: Record<string, unknown> }>;
	readonly duplicates: Array<{ readonly specId: string }>;
}

const daemons: DaemonHandle[] = [];
const mocks: Array<{ close(): Promise<void> }> = [];
const dirs: string[] = [];

export async function cleanupDaemonE2E(): Promise<void> {
	for (const daemon of daemons.splice(0)) await daemon.close().catch(() => {});
	for (const mock of mocks.splice(0)) await mock.close().catch(() => {});
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function trackMock<T extends { close(): Promise<void> }>(mock: T): T {
	mocks.push(mock);
	return mock;
}

export function setupDirs(): { root: string; dataDir: string; installationRoot: string } {
	const root = mkdtempSync(join(tmpdir(), "codeteam-f016a-e2e-"));
	dirs.push(root);
	const dataDir = join(root, "data");
	const installationRoot = join(root, "install");
	mkdirSync(installationRoot);
	return { root, dataDir, installationRoot };
}

export function writeModels(agentDir: string, baseUrl: string, modelIds: string[]): void {
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				mock: {
					baseUrl,
					api: "anthropic-messages",
					apiKey: "test",
					models: modelIds.map((id) => ({ id, name: id, contextWindow: 16_384, maxTokens: 1_024 })),
				},
			},
		}),
		"utf8",
	);
}

export function cli(dataDir: string, args: readonly string[]) {
	return spawnSync(process.execPath, [CODETEAM_CLI_PATH, "--data-dir", dataDir, ...args, "--json"], {
		encoding: "utf8",
		env: { ...process.env, CODETEAM_DATA_DIR: dataDir },
	});
}

export function cliJson<T>(dataDir: string, args: readonly string[]): T {
	const result = cli(dataDir, args);
	if (result.status !== 0) throw new Error(`cli ${args.join(" ")} exited ${result.status}\n${result.stderr}`);
	return JSON.parse(result.stdout.trim()) as T;
}

export function bootstrapProfiles(
	dataDir: string,
	extras: Array<{ id: string; role: string; displayName: string }> = [],
): void {
	cliJson(dataDir, ["auth", "init"]);
	cliJson(dataDir, ["profile", "seed"]);
	const profiles = [
		{ id: "profile:coder", role: "coder", displayName: "Coder" },
		{ id: "profile:reviewer", role: "reviewer", displayName: "Reviewer" },
		...extras,
	];
	for (const profile of profiles) {
		cliJson(dataDir, [
			"profile",
			"add",
			"--id",
			profile.id,
			"--role",
			profile.role,
			"--display-name",
			profile.displayName,
			"--provider",
			"mock",
			"--model",
			`mock-${profile.role}`,
			"--family",
			"test",
		]);
	}
}

export async function startE2eDaemon(
	dataDir: string,
	installationRoot: string,
	mockBaseUrl: string,
	modelIds: string[],
	controlPlane: Partial<ControlPlaneOptions> = {},
): Promise<{ daemon: DaemonHandle; store: Store }> {
	writeModels(join(dataDir, "worker-agent"), mockBaseUrl, modelIds);
	const daemon = await startDaemon({
		installationRoot,
		dataDir,
		runningRevision: "f016a",
		controlPlane: {
			cliPath: PI_CLI_PATH,
			offline: true,
			pollIntervalMs: 50,
			sweepIntervalMs: 1_000,
			...controlPlane,
		},
	});
	daemons.push(daemon);
	daemon.markReady();
	const store = daemon.controlPlane?.store;
	if (!store) throw new Error("daemon control plane did not start");
	return { daemon, store };
}

export function createBacklogAndDispatch(dataDir: string, target: string, body: string): DispatchedBacklog {
	const backlog = cliJson<{ id: string }>(dataDir, [
		"backlog",
		"create",
		"--title",
		"F016a ingress",
		"--summary",
		"F016a ingress E2E",
		"--tag",
		"feature:F016",
		"--priority",
		"p1",
	]);
	cliJson(dataDir, ["backlog", "approve", backlog.id]);
	const dispatched = cliJson<Omit<DispatchedBacklog, "backlog">>(dataDir, [
		"backlog",
		"dispatch",
		backlog.id,
		"--to",
		target,
		"--phase",
		"coding",
		"--body",
		body,
	]);
	return { backlog, ...dispatched };
}

export function prepareTask(
	dataDir: string,
	taskId: string,
	profiles: readonly string[],
): { task: { id: string; worktree: string }; sessions: Array<{ id: string; profileId: string; role: string }> } {
	return cliJson(dataDir, ["task", "prepare", taskId, ...profiles.flatMap((profile) => ["--profile", profile])]);
}

export function postThread(
	dataDir: string,
	threadId: string,
	taskId: string,
	targets: readonly string[],
	body: string,
): ThreadPostResult {
	return cliJson(dataDir, [
		"thread",
		"post",
		threadId,
		body,
		...targets.flatMap((target) => ["--to", target]),
		"--task",
		taskId,
	]);
}

export function queueRowCount(store: Store): number {
	const row = store.database.prepare("SELECT COUNT(*) AS count FROM queue_entries").get() as
		| { count?: number }
		| undefined;
	return row?.count ?? 0;
}

export function messageCount(store: Store, threadId: string): number {
	return store.messages.listThread(threadId, { limit: 500 }).length;
}

export async function waitFor<T>(check: () => T | null | undefined | false, timeoutMs = 60_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const value = check();
		if (value) return value;
		if (Date.now() > deadline) throw new Error("timed out waiting for F016a E2E state");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
