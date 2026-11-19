import type { DatabaseSync } from "node:sqlite";

import type {
	InvocationAttempt,
	InvocationAttemptDeliveryState,
	InvocationRecord,
	InvocationRecordStatus,
	TurnExecution,
	TurnExecutionStatus,
} from "@superagentteam/shared/types";

// F018 R1-b invocation stores (0007 §3.2/§3.3/§3.6, 0016 §4). Fresh
// implementations against the accepted contracts; task-first legacy code was
// not used as a skeleton.

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

// ------------------------------------------------------------ records (§3.2)

interface RecordRow {
	invocation_id: string;
	thread_id: string;
	user_id: string;
	source_record_id: string;
	user_message_id: string | null;
	target_agent_ids_json: string;
	status: InvocationRecordStatus;
	successful_agent_ids_json: string;
	usage_by_agent_json: string;
	usage_recorded_at: number | null;
	retry_count: number;
	terminal_reason: string | null;
	created_at: number;
	started_at: number | null;
	ended_at: number | null;
}

function mapRecord(row: RecordRow): InvocationRecord {
	return {
		invocationId: row.invocation_id,
		threadId: row.thread_id,
		userId: row.user_id,
		sourceRecordId: row.source_record_id,
		userMessageId: row.user_message_id,
		targetAgentIds: JSON.parse(row.target_agent_ids_json) as string[],
		status: row.status,
		successfulAgentIds: JSON.parse(row.successful_agent_ids_json) as string[],
		usageByAgent: JSON.parse(row.usage_by_agent_json) as Record<string, unknown>,
		usageRecordedAt: row.usage_recorded_at,
		retryCount: row.retry_count,
		terminalReason: row.terminal_reason,
		createdAt: row.created_at,
		startedAt: row.started_at,
		endedAt: row.ended_at,
	};
}

export type TerminalStatus = Exclude<InvocationRecordStatus, "queued" | "running">;

export interface CreateInvocationRecordInput {
	invocationId: string;
	threadId: string;
	userId: string;
	sourceRecordId: string;
	userMessageId: string | null;
	targetAgentIds: string[];
	now: number;
}

export class InvocationRecordStore {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/**
	 * Three-state create (0011 §11 + R-01): owner must match thread owner;
	 * replay compares immutable inputs; drift fails closed.
	 */
	create(input: CreateInvocationRecordInput): {
		outcome: "created" | "replayed" | "conflict";
		record: InvocationRecord;
	} {
		const thread = this.db.prepare("SELECT created_by FROM threads WHERE id = ?").get(input.threadId) as
			| { created_by: string }
			| undefined;
		if (!thread) throw new Error("invocation_thread_not_found");
		if (thread.created_by !== input.userId) throw new Error("invocation_owner_not_thread_owner");
		const existing = this.byThreadSource(input.threadId, input.sourceRecordId);
		if (existing) {
			const sameIdentity =
				existing.userId === input.userId &&
				existing.targetAgentIds.join("\u0000") === input.targetAgentIds.join("\u0000") &&
				(existing.userMessageId ?? null) === (input.userMessageId ?? null);
			if (!sameIdentity) return { outcome: "conflict", record: existing };
			return { outcome: "replayed", record: existing };
		}
		if (input.targetAgentIds.length === 0) throw new Error("invocation_targets_empty");
		this.db
			.prepare(
				`INSERT INTO invocation_records (invocation_id, thread_id, user_id, source_record_id, user_message_id, target_agent_ids_json, status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
			)
			.run(
				input.invocationId,
				input.threadId,
				input.userId,
				input.sourceRecordId,
				input.userMessageId,
				JSON.stringify(input.targetAgentIds),
				input.now,
			);
		return { outcome: "created", record: this.byThreadSource(input.threadId, input.sourceRecordId)! };
	}

	get(invocationId: string): InvocationRecord | null {
		const row = this.db.prepare("SELECT * FROM invocation_records WHERE invocation_id = ?").get(invocationId) as
			| RecordRow
			| undefined;
		return row ? mapRecord(row) : null;
	}

	byThreadSource(threadId: string, sourceRecordId: string): InvocationRecord | null {
		const row = this.db
			.prepare("SELECT * FROM invocation_records WHERE thread_id = ? AND source_record_id = ?")
			.get(threadId, sourceRecordId) as RecordRow | undefined;
		return row ? mapRecord(row) : null;
	}

	/**
	 * Claim-time status flip (G-02). Idempotent on running (returns the
	 * record); terminal or missing returns null so callers distinguish
	 * replay from failure.
	 */
	markRunning(invocationId: string, now: number): InvocationRecord | null {
		const current = this.get(invocationId);
		if (!current) return null;
		if (current.status === "running") return current;
		if (current.status !== "queued") return null;
		this.db
			.prepare(
				"UPDATE invocation_records SET status = 'running', started_at = COALESCE(started_at, ?) WHERE invocation_id = ? AND status = 'queued'",
			)
			.run(now, invocationId);
		return this.get(invocationId);
	}

	/** Monotonic union of successful agents (§3.9 aggregate rule). */
	addSuccessfulAgents(invocationId: string, agentIds: string[]): void {
		const row = this.get(invocationId);
		if (!row) return;
		const merged = [...new Set([...row.successfulAgentIds, ...agentIds])];
		if (merged.length === row.successfulAgentIds.length) return;
		this.db
			.prepare("UPDATE invocation_records SET successful_agent_ids_json = ? WHERE invocation_id = ?")
			.run(JSON.stringify(merged), invocationId);
	}

	setTerminal(invocationId: string, status: TerminalStatus, terminalReason: string | null, now: number): boolean {
		if (status !== "completed" && status !== "canceled" && !terminalReason) {
			throw new Error("invocation_terminal_reason_required");
		}
		const current = this.get(invocationId);
		if (!current) return false;
		// §5.1: queued → canceled only; every other terminal comes from running.
		if (current.status === "queued" && status !== "canceled") {
			throw new Error(`invocation_illegal_terminal_transition: queued -> ${status}`);
		}
		if (current.status !== "queued" && current.status !== "running") return false;
		return (
			this.db
				.prepare(
					"UPDATE invocation_records SET status = ?, terminal_reason = ?, ended_at = ? WHERE invocation_id = ? AND status IN ('queued', 'running')",
				)
				.run(status, status === "completed" ? null : terminalReason, now, invocationId).changes > 0
		);
	}

	/**
	 * T3 aggregate write (0007 §3.9): only queued|running parents;
	 * successfulAgentIds ⊆ targetAgentIds and monotonic; usage bucket first
	 * write only (usageRecordedAt stable).
	 */
	applyTerminalAggregate(input: {
		invocationId: string;
		status: TerminalStatus;
		successfulAgentIds: string[];
		terminalReason: string | null;
		usageByAgent?: Record<string, unknown>;
		now: number;
	}): boolean {
		const row = this.get(input.invocationId);
		if (!row) throw new Error("invocation_not_found");
		if (row.status !== "queued" && row.status !== "running") return false;
		// §5.1: queued → canceled only; every other terminal comes from running.
		if (row.status === "queued" && input.status !== "canceled") {
			throw new Error(`invocation_illegal_terminal_transition: queued -> ${input.status}`);
		}
		const outside = input.successfulAgentIds.filter((a) => !row.targetAgentIds.includes(a));
		if (outside.length > 0) throw new Error("invocation_successful_outside_targets");
		if (input.status !== "completed" && input.status !== "canceled" && !input.terminalReason) {
			throw new Error("invocation_terminal_reason_required");
		}
		const merged = [...new Set([...row.successfulAgentIds, ...input.successfulAgentIds])];
		const usage = row.usageRecordedAt === null && input.usageByAgent ? JSON.stringify(input.usageByAgent) : null;
		this.db
			.prepare(
				"UPDATE invocation_records SET status = ?, successful_agent_ids_json = ?, terminal_reason = ?, ended_at = ?, usage_by_agent_json = COALESCE(?, usage_by_agent_json), usage_recorded_at = COALESCE(usage_recorded_at, ?) WHERE invocation_id = ?",
			)
			.run(
				input.status,
				JSON.stringify(merged),
				input.status === "completed" ? null : input.terminalReason,
				input.now,
				usage,
				input.usageByAgent ? input.now : null,
				input.invocationId,
			);
		return true;
	}

	/** requestRetry store-side state flip only (§3.9 API boundary). */
	admitRetry(invocationId: string): boolean {
		return (
			this.db
				.prepare(
					"UPDATE invocation_records SET status = 'queued', retry_count = retry_count + 1, ended_at = NULL, terminal_reason = NULL WHERE invocation_id = ? AND status IN ('failed', 'partial_failed')",
				)
				.run(invocationId).changes > 0
		);
	}
}

// -------------------------------------------------------- turns (§3.6/§4.3)

interface TurnRow {
	turn_execution_id: string;
	parent_invocation_id: string;
	thread_id: string;
	user_id: string;
	agent_id: string;
	execution_kind: "ordinary" | "routing_guard";
	causal_json: string;
	status: TurnExecutionStatus;
	terminal_reason: string | null;
	started_at: number;
	ended_at: number | null;
}

function mapTurn(row: TurnRow): TurnExecution {
	return {
		turnExecutionId: row.turn_execution_id,
		parentInvocationId: row.parent_invocation_id,
		threadId: row.thread_id,
		userId: row.user_id,
		agentId: row.agent_id,
		executionKind: row.execution_kind,
		causal: JSON.parse(row.causal_json) as TurnExecution["causal"],
		status: row.status,
		terminalReason: row.terminal_reason,
		startedAt: row.started_at,
		endedAt: row.ended_at,
	};
}

export interface CreateTurnExecutionInput {
	turnExecutionId: string;
	parentInvocationId: string;
	threadId: string;
	userId: string;
	agentId: string;
	executionKind: "ordinary" | "routing_guard";
	causal: TurnExecution["causal"];
	startedAt: number;
}

export type CreateTurnOutcome = "created" | "replayed" | "conflict";

export interface CreateTurnExecutionResult {
	outcome: CreateTurnOutcome;
	record: TurnExecution;
}

export interface TurnTerminalInput {
	status: Exclude<TurnExecutionStatus, "running">;
	endedAt: number;
	terminalReason?: string | null;
}

export class TurnExecutionStore {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/**
	 * Provider 前幂等入口（§3.6）：identity = 全字段（startedAt 不进 identity）。
	 * replayed 不授予第二次 provider lease；identity 不同 = conflict。
	 */
	createRunning(input: CreateTurnExecutionInput): CreateTurnExecutionResult {
		// Ownership (0011 §11): userId must equal the parent/thread owner and
		// threadId must equal the parent's thread; agentId must be a target.
		const parent = this.db
			.prepare("SELECT thread_id, user_id, target_agent_ids_json FROM invocation_records WHERE invocation_id = ?")
			.get(input.parentInvocationId) as
			| { thread_id: string; user_id: string; target_agent_ids_json: string }
			| undefined;
		if (!parent) throw new Error("turn_parent_not_found");
		if (parent.thread_id !== input.threadId) throw new Error("turn_thread_not_parent_thread");
		if (parent.user_id !== input.userId) throw new Error("turn_user_not_parent_owner");
		const parentTargets = JSON.parse(parent.target_agent_ids_json) as string[];
		if (!parentTargets.includes(input.agentId)) throw new Error("turn_agent_not_parent_target");
		const existing = this.get(input.turnExecutionId);
		if (existing) {
			const sameIdentity =
				existing.parentInvocationId === input.parentInvocationId &&
				existing.threadId === input.threadId &&
				existing.userId === input.userId &&
				existing.agentId === input.agentId &&
				existing.executionKind === input.executionKind &&
				canonicalJson(existing.causal) === canonicalJson(input.causal);
			if (!sameIdentity) throw new Error("turn_identity_conflict");
			return { outcome: "replayed", record: existing };
		}
		this.db
			.prepare(
				`INSERT INTO turn_executions (turn_execution_id, parent_invocation_id, thread_id, user_id, agent_id, execution_kind, causal_json, status, started_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
			)
			.run(
				input.turnExecutionId,
				input.parentInvocationId,
				input.threadId,
				input.userId,
				input.agentId,
				input.executionKind,
				JSON.stringify(input.causal),
				input.startedAt,
			);
		return { outcome: "created", record: this.get(input.turnExecutionId)! };
	}

	get(turnExecutionId: string): TurnExecution | null {
		const row = this.db.prepare("SELECT * FROM turn_executions WHERE turn_execution_id = ?").get(turnExecutionId) as
			| TurnRow
			| undefined;
		return row ? mapTurn(row) : null;
	}

	listByInvocation(invocationId: string): TurnExecution[] {
		const rows = this.db
			.prepare("SELECT * FROM turn_executions WHERE parent_invocation_id = ?")
			.all(invocationId) as unknown as TurnRow[];
		return rows.map(mapTurn);
	}

	listRunning(): TurnExecution[] {
		const rows = this.db
			.prepare("SELECT * FROM turn_executions WHERE status = 'running'")
			.all() as unknown as TurnRow[];
		return rows.map(mapTurn);
	}

	/** Terminal first-write-wins; same status idempotent, different = conflict. */
	transitionTerminal(
		turnExecutionId: string,
		input: TurnTerminalInput,
	): { outcome: "transitioned" | "already_terminal" | "conflict" | "not_found" } {
		const row = this.get(turnExecutionId);
		if (!row) return { outcome: "not_found" };
		if (row.status !== "running") {
			return row.status === input.status ? { outcome: "already_terminal" } : { outcome: "conflict" };
		}
		if (input.status !== "completed" && !input.terminalReason) {
			throw new Error("turn_terminal_reason_required");
		}
		if (input.endedAt < row.startedAt) throw new Error("turn_ended_before_started");
		const changes = this.db
			.prepare(
				"UPDATE turn_executions SET status = ?, terminal_reason = ?, ended_at = ? WHERE turn_execution_id = ? AND status = 'running'",
			)
			.run(
				input.status,
				input.status === "completed" ? null : (input.terminalReason ?? null),
				input.endedAt,
				turnExecutionId,
			).changes;
		return changes > 0 ? { outcome: "transitioned" } : { outcome: "conflict" };
	}

	/** Startup-only cutoff convergence (§3.10.1). */
	interruptRunningBefore(
		cutoffStartedAt: number,
		input: { endedAt: number; terminalReason: string; excludedTurnExecutionIds?: readonly string[] },
	): TurnExecution[] {
		const excluded = new Set(input.excludedTurnExecutionIds ?? []);
		const rows = this.db
			.prepare("SELECT * FROM turn_executions WHERE status = 'running' AND started_at < ?")
			.all(cutoffStartedAt) as unknown as TurnRow[];
		const converged: TurnExecution[] = [];
		for (const row of rows) {
			if (excluded.has(row.turn_execution_id)) continue;
			this.db
				.prepare(
					"UPDATE turn_executions SET status = 'interrupted', terminal_reason = ?, ended_at = ? WHERE turn_execution_id = ? AND status = 'running'",
				)
				.run(input.terminalReason, input.endedAt, row.turn_execution_id).changes;
			if (row.status === "running") converged.push(this.get(row.turn_execution_id)!);
		}
		return converged;
	}

	/** attempt settlement projection (0007 §3.6): join over attempts. */
	listResponsePending(): TurnExecution[] {
		const rows = this.db
			.prepare(
				`SELECT t.* FROM turn_executions t JOIN invocation_attempts a ON a.turn_execution_id = t.turn_execution_id
				 WHERE a.settlement = 'response_pending'`,
			)
			.all() as unknown as TurnRow[];
		return rows.map(mapTurn);
	}

	clearResponsePending(turnExecutionId: string): {
		outcome: "settled" | "already_settled" | "not_pending" | "not_found";
	} {
		const changes = this.db
			.prepare(
				"UPDATE invocation_attempts SET settlement = 'settled' WHERE turn_execution_id = ? AND settlement = 'response_pending'",
			)
			.run(turnExecutionId).changes;
		if (changes > 0) return { outcome: "settled" };
		const row = this.db
			.prepare("SELECT settlement FROM invocation_attempts WHERE turn_execution_id = ?")
			.get(turnExecutionId) as { settlement: string | null } | undefined;
		if (!row) return { outcome: "not_found" };
		return row.settlement === null ? { outcome: "not_pending" } : { outcome: "already_settled" };
	}
}

// ------------------------------------------------------ attempts (§4.3.1)

interface AttemptRow {
	attempt_id: string;
	parent_invocation_id: string;
	queue_entry_id: string;
	thread_id: string;
	target_agent_id: string;
	attempt: number;
	turn_execution_id: string | null;
	delivery_state: InvocationAttemptDeliveryState;
	terminal_reason: string | null;
	agent_session_id: string | null;
	worker_id: string | null;
	provider: string | null;
	model: string | null;
	model_family: string | null;
	usage_json: string | null;
	settlement: "streaming" | "response_pending" | "settled" | null;
	response_message_id: string | null;
	delivery_boundary_seq: number | null;
	prompt_delivered_at: number | null;
	created_at: number;
	started_at: number | null;
	ended_at: number | null;
}

function mapAttempt(row: AttemptRow): InvocationAttempt {
	return {
		attemptId: row.attempt_id,
		parentInvocationId: row.parent_invocation_id,
		queueEntryId: row.queue_entry_id,
		threadId: row.thread_id,
		targetAgentId: row.target_agent_id,
		attempt: row.attempt,
		turnExecutionId: row.turn_execution_id,
		deliveryState: row.delivery_state,
		terminalReason: row.terminal_reason,
		agentSessionId: row.agent_session_id,
		workerId: row.worker_id,
		provider: row.provider,
		model: row.model,
		modelFamily: row.model_family,
		usage: row.usage_json ? (JSON.parse(row.usage_json) as Record<string, unknown>) : null,
		settlement: row.settlement,
		responseMessageId: row.response_message_id,
		deliveryBoundarySeq: row.delivery_boundary_seq,
		promptDeliveredAt: row.prompt_delivered_at,
		createdAt: row.created_at,
		startedAt: row.started_at,
		endedAt: row.ended_at,
	};
}

export interface AppendAttemptInput {
	attemptId: string;
	parentInvocationId: string;
	queueEntryId: string;
	threadId: string;
	targetAgentId: string;
	attempt: number;
	now: number;
}

export class InvocationAttemptStore {
	private readonly db: DatabaseSync;
	private readonly turns: TurnExecutionStore;

	constructor(db: DatabaseSync, turns?: TurnExecutionStore) {
		this.db = db;
		this.turns = turns ?? new TurnExecutionStore(db);
	}

	/** Append-only ledger row; (parent, target, attempt) idempotent-create / conflict. */
	appendQueued(input: AppendAttemptInput): {
		outcome: "created" | "replayed" | "conflict";
		record: InvocationAttempt;
	} {
		// Parent alignment (0007 §4.3.1): thread and target must match the
		// parent record's admission snapshot.
		const parent = this.db
			.prepare("SELECT thread_id, target_agent_ids_json FROM invocation_records WHERE invocation_id = ?")
			.get(input.parentInvocationId) as { thread_id: string; target_agent_ids_json: string } | undefined;
		if (!parent) throw new Error("attempt_parent_not_found");
		if (parent.thread_id !== input.threadId) throw new Error("attempt_thread_not_parent_thread");
		const parentTargets = JSON.parse(parent.target_agent_ids_json) as string[];
		if (!parentTargets.includes(input.targetAgentId)) throw new Error("attempt_target_not_parent_target");
		const existing = this.db
			.prepare(
				"SELECT * FROM invocation_attempts WHERE parent_invocation_id = ? AND target_agent_id = ? AND attempt = ?",
			)
			.get(input.parentInvocationId, input.targetAgentId, input.attempt) as AttemptRow | undefined;
		if (existing) {
			return existing.queue_entry_id === input.queueEntryId
				? { outcome: "replayed", record: mapAttempt(existing) }
				: { outcome: "conflict", record: mapAttempt(existing) };
		}
		this.db
			.prepare(
				`INSERT INTO invocation_attempts (attempt_id, parent_invocation_id, queue_entry_id, thread_id, target_agent_id, attempt, delivery_state, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
			)
			.run(
				input.attemptId,
				input.parentInvocationId,
				input.queueEntryId,
				input.threadId,
				input.targetAgentId,
				input.attempt,
				input.now,
			);
		return {
			outcome: "created",
			record: mapAttempt(
				this.db
					.prepare("SELECT * FROM invocation_attempts WHERE attempt_id = ?")
					.get(input.attemptId) as unknown as AttemptRow,
			),
		};
	}

	get(attemptId: string): InvocationAttempt | null {
		const row = this.db.prepare("SELECT * FROM invocation_attempts WHERE attempt_id = ?").get(attemptId) as
			| AttemptRow
			| undefined;
		return row ? mapAttempt(row) : null;
	}

	getByTurnExecutionId(turnExecutionId: string): InvocationAttempt | null {
		const row = this.db
			.prepare("SELECT * FROM invocation_attempts WHERE turn_execution_id = ?")
			.get(turnExecutionId) as AttemptRow | undefined;
		return row ? mapAttempt(row) : null;
	}

	getLatest(invocationId: string, targetAgentId: string): InvocationAttempt | null {
		const row = this.db
			.prepare(
				"SELECT * FROM invocation_attempts WHERE parent_invocation_id = ? AND target_agent_id = ? ORDER BY attempt DESC LIMIT 1",
			)
			.get(invocationId, targetAgentId) as AttemptRow | undefined;
		return row ? mapAttempt(row) : null;
	}

	listByInvocation(invocationId: string): InvocationAttempt[] {
		const rows = this.db
			.prepare("SELECT * FROM invocation_attempts WHERE parent_invocation_id = ? ORDER BY target_agent_id, attempt")
			.all(invocationId) as unknown as AttemptRow[];
		return rows.map(mapAttempt);
	}

	/** queued→starting only; Phase A reservation (0016 T1a). */
	markStarting(attemptId: string, input: { agentSessionId: string; now: number }): InvocationAttempt | null {
		const current = this.get(attemptId);
		if (!current) return null;
		if (current.deliveryState === "starting") {
			if (current.agentSessionId !== input.agentSessionId) {
				throw new Error("attempt_starting_session_conflict");
			}
			return current;
		}
		if (current.deliveryState !== "queued") return current;
		this.db
			.prepare(
				"UPDATE invocation_attempts SET delivery_state = 'starting', agent_session_id = ?, started_at = ? WHERE attempt_id = ? AND delivery_state = 'queued'",
			)
			.run(input.agentSessionId, input.now, attemptId);
		return this.get(attemptId);
	}

	/** starting→appended; writes execution binding snapshot (§4.3.1). */
	bindAppended(
		attemptId: string,
		input: {
			turnExecutionId: string;
			agentSessionId: string;
			workerId: string | null;
			provider: string;
			model: string;
			modelFamily: string;
			responseMessageId: string;
			now: number;
		},
	): InvocationAttempt | null {
		const current = this.get(attemptId);
		if (!current) return null;
		if (current.deliveryState === "appended") {
			// Idempotent re-bind: FULL binding identity must match; any drift
			// (session/provider/model/family too) fails closed.
			if (
				current.turnExecutionId !== input.turnExecutionId ||
				current.responseMessageId !== input.responseMessageId ||
				current.agentSessionId !== input.agentSessionId ||
				current.provider !== input.provider ||
				current.model !== input.model ||
				current.modelFamily !== input.modelFamily
			) {
				throw new Error("attempt_rebind_conflict");
			}
			return current;
		}
		if (current.deliveryState !== "starting") throw new Error("attempt_not_starting");
		this.db
			.prepare(
				`UPDATE invocation_attempts SET delivery_state = 'appended', turn_execution_id = ?, agent_session_id = ?, worker_id = COALESCE(?, worker_id), provider = ?, model = ?, model_family = ?, response_message_id = ?, settlement = 'streaming' WHERE attempt_id = ?`,
			)
			.run(
				input.turnExecutionId,
				input.agentSessionId,
				input.workerId,
				input.provider,
				input.model,
				input.modelFamily,
				input.responseMessageId,
				attemptId,
			);
		return this.get(attemptId);
	}

	bindWorker(attemptId: string, workerId: string): InvocationAttempt | null {
		const current = this.get(attemptId);
		if (!current) return null;
		if (current.workerId && current.workerId !== workerId) throw new Error("attempt_worker_conflict");
		if (current.workerId === workerId) return current;
		this.db.prepare("UPDATE invocation_attempts SET worker_id = ? WHERE attempt_id = ?").run(workerId, attemptId);
		return this.get(attemptId);
	}

	markPromptDelivered(
		attemptId: string,
		input: { deliveryBoundarySeq: number; now: number },
	): InvocationAttempt | null {
		const current = this.get(attemptId);
		if (!current) return null;
		if (current.promptDeliveredAt) {
			if (current.deliveryBoundarySeq !== input.deliveryBoundarySeq)
				throw new Error("attempt_prompt_boundary_conflict");
			return current;
		}
		if (current.deliveryState !== "appended") throw new Error("attempt_not_appended");
		this.db
			.prepare(
				"UPDATE invocation_attempts SET prompt_delivered_at = ?, delivery_boundary_seq = ? WHERE attempt_id = ?",
			)
			.run(input.now, input.deliveryBoundarySeq, attemptId);
		return this.get(attemptId);
	}

	setSettlement(
		attemptId: string,
		settlement: "streaming" | "response_pending" | "settled",
		responseMessageId?: string,
	): InvocationAttempt | null {
		const current = this.get(attemptId);
		if (current?.settlement === "settled" && settlement !== "settled") {
			throw new Error("attempt_settlement_regression");
		}
		this.db
			.prepare(
				"UPDATE invocation_attempts SET settlement = ?, response_message_id = COALESCE(?, response_message_id) WHERE attempt_id = ?",
			)
			.run(settlement, responseMessageId ?? null, attemptId);
		return this.get(attemptId);
	}

	/** Canonical-first projection (0016 §4.4): validates child status matches. */
	projectChildTerminal(
		attemptId: string,
		input: {
			turnExecutionId: string;
			childStatus: "completed" | "failed" | "interrupted" | "canceled";
			terminalReason: string | null;
			endedAt: number;
		},
	): { outcome: "transitioned" | "already_terminal" | "terminal_conflict" | "not_found" } {
		const current = this.get(attemptId);
		if (!current) return { outcome: "not_found" };
		// Canonical-first (0016 §4.4): read the TurnExecution and validate it
		// is the bound child with exactly this status — no attempt write may
		// invent or drift from child truth.
		if (current.turnExecutionId !== input.turnExecutionId) return { outcome: "terminal_conflict" };
		const child = this.turns.get(input.turnExecutionId);
		if (!child) throw new Error("attempt_child_not_found");
		if (child.status !== input.childStatus) return { outcome: "terminal_conflict" };
		if (current.deliveryState !== "appended") {
			const sameTerminal =
				(current.deliveryState === "handled" && input.childStatus === "completed") ||
				(current.deliveryState === input.childStatus &&
					(input.childStatus === "failed" ||
						input.childStatus === "interrupted" ||
						input.childStatus === "canceled"));
			return sameTerminal ? { outcome: "already_terminal" } : { outcome: "terminal_conflict" };
		}
		const mapped: InvocationAttemptDeliveryState = input.childStatus === "completed" ? "handled" : input.childStatus;
		if (mapped !== "handled" && !input.terminalReason) throw new Error("attempt_terminal_reason_required");
		this.db
			.prepare(
				"UPDATE invocation_attempts SET delivery_state = ?, terminal_reason = ?, ended_at = ?, settlement = CASE WHEN settlement = 'streaming' THEN 'response_pending' ELSE settlement END WHERE attempt_id = ?",
			)
			.run(mapped, mapped === "handled" ? null : input.terminalReason, input.endedAt, attemptId);
		return { outcome: "transitioned" };
	}

	/** Prestart terminal: queued→failed(target_invalid)|canceled, starting→failed|canceled. */
	markPrestartTerminal(
		attemptId: string,
		input: { status: "failed" | "canceled"; terminalReason: string; endedAt: number },
	): InvocationAttempt | null {
		const current = this.get(attemptId);
		if (!current) return null;
		if (
			current.deliveryState === "queued" &&
			input.status === "failed" &&
			input.terminalReason !== "target_invalid"
		) {
			throw new Error("attempt_queued_failed_requires_target_invalid");
		}
		this.db
			.prepare(
				"UPDATE invocation_attempts SET delivery_state = ?, terminal_reason = ?, ended_at = ? WHERE attempt_id = ? AND delivery_state IN ('queued', 'starting')",
			)
			.run(input.status, input.terminalReason, input.endedAt, attemptId);
		return this.get(attemptId);
	}

	recordUsage(attemptId: string, usage: Record<string, unknown>): InvocationAttempt | null {
		this.db
			.prepare("UPDATE invocation_attempts SET usage_json = ? WHERE attempt_id = ?")
			.run(JSON.stringify(usage), attemptId);
		return this.get(attemptId);
	}

	listActive(): InvocationAttempt[] {
		const rows = this.db
			.prepare("SELECT * FROM invocation_attempts WHERE delivery_state IN ('starting', 'appended')")
			.all() as unknown as AttemptRow[];
		return rows.map(mapAttempt);
	}

	listResponsePending(): InvocationAttempt[] {
		const rows = this.db
			.prepare("SELECT * FROM invocation_attempts WHERE settlement = 'response_pending'")
			.all() as unknown as AttemptRow[];
		return rows.map(mapAttempt);
	}
}
