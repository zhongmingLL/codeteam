import { afterEach, describe, expect, it } from "vitest";
import {
	type A2ASendInput,
	createA2AHandlers,
	describeA2ATools,
	type HandoffCreateInput,
	MAX_A2A_DEPTH,
	observeMissingA2AToolCall,
	resolveRunPrincipal,
} from "../src/index.ts";
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

function sourceRun(base: W5AFixture, id = "run-source-1") {
	const message = base.createSourceMessage();
	const run = base.createRun({
		id,
		profileId: "profile:coder",
		role: "coder",
		sessionId: "session-coder",
		sourceId: message.id,
	});
	return { message, run, principal: resolveRunPrincipal(base.store, run.id) };
}

function handoffInput(overrides: Partial<HandoffCreateInput> = {}): HandoffCreateInput {
	return {
		kind: "review_request",
		targets: ["profile:reviewer-a"],
		subject: "Review W5a",
		subjectRef: "pr:owner/repo#1",
		actionFamily: "review",
		successorSlot: "reviewer",
		expectedArtifact: "artifact:review",
		deadline: 1_700_000_100_000,
		idempotencyKey: "idem-1",
		terminalPredicate: { kind: "review_verdict", headSha: "a".repeat(40) },
		payload: { headSha: "a".repeat(40) },
		...overrides,
	};
}

describe("W5a A2A tool surface", () => {
	it("rejects A2A sends beyond the configured depth budget", () => {
		const base = fixture();
		const message = base.createSourceMessage("deep chain");
		const run = base.createRun({
			id: "run-deep",
			profileId: "profile:coder",
			role: "coder",
			sessionId: "session-coder",
			sourceId: message.id,
			chainMetadata: { a2aDepth: MAX_A2A_DEPTH },
		});
		const handlers = createA2AHandlers({
			store: base.store,
			principal: resolveRunPrincipal(base.store, run.id),
			clock: base.now,
		});
		expect(() =>
			handlers.send({ kind: "question", targets: ["profile:reviewer-a"], bodyMd: "too deep" }),
		).toThrowError(expect.objectContaining({ code: "a2a_depth_exceeded" }));
		expect(base.store.queue.listPending()).toHaveLength(0);
	});

	it("describes the complete typed A2A tool surface", () => {
		const tools = describeA2ATools();
		expect(tools.map((tool) => tool.name)).toEqual([
			"a2a_send",
			"handoff_create",
			"handoff_claim",
			"handoff_complete",
			"handoff_withdraw",
		]);
		expect(tools.find((tool) => tool.name === "a2a_send")?.inputSchema.additionalProperties).toBe(false);
		expect(tools.find((tool) => tool.name === "handoff_create")?.inputSchema.additionalProperties).toBe(false);
	});

	it("writes discussion messages and queue entries with visible target markers", () => {
		const base = fixture();
		const source = sourceRun(base);
		const handlers = createA2AHandlers({ store: base.store, principal: source.principal, clock: base.now });
		const result = handlers.send({
			kind: "question",
			targets: ["profile:reviewer-a", "profile:reviewer-b"],
			bodyMd: "Please inspect the contract.",
		});
		expect(result.message.kind).toBe("question");
		expect(result.message.controlRef).toBeNull();
		expect(result.message.bodyMd).toContain("→ @Reviewer A");
		expect(result.message.bodyMd).toContain("→ @Reviewer B");
		expect(result.queueEntry).not.toBeNull();
		expect(result.queueEntry!.targets).toEqual(["profile:reviewer-a", "profile:reviewer-b"]);
		expect(result.queueEntry!.sourceId).toBe(result.message.id);
		expect(base.store.handoffs.list()).toHaveLength(0);
		expect(base.store.queue.listPending()).toHaveLength(1);
		expect(
			base.store.evals
				.listByTask("task-1")
				.some((record) => record.metrics.a2a_tool_call_success === 1 && record.metrics.a2a_tool === "a2a_send"),
		).toBe(true);
	});

	it("rejects forged sender/control fields and non-discussion kinds", () => {
		const base = fixture();
		const source = sourceRun(base);
		const handlers = createA2AHandlers({ store: base.store, principal: source.principal, clock: base.now });
		expect(() =>
			handlers.send({
				kind: "question",
				targets: ["profile:reviewer-a"],
				bodyMd: "x",
				fromProfileId: "profile:reviewer-a",
			} as unknown as A2ASendInput),
		).toThrow(/does not accept field fromProfileId/);
		expect(() =>
			handlers.send({
				kind: "question",
				targets: ["profile:reviewer-a"],
				bodyMd: "x",
				controlRef: "handoff-1",
			} as unknown as A2ASendInput),
		).toThrow(/does not accept field controlRef/);
		expect(() => handlers.send({ kind: "handoff", targets: ["profile:reviewer-a"], bodyMd: "x" })).toThrow(
			/not a discussion kind/,
		);
		expect(() => handlers.send({ kind: "question", targets: ["profile:missing"], bodyMd: "x" })).toThrow(/not found/);
	});

	it("rejects disabled and cross-thread targets", () => {
		const base = fixture();
		const source = sourceRun(base);
		base.store.profiles.create({
			id: "profile:disabled",
			role: "reviewer",
			displayName: "Disabled",
			provider: "test",
			model: "model-reviewer",
			modelFamily: "test-family",
			toolPolicyProfile: "default",
			status: "disabled",
		});
		base.store.profiles.create({
			id: "profile:outsider",
			role: "reviewer",
			displayName: "Outsider",
			provider: "test",
			model: "model-reviewer",
			modelFamily: "test-family",
			toolPolicyProfile: "default",
		});
		base.store.threads.create({ id: "thread-2", title: "Other thread" });
		base.store.sessions.create({
			id: "session-outsider",
			threadId: "thread-2",
			taskId: "task-1",
			profileId: "profile:outsider",
			role: "reviewer",
			effectiveToolPolicy: "default",
			provider: "test",
			model: "model-reviewer",
			modelFamily: "test-family",
			seq: 0,
			userId: "user-1",
		});
		const handlers = createA2AHandlers({ store: base.store, principal: source.principal, clock: base.now });
		expect(() => handlers.send({ kind: "question", targets: ["profile:disabled"], bodyMd: "x" })).toThrow(/disabled/);
		expect(() => handlers.send({ kind: "question", targets: ["profile:outsider"], bodyMd: "x" })).toThrow(
			/not in the same thread/,
		);
	});

	it("creates a typed handoff with message control_ref and custody dispatch events", () => {
		const base = fixture();
		const source = sourceRun(base);
		const handlers = createA2AHandlers({ store: base.store, principal: source.principal, clock: base.now });
		const created = handlers.createHandoff(handoffInput());
		expect(created.handoff.status).toBe("pending");
		expect(created.handoff.holderProfileIds).toEqual(["profile:reviewer-a"]);
		expect(created.message.kind).toBe("handoff");
		expect(created.message.controlRef).toBe(created.handoff.id);
		expect(created.message.bodyMd).toContain("→ @Reviewer A");
		expect(created.queueEntry?.sourceId).toBe(created.message.id);
		expect(base.store.handoffs.custodyEvents(created.handoff.id).map((event) => event.kind)).toEqual([
			"handoff.created",
			"handoff.dispatched",
		]);
		expect(base.store.handoffs.custodyEvents(created.handoff.id)[0]?.actorRef).toContain("profile:coder");
		expect(base.store.queue.listPending()).toHaveLength(1);
		const replay = handlers.createHandoff(handoffInput());
		expect(replay.handoff.id).toBe(created.handoff.id);
		expect(replay.message.id).toBe(created.message.id);
		expect(replay.queueEntry?.id).toBe(created.queueEntry?.id);
		expect(base.store.messages.listThread("thread-1").filter((message) => message.kind === "handoff")).toHaveLength(
			1,
		);
		expect(base.store.queue.listPending()).toHaveLength(1);
		expect(base.store.handoffs.custodyEvents(created.handoff.id)).toHaveLength(2);
		expect(() => handlers.createHandoff({ ...handoffInput(), terminalPredicate: { kind: "different" } })).toThrow(
			/another intent/,
		);
	});

	it("rejects handoff forgery and missing expected artifact", () => {
		const base = fixture();
		const source = sourceRun(base);
		const handlers = createA2AHandlers({ store: base.store, principal: source.principal, clock: base.now });
		expect(() =>
			handlers.createHandoff({ ...handoffInput(), fromRole: "reviewer" } as unknown as HandoffCreateInput),
		).toThrow(/does not accept field fromRole/);
		expect(() => handlers.createHandoff({ ...handoffInput(), expectedArtifact: "" })).toThrow(
			/expectedArtifact is required/,
		);
		expect(() =>
			handlers.createHandoff({ ...handoffInput(), deadline: base.now() - 1, idempotencyKey: "past" }),
		).toThrow(/deadline must be in the future/);
	});

	it("claims per holder, returns safe_wait to non-holders, and records completion candidates", () => {
		const base = fixture();
		const source = sourceRun(base);
		const coder = createA2AHandlers({ store: base.store, principal: source.principal, clock: base.now });
		const created = coder.createHandoff(handoffInput());
		const reviewerSource = base.createSourceMessage("review");
		const reviewerRun = base.createRun({
			id: "run-reviewer-a",
			profileId: "profile:reviewer-a",
			role: "reviewer",
			sessionId: "session-reviewer-a",
			sourceId: reviewerSource.id,
		});
		const reviewer = createA2AHandlers({
			store: base.store,
			principal: resolveRunPrincipal(base.store, reviewerRun.id),
			clock: base.now,
		});
		const claimed = reviewer.claimHandoff(created.handoff.id);
		expect(claimed.status).toBe("claimed");
		if (claimed.status !== "claimed") throw new Error("expected claimed");
		expect(claimed.handoff.claimedByRunId).toBe(reviewerRun.id);
		const nonHolder = coder.claimHandoff(created.handoff.id);
		expect(nonHolder.status).toBe("safe_wait");
		if (nonHolder.status === "safe_wait") expect(nonHolder.handoff).toBeNull();
		const candidate = reviewer.completeHandoff(created.handoff.id, "verification:1", { verdict: "approve" });
		expect(candidate.status).toBe("claimed");
		expect(candidate.completionCandidates[reviewerRun.id]).toMatchObject({ evidenceRef: "verification:1" });
		expect(base.store.handoffs.custodyEvents(created.handoff.id).map((event) => event.kind)).toContain(
			"handoff.completion_candidate",
		);
		expect(() => reviewer.withdrawHandoff(created.handoff.id, "reviewer cannot withdraw")).toThrow(/author/);
		const withdrawn = coder.withdrawHandoff(created.handoff.id, "scope changed");
		expect(withdrawn.status).toBe("withdrawn");
		expect(base.store.queue.get(created.queueEntry!.id)?.status).toBe("withdrawn");
		expect(
			base.store.audit
				.listSubject(`queue:${created.queueEntry!.id}`, 20)
				.some((entry) => entry.action === "queue_withdrawn"),
		).toBe(true);
		expect(base.store.handoffs.custodyEvents(created.handoff.id).map((event) => event.kind)).toContain(
			"handoff.withdrawn",
		);
		expect(base.store.runs.get(reviewerRun.id)?.status).toBe("running");
		expect(reviewer.claimHandoff(created.handoff.id).status).toBe("terminal_handoff");
		expect(() => reviewer.completeHandoff(created.handoff.id, "late:evidence", {})).toThrowError(
			expect.objectContaining({ code: "invalid_state" }),
		);
	});

	it("rejects cross-task handoff claim and withdrawal", () => {
		const base = fixture();
		const source = sourceRun(base);
		const coder = createA2AHandlers({ store: base.store, principal: source.principal, clock: base.now });
		const created = coder.createHandoff(handoffInput());
		base.store.tasks.create({
			id: "task-2",
			kind: "work",
			threadId: "thread-1",
			title: "Other task",
			why: "scope probe",
			ownerProfileId: "profile:coder",
			createdBy: "user-1",
			userId: "user-1",
			backlogItemId: "backlog-1",
		});
		base.store.sessions.create({
			id: "session-reviewer-a-task2",
			threadId: "thread-1",
			taskId: "task-2",
			profileId: "profile:reviewer-a",
			role: "reviewer",
			effectiveToolPolicy: "default",
			provider: "test",
			model: "model-reviewer",
			modelFamily: "test-family",
			seq: 0,
			userId: "user-1",
		});
		const crossMessage = base.store.messages.append({
			threadId: "thread-1",
			taskId: "task-2",
			authorKind: "user",
			authorId: "user-1",
			kind: "chat",
			bodyMd: "cross task",
		});
		const crossRun = base.store.runs.create({
			id: "run-reviewer-task2",
			taskId: "task-2",
			role: "reviewer",
			agentSessionId: "session-reviewer-a-task2",
			sourceId: crossMessage.id,
			recipientProfileId: "profile:reviewer-a",
			provider: "test",
			model: "model-reviewer",
			modelFamily: "test-family",
		});
		const crossReviewer = createA2AHandlers({
			store: base.store,
			principal: resolveRunPrincipal(base.store, crossRun.id),
			clock: base.now,
		});
		const claim = crossReviewer.claimHandoff(created.handoff.id);
		expect(claim.status).toBe("safe_wait");
		if (claim.status === "safe_wait") expect(claim.reason).toBe("task_scope_mismatch");
		if (claim.status === "safe_wait") expect(claim.handoff).toBeNull();
		expect(() =>
			base.store.handoffs.claim({
				handoffId: created.handoff.id,
				profileId: "profile:reviewer-a",
				runId: crossRun.id,
			}),
		).toThrow(/handoff task/);
		base.store.sessions.create({
			id: "session-coder-task2",
			threadId: "thread-1",
			taskId: "task-2",
			profileId: "profile:coder",
			role: "coder",
			effectiveToolPolicy: "default",
			provider: "test",
			model: "model-coder",
			modelFamily: "test-family",
			seq: 0,
			userId: "user-1",
		});
		const crossCoderRun = base.store.runs.create({
			id: "run-coder-task2",
			taskId: "task-2",
			role: "coder",
			agentSessionId: "session-coder-task2",
			sourceId: crossMessage.id,
			recipientProfileId: "profile:coder",
			provider: "test",
			model: "model-coder",
			modelFamily: "test-family",
		});
		const crossCoder = createA2AHandlers({
			store: base.store,
			principal: resolveRunPrincipal(base.store, crossCoderRun.id),
			clock: base.now,
		});
		expect(() => crossCoder.withdrawHandoff(created.handoff.id, "cross task")).toThrow(
			/outside the caller task scope/,
		);
	});

	it("replays a2a_send by requestId and rejects a different intent under the same id", () => {
		const base = fixture();
		const source = sourceRun(base);
		const handlers = createA2AHandlers({ store: base.store, principal: source.principal, clock: base.now });
		const first = handlers.send({
			kind: "question",
			targets: ["profile:reviewer-a"],
			bodyMd: "same intent",
			requestId: "req-send-1",
		});
		const replay = handlers.send({
			kind: "question",
			targets: ["profile:reviewer-a"],
			bodyMd: "same intent",
			requestId: "req-send-1",
		});
		expect(replay.message.id).toBe(first.message.id);
		expect(replay.queueEntry?.id).toBe(first.queueEntry?.id);
		expect(
			base.store.messages.listThread("thread-1").filter((message) => message.bodyMd.includes("same intent")),
		).toHaveLength(1);
		expect(() =>
			handlers.send({
				kind: "question",
				targets: ["profile:reviewer-a"],
				bodyMd: "different intent",
				requestId: "req-send-1",
			}),
		).toThrow(/another intent/);
	});

	it("blocks a second live handoff for the same canonical action", () => {
		const base = fixture();
		const source = sourceRun(base);
		const handlers = createA2AHandlers({ store: base.store, principal: source.principal, clock: base.now });
		handlers.createHandoff(handoffInput());
		expect(() => handlers.createHandoff({ ...handoffInput(), idempotencyKey: "idem-2" })).toThrow(
			expect.objectContaining({ code: "loop_guard_live_handoff" }),
		);
		expect(base.store.handoffs.list({ taskId: "task-1" })).toHaveLength(1);
		const [live] = base.store.handoffs.list({ taskId: "task-1" });
		expect(
			base.store.audit
				.listSubject(`handoff:${live!.id}`, 20)
				.some((entry) => entry.action === "handoff_loop_guard_blocked"),
		).toBe(true);
	});

	it("requires parallelIntent for parallel handoffs", () => {
		const base = fixture();
		const source = sourceRun(base);
		const handlers = createA2AHandlers({ store: base.store, principal: source.principal, clock: base.now });
		expect(() =>
			handlers.createHandoff(
				handoffInput({
					targets: ["profile:reviewer-a", "profile:reviewer-b"],
					mode: "parallel",
					subjectRef: "pr:owner/repo#parallel",
				}),
			),
		).toThrow(/parallelIntent/);
		const created = handlers.createHandoff(
			handoffInput({
				targets: ["profile:reviewer-a", "profile:reviewer-b"],
				mode: "parallel",
				parallelIntent: "independent review",
				subjectRef: "pr:owner/repo#parallel",
				idempotencyKey: "idem-parallel",
			}),
		);
		expect(created.handoff.mode).toBe("parallel");
		expect(created.handoff.holderProfileIds).toEqual(["profile:reviewer-a", "profile:reviewer-b"]);
	});

	it("uses the run execution role, not the profile primary role, for handoff direction", () => {
		const base = fixture();
		base.store.profiles.create({
			id: "profile:architect-as-coder",
			role: "architect",
			displayName: "Architect as coder",
			provider: "test",
			model: "model-coder",
			modelFamily: "test-family",
			toolPolicyProfile: "default",
		});
		base.store.sessions.create({
			id: "session-architect-as-coder",
			threadId: "thread-1",
			taskId: "task-1",
			profileId: "profile:architect-as-coder",
			role: "coder",
			effectiveToolPolicy: "default",
			provider: "test",
			model: "model-coder",
			modelFamily: "test-family",
			seq: 1,
			userId: "user-1",
		});
		const message = base.createSourceMessage("execution role");
		const run = base.store.runs.create({
			id: "run-architect-as-coder",
			taskId: "task-1",
			role: "coder",
			agentSessionId: "session-architect-as-coder",
			sourceId: message.id,
			recipientProfileId: "profile:architect-as-coder",
			provider: "test",
			model: "model-coder",
			modelFamily: "test-family",
		});
		const principal = resolveRunPrincipal(base.store, run.id);
		expect(principal.role).toBe("coder");
		const handlers = createA2AHandlers({ store: base.store, principal, clock: base.now });
		const created = handlers.createHandoff({ ...handoffInput(), subjectRef: "pr:owner/repo#role" });
		expect(created.handoff.fromRole).toBe("coder");
	});

	it("observes missing A2A tool calls once without routing text", () => {
		const base = fixture();
		const source = sourceRun(base, "run-observe-1");
		const observed = observeMissingA2AToolCall(base.store, {
			runId: source.run.id,
			bodyMd: "@reviewer-a please look at this",
			toolCalls: [],
		});
		expect(observed?.kind).toBe("missing_a2a_tool_call");
		expect(observed?.correction).toContain("a2a_send");
		expect(base.store.queue.listPending()).toHaveLength(0);
		expect(base.store.handoffs.list()).toHaveLength(0);
		expect(
			base.store.audit
				.listSubject(`run:${source.run.id}`)
				.filter((entry) => entry.action === "missing_a2a_tool_call"),
		).toHaveLength(1);
		expect(base.store.evals.listByTask("task-1")).toHaveLength(1);
		expect(
			observeMissingA2AToolCall(base.store, {
				runId: source.run.id,
				bodyMd: "@reviewer-a please look again",
				toolCalls: [],
			}),
		).toBeNull();
		const source2 = sourceRun(base, "run-observe-2");
		expect(
			observeMissingA2AToolCall(base.store, {
				runId: source2.run.id,
				bodyMd: "Please ask reviewer to look",
				toolCalls: ["a2a_send"],
			}),
		).toBeNull();
	});
});
