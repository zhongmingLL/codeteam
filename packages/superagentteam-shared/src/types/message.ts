// F018 v1 shared contract types — StoredMessage (0007 §3.1) and AgentConfig
// family (0008). Dual-generation rule applies (see types/index.ts header).

// ---------------------------------------------------------------- 0007 §3.1

export type MessageSender =
	| { kind: "user"; userId: string }
	| { kind: "agent"; agentId: string }
	| { kind: "system"; service: string };

/** Queue/storage alias of MessageSender. */
export type MessageFrom = MessageSender;

export type TextContent = { type: "text"; text: string };

export type ToolCallContent = {
	type: "tool_call";
	toolName: string;
	toolId: string;
	input: Record<string, unknown>;
};

export type ToolResultContent = {
	type: "tool_result";
	toolId: string;
	result: unknown;
	isError?: boolean;
};

/** v1 keeps exactly these three; image/file/etc. extend later per Clowder. */
export type MessageContent = TextContent | ToolCallContent | ToolResultContent;

export type RichBlockKind =
	| "card"
	| "diff"
	| "checklist"
	| "media_gallery"
	| "audio"
	| "interactive"
	| "html_widget"
	| "file";

/** Hub presentation container; block shapes follow the 0001 RichBlock contract. */
export interface RichMessageExtra {
	v: 1;
	blocks: Array<{ id: string; kind: RichBlockKind; v: 1; [key: string]: unknown }>;
}

/** execution replay; content-level, distinct from contentBlocks. */
export interface StoredToolEvent {
	id: string;
	executionRef?: string;
	type: "tool_use" | "tool_result";
	label: string;
	detail?: string;
	timestamp: number;
	toolUseId?: string;
	status?: "ok" | "error" | "unknown";
	startTimeMs?: number;
	endTimeMs?: number;
	toolName?: string;
}

export type QueueTarget = { kind: "agent"; id: string };

/** Durable delivery receipt on input messages (0007 §3.1). */
export interface DispatchRef {
	target: QueueTarget;
	queueEntryId: string;
	attempt: number;
	phase: "dispatched" | "settled";
	responseMessageId?: string;
	turnExecutionId?: string;
	at: number;
}

export type MessageLifecycle =
	| { kind: "input"; dispatchRefs: DispatchRef[] }
	| {
			kind: "response";
			parentInvocationId: string;
			turnExecutionId: string;
			target: QueueTarget;
			status: "processing" | "completed" | "failed" | "interrupted" | "canceled";
			startedAt: number;
			endedAt?: number;
	  }
	| {
			kind: "delivery_failure";
			status: "failed";
			sourceEntryId: string;
			inputMessageId: string;
			requestedTargets: QueueTarget[];
			reason:
				| "turn_create_failed"
				| "response_create_failed"
				| "credential_mint_failed"
				| "draft_create_failed"
				| "retire_targets_failed"
				| "target_invalid";
			createdAt: number;
	  };

/** multi_mention aggregate projection (0007 §3.8). */
export interface MultiMentionExtra {
	requestId: string;
	status: "pending" | "running" | "partial" | "done" | "timeout" | "failed";
	callbackTo: string;
	targetAgentIds: string[];
	responses?: unknown[];
	allFailed?: boolean;
}

/** v1 single-layer message record; no domain Message (0005 D9). */
export interface StoredMessage {
	id: string;
	threadId: string;
	from: MessageFrom;
	/** Plain text body (DB body_md). */
	content: string;
	/** Semantic blocks (DB content_json). */
	contentBlocks?: MessageContent[];
	/** Execution replay (DB tool_events_json). */
	toolEvents?: StoredToolEvent[];
	lifecycle?: MessageLifecycle;
	replyTo?: string;
	/** operator notification flag; set by line-start @operator only. */
	mentionsUser?: boolean;
	/** Thread-global visibility order. */
	seq: number;
	timestamp: number;
	updatedAt: number;
	thinking?: string;
	deletedAt?: number;
	deletedBy?: string;
	extra?: {
		targetAgentIds?: string[];
		rich?: RichMessageExtra;
		crossPost?: { sourceThreadId: string; sourceTriggerMessageId?: string };
		multiMention?: MultiMentionExtra;
	};
}

// ---------------------------------------------------------------- 0008 §1

export interface AgentConfig {
	/** A2A target id; stable identity. */
	id: string;
	/** operator @mention routing patterns; leading @, globally unique. */
	readonly mentionPatterns: readonly string[];
	displayName: string;
	avatar?: string;
	color?: { primary: string; secondary: string };
	contextWindow: number;
	/** workflow trigger-group key; NOT the legacy execution role. */
	roleId: string;
	roleDescription: string;
	restrictions: string[];
	strengths: string[];
	accountRef: string;
	/** Must be a member of the referenced AccountConfig.models. */
	defaultModel: string;
	sessionChain: boolean;
	enabled: boolean;
}

export interface AccountConfig {
	ref: string;
	provider: string;
	apiUrl?: string;
	/** env/secret ref; never a raw key. */
	apiKeyRef: string;
	models: string[];
}

export interface AgentCatalog {
	version: 1;
	agents: AgentConfig[];
}

/** Runtime projection (0008 §1); not persisted in the catalog. */
export interface AgentState {
	agentId: string;
	status: "idle" | "thinking" | "working" | "error" | "offline";
	currentInvocationId?: string;
	sessionId?: string;
	lastActiveAt: number;
}

export interface ThreadAgentState {
	threadId: string;
	agentId: string;
	status: "idle" | "thinking" | "working" | "error" | "offline";
	currentTurnExecutionId?: string;
	currentInvocationId?: string;
	lastActiveAt: number;
}
