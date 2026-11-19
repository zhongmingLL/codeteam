import { runInTransaction } from "../../infrastructure/db/database.ts";
import type { QueueLedgerStore } from "../queue/store.ts";
import type { WorkerStore } from "../worker/store.ts";
import type { SettlementDeps } from "./settlement.ts";
import { ResponseRecoveryService } from "./settlement.ts";
import { InvocationRecordStore } from "./store.ts";

// F018 R2-d recovery (0007 §3.10): the startup one-shot reconciler and the
// single serialized runtime reaper share one convergence routine. Liveness is
// evidence-based — a record that cannot be read defers instead of guessing.

export interface RecoveryDeps extends SettlementDeps {
	queue: QueueLedgerStore;
	workers: WorkerStore;
	/** tracker slot release (ownership-fenced complete). */
	releaseSlot: (threadId: string, agentId: string, turnExecutionId: string) => void;
	/** Live-worker evidence: agentId+sessionId → worker heartbeat still valid. */
	isWorkerLive: (threadId: string, agentId: string, turnExecutionId: string) => boolean;
	processStartedAt: number;
}

export interface RecoveryRunResult {
	expiredClaimsRestored: number;
	workersReaped: number;
	childrenInterrupted: number;
	attemptsConverged: number;
	parentsReaggregated: number;
	responseRecovered: ReturnType<ResponseRecoveryService["runOnce"]>;
	deferred: number;
}

/**
 * The shared convergence chain (§3.10 order): child terminal → attempt
 * projection → response settlement → queue restore → parent aggregate →
 * credential terminalize → slot release. Idempotent at every step
 * (first-write-wins transitions, no-op settles).
 */
export class RecoveryConverger {
	private readonly deps: RecoveryDeps;
	private readonly records: InvocationRecordStore;
	private readonly t4: ResponseRecoveryService;

	constructor(deps: RecoveryDeps) {
		this.deps = deps;
		// records/attempts/turns arrive via SettlementDeps shape
		this.records = new InvocationRecordStore(deps.db);
		this.t4 = new ResponseRecoveryService(deps);
	}

	/** Terminal-interrupt one running child (zombie) with its attempt projection. */
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
				// Credential follows child truth.
				this.deps.credentials.commitTerminal(turnExecutionId, "interrupted");
				// §6.1.3 crash rows: ack only when the prompt was delivered.
				if (attempt.promptDeliveredAt !== null && attempt.deliveryBoundarySeq !== null) {
					this.deps.readState.ack(turn.threadId, turn.agentId, attempt.deliveryBoundarySeq, endedAt);
				}
			}
		});
		return true;
	}

	/** T4 sweep + parent re-aggregation for every parent owning a converged child. */
	finalize(invocationIds: ReadonlySet<string>, now: number): number {
		const response = this.t4.runOnce();
		let reaggregated = 0;
		for (const invocationId of invocationIds) {
			const parent = this.records.get(invocationId);
			if (!parent || (parent.status !== "queued" && parent.status !== "running")) continue;
			const latest = parent.targetAgentIds.map((agentId) => this.deps.attempts.getLatest(invocationId, agentId));
			const anyTerminal = latest.some((attempt) => attempt && attempt.deliveryState !== "appended");
			if (!anyTerminal) continue;
			reaggregated += 1;
			void now;
			// The T3 collector runs inside the next drain's aggregateParent; here
			// we mark the parent eligible by leaving it non-terminal — the
			// drain/reaper loop re-runs collectTerminalDispositions. For a
			// startup pass, force one aggregate via applyTerminalAggregate when
			// nothing remains running:
			const stillRunning = latest.some((attempt) => attempt && attempt.deliveryState === "appended");
			if (!stillRunning) {
				const successful = latest
					.filter((attempt) => attempt?.deliveryState === "handled")
					.map((attempt) => attempt!.targetAgentId);
				const failed = latest.some(
					(attempt) => attempt && ["failed", "interrupted"].includes(attempt.deliveryState),
				);
				const canceledOnly =
					!failed && latest.length > 0 && latest.every((attempt) => attempt?.deliveryState === "canceled");
				if (successful.length > 0 || failed || canceledOnly) {
					this.records.applyTerminalAggregate({
						invocationId,
						status:
							successful.length === latest.length
								? "completed"
								: canceledOnly
									? "canceled"
									: successful.length > 0
										? "partial_failed"
										: "failed",
						successfulAgentIds: successful,
						terminalReason: failed ? "recovery_converged" : null,
						now,
					});
				}
			}
		}
		void response;
		return reaggregated;
	}
}

/**
 * Startup one-shot (§3.10.1): restore expired claims, interrupt
 * pre-process running children (cutoff = processStartedAt + 1), converge
 * their attempts, run T4, re-aggregate affected parents.
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
					}
					// §3.10.1: starting/queued attempts have no child — leave them
					// to the next drain (bounded backoff), not terminalized here.
					this.deps.releaseSlot(turn.threadId, turn.agentId, turn.turnExecutionId);
				}
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
 * workers → converge running children without live-worker evidence.
 * Evidence rules: unreadable liveness defers; a live worker keeps the child.
 */
export class InvocationOwnerReaper {
	private readonly deps: RecoveryDeps;
	private readonly converger: RecoveryConverger;
	private inFlight = false;

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
			responseRecovered: { pendingScanned: 0, settled: 0, missing: 0, failures: 0 },
			deferred: 0,
		};
		if (this.inFlight) return result;
		this.inFlight = true;
		try {
			result.expiredClaimsRestored = this.deps.queue.restoreExpiredClaims(now);
			result.workersReaped = this.deps.workers.reapExpired(now);
			const parents = new Set<string>();
			for (const turn of this.deps.turns.listRunning()) {
				const attempt = this.deps.attempts.getByTurnExecutionId(turn.turnExecutionId);
				if (!attempt) continue;
				parents.add(attempt.parentInvocationId);
				// Liveness evidence: a valid worker heartbeat keeps the child.
				let live = false;
				try {
					live = this.deps.isWorkerLive(turn.threadId, turn.agentId, turn.turnExecutionId);
				} catch {
					result.deferred += 1;
					continue;
				}
				if (live) continue;
				if (this.converger.convergeChild(turn.turnExecutionId, "owner_reaped", now)) {
					result.childrenInterrupted += 1;
					result.attemptsConverged += 1;
					this.deps.releaseSlot(turn.threadId, turn.agentId, turn.turnExecutionId);
				}
			}
			result.responseRecovered = new ResponseRecoveryService(this.deps).runOnce();
			result.parentsReaggregated = this.converger.finalize(parents, now);
		} finally {
			this.inFlight = false;
		}
		return result;
	}
}
