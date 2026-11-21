import type { TurnExecutionStatus } from "@superagentteam/shared/types";

import type { MessageStore } from "../message/store.ts";
import type { InvocationTracker } from "../queue/tracker.ts";
import type { InvocationAttemptStore, TurnExecutionStore } from "./store.ts";

export type LiveChildStatus = TurnExecutionStatus;
export type LiveResponseStatus = "processing" | "completed" | "failed" | "interrupted" | "canceled" | "missing";
export type LiveEvidenceRank = "record+tracker" | "tracker-only" | "record-only";

export interface LiveInvocationView {
	agentId: string;
	turnExecutionId: string;
	parentInvocationId: string;
	startedAt: number;
	childStatus: LiveChildStatus;
	responseStatus: LiveResponseStatus;
	evidenceRank: LiveEvidenceRank;
}

export interface LiveInvocationDeps {
	tracker: InvocationTracker;
	turns: TurnExecutionStore;
	attempts: InvocationAttemptStore;
	messages: MessageStore;
}

interface LiveCandidate {
	agentId: string;
	parentInvocationId: string;
	startedAt: number;
	childStatus: LiveChildStatus;
	responseMessageId: string | null;
	hasRecord: boolean;
	hasTracker: boolean;
}

function terminalResponse(status: LiveResponseStatus): boolean {
	return status === "completed" || status === "failed" || status === "interrupted" || status === "canceled";
}

function responseStatus(messages: MessageStore, messageId: string | null): LiveResponseStatus {
	if (!messageId) return "missing";
	const message = messages.get(messageId, { includeDeleted: true });
	if (!message || message.lifecycle?.kind !== "response") return "missing";
	return message.lifecycle.status;
}

/**
 * 0007 §3.10 getThreadLiveInvocations: tracker slots + durable running turns,
 * deduped by turnExecutionId, filtered once the response is terminal, sorted by
 * startedAt. Attempts only enrich the response pointer; they never invent a
 * candidate without a running turn or tracker slot (no ghost executions).
 */
export function getThreadLiveInvocations(deps: LiveInvocationDeps, threadId: string): LiveInvocationView[] {
	const candidates = new Map<string, LiveCandidate>();

	for (const turn of deps.turns.listRunning()) {
		if (turn.threadId !== threadId) continue;
		candidates.set(turn.turnExecutionId, {
			agentId: turn.agentId,
			parentInvocationId: turn.parentInvocationId,
			startedAt: turn.startedAt,
			childStatus: turn.status,
			responseMessageId: null,
			hasRecord: true,
			hasTracker: false,
		});
	}

	for (const slot of deps.tracker.getActiveSlots(threadId)) {
		const candidate = candidates.get(slot.turnExecutionId);
		if (candidate) {
			candidate.hasTracker = true;
			candidate.startedAt = Math.min(candidate.startedAt, slot.startedAt);
			continue;
		}
		const attempt = deps.attempts.getByTurnExecutionId(slot.turnExecutionId);
		candidates.set(slot.turnExecutionId, {
			agentId: slot.agentId,
			parentInvocationId: attempt?.parentInvocationId ?? "",
			startedAt: attempt?.startedAt ? Math.min(slot.startedAt, attempt.startedAt) : slot.startedAt,
			childStatus: "running",
			responseMessageId: attempt?.responseMessageId ?? null,
			hasRecord: attempt !== null,
			hasTracker: true,
		});
	}

	for (const attempt of deps.attempts.listActive()) {
		if (attempt.threadId !== threadId || !attempt.turnExecutionId) continue;
		const candidate = candidates.get(attempt.turnExecutionId);
		if (!candidate) continue;
		candidate.responseMessageId = attempt.responseMessageId;
		candidate.startedAt = Math.min(candidate.startedAt, attempt.startedAt ?? candidate.startedAt);
	}

	const views: LiveInvocationView[] = [];
	for (const [turnExecutionId, candidate] of candidates) {
		const status = responseStatus(deps.messages, candidate.responseMessageId);
		if (terminalResponse(status)) continue;
		const evidenceRank: LiveEvidenceRank =
			candidate.hasRecord && candidate.hasTracker
				? "record+tracker"
				: candidate.hasTracker
					? "tracker-only"
					: "record-only";
		views.push({
			agentId: candidate.agentId,
			turnExecutionId,
			parentInvocationId: candidate.parentInvocationId,
			startedAt: candidate.startedAt,
			childStatus: candidate.childStatus,
			responseStatus: status,
			evidenceRank,
		});
	}
	return views.sort(
		(left, right) => left.startedAt - right.startedAt || left.turnExecutionId.localeCompare(right.turnExecutionId),
	);
}
