export type ToolRole = "coder" | "reviewer" | "verifier";

export interface ToolPolicy {
	readonly role: ToolRole;
	readonly cwd: string;
	readonly readRoots: readonly string[];
	readonly writeRoots: readonly string[];
	readonly deniedReadPaths: readonly string[];
	readonly allowedCommands: readonly string[];
	readonly timeoutMs: number;
	readonly maxOutputBytes: number;
	readonly envAllowlist: readonly string[];
}

export interface CreateToolPolicyOptions {
	readonly role: ToolRole;
	readonly dataDir: string;
	readonly worktreeRoot: string;
	readonly evidenceRoot?: string | null;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
	readonly allowedCommands?: readonly string[];
	readonly envAllowlist?: readonly string[];
}
