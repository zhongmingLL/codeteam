import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HandoffTerminalResolver } from "../src/a2a/terminal.ts";
import { DispatchService } from "../src/dispatch/service.ts";
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

function messagesOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
	return Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
}

function lastToolName(body: Record<string, unknown>): string | null {
	const messages = messagesOf(body);
	const last = messages.at(-1);
	if (!last || !Array.isArray(last.content)) return null;
	const result = last.content.find(
		(part) => part && typeof part === "object" && (part as { type?: unknown }).type === "tool_result",
	) as { tool_use_id?: unknown } | undefined;
	if (!result || typeof result.tool_use_id !== "string") return null;
	for (let index = messages.length - 2; index >= 0; index -= 1) {
		const content = messages[index]?.content;
		if (!Array.isArray(content)) continue;
		const toolUse = content.find(
			(part) =>
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "tool_use" &&
				(part as { id?: unknown }).id === result.tool_use_id,
		) as { name?: unknown } | undefined;
		if (toolUse && typeof toolUse.name === "string") return toolUse.name;
	}
	return null;
}

function handoffIdFromPrompt(body: Record<string, unknown>): string | null {
	const match = /Handoff ID: ([A-Za-z0-9._:-]+)/.exec(JSON.stringify(body.messages ?? []));
	return match?.[1] ?? null;
}

function handoffDeadline(): number {
	return Date.now() + 60 * 60 * 1000;
}

function createDispatch(f: W5BFixture): DispatchService {
	const resolver = new HandoffTerminalResolver({ store: f.store });
	return new DispatchService(f.store, f.runtime.executor, f.now, {
		onRunTerminal: (run, input) => {
			f.runtime.dispatchHooks.onRunTerminal?.(run, input);
			resolver.onRunTerminal(run);
		},
	});
}

describe("real worker A2A end-to-end", () => {
	it("runs coder a2a_send + handoff_create, reviewer claim/complete, and consumes the handoff", async () => {
		fixture = createRealFixture({ coder: "mock-coder", reviewer: "mock-reviewer" });
		mock = await startMockAnthropic(({ model, body }) => {
			if (model === "mock-coder") {
				const lastTool = lastToolName(body);
				if (lastTool === "handoff_create") return textResponse("CODER_HANDOFF_CREATED");
				if (lastTool === "a2a_send") {
					return toolCallResponse("handoff_create", {
						kind: "review_request",
						targets: ["profile:reviewer"],
						subject: "Review A2A E2E",
						subjectRef: "pr:owner/repo#15",
						actionFamily: "review",
						successorSlot: "reviewer",
						expectedArtifact: "artifact:review",
						deadline: handoffDeadline(),
						idempotencyKey: "idem-a2a-worker-e2e",
						terminalPredicate: { kind: "run_completed" },
						bodyMd: "Please review the handoff.",
					});
				}
				return toolCallResponse("a2a_send", {
					kind: "status",
					targets: ["profile:reviewer"],
					bodyMd: "I am creating a review handoff.",
					requestId: "req-a2a-worker-e2e",
				});
			}
			if (model === "mock-reviewer") {
				const handoffId = handoffIdFromPrompt(body);
				if (!handoffId) return textResponse("REVIEWER_ACK");
				const lastTool = lastToolName(body);
				if (lastTool === "handoff_claim") {
					return toolCallResponse("handoff_complete", {
						handoffId,
						evidenceRef: "review:approved",
						result: { verdict: "approved", headSha: "a".repeat(40) },
					});
				}
				if (lastTool === "handoff_complete") return textResponse("REVIEW_COMPLETE");
				return toolCallResponse("handoff_claim", { handoffId });
			}
			return textResponse("OK");
		});
		writeModels(fixture.workerAgentDir, mock.baseUrl, ["mock-coder", "mock-reviewer"]);
		await fixture.runtime.start();
		const dispatch = createDispatch(fixture);

		const source = fixture.createSource("Send a review request to the reviewer.");
		fixture.enqueue({ sourceId: source.id, target: "profile:coder" });
		const coderDrain = await dispatch.drain({ maxEntries: 1 });
		expect(coderDrain.outcomes[0]?.status).toBe("completed");
		const handoff = fixture.store.handoffs.list({ taskId: "task-w5b" })[0]!;
		expect(handoff.status).toBe("pending");

		const reviewDrain = await dispatch.drain({ maxEntries: 5 });
		expect(reviewDrain.outcomes.every((outcome) => outcome.status === "completed")).toBe(true);
		const consumed = fixture.store.handoffs.get(handoff.id)!;
		expect(consumed.status).toBe("consumed");
		expect(consumed.terminalEvidenceRef).toMatch(/^run:/);
		expect(consumed.holderOutcomes["profile:reviewer"]).toMatchObject({ outcome: "succeeded" });
		expect(fixture.store.handoffs.custodyEvents(handoff.id).map((event) => event.kind)).toContain(
			"handoff.completion_candidate",
		);
		expect(fixture.store.handoffs.custodyEvents(handoff.id).map((event) => event.kind)).toContain(
			"handoff.completed",
		);

		const runs = fixture.store.runs.list({ taskId: "task-w5b" });
		expect(runs.every((run) => run.status === "completed")).toBe(true);
		const toolNames = runs.flatMap((run) =>
			fixture!.store.runs
				.listEvents(run.id, 200)
				.filter((event) => event.kind === "tool_call")
				.map((event) => (event.payload as { toolName?: string }).toolName ?? ""),
		);
		expect(toolNames).toContain("a2a_send");
		expect(toolNames).toContain("handoff_create");
		expect(toolNames).toContain("handoff_claim");
		expect(toolNames).toContain("handoff_complete");
		expect(fixture.store.audit.latest(`run:${runs[0]!.id}`, "missing_a2a_tool_call")).toBeNull();
	}, 90_000);

	it("records exactly one missing_a2a_tool_call when the worker uses text @ without a tool", async () => {
		fixture = createRealFixture({ coder: "mock-text-only" });
		mock = await startMockAnthropic(({ model }) =>
			model === "mock-text-only" ? textResponse("@profile:reviewer please take this") : textResponse("OK"),
		);
		writeModels(fixture.workerAgentDir, mock.baseUrl, ["mock-text-only"]);
		await fixture.runtime.start();
		const dispatch = createDispatch(fixture);
		const source = fixture.createSource("Report the handoff in text only.");
		fixture.enqueue({ sourceId: source.id, target: "profile:coder" });
		const drain = await dispatch.drain({ maxEntries: 1 });
		expect(drain.outcomes[0]?.status).toBe("completed");
		const run = fixture.store.runs.get(drain.runs[0]!.id)!;
		const audits = fixture.store.audit.listSubject(`run:${run.id}`, 50);
		expect(audits.filter((entry) => entry.action === "missing_a2a_tool_call")).toHaveLength(1);
		expect(fixture.store.queue.pendingCount()).toBe(0);
		expect(fixture.store.handoffs.list({ taskId: "task-w5b" })).toHaveLength(0);
	}, 60_000);

	it("fails A2A tools closed when the control plane is unavailable", async () => {
		fixture = createRealFixture({ coder: "mock-a2a-blocked" });
		mock = await startMockAnthropic(({ model, body }) => {
			if (model !== "mock-a2a-blocked") return textResponse("OK");
			if (lastMessageHasToolResult(body)) return textResponse("A2A_BLOCKED_OBSERVED");
			return toolCallResponse("a2a_send", {
				kind: "status",
				targets: ["profile:reviewer"],
				bodyMd: "must not send",
			});
		});
		writeModels(fixture.workerAgentDir, mock.baseUrl, ["mock-a2a-blocked"]);
		await fixture.runtime.start();
		await fixture.runtime.control.stop();
		const dispatch = createDispatch(fixture);
		const source = fixture.createSource("Try to send while the control plane is down.");
		fixture.enqueue({ sourceId: source.id, target: "profile:coder" });
		const drain = await dispatch.drain({ maxEntries: 1 });
		expect(drain.outcomes[0]?.status).toBe("completed");
		const run = fixture.store.runs.get(drain.runs[0]!.id)!;
		expect(fixture.store.messages.get(run.responseMessageId!)!.bodyMd).toContain("A2A_BLOCKED_OBSERVED");
		expect(
			fixture.store.messages.listThread("thread-w5b").some((message) => message.bodyMd.includes("must not send")),
		).toBe(false);
		expect(fixture.store.queue.pendingCount()).toBe(0);
	}, 60_000);
});
