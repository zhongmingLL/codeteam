import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, AgentCatalog, AgentConfig, StoredMessage } from "@superagentteam/shared/types";
import { afterEach, describe, expect, it } from "vitest";

import { LoopGuardService } from "../src/domains/a2a/loop-guard.ts";
import { type A2AToolContext, A2AToolError, A2AToolService } from "../src/domains/a2a/tool-service.ts";
import { buildRegistry } from "../src/domains/agent/registry.ts";
import { InvocationCredentialStore } from "../src/domains/auth/store.ts";
import { InvocationAttemptStore, InvocationRecordStore, TurnExecutionStore } from "../src/domains/invocation/store.ts";
import { MessageStore } from "../src/domains/message/store.ts";
import { MultiMentionOrchestrator } from "../src/domains/multi-mention/orchestrator.ts";
import { MultiMentionStore } from "../src/domains/multi-mention/store.ts";
import { QueueLedgerStore } from "../src/domains/queue/store.ts";
import { ResponseDraftStore } from "../src/domains/response/store.ts";
import { AgentSessionStore } from "../src/domains/session/store.ts";
import { ThreadStore } from "../src/domains/thread/store.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";

const dirs: string[] = [];
const ACCOUNT: AccountConfig = { ref: "main", provider: "pi", apiKeyRef: "KEY", models: ["m1"] };

function agentConfig(id: string): AgentConfig {
	return {
		id,
		mentionPatterns: [`@${id}`],
		displayName: `Agent ${id}`,
		contextWindow: 128_000,
		roleId: "worker",
		roleDescription: "does things",
		restrictions: [],
		strengths: [],
		accountRef: "main",
		defaultModel: "m1",
		sessionChain: true,
		enabled: true,
	};
}

function makeWorld() {
	const dir = mkdtempSync(join(tmpdir(), "f018-r4b-"));
	dirs.push(dir);
	const fd = new F018Database({ path: join(dir, "f018.db") });
	const threads = new ThreadStore(fd.db);
	const messages = new MessageStore(fd.db);
	const turns = new TurnExecutionStore(fd.db);
	const records = new InvocationRecordStore(fd.db);
	const drafts = new ResponseDraftStore(fd.db);
	const queue = new QueueLedgerStore(fd.db);
	const sessions = new AgentSessionStore(fd.db);
	const credentials = new InvocationCredentialStore(fd.db);
	const attempts = new InvocationAttemptStore(fd.db);
	const catalog: AgentCatalog = { version: 1, agents: [agentConfig("a1"), agentConfig("a2"), agentConfig("a3")] };
	const registry = buildRegistry(catalog, [ACCOUNT]);
	threads.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
	records.create({
		invocationId: "inv-loop",
		threadId: "t1",
		userId: "u1",
		sourceRecordId: "src-loop",
		userMessageId: null,
		targetAgentIds: ["a1", "a2", "a3"],
		now: 2,
	});
	const guard = new LoopGuardService({ turns, messages, drafts });
	return { fd, threads, messages, turns, records, drafts, queue, sessions, credentials, attempts, registry, guard };
}

function createTurn(
	world: ReturnType<typeof makeWorld>,
	agentId: string,
	causal: { a2aParentTurnExecutionId?: string; a2aTriggerMessageId?: string; a2aDepth?: number } = {},
): string {
	const turnExecutionId = `te:${randomUUID()}`;
	world.turns.createRunning({
		turnExecutionId,
		parentInvocationId: "inv-loop",
		threadId: "t1",
		userId: "u1",
		agentId,
		executionKind: "ordinary",
		causal: { triggerMessageId: "root", ...causal },
		startedAt: 3,
	});
	return turnExecutionId;
}

function triggerMessage(world: ReturnType<typeof makeWorld>, from: string, content: string): StoredMessage {
	return world.messages.append({
		id: `msg:${randomUUID()}`,
		threadId: "t1",
		from: { kind: "agent", agentId: from },
		content,
		now: 4,
	});
}

function buildChain(
	world: ReturnType<typeof makeWorld>,
	edges: Array<{ from: string; to: string; long?: boolean }>,
): { callerTurnExecutionId: string; callerAgentId: string } {
	let parentTurn = createTurn(world, edges[0]!.from);
	let callerAgentId = edges[0]!.from;
	for (const edge of edges) {
		const message = triggerMessage(world, edge.from, edge.long ? "x".repeat(201) : "short");
		const child = createTurn(world, edge.to, {
			a2aParentTurnExecutionId: parentTurn,
			a2aTriggerMessageId: message.id,
			a2aDepth: 1,
		});
		parentTurn = child;
		callerAgentId = edge.to;
	}
	return { callerTurnExecutionId: parentTurn, callerAgentId };
}

function addDraft(
	world: ReturnType<typeof makeWorld>,
	turnExecutionId: string,
	agentId: string,
	options: { content?: string; toolName?: string; sinkToolName?: string } = {},
): void {
	const attemptId = `att:${randomUUID()}`;
	const attempt =
		(
			world.fd.db
				.prepare(
					"SELECT COUNT(*) AS count FROM invocation_attempts WHERE parent_invocation_id = 'inv-loop' AND target_agent_id = ?",
				)
				.get(agentId) as { count: number }
		).count + 1;
	world.fd.db
		.prepare(
			`INSERT INTO invocation_attempts
			 (attempt_id, parent_invocation_id, queue_entry_id, thread_id, target_agent_id, attempt, delivery_state, turn_execution_id, created_at, started_at)
			 VALUES (?, 'inv-loop', 'q-loop', 't1', ?, ?, 'appended', ?, 5, 5)`,
		)
		.run(attemptId, agentId, attempt, turnExecutionId);
	world.drafts.create({
		attemptId,
		turnExecutionId,
		parentInvocationId: "inv-loop",
		threadId: "t1",
		agentId,
		content: options.content ?? "short",
		toolEvents: options.sinkToolName
			? [{ toolCallId: "tool-1", name: options.sinkToolName, status: "completed", at: 5 }]
			: options.toolName
				? [{ id: "e1", type: "tool_use", label: options.toolName, toolName: options.toolName, timestamp: 5 }]
				: [],
		thinking: null,
		createdAt: 5,
		updatedAt: 5,
	});
}

function expectCode(error: unknown, code: string): void {
	expect(error).toBeInstanceOf(A2AToolError);
	expect((error as A2AToolError).code).toBe(code);
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("F018 R4-b loop guard", () => {
	it("warns at 2/3 and blocks at 4 for a short same-pair streak", () => {
		const w = makeWorld();
		const warn2 = buildChain(w, [{ from: "a2", to: "a1" }]);
		expect(w.guard.checkPush({ ...warn2, targetAgentId: "a2" })).toMatchObject({
			count: 2,
			warn: true,
			block: false,
		});
		const warn3 = buildChain(w, [
			{ from: "a2", to: "a1" },
			{ from: "a1", to: "a2" },
		]);
		expect(w.guard.checkPush({ ...warn3, targetAgentId: "a1" })).toMatchObject({
			count: 3,
			warn: true,
			block: false,
		});
		const block4 = buildChain(w, [
			{ from: "a2", to: "a1" },
			{ from: "a1", to: "a2" },
			{ from: "a2", to: "a1" },
		]);
		expect(w.guard.checkPush({ ...block4, targetAgentId: "a2" })).toMatchObject({
			count: 4,
			warn: false,
			block: true,
		});
	});

	it("resets on substantive output, substantive draft activity and pair changes", () => {
		const w = makeWorld();
		const longEdge = buildChain(w, [
			{ from: "a2", to: "a1" },
			{ from: "a1", to: "a2", long: true },
			{ from: "a2", to: "a1" },
		]);
		expect(w.guard.checkPush({ ...longEdge, targetAgentId: "a2" }).count).toBe(3);

		const toolDraft = buildChain(w, [
			{ from: "a2", to: "a1" },
			{ from: "a1", to: "a2" },
			{ from: "a2", to: "a1" },
		]);
		addDraft(w, toolDraft.callerTurnExecutionId, toolDraft.callerAgentId, { toolName: "read" });
		expect(w.guard.checkPush({ ...toolDraft, targetAgentId: "a2" }).count).toBe(1);

		const routingDraft = buildChain(w, [
			{ from: "a2", to: "a1" },
			{ from: "a1", to: "a2" },
			{ from: "a2", to: "a1" },
		]);
		addDraft(w, routingDraft.callerTurnExecutionId, routingDraft.callerAgentId, { toolName: "post_message" });
		expect(w.guard.checkPush({ ...routingDraft, targetAgentId: "a2" }).block).toBe(true);

		const sinkDraft = buildChain(w, [
			{ from: "a2", to: "a1" },
			{ from: "a1", to: "a2" },
			{ from: "a2", to: "a1" },
		]);
		addDraft(w, sinkDraft.callerTurnExecutionId, sinkDraft.callerAgentId, { sinkToolName: "read_file" });
		expect(w.guard.checkPush({ ...sinkDraft, targetAgentId: "a2" }).count).toBe(1);

		const readContextDraft = buildChain(w, [
			{ from: "a2", to: "a1" },
			{ from: "a1", to: "a2" },
			{ from: "a2", to: "a1" },
		]);
		addDraft(w, readContextDraft.callerTurnExecutionId, readContextDraft.callerAgentId, {
			toolName: "thread_context",
		});
		expect(w.guard.checkPush({ ...readContextDraft, targetAgentId: "a2" }).block).toBe(true);

		const pairChange = buildChain(w, [
			{ from: "a2", to: "a1" },
			{ from: "a1", to: "a2" },
			{ from: "a2", to: "a1" },
		]);
		expect(w.guard.checkPush({ ...pairChange, targetAgentId: "a3" }).count).toBe(1);
	});

	it("rebuilds the same decision after a restart without in-memory state", () => {
		const w = makeWorld();
		const chain = buildChain(w, [
			{ from: "a2", to: "a1" },
			{ from: "a1", to: "a2" },
			{ from: "a2", to: "a1" },
		]);
		const before = w.guard.checkPush({ ...chain, targetAgentId: "a2" });
		expect(before.block).toBe(true);
		const restarted = new LoopGuardService({
			turns: new TurnExecutionStore(w.fd.db),
			messages: new MessageStore(w.fd.db),
			drafts: new ResponseDraftStore(w.fd.db),
		});
		expect(restarted.checkPush({ ...chain, targetAgentId: "a2" })).toEqual(before);
	});

	it("rejects a blocked post before any message or queue write", () => {
		const w = makeWorld();
		const session = w.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/p",
			now: 1,
		});
		const callerTurn = createTurn(w, "a1");
		w.credentials.create({
			turnExecutionId: callerTurn,
			parentInvocationId: "inv-loop",
			threadId: "t1",
			agentId: "a1",
			agentSessionId: session.id,
			userId: "u1",
			allowedTools: ["post_message"],
			now: 4,
		});
		const service = new A2AToolService({
			db: w.fd.db,
			registry: w.registry,
			threads: w.threads,
			messages: w.messages,
			queue: w.queue,
			credentials: w.credentials,
			loopGuard: { checkPush: () => ({ count: 4, warn: false, block: true }) } as unknown as LoopGuardService,
		});
		const ctx: A2AToolContext = {
			threadId: "t1",
			userId: "u1",
			callerAgentId: "a1",
			callerTurnExecutionId: callerTurn,
			piExtToolCallId: "loop-block",
			triggerMessageId: "root",
			a2aDepth: 0,
			now: 100,
		};
		const messagesBefore = w.messages.getByThread("t1", 50).length;
		try {
			service.postMessage(ctx, { targets: [{ kind: "agent", id: "a2" }], bodyMd: "blocked" });
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "loop_guard");
		}
		expect(w.messages.getByThread("t1", 50)).toHaveLength(messagesBefore);
		expect(w.queue.listQueued("t1")).toHaveLength(0);
	});

	it("blocks multi_mention fan-out before creating the request or source message", () => {
		const w = makeWorld();
		const session = w.sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/p",
			now: 1,
		});
		const callerTurn = createTurn(w, "a1");
		w.credentials.create({
			turnExecutionId: callerTurn,
			parentInvocationId: "inv-loop",
			threadId: "t1",
			agentId: "a1",
			agentSessionId: session.id,
			userId: "u1",
			allowedTools: ["multi_mention"],
			now: 4,
		});
		const store = new MultiMentionStore(w.fd.db);
		const orchestrator = new MultiMentionOrchestrator({
			db: w.fd.db,
			registry: w.registry,
			threads: w.threads,
			messages: w.messages,
			queue: w.queue,
			credentials: w.credentials,
			attempts: w.attempts,
			turns: w.turns,
			store,
			loopGuard: { checkPush: () => ({ count: 4, warn: false, block: true }) } as unknown as LoopGuardService,
		});
		const messagesBefore = w.messages.getByThread("t1", 50).length;
		try {
			orchestrator.create(
				{
					threadId: "t1",
					userId: "u1",
					callerAgentId: "a1",
					callerTurnExecutionId: callerTurn,
					piExtToolCallId: "loop-mm",
					triggerMessageId: "root",
					a2aDepth: 0,
					now: 100,
				},
				{
					targets: [
						{ kind: "agent", id: "a2" },
						{ kind: "agent", id: "a3" },
					],
					question: "blocked",
					callbackTo: "a1",
					timeoutMinutes: 8,
				},
			);
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "loop_guard");
		}
		expect(w.messages.getByThread("t1", 50)).toHaveLength(messagesBefore);
		expect(w.fd.db.prepare("SELECT COUNT(*) AS count FROM multi_mention_requests").get()).toEqual({ count: 0 });
	});
});
