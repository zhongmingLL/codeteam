import { afterEach, describe, expect, it } from "vitest";
import {
	A2A_TOOL_NAMES,
	createA2AHandlers,
	type HandoffCreateInput,
	HandoffTerminalResolver,
	resolveRunPrincipal,
} from "../src/index.ts";
import {
	bootstrapProfiles,
	cleanupDaemonE2E,
	createBacklogAndDispatch,
	prepareTask,
	setupDirs,
	startE2eDaemon,
	trackMock,
	waitFor,
} from "./helpers/daemon-e2e.ts";
import {
	lastMessageHasToolResult,
	startMockAnthropic,
	textResponse,
	toolCallResponse,
} from "./helpers/mock-anthropic.ts";
import { createW5AFixture } from "./helpers/w5a-fixture.ts";

afterEach(async () => {
	await cleanupDaemonE2E();
});

function registeredTool(logical: string): string {
	const name = A2A_TOOL_NAMES.find((candidate) => candidate === logical || candidate.endsWith(`_${logical}`));
	if (!name) throw new Error(`registered tool ${logical} is missing`);
	return name;
}

function messagesOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
	return Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
}

function lastToolName(body: Record<string, unknown>): string | null {
	const messages = messagesOf(body);
	const last = messages.at(-1);
	if (!last || !Array.isArray(last.content)) return null;
	const result = last.content.find(
		(part) => part && typeof part === "object" && (part as { type?: unknown }).type === "tool_result",
	) as { tool_use_id?: unknown } | undefined;
	if (!result || typeof result.tool_use_id !== "string") return null;
	for (let index = messages.length - 2; index >= 0; index -= 1) {
		const content = messages[index]?.content;
		if (!Array.isArray(content)) continue;
		const toolUse = content.find(
			(part) =>
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "tool_use" &&
				(part as { id?: unknown }).id === result.tool_use_id,
		) as { name?: unknown } | undefined;
		if (toolUse && typeof toolUse.name === "string") return toolUse.name;
	}
	return null;
}

function handoffIdFromPrompt(body: Record<string, unknown>): string | null {
	const match = /Handoff ID: ([A-Za-z0-9._:-]+)/.exec(JSON.stringify(body.messages ?? []));
	return match?.[1] ?? null;
}

function parallelHandoffInput(idempotencyKey: string): HandoffCreateInput {
	return {
		kind: "review_request",
		targets: ["profile:reviewer-a", "profile:reviewer-b"],
		subject: "Parallel review",
		subjectRef: "pr:owner/repo#parallel",
		actionFamily: "review",
		successorSlot: "reviewer",
		expectedArtifact: "artifact:review",
		deadline: Date.now() + 60 * 60 * 1000,
		idempotencyKey,
		mode: "parallel",
		parallelIntent: "independent review",
		terminalPredicate: { kind: "run_completed" },
		bodyMd: "Please review in parallel.",
	};
}

function mockParallelReviewer(body: Record<string, unknown>): string {
	const handoffId = handoffIdFromPrompt(body);
	if (!handoffId) return textResponse("REVIEWER_ACK");
	const lastTool = lastToolName(body);
	if (lastTool === registeredTool("handoff_claim")) {
		return toolCallResponse(registeredTool("handoff_complete"), {
			handoffId,
			evidenceRef: "review:approved",
			result: { verdict: "approved" },
		});
	}
	if (lastTool === registeredTool("handoff_complete")) return textResponse("REVIEW_COMPLETE");
	return toolCallResponse(registeredTool("handoff_claim"), { handoffId });
}

describe("F016a A2A parallel/custody real RPC E2E", () => {
	it("A2: a2a_send to two targets creates one queue entry, two parallel runs, and two bubbles", async () => {
		const { dataDir, installationRoot } = setupDirs();
		bootstrapProfiles(dataDir, [
			{ id: "profile:reviewer-a", role: "reviewer", displayName: "Reviewer A" },
			{ id: "profile:reviewer-b", role: "reviewer", displayName: "Reviewer B" },
		]);
		const mock = trackMock(
			await startMockAnthropic(({ model, body }) => {
				if (model === "mock-coder") {
					if (lastMessageHasToolResult(body)) return textResponse("CODER_SENT");
					return toolCallResponse(registeredTool("a2a_send"), {
						kind: "status",
						targets: ["profile:reviewer-a", "profile:reviewer-b"],
						bodyMd: "parallel status",
						requestId: "req-a2-multi",
					});
				}
				if (model === "mock-reviewer") return textResponse("REVIEWER_DONE");
				return textResponse("OK");
			}),
		);
		const { daemon, store } = await startE2eDaemon(
			dataDir,
			installationRoot,
			mock.baseUrl,
			["mock-coder", "mock-reviewer"],
			{ pollIntervalMs: 60_000, sweepIntervalMs: 60_000 },
		);
		const dispatched = createBacklogAndDispatch(dataDir, "profile:coder", "kickoff");
		prepareTask(dataDir, dispatched.task.id, ["profile:coder", "profile:reviewer-a", "profile:reviewer-b"]);

		await daemon.controlPlane!.drainNow(1);
		const coderRun = await waitFor(() =>
			store.runs.list({ taskId: dispatched.task.id }).find((run) => run.recipientProfileId === "profile:coder"),
		);
		expect(coderRun.status).toBe("completed");
		await daemon.controlPlane!.drainNow(1);
		const reviewerRuns = await waitFor(() => {
			const runs = store.runs
				.list({ taskId: dispatched.task.id })
				.filter((run) => run.recipientProfileId.startsWith("profile:reviewer-"));
			return runs.length === 2 && runs.every((run) => run.status === "completed") ? runs : null;
		});
		expect(new Set(reviewerRuns.map((run) => run.queueEntryId)).size).toBe(1);
		const source = store.messages
			.listThread(dispatched.thread.id, { limit: 200 })
			.find((message) => message.authorId === "profile:coder" && message.bodyMd.includes("parallel status"));
		expect(source).toBeDefined();
		expect(source!.controlRef).toBeNull();
		const refs = source!.dispatchRefs;
		expect(refs).toHaveLength(2);
		expect(refs.every((ref) => (ref as { phase?: string }).phase === "settled")).toBe(true);
		const responses = reviewerRuns.map((run) => store.messages.get(run.responseMessageId!)!);
		expect(responses.every((message) => message.kind === "agent_response")).toBe(true);
		expect(responses.every((message) => message.bodyMd.includes("REVIEWER_DONE"))).toBe(true);
		expect(new Set(responses.map((message) => message.id)).size).toBe(2);
		expect(
			store.evals
				.listByTask(dispatched.task.id)
				.some((record) => record.metrics.a2a_tool_call_success === 1 && record.metrics.a2a_tool === "a2a_send"),
		).toBe(true);

		const sourceRun = store.runs
			.list({ taskId: dispatched.task.id })
			.find((run) => run.recipientProfileId === "profile:coder")!;
		const handlers = createA2AHandlers({
			store,
			principal: resolveRunPrincipal(store, sourceRun.id),
		});
		expect(() =>
			handlers.send({
				kind: "question",
				targets: ["profile:reviewer-a", "profile:reviewer-a"],
				bodyMd: "duplicate target",
			}),
		).toThrowError(expect.objectContaining({ code: "invalid_input" }));
	}, 90_000);

	it("A7: parallel handoff is consumed only after both holders complete", async () => {
		const { dataDir, installationRoot } = setupDirs();
		bootstrapProfiles(dataDir, [
			{ id: "profile:reviewer-a", role: "reviewer", displayName: "Reviewer A" },
			{ id: "profile:reviewer-b", role: "reviewer", displayName: "Reviewer B" },
		]);
		const mock = trackMock(
			await startMockAnthropic(({ model, body }) => {
				if (model === "mock-coder") {
					if (lastToolName(body) === registeredTool("handoff_create"))
						return textResponse("CODER_HANDOFF_CREATED");
					return toolCallResponse(registeredTool("handoff_create"), {
						...parallelHandoffInput("idem-parallel"),
					});
				}
				if (model === "mock-reviewer") return mockParallelReviewer(body);
				return textResponse("OK");
			}),
		);
		const { daemon, store } = await startE2eDaemon(
			dataDir,
			installationRoot,
			mock.baseUrl,
			["mock-coder", "mock-reviewer"],
			{ pollIntervalMs: 60_000, sweepIntervalMs: 60_000 },
		);
		const dispatched = createBacklogAndDispatch(dataDir, "profile:coder", "kickoff");
		prepareTask(dataDir, dispatched.task.id, ["profile:coder", "profile:reviewer-a", "profile:reviewer-b"]);

		await daemon.controlPlane!.drainNow(1);
		const handoff = await waitFor(() => store.handoffs.list({ taskId: dispatched.task.id })[0]);
		expect(handoff.mode).toBe("parallel");
		await daemon.controlPlane!.drainNow(1);
		const consumed = await waitFor(() => {
			const current = store.handoffs.get(handoff.id);
			return current?.status === "consumed" ? current : null;
		});
		const candidateProfiles = Object.values(consumed.completionCandidates)
			.map((candidate) => (candidate as { profileId?: string }).profileId)
			.sort();
		expect(candidateProfiles).toEqual(["profile:reviewer-a", "profile:reviewer-b"]);
		expect(Object.keys(consumed.completionCandidates)).toHaveLength(2);
		const reviewerRuns = store.runs
			.list({ taskId: dispatched.task.id })
			.filter((run) => run.recipientProfileId.startsWith("profile:reviewer-"));
		expect(reviewerRuns).toHaveLength(2);
		expect(reviewerRuns.every((run) => run.status === "completed")).toBe(true);
		const custodyKinds = store.handoffs.custodyEvents(handoff.id).map((event) => event.kind);
		expect(custodyKinds).toContain("handoff.completed");
		expect(custodyKinds).not.toContain("handoff.parallel_unfinished");

		const coderRun = store.runs
			.list({ taskId: dispatched.task.id })
			.find((run) => run.recipientProfileId === "profile:coder")!;
		const handlers = createA2AHandlers({ store, principal: resolveRunPrincipal(store, coderRun.id) });
		expect(() => handlers.withdrawHandoff(handoff.id, "terminal handoff")).toThrowError(
			expect.objectContaining({ code: "invalid_state" }),
		);
	}, 90_000);

	it("A6: author withdraw cleans the pending queue and prevents the reviewer run", async () => {
		const { dataDir, installationRoot } = setupDirs();
		bootstrapProfiles(dataDir);
		const mock = trackMock(
			await startMockAnthropic(({ model, body }) => {
				if (model !== "mock-coder") return textResponse("REVIEWER_SHOULD_NOT_RUN");
				if (lastToolName(body) === registeredTool("handoff_create")) return textResponse("CODER_HANDOFF_CREATED");
				return toolCallResponse(registeredTool("handoff_create"), {
					kind: "review_request",
					targets: ["profile:reviewer"],
					subject: "Withdraw review",
					subjectRef: "pr:owner/repo#withdraw",
					actionFamily: "review",
					successorSlot: "reviewer",
					expectedArtifact: "artifact:review",
					deadline: Date.now() + 60 * 60 * 1000,
					idempotencyKey: "idem-withdraw",
					terminalPredicate: { kind: "run_completed" },
					bodyMd: "Please review before withdrawal.",
				});
			}),
		);
		const { daemon, store } = await startE2eDaemon(
			dataDir,
			installationRoot,
			mock.baseUrl,
			["mock-coder", "mock-reviewer"],
			{ pollIntervalMs: 60_000, sweepIntervalMs: 60_000 },
		);
		const dispatched = createBacklogAndDispatch(dataDir, "profile:coder", "kickoff");
		const prepared = prepareTask(dataDir, dispatched.task.id, ["profile:coder", "profile:reviewer"]);
		await daemon.controlPlane!.drainNow(1);
		const handoff = await waitFor(() => store.handoffs.list({ taskId: dispatched.task.id })[0]);
		const coderSession = prepared.sessions.find((session) => session.profileId === "profile:coder")!;
		const authorSource = store.messages.append({
			threadId: dispatched.thread.id,
			taskId: dispatched.task.id,
			authorKind: "user",
			authorId: "user:test",
			kind: "chat",
			bodyMd: "withdraw the handoff",
		});
		const authorRun = store.runs.create({
			taskId: dispatched.task.id,
			role: "coder",
			agentSessionId: coderSession.id,
			sourceId: authorSource.id,
			recipientProfileId: "profile:coder",
			provider: "mock",
			model: "mock-coder",
			modelFamily: "test",
		});
		const handlers = createA2AHandlers({ store, principal: resolveRunPrincipal(store, authorRun.id) });
		const withdrawn = handlers.withdrawHandoff(handoff.id, "scope changed");
		expect(withdrawn.status).toBe("withdrawn");
		const handoffMessage = store.messages.findByControlRef(handoff.id)!;
		const queueEntry = store.queue.get(`queue:${handoffMessage.id}`)!;
		expect(queueEntry.status).toBe("withdrawn");
		expect(
			store.audit.listSubject(`queue:${queueEntry.id}`, 20).some((entry) => entry.action === "queue_withdrawn"),
		).toBe(true);
		store.runs.terminal(authorRun.id, { status: "completed" });
		await daemon.controlPlane!.drainNow(1);
		expect(
			store.runs
				.list({ taskId: dispatched.task.id })
				.filter((run) => run.recipientProfileId === "profile:reviewer"),
		).toHaveLength(0);
		expect(store.handoffs.get(handoff.id)?.status).toBe("withdrawn");
	}, 90_000);

	it("A9: a second live canonical handoff is blocked inside a real worker", async () => {
		const { dataDir, installationRoot } = setupDirs();
		bootstrapProfiles(dataDir);
		let handoffAttempts = 0;
		const mock = trackMock(
			await startMockAnthropic(({ model, body }) => {
				if (model !== "mock-coder") return textResponse("OK");
				if (!lastMessageHasToolResult(body)) {
					handoffAttempts = 1;
					return toolCallResponse(registeredTool("handoff_create"), {
						kind: "review_request",
						targets: ["profile:reviewer"],
						subject: "Loop guard",
						subjectRef: "pr:owner/repo#loop",
						actionFamily: "review",
						successorSlot: "reviewer",
						expectedArtifact: "artifact:review",
						deadline: Date.now() + 60 * 60 * 1000,
						idempotencyKey: "idem-loop-1",
						terminalPredicate: { kind: "run_completed" },
						bodyMd: "First attempt.",
					});
				}
				if (handoffAttempts === 1) {
					handoffAttempts = 2;
					return toolCallResponse(registeredTool("handoff_create"), {
						kind: "review_request",
						targets: ["profile:reviewer"],
						subject: "Loop guard",
						subjectRef: "pr:owner/repo#loop",
						actionFamily: "review",
						successorSlot: "reviewer",
						expectedArtifact: "artifact:review",
						deadline: Date.now() + 60 * 60 * 1000,
						idempotencyKey: "idem-loop-2",
						terminalPredicate: { kind: "run_completed" },
						bodyMd: "Second attempt.",
					});
				}
				return textResponse("LOOP_GUARD_OBSERVED");
			}),
		);
		const { daemon, store } = await startE2eDaemon(
			dataDir,
			installationRoot,
			mock.baseUrl,
			["mock-coder", "mock-reviewer"],
			{ pollIntervalMs: 60_000, sweepIntervalMs: 60_000 },
		);
		const dispatched = createBacklogAndDispatch(dataDir, "profile:coder", "kickoff");
		prepareTask(dataDir, dispatched.task.id, ["profile:coder", "profile:reviewer"]);
		await daemon.controlPlane!.drainNow(1);
		const coderRun = await waitFor(() =>
			store.runs
				.list({ taskId: dispatched.task.id })
				.find((run) => run.recipientProfileId === "profile:coder" && run.status !== "running"),
		);
		expect(coderRun.status).toBe("completed");
		const handoffs = store.handoffs.list({ taskId: dispatched.task.id });
		expect(handoffs).toHaveLength(1);
		expect(handoffs[0]?.idempotencyKey).toBe("idem-loop-1");
		expect(
			store.audit
				.listSubject(`handoff:${handoffs[0]!.id}`, 50)
				.some((entry) => entry.action === "handoff_loop_guard_blocked"),
		).toBe(true);
	}, 90_000);

	it("A7: a failed holder is recorded as parallel_unfinished while the other holder waits", () => {
		const base = createW5AFixture();
		try {
			const source = base.createSourceMessage("parallel semantics");
			const coderRun = base.createRun({
				id: "run-parallel-coder",
				profileId: "profile:coder",
				role: "coder",
				sessionId: "session-coder",
				sourceId: source.id,
			});
			const handlers = createA2AHandlers({
				store: base.store,
				principal: resolveRunPrincipal(base.store, coderRun.id),
				clock: base.now,
			});
			const created = handlers.createHandoff(parallelHandoffInput("idem-parallel-semantics"));
			const reviewerARun = base.createRun({
				id: "run-parallel-reviewer-a",
				profileId: "profile:reviewer-a",
				role: "reviewer",
				sessionId: "session-reviewer-a",
				sourceId: source.id,
			});
			const reviewerBRun = base.createRun({
				id: "run-parallel-reviewer-b",
				profileId: "profile:reviewer-b",
				role: "reviewer",
				sessionId: "session-reviewer-b",
				sourceId: source.id,
			});
			const reviewerA = createA2AHandlers({
				store: base.store,
				principal: resolveRunPrincipal(base.store, reviewerARun.id),
				clock: base.now,
			});
			const reviewerB = createA2AHandlers({
				store: base.store,
				principal: resolveRunPrincipal(base.store, reviewerBRun.id),
				clock: base.now,
			});
			expect(reviewerA.claimHandoff(created.handoff.id).status).toBe("claimed");
			expect(reviewerB.claimHandoff(created.handoff.id).status).toBe("claimed");
			reviewerA.completeHandoff(created.handoff.id, "review:a", { verdict: "approved" });
			base.store.runs.terminal(reviewerARun.id, { status: "completed" });
			base.store.runs.terminal(reviewerBRun.id, { status: "failed" });
			const failedRun = base.store.runs.get(reviewerBRun.id)!;
			const resolver = new HandoffTerminalResolver({ store: base.store });
			resolver.onRunTerminal(failedRun);
			const handoff = base.store.handoffs.get(created.handoff.id)!;
			expect(handoff.holderOutcomes["profile:reviewer-b"]).toMatchObject({ outcome: "unfinished" });
			expect(
				base.store.audit
					.listSubject(`handoff:${handoff.id}`, 50)
					.some((entry) => entry.action === "handoff_parallel_unfinished"),
			).toBe(true);
			const resolution = resolver.resolvePending("task-1").find((entry) => entry.handoffId === handoff.id);
			expect(resolution).toMatchObject({
				status: "waiting",
				reason: "parallel_holders_pending:profile:reviewer-b",
			});
		} finally {
			base.cleanup();
		}
	});

	it("A10: handoff direction uses the run role, not the profile primary role", () => {
		const base = createW5AFixture();
		try {
			base.store.profiles.create({
				id: "profile:dual-role",
				role: "architect",
				displayName: "Dual Role",
				provider: "test",
				model: "model-coder",
				modelFamily: "test-family",
				toolPolicyProfile: "default",
			});
			base.store.sessions.create({
				id: "session-dual-role",
				threadId: "thread-1",
				taskId: "task-1",
				profileId: "profile:dual-role",
				role: "coder",
				effectiveToolPolicy: "default",
				provider: "test",
				model: "model-coder",
				modelFamily: "test-family",
				seq: 0,
				userId: "user-1",
				workingDirectory: base.dataDir,
			});
			const source = base.createSourceMessage("execution role");
			const run = base.createRun({
				id: "run-dual-role",
				profileId: "profile:dual-role",
				role: "coder",
				sessionId: "session-dual-role",
				sourceId: source.id,
			});
			const handlers = createA2AHandlers({
				store: base.store,
				principal: resolveRunPrincipal(base.store, run.id),
				clock: base.now,
			});
			const created = handlers.createHandoff({
				kind: "review_request",
				targets: ["profile:reviewer-a"],
				subject: "Execution role",
				subjectRef: "pr:owner/repo#role",
				actionFamily: "review",
				successorSlot: "reviewer",
				expectedArtifact: "artifact:review",
				deadline: base.now() + 60_000,
				idempotencyKey: "idem-role",
				terminalPredicate: { kind: "run_completed" },
			});
			expect(base.store.profiles.get("profile:dual-role")?.role).toBe("architect");
			expect(created.handoff.fromRole).toBe("coder");
		} finally {
			base.cleanup();
		}
	});
});
