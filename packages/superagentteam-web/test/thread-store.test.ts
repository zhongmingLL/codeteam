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
		};
		const store = createThreadStore({ api });

		await store.getState().load();

		expect(store.getState()).toMatchObject({ status: "error", error: "daemon down" });
	});
});
