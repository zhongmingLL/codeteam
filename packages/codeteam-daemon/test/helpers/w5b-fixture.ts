import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ControlStore, DispatchService, openControlStore } from "../../src/index.ts";
import { WorkerRuntime } from "../../src/workers/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_WORKER_PATH = join(here, "..", "fixtures", "fake-rpc-worker.mjs");
export const REAL_EXTENSION_PATH = join(here, "..", "..", "src", "workers", "worker-extension.ts");

export interface W5BFixture {
	readonly store: ControlStore;
	readonly runtime: WorkerRuntime;
	readonly dispatch: DispatchService;
	readonly dataDir: string;
	readonly worktree: string;
	readonly workerAgentDir: string;
	readonly sessionDir: string;
	readonly argvFile: string;
	readonly transport: string;
	now(): number;
	advance(ms: number): number;
	createSource(bodyMd?: string): ReturnType<ControlStore["messages"]["append"]>;
	enqueue(input: {
		sourceId: string;
		target?: string;
		priority?: "normal" | "urgent";
		chainMetadata?: Record<string, unknown>;
	}): ReturnType<ControlStore["queue"]["admit"]>;
	cleanup(): Promise<void>;
}

export function createW5BFixture(
	options: {
		env?: Record<string, string>;
		workerCrash?: boolean;
		workerHang?: boolean;
		cliPath?: string;
		sessionProvider?: string;
		sessionModelForRole?: Record<string, string>;
		offline?: boolean;
	} = {},
): W5BFixture {
	const dataDir = mkdtempSync(join(tmpdir(), "codeteam-w5b-"));
	const worktree = join(dataDir, "worktree");
	const workerAgentDir = join(dataDir, "worker-agent");
	const sessionDir = join(dataDir, "pi-sessions");
	const argvFile = join(dataDir, "fake-argv.jsonl");
	mkdirSync(worktree, { recursive: true });
	mkdirSync(workerAgentDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(worktree, "README.md"), "# fixture\n", "utf8");
	let current = 1_700_000_000_000;
	const clock = () => current;
	const store = openControlStore({ dataDir, clock });
	store.seedIdentity({
		eval: { provider: "test", model: "eval", modelFamily: "test" },
		compress: { provider: "test", model: "compress", modelFamily: "test" },
	});
	store.backlog.create({
		id: "backlog-w5b",
		userId: "user-1",
		title: "W5b",
		summary: "W5b",
		priority: "p1",
		tags: ["feature:F009"],
		createdByKind: "user",
		createdById: "user-1",
	});
	store.threads.create({ id: "thread-w5b", title: "W5b" });
	for (const profile of [
		{ id: "profile:coder", role: "coder", displayName: "Coder" },
		{ id: "profile:reviewer", role: "reviewer", displayName: "Reviewer" },
		{ id: "profile:verifier", role: "verifier", displayName: "Verifier" },
	] as const) {
		store.profiles.create({
			id: profile.id,
			role: profile.role,
			displayName: profile.displayName,
			provider: "test",
			model: "fake",
			modelFamily: "test",
			toolPolicyProfile: "default",
		});
	}
	store.tasks.create({
		id: "task-w5b",
		kind: "work",
		threadId: "thread-w5b",
		title: "W5b task",
		why: "Exercise RPC worker runtime",
		ownerProfileId: "profile:coder",
		createdBy: "user-1",
		userId: "user-1",
		backlogItemId: "backlog-w5b",
		repo: "owner/repo",
		baseRef: "main",
		baseSha: "a".repeat(40),
		worktree,
		branch: "feat/w5b",
	});
	for (const profile of [
		{ id: "profile:coder", role: "coder" },
		{ id: "profile:reviewer", role: "reviewer" },
		{ id: "profile:verifier", role: "verifier" },
	] as const) {
		store.sessions.create({
			id: `session-${profile.role}`,
			threadId: "thread-w5b",
			taskId: "task-w5b",
			profileId: profile.id,
			role: profile.role,
			effectiveToolPolicy: "default",
			provider: options.sessionProvider ?? "test",
			model: options.sessionModelForRole?.[profile.role] ?? "fake",
			modelFamily: "test",
			seq: 0,
			userId: "user-1",
			workingDirectory: worktree,
		});
	}
	const env: Record<string, string> = {
		...(Object.fromEntries(
			Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
		) as Record<string, string>),
		...options.env,
		FAKE_ARGV_FILE: argvFile,
		FAKE_SESSION_ID: "fake-session",
		FAKE_SESSION_FILE: join(sessionDir, "fake-session.jsonl"),
		...(options.workerCrash ? { FAKE_WORKER_CRASH_ON_PROMPT: "1" } : {}),
		...(options.workerHang ? { FAKE_WORKER_HANG_ON_PROMPT: "1" } : {}),
	};
	writeFileSync(env.FAKE_SESSION_FILE, "{}\n", "utf8");
	const runtime = new WorkerRuntime({
		store,
		dataDir,
		clock,
		heartbeatIntervalMs: 1_000,
		leaseMs: 2_000,
		maxAttempts: 2,
		cliPath: options.cliPath ?? FAKE_WORKER_PATH,
		extensionPath: REAL_EXTENSION_PATH,
		workerAgentDir,
		sessionDir,
		env,
		promptTimeoutMs: 5_000,
		offline: options.offline ?? true,
	});
	const dispatch = new DispatchService(store, runtime.executor, clock, runtime.dispatchHooks);
	return {
		store,
		runtime,
		dispatch,
		dataDir,
		worktree,
		workerAgentDir,
		sessionDir,
		argvFile,
		transport: runtime.control.socketPath,
		now: () => current,
		advance: (ms) => {
			current += ms;
			return current;
		},
		createSource: (bodyMd = "Implement the task.") =>
			store.messages.append({
				threadId: "thread-w5b",
				taskId: "task-w5b",
				authorKind: "user",
				authorId: "user-1",
				kind: "chat",
				bodyMd,
			}),
		enqueue: (input) =>
			store.queue.admit({
				threadId: "thread-w5b",
				sourceId: input.sourceId,
				sourceKind: "message_wake",
				targets: [input.target ?? "profile:coder"],
				authorIntent: {
					[input.target ?? "profile:coder"]: {
						intent: "next_work",
						...(input.chainMetadata ? { chainMetadata: input.chainMetadata } : {}),
					},
				},
				priority: input.priority ?? "normal",
				sourceCategory: "w5b-test",
				orderKey: `${store.messages.get(input.sourceId)?.seq ?? 0}`,
			}),
		cleanup: async () => {
			await runtime.dispose().catch(() => {});
			store.close();
			rmSync(dataDir, { recursive: true, force: true });
		},
	};
}
