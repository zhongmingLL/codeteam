import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DaemonError,
	type DaemonHandle,
	readBootLedger,
	readStateFile,
	resolveInstallation,
	startDaemon,
} from "../src/index.ts";

describe("codeteam daemon lifecycle", () => {
	let root: string;
	let dataDir: string;
	let installationRoot: string;
	let running: DaemonHandle[];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "codeteam-daemon-"));
		dataDir = join(root, "data");
		installationRoot = join(root, "install");
		mkdirSync(installationRoot);
		running = [];
	});

	afterEach(async () => {
		for (const daemon of running) {
			await daemon.stop();
		}
		rmSync(root, { recursive: true, force: true });
	});

	async function start(overrides: Partial<Parameters<typeof startDaemon>[0]> = {}): Promise<DaemonHandle> {
		const daemon = await startDaemon({
			installationRoot,
			dataDir,
			runningRevision: "rev-1",
			...overrides,
		});
		running.push(daemon);
		return daemon;
	}

	it("fails closed when CODETEAM_DATA_DIR is not provided", async () => {
		const previous = process.env.CODETEAM_DATA_DIR;
		delete process.env.CODETEAM_DATA_DIR;
		try {
			await expect(startDaemon({ installationRoot, runningRevision: "rev-1" })).rejects.toMatchObject({
				code: "data_dir_missing",
			});
		} finally {
			if (previous !== undefined) process.env.CODETEAM_DATA_DIR = previous;
		}
	});

	it("creates a 0700 data dir and 0600 state/ledger files", async () => {
		const daemon = await start();
		expect(statSync(dataDir).mode & 0o777).toBe(0o700);
		expect(statSync(join(dataDir, "daemon-state.json")).mode & 0o777).toBe(0o600);
		expect(statSync(join(dataDir, "boot-ledger.jsonl")).mode & 0o777).toBe(0o600);
		expect(statSync(join(dataDir, "daemon.lock")).mode & 0o777).toBe(0o600);
		expect(daemon.boot.bootSequence).toBe(1);
	});

	it("derives a stable installation id from the real path", () => {
		const first = resolveInstallation(installationRoot);
		const second = resolveInstallation(join(installationRoot, "."));
		const other = resolveInstallation(root);
		expect(first.installationId).toBe(second.installationId);
		expect(first.installationId).toMatch(/^[0-9a-f]{64}$/);
		expect(other.installationId).not.toBe(first.installationId);
		expect(() => resolveInstallation(join(root, "missing"))).toThrow(DaemonError);
	});

	it("appends boot records and increments the sequence across restarts", async () => {
		const first = await start();
		await first.stop();
		const second = await start();

		const ledger = readBootLedger(join(dataDir, "boot-ledger.jsonl"));
		const started = ledger.filter((record) => record.event === "started");
		expect(started.map((record) => record.bootSequence)).toEqual([1, 2]);
		expect(started[1]?.runningRevision).toBe("rev-1");
		expect(second.boot.bootSequence).toBe(2);
	});

	it("fails with a typed ledger_corrupt error, leaves no fence, and recovers after repair", async () => {
		mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		const ledgerPath = join(dataDir, "boot-ledger.jsonl");
		writeFileSync(ledgerPath, '{"broken":\n', { mode: 0o600 });

		await expect(start()).rejects.toMatchObject({ code: "ledger_corrupt" });
		expect(existsSync(join(dataDir, "daemon.lock"))).toBe(false);

		writeFileSync(ledgerPath, "", { mode: 0o600 });
		const daemon = await start();
		expect(daemon.boot.bootSequence).toBe(1);
	});

	it("rejects a second daemon on the same data dir", async () => {
		await start();
		await expect(start()).rejects.toMatchObject({ code: "already_running" });
	});

	it("reclaims a fence left by a dead process and records it", async () => {
		mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		writeFileSync(
			join(dataDir, "daemon.lock"),
			JSON.stringify({ schemaVersion: 1, pid: 999_999, bootId: "dead", createdAt: new Date().toISOString() }),
			{ mode: 0o600 },
		);

		const daemon = await start();
		expect(daemon.boot.bootSequence).toBe(1);
		const ledger = readBootLedger(join(dataDir, "boot-ledger.jsonl"));
		expect(ledger).toContainEqual(expect.objectContaining({ event: "fence_reclaimed", detail: "999999" }));
	});

	it("reports 503 until markReady, then 200 with boot identity", async () => {
		const daemon = await start({ services: ["api"] });

		const before = await fetch(daemon.healthUrl);
		expect(before.status).toBe(503);
		expect((await before.json()).status).toBe("requested");

		daemon.markReady();
		const after = await fetch(daemon.healthUrl);
		expect(after.status).toBe(200);
		const body = await after.json();
		expect(body).toMatchObject({
			status: "ready",
			bootId: daemon.boot.bootId,
			installationId: daemon.boot.installationId,
			runningRevision: "rev-1",
		});

		const state = readStateFile(join(dataDir, "daemon-state.json"));
		expect(state?.state).toBe("ready");
		expect(state?.services).toEqual(["api"]);
	});

	it("fails closed when markReady reports missing or undeclared services", async () => {
		const daemon = await start({ services: ["api", "web"] });
		expect(() => daemon.markReady({ services: ["api"] })).toThrow(
			expect.objectContaining({ code: "missing_services" }),
		);
		expect(() => daemon.markReady({ services: ["api", "web", "extra"] })).toThrow(
			expect.objectContaining({ code: "undeclared_service" }),
		);
		expect(daemon.state()).toBe("requested");
	});

	it("stops through stopping to stopped, releases the fence, and refuses late readiness", async () => {
		const daemon = await start();
		daemon.markReady();
		await daemon.stop();

		const state = readStateFile(join(dataDir, "daemon-state.json"));
		expect(state?.state).toBe("stopped");
		expect(existsSync(join(dataDir, "daemon.lock"))).toBe(false);
		await expect(fetch(daemon.healthUrl)).rejects.toBeTruthy();
		expect(() => daemon.markReady()).toThrow(expect.objectContaining({ code: "invalid_state" }));
		await daemon.stop();

		const records = readBootLedger(join(dataDir, "boot-ledger.jsonl"));
		expect(records.map((record) => record.event)).toEqual(["started", "ready", "stopping", "stopped", "exited"]);
		expect(records.at(-1)?.exitKind).toBe("clean");
	});

	it("records a failed boot and releases the fence when the port is taken", async () => {
		const blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
		const address = blocker.address();
		if (typeof address !== "object" || address === null) throw new Error("no port");
		try {
			await expect(start({ port: address.port })).rejects.toBeInstanceOf(DaemonError);
			expect(existsSync(join(dataDir, "daemon.lock"))).toBe(false);
			const ledger = readBootLedger(join(dataDir, "boot-ledger.jsonl"));
			expect(ledger.map((record) => record.event)).toContain("failed");
			const state = JSON.parse(readFileSync(join(dataDir, "daemon-state.json"), "utf8"));
			expect(state.state).toBe("failed");
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});
});
