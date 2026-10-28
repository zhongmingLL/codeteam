import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initOperatorCredential, loadOperatorPrivateKey, loadOperatorPublicKey } from "../src/auth/index.ts";
import { type ControlStore, MergeExecutor, openControlStore } from "../src/index.ts";

const dirs: string[] = [];
let store: ControlStore;
let dataDir: string;
let repo: string;

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
			GIT_CONFIG_NOSYSTEM: "1",
		},
	}).trim();
}

function commitFile(path: string, content: string): string {
	writeFileSync(join(repo, path), content);
	git(repo, ["add", path]);
	git(repo, ["commit", "-m", `update ${path}`]);
	return git(repo, ["rev-parse", "HEAD"]);
}

function createRepo(): void {
	repo = mkdtempSync(join(tmpdir(), "codeteam-merge-repo-"));
	dirs.push(repo);
	git(repo, ["init", "-b", "main"]);
	git(repo, ["config", "user.email", "test@example.com"]);
	git(repo, ["config", "user.name", "Test"]);
	mkdirSync(join(repo, "docs"), { recursive: true });
	commitFile("docs/base.md", "base\n");
}

function createWork() {
	const backlog = store.backlog.create({
		id: `backlog-${Math.random().toString(16).slice(2)}`,
		userId: "user-1",
		title: "Merge work",
		summary: "Merge work",
		priority: "p1",
		tags: ["feature:F007"],
		createdByKind: "user",
		createdById: "operator:test",
		initialStatus: "dispatched",
		importReason: "test fixture",
	});
	const thread = store.threads.create({ backlogItemId: backlog.id, phase: "coding" });
	const task = store.tasks.create({
		id: `task-${Math.random().toString(16).slice(2)}`,
		kind: "work",
		threadId: thread.id,
		title: "Merge work",
		why: "test merge executor",
		createdBy: "operator:test",
		userId: "user-1",
		backlogItemId: backlog.id,
	});
	return { backlog, thread, task };
}

function execute(input: {
	taskId: string;
	headSha: string;
	hardGate?: boolean;
	approvalId?: string | null;
	prRef?: string;
}) {
	return new MergeExecutor(store).execute({
		taskId: input.taskId,
		repoPath: repo,
		worktreePath: repo,
		baseRef: "main",
		headSha: input.headSha,
		prRef: input.prRef ?? "local#1",
		allowUnsyncedBase: true,
		hardGate: input.hardGate,
		approvalId: input.approvalId ?? null,
		operatorId: "operator:test",
		operatorPrivateKey: loadOperatorPrivateKey(dataDir),
		operatorPublicKey: loadOperatorPublicKey(dataDir),
	});
}

beforeEach(() => {
	createRepo();
	dataDir = mkdtempSync(join(tmpdir(), "codeteam-merge-data-"));
	dirs.push(dataDir);
	initOperatorCredential({ dataDir });
	store = openControlStore({ dataDir });
});

afterEach(() => {
	store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("local MergeExecutor", () => {
	it("executes a docs fast-lane merge, records a gate-backed receipt, and completes the SOP", () => {
		const { backlog, thread, task } = createWork();
		git(repo, ["checkout", "-b", "feature", "-q"]);
		const featureSha = commitFile("docs/base.md", "base\nfeature\n");
		git(repo, ["checkout", "main", "-q"]);
		const result = execute({ taskId: task.id, headSha: featureSha });
		expect(result.gate.status).not.toBe("block");
		expect(result.receipt.status).toBe("succeeded");
		expect(result.receipt.executedBy).toBe("service:merge-owner");
		expect(result.receipt.gateEvidenceRef).toBeTruthy();
		expect(git(repo, ["rev-parse", "main"])).toBe(result.receipt.mergeSha);
		expect(store.audit.latest(`merge:${result.receipt.id}`, "merge_recorded")).not.toBeNull();
		expect(store.audit.latest("gate:merge", "gate_evaluated")?.args.overrides).toContain("allow_unsynced_base");
		store.backlog.markDone(backlog.id, "operator:test");
		const verdict = store.messages.append({
			threadId: thread.id,
			authorKind: "agent",
			authorId: "profile:vision-guard",
			kind: "verdict",
			bodyMd: "accepted",
		});
		store.sopEvidence.record({
			backlogItemId: backlog.id,
			checkName: "visionGuardDone",
			evidenceKind: "vision_guard",
			evidenceRef: `message:${verdict.id}`,
			subjectRevision: result.receipt.mergeSha,
			recordedBy: "operator:test",
		});
		const sop = store.sops.upsert({
			backlogItemId: backlog.id,
			featureId: "F007",
			stage: "completion",
			batonHolder: "operator",
			resumeCapsule: { goal: "ship", done: ["merged"], currentFocus: "close" },
			checks: {
				remoteMainSynced: "unknown",
				qualityGatePassed: "unknown",
				reviewApproved: "unknown",
				visionGuardDone: "unknown",
			},
			updatedBy: "operator:test",
			completionSubjectRevision: result.receipt.mergeSha,
		});
		expect(sop.stage).toBe("completion");
	});

	it("blocks code merges without the required independent review and leaves HEAD unchanged", () => {
		const { task } = createWork();
		git(repo, ["checkout", "-b", "feature-code", "-q"]);
		mkdirSync(join(repo, "packages/codeteam-daemon/src/auth"), { recursive: true });
		const featureSha = commitFile("packages/codeteam-daemon/src/auth/foo.ts", "export const x = 1;\n");
		git(repo, ["checkout", "main", "-q"]);
		const before = git(repo, ["rev-parse", "main"]);
		expect(() => execute({ taskId: task.id, headSha: featureSha })).toThrow(/merge_gate_blocked/);
		expect(git(repo, ["rev-parse", "main"])).toBe(before);
	});

	it("requires an accepted hard-gate approval and then executes", () => {
		const { thread, task } = createWork();
		git(repo, ["checkout", "-b", "feature-hard", "-q"]);
		const featureSha = commitFile("docs/base.md", "base\nhard-gate\n");
		git(repo, ["checkout", "main", "-q"]);
		expect(() => execute({ taskId: task.id, headSha: featureSha, hardGate: true })).toThrow(/merge_gate_blocked/);
		const approval = store.approvals.create({
			threadId: thread.id,
			taskId: task.id,
			kind: "merge",
			idempotencyKey: "hard-gate-merge",
			originRef: {},
			cardRef: {},
			payload: { headSha: featureSha, prRef: "local#1" },
			requestedBy: "operator:test",
		});
		store.approvals.decide(approval.id, { resolution: "accepted", decidedBy: "operator:test" });
		const result = execute({ taskId: task.id, headSha: featureSha, hardGate: true, approvalId: approval.id });
		expect(result.receipt.status).toBe("succeeded");
		expect(result.receipt.hardGate).toBe(true);
		expect(result.receipt.approvalId).toBe(approval.id);
	});

	it("blocks a moved base before executing git merge", () => {
		const { task } = createWork();
		git(repo, ["checkout", "-b", "feature-moved-base", "-q"]);
		const featureSha = commitFile("docs/base.md", "feature\n");
		git(repo, ["checkout", "main", "-q"]);
		commitFile("docs/base.md", "main\n");
		const before = git(repo, ["rev-parse", "main"]);
		expect(() => execute({ taskId: task.id, headSha: featureSha })).toThrow(/merge_head_not_based_on_base/);
		expect(git(repo, ["rev-parse", "main"])).toBe(before);
	});

	it("records a failed receipt when git merge itself fails", () => {
		const { task } = createWork();
		git(repo, ["checkout", "-b", "feature-hook", "-q"]);
		const featureSha = commitFile("docs/base.md", "base\nhook\n");
		git(repo, ["checkout", "main", "-q"]);
		writeFileSync(join(repo, ".git", "hooks", "pre-merge-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		const before = git(repo, ["rev-parse", "main"]);
		const result = execute({ taskId: task.id, headSha: featureSha });
		expect(result.receipt.status).toBe("failed");
		expect(result.receipt.failureRef).toMatch(/merge_failed/);
		expect(git(repo, ["rev-parse", "main"])).toBe(before);
		expect(git(repo, ["status", "--porcelain"])).toBe("");
	});

	it("fails closed and leaves a gate audit when the diff contains a binary file", () => {
		const { task } = createWork();
		git(repo, ["checkout", "-b", "feature-binary", "-q"]);
		writeFileSync(join(repo, "docs", "binary.bin"), Buffer.from([0, 1, 2, 3]));
		git(repo, ["add", "docs/binary.bin"]);
		git(repo, ["commit", "-m", "binary"]);
		const featureSha = git(repo, ["rev-parse", "HEAD"]);
		git(repo, ["checkout", "main", "-q"]);
		expect(() => execute({ taskId: task.id, headSha: featureSha })).toThrow(/binary diff/);
		const audit = store.audit.latest("gate:merge", "gate_evaluated");
		expect(audit?.args.codes).toContain("P1:binary_diff_unsupported");
	});
});
