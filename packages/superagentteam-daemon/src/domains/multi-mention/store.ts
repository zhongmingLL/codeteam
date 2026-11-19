import type { DatabaseSync } from "node:sqlite";

import {
	isValidMultiMentionTransition,
	MULTI_MENTION_MAX_CALLBACK_DEPTH,
	MULTI_MENTION_MAX_TARGETS,
	MULTI_MENTION_MAX_TIMEOUT_MINUTES,
	MULTI_MENTION_MIN_TARGETS,
	MULTI_MENTION_MIN_TIMEOUT_MINUTES,
	MULTI_MENTION_TERMINAL_STATUSES,
	type MultiMentionCallback,
	type MultiMentionCallbackStatus,
	type MultiMentionRequest,
	type MultiMentionResponse,
	type MultiMentionResponseState,
	type MultiMentionStatus,
	type MultiMentionStatusView,
	type MultiMentionTargetStatus,
	type MultiMentionTriggerType,
} from "@superagentteam/shared/types";
import { runInTransaction } from "../../infrastructure/db/database.ts";

// F018 R3 MultiMentionStore (0007 §3.8): durable group lifecycle, per-target
// outcome pointers and one callback delivery per request. First-write-wins
// for target outcomes; terminal group/callback states are final.

interface RequestRow {
	request_id: string;
	thread_id: string;
	user_id: string;
	initiator_agent_id: string;
	initiator_turn_execution_id: string;
	callback_to_agent_id: string;
	question: string;
	context: string | null;
	target_agent_ids_json: string;
	status: MultiMentionStatus;
	timeout_minutes: number;
	expires_at: number;
	parent_invocation_id: string | null;
	source_record_id: string;
	aggregate_message_id: string | null;
	trigger_type: MultiMentionTriggerType | null;
	search_evidence_refs_json: string | null;
	override_reason: string | null;
	created_at: number;
	updated_at: number;
	ended_at: number | null;
}

interface ResponseRow {
	request_id: string;
	target_agent_id: string;
	turn_execution_id: string | null;
	response_message_id: string | null;
	status: MultiMentionTargetStatus;
	response_state: MultiMentionResponseState;
	reason: string | null;
	received_at: number | null;
}

interface CallbackRow {
	request_id: string;
	thread_id: string;
	callback_to_agent_id: string;
	aggregate_message_id: string;
	queue_entry_id: string | null;
	parent_invocation_id: string | null;
	turn_execution_id: string | null;
	callback_depth: 1 | 2;
	status: MultiMentionCallbackStatus;
	reason: string | null;
	created_at: number;
	updated_at: number;
	ended_at: number | null;
}

function mapRequest(row: RequestRow): MultiMentionRequest {
	return {
		requestId: row.request_id,
		threadId: row.thread_id,
		userId: row.user_id,
		initiatorAgentId: row.initiator_agent_id,
		initiatorTurnExecutionId: row.initiator_turn_execution_id,
		callbackToAgentId: row.callback_to_agent_id,
		question: row.question,
		context: row.context,
		targetAgentIds: JSON.parse(row.target_agent_ids_json) as string[],
		status: row.status,
		timeoutMinutes: row.timeout_minutes,
		expiresAt: row.expires_at,
		parentInvocationId: row.parent_invocation_id,
		sourceRecordId: row.source_record_id,
		aggregateMessageId: row.aggregate_message_id,
		triggerType: row.trigger_type,
		searchEvidenceRefs: row.search_evidence_refs_json
			? (JSON.parse(row.search_evidence_refs_json) as string[])
			: null,
		overrideReason: row.override_reason,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		endedAt: row.ended_at,
	};
}

function mapResponse(row: ResponseRow): MultiMentionResponse {
	return {
		requestId: row.request_id,
		targetAgentId: row.target_agent_id,
		turnExecutionId: row.turn_execution_id,
		responseMessageId: row.response_message_id,
		status: row.status,
		responseState: row.response_state,
		reason: row.reason,
		receivedAt: row.received_at,
	};
}

function mapCallback(row: CallbackRow): MultiMentionCallback {
	return {
		requestId: row.request_id,
		threadId: row.thread_id,
		callbackToAgentId: row.callback_to_agent_id,
		aggregateMessageId: row.aggregate_message_id,
		queueEntryId: row.queue_entry_id,
		parentInvocationId: row.parent_invocation_id,
		turnExecutionId: row.turn_execution_id,
		callbackDepth: row.callback_depth,
		status: row.status,
		reason: row.reason,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		endedAt: row.ended_at,
	};
}

function sameRequestIdentity(request: MultiMentionRequest, input: CreateMultiMentionRequestInput): boolean {
	const sameTargets =
		request.targetAgentIds.length === input.targetAgentIds.length &&
		[...request.targetAgentIds].sort().join("\u0000") === [...input.targetAgentIds].sort().join("\u0000");
	return (
		request.threadId === input.threadId &&
		request.userId === input.userId &&
		request.initiatorAgentId === input.initiatorAgentId &&
		request.initiatorTurnExecutionId === input.initiatorTurnExecutionId &&
		request.callbackToAgentId === input.callbackToAgentId &&
		request.question === input.question &&
		(request.context ?? null) === (input.context ?? null) &&
		request.timeoutMinutes === input.timeoutMinutes &&
		sameTargets
	);
}

export interface CreateMultiMentionRequestInput {
	requestId: string;
	threadId: string;
	userId: string;
	initiatorAgentId: string;
	initiatorTurnExecutionId: string;
	callbackToAgentId: string;
	question: string;
	context?: string | null;
	targetAgentIds: readonly string[];
	timeoutMinutes: number;
	parentInvocationId?: string | null;
	sourceRecordId: string;
	triggerType?: MultiMentionTriggerType | null;
	searchEvidenceRefs?: readonly string[] | null;
	overrideReason?: string | null;
	now: number;
}

export type CreateMultiMentionOutcome =
	| { outcome: "created"; request: MultiMentionRequest }
	| { outcome: "replayed"; request: MultiMentionRequest }
	| { outcome: "conflict"; request: MultiMentionRequest };

export interface RecordTargetOutcomeInput {
	requestId: string;
	targetAgentId: string;
	turnExecutionId?: string | null;
	responseMessageId?: string | null;
	status: MultiMentionTargetStatus;
	responseState?: MultiMentionResponseState;
	reason?: string | null;
	now: number;
}

export interface RecordTargetResponseInput {
	requestId: string;
	targetAgentId: string;
	responseMessageId: string | null;
	responseState: MultiMentionResponseState;
}

export interface CreateCallbackInput {
	requestId: string;
	threadId: string;
	callbackToAgentId: string;
	aggregateMessageId: string;
	callbackDepth: 1 | 2;
	now: number;
}

export interface UpdateCallbackInput {
	status: MultiMentionCallbackStatus;
	queueEntryId?: string | null;
	parentInvocationId?: string | null;
	turnExecutionId?: string | null;
	reason?: string | null;
	now: number;
}

export type CallbackOutcome =
	| {
			outcome: "updated" | "already_terminal" | "terminal_conflict" | "invalid_transition" | "not_found";
			callback: MultiMentionCallback | null;
	  }
	| { outcome: "created" | "replayed"; callback: MultiMentionCallback };

export type StatusOutcome = {
	outcome: "updated" | "already_terminal" | "terminal_conflict" | "invalid_transition" | "not_found";
	request: MultiMentionRequest | null;
};

/** SQLite-backed durable multi_mention store. */
export class MultiMentionStore {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	createRequest(input: CreateMultiMentionRequestInput): CreateMultiMentionOutcome {
		const targets = [...new Set(input.targetAgentIds)];
		if (targets.length < MULTI_MENTION_MIN_TARGETS || targets.length > MULTI_MENTION_MAX_TARGETS) {
			throw new Error("multi_mention_invalid_targets");
		}
		if (targets.includes(input.callbackToAgentId)) throw new Error("multi_mention_invalid_callback");
		if (
			!Number.isInteger(input.timeoutMinutes) ||
			input.timeoutMinutes < MULTI_MENTION_MIN_TIMEOUT_MINUTES ||
			input.timeoutMinutes > MULTI_MENTION_MAX_TIMEOUT_MINUTES
		) {
			throw new Error("multi_mention_invalid_timeout");
		}
		if (!input.question.trim()) throw new Error("multi_mention_question_empty");
		if (Buffer.byteLength(input.question, "utf8") > 5 * 1024) {
			throw new Error("multi_mention_question_too_large");
		}
		if (input.context && Buffer.byteLength(input.context, "utf8") > 5 * 1024) {
			throw new Error("multi_mention_context_too_large");
		}
		const existing = this.getBySourceRecordId(input.sourceRecordId);
		if (existing) {
			return sameRequestIdentity(existing, input)
				? { outcome: "replayed", request: existing }
				: { outcome: "conflict", request: existing };
		}
		const expiresAt = input.now + input.timeoutMinutes * 60_000;
		this.db
			.prepare(
				`INSERT INTO multi_mention_requests (
					request_id, thread_id, user_id, initiator_agent_id, initiator_turn_execution_id,
					callback_to_agent_id, question, context, target_agent_ids_json, status,
					timeout_minutes, expires_at, parent_invocation_id, source_record_id,
					trigger_type, search_evidence_refs_json, override_reason, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.requestId,
				input.threadId,
				input.userId,
				input.initiatorAgentId,
				input.initiatorTurnExecutionId,
				input.callbackToAgentId,
				input.question,
				input.context ?? null,
				JSON.stringify(targets),
				input.timeoutMinutes,
				expiresAt,
				input.parentInvocationId ?? null,
				input.sourceRecordId,
				input.triggerType ?? null,
				input.searchEvidenceRefs ? JSON.stringify([...input.searchEvidenceRefs]) : null,
				input.overrideReason ?? null,
				input.now,
				input.now,
			);
		return { outcome: "created", request: this.get(input.requestId)! };
	}

	get(requestId: string): MultiMentionRequest | null {
		const row = this.db.prepare("SELECT * FROM multi_mention_requests WHERE request_id = ?").get(requestId) as
			| RequestRow
			| undefined;
		return row ? mapRequest(row) : null;
	}

	getBySourceRecordId(sourceRecordId: string): MultiMentionRequest | null {
		const row = this.db
			.prepare("SELECT * FROM multi_mention_requests WHERE source_record_id = ?")
			.get(sourceRecordId) as RequestRow | undefined;
		return row ? mapRequest(row) : null;
	}

	setStatus(
		requestId: string,
		to: MultiMentionStatus,
		now: number,
		patch: { parentInvocationId?: string | null; aggregateMessageId?: string | null } = {},
	): StatusOutcome {
		const current = this.get(requestId);
		if (!current) return { outcome: "not_found", request: null };
		// same_status (also covers non-terminal idempotent no-op).
		if (current.status === to) return { outcome: "already_terminal", request: current };
		if (MULTI_MENTION_TERMINAL_STATUSES.has(current.status)) {
			return { outcome: "terminal_conflict", request: current };
		}
		if (!isValidMultiMentionTransition(current.status, to)) {
			return { outcome: "invalid_transition", request: current };
		}
		const endedAt = MULTI_MENTION_TERMINAL_STATUSES.has(to) ? now : null;
		const changes = this.db
			.prepare(
				`UPDATE multi_mention_requests
				 SET status = ?, updated_at = ?, ended_at = ?,
				     parent_invocation_id = COALESCE(?, parent_invocation_id),
				     aggregate_message_id = COALESCE(?, aggregate_message_id)
				 WHERE request_id = ? AND status = ?`,
			)
			.run(
				to,
				now,
				endedAt,
				patch.parentInvocationId ?? null,
				patch.aggregateMessageId ?? null,
				requestId,
				current.status,
			).changes;
		if (changes === 0) {
			const raced = this.get(requestId);
			return raced && raced.status === to
				? { outcome: "already_terminal", request: raced }
				: { outcome: "terminal_conflict", request: raced };
		}
		return { outcome: "updated", request: this.get(requestId) };
	}

	recordTargetOutcome(input: RecordTargetOutcomeInput): {
		outcome: "recorded" | "replayed";
		response: MultiMentionResponse;
	} {
		const request = this.get(input.requestId);
		if (!request) throw new Error("multi_mention_not_found");
		if (!request.targetAgentIds.includes(input.targetAgentId)) {
			throw new Error("multi_mention_target_not_found");
		}
		let result: { outcome: "recorded" | "replayed"; response: MultiMentionResponse } | null = null;
		runInTransaction(this.db, () => {
			const changes = this.db
				.prepare(
					`INSERT OR IGNORE INTO multi_mention_responses
					 (request_id, target_agent_id, turn_execution_id, response_message_id, status, response_state, reason, received_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					input.requestId,
					input.targetAgentId,
					input.turnExecutionId ?? null,
					input.responseMessageId ?? null,
					input.status,
					input.responseState ?? (input.status === "received" ? "pending" : "missing"),
					input.reason ?? null,
					input.now,
				).changes;
			const response = this.getResponse(input.requestId, input.targetAgentId);
			if (!response) throw new Error("multi_mention_response_missing");
			// Any recorded target outcome moves a running group to partial.
			const current = this.get(input.requestId);
			if (changes > 0 && current?.status === "running") {
				this.setStatus(input.requestId, "partial", input.now);
			}
			result = { outcome: changes > 0 ? "recorded" : "replayed", response };
		});
		return result!;
	}

	recordTargetResponse(input: RecordTargetResponseInput): boolean {
		const changes = this.db
			.prepare(
				`UPDATE multi_mention_responses SET response_message_id = ?, response_state = ?
				 WHERE request_id = ? AND target_agent_id = ? AND response_state <> 'terminal'`,
			)
			.run(input.responseMessageId, input.responseState, input.requestId, input.targetAgentId).changes;
		if (changes > 0) return true;
		// terminal is monotonic: a late/stale T4 must not downgrade it to missing.
		return this.getResponse(input.requestId, input.targetAgentId)?.responseState === "terminal";
	}

	/** T2: the R message is terminal; project response_state=terminal. */
	markResponseTerminalByMessage(responseMessageId: string): boolean {
		return (
			this.db
				.prepare(
					"UPDATE multi_mention_responses SET response_state = 'terminal' WHERE response_message_id = ? AND response_state <> 'terminal'",
				)
				.run(responseMessageId).changes > 0
		);
	}

	/** T4 response_missing: projection only; target status is unchanged. */
	markResponseMissingByTurn(turnExecutionId: string): boolean {
		return (
			this.db
				.prepare(
					"UPDATE multi_mention_responses SET response_state = 'missing' WHERE turn_execution_id = ? AND response_state <> 'terminal'",
				)
				.run(turnExecutionId).changes > 0
		);
	}

	getResponse(requestId: string, targetAgentId: string): MultiMentionResponse | null {
		const row = this.db
			.prepare("SELECT * FROM multi_mention_responses WHERE request_id = ? AND target_agent_id = ?")
			.get(requestId, targetAgentId) as ResponseRow | undefined;
		return row ? mapResponse(row) : null;
	}

	listResponses(requestId: string): MultiMentionResponse[] {
		const rows = this.db
			.prepare("SELECT * FROM multi_mention_responses WHERE request_id = ? ORDER BY target_agent_id")
			.all(requestId) as unknown as ResponseRow[];
		return rows.map(mapResponse);
	}

	allTargetsAccounted(requestId: string): boolean {
		const request = this.get(requestId);
		if (!request) return false;
		const count = (
			this.db.prepare("SELECT COUNT(*) AS n FROM multi_mention_responses WHERE request_id = ?").get(requestId) as {
				n: number;
			}
		).n;
		return count >= request.targetAgentIds.length;
	}

	createCallback(input: CreateCallbackInput): CallbackOutcome {
		if (input.callbackDepth < 1 || input.callbackDepth > MULTI_MENTION_MAX_CALLBACK_DEPTH) {
			throw new Error("multi_mention_cascade");
		}
		const request = this.get(input.requestId);
		if (!request) throw new Error("multi_mention_not_found");
		if (request.threadId !== input.threadId || request.callbackToAgentId !== input.callbackToAgentId) {
			throw new Error("multi_mention_callback_mismatch");
		}
		const aggregate = this.db
			.prepare("SELECT thread_id, deleted_at FROM messages WHERE id = ?")
			.get(input.aggregateMessageId) as { thread_id: string; deleted_at: number | null } | undefined;
		if (!aggregate || aggregate.thread_id !== input.threadId || aggregate.deleted_at !== null) {
			throw new Error("multi_mention_aggregate_invalid");
		}
		const existing = this.getCallback(input.requestId);
		if (existing) return { outcome: "replayed", callback: existing };
		this.db
			.prepare(
				`INSERT INTO multi_mention_callbacks
				 (request_id, thread_id, callback_to_agent_id, aggregate_message_id, callback_depth, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
			)
			.run(
				input.requestId,
				input.threadId,
				input.callbackToAgentId,
				input.aggregateMessageId,
				input.callbackDepth,
				input.now,
				input.now,
			);
		return { outcome: "created", callback: this.getCallback(input.requestId)! };
	}

	getCallback(requestId: string): MultiMentionCallback | null {
		const row = this.db.prepare("SELECT * FROM multi_mention_callbacks WHERE request_id = ?").get(requestId) as
			| CallbackRow
			| undefined;
		return row ? mapCallback(row) : null;
	}

	updateCallback(requestId: string, input: UpdateCallbackInput): CallbackOutcome {
		const current = this.getCallback(requestId);
		if (!current) return { outcome: "not_found", callback: null };
		// same_status (also covers non-terminal idempotent no-op).
		if (current.status === input.status) return { outcome: "already_terminal", callback: current };
		if (isCallbackTerminal(current.status)) {
			return { outcome: "terminal_conflict", callback: current };
		}
		if (!isValidCallbackTransition(current.status, input.status)) {
			return { outcome: "invalid_transition", callback: current };
		}
		const endedAt = isCallbackTerminal(input.status) ? input.now : null;
		const changes = this.db
			.prepare(
				`UPDATE multi_mention_callbacks
				 SET status = ?, updated_at = ?, ended_at = ?,
				     queue_entry_id = COALESCE(?, queue_entry_id),
				     parent_invocation_id = COALESCE(?, parent_invocation_id),
				     turn_execution_id = COALESCE(?, turn_execution_id),
				     reason = COALESCE(?, reason)
				 WHERE request_id = ? AND status = ?`,
			)
			.run(
				input.status,
				input.now,
				endedAt,
				input.queueEntryId ?? null,
				input.parentInvocationId ?? null,
				input.turnExecutionId ?? null,
				input.reason ?? null,
				requestId,
				current.status,
			).changes;
		if (changes === 0) {
			const raced = this.getCallback(requestId);
			return raced && raced.status === input.status
				? { outcome: "already_terminal", callback: raced }
				: { outcome: "terminal_conflict", callback: raced };
		}
		return { outcome: "updated", callback: this.getCallback(requestId) };
	}

	listPendingCallbacks(): MultiMentionCallback[] {
		const rows = this.db
			.prepare("SELECT * FROM multi_mention_callbacks WHERE status = 'pending' ORDER BY created_at")
			.all() as unknown as CallbackRow[];
		return rows.map(mapCallback);
	}

	listExpired(now: number): MultiMentionRequest[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM multi_mention_requests
				 WHERE status IN ('pending', 'running', 'partial') AND expires_at <= ?
				 ORDER BY expires_at, request_id`,
			)
			.all(now) as unknown as RequestRow[];
		return rows.map(mapRequest);
	}

	listUnfinished(): MultiMentionRequest[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM multi_mention_requests WHERE status IN ('pending', 'running', 'partial') ORDER BY created_at",
			)
			.all() as unknown as RequestRow[];
		return rows.map(mapRequest);
	}

	/** Anti-cascade (§3.8): is this agent a target of an active multi_mention? */
	isActiveTarget(agentId: string): boolean {
		const row = this.db
			.prepare(
				`SELECT 1 AS hit
				 FROM multi_mention_requests r, json_each(r.target_agent_ids_json) t
				 WHERE r.status IN ('pending', 'running', 'partial') AND t.value = ?
				 LIMIT 1`,
			)
			.get(agentId) as { hit: number } | undefined;
		return row !== undefined;
	}

	/** Sources created by a multi_mention request are looked up by message id. */

	statusView(requestId: string): MultiMentionStatusView | null {
		const request = this.get(requestId);
		if (!request) return null;
		const responses = this.listResponses(requestId);
		const allFailed = responses.every((response) => response.status !== "received");
		return { request, responses, allFailed, callback: this.getCallback(requestId) };
	}
}

function isCallbackTerminal(status: MultiMentionCallbackStatus): boolean {
	return status === "completed" || status === "failed" || status === "interrupted" || status === "canceled";
}

function isValidCallbackTransition(from: MultiMentionCallbackStatus, to: MultiMentionCallbackStatus): boolean {
	switch (from) {
		case "pending":
			return to === "queued" || to === "failed";
		case "queued":
			return to === "running" || to === "failed" || to === "canceled";
		case "running":
			return to === "completed" || to === "failed" || to === "interrupted" || to === "canceled";
		case "completed":
		case "failed":
		case "interrupted":
		case "canceled":
			return false;
	}
}
