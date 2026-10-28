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
	afterSeq?: number;
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

export interface BacklogAuditProjection {
	audit: AuditEntry[];
	auditTruncated: boolean;
	auditCursor: string | null;
}

export interface BacklogItemView extends BacklogItem, BacklogAuditProjection {}

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
	importReason?: string;
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
	limit?: number;
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
export type EffectiveSopCheckStatus = SopCheckStatus | "verified";

export interface SopChecks {
	remoteMainSynced: SopCheckStatus;
	qualityGatePassed: SopCheckStatus;
	reviewApproved: SopCheckStatus;
	visionGuardDone: SopCheckStatus;
}

export type SopCheckName = keyof SopChecks;

export interface EffectiveSopChecks {
	remoteMainSynced: EffectiveSopCheckStatus;
	qualityGatePassed: EffectiveSopCheckStatus;
	reviewApproved: EffectiveSopCheckStatus;
	visionGuardDone: EffectiveSopCheckStatus;
}

export type SopEvidenceKind = "git_sync" | "quality_gate" | "review" | "vision_guard";

export interface SopCheckEvidence {
	id: string;
	backlogItemId: string;
	checkName: SopCheckName;
	evidenceKind: SopEvidenceKind;
	evidenceRef: string;
	subjectRevision: string;
	recordedBy: string;
	recordedAt: number;
}

export interface RecordSopCheckEvidenceInput {
	id?: string;
	backlogItemId: string;
	checkName: SopCheckName;
	evidenceKind: SopEvidenceKind;
	evidenceRef: string;
	subjectRevision: string;
	recordedBy: string;
}

export interface WorkflowSopView {
	sop: WorkflowSop;
	effectiveChecks: EffectiveSopChecks;
	evidence: SopCheckEvidence[];
	staleEvidence: SopCheckName[];
	currentRevisions: Partial<Record<SopCheckName, string>>;
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
	completionSubjectRevision?: string | null;
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
	callbackAllowlist: string[] | null;
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
	callbackAllowlist?: string[] | null;
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

export type HandoffKind =
	| "handoff"
	| "review_request"
	| "verdict"
	| "blocker"
	| "spec_change"
	| "plan_revision"
	| "question";
export type HandoffStatus = "pending" | "claimed" | "consumed" | "withdrawn" | "expired";
export type HandoffActionFamily = "review" | "merge" | "investigate" | "implement" | "verify" | "vision_guard";
export type HandoffSuccessorSlot =
	| "reviewer"
	| "merge_owner"
	| "vision_guardian"
	| "investigator"
	| "implementer"
	| "verifier";
export type HandoffMode = "single" | "parallel";
export type HandoffClaimOrigin = "structured_transfer" | "existing_standing";
export type HandoffHolderClaimStatus = "active" | "released" | "interrupted";
export type CustodyEventKind =
	| "handoff.created"
	| "handoff.dispatched"
	| "handoff.claimed"
	| "handoff.returned"
	| "handoff.replaced"
	| "handoff.completion_candidate"
	| "handoff.completed"
	| "handoff.parallel_unfinished"
	| "handoff.withdrawn"
	| "handoff.expired"
	| "handoff.recovered";
export type CustodyEventClassification = "state-changing" | "informational";

export interface Handoff {
	id: string;
	taskId: string;
	stageId: string | null;
	kind: HandoffKind;
	fromRole: string;
	toRole: string;
	status: HandoffStatus;
	subject: string;
	subjectRef: string;
	actionFamily: HandoffActionFamily;
	successorSlot: HandoffSuccessorSlot;
	mode: HandoffMode;
	parallelIntent: string | null;
	ownerUserId: string;
	canonicalActionKey: string;
	holderProfileIds: string[];
	holderThreadId: string;
	predecessorProfileId: string | null;
	predecessorThreadId: string | null;
	claimOrigin: HandoffClaimOrigin;
	issuerStandingEvidenceRef: string | null;
	generation: number;
	revision: number;
	dispatchId: string;
	terminalPredicate: Record<string, unknown>;
	completionCandidates: Record<string, unknown>;
	holderOutcomes: Record<string, unknown>;
	returnTransitions: unknown[];
	replacementTransitions: unknown[];
	terminalActorRef: string | null;
	terminalReason: string | null;
	terminalEvidenceRef: string | null;
	expectedArtifact: string;
	payload: Record<string, unknown>;
	idempotencyKey: string;
	replyTo: string | null;
	deadline: number;
	attempt: number;
	claimedByRunId: string | null;
	claimedAt: number | null;
	claimedLeaseUntil: number | null;
	lastHeartbeatAt: number | null;
	terminalAt: number | null;
	result: Record<string, unknown> | null;
	createdAt: number;
}

export interface CreateHandoffInput {
	id?: string;
	taskId: string;
	stageId?: string | null;
	kind: HandoffKind;
	fromRole: string;
	toRole: string;
	subject: string;
	subjectRef: string;
	actionFamily: HandoffActionFamily;
	successorSlot: HandoffSuccessorSlot;
	mode: HandoffMode;
	parallelIntent?: string | null;
	ownerUserId: string;
	canonicalActionKey: string;
	holderProfileIds: string[];
	holderThreadId: string;
	predecessorProfileId?: string | null;
	predecessorThreadId?: string | null;
	claimOrigin: HandoffClaimOrigin;
	issuerStandingEvidenceRef?: string | null;
	dispatchId: string;
	terminalPredicate: Record<string, unknown>;
	expectedArtifact: string;
	payload: Record<string, unknown>;
	idempotencyKey: string;
	replyTo?: string | null;
	deadline: number;
}

export interface HandoffHolderClaim {
	handoffId: string;
	profileId: string;
	generation: number;
	runId: string;
	status: HandoffHolderClaimStatus;
	claimedAt: number;
	leaseUntil: number | null;
	lastHeartbeatAt: number | null;
	releasedAt: number | null;
	releaseReason: string | null;
}

export interface LoopGuardSnapshotEntry {
	canonicalActionKey: string;
	attempts: number;
	live: number;
}

export interface ClaimHandoffInput {
	handoffId: string;
	profileId: string;
	runId: string;
	leaseMs?: number;
}

export interface HandoffCompletionCandidateInput {
	handoffId: string;
	profileId: string;
	runId: string;
	evidenceRef: string;
	result: Record<string, unknown>;
	verified?: boolean;
}

export interface HandoffListFilter {
	taskId?: string;
	status?: HandoffStatus;
	actionFamily?: HandoffActionFamily;
}

export interface CustodyEvent {
	id: string;
	subjectRef: string;
	handoffId: string;
	generation: number;
	seq: number;
	classification: CustodyEventClassification;
	kind: CustodyEventKind;
	actorRef: string;
	payload: Record<string, unknown>;
	ts: number;
}

export type WaitKind = "timer" | "event" | "managed_command";
export type WaitStatus = "active" | "terminated";
export type WaitOutcomeDelivery =
	| "pending"
	| "delivered"
	| "suppressed"
	| "not_applicable"
	| "legacy_unfenced"
	| "queue_conflict";

export interface Wait {
	id: string;
	waitId: string;
	generation: number;
	subjectRef: string;
	kind: WaitKind;
	waitSourceRef: string;
	expectedSignal: string | null;
	baseline: Record<string, unknown>;
	continuation: Record<string, unknown>;
	ownerFence: Record<string, unknown>;
	status: WaitStatus;
	expiresAt: number | null;
	autoRenew: boolean;
	slaUntil: number;
	outcome: Record<string, unknown> | null;
	outcomeDelivery: WaitOutcomeDelivery | null;
	publishClaimedAt: number | null;
	consumedAt: number | null;
	approvalId: string | null;
	createdAt: number;
	terminalizedAt: number | null;
}

export interface CreateWaitInput {
	waitId: string;
	generation: number;
	subjectRef: string;
	kind: WaitKind;
	waitSourceRef: string;
	expectedSignal?: string | null;
	baseline: Record<string, unknown>;
	continuation: Record<string, unknown>;
	ownerFence: Record<string, unknown>;
	expiresAt?: number | null;
	autoRenew?: boolean;
	slaUntil: number;
	approvalId?: string | null;
}

export interface WaitTermination {
	eventId: string;
	waitId: string;
	generation: number;
	waitKind: WaitKind;
	reason: string;
	actor: Record<string, unknown>;
	subjectRef: string;
	ownerUserId: string;
	ownerProfileId: string | null;
	threadId: string;
	at: number;
	dispositionRef: string | null;
}

export interface TerminateWaitInput {
	waitId: string;
	generation: number;
	reason: string;
	actor: Record<string, unknown>;
	ownerUserId: string;
	ownerProfileId?: string | null;
	threadId: string;
	dispositionRef?: string | null;
}

export interface RenewWaitInput {
	waitId: string;
	generation: number;
	next: CreateWaitInput;
	ownerUserId: string;
	ownerProfileId?: string | null;
	threadId: string;
}

export type ApprovalKind = "merge" | "design_gate" | "spec_change" | "blocker" | "budget_pause";
export type ApprovalResolution = "open" | "accepted" | "rejected" | "closed_without_decision";
export type MaterializationState = "not_started" | "outcome_unknown" | "in_progress" | "succeeded" | "failed";

export interface Approval {
	id: string;
	threadId: string;
	taskId: string;
	kind: ApprovalKind;
	idempotencyKey: string;
	originRef: Record<string, unknown>;
	cardRef: Record<string, unknown>;
	resolution: ApprovalResolution;
	materialization: Record<string, unknown>;
	effectReservationRef: string | null;
	effectRef: string | null;
	payload: Record<string, unknown>;
	requestedBy: string;
	decidedBy: string | null;
	decidedAt: number | null;
	decidedNote: string | null;
	expiresAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface CreateApprovalInput {
	id?: string;
	threadId: string;
	taskId: string;
	kind: ApprovalKind;
	idempotencyKey: string;
	originRef: Record<string, unknown>;
	cardRef: Record<string, unknown>;
	payload?: Record<string, unknown>;
	requestedBy: string;
	expiresAt?: number | null;
}

export interface DecideApprovalInput {
	resolution: Exclude<ApprovalResolution, "open">;
	decidedBy: string;
	note?: string | null;
}

export interface MaterializeApprovalInput {
	state: MaterializationState;
	effectRef?: string | null;
	failureRef?: string | null;
	retryable?: boolean;
}

export interface ApprovalListFilter {
	taskId?: string;
	kind?: ApprovalKind;
	resolution?: ApprovalResolution;
}

export type ReviewMode = "cross_family" | "same_family_fresh";
export type ReviewVerdict = "approve" | "changes_requested" | "blocked";
export type ReviewRisk = "low_risk_docs" | "code" | "high_risk";
export type FindingSeverity = "P1" | "P2" | "P3";
export type EvidenceKind = "red_test" | "repro_command" | "static_check" | "code_reading" | "judgment";
export type VerificationStatus = "confirmed" | "rejected" | "blocked";

export interface Finding {
	id: string;
	reviewId: string;
	findingIndex: number;
	severity: FindingSeverity;
	file: string | null;
	line: number | null;
	claim: string;
	evidenceKind: EvidenceKind;
	falsifier: string;
	falsifierExpected: "zero" | "nonzero" | null;
	requiredAction: string;
}

export interface CreateFindingInput {
	severity: FindingSeverity;
	file?: string | null;
	line?: number | null;
	claim: string;
	evidenceKind: EvidenceKind;
	falsifier: string;
	falsifierExpected?: "zero" | "nonzero" | null;
	requiredAction: string;
}

export interface Review {
	id: string;
	taskId: string;
	runId: string;
	headSha: string;
	baseSha: string | null;
	authorSessionId: string;
	authorModel: string;
	authorModelFamily: string;
	reviewerSessionId: string;
	reviewerModel: string;
	reviewerModelFamily: string;
	authorProfileId: string | null;
	reviewerProfileId: string | null;
	riskClass: ReviewRisk;
	reviewMode: ReviewMode;
	verdict: ReviewVerdict;
	round: number;
	stage: string;
	previousReviewId: string | null;
	envelope: Record<string, unknown>;
	decision: Record<string, unknown>;
	policy: Record<string, unknown>;
	findings: Finding[];
	createdAt: number;
}

export interface CreateReviewInput {
	id?: string;
	taskId: string;
	runId: string;
	headSha: string;
	baseSha: string;
	authorSessionId: string;
	authorModel: string;
	authorModelFamily: string;
	reviewerSessionId: string;
	reviewerModel: string;
	reviewerModelFamily: string;
	authorProfileId: string;
	reviewerProfileId: string;
	riskClass: ReviewRisk;
	reviewMode: ReviewMode;
	verdict: ReviewVerdict;
	round?: number;
	stage?: string;
	previousReviewId?: string | null;
	envelope?: unknown;
	decision?: unknown;
	policy?: Record<string, unknown>;
	findings: CreateFindingInput[];
	createdAt?: number;
}

export interface Verification {
	id: string;
	findingId: string;
	headSha: string;
	producingReviewId: string;
	status: VerificationStatus;
	reason: string;
	command: string | null;
	cwd: string | null;
	exitCode: number | null;
	durationMs: number | null;
	stdoutTail: string | null;
	stderrTail: string | null;
	blockedExpiresAt: number | null;
	createdAt: number;
}

export interface CreateVerificationInput {
	findingId: string;
	headSha: string;
	producingReviewId: string;
	status: VerificationStatus;
	reason: string;
	command?: string | null;
	cwd?: string | null;
	exitCode?: number | null;
	durationMs?: number | null;
	stdoutTail?: string | null;
	stderrTail?: string | null;
	blockedExpiresAt?: number | null;
}

export type MergeStatus = "succeeded" | "failed" | "unknown";

export interface Merge {
	id: string;
	taskId: string;
	baseSha: string;
	headSha: string;
	mergeSha: string;
	policy: string;
	approvedBy: string;
	receiptRef: string;
	approvalId: string | null;
	executedBy: string;
	gateEvidenceRef: string | null;
	reviewRef: string | null;
	status: MergeStatus;
	failureRef: string | null;
	hardGate: boolean;
	strategy: string | null;
	repo: string | null;
	prRef: string | null;
	mergedAt: number | null;
	createdAt: number;
}

export interface CreateMergeInput {
	id?: string;
	taskId: string;
	baseSha: string;
	headSha: string;
	mergeSha: string;
	policy: string;
	approvedBy?: string;
	receiptRef: string;
	approvalId?: string | null;
	executedBy?: string;
	gateEvidenceRef?: string | null;
	reviewRef?: string | null;
	status?: MergeStatus;
	failureRef?: string | null;
	hardGate?: boolean;
	strategy?: string | null;
	repo?: string | null;
	prRef?: string | null;
	mergedAt?: number | null;
}

export interface Budget {
	id: string;
	taskId: string;
	tokensLimit: number | null;
	tokensUsed: number;
	costLimit: number | null;
	costUsed: number;
	wallTimeLimitMs: number | null;
	wallTimeUsedMs: number;
}

export interface CreateBudgetInput {
	id?: string;
	taskId: string;
	tokensLimit?: number | null;
	tokensUsed?: number;
	costLimit?: number | null;
	costUsed?: number;
	wallTimeLimitMs?: number | null;
	wallTimeUsedMs?: number;
}

export interface Eval {
	id: string;
	taskId: string;
	provider: string;
	model: string;
	role: string;
	metrics: Record<string, unknown>;
	createdAt: number;
}

export interface CreateEvalInput {
	id?: string;
	taskId: string;
	provider: string;
	model: string;
	role: string;
	metrics: Record<string, unknown>;
}

export interface ForgeDelivery {
	id: string;
	provider: string;
	repo: string;
	deliveryId: string;
	naturalKey: string;
	status: string;
	retryCount: number;
	receivedAt: number;
	processedAt: number | null;
}

export interface CreateForgeDeliveryInput {
	id?: string;
	provider: string;
	repo: string;
	deliveryId: string;
	naturalKey: string;
	status?: string;
	receivedAt?: number;
}
