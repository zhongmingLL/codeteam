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
	 * terminal response by acking over a placeholder).
	 */
	boundarySeq: number;
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
		const earliestProcessing = fetched.find(
			(message) => message.lifecycle?.kind === "response" && message.lifecycle.status === "processing",
		);
		if (earliestProcessing) {
			boundarySeq = Math.min(boundarySeq, earliestProcessing.seq - 1);
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
	for (const message of rows) {
		const line = `[seq ${message.seq}] ${renderSender(message)}: ${message.content}`;
		if (maxChars !== undefined && used + line.length > maxChars) break;
		lines.push(line);
		used += line.length + 1;
	}
	return lines.length > 0 ? `${header}\n${lines.join("\n")}\n` : `${header}\n(no messages)\n`;
}
