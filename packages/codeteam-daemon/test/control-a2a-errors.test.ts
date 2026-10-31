import { afterEach, describe, expect, it } from "vitest";
import { createA2AHandlers, type HandoffCreateInput, MAX_A2A_DEPTH, resolveRunPrincipal } from "../src/index.ts";
import { createW5AFixture, type W5AFixture } from "./helpers/w5a-fixture.ts";

const fixtures: W5AFixture[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function fixture(): W5AFixture {
	const created = createW5AFixture();
	fixtures.push(created);
	return created;
}

function sourceRun(base: W5AFixture, id = "run-error-source") {
	const message = base.createSourceMessage("error matrix source");
	const run = base.createRun({
		id,
		profileId: "profile:coder",
		role: "coder",
		sessionId: "session-coder",
		sourceId: message.id,
	});
	return { message, run, principal: resolveRunPrincipal(base.store, run.id) };
}

function reviewerRun(base: W5AFixture, profileId = "profile:reviewer-a", id = "run-error-reviewer") {
	const message = base.createSourceMessage("error matrix review");
	const run = base.createRun({
		id,
		profileId,
		role: "reviewer",
		sessionId: profileId === "profile:reviewer-a" ? "session-reviewer-a" : "session-reviewer-b",
		sourceId: message.id,
	});
	return { message, run, principal: resolveRunPrincipal(base.store, run.id) };
}

function handoffInput(overrides: Partial<HandoffCreateInput> = {}): HandoffCreateInput {
	return {
		kind: "review_request",
		targets: ["profile:reviewer-a"],
		subject: "Error matrix review",
		subjectRef: "pr:owner/repo#errors",
		actionFamily: "review",
		successorSlot: "reviewer",
		expectedArtifact: "artifact:review",
		deadline: 1_700_000_100_000,
		idempotencyKey: "idem-errors-1",
		terminalPredicate: { kind: "run_completed" },
		...overrides,
	};
}

describe("F016a A2A error/auth matrix", () => {
	it("rejects depth overflow and a second live canonical handoff", () => {
		const base = fixture();
		const source = sourceRun(base, "run-depth");
		const deepSource = base.createSourceMessage("deep chain");
		const deep = base.createRun({
			id: "run-deep",
			profileId: "profile:coder",
			role: "coder",
			sessionId: "session-coder",
			sourceId: deepSource.id,
			chainMetadata: { a2aDepth: MAX_A2A_DEPTH },
		});
		const deepHandlers = createA2AHandlers({
			store: base.store,
			principal: resolveRunPrincipal(base.store, deep.id),
			clock: base.now,
		});
		expect(() =>
			deepHandlers.send({ kind: "question", targets: ["profile:reviewer-a"], bodyMd: "too deep" }),
		).toThrowError(expect.objectContaining({ code: "a2a_depth_exceeded" }));

		const handlers = createA2AHandlers({ store: base.store, principal: source.principal, clock: base.now });
		const first = handlers.createHandoff(handoffInput());
		expect(() => handlers.createHandoff(handoffInput({ idempotencyKey: "idem-errors-2" }))).toThrowError(
			expect.objectContaining({ code: "loop_guard_live_handoff" }),
		);
		expect(
			base.store.audit
				.listSubject(`handoff:${first.handoff.id}`, 20)
				.some((entry) => entry.action === "handoff_loop_guard_blocked"),
		).toBe(true);
	});

	it("rejects requestId conflicts and non-author withdrawal", () => {
		const base = fixture();
		const source = sourceRun(base);
		const coder = createA2AHandlers({ store: base.store, principal: source.principal, clock: base.now });
		coder.send({ kind: "question", targets: ["profile:reviewer-a"], bodyMd: "same", requestId: "req-errors" });
		expect(() =>
			coder.send({
				kind: "question",
				targets: ["profile:reviewer-a"],
				bodyMd: "different",
				requestId: "req-errors",
			}),
		).toThrowError(expect.objectContaining({ code: "conflict" }));
		const created = coder.createHandoff(handoffInput());
		const reviewerSource = reviewerRun(base);
		const reviewer = createA2AHandlers({
			store: base.store,
			principal: reviewerSource.principal,
			clock: base.now,
		});
		expect(() => reviewer.withdrawHandoff(created.handoff.id, "not the author")).toThrowError(
			expect.objectContaining({ code: "forbidden" }),
		);
	});

	it("keeps claim/complete typed invalid after withdrawal", () => {
		const base = fixture();
		const source = sourceRun(base);
		const coder = createA2AHandlers({ store: base.store, principal: source.principal, clock: base.now });
		const created = coder.createHandoff(handoffInput());
		const reviewerSource = reviewerRun(base);
		const reviewer = createA2AHandlers({
			store: base.store,
			principal: reviewerSource.principal,
			clock: base.now,
		});
		expect(reviewer.claimHandoff(created.handoff.id).status).toBe("claimed");
		reviewer.completeHandoff(created.handoff.id, "review:evidence", { verdict: "approved" });
		coder.withdrawHandoff(created.handoff.id, "error matrix withdrawal");
		expect(reviewer.claimHandoff(created.handoff.id).status).toBe("terminal_handoff");
		expect(() => reviewer.completeHandoff(created.handoff.id, "review:late", {})).toThrowError(
			expect.objectContaining({ code: "invalid_state" }),
		);
	});

	it("records audit and tool usage for each mutating A2A tool", () => {
		const base = fixture();
		const source = sourceRun(base);
		const coder = createA2AHandlers({ store: base.store, principal: source.principal, clock: base.now });
		const sent = coder.send({ kind: "question", targets: ["profile:reviewer-a"], bodyMd: "audited" });
		const created = coder.createHandoff(handoffInput());
		const reviewerSource = reviewerRun(base);
		const reviewer = createA2AHandlers({
			store: base.store,
			principal: reviewerSource.principal,
			clock: base.now,
		});
		reviewer.claimHandoff(created.handoff.id);
		reviewer.completeHandoff(created.handoff.id, "review:audited", { verdict: "approved" });
		coder.withdrawHandoff(created.handoff.id, "audit matrix");

		const toolRecords = base.store.evals.listByTask("task-1");
		expect(toolRecords.some((record) => record.metrics.a2a_tool === "a2a_send")).toBe(true);
		expect(toolRecords.some((record) => record.metrics.a2a_tool === "handoff_create")).toBe(true);
		expect(
			base.store.audit.listSubject(`message:${sent.message.id}`, 20).some((entry) => entry.action === "a2a_send"),
		).toBe(true);
		const handoffAudits = base.store.audit.listSubject(`handoff:${created.handoff.id}`, 50);
		for (const action of [
			"a2a_handoff_created",
			"handoff_claimed",
			"handoff_completion_candidate",
			"handoff_withdrawn",
		]) {
			expect(handoffAudits.some((entry) => entry.action === action)).toBe(true);
		}
		expect(base.store.queue.get(created.queueEntry!.id)?.status).toBe("withdrawn");
	});
});
