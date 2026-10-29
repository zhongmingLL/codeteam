/**
 * Frozen W6b eval contract. Consumers (CLI, W7 read surfaces, future
 * scheduler) depend on these shapes only; stores and implementation classes
 * are intentionally not part of the contract.
 */

export type EvalDomainFrequency = "manual" | "daily" | "weekly";
export type EvalTriggerPolicyKind = "time_only" | "threshold_or_time";
export type EvalSourceAdapterId = "task_outcome" | "eval_corpus";
export type EvalSourceRefsKind = "task" | "review" | "merge" | "artifact" | "trajectory";

export interface EvalDomainSla {
	readonly acknowledgementHours: number;
	readonly reevaluationHours: number;
}

export interface EvalDomainDormancy {
	readonly reason: string;
	readonly revivalPath: string;
	readonly decisionRef: string;
}

export interface EvalDomainRegistryEntry {
	readonly domainId: `eval:${string}`;
	readonly descriptionForHuman?: string;
	readonly systemThreadId: string;
	readonly evalAgent: string;
	readonly frequency: EvalDomainFrequency;
	readonly triggerPolicy: {
		readonly kind: EvalTriggerPolicyKind;
		readonly maxDetectionDelayHours: number;
	};
	readonly sourceAdapter: EvalSourceAdapterId;
	readonly sourceRefsKind: EvalSourceRefsKind;
	readonly sla: EvalDomainSla;
	readonly enabled: boolean;
	readonly dormancy?: EvalDomainDormancy;
}

export interface EvalAgentInvocationPacket {
	readonly v: 1;
	readonly invocationId: string;
	readonly domainId: string;
	readonly targetThreadId: string;
	readonly evalAgent: string;
	readonly evalAgentRole: "eval";
	readonly instructions: {
		readonly goal: string;
		readonly sourceAdapter: EvalSourceAdapterId;
		readonly sourceRefsKind: EvalSourceRefsKind;
		readonly outputContract: "VerdictHandoffPacketV1";
	};
	readonly context: {
		readonly windowStartMs: number;
		readonly windowEndMs: number;
		readonly trendRefs: readonly string[];
		readonly verdictRefs: readonly string[];
		readonly sourceRefs: readonly string[];
		readonly sla: EvalDomainSla;
	};
}

export type EvalVerdictKind = "fix" | "build" | "keep_observe" | "delete_sunset";
export type EvalMeasurementStatus = "ok" | "insufficient" | "no_data" | "degraded";

export interface EvalMeasurementV1 {
	readonly status: EvalMeasurementStatus;
	readonly method: string;
	readonly windowStartMs: number;
	readonly windowEndMs: number;
	readonly measurementRef: string;
	readonly reasons: readonly string[];
}

export type EvalFindingSeverity = "P1" | "P2" | "P3";

export interface VerdictFindingV1 {
	readonly severity: EvalFindingSeverity;
	readonly claim: string;
	readonly evidenceRefs: readonly string[];
	readonly falsifier?: string;
	readonly requiredAction?: string;
}

export interface VerdictHandoffPacketV1 {
	readonly v: 1;
	readonly id: string;
	readonly domainId: string;
	readonly bundleId: string;
	readonly createdAt: number;
	readonly phenomenon: string;
	readonly harnessUnderEval: {
		readonly featureId: string;
		readonly componentId: string;
		readonly name: string;
	};
	readonly evidencePacket: {
		readonly sourceRefs: readonly string[];
		readonly summary: string;
		readonly measurement: EvalMeasurementV1;
		readonly snapshotRef?: string;
		readonly attributionRef?: string;
	};
	readonly rootCauseHypothesis: string;
	readonly verdict: EvalVerdictKind;
	readonly findingKey?: string;
	readonly findings: readonly VerdictFindingV1[];
	readonly ownerAsk: {
		readonly targetFeatureId: string;
		readonly targetOwnerProfileId: string;
		readonly requestedAction: string;
	};
	readonly acceptanceReevalPlan: {
		readonly nextEvalAt: number;
		readonly closureCondition: string;
	};
	readonly counterarguments: readonly string[];
	readonly governance: {
		readonly cvoAcceptRequired: boolean;
		readonly cvoSuppressed: boolean;
	};
}

export type EvalLifecycleStatus =
	| "open"
	| "acknowledged"
	| "action_planned"
	| "fix_landed"
	| "reeval_pending"
	| "monitoring"
	| "escalated"
	| "resolved"
	| "suppressed_with_reason";

export type EvalLifecycleEventType =
	| "verdict_opened"
	| "owner_acknowledged"
	| "action_planned"
	| "fix_landed"
	| "reeval_requested"
	| "reeval_passed"
	| "reeval_failed"
	| "escalated"
	| "cvo_suppressed"
	| "sunset_accepted"
	| "resolved";

export type EvalLifecycleActorKind = "eval" | "owner" | "operator" | "system";

export interface EvalLifecycleActor {
	readonly kind: EvalLifecycleActorKind;
	readonly id: string;
}

export interface EvalLifecycleEvent {
	readonly eventId: string;
	readonly caseId: string;
	readonly seq: number;
	readonly verdictId: string;
	readonly domainId: string;
	readonly type: EvalLifecycleEventType;
	readonly actor: EvalLifecycleActor;
	readonly reason: string;
	readonly refs: readonly string[];
	readonly createdAt: number;
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
	readonly lastEventAt: number;
	readonly nextSequence: number;
	readonly createdAt: number;
	readonly sla: EvalDomainSla;
	readonly events: readonly EvalLifecycleEvent[];
}

export interface EvalArtifactRef {
	readonly kind: "eval-verdict" | "eval-finding" | "eval-snapshot" | "eval-attribution" | "lifecycle-root";
	readonly path: string;
	readonly sha256: string;
	readonly bytes: number;
}

export interface EvalVerdictMetricsV1 {
	readonly v: 1;
	readonly kind: "eval_verdict";
	readonly packet: VerdictHandoffPacketV1;
	readonly evalAgent: string;
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
	readonly createdAt: number;
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

export interface EvalCaseListItem {
	readonly caseId: string;
	readonly verdictId: string;
	readonly domainId: string;
	readonly findingKey: string;
	readonly verdict: EvalVerdictKind;
	readonly status: EvalLifecycleStatus;
	readonly awaitingSunsetDecision: boolean;
	readonly overdue: boolean;
	readonly createdAt: number;
	readonly lastEventAt: number;
}

export const EVAL_DOMAIN_ID_PATTERN = /^eval:[a-z0-9][a-z0-9-]*$/;
export const EVAL_BUNDLE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const EVAL_FINDING_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const EVAL_CASE_ID_PATTERN = /^eval-case-v1-[a-f0-9]{64}$/;
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
	"reeval_pending",
	"monitoring",
	"escalated",
	"resolved",
	"suppressed_with_reason",
];
export const EVAL_LIFECYCLE_EVENT_TYPES: readonly EvalLifecycleEventType[] = [
	"verdict_opened",
	"owner_acknowledged",
	"action_planned",
	"fix_landed",
	"reeval_requested",
	"reeval_passed",
	"reeval_failed",
	"escalated",
	"cvo_suppressed",
	"sunset_accepted",
	"resolved",
];
export const EVAL_LIFECYCLE_ACTOR_KINDS: readonly EvalLifecycleActorKind[] = ["eval", "owner", "operator", "system"];
export const TERMINAL_EVAL_STATUSES: readonly EvalLifecycleStatus[] = ["resolved", "suppressed_with_reason"];
