import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, AgentCatalog, AgentConfig } from "@superagentteam/shared/types";
import { afterEach, describe, expect, it } from "vitest";
import { LoopGuardService } from "../src/domains/a2a/loop-guard.ts";
import { type A2AToolContext, A2AToolError, A2AToolService } from "../src/domains/a2a/tool-service.ts";
import { buildRegistry } from "../src/domains/agent/registry.ts";
import { InvocationCredentialStore } from "../src/domains/auth/store.ts";
import { InvocationRecordStore, TurnExecutionStore } from "../src/domains/invocation/store.ts";
import { MessageStore } from "../src/domains/message/store.ts";
import { QueueLedgerStore } from "../src/domains/queue/store.ts";
import { ResponseDraftStore } from "../src/domains/response/store.ts";
import { AgentSessionStore } from "../src/domains/session/store.ts";
import { ThreadStore } from "../src/domains/thread/store.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";

const dirs: string[] = [];
const ACCOUNT: AccountConfig = { ref: "main", provider: "pi", apiKeyRef: "KEY", models: ["m1"] };

function agentConfig(id: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
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
		...overrides,
	};
}

function makeWorld(allowedTools: string[] = ["post_message", "cross_post_message"]) {
	const dir = mkdtempSync(join(tmpdir(), "f018-r3a-"));
	dirs.push(dir);
	const fd = new F018Database({ path: join(dir, "f018.db") });
	const threads = new ThreadStore(fd.db);
	const messages = new MessageStore(fd.db);
	const queue = new QueueLedgerStore(fd.db);
	const records = new InvocationRecordStore(fd.db);
	const turns = new TurnExecutionStore(fd.db);
	const drafts = new ResponseDraftStore(fd.db);
	const sessions = new AgentSessionStore(fd.db);
	const credentials = new InvocationCredentialStore(fd.db);
	const catalog: AgentCatalog = {
		version: 1,
		agents: [agentConfig("a1"), agentConfig("a2"), agentConfig("a3", { enabled: false })],
	};
	const registry = buildRegistry(catalog, [ACCOUNT]);
	threads.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
	threads.create({ id: "t2", projectPath: "/p2", createdBy: "u1", now: 1 });
	threads.create({ id: "t-other", projectPath: "/p", createdBy: "u2", now: 1 });
	threads.create({ id: "t-del", projectPath: "/p", createdBy: "u1", now: 1 });
	threads.softDelete("t-del", 2);
	fd.db
		.prepare(
			"INSERT INTO threads (id, project_path, title, created_by, last_active_at, created_at, updated_at) VALUES ('t-empty', '', 'empty', 'u1', 1, 1, 1)",
		)
		.run();
	const session = sessions.ensureActive({
		threadId: "t1",
		agentId: "a1",
		userId: "u1",
		workingDirectory: "/p",
		now: 1,
	});
	records.create({
		invocationId: "inv1",
		threadId: "t1",
		userId: "u1",
		sourceRecordId: "src",
		userMessageId: null,
		targetAgentIds: ["a1"],
		now: 2,
	});
	turns.createRunning({
		turnExecutionId: "te1",
		parentInvocationId: "inv1",
		threadId: "t1",
		userId: "u1",
		agentId: "a1",
		executionKind: "ordinary",
		causal: { triggerMessageId: "m-trigger" },
		startedAt: 3,
	});
	credentials.create({
		turnExecutionId: "te1",
		parentInvocationId: "inv1",
		threadId: "t1",
		agentId: "a1",
		agentSessionId: session.id,
		userId: "u1",
		allowedTools,
		now: 4,
	});
	const loopGuard = new LoopGuardService({ turns, messages, drafts });
	const service = new A2AToolService({ db: fd.db, registry, threads, messages, queue, credentials, loopGuard });
	return { fd, threads, messages, queue, credentials, service };
}

function ctx(overrides: Partial<A2AToolContext> = {}): A2AToolContext {
	return {
		threadId: "t1",
		userId: "u1",
		callerAgentId: "a1",
		callerTurnExecutionId: "te1",
		piExtToolCallId: "call-1",
		triggerMessageId: "m-trigger",
		a2aDepth: 0,
		now: 100,
		...overrides,
	};
}

function expectCode(error: unknown, code: string): void {
	expect(error).toBeInstanceOf(A2AToolError);
	expect((error as A2AToolError).code).toBe(code);
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("F018 R3-a post_message", () => {
	it("enforces the invocation credential allowlist and active state", () => {
		const denied = makeWorld([]);
		try {
			denied.service.postMessage(ctx(), { bodyMd: "denied" });
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "tool_not_allowed");
		}
		const terminal = makeWorld();
		terminal.fd.db
			.prepare(
				"UPDATE invocation_credentials SET state = 'terminal', disposition = 'completed', updated_at = 10 WHERE turn_execution_id = 'te1'",
			)
			.run();
		try {
			terminal.service.crossPostMessage(ctx(), { threadId: "t2", bodyMd: "terminal" });
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "credential_terminal");
		}
	});

	it("creates one agent message + one message_wake queue entry + execution metadata", () => {
		const w = makeWorld();
		const result = w.service.postMessage(ctx(), {
			targets: [{ kind: "agent", id: "a2" }],
			bodyMd: "hello @a2",
		});
		expect(result.replayed).toBe(false);
		expect(result.queueEntryId).toBeTruthy();
		expect(result.message.from).toEqual({ kind: "agent", agentId: "a1" });
		expect(result.message.threadId).toBe("t1");
		expect(result.message.content).toBe("hello @a2");
		expect(result.message.lifecycle).toMatchObject({ kind: "input", dispatchRefs: [] });
		const entry = w.queue.get("t1", result.queueEntryId!)!;
		expect(entry.kind).toBe("message_wake");
		expect(entry.owner).toEqual({ kind: "system", service: "a2a" });
		expect(entry.from).toEqual({ kind: "agent", agentId: "a1" });
		expect(entry.targets).toEqual([{ kind: "agent", id: "a2" }]);
		expect(entry.execution).toMatchObject({
			a2aParentTurnExecutionId: "te1",
			a2aTriggerMessageId: result.message.id,
			a2aDepth: 1,
			multiMentionCallbackDepth: null,
		});
	});

	it("writes message-only without queue/parent and sets mentionsUser only on line-start @operator", () => {
		const w = makeWorld();
		const result = w.service.postMessage(ctx({ piExtToolCallId: "call-message-only" }), {
			bodyMd: "  @operator note",
			targets: [],
		});
		expect(result.queueEntryId).toBeNull();
		expect(result.message.mentionsUser).toBe(true);
		expect(w.queue.listQueued("t1")).toHaveLength(0);
		const notLineStart = w.service.postMessage(ctx({ piExtToolCallId: "call-not-mention" }), {
			bodyMd: "hello @operator",
		});
		expect(notLineStart.message.mentionsUser).toBe(false);
	});

	it("rejects multiple targets with use_multi_mention and invalid targets", () => {
		const w = makeWorld();
		try {
			w.service.postMessage(ctx(), {
				targets: [
					{ kind: "agent", id: "a2" },
					{ kind: "agent", id: "a3" },
				],
				bodyMd: "hi",
			});
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "use_multi_mention");
		}
		try {
			w.service.postMessage(ctx({ piExtToolCallId: "call-disabled" }), {
				targets: [{ kind: "agent", id: "a3" }],
				bodyMd: "hi",
			});
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "agent_disabled");
		}
		try {
			w.service.postMessage(ctx({ piExtToolCallId: "call-unknown" }), {
				targets: [{ kind: "agent", id: "nope" }],
				bodyMd: "hi",
			});
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "agent_not_found");
		}
	});

	it("validates replyTo, body bounds, and A2A depth", () => {
		const w = makeWorld();
		const parent = w.messages.append({
			id: "m-parent",
			threadId: "t1",
			from: { kind: "agent", agentId: "a2" },
			content: "parent",
			now: 50,
		});
		const valid = w.service.postMessage(ctx({ piExtToolCallId: "call-reply" }), {
			bodyMd: "reply",
			replyTo: parent.id,
		});
		expect(valid.message.replyTo).toBe("m-parent");
		try {
			w.service.postMessage(ctx({ piExtToolCallId: "call-bad-reply" }), {
				bodyMd: "reply",
				replyTo: "missing",
			});
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "invalid_reply_to");
		}
		try {
			w.service.postMessage(ctx({ piExtToolCallId: "call-empty" }), { bodyMd: "   " });
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "body_empty");
		}
		try {
			w.service.postMessage(ctx({ piExtToolCallId: "call-depth", a2aDepth: 15 }), { bodyMd: "hi" });
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "a2a_depth_exceeded");
		}
	});

	it("replays the same piExtToolCallId intent and conflicts on a different intent", () => {
		const w = makeWorld();
		const first = w.service.postMessage(ctx({ piExtToolCallId: "call-replay" }), {
			targets: [{ kind: "agent", id: "a2" }],
			bodyMd: "same",
		});
		const replay = w.service.postMessage(ctx({ piExtToolCallId: "call-replay" }), {
			targets: [{ kind: "agent", id: "a2" }],
			bodyMd: "same",
		});
		expect(replay.replayed).toBe(true);
		expect(replay.message.id).toBe(first.message.id);
		expect(replay.queueEntryId).toBe(first.queueEntryId);
		try {
			w.service.postMessage(ctx({ piExtToolCallId: "call-replay" }), {
				targets: [{ kind: "agent", id: "a2" }],
				bodyMd: "different",
			});
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "pi_ext_tool_call_conflict");
		}
	});
});

describe("F018 R3-a cross_post_message", () => {
	it("writes the message/queue to the target thread and records crossPost provenance", () => {
		const w = makeWorld();
		const result = w.service.crossPostMessage(ctx({ piExtToolCallId: "cross-1" }), {
			threadId: "t2",
			targets: [{ kind: "agent", id: "a2" }],
			bodyMd: "cross thread",
		});
		expect(result.sourceThreadId).toBe("t1");
		expect(result.targetThreadId).toBe("t2");
		expect(result.message.threadId).toBe("t2");
		expect(result.message.extra?.crossPost).toEqual({
			sourceThreadId: "t1",
			sourceTriggerMessageId: "m-trigger",
		});
		const entry = w.queue.get("t2", result.queueEntryId!)!;
		expect(entry.kind).toBe("message_wake");
		expect(entry.owner).toEqual({ kind: "system", service: "cross_post" });
	});

	it("rejects same-thread cross-post, foreign/deleted threads, and missing projectPath with a target", () => {
		const w = makeWorld();
		try {
			w.service.crossPostMessage(ctx({ piExtToolCallId: "cross-same" }), {
				threadId: "t1",
				bodyMd: "same",
			});
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "use_post_message");
		}
		try {
			w.service.crossPostMessage(ctx({ piExtToolCallId: "cross-other" }), {
				threadId: "t-other",
				bodyMd: "other",
			});
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "thread_access_denied");
		}
		try {
			w.service.crossPostMessage(ctx({ piExtToolCallId: "cross-deleted" }), {
				threadId: "t-del",
				bodyMd: "deleted",
			});
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "thread_deleted");
		}
		try {
			w.service.crossPostMessage(ctx({ piExtToolCallId: "cross-empty-target" }), {
				threadId: "t-empty",
				targets: [{ kind: "agent", id: "a2" }],
				bodyMd: "target",
			});
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "thread_project_path_required");
		}
		try {
			w.service.postMessage(ctx({ threadId: "t-empty", piExtToolCallId: "post-empty-target" }), {
				targets: [{ kind: "agent", id: "a2" }],
				bodyMd: "target",
			});
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "thread_project_path_required");
		}
		const messageOnlyPost = w.service.postMessage(
			ctx({ threadId: "t-empty", piExtToolCallId: "post-empty-message" }),
			{
				bodyMd: "message only",
			},
		);
		expect(messageOnlyPost.queueEntryId).toBeNull();
		const messageOnly = w.service.crossPostMessage(ctx({ piExtToolCallId: "cross-empty-message" }), {
			threadId: "t-empty",
			bodyMd: "message only",
		});
		expect(messageOnly.queueEntryId).toBeNull();
	});
});
