import type { RiskClassification } from "./types.ts";
import { type GateFinding, gateResult } from "./types.ts";

export function evaluateRiskConsistency(risk: RiskClassification): ReturnType<typeof gateResult> {
	const findings: GateFinding[] = risk.mismatches.map((mismatch) => ({
		code: mismatch.code,
		severity: mismatch.severity,
		message: mismatch.message,
	}));
	if (risk.lane === "product_fast") {
		findings.push({
			code: "product_fast_requires_direction_confirmation",
			severity: "P3",
			message:
				"product fast lane is only valid when the operator has confirmed direction and rollback is one commit",
		});
	}
	return gateResult(
		"risk_consistency",
		findings,
		[],
		`lane=${risk.lane} assurance=${risk.assurance} axes=${risk.axes.join(",") || "none"}`,
	);
}
