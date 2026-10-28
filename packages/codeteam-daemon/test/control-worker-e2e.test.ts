import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	lastMessageHasToolResult,
	startMockAnthropic,
	textResponse,
	toolCallResponse,
} from "./helpers/mock-anthropic.ts";
import { createW5BFixture, type W5BFixture } from "./helpers/w5b-fixture.ts";

const REAL_CLI_PATH = join(import.meta.dirname, "..", "..", "coding-agent", "dist", "cli.js");

let fixture: W5BFixture | null = null;
let mock: Awaited<ReturnType<typeof startMockAnthropic>> | null = null;

afterEach(async () => {
	await fixture?.cleanup();
	fixture = null;
	await mock?.close();
	mock = null;
});

function writeModels(agentDir: string, baseUrl: string, modelIds: string[]): void {
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				mock: {
					baseUrl,
					api: "anthropic-messages",
					apiKey: "test",
					models: modelIds.map((id) => ({ id, name: id, contextWindow: 16_384, maxTokens: 1_024 })),
				},
			},
		}),
		"utf8",
	);
}

function createRealFixture(modelForRole: Record<string, string>): W5BFixture {
	return createW5BFixture({
		cliPath: REAL_CLI_PATH,
		sessionProvider: "mock",
		sessionModelForRole: modelForRole,
		offline: true,
	});
}

describe("W5b real pi RPC end-to-end", () => {
	it("runs a real implement then review through pi RPC and dispatch", async () => {
		fixture = createRealFixture({ coder: "mock-coder", reviewer: "mock-reviewer" });
		mock = await startMockAnthropic(({ model, body }) => {
			if (model === "mock-reviewer") return textResponse("REVIEW_APPROVED");
			if (model === "mock-coder") {
				if (lastMessageHasToolResult(body)) return textResponse("IMPLEMENTED_AND_VERIFIED");
				return toolCallResponse("write", { path: "solution.txt", content: "IMPLEMENTED_BY_W5B\n" });
			}
			return textResponse("OK");
		});
		writeModels(fixture.workerAgentDir, mock.baseUrl, ["mock-coder", "mock-reviewer"]);
		await fixture.runtime.start();

		const coderSource = fixture.createSource("Implement solution.txt with IMPLEMENTED_BY_W5B.");
		fixture.enqueue({ sourceId: coderSource.id });
		const coderDrain = await fixture.dispatch.drain({ maxEntries: 1 });
		expect(coderDrain.outcomes[0]?.status).toBe("completed");
		const coderRun = fixture.store.runs.get(coderDrain.runs[0]!.id)!;
		expect(fixture.store.messages.get(coderRun.responseMessageId!)!.bodyMd).toContain("IMPLEMENTED_AND_VERIFIED");
		expect(readFileSync(join(fixture.worktree, "solution.txt"), "utf8")).toBe("IMPLEMENTED_BY_W5B\n");

		const reviewSource = fixture.createSource("Review the change in solution.txt. Approve or request changes.");
		fixture.enqueue({ sourceId: reviewSource.id, target: "profile:reviewer" });
		const reviewDrain = await fixture.dispatch.drain({ maxEntries: 1 });
		expect(reviewDrain.outcomes[0]?.status).toBe("completed");
		const reviewRun = fixture.store.runs.get(reviewDrain.runs[0]!.id)!;
		expect(fixture.store.messages.get(reviewRun.responseMessageId!)!.bodyMd).toContain("REVIEW_APPROVED");
		expect(
			mock.requests.some(
				(entry) =>
					entry.model === "mock-reviewer" &&
					JSON.stringify(entry.body.messages).includes("Review the change in solution.txt"),
			),
		).toBe(true);
	}, 60_000);

	it("fail-closes mutating tools while the control plane is unavailable", async () => {
		fixture = createRealFixture({ coder: "mock-coder" });
		mock = await startMockAnthropic(({ model, body }) => {
			if (model === "mock-coder") {
				if (lastMessageHasToolResult(body)) return textResponse("WRITE_BLOCKED_OBSERVED");
				return toolCallResponse("write", { path: "blocked.txt", content: "must not be written\n" });
			}
			return textResponse("OK");
		});
		writeModels(fixture.workerAgentDir, mock.baseUrl, ["mock-coder"]);
		const source = fixture.createSource("Write blocked.txt.");
		fixture.enqueue({ sourceId: source.id });
		const drain = await fixture.dispatch.drain({ maxEntries: 1 });
		expect(drain.outcomes[0]?.status).toBe("completed");
		const run = fixture.store.runs.get(drain.runs[0]!.id)!;
		expect(fixture.store.messages.get(run.responseMessageId!)!.bodyMd).toContain("WRITE_BLOCKED_OBSERVED");
		expect(existsSync(join(fixture.worktree, "blocked.txt"))).toBe(false);
		const toolResults = fixture.store.runs.listEvents(run.id, 100).filter((event) => event.kind === "tool_result");
		expect(toolResults.some((event) => (event.payload as { isError?: boolean }).isError === true)).toBe(true);
	}, 60_000);

	it("continues read-only tools while the control plane is unavailable", async () => {
		fixture = createRealFixture({ coder: "mock-read" });
		mock = await startMockAnthropic(({ model, body }) => {
			if (model !== "mock-read") return textResponse("OK");
			if (lastMessageHasToolResult(body)) return textResponse("READ_ALLOWED_OBSERVED");
			return toolCallResponse("read", { path: "README.md" });
		});
		writeModels(fixture.workerAgentDir, mock.baseUrl, ["mock-read"]);
		const source = fixture.createSource("Read README.md.");
		fixture.enqueue({ sourceId: source.id });
		const drain = await fixture.dispatch.drain({ maxEntries: 1 });
		expect(drain.outcomes[0]?.status).toBe("completed");
		const run = fixture.store.runs.get(drain.runs[0]!.id)!;
		expect(fixture.store.messages.get(run.responseMessageId!)!.bodyMd).toContain("READ_ALLOWED_OBSERVED");
		const toolResults = fixture.store.runs.listEvents(run.id, 100).filter((event) => event.kind === "tool_result");
		expect(toolResults).toHaveLength(1);
		expect((toolResults[0]!.payload as { isError?: boolean }).isError).toBe(false);
	}, 60_000);

	it("re-attaches a real pi session and preserves prior conversation context", async () => {
		fixture = createRealFixture({ coder: "mock-session" });
		mock = await startMockAnthropic(({ model, body }) => {
			if (model !== "mock-session") return textResponse("OK");
			const messages = Array.isArray(body.messages) ? body.messages : [];
			const context = JSON.stringify(
				messages.filter((message) => (message as { role?: unknown }).role === "assistant"),
			);
			return textResponse(context.includes("SESSION_ONE") ? "SESSION_TWO" : "SESSION_ONE");
		});
		writeModels(fixture.workerAgentDir, mock.baseUrl, ["mock-session"]);
		await fixture.runtime.start();

		const firstSource = fixture.createSource("Remember the marker SESSION_ONE.");
		fixture.enqueue({ sourceId: firstSource.id });
		const first = await fixture.dispatch.drain({ maxEntries: 1 });
		const firstRun = fixture.store.runs.get(first.runs[0]!.id)!;
		expect(fixture.store.messages.get(firstRun.responseMessageId!)!.bodyMd).toBe("SESSION_ONE");
		const workerId = firstRun.workerId!;
		const sessionFile = (
			fixture.store.sessions.get("session-coder")?.nativeSessionBinding as { sessionFile?: string }
		)?.sessionFile;
		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(true);
		await fixture.runtime.harness.releaseWorker(workerId, "test_release");

		const secondSource = fixture.createSource("What marker did you remember?");
		fixture.enqueue({ sourceId: secondSource.id });
		const second = await fixture.dispatch.drain({ maxEntries: 1 });
		const secondRun = fixture.store.runs.get(second.runs[0]!.id)!;
		expect(fixture.store.messages.get(secondRun.responseMessageId!)!.bodyMd).toBe("SESSION_TWO");
		expect(secondRun.workerId).not.toBe(workerId);
		const reattachedRequest = mock.requests.filter((entry) => entry.model === "mock-session").at(-1)!;
		expect(JSON.stringify(reattachedRequest.body.messages)).toContain("SESSION_ONE");
		expect(fixture.store.audit.latest("session:session-coder", "session_reattached")).toBeDefined();
	}, 60_000);
});
