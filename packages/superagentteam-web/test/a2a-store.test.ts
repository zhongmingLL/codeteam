import { describe, expect, it, vi } from "vitest";

import type { LiveInvocationView, QueueEntryView } from "@/domains/a2a/api";
import { createA2AStore } from "@/domains/a2a/store";

function queueEntry(overrides: Partial<QueueEntryView> = {}): QueueEntryView {
	return {
		queueEntryId: "queue:1",
		sourceRecordId: "msg:1",
		status: "queued",
		priority: "normal",
		position: 0,
		targetAgentIds: ["a1"],
		claimedBy: null,
		enqueuedAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function live(overrides: Partial<LiveInvocationView> = {}): LiveInvocationView {
	return {
		agentId: "a1",
		turnExecutionId: "turn:1",
		parentInvocationId: "inv:1",
		startedAt: 1,
		childStatus: "running",
		responseStatus: "missing",
		evidenceRank: "record+tracker",
		...overrides,
	};
}

describe("a2a store", () => {
	it("loads queue and live state for a thread", async () => {
		const entry = queueEntry();
		const invocation = live();
		const api = {
			queue: vi.fn(async () => ({
				threadId: "thread:1",
				cap: { perKind: 20 },
				queue: [entry],
				entries: [entry],
				activeInvocations: [invocation],
			})),
			live: vi.fn(async () => ({ threadId: "thread:1", invocations: [invocation] })),
		};
		const store = createA2AStore({ api });

		await store.getState().load("thread:1");

		expect(store.getState()).toMatchObject({ threadId: "thread:1", status: "ready" });
		expect(store.getState().queue).toEqual([entry]);
		expect(store.getState().live).toEqual([invocation]);
	});

	it("keeps the last queue when a refresh fails", async () => {
		const api = {
			queue: vi.fn(async () => ({
				threadId: "thread:1",
				cap: { perKind: 20 },
				queue: [queueEntry()],
				entries: [],
				activeInvocations: [],
			})),
			live: vi
				.fn()
				.mockResolvedValueOnce({ threadId: "thread:1", invocations: [] })
				.mockRejectedValueOnce(new Error("daemon down")),
		};
		const store = createA2AStore({ api });
		await store.getState().load("thread:1");

		await store.getState().refresh();

		expect(store.getState().queue).toHaveLength(1);
		expect(store.getState()).toMatchObject({ status: "ready", error: "daemon down" });
	});

	it("ignores a stale thread response", async () => {
		let finish: (value: { threadId: string; invocations: LiveInvocationView[] }) => void = () => {};
		const api = {
			queue: vi.fn(async (threadId: string) => ({
				threadId,
				cap: { perKind: 20 },
				queue: threadId === "thread:1" ? [queueEntry()] : [],
				entries: [],
				activeInvocations: [],
			})),
			live: vi.fn((threadId: string) => {
				if (threadId === "thread:1") {
					return new Promise<{ threadId: string; invocations: LiveInvocationView[] }>((resolve) => {
						finish = resolve;
					});
				}
				return Promise.resolve({ threadId, invocations: [live({ turnExecutionId: "turn:2" })] });
			}),
		};
		const store = createA2AStore({ api });

		const first = store.getState().load("thread:1");
		await store.getState().load("thread:2");
		finish({ threadId: "thread:1", invocations: [live()] });
		await first;

		expect(store.getState().threadId).toBe("thread:2");
		expect(store.getState().live.map((item) => item.turnExecutionId)).toEqual(["turn:2"]);
	});
});
