import { describe, expect, it, vi } from "vitest";
import { createSessionStore } from "@/domains/session/store.ts";
import { type ApiClient, ApiError } from "@/lib/api/client.ts";

describe("session store", () => {
	it("authenticates and stores the CSRF token", async () => {
		const setToken = vi.fn();
		const client = { get: vi.fn(async () => ({ userId: "operator:1", csrfToken: "csrf" })) } as unknown as Pick<
			ApiClient,
			"get"
		>;
		const store = createSessionStore({ client, setToken });

		await store.getState().load();

		expect(store.getState()).toMatchObject({
			status: "authenticated",
			userId: "operator:1",
			csrfToken: "csrf",
		});
		expect(setToken).toHaveBeenCalledWith("csrf");
	});

	it("treats 401 as unauthenticated and clears the token", async () => {
		const setToken = vi.fn();
		const client = {
			get: vi.fn(async () => {
				throw new ApiError(401, "unauthorized", "missing browser session", undefined);
			}),
		} as unknown as Pick<ApiClient, "get">;
		const store = createSessionStore({ client, setToken });

		await store.getState().load();

		expect(store.getState().status).toBe("unauthenticated");
		expect(setToken).toHaveBeenCalledWith(undefined);
	});

	it("keeps non-401 failures as a retryable error", async () => {
		const setToken = vi.fn();
		const client = { get: vi.fn(async () => Promise.reject(new Error("network down"))) } as unknown as Pick<
			ApiClient,
			"get"
		>;
		const store = createSessionStore({ client, setToken });

		await store.getState().load();

		expect(store.getState()).toMatchObject({ status: "error", error: "network down" });
	});

	it("can be marked unauthenticated by a later 401", () => {
		const setToken = vi.fn();
		const client = { get: vi.fn(async () => ({ userId: "operator:1", csrfToken: "csrf" })) } as unknown as Pick<
			ApiClient,
			"get"
		>;
		const store = createSessionStore({ client, setToken });

		store.getState().markUnauthenticated();

		expect(store.getState().status).toBe("unauthenticated");
		expect(setToken).toHaveBeenCalledWith(undefined);
	});
});
