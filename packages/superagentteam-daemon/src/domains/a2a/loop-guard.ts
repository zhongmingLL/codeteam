import type { DraftRecord, StoredMessage, StoredToolEvent } from "@superagentteam/shared/types";
import type { TurnExecutionStore } from "../invocation/store.ts";
import type { MessageStore } from "../message/store.ts";
import type { ResponseDraftStore } from "../response/store.ts";

// F018 R4-b loop guard (0007 §3.8, DP-F018SURFACE-2=A): durable A2A lineage
// rebuilt from turn_executions.causal. Same unordered pair counts short,
// non-substantive pushes: >=2 warn, >=4 block. A substantive tool call or a
// long output resets the streak to 1.

export const LOOP_GUARD_WARN_THRESHOLD = 2;
export const LOOP_GUARD_BLOCK_THRESHOLD = 4;
export const LOOP_GUARD_OUTPUT_LENGTH = 200;
const MAX_LINEAGE_SCAN = 256;

// Substring match is intentional: provider-prefixed names (mcp__...__post_message)
// must also count as routing/holding rather than substantive work.
const NON_SUBSTANTIVE_TOOL_PATTERNS = [
	"post_message",
	"cross_post_message",
	"multi_mention",
	"thread_context",
	"hold_ball",
];

export function isSubstantiveTool(toolName: string): boolean {
	if (!toolName) return false;
	return !NON_SUBSTANTIVE_TOOL_PATTERNS.some((pattern) => toolName.includes(pattern));
}

function hasSubstantiveTool(events: readonly unknown[] | undefined): boolean {
	return (events ?? []).some((event) => {
		const toolEvent = event as Partial<StoredToolEvent> & { name?: unknown };
		// Legacy StoredToolEvent shape (messages/tests).
		if (toolEvent.type === "tool_use") {
			return isSubstantiveTool(String(toolEvent.toolName ?? toolEvent.label ?? ""));
		}
		// F018 ResponseEventSink ToolEventRecord shape (draft + T2 messages):
		// { toolCallId, name, status, at } — no `type`/`label`.
		if (typeof toolEvent.name === "string") {
			return isSubstantiveTool(toolEvent.name);
		}
		return false;
	});
}

function messageActivity(message: StoredMessage | null): boolean {
	if (!message) return false;
	return hasSubstantiveTool(message.toolEvents) || message.content.length > LOOP_GUARD_OUTPUT_LENGTH;
}

function draftActivity(draft: DraftRecord | null): boolean {
	if (!draft) return false;
	return hasSubstantiveTool(draft.toolEvents) || draft.content.length > LOOP_GUARD_OUTPUT_LENGTH;
}

function samePair(a: { from: string; to: string }, from: string, to: string): boolean {
	return (a.from === from && a.to === to) || (a.from === to && a.to === from);
}

export interface LoopGuardCheck {
	callerTurnExecutionId: string;
	callerAgentId: string;
	targetAgentId: string;
}

export interface LoopGuardResult {
	count: number;
	warn: boolean;
	block: boolean;
}

export class LoopGuardService {
	private readonly turns: TurnExecutionStore;
	private readonly messages: MessageStore;
	private readonly drafts: ResponseDraftStore;

	constructor(deps: { turns: TurnExecutionStore; messages: MessageStore; drafts: ResponseDraftStore }) {
		this.turns = deps.turns;
		this.messages = deps.messages;
		this.drafts = deps.drafts;
	}

	checkPush(input: LoopGuardCheck): LoopGuardResult {
		const edges: Array<{ from: string; to: string; substantive: boolean }> = [];
		const visited = new Set<string>();
		let current = this.turns.get(input.callerTurnExecutionId);
		while (current && edges.length < MAX_LINEAGE_SCAN && !visited.has(current.turnExecutionId)) {
			visited.add(current.turnExecutionId);
			const parentId = current.causal.a2aParentTurnExecutionId;
			if (!parentId) break;
			const parent = this.turns.get(parentId);
			if (!parent) break;
			const triggerId = current.causal.a2aTriggerMessageId;
			const trigger = triggerId ? this.messages.get(triggerId, { includeDeleted: true }) : null;
			// Historical triggers are input messages (no toolEvents); their only
			// substantive signal is long content. Current-edge activity comes
			// from the live draft below.
			edges.push({ from: parent.agentId, to: current.agentId, substantive: messageActivity(trigger) });
			current = parent;
		}
		edges.reverse();
		edges.push({
			from: input.callerAgentId,
			to: input.targetAgentId,
			substantive: draftActivity(this.drafts.getByTurn(input.callerTurnExecutionId)),
		});

		let streak: { from: string; to: string; count: number } | undefined;
		for (const edge of edges) {
			const same = streak ? samePair(streak, edge.from, edge.to) : false;
			const count = same && !edge.substantive ? streak!.count + 1 : 1;
			streak = { from: edge.from, to: edge.to, count };
		}
		const count = streak?.count ?? 0;
		return {
			count,
			warn: count >= LOOP_GUARD_WARN_THRESHOLD && count < LOOP_GUARD_BLOCK_THRESHOLD,
			block: count >= LOOP_GUARD_BLOCK_THRESHOLD,
		};
	}
}
