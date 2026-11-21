import type { AgentSession } from "@superagentteam/shared/types";

import type { RpcEvent } from "../../workers/rpc-client.ts";
import type { WorkerBindingStore, WorkerPoolKey, WorkerStore } from "./store.ts";

// F018 R2-b WorkerPool (0007 §3.5.2): ephemeral execution carriers. One
// worker per session, capacity=1, warmTtl=0 (retire after the turn). Session
// continuity lives in AgentSession.piSessionFile, not in the worker.

/** Minimal connection surface the runtime needs (RpcConnection satisfies it). */
export interface WorkerRpcConnection {
	onEvent(listener: (event: RpcEvent) => void): () => void;
	promptAndWait(
		message: string,
		options: { timeoutMs: number; signal?: AbortSignal; onAccepted?: () => void },
	): Promise<{ aborted: boolean }>;
	finish(reason?: string): Promise<void>;
}

export interface SpawnedWorker {
	connection: WorkerRpcConnection;
	pid: number | null;
	piSessionId: string | null;
	piSessionFile: string | null;
	spawnMs: number;
}

/** Port: real implementation spawns a pi RPC process; tests use a mock. */
export interface WorkerSpawnPort {
	spawn(input: {
		workerId: string;
		poolKey: WorkerPoolKey;
		session: AgentSession;
		now: number;
		/** Child-TurnExecution capability token for the A2A control channel. */
		credentialToken: string;
	}): Promise<SpawnedWorker>;
}

export interface WorkerHandle {
	workerId: string;
	agentSessionId: string;
	generation: number;
	poolKey: WorkerPoolKey;
	connection: WorkerRpcConnection;
	spawnMs: number;
	/** pi session identity reported by the spawn port (resume continuity). */
	piSessionId: string | null;
	piSessionFile: string | null;
}

export interface WorkerPoolMetrics {
	spawnCount: number;
	spawnMsTotal: number;
	spawnMsMax: number;
	/** Sum of busy durations at release time. */
	busyMsTotal: number;
	evictedCount: number;
}

export interface WorkerPoolDeps {
	workers: WorkerStore;
	bindings: WorkerBindingStore;
	spawn: WorkerSpawnPort;
	clock?: () => number;
	leaseTtlMs?: number;
}

export class WorkerPool {
	private readonly workers: WorkerStore;
	private readonly bindings: WorkerBindingStore;
	private readonly spawnPort: WorkerSpawnPort;
	private readonly clock: () => number;
	private readonly leaseTtlMs: number;
	private readonly acquiredAt = new Map<string, number>();
	/** Credential token currently installed in each live worker's env. */
	private readonly credentialTokens = new Map<string, string>();
	private metrics: WorkerPoolMetrics = {
		spawnCount: 0,
		spawnMsTotal: 0,
		spawnMsMax: 0,
		busyMsTotal: 0,
		evictedCount: 0,
	};

	constructor(deps: WorkerPoolDeps) {
		this.workers = deps.workers;
		this.bindings = deps.bindings;
		this.spawnPort = deps.spawn;
		this.clock = deps.clock ?? Date.now;
		this.leaseTtlMs = deps.leaseTtlMs ?? 300_000;
	}

	private now(): number {
		return this.clock();
	}

	/** Processor-facing capacity port (threadId unused — pool is process-global). */
	checkCapacityFor(_threadId: string, _targets: readonly string[]): { ok: true } | { ok: false; reason: string } {
		// v1: a single global pool key class — capacity is per-process.
		const anyKey: import("./store.ts").WorkerPoolKey = {
			projectPath: "*",
			accountRef: "*",
			provider: "*",
			model: "*",
		};
		return this.checkCapacity(anyKey);
	}

	/**
	 * Dispatch preflight (§3.5.2): evicts idle-draining workers, then typed
	 * `worker_capacity` when still no slot. Does NOT spawn.
	 */
	checkCapacity(poolKey: WorkerPoolKey): { ok: true } | { ok: false; reason: "worker_capacity" } {
		const before = this.countLive();
		const result = this.workers.checkCapacity(poolKey, this.now());
		if (!result.ok) return result;
		const evicted = before - this.countLive();
		if (evicted > 0) this.metrics.evictedCount += evicted;
		return result;
	}

	private countLive(): number {
		return this.workers
			.listSnapshot()
			.filter((worker) => worker.state === "starting" || worker.state === "online" || worker.state === "draining")
			.length;
	}

	/**
	 * Reuse an attached live worker when the poolKey still matches; otherwise
	 * spawn (real port: pi RPC process with --session / --session-id). Binds
	 * the session (generation-fenced).
	 */
	async ensure(poolKey: WorkerPoolKey, session: AgentSession, credentialToken: string): Promise<WorkerHandle> {
		const now = this.now();
		const existing = this.bindings.getBySession(session.id);
		if (existing && existing.state === "attached") {
			const worker = this.workers.get(existing.workerId);
			const sameKey =
				worker &&
				(worker.state === "online" || worker.state === "starting") &&
				worker.poolKey.projectPath === poolKey.projectPath &&
				worker.poolKey.accountRef === poolKey.accountRef &&
				worker.poolKey.provider === poolKey.provider &&
				worker.poolKey.model === poolKey.model;
			if (worker && sameKey) {
				const connection = this.liveConnections.get(existing.workerId);
				if (connection && this.credentialTokens.get(existing.workerId) === credentialToken) {
					// Renew the lease ONLY on an actual reuse return — a zombie
					// row without a live connection must not get its lease
					// extended before we fall through to a fresh spawn (review).
					this.workers.heartbeat(worker.id, now, this.leaseTtlMs);
					this.bindings.touchUsed(session.id, now);
					this.acquiredAt.set(existing.workerId, now);
					return {
						workerId: worker.id,
						agentSessionId: session.id,
						generation: existing.generation,
						poolKey,
						connection,
						spawnMs: 0,
						piSessionId: session.piSessionId,
						piSessionFile: session.piSessionFile,
					};
				}
				// A live worker from an older turn carries the old credential
				// token. Never reuse it: retire it and spawn with this turn's
				// token so A2A control auth cannot silently use stale capability.
				if (connection) {
					this.credentialTokens.delete(existing.workerId);
					this.liveConnections.delete(existing.workerId);
					await connection.finish("token-rotation").catch(() => {});
					this.workers.release(existing.workerId, now);
					this.bindings.unbind(session.id, existing.generation);
				}
			}
		}
		// Capacity gate before spawn (evict idle first).
		const capacity = this.checkCapacity(poolKey);
		if (!capacity.ok) throw new Error("worker_capacity");
		const workerId = `w:${session.id}:${now}:${Math.random().toString(36).slice(2, 8)}`;
		const spawned = await this.spawnPort.spawn({ workerId, poolKey, session, now, credentialToken });
		this.workers.ensure({ workerId, poolKey, now, leaseTtlMs: this.leaseTtlMs });
		this.workers.markOnline(workerId, spawned.pid ?? -1, now);
		const binding = this.bindings.bind({ agentSessionId: session.id, workerId, now });
		this.liveConnections.set(workerId, spawned.connection);
		this.credentialTokens.set(workerId, credentialToken);
		this.metrics.spawnCount += 1;
		this.metrics.spawnMsTotal += spawned.spawnMs;
		this.metrics.spawnMsMax = Math.max(this.metrics.spawnMsMax, spawned.spawnMs);
		this.acquiredAt.set(workerId, now);
		return {
			workerId,
			agentSessionId: session.id,
			generation: binding.generation,
			poolKey,
			connection: spawned.connection,
			spawnMs: spawned.spawnMs,
			piSessionId: spawned.piSessionId,
			piSessionFile: spawned.piSessionFile,
		};
	}

	private readonly liveConnections = new Map<string, WorkerRpcConnection>();

	/**
	 * warmTtl=0 (§3.5.2): finish the connection, retire the worker, drop the
	 * binding. A stale generation no-ops (the replacement binding survives).
	 */
	async release(handle: WorkerHandle, _reason: string): Promise<void> {
		const now = this.now();
		const acquired = this.acquiredAt.get(handle.workerId);
		if (acquired !== undefined) {
			this.metrics.busyMsTotal += now - acquired;
			this.acquiredAt.delete(handle.workerId);
		}
		this.liveConnections.delete(handle.workerId);
		this.credentialTokens.delete(handle.workerId);
		await handle.connection.finish("turn-complete").catch(() => {});
		this.workers.release(handle.workerId, now);
		this.bindings.unbind(handle.agentSessionId, handle.generation);
	}

	snapshotMetrics(): Readonly<WorkerPoolMetrics> {
		return { ...this.metrics };
	}

	/** Daemon shutdown: finish every live carrier and retire its row. */
	async closeAll(reason = "daemon-shutdown"): Promise<void> {
		const now = this.now();
		for (const [workerId, connection] of this.liveConnections) {
			this.credentialTokens.delete(workerId);
			await connection.finish(reason).catch(() => {});
			this.workers.release(workerId, now);
		}
		this.liveConnections.clear();
		this.acquiredAt.clear();
	}
}
