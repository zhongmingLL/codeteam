import { describe, expect, it } from "vitest";
import { parseReviewVerdict, ReviewParseError } from "./parser.ts";

describe("review verdict parser", () => {
	it("parses an approve verdict with no findings", () => {
		expect(parseReviewVerdict('{"verdict":"approve","findings":[]}')).toEqual({
			verdict: "approve",
			findings: [],
		});
	});

	it("parses a changes_requested verdict with an executable P1", () => {
		const verdict = parseReviewVerdict(
			JSON.stringify({
				verdict: "changes_requested",
				findings: [
					{
						severity: "P1",
						file: "src/math.js",
						line: 2,
						claim: "add still subtracts",
						evidenceKind: "red_test",
						falsifier: "node --test",
						requiredAction: "return a + b",
					},
				],
			}),
		);
		expect(verdict.verdict).toBe("changes_requested");
		expect(verdict.findings[0]?.severity).toBe("P1");
	});

	it("parses an explicit falsifier expectation", () => {
		const verdict = parseReviewVerdict(
			JSON.stringify({
				verdict: "changes_requested",
				findings: [
					{
						severity: "P1",
						claim: "the test expectation was weakened",
						evidenceKind: "static_check",
						falsifier: 'grep -n "add(2, 3), -1" test/math.test.js',
						falsifierExpected: "zero",
						requiredAction: "restore the test",
					},
				],
			}),
		);
		expect(verdict.findings[0]?.severity).toBe("P1");
		expect(verdict.findings[0]?.falsifierExpected).toBe("zero");
	});

	it("downgrades a static_check without falsifierExpected to P3", () => {
		const verdict = parseReviewVerdict(
			JSON.stringify({
				verdict: "changes_requested",
				findings: [
					{
						severity: "P1",
						claim: "the test expectation was weakened",
						evidenceKind: "static_check",
						falsifier: 'grep -n "add(2, 3), -1" test/math.test.js',
						requiredAction: "restore the test",
					},
				],
			}),
		);
		expect(verdict.findings[0]?.severity).toBe("P3");
		expect(verdict.findings[0]?.falsifierExpected).toBeUndefined();
	});

	it("downgrades P1/P2 without an executable falsifier to P3", () => {
		const verdict = parseReviewVerdict(
			JSON.stringify({
				verdict: "changes_requested",
				findings: [
					{
						severity: "P1",
						claim: "this looks risky",
						evidenceKind: "judgment",
						falsifier: "none",
						requiredAction: "double-check",
					},
				],
			}),
		);
		expect(verdict.findings[0]?.severity).toBe("P3");
	});

	it("parses JSON inside a markdown code fence", () => {
		const verdict = parseReviewVerdict('```json\n{"verdict":"approve","findings":[]}\n```');
		expect(verdict.verdict).toBe("approve");
	});

	it("rejects responses without a JSON object", () => {
		expect(() => parseReviewVerdict("looks good to me")).toThrowError(ReviewParseError);
	});

	it("rejects an invalid verdict", () => {
		expect(() => parseReviewVerdict('{"verdict":"lgtm","findings":[]}')).toThrowError(ReviewParseError);
	});
});
