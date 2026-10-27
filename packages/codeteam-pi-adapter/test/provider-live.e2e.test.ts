import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { compileL0, createAgentSessionWithL0 } from "../src/index.ts";

const liveBaseUrl = process.env.CODETEAM_LIVE_BASE_URL;
const liveModel = process.env.CODETEAM_LIVE_MODEL;
const liveApiKey = process.env.CODETEAM_LIVE_API_KEY;
const liveEnabled = process.env.CODETEAM_LIVE_PROVIDER === "1" && Boolean(liveBaseUrl && liveModel && liveApiKey);

describe.skipIf(!liveEnabled)("live provider end-to-end", () => {
	it("gets a real model reply while sending L0 over the wire", async () => {
		const root = mkdtempSync(join(tmpdir(), "codeteam-live-e2e-"));
		const cwd = join(root, "work");
		const agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		const authPath = join(agentDir, "auth.json");
		writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: liveApiKey } }), { mode: 0o600 });
		expect(statSync(authPath).mode & 0o777).toBe(0o600);

		const compiled = compileL0({ role: "coder", sections: [{ id: "task", body: "Live provider check." }] });
		const model = {
			...getModel("anthropic", "claude-sonnet-4-5")!,
			id: liveModel!,
			baseUrl: liveBaseUrl!,
			maxTokens: 256,
		};

		const originalFetch = globalThis.fetch;
		const captured: Array<{ url: string; body: string }> = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const body = typeof init?.body === "string" ? init.body : "";
			captured.push({ url: String(input), body });
			return originalFetch(input, init);
		}) as typeof fetch;

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
			await session.prompt("Reply with exactly LIVE_OK");
			const text = session.getLastAssistantText() ?? "";
			expect(text).toContain("LIVE_OK");

			expect(captured).toHaveLength(1);
			expect(captured[0]!.url.startsWith(liveBaseUrl!)).toBe(true);
			const body = JSON.parse(captured[0]!.body) as { stream?: boolean; system?: unknown; messages?: unknown };
			expect(body.stream).toBe(true);
			const systemText = Array.isArray(body.system)
				? (body.system as Array<{ text?: string }>).map((block) => block.text ?? "").join("")
				: String(body.system);
			expect(systemText).toContain(compiled.text);
			expect(JSON.stringify(body.messages)).toContain("Reply with exactly LIVE_OK");
		} finally {
			globalThis.fetch = originalFetch;
			session.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);
});
