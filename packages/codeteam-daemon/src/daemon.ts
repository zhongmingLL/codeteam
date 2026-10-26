import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { appendBootRecord, nextBootSequence } from "./boot-ledger.ts";
import { DaemonError } from "./errors.ts";
import { acquireFence, releaseFence } from "./fence.ts";
import { resolveInstallation } from "./installation.ts";
import { resolveDaemonPaths } from "./paths.ts";
import { type DaemonState, type DaemonStateFile, writeStateFile } from "./state.ts";

export interface StartDaemonOptions {
	installationRoot: string;
	dataDir?: string;
	runningRevision: string;
	services?: string[];
	port?: number;
}

export interface DaemonBoot {
	bootId: string;
	bootSequence: number;
	installationId: string;
	runningRevision: string;
}

export interface DaemonHealth {
	status: DaemonState;
	bootId: string;
	installationId: string;
	runningRevision: string;
	services: string[];
}

export interface DaemonHandle {
	boot: DaemonBoot;
	healthUrl: string;
	state(): DaemonState;
	health(): DaemonHealth;
	markReady(input?: { services?: string[] }): void;
	stop(): Promise<void>;
}

export async function startDaemon(options: StartDaemonOptions): Promise<DaemonHandle> {
	const paths = resolveDaemonPaths(options.dataDir);
	const installation = resolveInstallation(options.installationRoot);
	const bootId = randomUUID();
	const bootSequence = nextBootSequence(paths.ledgerFile);
	const declaredServices = [...(options.services ?? [])];
	const startedAt = new Date().toISOString();

	let state: DaemonState = "requested";
	let healthPort: number | null = null;

	const stateSnapshot = (): DaemonStateFile => ({
		schemaVersion: 1,
		installationId: installation.installationId,
		installationRoot: installation.realRoot,
		pid: process.pid,
		bootId,
		bootSequence,
		runningRevision: options.runningRevision,
		state,
		services: declaredServices,
		healthPort,
		startedAt,
		updatedAt: new Date().toISOString(),
	});
	const persist = (): void => writeStateFile(paths.stateFile, stateSnapshot());
	const record = (event: Parameters<typeof appendBootRecord>[1]["event"], detail?: string): void => {
		appendBootRecord(paths.ledgerFile, {
			schemaVersion: 1,
			bootId,
			bootSequence,
			installationId: installation.installationId,
			runningRevision: options.runningRevision,
			event,
			recordedAt: new Date().toISOString(),
			detail,
		});
	};

	const health = (): DaemonHealth => ({
		status: state,
		bootId,
		installationId: installation.installationId,
		runningRevision: options.runningRevision,
		services: [...declaredServices],
	});

	const fence = acquireFence(paths.lockFile, bootId);
	if (fence.reclaimedPid !== null) record("fence_reclaimed", String(fence.reclaimedPid));
	record("started");
	persist();

	let server: Server;
	try {
		server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (request.method === "GET" && url.pathname === "/health") {
				response.writeHead(state === "ready" ? 200 : 503, { "content-type": "application/json" });
				response.end(JSON.stringify(health()));
				return;
			}
			response.writeHead(404, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "not_found" }));
		});
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error): void => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = (): void => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(options.port ?? 0, "127.0.0.1");
		});
	} catch (error) {
		state = "failed";
		persist();
		record("failed", error instanceof Error ? error.message : String(error));
		releaseFence(paths.lockFile, bootId);
		throw new DaemonError(
			"listen_failed",
			`daemon failed to listen on 127.0.0.1:${options.port ?? 0}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const address = server.address();
	healthPort = typeof address === "object" && address !== null ? address.port : null;
	persist();

	let stopPromise: Promise<void> | null = null;

	const markReady = (input?: { services?: string[] }): void => {
		if (state !== "requested") {
			throw new DaemonError("invalid_state", `cannot mark ready in state "${state}"`);
		}
		const reported = [...(input?.services ?? declaredServices)];
		for (const name of reported) {
			if (!declaredServices.includes(name)) {
				throw new DaemonError("undeclared_service", `service "${name}" was not declared at startup`);
			}
		}
		const missing = declaredServices.filter((name) => !reported.includes(name));
		if (missing.length > 0) {
			throw new DaemonError("missing_services", `services not ready: ${missing.join(", ")}`);
		}
		state = "ready";
		persist();
		record("ready", reported.length > 0 ? reported.join(",") : undefined);
	};

	const stop = async (): Promise<void> => {
		if (state === "stopped") return;
		if (stopPromise) return stopPromise;
		state = "stopping";
		persist();
		record("stopping");
		stopPromise = new Promise<void>((resolve) => {
			server.closeAllConnections();
			server.close(() => resolve());
		}).then(() => {
			state = "stopped";
			persist();
			record("stopped");
			releaseFence(paths.lockFile, bootId);
		});
		return stopPromise;
	};

	return {
		boot: {
			bootId,
			bootSequence,
			installationId: installation.installationId,
			runningRevision: options.runningRevision,
		},
		healthUrl: `http://127.0.0.1:${healthPort ?? 0}/health`,
		state: () => state,
		health,
		markReady,
		stop,
	};
}
