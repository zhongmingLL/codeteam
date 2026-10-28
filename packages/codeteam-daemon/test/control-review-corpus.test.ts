import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createToolPolicy } from "../src/index.ts";
import { type ReviewCorpus, runReviewCorpus } from "../src/review/index.ts";

const dirs: string[] = [];
const fixtureDir = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("W3 review eval corpus", () => {
	it("runs 5 clean + 5 seeded diffs against two reviewer families and enforces smoke thresholds", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "codeteam-review-corpus-"));
		dirs.push(rootDir);
		const dataDir = join(rootDir, "data");
		mkdirSync(dataDir, { recursive: true });
		const corpus = JSON.parse(
			readFileSync(join(fixtureDir, "fixtures", "review-corpus", "cases.json"), "utf8"),
		) as ReviewCorpus;

		const metrics = await runReviewCorpus({
			corpus,
			rootDir,
			createPolicy: (worktreeRoot, evidenceRoot) =>
				createToolPolicy({ role: "verifier", dataDir, worktreeRoot, evidenceRoot }),
		});

		// Captured for docs/reports/2026-10-28-w3-review-evidence.md.
		console.log("W3_REVIEW_CORPUS_METRICS", JSON.stringify(metrics));

		expect(metrics.cases).toBe(10);
		expect(metrics.cleanCases).toBe(5);
		expect(metrics.seededCases).toBe(5);
		expect(Object.keys(metrics.families).sort()).toEqual(["glm", "qwen"]);
		expect(metrics.syntheticObservations).toBe(true);
		expect(metrics.thresholdPass).toBe(true);

		expect(metrics.overall.cleanFpRate).toBeLessThanOrEqual(corpus.thresholds.cleanFpMax);
		expect(metrics.overall.seededRecall).toBeGreaterThanOrEqual(corpus.thresholds.seededRecallMin);
		expect(metrics.overall.survival).toBeGreaterThanOrEqual(corpus.thresholds.survivalMin);
		expect(metrics.overall.cleanFalsePositives).toBe(1);
		expect(metrics.overall.seededDetected).toBe(9);
		expect(metrics.overall.confirmed).toBe(10);
		expect(metrics.overall.rejected).toBe(1);
		expect(metrics.overall.seededConfirmed).toBe(9);
		expect(metrics.overall.seededRejected).toBe(1);
		expect(metrics.overall.blocked).toBe(0);
		expect(metrics.overall.survival).toBeCloseTo(0.9, 6);

		expect(metrics.families.glm!.cleanFpRate).toBeCloseTo(0.2, 6);
		expect(metrics.families.glm!.seededRecall).toBe(1);
		expect(metrics.families.glm!.seededConfirmed).toBe(5);
		expect(metrics.families.glm!.seededRejected).toBe(0);
		expect(metrics.families.glm!.survival).toBe(1);
		expect(metrics.families.qwen!.cleanFpRate).toBe(0);
		expect(metrics.families.qwen!.seededRecall).toBeCloseTo(0.8, 6);
		expect(metrics.families.qwen!.seededConfirmed).toBe(4);
		expect(metrics.families.qwen!.seededRejected).toBe(1);
		expect(metrics.families.qwen!.survival).toBeCloseTo(0.8, 6);
	});

	it("rejects corpus ids and file keys that escape the fixture root", async () => {
		const corpus = JSON.parse(
			readFileSync(join(fixtureDir, "fixtures", "review-corpus", "cases.json"), "utf8"),
		) as ReviewCorpus;
		const rootDir = mkdtempSync(join(tmpdir(), "codeteam-review-corpus-bad-"));
		dirs.push(rootDir);
		const createPolicy = () => {
			throw new Error("policy should not be created for an invalid corpus");
		};
		await expect(
			runReviewCorpus({
				corpus: { ...corpus, cases: [{ ...corpus.cases[0]!, id: "../../escape" }, ...corpus.cases.slice(1)] },
				rootDir,
				createPolicy,
			}),
		).rejects.toThrow(/invalid corpus case id/i);
		await expect(
			runReviewCorpus({
				corpus: {
					...corpus,
					cases: [{ ...corpus.cases[0]!, files: { "../../escape": "x" } }, ...corpus.cases.slice(1)],
				},
				rootDir,
				createPolicy,
			}),
		).rejects.toThrow(/traverse/i);
		await expect(
			runReviewCorpus({
				corpus: {
					...corpus,
					cases: [
						{ ...corpus.cases[0]!, observations: [corpus.cases[0]!.observations[0]!] },
						...corpus.cases.slice(1),
					],
				},
				rootDir,
				createPolicy,
			}),
		).rejects.toThrow(/cover every declared family/i);
		await expect(
			runReviewCorpus({
				corpus: {
					...corpus,
					cases: [
						{
							...corpus.cases[0]!,
							observations: [
								{ ...corpus.cases[0]!.observations[0]!, reviewerModel: "qwen-fixture" },
								corpus.cases[0]!.observations[1]!,
							],
						},
						...corpus.cases.slice(1),
					],
				},
				rootDir,
				createPolicy,
			}),
		).rejects.toThrow(/belongs to family/i);
	});
});
