import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import { type Clock, changesOf, jsonObject, mapStoreError, newId, nonEmpty, parseJsonObject } from "./helpers.ts";
import type {
	CreateRunInput,
	Run,
	RunEvent,
	RunEventKind,
	RunExecutionKind,
	RunListFilter,
	RunStatus,
	TerminalRunInput,
} from "./types.ts";

interface RunRow {
	id: string;
	task_id: string;
	queue_entry_id: string | null;
	stage_id: string | null;
	attempt: number;
	role: string;
	agent_session_id: string;
	parent_run_id: string | null;
	source_id: string;
	recipient_profile_id: string;
	chain_metadata_json: string;
	provider: string;
	model: string;
	model_family: string;
	l0_revision: string | null;
	worker_id: string | null;
	status: RunStatus;
	response_message_id: string | null;
	execution_kind: RunExecutionKind;
	handoff_id: string | null;
	approval_id: string | null;
	started_at: number;
	terminal_at: number | null;
	usage_json: string | null;
}

interface RunEventRow {
	id: string;
	run_id: string;
	seq: number;
	kind: RunEventKind;
	payload_json: string;
	ts: number;
}

function mapRun(row: RunRow): Run {
	return {
		id: row.id,
		taskId: row.task_id,
		queueEntryId: row.queue_entry_id,
		stageId: row.stage_id,
		attempt: row.attempt,
		role: row.role,
		agentSessionId: row.agent_session_id,
		parentRunId: row.parent_run_id,
		sourceId: row.source_id,
		recipientProfileId: row.recipient_profile_id,
		chainMetadata: parseJsonObject(row.chain_metadata_json),
		provider: row.provider,
		model: row.model,
		modelFamily: row.model_family,
		l0Revision: row.l0_revision,
		workerId: row.worker_id,
		status: row.status,
		responseMessageId: row.response_message_id,
		executionKind: row.execution_kind,
		handoffId: row.handoff_id,
		approvalId: row.approval_id,
		startedAt: row.started_at,
		terminalAt: row.terminal_at,
		usage: row.usage_json ? parseJsonObject(row.usage_json) : null,
	};
}

function mapRunEvent(row: RunEventRow): RunEvent {
	return {
		id: row.id,
		runId: row.run_id,
		seq: row.seq,
		kind: row.kind,
		payload: JSON.parse(row.payload_json) as unknown,
		ts: row.ts,
	};
}

export class RunStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
	}

	get(id: string): Run | null {
		const row = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
		return row ? mapRun(row) : null;
	}

	list(filter: RunListFilter = {}): Run[] {
		const clauses: string[] = [];
		const params: string[] = [];
		if (filter.taskId !== undefined) {
			clauses.push("task_id = ?");
			params.push(filter.taskId);
		}
		if (filter.agentSessionId !== undefined) {
			clauses.push("agent_session_id = ?");
			params.push(filter.agentSessionId);
		}
		if (filter.recipientProfileId !== undefined) {
			clauses.push("recipient_profile_id = ?");
			params.push(filter.recipientProfileId);
		}
		if (filter.workerId !== undefined) {
			clauses.push("worker_id = ?");
			params.push(filter.workerId);
		}
		if (filter.status !== undefined) {
			clauses.push("status = ?");
			params.push(filter.status);
		}
		const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.database
			.prepare(`SELECT * FROM runs${where} ORDER BY started_at, id`)
			.all(...params) as unknown as RunRow[];
		return rows.map(mapRun);
	}

	create(input: CreateRunInput): Run {
		const task = this.database.prepare("SELECT thread_id FROM tasks WHERE id = ?").get(input.taskId) as
			| { thread_id?: string }
			| undefined;
		if (!task?.thread_id) throw new ControlError("not_found", `task ${input.taskId} not found`);
		const session = this.database
			.prepare("SELECT task_id, profile_id, thread_id, role FROM agent_sessions WHERE id = ?")
			.get(input.agentSessionId) as
			| { task_id?: string | null; profile_id?: string; thread_id?: string; role?: string }
			| undefined;
		if (!session) throw new ControlError("not_found", `agent session ${input.agentSessionId} not found`);
		if (session.task_id !== input.taskId || session.thread_id !== task.thread_id) {
			throw new ControlError("invalid_input", "agent session is not bound to the run task/thread");
		}
		if (session.profile_id !== input.recipientProfileId) {
			throw new ControlError("invalid_input", "agent session profile does not match the run recipient");
		}
		if (session.role !== input.role) {
			throw new ControlError("invalid_input", "agent session role does not match the run role");
		}
		if (!this.database.prepare("SELECT id FROM roles WHERE id = ?").get(input.role)) {
			throw new ControlError("not_found", `role ${input.role} not found`);
		}
		if (!this.database.prepare("SELECT id FROM agent_profiles WHERE id = ?").get(input.recipientProfileId)) {
			throw new ControlError("not_found", `agent profile ${input.recipientProfileId} not found`);
		}
		if (
			input.queueEntryId &&
			!this.database.prepare("SELECT id FROM queue_entries WHERE id = ?").get(input.queueEntryId)
		) {
			throw new ControlError("not_found", `queue entry ${input.queueEntryId} not found`);
		}
		if (
			input.responseMessageId &&
			!this.database.prepare("SELECT id FROM messages WHERE id = ?").get(input.responseMessageId)
		) {
			throw new ControlError("not_found", `response message ${input.responseMessageId} not found`);
		}
		const id = input.id ?? newId();
		const now = this.clock();
		try {
			this.database
				.prepare(
					"INSERT INTO runs (id, task_id, queue_entry_id, stage_id, attempt, role, agent_session_id, parent_run_id, source_id, recipient_profile_id, chain_metadata_json, provider, model, model_family, l0_revision, worker_id, status, response_message_id, execution_kind, handoff_id, approval_id, started_at, usage_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					nonEmpty(input.taskId, "taskId"),
					input.queueEntryId ?? null,
					input.stageId ?? null,
					input.attempt ?? 1,
					nonEmpty(input.role, "role"),
					nonEmpty(input.agentSessionId, "agentSessionId"),
					input.parentRunId ?? null,
					nonEmpty(input.sourceId, "sourceId"),
					nonEmpty(input.recipientProfileId, "recipientProfileId"),
					jsonObject(input.chainMetadata ?? {}, "chainMetadata"),
					nonEmpty(input.provider, "provider"),
					nonEmpty(input.model, "model"),
					nonEmpty(input.modelFamily, "modelFamily"),
					input.l0Revision ?? null,
					input.workerId ?? null,
					input.responseMessageId ?? null,
					input.executionKind ?? "ordinary",
					input.handoffId ?? null,
					input.approvalId ?? null,
					input.startedAt ?? now,
					input.usage ? jsonObject(input.usage, "usage") : null,
				);
		} catch (error) {
			throw mapStoreError(error);
		}
		return this.get(id)!;
	}

	terminal(id: string, input: TerminalRunInput): Run {
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `run ${id} not found`);
				if (current.status !== "running") {
					if (current.status === input.status) return current;
					throw new ControlError("invalid_state", `run ${id} is already ${current.status}`);
				}
				const now = this.clock();
				const result = this.database
					.prepare(
						"UPDATE runs SET status = ?, terminal_at = ?, usage_json = ? WHERE id = ? AND status = 'running'",
					)
					.run(
						input.status,
						input.terminalAt ?? now,
						input.usage ? jsonObject(input.usage, "usage") : current.usage ? JSON.stringify(current.usage) : null,
						id,
					);
				if (changesOf(result) === 0) throw new ControlError("version_conflict", `run ${id} changed state`);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	appendEvent(runId: string, kind: RunEventKind, payload: unknown): RunEvent {
		try {
			return this.transaction.run(() => {
				if (!this.get(runId)) throw new ControlError("not_found", `run ${runId} not found`);
				const row = this.database
					.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = ?")
					.get(runId) as { next: number };
				const id = newId();
				const ts = this.clock();
				this.database
					.prepare("INSERT INTO run_events (id, run_id, seq, kind, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?)")
					.run(id, runId, row.next, kind, JSON.stringify(payload), ts);
				return {
					id,
					runId,
					seq: row.next,
					kind,
					payload,
					ts,
				};
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	attachWorker(id: string, workerId: string): Run {
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `run ${id} not found`);
				if (current.status !== "running") {
					throw new ControlError("invalid_state", `run ${id} is ${current.status}`);
				}
				if (current.workerId !== null && current.workerId !== workerId) {
					throw new ControlError("conflict", `run ${id} is already attached to worker ${current.workerId}`);
				}
				if (current.workerId === workerId) return current;
				const result = this.database
					.prepare("UPDATE runs SET worker_id = ? WHERE id = ? AND status = 'running' AND worker_id IS NULL")
					.run(workerId, id);
				if (changesOf(result) === 0) {
					throw new ControlError("version_conflict", `run ${id} changed while attaching a worker`);
				}
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	listEvents(runId: string, limit = 100): RunEvent[] {
		const rows = this.database
			.prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC LIMIT ?")
			.all(runId, Math.min(Math.max(limit, 1), 500)) as unknown as RunEventRow[];
		return rows.map(mapRunEvent);
	}
}
