import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createA2AHandlers,
	type DaemonHandle,
	type openControlStore,
	ProactiveScheduleService,
	resolveRunPrincipal,
	startDaemon,
} from "../src/index.ts";
import { errorResponse, startMockAnthropic, textResponse } from "./helpers/mock-anthropic.ts";
import { createW5AFixture } from "./helpers/w5a-fixture.ts";

const CODETEAM_CLI_PATH = join(import.meta.dirname, "..", "dist", "cli.js");
const PI_CLI_PATH = join(import.meta.dirname, "..", "..", "coding-agent", "dist", "cli.js");

const daemons: DaemonHandle[] = [];
const mocks: Array<{ close(): Promise<void> }> = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const daemon of daemons.splice(0)) await daemon.close().catch(() => {});
	for (const mock of mocks.splice(0)) await mock.close().catch(() => {});
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Store = ReturnType<typeof openControlStore>;
type ControlPlaneOptions = NonNullable<Exclude<Parameters<typeof startDaemon>[0]["controlPlane"], false>>;

interface DispatchedBacklog {
	readonly backlog: { id: string };
	readonly thread: { id: string };
	readonly task: { id: string };
	readonly message: { id: string };
	readonly queueEntry: { id: string };
}

interface ThreadPostResult {
	readonly message: { id: string; taskId: string | null };
	readonly queue: { id: string; targets: string[] } | null;
}

interface ScheduleTickOutput {
	readonly materialized: Array<{
		readonly specId: string;
		readonly occurrenceKey: string;
		readonly sourceMessageId: string;
		readonly queueEntryId: string;
	}>;
	readonly skipped: Array<{ readonly specId: string; readonly reason: Record<string, unknown> }>;
	readonly duplicates: Array<{ readonly specId: string }>;
}

function setupDirs(): { root: string; dataDir: string; installationRoot: string } {
	const root = mkdtempSync(join(tmpdir(), "codeteam-f016a-ingress-"));
	dirs.push(root);
	const dataDir = join(root, "data");
	const installationRoot = join(root, "install");
	mkdirSync(installationRoot);
	return { root, dataDir, installationRoot };
}

function writeModels(agentDir: string, baseUrl: string, modelIds: string[]): void {
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

function cli(dataDir: string, args: readonly string[]) {
	return spawnSync(process.execPath, [CODETEAM_CLI_PATH, "--data-dir", dataDir, ...args, "--json"], {
		encoding: "utf8",
		env: { ...process.env, CODETEAM_DATA_DIR: dataDir },
	});
}

function cliJson<T>(dataDir: string, args: readonly string[]): T {
	const result = cli(dataDir, args);
	if (result.status !== 0) throw new Error(`cli ${args.join(" ")} exited ${result.status}\n${result.stderr}`);
	return JSON.parse(result.stdout.trim()) as T;
}

function bootstrapProfiles(
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

async function startE2eDaemon(
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
		runningRevision: "f016a-s1",
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

function createBacklogAndDispatch(dataDir: string, target: string, body: string): DispatchedBacklog {
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

function prepareTask(
	dataDir: string,
	taskId: string,
	profiles: readonly string[],
): { task: { id: string; worktree: string }; sessions: Array<{ id: string; profileId: string; role: string }> } {
	return cliJson(dataDir, ["task", "prepare", taskId, ...profiles.flatMap((profile) => ["--profile", profile])]);
}

function postThread(
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

function queueRowCount(store: Store): number {
	const row = store.database.prepare("SELECT COUNT(*) AS count FROM queue_entries").get() as
		| { count?: number }
		| undefined;
	return row?.count ?? 0;
}

function messageCount(store: Store, threadId: string): number {
	return store.messages.listThread(threadId, { limit: 500 }).length;
}

async function waitFor<T>(check: () => T | null | undefined | false, timeoutMs = 60_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const value = check();
		if (value) return value;
		if (Date.now() > deadline) throw new Error("timed out waiting for F016a ingress state");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("F016a ingress real RPC E2E", () => {
	it("I1: operator thread post reaches a real worker and rejects unbound producers", async () => {
		const { dataDir, installationRoot } = setupDirs();
		bootstrapProfiles(dataDir, [{ id: "profile:reviewer-2", role: "reviewer", displayName: "Reviewer Two" }]);
		const mock = await startMockAnthropic(({ model }) =>
			textResponse(model === "mock-coder" ? "KICKOFF_DONE" : "THREAD_POST_DONE"),
		);
		mocks.push(mock);
		const { daemon, store } = await startE2eDaemon(dataDir, installationRoot, mock.baseUrl, [
			"mock-coder",
			"mock-reviewer",
		]);
		const dispatched = createBacklogAndDispatch(dataDir, "profile:coder", "kickoff");
		prepareTask(dataDir, dispatched.task.id, ["profile:coder", "profile:reviewer"]);
		await waitFor(() => store.runs.list({ taskId: dispatched.task.id }).find((run) => run.status === "completed"));

		const posted = postThread(
			dataDir,
			dispatched.thread.id,
			dispatched.task.id,
			["profile:reviewer"],
			"please review",
		);
		expect(posted.message.taskId).toBe(dispatched.task.id);
		expect(posted.queue?.targets).toEqual(["profile:reviewer"]);
		expect(store.messages.get(posted.message.id)?.taskId).toBe(dispatched.task.id);

		const run = await waitFor(() =>
			store.runs
				.list({ taskId: dispatched.task.id })
				.find((candidate) => candidate.sourceId === posted.message.id && candidate.status === "completed"),
		);
		expect(run.queueEntryId).toBe(posted.queue!.id);
		const response = store.messages.get(run.responseMessageId!)!;
		expect(response.kind).toBe("agent_response");
		expect(response.bodyMd).toContain("THREAD_POST_DONE");
		expect(store.messages.get(posted.message.id)?.dispatchRefs).toContainEqual(
			expect.objectContaining({ targetId: "profile:reviewer", phase: "settled" }),
		);
		expect(daemon.health().status).toBe("ready");

		const queuesBefore = queueRowCount(store);
		const messagesBefore = messageCount(store, dispatched.thread.id);
		const noTask = cli(dataDir, [
			"thread",
			"post",
			dispatched.thread.id,
			"missing task binding",
			"--to",
			"profile:reviewer",
		]);
		expect(noTask.status).not.toBe(0);
		expect(noTask.stderr).toContain("--task");
		expect(queueRowCount(store)).toBe(queuesBefore);
		expect(messageCount(store, dispatched.thread.id)).toBe(messagesBefore);

		const extraBacklog = cliJson<{ id: string }>(dataDir, [
			"backlog",
			"create",
			"--title",
			"No worktree",
			"--summary",
			"negative",
			"--tag",
			"feature:F016",
			"--priority",
			"p2",
		]);
		const noWorktreeTask = cliJson<{ id: string }>(dataDir, [
			"task",
			"create",
			"--thread",
			dispatched.thread.id,
			"--title",
			"No worktree",
			"--why",
			"negative",
			"--backlog",
			extraBacklog.id,
		]);
		const missingWorktree = cli(dataDir, [
			"thread",
			"post",
			dispatched.thread.id,
			"no worktree",
			"--to",
			"profile:coder",
			"--task",
			noWorktreeTask.id,
		]);
		expect(missingWorktree.status).not.toBe(0);
		expect(missingWorktree.stderr).toContain("has no worktree");
		expect(queueRowCount(store)).toBe(queuesBefore);
		expect(messageCount(store, dispatched.thread.id)).toBe(messagesBefore);

		const noSession = cli(dataDir, [
			"thread",
			"post",
			dispatched.thread.id,
			"no session",
			"--to",
			"profile:reviewer-2",
			"--task",
			dispatched.task.id,
		]);
		expect(noSession.status).not.toBe(0);
		expect(noSession.stderr).toContain("0 active sessions");
		expect(queueRowCount(store)).toBe(queuesBefore);
		expect(messageCount(store, dispatched.thread.id)).toBe(messagesBefore);
	}, 90_000);

	it("I2/I8: multi-target post runs both workers and withdraws a missing-session target with audit", async () => {
		const { dataDir, installationRoot } = setupDirs();
		bootstrapProfiles(dataDir, [{ id: "profile:no-session", role: "reviewer", displayName: "No Session" }]);
		const mock = await startMockAnthropic(() => textResponse("MULTI_TARGET_DONE"));
		mocks.push(mock);
		const { daemon, store } = await startE2eDaemon(
			dataDir,
			installationRoot,
			mock.baseUrl,
			["mock-coder", "mock-reviewer"],
			{ pollIntervalMs: 60_000, sweepIntervalMs: 60_000 },
		);
		const dispatched = createBacklogAndDispatch(dataDir, "profile:coder", "kickoff");
		prepareTask(dataDir, dispatched.task.id, ["profile:coder", "profile:reviewer"]);
		await daemon.controlPlane!.drainNow();
		await waitFor(() => store.runs.list({ taskId: dispatched.task.id }).find((run) => run.status === "completed"));

		const posted = postThread(
			dataDir,
			dispatched.thread.id,
			dispatched.task.id,
			["profile:coder", "profile:reviewer"],
			"parallel work",
		);
		expect(posted.queue?.targets.sort()).toEqual(["profile:coder", "profile:reviewer"]);
		await daemon.controlPlane!.drainNow();
		const runs = await waitFor(() => {
			const matched = store.runs
				.list({ taskId: dispatched.task.id })
				.filter((run) => run.sourceId === posted.message.id);
			return matched.length === 2 && matched.every((run) => run.status === "completed") ? matched : null;
		});
		expect(new Set(runs.map((run) => run.queueEntryId))).toEqual(new Set([posted.queue!.id]));
		const responses = runs.map((run) => store.messages.get(run.responseMessageId!)!);
		expect(responses.every((message) => message.kind === "agent_response")).toBe(true);
		expect(responses.every((message) => message.bodyMd.includes("MULTI_TARGET_DONE"))).toBe(true);
		expect(new Set(responses.map((message) => message.id)).size).toBe(2);
		const refs = store.messages.get(posted.message.id)?.dispatchRefs ?? [];
		expect(refs).toHaveLength(2);
		expect(refs.every((ref) => (ref as { phase?: string }).phase === "settled")).toBe(true);

		const mixedSource = store.messages.append({
			threadId: dispatched.thread.id,
			taskId: dispatched.task.id,
			authorKind: "system",
			authorId: "system:f016a-test",
			kind: "status",
			bodyMd: "system ingress with a missing session",
		});
		const mixedEntry = store.queue.admit({
			threadId: dispatched.thread.id,
			sourceId: mixedSource.id,
			sourceRecordId: dispatched.task.id,
			sourceKind: "message_wake",
			targets: ["profile:coder", "profile:no-session"],
			authorIntent: {
				"profile:coder": { intent: "next_work" },
				"profile:no-session": { intent: "next_work" },
			},
			priority: "normal",
			sourceCategory: "worker_retry",
			orderKey: `${mixedSource.createdAt}:${mixedSource.seq}`,
		});
		const drained = await daemon.controlPlane!.drainNow();
		expect(drained?.errors).toContainEqual(
			expect.objectContaining({
				queueEntryId: mixedEntry.id,
				targetProfileId: "profile:no-session",
				code: "invalid_state",
			}),
		);
		const goodRun = await waitFor(() =>
			store.runs
				.list({ taskId: dispatched.task.id })
				.find((run) => run.sourceId === mixedSource.id && run.status === "completed"),
		);
		expect(goodRun.recipientProfileId).toBe("profile:coder");
		expect(
			store.runs.list({ taskId: dispatched.task.id }).filter((run) => run.sourceId === mixedSource.id),
		).toHaveLength(1);
		expect(store.queue.get(mixedEntry.id)?.status).toBe("withdrawn");
		const audits = store.audit.listSubject(`queue:${mixedEntry.id}`, 50);
		expect(audits.some((entry) => entry.action === "queue_withdrawn")).toBe(true);
		expect(audits.some((entry) => entry.action === "dispatch_dead_lettered")).toBe(false);
	}, 90_000);

	it("I4/I8: schedule tick only enqueues, then drains real workers; missing session is typed", async () => {
		const { dataDir, installationRoot } = setupDirs();
		bootstrapProfiles(dataDir, [{ id: "profile:no-session", role: "reviewer", displayName: "No Session" }]);
		const mock = await startMockAnthropic(() => textResponse("SCHEDULED_WAKE_DONE"));
		mocks.push(mock);
		const { daemon, store } = await startE2eDaemon(
			dataDir,
			installationRoot,
			mock.baseUrl,
			["mock-coder", "mock-reviewer"],
			{ pollIntervalMs: 60_000, sweepIntervalMs: 60_000 },
		);
		const dispatched = createBacklogAndDispatch(dataDir, "profile:coder", "kickoff");
		prepareTask(dataDir, dispatched.task.id, ["profile:coder"]);
		await daemon.controlPlane!.drainNow();
		await waitFor(() => store.runs.list({ taskId: dispatched.task.id }).find((run) => run.status === "completed"));

		const now = Date.now();
		const goodSpec = cliJson<{ id: string }>(dataDir, [
			"schedule",
			"add",
			"--task",
			dispatched.task.id,
			"--thread",
			dispatched.thread.id,
			"--to",
			"profile:coder",
			"--body",
			"SCHEDULED_WAKE",
			"--every-ms",
			"60000",
			"--first-run-at",
			String(now - 1_000),
			"--priority",
			"urgent",
		]);
		const badSpec = cliJson<{ id: string }>(dataDir, [
			"schedule",
			"add",
			"--task",
			dispatched.task.id,
			"--thread",
			dispatched.thread.id,
			"--to",
			"profile:no-session",
			"--body",
			"MISSING_SESSION_WAKE",
			"--every-ms",
			"60000",
			"--first-run-at",
			String(now - 1_000),
			"--priority",
			"normal",
		]);
		const tick = cliJson<ScheduleTickOutput>(dataDir, ["schedule", "tick", "--at", String(now)]);
		expect(tick.materialized).toHaveLength(2);
		const goodOccurrence = tick.materialized.find((run) => run.specId === goodSpec.id);
		const badOccurrence = tick.materialized.find((run) => run.specId === badSpec.id);
		expect(goodOccurrence).toBeDefined();
		expect(badOccurrence).toBeDefined();
		expect(
			store.runs
				.list({ taskId: dispatched.task.id })
				.some((run) => run.sourceId === goodOccurrence!.sourceMessageId),
		).toBe(false);
		expect(
			store.runs.list({ taskId: dispatched.task.id }).some((run) => run.sourceId === badOccurrence!.sourceMessageId),
		).toBe(false);

		await daemon.controlPlane!.drainNow();
		const scheduledRun = await waitFor(() =>
			store.runs
				.list({ taskId: dispatched.task.id })
				.find((run) => run.sourceId === goodOccurrence!.sourceMessageId && run.status === "completed"),
		);
		expect(store.messages.get(scheduledRun.responseMessageId!)?.bodyMd).toContain("SCHEDULED_WAKE_DONE");
		expect(store.queue.get(badOccurrence!.queueEntryId)?.status).toBe("withdrawn");
		expect(
			store.runs.list({ taskId: dispatched.task.id }).some((run) => run.sourceId === badOccurrence!.sourceMessageId),
		).toBe(false);
		const audits = store.audit.listSubject(`queue:${badOccurrence!.queueEntryId}`, 50);
		expect(audits.some((entry) => entry.action === "queue_withdrawn")).toBe(true);
		expect(audits.some((entry) => entry.action === "dispatch_dead_lettered")).toBe(false);

		const duplicate = new ProactiveScheduleService(store).materialize(goodSpec.id, {
			occurrenceKey: goodOccurrence!.occurrenceKey,
			scheduledFor: now,
		});
		expect(duplicate.status).toBe("duplicate");

		cliJson(dataDir, ["schedule", "pause", goodSpec.id]);
		const paused = new ProactiveScheduleService(store).materialize(goodSpec.id, {
			occurrenceKey: "paused-f016a",
			scheduledFor: now,
		});
		expect(paused.status).toBe("skipped");
		expect(paused.run.reason).toMatchObject({ code: "schedule_paused" });
	}, 90_000);

	it("I6: a retryable model failure queues one real retry and completes", async () => {
		const { dataDir, installationRoot } = setupDirs();
		bootstrapProfiles(dataDir);
		let daemonRef: DaemonHandle | null = null;
		const mock = await startMockAnthropic(() => {
			const running = daemonRef?.controlPlane?.store.runs.list({ status: "running" }) ?? [];
			const attempt = running.sort((left, right) => right.startedAt - left.startedAt)[0]?.attempt ?? 1;
			return attempt === 1 ? errorResponse("mock model unavailable") : textResponse("RETRY_DONE");
		});
		mocks.push(mock);
		const { daemon, store } = await startE2eDaemon(dataDir, installationRoot, mock.baseUrl, ["mock-coder"]);
		daemonRef = daemon;
		const dispatched = createBacklogAndDispatch(dataDir, "profile:coder", "kickoff");
		prepareTask(dataDir, dispatched.task.id, ["profile:coder"]);

		const retryRun = await waitFor(() =>
			store.runs.list({ taskId: dispatched.task.id }).find((run) => run.attempt === 2 && run.status === "completed"),
		);
		const firstRun = store.runs.list({ taskId: dispatched.task.id }).find((run) => run.attempt === 1);
		expect(firstRun?.status).toBe("failed");
		expect(store.audit.latest(`run:${firstRun!.id}`, "run_retry_queued")).not.toBeNull();
		expect(store.runs.list({ taskId: dispatched.task.id }).filter((run) => run.attempt === 1)).toHaveLength(1);
		expect(store.runs.list({ taskId: dispatched.task.id })).toHaveLength(2);
		expect(store.messages.get(retryRun.responseMessageId!)?.bodyMd).toContain("RETRY_DONE");
	}, 90_000);

	it("I6: max attempts dead-letters with a human inbox item and no retry", async () => {
		const { dataDir, installationRoot } = setupDirs();
		bootstrapProfiles(dataDir);
		const mock = await startMockAnthropic(() => errorResponse("mock model unavailable"));
		mocks.push(mock);
		const { store } = await startE2eDaemon(dataDir, installationRoot, mock.baseUrl, ["mock-coder"], {
			maxAttempts: 1,
		});
		const dispatched = createBacklogAndDispatch(dataDir, "profile:coder", "kickoff");
		prepareTask(dataDir, dispatched.task.id, ["profile:coder"]);

		const failedRun = await waitFor(() =>
			store.runs.list({ taskId: dispatched.task.id }).find((run) => run.status === "failed"),
		);
		await waitFor(() =>
			store.inbox.list({ taskId: dispatched.task.id }).find((item) => item.kind === "humanGuidance"),
		);
		expect(store.audit.latest(`run:${failedRun.id}`, "run_dead_lettered")).not.toBeNull();
		expect(store.audit.latest(`run:${failedRun.id}`, "run_retry_queued")).toBeNull();
		expect(store.runs.list({ taskId: dispatched.task.id })).toHaveLength(1);
		expect(store.queue.pendingCount()).toBe(0);
		const escalation = store.inbox.list({ taskId: dispatched.task.id });
		expect(escalation[0]?.payload).toMatchObject({ kind: "dead_letter", attempts: 1 });
	}, 90_000);

	it("I10: a cross-thread A2A target is rejected without a queue entry or run", () => {
		const base = createW5AFixture();
		try {
			base.store.threads.create({ id: "thread-other", title: "Other thread" });
			base.store.profiles.create({
				id: "profile:other-thread",
				role: "reviewer",
				displayName: "Other Thread",
				provider: "test",
				model: "model-reviewer",
				modelFamily: "test-family",
				toolPolicyProfile: "default",
			});
			base.store.sessions.create({
				id: "session-other-thread",
				threadId: "thread-other",
				taskId: "task-1",
				profileId: "profile:other-thread",
				role: "reviewer",
				effectiveToolPolicy: "default",
				provider: "test",
				model: "model-reviewer",
				modelFamily: "test-family",
				seq: 0,
				userId: "user-1",
				workingDirectory: base.dataDir,
			});
			const source = base.createSourceMessage("cross-thread negative");
			const sourceRun = base.createRun({
				id: "run-cross-thread",
				profileId: "profile:coder",
				role: "coder",
				sessionId: "session-coder",
				sourceId: source.id,
			});
			const handlers = createA2AHandlers({
				store: base.store,
				principal: resolveRunPrincipal(base.store, sourceRun.id),
			});
			expect(() =>
				handlers.send({ kind: "question", targets: ["profile:other-thread"], bodyMd: "must not route" }),
			).toThrowError(expect.objectContaining({ code: "invalid_input" }));
			expect(base.store.queue.listPending()).toHaveLength(0);
			expect(base.store.runs.list({ taskId: "task-1" })).toHaveLength(1);
			expect(base.store.handoffs.list()).toHaveLength(0);
		} finally {
			base.cleanup();
		}
	});
});
