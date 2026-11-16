import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createObservabilityRuntime,
	type DaemonHandle,
	disabledObservabilityRuntime,
	startDaemon,
} from "../src/index.ts";

describe("W6c daemon readiness and metrics", () => {
	let root: string;
	let dataDir: string;
	let installationRoot: string;
	const running: DaemonHandle[] = [];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "codeteam-obs-ready-"));
		dataDir = join(root, "data");
		installationRoot = join(root, "install");
		mkdirSync(installationRoot);
	});

	afterEach(async () => {
		for (const daemon of running.splice(0)) await daemon.stop();
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

	function endpoint(daemon: DaemonHandle, path: string): string {
		return `${daemon.healthUrl.replace(/\/health$/, "")}${path}`;
	}

	it("reports ready and serves a Prometheus snapshot after markReady", async () => {
		const daemon = await start();
		daemon.markReady();
		const ready = await fetch(endpoint(daemon, "/ready"));
		expect(ready.status).toBe(200);
		const body = (await ready.json()) as ReadyBody;
		expect(body.status).toBe("ready");
		expect(body.telemetry.status).toBe("ready");
		expect(body.telemetry.trace.maxSpans).toBe(10_000);
		expect(body.telemetry.trace.maxAgeMs).toBe(86_400_000);
		expect(body.telemetry.logs.status).toBe("ready");
		expect(body.telemetry.otlp.status).toBe("disabled");

		const metrics = await fetch(endpoint(daemon, "/metrics"));
		expect(metrics.status).toBe(200);
		expect(metrics.headers.get("content-type")).toContain("text/plain");
		expect(await metrics.text()).toContain("codeteam_telemetry_up 1");

		const health = await fetch(daemon.healthUrl);
		expect(health.status).toBe(200);
		expect(((await health.json()) as Record<string, unknown>).status).toBe("ready");
	});

	it("keeps /ready at 503 before the daemon is ready", async () => {
		const daemon = await start();
		const ready = await fetch(endpoint(daemon, "/ready"));
		expect(ready.status).toBe(503);
		expect(((await ready.json()) as Record<string, unknown>).status).toBe("starting");
	});

	it("reports degraded telemetry without failing the control plane", async () => {
		const daemon = await start({ observability: disabledObservabilityRuntime("test_disabled") });
		daemon.markReady();
		const ready = await fetch(endpoint(daemon, "/ready"));
		expect(ready.status).toBe(200);
		const body = (await ready.json()) as ReadyBody;
		expect(body.status).toBe("degraded");
		expect(body.telemetry.status).toBe("disabled");
		expect(body.telemetry.trace.status).toBe("disabled");
		expect(body.telemetry.trace.reason).toBe("test_disabled");
		expect((await fetch(endpoint(daemon, "/metrics"))).status).toBe(503);
	});

	it("degrades trace but keeps logs when the salt permissions are wrong", async () => {
		mkdirSync(dataDir, { recursive: true });
		const saltPath = join(dataDir, "telemetry-salt");
		writeFileSync(saltPath, Buffer.alloc(32, 7), { mode: 0o644 });
		if (process.platform !== "win32") chmodSync(saltPath, 0o644);
		const runtime = createObservabilityRuntime({ dataDir, env: {} });
		const daemon = await start({ observability: runtime });
		daemon.markReady();
		const body = (await (await fetch(endpoint(daemon, "/ready"))).json()) as ReadyBody;
		expect(body.status).toBe("degraded");
		expect(body.telemetry.status).toBe("degraded");
		expect(body.telemetry.trace.status).toBe("disabled");
		expect(body.telemetry.trace.reason).toContain("telemetry_salt_permissions_invalid");
		expect(body.telemetry.logs.status).toBe("ready");
	});
});

interface ReadyBody {
	status: string;
	telemetry: {
		status: string;
		trace: { status: string; maxSpans: number; maxAgeMs: number; reason?: string };
		logs: { status: string };
		otlp: { status: string };
	};
}
