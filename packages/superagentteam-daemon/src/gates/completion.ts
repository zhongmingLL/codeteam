import type { Merge, SopCheckEvidence } from "../control/stores/types.ts";
import { type GateFinding, type GateResult, gateResult } from "./types.ts";

export interface CompletionGateInput {
	readonly backlogStatus: string;
	readonly actor: string;
	readonly merge: Merge | null;
	readonly visionEvidence: SopCheckEvidence | null;
	readonly acceptanceRef?: string | null;
}

export function evaluateCompletionGate(input: CompletionGateInput): GateResult {
	const findings: GateFinding[] = [];
	const evidenceRefs: string[] = [];
	if (input.backlogStatus !== "done") {
		findings.push({ code: "completion_backlog_not_done", severity: "P1", message: "backlog item is not done" });
	}
	if (!input.actor.startsWith("operator:")) {
		findings.push({
			code: "completion_operator_required",
			severity: "P1",
			message: "completion must be written by an operator actor",
		});
	}
	if (!input.merge || input.merge.status !== "succeeded") {
		findings.push({
			code: "completion_merge_receipt_missing",
			severity: "P1",
			message: "a succeeded merge receipt is required",
		});
	} else {
		evidenceRefs.push(`merge:${input.merge.id}`);
		if (input.merge.executedBy !== "service:merge-owner" || !input.merge.gateEvidenceRef) {
			findings.push({
				code: "completion_merge_receipt_not_contract",
				severity: "P1",
				message: "merge receipt is not a service:merge-owner receipt with gate evidence",
				evidenceRef: `merge:${input.merge.id}`,
			});
		}
	}
	if (!input.visionEvidence) {
		findings.push({
			code: "completion_vision_evidence_missing",
			severity: "P1",
			message: "fresh visionGuardDone evidence is required",
		});
	} else {
		evidenceRefs.push(`sop_check_evidence:${input.visionEvidence.id}`);
		if (
			input.merge &&
			input.visionEvidence.subjectRevision !== input.merge.headSha &&
			input.visionEvidence.subjectRevision !== input.merge.mergeSha
		) {
			findings.push({
				code: "completion_vision_evidence_stale",
				severity: "P1",
				message: "vision evidence revision does not match the merge receipt",
				evidenceRef: `sop_check_evidence:${input.visionEvidence.id}`,
			});
		}
	}
	if (!input.acceptanceRef) {
		findings.push({
			code: "completion_acceptance_ref_missing",
			severity: "P3",
			message: "no explicit acceptance reference recorded; backlog done is the acceptance signal",
		});
	} else {
		evidenceRefs.push(input.acceptanceRef);
	}
	return gateResult("completion", findings, evidenceRefs, "completion evidence");
}
