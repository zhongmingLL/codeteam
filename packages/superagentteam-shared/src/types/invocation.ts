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

/** queue_admissions receipt row (0007 §4.1, R-01). */
export interface QueueAdmission {
	threadId: string;
	sourceRecordId: string;
	attempt: number;
	queueEntryId: string;
	fingerprint: string;
	admittedAt: number;
}

/** 0007 §3.1 transition projections: appear in return values/read models only. */
export interface QueueAttemptProjection {
	status: "processing";
	queueEntryId: string;
	targets: QueueTarget[];
	startedAt: number;
}

/** Ephemeral UI stream event (0007 §3.5); NOT persisted — durable truth is response_drafts. */
export type AgentStreamEvent =
	| { type: "text"; agentId: string; turnExecutionId: string; content: string; timestamp: number }
	| { type: "thinking"; agentId: string; turnExecutionId: string; content: string; timestamp: number }
	| { type: "tool_call"; agentId: string; turnExecutionId: string; name: string; args: unknown; timestamp: number }
	| { type: "tool_result"; agentId: string; turnExecutionId: string; name: string; result: unknown; timestamp: number }
	| { type: "error"; agentId: string; turnExecutionId: string; error: string; timestamp: number }
	| { type: "done"; agentId: string; turnExecutionId: string; timestamp: number };

export interface QueueTerminalProjection {
	status: "terminal";
	queueEntryId: string;
	targets: QueueTarget[];
	endedAt: number;
	reason: "dispatched" | "withdrawn";
}

// --------------------------------------------- R1-c (0007 §4.3.2/§4.4/§4.6, 0010, 0017)

/** 0010: thread × agent durable execution identity. */
export interface AgentSession {
	id: string;
	threadId: string;
	agentId: string;
	userId: string;
	/** 0-based per-pair sequence; unique with (threadId, agentId). */
	seq: number;
	/** Durable messageCount dedup: last turn that already counted. */
	lastCountedTurnExecutionId: string | null;
	status: "active" | "sealing" | "sealed";
	piSessionId: string | null;
	piSessionFile: string | null;
	workingDirectory: string;
	messageCount: number;
	consecutiveResumeFailures: number;
	sealReason: string | null;
	createdAt: number;
	updatedAt: number;
	sealedAt: number | null;
}

/** 0007 §4.6: ephemeral worker; capacity=1 per pi v1. */
export interface Worker {
	id: string;
	poolKey: { projectPath: string; accountRef: string; provider: string; model: string };
	state: "starting" | "online" | "draining" | "stale" | "retired";
	pid: number | null;
	heartbeatAt: number;
	leaseExpiresAt: number;
	idleSince: number | null;
	retiredAt: number | null;
	lastError: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface WorkerBinding {
	agentSessionId: string;
	workerId: string;
	generation: number;
	state: "attached" | "idle" | "reattach_pending";
	boundAt: number;
	lastUsedAt: number;
}

/** piExtToolCallId → original result replay map (0007 §3.8). */
export interface ToolCallClaim {
	intentHash: string;
	messageId: string;
	queueEntryId: string | null;
}

/** 0007 §4.4: child TurnExecution capability. */
export interface InvocationCredential {
	credentialId: string;
	turnExecutionId: string;
	parentInvocationId: string;
	threadId: string;
	agentId: string;
	agentSessionId: string;
	userId: string;
	allowedTools: string[];
	toolCallClaims: Record<string, ToolCallClaim>;
	state: "active" | "terminal";
	disposition: "completed" | "failed" | "interrupted" | "canceled" | "revoked" | "replaced" | null;
	replacedByTurnExecutionId: string | null;
	expiresAt: number | null;
	createdAt: number;
	updatedAt: number;
}

/** 0017 §3: single draft record; read model AND write input. */
export interface DraftRecord {
	attemptId: string;
	turnExecutionId: string;
	parentInvocationId: string;
	threadId: string;
	agentId: string;
	content: string;
	toolEvents: unknown[];
	thinking: string | null;
	createdAt: number;
	updatedAt: number;
}
