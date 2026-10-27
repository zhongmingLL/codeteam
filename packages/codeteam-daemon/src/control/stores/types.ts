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

export type TaskKind = "work" | "pr_tracking" | "issue_tracking";
export type TaskStatus = "todo" | "doing" | "blocked" | "done";
export type TaskDisposition = "canceled" | "abandoned";
export type StageLane = "impl" | "quality_gate" | "fresh_context" | "review" | "merge";

export interface Task {
	id: string;
	kind: TaskKind;
	threadId: string;
	subjectKey: string | null;
	title: string;
	why: string;
	ownerProfileId: string | null;
	status: TaskStatus;
	createdBy: string;
	userId: string | null;
	sourceMessageId: string | null;
	sourceSummaryId: string | null;
	relatedFeatureId: string | null;
	detectedFeatureIds: unknown[];
	dispatchGate: Record<string, unknown> | null;
	probe: Record<string, unknown> | null;
	resolveMode: string | null;
	entrustedWork: Record<string, unknown> | null;
	deploymentWait: Record<string, unknown> | null;
	automationState: Record<string, unknown> | null;
	backlogItemId: string | null;
	repo: string | null;
	baseRef: string | null;
	baseSha: string | null;
	worktree: string | null;
	branch: string | null;
	risk: string | null;
	riskAxes: unknown[];
	disposition: TaskDisposition | null;
	lane: StageLane | null;
	budget: Record<string, unknown> | null;
	createdAt: number;
	updatedAt: number;
}

export interface CreateTaskInput {
	id?: string;
	kind: TaskKind;
	threadId: string;
	subjectKey?: string | null;
	title: string;
	why: string;
	ownerProfileId?: string | null;
	status?: TaskStatus;
	createdBy: string;
	userId?: string | null;
	sourceMessageId?: string | null;
	sourceSummaryId?: string | null;
	relatedFeatureId?: string | null;
	detectedFeatureIds?: unknown[];
	backlogItemId?: string | null;
	repo?: string | null;
	baseRef?: string | null;
	baseSha?: string | null;
	worktree?: string | null;
	branch?: string | null;
	risk?: string | null;
	riskAxes?: unknown[];
	lane?: StageLane | null;
	budget?: Record<string, unknown> | null;
}

export interface TaskListFilter {
	threadId?: string;
	ownerProfileId?: string;
	status?: TaskStatus;
	kind?: TaskKind;
}

export type StageStatus = "active" | "passed";

export interface Stage {
	id: string;
	taskId: string;
	lane: StageLane;
	status: StageStatus;
	startedAt: number;
	endedAt: number | null;
}

export interface CreateStageInput {
	id?: string;
	taskId: string;
	lane: StageLane;
}

export type RunStatus = "running" | "completed" | "canceled" | "interrupted" | "failed";
export type RunExecutionKind = "ordinary" | "routing_guard";

export interface Run {
	id: string;
	taskId: string;
	queueEntryId: string | null;
	stageId: string | null;
	attempt: number;
	role: string;
	agentSessionId: string;
	parentRunId: string | null;
	sourceId: string;
	recipientProfileId: string;
	chainMetadata: Record<string, unknown>;
	provider: string;
	model: string;
	modelFamily: string;
	l0Revision: string | null;
	status: RunStatus;
	responseMessageId: string | null;
	executionKind: RunExecutionKind;
	handoffId: string | null;
	approvalId: string | null;
	startedAt: number;
	terminalAt: number | null;
	usage: Record<string, unknown> | null;
}

export interface CreateRunInput {
	id?: string;
	taskId: string;
	queueEntryId?: string | null;
	stageId?: string | null;
	attempt?: number;
	role: string;
	agentSessionId: string;
	parentRunId?: string | null;
	sourceId: string;
	recipientProfileId: string;
	chainMetadata?: Record<string, unknown>;
	provider: string;
	model: string;
	modelFamily: string;
	l0Revision?: string | null;
	responseMessageId?: string | null;
	executionKind?: RunExecutionKind;
	handoffId?: string | null;
	approvalId?: string | null;
	startedAt?: number;
	usage?: Record<string, unknown> | null;
}

export interface TerminalRunInput {
	status: Exclude<RunStatus, "running">;
	terminalAt?: number;
	usage?: Record<string, unknown> | null;
}

export interface RunListFilter {
	taskId?: string;
	agentSessionId?: string;
	recipientProfileId?: string;
	status?: RunStatus;
}

export type RunEventKind =
	| "message"
	| "tool_call"
	| "tool_result"
	| "gate"
	| "handoff"
	| "review"
	| "verification"
	| "error";

export interface RunEvent {
	id: string;
	runId: string;
	seq: number;
	kind: RunEventKind;
	payload: unknown;
	ts: number;
}

export type ThreadEventKind = "backlog_item_dispatched" | "backlog_item_done" | "workflow_sop_updated";

export interface ThreadEvent {
	id: string;
	threadId: string;
	seq: number;
	kind: ThreadEventKind;
	payload: unknown;
	ts: number;
}

export type CredentialState = "active" | "terminal";
export type CredentialDisposition = "completed" | "failed" | "canceled" | "interrupted" | "revoked";
export type OwnerAuthProvenance = "strict" | "compat" | "unknown";

export interface InvocationCredential {
	id: string;
	runId: string;
	taskId: string;
	role: string;
	agentSessionId: string;
	agentProfileId: string;
	threadId: string;
	userId: string;
	ownerAuthProvenance: OwnerAuthProvenance;
	parentRunId: string | null;
	toolPolicy: Record<string, unknown>;
	state: CredentialState;
	disposition: CredentialDisposition | null;
	lastRefreshAt: number;
	expiresAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface CreateInvocationCredentialInput {
	id?: string;
	tokenHash: string;
	tokenSalt: string;
	runId: string;
	taskId: string;
	role: string;
	agentSessionId: string;
	agentProfileId: string;
	threadId: string;
	userId: string;
	ownerAuthProvenance: OwnerAuthProvenance;
	parentRunId?: string | null;
	toolPolicy: Record<string, unknown>;
	lastRefreshAt?: number;
	expiresAt?: number | null;
}

export interface CutoverQueueEntryInput {
	queueEntryId: string;
	claimId: string;
	targetProfileId: string;
	taskId: string;
	stageId?: string | null;
	role: string;
	agentSessionId: string;
	provider: string;
	model: string;
	modelFamily: string;
	l0Revision?: string | null;
	executionKind?: RunExecutionKind;
	handoffId?: string | null;
	approvalId?: string | null;
	attempt?: number;
	parentRunId?: string | null;
	chainMetadata?: Record<string, unknown>;
	responseBody?: string;
}

export interface CutoverQueueEntryResult {
	run: Run;
	responseMessage: Message;
	queueEntry: QueueEntry | null;
	runEvent: RunEvent;
}

export interface WorkRunBinding {
	runId: string;
	workId: string;
	attemptId: string;
	boundAt: number;
}

export interface WorkTaskBinding {
	taskId: string;
	workId: string;
	attemptId: string;
	boundAt: number;
}
