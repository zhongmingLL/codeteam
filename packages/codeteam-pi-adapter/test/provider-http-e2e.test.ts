import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileL0, createAgentSessionWithL0 } from "../src/index.ts";

function sse(events: Array<{ event: string; data: unknown }>): string {
	return `${events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")}`;
}

function anthropicStream(text: string): string {
	return sse([
		{
			event: "message_start",
			data: {
				type: "message_start",
				message: {
					id: "msg_e2e",
					type: "message",
					role: "assistant",
					model: "claude-sonnet-4-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 11, output_tokens: 1 },
				},
			},
		},
		{
			event: "content_block_start",
			data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		},
		{
			event: "content_block_delta",
			data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		},
		{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
		{
			event: "message_delta",
			data: {
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 4 },
			},
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	]);
}

describe("provider HTTP end-to-end", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	let server: Server;
	let baseUrl: string;
	const requests: Array<Record<string, unknown>> = [];

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "codeteam-provider-e2e-"));
		cwd = join(root, "work");
		agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test" } }), {
			mode: 0o600,
		});

		server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				try {
					requests.push(JSON.parse(body) as Record<string, unknown>);
				} catch {
					requests.push({ raw: body });
				}
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(anthropicStream("E2E_OK"));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (typeof address !== "object" || address === null) throw new Error("no port");
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	});

	it("sends L0 through the real provider HTTP path and consumes the streamed reply", async () => {
		const compiled = compileL0({ role: "coder", sections: [{ id: "task", body: "E2E task capsule." }] });
		const model = { ...getModel("anthropic", "claude-sonnet-4-5")!, baseUrl };
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

		try {
			await session.prompt("ping over http");
			expect(session.getLastAssistantText()).toBe("E2E_OK");
			expect(requests).toHaveLength(1);
			const body = requests[0]!;
			const systemText = Array.isArray(body.system)
				? (body.system as Array<{ text?: string }>).map((block) => block.text ?? "").join("")
				: String(body.system);
			expect(systemText).toContain(compiled.text);
			expect(JSON.stringify(body.messages)).toContain("ping over http");
			expect(body.stream).toBe(true);
		} finally {
			session.dispose();
		}
	});
});
