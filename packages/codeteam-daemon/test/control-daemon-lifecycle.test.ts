import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendBootRecord,
	authorizationPayload,
	initOperatorCredential,
	loadOperatorPrivateKey,
	operatorCredentialPaths,
	type ProcessIdentity,
	type ProcessIdentityProvider,
	type ProcessSignalSender,
	readBootLedger,
	resolveDaemonPaths,
	resolveInstallation,
	type StopHealthProbe,
	type StopHealthResult,
	StopOperationService,
	signOperatorPayload,
	startDaemon,
	writeStateFile,
} from "../src/index.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeProcesses implements ProcessIdentityProvider {
	identities = new Map<number, ProcessIdentity>();
	alive = new Set<number>();
	children = new Map<number, number[]>();

	read(pid: number): ProcessIdentity | null {
		return this.identities.get(pid) ?? null;
	}

	isAlive(pid: number): boolean {
		return this.alive.has(pid);
	}

	descendants(pid: number): number[] {
		return this.children.get(pid) ?? [];
	}
}

class FakeSignals implements ProcessSignalSender {
	sent: { target: number; signal: "SIGTERM" }[] = [];
	processes: FakeProcesses;

	constructor(processes: FakeProcesses) {
		this.processes = processes;
	}

	send(target: number, signal: "SIGTERM"): void {
		this.sent.push({ target, signal });
		this.processes.alive.delete(target);
	}
}

class FakeHealth implements StopHealthProbe {
	result: StopHealthResult = { ok: true };

	async probe(): Promise<StopHealthResult> {
		return this.result;
	}
}

function setup() {
	const root = mkdtempSync(join(tmpdir(), "codeteam-lifecycle-"));
	dirs.push(root);
	const dataDir = join(root, "data");
	const installationRoot = join(root, "install");
	mkdirSync(installationRoot);
	initOperatorCredential({ dataDir });
	const installation = resolveInstallation(installationRoot);
	writeStateFile(resolveDaemonPaths(dataDir).stateFile, {
		schemaVersion: 1,
		deploymentId: "local",
		installationId: installation.installationId,
		installationRoot: installation.realRoot,
		pid: 100,
		bootId: "boot-1",
		bootSequence: 1,
		runningRevision: "a".repeat(40),
		state: "ready",
		services: ["daemon"],
		healthPort: 1234,
		startedAt: "2026-10-28T00:00:00.000Z",
		updatedAt: "2026-10-28T00:00:00.000Z",
	});
	const processes = new FakeProcesses();
	processes.identities.set(100, { pid: 100, startedAt: "100.0", command: "codeteam daemon" });
	processes.identities.set(200, { pid: 200, startedAt: "200.0", command: "codeteam lifecycle" });
	processes.alive.add(100);
	processes.alive.add(200);
	const signals = new FakeSignals(processes);
	const health = new FakeHealth();
	let now = Date.parse("2026-10-28T00:01:00.000Z");
	const service = new StopOperationService({
		dataDir,
		deploymentId: "local",
		installationRoot,
		processProvider: processes,
		signalSender: signals,
		healthProbe: health,
		clock: () => {
			now += 1_000;
			return new Date(now);
		},
		executorPid: 200,
	});
	return { root, dataDir, installationRoot, installation, processes, signals, health, service };
}

function authorization(dataDir: string, action: "halt" | "relaunch", opId = "op-1", stoppedBootId = "boot-1") {
	const privateKey = loadOperatorPrivateKey(dataDir);
	const paths = operatorCredentialPaths(dataDir);
	const payload = authorizationPayload(opId, "local", stoppedBootId, action);
	return {
		opId,
		deploymentId: "local",
		stoppedBootId,
		action,
		operatorRef: "operator:user-1",
		keyFingerprint: paths.fingerprint,
		signature: signOperatorPayload(privateKey, payload),
	};
}

describe("W5d daemon lifecycle", () => {
	it("runs requested -> stopping -> stopped and records the signal", async () => {
		const base = setup();
		const requested = base.service.requestStop(authorization(base.dataDir, "halt"));
		expect(requested.state).toBe("requested");
		const stopped = await base.service.executeStop(requested.opId, { graceMs: 1_000, pollMs: 1 });
		expect(stopped.state).toBe("stopped");
		expect(stopped.history.map((entry) => entry.state)).toEqual(["requested", "stopping", "stopped"]);
		expect(base.signals.sent).toEqual([{ target: 100, signal: "SIGTERM" }]);
		expect(statSync(join(base.dataDir, "lifecycle", "ops")).mode & 0o777).toBe(0o700);
		expect(statSync(join(base.dataDir, "lifecycle", "ops", `${requested.opId}.json`)).mode & 0o777).toBe(0o600);
	});

	it("rejects a forged signature and an executor inside the target tree", () => {
		const base = setup();
		const forged = { ...authorization(base.dataDir, "halt"), signature: "bad" };
		expect(() => base.service.requestStop(forged)).toThrowError(
			expect.objectContaining({ code: "lifecycle_unauthorized" }),
		);

		base.processes.children.set(100, [200]);
		expect(() => base.service.requestStop(authorization(base.dataDir, "halt"))).toThrowError(
			expect.objectContaining({ code: "lifecycle_executor_inside_target" }),
		);
	});

	it("fails closed when frozen identity changes before the signal", async () => {
		const base = setup();
		const requested = base.service.requestStop(authorization(base.dataDir, "halt"));
		base.processes.identities.set(100, { pid: 100, startedAt: "different", command: "codeteam daemon" });
		await expect(base.service.executeStop(requested.opId, { graceMs: 10, pollMs: 1 })).rejects.toMatchObject({
			code: "lifecycle_identity_mismatch",
		});
		expect(base.service.status().latestOperation?.state).toBe("failed");
	});

	it("authorizes, records and reverifies a new daemon incarnation", async () => {
		const base = setup();
		const requested = base.service.requestStop(authorization(base.dataDir, "halt"));
		await base.service.executeStop(requested.opId, { graceMs: 1_000, pollMs: 1 });
		const authorized = base.service.authorizeRestart(requested.opId, authorization(base.dataDir, "relaunch"));
		expect(authorized.state).toBe("restart_authorized");
		const daemonPaths = resolveDaemonPaths(base.dataDir);
		writeStateFile(daemonPaths.stateFile, {
			schemaVersion: 1,
			deploymentId: "local",
			installationId: base.installation.installationId,
			installationRoot: base.installation.realRoot,
			pid: 300,
			bootId: "boot-2",
			bootSequence: 2,
			runningRevision: "a".repeat(40),
			state: "ready",
			services: ["daemon"],
			healthPort: 1234,
			startedAt: "2026-10-28T00:02:00.000Z",
			updatedAt: "2026-10-28T00:02:00.000Z",
		});
		appendBootRecord(daemonPaths.ledgerFile, {
			schemaVersion: 1,
			bootId: "boot-2",
			bootSequence: 2,
			deploymentId: "local",
			installationId: base.installation.installationId,
			runningRevision: "a".repeat(40),
			event: "started",
			recordedAt: "2026-10-28T00:02:00.000Z",
		});
		base.processes.identities.set(300, { pid: 300, startedAt: "300.0", command: "codeteam daemon" });
		base.processes.alive.add(300);
		const restarted = base.service.recordRestart(requested.opId, {
			bootId: "boot-2",
			processId: 300,
			startedAt: "300.0",
			command: "codeteam daemon",
			installationId: base.installation.installationId,
		});
		expect(restarted.state).toBe("restarted");
		const reverified = await base.service.reverify(requested.opId, "http://127.0.0.1:1234/health");
		expect(reverified.state).toBe("reverified");
		expect(reverified.reverification).toMatchObject({ bootId: "boot-2", processId: 300, ok: true });
		expect(reverified.history.map((entry) => entry.state)).toEqual([
			"requested",
			"stopping",
			"stopped",
			"restart_authorized",
			"restarted",
			"reverified",
		]);
	});

	it("clears stale lifecycle state only with operator authorization", () => {
		const base = setup();
		const requested = base.service.requestStop(authorization(base.dataDir, "halt"));
		const cleared = base.service.staleClear(requested.opId, authorization(base.dataDir, "halt"));
		expect(cleared.state).toBe("stale_cleared");
		expect(() => base.service.staleClear(requested.opId, authorization(base.dataDir, "halt"))).toThrowError(
			expect.objectContaining({ code: "lifecycle_state_invalid" }),
		);
	});

	it("records deploymentId, health identity and clean exit evidence", async () => {
		const root = mkdtempSync(join(tmpdir(), "codeteam-lifecycle-boot-"));
		dirs.push(root);
		const dataDir = join(root, "data");
		const installationRoot = join(root, "install");
		mkdirSync(installationRoot);
		const daemon = await startDaemon({
			installationRoot,
			dataDir,
			deploymentId: "local",
			runningRevision: "a".repeat(40),
			services: ["daemon"],
		});
		daemon.markReady();
		expect(daemon.health()).toMatchObject({
			status: "ready",
			deploymentId: "local",
			pid: process.pid,
			bootSequence: 1,
			services: ["daemon"],
		});
		await daemon.stop();
		const ledger = readBootLedger(join(dataDir, "boot-ledger.jsonl"));
		expect(ledger.some((record) => record.event === "exited" && record.exitKind === "clean")).toBe(true);
	});
});
