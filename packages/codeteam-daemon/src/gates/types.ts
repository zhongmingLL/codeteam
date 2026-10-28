export type RiskAxis = "behavior" | "data" | "security" | "contract" | "irreversible";
export type AssuranceLevel = "light" | "standard" | "high" | "critical";
export type RiskLane = "docs" | "product_fast" | "small_change" | "standard";

export interface DiffFileStat {
	readonly path: string;
	readonly additions: number;
	readonly deletions: number;
}

export interface RiskClassificationInput {
	readonly changedFiles: readonly DiffFileStat[];
	readonly declaredAxes?: readonly RiskAxis[];
	readonly declaredLane?: RiskLane;
	readonly declaredAssurance?: AssuranceLevel;
	readonly irreversible?: boolean;
}

export interface RiskMismatch {
	readonly code: string;
	readonly severity: "P1" | "P2";
	readonly message: string;
}

export interface RiskClassification {
	readonly axes: readonly RiskAxis[];
	readonly assurance: AssuranceLevel;
	readonly lane: RiskLane;
	readonly changedFiles: number;
	readonly additions: number;
	readonly deletions: number;
	readonly reasons: readonly string[];
	readonly mismatches: readonly RiskMismatch[];
	readonly declared: boolean;
}

export type GateName = "worktree" | "design" | "review" | "verify" | "risk_consistency" | "merge" | "completion";

export type GateStatus = "pass" | "block" | "advisory";

export interface GateFinding {
	readonly code: string;
	readonly severity: "P1" | "P2" | "P3";
	readonly message: string;
	readonly evidenceRef?: string;
}

export interface GateResult {
	readonly gate: GateName;
	readonly status: GateStatus;
	readonly findings: readonly GateFinding[];
	readonly evidenceRefs: readonly string[];
	readonly overrides: readonly string[];
	readonly summary: string;
}

export function gateResult(
	gate: GateName,
	findings: readonly GateFinding[],
	evidenceRefs: readonly string[],
	summary: string,
	overrides: readonly string[] = [],
): GateResult {
	const status: GateStatus = findings.some((finding) => finding.severity === "P1" || finding.severity === "P2")
		? "block"
		: findings.length > 0
			? "advisory"
			: "pass";
	return { gate, status, findings, evidenceRefs, overrides, summary };
}

export function gateCodes(result: GateResult): string[] {
	return result.findings.map((finding) => `${finding.severity}:${finding.code}`);
}
