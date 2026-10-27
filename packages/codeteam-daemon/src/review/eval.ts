import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ControlError } from "../control/errors.ts";
import type { CreateFindingInput } from "../control/stores/types.ts";
import type { ToolPolicy } from "../policy/types.ts";
import { executeFalsifier } from "./falsifier.ts";
import { normalizeFindings } from "./findings.ts";

export interface ReviewCorpusObservation {
	readonly modelFamily: string;
	readonly reviewerModel: string;
	readonly findings: readonly CreateFindingInput[];
}

export interface ReviewCorpusCase {
	readonly id: string;
	readonly kind: "clean" | "seeded";
	readonly files: Readonly<Record<string, string>>;
	readonly observations: readonly ReviewCorpusObservation[];
}

export interface ReviewCorpusThresholds {
	readonly cleanFpMax: number;
	readonly seededRecallMin: number;
	readonly survivalMin: number;
}

export interface ReviewCorpus {
	readonly version: number;
	readonly families: readonly string[];
	readonly thresholds: ReviewCorpusThresholds;
	readonly cases: readonly ReviewCorpusCase[];
}

export interface ReviewCorpusFamilyMetrics {
	readonly family: string;
	readonly cleanObservations: number;
	readonly cleanFalsePositives: number;
	readonly seededObservations: number;
	readonly seededDetected: number;
	readonly reportedFindings: number;
	readonly confirmed: number;
	readonly rejected: number;
	readonly blocked: number;
	readonly cleanFpRate: number;
	readonly seededRecall: number;
	readonly survival: number;
}

export interface ReviewCorpusOverallMetrics extends Omit<ReviewCorpusFamilyMetrics, "family"> {}

export interface ReviewCorpusMetrics {
	readonly cases: number;
	readonly cleanCases: number;
	readonly seededCases: number;
	readonly families: Readonly<Record<string, ReviewCorpusFamilyMetrics>>;
	readonly overall: ReviewCorpusOverallMetrics;
	readonly thresholds: ReviewCorpusThresholds;
	readonly thresholdPass: boolean;
	readonly syntheticObservations: true;
}

export interface RunReviewCorpusOptions {
	readonly corpus: ReviewCorpus;
	readonly rootDir: string;
	readonly createPolicy: (worktreeRoot: string, evidenceRoot: string) => ToolPolicy;
}

interface MutableMetrics {
	cleanObservations: number;
	cleanFalsePositives: number;
	seededObservations: number;
	seededDetected: number;
	reportedFindings: number;
	confirmed: number;
	rejected: number;
	blocked: number;
}

function emptyMetrics(): MutableMetrics {
	return {
		cleanObservations: 0,
		cleanFalsePositives: 0,
		seededObservations: 0,
		seededDetected: 0,
		reportedFindings: 0,
		confirmed: 0,
		rejected: 0,
		blocked: 0,
	};
}

function rate(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : numerator / denominator;
}

function survivalRate(metrics: MutableMetrics): number {
	const decided = metrics.confirmed + metrics.rejected;
	return decided === 0 ? 1 : metrics.confirmed / decided;
}

function finalize(family: string, metrics: MutableMetrics): ReviewCorpusFamilyMetrics {
	return {
		family,
		...metrics,
		cleanFpRate: rate(metrics.cleanFalsePositives, metrics.cleanObservations),
		seededRecall: rate(metrics.seededDetected, metrics.seededObservations),
		survival: survivalRate(metrics),
	};
}

function validateCorpus(corpus: ReviewCorpus): void {
	if (corpus.version !== 1) throw new ControlError("invalid_input", "review corpus version must be 1");
	if (corpus.families.length < 2) throw new ControlError("invalid_input", "review corpus needs at least two families");
	const clean = corpus.cases.filter((entry) => entry.kind === "clean").length;
	const seeded = corpus.cases.filter((entry) => entry.kind === "seeded").length;
	if (clean < 5 || seeded < 5) {
		throw new ControlError("invalid_input", "review corpus needs at least 5 clean and 5 seeded cases");
	}
	for (const entry of corpus.cases) {
		for (const observation of entry.observations) {
			if (!corpus.families.includes(observation.modelFamily)) {
				throw new ControlError("invalid_input", `unknown corpus family: ${observation.modelFamily}`);
			}
		}
	}
}

export async function runReviewCorpus(options: RunReviewCorpusOptions): Promise<ReviewCorpusMetrics> {
	validateCorpus(options.corpus);
	const familyMetrics = new Map<string, MutableMetrics>();
	const overall = emptyMetrics();
	for (const family of options.corpus.families) familyMetrics.set(family, emptyMetrics());

	for (const entry of options.corpus.cases) {
		const worktreeRoot = join(options.rootDir, "cases", entry.id);
		const evidenceRoot = join(options.rootDir, "evidence", entry.id);
		mkdirSync(worktreeRoot, { recursive: true });
		mkdirSync(evidenceRoot, { recursive: true });
		for (const [path, content] of Object.entries(entry.files)) {
			const target = join(worktreeRoot, path);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
		const policy = options.createPolicy(worktreeRoot, evidenceRoot);

		for (const observation of entry.observations) {
			const metrics = familyMetrics.get(observation.modelFamily)!;
			if (entry.kind === "clean") {
				metrics.cleanObservations += 1;
				overall.cleanObservations += 1;
			} else {
				metrics.seededObservations += 1;
				overall.seededObservations += 1;
			}

			const normalized = normalizeFindings(observation.findings, {
				verifierPolicy: policy,
				worktreeRoot,
			});
			const executable = normalized.findings.filter(
				(finding) => finding.severity === "P1" || finding.severity === "P2",
			);
			metrics.reportedFindings += executable.length;
			overall.reportedFindings += executable.length;

			let detected = false;
			for (const finding of executable) {
				const result = await executeFalsifier({
					finding: {
						id: `${entry.id}:${observation.modelFamily}:${metrics.reportedFindings}`,
						severity: finding.severity,
						evidenceKind: finding.evidenceKind,
						falsifier: finding.falsifier,
						falsifierExpected: finding.falsifierExpected ?? null,
					},
					reviewId: `corpus:${entry.id}:${observation.modelFamily}`,
					policy,
				});
				if (result.status === "confirmed") {
					metrics.confirmed += 1;
					overall.confirmed += 1;
					detected = true;
				} else if (result.status === "rejected") {
					metrics.rejected += 1;
					overall.rejected += 1;
				} else {
					metrics.blocked += 1;
					overall.blocked += 1;
				}
			}
			if (entry.kind === "clean" && detected) {
				metrics.cleanFalsePositives += 1;
				overall.cleanFalsePositives += 1;
			}
			if (entry.kind === "seeded" && detected) {
				metrics.seededDetected += 1;
				overall.seededDetected += 1;
			}
		}
	}

	const families: Record<string, ReviewCorpusFamilyMetrics> = {};
	for (const family of options.corpus.families) {
		families[family] = finalize(family, familyMetrics.get(family)!);
	}
	const overallMetrics = finalize("overall", overall);
	const thresholdPass =
		overallMetrics.cleanFpRate <= options.corpus.thresholds.cleanFpMax &&
		overallMetrics.seededRecall >= options.corpus.thresholds.seededRecallMin &&
		overallMetrics.survival >= options.corpus.thresholds.survivalMin &&
		Object.values(families).every(
			(metrics) =>
				metrics.cleanFpRate <= options.corpus.thresholds.cleanFpMax &&
				metrics.seededRecall >= options.corpus.thresholds.seededRecallMin &&
				metrics.survival >= options.corpus.thresholds.survivalMin,
		);
	return {
		cases: options.corpus.cases.length,
		cleanCases: options.corpus.cases.filter((entry) => entry.kind === "clean").length,
		seededCases: options.corpus.cases.filter((entry) => entry.kind === "seeded").length,
		families,
		overall: overallMetrics,
		thresholds: options.corpus.thresholds,
		thresholdPass,
		syntheticObservations: true,
	};
}
