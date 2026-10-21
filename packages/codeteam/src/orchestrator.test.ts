import { describe, expect, it } from "vitest";
import { ManualClock } from "./clock.ts";
import { ControlPlane } from "./control-plane.ts";
import {
	type ImplementRequest,
	type ImplementResult,
	type Phase3Error,
	type Phase3Ports,
	type ReviewRequest,
	type ReviewResult,
	runPhase3,
	type VerifyRequest,
	type VerifyResult,
} from "./orchestrator.ts";
import type { ReviewFinding, ReviewVerdict } from "./review/types.ts";
import type { FindingVerification } from "./verifier/types.ts";

const finding: ReviewFinding = {
	severity: "P1",
	file: "src/stats.js",
	claim: "mode returns the maximum value instead of the most frequent value",
	evidenceKind: "static_check",
	falsifier: "grep -F -n 'values[values.length - 1]' src/stats.js",
	falsifierExpected: "zero",
	requiredAction: "count frequencies and return the mode",
};

function verification(
	index: number,
	status: FindingVerification["status"],
	subject: ReviewFinding,
): FindingVerification {
	return {
		finding: subject,
		status,
		reason: status,
		audit: {
			index,
			finding: subject,
			mode: "repro",
			cwd: "/tmp/work",
			command: subject.falsifier,
			status,
			reason: status,
		},
	};
}

interface FakeOptions {
	implement?: (request: ImplementRequest) => ImplementResult;
	review?: (request: ReviewRequest) => ReviewResult;
	verify?: (request: VerifyRequest) => VerifyResult;
}

function makePorts(options: FakeOptions = {}): Phase3Ports {
	return {
		implement: async (request) =>
			options.implement?.(request) ?? {
				diff: `diff-${request.iteration + 1}`,
				testReport: "green",
				testFileUnchanged: true,
				agentInstanceId: `coder-${request.iteration + 1}`,
				provider: "coder-provider",
			},
		review: async (request) =>
			options.review?.(request) ?? {
				verdict: { verdict: "approve", findings: [] },
				agentInstanceId: `reviewer-${request.iteration}`,
				provider: "reviewer-provider",
			},
		verify: async (request) =>
			options.verify?.(request) ?? {
				verifications: request.findings.map((subject, index) =>
					verification(index, request.revision === "initial" ? "confirmed" : "rejected", subject),
				),
			},
	};
}

function setup(ports: Phase3Ports) {
	const clock = new ManualClock(1_000);
	const plane = new ControlPlane({ clock, loopLimit: 5, defaultDeadlineMs: 1_000 });
	return { clock, plane, ports };
}

function verdictOf(verdict: ReviewVerdict["verdict"], findings: ReviewFinding[]): ReviewVerdict {
	return { verdict, findings };
}

describe("phase 3 orchestrator", () => {
	it("runs implement -> review -> verify -> fix -> review -> verify and stops at the human merge gate", async () => {
		let reviewCalls = 0;
		const ports = makePorts({
			implement: (request) => ({
				diff: `diff-${request.iteration + 1}`,
				testReport: "green",
				testFileUnchanged: true,
				agentInstanceId: `coder-${request.iteration + 1}`,
				provider: "coder-provider",
			}),
			review: (request) => {
				reviewCalls += 1;
				return {
					verdict: reviewCalls === 1 ? verdictOf("changes_requested", [finding]) : verdictOf("approve", []),
					agentInstanceId: `reviewer-${request.iteration}`,
					provider: "reviewer-provider",
				};
			},
			verify: (request) => ({
				verifications: request.findings.map((subject, index) =>
					verification(index, request.revision === "initial" ? "confirmed" : "rejected", subject),
				),
			}),
		});
		const { plane } = setup(ports);
		const result = await runPhase3({
			taskId: "task-1",
			objective: "fix the seeded bug",
			initialWorkdir: "/tmp/initial",
			workdir: "/tmp/work",
			plane,
			ports,
		});

		expect(result.outcome).toBe("awaiting_merge");
		expect(result.rounds).toBe(2);
		expect(result.findings).toHaveLength(1);
		expect(result.closures[0]?.status).toBe("resolved");
		expect(result.mergeHandoff?.status).toBe("pending");
		expect(result.mergeHandoff?.toRole).toBe("human");
		expect(result.authorInstanceId).toBe("coder-2");
		expect(result.reviewerInstanceId).toBe("reviewer-2");
		expect(result.authorProvider).toBe("coder-provider");
		expect(result.reviewerProvider).toBe("reviewer-provider");
		expect(plane.getTask("task-1").stage).toBe("verify");
		expect(plane.getTask("task-1").status).toBe("running");
		expect(plane.listHandoffs("task-1")).toHaveLength(7);
	});

	it("rejects author self-review and blocks the task", async () => {
		const ports = makePorts({
			review: () => ({
				verdict: verdictOf("changes_requested", [finding]),
				agentInstanceId: "coder-1",
				provider: "reviewer-provider",
			}),
		});
		const { plane } = setup(ports);

		await expect(
			runPhase3({
				taskId: "task-1",
				objective: "fix the seeded bug",
				initialWorkdir: "/tmp/initial",
				workdir: "/tmp/work",
				plane,
				ports,
			}),
		).rejects.toMatchObject({ code: "author_self_review" } satisfies Partial<Phase3Error>);
		expect(plane.getTask("task-1").status).toBe("blocked");
		expect(plane.listHandoffs("task-1").some((handoff) => handoff.kind === "blocker")).toBe(true);
	});

	it("blocks when the verifier cannot execute a blocking finding", async () => {
		const ports = makePorts({
			review: () => ({
				verdict: verdictOf("changes_requested", [finding]),
				agentInstanceId: "reviewer-1",
				provider: "reviewer-provider",
			}),
			verify: (request) => ({
				verifications: request.findings.map((subject, index) => verification(index, "blocked", subject)),
			}),
		});
		const { plane } = setup(ports);
		const result = await runPhase3({
			taskId: "task-1",
			objective: "fix the seeded bug",
			initialWorkdir: "/tmp/initial",
			workdir: "/tmp/work",
			plane,
			ports,
		});

		expect(result.outcome).toBe("blocked");
		expect(plane.getTask("task-1").status).toBe("blocked");
		expect(result.blockerHandoff?.payload.code).toBe("verifier_blocked");
	});

	it("blocks when a finding is still confirmed after the fix", async () => {
		let reviewCalls = 0;
		const ports = makePorts({
			review: (request) => {
				reviewCalls += 1;
				return {
					verdict: reviewCalls === 1 ? verdictOf("changes_requested", [finding]) : verdictOf("approve", []),
					agentInstanceId: `reviewer-${request.iteration}`,
					provider: "reviewer-provider",
				};
			},
			verify: (request) => ({
				verifications: request.findings.map((subject, index) => verification(index, "confirmed", subject)),
			}),
		});
		const { plane } = setup(ports);
		const result = await runPhase3({
			taskId: "task-1",
			objective: "fix the seeded bug",
			initialWorkdir: "/tmp/initial",
			workdir: "/tmp/work",
			plane,
			ports,
		});

		expect(result.outcome).toBe("blocked");
		expect(result.closures[0]?.status).toBe("still_confirmed");
		expect(result.blockerHandoff?.payload.code).toBe("unclosed_finding");
	});

	it("blocks after the configured review rounds instead of looping forever", async () => {
		let implementCalls = 0;
		const ports = makePorts({
			implement: () => {
				implementCalls += 1;
				return {
					diff: `diff-${implementCalls}`,
					testReport: "green",
					testFileUnchanged: true,
					agentInstanceId: `coder-${implementCalls}`,
					provider: "coder-provider",
				};
			},
			review: (request) => ({
				verdict: verdictOf("changes_requested", [finding]),
				agentInstanceId: `reviewer-${request.iteration}`,
				provider: "reviewer-provider",
			}),
		});
		const { plane } = setup(ports);
		const result = await runPhase3({
			taskId: "task-1",
			objective: "fix the seeded bug",
			initialWorkdir: "/tmp/initial",
			workdir: "/tmp/work",
			plane,
			ports,
			maxReviewRounds: 2,
		});

		expect(result.outcome).toBe("blocked");
		expect(result.blockerHandoff?.payload.code).toBe("review_loop");
		expect(implementCalls).toBe(2);
	});

	it("goes straight to the merge gate when the first review approves", async () => {
		const ports = makePorts({
			review: () => ({
				verdict: verdictOf("approve", []),
				agentInstanceId: "reviewer-1",
				provider: "reviewer-provider",
			}),
		});
		const { plane } = setup(ports);
		const result = await runPhase3({
			taskId: "task-1",
			objective: "fix the seeded bug",
			initialWorkdir: "/tmp/initial",
			workdir: "/tmp/work",
			plane,
			ports,
		});

		expect(result.outcome).toBe("awaiting_merge");
		expect(result.rounds).toBe(1);
		expect(result.closures).toEqual([]);
		expect(result.mergeHandoff?.status).toBe("pending");
	});

	it("closes a P3 raised on an approving review with the final revision evidence", async () => {
		const p3: ReviewFinding = {
			...finding,
			severity: "P3",
			evidenceKind: "judgment",
			falsifier: "",
		};
		const ports = makePorts({
			review: () => ({
				verdict: verdictOf("approve", [p3]),
				agentInstanceId: "reviewer-1",
				provider: "reviewer-provider",
			}),
			verify: (request) => ({
				verifications: request.findings.map((subject, index) => verification(index, "blocked", subject)),
			}),
		});
		const { plane } = setup(ports);
		const result = await runPhase3({
			taskId: "task-1",
			objective: "fix the seeded bug",
			initialWorkdir: "/tmp/initial",
			workdir: "/tmp/work",
			plane,
			ports,
		});

		expect(result.outcome).toBe("awaiting_merge");
		expect(result.closures[0]?.initialStatus).toBe("blocked");
		expect(result.closures[0]?.finalStatus).toBe("blocked");
		expect(result.closures[0]?.status).toBe("blocked");
	});

	it("rejects a reviewer from the same provider as the author", async () => {
		const ports = makePorts({
			review: () => ({
				verdict: verdictOf("approve", []),
				agentInstanceId: "reviewer-1",
				provider: "coder-provider",
			}),
		});
		const { plane } = setup(ports);

		await expect(
			runPhase3({
				taskId: "task-1",
				objective: "fix the seeded bug",
				initialWorkdir: "/tmp/initial",
				workdir: "/tmp/work",
				plane,
				ports,
			}),
		).rejects.toMatchObject({ code: "reviewer_provider_mismatch" } satisfies Partial<Phase3Error>);
		expect(plane.getTask("task-1").status).toBe("blocked");
		const blocker = plane.listHandoffs("task-1").find((handoff) => handoff.kind === "blocker");
		expect(blocker?.payload.code).toBe("reviewer_provider_mismatch");
		expect(blocker?.fromRole).toBe("reviewer");
	});

	it("creates a typed blocker handoff and releases the run when a port throws", async () => {
		const ports = makePorts({
			implement: () => {
				throw new Error("coder exploded");
			},
		});
		const { plane } = setup(ports);

		await expect(
			runPhase3({
				taskId: "task-1",
				objective: "fix the seeded bug",
				initialWorkdir: "/tmp/initial",
				workdir: "/tmp/work",
				plane,
				ports,
			}),
		).rejects.toThrow("coder exploded");
		expect(plane.getTask("task-1").status).toBe("blocked");
		const handoffs = plane.listHandoffs("task-1");
		const blocker = handoffs.find((handoff) => handoff.kind === "blocker");
		expect(blocker?.payload.code).toBe("port_error");
		expect(blocker?.fromRole).toBe("coder");
		expect(handoffs.find((handoff) => handoff.kind === "handoff")?.status).toBe("pending");
		expect(plane.getRun("coder-task-1-0").status).toBe("interrupted");
	});

	it("blocks and records evidence when the implementation modifies a test file", async () => {
		const ports = makePorts({
			implement: () => ({
				diff: "diff-1",
				testReport: "green",
				testFileUnchanged: false,
				agentInstanceId: "coder-1",
				provider: "coder-provider",
			}),
		});
		const { plane } = setup(ports);

		await expect(
			runPhase3({
				taskId: "task-1",
				objective: "fix the seeded bug",
				initialWorkdir: "/tmp/initial",
				workdir: "/tmp/work",
				plane,
				ports,
			}),
		).rejects.toMatchObject({ code: "test_modified" } satisfies Partial<Phase3Error>);
		expect(plane.getTask("task-1").status).toBe("blocked");
		const blocker = plane.listHandoffs("task-1").find((handoff) => handoff.kind === "blocker");
		expect(blocker?.payload.code).toBe("test_modified");
		expect(blocker?.fromRole).toBe("coder");
	});
});
