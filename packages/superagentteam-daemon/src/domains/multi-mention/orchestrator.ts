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
	MULTI_MENTION_TERMINAL_STATUSES,
	type MultiMentionRequest,
	type MultiMentionResponse,
	type MultiMentionStatus,
	type MultiMentionTriggerType,
	type StoredMessage,
} from "@superagentteam/shared/types";
import { runInTransaction } from "../../infrastructure/db/database.ts";
import type { AgentRegistry } from "../agent/registry.ts";
import type { InvocationCredentialStore } from "../auth/store.ts";
import type { InvocationAttemptStore, TurnExecutionStore } from "../invocation/store.ts";
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
	attempts: InvocationAttemptStore;
	turns: TurnExecutionStore;
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

	finalizeIfReady(
		requestId: string,
		now: number,
	): "finalized" | "waiting" | "already_terminal" | "not_found" {
		const request = this.deps.store.get(requestId);
		if (!request) return "not_found";
		if (MULTI_MENTION_TERMINAL_STATUSES.has(request.status)) return "already_terminal";
		const responses = this.deps.store.listResponses(requestId);
		if (responses.length < request.targetAgentIds.length) return "waiting";
		return this.finalizeRequest(request, "done", responses, now);
	}

	/** Reaper/startup timeout path: backfill terminal children, then settle. */
	settleExpired(now: number): number {
		let finalized = 0;
		for (const request of this.deps.store.listExpired(now)) {
			this.backfillTerminalChildren(request, now);
			let responses = this.deps.store.listResponses(request.requestId);
			if (responses.length >= request.targetAgentIds.length) {
				if (this.finalizeRequest(request, "done", responses, now) === "finalized") finalized += 1;
				continue;
			}
			const status = request.status === "pending" ? "failed" : "timeout";
			for (const agentId of request.targetAgentIds) {
				if (responses.some((response) => response.targetAgentId === agentId)) continue;
				this.deps.store.recordTargetOutcome({
					requestId: request.requestId,
					targetAgentId: agentId,
					status: "timeout",
					responseState: "missing",
					now,
				});
			}
			responses = this.deps.store.listResponses(request.requestId);
			if (this.finalizeRequest(request, status, responses, now) === "finalized") finalized += 1;
		}
		return finalized;
	}

	/** Startup: settle expired requests and re-deliver pending callbacks only. */
	recover(now: number): { settled: number; callbacksDelivered: number } {
		const settled = this.settleExpired(now);
		let callbacksDelivered = 0;
		for (const callback of this.deps.store.listPendingCallbacks()) {
			this.deliverCallback(callback.requestId, now);
			if (this.deps.store.getCallback(callback.requestId)?.status !== "pending") callbacksDelivered += 1;
		}
		return { settled, callbacksDelivered };
	}

	private finalizeRequest(
		request: MultiMentionRequest,
		status: "done" | "timeout" | "failed",
		responses: MultiMentionResponse[],
		now: number,
	): "finalized" | "waiting" | "already_terminal" | "not_found" {
		const current = this.deps.store.get(request.requestId);
		if (!current) return "not_found";
		if (MULTI_MENTION_TERMINAL_STATUSES.has(current.status)) return "already_terminal";
		if (responses.length < request.targetAgentIds.length) return "waiting";
		const aggregateMessageId = `msg:${request.threadId}:${now}:agg:${randomUUID().slice(0, 8)}`;
		const allFailed = responses.every((response) => response.status !== "received");
		const body = this.buildAggregateBody(request, status, responses);
		const causal = this.initiatorCausal(request);
		const callbackDepth = Math.min((causal.multiMentionCallbackDepth ?? 0) + 1, 2) as 1 | 2;
		let outcome: "finalized" | "already_terminal" = "finalized";
		runInTransaction(this.deps.db, () => {
			const fresh = this.deps.store.get(request.requestId);
			if (!fresh || MULTI_MENTION_TERMINAL_STATUSES.has(fresh.status)) {
				outcome = "already_terminal";
				return;
			}
			this.deps.messages.append({
				id: aggregateMessageId,
				threadId: request.threadId,
				from: { kind: "system", service: "multi_mention" },
				content: body,
				extra: {
					multiMention: {
						requestId: request.requestId,
						status,
						callbackTo: request.callbackToAgentId,
						targetAgentIds: request.targetAgentIds,
						responses: responses.map((response) => ({
							targetAgentId: response.targetAgentId,
							status: response.status,
							responseState: response.responseState,
							responseMessageId: response.responseMessageId,
							reason: response.reason,
						})),
						allFailed,
					},
				},
				now,
			});
			this.deps.store.createCallback({
				requestId: request.requestId,
				threadId: request.threadId,
				callbackToAgentId: request.callbackToAgentId,
				aggregateMessageId,
				callbackDepth,
				now,
			});
			const transition = this.deps.store.setStatus(request.requestId, status, now, { aggregateMessageId });
			if (transition.outcome !== "updated" && transition.outcome !== "already_terminal") {
				throw new Error("multi_mention_finalize_state");
			}
		});
		if (outcome === "finalized") this.deliverCallback(request.requestId, now);
		return outcome;
	}

	private deliverCallback(requestId: string, now: number): void {
		const callback = this.deps.store.getCallback(requestId);
		if (!callback || callback.status !== "pending") return;
		const request = this.deps.store.get(requestId);
		if (!request) {
			this.callbackFailed(requestId, callback, "request_missing", now);
			return;
		}
		const causal = this.initiatorCausal(request);
		const callbackDepth = (causal.multiMentionCallbackDepth ?? 0) + 1;
		const a2aDepth = (causal.a2aDepth ?? 0) + 1;
		const callbackAgent = this.deps.registry.agents.get(callback.callbackToAgentId);
		if (!callbackAgent || !callbackAgent.enabled || !this.deps.registry.accounts.get(callbackAgent.accountRef)) {
			this.callbackFailed(requestId, callback, "multi_mention_invalid_callback", now);
			return;
		}
		if (callbackDepth > MULTI_MENTION_MAX_CALLBACK_DEPTH) {
			this.callbackFailed(requestId, callback, "multi_mention_cascade", now);
			return;
		}
		if (a2aDepth > MAX_A2A_DEPTH) {
			this.callbackFailed(requestId, callback, "a2a_depth_exceeded", now);
			return;
		}
		const aggregate = this.deps.messages.get(callback.aggregateMessageId, { includeDeleted: true });
		if (!aggregate) {
			this.callbackFailed(requestId, callback, "aggregate_message_missing", now);
			return;
		}
		try {
			runInTransaction(this.deps.db, () => {
				const enqueued = this.deps.queue.enqueue(
					{
						threadId: request.threadId,
						sourceRecordId: callback.aggregateMessageId,
						messageId: callback.aggregateMessageId,
						attempt: 1,
						owner: { kind: "system", service: "multi_mention" },
						kind: "message_wake",
						from: { kind: "system", service: "multi_mention" },
						content: aggregate.content,
						targets: [{ kind: "agent", id: callback.callbackToAgentId }],
						priority: "normal",
						execution: {
							a2aParentTurnExecutionId: request.initiatorTurnExecutionId,
							a2aTriggerMessageId: callback.aggregateMessageId,
							a2aDepth,
							multiMentionRequestId: request.requestId,
							multiMentionCallbackDepth: callbackDepth,
						},
					},
					now,
				);
				if (enqueued.outcome === "conflict") throw new Error("queue_admission_conflict");
				if (!enqueued.entry) throw new Error("queue_admission_replayed");
				const updated = this.deps.store.updateCallback(requestId, {
					status: "queued",
					queueEntryId: enqueued.entry.queueEntryId,
					now,
				});
				if (updated.outcome !== "updated" && updated.outcome !== "already_terminal") {
					throw new Error("callback_state_conflict");
				}
			});
		} catch (error) {
			this.callbackFailed(requestId, callback, error instanceof Error ? error.message : "callback_failed", now);
		}
	}

	private callbackFailed(
		requestId: string,
		callback: NonNullable<ReturnType<MultiMentionStore["getCallback"]>>,
		reason: string,
		now: number,
	): void {
		const request = this.deps.store.get(requestId);
		if (!request) return;
		this.deps.store.updateCallback(requestId, { status: "failed", reason, now });
		this.deps.messages.append({
			id: `msg:${request.threadId}:${now}:cb-fail:${randomUUID().slice(0, 8)}`,
			threadId: request.threadId,
			from: { kind: "system", service: "multi_mention" },
			content: `multi_mention_callback_failed: ${reason}`,
			now,
		});
		void callback;
	}

	private buildAggregateBody(
		request: MultiMentionRequest,
		status: "done" | "timeout" | "failed",
		responses: MultiMentionResponse[],
	): string {
		const lines = ["## Multi-Mention 结果汇总", "", `Question: ${request.question}`];
		for (const response of responses) {
			const message = response.responseMessageId
				? this.deps.messages.get(response.responseMessageId, { includeDeleted: true })
				: null;
			const content = message?.content?.trim() ?? "";
			const pending = response.responseState === "pending" ? " (response pending)" : "";
			const reason = response.reason ? ` (${response.reason})` : "";
			lines.push(
				`- ${response.targetAgentId}: ${response.status}${pending}${reason}${content ? ` — ${content}` : ""}`,
			);
		}
		if (status === "timeout") lines.push("", "Status: timeout");
		if (status === "failed") lines.push("", "Status: failed");
		return lines.join("\n");
	}

	private initiatorCausal(request: MultiMentionRequest): {
		a2aDepth?: number;
		multiMentionCallbackDepth?: number;
	} {
		const row = this.deps.db
			.prepare("SELECT causal_json FROM turn_executions WHERE turn_execution_id = ?")
			.get(request.initiatorTurnExecutionId) as { causal_json: string } | undefined;
		if (!row) return {};
		try {
			return JSON.parse(row.causal_json) as {
				a2aDepth?: number;
				multiMentionCallbackDepth?: number;
			};
		} catch {
			return {};
		}
	}

	private backfillTerminalChildren(request: MultiMentionRequest, now: number): void {
		if (!request.parentInvocationId) return;
		for (const agentId of request.targetAgentIds) {
			if (this.deps.store.getResponse(request.requestId, agentId)) continue;
			const latest = this.deps.attempts.getLatest(request.parentInvocationId, agentId);
			if (!latest) continue;
			const child = latest.turnExecutionId ? this.deps.turns.get(latest.turnExecutionId) : null;
			if (child?.status === "completed") {
				this.deps.store.recordTargetOutcome({
					requestId: request.requestId,
					targetAgentId: agentId,
					turnExecutionId: child.turnExecutionId,
					responseMessageId: latest.responseMessageId,
					status: "received",
					responseState: "pending",
					now,
				});
			} else if (child && (child.status === "failed" || child.status === "interrupted" || child.status === "canceled")) {
				this.deps.store.recordTargetOutcome({
					requestId: request.requestId,
					targetAgentId: agentId,
					turnExecutionId: child.turnExecutionId,
					responseMessageId: latest.responseMessageId,
					status: "failed",
					responseState: "missing",
					reason: child.terminalReason ?? child.status,
					now,
				});
			} else if (
				!child &&
				(latest.deliveryState === "failed" ||
					latest.deliveryState === "interrupted" ||
					latest.deliveryState === "canceled")
			) {
				this.deps.store.recordTargetOutcome({
					requestId: request.requestId,
					targetAgentId: agentId,
					turnExecutionId: latest.turnExecutionId,
					responseMessageId: latest.responseMessageId,
					status: "failed",
					responseState: "missing",
					reason: latest.terminalReason ?? latest.deliveryState,
					now,
				});
			}
		}
	}
}
