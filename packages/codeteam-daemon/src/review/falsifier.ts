import { ControlError } from "../control/errors.ts";
import type { Finding, Verification, VerificationStatus } from "../control/stores/types.ts";
import { type CommandAuditContext, type CommandResult, runCommand } from "../policy/exec.ts";
import type { ToolPolicy } from "../policy/types.ts";
import { parseFalsifierCommand } from "./findings.ts";

export const DEFAULT_BLOCKED_TTL_MS = 24 * 60 * 60 * 1000;

export interface FalsifierFinding {
	readonly id: string;
	readonly severity: Finding["severity"];
	readonly evidenceKind: Finding["evidenceKind"];
	readonly falsifier: string;
	readonly falsifierExpected: Finding["falsifierExpected"];
}

export interface ExecuteFalsifierInput {
	readonly finding: FalsifierFinding;
	readonly reviewId: string;
	readonly policy: ToolPolicy;
	readonly audit?: CommandAuditContext;
	readonly now?: () => number;
	readonly blockedTtlMs?: number;
}

export interface FalsifierExecutionResult {
	readonly status: VerificationStatus;
	readonly reason: string;
	readonly command: string;
	readonly cwd: string;
	readonly exitCode: number | null;
	readonly durationMs: number | null;
	readonly stdoutTail: string | null;
	readonly stderrTail: string | null;
	readonly blockedExpiresAt: number | null;
}

export function expectedExitForFinding(
	finding: Pick<FalsifierFinding, "evidenceKind" | "falsifierExpected">,
): "zero" | "nonzero" {
	if (finding.falsifierExpected) return finding.falsifierExpected;
	return finding.evidenceKind === "static_check" ? "zero" : "nonzero";
}

export function isBlockedExpired(
	verification: Pick<Verification, "status" | "createdAt">,
	now: number,
	blockedTtlMs = DEFAULT_BLOCKED_TTL_MS,
): boolean {
	if (verification.status !== "blocked") return false;
	return now >= verification.createdAt + blockedTtlMs;
}

export async function executeFalsifier(input: ExecuteFalsifierInput): Promise<FalsifierExecutionResult> {
	const argv = parseFalsifierCommand(input.finding.falsifier);
	const command = input.finding.falsifier;
	let result: CommandResult;
	try {
		result = await runCommand(input.policy, { argv, cwd: input.policy.cwd }, { audit: input.audit });
	} catch (error) {
		if (error instanceof ControlError && error.code === "command_failed") {
			return blockedResult(input, command, `infrastructure:${error.message}`, null);
		}
		throw error;
	}
	if (result.timedOut) return blockedResult(input, command, "infrastructure:timeout", result);
	if (result.truncated) return blockedResult(input, command, "infrastructure:output_cap", result);
	if (result.exitCode === null) return blockedResult(input, command, "infrastructure:no_exit_code", result);
	const expected = expectedExitForFinding(input.finding);
	const matched = expected === "zero" ? result.exitCode === 0 : result.exitCode !== 0;
	return {
		status: matched ? "confirmed" : "rejected",
		reason: matched ? `falsifier_matched_${expected}` : `falsifier_expected_${expected}_got_${result.exitCode}`,
		command,
		cwd: input.policy.cwd,
		exitCode: result.exitCode,
		durationMs: result.durationMs,
		stdoutTail: tail(result.stdout),
		stderrTail: tail(result.stderr),
		blockedExpiresAt: null,
	};
}

function blockedResult(
	input: ExecuteFalsifierInput,
	command: string,
	reason: string,
	result: CommandResult | null,
): FalsifierExecutionResult {
	const now = input.now ?? Date.now;
	const ttl = input.blockedTtlMs ?? DEFAULT_BLOCKED_TTL_MS;
	return {
		status: "blocked",
		reason,
		command,
		cwd: input.policy.cwd,
		exitCode: result?.exitCode ?? null,
		durationMs: result?.durationMs ?? null,
		stdoutTail: result ? tail(result.stdout) : null,
		stderrTail: result ? tail(result.stderr) : null,
		blockedExpiresAt: now() + ttl,
	};
}

function tail(text: string): string | null {
	const trimmed = text.trim();
	return trimmed === "" ? null : trimmed.slice(-2000);
}
