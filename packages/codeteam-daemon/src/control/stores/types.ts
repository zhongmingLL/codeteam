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

export type BacklogPriority = "p0" | "p1" | "p2" | "p3";
export type BacklogStatus = "open" | "suggested" | "approved" | "dispatched" | "done";
export type BacklogCreatedByKind = "cat" | "user" | "system";
export type BacklogSuggestionStatus = "pending" | "approved" | "rejected";

export interface BacklogSuggestion {
	catId: string;
	why: string;
	plan: string;
	requestedPhase: ThreadPhase;
	status: BacklogSuggestionStatus;
	suggestedAt: number;
	decidedAt?: number;
	decidedBy?: string;
	note?: string;
}

export interface BacklogItem {
	id: string;
	userId: string;
	projectId: string | null;
	title: string;
	summary: string;
	priority: BacklogPriority;
	tags: string[];
	status: BacklogStatus;
	createdByKind: BacklogCreatedByKind;
	createdById: string;
	suggestion: BacklogSuggestion | null;
	lease: Record<string, unknown> | null;
	dependencies: Record<string, unknown> | null;
	dispatchedThreadId: string | null;
	dispatchedThreadPhase: ThreadPhase | null;
	dispatchAttemptId: string | null;
	pendingThreadId: string | null;
	kickoffMessageId: string | null;
	approvedAt: number | null;
	dispatchedAt: number | null;
	doneAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface CreateBacklogItemInput {
	id?: string;
	userId: string;
	projectId?: string | null;
	title: string;
	summary: string;
	priority: BacklogPriority;
	tags: string[];
	createdByKind: BacklogCreatedByKind;
	createdById: string;
	dependencies?: Record<string, unknown> | null;
	initialStatus?: BacklogStatus;
}

export interface SuggestBacklogInput {
	catId: string;
	why: string;
	plan: string;
	requestedPhase: ThreadPhase;
}

export interface DecideBacklogSuggestionInput {
	decision: "approve" | "reject";
	decidedBy: string;
	note?: string;
}

export interface BacklogListFilter {
	status?: BacklogStatus;
	priority?: BacklogPriority;
	projectId?: string;
}

export interface MarkBacklogDispatchedInput {
	threadId: string;
	phase: ThreadPhase;
	dispatchAttemptId: string;
	kickoffMessageId: string;
}

export interface DispatchBacklogInput {
	backlogItemId: string;
	targets: string[];
	threadPhase: ThreadPhase;
	dispatchAttemptId?: string;
	title?: string;
	repo?: string | null;
	kickoffBody?: string;
}

export interface DispatchBacklogResult {
	backlog: BacklogItem;
	thread: Thread;
	message: Message;
	queueEntry: QueueEntry;
	audit: AuditEntry | null;
}

export type SopStage = "kickoff" | "impl" | "quality_gate" | "fresh_context" | "review" | "merge" | "completion";
export type SopCheckStatus = "attested" | "unknown";

export interface SopChecks {
	remoteMainSynced: SopCheckStatus;
	qualityGatePassed: SopCheckStatus;
	reviewApproved: SopCheckStatus;
	visionGuardDone: SopCheckStatus;
}

export interface ResumeCapsule {
	goal: string;
	done: string[];
	currentFocus: string;
}

export interface WorkflowSop {
	backlogItemId: string;
	featureId: string;
	sopDefinitionId: string;
	stage: SopStage;
	batonHolder: string;
	nextSkill: string | null;
	resumeCapsule: ResumeCapsule;
	checks: SopChecks;
	version: number;
	updatedAt: number;
	updatedBy: string;
}

export interface UpsertWorkflowSopInput {
	backlogItemId: string;
	featureId: string;
	sopDefinitionId?: string;
	stage: SopStage;
	batonHolder: string;
	nextSkill?: string | null;
	resumeCapsule: ResumeCapsule;
	checks: SopChecks;
	expectedVersion?: number;
	updatedBy: string;
}

export interface WorkAdmission {
	workId: string;
	ownerUserId: string;
	producerKind: string;
	producerRef: string;
	initialAttemptId: string;
	admittedAt: number;
}

export interface WorkAttempt {
	attemptId: string;
	workId: string;
	attemptNumber: number;
	executorProfileId: string | null;
	createdAt: number;
	executorBoundAt: number | null;
}

export type ArtifactKind =
	| "spec"
	| "plan"
	| "diff"
	| "test-report"
	| "review"
	| "verification"
	| "merge-receipt"
	| "log";

export interface Artifact {
	id: string;
	taskId: string;
	runId: string | null;
	kind: ArtifactKind;
	sha256: string;
	path: string;
	mediaType: string;
	bytes: number;
	provenance: Record<string, unknown>;
	approvalId: string | null;
	createdAt: number;
}

export interface PutArtifactInput {
	id?: string;
	taskId: string;
	runId?: string | null;
	kind: ArtifactKind;
	content: Buffer;
	mediaType: string;
	provenance: Record<string, unknown>;
	approvalId?: string | null;
	createdAt?: number;
}

export type InboxKind = "steer" | "followUp" | "humanGuidance";
export type InboxStatus = "pending" | "consumed" | "expired";

export interface InboxItem {
	id: string;
	taskId: string;
	runId: string | null;
	kind: InboxKind;
	payload: Record<string, unknown>;
	status: InboxStatus;
	createdAt: number;
	consumedAt: number | null;
}

export interface CreateInboxInput {
	id?: string;
	taskId: string;
	runId?: string | null;
	kind: InboxKind;
	payload?: Record<string, unknown>;
}

export interface InboxListFilter {
	taskId?: string;
	status?: InboxStatus;
}

export interface AuditEntry {
	id: string;
	actor: string;
	action: string;
	subject: string;
	args: Record<string, unknown>;
	result: string;
	ts: number;
}

export interface AppendAuditInput {
	id?: string;
	actor: string;
	action: string;
	subject: string;
	args?: Record<string, unknown>;
	result?: string;
	ts?: number;
}
