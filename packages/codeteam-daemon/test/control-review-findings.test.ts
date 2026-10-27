import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlStore, ToolPolicy } from "../src/index.ts";
import { ControlError, createToolPolicy, openControlStore } from "../src/index.ts";
import {
	DEFAULT_BLOCKED_TTL_MS,
	executeFalsifier,
	isBlockedExpired,
	normalizeFindings,
	parseFalsifierCommand,
} from "../src/review/index.ts";

const dirs: string[] = [];
let root: string;
let worktree: string;
let evidence: string;
let dataDir: string;
let policy: ToolPolicy;
let store: ControlStore;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "codeteam-review-findings-"));
	dirs.push(root);
	worktree = join(root, "worktree");
	evidence = join(root, "evidence");
	dataDir = join(root, "data");
	mkdirSync(join(worktree, "src"), { recursive: true });
	mkdirSync(evidence, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(join(worktree, "src", "bug.ts"), "// BUG: wrong value\n");
	policy = createToolPolicy({ role: "verifier", dataDir, worktreeRoot: worktree, evidenceRoot: evidence });
	store = openControlStore({ dataDir });
});

afterEach(() => {
	store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function normalize(overrides: Record<string, unknown> = {}) {
	return normalizeFindings(
		[
			{
				severity: "P2",
				file: "src/bug.ts",
				line: 1,
				claim: "wrong value",
				evidenceKind: "static_check",
				falsifier: "grep -q BUG src/bug.ts",
				falsifierExpected: "zero",
				requiredAction: "fix",
				...overrides,
			},
		],
		{ verifierPolicy: policy, worktreeRoot: worktree },
	);
}

describe("W3 finding and falsifier policy", () => {
	it("parses shell-free falsifier commands with quoted arguments", () => {
		expect(parseFalsifierCommand("grep -q BUG src/bug.ts")).toEqual(["grep", "-q", "BUG", "src/bug.ts"]);
		expect(parseFalsifierCommand('node --test --test-name-pattern="a b"')).toEqual([
			"node",
			"--test",
			"--test-name-pattern=a b",
		]);
		expect(() => parseFalsifierCommand('grep "unterminated')).toThrow(ControlError);
		expect(() => parseFalsifierCommand("   ")).toThrow(ControlError);
	});

	it("downgrades only the unverifiable P1/P2 finding and keeps executable findings", () => {
		const result = normalizeFindings(
			[
				{
					severity: "P1",
					claim: "no evidence",
					evidenceKind: "code_reading",
					falsifier: "",
					requiredAction: "add evidence",
				},
				{
					severity: "P2",
					file: "src/bug.ts",
					line: 1,
					claim: "real bug",
					evidenceKind: "static_check",
					falsifier: "grep -q BUG src/bug.ts",
					falsifierExpected: "zero",
					requiredAction: "fix",
				},
				{
					severity: "P3",
					claim: "style nit",
					evidenceKind: "judgment",
					falsifier: "reviewer judgment",
					requiredAction: "consider",
				},
			],
			{ verifierPolicy: policy, worktreeRoot: worktree },
		);
		expect(result.findings.map((finding) => finding.severity)).toEqual(["P3", "P2", "P3"]);
		expect(result.downgrades).toHaveLength(1);
		expect(result.downgrades[0]).toMatchObject({ index: 0, from: "P1", to: "P3" });
		expect(result.downgrades[0]?.reason).toMatch(/evidence|falsifier/i);
	});

	it("downgrades commands outside the verifier allowlist, shell operators, absolute paths, and traversal", () => {
		expect(normalize({ falsifier: "rm -rf src" }).findings[0]?.severity).toBe("P3");
		expect(normalize({ falsifier: "grep -q BUG src/bug.ts; rm -rf src" }).findings[0]?.severity).toBe("P3");
		expect(normalize({ falsifier: "grep -q BUG /etc/passwd", file: "src/bug.ts" }).findings[0]?.severity).toBe("P3");
		expect(normalize({ falsifier: "grep -q BUG ../outside.ts", file: "src/bug.ts" }).findings[0]?.severity).toBe(
			"P3",
		);
	});

	it("rejects unsafe finding file references instead of treating them as a P3", () => {
		expect(() => normalize({ file: "../../etc/passwd" })).toThrow(ControlError);
		expect(() => normalize({ file: "/etc/passwd" })).toThrow(ControlError);
	});

	it("executes falsifiers into confirmed, rejected, and blocked states", async () => {
		const confirmed = await executeFalsifier({
			finding: {
				id: "finding-1",
				severity: "P2",
				evidenceKind: "static_check",
				falsifier: "grep -q BUG src/bug.ts",
				falsifierExpected: "zero",
			},
			reviewId: "review-1",
			policy,
		});
		expect(confirmed.status).toBe("confirmed");
		expect(confirmed.exitCode).toBe(0);

		const rejected = await executeFalsifier({
			finding: {
				id: "finding-1",
				severity: "P2",
				evidenceKind: "static_check",
				falsifier: "grep -q BUG src/bug.ts",
				falsifierExpected: "nonzero",
			},
			reviewId: "review-1",
			policy,
		});
		expect(rejected.status).toBe("rejected");

		const missing = await executeFalsifier({
			finding: {
				id: "finding-1",
				severity: "P2",
				evidenceKind: "static_check",
				falsifier: "grep -q MISSING src/bug.ts",
				falsifierExpected: "zero",
			},
			reviewId: "review-1",
			policy,
		});
		expect(missing.status).toBe("rejected");
		expect(missing.exitCode).toBe(1);

		const brokenPolicy = createToolPolicy({
			role: "verifier",
			dataDir,
			worktreeRoot: worktree,
			evidenceRoot: evidence,
			allowedCommands: ["definitely-not-a-real-command"],
		});
		const blocked = await executeFalsifier({
			finding: {
				id: "finding-1",
				severity: "P2",
				evidenceKind: "repro_command",
				falsifier: "definitely-not-a-real-command",
				falsifierExpected: "nonzero",
			},
			reviewId: "review-1",
			policy: brokenPolicy,
		});
		expect(blocked.status).toBe("blocked");
		expect(blocked.reason).toMatch(/infrastructure|spawn|command/i);
		expect(blocked.blockedExpiresAt).toBeGreaterThan(Date.now());
	});

	it("expires blocked verifications and escalates, never treating them as confirmed", () => {
		const blocked = { status: "blocked" as const, createdAt: 1_000 };
		expect(isBlockedExpired(blocked, 1_000 + DEFAULT_BLOCKED_TTL_MS - 1)).toBe(false);
		expect(isBlockedExpired(blocked, 1_000 + DEFAULT_BLOCKED_TTL_MS)).toBe(true);
		expect(isBlockedExpired({ status: "confirmed", createdAt: 1_000 }, 99_999_999)).toBe(false);
	});

	it("records producingReviewId on the verifier command audit", async () => {
		await executeFalsifier({
			finding: {
				id: "finding-1",
				severity: "P2",
				evidenceKind: "static_check",
				falsifier: "grep -q BUG src/bug.ts",
				falsifierExpected: "zero",
			},
			reviewId: "review-1",
			policy,
			audit: { store, actorRef: "review:review-1", producingReviewId: "review-1" },
		});
		const audit = store.audit.latest("tool:grep", "tool_command");
		expect(audit?.args).toMatchObject({ producingReviewId: "review-1", exitCode: 0 });
	});
});
