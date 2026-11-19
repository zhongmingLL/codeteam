import type { MessageSender, QueueTarget } from "./message.ts";

// F018 v1 shared contract types — invocation/queue/turn family
// (0007 §3.1/§3.2/§3.3/§3.6, 0011). Dual-generation rule applies.

// ---------------------------------------------------------------- §3.1 queue

export type QueueOwner = { kind: "user"; userId: string } | { kind: "system"; service: string };

export type QueueEntryKind = "conversation_input" | "message_wake";

/** Durable row statuses only; processing/terminal are projections (§3.1). */
export type QueueDurableStatus = "queued" | "claimed";

export interface QueuePayload {
	/** Queue identity; v1 = messageId. */
	sourceRecordId: string;
	messageId: string | null;
	originRecordId: string | null;
	attempt: number;
	content: string;
	requestedTargets: QueueTarget[];
	piExtToolCallId?: string;
}

export interface QueueExecution {
	a2aParentTurnExecutionId: string | null;
	a2aTriggerMessageId: string | null;
	a2aDepth: number;
	multiMentionRequestId: string | null;
	multiMentionCallbackDepth: number | null;
}

export interface QueueClaim {
	claimId: string;
	owner: string;
	claimedAt: number;
	expiresAt: number;
	targetKeys: string[];
}

export interface QueueEntry {
	version: 1;
	queueEntryId: string;
	threadId: string;
	owner: QueueOwner;
	kind: QueueEntryKind;
	from: MessageSender;
	targets: QueueTarget[];
	payload: QueuePayload;
	execution: QueueExecution;
	claim: QueueClaim | null;
	status: QueueDurableStatus;
	priority: "urgent" | "normal";
	position: number;
	enqueuedAt: number;
	updatedAt: number;
}

// ---------------------------------------------------------- §3.2/§4.2 parent

export type InvocationRecordStatus = "queued" | "running" | "completed" | "partial_failed" | "failed" | "canceled";

export interface InvocationRecord {
	invocationId: string;
	threadId: string;
	userId: string;
	sourceRecordId: string;
	userMessageId: string | null;
	/** Immutable admission snapshot. */
	targetAgentIds: string[];
	status: InvocationRecordStatus;
	/** Monotonic union of successful agents. */
	successfulAgentIds: string[];
	usageByAgent: Record<string, unknown>;
	usageRecordedAt: number | null;
	retryCount: number;
	terminalReason: string | null;
	createdAt: number;
	startedAt: number | null;
	endedAt: number | null;
}

// ------------------------------------------------------------ §3.6/§4.3 child

export type TurnExecutionKind = "ordinary" | "routing_guard";

export type TurnExecutionStatus = "running" | "completed" | "failed" | "interrupted" | "canceled";

export interface TurnExecutionCausalRefs {
	triggerMessageId: string;
	a2aParentTurnExecutionId?: string;
	a2aTriggerMessageId?: string;
	a2aDepth?: number;
	multiMentionRequestId?: string;
	multiMentionCallbackDepth?: number;
	routingGuardReason?: "missing_routing_exit";
}

export interface TurnExecution {
	turnExecutionId: string;
	parentInvocationId: string;
	threadId: string;
	/** Scope snapshot; must equal parent/thread owner (0011 §11). */
	userId: string;
	agentId: string;
	executionKind: TurnExecutionKind;
	causal: TurnExecutionCausalRefs;
	status: TurnExecutionStatus;
	terminalReason: string | null;
	startedAt: number;
	endedAt: number | null;
}

// --------------------------------------------------------- §4.3.1 attempt

export type InvocationAttemptDeliveryState =
	| "queued"
	| "starting"
	| "appended"
	| "handled"
	| "failed"
	| "interrupted"
	| "canceled";

export type AttemptSettlement = "streaming" | "response_pending" | "settled";

export interface InvocationAttempt {
	attemptId: string;
	parentInvocationId: string;
	/** Route anchor; survives queue row deletion as a trace string. */
	queueEntryId: string;
	threadId: string;
	targetAgentId: string;
	attempt: number;
	turnExecutionId: string | null;
	deliveryState: InvocationAttemptDeliveryState;
	terminalReason: string | null;
	agentSessionId: string | null;
	workerId: string | null;
	provider: string | null;
	model: string | null;
	modelFamily: string | null;
	usage: Record<string, unknown> | null;
	settlement: AttemptSettlement | null;
	responseMessageId: string | null;
	deliveryBoundarySeq: number | null;
	promptDeliveredAt: number | null;
	createdAt: number;
	startedAt: number | null;
	endedAt: number | null;
}
