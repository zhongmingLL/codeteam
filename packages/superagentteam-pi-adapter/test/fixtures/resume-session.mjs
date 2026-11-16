import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { compileL0, createAgentSessionWithL0 } from "../../dist/index.js";

const [sessionFile, cwd, agentDir, l0Path] = process.argv.slice(2);
if (!sessionFile || !cwd || !agentDir || !l0Path) throw new Error("missing fixture argument");

const compiled = compileL0(JSON.parse(readFileSync(l0Path, "utf8")));
const sessionManager = SessionManager.open(sessionFile, dirname(sessionFile), cwd);
const { session, l0Revision } = await createAgentSessionWithL0({
	cwd,
	agentDir,
	compiledL0: compiled,
	model: getModel("anthropic", "claude-sonnet-4-5"),
	sessionManager,
	settingsManager: SettingsManager.inMemory({
		compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 },
	}),
	tools: [],
});

try {
	session.agent.streamFunction = () => {
		const stream = createAssistantMessageEventStream();
		stream.end({
			role: "assistant",
			content: [{ type: "text", text: "resumed" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: session.model?.id ?? "claude-sonnet-4-5",
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
		});
		return stream;
	};
	await session.prompt("continue after resume");
	const historyContainsParent = session.messages.some(
		(message) => message.role === "user" && JSON.stringify(message.content).includes("remember this session"),
	);
	console.log(
		JSON.stringify({
			messageCount: session.messages.length,
			systemPromptIncludesL0: session.systemPrompt.includes(compiled.text),
			l0Revision,
			model: session.model?.id,
			thinkingLevel: session.thinkingLevel,
			continued: session.getLastAssistantText() === "resumed",
			historyContainsParent,
		}),
	);
} finally {
	session.dispose();
}
