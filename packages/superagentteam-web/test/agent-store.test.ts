import { describe, expect, it, vi } from "vitest";

import { createAgentStore } from "@/domains/agent/store";

describe("agent store", () => {
	it("loads global agent status", async () => {
		const api = {
			list: vi.fn(async () => ({
				agents: [{ id: "a1", displayName: "Agent A1", enabled: true, status: "idle" as const }],
			})),
		};
		const store = createAgentStore({ api });

		await store.getState().load();

		expect(store.getState().status).toBe("ready");
		expect(store.getState().agents).toHaveLength(1);
	});

	it("keeps the last agents when refresh fails", async () => {
		const api = {
			list: vi
				.fn()
				.mockResolvedValueOnce({ agents: [{ id: "a1", displayName: "Agent A1", enabled: true }] })
				.mockRejectedValueOnce(new Error("daemon down")),
		};
		const store = createAgentStore({ api });
		await store.getState().load();

		await store.getState().refresh();

		expect(store.getState().agents).toHaveLength(1);
		expect(store.getState()).toMatchObject({ status: "ready", error: "daemon down" });
	});
});
