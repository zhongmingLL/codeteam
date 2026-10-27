import { ControlError } from "../control/errors.ts";
import { MERGE_SERVICE_ACTOR } from "./merge-credential.ts";

export type PrincipalKind = "operator" | "run" | "agent-key" | "service";

export interface Principal {
	readonly kind: PrincipalKind;
	readonly id: string;
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
