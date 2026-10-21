import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { FalsifierMode, PolicyDecision } from "./types.ts";

const READ_ONLY_EXECUTABLES = new Set(["grep", "rg", "diff", "ls", "cat"]);
const SHELL_OPERATORS = new Set([";", "|", "&", "<", ">", "`", "$", "\n", "\r", "#"]);
const DANGEROUS_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
	rg: new Set(["--pre", "--pre-glob"]),
};

function assertNoShellOperators(command: string): void {
	let quote: string | undefined;
	for (let index = 0; index < command.length; index += 1) {
		const char = command.charAt(index);
		if (quote !== undefined) {
			if (char === "\\" && quote === '"') {
				index += 1;
				continue;
			}
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (SHELL_OPERATORS.has(char)) {
			throw new Error(`shell operator ${char} is not allowed outside quotes`);
		}
	}
	if (quote !== undefined) throw new Error("unterminated quote");
}

function tokenize(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (let index = 0; index < command.length; index += 1) {
		const char = command.charAt(index);
		if (quote !== undefined) {
			if (char === quote) {
				quote = undefined;
				continue;
			}
			if (char === "\\" && quote === '"' && index + 1 < command.length) {
				index += 1;
				current += command.charAt(index);
				continue;
			}
			current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "\\" && index + 1 < command.length) {
			index += 1;
			current += command.charAt(index);
			continue;
		}
		if (char === " " || char === "\t") {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (quote !== undefined) throw new Error("unterminated quote");
	if (current.length > 0) tokens.push(current);
	return tokens;
}

function isSecretSegment(segment: string): boolean {
	const lower = segment.toLowerCase();
	return (
		lower === ".env" ||
		lower.startsWith(".env.") ||
		lower.endsWith(".pem") ||
		lower.startsWith("id_rsa") ||
		lower.startsWith("credentials") ||
		lower === ".git"
	);
}

function assertSafePath(argument: string, workdir: string): void {
	if (argument.startsWith("~") || isAbsolute(argument)) {
		throw new Error(`absolute path is not allowed: ${argument}`);
	}
	const segments = argument.split(/[\\/]/);
	if (segments.includes("..")) {
		throw new Error(`path escape is not allowed: ${argument}`);
	}
	if (segments.some(isSecretSegment)) {
		throw new Error(`secret path is not allowed: ${argument}`);
	}
	const candidate = resolve(workdir, argument);
	const relativeCandidate = relative(workdir, candidate);
	if (relativeCandidate.startsWith("..") || isAbsolute(relativeCandidate)) {
		throw new Error(`path escapes worktree: ${argument}`);
	}
	try {
		const real = realpathSync(candidate);
		const relativeReal = relative(workdir, real);
		if (relativeReal.startsWith("..") || isAbsolute(relativeReal)) {
			throw new Error(`symlink escapes worktree: ${argument}`);
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return;
		throw error;
	}
}

function assertSafeValue(value: string, workdir: string): void {
	if (value.length === 0) return;
	assertSafePath(value, workdir);
}

function assertSafeFlag(executable: string, flag: string, workdir: string): void {
	if (flag === "-") return;
	if (flag.startsWith("--")) {
		const equals = flag.indexOf("=");
		const name = equals === -1 ? flag : flag.slice(0, equals);
		if (DANGEROUS_FLAGS[executable]?.has(name)) {
			throw new Error(`dangerous flag is not allowed: ${name}`);
		}
		if (equals !== -1) assertSafeValue(flag.slice(equals + 1), workdir);
		return;
	}
	if (flag.length > 1) {
		const shortName = flag.slice(0, 2);
		if (DANGEROUS_FLAGS[executable]?.has(shortName)) {
			throw new Error(`dangerous flag is not allowed: ${shortName}`);
		}
		if (flag.length > 2) assertSafeValue(flag.slice(2), workdir);
	}
}

export class CommandPolicy {
	private readonly workdir: string;
	private readonly mode: FalsifierMode;

	constructor(workdir: string, mode: FalsifierMode = "strict") {
		this.workdir = resolve(workdir);
		this.mode = mode;
	}

	evaluate(command: string, cwd: string): PolicyDecision {
		try {
			if (command.trim().length === 0) throw new Error("empty command");
			const target = resolve(cwd);
			const relativeTarget = relative(this.workdir, target);
			if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
				throw new Error(`cwd escapes worktree: ${cwd}`);
			}
			assertNoShellOperators(command);
			const tokens = tokenize(command);
			const executable = tokens[0];
			if (executable === undefined) throw new Error("missing executable");
			if (executable.includes("/") || isAbsolute(executable)) {
				throw new Error(`absolute executable path is not allowed: ${executable}`);
			}
			const args = tokens.slice(1);

			if (executable === "node") {
				if (this.mode === "strict") throw new Error("node execution is disabled in strict mode");
				if (!args.includes("--test")) throw new Error("node is only allowed with --test in repro mode");
				for (const argument of args) {
					if (argument === "--test") continue;
					if (argument.startsWith("-")) throw new Error(`node flag is not allowed: ${argument}`);
					assertSafePath(argument, this.workdir);
				}
				return { allowed: true, reason: "allowed", command: { executable, args } };
			}

			if (!READ_ONLY_EXECUTABLES.has(executable)) {
				throw new Error(`executable is not allowlisted: ${executable}`);
			}
			for (const argument of args) {
				if (argument.startsWith("-")) assertSafeFlag(executable, argument, this.workdir);
				else assertSafePath(argument, this.workdir);
			}
			return { allowed: true, reason: "allowed", command: { executable, args } };
		} catch (error) {
			return { allowed: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}
}
