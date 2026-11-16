import { createPublicKey } from "node:crypto";
import { ControlError } from "../control/errors.ts";
import { MERGE_SERVICE_ACTOR, type MergeServicePayload } from "./merge-credential.ts";
import { fingerprintOfPublicKey, verifyOperatorSignature } from "./operator.ts";

export type PrincipalKind = "operator" | "run" | "agent-key" | "service";

declare const principalBrand: unique symbol;

export interface Principal {
	readonly kind: PrincipalKind;
	readonly id: string;
	readonly [principalBrand]: true;
}

export interface OperatorProof {
	readonly publicKeyPem: string;
	readonly payload: string;
	readonly signature: string;
}

export function principalFromOperatorProof(proof: OperatorProof): Principal {
	const publicKey = createPublicKey(proof.publicKeyPem);
	if (!verifyOperatorSignature(publicKey, proof.payload, proof.signature)) {
		throw new ControlError("forbidden", "operator signature verification failed");
	}
	return brand("operator", `operator:${fingerprintOfPublicKey(proof.publicKeyPem)}`);
}

export function principalFromRunId(runId: string): Principal {
	if (!runId || runId.trim() === "") throw new ControlError("invalid_input", "runId is required");
	return brand("run", `run:${runId}`);
}

export function principalFromVerifiedMergeCredential(payload: MergeServicePayload): Principal {
	if (payload.actor !== MERGE_SERVICE_ACTOR) {
		throw new ControlError("forbidden", "merge credential actor mismatch");
	}
	return brand("service", MERGE_SERVICE_ACTOR);
}

export function assertApprovalDecisionPrincipal(principal: Principal): void {
	if (principal.kind !== "operator") {
		throw new ControlError("forbidden", "approval decide requires an operator principal");
	}
}

export function assertMergeExecutionPrincipal(principal: Principal): void {
	if (principal.kind !== "service" || principal.id !== MERGE_SERVICE_ACTOR) {
		throw new ControlError("forbidden", "merge execution requires the service:merge-owner principal");
	}
}

function brand(kind: PrincipalKind, id: string): Principal {
	return { kind, id } as Principal;
}
