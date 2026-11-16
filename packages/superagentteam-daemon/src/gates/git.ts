import { execFileSync } from "node:child_process";
import { ControlError } from "../control/errors.ts";
import { parseGitNumstat } from "./risk.ts";
import type { WorktreeEvidence } from "./worktree.ts";

export interface GitCommandResult {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
}

export function runGit(args: readonly string[], cwd: string): GitCommandResult {
	try {
		const stdout = execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: 0, stdout: stdout.trim(), stderr: "" };
	} catch (error) {
		const candidate = error as { status?: number; stdout?: string; stderr?: string; message?: string };
		return {
			status: typeof candidate.status === "number" ? candidate.status : 1,
			stdout: candidate.stdout?.toString().trim() ?? "",
			stderr: candidate.stderr?.toString().trim() ?? candidate.message ?? String(error),
		};
	}
}

export function requireGit(args: readonly string[], cwd: string): string {
	const result = runGit(args, cwd);
	if (result.status !== 0) {
		throw new ControlError("invalid_input", `git ${args.join(" ")} failed: ${result.stderr || result.status}`);
	}
	return result.stdout;
}

export function inspectWorktree(repoPath: string, worktreePath: string, baseRef: string): WorktreeEvidence {
	const worktreeRoot = requireGit(["rev-parse", "--show-toplevel"], worktreePath);
	const repoRoot = requireGit(["rev-parse", "--show-toplevel"], repoPath);
	const list = requireGit(["worktree", "list", "--porcelain"], repoRoot);
	const primaryWorktreePath = parseWorktreeList(list)[0]?.path ?? repoRoot;
	const headResult = runGit(["rev-parse", "HEAD"], worktreeRoot);
	const baseResult = runGit(["rev-parse", baseRef], repoRoot);
	const branchResult = runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], worktreeRoot);
	const remoteRef = baseRef.startsWith("origin/") ? baseRef : `origin/${baseRef}`;
	const remoteResult = runGit(["rev-parse", remoteRef], repoRoot);
	const status = runGit(["status", "--porcelain"], worktreeRoot);
	const dirtyPaths =
		status.status === 0
			? status.stdout
					.split(/\r?\n/)
					.filter((line) => line.trim() !== "")
					.map((line) => parsePorcelainPath(line))
			: [];
	let baseIsAncestorOfHead: boolean | null = null;
	if (baseResult.status === 0 && headResult.status === 0) {
		const ancestor = runGit(["merge-base", "--is-ancestor", baseResult.stdout, headResult.stdout], worktreeRoot);
		if (ancestor.status === 0) baseIsAncestorOfHead = true;
		else if (ancestor.status === 1) baseIsAncestorOfHead = false;
	}
	return {
		repoPath: repoRoot,
		worktreePath: worktreeRoot,
		primaryWorktreePath,
		branch: branchResult.status === 0 ? branchResult.stdout : null,
		baseRef,
		baseSha: baseResult.status === 0 ? baseResult.stdout : null,
		remoteBaseSha: remoteResult.status === 0 ? remoteResult.stdout : null,
		headSha: headResult.status === 0 ? headResult.stdout : null,
		dirtyPaths,
		baseIsAncestorOfHead,
	};
}

export function diffNumstat(repoPath: string, baseRef: string, headRef: string) {
	const baseSha = requireGit(["rev-parse", baseRef], repoPath);
	const headSha = requireGit(["rev-parse", headRef], repoPath);
	const output = requireGit(["diff", "--numstat", baseSha, headSha], repoPath);
	return { baseSha, headSha, files: parseGitNumstat(output) };
}

function parseWorktreeList(output: string): Array<{ path: string }> {
	const entries: Array<{ path: string }> = [];
	for (const block of output.split(/\r?\n\r?\n/)) {
		const pathLine = block.split(/\r?\n/).find((line) => line.startsWith("worktree "));
		if (pathLine) entries.push({ path: pathLine.slice("worktree ".length).trim() });
	}
	return entries;
}

function parsePorcelainPath(line: string): string {
	const raw = line.slice(3).trim();
	const rename = raw.indexOf(" -> ");
	return rename >= 0 ? raw.slice(rename + 4).trim() : raw;
}
