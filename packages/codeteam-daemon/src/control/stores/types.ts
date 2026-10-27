export type RoleStatus = "active" | "disabled";

export interface Role {
	id: string;
	label: string;
	description: string;
	status: RoleStatus;
	createdAt: number;
	updatedAt: number;
}

export interface CreateRoleInput {
	id?: string;
	label: string;
	description?: string;
	status?: RoleStatus;
}

export interface RoleSetStatusOptions {
	expectedUpdatedAt?: number;
}

export type ProfileStatus = "active" | "disabled";

export interface AgentProfile {
	id: string;
	role: string;
	displayName: string;
	provider: string;
	model: string;
	modelFamily: string;
	toolPolicyProfile: string;
	roleDescription: string;
	restrictions: Record<string, unknown>;
	status: ProfileStatus;
	clowderCatId: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface CreateAgentProfileInput {
	id?: string;
	role: string;
	displayName: string;
	provider: string;
	model: string;
	modelFamily: string;
	toolPolicyProfile: string;
	roleDescription?: string;
	restrictions?: Record<string, unknown>;
	status?: ProfileStatus;
	clowderCatId?: string | null;
}

export interface ProfileSeed {
	profileId?: string;
	displayName?: string;
	provider: string;
	model: string;
	modelFamily: string;
	toolPolicyProfile?: string;
	roleDescription?: string;
	restrictions?: Record<string, unknown>;
	clowderCatId?: string | null;
}

export interface ProfileListFilter {
	role?: string;
	status?: ProfileStatus;
}

export type SessionStatus = "active" | "sealing" | "sealed";

export interface AgentSession {
	id: string;
	threadId: string;
	taskId: string | null;
	profileId: string;
	role: string;
	stageId: string | null;
	piSessionId: string | null;
	effectiveToolPolicy: string;
	chainKey: string | null;
	provider: string;
	model: string;
	modelFamily: string;
	status: SessionStatus;
	seq: number;
	nativeSessionBinding: unknown;
	contextHealth: unknown;
	capacityPin: unknown;
	sealReason: string | null;
	catHandoffNote: unknown;
	compressionCount: number | null;
	continuityCapsule: unknown;
	latestResumeSessionId: string | null;
	lastUsage: unknown;
	messageCount: number;
	workingDirectory: string | null;
	workspaceFingerprint: string | null;
	userId: string | null;
	createdAt: number;
	updatedAt: number;
	sealedAt: number | null;
}

export interface CreateAgentSessionInput {
	id?: string;
	threadId: string;
	taskId?: string | null;
	profileId: string;
	role: string;
	stageId?: string | null;
	piSessionId?: string | null;
	effectiveToolPolicy: string;
	chainKey?: string | null;
	provider: string;
	model: string;
	modelFamily: string;
	status?: SessionStatus;
	seq: number;
	nativeSessionBinding?: unknown;
	contextHealth?: unknown;
	capacityPin?: unknown;
	sealReason?: string | null;
	catHandoffNote?: unknown;
	compressionCount?: number | null;
	continuityCapsule?: unknown;
	latestResumeSessionId?: string | null;
	lastUsage?: unknown;
	messageCount?: number;
	workingDirectory?: string | null;
	workspaceFingerprint?: string | null;
	userId?: string | null;
}

export interface SealAgentSessionInput {
	sealReason: string;
	catHandoffNote?: unknown;
	continuityCapsule?: unknown;
	compressionCount?: number | null;
	latestResumeSessionId?: string | null;
	messageCount?: number;
	expectedUpdatedAt?: number;
}

export interface SessionListFilter {
	threadId?: string;
	taskId?: string;
	profileId?: string;
	status?: SessionStatus;
}

export type ThreadStatus = "active" | "archived";
export type ThreadPhase = "coding" | "research" | "brainstorm";

export interface Thread {
	id: string;
	title: string | null;
	repo: string | null;
	status: ThreadStatus;
	phase: ThreadPhase | null;
	backlogItemId: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface CreateThreadInput {
	id?: string;
	title?: string | null;
	repo?: string | null;
	status?: ThreadStatus;
	phase?: ThreadPhase | null;
	backlogItemId?: string | null;
}

export interface ThreadListFilter {
	status?: ThreadStatus;
	phase?: ThreadPhase;
	backlogItemId?: string;
}

export interface LinkThreadBacklogInput {
	backlogItemId: string;
	phase: ThreadPhase;
	expectedUpdatedAt?: number;
}

export type MessageAuthorKind = "user" | "agent" | "external" | "plugin" | "system";
export type MessageKind =
	| "chat"
	| "question"
	| "answer"
	| "proposal"
	| "finding"
	| "status"
	| "handoff"
	| "verdict"
	| "approval_request"
	| "agent_response"
	| "backlog_kickoff"
	| "approval_pointer";

export interface Message {
	id: string;
	threadId: string;
	taskId: string | null;
	authorKind: MessageAuthorKind;
	authorId: string;
	kind: MessageKind;
	bodyMd: string;
	richBlocks: unknown[];
	dispatchRefs: unknown[];
	replyTo: string | null;
	controlRef: string | null;
	seq: number;
	createdAt: number;
	updatedAt: number;
}

export interface AppendMessageInput {
	id?: string;
	threadId: string;
	taskId?: string | null;
	authorKind: MessageAuthorKind;
	authorId: string;
	kind: MessageKind;
	bodyMd?: string;
	richBlocks?: unknown[];
	dispatchRefs?: unknown[];
	replyTo?: string | null;
	expectedSeq?: number;
}

export interface MessageListOptions {
	limit?: number;
	beforeSeq?: number;
}

export interface MessageMutationOptions {
	expectedUpdatedAt?: number;
}

export type QueuePriority = "urgent" | "normal";
export type QueueStatus = "queued" | "claimed" | "processing";
export type QueueSourceKind = "conversation_input" | "message_wake" | "private_input" | "backlog_dispatch";

export interface QueueEntry {
	id: string;
	threadId: string;
	sourceId: string;
	sourceRecordId: string | null;
	sourceKind: QueueSourceKind;
	targets: string[];
	authorIntent: Record<string, unknown>;
	priority: QueuePriority;
	sourceCategory: string;
	orderKey: string;
	revision: number;
	fenceRefs: unknown[];
	status: QueueStatus;
	claimId: string | null;
	claimOwnerRunId: string | null;
	claimExpiresAt: number | null;
	enqueuedAt: number;
	updatedAt: number;
}

export interface AdmitQueueEntryInput {
	id?: string;
	threadId: string;
	sourceId: string;
	sourceRecordId?: string | null;
	sourceKind: QueueSourceKind;
	targets: string[];
	authorIntent?: Record<string, unknown>;
	priority?: QueuePriority;
	sourceCategory: string;
	orderKey: string;
	fenceRefs?: unknown[];
}

export interface ClaimQueueEntryInput {
	claimId: string;
	ownerRunId?: string | null;
	ttlMs?: number;
}
