import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentStreamEvent } from "@superagentteam/shared/types";
import { defaultA2AControlSocketPath } from "./domains/a2a/control.ts";
import { type A2ARuntime, buildA2ARuntime } from "./domains/a2a/runtime.ts";
import type { AgentRegistry } from "./domains/agent/registry.ts";
import { loadRegistryFromFiles } from "./domains/agent/registry.ts";
import type { ChangeBus } from "./domains/events/bus.ts";
import { PiWorkerSpawnPort, resolveA2AExtensionPath } from "./domains/worker/pi-spawn.ts";
import type { WorkerSpawnPort } from "./domains/worker/pool.ts";
import { envValue } from "./env.ts";
import { DaemonError } from "./errors.ts";
import { F018Database } from "./infrastructure/db/database.ts";

// F018 R5-b: A2A daemon control plane. One SQLite database, one registry,
// one ephemeral worker pool, one control socket, and a daemon-owned drain /
// recovery loop. This is opt-in via startDaemon({ a2aControlPlane }); the
// CLI/default-entry switch is R5-c.

export interface A2ADaemonControlPlaneOptions {
	readonly dataDir: string;
	/** Test/composition injection; otherwise loaded from catalog/accounts files. */
	readonly registry?: AgentRegistry;
	readonly database?: F018Database;
	readonly spawn?: WorkerSpawnPort;
	readonly catalogPath?: string;
	readonly accountsPath?: string;
	readonly defaultAgentId?: string;
	readonly cliPath?: string;
	readonly workerAgentDir?: string;
	readonly sessionDir?: string;
	readonly controlSocketPath?: string;
	readonly extensionPath?: string;
	readonly offline?: boolean;
	readonly promptTimeoutMs?: number;
	readonly pollIntervalMs?: number;
	readonly sweepIntervalMs?: number;
	readonly env?: Record<string, string | undefined>;
	readonly clock?: () => number;
	readonly processStartedAt?: number;
	readonly onStreamEvent?: (event: AgentStreamEvent) => void;
	readonly changeBus?: ChangeBus;
}

export interface A2ADaemonControlPlaneReady {
	readonly started: boolean;
	readonly controlSocket: string;
	readonly recoveredInterruptedRuns: number;
	readonly pendingQueueEntries: number;
	readonly lastDrainAt: number | null;
	readonly lastSweepAt: number | null;
	readonly lastError: string | null;
}

function resolvePiCliPath(): string {
	const configured = envValue(process.env, "PI_CLI");
	if (configured && configured.trim() !== "") return configured;
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "..", "coding-agent", "dist", "cli.js");
}

export class A2ADaemonControlPlane {
	readonly dataDir: string;
	readonly database: F018Database;
	readonly registry: AgentRegistry;
	readonly runtime: A2ARuntime;
	readonly controlSocket: string;
	private readonly ownsDatabase: boolean;
	private readonly clock: () => number;
	private readonly changeBus?: ChangeBus;
	private readonly pollIntervalMs: number;
	private readonly sweepIntervalMs: number;
	private started = false;
	private closing = false;
	private closed = false;
	private drainTimer: ReturnType<typeof setInterval> | null = null;
	private sweepTimer: ReturnType<typeof setInterval> | null = null;
	private ticking: Promise<unknown> | null = null;
	private sweeping: Promise<void> | null = null;
	private lastDrainAt: number | null = null;
	private lastSweepAt: number | null = null;
	private lastError: string | null = null;
	private recoveredInterruptedRuns = 0;

	constructor(options: A2ADaemonControlPlaneOptions) {
		this.dataDir = options.dataDir;
		this.clock = options.clock ?? Date.now;
		this.changeBus = options.changeBus;
		this.pollIntervalMs = Math.max(options.pollIntervalMs ?? 250, 25);
		this.sweepIntervalMs = Math.max(options.sweepIntervalMs ?? 30_000, 1_000);
		this.ownsDatabase = options.database === undefined;
		this.database = options.database ?? new F018Database({ path: join(options.dataDir, "f018.db") });
		try {
			this.registry =
				options.registry ??
				loadRegistryFromFiles(
					{
						catalogPath: options.catalogPath ?? join(options.dataDir, "agent-catalog.json"),
						accountsPath: options.accountsPath ?? join(options.dataDir, "accounts.json"),
					},
					options.defaultAgentId,
				);
		} catch (error) {
			if (this.ownsDatabase) this.database.close();
			throw new DaemonError(
				"control_plane_failed",
				`A2A registry failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		this.controlSocket = options.controlSocketPath ?? defaultA2AControlSocketPath(options.dataDir);
		let runtime: A2ARuntime;
		try {
			const spawn =
				options.spawn ??
				new PiWorkerSpawnPort({
					cliPath: options.cliPath ?? resolvePiCliPath(),
					sessionDir: options.sessionDir ?? join(options.dataDir, "pi-sessions"),
					workerAgentDir: options.workerAgentDir ?? join(options.dataDir, "worker-agent"),
					extensionPath: options.extensionPath ?? resolveA2AExtensionPath(),
					controlSocketPath: this.controlSocket,
					offline: options.offline ?? true,
					env: options.env,
					clock: this.clock,
				});
			runtime = buildA2ARuntime({
				db: this.database.db,
				registry: this.registry,
				spawn,
				controlSocketPath: this.controlSocket,
				clock: this.clock,
				processStartedAt: options.processStartedAt ?? this.clock(),
				promptTimeoutMs: options.promptTimeoutMs,
				onStreamEvent: options.onStreamEvent,
				changeBus: options.changeBus,
			});
		} catch (error) {
			if (this.ownsDatabase) this.database.close();
			throw new DaemonError(
				"control_plane_failed",
				`A2A runtime failed to assemble: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		this.runtime = runtime;
	}

	async start(): Promise<void> {
		if (this.started) return;
		try {
			await this.runtime.control?.start();
			const recovery = this.runtime.startup.recover(this.clock());
			this.recoveredInterruptedRuns = recovery.childrenInterrupted;
			this.started = true;
			this.drainTimer = setInterval(() => {
				void this.tick().catch((error) => this.recordLoopError(error));
			}, this.pollIntervalMs);
			this.drainTimer.unref?.();
			this.sweepTimer = setInterval(() => {
				void this.sweep().catch((error) => this.recordLoopError(error));
			}, this.sweepIntervalMs);
			this.sweepTimer.unref?.();
			if (this.runtime.queue.countQueuedAll() > 0) {
				void this.tick().catch((error) => this.recordLoopError(error));
			}
		} catch (error) {
			await this.runtime.control?.stop().catch(() => {});
			if (this.ownsDatabase) this.database.close();
			throw new DaemonError(
				"control_plane_failed",
				`A2A control plane failed to start: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	requestDrain(): void {
		if (!this.started || this.closing) return;
		void this.tick().catch((error) => this.recordLoopError(error));
	}

	ready(): A2ADaemonControlPlaneReady {
		let pendingQueueEntries = 0;
		try {
			pendingQueueEntries = this.runtime.queue.countQueuedAll();
		} catch {
			// The database may already be closed during shutdown.
		}
		return {
			started: this.started && !this.closing,
			controlSocket: this.controlSocket,
			recoveredInterruptedRuns: this.recoveredInterruptedRuns,
			pendingQueueEntries,
			lastDrainAt: this.lastDrainAt,
			lastSweepAt: this.lastSweepAt,
			lastError: this.lastError,
		};
	}

	async drainNow(maxEntries = 10): Promise<Awaited<ReturnType<A2ARuntime["processor"]["drainAll"]>> | null> {
		return await this.tick(maxEntries);
	}

	async sweepNow(): Promise<void> {
		await this.sweep();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.closing) return;
		this.closing = true;
		if (this.drainTimer) clearInterval(this.drainTimer);
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		this.drainTimer = null;
		this.sweepTimer = null;
		try {
			await this.ticking;
		} catch {
			// tick records its own error; cleanup still proceeds.
		}
		try {
			await this.sweeping;
		} catch {
			// sweep records its own error; cleanup still proceeds.
		}
		await this.runtime.pool.closeAll("daemon-shutdown").catch(() => {});
		await this.runtime.control?.stop().catch(() => {});
		if (this.ownsDatabase) {
			try {
				this.database.close();
			} catch {
				// Already closed by a failed start path.
			}
		}
		this.started = false;
		this.closing = false;
	}

	private async tick(maxEntries = 10): Promise<Awaited<ReturnType<A2ARuntime["processor"]["drainAll"]>> | null> {
		if (!this.started || this.closing) return null;
		if (this.ticking) return (await this.ticking) as Awaited<ReturnType<A2ARuntime["processor"]["drainAll"]>>;
		if (this.runtime.queue.countQueuedAll() === 0) return null;
		const queuedThreads = this.runtime.queue.listQueuedThreadIds();
		for (const threadId of queuedThreads) this.changeBus?.publish(threadId, ["queue", "live"]);
		this.ticking = (async () => {
			const result = await this.runtime.processor.drainAll(maxEntries);
			this.lastDrainAt = this.clock();
			return result;
		})();
		try {
			const result = (await this.ticking) as Awaited<ReturnType<A2ARuntime["processor"]["drainAll"]>>;
			for (const threadId of queuedThreads) {
				this.changeBus?.publish(threadId, ["messages", "queue", "live", "thread"]);
			}
			return result;
		} finally {
			this.ticking = null;
		}
	}

	private async sweep(): Promise<void> {
		if (!this.started || this.closing) return;
		if (this.sweeping) return this.sweeping;
		this.sweeping = (async () => {
			await this.runtime.reaper.runOnce(this.clock());
			this.lastSweepAt = this.clock();
			if (this.runtime.queue.countQueuedAll() > 0) this.requestDrain();
		})();
		try {
			await this.sweeping;
		} finally {
			this.sweeping = null;
		}
	}

	private recordLoopError(error: unknown): void {
		this.lastError = error instanceof Error ? error.message : String(error);
	}
}
