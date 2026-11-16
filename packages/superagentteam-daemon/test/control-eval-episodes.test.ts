import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildEvalCorpusReport,
	buildTaskOutcomeEpisode,
	type EvalCorpusObservation,
	materializeTaskOutcomeEpisodes,
	type TaskOutcomeEpisodeMetricsV1,
} from "../src/index.ts";
import { createEvalFixture, type EvalFixture, seedOutcomeTask } from "./helpers/eval-fixture.ts";

const fixtures: EvalFixture[] = [];
const fixtureDir = dirname(fileURLToPath(import.meta.url));

function fixture(): EvalFixture {
	const value = createEvalFixture();
	fixtures.push(value);
	return value;
}

afterEach(() => {
	for (const value of fixtures.splice(0)) value.cleanup();
});

function liveMetrics(overrides: Partial<TaskOutcomeEpisodeMetricsV1> = {}): TaskOutcomeEpisodeMetricsV1 {
	const base: TaskOutcomeEpisodeMetricsV1 = {
		v: 1,
		kind: "task_outcome_episode",
		synthetic: false,
		taskId: "task-outcome",
		runId: "run-outcome",
		repo: "repo-live",
		outcome: "merged",
		firstPassReviewPass: true,
		reviewRounds: 1,
		findings: { total: 1, p1: 0, p2: 1, p3: 0 },
		verifications: { confirmed: 1, rejected: 0, blocked: 0 },
		tokens: 100,
		costUsd: 0.1,
		latencyMs: 1000,
		humanInterventionCount: 0,
		codeMetrics: {
			reviewFalsePositiveRate: 0,
			findingSurvival: 1,
			timeToGreenMs: 2000,
			costPerMergedChangeUsd: 0.1,
		},
		sourceRefs: ["task:task-outcome", "review:review-1"],
		windowStartMs: 1_700_000_000_000,
		windowEndMs: 1_700_000_100_000,
	};
	return { ...base, ...overrides };
}

describe("W6b task outcome episodes", () => {
	it("materializes canonical outcome, review, cost, latency, human, and code metrics", () => {
		const base = fixture();
		const seed = seedOutcomeTask(base.store);
		const result = materializeTaskOutcomeEpisodes(base.store, { taskIds: [seed.taskId] });
		expect(result.created).toBe(1);
		const episode = result.episodes[0]!;
		expect(episode.taskId).toBe(seed.taskId);
		expect(episode.status).toBe("ok");
		expect(episode.provider).toBe("owner-provider");
		expect(episode.model).toBe("glm-owner");
		expect(episode.role).toBe("coder");
		expect(episode.bundleId).toBe("task-outcome:task-outcome");
		expect(episode.measurementRef).toBe("task:task-outcome");
		const metrics = episode.metrics as unknown as TaskOutcomeEpisodeMetricsV1;
		expect(metrics.kind).toBe("task_outcome_episode");
		expect(metrics.synthetic).toBe(false);
		expect(metrics.taskId).toBe(seed.taskId);
		expect(metrics.runId).toBe(seed.runId);
		expect(metrics.repo).toBe("repo-a");
		expect(metrics.outcome).toBe("merged");
		expect(metrics.firstPassReviewPass).toBe(false);
		expect(metrics.reviewRounds).toBe(1);
		expect(metrics.findings).toEqual({ total: 1, p1: 0, p2: 1, p3: 0 });
		expect(metrics.verifications).toEqual({ confirmed: 1, rejected: 0, blocked: 0 });
		expect(metrics.tokens).toBe(150);
		expect(metrics.costUsd).toBe(0.25);
		expect(metrics.humanInterventionCount).toBe(2);
		expect(metrics.codeMetrics.reviewFalsePositiveRate).toBe(0);
		expect(metrics.codeMetrics.findingSurvival).toBe(1);
		expect(metrics.codeMetrics.costPerMergedChangeUsd).toBe(0.5);
		expect(metrics.sourceRefs).toContain(`review:${seed.reviewId}`);
		expect(metrics.sourceRefs).toContain(`merge:${seed.mergeId}`);
		expect(metrics.sourceRefs).toContain("task:task-outcome");
	});

	it("is idempotent for the same canonical payload and records insufficient/no_data reasons", () => {
		const base = fixture();
		const seed = seedOutcomeTask(base.store);
		const first = materializeTaskOutcomeEpisodes(base.store, { taskIds: [seed.taskId] });
		const second = materializeTaskOutcomeEpisodes(base.store, { taskIds: [seed.taskId] });
		expect(first.created).toBe(1);
		expect(second.created).toBe(0);
		expect(second.episodes[0]!.id).toBe(first.episodes[0]!.id);

		const missingReview = fixture();
		const mergeOnly = seedOutcomeTask(missingReview.store, { withReview: false, withMerge: true });
		const mergeOnlyEpisode = materializeTaskOutcomeEpisodes(missingReview.store, { taskIds: [mergeOnly.taskId] })
			.episodes[0]!;
		expect(mergeOnlyEpisode.status).toBe("insufficient");
		expect(mergeOnlyEpisode.reasons).toEqual(["no_review_evidence"]);

		const noData = fixture();
		const empty = seedOutcomeTask(noData.store, { withReview: false, withMerge: false });
		const emptyEpisode = materializeTaskOutcomeEpisodes(noData.store, { taskIds: [empty.taskId] }).episodes[0]!;
		expect(emptyEpisode.status).toBe("no_data");
		expect(emptyEpisode.reasons).toEqual(["no_review_evidence", "no_merge_evidence"]);
	});

	it("builds an episode directly from a task and same-run metrics", () => {
		const base = fixture();
		const seed = seedOutcomeTask(base.store);
		const task = base.store.tasks.get(seed.taskId)!;
		const run = base.store.runs.get(seed.runId)!;
		const built = buildTaskOutcomeEpisode(base.store, task, run);
		expect(built.metrics.runId).toBe(seed.runId);
		expect(built.status).toBe("ok");
	});
});

describe("W6b eval corpus report", () => {
	it("keeps synthetic fixtures smoke-only across 2 providers and 2 repos", () => {
		const raw = JSON.parse(
			readFileSync(join(fixtureDir, "fixtures", "eval-corpus", "observations.json"), "utf8"),
		) as {
			observations: Array<{
				provider: string;
				model: string;
				modelFamily: string;
				role: string;
				repo: string;
				cleanCases: number;
				cleanFalsePositiveCases: number;
				seededCases: number;
				seededDetectedCases: number;
				reportedFindings: number;
				confirmedFindings: number;
				rejectedFindings: number;
				blockedFindings: number;
			}>;
		};
		const synthetic: EvalCorpusObservation[] = raw.observations.map((observation) => ({
			evidenceTier: "synthetic",
			kind: "review_corpus",
			provider: observation.provider,
			model: observation.model,
			modelFamily: observation.modelFamily,
			role: observation.role,
			repo: observation.repo,
			status: "ok",
			reviewCorpus: {
				v: 1,
				kind: "synthetic_review_corpus",
				synthetic: true,
				cleanCases: observation.cleanCases,
				cleanFalsePositiveCases: observation.cleanFalsePositiveCases,
				seededCases: observation.seededCases,
				seededDetectedCases: observation.seededDetectedCases,
				reportedFindings: observation.reportedFindings,
				confirmedFindings: observation.confirmedFindings,
				rejectedFindings: observation.rejectedFindings,
				blockedFindings: observation.blockedFindings,
			},
		}));
		const report = buildEvalCorpusReport({
			syntheticObservations: synthetic,
			windowStartMs: 1_700_000_000_000,
			windowEndMs: 1_700_000_100_000,
			minSample: 20,
		});
		expect(report.cells).toHaveLength(4);
		expect(new Set(report.cells.map((cell) => cell.provider))).toEqual(new Set(["provider-a", "provider-b"]));
		expect(new Set(report.cells.map((cell) => cell.repo))).toEqual(new Set(["repo-a", "repo-b"]));
		for (const cell of report.cells) {
			expect(cell.n).toBe(10);
			expect(cell.smokeOnly).toBe(true);
			expect(cell.conclusionAllowed).toBe(false);
			expect(cell.suppressionReason).toBe("synthetic_fixture");
			expect(cell.reviewRecall).not.toBeNull();
		}
		expect(report.warnings).toContain("no_live_data");
		expect(report.warnings).toContain("synthetic_fixture_not_model_conclusion");
		expect(report.warnings).toContain("below_min_sample");
		expect(report.codeDomain.liveEpisodes).toBe(0);
	});

	it("allows descriptive live conclusions only at n>=20 and keeps live recall null", () => {
		const base = fixture();
		const seed = seedOutcomeTask(base.store);
		for (let index = 0; index < 20; index += 1) {
			base.store.evals.create({
				id: `live-eval-${index}`,
				taskId: seed.taskId,
				provider: "live-provider",
				model: "glm-5",
				role: "coder",
				metrics: liveMetrics() as unknown as Record<string, unknown>,
				bundleId: `live-bundle-${index}`,
				measurementRef: "measurement:live",
				windowStartMs: 1_700_000_000_000,
				windowEndMs: 1_700_000_100_000,
				status: "ok",
			});
		}
		const report = buildEvalCorpusReport({
			store: base.store,
			windowStartMs: 1_700_000_000_000,
			windowEndMs: 1_700_000_100_000,
			minSample: 20,
		});
		expect(report.cells).toHaveLength(1);
		const cell = report.cells[0]!;
		expect(cell.evidenceTier).toBe("live");
		expect(cell.n).toBe(20);
		expect(cell.smokeOnly).toBe(false);
		expect(cell.conclusionAllowed).toBe(true);
		expect(cell.reviewRecall).toBeNull();
		expect(cell.modelFamily).toBe("glm");
		expect(report.codeDomain.liveEpisodes).toBe(20);
		expect(report.warnings).not.toContain("no_live_data");
	});

	it("excludes insufficient/no_data live episodes from quality conclusions", () => {
		const base = fixture();
		const seed = seedOutcomeTask(base.store);
		for (let index = 0; index < 5; index += 1) {
			base.store.evals.create({
				id: `ok-eval-${index}`,
				taskId: seed.taskId,
				provider: "live-provider",
				model: "glm-5",
				role: "coder",
				metrics: liveMetrics() as unknown as Record<string, unknown>,
				bundleId: `ok-bundle-${index}`,
				measurementRef: "measurement:live",
				windowStartMs: 1_700_000_000_000,
				windowEndMs: 1_700_000_100_000,
				status: "ok",
			});
			base.store.evals.create({
				id: `insufficient-eval-${index}`,
				taskId: seed.taskId,
				provider: "live-provider",
				model: "glm-5",
				role: "coder",
				metrics: liveMetrics() as unknown as Record<string, unknown>,
				bundleId: `insufficient-bundle-${index}`,
				measurementRef: "measurement:live",
				windowStartMs: 1_700_000_000_000,
				windowEndMs: 1_700_000_100_000,
				status: "insufficient",
				reasons: ["missing review evidence"],
			});
		}
		const report = buildEvalCorpusReport({
			store: base.store,
			windowStartMs: 1_700_000_000_000,
			windowEndMs: 1_700_000_100_000,
			minSample: 20,
		});
		const cell = report.cells[0]!;
		expect(cell.n).toBe(5);
		expect(cell.excludedNonOk).toBe(5);
		expect(cell.statusCounts.insufficient).toBe(5);
		expect(cell.conclusionAllowed).toBe(false);
		expect(report.codeDomain.excludedNonOkEpisodes).toBe(5);
		expect(report.warnings).toContain("non_ok_episodes_excluded");
	});

	it("counts only the latest snapshot per task outcome bundle", () => {
		const base = fixture();
		const seed = seedOutcomeTask(base.store);
		base.store.evals.create({
			id: "snapshot-old",
			taskId: seed.taskId,
			provider: "live-provider",
			model: "glm-5",
			role: "coder",
			metrics: liveMetrics({ outcome: "rejected" }) as unknown as Record<string, unknown>,
			bundleId: "task-outcome:task-outcome",
			measurementRef: "task:task-outcome",
			windowStartMs: 90,
			windowEndMs: 110,
			status: "ok",
			createdAt: 100,
		});
		base.store.evals.create({
			id: "snapshot-new",
			taskId: seed.taskId,
			provider: "live-provider",
			model: "glm-5",
			role: "coder",
			metrics: liveMetrics({ outcome: "merged" }) as unknown as Record<string, unknown>,
			bundleId: "task-outcome:task-outcome",
			measurementRef: "task:task-outcome",
			windowStartMs: 190,
			windowEndMs: 210,
			status: "ok",
			createdAt: 200,
		});
		const report = buildEvalCorpusReport({
			store: base.store,
			windowStartMs: 50,
			windowEndMs: 300,
			minSample: 1,
		});
		expect(report.cells).toHaveLength(1);
		expect(report.cells[0]!.n).toBe(1);
		expect(report.cells[0]!.outcomeCounts.merged).toBe(1);
		expect(report.cells[0]!.outcomeCounts.rejected).toBe(0);
	});
});
