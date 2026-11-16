#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const argvFile = process.env.FAKE_ARGV_FILE;
if (argvFile) appendFileSync(argvFile, `${JSON.stringify(process.argv.slice(2))}\n`);

const sessionId = process.env.FAKE_SESSION_ID ?? "fake-session";
const sessionFile = process.env.FAKE_SESSION_FILE ?? null;
const crashOnPrompt = Number(process.env.FAKE_WORKER_CRASH_ON_PROMPT ?? "0");
const crashAfter = Number(process.env.FAKE_WORKER_CRASH_AFTER ?? "0");
const hangOnPrompt = process.env.FAKE_WORKER_HANG_ON_PROMPT === "1";
const delayMs = Number(process.env.FAKE_WORKER_DELAY_MS ?? "0");
let promptCount = 0;
let aborted = false;

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
	if (line.trim() === "") return;
	let command;
	try {
		command = JSON.parse(line);
	} catch {
		process.stderr.write("fake worker: invalid JSON\n");
		return;
	}
	if (command.type === "get_state") {
		respond(command.id, "get_state", { sessionId, sessionFile, messageCount: promptCount });
		return;
	}
	if (command.type === "abort") {
		aborted = true;
		respond(command.id, "abort", undefined);
		emit({ type: "agent_settled", aborted: true });
		return;
	}
	if (command.type !== "prompt") {
		respondError(command.id, command.type, "unsupported command");
		return;
	}
	promptCount += 1;
	respond(command.id, "prompt", { disposition: "started" });
	if (crashOnPrompt > 0 || (crashAfter > 0 && promptCount >= crashAfter)) {
		process.exit(7);
	}
	if (hangOnPrompt) return;
	const finishPrompt = () => {
		const tokenHash = hashToken(process.env.CODETEAM_TOKEN_FILE);
		emit({
			type: "tool_execution_start",
			toolCallId: `fake-tool-${promptCount}`,
			toolName: "read",
			args: { path: "README.md" },
		});
		emit({
			type: "tool_execution_end",
			toolCallId: `fake-tool-${promptCount}`,
			toolName: "read",
			result: { content: [{ type: "text", text: "fake" }] },
			isError: false,
			durationMs: 2,
		});
		const capsule = String(command.message ?? "").includes("Continuity capsule") ? " capsule=yes" : " capsule=no";
		emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `FAKE_OK prompt=${promptCount} token=${tokenHash}${capsule}` }],
				usage: { inputTokens: 1, outputTokens: 1 },
			},
		});
		emit({ type: "agent_settled", aborted });
	};
	if (delayMs > 0) setTimeout(finishPrompt, delayMs);
	else finishPrompt();
});

function respond(id, command, data) {
	emit({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) });
}

function respondError(id, command, error) {
	emit({ id, type: "response", command, success: false, error });
}

function emit(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function hashToken(path) {
	if (!path) return "no-token";
	try {
		return createHash("sha256").update(readFileSync(path, "utf8").trim()).digest("hex").slice(0, 12);
	} catch {
		return "no-token";
	}
}
