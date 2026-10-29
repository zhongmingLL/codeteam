import { afterEach, describe, expect, it } from "vitest";
import { HandoffTerminalResolver } from "../src/a2a/terminal.ts";
import { createA2AHandlers, resolveRunPrincipal } from "../src/index.ts";
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

function sourceRun(base: W5AFixture) {
	const message = base.createSourceMessage();
	const run = base.createRun({
		id: "run-coder-terminal",
		profileId: "profile:coder",
		role: "coder",
		sessionId: "session-coder",
		sourceId: message.id,
	});
	return { message, run, principal: resolveRunPrincipal(base.store, run.id) };
}

function handoffInput(overrides: Record<string, unknown> = {}) {
	return {
		kind: "review_request",
		targets: ["profile:reviewer-a"],
		subject: "Review terminal",
		subjectRef: "pr:owner/repo#terminal",
		actionFamily: "review",
		successorSlot: "reviewer",
		expectedArtifact: "artifact:review",
		deadline: 1_700_000_100_000,
		idempotencyKey: "idem-terminal",
		terminalPredicate: { kind: "run_completed" },
		...overrides,
	};
}

describe("server-owned handoff terminal resolver", () => {
	it("does not commit while the holder run is still running, then consumes after run completion", () => {
		const base = fixture();
		const coder = sourceRun(base);
		const created = createA2AHandlers({
			store: base.store,
			principal: coder.principal,
			clock: base.now,
		}).createHandoff(handoffInput() as never);
		const reviewerMessage = base.createSourceMessage("review work");
		const reviewerRun = base.createRun({
			id: "run-reviewer-terminal",
			profileId: "profile:reviewer-a",
			role: "reviewer",
			sessionId: "session-reviewer-a",
			sourceId: reviewerMessage.id,
		});
		const reviewerHandlers = createA2AHandlers({
			store: base.store,
			principal: resolveRunPrincipal(base.store, reviewerRun.id),
			clock: base.now,
		});
		expect(reviewerHandlers.claimHandoff(created.handoff.id).status).toBe("claimed");
		reviewerHandlers.completeHandoff(created.handoff.id, "review:evidence", { verdict: "approved" });
		const resolver = new HandoffTerminalResolver({ store: base.store, clock: base.now });
		const whileRunning = resolver.onRunTerminal(base.store.runs.get(reviewerRun.id)!);
		expect(whileRunning[0]).toMatchObject({ status: "unverified", reason: "candidate_run_running" });
		expect(base.store.handoffs.get(created.handoff.id)?.status).toBe("claimed");

		base.store.runs.terminal(reviewerRun.id, { status: "completed" });
		const resolved = resolver.onRunTerminal(base.store.runs.get(reviewerRun.id)!);
		expect(resolved[0]).toMatchObject({ status: "consumed", evidenceRef: `run:${reviewerRun.id}:completed` });
		const consumed = base.store.handoffs.get(created.handoff.id)!;
		expect(consumed.status).toBe("consumed");
		expect(consumed.result).toMatchObject({
			verifiedBy: "system:handoff-resolver",
			terminalPredicate: { kind: "run_completed" },
		});
	});

	it("does not commit an unknown terminal predicate", () => {
		const base = fixture();
		const coder = sourceRun(base);
		const created = createA2AHandlers({
			store: base.store,
			principal: coder.principal,
			clock: base.now,
		}).createHandoff(
			handoffInput({ terminalPredicate: { kind: "mystery" }, idempotencyKey: "idem-unknown" }) as never,
		);
		const reviewerMessage = base.createSourceMessage("unknown predicate");
		const reviewerRun = base.createRun({
			id: "run-reviewer-unknown",
			profileId: "profile:reviewer-a",
			role: "reviewer",
			sessionId: "session-reviewer-a",
			sourceId: reviewerMessage.id,
		});
		const reviewerHandlers = createA2AHandlers({
			store: base.store,
			principal: resolveRunPrincipal(base.store, reviewerRun.id),
			clock: base.now,
		});
		reviewerHandlers.claimHandoff(created.handoff.id);
		reviewerHandlers.completeHandoff(created.handoff.id, "review:evidence", { verdict: "approved" });
		base.store.runs.terminal(reviewerRun.id, { status: "completed" });
		const resolver = new HandoffTerminalResolver({ store: base.store, clock: base.now });
		const resolved = resolver.onRunTerminal(base.store.runs.get(reviewerRun.id)!);
		expect(resolved[0]).toMatchObject({ status: "unverified", reason: "unsupported_terminal_predicate:mystery" });
		expect(base.store.handoffs.get(created.handoff.id)?.status).toBe("claimed");
		expect(
			base.store.audit
				.listSubject(`handoff:${created.handoff.id}`, 20)
				.some((entry) => entry.action === "handoff_completion_unverified"),
		).toBe(true);
	});

	it("records parallel_unfinished when one holder ends without a candidate", () => {
		const base = fixture();
		const coder = sourceRun(base);
		const created = createA2AHandlers({
			store: base.store,
			principal: coder.principal,
			clock: base.now,
		}).createHandoff(
			handoffInput({
				targets: ["profile:reviewer-a", "profile:reviewer-b"],
				mode: "parallel",
				parallelIntent: "independent review",
				idempotencyKey: "idem-parallel",
			}) as never,
		);
		const messageA = base.createSourceMessage("review A");
		const runA = base.createRun({
			id: "run-reviewer-a",
			profileId: "profile:reviewer-a",
			role: "reviewer",
			sessionId: "session-reviewer-a",
			sourceId: messageA.id,
		});
		const messageB = base.createSourceMessage("review B");
		const runB = base.createRun({
			id: "run-reviewer-b",
			profileId: "profile:reviewer-b",
			role: "reviewer",
			sessionId: "session-reviewer-b",
			sourceId: messageB.id,
		});
		const handlersA = createA2AHandlers({
			store: base.store,
			principal: resolveRunPrincipal(base.store, runA.id),
			clock: base.now,
		});
		const handlersB = createA2AHandlers({
			store: base.store,
			principal: resolveRunPrincipal(base.store, runB.id),
			clock: base.now,
		});
		handlersA.claimHandoff(created.handoff.id);
		handlersB.claimHandoff(created.handoff.id);
		handlersA.completeHandoff(created.handoff.id, "review:a", { verdict: "approved" });
		base.store.runs.terminal(runA.id, { status: "completed" });
		base.store.runs.terminal(runB.id, { status: "failed" });
		const resolver = new HandoffTerminalResolver({ store: base.store, clock: base.now });
		const resolved = resolver.onRunTerminal(base.store.runs.get(runB.id)!);
		expect(resolved[0]).toMatchObject({ status: "released", reason: "holder_run_failed_without_candidate" });
		expect(base.store.handoffs.custodyEvents(created.handoff.id).map((event) => event.kind)).toContain(
			"handoff.parallel_unfinished",
		);
		expect(base.store.handoffs.get(created.handoff.id)?.status).not.toBe("consumed");
	});

	it("releases a holder claim when a failed run left only an unverified candidate", () => {
		const base = fixture();
		const coder = sourceRun(base);
		const created = createA2AHandlers({ store: base.store, principal: coder.principal, clock: base.now }).createHandoff(
			handoffInput({ idempotencyKey: "idem-failed-candidate" }) as never,
		);
		const reviewerMessage = base.createSourceMessage("failed candidate");
		const reviewerRun = base.createRun({
			id: "run-reviewer-failed-candidate",
			profileId: "profile:reviewer-a",
			role: "reviewer",
			sessionId: "session-reviewer-a",
			sourceId: reviewerMessage.id,
		});
		const reviewer = createA2AHandlers({
			store: base.store,
			principal: resolveRunPrincipal(base.store, reviewerRun.id),
			clock: base.now,
		});
		reviewer.claimHandoff(created.handoff.id);
		reviewer.completeHandoff(created.handoff.id, "review:candidate", { verdict: "approved" });
		base.store.runs.terminal(reviewerRun.id, { status: "failed" });
		const resolver = new HandoffTerminalResolver({ store: base.store, clock: base.now });
		const resolved = resolver.onRunTerminal(base.store.runs.get(reviewerRun.id)!);
		expect(resolved.map((entry) => entry.status)).toEqual(["unverified", "released"]);
		expect(base.store.handoffs.get(created.handoff.id)?.status).toBe("pending");
		expect(base.store.handoffs.listClaims(created.handoff.id).every((claim) => claim.status === "released")).toBe(true);
	});

	it("commits a review_delivered predicate only from a matching review record", () => {
		const base = fixture();
		const headSha = "b".repeat(40);
		base.store.audit.append({
			actor: "profile:coder",
			action: "commit_created",
			subject: `commit:${headSha}`,
			args: { headSha, taskId: "task-1" },
		});
		const coder = sourceRun(base);
		base.store.profiles.create({
			id: "profile:coder-anthropic",
			role: "coder",
			displayName: "Coder Anthropic",
			provider: "test",
			model: "claude-sonnet-4-5",
			modelFamily: "anthropic",
			toolPolicyProfile: "default",
		});
		base.store.profiles.create({
			id: "profile:reviewer-anthropic",
			role: "reviewer",
			displayName: "Reviewer Anthropic",
			provider: "test",
			model: "claude-sonnet-4-5",
			modelFamily: "anthropic",
			toolPolicyProfile: "default",
		});
		base.store.sessions.create({
			id: "session-coder-anthropic",
			threadId: "thread-1",
			taskId: "task-1",
			profileId: "profile:coder-anthropic",
			role: "coder",
			effectiveToolPolicy: "default",
			provider: "test",
			model: "claude-sonnet-4-5",
			modelFamily: "anthropic",
			seq: 1,
			userId: "user-1",
		});
		base.store.sessions.create({
			id: "session-reviewer-anthropic",
			threadId: "thread-1",
			taskId: "task-1",
			profileId: "profile:reviewer-anthropic",
			role: "reviewer",
			effectiveToolPolicy: "default",
			provider: "test",
			model: "claude-sonnet-4-5",
			modelFamily: "anthropic",
			seq: 1,
			userId: "user-1",
		});
		const created = createA2AHandlers({ store: base.store, principal: coder.principal, clock: base.now }).createHandoff(
			handoffInput({
				terminalPredicate: { kind: "review_delivered", headSha },
				targets: ["profile:reviewer-anthropic"],
				idempotencyKey: "idem-review-delivered",
			}) as never,
		);
		const reviewerMessage = base.createSourceMessage("review delivered");
		const reviewerRun = base.store.runs.create({
			id: "run-review-delivered",
			taskId: "task-1",
			role: "reviewer",
			agentSessionId: "session-reviewer-anthropic",
			sourceId: reviewerMessage.id,
			recipientProfileId: "profile:reviewer-anthropic",
			provider: "test",
			model: "claude-sonnet-4-5",
			modelFamily: "anthropic",
		});
		const review = base.store.reviews.create({
			taskId: "task-1",
			runId: reviewerRun.id,
			headSha,
			baseSha: "c".repeat(40),
			authorSessionId: "session-coder-anthropic",
			authorModel: "claude-sonnet-4-5",
			authorModelFamily: "anthropic",
			reviewerSessionId: "session-reviewer-anthropic",
			reviewerModel: "claude-sonnet-4-5",
			reviewerModelFamily: "anthropic",
			authorProfileId: "profile:coder-anthropic",
			reviewerProfileId: "profile:reviewer-anthropic",
			riskClass: "low_risk_docs",
			reviewMode: "same_family_fresh",
			verdict: "approve",
			findings: [],
		});
		const reviewer = createA2AHandlers({
			store: base.store,
			principal: resolveRunPrincipal(base.store, reviewerRun.id),
			clock: base.now,
		});
		reviewer.claimHandoff(created.handoff.id);
		reviewer.completeHandoff(created.handoff.id, "review:candidate", { verdict: "approved" });
		base.store.runs.terminal(reviewerRun.id, { status: "completed" });
		const resolver = new HandoffTerminalResolver({ store: base.store, clock: base.now });
		const resolved = resolver.onRunTerminal(base.store.runs.get(reviewerRun.id)!);
		expect(resolved[0]).toMatchObject({ status: "consumed", evidenceRef: `review:${review.id}` });
		expect(base.store.handoffs.get(created.handoff.id)?.status).toBe("consumed");
	});
});
