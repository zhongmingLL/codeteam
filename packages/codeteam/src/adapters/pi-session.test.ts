import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createCodeteamSession } from "./pi-session.ts";

describe("pi session adapter", () => {
	it("creates a reviewer session with read-only tools and fresh context", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "codeteam-session-"));
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const runtime = await ModelRuntime.create({
			modelsPath: null,
			authPath: join(agentDir, "auth.json"),
		});
		const faux = fauxProvider();
		runtime.registerNativeProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("reviewed")]);

		const session = await createCodeteamSession({
			role: "reviewer",
			cwd: tempDir,
			agentDir,
			model: faux.getModel(),
			modelRuntime: runtime,
		});
		try {
			expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "grep", "find", "ls"]));
			expect(session.getActiveToolNames()).not.toContain("write");
			expect(session.getActiveToolNames()).not.toContain("bash");
			expect(session.systemPrompt).toContain("codeteam's reviewer");

			await session.prompt("Review the provided diff.");
			expect(session.getLastAssistantText()).toBe("reviewed");
		} finally {
			session.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("executes a built-in tool through a coder session", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "codeteam-tool-"));
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(tempDir, "hello.txt"), "hello from fixture\n");
		const runtime = await ModelRuntime.create({
			modelsPath: null,
			authPath: join(agentDir, "auth.json"),
		});
		const faux = fauxProvider();
		runtime.registerNativeProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "hello.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const session = await createCodeteamSession({
			role: "coder",
			cwd: tempDir,
			agentDir,
			model: faux.getModel(),
			modelRuntime: runtime,
			tools: ["read"],
		});
		try {
			await session.prompt("Read hello.txt and report done.");
			expect(session.getLastAssistantText()).toBe("done");
			const toolResult = session.messages.find((message) => message.role === "toolResult");
			expect(JSON.stringify(toolResult)).toContain("hello from fixture");
		} finally {
			session.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
