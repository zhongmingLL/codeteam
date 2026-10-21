import { describe, expect, it } from "vitest";
import type { ReviewFinding, ReviewVerdict } from "../review/types.ts";
import type { FindingVerification } from "../verifier/types.ts";
import {
	type CorpusGroundTruth,
	type ReviewCaseKind,
	type ReviewCaseOutcome,
	scoreCase,
	summarize,
} from "./scoring.ts";

const groundTruth: CorpusGroundTruth = {
	file: "src/cache.js",
	keywords: ["recency", "evict"],
	redTest: "red-test.mjs",
	bugSummary: "set does not refresh recency",
};

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
	return {
		severity: "P1",
		file: "src/cache.js",
		claim: "set does not refresh recency, so the wrong key is evicted",
		evidenceKind: "repro_command",
		falsifier: "node --test test/cache.test.js",
		falsifierExpected: "nonzero",
		requiredAction: "delete the key before set",
		...overrides,
	};
}

function verification(index: number, status: FindingVerification["status"]): FindingVerification {
	const subject = finding();
	return {
		finding: subject,
		status,
		reason: status,
		audit: {
			index,
			finding: subject,
			mode: "repro",
			cwd: "/tmp/work",
			command: subject.falsifier,
			status,
			reason: status,
		},
	};
}

function outcome(
	kind: ReviewCaseKind,
	findings: ReviewFinding[],
	verifications: FindingVerification[] = [],
	verdict: ReviewVerdict["verdict"] = "approve",
): ReviewCaseOutcome {
	return {
		sampleId: "sample",
		kind,
		verdict: { verdict, findings },
		verdictValid: true,
		verifications,
		reviewRounds: 1,
		inputTokens: 100,
		outputTokens: 20,
		costUsd: 0.01,
	};
}

describe("scoreCase", () => {
	it("does not count an approve verdict on a clean change as a false positive", () => {
		const score = scoreCase(outcome("clean", []), groundTruth);
		expect(score.falsePositive).toBe(false);
	});

	it("ignores P3 findings on clean changes", () => {
		const score = scoreCase(outcome("clean", [finding({ severity: "P3" })]), groundTruth);
		expect(score.falsePositive).toBe(false);
	});

	it("counts a blocking finding on a clean change as a false positive", () => {
		const score = scoreCase(outcome("clean", [finding({ severity: "P2" })]), groundTruth);
		expect(score.falsePositive).toBe(true);
	});

	it("matches a seeded bug by file and keyword", () => {
		const score = scoreCase(
			outcome("bug", [finding()], [verification(0, "confirmed")], "changes_requested"),
			groundTruth,
		);
		expect(score.recallHit).toBe(true);
		expect(score.findingSurvived).toBe(true);
		expect(score.matchedFindingIndex).toBe(0);
	});

	it("rejects a finding on the wrong file", () => {
		const score = scoreCase(outcome("bug", [finding({ file: "src/other.js" })]), groundTruth);
		expect(score.recallHit).toBe(false);
	});

	it("rejects a finding on the right file without a defect keyword", () => {
		const score = scoreCase(
			outcome("bug", [
				finding({ claim: "style issue", requiredAction: "rename", falsifier: "grep x src/cache.js" }),
			]),
			groundTruth,
		);
		expect(score.recallHit).toBe(false);
	});

	it("rejects a matched finding whose falsifier is not confirmed", () => {
		const score = scoreCase(outcome("bug", [finding()], [verification(0, "rejected")]), groundTruth);
		expect(score.recallHit).toBe(true);
		expect(score.findingSurvived).toBe(false);
	});
});

describe("summarize", () => {
	const thresholds = { cleanFpRateMax: 0.2, seededRecallMin: 0.6, findingSurvivalMin: 0.8 };

	it("passes when all thresholds are met", () => {
		const outcomes = [
			...Array.from({ length: 5 }, (_, index) => ({ ...outcome("clean", []), sampleId: `clean-${index}` })),
			...Array.from({ length: 5 }, (_, index) => ({
				...outcome("bug", [finding()], [verification(0, "confirmed")]),
				sampleId: `bug-${index}`,
			})),
		];
		const scores = outcomes.map((entry) => scoreCase(entry, groundTruth));
		const summary = summarize(outcomes, scores, thresholds);
		expect(summary.passed).toBe(true);
		expect(summary.cleanFpRate).toBe(0);
		expect(summary.recall).toBe(1);
		expect(summary.findingSurvival).toBe(1);
		expect(summary.reviewRounds).toBe(10);
	});

	it("fails when the FP, recall, or survival gates are missed", () => {
		const outcomes = [
			...Array.from({ length: 5 }, (_, index) => ({
				...outcome("clean", index < 2 ? [finding({ severity: "P2" })] : []),
				sampleId: `clean-${index}`,
			})),
			...Array.from({ length: 5 }, (_, index) => ({
				...outcome("bug", index < 2 ? [finding()] : [finding({ file: "src/other.js" })], [
					verification(0, "rejected"),
				]),
				sampleId: `bug-${index}`,
			})),
		];
		const scores = outcomes.map((entry) => scoreCase(entry, groundTruth));
		const summary = summarize(outcomes, scores, thresholds);
		expect(summary.passed).toBe(false);
		expect(summary.failures).toHaveLength(3);
	});

	it("counts invalid verdicts separately", () => {
		const outcomes = [
			...Array.from({ length: 5 }, (_, index) => ({
				...outcome("clean", []),
				sampleId: `clean-${index}`,
				verdictValid: index !== 0,
			})),
			...Array.from({ length: 5 }, (_, index) => ({
				...outcome("bug", [finding()], [verification(0, "confirmed")]),
				sampleId: `bug-${index}`,
			})),
		];
		const scores = outcomes.map((entry) => scoreCase(entry, groundTruth));
		const summary = summarize(outcomes, scores, thresholds);
		expect(summary.invalidVerdicts).toBe(1);
	});
});
