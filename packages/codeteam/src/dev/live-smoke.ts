import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createCodeteamSession } from "../adapters/pi-session.ts";
import {
	configureAllAuth,
	findConfig,
	loadModelConfigs,
	readProvider,
	type SmokeProvider,
	selectModel,
} from "./provider-config.ts";
import { copySmokeFixture, runNodeTest, sha256 } from "./smoke-utils.ts";

interface SmokeResult {
	provider: SmokeProvider;
	model: string;
	success: boolean;
	timedOut: boolean;
	testExitCode: number;
	testFileUnchanged: boolean;
	modelError: string;
	promptError: string;
	toolCalls: string[];
	lastAssistantText: string;
	testOutputTail: string;
	workdir: string;
	resultPath: string;
}

async function main(): Promise<void> {
	const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
	const provider = readProvider("CODETEAM_SMOKE_PROVIDER", "deepseek");
	const configs = loadModelConfigs("/home/ming/.env");
	configureAllAuth(configs);
	const config = findConfig(configs, provider);
	const fixture = join(repoRoot, "fixtures/smoke-bug-01");
	const { workdir, agentDir } = copySmokeFixture(fixture);
	const testFile = join(workdir, "test/math.test.js");
	const beforeHash = sha256(testFile);
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		authPath: join(agentDir, "auth.json"),
	});
	const selected = selectModel(runtime, provider, config);
	const session = await createCodeteamSession({
		role: "coder",
		cwd: workdir,
		agentDir,
		model: selected.model,
		modelRuntime: runtime,
	});

	const toolCalls: string[] = [];
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			toolCalls.push(`${event.toolName} ${JSON.stringify(event.args)}`);
		}
		if (event.type === "tool_execution_end" && event.isError) {
			toolCalls.push(`${event.toolName} ERROR`);
		}
	});

	let timedOut = false;
	let promptError = "";
	const timer = setTimeout(() => {
		timedOut = true;
		void session.abort();
	}, 180_000);
	try {
		await session.prompt(
			[
				"You are working in a small Node.js repository.",
				"The failing test is in test/math.test.js. Do not modify the test file.",
				"Read src/math.js and test/math.test.js, fix the bug in src/math.js, then run `node --test` from the repository root.",
				"Report the exact command and result. Stop once the test passes.",
			].join(" "),
		);
	} catch (error) {
		promptError = error instanceof Error ? error.message : String(error);
	} finally {
		clearTimeout(timer);
		unsubscribe();
	}

	const testRun = runNodeTest(workdir);
	const afterHash = sha256(testFile);
	const modelError = session.agent.state.errorMessage ?? "";
	const resultPath = join(tmpdir(), `codeteam-smoke-${Date.now()}.json`);
	const result: SmokeResult = {
		provider,
		model: selected.label,
		success: testRun.exitCode === 0 && beforeHash === afterHash && !timedOut && promptError.length === 0,
		timedOut,
		testExitCode: testRun.exitCode,
		testFileUnchanged: beforeHash === afterHash,
		modelError,
		promptError,
		toolCalls,
		lastAssistantText: (session.getLastAssistantText() ?? "").slice(0, 4_000),
		testOutputTail: testRun.outputTail,
		workdir,
		resultPath,
	};
	session.dispose();
	writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
	console.log(JSON.stringify(result, null, 2));
}

await main();
