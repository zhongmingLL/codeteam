import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createCodeteamSession } from "../adapters/pi-session.ts";
import { ControlPlane } from "../control-plane.ts";
import {
	type ImplementRequest,
	type ImplementResult,
	type Phase3Ports,
	type ReviewRequest,
	type ReviewResult,
	runPhase3,
	type VerifyRequest,
	type VerifyResult,
} from "../orchestrator.ts";
import { parseReviewVerdict } from "../review/parser.ts";
import { buildReviewPrompt } from "../review/prompt.ts";
import type { ReviewVerdict } from "../review/types.ts";
import { verifyVerdict } from "../verifier/runner.ts";
import {
	configureAllAuth,
	findConfig,
	loadModelConfigs,
	readProvider,
	resolveEnvFile,
	selectModel,
} from "./provider-config.ts";
import { runNodeTest, sha256 } from "./smoke-utils.ts";

interface DemoModels {
	coderProvider: ReturnType<typeof readProvider>;
	reviewerProvider: ReturnType<typeof readProvider>;
	coderModel: { model: Model<Api>; label: string };
	reviewerModel: { model: Model<Api>; label: string };
	runtime: ModelRuntime;
	agentDir: string;
}

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

function collectTools(session: AgentSession): { toolCalls: string[]; unsubscribe: () => void } {
	const toolCalls: string[] = [];
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			toolCalls.push(`${event.toolName} ${JSON.stringify(event.args)}`);
		}
	});
	return { toolCalls, unsubscribe };
}

async function loadModels(): Promise<DemoModels> {
	const configs = loadModelConfigs(resolveEnvFile());
	configureAllAuth(configs);
	const coderProvider = readProvider("CODETEAM_DEMO_CODER", "deepseek");
	const reviewerProvider = readProvider("CODETEAM_DEMO_REVIEWER", "kimi");
	const coderConfig = findConfig(configs, coderProvider);
	const reviewerConfig = findConfig(configs, reviewerProvider);
	const agentDir = mkdtempSync(join(tmpdir(), "codeteam-phase3-agent-"));
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		authPath: join(agentDir, "auth.json"),
	});
	return {
		coderProvider,
		reviewerProvider,
		coderModel: selectModel(runtime, coderProvider, coderConfig),
		reviewerModel: selectModel(runtime, reviewerProvider, reviewerConfig),
		runtime,
		agentDir,
	};
}

async function runCoderFix(
	models: DemoModels,
	request: ImplementRequest,
	initialWorkdir: string,
	initialTestHash: string,
): Promise<ImplementResult> {
	const session = await createCodeteamSession({
		role: "coder",
		cwd: request.workdir,
		agentDir: models.agentDir,
		model: models.coderModel.model,
		modelRuntime: models.runtime,
	});
	const collected = collectTools(session);
	const findings = request.findings
		.map(
			(finding, index) =>
				`${index + 1}. [${finding.severity}] ${finding.file ?? "unknown file"}${finding.line === undefined ? "" : `:${finding.line}`}\n   ${finding.claim}\n   Required: ${finding.requiredAction}`,
		)
		.join("\n");
	let promptError = "";
	const timer = setTimeout(() => void session.abort(), 180_000);
	try {
		await session.prompt(
			[
				"You are working in a small Node.js repository.",
				"Fix the defect described by the review findings. Do not modify any test file.",
				"Read the source first, make the minimal fix, then run `node --test` from the repository root.",
				"Review findings:",
				findings,
			].join("\n"),
		);
	} catch (error) {
		promptError = error instanceof Error ? error.message : String(error);
	} finally {
		clearTimeout(timer);
		collected.unsubscribe();
	}
	const modelError = session.agent.state.errorMessage ?? "";
	const test = runNodeTest(request.workdir);
	const testFileUnchanged = initialTestHash === sha256(join(request.workdir, "test/stats.test.js"));
	const diff = makeDiff(initialWorkdir, request.workdir);
	session.dispose();
	if (promptError.length > 0 || modelError.length > 0) {
		throw new Error(`coder failed: ${promptError || modelError}`);
	}
	return {
		diff,
		testReport: `${test.outputTail}\nmodel=${models.coderModel.label}`,
		testFileUnchanged,
		agentInstanceId: `coder:${models.coderProvider}:${randomUUID()}`,
	};
}

async function runReviewer(models: DemoModels, request: ReviewRequest): Promise<ReviewResult> {
	const session = await createCodeteamSession({
		role: "reviewer",
		cwd: request.workdir,
		agentDir: models.agentDir,
		model: models.reviewerModel.model,
		modelRuntime: models.runtime,
	});
	const collected = collectTools(session);
	const previous =
		request.previousFindings.length === 0
			? ""
			: `Previous findings that the fix must address:\n${request.previousFindings
					.map((finding) => `- [${finding.severity}] ${finding.file ?? "unknown"}: ${finding.claim}`)
					.join("\n")}`;
	const constraints = [
		"The test file must not be modified.",
		"Executable falsifiers must use one of: grep, rg, diff, ls, cat, or `node --test <file>`.",
		"For static_check, use `grep -F` with the exact source text quoted in single quotes.",
		"Do not use code_reading for a finding that has a shell falsifier.",
		previous,
	].filter((entry) => entry.length > 0);
	let promptError = "";
	const timer = setTimeout(() => void session.abort(), 180_000);
	try {
		await session.prompt(
			buildReviewPrompt({
				diff: request.diff,
				testReport: request.testReport,
				constraints,
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
	let verdict: ReviewVerdict;
	try {
		verdict = parseReviewVerdict(rawText);
	} catch {
		verdict = { verdict: "blocked", findings: [] };
	}
	session.dispose();
	console.log(
		`[phase3] review round ${request.iteration}: verdict=${verdict.verdict} findings=${verdict.findings.length} tools=${collected.toolCalls.length}`,
	);
	if (promptError.length > 0 || modelError.length > 0) {
		console.log(`[phase3] reviewer error: ${promptError || modelError}`);
	}
	return {
		verdict,
		agentInstanceId: `reviewer:${models.reviewerProvider}:${randomUUID()}`,
	};
}

async function main(): Promise<void> {
	const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
	const sample = join(repoRoot, "fixtures/review-corpus/samples/s01-stats-mode");
	const baseDir = join(sample, "base");
	const initialWorkdir = mkdtempSync(join(tmpdir(), "codeteam-phase3-initial-"));
	const workdir = mkdtempSync(join(tmpdir(), "codeteam-phase3-work-"));
	cpSync(baseDir, initialWorkdir, { recursive: true });
	overlay(join(sample, "bug"), initialWorkdir);
	cpSync(initialWorkdir, workdir, { recursive: true });
	const initialDiff = makeDiff(baseDir, initialWorkdir);
	const initialTest = runNodeTest(workdir);
	const initialTestHash = sha256(join(workdir, "test/stats.test.js"));
	const models = await loadModels();

	const ports: Phase3Ports = {
		implement: async (request) => {
			if (request.iteration === 0) {
				return {
					diff: initialDiff,
					testReport: `${initialTest.outputTail}\nseeded bug: s01-stats-mode`,
					testFileUnchanged: true,
					agentInstanceId: "seed:author",
				};
			}
			console.log(`[phase3] coder fix iteration ${request.iteration}`);
			return runCoderFix(models, request, initialWorkdir, initialTestHash);
		},
		review: async (request) => runReviewer(models, request),
		verify: async (request: VerifyRequest): Promise<VerifyResult> => ({
			verifications: verifyVerdict(
				{ verdict: "changes_requested", findings: request.findings },
				{ workdir: request.workdir, mode: "repro" },
			),
		}),
	};

	const plane = new ControlPlane({ defaultDeadlineMs: 30 * 60_000, loopLimit: 10 });
	const taskId = `phase3-demo-${Date.now()}`;
	const result = await runPhase3({
		taskId,
		objective: "Fix the seeded mode() bug without modifying tests.",
		initialWorkdir,
		workdir,
		plane,
		ports,
	});

	const resultPath = join(tmpdir(), `codeteam-phase3-${Date.now()}.json`);
	const summary = {
		taskId,
		coder: models.coderModel.label,
		reviewer: models.reviewerModel.label,
		outcome: result.outcome,
		rounds: result.rounds,
		task: result.task,
		findings: result.findings,
		closures: result.closures,
		initialVerifications: result.initialVerifications.map((entry) => ({
			index: entry.audit.index,
			status: entry.status,
			command: entry.audit.command,
		})),
		finalVerifications: result.finalVerifications.map((entry) => ({
			index: entry.audit.index,
			status: entry.status,
			command: entry.audit.command,
		})),
		handoffs: plane.listHandoffs(taskId).map((handoff) => ({
			id: handoff.id,
			kind: handoff.kind,
			fromRole: handoff.fromRole,
			toRole: handoff.toRole,
			status: handoff.status,
			expectedArtifact: handoff.expectedArtifact,
		})),
		mergeHandoff: result.mergeHandoff?.id,
		blockerHandoff: result.blockerHandoff?.id,
		authorInstanceId: result.authorInstanceId,
		reviewerInstanceId: result.reviewerInstanceId,
		workdirs: { initialWorkdir, workdir },
		resultPath,
	};
	writeFileSync(resultPath, `${JSON.stringify(summary, null, 2)}\n`);
	console.log(JSON.stringify(summary, null, 2));

	const blockingFindings = result.findings.filter((finding) => finding.severity === "P1" || finding.severity === "P2");
	if (result.outcome !== "awaiting_merge" || blockingFindings.length === 0) {
		console.log("[phase3] demo did not reach the merge gate with a blocking finding");
		process.exitCode = 1;
	}
}

await main();
