import { afterEach, describe, expect, it } from "vitest";
import { A2A_TOOL_NAMES, createA2AHandlers, resolveRunPrincipal } from "../src/index.ts";
import {
	bootstrapProfiles,
	cleanupDaemonE2E,
	createBacklogAndDispatch,
	prepareTask,
	setupDirs,
	startE2eDaemon,
	trackMock,
	waitFor,
} from "./helpers/daemon-e2e.ts";
import {
	lastMessageHasToolResult,
	startMockAnthropic,
	textResponse,
	toolCallResponse,
} from "./helpers/mock-anthropic.ts";
import { createW5AFixture, type W5AFixture } from "./helpers/w5a-fixture.ts";

const fixtures: W5AFixture[] = [];

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
	await cleanupDaemonE2E();
});

function registeredTool(logical: string): string {
	const name = A2A_TOOL_NAMES.find((candidate) => candidate === logical || candidate.endsWith(`_${logical}`));
	if (!name) throw new Error(`registered tool ${logical} is missing`);
	return name;
}

function fixture(): W5AFixture {
	const created = createW5AFixture();
	fixtures.push(created);
	return created;
}

function readHandlers(base: W5AFixture) {
	const source = base.createSourceMessage("thread context source");
	const run = base.createRun({
		id: "run-read-context",
		profileId: "profile:coder",
		role: "coder",
		sessionId: "session-coder",
		sourceId: source.id,
	});
	return createA2AHandlers({
		store: base.store,
		principal: resolveRunPrincipal(base.store, run.id),
		clock: base.now,
	});
}

function appendMessages(base: W5AFixture, count: number) {
	const messages = [];
	for (let index = 0; index < count; index += 1) {
		messages.push(
			base.store.messages.append({
				threadId: "thread-1",
				taskId: "task-1",
				authorKind: "user",
				authorId: "user-1",
				kind: "chat",
				bodyMd: `context message ${index}`,
			}),
		);
	}
	return messages;
}

describe("F016a thread_context read tool", () => {
	it("pages the latest bounded window and follows the cursor without overlap", () => {
		const base = fixture();
		const handlers = readHandlers(base);
		const appended = appendMessages(base, 10);

		const first = handlers.threadContext({ limit: 3 });
		expect(first.threadId).toBe("thread-1");
		expect(first.messages).toHaveLength(3);
		expect(first.messages.map((message) => message.bodyMd)).toEqual([
			"context message 7",
			"context message 8",
			"context message 9",
		]);
		expect(first.hasMore).toBe(true);
		expect(first.nextCursor).toBe(String(first.messages[0]!.seq));

		const second = handlers.threadContext({ limit: 3, cursor: first.nextCursor });
		expect(second.messages).toHaveLength(3);
		expect(second.messages.every((message) => message.seq < first.messages[0]!.seq)).toBe(true);
		expect(new Set([...first.messages, ...second.messages].map((message) => message.id)).size).toBe(6);

		const collected = [...second.messages, ...first.messages];
		let cursor = second.nextCursor;
		let page = second;
		while (page.hasMore && cursor) {
			page = handlers.threadContext({ limit: 3, cursor });
			collected.unshift(...page.messages);
			cursor = page.nextCursor;
		}
		expect(cursor).toBeNull();
		expect(collected).toHaveLength(appended.length + 1);
		expect(new Set(collected.map((message) => message.id)).size).toBe(collected.length);
		expect(collected[0]?.bodyMd).toBe("thread context source");
	});

	it("returns a bounded window around an anchor and rejects cross-thread anchors", () => {
		const base = fixture();
		const handlers = readHandlers(base);
		const appended = appendMessages(base, 10);
		const anchor = appended[5]!;
		const window = handlers.threadContext({ anchorMessageId: anchor.id, before: 2, after: 1, limit: 5 });
		expect(window.anchorMessageId).toBe(anchor.id);
		expect(window.messages.map((message) => message.bodyMd)).toEqual([
			"context message 3",
			"context message 4",
			"context message 5",
			"context message 6",
		]);
		expect(window.hasMore).toBe(true);

		base.store.threads.create({ id: "thread-other", title: "Other" });
		const other = base.store.messages.append({
			threadId: "thread-other",
			authorKind: "user",
			authorId: "user-1",
			kind: "chat",
			bodyMd: "other thread",
		});
		expect(() => handlers.threadContext({ anchorMessageId: other.id })).toThrowError(
			expect.objectContaining({ code: "forbidden" }),
		);
		expect(() => handlers.threadContext({ anchorMessageId: "message:missing" })).toThrowError(
			expect.objectContaining({ code: "not_found" }),
		);
	});

	it("rejects caller-supplied scope and invalid cursor combinations", () => {
		const base = fixture();
		const handlers = readHandlers(base);
		const appended = appendMessages(base, 2);
		expect(() => handlers.threadContext({ threadId: "thread-other" } as never)).toThrowError(
			expect.objectContaining({ code: "invalid_input" }),
		);
		expect(() => handlers.threadContext({ anchorMessageId: appended[0]!.id, cursor: "1" })).toThrowError(
			expect.objectContaining({ code: "invalid_input" }),
		);
		expect(() => handlers.threadContext({ limit: 0 })).toThrowError(
			expect.objectContaining({ code: "invalid_input" }),
		);
		expect(() => handlers.threadContext({ cursor: "not-a-seq" })).toThrowError(
			expect.objectContaining({ code: "invalid_input" }),
		);
	});

	it("stays bounded on a large thread", () => {
		const base = fixture();
		const handlers = readHandlers(base);
		appendMessages(base, 250);
		const latest = handlers.threadContext({ limit: 200 });
		expect(latest.messages).toHaveLength(200);
		expect(latest.hasMore).toBe(true);
		expect(latest.nextCursor).not.toBeNull();
		expect(() => handlers.threadContext({ limit: 201 })).toThrowError(
			expect.objectContaining({ code: "invalid_input" }),
		);
	});

	it("registers thread_context in a real worker and reads without routing", async () => {
		const { dataDir, installationRoot } = setupDirs();
		bootstrapProfiles(dataDir);
		const mock = trackMock(
			await startMockAnthropic(({ model, body }) => {
				if (model !== "mock-coder") return textResponse("OK");
				if (lastMessageHasToolResult(body)) return textResponse("THREAD_CONTEXT_READ");
				return toolCallResponse(registeredTool("thread_context"), { limit: 2 });
			}),
		);
		const { daemon, store } = await startE2eDaemon(dataDir, installationRoot, mock.baseUrl, ["mock-coder"], {
			pollIntervalMs: 60_000,
			sweepIntervalMs: 60_000,
		});
		const dispatched = createBacklogAndDispatch(dataDir, "profile:coder", "kickoff");
		prepareTask(dataDir, dispatched.task.id, ["profile:coder"]);
		await daemon.controlPlane!.drainNow(1);
		const run = await waitFor(() =>
			store.runs
				.list({ taskId: dispatched.task.id })
				.find((candidate) => candidate.recipientProfileId === "profile:coder" && candidate.status === "completed"),
		);
		expect(store.messages.get(run.responseMessageId!)?.bodyMd).toContain("THREAD_CONTEXT_READ");
		const toolNames = store.runs
			.listEvents(run.id, 100)
			.filter((event) => event.kind === "tool_call")
			.map((event) => (event.payload as { toolName?: string }).toolName ?? "");
		expect(toolNames.some((name) => name.endsWith("thread_context"))).toBe(true);
		expect(store.runs.list({ taskId: dispatched.task.id })).toHaveLength(1);
		expect(store.queue.pendingCount()).toBe(0);
	}, 90_000);
});
