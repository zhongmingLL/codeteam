import type { ControlStore } from "../control/store.ts";
import type { Eval } from "../control/stores/types.ts";
import { resolveModelFamily } from "../review/model-family.ts";
import type {
	EvalCorpusObservation,
	EvalCorpusReport,
	EvalMatrixAggregate,
	EvalMatrixCell,
	EvalMeasurementStatus,
	SyntheticReviewCorpusMetricsV1,
	TaskOutcomeEpisodeMetricsV1,
} from "./contract.ts";

export interface BuildEvalCorpusReportOptions {
	readonly store?: ControlStore;
	readonly syntheticObservations?: readonly EvalCorpusObservation[];
	readonly windowStartMs: number;
	readonly windowEndMs: number;
	readonly minSample?: number;
}

const OUTCOME_KEYS: readonly TaskOutcomeEpisodeMetricsV1["outcome"][] = [
	"merged",
	"rejected",
	"blocked",
	"abandoned",
	"unknown",
];

interface MutableAggregate {
	n: number;
	statusCounts: Record<EvalMeasurementStatus | "unknown", number>;
	excludedNonOk: number;
	taskOutcomeCount: number;
	syntheticReviewCount: number;
	outcomeCounts: Record<TaskOutcomeEpisodeMetricsV1["outcome"], number>;
	firstPassPass: number;
	firstPassTotal: number;
	reviewRoundsSum: number;
	findingsSum: number;
	confirmed: number;
	rejected: number;
	blocked: number;
	syntheticClean: number;
	syntheticCleanFalsePositive: number;
	syntheticSeeded: number;
	syntheticSeededDetected: number;
	syntheticConfirmed: number;
	syntheticRejected: number;
	syntheticBlocked: number;
	timeToGreenSum: number;
	timeToGreenCount: number;
	costPerMergedSum: number;
	costPerMergedCount: number;
	humanInterventions: number;
	tokensSum: number;
	tokensCount: number;
	costSum: number;
	costCount: number;
	latencySum: number;
	latencyCount: number;
}

function emptyAggregate(): MutableAggregate {
	return {
		n: 0,
		statusCounts: { ok: 0, insufficient: 0, no_data: 0, degraded: 0, unknown: 0 },
		excludedNonOk: 0,
		taskOutcomeCount: 0,
		syntheticReviewCount: 0,
		outcomeCounts: { merged: 0, rejected: 0, blocked: 0, abandoned: 0, unknown: 0 },
		firstPassPass: 0,
		firstPassTotal: 0,
		reviewRoundsSum: 0,
		findingsSum: 0,
		confirmed: 0,
		rejected: 0,
		blocked: 0,
		syntheticClean: 0,
		syntheticCleanFalsePositive: 0,
		syntheticSeeded: 0,
		syntheticSeededDetected: 0,
		syntheticConfirmed: 0,
		syntheticRejected: 0,
		syntheticBlocked: 0,
		timeToGreenSum: 0,
		timeToGreenCount: 0,
		costPerMergedSum: 0,
		costPerMergedCount: 0,
		humanInterventions: 0,
		tokensSum: 0,
		tokensCount: 0,
		costSum: 0,
		costCount: 0,
		latencySum: 0,
		latencyCount: 0,
	};
}

function addTaskOutcome(aggregate: MutableAggregate, metrics: TaskOutcomeEpisodeMetricsV1): void {
	aggregate.n += 1;
	aggregate.taskOutcomeCount += 1;
	aggregate.outcomeCounts[metrics.outcome] += 1;
	if (metrics.firstPassReviewPass !== null) {
		aggregate.firstPassTotal += 1;
		if (metrics.firstPassReviewPass) aggregate.firstPassPass += 1;
	}
	aggregate.reviewRoundsSum += metrics.reviewRounds;
	aggregate.findingsSum += metrics.findings.total;
	aggregate.confirmed += metrics.verifications.confirmed;
	aggregate.rejected += metrics.verifications.rejected;
	aggregate.blocked += metrics.verifications.blocked;
	aggregate.humanInterventions += metrics.humanInterventionCount;
	if (metrics.codeMetrics.timeToGreenMs !== null) {
		aggregate.timeToGreenSum += metrics.codeMetrics.timeToGreenMs;
		aggregate.timeToGreenCount += 1;
	}
	if (metrics.codeMetrics.costPerMergedChangeUsd !== null) {
		aggregate.costPerMergedSum += metrics.codeMetrics.costPerMergedChangeUsd;
		aggregate.costPerMergedCount += 1;
	}
	if (metrics.tokens !== null) {
		aggregate.tokensSum += metrics.tokens;
		aggregate.tokensCount += 1;
	}
	if (metrics.costUsd !== null) {
		aggregate.costSum += metrics.costUsd;
		aggregate.costCount += 1;
	}
	if (metrics.latencyMs !== null) {
		aggregate.latencySum += metrics.latencyMs;
		aggregate.latencyCount += 1;
	}
}

function addSyntheticReview(aggregate: MutableAggregate, metrics: SyntheticReviewCorpusMetricsV1): void {
	const cases = metrics.cleanCases + metrics.seededCases;
	aggregate.n += cases;
	aggregate.syntheticReviewCount += cases;
	aggregate.syntheticClean += metrics.cleanCases;
	aggregate.syntheticCleanFalsePositive += metrics.cleanFalsePositiveCases;
	aggregate.syntheticSeeded += metrics.seededCases;
	aggregate.syntheticSeededDetected += metrics.seededDetectedCases;
	aggregate.syntheticConfirmed += metrics.confirmedFindings;
	aggregate.syntheticRejected += metrics.rejectedFindings;
	aggregate.syntheticBlocked += metrics.blockedFindings;
	aggregate.findingsSum += metrics.reportedFindings;
}

function ratio(numerator: number, denominator: number): number | null {
	return denominator === 0 ? null : numerator / denominator;
}

function average(sum: number, count: number): number | null {
	return count === 0 ? null : sum / count;
}

function finalizeAggregate(aggregate: MutableAggregate): EvalMatrixAggregate {
	const liveDecided = aggregate.confirmed + aggregate.rejected;
	const syntheticDecided = aggregate.syntheticConfirmed + aggregate.syntheticRejected;
	return {
		n: aggregate.n,
		statusCounts: aggregate.statusCounts,
		excludedNonOk: aggregate.excludedNonOk,
		outcomeCounts: aggregate.outcomeCounts,
		firstPassReviewPassRate: ratio(aggregate.firstPassPass, aggregate.firstPassTotal),
		averageReviewRounds:
			aggregate.taskOutcomeCount === 0 ? 0 : aggregate.reviewRoundsSum / aggregate.taskOutcomeCount,
		findingsPerEpisode: aggregate.taskOutcomeCount === 0 ? 0 : aggregate.findingsSum / aggregate.taskOutcomeCount,
		reviewFalsePositiveRate:
			aggregate.syntheticClean > 0
				? ratio(aggregate.syntheticCleanFalsePositive, aggregate.syntheticClean)
				: ratio(aggregate.rejected, liveDecided),
		findingSurvival:
			aggregate.syntheticSeeded > 0
				? ratio(aggregate.syntheticConfirmed, syntheticDecided)
				: ratio(aggregate.confirmed, liveDecided),
		reviewRecall:
			aggregate.syntheticSeeded > 0 ? ratio(aggregate.syntheticSeededDetected, aggregate.syntheticSeeded) : null,
		averageTimeToGreenMs: average(aggregate.timeToGreenSum, aggregate.timeToGreenCount),
		averageCostPerMergedChangeUsd: average(aggregate.costPerMergedSum, aggregate.costPerMergedCount),
		humanInterventionRate:
			aggregate.taskOutcomeCount === 0 ? 0 : aggregate.humanInterventions / aggregate.taskOutcomeCount,
		averageTokens: average(aggregate.tokensSum, aggregate.tokensCount),
		averageCostUsd: average(aggregate.costSum, aggregate.costCount),
		averageLatencyMs: average(aggregate.latencySum, aggregate.latencyCount),
	};
}

function liveObservation(evalRecord: Eval): EvalCorpusObservation | null {
	const metrics = evalRecord.metrics as unknown as TaskOutcomeEpisodeMetricsV1;
	if (metrics?.kind !== "task_outcome_episode" || metrics.v !== 1) return null;
	return {
		evidenceTier: "live",
		kind: "task_outcome",
		provider: evalRecord.provider,
		model: evalRecord.model,
		modelFamily: resolveModelFamily(evalRecord.model),
		role: evalRecord.role,
		repo: metrics.repo ?? "unknown",
		status: evalRecord.status,
		taskOutcome: metrics,
	};
}

function isTaskOutcomeEval(evalRecord: Eval): boolean {
	const metrics = evalRecord.metrics as { kind?: unknown; v?: unknown };
	return metrics?.kind === "task_outcome_episode" && metrics.v === 1;
}

/** One bundle is one task outcome lineage; only its latest snapshot counts. */
function latestLiveSnapshots(records: readonly Eval[]): Eval[] {
	const latestByBundle = new Map<string, Eval>();
	const standalone: Eval[] = [];
	for (const record of records) {
		if (!isTaskOutcomeEval(record)) continue;
		if (!record.bundleId) {
			standalone.push(record);
			continue;
		}
		const current = latestByBundle.get(record.bundleId);
		if (
			!current ||
			record.createdAt > current.createdAt ||
			(record.createdAt === current.createdAt && record.id > current.id)
		) {
			latestByBundle.set(record.bundleId, record);
		}
	}
	return [...latestByBundle.values(), ...standalone].sort(
		(left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
	);
}

function assertObservation(observation: EvalCorpusObservation): void {
	if (observation.kind === "task_outcome" && !observation.taskOutcome) {
		throw new Error("task_outcome observation requires taskOutcome metrics");
	}
	if (observation.kind === "review_corpus" && !observation.reviewCorpus) {
		throw new Error("review_corpus observation requires reviewCorpus metrics");
	}
	if (observation.kind === "review_corpus" && observation.evidenceTier !== "synthetic") {
		throw new Error("review_corpus observations are synthetic-only in W6b");
	}
}

export function buildEvalCorpusReport(options: BuildEvalCorpusReportOptions): EvalCorpusReport {
	if (!Number.isSafeInteger(options.windowStartMs) || options.windowStartMs < 0) {
		throw new Error("windowStartMs must be a non-negative integer");
	}
	if (!Number.isSafeInteger(options.windowEndMs) || options.windowEndMs <= options.windowStartMs) {
		throw new Error("windowEndMs must be greater than windowStartMs");
	}
	const minSample = options.minSample ?? 20;
	if (!Number.isSafeInteger(minSample) || minSample < 1) {
		throw new Error("minSample must be a positive integer");
	}
	const live = options.store
		? latestLiveSnapshots(
				options.store.evals
					.list({ limit: 5000, order: "desc" })
					.filter(
						(record) =>
							record.windowStartMs !== null &&
							record.windowEndMs !== null &&
							record.windowEndMs >= options.windowStartMs &&
							record.windowStartMs <= options.windowEndMs,
					),
			)
				.map(liveObservation)
				.filter((observation): observation is EvalCorpusObservation => observation !== null)
		: [];
	const synthetic = [...(options.syntheticObservations ?? [])];
	for (const observation of synthetic) assertObservation(observation);
	const groups = new Map<string, { observation: EvalCorpusObservation; aggregate: MutableAggregate }>();
	for (const observation of [...live, ...synthetic]) {
		const key = [
			observation.evidenceTier,
			observation.kind,
			observation.provider,
			observation.model,
			observation.role,
			observation.repo,
		].join("\u001f");
		let group = groups.get(key);
		if (!group) {
			group = { observation, aggregate: emptyAggregate() };
			groups.set(key, group);
		}
		const status = observation.status ?? "unknown";
		group.aggregate.statusCounts[status] += 1;
		if (status !== "ok") {
			group.aggregate.excludedNonOk += 1;
			continue;
		}
		if (observation.kind === "task_outcome" && observation.taskOutcome) {
			addTaskOutcome(group.aggregate, observation.taskOutcome);
		} else if (observation.kind === "review_corpus" && observation.reviewCorpus) {
			addSyntheticReview(group.aggregate, observation.reviewCorpus);
		}
	}
	const cells: EvalMatrixCell[] = [...groups.values()].map(({ observation, aggregate }) => {
		const conclusionAllowed =
			observation.evidenceTier === "live" &&
			observation.kind === "task_outcome" &&
			observation.modelFamily !== null &&
			aggregate.n >= minSample;
		const smokeOnly = !conclusionAllowed;
		return {
			evidenceTier: observation.evidenceTier,
			provider: observation.provider,
			model: observation.model,
			modelFamily: observation.modelFamily,
			role: observation.role,
			repo: observation.repo,
			...finalizeAggregate(aggregate),
			smokeOnly,
			conclusionAllowed,
			suppressionReason:
				observation.evidenceTier === "synthetic"
					? "synthetic_fixture"
					: observation.modelFamily === null
						? "unknown_model_family"
						: aggregate.n < minSample
							? "below_min_sample"
							: null,
		};
	});
	cells.sort(
		(left, right) =>
			left.evidenceTier.localeCompare(right.evidenceTier) ||
			left.provider.localeCompare(right.provider) ||
			left.model.localeCompare(right.model) ||
			left.role.localeCompare(right.role) ||
			left.repo.localeCompare(right.repo),
	);
	const liveAggregate = emptyAggregate();
	const syntheticAggregate = emptyAggregate();
	for (const group of groups.values()) {
		if (group.observation.evidenceTier === "live") {
			Object.assign(liveAggregate, mergeAggregate(liveAggregate, group.aggregate));
		} else {
			Object.assign(syntheticAggregate, mergeAggregate(syntheticAggregate, group.aggregate));
		}
	}
	const liveDecided = liveAggregate.confirmed + liveAggregate.rejected;
	const warnings = new Set<string>();
	if (liveAggregate.taskOutcomeCount === 0) warnings.add("no_live_data");
	if (synthetic.length > 0) warnings.add("synthetic_fixture_not_model_conclusion");
	if (cells.some((cell) => cell.n < minSample)) warnings.add("below_min_sample");
	if (cells.some((cell) => cell.excludedNonOk > 0)) warnings.add("non_ok_episodes_excluded");
	if (cells.some((cell) => cell.evidenceTier === "live" && cell.modelFamily === null)) {
		warnings.add("unknown_model_family");
	}
	return {
		v: 1,
		window: { startMs: options.windowStartMs, endMs: options.windowEndMs },
		minSample,
		cells,
		codeDomain: {
			liveEpisodes: liveAggregate.taskOutcomeCount,
			syntheticEpisodes: syntheticAggregate.syntheticReviewCount,
			mergedEpisodes: liveAggregate.outcomeCounts.merged,
			reviewFalsePositiveRate:
				liveAggregate.syntheticClean > 0
					? ratio(liveAggregate.syntheticCleanFalsePositive, liveAggregate.syntheticClean)
					: ratio(liveAggregate.rejected, liveDecided),
			findingSurvival:
				liveAggregate.syntheticSeeded > 0
					? ratio(
							liveAggregate.syntheticConfirmed,
							liveAggregate.syntheticConfirmed + liveAggregate.syntheticRejected,
						)
					: ratio(liveAggregate.confirmed, liveDecided),
			averageTimeToGreenMs: average(liveAggregate.timeToGreenSum, liveAggregate.timeToGreenCount),
			averageCostPerMergedChangeUsd: average(liveAggregate.costPerMergedSum, liveAggregate.costPerMergedCount),
			humanInterventionRate:
				liveAggregate.taskOutcomeCount === 0
					? 0
					: liveAggregate.humanInterventions / liveAggregate.taskOutcomeCount,
			excludedNonOkEpisodes: liveAggregate.excludedNonOk,
		},
		warnings: [...warnings].sort(),
	};
}

function mergeAggregate(target: MutableAggregate, source: MutableAggregate): MutableAggregate {
	return {
		n: target.n + source.n,
		statusCounts: {
			ok: target.statusCounts.ok + source.statusCounts.ok,
			insufficient: target.statusCounts.insufficient + source.statusCounts.insufficient,
			no_data: target.statusCounts.no_data + source.statusCounts.no_data,
			degraded: target.statusCounts.degraded + source.statusCounts.degraded,
			unknown: target.statusCounts.unknown + source.statusCounts.unknown,
		},
		excludedNonOk: target.excludedNonOk + source.excludedNonOk,
		taskOutcomeCount: target.taskOutcomeCount + source.taskOutcomeCount,
		syntheticReviewCount: target.syntheticReviewCount + source.syntheticReviewCount,
		outcomeCounts: Object.fromEntries(
			OUTCOME_KEYS.map((key) => [key, target.outcomeCounts[key] + source.outcomeCounts[key]]),
		) as MutableAggregate["outcomeCounts"],
		firstPassPass: target.firstPassPass + source.firstPassPass,
		firstPassTotal: target.firstPassTotal + source.firstPassTotal,
		reviewRoundsSum: target.reviewRoundsSum + source.reviewRoundsSum,
		findingsSum: target.findingsSum + source.findingsSum,
		confirmed: target.confirmed + source.confirmed,
		rejected: target.rejected + source.rejected,
		blocked: target.blocked + source.blocked,
		syntheticClean: target.syntheticClean + source.syntheticClean,
		syntheticCleanFalsePositive: target.syntheticCleanFalsePositive + source.syntheticCleanFalsePositive,
		syntheticSeeded: target.syntheticSeeded + source.syntheticSeeded,
		syntheticSeededDetected: target.syntheticSeededDetected + source.syntheticSeededDetected,
		syntheticConfirmed: target.syntheticConfirmed + source.syntheticConfirmed,
		syntheticRejected: target.syntheticRejected + source.syntheticRejected,
		syntheticBlocked: target.syntheticBlocked + source.syntheticBlocked,
		timeToGreenSum: target.timeToGreenSum + source.timeToGreenSum,
		timeToGreenCount: target.timeToGreenCount + source.timeToGreenCount,
		costPerMergedSum: target.costPerMergedSum + source.costPerMergedSum,
		costPerMergedCount: target.costPerMergedCount + source.costPerMergedCount,
		humanInterventions: target.humanInterventions + source.humanInterventions,
		tokensSum: target.tokensSum + source.tokensSum,
		tokensCount: target.tokensCount + source.tokensCount,
		costSum: target.costSum + source.costSum,
		costCount: target.costCount + source.costCount,
		latencySum: target.latencySum + source.latencySum,
		latencyCount: target.latencyCount + source.latencyCount,
	};
}
