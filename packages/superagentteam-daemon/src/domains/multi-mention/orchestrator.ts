import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
	MAX_A2A_DEPTH,
	MULTI_MENTION_DEFAULT_TIMEOUT_MINUTES,
	MULTI_MENTION_MAX_CALLBACK_DEPTH,
	MULTI_MENTION_MAX_TARGETS,
	MULTI_MENTION_MAX_TIMEOUT_MINUTES,
	MULTI_MENTION_MIN_TARGETS,
	MULTI_MENTION_MIN_TIMEOUT_MINUTES,
	type MultiMentionStatus,
	type MultiMentionTriggerType,
	type StoredMessage,
} from "@superagentteam/shared/types";
import { runInTransaction } from "../../infrastructure/db/database.ts";
import type { AgentRegistry } from "../agent/registry.ts";
import type { InvocationCredentialStore } from "../auth/store.ts";
import type { MessageStore } from "../message/store.ts";
import type { QueueLedgerStore } from "../queue/store.ts";
import type { ThreadStore } from "../thread/store.ts";
import {
	A2AToolError,
	type A2ATarget,
	type A2AToolContext,
	normalizeTargets,
} from "../a2a/tool-service.ts";
import type { MultiMentionStore } from "./store.ts";

// F018 R3-b MultiMentionOrchestrator.create (0007 §3.8, DP-F018MM-1=B):
// one source message + one queue entry + one request; the queue processor
// creates the parent/N children and records per-target outcomes in T3.

const MAX_QUESTION_BYTES = 5 * 1024;
const MAX_CONTEXT_BYTES = 5 * 1024;

export interface MultiMentionInput {
	targets: readonly A2ATarget[];
	question: string;
	context?: string;
	callbackTo: string;
	timeoutMinutes?: number;
	triggerType?: MultiMentionTriggerType;
	searchEvidenceRefs?: readonly string[];
	overrideReason?: string;
}

export interface MultiMentionCreateResult {
	requestId: string;
	status: MultiMentionStatus;
	message: StoredMessage;
	queueEntryId: string;
	targetAgentIds: string[];
	callbackTo: string;
	replayed: boolean;
}

export interface MultiMentionOrchestratorDeps {
	db: DatabaseSync;
	registry: AgentRegistry;
	threads: ThreadStore;
	messages: MessageStore;
	queue: QueueLedgerStore;
	credentials: InvocationCredentialStore;
	store: MultiMentionStore;
	clock?: () => number;
}

class ReplayRace extends Error {}

function fail(code: ConstructorParameters<typeof A2AToolError>[0], message?: string): never {
	throw new A2AToolError(code, message);
}

export function computeMultiMentionIntentHash(input: {
	threadId: string;
	targets: readonly A2ATarget[];
	question: string;
	context?: string;
	callbackTo: string;
	timeoutMinutes: number;
	triggerType?: MultiMentionTriggerType;
	searchEvidenceRefs?: readonly string[];
	overrideReason?: string;
}): string {
	const stable = {
		tool: "multi_mention",
		threadId: input.threadId,
		targets: input.targets.map((target) => `agent:${target.id}`).sort(),
		question: input.question,
		context: input.context ?? null,
		callbackTo: input.callbackTo,
		timeoutMinutes: input.timeoutMinutes,
		triggerType: input.triggerType ?? null,
		searchEvidenceRefs: input.searchEvidenceRefs ? [...input.searchEvidenceRefs].sort() : null,
		overrideReason: input.overrideReason ?? null,
	};
	return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export class MultiMentionOrchestrator {
	private readonly deps: MultiMentionOrchestratorDeps;
	private readonly clock: () => number;

	constructor(deps: MultiMentionOrchestratorDeps) {
		this.deps = deps;
		this.clock = deps.clock ?? Date.now;
	}

	create(ctx: A2AToolContext, input: MultiMentionInput): MultiMentionCreateResult {
		const now = ctx.now ?? this.clock();
		if (typeof ctx.piExtToolCallId !== "string" || !ctx.piExtToolCallId.trim()) {
			fail("invalid_input", "piExtToolCallId is required");
		}
		const targets = normalizeTargets(input.targets);
		if (targets.length < MULTI_MENTION_MIN_TARGETS || targets.length > MULTI_MENTION_MAX_TARGETS) {
			fail("multi_mention_invalid_targets");
		}
		if (targets.some((target) => target.id === input.callbackTo)) {
			fail("multi_mention_invalid_callback", "callbackTo cannot be a target");
		}
		if (typeof input.question !== "string" || !input.question.trim()) fail("invalid_input", "question is required");
		if (Buffer.byteLength(input.question, "utf8") > MAX_QUESTION_BYTES) {
			fail("invalid_input", "question exceeds 5 KiB");
		}
		if (input.context && Buffer.byteLength(input.context, "utf8") > MAX_CONTEXT_BYTES) {
			fail("invalid_input", "context exceeds 5 KiB");
		}
		const timeoutMinutes = input.timeoutMinutes ?? MULTI_MENTION_DEFAULT_TIMEOUT_MINUTES;
		if (
			!Number.isInteger(timeoutMinutes) ||
			timeoutMinutes < MULTI_MENTION_MIN_TIMEOUT_MINUTES ||
			timeoutMinutes > MULTI_MENTION_MAX_TIMEOUT_MINUTES
		) {
			fail("multi_mention_invalid_timeout");
		}

		const sourceThread = this.deps.threads.get(ctx.threadId);
		if (!sourceThread) fail("thread_not_found");
		if (sourceThread.deletedAt !== null && sourceThread.deletedAt !== undefined) fail("thread_deleted");
		if (sourceThread.createdBy !== ctx.userId) fail("thread_access_denied");

		for (const target of targets) {
			const agent = this.deps.registry.agents.get(target.id);
			if (!agent) fail("agent_not_found", `agent ${target.id} not found`);
			if (!agent.enabled) fail("agent_disabled", `agent ${target.id} is disabled`);
			if (!this.deps.registry.accounts.get(agent.accountRef)) {
				fail("account_not_found", `account ${agent.accountRef} not found`);
			}
		}
		const callbackAgent = this.deps.registry.agents.get(input.callbackTo);
		if (!callbackAgent || !callbackAgent.enabled) {
			fail("multi_mention_invalid_callback", "callbackTo must be an enabled agent");
		}
		if (!this.deps.registry.accounts.get(callbackAgent.accountRef)) {
			fail("multi_mention_invalid_callback", "callbackTo account is missing");
		}

		const depth = Math.max(0, ctx.a2aDepth ?? 0) + 1;
		if (depth > MAX_A2A_DEPTH) fail("a2a_depth_exceeded");
		const callbackDepth = Math.max(0, ctx.multiMentionCallbackDepth ?? 0) + 1;
		if (callbackDepth > MULTI_MENTION_MAX_CALLBACK_DEPTH) fail("multi_mention_cascade");
		if (this.deps.store.isActiveTarget(ctx.callerAgentId)) fail("multi_mention_cascade");

		const intentHash = computeMultiMentionIntentHash({
			threadId: ctx.threadId,
			targets,
			question: input.question,
			context: input.context,
			callbackTo: input.callbackTo,
			timeoutMinutes,
			triggerType: input.triggerType,
			searchEvidenceRefs: input.searchEvidenceRefs,
			overrideReason: input.overrideReason,
		});
		const existingClaim = this.deps.credentials.getToolCallClaim(
			ctx.callerTurnExecutionId,
			ctx.piExtToolCallId,
		);
		if (existingClaim) {
			if (existingClaim.intentHash !== intentHash) fail("pi_ext_tool_call_conflict");
			const existing = this.deps.store.getBySourceRecordId(existingClaim.messageId);
			if (!existing) fail("pi_ext_tool_call_replay_missing");
			const message = this.deps.messages.get(existing.sourceRecordId, { includeDeleted: true });
			if (!message || !existingClaim.queueEntryId) fail("pi_ext_tool_call_replay_missing");
			return {
				requestId: existing.requestId,
				status: existing.status,
				message,
				queueEntryId: existingClaim.queueEntryId,
				targetAgentIds: existing.targetAgentIds,
				callbackTo: existing.callbackToAgentId,
				replayed: true,
			};
		}

		const requestId = `mm:${randomUUID()}`;
		const messageId = `msg:${ctx.threadId}:${now}:${randomUUID().slice(0, 8)}`;
		const callerName = this.deps.registry.agents.get(ctx.callerAgentId)?.displayName ?? ctx.callerAgentId;
		const body = `[Multi-Mention from ${callerName}]\n\n${input.question}${
			input.context ? `\n\n${input.context}` : ""
		}`;
		let message: StoredMessage | null = null;
		let queueEntryId: string | null = null;
		try {
			runInTransaction(this.deps.db, () => {
				const created = this.deps.store.createRequest({
					requestId,
					threadId: ctx.threadId,
					userId: ctx.userId,
					initiatorAgentId: ctx.callerAgentId,
					initiatorTurnExecutionId: ctx.callerTurnExecutionId,
					callbackToAgentId: input.callbackTo,
					question: input.question,
					context: input.context ?? null,
					targetAgentIds: targets.map((target) => target.id),
					timeoutMinutes,
					parentInvocationId: null,
					sourceRecordId: messageId,
					triggerType: input.triggerType ?? null,
					searchEvidenceRefs: input.searchEvidenceRefs ?? null,
					overrideReason: input.overrideReason ?? null,
					now,
				});
				if (created.outcome !== "created") fail("pi_ext_tool_call_conflict");
				message = this.deps.messages.append({
					id: messageId,
					threadId: ctx.threadId,
					from: { kind: "agent", agentId: ctx.callerAgentId },
					content: body,
					lifecycle: { kind: "input", dispatchRefs: [] },
					now,
				});
				let enqueued: ReturnType<QueueLedgerStore["enqueue"]>;
				try {
					enqueued = this.deps.queue.enqueue(
						{
							threadId: ctx.threadId,
							sourceRecordId: messageId,
							messageId,
							attempt: 1,
							owner: { kind: "system", service: "multi_mention" },
							kind: "message_wake",
							from: { kind: "agent", agentId: ctx.callerAgentId },
							content: body,
							targets,
							priority: "normal",
							execution: {
								a2aParentTurnExecutionId: ctx.callerTurnExecutionId,
								a2aTriggerMessageId: messageId,
								a2aDepth: depth,
								multiMentionRequestId: requestId,
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
				if (enqueued.outcome !== "enqueued") fail("queue_admission_conflict");
				queueEntryId = enqueued.entry!.queueEntryId;
				const reserved = this.deps.credentials.reserveToolCallClaim(
					ctx.callerTurnExecutionId,
					{ piExtToolCallId: ctx.piExtToolCallId, intentHash, messageId, queueEntryId },
					now,
				);
				if (reserved.outcome === "conflict") fail("pi_ext_tool_call_conflict");
				if (reserved.outcome === "replayed") throw new ReplayRace();
			});
		} catch (error) {
			if (error instanceof ReplayRace) {
				const claim = this.deps.credentials.getToolCallClaim(ctx.callerTurnExecutionId, ctx.piExtToolCallId);
				if (!claim) fail("pi_ext_tool_call_replay_missing");
				const replayRequest = this.deps.store.getBySourceRecordId(claim.messageId);
				const replayMessage = this.deps.messages.get(claim.messageId, { includeDeleted: true });
				if (!replayRequest || !replayMessage || !claim.queueEntryId) fail("pi_ext_tool_call_replay_missing");
				return {
					requestId: replayRequest.requestId,
					status: replayRequest.status,
					message: replayMessage,
					queueEntryId: claim.queueEntryId,
					targetAgentIds: replayRequest.targetAgentIds,
					callbackTo: replayRequest.callbackToAgentId,
					replayed: true,
				};
			}
			if (error instanceof Error && error.message === "credential_not_found") fail("credential_not_found");
			throw error;
		}
		if (!message || !queueEntryId) fail("invalid_input", "multi_mention admission incomplete");
		return {
			requestId,
			status: "pending",
			message,
			queueEntryId,
			targetAgentIds: targets.map((target) => target.id),
			callbackTo: input.callbackTo,
			replayed: false,
		};
	}
}
