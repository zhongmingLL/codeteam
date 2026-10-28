import type { ControlStore } from "../control/store.ts";
import type { WorkerCapacitySnapshot } from "../control/stores/types.ts";

export type CapacitySlotStatus = "available" | "busy" | "draining" | "stale" | "offline";

export interface CapacitySlot {
	readonly slotId: string;
	readonly role: string;
	readonly status: CapacitySlotStatus;
	readonly capacity: number;
	readonly activeRuns: number;
}

export interface CapacitySnapshot {
	readonly schemaVersion: 1;
	readonly source: "local" | "w5b-registry";
	readonly observedAt: number;
	readonly staleAfterMs: number;
	readonly slots: readonly CapacitySlot[];
}

export interface CapacityProvider {
	snapshot(now: number): CapacitySnapshot | null;
}

export type CapacityDecision =
	| { readonly ok: true; readonly slotId: string }
	| { readonly ok: false; readonly code: "capacity_unknown" | "capacity_exhausted"; readonly message: string };

export interface LocalCapacityProviderOptions {
	readonly maxConcurrentRuns?: number;
}

export const DEFAULT_WORKER_CAPACITY_STALE_MS = 30_000;

export class LocalCapacityProvider implements CapacityProvider {
	private readonly store: ControlStore;
	private readonly maxConcurrentRuns: number;

	constructor(store: ControlStore, options: LocalCapacityProviderOptions = {}) {
		this.store = store;
		const configured = options.maxConcurrentRuns ?? Number(process.env.CODETEAM_LOCAL_MAX_CONCURRENT_RUNS ?? "4");
		this.maxConcurrentRuns = Number.isSafeInteger(configured) && configured > 0 ? configured : 4;
	}

	snapshot(now: number): CapacitySnapshot {
		const running = this.store.runs.list({ status: "running" }).length;
		return {
			schemaVersion: 1,
			source: "local",
			observedAt: now,
			staleAfterMs: 0,
			slots: [
				{
					slotId: "local:process",
					role: "*",
					status: running < this.maxConcurrentRuns ? "available" : "busy",
					capacity: this.maxConcurrentRuns,
					activeRuns: running,
				},
			],
		};
	}
}

export class StaticCapacityProvider implements CapacityProvider {
	private readonly value: CapacitySnapshot | null;

	constructor(snapshot: CapacitySnapshot | null) {
		this.value = snapshot;
	}

	snapshot(): CapacitySnapshot | null {
		return this.value;
	}
}

export class WorkerRegistryCapacityProvider implements CapacityProvider {
	private readonly store: ControlStore;
	private readonly staleAfterMs: number;

	constructor(store: ControlStore, staleAfterMs = DEFAULT_WORKER_CAPACITY_STALE_MS) {
		this.store = store;
		this.staleAfterMs = staleAfterMs;
	}

	snapshot(now: number): CapacitySnapshot {
		const workers = this.store.workers.listSnapshots();
		const observedAt = workers.length > 0 ? Math.max(...workers.map((worker) => worker.heartbeatAt)) : now;
		return {
			schemaVersion: 1,
			source: "w5b-registry",
			observedAt,
			staleAfterMs: this.staleAfterMs,
			slots: workers.map((worker) => ({
				slotId: worker.workerId,
				role: worker.role,
				status: workerSlotStatus(worker, now),
				capacity: worker.capacity,
				activeRuns: worker.activeRuns,
			})),
		};
	}
}

function workerSlotStatus(worker: WorkerCapacitySnapshot, now: number): CapacitySlotStatus {
	if (worker.state === "retired") return "offline";
	if (worker.state === "stale" || worker.leaseExpiresAt <= now) return "stale";
	if (worker.state === "draining") return "draining";
	if (worker.state === "starting") return "busy";
	return worker.availableRunSlots > 0 ? "available" : "busy";
}

export function decideCapacity(snapshot: CapacitySnapshot | null, role: string, now: number): CapacityDecision {
	if (!snapshot) {
		return { ok: false, code: "capacity_unknown", message: "capacity projection is unavailable" };
	}
	if (snapshot.staleAfterMs > 0 && now - snapshot.observedAt > snapshot.staleAfterMs) {
		return { ok: false, code: "capacity_unknown", message: "capacity projection is stale" };
	}
	const matching = snapshot.slots.filter((slot) => slot.role === role || slot.role === "*");
	if (matching.length === 0) {
		return { ok: false, code: "capacity_unknown", message: `no capacity slot projects role ${role}` };
	}
	const available = matching.find((slot) => slot.status === "available" && slot.activeRuns < slot.capacity);
	if (available) return { ok: true, slotId: available.slotId };
	return {
		ok: false,
		code: "capacity_exhausted",
		message: `no available capacity for role ${role} (${matching.map((slot) => slot.status).join(",")})`,
	};
}
