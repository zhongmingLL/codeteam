import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { ControlError } from "../control/errors.ts";
import type { CommandExecution } from "./commands.ts";
import type { ToolPolicy } from "./types.ts";

export interface SandboxConfig {
	readonly bwrapPath?: string;
	readonly extraRuntimeBinds?: readonly string[];
	readonly shareNetwork?: boolean;
}

export const SANDBOX_SYSTEM_ROOTS: readonly string[] = [
	"/usr",
	"/bin",
	"/sbin",
	"/lib",
	"/lib64",
	"/lib32",
	"/usr/local",
];

export const SANDBOX_ETC_FILES: readonly string[] = [
	"/etc/hosts",
	"/etc/resolv.conf",
	"/etc/nsswitch.conf",
	"/etc/passwd",
	"/etc/group",
	"/etc/localtime",
];

export function resolveBwrapPath(config: SandboxConfig = {}): string {
	if (config.bwrapPath) return config.bwrapPath;
	const found = findExecutableOnPath("bwrap");
	if (!found) throw new ControlError("command_failed", "bubblewrap (bwrap) is not installed");
	return found;
}

function findExecutableOnPath(name: string): string | null {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// keep searching
		}
	}
	return null;
}

export function buildSandboxArgv(
	policy: ToolPolicy,
	execution: CommandExecution,
	config: SandboxConfig = {},
): string[] {
	const args = [config.bwrapPath ?? "bwrap", "--die-with-parent", "--new-session", "--unshare-all"];
	if (config.shareNetwork !== false) args.push("--share-net");
	args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
	for (const root of SANDBOX_SYSTEM_ROOTS) pushReadOnlyBind(args, root);
	for (const root of runtimeBindRoots(config)) pushReadOnlyBind(args, root);
	for (const file of SANDBOX_ETC_FILES) pushReadOnlyBind(args, file);
	const writable = new Set(policy.writeRoots);
	for (const root of policy.readRoots) {
		args.push(writable.has(root) ? "--bind" : "--ro-bind", root, root);
	}
	for (const root of policy.writeRoots) {
		if (!policy.readRoots.includes(root)) args.push("--bind", root, root);
	}
	args.push("--chdir", execution.cwd, "--", ...execution.argv);
	return args;
}

function runtimeBindRoots(config: SandboxConfig): string[] {
	const nodePrefix = dirname(dirname(process.execPath));
	return [nodePrefix, ...(config.extraRuntimeBinds ?? [])];
}

function pushReadOnlyBind(args: string[], path: string): void {
	if (existsSync(path)) args.push("--ro-bind", path, path);
}
