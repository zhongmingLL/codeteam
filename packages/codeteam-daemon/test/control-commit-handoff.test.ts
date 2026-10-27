import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assertHandoffDirection,
	ControlError,
	type ControlStore,
	commitWithAudit,
	createToolPolicy,
	evaluateCommand,
	openControlStore,
	type ToolPolicy,
} from "../src/index.ts";

const dirs: string[] = [];
let root: string;
let dataDir: string;
let worktree: string;
let policy: ToolPolicy;
let store: ControlStore;
let initialHead: string;

function git(args: string[]): string {
	return execFileSync("git", args, { cwd: worktree, encoding: "utf8" }).trim();
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "codeteam-commit-"));
	dirs.push(root);
	dataDir = join(root, "data");
	worktree = join(root, "worktree");
	mkdirSync(join(worktree, "src"), { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	git(["init", "-q"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "Test"]);
	writeFileSync(join(worktree, "a.txt"), "a\n");
	git(["add", "a.txt"]);
	git(["commit", "-q", "-m", "init"]);
	initialHead = git(["rev-parse", "HEAD"]);
	store = openControlStore({ dataDir });
	policy = createToolPolicy({ role: "coder", dataDir, worktreeRoot: worktree });
});

afterEach(() => {
	store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codeteam commit wrapper and handoff direction", () => {
	it("commits paths through the wrapper and records the head chain in audit", async () => {
		writeFileSync(join(worktree, "src", "b.ts"), "export const b = 2;\n");
		const result = await commitWithAudit(store, policy, {
			message: "feat: add b",
			paths: ["src/b.ts"],
			actorRef: "profile:coder",
		});

		expect(result.previousHead).toBe(initialHead);
		expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
		expect(result.commitSha).not.toBe(initialHead);
		const audit = store.audit.latest(`commit:${result.commitSha}`, "commit_created");
		expect(audit).not.toBeNull();
		expect(audit?.args).toMatchObject({ previousHead: initialHead, headSha: result.commitSha });
	});

	it("fails with a typed error when git commit makes no commit", async () => {
		await expect(
			commitWithAudit(store, policy, { message: "empty", actorRef: "profile:coder" }),
		).rejects.toMatchObject({ code: "command_failed" });
	});

	it("derives fromRole from the token binding and enforces the direction whitelist", () => {
		const coder = { role: "coder", runId: "run-1" };
		const reviewer = { role: "reviewer", runId: "run-2" };

		expect(assertHandoffDirection(coder, { toRole: "reviewer", kind: "review_request" })).toEqual({
			fromRole: "coder",
			actionPair: "coder->reviewer:review",
		});
		expect(assertHandoffDirection(reviewer, { toRole: "coder", kind: "verdict" })).toEqual({
			fromRole: "reviewer",
			actionPair: "reviewer->coder:verdict",
		});
		expect(assertHandoffDirection(coder, { toRole: "human", kind: "blocker" })).toEqual({
			fromRole: "coder",
			actionPair: "coder->human:blocker",
		});
		expect(() => assertHandoffDirection(coder, { toRole: "reviewer", kind: "verdict" })).toThrow(ControlError);
		expect(() => assertHandoffDirection(reviewer, { toRole: "reviewer", kind: "review_request" })).toThrow(
			ControlError,
		);
	});

	it("ignores caller-declared fromRole and accepts custom action pairs", () => {
		const binding = { role: "coder", runId: "run-1" };
		const spoofed = { toRole: "architect", kind: "handoff", fromRole: "reviewer" } as unknown as {
			toRole: string;
			kind: "handoff";
		};
		expect(() => assertHandoffDirection(binding, spoofed)).toThrow(ControlError);
		expect(assertHandoffDirection(binding, spoofed, { actionPairs: ["coder->architect:handoff"] })).toEqual({
			fromRole: "coder",
			actionPair: "coder->architect:handoff",
		});
	});

	it("rejects cwd outside the allowed roots", () => {
		expect(() => evaluateCommand(policy, { argv: ["git", "status"], cwd: root })).toThrow(ControlError);
		expect(evaluateCommand(policy, { argv: ["git", "status"] }).cwd).toBe(worktree);
	});
});
