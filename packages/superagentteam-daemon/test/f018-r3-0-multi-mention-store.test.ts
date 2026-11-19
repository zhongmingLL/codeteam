import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InvocationRecordStore, TurnExecutionStore } from "../src/domains/invocation/store.ts";
import { MessageStore } from "../src/domains/message/store.ts";
import { MultiMentionStore } from "../src/domains/multi-mention/store.ts";
import { ThreadStore } from "../src/domains/thread/store.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";

const dirs: string[] = [];

function makeWorld() {
	const dir = mkdtempSync(join(tmpdir(), "f018-r3-mm-"));
	dirs.push(dir);
	const fd = new F018Database({ path: join(dir, "f018.db") });
	const threads = new ThreadStore(fd.db);
	const messages = new MessageStore(fd.db);
	const records = new InvocationRecordStore(fd.db);
	const turns = new TurnExecutionStore(fd.db);
	const store = new MultiMentionStore(fd.db);
	threads.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
	records.create({
		invocationId: "inv1",
		threadId: "t1",
		userId: "u1",
		sourceRecordId: "src-inv",
		userMessageId: null,
		targetAgentIds: ["a1", "a2", "a3"],
		now: 2,
	});
	turns.createRunning({
		turnExecutionId: "te1",
		parentInvocationId: "inv1",
		threadId: "t1",
		userId: "u1",
		agentId: "a1",
		executionKind: "ordinary",
		causal: { triggerMessageId: "m1" },
		startedAt: 3,
	});
	return { fd, threads, messages, store };
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function requestInput(overrides: Record<string, unknown> = {}) {
	return {
		requestId: "r1",
		threadId: "t1",
		userId: "u1",
		initiatorAgentId: "a1",
		initiatorTurnExecutionId: "te1",
		callbackToAgentId: "a3",
		question: "What should we do?",
		context: "ctx",
		targetAgentIds: ["a1", "a2"],
		timeoutMinutes: 8,
		sourceRecordId: "src-mm-1",
		now: 1000,
		...overrides,
	};
}

describe("F018 R3 multi_mention store", () => {
	it("creates a request, replays the same source identity, conflicts on a different one", () => {
		const w = makeWorld();
		const created = w.store.createRequest(requestInput());
		expect(created.outcome).toBe("created");
		expect(created.request.status).toBe("pending");
		expect(created.request.expiresAt).toBe(1000 + 8 * 60_000);

		const replay = w.store.createRequest(requestInput({ requestId: "r-other" }));
		expect(replay.outcome).toBe("replayed");
		expect(replay.request.requestId).toBe("r1");

		const conflict = w.store.createRequest(requestInput({ question: "Different?" }));
		expect(conflict.outcome).toBe("conflict");
		expect(conflict.request.requestId).toBe("r1");
	});

	it("enforces targets/callback/timeout bounds", () => {
		const w = makeWorld();
		expect(() => w.store.createRequest(requestInput({ targetAgentIds: ["a1"] }))).toThrow(
			"multi_mention_invalid_targets",
		);
		expect(() => w.store.createRequest(requestInput({ targetAgentIds: ["a1", "a2", "a3", "a4"] }))).toThrow(
			"multi_mention_invalid_targets",
		);
		expect(() => w.store.createRequest(requestInput({ callbackToAgentId: "a1" }))).toThrow(
			"multi_mention_invalid_callback",
		);
		expect(() => w.store.createRequest(requestInput({ timeoutMinutes: 2 }))).toThrow("multi_mention_invalid_timeout");
	});

	it("runs the group state machine and keeps target outcomes first-write-wins", () => {
		const w = makeWorld();
		w.store.createRequest(requestInput());
		expect(w.store.setStatus("r1", "done", 1100).outcome).toBe("invalid_transition");
		expect(w.store.setStatus("r1", "running", 1100).outcome).toBe("updated");
		expect(w.store.setStatus("r1", "partial", 1200).outcome).toBe("updated");

		const first = w.store.recordTargetOutcome({
			requestId: "r1",
			targetAgentId: "a1",
			turnExecutionId: "te1",
			responseMessageId: "resp1",
			status: "received",
			now: 1300,
		});
		expect(first.outcome).toBe("recorded");
		expect(first.response.status).toBe("received");

		const replay = w.store.recordTargetOutcome({
			requestId: "r1",
			targetAgentId: "a1",
			status: "failed",
			reason: "late",
			now: 1400,
		});
		expect(replay.outcome).toBe("replayed");
		expect(replay.response.status).toBe("received");

		expect(
			w.store.recordTargetResponse({
				requestId: "r1",
				targetAgentId: "a1",
				responseMessageId: "resp1",
				responseState: "terminal",
			}),
		).toBe(true);
		expect(w.store.getResponse("r1", "a1")?.responseState).toBe("terminal");
		expect(w.store.getResponse("r1", "a1")?.status).toBe("received");

		w.store.recordTargetOutcome({
			requestId: "r1",
			targetAgentId: "a2",
			status: "failed",
			reason: "boom",
			now: 1500,
		});
		expect(w.store.allTargetsAccounted("r1")).toBe(true);
		expect(w.store.statusView("r1")?.allFailed).toBe(false);
		expect(w.store.setStatus("r1", "done", 1600).outcome).toBe("updated");
		expect(w.store.setStatus("r1", "timeout", 1700).outcome).toBe("terminal_conflict");
	});

	it("derives allFailed, expires, and status view", () => {
		const w = makeWorld();
		w.store.createRequest(requestInput({ requestId: "r2", sourceRecordId: "src-mm-2", now: 1000 }));
		w.store.setStatus("r2", "running", 1100);
		w.store.recordTargetOutcome({ requestId: "r2", targetAgentId: "a1", status: "failed", now: 1200 });
		expect(w.store.listExpired(1000 + 8 * 60_000 - 1)).toHaveLength(0);
		expect(w.store.listExpired(1000 + 8 * 60_000)).toHaveLength(1);
		w.store.recordTargetOutcome({ requestId: "r2", targetAgentId: "a2", status: "timeout", now: 1300 });
		w.store.setStatus("r2", "timeout", 1400);
		const view = w.store.statusView("r2")!;
		expect(view.allFailed).toBe(true);
		expect(view.responses).toHaveLength(2);
		expect(view.request.status).toBe("timeout");
	});

	it("allows partial→failed and derives allFailed purely from responses", () => {
		const w = makeWorld();
		w.store.createRequest(requestInput({ requestId: "r3", sourceRecordId: "src-mm-3" }));
		w.store.setStatus("r3", "running", 100);
		w.store.recordTargetOutcome({ requestId: "r3", targetAgentId: "a1", status: "received", now: 200 });
		expect(w.store.get("r3")?.status).toBe("partial");
		expect(w.store.setStatus("r3", "failed", 300).outcome).toBe("updated");
		expect(w.store.statusView("r3")?.allFailed).toBe(false);

		w.store.createRequest(requestInput({ requestId: "r4", sourceRecordId: "src-mm-4" }));
		w.store.setStatus("r4", "running", 100);
		w.store.recordTargetOutcome({ requestId: "r4", targetAgentId: "a1", status: "failed", now: 200 });
		expect(w.store.setStatus("r4", "failed", 300).outcome).toBe("updated");
		expect(w.store.statusView("r4")?.allFailed).toBe(true);
	});

	it("keeps terminal response_state monotonic against a late missing update", () => {
		const w = makeWorld();
		w.store.createRequest(requestInput());
		w.store.setStatus("r1", "running", 100);
		w.store.recordTargetOutcome({
			requestId: "r1",
			targetAgentId: "a1",
			status: "received",
			responseMessageId: "resp1",
			responseState: "terminal",
			now: 200,
		});
		expect(
			w.store.recordTargetResponse({
				requestId: "r1",
				targetAgentId: "a1",
				responseMessageId: null,
				responseState: "missing",
			}),
		).toBe(true);
		const response = w.store.getResponse("r1", "a1")!;
		expect(response.responseState).toBe("terminal");
		expect(response.responseMessageId).toBe("resp1");
	});

	it("rejects oversized question/context and mismatched callbacks", () => {
		const w = makeWorld();
		expect(() =>
			w.store.createRequest(
				requestInput({ question: "x".repeat(5 * 1024 + 1), sourceRecordId: "src-too-large" }),
			),
		).toThrow("multi_mention_question_too_large");
		w.store.createRequest(requestInput({ sourceRecordId: "src-cb-check" }));
		const aggregate = w.messages.append({
			id: "agg-cb-check",
			threadId: "t1",
			from: { kind: "system", service: "multi_mention" },
			content: "aggregate",
			now: 2000,
		});
		expect(() =>
			w.store.createCallback({
				requestId: "r1",
				threadId: "t2",
				callbackToAgentId: "a3",
				aggregateMessageId: aggregate.id,
				callbackDepth: 1,
				now: 2001,
			}),
		).toThrow("multi_mention_callback_mismatch");
		expect(() =>
			w.store.createCallback({
				requestId: "r1",
				threadId: "t1",
				callbackToAgentId: "a3",
				aggregateMessageId: "missing-aggregate",
				callbackDepth: 1,
				now: 2002,
			}),
		).toThrow("multi_mention_aggregate_invalid");
	});

	it("creates one callback per request and follows the callback lifecycle", () => {
		const w = makeWorld();
		w.store.createRequest(requestInput());
		const aggregate = w.messages.append({
			id: "agg1",
			threadId: "t1",
			from: { kind: "system", service: "multi_mention" },
			content: "aggregate",
			now: 2000,
		});
		const created = w.store.createCallback({
			requestId: "r1",
			threadId: "t1",
			callbackToAgentId: "a3",
			aggregateMessageId: aggregate.id,
			callbackDepth: 1,
			now: 2000,
		});
		expect(created.outcome).toBe("created");
		expect(created.callback!.status).toBe("pending");
		const replay = w.store.createCallback({
			requestId: "r1",
			threadId: "t1",
			callbackToAgentId: "a3",
			aggregateMessageId: aggregate.id,
			callbackDepth: 1,
			now: 2001,
		});
		expect(replay.outcome).toBe("replayed");
		expect(replay.callback).not.toBeNull();
		expect(() =>
			w.store.createCallback({
				requestId: "r-missing",
				threadId: "t1",
				callbackToAgentId: "a3",
				aggregateMessageId: aggregate.id,
				callbackDepth: 3 as 1 | 2,
				now: 2002,
			}),
		).toThrow("multi_mention_cascade");

		expect(w.store.updateCallback("r1", { status: "queued", now: 2100 }).outcome).toBe("updated");
		expect(w.store.updateCallback("r1", { status: "running", now: 2200 }).outcome).toBe("updated");
		expect(w.store.updateCallback("r1", { status: "completed", now: 2300 }).outcome).toBe("updated");
		expect(w.store.updateCallback("r1", { status: "running", now: 2400 }).outcome).toBe("terminal_conflict");
		expect(w.store.listPendingCallbacks()).toHaveLength(0);
	});
});
