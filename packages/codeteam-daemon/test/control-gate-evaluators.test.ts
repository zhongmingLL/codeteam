import { describe, expect, it } from "vitest";
import type { Approval, Merge, Review, SopCheckEvidence, Verification } from "../src/control/stores/types.ts";
import { evaluateCompletionGate } from "../src/gates/completion.ts";
import { evaluateDesignGate } from "../src/gates/design.ts";
import { evaluateReviewGate } from "../src/gates/review.ts";
import { classifyRisk } from "../src/gates/risk.ts";
import { evaluateVerifyGate } from "../src/gates/verify.ts";
import { evaluateWorktreeGate } from "../src/gates/worktree.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

function review(overrides: Partial<Review> = {}): Review {
	return {
		id: "review-1",
		taskId: "task-1",
		runId: "run-1",
		headSha: HEAD,
		baseSha: BASE,
		authorSessionId: "author",
		authorModel: "deepseek-flash",
		authorModelFamily: "deepseek",
		reviewerSessionId: "reviewer",
		reviewerModel: "glm-5.3-flash",
		reviewerModelFamily: "glm",
		authorProfileId: "profile-author",
		reviewerProfileId: "profile-reviewer",
		riskClass: "code",
		reviewMode: "cross_family",
		verdict: "approve",
		round: 1,
		stage: "review",
		previousReviewId: null,
		envelope: {},
		decision: {},
		policy: {},
		findings: [],
		createdAt: 1,
		...overrides,
	};
}

function verification(overrides: Partial<Verification> = {}): Verification {
	return {
		id: "verification-1",
		findingId: "finding-1",
		headSha: HEAD,
		producingReviewId: "review-1",
		status: "rejected",
		reason: "fixed",
		command: "node --test",
		cwd: ".",
		exitCode: 0,
		durationMs: 1,
		stdoutTail: null,
		stderrTail: null,
		blockedExpiresAt: null,
		createdAt: 1,
		...overrides,
	};
}

describe("codeteam point gate evaluators", () => {
	it("review gate requires exact HEAD/base, non-owner approval, and closed P1/P2", () => {
		const finding = {
			id: "finding-1",
			reviewId: "review-1",
			findingIndex: 0,
			severity: "P1" as const,
			file: "src/a.ts",
			line: 1,
			claim: "bug",
			evidenceKind: "red_test" as const,
			falsifier: "node --test",
			falsifierExpected: null,
			requiredAction: "fix",
		};
		const blocked = evaluateReviewGate({
			taskId: "task-1",
			taskOwnerProfileId: null,
			headSha: HEAD,
			baseSha: BASE,
			reviews: [review({ findings: [finding] })],
			verifications: () => [],
		});
		expect(blocked.status).toBe("block");
		expect(blocked.findings.map((item) => item.code)).toContain("p1p2_without_verification");
		const closed = evaluateReviewGate({
			taskId: "task-1",
			taskOwnerProfileId: null,
			headSha: HEAD,
			baseSha: BASE,
			reviews: [review({ findings: [finding] })],
			verifications: () => [verification()],
		});
		expect(closed.status).toBe("pass");
		const owner = evaluateReviewGate({
			taskId: "task-1",
			taskOwnerProfileId: "profile-reviewer",
			headSha: HEAD,
			baseSha: BASE,
			reviews: [review()],
			verifications: () => [],
		});
		expect(owner.findings.map((item) => item.code)).toContain("reviewer_is_task_owner");
	});

	it("verify gate requires terminal falsifier evidence with command/exit code", () => {
		const finding = {
			id: "finding-1",
			reviewId: "review-1",
			findingIndex: 0,
			severity: "P2" as const,
			file: "src/a.ts",
			line: 1,
			claim: "bug",
			evidenceKind: "repro_command" as const,
			falsifier: "node repro.mjs",
			falsifierExpected: null,
			requiredAction: "fix",
		};
		const result = evaluateVerifyGate({
			taskId: "task-1",
			headSha: HEAD,
			baseSha: BASE,
			reviews: [review({ findings: [finding] })],
			verifications: () => [verification({ command: null, exitCode: null })],
		});
		expect(result.findings.map((item) => item.code)).toContain("verification_missing_command_evidence");
		const confirmed = evaluateVerifyGate({
			taskId: "task-1",
			headSha: HEAD,
			baseSha: BASE,
			reviews: [review({ findings: [finding] })],
			verifications: () => [verification({ status: "confirmed", exitCode: 1 })],
		});
		expect(confirmed.status).toBe("block");
	});

	it("worktree gate enforces start isolation and merge-time base sync", () => {
		const base = {
			repoPath: "/repo",
			worktreePath: "/repo",
			primaryWorktreePath: "/repo",
			branch: "main",
			baseRef: "main",
			baseSha: BASE,
			remoteBaseSha: BASE,
			headSha: HEAD,
			dirtyPaths: [],
			baseIsAncestorOfHead: true,
		};
		expect(evaluateWorktreeGate(base, { phase: "start" }).findings.map((item) => item.code)).toContain(
			"worktree_must_be_isolated",
		);
		expect(evaluateWorktreeGate(base, { phase: "merge" }).status).toBe("pass");
		expect(
			evaluateWorktreeGate({ ...base, worktreePath: "/worktree", branch: "feat" }, { phase: "start" }).status,
		).toBe("pass");
		expect(
			evaluateWorktreeGate({ ...base, baseSha: "c".repeat(40) }, { phase: "merge" }).findings.map(
				(item) => item.code,
			),
		).toContain("base_not_synced");
		const overridden = evaluateWorktreeGate(
			{ ...base, remoteBaseSha: null },
			{ phase: "merge", allowUnsyncedBase: true },
		);
		expect(overridden.overrides).toContain("allow_unsynced_base");
	});

	it("design gate is machine-default and only critical/spec_change needs human approval", () => {
		const risk = classifyRisk({ changedFiles: [{ path: "docs/plan.md", additions: 1, deletions: 0 }] });
		const machine = evaluateDesignGate({
			taskId: "task-1",
			specRef: "docs/plan.md",
			acceptanceCriteria: ["works"],
			userJourney: [],
			userVisible: false,
			risk,
		});
		expect(machine.status).toBe("pass");
		const criticalRisk = classifyRisk({
			changedFiles: [{ path: "packages/codeteam-daemon/src/auth/operator.ts", additions: 1, deletions: 0 }],
		});
		const human = evaluateDesignGate({
			taskId: "task-1",
			specRef: "docs/plan.md",
			acceptanceCriteria: ["works"],
			userJourney: ["user opens the CLI"],
			userVisible: true,
			risk: criticalRisk,
		});
		expect(human.findings.map((item) => item.code)).toContain("design_gate_human_required");
		const approval = {
			id: "approval-1",
			kind: "design_gate",
			resolution: "accepted",
		} as Approval;
		const accepted = evaluateDesignGate({
			taskId: "task-1",
			specRef: "docs/plan.md",
			acceptanceCriteria: ["works"],
			userJourney: ["user opens the CLI"],
			userVisible: true,
			risk: criticalRisk,
			approval,
		});
		expect(accepted.status).toBe("pass");
	});

	it("completion gate requires done backlog, operator, merge receipt, and fresh vision evidence", () => {
		const merge = {
			id: "merge-1",
			status: "succeeded",
			headSha: HEAD,
			mergeSha: "c".repeat(40),
			executedBy: "service:merge-owner",
			gateEvidenceRef: "audit:gate",
		} as Merge;
		const evidence = { id: "evidence-1", subjectRevision: "c".repeat(40) } as SopCheckEvidence;
		const result = evaluateCompletionGate({
			backlogStatus: "done",
			actor: "operator:test",
			merge,
			visionEvidence: evidence,
			acceptanceRef: "message:acceptance",
		});
		expect(result.status).toBe("pass");
		const missing = evaluateCompletionGate({
			backlogStatus: "open",
			actor: "profile:coder",
			merge: null,
			visionEvidence: null,
		});
		expect(missing.status).toBe("block");
	});
});
