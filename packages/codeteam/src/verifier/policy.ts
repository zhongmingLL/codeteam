import { isAbsolute, relative, resolve } from "node:path";
import type { FalsifierMode, PolicyDecision } from "./types.ts";

const STRICT_EXECUTABLES = new Set(["grep", "rg", "diff", "ls", "cat"]);
const SHELL_OPERATORS = new Set([";", "|", "&", "<", ">", "`", "$", "\n", "\r", "#"]);

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

function assertSafeArgument(argument: string): void {
	if (argument.startsWith("-") || argument === "" || argument === ".") return;
	if (argument.startsWith("~") || isAbsolute(argument)) {
		throw new Error(`absolute path is not allowed: ${argument}`);
	}
	if (argument.split(/[\\/]/).includes("..")) {
		throw new Error(`path escape is not allowed: ${argument}`);
	}
	const lower = argument.toLowerCase();
	const secret =
		lower === ".env" ||
		lower.startsWith(".env.") ||
		lower.endsWith(".pem") ||
		lower.startsWith("id_rsa") ||
		lower.startsWith("credentials") ||
		lower === ".git" ||
		lower.startsWith(".git/");
	if (secret) throw new Error(`secret path is not allowed: ${argument}`);
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
			for (const argument of args) assertSafeArgument(argument);

			if (executable === "node") {
				const hasTest = args.includes("--test");
				const hasEval = args.includes("-e") || args.includes("--eval");
				if (this.mode === "strict" && !hasTest) {
					throw new Error("node is only allowed with --test in strict mode");
				}
				if (this.mode === "repro" && !hasTest && !hasEval) {
					throw new Error("node is only allowed with --test or -e in repro mode");
				}
				return { allowed: true, reason: "allowed", command: { executable, args } };
			}
			if (!STRICT_EXECUTABLES.has(executable)) {
				throw new Error(`executable is not allowlisted: ${executable}`);
			}
			return { allowed: true, reason: "allowed", command: { executable, args } };
		} catch (error) {
			return { allowed: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}
}
