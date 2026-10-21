import type { ReviewFinding, ReviewVerdict } from "../review/types.ts";
import type { FindingVerification } from "../verifier/types.ts";

export type ReviewCaseKind = "clean" | "bug";

export interface CorpusGroundTruth {
	file: string;
	keywords: string[];
	redTest: string;
	bugSummary: string;
}

export interface CorpusSample {
	id: string;
	title: string;
	base: string;
	variants: Record<ReviewCaseKind, string>;
	groundTruth: CorpusGroundTruth;
}

export interface CorpusThresholds {
	cleanFpRateMax: number;
	seededRecallMin: number;
	findingSurvivalMin: number;
}

export interface CorpusManifest {
	version: number;
	registeredAt: string;
	thresholds: CorpusThresholds;
	samples: CorpusSample[];
}

export interface ReviewCaseOutcome {
	sampleId: string;
	kind: ReviewCaseKind;
	verdict: ReviewVerdict;
	verdictValid: boolean;
	verifications: FindingVerification[];
	reviewRounds: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	rawText?: string;
	modelError?: string;
	promptError?: string;
}

export interface CaseScore {
	sampleId: string;
	kind: ReviewCaseKind;
	falsePositive: boolean;
	recallHit: boolean;
	findingSurvived: boolean;
	matchedFindingIndex?: number;
}

export interface EvalSummary {
	cleanCases: number;
	cleanFalsePositives: number;
	cleanFpRate: number;
	bugCases: number;
	bugHits: number;
	recall: number;
	matchedFindings: number;
	survivedFindings: number;
	findingSurvival: number;
	reviewRounds: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	invalidVerdicts: number;
	passed: boolean;
	failures: string[];
}

const BLOCKING_SEVERITIES = new Set(["P1", "P2"]);

function normalizePath(value: string): string {
	return value
		.replaceAll("\\", "/")
		.replace(/^\.\//, "")
		.replace(/^[ab]\//, "");
}

export function isBlockingFinding(finding: ReviewFinding): boolean {
	return BLOCKING_SEVERITIES.has(finding.severity);
}

export function findingMatchesGroundTruth(finding: ReviewFinding, groundTruth: CorpusGroundTruth): boolean {
	if (finding.file === undefined) return false;
	const findingPath = normalizePath(finding.file);
	const truthPath = normalizePath(groundTruth.file);
	const pathMatches = findingPath === truthPath || findingPath.endsWith(`/${truthPath}`);
	if (!pathMatches) return false;
	const text = `${finding.claim} ${finding.requiredAction} ${finding.falsifier}`.toLowerCase();
	return groundTruth.keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

export function scoreCase(outcome: ReviewCaseOutcome, groundTruth: CorpusGroundTruth): CaseScore {
	const blocking = outcome.verdict.findings
		.map((finding, index) => ({ finding, index }))
		.filter((entry) => isBlockingFinding(entry.finding));
	if (outcome.kind === "clean") {
		return {
			sampleId: outcome.sampleId,
			kind: outcome.kind,
			falsePositive: blocking.length > 0,
			recallHit: false,
			findingSurvived: false,
		};
	}
	const match = blocking.find((entry) => findingMatchesGroundTruth(entry.finding, groundTruth));
	const verification =
		match === undefined ? undefined : outcome.verifications.find((entry) => entry.audit.index === match.index);
	return {
		sampleId: outcome.sampleId,
		kind: outcome.kind,
		falsePositive: false,
		recallHit: match !== undefined,
		findingSurvived: verification?.status === "confirmed",
		...(match === undefined ? {} : { matchedFindingIndex: match.index }),
	};
}

export function summarize(
	outcomes: ReviewCaseOutcome[],
	scores: CaseScore[],
	thresholds: CorpusThresholds,
): EvalSummary {
	const cleanScores = scores.filter((score) => score.kind === "clean");
	const bugScores = scores.filter((score) => score.kind === "bug");
	const cleanFalsePositives = cleanScores.filter((score) => score.falsePositive).length;
	const bugHits = bugScores.filter((score) => score.recallHit).length;
	const matchedFindings = bugScores.filter((score) => score.matchedFindingIndex !== undefined).length;
	const survivedFindings = bugScores.filter((score) => score.findingSurvived).length;
	const cleanFpRate = cleanScores.length === 0 ? 1 : cleanFalsePositives / cleanScores.length;
	const recall = bugScores.length === 0 ? 0 : bugHits / bugScores.length;
	const findingSurvival = matchedFindings === 0 ? 0 : survivedFindings / matchedFindings;
	const failures: string[] = [];
	if (cleanScores.length < 5) failures.push(`clean cases: ${cleanScores.length} < 5`);
	if (bugScores.length < 5) failures.push(`seeded-bug cases: ${bugScores.length} < 5`);
	if (cleanFpRate > thresholds.cleanFpRateMax) {
		failures.push(`clean FP rate ${cleanFpRate.toFixed(2)} > ${thresholds.cleanFpRateMax}`);
	}
	if (recall < thresholds.seededRecallMin) {
		failures.push(`seeded recall ${recall.toFixed(2)} < ${thresholds.seededRecallMin}`);
	}
	if (findingSurvival < thresholds.findingSurvivalMin) {
		failures.push(`finding survival ${findingSurvival.toFixed(2)} < ${thresholds.findingSurvivalMin}`);
	}
	return {
		cleanCases: cleanScores.length,
		cleanFalsePositives,
		cleanFpRate,
		bugCases: bugScores.length,
		bugHits,
		recall,
		matchedFindings,
		survivedFindings,
		findingSurvival,
		reviewRounds: outcomes.reduce((sum, outcome) => sum + outcome.reviewRounds, 0),
		inputTokens: outcomes.reduce((sum, outcome) => sum + outcome.inputTokens, 0),
		outputTokens: outcomes.reduce((sum, outcome) => sum + outcome.outputTokens, 0),
		costUsd: outcomes.reduce((sum, outcome) => sum + outcome.costUsd, 0),
		invalidVerdicts: outcomes.filter((outcome) => !outcome.verdictValid).length,
		passed: failures.length === 0,
		failures,
	};
}
