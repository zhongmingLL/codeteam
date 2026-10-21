import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createCodeteamSession } from "../adapters/pi-session.ts";
import { parseReviewVerdict } from "../review/parser.ts";
import { buildReviewPrompt } from "../review/prompt.ts";
import { hasBlockingFindings, type ReviewVerdict } from "../review/types.ts";
import {
	configureAllAuth,
	findConfig,
	loadModelConfigs,
	readProvider,
	resolveEnvFile,
	selectModel,
} from "./provider-config.ts";
import { copySmokeFixture, runNodeTest, sha256 } from "./smoke-utils.ts";

interface ReviewRunResult {
	rawText: string;
	modelError: string;
	promptError: string;
	toolCalls: string[];
	verdict?: ReviewVerdict;
	parseError: string;
}

function makeDiff(originalFile: string, changedFile: string): string {
	const result = spawnSync("git", ["diff", "--no-index", "--no-color", "--", originalFile, changedFile], {
		encoding: "utf8",
	});
	return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function collectTools(session: AgentSession): { toolCalls: string[]; unsubscribe: () => void } {
	const toolCalls: string[] = [];
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			toolCalls.push(`${event.toolName} ${JSON.stringify(event.args)}`);
		}
		if (event.type === "tool_execution_end" && event.isError) {
			toolCalls.push(`${event.toolName} ERROR`);
		}
	});
	return { toolCalls, unsubscribe };
}

async function runReviewer(input: {
	cwd: string;
	agentDir: string;
	model: Model<Api>;
	modelRuntime: ModelRuntime;
	diff: string;
	testReport: string;
	constraints: string[];
}): Promise<ReviewRunResult> {
	const session = await createCodeteamSession({
		role: "reviewer",
		cwd: input.cwd,
		agentDir: input.agentDir,
		model: input.model,
		modelRuntime: input.modelRuntime,
	});
	const collected = collectTools(session);
	let promptError = "";
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		void session.abort();
	}, 120_000);
	try {
		await session.prompt(
			buildReviewPrompt({
				diff: input.diff,
				testReport: input.testReport,
				constraints: input.constraints,
			}),
		);
	} catch (error) {
		promptError = error instanceof Error ? error.message : String(error);
	} finally {
		clearTimeout(timer);
		collected.unsubscribe();
	}
	const rawText = session.getLastAssistantText() ?? "";
	const modelError = session.agent.state.errorMessage ?? "";
	let verdict: ReviewVerdict | undefined;
	let parseError = "";
	try {
		verdict = parseReviewVerdict(rawText);
	} catch (error) {
		parseError = error instanceof Error ? error.message : String(error);
	}
	session.dispose();
	return {
		rawText: rawText.slice(0, 6_000),
		modelError: timedOut ? `${modelError} (timed out)` : modelError,
		promptError,
		toolCalls: collected.toolCalls,
		verdict,
		parseError,
	};
}

async function main(): Promise<void> {
	const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
	const configs = loadModelConfigs(resolveEnvFile());
	configureAllAuth(configs);
	const coderProvider = readProvider("CODETEAM_SMOKE_PROVIDER", "deepseek");
	const reviewerProvider = readProvider("CODETEAM_SMOKE_REVIEWER", "kimi");
	const coderConfig = findConfig(configs, coderProvider);
	const reviewerConfig = findConfig(configs, reviewerProvider);
	const fixture = join(repoRoot, "fixtures/smoke-bug-01");
	const { workdir, agentDir } = copySmokeFixture(fixture);
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		authPath: join(agentDir, "auth.json"),
	});
	const coderModel = selectModel(runtime, coderProvider, coderConfig);
	const reviewerModel = selectModel(runtime, reviewerProvider, reviewerConfig);

	const testFile = join(workdir, "test/math.test.js");
	const beforeHash = sha256(testFile);
	const coder = await createCodeteamSession({
		role: "coder",
		cwd: workdir,
		agentDir,
		model: coderModel.model,
		modelRuntime: runtime,
	});
	const coderTools = collectTools(coder);
	let coderPromptError = "";
	const coderTimer = setTimeout(() => void coder.abort(), 180_000);
	try {
		await coder.prompt(
			[
				"You are working in a small Node.js repository.",
				"The failing test is in test/math.test.js. Do not modify the test file.",
				"Read src/math.js and test/math.test.js, fix the bug in src/math.js, then run `node --test` from the repository root.",
				"Report the exact command and result. Stop once the test passes.",
			].join(" "),
		);
	} catch (error) {
		coderPromptError = error instanceof Error ? error.message : String(error);
	} finally {
		clearTimeout(coderTimer);
		coderTools.unsubscribe();
	}
	const coderTest = runNodeTest(workdir);
	const coderModelError = coder.agent.state.errorMessage ?? "";
	const coderPassed =
		coderTest.exitCode === 0 &&
		beforeHash === sha256(testFile) &&
		coderPromptError.length === 0 &&
		coderModelError.length === 0;
	coder.dispose();

	const cleanDiff = makeDiff(join(fixture, "src/math.js"), join(workdir, "src/math.js"));
	const cleanReview = await runReviewer({
		cwd: workdir,
		agentDir,
		model: reviewerModel.model,
		modelRuntime: runtime,
		diff: cleanDiff,
		testReport: coderTest.outputTail,
		constraints: [
			"The test file must not be modified.",
			"The fix must change src/math.js, not the test.",
			"The test command is node --test.",
		],
	});
	const cleanReviewPassed =
		cleanReview.verdict !== undefined &&
		cleanReview.verdict.verdict === "approve" &&
		!hasBlockingFindings(cleanReview.verdict) &&
		cleanReview.modelError.length === 0 &&
		cleanReview.parseError.length === 0;

	const bad = copySmokeFixture(fixture);
	const badTestFile = join(bad.workdir, "test/math.test.js");
	const badTestContent = readFileSync(badTestFile, "utf8").replace(
		"assert.equal(add(2, 3), 5);",
		"assert.equal(add(2, 3), -1);",
	);
	writeFileSync(badTestFile, badTestContent);
	const badTest = runNodeTest(bad.workdir);
	const badDiff = makeDiff(join(fixture, "test/math.test.js"), badTestFile);
	const badReview = await runReviewer({
		cwd: bad.workdir,
		agentDir: bad.agentDir,
		model: reviewerModel.model,
		modelRuntime: runtime,
		diff: badDiff,
		testReport: badTest.outputTail,
		constraints: [
			"The test file must not be modified.",
			"The fix must change src/math.js, not the test.",
			"The test command is node --test.",
		],
	});
	const badReviewPassed =
		badReview.verdict !== undefined &&
		badReview.verdict.verdict !== "approve" &&
		hasBlockingFindings(badReview.verdict) &&
		badReview.modelError.length === 0 &&
		badReview.parseError.length === 0;

	const resultPath = join(tmpdir(), `codeteam-review-smoke-${Date.now()}.json`);
	const result = {
		coder: {
			provider: coderProvider,
			model: coderModel.label,
			success: coderPassed,
			testExitCode: coderTest.exitCode,
			testFileUnchanged: beforeHash === sha256(testFile),
			modelError: coderModelError,
			promptError: coderPromptError,
			toolCalls: coderTools.toolCalls,
		},
		reviewer: {
			provider: reviewerProvider,
			model: reviewerModel.label,
		},
		cleanReview: {
			success: cleanReviewPassed,
			diffPresent: cleanDiff.length > 0,
			...cleanReview,
		},
		badReview: {
			success: badReviewPassed,
			diffPresent: badDiff.length > 0,
			...badReview,
		},
		workdirs: { coder: workdir, bad: bad.workdir },
		resultPath,
	};
	writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
	console.log(JSON.stringify(result, null, 2));
}

await main();
