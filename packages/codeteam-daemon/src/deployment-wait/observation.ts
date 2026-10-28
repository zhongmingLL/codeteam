import { type BootRecord, readBootLedger } from "../boot-ledger.ts";
import { ControlError } from "../control/errors.ts";
import { DaemonError } from "../errors.ts";
import { resolveInstallation } from "../installation.ts";
import { resolveDaemonPaths } from "../paths.ts";
import { readStateFile } from "../state.ts";
import { type DeploymentObservation, type DeploymentObserver, deploymentSubjectRef } from "./types.ts";

export interface DeploymentObservationOptions {
	readonly dataDir?: string;
	readonly installationRoot?: string;
	readonly deploymentId?: string;
	readonly clock?: () => number;
}

export class DeploymentObservationService implements DeploymentObserver {
	private readonly dataDir: string | undefined;
	private readonly installationRoot: string | undefined;
	private readonly deploymentId: string | undefined;
	private readonly clock: () => number;

	constructor(options: DeploymentObservationOptions = {}) {
		this.dataDir = options.dataDir;
		this.installationRoot = options.installationRoot;
		this.deploymentId = options.deploymentId;
		this.clock = options.clock ?? Date.now;
	}

	subjectRef(): string {
		const paths = resolveDaemonPaths(this.dataDir);
		const state = readStateFile(paths.stateFile);
		if (state?.installationId) {
			return deploymentSubjectRef(
				state.installationId,
				state.deploymentId ?? this.deploymentId ?? process.env.CODETEAM_DEPLOYMENT_ID ?? "local",
			);
		}
		if (!this.installationRoot) {
			throw new ControlError(
				"deployment_wait_invalid",
				"deployment observation requires an initialized daemon state or an installationRoot",
			);
		}
		const installation = resolveInstallation(this.installationRoot);
		return deploymentSubjectRef(
			installation.installationId,
			this.deploymentId ?? process.env.CODETEAM_DEPLOYMENT_ID ?? "local",
		);
	}

	observe(): DeploymentObservation | null {
		const paths = resolveDaemonPaths(this.dataDir);
		const state = readStateFile(paths.stateFile);
		if (!state || state.state !== "ready" || !state.bootId || !Number.isSafeInteger(state.bootSequence)) {
			return null;
		}
		let ledger: BootRecord[];
		try {
			ledger = readBootLedger(paths.ledgerFile);
		} catch (error) {
			if (error instanceof DaemonError && error.code === "ledger_corrupt") return null;
			throw error;
		}
		const bootRecords = ledger.filter((record) => record.bootId === state.bootId);
		const ready = bootRecords.findLast((record) => record.event === "ready");
		if (!ready) return null;
		const readyServices = ready.detail
			? ready.detail
					.split(",")
					.map((service) => service.trim())
					.filter((service) => service !== "")
			: [...state.services];
		const deploymentId = state.deploymentId ?? this.deploymentId ?? process.env.CODETEAM_DEPLOYMENT_ID ?? "local";
		return {
			v: 1,
			subjectRef: deploymentSubjectRef(state.installationId, deploymentId),
			bootId: state.bootId,
			bootSequence: state.bootSequence,
			runningRevision: state.runningRevision?.trim() ? state.runningRevision : null,
			readyServices,
			observedAt: this.clock(),
			inclusionProof: null,
		};
	}
}
