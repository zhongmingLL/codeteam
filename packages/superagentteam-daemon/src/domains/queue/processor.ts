import type { DatabaseSync } from "node:sqlite";
import type { AgentConfig, QueueEntry, QueueTarget } from "@superagentteam/shared/types";
import { runInTransaction } from "../../infrastructure/db/database.ts";
import type { AgentRegistry } from "../agent/registry.ts";
import type { InvocationCredentialStore } from "../auth/store.ts";
import { type CollectorTargetView, collectTerminalDispositions } from "../invocation/collector.ts";
import type { InvocationAttemptStore, InvocationRecordStore, TurnExecutionStore } from "../invocation/store.ts";
import type { MessageStore } from "../message/store.ts";
import type { ResponseDraftStore } from "../response/store.ts";
import type { AgentSessionStore } from "../session/store.ts";
import type { ThreadStore } from "../thread/store.ts";
import type { QueueLedgerStore } from "./store.ts";
import type { InvocationTracker } from "./tracker.ts";

// F018 R2-a QueueProcessor (0007 §3.2 + 0010 §6.1.1 steps 1-4): candidate
// selection, dispatch preflight, Phase A single transaction (parent + all
// claimed target attempts starting), Phase B per-target dispatch transaction
// (processing R + TurnExecution + credential + draft + retireTargets).
// Everything AFTER the Phase B commit (worker spawn / prompt / stream / T1)
// is the injected dispatchTarget port — the real runAgentTurn lands in R2-b.

export interface PreparedDispatch {
	threadId: string;
	userId: string;
	parentInvocationId: string;
	queueEntryId: string;
	sourceMessageId: string | null;
	agentId: string;
	agentConfig: AgentConfig;
	provider: string;
	model: string;
	/** Resolves at provider time; null through the dispatch transaction. */
	modelFamily: string | null;
	attemptId: string;
	turnExecutionId: string;
	agentSessionId: string;
	responseMessageId: string;
	claimId: string;
}

/**
 * Post-Phase-B continuation port (R2-b: real worker/prompt/stream/T1).
 *
 * PORT CONTRACT (round-2 review):
 * - The port OWES terminalization: on provider-phase failure it either (a)
 *   throws WITHOUT having terminalized anything (the processor then converges
 *   turn/attempt/credential/R to failed and restores the target), or (b)
 *   performs its own T1 terminal + settlement and returns WITHOUT throwing.
 *   Terminalize-then-throw is a contract violation: the processor's
 *   convergence would hit already_terminal conflicts and surface a typed
 *   convergenceFailed instead of silently double-converging.
 * - The port must release/retire any worker it acquired before throwing
 *   (warmTtl=0); the processor does not know worker ids.
 * - The port must not touch the queue claim or targets; retirement/restore
 *   is processor-owned.
 */
export interface DispatchTargetPort {
	dispatch(prepared: PreparedDispatch): Promise<void>;
}

/** Optional capacity preflight (R2-b: WorkerPool.checkCapacity). */
export interface CapacityChecker {
	check(threadId: string, targets: readonly string[]): { ok: true } | { ok: false; reason: string };
}

export interface QueueProcessorDeps {
	db: DatabaseSync;
	registry: AgentRegistry;
	queue: QueueLedgerStore;
	records: InvocationRecordStore;
	turns: TurnExecutionStore;
	attempts: InvocationAttemptStore;
	sessions: AgentSessionStore;
	credentials: InvocationCredentialStore;
	drafts: ResponseDraftStore;
	messages: MessageStore;
	threads: ThreadStore;
	tracker: InvocationTracker;
	dispatchTarget: DispatchTargetPort;
	capacity?: CapacityChecker;
	clock?: () => number;
	owner?: string;
}

export type ProcessEntryResult =
	| {
			outcome: "dispatched";
			parentInvocationId: string;
			dispatched: string[];
			invalid: string[];
			/** Targets whose provider phase failed AND whose convergence tx also failed (typed, recoverable). */
			convergenceFailed?: string[];
	  }
	| { outcome: "deferred"; reason: string }
	| { outcome: "nothing_startable"; parentInvocationId: string; invalid: string[] };

export interface DrainResult {
	processed: number;
	deferred: number;
	/** Targets whose provider-phase convergence transaction failed (typed, recoverable). */
	convergenceFailed: string[];
}

type PreflightTarget =
	| {
			kind: "startable";
			agentId: string;
			agentConfig: AgentConfig;
			provider: string;
			model: string;
			attemptNumber: number;
			agentSessionId: string;
	  }
	| { kind: "invalid"; agentId: string; reason: "agent_not_found" | "agent_disabled" | "account_not_found" };

/** Bounded exponential backoff ledger for pre-handoff failures (base 10s, cap 1h; R2-d tunes). */
export class RetryDeferrals {
	private readonly nextEligible = new Map<string, number>();
	private readonly lastGap = new Map<string, number>();
	private readonly baseMs: number;
	private readonly capMs: number;
	constructor(baseMs = 10_000, capMs = 3_600_000) {
		this.baseMs = baseMs;
		this.capMs = capMs;
	}
	private key(threadId: string, agentId: string): string {
		return `${threadId}\u0000${agentId}`;
	}
	defer(threadId: string, agentId: string, now: number): void {
		const key = this.key(threadId, agentId);
		const gap = Math.min((this.lastGap.get(key) ?? this.baseMs / 2) * 2, this.capMs);
		this.lastGap.set(key, gap);
		this.nextEligible.set(key, now + gap);
	}
	eligible(threadId: string, agentId: string, now: number): boolean {
		const at = this.nextEligible.get(this.key(threadId, agentId));
		return at === undefined || at <= now;
	}
	/** Successful dispatch resets the backoff ladder (next failure starts at base). */
	reset(threadId: string, agentId: string): void {
		const key = this.key(threadId, agentId);
		this.nextEligible.delete(key);
		this.lastGap.delete(key);
	}
}

export class QueueProcessor {
	private readonly deps: QueueProcessorDeps;
	private readonly deferrals = new RetryDeferrals();

	constructor(deps: QueueProcessorDeps) {
		this.deps = deps;
	}

	private now(): number {
		return this.deps.clock ? this.deps.clock() : Date.now();
	}

	isThreadBusy(threadId: string): boolean {
		return this.deps.tracker.has(threadId);
	}

	isAgentBusy(threadId: string, agentId: string): boolean {
		return this.deps.tracker.isBusy(threadId, agentId);
	}

	hasQueuedForThread(threadId: string): boolean {
		return this.deps.queue.listQueued(threadId).length > 0;
	}

	/**
	 * 0007 §3.2 candidate selection: listQueued → filter busy/deferred →
	 * claim → processEntry. One entry per drain; subsequent drains pick up
	 * parallel-target entries.
	 */
	async drain(threadId: string, userId: string, options: { maxEntries?: number } = {}): Promise<DrainResult> {
		const maxEntries = options.maxEntries ?? 1;
		let processed = 0;
		let deferred = 0;
		const convergenceFailed: string[] = [];
		for (let i = 0; i < maxEntries; i += 1) {
			const claimed = this.claimNext(threadId, userId);
			if (!claimed) break;
			const result = await this.processEntry(claimed.entry, claimed.claimId, userId);
			if (result.outcome === "deferred") {
				deferred += 1;
			} else {
				processed += 1;
				if (result.outcome === "dispatched" && result.convergenceFailed) {
					convergenceFailed.push(...result.convergenceFailed);
				}
			}
		}
		return { processed, deferred, convergenceFailed };
	}

	private claimNext(threadId: string, userId: string): { entry: QueueEntry; claimId: string } | null {
		const entries = this.deps.queue.listQueued(threadId);
		const held = new Set<string>();
		const now = this.now();
		for (const entry of entries) {
			const startable = entry.targets.filter(
				(target) =>
					target.kind === "agent" &&
					!this.deps.tracker.isBusy(threadId, target.id) &&
					this.deferrals.eligible(threadId, target.id, now),
			);
			if (startable.length === 0) {
				for (const target of entry.targets) held.add(`agent:${target.id}`);
				continue;
			}
			const keys = startable.map((target) => `agent:${target.id}`);
			if (keys.some((key) => held.has(key))) continue;
			const claimId = `claim:${entry.queueEntryId}:${now}:${Math.random().toString(36).slice(2, 8)}`;
			const claimed = this.deps.queue.claim(threadId, entry.queueEntryId, {
				claimId,
				owner: this.deps.owner ?? `processor:${userId}`,
				ttlMs: 60_000,
				targetKeys: keys,
				now,
			});
			if (claimed.outcome === "claimed") return { entry: claimed.entry, claimId };
			for (const key of keys) held.add(key);
		}
		return null;
	}

	/**
	 * Dispatch preflight (§3.2 step 3, 0010 §6.1.1 order): resolve config →
	 * ensureActive session → capacity. Classification: startable / invalid
	 * (permanent) / deferred (transient — any shortage defers the WHOLE entry
	 * before anything is created and records a bounded backoff).
	 */
	private preflight(
		entry: QueueEntry,
		startableTargets: QueueTarget[],
		userId: string,
	): {
		targets: PreflightTarget[];
		deferred?: string;
	} {
		const targets: PreflightTarget[] = [];
		for (const target of startableTargets) {
			const config = this.deps.registry.agents.get(target.id);
			if (!config) {
				targets.push({ kind: "invalid", agentId: target.id, reason: "agent_not_found" });
				continue;
			}
			if (!config.enabled) {
				targets.push({ kind: "invalid", agentId: target.id, reason: "agent_disabled" });
				continue;
			}
			const account = this.deps.registry.accounts.get(config.accountRef);
			if (!account) {
				targets.push({ kind: "invalid", agentId: target.id, reason: "account_not_found" });
				continue;
			}
			// 0010 §6.1.1 step 1: ensureActive per claimed target BEFORE
			// capacity/Phase A (session rows are durable identity, safe to
			// create outside the Phase A transaction).
			const session = this.deps.sessions.ensureActive({
				threadId: entry.threadId,
				agentId: target.id,
				userId,
				workingDirectory: this.deps.threads.get(entry.threadId)?.projectPath ?? "",
				now: this.now(),
			});
			targets.push({
				kind: "startable",
				agentId: target.id,
				agentConfig: config,
				provider: account.provider,
				model: config.defaultModel,
				attemptNumber: 0, // filled by Phase A against the parent record
				agentSessionId: session.id,
			});
		}
		// 0010 §6.1.1 step 2: capacity over ALL startable targets; any
		// shortage defers the whole entry and records a bounded backoff so
		// consecutive drains do not spin.
		const startableIds = targets.filter((t) => t.kind === "startable").map((t) => (t as { agentId: string }).agentId);
		if (this.deps.capacity && startableIds.length > 0) {
			const check = this.deps.capacity.check(entry.threadId, startableIds);
			if (!check.ok) {
				const now = this.now();
				for (const agentId of startableIds) this.deferrals.defer(entry.threadId, agentId, now);
				return { targets, deferred: check.reason };
			}
		}
		return { targets };
	}

	/** 0007 §3.2 processEntry: Phase A → tracker → Phase B per target. */
	async processEntry(entry: QueueEntry, claimId: string, userId: string): Promise<ProcessEntryResult> {
		const now = this.now();
		const invocationId = `inv:${entry.threadId}:${entry.payload.sourceRecordId}`;
		let phaseA: Array<{ agentId: string; turnExecutionId: string; attemptId: string }> = [];
		let startable: Array<Extract<PreflightTarget, { kind: "startable" }>> = [];
		let invalid: Array<Extract<PreflightTarget, { kind: "invalid" }>> = [];
		try {
			// Step 1-2: claim keys must still be pending on the entry.
			const claimKeys = entry.claim?.targetKeys ?? [];
			const pendingKeys = entry.targets.map((target) => `agent:${target.id}`);
			if (claimKeys.length === 0 || !claimKeys.every((key) => pendingKeys.includes(key))) {
				throw new Error("process_entry_claim_not_pending");
			}
			const claimedTargets = entry.targets.filter((target) => claimKeys.includes(`agent:${target.id}`));

			const preflight = this.preflight(entry, claimedTargets, userId);
			// Any deferred → release + defer; nothing created (0010 §6.1.3 row 1).
			if (preflight.deferred) {
				this.deps.queue.releaseClaim(entry.threadId, entry.queueEntryId, claimId, now);
				return { outcome: "deferred", reason: preflight.deferred };
			}
			startable = preflight.targets.filter(
				(t): t is Extract<PreflightTarget, { kind: "startable" }> => t.kind === "startable",
			);
			invalid = preflight.targets.filter(
				(t): t is Extract<PreflightTarget, { kind: "invalid" }> => t.kind === "invalid",
			);

			// Phase A (§3.2 step 4): ONE transaction covering all claimed targets.
			phaseA = runInTransaction(this.deps.db, () => {
				const created = this.deps.records.create({
					invocationId,
					threadId: entry.threadId,
					userId,
					sourceRecordId: entry.payload.sourceRecordId,
					userMessageId: entry.payload.messageId ?? null,
					targetAgentIds: entry.targets.map((target) => target.id),
					now,
				});
				if (created.outcome === "conflict") throw new Error("phase_a_parent_conflict");
				// P2: a terminal/missing parent must not admit new attempts.
				if (!this.deps.records.markRunning(invocationId, now)) {
					throw new Error("phase_a_parent_not_runnable");
				}
				const prepared: Array<{ agentId: string; turnExecutionId: string; attemptId: string }> = [];
				for (const target of startable) {
					const attemptNumber = (this.deps.attempts.getLatest(invocationId, target.agentId)?.attempt ?? 0) + 1;
					const attemptId = `att:${invocationId}:${target.agentId}:${attemptNumber}`;
					const appended = this.deps.attempts.appendQueued({
						attemptId,
						parentInvocationId: invocationId,
						queueEntryId: entry.queueEntryId,
						threadId: entry.threadId,
						targetAgentId: target.agentId,
						attempt: attemptNumber,
						now,
					});
					if (appended.outcome === "conflict") throw new Error("phase_a_attempt_conflict");
					const starting = this.deps.attempts.markStarting(attemptId, {
						agentSessionId: target.agentSessionId,
						now,
					});
					// markStarting null/conflict (held gate pierced) rolls back the
					// whole Phase A (§3.2 step 4 bullet 4).
					if (!starting || starting.deliveryState !== "starting") throw new Error("phase_a_mark_starting_failed");
					prepared.push({
						agentId: target.agentId,
						turnExecutionId: `te:${attemptId}`,
						attemptId,
					});
				}
				for (const target of invalid) {
					const attemptNumber = (this.deps.attempts.getLatest(invocationId, target.agentId)?.attempt ?? 0) + 1;
					const attemptId = `att:${invocationId}:${target.agentId}:${attemptNumber}`;
					const appended = this.deps.attempts.appendQueued({
						attemptId,
						parentInvocationId: invocationId,
						queueEntryId: entry.queueEntryId,
						threadId: entry.threadId,
						targetAgentId: target.agentId,
						attempt: attemptNumber,
						now,
					});
					if (appended.outcome === "conflict") throw new Error("phase_a_invalid_attempt_conflict");
					const terminal = this.deps.attempts.markPrestartTerminal(attemptId, {
						status: "failed",
						terminalReason: "target_invalid",
						endedAt: now,
					});
					if (!terminal || terminal.deliveryState !== "failed") throw new Error("phase_a_invalid_terminal_failed");
					this.deps.messages.append({
						id: `df:${attemptId}`,
						threadId: entry.threadId,
						from: { kind: "system", service: "queue" },
						content: `delivery_failure (${target.reason})`,
						lifecycle: {
							kind: "delivery_failure",
							status: "failed",
							sourceEntryId: entry.queueEntryId,
							inputMessageId: entry.payload.messageId ?? entry.payload.sourceRecordId,
							requestedTargets: [{ kind: "agent", id: target.agentId }],
							reason: "target_invalid",
							createdAt: now,
						},
						now,
					});
					const retired = this.deps.queue.retireTargets(entry.threadId, entry.queueEntryId, claimId, {
						targetKeys: [`agent:${target.agentId}`],
						now,
					});
					if (retired.outcome !== "updated" && retired.outcome !== "retired_all") {
						throw new Error("phase_a_invalid_retire_state_changed");
					}
				}
				return prepared;
			});

			// Step 5: tracker.startAll all-or-nothing; failure → prestart failed,
			// release + defer (no delivery_failure).
			const startAll = this.deps.tracker.startAll(
				entry.threadId,
				phaseA.map((p) => ({ agentId: p.agentId, turnExecutionId: p.turnExecutionId })),
				userId,
			);
			if ("error" in startAll) {
				const nowB = this.now();
				for (const prepared of phaseA) {
					const terminal = this.deps.attempts.markPrestartTerminal(prepared.attemptId, {
						status: "failed",
						terminalReason: "tracker_start_failed",
						endedAt: nowB,
					});
					if (!terminal || terminal.deliveryState !== "failed") {
						throw new Error(`tracker_start_terminal_failed: ${prepared.agentId}`);
					}
					this.deferrals.defer(entry.threadId, prepared.agentId, nowB);
				}
				this.deps.queue.releaseClaim(entry.threadId, entry.queueEntryId, claimId, nowB);
				return { outcome: "deferred", reason: `tracker_start_failed:${startAll.agentId}` };
			}
		} catch (error) {
			// P1-1: ANY pre-Phase-B failure (validation, preflight throw, Phase A
			// rollback, startAll setup) releases the claim and defers — the
			// entry must not sit claimed until TTL (0010 §6.1.3 rows 1/3/4).
			// Permanent causes (owner/registry/workspace/parent-terminal) are
			// tagged so retry policy (R2-d) can stop backing off on them.
			const message = String(error);
			const permanent =
				/owner|workspace|parent_not_runnable|parent_conflict|agent_not_found|agent_disabled|account_not_found/.test(
					message,
				);
			this.deps.queue.releaseClaim(entry.threadId, entry.queueEntryId, claimId, this.now());
			return { outcome: "deferred", reason: permanent ? `permanent:${message}` : message };
		}

		const dispatched: string[] = [];
		const convergenceFailed: string[] = [];
		try {
			// Phase B (§3.2 step 6): per-target independent dispatch transaction.
			// A failing target writes delivery_failure and stays pending; healthy
			// siblings keep going (per-target isolation, not entry-level abort).
			for (const prepared of phaseA) {
				const target = startable.find((t) => t.agentId === prepared.agentId)!;
				const session = this.deps.sessions.getActive(entry.threadId, prepared.agentId);
				if (!session) {
					throw new Error(`phase_b_session_lost: ${prepared.agentId}`);
				}
				const responseMessageId = `resp:${prepared.turnExecutionId}`;
				try {
					runInTransaction(this.deps.db, () => {
						this.deps.messages.append({
							id: responseMessageId,
							threadId: entry.threadId,
							from: { kind: "agent", agentId: prepared.agentId },
							content: "",
							lifecycle: {
								kind: "response",
								parentInvocationId: invocationId,
								turnExecutionId: prepared.turnExecutionId,
								target: { kind: "agent", id: prepared.agentId },
								status: "processing",
								startedAt: now,
							},
							now,
						});
						const turn = this.deps.turns.createRunning({
							turnExecutionId: prepared.turnExecutionId,
							parentInvocationId: invocationId,
							threadId: entry.threadId,
							userId,
							agentId: prepared.agentId,
							executionKind: "ordinary",
							causal: { triggerMessageId: entry.payload.messageId ?? entry.payload.sourceRecordId },
							startedAt: now,
						});
						if (turn.outcome === "conflict") throw new Error("phase_b_turn_conflict");
						this.deps.attempts.bindAppended(prepared.attemptId, {
							turnExecutionId: prepared.turnExecutionId,
							agentSessionId: session.id,
							workerId: null,
							provider: target.provider,
							model: target.model,
							modelFamily: null,
							responseMessageId,
							now,
						});
						this.deps.credentials.create({
							turnExecutionId: prepared.turnExecutionId,
							parentInvocationId: invocationId,
							threadId: entry.threadId,
							agentId: prepared.agentId,
							agentSessionId: session.id,
							userId,
							allowedTools: [],
							now,
						});
						this.deps.drafts.create({
							attemptId: prepared.attemptId,
							turnExecutionId: prepared.turnExecutionId,
							parentInvocationId: invocationId,
							threadId: entry.threadId,
							agentId: prepared.agentId,
							content: "",
							toolEvents: [],
							thinking: null,
							createdAt: now,
							updatedAt: now,
						});
						if (entry.payload.messageId) {
							this.deps.messages.appendDispatchRef(
								entry.payload.messageId,
								{
									target: { kind: "agent", id: prepared.agentId },
									queueEntryId: entry.queueEntryId,
									attempt: this.deps.attempts.get(prepared.attemptId)?.attempt ?? 1,
									turnExecutionId: prepared.turnExecutionId,
									at: now,
								},
								now,
							);
						}
						// P2: a lost claim must NOT commit R/child/credential for a
						// still-pending target (double-dispatch risk) — the whole
						// Phase B transaction rolls back instead.
						const retired = this.deps.queue.retireTargets(entry.threadId, entry.queueEntryId, claimId, {
							targetKeys: [`agent:${prepared.agentId}`],
							now,
						});
						if (retired.outcome !== "updated" && retired.outcome !== "retired_all") {
							throw new Error("phase_b_retire_state_changed");
						}
					});
					dispatched.push(prepared.agentId);
					this.deferrals.reset(entry.threadId, prepared.agentId);
				} catch (error) {
					// Phase B tx rolled back: no R/child for this target; attempt
					// starting→failed + delivery_failure in ONE transaction (a
					// failing append must not leave the attempt marked failed
					// without its receipt); target stays pending (retryable);
					// sibling targets continue (§3.2 step 6).
					const nowF = this.now();
					runInTransaction(this.deps.db, () => {
						const terminal = this.deps.attempts.markPrestartTerminal(prepared.attemptId, {
							status: "failed",
							terminalReason: "phase_b_failed",
							endedAt: nowF,
						});
						if (!terminal || terminal.deliveryState !== "failed") {
							throw new Error(`phase_b_terminal_failed: ${prepared.agentId}`);
						}
						this.deps.messages.append({
							id: `df:${prepared.attemptId}`,
							threadId: entry.threadId,
							from: { kind: "system", service: "queue" },
							content: `delivery_failure (phase_b_failed): ${String(error)}`,
							lifecycle: {
								kind: "delivery_failure",
								status: "failed",
								sourceEntryId: entry.queueEntryId,
								inputMessageId: entry.payload.messageId ?? entry.payload.sourceRecordId,
								requestedTargets: [{ kind: "agent", id: prepared.agentId }],
								reason: "phase_b_failed",
								createdAt: nowF,
							},
							now: nowF,
						});
					});
					this.deferrals.defer(entry.threadId, prepared.agentId, nowF);
				}
			}

			// Post-Phase-B port (§3.2 step 7 / R2-b: worker spawn + prompt +
			// stream + T1) — only for targets whose Phase B committed.
			for (const agentId of dispatched) {
				const prepared = phaseA.find((p) => p.agentId === agentId)!;
				const target = startable.find((t) => t.agentId === prepared.agentId)!;
				const session = this.deps.sessions.getActive(entry.threadId, prepared.agentId)!;
				try {
					await this.deps.dispatchTarget.dispatch({
						threadId: entry.threadId,
						userId,
						parentInvocationId: invocationId,
						queueEntryId: entry.queueEntryId,
						sourceMessageId: entry.payload.messageId ?? null,
						agentId: prepared.agentId,
						agentConfig: target.agentConfig,
						provider: target.provider,
						model: target.model,
						modelFamily: null,
						attemptId: prepared.attemptId,
						turnExecutionId: prepared.turnExecutionId,
						agentSessionId: session.id,
						responseMessageId: `resp:${prepared.turnExecutionId}`,
						claimId,
					});
				} catch {
					// P1-2: provider-phase failure must NOT strand an appended
					// attempt / running turn / processing R with a retired target
					// (0010 §6.1.3 row 6). Converge the chain terminal-failed and
					// put the target back on the entry so the bounded backoff can
					// re-dispatch (new attempt). No delivery_failure, no ack.
					// Round-2: the convergence itself is caught — a failing
					// convergence (port terminalized before throwing, claim
					// changed hands) surfaces a typed convergenceFailed instead
					// of escaping and skipping the final claim release.
					const nowP = this.now();
					const responseMessageId = `resp:${prepared.turnExecutionId}`;
					try {
						runInTransaction(this.deps.db, () => {
							const terminal = this.deps.turns.transitionTerminal(prepared.turnExecutionId, {
								status: "failed",
								endedAt: nowP,
								terminalReason: "provider_phase_failed",
							});
							if (terminal.outcome === "not_found" || terminal.outcome === "conflict") {
								throw new Error("provider_phase_terminal_conflict");
							}
							const projected = this.deps.attempts.projectChildTerminal(prepared.attemptId, {
								turnExecutionId: prepared.turnExecutionId,
								childStatus: "failed",
								terminalReason: "provider_phase_failed",
								endedAt: nowP,
							});
							if (projected.outcome === "not_found" || projected.outcome === "terminal_conflict") {
								throw new Error("provider_phase_projection_conflict");
							}
							// Credential follows child truth (0007 §5.3, T1
							// same close-out): canonical-first commitTerminal.
							const cred = this.deps.credentials.commitTerminal(prepared.turnExecutionId, "failed");
							if (cred.outcome === "not_found" || cred.outcome === "conflict") {
								throw new Error("provider_phase_credential_conflict");
							}
							// The response R is terminal-failed here (no T2 will
							// commit it); settle the attempt so T4 has nothing
							// dangling to recover, and drop the empty draft.
							this.deps.attempts.setSettlement(prepared.attemptId, "settled", responseMessageId);
							this.deps.drafts.delete(prepared.turnExecutionId);
							const response = this.deps.messages.get(responseMessageId, { includeDeleted: true });
							if (response?.lifecycle?.kind === "response") {
								this.deps.messages.updateLifecycle(
									responseMessageId,
									{ ...response.lifecycle, status: "failed", endedAt: nowP },
									nowP,
								);
							}
							const restored = this.deps.queue.restoreTargets(entry.threadId, entry.queueEntryId, claimId, {
								targets: [{ kind: "agent", id: prepared.agentId }],
								now: nowP,
							});
							if (restored.outcome !== "updated") {
								throw new Error("provider_phase_restore_state_changed");
							}
						});
					} catch (convergenceError) {
						convergenceFailed.push(prepared.agentId);
						void convergenceError;
					} finally {
						this.deferrals.defer(entry.threadId, prepared.agentId, nowP);
					}
				}
			}
		} finally {
			// T3 slot release (§3.2 step 8): per-target ownership-fenced complete
			// so a stale finally cannot release a replacement slot. The claim is
			// released HERE too — an escaping exception must not leave it
			// claimed until TTL (round-2 P1-2).
			for (const prepared of phaseA) {
				this.deps.tracker.complete(entry.threadId, prepared.agentId, prepared.turnExecutionId);
			}
			// §3.2 step 6 note: release whatever the claim still holds (targets
			// that never reached retireTargets stay pending for the next drain).
			this.deps.queue.releaseClaim(entry.threadId, entry.queueEntryId, claimId, this.now());
			// T3 parent aggregate (§3.9): re-read under the write lock (the
			// dispatch loop above may have terminalized children) and apply.
			// Failure keeps the parent non-terminal; recovery re-runs this
			// idempotently.
			try {
				this.aggregateParent(entry, invocationId, userId);
			} catch {
				// T3 失败保留 parent 原状态（§3.9）。
			}
		}

		if (dispatched.length === 0 && invalid.length > 0) {
			return {
				outcome: "nothing_startable",
				parentInvocationId: invocationId,
				invalid: invalid.map((t) => t.agentId),
			};
		}
		return {
			outcome: "dispatched",
			parentInvocationId: invocationId,
			dispatched,
			invalid: invalid.map((t) => t.agentId),
			convergenceFailed: convergenceFailed.length > 0 ? convergenceFailed : undefined,
		};
	}

	/**
	 * T3 parent aggregate (§3.9): collector over per-target latest attempt +
	 * canonical child + queue pending; writes parent status /
	 * successfulAgentIds / terminalReason and deletes terminal queue entries.
	 * Never writes child/credential/R.
	 */
	private aggregateParent(entry: QueueEntry, invocationId: string, _userId: string): void {
		const parent = this.deps.records.get(invocationId);
		if (!parent || (parent.status !== "queued" && parent.status !== "running")) return;
		const liveEntry = this.deps.queue.get(entry.threadId, entry.queueEntryId);
		const pendingKeys = new Set((liveEntry?.targets ?? []).map((target) => `agent:${target.id}`));
		const views: CollectorTargetView[] = parent.targetAgentIds.map((agentId) => {
			const latest = this.deps.attempts.getLatest(invocationId, agentId);
			const child = latest?.turnExecutionId ? this.deps.turns.get(latest.turnExecutionId) : null;
			return {
				agentId,
				latestAttempt: latest,
				child,
				retryablePending:
					pendingKeys.has(`agent:${agentId}`) &&
					(latest?.deliveryState === "failed" || latest?.deliveryState === "interrupted"),
			};
		});
		const result = collectTerminalDispositions({ parent, targets: views });
		if (result.parentStatus === "running" || result.parentStatus === "queued") {
			if (result.successfulAgentIds.length > 0) {
				this.deps.records.addSuccessfulAgents(invocationId, result.successfulAgentIds);
			}
			return;
		}
		this.deps.records.applyTerminalAggregate({
			invocationId,
			status: result.parentStatus,
			successfulAgentIds: result.successfulAgentIds,
			terminalReason: result.primaryTerminalError,
			now: this.now(),
		});
		// §3.2: parent completed/canceled → delete the anchor entry;
		// partial_failed/failed stay for retry/abandon/TTL.
		if (result.parentStatus === "completed" || result.parentStatus === "canceled") {
			this.deps.queue.deleteEntry(entry.threadId, entry.queueEntryId);
		}
	}
}
