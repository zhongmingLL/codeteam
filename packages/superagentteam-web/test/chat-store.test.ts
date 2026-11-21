import { describe, expect, it, vi } from "vitest";

import type { MessageView } from "@/domains/chat/api";
import { createChatStore } from "@/domains/chat/store";

function message(overrides: Partial<MessageView> = {}): MessageView {
	return {
		id: "msg:1",
		threadId: "thread:1",
		type: "user",
		from: { kind: "user", userId: "operator:1" },
		content: "hello",
		timestamp: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe("chat store", () => {
	it("loads the latest window and refreshes by replacing it", async () => {
		const api = {
			list: vi
				.fn()
				.mockResolvedValueOnce({ messages: [message()], hasMore: false })
				.mockResolvedValueOnce({
					messages: [message(), message({ id: "msg:2", content: "world" })],
					hasMore: false,
				}),
			send: vi.fn(),
		};
		const store = createChatStore({ api });

		await store.getState().loadLatest("thread:1");
		expect(store.getState().messages.map((item) => item.id)).toEqual(["msg:1"]);
		expect(store.getState().status).toBe("ready");

		await store.getState().refresh();
		expect(store.getState().messages.map((item) => item.id)).toEqual(["msg:1", "msg:2"]);
	});

	it("clears an invalid older cursor by reloading the latest window", async () => {
		const api = {
			list: vi
				.fn()
				.mockResolvedValueOnce({ messages: [message()], hasMore: true })
				.mockResolvedValueOnce({ messages: [], hasMore: false, query_warnings: ["invalid_cursor"] })
				.mockResolvedValueOnce({ messages: [message(), message({ id: "msg:2" })], hasMore: true }),
			send: vi.fn(),
		};
		const store = createChatStore({ api });
		await store.getState().loadLatest("thread:1");

		await store.getState().loadOlder();

		expect(api.list).toHaveBeenLastCalledWith("thread:1", { limit: 50 });
		expect(store.getState().messages.map((item) => item.id)).toEqual(["msg:1", "msg:2"]);
		expect(store.getState().status).toBe("ready");
	});

	it("keeps a receipt-backed pending row instead of optimistically inserting a message", async () => {
		const api = {
			list: vi.fn(async () => ({ messages: [] as MessageView[], hasMore: false })),
			send: vi.fn(async () => ({ status: "queued" as const, userMessageId: "msg:sent" })),
		};
		const store = createChatStore({ api });
		await store.getState().loadLatest("thread:1");

		await store.getState().send("hello", "key-1");

		expect(store.getState().messages).toEqual([]);
		expect(store.getState().pendingUserMessages).toEqual([{ messageId: "msg:sent", content: "hello" }]);
	});

	it("clears the pending row once the sent message appears in the history", async () => {
		const sent = message({ id: "msg:sent", content: "hello" });
		const api = {
			list: vi
				.fn()
				.mockResolvedValueOnce({ messages: [], hasMore: false })
				.mockResolvedValueOnce({ messages: [sent], hasMore: false }),
			send: vi.fn(async () => ({ status: "queued" as const, userMessageId: sent.id })),
		};
		const store = createChatStore({ api });
		await store.getState().loadLatest("thread:1");

		await store.getState().send("hello", "key-1");

		expect(store.getState().pendingUserMessages).toEqual([]);
		expect(store.getState().messages.map((item) => item.id)).toEqual(["msg:sent"]);
	});

	it("ignores a slow response from a thread the user already left", async () => {
		let finishFirst: (value: { messages: MessageView[]; hasMore: boolean }) => void = () => {};
		const api = {
			list: vi.fn((threadId: string) => {
				if (threadId === "thread:1") {
					return new Promise<{ messages: MessageView[]; hasMore: boolean }>((resolve) => {
						finishFirst = resolve;
					});
				}
				return Promise.resolve({ messages: [message({ id: "msg:2", threadId: "thread:2" })], hasMore: false });
			}),
			send: vi.fn(),
		};
		const store = createChatStore({ api });

		const first = store.getState().loadLatest("thread:1");
		await store.getState().loadLatest("thread:2");
		finishFirst({ messages: [message({ id: "msg:1", threadId: "thread:1" })], hasMore: false });
		await first;

		expect(store.getState().threadId).toBe("thread:2");
		expect(store.getState().messages.map((item) => item.id)).toEqual(["msg:2"]);
	});
});
