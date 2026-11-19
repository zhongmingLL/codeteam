import type { DatabaseSync } from "node:sqlite";
import type { AgentConfig, QueueEntry, QueueTarget } from "@superagentteam/shared/types";
import { runInTransaction } from "../../infrastructure/db/database.ts";
import type { AgentRegistry } from "../agent/registry.ts";
import type { InvocationCredentialStore } from "../auth/store.ts";
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

/** Post-Phase-B continuation port (R2-b: real worker/prompt/stream/T1). */
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
	| { outcome: "dispatched"; parentInvocationId: string; dispatched: string[]; invalid: string[] }
	| { outcome: "deferred"; reason: string }
	| { outcome: "nothing_startable"; parentInvocationId: string; invalid: string[] };

export interface DrainResult {
	processed: number;
	deferred: number;
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

/** Bounded backoff ledger for pre-handoff failures (base 10s, cap 1h; R2-d tunes). */
export class RetryDeferrals {
	private readonly nextEligible = new Map<string, number>();
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
		const previous = this.nextEligible.get(key) ?? now;
		const elapsedGap = Math.min(Math.max(previous - now, this.baseMs), this.capMs);
		this.nextEligible.set(key, now + elapsedGap);
	}
	eligible(threadId: string, agentId: string, now: number): boolean {
		const at = this.nextEligible.get(this.key(threadId, agentId));
		return at === undefined || at <= now;
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
		for (let i = 0; i < maxEntries; i += 1) {
			const claimed = this.claimNext(threadId, userId);
			if (!claimed) break;
			const result = await this.processEntry(claimed.entry, claimed.claimId, userId);
			if (result.outcome === "deferred") deferred += 1;
			else processed += 1;
		}
		return { processed, deferred };
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

	/** Dispatch preflight (§3.2 step 3): startable / invalid / deferred. */
	private preflight(
		entry: QueueEntry,
		startableTargets: QueueTarget[],
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
			targets.push({
				kind: "startable",
				agentId: target.id,
				agentConfig: config,
				provider: account.provider,
				model: config.defaultModel,
				attemptNumber: 0, // filled by caller against the parent record
				agentSessionId: "",
			});
		}
		// Capacity is checked for ALL startable targets (§3.2 step 3): any
		// shortage defers the whole entry before anything is created.
		const startableIds = targets.filter((t) => t.kind === "startable").map((t) => (t as { agentId: string }).agentId);
		if (this.deps.capacity && startableIds.length > 0) {
			const check = this.deps.capacity.check(entry.threadId, startableIds);
			if (!check.ok) return { targets, deferred: check.reason };
		}
		return { targets };
	}

	/** 0007 §3.2 processEntry: Phase A → tracker → Phase B per target. */
	async processEntry(entry: QueueEntry, claimId: string, userId: string): Promise<ProcessEntryResult> {
		const now = this.now();
		// Step 1-2: claim keys must still be pending on the entry.
		const claimKeys = entry.claim?.targetKeys ?? [];
		const pendingKeys = entry.targets.map((target) => `agent:${target.id}`);
		if (claimKeys.length === 0 || !claimKeys.every((key) => pendingKeys.includes(key))) {
			throw new Error("process_entry_claim_not_pending");
		}
		const claimedTargets = entry.targets.filter((target) => claimKeys.includes(`agent:${target.id}`));

		const preflight = this.preflight(entry, claimedTargets);
		// Any deferred → release + defer; nothing created (0010 §6.1.3 row 1).
		if (preflight.deferred) {
			this.deps.queue.releaseClaim(entry.threadId, entry.queueEntryId, claimId, now);
			return { outcome: "deferred", reason: preflight.deferred };
		}
		const startable = preflight.targets.filter(
			(t): t is Extract<PreflightTarget, { kind: "startable" }> => t.kind === "startable",
		);
		const invalid = preflight.targets.filter(
			(t): t is Extract<PreflightTarget, { kind: "invalid" }> => t.kind === "invalid",
		);

		// Phase A (§3.2 step 4): ONE transaction covering all claimed targets.
		const invocationId = `inv:${entry.threadId}:${entry.payload.sourceRecordId}`;
		const phaseA = runInTransaction(this.deps.db, () => {
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
			this.deps.records.markRunning(invocationId, now);
			const prepared: Array<{ agentId: string; turnExecutionId: string; attemptId: string }> = [];
			for (const target of startable) {
				const session = this.deps.sessions.ensureActive({
					threadId: entry.threadId,
					agentId: target.agentId,
					userId,
					workingDirectory: this.deps.threads.get(entry.threadId)?.projectPath ?? "",
					now,
				});
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
				const starting = this.deps.attempts.markStarting(attemptId, { agentSessionId: session.id, now });
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
				this.deps.attempts.appendQueued({
					attemptId,
					parentInvocationId: invocationId,
					queueEntryId: entry.queueEntryId,
					threadId: entry.threadId,
					targetAgentId: target.agentId,
					attempt: attemptNumber,
					now,
				});
				this.deps.attempts.markPrestartTerminal(attemptId, {
					status: "failed",
					terminalReason: "target_invalid",
					endedAt: now,
				});
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
				this.deps.queue.retireTargets(entry.threadId, entry.queueEntryId, claimId, {
					targetKeys: [`agent:${target.agentId}`],
					now,
				});
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
				this.deps.attempts.markPrestartTerminal(prepared.attemptId, {
					status: "failed",
					terminalReason: "tracker_start_failed",
					endedAt: nowB,
				});
				this.deferrals.defer(entry.threadId, prepared.agentId, nowB);
			}
			this.deps.queue.releaseClaim(entry.threadId, entry.queueEntryId, claimId, nowB);
			return { outcome: "deferred", reason: `tracker_start_failed:${startAll.agentId}` };
		}

		const dispatched: string[] = [];
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
						this.deps.queue.retireTargets(entry.threadId, entry.queueEntryId, claimId, {
							targetKeys: [`agent:${prepared.agentId}`],
							now,
						});
					});
					dispatched.push(prepared.agentId);
				} catch (error) {
					// Phase B tx rolled back: no R/child for this target; attempt
					// starting→failed + delivery_failure; target stays pending
					// (retryable); sibling targets continue (§3.2 step 6).
					const nowF = this.now();
					this.deps.attempts.markPrestartTerminal(prepared.attemptId, {
						status: "failed",
						terminalReason: "phase_b_failed",
						endedAt: nowF,
					});
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
					this.deferrals.defer(entry.threadId, prepared.agentId, nowF);
				}
			}

			// Post-Phase-B port (§3.2 step 7 / R2-b: worker spawn + prompt +
			// stream + T1) — only for targets whose Phase B committed. A port
			// failure after the Phase B commit is a provider-phase failure
			// (0010 §6.1.3 rows 6-7): NO delivery_failure; the target stays
			// pending and the deferral backs off.
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
					this.deferrals.defer(entry.threadId, prepared.agentId, this.now());
				}
			}
		} finally {
			// T3 slot release (§3.2 step 8): slots live through the dispatch
			// port (provider phase), not just Phase B; always released.
			this.deps.tracker.completeAll(
				entry.threadId,
				phaseA.map((p) => p.agentId),
			);
		}

		// §3.2 step 6 note: release whatever the claim still holds (targets
		// that never reached retireTargets stay pending for the next drain).
		this.deps.queue.releaseClaim(entry.threadId, entry.queueEntryId, claimId, this.now());

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
		};
	}
}
