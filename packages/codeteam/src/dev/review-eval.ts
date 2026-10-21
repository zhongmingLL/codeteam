import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createCodeteamSession } from "../adapters/pi-session.ts";
import {
	type CaseScore,
	type CorpusManifest,
	type CorpusSample,
	type ReviewCaseKind,
	type ReviewCaseOutcome,
	scoreCase,
	summarize,
} from "../eval/scoring.ts";
import { parseReviewVerdict } from "../review/parser.ts";
import { buildReviewPrompt } from "../review/prompt.ts";
import type { ReviewVerdict } from "../review/types.ts";
import { verifyVerdict } from "../verifier/runner.ts";
import { configureAllAuth, findConfig, loadModelConfigs, readProvider, selectModel } from "./provider-config.ts";

interface PreparedCase {
	sampleId: string;
	kind: ReviewCaseKind;
	workdir: string;
	agentDir: string;
	diff: string;
	testExitCode: number;
	testReport: string;
	redTestExitCode: number;
	valid: boolean;
	problems: string[];
}

interface ReviewRun {
	verdict?: ReviewVerdict;
	verdictValid: boolean;
	rawText: string;
	modelError: string;
	promptError: string;
	toolCalls: string[];
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
}

const CASE_KINDS: readonly ReviewCaseKind[] = ["clean", "bug"];
const REVIEW_CONSTRAINTS = [
	"The test file must not be modified.",
	"Do not raise a finding solely because the diff lacks tests; test coverage is tracked separately.",
	"The project tests may be green even when the change is wrong; inspect the changed source.",
	"Executable falsifiers must use one of: grep, rg, diff, ls, cat, or `node --test <file>`. `node -e` and `node <script>` are blocked by the verifier.",
	'For a source defect, cite the exact line in the claim and prefer a static_check falsifier that greps that line, with falsifierExpected "zero".',
	"Return only the JSON object described above.",
];

function overlay(source: string, target: string): void {
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		const sourcePath = join(source, entry.name);
		const targetPath = join(target, entry.name);
		if (entry.isDirectory()) {
			mkdirSync(targetPath, { recursive: true });
			overlay(sourcePath, targetPath);
			continue;
		}
		cpSync(sourcePath, targetPath);
	}
}

function runNodeTest(cwd: string): { exitCode: number; outputTail: string } {
	const result = spawnSync("node", ["--test"], {
		cwd,
		encoding: "utf8",
		timeout: 60_000,
		maxBuffer: 16_000_000,
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\r?\n/).slice(-40).join("\n");
	return { exitCode: result.status ?? 1, outputTail: output };
}

function makeDiff(baseDir: string, workdir: string): string {
	const result = spawnSync("git", ["diff", "--no-index", "--no-color", "--", baseDir, workdir], {
		encoding: "utf8",
		maxBuffer: 16_000_000,
	});
	const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	return raw
		.replaceAll(`a${baseDir}`, "a")
		.replaceAll(`b${workdir}`, "b")
		.replaceAll(baseDir, "a")
		.replaceAll(workdir, "b")
		.trim();
}

function prepareCase(corpusRoot: string, sample: CorpusSample, kind: ReviewCaseKind): PreparedCase {
	const workRoot = mkdtempSync(join(tmpdir(), `codeteam-eval-work-${sample.id}-${kind}-`));
	const artifactRoot = mkdtempSync(join(tmpdir(), `codeteam-eval-ref-${sample.id}-${kind}-`));
	const baseDir = join(artifactRoot, "base");
	const redDir = join(artifactRoot, "red");
	const workdir = join(workRoot, "work");
	const agentDir = join(workRoot, "agent");
	mkdirSync(baseDir, { recursive: true });
	mkdirSync(workdir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	cpSync(join(corpusRoot, sample.base), baseDir, { recursive: true });
	cpSync(baseDir, workdir, { recursive: true });
	overlay(join(corpusRoot, sample.variants[kind]), workdir);
	const test = runNodeTest(workdir);
	cpSync(workdir, redDir, { recursive: true });
	cpSync(join(corpusRoot, sample.groundTruth.redTest), join(redDir, "red-test.mjs"));
	const red = spawnSync("node", ["red-test.mjs"], {
		cwd: redDir,
		encoding: "utf8",
		timeout: 60_000,
		maxBuffer: 16_000_000,
	});
	const redTestExitCode = red.status ?? 1;
	const diff = makeDiff(baseDir, workdir);
	const problems: string[] = [];
	if (test.exitCode !== 0) problems.push(`project tests failed on ${kind}: exit ${test.exitCode}`);
	if (kind === "clean" && redTestExitCode !== 0) problems.push(`red test failed on clean: exit ${redTestExitCode}`);
	if (kind === "bug" && redTestExitCode === 0) problems.push("red test passed on bug");
	if (diff.length === 0) problems.push(`diff is empty on ${kind}`);
	return {
		sampleId: sample.id,
		kind,
		workdir,
		agentDir,
		diff,
		testExitCode: test.exitCode,
		testReport: test.outputTail,
		redTestExitCode,
		valid: problems.length === 0,
		problems,
	};
}

function sumUsage(session: AgentSession): { inputTokens: number; outputTokens: number; costUsd: number } {
	let inputTokens = 0;
	let outputTokens = 0;
	let costUsd = 0;
	for (const entry of session.sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		inputTokens += message.usage.input;
		outputTokens += message.usage.output;
		costUsd += message.usage.cost.total;
	}
	return { inputTokens, outputTokens, costUsd };
}

async function runReviewer(input: {
	workdir: string;
	agentDir: string;
	model: Model<Api>;
	modelRuntime: ModelRuntime;
	diff: string;
	testReport: string;
}): Promise<ReviewRun> {
	const session = await createCodeteamSession({
		role: "reviewer",
		cwd: input.workdir,
		agentDir: input.agentDir,
		model: input.model,
		modelRuntime: input.modelRuntime,
	});
	const toolCalls: string[] = [];
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			toolCalls.push(`${event.toolName} ${JSON.stringify(event.args)}`);
		}
	});
	let promptError = "";
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		void session.abort();
	}, 180_000);
	try {
		await session.prompt(
			buildReviewPrompt({
				diff: input.diff,
				testReport: input.testReport,
				constraints: REVIEW_CONSTRAINTS,
			}),
		);
	} catch (error) {
		promptError = error instanceof Error ? error.message : String(error);
	} finally {
		clearTimeout(timer);
		unsubscribe();
	}
	const rawText = session.getLastAssistantText() ?? "";
	const modelError = session.agent.state.errorMessage ?? "";
	let verdict: ReviewVerdict | undefined;
	let verdictValid = false;
	if (rawText.trim().length > 0) {
		try {
			verdict = parseReviewVerdict(rawText);
			verdictValid = true;
		} catch {
			verdictValid = false;
		}
	}
	const usage = sumUsage(session);
	session.dispose();
	return {
		...(verdict === undefined ? {} : { verdict }),
		verdictValid,
		rawText: rawText.slice(0, 4_000),
		modelError: timedOut ? `${modelError} (timed out)` : modelError,
		promptError,
		toolCalls,
		...usage,
	};
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const checkOnly = args.includes("--check");
	const limitArg = args.find((arg) => arg.startsWith("--limit="));
	const limit = limitArg === undefined ? undefined : Number(limitArg.slice("--limit=".length));
	if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
		throw new Error(`invalid --limit value: ${limitArg}`);
	}

	const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
	const corpusRoot = join(repoRoot, "fixtures/review-corpus");
	const manifest = JSON.parse(readFileSync(join(corpusRoot, "manifest.json"), "utf8")) as CorpusManifest;
	const samples = limit === undefined ? manifest.samples : manifest.samples.slice(0, limit);
	const sampleById = new Map(samples.map((sample) => [sample.id, sample]));

	const prepared: PreparedCase[] = [];
	for (const sample of samples) {
		for (const kind of CASE_KINDS) {
			prepared.push(prepareCase(corpusRoot, sample, kind));
		}
	}

	let invalid = 0;
	for (const entry of prepared) {
		console.log(
			`${entry.sampleId} ${entry.kind}: test=${entry.testExitCode} red=${entry.redTestExitCode} diff=${entry.diff.length} bytes ${entry.valid ? "ok" : "INVALID"}`,
		);
		for (const problem of entry.problems) {
			console.log(`  - ${problem}`);
			invalid += 1;
		}
	}
	if (invalid > 0) {
		throw new Error(`corpus check failed with ${invalid} problem(s)`);
	}
	console.log(`corpus check passed: ${prepared.length} cases`);
	if (checkOnly) return;

	const configs = loadModelConfigs("/home/ming/.env");
	configureAllAuth(configs);
	const reviewerProvider = readProvider("CODETEAM_EVAL_REVIEWER", "kimi");
	const reviewerConfig = findConfig(configs, reviewerProvider);
	const runtimeAgentDir = mkdtempSync(join(tmpdir(), "codeteam-eval-runtime-"));
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		authPath: join(runtimeAgentDir, "auth.json"),
	});
	const reviewerModel = selectModel(runtime, reviewerProvider, reviewerConfig);

	const outcomes: ReviewCaseOutcome[] = [];
	const scores: CaseScore[] = [];
	for (const entry of prepared) {
		const run = await runReviewer({
			workdir: entry.workdir,
			agentDir: entry.agentDir,
			model: reviewerModel.model,
			modelRuntime: runtime,
			diff: entry.diff,
			testReport: entry.testReport,
		});
		const sample = sampleById.get(entry.sampleId);
		if (sample === undefined) throw new Error(`missing sample ${entry.sampleId}`);
		const verdict = run.verdict ?? { verdict: "blocked" as const, findings: [] };
		const verifications =
			run.verdict === undefined ? [] : verifyVerdict(run.verdict, { workdir: entry.workdir, mode: "repro" });
		const outcome: ReviewCaseOutcome = {
			sampleId: entry.sampleId,
			kind: entry.kind,
			verdict,
			verdictValid: run.verdictValid,
			verifications,
			reviewRounds: 1,
			inputTokens: run.inputTokens,
			outputTokens: run.outputTokens,
			costUsd: run.costUsd,
			rawText: run.rawText,
			modelError: run.modelError,
			promptError: run.promptError,
		};
		const score = scoreCase(outcome, sample.groundTruth);
		outcomes.push(outcome);
		scores.push(score);
		const label =
			entry.kind === "clean"
				? score.falsePositive
					? "FALSE_POSITIVE"
					: "clean-ok"
				: score.recallHit
					? score.findingSurvived
						? "recall-hit+survived"
						: "recall-hit"
					: "recall-miss";
		console.log(
			`${entry.sampleId} ${entry.kind}: verdict=${verdict.verdict} findings=${verdict.findings.length} valid=${run.verdictValid} ${label}`,
		);
		if (run.modelError.length > 0) console.log(`  model error: ${run.modelError}`);
		if (run.promptError.length > 0) console.log(`  prompt error: ${run.promptError}`);
	}

	const summary = summarize(outcomes, scores, manifest.thresholds);
	const resultPath = join(tmpdir(), `codeteam-phase2-${Date.now()}.json`);
	writeFileSync(
		resultPath,
		`${JSON.stringify({ reviewer: reviewerModel.label, thresholds: manifest.thresholds, outcomes, scores, summary }, null, 2)}\n`,
	);
	console.log(JSON.stringify(summary, null, 2));
	console.log(`result: ${resultPath}`);
	if (!summary.passed) process.exitCode = 1;
}

await main();
