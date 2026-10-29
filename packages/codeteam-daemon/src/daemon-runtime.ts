import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HandoffResolution } from "./a2a/terminal.ts";
import { HandoffTerminalResolver } from "./a2a/terminal.ts";
import { type ControlStore, openControlStore } from "./control/store.ts";
import { DispatchService } from "./dispatch/service.ts";
import type { DispatchDrainResult } from "./dispatch/types.ts";
import { WorkerRuntime } from "./workers/runtime.ts";

export interface DaemonControlPlaneOptions {
	readonly dataDir: string;
	readonly cliPath?: string;
	readonly workerAgentDir?: string;
	readonly sessionDir?: string;
	readonly controlSocketPath?: string;
	readonly extensionPath?: string;
	readonly offline?: boolean;
	readonly promptTimeoutMs?: number;
	readonly maxAttempts?: number;
	readonly pollIntervalMs?: number;
	readonly sweepIntervalMs?: number;
	readonly env?: Record<string, string | undefined>;
}

export interface DaemonControlPlaneReady {
	readonly started: boolean;
	readonly controlSocket: string;
	readonly recoveredInterruptedRuns: number;
	readonly pendingQueueEntries: number;
	readonly lastDrainAt: number | null;
}

export class DaemonControlPlane {
	readonly store: ControlStore;
	readonly runtime: WorkerRuntime;
	readonly dispatch: DispatchService;
	readonly resolver: HandoffTerminalResolver;
	readonly dataDir: string;
	private readonly pollIntervalMs: number;
	private readonly sweepIntervalMs: number;
	private started = false;
	private closing = false;
	private drainTimer: ReturnType<typeof setInterval> | null = null;
	private sweepTimer: ReturnType<typeof setInterval> | null = null;
	private ticking: Promise<DispatchDrainResult | null> | null = null;
	private lastDrainAt: number | null = null;
	private recoveredInterruptedRuns = 0;
	private lastResolution: readonly HandoffResolution[] = [];

	constructor(options: DaemonControlPlaneOptions) {
		this.dataDir = options.dataDir;
		this.store = openControlStore({ dataDir: options.dataDir });
		this.store.seedIdentity();
		this.resolver = new HandoffTerminalResolver({ store: this.store });
		this.runtime = new WorkerRuntime({
			store: this.store,
			dataDir: options.dataDir,
			cliPath: options.cliPath ?? resolvePiCliPath(),
			workerAgentDir: options.workerAgentDir ?? join(options.dataDir, "worker-agent"),
			sessionDir: options.sessionDir ?? join(options.dataDir, "pi-sessions"),
			controlSocketPath: options.controlSocketPath,
			extensionPath: options.extensionPath,
			promptTimeoutMs: options.promptTimeoutMs,
			offline: options.offline ?? true,
			env: options.env,
			maxAttempts: options.maxAttempts,
		});
		this.dispatch = new DispatchService(this.store, this.runtime.executor, Date.now, {
			onRunTerminal: (run, input) => {
				this.runtime.dispatchHooks.onRunTerminal?.(run, input);
				try {
					this.resolver.onRunTerminal(run);
				} catch (error) {
					this.store.audit.append({
						actor: "system:handoff-resolver",
						action: "handoff_resolution_failed",
						subject: `run:${run.id}`,
						args: { message: error instanceof Error ? error.message : String(error) },
					});
				}
			},
		});
		this.pollIntervalMs = Math.max(options.pollIntervalMs ?? 250, 25);
		this.sweepIntervalMs = Math.max(options.sweepIntervalMs ?? 30_000, 1_000);
	}

	get controlSocket(): string {
		return this.runtime.control.socketPath;
	}

	async start(): Promise<void> {
		if (this.started) return;
		try {
			await this.runtime.start();
			const recovery = await this.runtime.recover();
			this.recoveredInterruptedRuns = recovery.interruptedRunIds.length;
			this.lastResolution = this.resolver.resolvePending();
			this.started = true;
			this.drainTimer = setInterval(() => {
				void this.tick().catch((error) => this.recordLoopError(error));
			}, this.pollIntervalMs);
			this.drainTimer.unref?.();
			this.sweepTimer = setInterval(() => {
				void this.sweep().catch((error) => this.recordLoopError(error));
			}, this.sweepIntervalMs);
			this.sweepTimer.unref?.();
		} catch (error) {
			await this.runtime.dispose("daemon_startup_failed").catch(() => {});
			this.store.close();
			throw error;
		}
	}

	requestDrain(): void {
		this.dispatch.requestDrain();
	}

	ready(): DaemonControlPlaneReady {
		let pendingQueueEntries = 0;
		try {
			pendingQueueEntries = this.store.queue.pendingCount();
		} catch {
			// The store may already be closed during daemon shutdown.
		}
		return {
			started: this.started && !this.closing,
			controlSocket: this.controlSocket,
			recoveredInterruptedRuns: this.recoveredInterruptedRuns,
			pendingQueueEntries,
			lastDrainAt: this.lastDrainAt,
		};
	}

	async drainNow(maxEntries = 10): Promise<DispatchDrainResult | null> {
		return await this.tick(maxEntries);
	}

	async close(): Promise<void> {
		if (!this.started || this.closing) return;
		this.closing = true;
		if (this.drainTimer) clearInterval(this.drainTimer);
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		this.drainTimer = null;
		this.sweepTimer = null;
		try {
			await this.runtime.dispose("daemon_cleanup");
		} catch {
			// Worker cleanup is best effort; the store still needs to close.
		}
		try {
			await this.ticking;
		} catch {
			// The loop records its own error; cleanup still proceeds.
		} finally {
			this.store.close();
			this.started = false;
			this.closing = false;
		}
	}

	lastResolutions(): readonly HandoffResolution[] {
		return this.lastResolution;
	}

	private async tick(maxEntries = 10): Promise<DispatchDrainResult | null> {
		if (!this.started || this.closing) return null;
		if (this.ticking) return this.ticking;
		if (this.dispatch.pendingWake() === 0) return null;
		this.ticking = (async () => {
			const result = await this.dispatch.drain({ maxEntries });
			this.lastDrainAt = Date.now();
			return result;
		})();
		try {
			return await this.ticking;
		} finally {
			this.ticking = null;
		}
	}

	private async sweep(): Promise<void> {
		if (!this.started || this.closing) return;
		await this.runtime.sweepStale();
		this.lastResolution = this.resolver.resolvePending();
		if (this.dispatch.pendingWake() > 0) this.requestDrain();
	}

	private recordLoopError(error: unknown): void {
		try {
			this.store.audit.append({
				actor: "system:daemon-runtime",
				action: "drain_loop_error",
				subject: "daemon:control-plane",
				args: { message: error instanceof Error ? error.message : String(error) },
			});
		} catch {
			// Dropping an audit while the DB is closing is safer than crashing.
		}
	}
}

export function resolvePiCliPath(): string {
	const configured = process.env.CODETEAM_PI_CLI;
	if (configured && configured.trim() !== "") return configured;
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "..", "coding-agent", "dist", "cli.js");
}
