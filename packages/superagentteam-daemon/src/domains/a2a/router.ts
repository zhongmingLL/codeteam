import type { DatabaseSync } from "node:sqlite";
import type { QueueEntry, StoredMessage } from "@superagentteam/shared/types";
import { runInTransaction } from "../../infrastructure/db/database.ts";
import { parseOperatorMentions } from "../agent/mentions.ts";
import type { AgentRegistry, ResolvedTarget } from "../agent/registry.ts";
import { resolveExplicitTarget } from "../agent/registry.ts";
import type { MessageStore } from "../message/store.ts";
import type { QueueLedgerStore } from "../queue/store.ts";
import type { ThreadStore } from "../thread/store.ts";

// F018 R2-a OperatorMessageIngress (0007 §3.0): operator-side A2A admission.
// Explicit @ anywhere in the body resolves via the registry mention index;
// no explicit mention falls back to the implicit 5-step chain. Message append
// and queue admission commit in ONE transaction (§3.0 step 4).

export type RoutingReason =
	| "current_message_mentions"
	| "previous_user_mentions"
	| "recent_replier"
	| "thread_participant"
	| "default_agent";

export type ResolveTargetsResult =
	| { kind: "ok"; targetAgentIds: string[]; reason: RoutingReason }
	| { kind: "no_target" }
	| { kind: "agent_disabled" | "agent_not_found"; pattern: string };

export interface OperatorMessageIngressDeps {
	db: DatabaseSync;
	registry: AgentRegistry;
	threads: ThreadStore;
	messages: MessageStore;
	queue: QueueLedgerStore;
}

export interface SubmitOperatorMessageInput {
	threadId: string;
	userId: string;
	body: string;
	messageId?: string;
	now: number;
}

export interface SubmitOperatorMessageResult {
	message: StoredMessage;
	queueEntry: QueueEntry;
	targetAgentIds: string[];
	reason: RoutingReason;
}

export class OperatorMessageIngress {
	private readonly db: DatabaseSync;
	private readonly registry: AgentRegistry;
	private readonly threads: ThreadStore;
	private readonly messages: MessageStore;
	private readonly queue: QueueLedgerStore;

	constructor(deps: OperatorMessageIngressDeps) {
		this.db = deps.db;
		this.registry = deps.registry;
		this.threads = deps.threads;
		this.messages = deps.messages;
		this.queue = deps.queue;
	}

	/**
	 * 0007 §3.0 step 3: implicit target chain — (1) last user message's
	 * targetAgentIds, (2) most recent successfully-responding agent, (3) first
	 * thread participant, (4) registry defaultAgentId, (5) no_target.
	 */
	resolveImplicitTargets(threadId: string): { agentId: string; reason: RoutingReason } | null {
		// (1) last user message with explicit targets
		const recent = this.messages.getByThread(threadId, 50);
		for (let i = recent.length - 1; i >= 0; i -= 1) {
			const message = recent[i]!;
			if (message.from.kind !== "user") continue;
			const targets = message.extra?.targetAgentIds;
			if (targets && targets.length > 0) return { agentId: targets[0]!, reason: "previous_user_mentions" };
			break; // only the LATEST user message carries the fallback
		}
		// (2) recent replier: last completed TurnExecution agent on the thread
		const replier = this.db
			.prepare(
				"SELECT agent_id FROM turn_executions WHERE thread_id = ? AND status = 'completed' ORDER BY ended_at DESC LIMIT 1",
			)
			.get(threadId) as { agent_id: string } | undefined;
		if (replier) return { agentId: replier.agent_id, reason: "recent_replier" };
		// (3) first participant by join order
		const participants = this.threads.listParticipants(threadId);
		if (participants.length > 0) return { agentId: participants[0]!, reason: "thread_participant" };
		// (4) registry default
		if (this.registry.defaultAgentId) {
			return { agentId: this.registry.defaultAgentId, reason: "default_agent" };
		}
		return null;
	}

	/** 0007 §3.0 steps 1-3: explicit mentions first, implicit chain fallback. */
	resolveTargets(threadId: string, body: string): ResolveTargetsResult {
		const patterns = parseOperatorMentions(body, [...this.registry.mentionIndex.keys()]);
		if (patterns.length > 0) {
			const agentIds: string[] = [];
			for (const pattern of patterns) {
				const resolved: ResolvedTarget = resolveExplicitTarget(this.registry, pattern);
				if (resolved.kind !== "ok") return { kind: resolved.kind, pattern: resolved.pattern };
				if (!agentIds.includes(resolved.agentId)) agentIds.push(resolved.agentId);
			}
			return { kind: "ok", targetAgentIds: agentIds, reason: "current_message_mentions" };
		}
		const implicit = this.resolveImplicitTargets(threadId);
		return implicit
			? { kind: "ok", targetAgentIds: [implicit.agentId], reason: implicit.reason }
			: { kind: "no_target" };
	}

	/**
	 * 0020 R2 gates + §3.0 step 4: deleted thread rejects post; targets must
	 * resolve non-empty (no_target typed reject); message + queue entry commit
	 * atomically — a queue_full rejection rolls the message back.
	 */
	submit(input: SubmitOperatorMessageInput): SubmitOperatorMessageResult {
		const thread = this.threads.get(input.threadId);
		if (!thread) throw new Error(`thread_not_found: ${input.threadId}`);
		if (thread.deletedAt !== null && thread.deletedAt !== undefined) {
			throw new Error(`thread_deleted: ${input.threadId}`);
		}
		const resolved = this.resolveTargets(input.threadId, input.body);
		if (resolved.kind === "no_target") throw new Error("no_target");
		if (resolved.kind !== "ok") throw new Error(`${resolved.kind}: ${resolved.pattern}`);
		const targetAgentIds = resolved.targetAgentIds;
		return runInTransaction(this.db, () => {
			const message = this.messages.append({
				id: input.messageId ?? `msg:${input.threadId}:${input.now}:${Math.random().toString(36).slice(2, 8)}`,
				threadId: input.threadId,
				from: { kind: "user", userId: input.userId },
				content: input.body,
				lifecycle: { kind: "input", dispatchRefs: [] },
				extra: { targetAgentIds },
				now: input.now,
			});
			const enqueued = this.queue.enqueue(
				{
					threadId: input.threadId,
					sourceRecordId: message.id,
					messageId: message.id,
					attempt: 1,
					owner: { kind: "user", userId: input.userId },
					kind: "conversation_input",
					from: { kind: "user", userId: input.userId },
					content: input.body,
					targets: targetAgentIds.map((agentId) => ({ kind: "agent", id: agentId })),
				},
				input.now,
			);
			if (enqueued.outcome === "conflict") throw new Error("queue_admission_conflict");
			if (enqueued.outcome === "replayed") throw new Error("queue_admission_replayed");
			return {
				message,
				queueEntry: enqueued.entry!,
				targetAgentIds,
				reason: resolved.reason,
			};
		});
	}
}
