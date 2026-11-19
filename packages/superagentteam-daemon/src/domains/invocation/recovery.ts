import { runInTransaction } from "../../infrastructure/db/database.ts";
import type { QueueLedgerStore } from "../queue/store.ts";
import type { WorkerStore } from "../worker/store.ts";
import { type AggregateDeps, aggregateParent, queueEntryIdFor } from "./aggregate.ts";
import type { SettlementDeps } from "./settlement.ts";
import { ResponseRecoveryService } from "./settlement.ts";
import { InvocationRecordStore } from "./store.ts";

// F018 R2-d recovery (0007 §3.10): the startup one-shot reconciler and the
// single serialized runtime reaper share one convergence routine. Liveness is
// evidence-based — a record that cannot be read defers instead of guessing;
// a first non-live observation waits out the provider finalization grace.

export interface RecoveryDeps extends SettlementDeps {
	queue: QueueLedgerStore;
	workers: WorkerStore;
	/** tracker slot release (ownership-fenced complete). */
	releaseSlot: (threadId: string, agentId: string, turnExecutionId: string) => void;
	/** tracker stale-slot scan (§3.10.2 candidate set). */
	listStaleSlots: (now: number) => Array<{ threadId: string; agentId: string; turnExecutionId: string }>;
	/**
	 * Exact-owner liveness (§3.10.2): judge by the ATTEMPT's worker binding +
	 * turnExecutionId, never the session's current binding (a re-bound worker
	 * must not keep an old zombie alive). Unreadable → throw → defer.
	 */
	isWorkerLive: (turnExecutionId: string) => boolean;
	processStartedAt: number;
	/** Provider finalization grace before owner_reaped (default 5min). */
	graceMs?: number;
}

export interface RecoveryRunResult {
	expiredClaimsRestored: number;
	workersReaped: number;
	childrenInterrupted: number;
	attemptsConverged: number;
	parentsReaggregated: number;
	staleSlotsReleased: number;
	responseRecovered: ReturnType<ResponseRecoveryService["runOnce"]>;
	deferred: number;
}

/**
 * The shared convergence chain (§3.10 order): child terminal → attempt
 * projection → credential → (T4 later) → shared §3.9 aggregate → slot
 * release. Idempotent at every step.
 */
export class RecoveryConverger {
	private readonly deps: RecoveryDeps;
	private readonly t4: ResponseRecoveryService;

	constructor(deps: RecoveryDeps) {
		this.deps = deps;
		this.t4 = new ResponseRecoveryService(deps);
	}

	private aggregateDeps(): AggregateDeps {
		return {
			db: this.deps.db,
			records: new AggregateRecords(this.deps.db),
			attempts: this.deps.attempts,
			turns: this.deps.turns,
			queue: this.deps.queue,
		};
	}

	/** Terminal-interrupt one running child (zombie) — attempt optional. */
	convergeChild(turnExecutionId: string, terminalReason: string, endedAt: number): boolean {
		const turn = this.deps.turns.get(turnExecutionId);
		if (!turn || turn.status !== "running") return false;
		const attempt = this.deps.attempts.getByTurnExecutionId(turnExecutionId);
		runInTransaction(this.deps.db, () => {
			this.deps.turns.transitionTerminal(turnExecutionId, {
				status: "interrupted",
				endedAt,
				terminalReason,
			});
			if (attempt && attempt.deliveryState === "appended") {
				this.deps.attempts.projectChildTerminal(attempt.attemptId, {
					turnExecutionId,
					childStatus: "interrupted",
					terminalReason,
					endedAt,
				});
				this.deps.credentials.commitTerminal(turnExecutionId, "interrupted");
				if (attempt.promptDeliveredAt !== null && attempt.deliveryBoundarySeq !== null) {
					this.deps.readState.ack(turn.threadId, turn.agentId, attempt.deliveryBoundarySeq, endedAt);
				}
			}
		});
		return true;
	}

	/** T4 sweep + the SHARED §3.9 aggregate for each affected parent. */
	finalize(parents: ReadonlySet<string>, now: number): number {
		const response = this.t4.runOnce();
		let reaggregated = 0;
		const aggregate = this.aggregateDeps();
		for (const invocationId of parents) {
			const parent = aggregate.records.get(invocationId);
			if (!parent || (parent.status !== "queued" && parent.status !== "running")) continue;
			const entryId = queueEntryIdFor(aggregate, invocationId, parent.targetAgentIds);
			if (!entryId) continue;
			const outcome = aggregateParent(
				aggregate,
				{ threadId: parent.threadId, queueEntryId: entryId, invocationId },
				now,
			);
			if (outcome !== "skipped") reaggregated += 1;
		}
		void response;
		return reaggregated;
	}
}

class AggregateRecords extends InvocationRecordStore {}

/**
 * Startup one-shot (§3.10.1): restore expired claims, interrupt pre-process
 * running children (cutoff = processStartedAt + 1), converge appended
 * attempts + starting attempts without children, run T4, re-aggregate via
 * the SHARED collector. Best-effort — never blocks startup.
 */
export class TurnExecutionStartupReconciler {
	private readonly deps: RecoveryDeps;
	private readonly converger: RecoveryConverger;
	private completed = false;

	constructor(deps: RecoveryDeps) {
		this.deps = deps;
		this.converger = new RecoveryConverger(deps);
	}

	get startupRecoveryComplete(): boolean {
		return this.completed;
	}

	recover(now: number): RecoveryRunResult {
		const result: RecoveryRunResult = {
			expiredClaimsRestored: 0,
			workersReaped: 0,
			childrenInterrupted: 0,
			attemptsConverged: 0,
			parentsReaggregated: 0,
			staleSlotsReleased: 0,
			responseRecovered: { pendingScanned: 0, settled: 0, missing: 0, failures: 0 },
			deferred: 0,
		};
		try {
			result.expiredClaimsRestored = this.deps.queue.restoreExpiredClaims(now);
			result.workersReaped = this.deps.workers.reapExpired(now);
			const cutoff = this.deps.processStartedAt + 1;
			const interrupted = this.deps.turns.interruptRunningBefore(cutoff, {
				endedAt: now,
				terminalReason: "process_restart",
			});
			const parents = new Set<string>();
			for (const turn of interrupted) {
				const attempt = this.deps.attempts.getByTurnExecutionId(turn.turnExecutionId);
				if (attempt) {
					parents.add(attempt.parentInvocationId);
					if (attempt.deliveryState === "appended") {
						this.deps.attempts.projectChildTerminal(attempt.attemptId, {
							turnExecutionId: turn.turnExecutionId,
							childStatus: "interrupted",
							terminalReason: "process_restart",
							endedAt: now,
						});
						this.deps.credentials.commitTerminal(turn.turnExecutionId, "interrupted");
						result.attemptsConverged += 1;
					} else if (attempt.deliveryState === "starting") {
						// §3.10.1: starting without a live child → prestart failed
						// (starting→failed accepts any reason; queued stays for drain).
						this.deps.attempts.markPrestartTerminal(attempt.attemptId, {
							status: "failed",
							terminalReason: "process_restart",
							endedAt: now,
						});
						result.attemptsConverged += 1;
					}
				}
				this.deps.releaseSlot(turn.threadId, turn.agentId, turn.turnExecutionId);
				result.childrenInterrupted += 1;
			}
			result.responseRecovered = new ResponseRecoveryService(this.deps).runOnce();
			result.parentsReaggregated = this.converger.finalize(parents, now);
			this.completed = true;
		} catch {
			// best-effort: never block the API on recovery (§3.10.1).
			result.deferred += 1;
		}
		return result;
	}
}

/**
 * The single runtime janitor (§3.10.2): restore expired claims → reap stale
 * workers → converge running children whose EXACT owner is absent past the
 * provider finalization grace → T4 → shared aggregate → release stale slots.
 */
export class InvocationOwnerReaper {
	private readonly deps: RecoveryDeps;
	private readonly converger: RecoveryConverger;
	private inFlight = false;
	private readonly firstDeadSeen = new Map<string, number>();

	constructor(deps: RecoveryDeps) {
		this.deps = deps;
		this.converger = new RecoveryConverger(deps);
	}

	async runOnce(now: number): Promise<RecoveryRunResult> {
		const result: RecoveryRunResult = {
			expiredClaimsRestored: 0,
			workersReaped: 0,
			childrenInterrupted: 0,
			attemptsConverged: 0,
			parentsReaggregated: 0,
			staleSlotsReleased: 0,
			responseRecovered: { pendingScanned: 0, settled: 0, missing: 0, failures: 0 },
			deferred: 0,
		};
		if (this.inFlight) return result;
		this.inFlight = true;
		try {
			result.expiredClaimsRestored = this.deps.queue.restoreExpiredClaims(now);
			result.workersReaped = this.deps.workers.reapExpired(now);
			const graceMs = this.deps.graceMs ?? 300_000;
			const parents = new Set<string>();
			for (const turn of this.deps.turns.listRunning()) {
				// P2: a per-turn failure must not abort the whole sweep.
				try {
					const attempt = this.deps.attempts.getByTurnExecutionId(turn.turnExecutionId);
					if (attempt) parents.add(attempt.parentInvocationId);
					// Exact-owner liveness; unreadable evidence defers.
					let live = false;
					try {
						live = this.deps.isWorkerLive(turn.turnExecutionId);
					} catch {
						result.deferred += 1;
						continue;
					}
					if (live) {
						this.firstDeadSeen.delete(turn.turnExecutionId);
						continue;
					}
					// P1-4: provider finalization grace — the first non-live
					// observation only ARMS the fence; convergence waits out
					// the grace window so a draining/re-attaching worker or a
					// finalizing provider is not prematurely reaped.
					const seen = this.firstDeadSeen.get(turn.turnExecutionId);
					if (seen === undefined) {
						this.firstDeadSeen.set(turn.turnExecutionId, now);
						result.deferred += 1;
						continue;
					}
					if (now - seen < graceMs) {
						result.deferred += 1;
						continue;
					}
					this.firstDeadSeen.delete(turn.turnExecutionId);
					const reason = "provider_exited_without_terminal";
					if (this.converger.convergeChild(turn.turnExecutionId, reason, now)) {
						result.childrenInterrupted += 1;
						if (attempt) result.attemptsConverged += 1;
						this.deps.releaseSlot(turn.threadId, turn.agentId, turn.turnExecutionId);
					}
				} catch {
					result.deferred += 1;
				}
			}
			// P2: tracker stale slots without a running turn get released.
			for (const slot of this.deps.listStaleSlots(now)) {
				if (this.deps.turns.get(slot.turnExecutionId)?.status === "running") continue;
				this.deps.releaseSlot(slot.threadId, slot.agentId, slot.turnExecutionId);
				result.staleSlotsReleased += 1;
			}
			result.responseRecovered = new ResponseRecoveryService(this.deps).runOnce();
			result.parentsReaggregated = this.converger.finalize(parents, now);
		} finally {
			this.inFlight = false;
		}
		return result;
	}
}
