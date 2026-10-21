export type ReviewVerdictKind = "approve" | "changes_requested" | "blocked";

export type FindingSeverity = "P1" | "P2" | "P3";

export type EvidenceKind = "red_test" | "repro_command" | "static_check" | "code_reading" | "judgment";

export type FalsifierExpected = "zero" | "nonzero";

export interface ReviewFinding {
	severity: FindingSeverity;
	file?: string;
	line?: number;
	claim: string;
	evidenceKind: EvidenceKind;
	falsifier: string;
	falsifierExpected?: FalsifierExpected;
	requiredAction: string;
}

export interface ReviewVerdict {
	verdict: ReviewVerdictKind;
	findings: ReviewFinding[];
}

export function hasBlockingFindings(verdict: ReviewVerdict): boolean {
	return verdict.findings.some((finding) => finding.severity === "P1" || finding.severity === "P2");
}
