import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getSystemMessageText,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CompiledL0, compileL0, createAgentSessionWithL0 } from "../src/index.ts";

interface CapturedRequest {
	summary: boolean;
	system: string;
}

function systemText(context: TranscriptContext): string {
	const systemMessage = context.messages.find((message) => message.role === "system");
	return systemMessage ? getSystemMessageText(systemMessage) : "";
}

function assistantMessage(model: string, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function fakeStream(captures: CapturedRequest[]) {
	return (requestModel: { id: string }, context: TranscriptContext) => {
		const system = systemText(context);
		const summary = system.includes("You are a context summarization assistant");
		captures.push({ summary, system });
		const stream = createAssistantMessageEventStream();
		stream.end(assistantMessage(requestModel.id, summary ? "Compacted summary." : "ok"));
		return stream;
	};
}

describe("L0 session compaction", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	let compiled: CompiledL0;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "codeteam-session-"));
		cwd = join(root, "work");
		agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test" } }));
		compiled = compileL0({ role: "coder", sections: [{ id: "task", body: "Keep this task capsule." }] });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps compiled L0 in the first request after manual compaction", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const captures: CapturedRequest[] = [];
		const { session, l0Revision } = await createAgentSessionWithL0({
			cwd,
			agentDir,
			compiledL0: compiled,
			model,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
			}),
			tools: [],
		});
		session.agent.streamFunction = fakeStream(captures) as typeof session.agent.streamFunction;

		try {
			await session.prompt("first");
			await session.prompt("second");
			expect(l0Revision).toBe(compiled.revision);
			expect(session.systemPrompt).toContain(compiled.text);
			await session.compact();

			captures.length = 0;
			await session.prompt("after compaction");
			const normal = captures.find((capture) => !capture.summary);
			if (!normal) throw new Error("no normal request captured after compaction");
			expect(normal.system).toContain(compiled.text);
			expect(normal.system).toBe(session.systemPrompt);
		} finally {
			session.dispose();
		}
	});

	it("keeps compiled L0 when the context threshold auto-compacts", async () => {
		const model = { ...getModel("anthropic", "claude-sonnet-4-5")!, contextWindow: 200, maxTokens: 20 };
		const captures: CapturedRequest[] = [];
		const compactionReasons: string[] = [];
		const { session } = await createAgentSessionWithL0({
			cwd,
			agentDir,
			compiledL0: compiled,
			model,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
			}),
			tools: [],
		});
		session.agent.streamFunction = fakeStream(captures) as typeof session.agent.streamFunction;
		session.subscribe((event) => {
			if (event.type === "compaction_start") compactionReasons.push(event.reason);
		});

		try {
			for (let index = 0; index < 6; index++) {
				await session.prompt(`message ${index}`);
			}
			expect(compactionReasons.some((reason) => reason !== "manual")).toBe(true);
			const normal = [...captures].reverse().find((capture) => !capture.summary);
			if (!normal) throw new Error("no normal request captured after auto-compaction");
			expect(normal.system).toContain(compiled.text);
			expect(normal.system).toBe(session.systemPrompt);
		} finally {
			session.dispose();
		}
	});

	it("resumes an exported JSONL session in a separate process with L0 intact", async () => {
		const sessionDir = join(root, "sessions");
		const sessionManager = SessionManager.create(cwd, sessionDir);
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const captures: CapturedRequest[] = [];
		const { session } = await createAgentSessionWithL0({
			cwd,
			agentDir,
			compiledL0: compiled,
			model,
			sessionManager,
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 },
			}),
			tools: [],
		});
		session.agent.streamFunction = fakeStream(captures) as typeof session.agent.streamFunction;

		try {
			await session.prompt("remember this session");
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("session file was not created");
			const expectedThinkingLevel = session.thinkingLevel;

			const l0Path = join(root, "l0.json");
			writeFileSync(
				l0Path,
				JSON.stringify({ role: "coder", sections: [{ id: "task", body: "Keep this task capsule." }] }),
			);
			const fixture = fileURLToPath(new URL("./fixtures/resume-session.mjs", import.meta.url));
			const output = execFileSync(process.execPath, [fixture, sessionFile, cwd, agentDir, l0Path], {
				encoding: "utf8",
			});
			const resumed = JSON.parse(output.trim()) as {
				messageCount: number;
				systemPromptIncludesL0: boolean;
				l0Revision: string;
				model: string | undefined;
				thinkingLevel: string;
				continued: boolean;
			};

			expect(resumed.messageCount).toBeGreaterThan(0);
			expect(resumed.systemPromptIncludesL0).toBe(true);
			expect(resumed.l0Revision).toBe(compiled.revision);
			expect(resumed.model).toBe("claude-sonnet-4-5");
			expect(resumed.thinkingLevel).toBe(expectedThinkingLevel);
			expect(resumed.continued).toBe(true);
		} finally {
			session.dispose();
		}
	});

	it("keeps the L0 system hash stable across normal requests", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const captures: CapturedRequest[] = [];
		const { session } = await createAgentSessionWithL0({
			cwd,
			agentDir,
			compiledL0: compiled,
			model,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 },
			}),
			tools: [],
		});
		session.agent.streamFunction = fakeStream(captures) as typeof session.agent.streamFunction;

		try {
			await session.prompt("one");
			await session.prompt("two");
			const normalSystems = captures.filter((capture) => !capture.summary).map((capture) => capture.system);
			const hashes = normalSystems.map((system) => createHash("sha256").update(system).digest("hex"));
			expect(hashes.length).toBeGreaterThanOrEqual(2);
			expect(new Set(hashes).size).toBe(1);
		} finally {
			session.dispose();
		}
	});
});
