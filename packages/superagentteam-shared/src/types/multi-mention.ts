// F018 R3 multi_mention contract types (0007 §3.8, DP-F018MM-1=B).
// Durable group lifecycle + per-target outcome pointers + callback delivery.
// These types are defined fresh for the F018 v1 store; they do not import
// Clowder runtime types.

export type MultiMentionStatus = "pending" | "running" | "partial" | "done" | "timeout" | "failed";

export const MULTI_MENTION_TERMINAL_STATUSES: ReadonlySet<MultiMentionStatus> = new Set(["done", "timeout", "failed"]);

export type MultiMentionTargetStatus = "received" | "timeout" | "failed";
export type MultiMentionResponseState = "pending" | "terminal" | "missing";

export type MultiMentionCallbackStatus =
	| "pending"
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "interrupted"
	| "canceled";

export type MultiMentionTriggerType = "high-impact" | "cross-domain" | "uncertain" | "info-gap" | "recon";

export const MULTI_MENTION_MIN_TARGETS = 2;
export const MULTI_MENTION_MAX_TARGETS = 3;
export const MULTI_MENTION_MIN_TIMEOUT_MINUTES = 3;
export const MULTI_MENTION_MAX_TIMEOUT_MINUTES = 20;
export const MULTI_MENTION_DEFAULT_TIMEOUT_MINUTES = 8;
export const MULTI_MENTION_MAX_CALLBACK_DEPTH = 2;

/** pending → running|failed; running → partial|done|timeout|failed;
 *  partial → done|timeout; terminal statuses are final. */
export function isValidMultiMentionTransition(from: MultiMentionStatus, to: MultiMentionStatus): boolean {
	switch (from) {
		case "pending":
			return to === "running" || to === "failed";
		case "running":
			return to === "partial" || to === "done" || to === "timeout" || to === "failed";
		case "partial":
			return to === "done" || to === "timeout";
		case "done":
		case "timeout":
		case "failed":
			return false;
	}
}

export interface MultiMentionRequest {
	requestId: string;
	threadId: string;
	userId: string;
	initiatorAgentId: string;
	initiatorTurnExecutionId: string;
	callbackToAgentId: string;
	question: string;
	context: string | null;
	targetAgentIds: string[];
	status: MultiMentionStatus;
	timeoutMinutes: number;
	expiresAt: number;
	parentInvocationId: string | null;
	sourceRecordId: string;
	aggregateMessageId: string | null;
	createdAt: number;
	updatedAt: number;
	endedAt: number | null;
	triggerType: MultiMentionTriggerType | null;
	searchEvidenceRefs: string[] | null;
	overrideReason: string | null;
}

export interface MultiMentionResponse {
	requestId: string;
	targetAgentId: string;
	turnExecutionId: string | null;
	responseMessageId: string | null;
	status: MultiMentionTargetStatus;
	responseState: MultiMentionResponseState;
	reason: string | null;
	receivedAt: number | null;
}

export interface MultiMentionCallback {
	requestId: string;
	threadId: string;
	callbackToAgentId: string;
	aggregateMessageId: string;
	queueEntryId: string | null;
	parentInvocationId: string | null;
	turnExecutionId: string | null;
	callbackDepth: 1 | 2;
	status: MultiMentionCallbackStatus;
	reason: string | null;
	createdAt: number;
	updatedAt: number;
	endedAt: number | null;
}

export interface MultiMentionStatusView {
	request: MultiMentionRequest;
	responses: MultiMentionResponse[];
	allFailed: boolean;
	callback: MultiMentionCallback | null;
}
