import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { AgentSession, Worker, WorkerCapacitySnapshot } from "../control/stores/types.ts";

export const DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
export const DEFAULT_WORKER_LEASE_MS = 30_000;

export interface WorkerRegistryConfig {
	readonly heartbeatIntervalMs: number;
	readonly leaseMs: number;
}

export interface WorkerRegistryOptions {
	readonly clock?: () => number;
	readonly heartbeatIntervalMs?: number;
	readonly leaseMs?: number;
}

export type SessionWorkerResolution =
	| { readonly kind: "attached"; readonly session: AgentSession; readonly worker: Worker }
	| { readonly kind: "reattach"; readonly session: AgentSession; readonly previousWorker: Worker | null }
	| { readonly kind: "new"; readonly session: AgentSession };

export class WorkerRegistry {
	readonly store: ControlStore;
	readonly config: WorkerRegistryConfig;
	private readonly clock: () => number;

	constructor(store: ControlStore, options: WorkerRegistryOptions = {}) {
		const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS;
		const leaseMs = options.leaseMs ?? DEFAULT_WORKER_LEASE_MS;
		if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
			throw new ControlError("invalid_input", "heartbeatIntervalMs must be a positive integer");
		}
		if (!Number.isSafeInteger(leaseMs) || leaseMs <= heartbeatIntervalMs) {
			throw new ControlError("invalid_input", "leaseMs must be a positive integer greater than heartbeatIntervalMs");
		}
		this.store = store;
		this.clock = options.clock ?? Date.now;
		this.config = { heartbeatIntervalMs, leaseMs };
	}

	register(input: { workerId: string; role: string; pid?: number | null; state?: "starting" | "online" }): Worker {
		const now = this.clock();
		const worker = this.store.workers.create({
			id: input.workerId,
			kind: "rpc",
			role: input.role,
			capacity: 1,
			state: input.state ?? "starting",
			pid: input.pid ?? null,
			heartbeatAt: now,
			leaseExpiresAt: now + this.config.leaseMs,
		});
		this.store.audit.append({
			actor: "system:worker",
			action: "worker_registered",
			subject: `worker:${worker.id}`,
			args: {
				role: worker.role,
				capacity: worker.capacity,
				heartbeatIntervalMs: this.config.heartbeatIntervalMs,
				leaseMs: this.config.leaseMs,
			},
		});
		return worker;
	}

	heartbeat(workerId: string, pid?: number | null): Worker {
		const worker = this.store.workers.heartbeat(workerId, {
			at: this.clock(),
			leaseMs: this.config.leaseMs,
			pid: pid ?? null,
		});
		if (worker.state === "online") return worker;
		return worker;
	}

	markOnline(workerId: string, pid?: number | null): Worker {
		return this.store.workers.markOnline(workerId, pid);
	}

	requestDrain(workerId: string): Worker {
		const worker = this.store.workers.requestDrain(workerId);
		this.store.audit.append({
			actor: "system:worker",
			action: "worker_drain_requested",
			subject: `worker:${workerId}`,
			args: { drainRequestedAt: worker.drainRequestedAt },
		});
		return worker;
	}

	markStale(workerId: string, reason: string): Worker {
		const worker = this.store.workers.markStale(workerId, reason);
		this.store.audit.append({
			actor: "system:worker",
			action: "worker_stale",
			subject: `worker:${workerId}`,
			args: { reason, pid: worker.pid, leaseExpiresAt: worker.leaseExpiresAt },
		});
		return worker;
	}

	retire(workerId: string, reason?: string): Worker {
		const worker = this.store.workers.retire(workerId, reason);
		this.store.audit.append({
			actor: "system:worker",
			action: "worker_retired",
			subject: `worker:${workerId}`,
			args: { reason: reason ?? null, pid: worker.pid, retiredAt: worker.retiredAt },
		});
		return worker;
	}

	resolveSessionWorker(sessionId: string): SessionWorkerResolution {
		const session = this.store.sessions.get(sessionId);
		if (!session) throw new ControlError("not_found", `agent session ${sessionId} not found`);
		if (session.status !== "active") {
			throw new ControlError("invalid_state", `agent session ${sessionId} is ${session.status}`);
		}
		const worker = session.workerId ? this.store.workers.get(session.workerId) : null;
		const live =
			worker !== null &&
			(worker.state === "online" || worker.state === "starting") &&
			worker.leaseExpiresAt > this.clock();
		if (live && session.workerBindingState === "attached") {
			return { kind: "attached", session, worker: worker! };
		}
		if (session.workerBindingState === "re_attach_pending" || worker !== null) {
			return { kind: "reattach", session, previousWorker: worker };
		}
		return { kind: "new", session };
	}

	bindSession(sessionId: string, workerId: string): AgentSession {
		const worker = this.store.workers.get(workerId);
		if (!worker) throw new ControlError("not_found", `worker ${workerId} not found`);
		if (worker.state !== "online" && worker.state !== "starting") {
			throw new ControlError("invalid_state", `worker ${workerId} is ${worker.state}`);
		}
		const session = this.store.sessions.get(sessionId);
		if (!session) throw new ControlError("not_found", `agent session ${sessionId} not found`);
		if (session.role !== worker.role) {
			throw new ControlError(
				"invalid_input",
				`session role ${session.role} does not match worker role ${worker.role}`,
			);
		}
		const snapshot = this.store.workers.snapshot(workerId);
		if (!snapshot) throw new ControlError("not_found", `worker ${workerId} not found`);
		const alreadyBound = session.workerId === workerId;
		if (!alreadyBound && snapshot.availableSlots <= 0) {
			throw new ControlError("capacity_exhausted", `worker ${workerId} has no session capacity`);
		}
		const bound = this.store.sessions.bindWorker(sessionId, workerId, {
			state: "attached",
			attachedAt: this.clock(),
		});
		this.store.audit.append({
			actor: "system:worker",
			action: "session_worker_bound",
			subject: `session:${sessionId}`,
			args: { workerId, previousWorkerId: session.workerId },
		});
		return bound;
	}

	markSessionReattachPending(sessionId: string): AgentSession {
		const session = this.store.sessions.markReattachPending(sessionId);
		if (session.workerBindingState === "re_attach_pending") {
			this.store.audit.append({
				actor: "system:worker",
				action: "session_reattach_pending",
				subject: `session:${sessionId}`,
				args: { workerId: session.workerId },
			});
		}
		return session;
	}

	snapshot(workerId: string): WorkerCapacitySnapshot | null {
		return this.store.workers.snapshot(workerId);
	}

	listSnapshots(): WorkerCapacitySnapshot[] {
		return this.store.workers.listSnapshots();
	}

	staleWorkers(now = this.clock()): Worker[] {
		return this.store.workers.listStale(now);
	}
}
