import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, AgentCatalog, AgentConfig } from "@superagentteam/shared/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConsoleToken } from "../src/api/console-link.ts";
import { initOperatorCredential } from "../src/auth/operator.ts";
import { type DaemonHandle, startDaemon } from "../src/index.ts";
import { textResponse } from "./helpers/mock-anthropic.ts";

const HUB_ORIGIN = "http://localhost:3000";
const PI_CLI_PATH = join(import.meta.dirname, "..", "..", "coding-agent", "dist", "cli.js");

function agentConfig(): AgentConfig {
	return {
		id: "a1",
		mentionPatterns: ["@a1"],
		displayName: "Agent A1",
		contextWindow: 16_384,
		roleId: "worker",
		roleDescription: "busy live smoke",
		restrictions: [],
		strengths: [],
		accountRef: "main",
		defaultModel: "m1",
		sessionChain: true,
		enabled: true,
	};
}

function writeModels(agentDir: string, baseUrl: string): void {
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				mock: {
					baseUrl,
					api: "anthropic-messages",
					apiKey: "test",
					models: [{ id: "m1", name: "m1", contextWindow: 16_384, maxTokens: 1_024 }],
				},
			},
		}),
	);
}

async function delayedProvider(delayMs: number): Promise<{ baseUrl: string; close(): Promise<void> }> {
	const server: Server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			void body;
			setTimeout(() => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(textResponse("BUSY_DONE"));
			}, delayMs);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("mock provider did not bind");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

async function waitFor<T>(check: () => Promise<T | null>, timeoutMs = 30_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await check();
		if (value !== null) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("timed out waiting for live worker state");
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string): Promise<string> {
	const decoder = new TextDecoder();
	let buffer = "";
	const deadline = Date.now() + 5_000;
	while (!buffer.includes(marker)) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${marker}`);
		const { value, done } = await reader.read();
		if (done) throw new Error(`stream ended before ${marker}`);
		buffer += decoder.decode(value, { stream: true });
	}
	return buffer;
}

describe("F021 real worker busy live state", () => {
	let root: string;
	let dataDir: string;
	let installationRoot: string;
	let projectDir: string;
	let daemon: DaemonHandle | null;
	let provider: { baseUrl: string; close(): Promise<void> } | null;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "f021-busy-live-"));
		dataDir = join(root, "data");
		installationRoot = join(root, "install");
		projectDir = join(root, "project");
		mkdirSync(installationRoot);
		mkdirSync(projectDir);
		initOperatorCredential({ dataDir });
		const catalog: AgentCatalog = { version: 1, agents: [agentConfig()] };
		const account: AccountConfig = { ref: "main", provider: "mock", apiKeyRef: "KEY", models: ["m1"] };
		writeFileSync(join(dataDir, "agent-catalog.json"), JSON.stringify(catalog));
		writeFileSync(join(dataDir, "accounts.json"), JSON.stringify([account]));
		daemon = null;
		provider = null;
	});

	afterEach(async () => {
		await daemon?.stop();
		daemon = null;
		await provider?.close();
		provider = null;
		rmSync(root, { recursive: true, force: true });
	});

	it("shows /live busy state while a real pi worker is running, then clears it", async () => {
		provider = await delayedProvider(1_500);
		writeModels(join(dataDir, "worker-agent"), provider.baseUrl);
		daemon = await startDaemon({
			installationRoot,
			dataDir,
			runningRevision: "f021-busy-live",
			controlPlane: false,
			hubOrigin: HUB_ORIGIN,
			a2aControlPlane: {
				cliPath: PI_CLI_PATH,
				offline: true,
				pollIntervalMs: 50,
				sweepIntervalMs: 1_000,
				promptTimeoutMs: 30_000,
			},
		});
		daemon.markReady();
		const base = new URL(daemon.healthUrl).origin;
		const created = createConsoleToken({ dataDir, ttlMs: 60_000 });
		const exchange = await fetch(`${base}/auth/console?token=${encodeURIComponent(created.token)}`, {
			redirect: "manual",
		});
		const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
		const session = await fetch(`${base}/api/session`, { headers: { cookie } });
		const { csrfToken } = (await session.json()) as { csrfToken: string };
		const headers = {
			cookie,
			"x-csrf-token": csrfToken,
			origin: HUB_ORIGIN,
			"content-type": "application/json",
		};

		const threadResponse = await fetch(`${base}/api/threads`, {
			method: "POST",
			headers,
			body: JSON.stringify({ projectPath: projectDir, title: "Busy", idempotencyKey: "busy-thread" }),
		});
		expect(threadResponse.status).toBe(201);
		const thread = (await threadResponse.json()) as { id: string };

		const eventsResponse = await fetch(`${base}/api/events?threadId=${encodeURIComponent(thread.id)}`, {
			headers: { cookie },
		});
		expect(eventsResponse.status).toBe(200);
		const reader = eventsResponse.body!.getReader();

		try {
			await readUntil(reader, "event: ready");
			const post = await fetch(`${base}/api/messages`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					threadId: thread.id,
					content: "hold the turn open",
					idempotencyKey: "busy-message",
					targets: ["a1"],
				}),
			});
			expect(post.status).toBe(202);
			const change = await readUntil(reader, '"live"');
			expect(change).toContain('"live"');

			const busy = await waitFor(async () => {
				const response = await fetch(`${base}/api/threads/${encodeURIComponent(thread.id)}/live`, {
					headers: { cookie },
				});
				const body = (await response.json()) as {
					invocations: Array<{ agentId: string; responseStatus: string }>;
				};
				return body.invocations.length > 0 ? body : null;
			});
			expect(busy.invocations[0]?.agentId).toBe("a1");
			expect(["missing", "processing"]).toContain(busy.invocations[0]?.responseStatus);
			const agentsResponse = await fetch(`${base}/api/agents`, { headers: { cookie } });
			const agents = (await agentsResponse.json()) as { agents: Array<{ id: string; status?: string }> };
			expect(agents.agents.find((agent) => agent.id === "a1")?.status).toBe("working");

			const done = await waitFor(async () => {
				const response = await fetch(`${base}/api/threads/${encodeURIComponent(thread.id)}/live`, {
					headers: { cookie },
				});
				const live = (await response.json()) as { invocations: unknown[] };
				if (live.invocations.length > 0) return null;
				const messagesResponse = await fetch(
					`${base}/api/messages?threadId=${encodeURIComponent(thread.id)}&limit=50`,
					{ headers: { cookie } },
				);
				const messages = (await messagesResponse.json()) as {
					messages: Array<{ type: string; content: string }>;
				};
				return messages.messages.some(
					(message) => message.type === "assistant" && message.content.includes("BUSY_DONE"),
				)
					? messages
					: null;
			});
			expect(done.messages.some((message) => message.type === "assistant")).toBe(true);
		} finally {
			await reader.cancel();
		}
	}, 60_000);
});
