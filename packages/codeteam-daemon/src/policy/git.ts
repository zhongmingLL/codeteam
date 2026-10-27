import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import { runCommand } from "./exec.ts";
import type { ToolPolicy } from "./types.ts";

export interface CommitWithAuditInput {
	readonly message: string;
	readonly paths?: readonly string[];
	readonly actorRef: string;
	readonly env?: Record<string, string>;
}

export interface CommitWithAuditResult {
	readonly previousHead: string | null;
	readonly commitSha: string;
	readonly auditId: string;
}

export async function commitWithAudit(
	store: ControlStore,
	policy: ToolPolicy,
	input: CommitWithAuditInput,
): Promise<CommitWithAuditResult> {
	const previousHead = await resolveHead(policy, input.env);
	if (input.paths && input.paths.length > 0) {
		const add = await runCommand(policy, { argv: ["git", "add", ...input.paths], env: input.env });
		if (add.exitCode !== 0) throw new ControlError("command_failed", `git add failed: ${tail(add.stderr)}`);
	}
	const commit = await runCommand(policy, { argv: ["git", "commit", "-m", input.message], env: input.env });
	if (commit.exitCode !== 0) throw new ControlError("command_failed", `git commit failed: ${tail(commit.stderr)}`);
	const commitSha = await resolveHead(policy, input.env);
	if (!commitSha) throw new ControlError("command_failed", "git commit produced no HEAD");
	if (commitSha === previousHead) throw new ControlError("command_failed", "git commit did not advance HEAD");
	const verified = await runCommand(policy, {
		argv: ["git", "rev-parse", "--verify", `${commitSha}^{commit}`],
		env: input.env,
	});
	if (verified.exitCode !== 0) {
		throw new ControlError("command_failed", "commit object could not be verified");
	}
	if (previousHead) {
		const parents = await runCommand(policy, {
			argv: ["git", "show", "-s", "--format=%P", commitSha],
			env: input.env,
		});
		if (parents.exitCode !== 0) {
			throw new ControlError("command_failed", `git show failed: ${tail(parents.stderr)}`);
		}
		const parentList = parents.stdout.trim().split(/\s+/).filter(Boolean);
		if (!parentList.includes(previousHead)) {
			throw new ControlError("command_failed", "commit parent chain does not include the previous HEAD");
		}
	}
	const audit = store.audit.append({
		actor: input.actorRef,
		action: "commit_created",
		subject: `commit:${commitSha}`,
		args: { previousHead, headSha: commitSha, paths: input.paths ?? [], cwd: policy.cwd },
	});
	return { previousHead, commitSha, auditId: audit.id };
}

async function resolveHead(policy: ToolPolicy, env: Record<string, string> | undefined): Promise<string | null> {
	const result = await runCommand(policy, { argv: ["git", "rev-parse", "HEAD"], env });
	if (result.exitCode !== 0) return null;
	const sha = result.stdout.trim();
	return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

function tail(text: string): string {
	return text.trim().slice(-500);
}
