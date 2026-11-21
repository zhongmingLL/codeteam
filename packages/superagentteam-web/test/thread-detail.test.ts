import { describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/domains/thread/api";
import { createThreadStore } from "@/domains/thread/store";
import { ApiError } from "@/lib/api/client";

function thread(overrides: Partial<ThreadView> = {}): ThreadView {
	return {
		id: "thread:1",
		projectPath: "/tmp/project",
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

describe("thread detail", () => {
	it("loads the detail endpoint even when the thread is gone from the list", async () => {
		const deleted = thread({ deletedAt: 42 });
		const api = { list: vi.fn(), create: vi.fn(), get: vi.fn(async () => deleted), markRead: vi.fn() };
		const store = createThreadStore({ api });

		await store.getState().loadDetail("thread:1");

		expect(api.get).toHaveBeenCalledWith("thread:1");
		expect(store.getState().detailStatus).toBe("ready");
		expect(store.getState().detail?.deletedAt).toBe(42);
	});

	it("marks a missing thread as not found", async () => {
		const api = {
			list: vi.fn(),
			create: vi.fn(),
			get: vi.fn(async () => Promise.reject(new ApiError(404, "thread_not_found", "not found", {}))),
			markRead: vi.fn(),
		};
		const store = createThreadStore({ api });

		await store.getState().loadDetail("thread:missing");

		expect(store.getState().detailStatus).toBe("not_found");
	});
});
