import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { ControlError } from "../control/errors.ts";
import { DEFAULT_COMMAND_ALLOWLIST } from "./commands.ts";
import type { CreateToolPolicyOptions, ToolPolicy } from "./types.ts";

export { type CommandExecution, type CommandRequest, DEFAULT_COMMAND_ALLOWLIST, evaluateCommand } from "./commands.ts";
export { type CommandAuditContext, type CommandResult, type RunCommandOptions, runCommand } from "./exec.ts";
export {
	type CommitWithAuditInput,
	type CommitWithAuditResult,
	commitWithAudit,
} from "./git.ts";
export {
	assertHandoffDirection,
	DEFAULT_ACTION_PAIRS,
	type HandoffDirectionBinding,
	type HandoffDirectionDecision,
	type HandoffDirectionOptions,
	type HandoffDirectionRequest,
} from "./handoffs.ts";
export { assertAllowedCwd, assertReadablePath, assertWritablePath } from "./paths.ts";
export {
	buildSandboxArgv,
	resolveBwrapPath,
	SANDBOX_ETC_FILES,
	SANDBOX_SYSTEM_ROOTS,
	type SandboxConfig,
} from "./sandbox.ts";
export type { CreateToolPolicyOptions, ToolPolicy, ToolRole } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_ENV_ALLOWLIST: readonly string[] = ["HOME", "USER", "TMPDIR", "LANG", "LC_ALL", "TZ"];

export function createToolPolicy(options: CreateToolPolicyOptions): ToolPolicy {
	const dataDir = resolve(options.dataDir);
	const worktreeRoot = canonicalRoot(options.worktreeRoot, "worktreeRoot");
	const evidenceRoot = options.evidenceRoot ? canonicalRoot(options.evidenceRoot, "evidenceRoot") : null;
	if (options.role !== "coder" && !evidenceRoot) {
		throw new ControlError("invalid_input", "reviewer/verifier policies require evidenceRoot");
	}
	const readRoots = evidenceRoot ? [worktreeRoot, evidenceRoot] : [worktreeRoot];
	const writeRoots = options.role === "coder" ? [worktreeRoot] : [evidenceRoot!];
	return {
		role: options.role,
		cwd: worktreeRoot,
		readRoots,
		writeRoots,
		deniedReadPaths: [
			join(dataDir, "tokens"),
			join(dataDir, "credentials"),
			join(dataDir, "control.db"),
			join(dataDir, "artifacts"),
			"/run/codeteam/tokens",
		],
		allowedCommands: options.allowedCommands ?? DEFAULT_COMMAND_ALLOWLIST,
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
		envAllowlist: options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST,
	};
}

function canonicalRoot(path: string, label: string): string {
	try {
		return realpathSync.native(resolve(path));
	} catch {
		throw new ControlError("invalid_input", `${label} does not exist: ${path}`);
	}
}
