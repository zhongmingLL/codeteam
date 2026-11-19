import type { InvocationAttempt, InvocationRecord, TurnExecution } from "@superagentteam/shared/types";

// F018 R2-c PerAgentTerminalDispositionCollector (0007 §3.9): a PURE
// aggregation over the latest attempt + canonical child per target. The
// QueueProcessor re-reads attempts/children under the write lock before
// applying, so two children reaching terminal concurrently cannot lose
// updates. This module writes nothing.

export type ParentTerminalStatus = "completed" | "partial_failed" | "failed" | "canceled";

export interface CollectorTargetView {
	agentId: string;
	/** Latest attempt for the target (null when none was ever created). */
	latestAttempt: InvocationAttempt | null;
	/** Canonical TurnExecution bound to the latest attempt (null prestart). */
	child: TurnExecution | null;
	/** Target still on the queue entry's pending targets with a deferral. */
	retryablePending: boolean;
}

export interface CollectorInput {
	parent: InvocationRecord;
	targets: readonly CollectorTargetView[];
}

export interface CollectorResult {
	parentStatus: ParentTerminalStatus | "running" | "queued";
	successfulAgentIds: string[];
	primaryTerminalError: string | null;
	/** Targets whose latest attempt failed but remain pending+deferred. */
	retryablePendingAgentIds: string[];
	allTargetsCanceled: boolean;
}

/**
 * §3.9 aggregation table:
 * - any child running (or no child and not retryablePending) → running
 * - all children completed → completed
 * - ≥1 completed + ≥1 failed-face, no running/pending → partial_failed
 * - 0 completed, all canceled → canceled; else failed
 * - first attempt not started and retryCount=0 → queued
 */
export function collectTerminalDispositions(input: CollectorInput): CollectorResult {
	const { parent, targets } = input;
	const successfulAgentIds: string[] = [];
	const retryablePendingAgentIds: string[] = [];
	let primaryTerminalError: string | null = null;
	let completed = 0;
	let failedFace = 0; // failed | interrupted
	let canceled = 0;
	let running = 0;
	let notStartedNonRetryable = 0;

	for (const target of targets) {
		const child = target.child;
		const attempt = target.latestAttempt;
		if (!child && !attempt) {
			// No attempt row at all (dispatch never reached this target).
			if (target.retryablePending) retryablePendingAgentIds.push(target.agentId);
			else notStartedNonRetryable += 1;
			continue;
		}
		if (child) {
			if (child.status === "running") {
				running += 1;
				continue;
			}
			if (child.status === "completed") {
				completed += 1;
				successfulAgentIds.push(target.agentId);
				continue;
			}
			if (child.status === "failed" || child.status === "interrupted") {
				failedFace += 1;
				primaryTerminalError ??= child.terminalReason ?? child.status;
			} else {
				canceled += 1;
				primaryTerminalError ??= child.terminalReason ?? "canceled";
			}
			// A failed-face/canceled target with a pending+deferred retry stays
			// non-terminal for the parent.
			if (target.retryablePending) retryablePendingAgentIds.push(target.agentId);
			continue;
		}
		// Attempt exists but no child (prestart failure): read delivery_state.
		if (attempt) {
			if (attempt.deliveryState === "failed" || attempt.deliveryState === "interrupted") {
				failedFace += 1;
				primaryTerminalError ??= attempt.terminalReason ?? attempt.deliveryState;
				if (target.retryablePending) retryablePendingAgentIds.push(target.agentId);
			} else if (attempt.deliveryState === "canceled") {
				canceled += 1;
				primaryTerminalError ??= attempt.terminalReason ?? "canceled";
			} else {
				// queued/starting/appended without a child: still in flight.
				running += 1;
			}
		}
	}

	const blocked = running > 0 || notStartedNonRetryable > 0 || retryablePendingAgentIds.length > 0;
	if (blocked) {
		// 0020 §3.9: retry admitted + no new child yet → queued, not running.
		if (completed === 0 && failedFace === 0 && canceled === 0 && parent.retryCount > 0) {
			return {
				parentStatus: "queued",
				successfulAgentIds,
				primaryTerminalError,
				retryablePendingAgentIds,
				allTargetsCanceled: false,
			};
		}
		return {
			parentStatus: "running",
			successfulAgentIds,
			primaryTerminalError,
			retryablePendingAgentIds,
			allTargetsCanceled: false,
		};
	}
	const allTargetsCanceled = canceled > 0 && completed === 0 && failedFace === 0;
	if (completed === targets.length) {
		return {
			parentStatus: "completed",
			successfulAgentIds,
			primaryTerminalError: null,
			retryablePendingAgentIds,
			allTargetsCanceled: false,
		};
	}
	return {
		parentStatus: allTargetsCanceled ? "canceled" : completed > 0 ? "partial_failed" : "failed",
		successfulAgentIds,
		primaryTerminalError,
		retryablePendingAgentIds,
		allTargetsCanceled,
	};
}
