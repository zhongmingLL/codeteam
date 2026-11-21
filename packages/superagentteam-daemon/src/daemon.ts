import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { type BrowserApi, createBrowserApi } from "./api/browser.ts";
import { createStaticHandler } from "./api/static.ts";
import { appendBootRecord, nextBootSequence } from "./boot-ledger.ts";
import { A2ADaemonControlPlane, type A2ADaemonControlPlaneOptions } from "./daemon-a2a.ts";
import { DaemonControlPlane, type DaemonControlPlaneOptions } from "./daemon-runtime.ts";
import { ChangeBus } from "./domains/events/bus.ts";
import { envValue } from "./env.ts";
import { DaemonError } from "./errors.ts";
import { acquireFence, releaseFence } from "./fence.ts";
import { resolveInstallation } from "./installation.ts";
import type { ReadyStatus } from "./observability/contracts.ts";
import {
	createObservabilityRuntime,
	disabledObservabilityRuntime,
	type ObservabilityRuntime,
} from "./observability/runtime.ts";
import { resolveDaemonPaths } from "./paths.ts";
import { type DaemonState, type DaemonStateFile, writeStateFile } from "./state.ts";

export interface StartDaemonOptions {
	installationRoot: string;
	dataDir?: string;
	deploymentId?: string;
	runningRevision: string;
	services?: string[];
	port?: number;
	/** Directory containing the built SPA; false disables static serving. */
	staticDir?: string | false;
	/** SSE heartbeat interval for tests/dev; defaults to 15s. */
	eventHeartbeatMs?: number;
	/** Defaults to a local observability runtime; pass false to disable telemetry. */
	observability?: ObservabilityRuntime | false;
	/** Legacy task-first control plane (frozen); use {} for its defaults. */
	controlPlane?: Omit<DaemonControlPlaneOptions, "dataDir"> | false;
	/** A2A runtime control plane; the default when neither option is provided. */
	a2aControlPlane?: Omit<A2ADaemonControlPlaneOptions, "dataDir"> | false;
	/** Hub origin allowed to use the browser API; defaults to SUPERAGENTTEAM_HUB_ORIGIN or http://localhost:3000. */
	hubOrigin?: string;
	/** Set Secure on browser session cookies when the Hub is served over https. */
	secureCookies?: boolean;
}

export interface DaemonBoot {
	bootId: string;
	bootSequence: number;
	deploymentId: string;
	installationId: string;
	runningRevision: string;
}

export interface DaemonHealth {
	status: DaemonState;
	bootId: string;
	bootSequence: number;
	deploymentId: string;
	pid: number;
	installationId: string;
	runningRevision: string;
	services: string[];
	startedAt: string;
}

const DEPLOYMENT_ID = /^[a-z][a-z0-9._-]{0,63}$/;

function validateDeploymentId(value: string | undefined): string {
	const deploymentId = value ?? envValue(process.env, "DEPLOYMENT_ID") ?? "local";
	if (!DEPLOYMENT_ID.test(deploymentId)) {
		throw new DaemonError(
			"invalid_deployment_id",
			`deploymentId must match ${DEPLOYMENT_ID.source}: ${deploymentId}`,
		);
	}
	return deploymentId;
}

export interface DaemonHandle {
	boot: DaemonBoot;
	healthUrl: string;
	observability: ObservabilityRuntime;
	controlPlane: DaemonControlPlane | null;
	a2aControlPlane: A2ADaemonControlPlane | null;
	state(): DaemonState;
	health(): DaemonHealth;
	markReady(input?: { services?: string[] }): void;
	stop(): Promise<void>;
	close(): Promise<void>;
}

function resolveStaticDir(input: string | false | undefined): string | null {
	if (input === false) return null;
	if (typeof input === "string" && input.trim() !== "") return input;
	const configured = envValue(process.env, "SUPERAGENTTEAM_STATIC_DIR");
	if (configured !== undefined) {
		const value = configured.trim();
		if (value === "" || value === "off" || value === "false" || value === "0") return null;
		return value;
	}
	return join(import.meta.dirname, "..", "..", "superagentteam-web", "dist");
}

function originPort(origin: string | undefined): string | null {
	if (origin === undefined) return null;
	try {
		const url = new URL(origin);
		if (url.port !== "") return url.port;
		return url.protocol === "https:" ? "443" : "80";
	} catch {
		return null;
	}
}

export async function startDaemon(options: StartDaemonOptions): Promise<DaemonHandle> {
	const paths = resolveDaemonPaths(options.dataDir);
	const installation = resolveInstallation(options.installationRoot);
	const deploymentId = validateDeploymentId(options.deploymentId);
	const legacyRequested = typeof options.controlPlane === "object" && options.controlPlane !== null;
	const a2aRequested = options.a2aControlPlane !== undefined && options.a2aControlPlane !== false;
	const defaultEntry = options.controlPlane === undefined && options.a2aControlPlane === undefined;
	if (a2aRequested && legacyRequested) {
		throw new DaemonError("invalid_state", "controlPlane and a2aControlPlane are mutually exclusive");
	}
	const useA2A = a2aRequested || defaultEntry;
	const useLegacy = legacyRequested;
	const bootId = randomUUID();
	const bootSequence = nextBootSequence(paths.ledgerFile);
	const declaredServices = [...(options.services ?? [])];
	const startedAt = new Date().toISOString();
	const configuredHubOrigin = options.hubOrigin ?? envValue(process.env, "HUB_ORIGIN");
	let hubOrigin = configuredHubOrigin ?? "http://localhost:3000";
	const staticRoot = resolveStaticDir(options.staticDir);
	const staticHandler = staticRoot ? createStaticHandler(staticRoot) : null;
	const changeBus = new ChangeBus();

	let state: DaemonState = "requested";
	let healthPort: number | null = null;

	const stateSnapshot = (): DaemonStateFile => ({
		schemaVersion: 1,
		deploymentId,
		installationId: installation.installationId,
		installationRoot: installation.realRoot,
		pid: process.pid,
		bootId,
		bootSequence,
		runningRevision: options.runningRevision,
		state,
		services: declaredServices,
		healthPort,
		hubOrigin,
		startedAt,
		updatedAt: new Date().toISOString(),
	});
	const persist = (): void => writeStateFile(paths.stateFile, stateSnapshot());
	const record = (
		event: Parameters<typeof appendBootRecord>[1]["event"],
		detail?: string,
		exitKind?: "clean" | "startup_failed",
	): void => {
		appendBootRecord(paths.ledgerFile, {
			schemaVersion: 1,
			bootId,
			bootSequence,
			deploymentId,
			installationId: installation.installationId,
			runningRevision: options.runningRevision,
			event,
			recordedAt: new Date().toISOString(),
			detail,
			exitKind,
		});
	};

	const health = (): DaemonHealth => ({
		status: state,
		bootId,
		bootSequence,
		deploymentId,
		pid: process.pid,
		installationId: installation.installationId,
		runningRevision: options.runningRevision,
		services: [...declaredServices],
		startedAt,
	});

	const fence = acquireFence(paths.lockFile, bootId);
	if (fence.reclaimedPid !== null) record("fence_reclaimed", String(fence.reclaimedPid));
	record("started");
	persist();
	const observability = createRuntime(options, paths.dataDir);

	let controlPlane: DaemonControlPlane | null = null;
	let a2aControlPlane: A2ADaemonControlPlane | null = null;
	if (useA2A || useLegacy) {
		try {
			if (useA2A) {
				const a2aOptions =
					options.a2aControlPlane === undefined || options.a2aControlPlane === false
						? {}
						: options.a2aControlPlane;
				a2aControlPlane = new A2ADaemonControlPlane({
					...a2aOptions,
					dataDir: paths.dataDir,
					changeBus,
				});
				await a2aControlPlane.start();
			} else {
				const legacyOptions =
					options.controlPlane === false || options.controlPlane === undefined ? {} : options.controlPlane;
				controlPlane = new DaemonControlPlane({ ...legacyOptions, dataDir: paths.dataDir });
				await controlPlane.start();
			}
		} catch (error) {
			state = "failed";
			persist();
			record("failed", error instanceof Error ? error.message : String(error), "startup_failed");
			record("exited", "startup_failed", "startup_failed");
			await a2aControlPlane?.close().catch(() => {});
			await controlPlane?.close().catch(() => {});
			releaseFence(paths.lockFile, bootId);
			await observability.close();
			throw new DaemonError(
				"control_plane_failed",
				`daemon control plane failed to start: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const readyStatus = (): ReadyStatus => {
		if (state === "failed") return "failed";
		if (state === "stopping" || state === "stopped") return "stopping";
		if (state !== "ready") return "starting";
		if (controlPlane && !controlPlane.ready().started) return "degraded";
		if (a2aControlPlane && !a2aControlPlane.ready().started) return "degraded";
		return observability.readiness().status === "ready" ? "ready" : "degraded";
	};

	const ready = () => ({
		...health(),
		status: readyStatus(),
		telemetry: observability.readiness(),
		controlPlane: controlPlane?.ready() ?? null,
		a2aControlPlane: a2aControlPlane?.ready() ?? null,
	});

	let browserApi: BrowserApi | null = null;
	let serveStatic = false;

	let server: Server;
	try {
		async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (browserApi && (await browserApi.handle(request, response))) return;
			if (request.method === "GET" && url.pathname === "/health") {
				response.writeHead(state === "ready" ? 200 : 503, { "content-type": "application/json" });
				response.end(JSON.stringify(health()));
				return;
			}
			if (request.method === "GET" && url.pathname === "/ready") {
				response.writeHead(state === "ready" ? 200 : 503, { "content-type": "application/json" });
				response.end(JSON.stringify(ready()));
				return;
			}
			if (request.method === "GET" && url.pathname === "/metrics") {
				const readiness = observability.readiness();
				if (readiness.metrics.status !== "ready") {
					response.writeHead(503, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: "metrics_unavailable", reason: readiness.metrics.reason }));
					return;
				}
				response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
				response.end(observability.metrics.renderPrometheus());
				return;
			}
			if (serveStatic && staticHandler?.handle(request, response, url)) return;
			response.writeHead(404, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "not_found" }));
		}
		server = createServer((request, response) => {
			void handleRequest(request, response).catch(() => {
				if (!response.headersSent) {
					response.writeHead(500, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: "internal_error" }));
				} else {
					response.destroy();
				}
			});
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
		record("failed", error instanceof Error ? error.message : String(error), "startup_failed");
		record("exited", "startup_failed", "startup_failed");
		await a2aControlPlane?.close().catch(() => {});
		await controlPlane?.close().catch(() => {});
		releaseFence(paths.lockFile, bootId);
		await observability.close();
		throw new DaemonError(
			"listen_failed",
			`daemon failed to listen on 127.0.0.1:${options.port ?? 0}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const address = server.address();
	healthPort = typeof address === "object" && address !== null ? address.port : null;
	serveStatic =
		staticHandler !== null &&
		(configuredHubOrigin === undefined || originPort(configuredHubOrigin) === String(healthPort));
	if (serveStatic && configuredHubOrigin === undefined) hubOrigin = `http://localhost:${healthPort}`;
	persist();
	browserApi = createBrowserApi({
		dataDir: paths.dataDir,
		hubOrigin,
		consoleRedirect: serveStatic ? "/" : undefined,
		secureCookies: options.secureCookies ?? false,
		changeBus,
		eventHeartbeatMs: options.eventHeartbeatMs,
		a2a: a2aControlPlane ? { runtime: a2aControlPlane.runtime, registry: a2aControlPlane.registry } : undefined,
	});

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
		stopPromise = (async () => {
			await new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			});
			await a2aControlPlane?.close().catch(() => {});
			await controlPlane?.close().catch(() => {});
			state = "stopped";
			persist();
			record("stopped");
			record("exited", "clean", "clean");
			releaseFence(paths.lockFile, bootId);
			await observability.close();
		})();
		return stopPromise;
	};

	return {
		boot: {
			bootId,
			bootSequence,
			deploymentId,
			installationId: installation.installationId,
			runningRevision: options.runningRevision,
		},
		healthUrl: `http://127.0.0.1:${healthPort ?? 0}/health`,
		observability,
		controlPlane,
		a2aControlPlane,
		state: () => state,
		health,
		markReady,
		stop,
		close: stop,
	};
}

function createRuntime(options: StartDaemonOptions, dataDir: string): ObservabilityRuntime {
	if (options.observability === false) return disabledObservabilityRuntime("disabled_by_option");
	if (options.observability) return options.observability;
	try {
		return createObservabilityRuntime({ dataDir });
	} catch (error) {
		return disabledObservabilityRuntime(error instanceof Error ? error.message : String(error));
	}
}
