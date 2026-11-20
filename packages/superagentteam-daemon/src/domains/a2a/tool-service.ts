import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { MAX_A2A_DEPTH, type StoredMessage } from "@superagentteam/shared/types";
import { runInTransaction } from "../../infrastructure/db/database.ts";
import type { AgentRegistry } from "../agent/registry.ts";
import type { InvocationCredentialStore } from "../auth/store.ts";
import type { MessageStore } from "../message/store.ts";
import type { QueueLedgerStore } from "../queue/store.ts";
import type { ThreadStore } from "../thread/store.ts";
import type { LoopGuardService } from "./loop-guard.ts";

// F018 R3-a A2A text tools (0007 §3.8): post_message / cross_post_message.
// One agent target max; message + queue + dispatchRefs are one transaction.
// The queue processor creates the parent/child and appends the dispatchRefs.

const MAX_BODY_BYTES = 32 * 1024;

/** 0007 §3.7: the v1 child credential owns this A2A tool allowlist. */
export const A2A_CREDENTIAL_TOOL_NAMES = [
	"post_message",
	"cross_post_message",
	"multi_mention",
	"thread_context",
] as const;

export type A2ACredentialTool = (typeof A2A_CREDENTIAL_TOOL_NAMES)[number];

export type A2AToolErrorCode =
	| "invalid_input"
	| "body_empty"
	| "body_too_large"
	| "use_multi_mention"
	| "use_post_message"
	| "agent_not_found"
	| "agent_disabled"
	| "account_not_found"
	| "thread_not_found"
	| "thread_deleted"
	| "thread_access_denied"
	| "thread_project_path_required"
	| "invalid_reply_to"
	| "invalid_anchor"
	| "invalid_cursor"
	| "invalid_window"
	| "a2a_depth_exceeded"
	| "loop_guard"
	| "pi_ext_tool_call_conflict"
	| "pi_ext_tool_call_replay_missing"
	| "queue_full"
	| "queue_admission_conflict"
	| "credential_not_found"
	| "credential_terminal"
	| "tool_not_allowed"
	| "multi_mention_invalid_targets"
	| "multi_mention_invalid_callback"
	| "multi_mention_invalid_timeout"
	| "multi_mention_cascade"
	| "multi_mention_not_found";

export class A2AToolError extends Error {
	readonly code: A2AToolErrorCode;

	constructor(code: A2AToolErrorCode, message?: string) {
		super(message ?? code);
		this.code = code;
		this.name = "A2AToolError";
	}
}

export interface A2AToolContext {
	/** Caller's thread. Never the target of post_message. */
	threadId: string;
	userId: string;
	callerAgentId: string;
	callerTurnExecutionId: string;
	/** Injected by the pi extension from toolCallId + toolName. */
	piExtToolCallId: string;
	/** Caller turn's causal trigger; used for crossPost.sourceTriggerMessageId. */
	triggerMessageId?: string | null;
	/** Caller's causal A2A depth; the new queue entry uses +1. */
	a2aDepth?: number | null;
	multiMentionCallbackDepth?: number | null;
	now?: number;
}

export interface A2ATarget {
	kind: "agent";
	id: string;
}

export interface PostMessageInput {
	targets?: readonly A2ATarget[];
	bodyMd: string;
	replyTo?: string;
}

export interface CrossPostMessageInput extends PostMessageInput {
	/** Target thread; must differ from the caller thread. */
	threadId: string;
}

export interface PostMessageResult {
	message: StoredMessage;
	queueEntryId: string | null;
	replayed: boolean;
	warnPingPong?: boolean;
}

export interface CrossPostMessageResult extends PostMessageResult {
	sourceThreadId: string;
	targetThreadId: string;
}

export interface A2AToolServiceDeps {
	db: DatabaseSync;
	registry: AgentRegistry;
	threads: ThreadStore;
	messages: MessageStore;
	queue: QueueLedgerStore;
	credentials: InvocationCredentialStore;
	loopGuard: LoopGuardService;
	clock?: () => number;
}

interface AdmittedMessage {
	message: StoredMessage;
	queueEntryId: string | null;
	replayed: boolean;
	targetThreadId: string;
	sourceThreadId: string;
	warnPingPong?: boolean;
}

class ReplayRace extends Error {}

function fail(code: A2AToolErrorCode, message?: string): never {
	throw new A2AToolError(code, message);
}

export function normalizeTargets(raw: readonly A2ATarget[] | undefined): A2ATarget[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) fail("invalid_input", "targets must be an array");
	const seen = new Set<string>();
	const targets: A2ATarget[] = [];
	for (const target of raw) {
		if (!target || target.kind !== "agent" || typeof target.id !== "string" || !target.id.trim()) {
			fail("invalid_input", "targets must be { kind: 'agent', id: string }");
		}
		if (seen.has(target.id)) continue;
		seen.add(target.id);
		targets.push({ kind: "agent", id: target.id });
	}
	return targets;
}

function hasLineStartOperatorMention(body: string): boolean {
	// v1 tolerates horizontal whitespace before @operator; "line-start" means
	// the first non-space token on a line.
	return /^[ \t]*@operator(?=\s|$)/m.test(body);
}

/** 0007 §3.7: the invocation credential owns the A2A tool allowlist. */
export function assertCredentialAllowsTool(
	credentials: InvocationCredentialStore,
	turnExecutionId: string,
	tool: A2ACredentialTool,
): void {
	const credential = credentials.getByTurn(turnExecutionId);
	if (!credential) fail("credential_not_found");
	if (credential.state !== "active") fail("credential_terminal");
	if (!credential.allowedTools.includes(tool)) fail("tool_not_allowed");
}

/** Stable intent hash for piExtToolCallId replay/conflict (0007 §3.8). */
export function computeA2AToolIntentHash(input: {
	tool: "post_message" | "cross_post_message";
	sourceThreadId: string;
	targetThreadId: string;
	targets: readonly A2ATarget[];
	bodyMd: string;
	replyTo?: string;
}): string {
	const stable = {
		tool: input.tool,
		sourceThreadId: input.sourceThreadId,
		targetThreadId: input.targetThreadId,
		targets: input.targets.map((target) => `agent:${target.id}`).sort(),
		body: input.bodyMd,
		replyTo: input.replyTo ?? null,
	};
	return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export class A2AToolService {
	private readonly deps: A2AToolServiceDeps;
	private readonly clock: () => number;

	constructor(deps: A2AToolServiceDeps) {
		this.deps = deps;
		this.clock = deps.clock ?? Date.now;
	}

	postMessage(ctx: A2AToolContext, input: PostMessageInput): PostMessageResult {
		const admitted = this.admit(ctx, input, ctx.threadId, false);
		return {
			message: admitted.message,
			queueEntryId: admitted.queueEntryId,
			replayed: admitted.replayed,
			...(admitted.warnPingPong ? { warnPingPong: true } : {}),
		};
	}

	crossPostMessage(ctx: A2AToolContext, input: CrossPostMessageInput): CrossPostMessageResult {
		const admitted = this.admit(ctx, input, input.threadId, true);
		return {
			message: admitted.message,
			queueEntryId: admitted.queueEntryId,
			replayed: admitted.replayed,
			sourceThreadId: admitted.sourceThreadId,
			targetThreadId: admitted.targetThreadId,
			...(admitted.warnPingPong ? { warnPingPong: true } : {}),
		};
	}

	private admit(
		ctx: A2AToolContext,
		input: PostMessageInput,
		targetThreadId: string,
		crossPost: boolean,
	): AdmittedMessage {
		const now = ctx.now ?? this.clock();
		if (typeof ctx.piExtToolCallId !== "string" || !ctx.piExtToolCallId.trim()) {
			fail("invalid_input", "piExtToolCallId is required");
		}
		if (typeof input.bodyMd !== "string" || !input.bodyMd.trim()) fail("body_empty");
		if (Buffer.byteLength(input.bodyMd, "utf8") > MAX_BODY_BYTES) fail("body_too_large");
		assertCredentialAllowsTool(
			this.deps.credentials,
			ctx.callerTurnExecutionId,
			crossPost ? "cross_post_message" : "post_message",
		);
		const targets = normalizeTargets(input.targets);
		if (targets.length > 1) {
			if (!crossPost) fail("use_multi_mention", "same-thread messages with multiple targets must use multi_mention");
			fail("invalid_input", "cross_post_message supports at most 1 agent target");
		}

		const sourceThread = this.deps.threads.get(ctx.threadId);
		if (!sourceThread) fail("thread_not_found", `thread ${ctx.threadId} not found`);
		if (sourceThread.deletedAt !== null && sourceThread.deletedAt !== undefined) {
			fail("thread_deleted", `thread ${ctx.threadId} is deleted`);
		}
		if (sourceThread.createdBy !== ctx.userId) fail("thread_access_denied", "caller does not own the source thread");
		if (crossPost && targetThreadId === ctx.threadId) fail("use_post_message");

		const targetThread = this.deps.threads.get(targetThreadId);
		if (!targetThread) fail("thread_not_found", `thread ${targetThreadId} not found`);
		if (targetThread.deletedAt !== null && targetThread.deletedAt !== undefined) {
			fail("thread_deleted", `thread ${targetThreadId} is deleted`);
		}
		if (targetThread.createdBy !== ctx.userId) fail("thread_access_denied", "target thread belongs to another user");
		if (crossPost && targets.length > 0 && !targetThread.projectPath.trim()) {
			fail("thread_project_path_required");
		}

		for (const target of targets) {
			const agent = this.deps.registry.agents.get(target.id);
			if (!agent) fail("agent_not_found", `agent ${target.id} not found`);
			if (!agent.enabled) fail("agent_disabled", `agent ${target.id} is disabled`);
			if (!this.deps.registry.accounts.get(agent.accountRef)) {
				fail("account_not_found", `account ${agent.accountRef} not found`);
			}
		}

		if (input.replyTo) {
			// v1 thread access is single-user; per-message visibility is deferred.
			const reply = this.deps.messages.get(input.replyTo, { includeDeleted: true });
			if (
				!reply ||
				reply.threadId !== targetThreadId ||
				(reply.deletedAt !== null && reply.deletedAt !== undefined)
			) {
				fail("invalid_reply_to");
			}
		}

		const depth = Math.max(0, ctx.a2aDepth ?? 0) + 1;
		if (depth > MAX_A2A_DEPTH) fail("a2a_depth_exceeded");
		const intentHash = computeA2AToolIntentHash({
			tool: crossPost ? "cross_post_message" : "post_message",
			sourceThreadId: ctx.threadId,
			targetThreadId,
			targets,
			bodyMd: input.bodyMd,
			replyTo: input.replyTo,
		});
		const existingClaim = this.deps.credentials.getToolCallClaim(ctx.callerTurnExecutionId, ctx.piExtToolCallId);
		if (existingClaim) {
			if (existingClaim.intentHash !== intentHash) fail("pi_ext_tool_call_conflict");
			const message = this.deps.messages.get(existingClaim.messageId, { includeDeleted: true });
			if (!message) fail("pi_ext_tool_call_replay_missing");
			return {
				message,
				queueEntryId: existingClaim.queueEntryId ?? null,
				replayed: true,
				sourceThreadId: ctx.threadId,
				targetThreadId,
			};
		}

		let warnPingPong = false;
		if (targets.length > 0) {
			const verdict = this.deps.loopGuard.checkPush({
				callerTurnExecutionId: ctx.callerTurnExecutionId,
				callerAgentId: ctx.callerAgentId,
				targetAgentId: targets[0]!.id,
			});
			if (verdict?.block) fail("loop_guard");
			warnPingPong = verdict?.warn ?? false;
		}

		const messageId = `msg:${targetThreadId}:${now}:${randomUUID().slice(0, 8)}`;
		let message: StoredMessage | null = null;
		let queueEntryId: string | null = null;
		try {
			runInTransaction(this.deps.db, () => {
				message = this.deps.messages.append({
					id: messageId,
					threadId: targetThreadId,
					from: { kind: "agent", agentId: ctx.callerAgentId },
					content: input.bodyMd,
					lifecycle: { kind: "input", dispatchRefs: [] },
					mentionsUser: hasLineStartOperatorMention(input.bodyMd),
					replyTo: input.replyTo,
					extra: crossPost
						? {
								crossPost: {
									sourceThreadId: ctx.threadId,
									...(ctx.triggerMessageId ? { sourceTriggerMessageId: ctx.triggerMessageId } : {}),
								},
							}
						: undefined,
					now,
				});
				if (targets.length > 0) {
					let enqueued: ReturnType<QueueLedgerStore["enqueue"]>;
					try {
						enqueued = this.deps.queue.enqueue(
							{
								threadId: targetThreadId,
								sourceRecordId: messageId,
								messageId,
								attempt: 1,
								owner: { kind: "system", service: crossPost ? "cross_post" : "a2a" },
								kind: "message_wake",
								from: { kind: "agent", agentId: ctx.callerAgentId },
								content: input.bodyMd,
								targets,
								priority: "normal",
								execution: {
									a2aParentTurnExecutionId: ctx.callerTurnExecutionId,
									a2aTriggerMessageId: messageId,
									a2aDepth: depth,
									multiMentionRequestId: null,
									multiMentionCallbackDepth: ctx.multiMentionCallbackDepth ?? null,
								},
								piExtToolCallId: ctx.piExtToolCallId,
							},
							now,
						);
					} catch (error) {
						if (error instanceof Error && error.message === "queue_full") fail("queue_full");
						throw error;
					}
					// Random message ids make replayed unreachable; kept as a safety net.
					if (enqueued.outcome !== "enqueued") fail("queue_admission_conflict");
					queueEntryId = enqueued.entry!.queueEntryId;
				}
				const reserved = this.deps.credentials.reserveToolCallClaim(
					ctx.callerTurnExecutionId,
					{
						piExtToolCallId: ctx.piExtToolCallId,
						intentHash,
						messageId,
						queueEntryId,
					},
					now,
				);
				if (reserved.outcome === "conflict") fail("pi_ext_tool_call_conflict");
				if (reserved.outcome === "replayed") throw new ReplayRace();
			});
		} catch (error) {
			if (error instanceof ReplayRace) {
				const claim = this.deps.credentials.getToolCallClaim(ctx.callerTurnExecutionId, ctx.piExtToolCallId);
				if (!claim) fail("pi_ext_tool_call_replay_missing");
				const existing = this.deps.messages.get(claim.messageId, { includeDeleted: true });
				if (!existing) fail("pi_ext_tool_call_replay_missing");
				return {
					message: existing,
					queueEntryId: claim.queueEntryId ?? null,
					replayed: true,
					sourceThreadId: ctx.threadId,
					targetThreadId,
					...(warnPingPong ? { warnPingPong } : {}),
				};
			}
			if (error instanceof Error && error.message === "credential_not_found") fail("credential_not_found");
			throw error;
		}
		if (!message) fail("invalid_input", "message was not created");
		return {
			message,
			queueEntryId,
			replayed: false,
			sourceThreadId: ctx.threadId,
			targetThreadId,
			...(warnPingPong ? { warnPingPong } : {}),
		};
	}
}
