import { ControlError } from "../control/errors.ts";
import { assertAllowedCwd, assertReadablePath, assertWritablePath } from "./paths.ts";
import type { ToolPolicy } from "./types.ts";

export const DEFAULT_COMMAND_ALLOWLIST: readonly string[] = ["git", "ls", "cat", "head", "tail", "wc", "grep", "node"];

const SHELL_META = /[;|&<>`$\n\r#]/;
const SHELL_META_WITHOUT_HASH = /[;|&<>`$\n\r]/;
const GIT_ALLOWED_SUBCOMMANDS = new Set(["add", "commit", "status", "diff", "rev-parse", "show"]);
const GIT_DENIED_FLAGS = new Set([
	"--no-index",
	"--git-dir",
	"--work-tree",
	"--exec-path",
	"--amend",
	"--upload-pack",
	"--receive-pack",
	"-C",
	"-c",
]);
const GIT_DENIED_PREFIXES: readonly string[] = [
	"--output",
	"--pathspec-from-file",
	"--pathspec-file-nul",
	"--exec-path",
	"-o",
	"-c",
	"-C",
];
const READ_PATH_COMMANDS = new Set(["cat", "head", "tail", "wc", "ls"]);
const NODE_DENIED_FLAGS = new Set([
	"-e",
	"--eval",
	"-p",
	"--print",
	"-i",
	"--interactive",
	"--require",
	"-r",
	"--import",
	"--loader",
	"--experimental-loader",
	"--inspect",
	"--inspect-brk",
	"--inspect-port",
	"--inspect-wait",
	"--watch",
	"--watch-path",
	"--watch-preserve-output",
	"--env-file",
	"--env-file-if-exists",
	"--input-type",
	"--experimental-policy",
	"--experimental-network-imports",
	"--test-reporter-destination",
]);
const NODE_VALUE_FLAGS = new Set([
	"--test-name-pattern",
	"--test-reporter",
	"--test-timeout",
	"--test-concurrency",
	"--experimental-test-isolation",
]);

export interface CommandRequest {
	readonly argv: readonly string[];
	readonly env?: Record<string, string>;
	readonly cwd?: string;
}

export interface CommandExecution {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly timeoutMs: number;
	readonly maxOutputBytes: number;
}

export interface PathTarget {
	readonly arg: string;
	readonly mode: "read" | "write";
}

export function evaluateCommand(policy: ToolPolicy, request: CommandRequest): CommandExecution {
	const argv = request.argv.map((arg) => String(arg));
	const command = argv[0];
	if (!command || command.trim() === "") throw forbidden("empty command");
	const gitMessageIndexes = command === "git" ? gitMessageArgumentIndexes(argv) : new Set<number>();
	for (const [index, arg] of argv.entries()) {
		const pattern = gitMessageIndexes.has(index) ? SHELL_META_WITHOUT_HASH : SHELL_META;
		if (pattern.test(arg)) throw forbidden(`shell metacharacters not allowed: ${arg}`);
	}
	if (!policy.allowedCommands.includes(command)) throw forbidden(`command not allowed: ${command}`);
	if (command === "git") validateGit(policy.role, argv);
	if (command === "node") validateNode(argv);
	const cwd = assertAllowedCwd(policy, request.cwd ?? policy.cwd);
	validatePathArguments(policy, command, argv, cwd);
	return {
		argv,
		cwd,
		env: minimalEnv(policy, request.env),
		timeoutMs: policy.timeoutMs,
		maxOutputBytes: policy.maxOutputBytes,
	};
}

function validateGit(role: string, argv: readonly string[]): void {
	const subcommand = argv[1];
	if (!subcommand || subcommand.startsWith("-")) throw forbidden("git requires a subcommand without global flags");
	if (!GIT_ALLOWED_SUBCOMMANDS.has(subcommand)) {
		throw forbidden(`git subcommand not allowed: ${subcommand}`);
	}
	if (role !== "coder" && (subcommand === "add" || subcommand === "commit")) {
		throw forbidden(`git ${subcommand} is only allowed for coder runs`);
	}
	if (subcommand === "show" && !argv.slice(2).some((arg) => arg === "-s" || arg === "--no-patch")) {
		throw forbidden("git show requires -s or --no-patch");
	}
	for (const arg of argv.slice(2)) {
		if (GIT_DENIED_FLAGS.has(arg)) throw forbidden(`git flag not allowed: ${arg}`);
		if (GIT_DENIED_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
			throw forbidden(`git flag not allowed: ${arg}`);
		}
	}
}

function gitMessageArgumentIndexes(argv: readonly string[]): Set<number> {
	const indexes = new Set<number>();
	if (argv[1] !== "commit") return indexes;
	for (let index = 2; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "-m" || arg === "--message") {
			indexes.add(index + 1);
			index += 1;
			continue;
		}
		if (arg?.startsWith("--message=") || (arg?.startsWith("-m") && arg.length > 2)) {
			indexes.add(index);
		}
	}
	return indexes;
}

function validateNode(argv: readonly string[]): void {
	const args = argv.slice(1);
	if (args[0] !== "--test") throw forbidden("node is only allowed with --test");
	for (const arg of args) {
		const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
		if (NODE_DENIED_FLAGS.has(flag)) throw forbidden(`node flag not allowed: ${flag}`);
		if (!arg.startsWith("--") && arg.startsWith("-r") && arg !== "-r") {
			throw forbidden(`node flag not allowed: ${flag}`);
		}
	}
}

export function collectPathTargets(command: string, argv: readonly string[]): PathTarget[] {
	const targets: PathTarget[] = [];
	if (command === "git") {
		if (argv[1] === "add") {
			for (const arg of argv.slice(2)) {
				if (arg.startsWith("-")) continue;
				targets.push({ arg, mode: "write" });
			}
		}
		if (argv[1] === "commit") {
			for (let index = 2; index < argv.length; index += 1) {
				const arg = argv[index];
				if (arg === "-F" || arg === "--file") {
					const target = argv[index + 1];
					if (target) targets.push({ arg: target, mode: "read" });
					index += 1;
					continue;
				}
				if (arg?.startsWith("--file=")) {
					targets.push({ arg: arg.slice("--file=".length), mode: "read" });
					continue;
				}
				if (arg?.startsWith("-F") && arg.length > 2) {
					targets.push({ arg: arg.slice(2), mode: "read" });
				}
			}
		}
		return targets;
	}
	if (READ_PATH_COMMANDS.has(command)) {
		for (const arg of argv.slice(1)) {
			if (arg.startsWith("-")) continue;
			targets.push({ arg, mode: "read" });
		}
		return targets;
	}
	if (command === "grep") {
		let skippedPattern = false;
		for (const arg of argv.slice(1)) {
			if (arg.startsWith("-")) continue;
			if (!skippedPattern) {
				skippedPattern = true;
				continue;
			}
			targets.push({ arg, mode: "read" });
		}
	}
	if (command === "node") {
		const args = argv.slice(1);
		for (let index = 1; index < args.length; index += 1) {
			const arg = args[index]!;
			if (NODE_VALUE_FLAGS.has(arg)) {
				index += 1;
				continue;
			}
			if (arg.startsWith("-")) continue;
			targets.push({ arg, mode: "read" });
		}
	}
	return targets;
}

function validatePathArguments(policy: ToolPolicy, command: string, argv: readonly string[], cwd: string): void {
	for (const target of collectPathTargets(command, argv)) {
		if (target.mode === "read") assertReadablePath(policy, target.arg, cwd);
		else assertWritablePath(policy, target.arg, cwd);
	}
}

function minimalEnv(policy: ToolPolicy, requestEnv: Record<string, string> | undefined): Record<string, string> {
	const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
	for (const key of policy.envAllowlist) {
		const value = requestEnv?.[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

function forbidden(message: string): ControlError {
	return new ControlError("forbidden", message);
}
