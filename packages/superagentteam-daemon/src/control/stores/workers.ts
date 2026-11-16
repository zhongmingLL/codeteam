import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import { type Clock, changesOf, mapStoreError, nonEmpty } from "./helpers.ts";
import type { CreateWorkerInput, Worker, WorkerCapacitySnapshot, WorkerListFilter, WorkerState } from "./types.ts";

interface WorkerRow {
	id: string;
	kind: "rpc";
	role: string;
	capacity: number;
	state: WorkerState;
	pid: number | null;
	heartbeat_at: number;
	lease_expires_at: number;
	drain_requested_at: number | null;
	retired_at: number | null;
	last_error: string | null;
	created_at: number;
	updated_at: number;
}

const ACTIVE_STATES: readonly WorkerState[] = ["starting", "online", "draining"];

function mapWorker(row: WorkerRow): Worker {
	return {
		id: row.id,
		kind: row.kind,
		role: row.role,
		capacity: row.capacity,
		state: row.state,
		pid: row.pid,
		heartbeatAt: row.heartbeat_at,
		leaseExpiresAt: row.lease_expires_at,
		drainRequestedAt: row.drain_requested_at,
		retiredAt: row.retired_at,
		lastError: row.last_error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class WorkerStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
	}

	get(id: string): Worker | null {
		const row = this.database.prepare("SELECT * FROM workers WHERE id = ?").get(id) as WorkerRow | undefined;
		return row ? mapWorker(row) : null;
	}

	list(filter: WorkerListFilter = {}): Worker[] {
		const clauses: string[] = [];
		const params: string[] = [];
		if (filter.role !== undefined) {
			clauses.push("role = ?");
			params.push(filter.role);
		}
		if (filter.state !== undefined) {
			clauses.push("state = ?");
			params.push(filter.state);
		}
		const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.database
			.prepare(`SELECT * FROM workers${where} ORDER BY created_at, id`)
			.all(...params) as unknown as WorkerRow[];
		return rows.map(mapWorker);
	}

	listStale(now: number): Worker[] {
		const rows = this.database
			.prepare(
				"SELECT * FROM workers WHERE state IN ('starting', 'online', 'draining') AND lease_expires_at <= ? ORDER BY lease_expires_at, id",
			)
			.all(now) as unknown as WorkerRow[];
		return rows.map(mapWorker);
	}

	create(input: CreateWorkerInput): Worker {
		const kind = input.kind ?? "rpc";
		const capacity = input.capacity ?? 1;
		if (kind !== "rpc") throw new ControlError("invalid_input", `unsupported worker kind ${kind}`);
		if (capacity !== 1) throw new ControlError("invalid_input", "rpc worker capacity must be 1");
		if (input.leaseExpiresAt < input.heartbeatAt) {
			throw new ControlError("invalid_input", "leaseExpiresAt must not be before heartbeatAt");
		}
		try {
			return this.transaction.run(() => {
				if (!this.database.prepare("SELECT id FROM roles WHERE id = ?").get(input.role)) {
					throw new ControlError("not_found", `role ${input.role} not found`);
				}
				const now = this.clock();
				this.database
					.prepare(
						"INSERT INTO workers (id, kind, role, capacity, state, pid, heartbeat_at, lease_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						nonEmpty(input.id, "workerId"),
						kind,
						nonEmpty(input.role, "role"),
						capacity,
						input.state ?? "starting",
						input.pid ?? null,
						input.heartbeatAt,
						input.leaseExpiresAt,
						now,
						now,
					);
				return this.get(input.id)!;
			});
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}

	heartbeat(id: string, input: { at: number; leaseMs: number; pid?: number | null }): Worker {
		if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
			throw new ControlError("invalid_input", "leaseMs must be a positive integer");
		}
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `worker ${id} not found`);
				if (!ACTIVE_STATES.includes(current.state)) {
					throw new ControlError("invalid_state", `worker ${id} is ${current.state}`);
				}
				const state: WorkerState = current.state === "starting" ? "online" : current.state;
				const result = this.database
					.prepare(
						"UPDATE workers SET state = ?, heartbeat_at = ?, lease_expires_at = ?, pid = COALESCE(?, pid), updated_at = ? WHERE id = ?",
					)
					.run(state, input.at, input.at + input.leaseMs, input.pid ?? null, this.clock(), id);
				if (changesOf(result) === 0) throw new ControlError("not_found", `worker ${id} not found`);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	markOnline(id: string, pid?: number | null): Worker {
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `worker ${id} not found`);
				if (current.state !== "starting") return current;
				const result = this.database
					.prepare("UPDATE workers SET state = 'online', pid = COALESCE(?, pid), updated_at = ? WHERE id = ?")
					.run(pid ?? null, this.clock(), id);
				if (changesOf(result) === 0) throw new ControlError("not_found", `worker ${id} not found`);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	requestDrain(id: string): Worker {
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `worker ${id} not found`);
				if (current.state === "draining" || current.state === "retired") return current;
				if (current.state === "stale") {
					throw new ControlError("invalid_state", `worker ${id} is stale`);
				}
				const now = this.clock();
				const result = this.database
					.prepare(
						"UPDATE workers SET state = 'draining', drain_requested_at = COALESCE(drain_requested_at, ?), updated_at = ? WHERE id = ?",
					)
					.run(now, now, id);
				if (changesOf(result) === 0) throw new ControlError("not_found", `worker ${id} not found`);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	markStale(id: string, reason: string): Worker {
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `worker ${id} not found`);
				if (current.state === "stale" || current.state === "retired") return current;
				const now = this.clock();
				const result = this.database
					.prepare("UPDATE workers SET state = 'stale', last_error = ?, updated_at = ? WHERE id = ?")
					.run(reason, now, id);
				if (changesOf(result) === 0) throw new ControlError("not_found", `worker ${id} not found`);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	retire(id: string, reason?: string): Worker {
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `worker ${id} not found`);
				if (current.state === "retired") return current;
				const now = this.clock();
				const result = this.database
					.prepare(
						"UPDATE workers SET state = 'retired', retired_at = ?, last_error = COALESCE(?, last_error), updated_at = ? WHERE id = ?",
					)
					.run(now, reason ?? null, now, id);
				if (changesOf(result) === 0) throw new ControlError("not_found", `worker ${id} not found`);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	snapshot(id: string): WorkerCapacitySnapshot | null {
		const worker = this.get(id);
		if (!worker) return null;
		const active = this.database
			.prepare(
				"SELECT id, agent_session_id FROM runs WHERE worker_id = ? AND status = 'running' ORDER BY started_at, id",
			)
			.all(id) as unknown as { id: string; agent_session_id: string }[];
		const bound = this.database
			.prepare(
				"SELECT id FROM agent_sessions WHERE worker_id = ? AND status IN ('active', 'sealing') ORDER BY created_at, id",
			)
			.all(id) as unknown as { id: string }[];
		const activeSessionIds = [...new Set(active.map((row) => row.agent_session_id))];
		return {
			workerId: worker.id,
			role: worker.role,
			state: worker.state,
			capacity: worker.capacity,
			activeRuns: active.length,
			activeSessions: activeSessionIds.length,
			boundSessions: bound.length,
			availableSlots: Math.max(0, worker.capacity - bound.length),
			availableRunSlots: Math.max(0, worker.capacity - active.length),
			heartbeatAt: worker.heartbeatAt,
			leaseExpiresAt: worker.leaseExpiresAt,
			activeRunIds: active.map((row) => row.id),
			activeSessionIds,
		};
	}

	listSnapshots(filter: WorkerListFilter = {}): WorkerCapacitySnapshot[] {
		return this.list(filter)
			.map((worker) => this.snapshot(worker.id))
			.filter((snapshot): snapshot is WorkerCapacitySnapshot => snapshot !== null);
	}
}
