import { isAbsolute, relative, resolve } from "node:path";
import { ControlError } from "../control/errors.ts";
import type { CreateFindingInput, FindingSeverity } from "../control/stores/types.ts";
import { collectPathTargets, evaluateCommand } from "../policy/commands.ts";
import { assertReadablePath } from "../policy/paths.ts";
import type { ToolPolicy } from "../policy/types.ts";

const EXECUTABLE_EVIDENCE_KINDS = new Set(["red_test", "repro_command", "static_check"]);
const PATH_VALUE_FLAGS = new Set([
	"--require",
	"-r",
	"--import",
	"--loader",
	"--experimental-loader",
	"--test-reporter-destination",
	"--test-file",
]);

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
	for (let index = 0; index < falsifier.length; index += 1) {
		const char = falsifier[index]!;
		if (quote === "'") {
			if (char === "'") quote = null;
			else current += char;
			continue;
		}
		if (quote === '"') {
			if (char === '"') {
				quote = null;
				continue;
			}
			if (char === "\\") {
				const next = falsifier[index + 1];
				if (next === "\\" || next === '"' || next === "$" || next === "`" || next === "\n") {
					current += next;
					index += 1;
					continue;
				}
			}
			current += char;
			continue;
		}
		if (char === "\\") {
			const next = falsifier[index + 1];
			if (next === undefined) throw new ControlError("invalid_input", "falsifier ends with an unfinished escape");
			current += next;
			index += 1;
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
		if (!arg.startsWith("-")) continue;
		const equals = arg.indexOf("=");
		if (equals <= 0) continue;
		const flag = arg.slice(0, equals);
		const value = arg.slice(equals + 1);
		if (PATH_VALUE_FLAGS.has(flag)) {
			assertWorktreeRelativePath(value, `falsifier ${flag}`);
		} else if (isAbsolute(value)) {
			throw new ControlError("invalid_input", `falsifier flag value must be worktree-relative: ${flag}`);
		} else {
			continue;
		}
		if (context.verifierPolicy && context.worktreeRoot) {
			const canonical = assertReadablePath(context.verifierPolicy, value, context.verifierPolicy.cwd);
			assertInsideWorktree(canonical, context.worktreeRoot);
		}
	}

	if (!context.verifierPolicy || !context.worktreeRoot) return;
	const policy = context.verifierPolicy;
	for (const target of collectPathTargets(command, argv)) {
		assertInsideWorktree(assertReadablePath(policy, target.arg, policy.cwd), context.worktreeRoot);
	}
}

function assertInsideWorktree(canonicalPath: string, worktreeRoot: string): void {
	const rel = relative(resolve(worktreeRoot), canonicalPath);
	if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
	throw new ControlError("forbidden", `falsifier path escapes the worktree: ${canonicalPath}`);
}

function assertSafeFileReference(file: string | null | undefined): void {
	if (file === null || file === undefined) return;
	assertWorktreeRelativePath(file, "finding file");
}

export function assertWorktreeRelativePath(value: string, label: string): void {
	const trimmed = value.trim();
	if (trimmed === "") throw new ControlError("invalid_input", `${label} must not be empty`);
	if (isAbsolute(trimmed)) throw new ControlError("invalid_input", `${label} must be worktree-relative: ${value}`);
	if (trimmed.split(/[\\/]+/).includes("..")) {
		throw new ControlError("invalid_input", `${label} must not traverse outside the worktree: ${value}`);
	}
}
