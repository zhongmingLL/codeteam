import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DaemonHandle, openControlStore, startDaemon } from "../src/index.ts";
import { startMockAnthropic, textResponse, toolCallResponse } from "./helpers/mock-anthropic.ts";

const CODETEAM_CLI_PATH = join(process.cwd(), "dist", "cli.js");
const PI_CLI_PATH = join(import.meta.dirname, "..", "..", "coding-agent", "dist", "cli.js");
const daemons: DaemonHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const daemon of daemons.splice(0)) await daemon.close().catch(() => {});
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

function messagesOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
	return Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
}

function lastToolName(body: Record<string, unknown>): string | null {
	const messages = messagesOf(body);
	const last = messages.at(-1);
	if (!last || !Array.isArray(last.content)) return null;
	const result = last.content.find(
		(part) => part && typeof part === "object" && (part as { type?: unknown }).type === "tool_result",
	) as { tool_use_id?: unknown } | undefined;
	if (!result || typeof result.tool_use_id !== "string") return null;
	for (let index = messages.length - 2; index >= 0; index -= 1) {
		const content = messages[index]?.content;
		if (!Array.isArray(content)) continue;
		const toolUse = content.find(
			(part) =>
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "tool_use" &&
				(part as { id?: unknown }).id === result.tool_use_id,
		) as { name?: unknown } | undefined;
		if (toolUse && typeof toolUse.name === "string") return toolUse.name;
	}
	return null;
}

function handoffIdFromPrompt(body: Record<string, unknown>): string | null {
	const match = /Handoff ID: ([A-Za-z0-9._:-]+)/.exec(JSON.stringify(body.messages ?? []));
	return match?.[1] ?? null;
}

function mockCoder(body: Record<string, unknown>): string {
	const lastTool = lastToolName(body);
	if (lastTool === "handoff_create") return textResponse("CODER_HANDOFF_CREATED");
	if (lastTool === "a2a_send") {
		return toolCallResponse("handoff_create", {
			kind: "review_request",
			targets: ["profile:reviewer"],
			subject: "Review daemon E2E",
			subjectRef: "pr:owner/repo#daemon",
			actionFamily: "review",
			successorSlot: "reviewer",
			expectedArtifact: "artifact:review",
			deadline: Date.now() + 60 * 60 * 1000,
			idempotencyKey: "idem-daemon-e2e",
			terminalPredicate: { kind: "run_completed" },
			bodyMd: "Please review the daemon E2E handoff.",
		});
	}
	return toolCallResponse("a2a_send", {
		kind: "status",
		targets: ["profile:reviewer"],
		bodyMd: "Creating a review handoff.",
		requestId: "req-daemon-e2e",
	});
}

function mockReviewer(body: Record<string, unknown>): string {
	const handoffId = handoffIdFromPrompt(body);
	if (!handoffId) return textResponse("REVIEWER_ACK");
	const lastTool = lastToolName(body);
	if (lastTool === "handoff_claim") {
		return toolCallResponse("handoff_complete", {
			handoffId,
			evidenceRef: "review:approved",
			result: { verdict: "approved" },
		});
	}
	if (lastTool === "handoff_complete") return textResponse("REVIEW_COMPLETE");
	return toolCallResponse("handoff_claim", { handoffId });
}

async function waitFor<T>(check: () => T | null | undefined | false, timeoutMs = 30_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const value = check();
		if (value) return value;
		if (Date.now() > deadline) throw new Error("timed out waiting for daemon E2E state");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function setupDirs() {
	const root = mkdtempSync(join(tmpdir(), "codeteam-daemon-a2a-"));
	dirs.push(root);
	const dataDir = join(root, "data");
	const installationRoot = join(root, "install");
	mkdirSync(installationRoot);
	return { root, dataDir, installationRoot };
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

function bootstrapProfiles(dataDir: string): void {
	cliJson(dataDir, ["auth", "init"]);
	cliJson(dataDir, ["profile", "seed"]);
	cliJson(dataDir, [
		"profile",
		"add",
		"--id",
		"profile:coder",
		"--role",
		"coder",
		"--display-name",
		"Coder",
		"--provider",
		"mock",
		"--model",
		"mock-coder",
		"--family",
		"test",
	]);
	cliJson(dataDir, [
		"profile",
		"add",
		"--id",
		"profile:reviewer",
		"--role",
		"reviewer",
		"--display-name",
		"Reviewer",
		"--provider",
		"mock",
		"--model",
		"mock-reviewer",
		"--family",
		"test",
	]);
}

describe("daemon A2A end-to-end", () => {
	it("runs CLI producer -> daemon control plane -> real workers -> consumed handoff", async () => {
		const { dataDir, installationRoot } = setupDirs();
		bootstrapProfiles(dataDir);
		const mock = await startMockAnthropic(({ model, body }) => {
			if (model === "mock-coder") return mockCoder(body);
			if (model === "mock-reviewer") return mockReviewer(body);
			return textResponse("OK");
		});
		try {
			writeModels(join(dataDir, "worker-agent"), mock.baseUrl, ["mock-coder", "mock-reviewer"]);
			const daemon = await startDaemon({
				installationRoot,
				dataDir,
				runningRevision: "test-rev",
				controlPlane: { cliPath: PI_CLI_PATH, offline: true, pollIntervalMs: 50, sweepIntervalMs: 1_000 },
			});
			daemons.push(daemon);
			daemon.markReady();
			expect(daemon.controlPlane?.ready().started).toBe(true);

			const backlog = cliJson<{ id: string }>(dataDir, [
				"backlog",
				"create",
				"--title",
				"Daemon A2A",
				"--summary",
				"Real CLI daemon worker",
				"--tag",
				"feature:F015",
				"--priority",
				"p1",
			]);
			cliJson(dataDir, ["backlog", "approve", backlog.id]);
			const dispatched = cliJson<{
				thread: { id: string };
				task: { id: string };
				message: { id: string };
				queueEntry: { id: string };
			}>(dataDir, [
				"backlog",
				"dispatch",
				backlog.id,
				"--to",
				"profile:coder",
				"--phase",
				"coding",
				"--body",
				"Kickoff",
			]);
			expect(daemon.controlPlane!.store.messages.get(dispatched.message.id)?.taskId).toBe(dispatched.task.id);

			cliJson(dataDir, [
				"task",
				"prepare",
				dispatched.task.id,
				"--profile",
				"profile:coder",
				"--profile",
				"profile:reviewer",
			]);

			const handoff = await waitFor(
				() => daemon.controlPlane!.store.handoffs.list({ taskId: dispatched.task.id })[0],
				60_000,
			);
			await waitFor(() => daemon.controlPlane!.store.handoffs.get(handoff.id)?.status === "consumed", 60_000);
			const store = daemon.controlPlane!.store;
			const runs = store.runs.list({ taskId: dispatched.task.id });
			expect(runs.length).toBeGreaterThanOrEqual(3);
			expect(runs.every((run) => run.status === "completed")).toBe(true);
			const toolNames = runs.flatMap((run) =>
				store.runs
					.listEvents(run.id, 300)
					.filter((event) => event.kind === "tool_call")
					.map((event) => (event.payload as { toolName?: string }).toolName ?? ""),
			);
			expect(toolNames).toContain("a2a_send");
			expect(toolNames).toContain("handoff_create");
			expect(toolNames).toContain("handoff_claim");
			expect(toolNames).toContain("handoff_complete");
			expect(
				store.audit
					.listSubject(`queue:${dispatched.queueEntry.id}`, 50)
					.some((entry) => entry.action === "dispatch_dead_lettered"),
			).toBe(false);

			const before = store.queue.pendingCount();
			const negative = cli(dataDir, [
				"thread",
				"post",
				dispatched.thread.id,
				"missing task binding",
				"--to",
				"profile:coder",
			]);
			expect(negative.status).not.toBe(0);
			expect(negative.stderr).toContain("--task");
			expect(store.queue.pendingCount()).toBe(before);
			expect(daemon.health().status).toBe("ready");
		} finally {
			await mock.close();
		}
	}, 90_000);

	it("recovers a running run after a cold control-plane boot and completes the retry", async () => {
		const { dataDir, installationRoot } = setupDirs();
		bootstrapProfiles(dataDir);
		const backlog = cliJson<{ id: string }>(dataDir, [
			"backlog",
			"create",
			"--title",
			"Daemon recovery",
			"--summary",
			"Cold boot recovery",
			"--tag",
			"feature:F015",
			"--priority",
			"p1",
		]);
		cliJson(dataDir, ["backlog", "approve", backlog.id]);
		const dispatched = cliJson<{
			thread: { id: string };
			task: { id: string };
			message: { id: string };
			queueEntry: { id: string };
		}>(dataDir, [
			"backlog",
			"dispatch",
			backlog.id,
			"--to",
			"profile:coder",
			"--phase",
			"coding",
			"--body",
			"Kickoff",
		]);
		const prepared = cliJson<{ sessions: Array<{ id: string; role: string }> }>(dataDir, [
			"task",
			"prepare",
			dispatched.task.id,
			"--profile",
			"profile:coder",
		]);
		const seed = openControlStore({ dataDir });
		let interruptedRunId: string;
		try {
			const pending = seed.queue.get(dispatched.queueEntry.id)!;
			expect(pending.status).toBe("queued");
			seed.queue.claim(pending.id, { claimId: "seed-claim" });
			const cutover = seed.cutoverQueueEntry({
				queueEntryId: pending.id,
				claimId: "seed-claim",
				targetProfileId: "profile:coder",
				taskId: dispatched.task.id,
				role: prepared.sessions[0]!.role,
				agentSessionId: prepared.sessions[0]!.id,
				provider: "mock",
				model: "mock-coder",
				modelFamily: "test",
				responseBody: "seed",
			});
			interruptedRunId = cutover.run.id;
		} finally {
			seed.close();
		}

		const mock = await startMockAnthropic(({ model }) =>
			model === "mock-coder" ? textResponse("RECOVERED_AFTER_RESTART") : textResponse("OK"),
		);
		try {
			writeModels(join(dataDir, "worker-agent"), mock.baseUrl, ["mock-coder"]);
			const daemon = await startDaemon({
				installationRoot,
				dataDir,
				runningRevision: "test-rev",
				controlPlane: { cliPath: PI_CLI_PATH, offline: true, pollIntervalMs: 50, sweepIntervalMs: 1_000 },
			});
			daemons.push(daemon);
			daemon.markReady();
			expect(daemon.controlPlane?.ready().recoveredInterruptedRuns).toBe(1);
			const store = daemon.controlPlane!.store;
			expect(store.runs.get(interruptedRunId)?.status).toBe("interrupted");
			await waitFor(
				() =>
					store.runs
						.list({ taskId: dispatched.task.id })
						.some(
							(run) =>
								run.id !== interruptedRunId &&
								run.status === "completed" &&
								(store.messages.get(run.responseMessageId ?? "")?.bodyMd.includes("RECOVERED_AFTER_RESTART") ??
									false),
						),
				60_000,
			);
			expect(store.audit.latest(`run:${interruptedRunId}`, "run_retry_queued")).not.toBeNull();
		} finally {
			await mock.close();
		}
	}, 90_000);
});
