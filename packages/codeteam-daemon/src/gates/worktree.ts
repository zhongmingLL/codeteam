import { resolve } from "node:path";
import { type GateFinding, type GateResult, gateResult } from "./types.ts";

export interface WorktreeEvidence {
	readonly repoPath: string;
	readonly worktreePath: string;
	readonly primaryWorktreePath: string;
	readonly branch: string | null;
	readonly baseRef: string;
	readonly baseSha: string | null;
	readonly remoteBaseSha: string | null;
	readonly headSha: string | null;
	readonly dirtyPaths: readonly string[];
	readonly baseIsAncestorOfHead: boolean | null;
}

export interface WorktreeGateOptions {
	readonly phase?: "start" | "merge";
	readonly allowUnsyncedBase?: boolean;
	readonly allowPrimaryWorktree?: boolean;
}

export function evaluateWorktreeGate(evidence: WorktreeEvidence, options: WorktreeGateOptions = {}): GateResult {
	const findings: GateFinding[] = [];
	const evidenceRefs: string[] = [];
	const phase = options.phase ?? "start";
	if (!evidence.baseRef.trim()) {
		findings.push({ code: "base_ref_missing", severity: "P1", message: "base ref is required" });
	}
	if (!evidence.headSha) {
		findings.push({ code: "head_unknown", severity: "P1", message: "worktree HEAD could not be resolved" });
	} else {
		evidenceRefs.push(`git:${evidence.headSha}`);
	}
	if (!evidence.baseSha) {
		findings.push({ code: "base_unknown", severity: "P1", message: "base SHA could not be resolved" });
	} else {
		evidenceRefs.push(`git:${evidence.baseSha}`);
	}
	if (evidence.remoteBaseSha) evidenceRefs.push(`git:${evidence.remoteBaseSha}`);
	if (
		phase === "start" &&
		resolve(evidence.worktreePath) === resolve(evidence.primaryWorktreePath) &&
		!options.allowPrimaryWorktree
	) {
		findings.push({
			code: "worktree_must_be_isolated",
			severity: "P1",
			message: "changes must run in an isolated worktree, not the primary checkout",
			evidenceRef: evidence.worktreePath,
		});
	}
	if (phase === "start" && evidence.branch !== null && evidence.branch === evidence.baseRef) {
		findings.push({
			code: "worktree_on_base_branch",
			severity: "P1",
			message: `worktree is checked out on the base branch ${evidence.baseRef}`,
		});
	}
	if (phase === "merge" && evidence.branch !== evidence.baseRef) {
		findings.push({
			code: "merge_target_not_on_base",
			severity: "P1",
			message: `merge target checkout must be on ${evidence.baseRef}, found ${evidence.branch ?? "detached HEAD"}`,
		});
	}
	if (!evidence.remoteBaseSha) {
		const severity = options.allowUnsyncedBase ? "P3" : "P1";
		findings.push({
			code: "remote_base_unknown",
			severity,
			message: `remote tracking ref for ${evidence.baseRef} is unavailable`,
		});
	} else if (evidence.baseSha && evidence.baseSha !== evidence.remoteBaseSha) {
		const severity = options.allowUnsyncedBase ? "P3" : "P1";
		findings.push({
			code: "base_not_synced",
			severity,
			message: `local ${evidence.baseRef} does not match its remote tracking ref`,
		});
	}
	if (evidence.dirtyPaths.length > 0) {
		findings.push({
			code: phase === "merge" ? "worktree_dirty_at_merge" : "worktree_dirty",
			severity: phase === "merge" ? "P1" : "P3",
			message: `worktree has ${evidence.dirtyPaths.length} uncommitted path(s)`,
			evidenceRef: evidence.dirtyPaths[0],
		});
	}
	if (evidence.baseIsAncestorOfHead === false) {
		findings.push({
			code: "head_not_based_on_base",
			severity: "P2",
			message: "head is not a descendant of the current base",
		});
	} else if (evidence.baseIsAncestorOfHead === null) {
		findings.push({ code: "base_ancestry_unknown", severity: "P2", message: "base ancestry could not be resolved" });
	}
	return gateResult("worktree", findings, evidenceRefs, `phase=${phase}`);
}
