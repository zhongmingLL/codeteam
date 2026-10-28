import { ControlError } from "../control/errors.ts";

export const DEPLOYMENT_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export type DeploymentWaitPredicate =
	| {
			readonly kind: "revision_included";
			readonly revision: string;
			readonly services: readonly string[];
	  }
	| {
			readonly kind: "new_ready_boot";
			readonly services: readonly string[];
	  };

export interface DeploymentWaitOwnerFence {
	readonly kind: "containing_task";
	readonly taskId: string;
}

export interface DeploymentObservation {
	readonly v: 1;
	readonly subjectRef: string;
	readonly bootId: string;
	readonly bootSequence: number;
	readonly runningRevision: string | null;
	readonly readyServices: readonly string[];
	readonly observedAt: number;
	readonly inclusionProof: null;
}

export interface DeploymentWaitOutcome {
	readonly outcomeId: string;
	readonly generation: number;
	readonly subjectRef: string;
	readonly ownerFence: DeploymentWaitOwnerFence;
	readonly reason: "predicate_matched";
	readonly at: number;
	readonly delivery: "pending" | "delivered" | "suppressed" | "not_applicable";
	readonly deploymentMatch: DeploymentObservation | null;
	readonly registeredAt: number;
	readonly queueEntryId?: string;
	readonly sourceMessageId?: string;
}

export interface DeploymentWaitStateV1 {
	readonly v: 1;
	readonly generation: number;
	readonly subjectRef: string;
	readonly ownerFence: DeploymentWaitOwnerFence;
	readonly baseline: {
		readonly bootSequence: number;
		readonly bootId: string | null;
		readonly capturedAt: number;
	};
	readonly continuation: {
		readonly when: DeploymentWaitPredicate;
		readonly deliver: { readonly kind: "queue_entry"; readonly targetProfileIds: readonly string[] };
		readonly autoRenew: false;
	};
	readonly status: "waiting" | "matched" | "terminal";
	readonly outcome?: DeploymentWaitOutcome;
	readonly registeredAt: number;
	readonly updatedAt: number;
}

export interface DeploymentWaitRegisterInput {
	readonly taskId: string;
	readonly predicate: DeploymentWaitPredicate;
	readonly targetProfileIds: readonly string[];
	readonly actorRef: string;
}

export interface DeploymentWaitCancelInput {
	readonly taskId: string;
	readonly actorRef: string;
	readonly reason: string;
}

export interface DeploymentObserver {
	subjectRef(): string;
	observe(): DeploymentObservation | null;
}

export function deploymentSubjectRef(installationId: string, deploymentId: string): string {
	if (!/^[0-9a-f]{64}$/.test(installationId)) {
		throw new ControlError("deployment_wait_invalid", "installationId must be a 64-character lowercase hex string");
	}
	if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
		throw new ControlError("deployment_wait_invalid", `deploymentId is invalid: ${deploymentId}`);
	}
	return `deployment:${installationId}:${deploymentId}`;
}

export function validateDeploymentPredicate(predicate: DeploymentWaitPredicate): DeploymentWaitPredicate {
	if (!predicate || (predicate.kind !== "revision_included" && predicate.kind !== "new_ready_boot")) {
		throw new ControlError(
			"deployment_wait_invalid",
			"deployment wait predicate must be revision_included or new_ready_boot",
		);
	}
	if (!Array.isArray(predicate.services) || predicate.services.length === 0) {
		throw new ControlError("deployment_wait_invalid", "deployment wait services must be a non-empty array");
	}
	const services = predicate.services.filter((service) => typeof service === "string" && service.trim() !== "");
	if (services.length !== predicate.services.length || new Set(services).size !== services.length) {
		throw new ControlError("deployment_wait_invalid", "deployment wait services must be unique non-empty strings");
	}
	if (predicate.kind === "revision_included" && !SHA_PATTERN.test(predicate.revision)) {
		throw new ControlError("deployment_wait_invalid", "revision_included.revision must be a full lowercase sha");
	}
	return { ...predicate, services };
}

export function parseDeploymentWaitState(value: unknown): DeploymentWaitStateV1 | null {
	if (value === null || value === undefined) return null;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ControlError("deployment_wait_invalid", "task deployment_wait_json must be an object");
	}
	const state = value as Record<string, unknown>;
	if (state.v !== 1) throw new ControlError("deployment_wait_invalid", "unsupported deployment wait version");
	if (!Number.isSafeInteger(state.generation) || (state.generation as number) < 1) {
		throw new ControlError("deployment_wait_invalid", "deployment wait generation must be a positive integer");
	}
	if (typeof state.subjectRef !== "string" || !state.subjectRef.startsWith("deployment:")) {
		throw new ControlError("deployment_wait_invalid", "deployment wait subjectRef is invalid");
	}
	if (!state.ownerFence || typeof state.ownerFence !== "object") {
		throw new ControlError("deployment_wait_invalid", "deployment wait ownerFence is required");
	}
	if (!state.baseline || typeof state.baseline !== "object") {
		throw new ControlError("deployment_wait_invalid", "deployment wait baseline is required");
	}
	if (!state.continuation || typeof state.continuation !== "object") {
		throw new ControlError("deployment_wait_invalid", "deployment wait continuation is required");
	}
	if (state.status !== "waiting" && state.status !== "matched" && state.status !== "terminal") {
		throw new ControlError("deployment_wait_invalid", "deployment wait status is invalid");
	}
	return state as unknown as DeploymentWaitStateV1;
}
