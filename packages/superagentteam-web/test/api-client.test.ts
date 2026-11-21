import { describe, expect, it, vi } from "vitest";

import { ApiError, createApiClient } from "@/lib/api/client.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("api client", () => {
	it("loads JSON with credentials and returns the parsed body", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ userId: "operator:1", csrfToken: "csrf" }));
		const client = createApiClient({
			fetchImpl: fetchImpl as unknown as typeof fetch,
			getCsrfToken: () => "csrf",
		});

		await expect(client.get<{ userId: string }>("/api/session")).resolves.toMatchObject({
			userId: "operator:1",
		});
		expect(fetchImpl).toHaveBeenCalledWith("/api/session", expect.objectContaining({ credentials: "include" }));
	});

	it("adds the CSRF token to writes", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ id: "thread:1" }));
		const client = createApiClient({
			fetchImpl: fetchImpl as unknown as typeof fetch,
			getCsrfToken: () => "csrf-1",
		});

		await client.post("/api/threads", { projectPath: "/tmp/p", idempotencyKey: "k" });

		const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
		const headers = new Headers(init?.headers);
		expect(headers.get("x-csrf-token")).toBe("csrf-1");
		expect(init?.body).toBe(JSON.stringify({ projectPath: "/tmp/p", idempotencyKey: "k" }));
	});

	it("throws a typed error for 401", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ error: "unauthorized", message: "missing browser session" }, 401),
		);
		const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

		await expect(client.get("/api/session")).rejects.toMatchObject({
			name: "ApiError",
			status: 401,
			code: "unauthorized",
			message: "missing browser session",
		});
	});

	it("keeps non-JSON error bodies observable", async () => {
		const fetchImpl = vi.fn(async () => new Response("<html>oops</html>", { status: 500 }));
		const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

		const error = await client.get("/api/session").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 500, code: "http_500", body: "<html>oops</html>" });
	});
});
