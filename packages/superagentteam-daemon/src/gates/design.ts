import type { Approval } from "../control/stores/types.ts";
import type { RiskClassification } from "./types.ts";
import { type GateFinding, type GateResult, gateResult } from "./types.ts";

export interface DesignGateInput {
	readonly taskId: string;
	readonly specRef: string | null;
	readonly acceptanceCriteria: readonly string[];
	readonly userJourney: readonly string[];
	readonly userVisible: boolean;
	readonly risk: RiskClassification;
	readonly specChange?: boolean;
	readonly approval?: Approval | null;
}

export function evaluateDesignGate(input: DesignGateInput): GateResult {
	const findings: GateFinding[] = [];
	const evidenceRefs: string[] = [];
	if (!input.specRef || input.specRef.trim() === "") {
		findings.push({ code: "design_spec_missing", severity: "P1", message: "design gate requires a spec reference" });
	} else {
		evidenceRefs.push(input.specRef);
	}
	if (input.acceptanceCriteria.filter((criterion) => criterion.trim() !== "").length === 0) {
		findings.push({
			code: "design_acceptance_missing",
			severity: "P1",
			message: "design gate requires at least one acceptance criterion",
		});
	}
	if (input.userVisible && input.userJourney.filter((step) => step.trim() !== "").length === 0) {
		findings.push({
			code: "design_user_journey_missing",
			severity: "P1",
			message: "user-visible work requires a User Journey",
		});
	}
	const humanRequired = input.risk.assurance === "critical" || input.specChange === true;
	if (humanRequired) {
		const accepted =
			input.approval?.resolution === "accepted" &&
			(input.approval.kind === "design_gate" || input.approval.kind === "spec_change");
		if (!accepted) {
			findings.push({
				code: "design_gate_human_required",
				severity: "P1",
				message: "critical risk or spec_change requires an accepted design_gate/spec_change approval",
				evidenceRef: input.approval ? `approval:${input.approval.id}` : undefined,
			});
		} else {
			evidenceRefs.push(`approval:${input.approval!.id}`);
		}
	}
	return gateResult("design", findings, evidenceRefs, humanRequired ? "human gate required" : "machine gate");
}
