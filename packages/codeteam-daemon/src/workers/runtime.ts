import { rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveInvocationTokenDir } from "../auth/tokens.ts";
import { type RecoveryReport, recoverControlPlane } from "../control/recovery.ts";
import type { ControlStore } from "../control/store.ts";
import type { Run, Worker } from "../control/stores/types.ts";
import { settleRunTerminal } from "../dispatch/settle.ts";
import type { DispatchServiceHooks } from "../dispatch/types.ts";
import type { ObservabilityRuntime } from "../observability/runtime.ts";
import { WorkerControlServer } from "./control.ts";
import { RpcAgentExecutor } from "./executor.ts";
import { WorkerFailurePolicy } from "./failure-policy.ts";
import { WorkerHarness } from "./harness.ts";
import { WorkerRegistry, type WorkerRegistryOptions } from "./registry.ts";

export interface WorkerRuntimeOptions extends WorkerRegistryOptions {
	readonly store: ControlStore;
	readonly dataDir: string;
	readonly cliPath: string;
	readonly workerAgentDir: string;
	readonly sessionDir: string;
	readonly controlSocketPath?: string;
	readonly extensionPath?: string;
	readonly promptTimeoutMs?: number;
	readonly offline?: boolean;
	readonly extraArgs?: readonly string[];
	readonly env?: Record<string, string | undefined>;
	readonly maxAttempts?: number;
	readonly observability?: ObservabilityRuntime | null;
}

export interface StaleSweepResult {
	readonly staleWorkerIds: string[];
	readonly interruptedRunIds: string[];
	readonly reattachSessionIds: string[];
}

export interface WorkerRecoveryResult {
	readonly sweep: StaleSweepResult;
	readonly recovery: RecoveryReport;
	readonly interruptedRunIds: string[];
}

export interface WorkerDrainResult {
	readonly drained: boolean;
	readonly interruptedRunIds: string[];
	readonly reattachSessionIds: string[];
}

export class WorkerRuntime {
	readonly store: ControlStore;
	readonly dataDir: string;
	readonly registry: WorkerRegistry;
	readonly control: WorkerControlServer;
	readonly harness: WorkerHarness;
	readonly executor: RpcAgentExecutor;
	readonly failurePolicy: WorkerFailurePolicy;
	readonly dispatchHooks: DispatchServiceHooks;
	private readonly clock: () => number;

	constructor(options: WorkerRuntimeOptions) {
		this.store = options.store;
		this.dataDir = options.dataDir;
		this.clock = options.clock ?? Date.now;
		this.registry = new WorkerRegistry(options.store, {
			clock: this.clock,
			heartbeatIntervalMs: options.heartbeatIntervalMs,
			leaseMs: options.leaseMs,
		});
		this.control = new WorkerControlServer({
			store: options.store,
			registry: this.registry,
			dataDir: options.dataDir,
			socketPath: options.controlSocketPath,
			clock: this.clock,
		});
		this.harness = new WorkerHarness({
			store: options.store,
			registry: this.registry,
			dataDir: options.dataDir,
			cliPath: options.cliPath,
			workerAgentDir: options.workerAgentDir,
			sessionDir: options.sessionDir,
			controlSocketPath: this.control.socketPath,
			extensionPath: options.extensionPath,
			promptTimeoutMs: options.promptTimeoutMs,
			offline: options.offline,
			extraArgs: options.extraArgs,
			env: options.env,
			clock: this.clock,
		});
		this.executor = new RpcAgentExecutor({
			store: options.store,
			harness: this.harness,
			dataDir: options.dataDir,
			clock: this.clock,
			observability: options.observability ?? null,
		});
		this.failurePolicy = new WorkerFailurePolicy({
			store: options.store,
			maxAttempts: options.maxAttempts,
			clock: this.clock,
		});
		this.dispatchHooks = {
			onRunTerminal: (run, input) => {
				this.failurePolicy.onRunTerminal(run, input.reason);
			},
		};
	}

	async start(): Promise<string> {
		return await this.control.start();
	}

	async recover(options: { activeRunIds?: Iterable<string>; now?: number } = {}): Promise<WorkerRecoveryResult> {
		const now = options.now ?? this.clock();
		const activeRunIds = new Set(options.activeRunIds ?? []);
		const sweep = await this.sweepStale(now, activeRunIds);
		const interruptedRunIds: string[] = [...sweep.interruptedRunIds];
		for (const run of this.store.runs.list({ status: "running" })) {
			if (activeRunIds.has(run.id)) continue;
			const settled = settleRunTerminal(
				this.store,
				run.id,
				{
					status: "interrupted",
					reason: "daemon_restarted",
					bodyMd: "Execution interrupted: the daemon restarted before this run finished.",
					actorRef: "system:recovery",
				},
				this.clock,
			);
			if (settled.changed) {
				interruptedRunIds.push(settled.run.id);
				this.failurePolicy.onRunTerminal(settled.run, "daemon_restarted");
				cleanupRunToken(this.dataDir, settled.run.id);
			}
		}
		const recovery = recoverControlPlane(this.store, { activeRunIds, now });
		for (const session of this.store.sessions.list({ status: "active" })) {
			if (!session.workerId) continue;
			const worker = this.store.workers.get(session.workerId);
			if (!worker || worker.state === "stale" || worker.state === "retired") {
				this.registry.markSessionReattachPending(session.id);
			}
		}
		return { sweep, recovery, interruptedRunIds };
	}

	async sweepStale(now = this.clock(), activeRunIds: Iterable<string> = []): Promise<StaleSweepResult> {
		const active = new Set(activeRunIds);
		const staleWorkerIds: string[] = [];
		const interruptedRunIds: string[] = [];
		const reattachSessionIds: string[] = [];
		for (const worker of this.registry.staleWorkers(now)) {
			if (this.store.runs.list({ workerId: worker.id, status: "running" }).some((run) => active.has(run.id))) {
				continue;
			}
			staleWorkerIds.push(worker.id);
			this.registry.markStale(worker.id, "lease_expired");
			interruptedRunIds.push(...this.settleWorkerRuns(worker.id, "worker_stale", active));
			reattachSessionIds.push(...this.markWorkerSessionsReattach(worker.id));
			await this.harness.releaseWorker(worker.id, "stale", { keepBinding: true }).catch(() => {});
			cleanupWorkerTokenDir(this.dataDir, worker.id);
		}
		return { staleWorkerIds, interruptedRunIds, reattachSessionIds };
	}

	workerSnapshots() {
		return this.registry.listSnapshots();
	}

	async drainWorker(workerId: string, timeoutMs = 30_000): Promise<WorkerDrainResult> {
		this.registry.requestDrain(workerId);
		if (this.store.runs.list({ workerId, status: "running" }).length === 0) {
			const reattachSessionIds = this.markWorkerSessionsReattach(workerId);
			await this.harness.releaseWorker(workerId, "drained", { keepBinding: true });
			return { drained: true, interruptedRunIds: [], reattachSessionIds };
		}
		const deadline = Date.now() + Math.max(0, timeoutMs);
		while (Date.now() < deadline) {
			if (this.store.runs.list({ workerId, status: "running" }).length === 0) {
				const reattachSessionIds = this.markWorkerSessionsReattach(workerId);
				await this.harness.releaseWorker(workerId, "drained", { keepBinding: true });
				return { drained: true, interruptedRunIds: [], reattachSessionIds };
			}
			await sleep(25);
		}
		this.registry.markStale(workerId, "drain_timeout");
		const interruptedRunIds = this.settleWorkerRuns(workerId, "drain_timeout");
		const reattachSessionIds = this.markWorkerSessionsReattach(workerId);
		await this.harness.releaseWorker(workerId, "drain_timeout", { keepBinding: true });
		return { drained: false, interruptedRunIds, reattachSessionIds };
	}

	async drainAll(timeoutMs = 30_000): Promise<WorkerDrainResult[]> {
		const results: WorkerDrainResult[] = [];
		for (const worker of this.store.workers.list({ state: "online" })) {
			results.push(await this.drainWorker(worker.id, timeoutMs));
		}
		return results;
	}

	runningRunsForWorker(worker: Worker): Run[] {
		return this.store.runs.list({ workerId: worker.id, status: "running" });
	}

	async dispose(reason = "shutdown"): Promise<void> {
		await this.harness.releaseAll(reason);
		await this.control.stop();
	}

	private markWorkerSessionsReattach(workerId: string): string[] {
		const sessionIds: string[] = [];
		for (const session of this.store.sessions.list()) {
			if (session.workerId !== workerId || session.status !== "active") continue;
			if (session.workerBindingState === "re_attach_pending") continue;
			this.registry.markSessionReattachPending(session.id);
			sessionIds.push(session.id);
		}
		return sessionIds;
	}

	private settleWorkerRuns(workerId: string, reason: string, activeRunIds: Set<string> = new Set()): string[] {
		const runIds: string[] = [];
		for (const run of this.store.runs.list({ workerId, status: "running" })) {
			if (activeRunIds.has(run.id)) continue;
			const settled = settleRunTerminal(
				this.store,
				run.id,
				{ status: "interrupted", reason, actorRef: "system:worker" },
				this.clock,
			);
			if (!settled.changed) continue;
			runIds.push(settled.run.id);
			this.failurePolicy.onRunTerminal(settled.run, reason);
			cleanupRunToken(this.dataDir, settled.run.id);
		}
		return runIds;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupRunToken(dataDir: string, runId: string): void {
	try {
		unlinkSync(join(resolveInvocationTokenDir(dataDir), `${runId}.token`));
	} catch {
		// Already gone or never written.
	}
}

function cleanupWorkerTokenDir(dataDir: string, workerId: string): void {
	try {
		rmSync(join(dataDir, "worker-runs", workerId), { recursive: true, force: true });
	} catch {
		// Best effort; the directory is inside the daemon data dir.
	}
}
