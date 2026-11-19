import type { DatabaseSync } from "node:sqlite";
import type { QueueEntry } from "@superagentteam/shared/types";
import { runInTransaction } from "../../infrastructure/db/database.ts";
import type { QueueLedgerStore } from "../queue/store.ts";
import { type CollectorTargetView, collectTerminalDispositions } from "./collector.ts";
import type { InvocationAttemptStore, InvocationRecordStore, TurnExecutionStore } from "./store.ts";

// F018 R2-d shared T3 aggregator (§3.9): the ONE implementation used by both
// the QueueProcessor (post-dispatch) and recovery (startup/reaper). Runs in a
// write transaction, re-reads latest attempts/children/queue pending after
// the lock, and never treats starting/queued attempts or retryablePending
// targets as terminal.

export interface AggregateDeps {
	db: DatabaseSync;
	records: InvocationRecordStore;
	attempts: InvocationAttemptStore;
	turns: TurnExecutionStore;
	queue: QueueLedgerStore;
}

export interface AggregateContext {
	threadId: string;
	queueEntryId: string;
	invocationId: string;
}

export type AggregateOutcome = "terminal" | "non_terminal" | "skipped";

export function aggregateParent(deps: AggregateDeps, ctx: AggregateContext, now: number): AggregateOutcome {
	let outcome: AggregateOutcome = "skipped";
	runInTransaction(deps.db, () => {
		const parent = deps.records.get(ctx.invocationId);
		if (!parent || (parent.status !== "queued" && parent.status !== "running")) return;
		const liveEntry = deps.queue.get(ctx.threadId, ctx.queueEntryId);
		const pendingKeys = new Set((liveEntry?.targets ?? []).map((target) => `agent:${target.id}`));
		const views: CollectorTargetView[] = parent.targetAgentIds.map((agentId) => {
			const latest = deps.attempts.getLatest(ctx.invocationId, agentId);
			const child = latest?.turnExecutionId ? deps.turns.get(latest.turnExecutionId) : null;
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
				deps.records.addSuccessfulAgents(ctx.invocationId, result.successfulAgentIds);
			}
			outcome = "non_terminal";
			return;
		}
		const usageByAgent: Record<string, unknown> = {};
		for (const view of views) {
			if (view.latestAttempt?.usage) usageByAgent[view.agentId] = view.latestAttempt.usage;
		}
		deps.records.applyTerminalAggregate({
			invocationId: ctx.invocationId,
			status: result.parentStatus,
			successfulAgentIds: result.successfulAgentIds,
			terminalReason: result.primaryTerminalError,
			usageByAgent: Object.keys(usageByAgent).length > 0 ? usageByAgent : undefined,
			now,
		});
		if (result.parentStatus === "completed" || result.parentStatus === "canceled") {
			deps.queue.deleteEntry(ctx.threadId, ctx.queueEntryId);
		}
		outcome = "terminal";
	});
	return outcome;
}

/** Find the anchor entry id for a parent (from any attempt row). */
export function queueEntryIdFor(
	deps: AggregateDeps,
	invocationId: string,
	targetAgentIds: readonly string[],
): string | null {
	for (const agentId of targetAgentIds) {
		const latest = deps.attempts.getLatest(invocationId, agentId);
		if (latest?.queueEntryId) return latest.queueEntryId;
	}
	return null;
}

export type { QueueEntry };
