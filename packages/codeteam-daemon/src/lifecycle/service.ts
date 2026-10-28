import { readFileSync } from "node:fs";
import {
	fingerprintOfPublicKey,
	loadOperatorPublicKey,
	operatorCredentialPaths,
	verifyOperatorSignature,
} from "../auth/operator.ts";
import { readBootLedger } from "../boot-ledger.ts";
import { ControlError } from "../control/errors.ts";
import { resolveInstallation } from "../installation.ts";
import { resolveDaemonPaths } from "../paths.ts";
import { readStateFile } from "../state.ts";
import { HttpStopHealthProbe, type StopHealthProbe } from "./health.ts";
import { assertExecutorOutside, LinuxProcessIdentityProvider, type ProcessIdentityProvider } from "./process.ts";
import { type ProcessSignalSender, RealProcessSignalSender } from "./signal.ts";
import { type LifecyclePaths, resolveLifecyclePaths, StopOperationStore } from "./store.ts";
import {
	authorizationPayload,
	type ProcessIdentity,
	type StopOperationAuthorization,
	type StopOperationRecord,
} from "./types.ts";

export interface StopOperationServiceOptions {
	readonly dataDir: string;
	readonly deploymentId: string;
	readonly installationRoot: string;
	readonly processProvider?: ProcessIdentityProvider;
	readonly signalSender?: ProcessSignalSender;
	readonly healthProbe?: StopHealthProbe;
	readonly clock?: () => Date;
	readonly executorPid?: number;
}

export interface StopOperationStatus {
	readonly daemonState: ReturnType<typeof readStateFile>;
	readonly bootRecords: ReturnType<typeof readBootLedger>;
	readonly latestOperation: StopOperationRecord | null;
}

export class StopOperationService {
	private readonly dataDir: string;
	private readonly deploymentId: string;
	private readonly installationId: string;
	private readonly installationRoot: string;
	private readonly paths: LifecyclePaths;
	private readonly store: StopOperationStore;
	private readonly processProvider: ProcessIdentityProvider;
	private readonly signalSender: ProcessSignalSender;
	private readonly healthProbe: StopHealthProbe;
	private readonly clock: () => Date;
	private readonly executorPid: number;

	constructor(options: StopOperationServiceOptions) {
		this.dataDir = options.dataDir;
		this.deploymentId = options.deploymentId;
		this.installationRoot = options.installationRoot;
		this.installationId = resolveInstallation(options.installationRoot).installationId;
		this.paths = resolveLifecyclePaths(options.dataDir);
		this.clock = options.clock ?? (() => new Date());
		this.store = new StopOperationStore(this.paths, this.clock);
		this.processProvider = options.processProvider ?? new LinuxProcessIdentityProvider();
		this.signalSender = options.signalSender ?? new RealProcessSignalSender();
		this.healthProbe = options.healthProbe ?? new HttpStopHealthProbe();
		this.executorPid = options.executorPid ?? process.pid;
	}

	status(): StopOperationStatus {
		const daemonPaths = resolveDaemonPaths(this.dataDir);
		return {
			daemonState: readStateFile(daemonPaths.stateFile),
			bootRecords: readBootLedger(daemonPaths.ledgerFile),
			latestOperation: this.store.latest(),
		};
	}

	list(): StopOperationRecord[] {
		return this.store.list();
	}

	requestStop(authorization: StopOperationAuthorization): StopOperationRecord {
		const daemonPaths = resolveDaemonPaths(this.dataDir);
		const state = readStateFile(daemonPaths.stateFile);
		if (!state) throw new ControlError("not_found", "daemon state is not available");
		if (state.state !== "ready" && state.state !== "requested") {
			throw new ControlError("lifecycle_state_invalid", `daemon is ${state.state}`);
		}
		const frozenIdentity = this.processProvider.read(state.pid);
		if (!frozenIdentity) {
			throw new ControlError(
				"lifecycle_identity_mismatch",
				`cannot read daemon process identity for pid ${state.pid}`,
			);
		}
		const targets = [state.pid, ...this.processProvider.descendants(state.pid)];
		assertExecutorOutside(targets, this.executorPid, this.processProvider);
		this.verifyAuthorization(authorization, "halt", state.bootId);
		return this.store.createRequested({
			opId: authorization.opId,
			deploymentId: this.deploymentId,
			installationId: state.installationId,
			installationRoot: state.installationRoot,
			requestedBy: authorization.operatorRef,
			stoppedBootId: state.bootId,
			targetProcessSet: targets,
			frozenIdentity,
		});
	}

	private verifyAuthorization(
		authorization: StopOperationAuthorization,
		expectedAction: "halt" | "relaunch",
		expectedBootId: string,
	): void {
		if (authorization.action !== expectedAction) {
			throw new ControlError("lifecycle_unauthorized", "lifecycle authorization action does not match");
		}
		if (authorization.deploymentId !== this.deploymentId) {
			throw new ControlError("lifecycle_unauthorized", "lifecycle authorization deployment does not match");
		}
		if (authorization.stoppedBootId !== expectedBootId) {
			throw new ControlError("lifecycle_unauthorized", "lifecycle authorization boot does not match");
		}
		if (authorization.operatorRef.trim() === "") {
			throw new ControlError("lifecycle_unauthorized", "lifecycle authorization has no operator principal");
		}
		const publicKey = loadOperatorPublicKey(this.dataDir);
		const publicPem = readFileSync(operatorCredentialPaths(this.dataDir).publicKeyPath, "utf8");
		const fingerprint = fingerprintOfPublicKey(publicPem);
		if (fingerprint !== authorization.keyFingerprint) {
			throw new ControlError("lifecycle_unauthorized", "lifecycle authorization key fingerprint does not match");
		}
		const payload = authorizationPayload(
			authorization.opId,
			authorization.deploymentId,
			authorization.stoppedBootId,
			authorization.action,
		);
		if (!verifyOperatorSignature(publicKey, payload, authorization.signature)) {
			throw new ControlError("lifecycle_unauthorized", "lifecycle authorization signature is invalid");
		}
	}

	async executeStop(opId: string, options: { graceMs?: number; pollMs?: number } = {}): Promise<StopOperationRecord> {
		const record = this.store.read(opId);
		if (!record) throw new ControlError("not_found", `lifecycle operation ${opId} not found`);
		if (record.state !== "requested") {
			throw new ControlError("lifecycle_state_invalid", `lifecycle operation ${opId} is ${record.state}`);
		}
		const holder =
			this.processProvider.read(this.executorPid) ??
			({ pid: this.executorPid, startedAt: "", command: "" } satisfies ProcessIdentity);
		const claim = this.store.acquireClaim(this.deploymentId, holder, (pid) => this.processProvider.isAlive(pid));
		try {
			const current = this.processProvider.read(record.frozenIdentity.pid);
			if (
				!current ||
				current.startedAt !== record.frozenIdentity.startedAt ||
				current.command !== record.frozenIdentity.command
			) {
				this.store.fail(opId, "frozen_identity_mismatch");
				throw new ControlError("lifecycle_identity_mismatch", "daemon process identity changed before stop");
			}
			this.store.transition(opId, "requested", "stopping");
			try {
				await this.terminateTargets(record.targetProcessSet);
			} catch (error) {
				this.store.fail(opId, "signal_failed");
				throw new ControlError(
					"lifecycle_state_invalid",
					`failed to signal target process set: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const graceMs = options.graceMs ?? Number(process.env.CODETEAM_STOP_GRACE_MS ?? 15_000);
			const pollMs = options.pollMs ?? 50;
			const deadline = this.clock().getTime() + graceMs;
			while (record.targetProcessSet.some((pid) => this.processProvider.isAlive(pid))) {
				if (this.clock().getTime() >= deadline) {
					this.store.fail(opId, "stop_timeout");
					throw new ControlError(
						"lifecycle_state_invalid",
						"daemon processes did not exit before the grace deadline",
					);
				}
				await this.sleep(pollMs);
			}
			return this.store.transition(opId, "stopping", "stopped");
		} finally {
			this.store.releaseClaim(this.deploymentId, claim.holder.token);
		}
	}

	private async terminateTargets(targets: readonly number[]): Promise<void> {
		for (const target of targets) {
			if (this.processProvider.isAlive(target)) this.signalSender.send(target, "SIGTERM");
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, Math.max(ms, 1)));
	}

	authorizeRestart(opId: string, authorization: StopOperationAuthorization): StopOperationRecord {
		const record = this.store.read(opId);
		if (!record) throw new ControlError("not_found", `lifecycle operation ${opId} not found`);
		if (record.state !== "stopped") {
			throw new ControlError("lifecycle_state_invalid", `lifecycle operation ${opId} is ${record.state}`);
		}
		this.verifyAuthorization(authorization, "relaunch", record.stoppedBootId);
		return this.store.transition(opId, "stopped", "restart_authorized", {
			restart: {
				authorizedBy: authorization.operatorRef,
				keyFingerprint: authorization.keyFingerprint,
				signature: authorization.signature,
				stoppedBootId: record.stoppedBootId,
				at: this.clock().toISOString(),
			},
		});
	}

	recordRestart(
		opId: string,
		input: { bootId: string; processId: number; startedAt: string; command: string; installationId: string },
	): StopOperationRecord {
		const record = this.store.read(opId);
		if (!record) throw new ControlError("not_found", `lifecycle operation ${opId} not found`);
		if (record.state !== "restart_authorized" || !record.restart) {
			throw new ControlError("lifecycle_state_invalid", `lifecycle operation ${opId} is ${record.state}`);
		}
		if (input.installationId !== record.installationId) {
			throw new ControlError("lifecycle_identity_mismatch", "restarted daemon installation does not match");
		}
		if (input.bootId === record.stoppedBootId) {
			throw new ControlError("lifecycle_identity_mismatch", "restart requires a new boot identity");
		}
		const state = readStateFile(resolveDaemonPaths(this.dataDir).stateFile);
		if (!state || state.bootId !== input.bootId || state.pid !== input.processId) {
			throw new ControlError("lifecycle_identity_mismatch", "restarted daemon state does not match the request");
		}
		const bootRecord = readBootLedger(resolveDaemonPaths(this.dataDir).ledgerFile).find(
			(entry) =>
				entry.event === "started" &&
				entry.bootId === input.bootId &&
				entry.deploymentId === this.deploymentId &&
				entry.installationId === record.installationId,
		);
		if (!bootRecord) {
			throw new ControlError("lifecycle_identity_mismatch", "restarted boot is not present in the boot ledger");
		}
		const identity = this.processProvider.read(input.processId);
		if (!identity || identity.startedAt !== input.startedAt || identity.command !== input.command) {
			throw new ControlError("lifecycle_identity_mismatch", "restarted daemon process identity does not match");
		}
		return this.store.transition(opId, "restart_authorized", "restarted", {
			restart: {
				...record.restart,
				restartedBootId: input.bootId,
				restartedProcess: input.processId,
				restartedAt: this.clock().toISOString(),
				restartedInstallationId: input.installationId,
			},
		});
	}

	async reverify(opId: string, url: string): Promise<StopOperationRecord> {
		const record = this.store.read(opId);
		if (!record) throw new ControlError("not_found", `lifecycle operation ${opId} not found`);
		const target = this.reverificationTarget(record);
		if (!target) {
			throw new ControlError("lifecycle_state_invalid", `lifecycle operation ${opId} is ${record.state}`);
		}
		const result = await this.healthProbe.probe(url, target);
		const checkedAt = this.clock().toISOString();
		if (!result.ok) {
			this.store.fail(opId, `health_reverification_failed:${result.reason ?? "unknown"}`);
			throw new ControlError("lifecycle_health_failed", result.reason ?? "health re-verification failed");
		}
		return this.store.transition(opId, "restarted", "reverified", {
			reverification: { ...target, healthUrl: url, checkedAt, ok: true },
		});
	}

	private reverificationTarget(
		record: StopOperationRecord,
	): { bootId: string; processId: number; installationId: string } | null {
		const restart = record.restart;
		if (!restart?.restartedBootId || !restart.restartedProcess) return null;
		return {
			bootId: restart.restartedBootId,
			processId: restart.restartedProcess,
			installationId: record.installationId,
		};
	}

	staleClear(opId: string, authorization: StopOperationAuthorization): StopOperationRecord {
		const record = this.store.read(opId);
		if (!record) throw new ControlError("not_found", `lifecycle operation ${opId} not found`);
		this.verifyAuthorization(authorization, "halt", record.stoppedBootId);
		return this.store.transition(
			opId,
			["requested", "stopping", "stopped", "restart_authorized", "restarted"],
			"stale_cleared",
			{},
			"operator cleared stale lifecycle state",
		);
	}
}
