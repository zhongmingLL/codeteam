import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { consoleLinkUrl, createConsoleToken } from "../src/api/console-link.ts";
import { hasForbiddenIdentityHeaders, isAllowedOrigin, requireCsrf, SessionStore } from "../src/api/session.ts";
import { initOperatorCredential } from "../src/auth/operator.ts";
import { runCli } from "../src/cli/index.ts";
import { type DaemonHandle, startDaemon } from "../src/index.ts";
import { resolveDaemonPaths } from "../src/paths.ts";
import { readStateFile } from "../src/state.ts";

describe("F016c-M1 S1 browser session", () => {
	let root: string;
	let dataDir: string;
	let installationRoot: string;
	let daemon: DaemonHandle | null;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "f016c-s1-session-"));
		dataDir = join(root, "data");
		installationRoot = join(root, "install");
		mkdirSync(installationRoot);
		initOperatorCredential({ dataDir });
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
			runningRevision: "f016c-s1",
			controlPlane: false,
			hubOrigin: "http://localhost:3000",
		});
		daemon.markReady();
		return new URL(daemon.healthUrl).origin;
	}

	it("exchanges a console token for a cookie session and serves /api/session", async () => {
		const base = await start();
		const created = createConsoleToken({ dataDir, ttlMs: 60_000 });
		const response = await fetch(`${base}/auth/console?token=${encodeURIComponent(created.token)}`, {
			redirect: "manual",
		});
		expect(response.status).toBe(302);
		const setCookie = response.headers.get("set-cookie");
		expect(setCookie).toContain("superagentteam_session=");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Strict");
		expect(setCookie).toContain("Max-Age=28800");

		const cookie = setCookie!.split(";")[0]!;
		const session = await fetch(`${base}/api/session`, { headers: { cookie } });
		expect(session.status).toBe(200);
		const sessionBody = (await session.json()) as { userId: string; csrfToken: string };
		expect(sessionBody.userId).toMatch(/^operator:/);
		expect(sessionBody.csrfToken).toBeTruthy();
	});

	it("rejects missing sessions, replayed tokens, and invalid tokens", async () => {
		const base = await start();
		const missing = await fetch(`${base}/api/session`);
		expect(missing.status).toBe(401);
		expect(((await missing.json()) as { relogin_hint?: string }).relogin_hint).toContain("auth console-link");

		const created = createConsoleToken({ dataDir, ttlMs: 60_000 });
		expect(
			(await fetch(`${base}/auth/console?token=${encodeURIComponent(created.token)}`, { redirect: "manual" }))
				.status,
		).toBe(302);
		expect(
			(await fetch(`${base}/auth/console?token=${encodeURIComponent(created.token)}`, { redirect: "manual" }))
				.status,
		).toBe(401);
		expect((await fetch(`${base}/auth/console?token=not-a-token`, { redirect: "manual" })).status).toBe(401);
		expect((await fetch(`${base}/auth/console`, { redirect: "manual" })).status).toBe(401);
	});

	it("rejects transport identity headers on /api/session", async () => {
		const base = await start();
		const response = await fetch(`${base}/api/session`, {
			headers: { authorization: "Bearer forged" },
		});
		expect(response.status).toBe(403);
	});

	it("rejects a disallowed origin on the console exchange", async () => {
		const base = await start();
		const created = createConsoleToken({ dataDir, ttlMs: 60_000 });
		const response = await fetch(`${base}/auth/console?token=${encodeURIComponent(created.token)}`, {
			headers: { origin: "http://evil.example" },
		});
		expect(response.status).toBe(403);
	});

	it("prints a console-link URL from the CLI", async () => {
		const base = await start();
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			expect(await runCli(["auth", "console-link", "--data-dir", dataDir, "--json"])).toBe(0);
			const output = write.mock.calls.map((call) => String(call[0])).join("");
			const parsed = JSON.parse(output) as { url: string };
			const url = new URL(parsed.url);
			expect(url.hostname).toBe("localhost");
			expect(url.port).toBe(new URL(base).port);
			expect(url.pathname).toBe("/auth/console");
		} finally {
			write.mockRestore();
		}
	});

	it("records the Hub origin in daemon state for console-link host selection", async () => {
		await start();
		const state = readStateFile(resolveDaemonPaths(dataDir).stateFile);
		expect(state?.hubOrigin).toBe("http://localhost:3000");
	});
});

describe("SessionStore", () => {
	it("expires idle sessions and refreshes active ones", () => {
		let now = 1_000;
		const store = new SessionStore({ clock: () => now, idleTtlMs: 100, absoluteTtlMs: 1_000 });
		const session = store.create("operator:a", now);
		expect(store.get(session.id, now)?.id).toBe(session.id);
		now = 1_050;
		expect(store.get(session.id, now)?.id).toBe(session.id);
		now = 1_151;
		expect(store.get(session.id, now)).toBeNull();
	});

	it("enforces the absolute TTL even with refreshes", () => {
		let now = 0;
		const store = new SessionStore({ clock: () => now, idleTtlMs: 100, absoluteTtlMs: 300 });
		const session = store.create("operator:a", now);
		for (let step = 0; step < 3; step += 1) {
			now += 90;
			expect(store.get(session.id, now)?.id).toBe(session.id);
		}
		now = 301;
		expect(store.get(session.id, now)).toBeNull();
	});

	it("validates CSRF, origin, and forbidden identity headers", () => {
		const store = new SessionStore({ clock: () => 1 });
		const session = store.create("operator:a", 1);
		expect(requireCsrf(session, session.csrfToken)).toBe(true);
		expect(requireCsrf(session, "wrong")).toBe(false);
		expect(isAllowedOrigin("http://localhost:3000", "http://localhost:3000")).toBe(true);
		expect(isAllowedOrigin("http://evil.example", "http://localhost:3000")).toBe(false);
		expect(isAllowedOrigin(undefined, "http://localhost:3000")).toBe(false);
		expect(hasForbiddenIdentityHeaders({ authorization: "Bearer x" })).toBe(true);
		expect(hasForbiddenIdentityHeaders({ cookie: "superagentteam_session=x" })).toBe(false);
	});
});

describe("consoleLinkUrl", () => {
	it("uses the Hub host rather than the daemon bind address", () => {
		const url = new URL(consoleLinkUrl({ hubOrigin: "http://localhost:3000", port: 3011, token: "abc" }));
		expect(url.hostname).toBe("localhost");
		expect(url.port).toBe("3011");
		expect(url.pathname).toBe("/auth/console");
		expect(url.searchParams.get("token")).toBe("abc");
	});
});
