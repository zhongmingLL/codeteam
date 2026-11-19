import type { DatabaseSync } from "node:sqlite";

import type { InvocationAttempt, TurnExecution } from "@superagentteam/shared/types";

import { runInTransaction } from "../../infrastructure/db/database.ts";
import type { InvocationCredentialStore } from "../auth/store.ts";
import type { AgentReadStateStore, MessageStore } from "../message/store.ts";
import type { ResponseDraftStore } from "../response/store.ts";
import type { AgentSessionStore } from "../session/store.ts";
import type { ThreadStore } from "../thread/store.ts";
import type { InvocationAttemptStore, TurnExecutionStore } from "./store.ts";

// F018 R2-c settlement (0007 §3.6/§3.9 four-owner split):
// T1 invoke-single-agent + TurnExecutionLifecycle — child terminal only.
// T2 RouteResponseCommitter — response R commit only.
// T4 ResponseRecoveryService — pending/missing R recovery only.
// T3 (parent aggregate) lives in the collector + QueueProcessor wiring.
// NOTHING here writes the parent aggregate (T3's exclusive job).

export type ChildTerminalStatus = "completed" | "failed" | "interrupted" | "canceled";

export interface TurnTerminalInputR2c {
	turnExecutionId: string;
	status: ChildTerminalStatus;
	endedAt: number;
	terminalReason?: string | null;
	/** True when the turn produced a user-visible response body. */
	userVisibleOutput: boolean;
}

export type T1Outcome =
	| { outcome: "terminalized"; attempt: InvocationAttempt }
	| { outcome: "already_terminal"; attempt: InvocationAttempt }
	| { outcome: "terminal_conflict"; attempt: InvocationAttempt }
	| { outcome: "not_found"; attempt: InvocationAttempt | null };

export interface SettlementRow {
	user_message_id: string | null;
}

export interface SettlementDeps {
	db: DatabaseSync;
	turns: TurnExecutionStore;
	attempts: InvocationAttemptStore;
	credentials: InvocationCredentialStore;
	sessions: AgentSessionStore;
	readState: AgentReadStateStore;
	messages: MessageStore;
	drafts: ResponseDraftStore;
	threads: ThreadStore;
	clock?: () => number;
}

/**
 * T1 child terminal (§3.9): ONE transaction — TurnExecution terminal
 * (first-write-wins) + attempt projectChildTerminal + settlement
 * 'response_pending' + credential terminalize (canonical-first) +
 * recordCompletedTurn + delivery-cursor ack (ONLY when promptDelivered) +
 * participant insert on completed. Never writes R, drafts, or the parent.
 */
export class TurnExecutionLifecycle {
	private readonly deps: SettlementDeps;
	private readonly clock: () => number;

	constructor(deps: SettlementDeps) {
		this.deps = deps;
		this.clock = deps.clock ?? Date.now;
	}

	invokeTerminal(input: TurnTerminalInputR2c): T1Outcome {
		const attempt = this.deps.attempts.getByTurnExecutionId(input.turnExecutionId);
		if (!attempt) return { outcome: "not_found", attempt: null };
		let result: T1Outcome = { outcome: "not_found", attempt };
		runInTransaction(this.deps.db, () => {
			const terminal = this.deps.turns.transitionTerminal(input.turnExecutionId, {
				status: input.status,
				endedAt: input.endedAt,
				terminalReason: input.terminalReason ?? null,
			});
			if (terminal.outcome === "not_found") {
				result = { outcome: "not_found", attempt };
				return;
			}
			if (terminal.outcome === "already_terminal" || terminal.outcome === "conflict") {
				result = {
					outcome: terminal.outcome === "already_terminal" ? "already_terminal" : "terminal_conflict",
					attempt,
				};
				return;
			}
			const projected = this.deps.attempts.projectChildTerminal(attempt.attemptId, {
				turnExecutionId: input.turnExecutionId,
				childStatus: input.status,
				terminalReason: input.terminalReason ?? null,
				endedAt: input.endedAt,
			});
			if (projected.outcome === "terminal_conflict" || projected.outcome === "not_found") {
				throw new Error(`t1_projection_failed: ${projected.outcome}`);
			}
			// settlement: streaming → response_pending (projectChildTerminal already
			// does this for streaming; make it explicit for the non-streaming edge).
			this.deps.attempts.setSettlement(attempt.attemptId, "response_pending");
			// Credential follows child truth (0007 §5.3).
			const cred = this.deps.credentials.commitTerminal(input.turnExecutionId, input.status);
			if (cred.outcome === "conflict") throw new Error("t1_credential_conflict");
			// recordTurnTerminal: messageCount + cursor ack. The ack fires ONLY
			// when this attempt actually delivered its prompt (0010 §6.1.1
			// step 9 / §3.5.1): undelivered turns must replay next round.
			if (attempt.agentSessionId) {
				this.deps.sessions.recordCompletedTurn(attempt.agentSessionId, {
					turnExecutionId: input.turnExecutionId,
					userVisibleOutput: input.userVisibleOutput,
					now: input.endedAt,
				});
				if (attempt.promptDeliveredAt !== null && attempt.deliveryBoundarySeq !== null) {
					this.deps.readState.ack(
						attempt.threadId,
						attempt.targetAgentId,
						attempt.deliveryBoundarySeq,
						input.endedAt,
					);
				}
			}
			if (input.status === "completed" && attempt.agentSessionId) {
				// §3.9: the ONLY participant write point — first successful
				// invocation makes the agent a participant.
				this.deps.threads.addParticipant(attempt.threadId, attempt.targetAgentId, input.endedAt);
			}
			result = { outcome: "terminalized", attempt: this.deps.attempts.get(attempt.attemptId)! };
		});
		return result;
	}
}

export interface CommitResponseInput {
	turnExecutionId: string;
	/** Draft content to commit into the R message body. */
	content: string;
	thinking?: string | null;
}

export type T2Outcome =
	| { outcome: "committed"; responseMessageId: string }
	| { outcome: "already_terminal"; responseMessageId: string }
	| { outcome: "child_running"; responseMessageId: string }
	| { outcome: "response_missing"; attempt: InvocationAttempt }
	| { outcome: "not_found" };

/**
 * T2 response commit (§3.9): R terminal + settle inputs + delete draft +
 * attempt settled + clearResponsePending — separate transaction from T1.
 * Idempotent per R status; failures leave response_pending for T4.
 */
export class RouteResponseCommitter {
	private readonly deps: SettlementDeps;
	private readonly clock: () => number;

	constructor(deps: SettlementDeps) {
		this.deps = deps;
		this.clock = deps.clock ?? Date.now;
	}

	commit(input: CommitResponseInput): T2Outcome {
		const attempt = this.deps.attempts.getByTurnExecutionId(input.turnExecutionId);
		if (!attempt) return { outcome: "not_found" };
		if (!attempt.responseMessageId) return { outcome: "response_missing", attempt };
		const response = this.deps.messages.get(attempt.responseMessageId);
		if (!response) return { outcome: "response_missing", attempt };
		const now = this.clock();
		let result: T2Outcome = { outcome: "committed", responseMessageId: attempt.responseMessageId };
		runInTransaction(this.deps.db, () => {
			if (response.lifecycle?.kind === "response") {
				if (response.lifecycle.status !== "processing") {
					// Idempotent head: R already terminal — still run the
					// settling tail (refs + draft + pending) so a crash between
					// terminalize and tail completes here (round-1 P2).
					result = { outcome: "already_terminal", responseMessageId: attempt.responseMessageId! };
					this.settlingTail(attempt, now);
					return;
				}
				const child = this.deps.turns.get(input.turnExecutionId);
				const status = childStatusForResponse(child);
				if (status === "processing") {
					// Child not terminal yet — T2 must not run ahead of T1.
					result = { outcome: "child_running", responseMessageId: attempt.responseMessageId! };
					return;
				}
				// 0016 §5 / 0017 §5.2: the R carries the DRAFT's full payload —
				// body from the draft (caller content is only a fallback),
				// plus thinking and the merged toolEvents (the only source for
				// contentBlocks reconstruction once the draft is deleted).
				const draft = this.deps.drafts.getByTurn(input.turnExecutionId);
				const body = draft?.content ?? input.content;
				const thinking = draft?.thinking ?? input.thinking ?? null;
				const toolEvents = draft?.toolEvents ?? [];
				this.deps.messages.updateResponseContent(response.id, { content: body, thinking, toolEvents }, now);
				this.deps.messages.updateLifecycle(
					response.id,
					{
						...response.lifecycle,
						status,
						endedAt: now,
					},
					now,
				);
			}
			this.settlingTail(attempt, now);
		});
		return result;
	}

	/** Idempotent settling tail: input refs → settled, draft deleted, pending cleared. */
	private settlingTail(attempt: InvocationAttempt, now: number): void {
		this.settleInputDispatchRefs(attempt, now);
		this.deps.drafts.delete(attempt.turnExecutionId!);
		this.deps.turns.clearResponsePending(attempt.turnExecutionId!);
	}

	/** Public tail access for T4's already-terminal branch. */
	settleInputDispatchRefsPublic(attempt: InvocationAttempt, now: number): void {
		this.settleInputDispatchRefs(attempt, now);
	}

	private recordsRow(invocationId: string): SettlementRow | null {
		return (
			(this.deps.db
				.prepare("SELECT user_message_id FROM invocation_records WHERE invocation_id = ?")
				.get(invocationId) as SettlementRow | undefined) ?? null
		);
	}

	private settleInputDispatchRefs(attempt: InvocationAttempt, now: number): void {
		// The source input message carries one dispatchRef per (target, attempt).
		const sourceMessageId = this.sourceMessageIdFor(attempt);
		if (!sourceMessageId) return;
		const message = this.deps.messages.get(sourceMessageId, { includeDeleted: true });
		if (message?.lifecycle?.kind !== "input") return;
		const dispatchRefs = message.lifecycle.dispatchRefs.map((ref) =>
			ref.target.id === attempt.targetAgentId && ref.attempt === attempt.attempt
				? { ...ref, phase: "settled" as const }
				: ref,
		);
		this.deps.messages.updateLifecycle(message.id, { kind: "input", dispatchRefs }, now);
	}

	private sourceMessageIdFor(attempt: InvocationAttempt): string | null {
		// Primary: the live queue anchor's payload. Fallback (round-1 P2): the
		// anchor may already be deleted by T3 — the parent's userMessageId is
		// the durable equivalent.
		const row = this.deps.db
			.prepare("SELECT payload_json FROM invocation_queue WHERE queue_entry_id = ?")
			.get(attempt.queueEntryId) as { payload_json: string } | undefined;
		if (row) {
			try {
				const payload = JSON.parse(row.payload_json) as { messageId?: string | null };
				if (payload.messageId) return payload.messageId;
			} catch {
				// fall through to the parent fallback
			}
		}
		const parent = this.recordsRow(attempt.parentInvocationId);
		return parent?.user_message_id ?? null;
	}
}

function childStatusForResponse(child: TurnExecution | null): "processing" | ChildTerminalStatus {
	if (!child) return "processing";
	return child.status === "running" ? "processing" : child.status;
}

export interface T4RunResult {
	pendingScanned: number;
	settled: number;
	missing: number;
	failures: number;
}

/**
 * T4 recovery (§3.9): response_pending (crash between T1 and T2) re-runs the
 * T2 commit from the durable draft; a missing R gets a typed response_missing
 * system message and settles the attempt. Never rewrites child/credential
 * and never re-aggregates the parent.
 */
export class ResponseRecoveryService {
	private readonly deps: SettlementDeps;
	private readonly committer: RouteResponseCommitter;
	private readonly clock: () => number;

	constructor(deps: SettlementDeps) {
		this.deps = deps;
		this.clock = deps.clock ?? Date.now;
		this.committer = new RouteResponseCommitter(deps);
	}

	runOnce(): T4RunResult {
		const result: T4RunResult = { pendingScanned: 0, settled: 0, missing: 0, failures: 0 };
		const pending = this.deps.turns.listResponsePending();
		for (const turn of pending) {
			result.pendingScanned += 1;
			const attempt = this.deps.attempts.getByTurnExecutionId(turn.turnExecutionId);
			if (!attempt) {
				result.failures += 1;
				continue;
			}
			try {
				// response_missing covers BOTH a null binding and a soft-deleted
				// R (the FK forces the row to exist at bind time): typed system
				// message; NO prestart delivery_failure (0007 §3.6).
				const response = attempt.responseMessageId ? this.deps.messages.get(attempt.responseMessageId) : null;
				if (!response) {
					const now = this.clock();
					runInTransaction(this.deps.db, () => {
						// Idempotent marker: a retried recovery after a partial
						// failure must not hit the message UNIQUE (round-1 P2).
						if (!this.deps.messages.get(`rm:${attempt.attemptId}`, { includeDeleted: true })) {
							this.deps.messages.append({
								id: `rm:${attempt.attemptId}`,
								threadId: attempt.threadId,
								from: { kind: "system", service: "recovery" },
								content: "response_missing: processing response was not found for a terminal child",
								now,
							});
						}
						this.deps.drafts.delete(turn.turnExecutionId);
						this.deps.turns.clearResponsePending(turn.turnExecutionId);
					});
					result.missing += 1;
					continue;
				}
				const draft = this.deps.drafts.getByTurn(turn.turnExecutionId);
				if (response.lifecycle?.kind === "response" && response.lifecycle.status === "processing") {
					const committed = this.committer.commit({
						turnExecutionId: turn.turnExecutionId,
						content: draft?.content ?? "",
						thinking: draft?.thinking ?? null,
					});
					if (committed.outcome === "committed" || committed.outcome === "already_terminal") {
						result.settled += 1;
					} else {
						result.failures += 1;
					}
				} else {
					// R already terminal elsewhere — run the same settling tail
					// (refs + draft + pending), idempotently.
					runInTransaction(this.deps.db, () => {
						this.deps.drafts.delete(turn.turnExecutionId);
						if (attempt.queueEntryId) {
							this.committer.settleInputDispatchRefsPublic(attempt, this.clock());
						}
						this.deps.turns.clearResponsePending(turn.turnExecutionId);
					});
					result.settled += 1;
				}
			} catch {
				result.failures += 1;
			}
		}
		return result;
	}
}
