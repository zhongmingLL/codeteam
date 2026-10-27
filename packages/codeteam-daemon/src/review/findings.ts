import { isAbsolute, relative, resolve } from "node:path";
import { ControlError } from "../control/errors.ts";
import type { CreateFindingInput, FindingSeverity } from "../control/stores/types.ts";
import { collectPathTargets, evaluateCommand } from "../policy/commands.ts";
import { assertReadablePath } from "../policy/paths.ts";
import type { ToolPolicy } from "../policy/types.ts";

const EXECUTABLE_EVIDENCE_KINDS = new Set(["red_test", "repro_command", "static_check"]);

export interface FindingPolicyContext {
	readonly verifierPolicy?: ToolPolicy;
	readonly worktreeRoot?: string;
}

export interface FindingDowngrade {
	readonly index: number;
	readonly from: "P1" | "P2";
	readonly to: "P3";
	readonly reason: string;
}

export interface NormalizedFinding extends CreateFindingInput {
	readonly severity: FindingSeverity;
}

export interface NormalizeFindingsResult {
	readonly findings: readonly NormalizedFinding[];
	readonly downgrades: readonly FindingDowngrade[];
}

export function parseFalsifierCommand(falsifier: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaped = false;
	for (const char of falsifier) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current !== "") {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (escaped) throw new ControlError("invalid_input", "falsifier ends with an unfinished escape");
	if (quote) throw new ControlError("invalid_input", "falsifier has an unterminated quote");
	if (current !== "") tokens.push(current);
	if (tokens.length === 0) throw new ControlError("invalid_input", "falsifier is empty");
	return tokens;
}

export function normalizeFindings(
	inputs: readonly CreateFindingInput[],
	context: FindingPolicyContext = {},
): NormalizeFindingsResult {
	const findings: NormalizedFinding[] = [];
	const downgrades: FindingDowngrade[] = [];
	for (const [index, input] of inputs.entries()) {
		const normalized = normalizeFinding(input, context, index);
		findings.push(normalized.finding);
		if (normalized.downgrade) downgrades.push(normalized.downgrade);
	}
	return { findings, downgrades };
}

export function normalizeFinding(
	input: CreateFindingInput,
	context: FindingPolicyContext = {},
	index = 0,
): { finding: NormalizedFinding; downgrade: FindingDowngrade | null } {
	assertSafeFileReference(input.file);
	let severity = input.severity;
	let downgrade: FindingDowngrade | null = null;
	const originalSeverity = input.severity;
	if (originalSeverity === "P1" || originalSeverity === "P2") {
		const reason = downgradeReason(input, context);
		if (reason) {
			severity = "P3";
			downgrade = { index, from: originalSeverity, to: "P3", reason };
		}
	} else {
		assertRawFalsifierPathSafety(input.falsifier);
	}
	return {
		finding: {
			...input,
			severity,
			falsifierExpected: input.falsifierExpected ?? null,
		},
		downgrade,
	};
}

function downgradeReason(input: CreateFindingInput, context: FindingPolicyContext): string | null {
	if (!EXECUTABLE_EVIDENCE_KINDS.has(input.evidenceKind)) {
		return `evidence_kind_${input.evidenceKind}_is_not_executable`;
	}
	return validateExecutableFalsifier(input.falsifier, context);
}

export function validateExecutableFalsifier(falsifier: string, context: FindingPolicyContext): string | null {
	if (falsifier.trim() === "") return "missing_falsifier";
	let argv: string[];
	try {
		argv = parseFalsifierCommand(falsifier);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	if (context.verifierPolicy) {
		try {
			evaluateCommand(context.verifierPolicy, { argv, cwd: context.verifierPolicy.cwd });
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}
	try {
		assertFalsifierPathArguments(argv, context);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return null;
}

function assertFalsifierPathArguments(argv: readonly string[], context: FindingPolicyContext): void {
	const command = argv[0] ?? "";
	for (const arg of argv) {
		if (arg.startsWith("-")) continue;
		assertRelativePathReference(arg, "falsifier path");
	}

	if (!context.verifierPolicy || !context.worktreeRoot) return;
	const policy = context.verifierPolicy;
	for (const target of collectPathTargets(command, argv)) {
		assertInsideWorktree(assertReadablePath(policy, target.arg, policy.cwd), context.worktreeRoot);
	}
	if (command === "node") {
		for (let index = 1; index < argv.length; index += 1) {
			const arg = argv[index]!;
			if (arg.startsWith("-")) {
				if (arg === "--test-name-pattern" || arg === "--test-reporter") index += 1;
				continue;
			}
			if (!arg.includes("/") && !/\.(?:ts|js|mjs|cjs)$/.test(arg)) continue;
			assertRelativePathReference(arg, "node test path");
			assertInsideWorktree(assertReadablePath(policy, arg, policy.cwd), context.worktreeRoot);
		}
	}
}

function assertInsideWorktree(canonicalPath: string, worktreeRoot: string): void {
	const rel = relative(resolve(worktreeRoot), canonicalPath);
	if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
	throw new ControlError("forbidden", `falsifier path escapes the worktree: ${canonicalPath}`);
}

function assertSafeFileReference(file: string | null | undefined): void {
	if (file === null || file === undefined) return;
	assertRelativePathReference(file, "finding file");
}

function assertRelativePathReference(value: string, label: string): void {
	const trimmed = value.trim();
	if (trimmed === "") throw new ControlError("invalid_input", `${label} must not be empty`);
	if (isAbsolute(trimmed)) throw new ControlError("invalid_input", `${label} must be worktree-relative: ${value}`);
	if (trimmed.split(/[\\/]+/).includes("..")) {
		throw new ControlError("invalid_input", `${label} must not traverse outside the worktree: ${value}`);
	}
}

function assertRawFalsifierPathSafety(falsifier: string): void {
	if (/(^|\s)\/[^\s]+/.test(falsifier)) {
		throw new ControlError("invalid_input", "falsifier may only reference worktree-relative paths");
	}
	if (/(^|[\\/])\.\.([\\/]|$)/.test(falsifier)) {
		throw new ControlError("invalid_input", "falsifier may not traverse outside the worktree");
	}
}
