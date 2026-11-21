import { describe, expect, it, vi } from "vitest";

import type { ThreadView } from "@/domains/thread/api";
import { createThreadStore, selectFilteredThreads } from "@/domains/thread/store";

function thread(overrides: Partial<ThreadView> = {}): ThreadView {
	return {
		id: "thread:1",
		projectPath: "/tmp/project-a",
		title: "Alpha",
		titleSource: "user",
		createdBy: "operator:1",
		participants: [],
		lastActiveAt: 1,
		createdAt: 1,
		updatedAt: 1,
		deletedAt: null,
		...overrides,
	};
}

describe("thread store", () => {
	it("loads threads and filters by title or project", async () => {
		const api = {
			list: vi.fn(async () => ({
				threads: [thread(), thread({ id: "thread:2", title: "Beta", projectPath: "/tmp/b" })],
			})),
			get: vi.fn(),
			create: vi.fn(),
			markRead: vi.fn(),
			rename: vi.fn(),
		};
		const store = createThreadStore({ api });

		await store.getState().load();

		expect(store.getState().status).toBe("ready");
		expect(store.getState().threads).toHaveLength(2);
		store.getState().setQuery("alpha");
		expect(selectFilteredThreads(store.getState()).map((item) => item.id)).toEqual(["thread:1"]);
		store.getState().setQuery("/tmp/b");
		expect(selectFilteredThreads(store.getState()).map((item) => item.id)).toEqual(["thread:2"]);
	});

	it("prepends a created thread without duplicating it", async () => {
		const created = thread({ id: "thread:new", title: "New" });
		const api = {
			list: vi.fn(async () => ({ threads: [thread()] })),
			get: vi.fn(),
			create: vi.fn(async () => created),
			markRead: vi.fn(),
			rename: vi.fn(),
		};
		const store = createThreadStore({ api });
		await store.getState().load();

		await store.getState().create({ projectPath: "/tmp/new", idempotencyKey: "key" });

		expect(store.getState().threads.map((item) => item.id)).toEqual(["thread:new", "thread:1"]);
	});

	it("keeps the error retryable when loading fails", async () => {
		const api = {
			list: vi.fn(async () => Promise.reject(new Error("daemon down"))),
			get: vi.fn(),
			create: vi.fn(),
			markRead: vi.fn(),
			rename: vi.fn(),
		};
		const store = createThreadStore({ api });

		await store.getState().load();

		expect(store.getState()).toMatchObject({ status: "error", error: "daemon down" });
	});

	it("marks a thread read optimistically with the message cursor", async () => {
		const api = {
			list: vi.fn(async () => ({ threads: [thread({ unreadCount: 2 })] })),
			get: vi.fn(),
			create: vi.fn(),
			markRead: vi.fn(async () => ({ threadId: "thread:1", unreadCount: 0 })),
			rename: vi.fn(),
		};
		const store = createThreadStore({ api });
		await store.getState().load();

		await store.getState().markRead("thread:1", "msg:agent");

		expect(api.markRead).toHaveBeenCalledWith("thread:1", "msg:agent");
		expect(store.getState().threads[0]?.unreadCount).toBe(0);
	});

	it("restores the unread count when mark-read fails", async () => {
		const api = {
			list: vi.fn(async () => ({ threads: [thread({ unreadCount: 2 })] })),
			get: vi.fn(),
			create: vi.fn(),
			markRead: vi.fn(async () => Promise.reject(new Error("daemon down"))),
			rename: vi.fn(),
		};
		const store = createThreadStore({ api });
		await store.getState().load();

		await store.getState().markRead("thread:1", "msg:agent");

		expect(store.getState().threads[0]?.unreadCount).toBe(2);
	});

	it("ignores a list response that started before mark-read completed", async () => {
		let resolveList: ((value: { threads: ThreadView[] }) => void) | undefined;
		const api = {
			list: vi.fn(
				() =>
					new Promise<{ threads: ThreadView[] }>((resolve) => {
						resolveList = resolve;
					}),
			),
			get: vi.fn(),
			create: vi.fn(),
			markRead: vi.fn(async () => ({ threadId: "thread:1", unreadCount: 0 })),
			rename: vi.fn(),
		};
		const store = createThreadStore({ api });
		store.setState({ threads: [thread({ unreadCount: 2 })], status: "ready" });

		const refresh = store.getState().refresh();
		await store.getState().markRead("thread:1", "msg:agent");
		resolveList?.({ threads: [thread({ unreadCount: 2 })] });
		await refresh;

		expect(store.getState().threads[0]?.unreadCount).toBe(0);
	});

	it("renames a thread in both list and detail", async () => {
		const renamed = thread({ title: "Beta", titleSource: "user" });
		const api = {
			list: vi.fn(async () => ({ threads: [thread()] })),
			get: vi.fn(),
			create: vi.fn(),
			markRead: vi.fn(),
			rename: vi.fn(async () => renamed),
		};
		const store = createThreadStore({ api });
		await store.getState().load();
		store.setState({ detail: thread(), detailStatus: "ready" });

		await store.getState().rename("thread:1", "Beta");

		expect(api.rename).toHaveBeenCalledWith("thread:1", "Beta");
		expect(store.getState().threads[0]?.title).toBe("Beta");
		expect(store.getState().detail?.title).toBe("Beta");
	});
});
