import type { FalsifierExpected, ReviewFinding } from "../review/types.ts";

export type FalsifierMode = "strict" | "repro";

export type VerificationStatus = "confirmed" | "rejected" | "blocked";

export interface ParsedCommand {
	executable: string;
	args: string[];
}

export interface PolicyDecision {
	allowed: boolean;
	reason: string;
	command?: ParsedCommand;
}

export interface FalsifierAuditRecord {
	index: number;
	finding: ReviewFinding;
	mode: FalsifierMode;
	cwd: string;
	command: string;
	expected?: FalsifierExpected;
	status: VerificationStatus;
	reason: string;
	executable?: string;
	args?: string[];
	exitCode?: number;
	durationMs?: number;
	stdoutTail?: string;
	stderrTail?: string;
}

export interface FindingVerification {
	finding: ReviewFinding;
	status: VerificationStatus;
	reason: string;
	audit: FalsifierAuditRecord;
}

export interface VerifierOptions {
	workdir: string;
	mode?: FalsifierMode;
	timeoutMs?: number;
	outputLimitBytes?: number;
}
