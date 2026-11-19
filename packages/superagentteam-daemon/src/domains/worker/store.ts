import type { DatabaseSync } from "node:sqlite";

import type { Worker, WorkerBinding } from "@superagentteam/shared/types";

// F018 R1-c WorkerStore + WorkerBindingStore (0007 §3.5.2/§4.6): ephemeral
// execution carriers; capacity=1; one session per worker and one worker per
// session; generation fences stale releases.

export interface WorkerPoolKey {
	projectPath: string;
	accountRef: string;
	provider: string;
	model: string;
}

export const MAX_LIVE_WORKERS = 8;

interface WorkerRow {
	id: string;
	project_path: string;
	account_ref: string;
	provider: string;
	model: string;
	state: "starting" | "online" | "draining" | "stale" | "retired";
	pid: number | null;
	heartbeat_at: number;
	lease_expires_at: number;
	idle_since: number | null;
	retired_at: number | null;
	last_error: string | null;
	created_at: number;
	updated_at: number;
}

function mapWorker(row: WorkerRow): Worker {
	return {
		id: row.id,
		poolKey: {
			projectPath: row.project_path,
			accountRef: row.account_ref,
			provider: row.provider,
			model: row.model,
		},
		state: row.state,
		pid: row.pid,
		heartbeatAt: row.heartbeat_at,
		leaseExpiresAt: row.lease_expires_at,
		idleSince: row.idle_since,
		retiredAt: row.retired_at,
		lastError: row.last_error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

interface BindingRow {
	agent_session_id: string;
	worker_id: string;
	generation: number;
	state: "attached" | "idle" | "reattach_pending";
	bound_at: number;
	last_used_at: number;
}

function mapBinding(row: BindingRow): WorkerBinding {
	return {
		agentSessionId: row.agent_session_id,
		workerId: row.worker_id,
		generation: row.generation,
		state: row.state,
		boundAt: row.bound_at,
		lastUsedAt: row.last_used_at,
	};
}

export interface EnsureWorkerInput {
	workerId: string;
	poolKey: WorkerPoolKey;
	now: number;
	leaseTtlMs: number;
}

export class WorkerStore {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/** Dispatch 前预检 (0007 §3.5.2): does NOT spawn; typed reject on no slot. */
	checkCapacity(_poolKey: WorkerPoolKey, now = Date.now()): { ok: true } | { ok: false; reason: "worker_capacity" } {
		const live = (
			this.db
				.prepare("SELECT COUNT(*) AS n FROM workers WHERE state IN ('starting', 'online', 'draining')")
				.get() as { n: number }
		).n;
		if (live >= MAX_LIVE_WORKERS) {
			const evicted = this.retireIdle(now);
			if (live - evicted >= MAX_LIVE_WORKERS) return { ok: false, reason: "worker_capacity" };
		}
		return { ok: true };
	}

	/** R1 closeout handover: injected clock (was Date.now()). */
	retireIdle(now = Date.now()): number {
		const idle = this.db
			.prepare("SELECT id FROM workers WHERE state = 'draining' AND idle_since IS NOT NULL")
			.all() as Array<{ id: string }>;
		for (const row of idle) {
			this.db
				.prepare("UPDATE workers SET state = 'retired', retired_at = ?, updated_at = ? WHERE id = ?")
				.run(now, now, row.id);
			this.db.prepare("UPDATE worker_bindings SET state = 'reattach_pending' WHERE worker_id = ?").run(row.id);
		}
		return idle.length;
	}

	ensure(input: EnsureWorkerInput): Worker {
		const existing = this.db.prepare("SELECT * FROM workers WHERE id = ?").get(input.workerId) as
			| WorkerRow
			| undefined;
		if (existing) {
			const sameKey =
				existing.project_path === input.poolKey.projectPath &&
				existing.account_ref === input.poolKey.accountRef &&
				existing.provider === input.poolKey.provider &&
				existing.model === input.poolKey.model;
			if (!sameKey) throw new Error("worker_pool_key_conflict");
			return mapWorker(existing);
		}
		this.db
			.prepare(
				`INSERT INTO workers (id, project_path, account_ref, provider, model, state, heartbeat_at, lease_expires_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?)`,
			)
			.run(
				input.workerId,
				input.poolKey.projectPath,
				input.poolKey.accountRef,
				input.poolKey.provider,
				input.poolKey.model,
				input.now,
				input.now + input.leaseTtlMs,
				input.now,
				input.now,
			);
		return mapWorker(
			this.db.prepare("SELECT * FROM workers WHERE id = ?").get(input.workerId) as unknown as WorkerRow,
		);
	}

	markOnline(workerId: string, pid: number, now: number): Worker | null {
		this.db
			.prepare("UPDATE workers SET state = 'online', pid = ?, updated_at = ? WHERE id = ? AND state = 'starting'")
			.run(pid, now, workerId);
		return this.get(workerId);
	}

	get(workerId: string): Worker | null {
		const row = this.db.prepare("SELECT * FROM workers WHERE id = ?").get(workerId) as WorkerRow | undefined;
		return row ? mapWorker(row) : null;
	}

	heartbeat(workerId: string, now: number, leaseTtlMs: number): void {
		this.db
			.prepare("UPDATE workers SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?")
			.run(now, now + leaseTtlMs, now, workerId);
	}

	/** warmTtl=0 default: retire after the turn (0007 §3.5.2). */
	release(workerId: string, now: number): boolean {
		const result = this.db
			.prepare(
				"UPDATE workers SET state = 'retired', retired_at = ?, updated_at = ? WHERE id = ? AND state <> 'retired'",
			)
			.run(now, now, workerId);
		this.db.prepare("DELETE FROM worker_bindings WHERE worker_id = ?").run(workerId);
		return Number(result.changes) > 0;
	}

	/** Stale sweep (lease/heartbeat expiry). */
	reapExpired(now: number): number {
		const stale = this.db
			.prepare("SELECT id FROM workers WHERE state IN ('starting', 'online') AND lease_expires_at <= ?")
			.all(now) as Array<{ id: string }>;
		for (const row of stale) {
			this.db
				.prepare("UPDATE workers SET state = 'stale', last_error = 'lease_expired', updated_at = ? WHERE id = ?")
				.run(now, row.id);
			this.db.prepare("UPDATE worker_bindings SET state = 'reattach_pending' WHERE worker_id = ?").run(row.id);
		}
		return stale.length;
	}

	listSnapshot(): Worker[] {
		const rows = this.db.prepare("SELECT * FROM workers ORDER BY created_at").all() as unknown as WorkerRow[];
		return rows.map(mapWorker);
	}
}

export interface BindInput {
	agentSessionId: string;
	workerId: string;
	now: number;
}

export class WorkerBindingStore {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/**
	 * Binds a session to a worker. Re-binding the same pair bumps
	 * `generation`; stale releases carrying an old generation no-op
	 * (0007 §3.5.2 "generation fences stale release").
	 */
	bind(input: BindInput): WorkerBinding {
		const existing = this.db
			.prepare("SELECT * FROM worker_bindings WHERE agent_session_id = ?")
			.get(input.agentSessionId) as BindingRow | undefined;
		if (existing) {
			if (existing.worker_id === input.workerId && existing.state === "attached") return mapBinding(existing);
			// Target worker must not already serve another session (worker_id
			// UNIQUE would otherwise surface as a raw constraint error).
			const owner = this.db
				.prepare("SELECT agent_session_id FROM worker_bindings WHERE worker_id = ?")
				.get(input.workerId) as { agent_session_id: string } | undefined;
			if (owner && owner.agent_session_id !== input.agentSessionId) {
				throw new Error(`worker_bound_to_other_session: ${owner.agent_session_id}`);
			}
			// Move to a different worker: generation+1 fences the old one.
			this.db
				.prepare(
					"UPDATE worker_bindings SET worker_id = ?, generation = generation + 1, state = 'attached', bound_at = ?, last_used_at = ? WHERE agent_session_id = ?",
				)
				.run(input.workerId, input.now, input.now, input.agentSessionId);
			return this.getBySession(input.agentSessionId)!;
		}
		const clash = this.db
			.prepare("SELECT agent_session_id FROM worker_bindings WHERE worker_id = ?")
			.get(input.workerId) as { agent_session_id: string } | undefined;
		if (clash) {
			throw new Error(`worker_bound_to_other_session: ${clash.agent_session_id}`);
		}
		this.db
			.prepare(
				`INSERT INTO worker_bindings (agent_session_id, worker_id, generation, state, bound_at, last_used_at)
				 VALUES (?, ?, 1, 'attached', ?, ?)`,
			)
			.run(input.agentSessionId, input.workerId, input.now, input.now);
		return this.getBySession(input.agentSessionId)!;
	}

	getBySession(agentSessionId: string): WorkerBinding | null {
		const row = this.db.prepare("SELECT * FROM worker_bindings WHERE agent_session_id = ?").get(agentSessionId) as
			| BindingRow
			| undefined;
		return row ? mapBinding(row) : null;
	}

	/**
	 * Generation-fenced unbind: releasing with a stale generation is a no-op
	 * so a slow release cannot unbind the replacement binding.
	 */
	unbind(agentSessionId: string, expectedGeneration: number): boolean {
		const result = this.db
			.prepare("DELETE FROM worker_bindings WHERE agent_session_id = ? AND generation = ?")
			.run(agentSessionId, expectedGeneration);
		return Number(result.changes) > 0;
	}

	touchUsed(agentSessionId: string, now: number): void {
		this.db
			.prepare("UPDATE worker_bindings SET last_used_at = ? WHERE agent_session_id = ?")
			.run(now, agentSessionId);
	}

	/** Worker-side revocation (session replaced while worker lived). */
	revokeSession(agentSessionId: string, reason: string): boolean {
		const worker = this.db
			.prepare("SELECT worker_id FROM worker_bindings WHERE agent_session_id = ?")
			.get(agentSessionId) as { worker_id: string } | undefined;
		if (!worker) return false;
		this.db.prepare("DELETE FROM worker_bindings WHERE agent_session_id = ?").run(agentSessionId);
		this.db
			.prepare(
				"UPDATE workers SET state = 'draining', last_error = ?, idle_since = ?, updated_at = ? WHERE id = ? AND state <> 'retired'",
			)
			.run(reason, Date.now(), Date.now(), worker.worker_id);
		return true;
	}
}
