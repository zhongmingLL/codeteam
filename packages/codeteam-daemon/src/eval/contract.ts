/**
 * Frozen W6b eval contract, aligned with the approved architecture reuse review
 * (`docs/architecture/reuse-review/harness-eval.md`). Clowder wire names are
 * mapped to codeteam identities (evalCat -> evalAgentProfileId, catId ->
 * profileId), but the envelope/lifecycle semantics stay the same.
 */

export type EvalDomainFrequency = "daily" | "weekly" | `every-${number}d`;
export type EvalTriggerPolicyMode = "time_only" | "threshold_or_time";
export type EvalSourceAdapterId = "task_outcome" | "eval_corpus";
export type EvalSourceRefsKind = "task" | "review" | "merge" | "artifact" | "trajectory";

export interface EvalDomainSla {
	readonly acknowledgeHours: number;
	readonly reevalWithinHours: number;
}

export interface EvalDomainFixture {
	readonly id: string;
	readonly featureId: `F${number}`;
	readonly path: string;
	readonly skill?: string;
	readonly signal?: string;
}

export interface EvalDomainDormancy {
	readonly reason: string;
	readonly revivalPath: string;
	readonly decisionRef: string;
}

export interface EvalTriggerPolicyTimeOnly {
	readonly mode: "time_only";
	readonly maxDetectionDelayHours: number;
}

export interface EvalTriggerPolicyThresholdOrTime {
	readonly mode: "threshold_or_time";
	readonly cooldownHours: number;
	readonly eventSource: string;
	readonly threshold: Readonly<Record<string, number>>;
}

export type EvalTriggerPolicy = EvalTriggerPolicyTimeOnly | EvalTriggerPolicyThresholdOrTime;

export interface EvalDomainRegistryEntry {
	readonly domainId: `eval:${string}`;
	readonly displayName: string;
	readonly descriptionForHuman?: string;
	readonly metricGlossary?: Readonly<Record<string, string>>;
	readonly systemThreadId: string;
	readonly evalAgent: {
		readonly profileId: string;
		readonly role: "eval";
		readonly handle: string;
		readonly model: string;
	};
	readonly frequency: EvalDomainFrequency;
	readonly triggerPolicy: EvalTriggerPolicy;
	readonly sourceAdapter: EvalSourceAdapterId;
	readonly sourceRefsKind: EvalSourceRefsKind;
	readonly handoffTargetResolver: {
		readonly featureId: `F${number}`;
		readonly ownerProfileId: string;
		readonly threadLookup: "feature-thread";
	};
	readonly sla: EvalDomainSla;
	readonly fixtures?: readonly EvalDomainFixture[];
	readonly legacyScheduledTaskIds?: readonly string[];
	readonly threadPolicy?: {
		readonly role: "working-home";
		readonly stateSot: "registry";
		readonly allowedContent?: readonly string[];
	};
	readonly enabled: boolean;
	readonly dormancy?: EvalDomainDormancy;
}

export interface EvalAgentInvocationPacket {
	readonly v: 1;
	readonly invocationId: string;
	readonly domainId: string;
	readonly targetThreadId: string;
	readonly evalAgentProfileId: string;
	readonly evalAgentRole: "eval";
	readonly instructions: {
		readonly goal: string;
		readonly publish: string;
		readonly outputContract: "VerdictHandoffPacketV1";
		readonly publishRequired: true;
	};
	readonly context: {
		readonly windowStartMs: number;
		readonly windowEndMs: number;
		readonly trendRefs: readonly string[];
		readonly verdictRefs: readonly string[];
		readonly sourceAdapter: EvalSourceAdapterId;
		readonly sourceRefsKind: EvalSourceRefsKind;
		readonly sourceRefs: readonly string[];
		readonly fixtures: readonly EvalDomainFixture[];
		readonly handoffTargetResolver: EvalDomainRegistryEntry["handoffTargetResolver"];
		readonly sla: EvalDomainSla;
	};
}

export type EvalVerdictKind = "fix" | "build" | "keep_observe" | "delete_sunset";
export type EvalMeasurementStatus = "ok" | "insufficient" | "no_data" | "degraded";
export type EvalTrendDirection = "improved" | "regressed" | "flat" | "unknown";
export type EvalRootCauseConfidence = "low" | "medium" | "high";

export interface VerdictHandoffPacketV1 {
	readonly v: 1;
	readonly id: string;
	readonly domainId: `eval:${string}`;
	readonly findingKey?: string;
	readonly createdAt: string;
	readonly phenomenon: string;
	readonly harnessUnderEval: {
		readonly featureId: string;
		readonly componentId: string;
		readonly name: string;
	};
	readonly evidencePacket: {
		readonly snapshotRefs: readonly string[];
		readonly attributionRefs: readonly string[];
		readonly metricRefs: readonly string[];
		readonly sampleTraceRefs: readonly string[];
	};
	readonly dailyTrend: {
		readonly window: string;
		readonly current: Readonly<Record<string, number>>;
		readonly baseline: Readonly<Record<string, number>>;
		readonly threshold: Readonly<Record<string, number>>;
		readonly direction: EvalTrendDirection;
	};
	readonly rootCauseHypothesis: {
		readonly summary: string;
		readonly confidence: EvalRootCauseConfidence;
		readonly alternatives: readonly string[];
	};
	readonly verdict: EvalVerdictKind;
	readonly ownerAsk: {
		readonly targetFeatureId: string;
		readonly targetOwnerProfileId: string;
		readonly requestedAction: string;
	};
	readonly governance?: {
		readonly cvoAcceptRequired: boolean;
	};
	readonly acceptanceReevalPlan: {
		readonly nextEvalAt: string;
		readonly closureCondition: string;
	};
	readonly counterarguments: readonly string[];
}

export interface EvalMeasurementMetricV1 {
	readonly metricId: string;
	readonly role: "primary_loss" | "guardrail";
	readonly n: number;
	readonly pointEstimate: number | null;
	readonly evidenceStatus: "sufficient" | "insufficient";
}

export interface EvalMeasurementResultV1 {
	readonly v: 1;
	readonly kind: "eval_measurement_result";
	readonly resultId: string;
	readonly bundleId: string;
	readonly domainId: string;
	readonly generatedAt: string;
	readonly status: EvalMeasurementStatus;
	readonly method: string;
	readonly cohort: {
		readonly ref: string;
		readonly sha256: string;
		readonly window: { readonly startMs: number; readonly endMs: number };
	};
	readonly metrics: readonly EvalMeasurementMetricV1[];
	readonly decision: {
		readonly status: "usable" | "insufficient";
		readonly reasons: readonly string[];
		readonly withdrawalConditions: readonly string[];
	};
	readonly actionProposal: {
		readonly action: EvalVerdictKind;
		readonly rationale: string;
	};
	readonly measurementRef: string;
}

export type EvalLifecycleStatus =
	| "open"
	| "acknowledged"
	| "action_planned"
	| "fix_landed"
	| "main_landed"
	| "reeval_pending"
	| "monitoring"
	| "live_active"
	| "resolved"
	| "suppressed_with_reason"
	| "escalated";

export type EvalLifecycleEventType =
	| "verdict_opened"
	| "verdict_cycle_observed"
	| "owner_acknowledged"
	| "action_planned"
	| "fix_recorded"
	| "main_landed"
	| "reeval_requested"
	| "reeval_passed"
	| "reeval_failed"
	| "cvo_suppressed"
	| "sla_escalated"
	| "owner_reassigned"
	| "migration"
	| "sunset_accepted";

export type EvalLifecycleActorKind = "agent" | "operator" | "system" | "migration";

export interface EvalLifecycleActor {
	readonly kind: EvalLifecycleActorKind;
	readonly id: string;
}

export interface EvalLifecycleEventPayloadV1 {
	readonly verdictId?: string;
	readonly refs?: readonly string[];
	readonly reason?: string;
	readonly commitSha?: string;
	readonly dueAt?: string;
	readonly targetOwnerProfileId?: string;
	readonly sourceRef?: string;
}

export interface EvalLifecycleEvent {
	readonly eventId: string;
	readonly caseId: string;
	readonly seq: number;
	readonly domainId: string;
	readonly type: EvalLifecycleEventType;
	readonly actor: EvalLifecycleActor;
	readonly payload: EvalLifecycleEventPayloadV1;
	readonly occurredAt: string;
	readonly createdAt: string;
}

export interface EvalCaseProjection {
	readonly caseId: string;
	readonly verdictId: string;
	readonly domainId: string;
	readonly findingKey: string;
	readonly verdict: EvalVerdictKind;
	readonly status: EvalLifecycleStatus;
	readonly awaitingSunsetDecision: boolean;
	readonly overdue: boolean;
	readonly lastEventAt: string;
	readonly nextSequence: number;
	readonly createdAt: string;
	readonly sla: EvalDomainSla;
	readonly events: readonly EvalLifecycleEvent[];
}

export interface EvalCaseListItem {
	readonly caseId: string;
	readonly verdictId: string;
	readonly domainId: string;
	readonly findingKey: string;
	readonly verdict: EvalVerdictKind;
	readonly status: EvalLifecycleStatus;
	readonly awaitingSunsetDecision: boolean;
	readonly overdue: boolean;
	readonly createdAt: string;
	readonly lastEventAt: string;
}

export type EvalArtifactKind =
	| "eval-verdict"
	| "eval-lifecycle-root"
	| "eval-finding"
	| "eval-snapshot"
	| "eval-attribution"
	| "eval-measurement-result";

export interface EvalArtifactRef {
	readonly artifactId: string;
	readonly kind: EvalArtifactKind;
	readonly sha256: string;
	readonly bytes: number;
	readonly path: string;
}

export interface EvalVerdictMetricsV1 {
	readonly v: 1;
	readonly kind: "eval_verdict";
	readonly packet: VerdictHandoffPacketV1;
	readonly measurement: EvalMeasurementResultV1;
	readonly evalAgentProfileId: string;
	readonly systemThreadId: string;
	readonly sla: EvalDomainSla;
	readonly messageId: string;
	readonly artifacts: readonly EvalArtifactRef[];
	readonly lifecycleRootDigest: string;
	readonly findingKey?: string;
	readonly caseId?: string;
}

export interface LifecycleRootArtifactV1 {
	readonly schemaVersion: 1;
	readonly verdictId: string;
	readonly domainId: string;
	readonly createdAt: string;
	readonly verdict: EvalVerdictKind;
	readonly harnessUnderEval: VerdictHandoffPacketV1["harnessUnderEval"];
	readonly ownerAsk: VerdictHandoffPacketV1["ownerAsk"];
	readonly acceptanceReevalPlan: VerdictHandoffPacketV1["acceptanceReevalPlan"];
}

export interface LifecycleRootArtifactV2 extends Omit<LifecycleRootArtifactV1, "schemaVersion"> {
	readonly schemaVersion: 2;
	readonly caseId: string;
	readonly findingKey: string;
}

export type LifecycleRootArtifact = LifecycleRootArtifactV1 | LifecycleRootArtifactV2;

export interface TaskOutcomeEpisodeMetricsV1 {
	readonly v: 1;
	readonly kind: "task_outcome_episode";
	readonly synthetic: false;
	readonly taskId: string;
	readonly runId: string;
	readonly repo: string | null;
	readonly outcome: "merged" | "rejected" | "blocked" | "abandoned" | "unknown";
	readonly firstPassReviewPass: boolean | null;
	readonly reviewRounds: number;
	readonly findings: {
		readonly total: number;
		readonly p1: number;
		readonly p2: number;
		readonly p3: number;
	};
	readonly verifications: {
		readonly confirmed: number;
		readonly rejected: number;
		readonly blocked: number;
	};
	readonly tokens: number | null;
	readonly costUsd: number | null;
	readonly latencyMs: number | null;
	readonly humanInterventionCount: number;
	readonly codeMetrics: {
		readonly reviewFalsePositiveRate: number | null;
		readonly findingSurvival: number | null;
		readonly timeToGreenMs: number | null;
		readonly costPerMergedChangeUsd: number | null;
	};
	readonly sourceRefs: readonly string[];
	readonly windowStartMs: number;
	readonly windowEndMs: number;
}

export interface SyntheticReviewCorpusMetricsV1 {
	readonly v: 1;
	readonly kind: "synthetic_review_corpus";
	readonly synthetic: true;
	readonly cleanCases: number;
	readonly cleanFalsePositiveCases: number;
	readonly seededCases: number;
	readonly seededDetectedCases: number;
	readonly reportedFindings: number;
	readonly confirmedFindings: number;
	readonly rejectedFindings: number;
	readonly blockedFindings: number;
}

export interface EvalCorpusObservation {
	readonly evidenceTier: "live" | "synthetic";
	readonly kind: "task_outcome" | "review_corpus";
	readonly provider: string;
	readonly model: string;
	readonly modelFamily: string | null;
	readonly role: string;
	readonly repo: string;
	readonly status: EvalMeasurementStatus | null;
	readonly taskOutcome?: TaskOutcomeEpisodeMetricsV1;
	readonly reviewCorpus?: SyntheticReviewCorpusMetricsV1;
}

export interface EvalMatrixAggregate {
	readonly n: number;
	readonly statusCounts: Readonly<Record<EvalMeasurementStatus | "unknown", number>>;
	readonly excludedNonOk: number;
	readonly outcomeCounts: Readonly<Record<TaskOutcomeEpisodeMetricsV1["outcome"], number>>;
	readonly firstPassReviewPassRate: number | null;
	readonly averageReviewRounds: number;
	readonly findingsPerEpisode: number;
	readonly reviewFalsePositiveRate: number | null;
	readonly findingSurvival: number | null;
	readonly reviewRecall: number | null;
	readonly averageTimeToGreenMs: number | null;
	readonly averageCostPerMergedChangeUsd: number | null;
	readonly humanInterventionRate: number;
	readonly averageTokens: number | null;
	readonly averageCostUsd: number | null;
	readonly averageLatencyMs: number | null;
}

export interface EvalMatrixCell extends EvalMatrixAggregate {
	readonly evidenceTier: "live" | "synthetic";
	readonly provider: string;
	readonly model: string;
	readonly modelFamily: string | null;
	readonly role: string;
	readonly repo: string;
	readonly smokeOnly: boolean;
	readonly conclusionAllowed: boolean;
	readonly suppressionReason: string | null;
}

export interface EvalCorpusReport {
	readonly v: 1;
	readonly window: { readonly startMs: number; readonly endMs: number };
	readonly minSample: number;
	readonly cells: readonly EvalMatrixCell[];
	readonly codeDomain: {
		readonly liveEpisodes: number;
		readonly syntheticEpisodes: number;
		readonly mergedEpisodes: number;
		readonly reviewFalsePositiveRate: number | null;
		readonly findingSurvival: number | null;
		readonly averageTimeToGreenMs: number | null;
		readonly averageCostPerMergedChangeUsd: number | null;
		readonly humanInterventionRate: number;
		readonly excludedNonOkEpisodes: number;
	};
	readonly warnings: readonly string[];
}

export const EVAL_DOMAIN_ID_PATTERN = /^eval:[a-z0-9][a-z0-9-]*$/;
export const EVAL_BUNDLE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const EVAL_FINDING_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const EVAL_CASE_ID_PATTERN = /^eval-case-v1-[a-f0-9]{64}$/;
export const EVAL_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const EVAL_VERDICT_KINDS: readonly EvalVerdictKind[] = ["fix", "build", "keep_observe", "delete_sunset"];
export const EVAL_MEASUREMENT_STATUSES: readonly EvalMeasurementStatus[] = [
	"ok",
	"insufficient",
	"no_data",
	"degraded",
];
export const EVAL_LIFECYCLE_STATUSES: readonly EvalLifecycleStatus[] = [
	"open",
	"acknowledged",
	"action_planned",
	"fix_landed",
	"main_landed",
	"reeval_pending",
	"monitoring",
	"live_active",
	"resolved",
	"suppressed_with_reason",
	"escalated",
];
export const EVAL_LIFECYCLE_EVENT_TYPES: readonly EvalLifecycleEventType[] = [
	"verdict_opened",
	"verdict_cycle_observed",
	"owner_acknowledged",
	"action_planned",
	"fix_recorded",
	"main_landed",
	"reeval_requested",
	"reeval_passed",
	"reeval_failed",
	"cvo_suppressed",
	"sla_escalated",
	"owner_reassigned",
	"migration",
	"sunset_accepted",
];
export const EVAL_LIFECYCLE_ACTOR_KINDS: readonly EvalLifecycleActorKind[] = [
	"agent",
	"operator",
	"system",
	"migration",
];
export const TERMINAL_EVAL_STATUSES: readonly EvalLifecycleStatus[] = ["resolved", "suppressed_with_reason"];
