import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConsoleToken } from "../src/api/console-link.ts";
import { initOperatorCredential } from "../src/auth/operator.ts";
import { type DaemonHandle, startDaemon } from "../src/index.ts";

function rawGet(origin: string, path: string): Promise<{ status: number; body: string }> {
	const url = new URL(origin);
	return new Promise((resolve, reject) => {
		const req = request({ hostname: url.hostname, port: url.port, path, method: "GET" }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				body += chunk;
			});
			response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

describe("F020 H5 static SPA serving", () => {
	let root: string;
	let dataDir: string;
	let installationRoot: string;
	let staticDir: string;
	let daemon: DaemonHandle | null;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "f020-h5-static-"));
		dataDir = join(root, "data");
		installationRoot = join(root, "install");
		staticDir = join(root, "web");
		mkdirSync(installationRoot);
		mkdirSync(join(staticDir, "assets"), { recursive: true });
		writeFileSync(
			join(staticDir, "index.html"),
			'<!doctype html><html><body><div id="root">thin hub</div></body></html>',
		);
		writeFileSync(join(staticDir, "assets", "app.js"), 'console.log("thin hub");');
		initOperatorCredential({ dataDir });
		writeFileSync(
			join(dataDir, "agent-catalog.json"),
			JSON.stringify({
				version: 1,
				agents: [
					{
						id: "a1",
						mentionPatterns: ["@a1"],
						displayName: "Agent A1",
						contextWindow: 128_000,
						roleId: "worker",
						roleDescription: "static test",
						restrictions: [],
						strengths: [],
						accountRef: "main",
						defaultModel: "m1",
						sessionChain: true,
						enabled: true,
					},
				],
			}),
		);
		writeFileSync(
			join(dataDir, "accounts.json"),
			JSON.stringify([{ ref: "main", provider: "pi", apiKeyRef: "KEY", models: ["m1"] }]),
		);
		daemon = null;
	});

	afterEach(async () => {
		await daemon?.stop();
		daemon = null;
		rmSync(root, { recursive: true, force: true });
	});

	async function start(): Promise<string> {
		daemon = await startDaemon({
			installationRoot,
			dataDir,
			runningRevision: "f020-h5",
			controlPlane: false,
			staticDir,
			a2aControlPlane: { pollIntervalMs: 3_600_000, sweepIntervalMs: 3_600_000 },
		});
		daemon.markReady();
		const port = new URL(daemon.healthUrl).port;
		return `http://localhost:${port}`;
	}

	async function login(origin: string): Promise<{ cookie: string; csrfToken: string }> {
		const created = createConsoleToken({ dataDir, ttlMs: 60_000 });
		const exchange = await fetch(`${origin}/auth/console?token=${encodeURIComponent(created.token)}`, {
			redirect: "manual",
		});
		const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
		const session = await fetch(`${origin}/api/session`, { headers: { cookie } });
		const body = (await session.json()) as { csrfToken: string };
		return { cookie, csrfToken: body.csrfToken };
	}

	it("serves the SPA shell, hashed assets, and SPA fallback routes", async () => {
		const origin = await start();

		const index = await fetch(`${origin}/`);
		expect(index.status).toBe(200);
		expect(index.headers.get("content-type")).toContain("text/html");
		expect(await index.text()).toContain("thin hub");

		const fallback = await fetch(`${origin}/thread/thread%3Aabc`);
		expect(fallback.status).toBe(200);
		expect(await fallback.text()).toContain("thin hub");

		const asset = await fetch(`${origin}/assets/app.js`);
		expect(asset.status).toBe(200);
		expect(asset.headers.get("content-type")).toContain("text/javascript");
		expect(asset.headers.get("cache-control")).toContain("immutable");

		const head = await fetch(`${origin}/assets/app.js`, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
	});

	it("returns 404 for non-dist files, directory probes, and path traversal", async () => {
		const origin = await start();

		expect((await fetch(`${origin}/package.json`)).status).toBe(404);
		expect((await fetch(`${origin}/assets/missing.js`)).status).toBe(404);
		expect((await fetch(`${origin}/assets`)).status).toBe(404);
		expect((await rawGet(origin, "/..%2fpackage.json")).status).toBe(404);
		expect((await rawGet(origin, "/%2e%2e%2fhosts")).status).toBe(404);
	});

	it("keeps /api/* as JSON and redirects console-link to /", async () => {
		const origin = await start();
		const auth = await login(origin);

		const unknown = await fetch(`${origin}/api/unknown`, {
			headers: { cookie: auth.cookie, origin },
		});
		expect(unknown.status).toBe(404);
		expect(unknown.headers.get("content-type")).toContain("application/json");
		expect(((await unknown.json()) as { error: string }).error).toBe("not_found");

		const created = createConsoleToken({ dataDir, ttlMs: 60_000 });
		const exchange = await fetch(`${origin}/auth/console?token=${encodeURIComponent(created.token)}`, {
			redirect: "manual",
		});
		expect(exchange.status).toBe(302);
		expect(exchange.headers.get("location")).toBe("/");
	});

	it("keeps an explicit external Hub origin on the Vite dev path", async () => {
		daemon = await startDaemon({
			installationRoot,
			dataDir,
			runningRevision: "f020-h5-dev",
			controlPlane: false,
			staticDir,
			hubOrigin: "http://localhost:3000",
			a2aControlPlane: { pollIntervalMs: 3_600_000, sweepIntervalMs: 3_600_000 },
		});
		daemon.markReady();
		const port = new URL(daemon.healthUrl).port;
		const origin = `http://localhost:${port}`;

		expect((await fetch(`${origin}/`)).status).toBe(404);
		const created = createConsoleToken({ dataDir, ttlMs: 60_000 });
		const exchange = await fetch(`${origin}/auth/console?token=${encodeURIComponent(created.token)}`, {
			redirect: "manual",
		});
		expect(exchange.status).toBe(302);
		expect(exchange.headers.get("location")).toBe("http://localhost:3000");
	});
});
