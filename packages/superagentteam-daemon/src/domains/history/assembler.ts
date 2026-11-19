import type { StoredMessage, Thread } from "@superagentteam/shared/types";

import type { AgentReadStateStore, MessageStore } from "../message/store.ts";

// F018 R2-0 HistoryAssembler + buildThreadPrompt (0007 §3.5.1 / 0020 R2):
// per-(thread, agent) delivery-cursor windowed history with visibility
// filtering. loadHistory NEVER acks — ack happens in the T1 child-terminal
// transaction only when the prompt was actually delivered (0010 §6.1.1).

/** Default per-turn consumption window (0007 §3.5.1 bootstrap window). */
export const BOOTSTRAP_WINDOW = 200;

export interface HistoryWindow {
	mode: "bootstrap" | "incremental";
	/** Visible rows only (post-filter), ascending seq. */
	rows: StoredMessage[];
	/**
	 * Consumed boundary: the last seq of the FETCHED window, including rows
	 * filtered out by visibility, but never past the earliest processing
	 * response (0007 §3.5.1: a parallel agent must not skip the final
	 * terminal response by acking over a placeholder). Soft-deleted tail
	 * messages are outside the fetch surface, so the boundary naturally
	 * stops at the last visible seq.
	 */
	boundarySeq: number;
	/**
	 * 0010 §6: optional resume-degradation marker (e.g. "fresh" after
	 * consecutive resume failures). The assembler never sets it; the
	 * AgentSessionManager layer (R2-b) populates it when this turn's
	 * context came from a fresh/reset session instead of a resumed one.
	 */
	degraded?: string;
}

export interface HistoryAssemblerDeps {
	messages: MessageStore;
	readState: AgentReadStateStore;
}

/** 0007 §3.5.1 visibility rules for one message against one agent. */
export function visibleTo(message: StoredMessage, agentId: string): boolean {
	const lifecycle = message.lifecycle;
	if (lifecycle?.kind === "response") {
		// Responses broadcast; the author's own just-written response is
		// excluded so an agent does not re-read its own output.
		return !(message.from.kind === "agent" && message.from.agentId === agentId);
	}
	// Input (with or without lifecycle) and delivery_failure/system records:
	// targeted messages only reach their targets; everything else broadcasts.
	const targeted = message.extra?.targetAgentIds;
	if (targeted && targeted.length > 0) {
		return targeted.includes(agentId);
	}
	if (lifecycle?.kind === "input") {
		const refTargets = lifecycle.dispatchRefs.map((ref) => ref.target).filter((target) => target.kind === "agent");
		if (refTargets.length > 0) {
			return refTargets.some((target) => target.id === agentId);
		}
	}
	return true;
}

export class HistoryAssembler {
	private readonly messages: MessageStore;
	private readonly readState: AgentReadStateStore;

	constructor(deps: HistoryAssemblerDeps) {
		this.messages = deps.messages;
		this.readState = deps.readState;
	}

	/**
	 * Loads the next window for (threadId, agentId). Bootstrap when no read
	 * state exists yet; otherwise strictly after the delivery cursor. Does
	 * not write the cursor — the caller acks in the T1 transaction.
	 */
	loadHistory(threadId: string, agentId: string, windowSize = BOOTSTRAP_WINDOW): HistoryWindow {
		const cursor = this.readState.get(threadId, agentId)?.deliveryCursor;
		const fetched =
			cursor === undefined
				? this.messages.getByThread(threadId, windowSize)
				: this.messages.getByThreadAfter(threadId, cursor, windowSize);
		const lastFetchedSeq = fetched.length > 0 ? fetched[fetched.length - 1]!.seq : (cursor ?? 0);
		let boundarySeq = lastFetchedSeq;
		// Boundary cap (0007 §3.5.1): query the earliest processing response
		// INDEPENDENTLY of the fetched window — the bootstrap window takes the
		// LAST N visible rows, so a placeholder below the window start would
		// otherwise be silently crossed (review P1). The scan scope matches
		// the fetch scope (whole thread for bootstrap, seq > cursor for
		// incremental), so an already-consumed below-cursor placeholder does
		// not over-block.
		const earliestProcessingSeq = this.messages.getEarliestProcessingSeq(threadId, cursor ?? 0);
		if (earliestProcessingSeq !== null) {
			boundarySeq = Math.min(boundarySeq, earliestProcessingSeq - 1);
		}
		return {
			mode: cursor === undefined ? "bootstrap" : "incremental",
			rows: fetched.filter((message) => visibleTo(message, agentId)),
			boundarySeq,
		};
	}
}

export interface BuildThreadPromptInput {
	thread: Thread;
	/** Participant agent ids (routing/context membership, not ACL). */
	participants: readonly string[];
	rows: readonly StoredMessage[];
	selfAgentId: string;
	/** Approximate character budget for the rendered body (token trim). */
	maxChars?: number;
}

function renderSender(message: StoredMessage): string {
	if (message.from.kind === "user") return `user:${message.from.userId}`;
	if (message.from.kind === "agent") return `agent:${message.from.agentId}`;
	return `system:${message.from.service}`;
}

/**
 * 0020 R2: buildThreadPrompt — thread/participants/recent messages for the
 * agent's prompt. Contract: no task-first scaffolding ("# Task" heading);
 * token trimming only affects the rendered prompt, never the assembler's
 * boundary (boundary is decided in loadHistory).
 */
export function buildThreadPrompt(input: BuildThreadPromptInput): string {
	const { thread, participants, rows, selfAgentId, maxChars } = input;
	const header = [
		`# Thread: ${thread.title ?? thread.id}`,
		`Project: ${thread.projectPath}`,
		`Participants: ${participants.map((id) => `@${id}`).join(", ")}`,
		`You are @${selfAgentId}.`,
		"",
		"## Recent messages",
	].join("\n");
	const lines: string[] = [];
	let used = header.length;
	let truncated = false;
	for (const message of rows) {
		const line = `[seq ${message.seq}] ${renderSender(message)}: ${message.content}`;
		if (maxChars !== undefined && used + line.length > maxChars) {
			truncated = true;
			break;
		}
		lines.push(line);
		used += line.length + 1;
	}
	const body = lines.length > 0 ? lines.join("\n") : "(no messages)";
	const tail = truncated ? `\n…(truncated; older messages omitted by prompt budget)` : "";
	return `${header}\n${body}${tail}\n`;
}
