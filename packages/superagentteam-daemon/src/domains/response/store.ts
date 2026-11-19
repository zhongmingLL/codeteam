import type { DatabaseSync } from "node:sqlite";

import type { DraftRecord } from "@superagentteam/shared/types";

// F018 R1-c ResponseDraftStore (0017 §4-§7): one DraftRecord per attempt/
// turn; full-snapshot upsert; deletion is final (late flush returns null and
// does NOT recreate).

interface DraftRow {
	attempt_id: string;
	turn_execution_id: string;
	parent_invocation_id: string;
	thread_id: string;
	agent_id: string;
	content: string;
	tool_events_json: string;
	thinking: string | null;
	created_at: number;
	updated_at: number;
}

function mapDraft(row: DraftRow): DraftRecord {
	return {
		attemptId: row.attempt_id,
		turnExecutionId: row.turn_execution_id,
		parentInvocationId: row.parent_invocation_id,
		threadId: row.thread_id,
		agentId: row.agent_id,
		content: row.content,
		toolEvents: JSON.parse(row.tool_events_json) as unknown[],
		thinking: row.thinking,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class ResponseDraftStore {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/**
	 * T1 dispatch tx: idempotent create. Identity = attemptId + turnExecutionId;
	 * same identity with conflicting parent/thread/agent throws; replay returns
	 * the existing draft.
	 */
	create(draft: DraftRecord): DraftRecord {
		const existing = this.getByTurn(draft.turnExecutionId);
		if (existing) {
			const sameIdentity =
				existing.attemptId === draft.attemptId &&
				existing.parentInvocationId === draft.parentInvocationId &&
				existing.threadId === draft.threadId &&
				existing.agentId === draft.agentId;
			if (!sameIdentity) throw new Error("draft_identity_conflict");
			return existing;
		}
		this.db
			.prepare(
				`INSERT INTO response_drafts (attempt_id, turn_execution_id, parent_invocation_id, thread_id, agent_id, content, tool_events_json, thinking, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				draft.attemptId,
				draft.turnExecutionId,
				draft.parentInvocationId,
				draft.threadId,
				draft.agentId,
				draft.content,
				JSON.stringify(draft.toolEvents),
				draft.thinking,
				draft.createdAt,
				draft.updatedAt,
			);
		return this.getByTurn(draft.turnExecutionId)!;
	}

	/**
	 * WorkerEventSink flush: full snapshot, last-write-wins. Row deleted by
	 * T2/T4 → returns null and does NOT recreate (0017 §5.3).
	 */
	upsert(draft: DraftRecord): DraftRecord | null {
		const changes = this.db
			.prepare(
				`UPDATE response_drafts SET content = ?, tool_events_json = ?, thinking = ?, updated_at = ?
				 WHERE attempt_id = ?`,
			)
			.run(
				draft.content,
				JSON.stringify(draft.toolEvents),
				draft.thinking,
				draft.updatedAt,
				draft.attemptId,
			).changes;
		return changes > 0 ? this.getByTurn(draft.turnExecutionId) : null;
	}

	getByTurn(turnExecutionId: string): DraftRecord | null {
		const row = this.db.prepare("SELECT * FROM response_drafts WHERE turn_execution_id = ?").get(turnExecutionId) as
			| DraftRow
			| undefined;
		return row ? mapDraft(row) : null;
	}

	getByThread(threadId: string, opts: { limit?: number } = {}): DraftRecord[] {
		const rows = this.db
			.prepare("SELECT * FROM response_drafts WHERE thread_id = ? ORDER BY updated_at ASC LIMIT ?")
			.all(threadId, opts.limit ?? 50) as unknown as DraftRow[];
		return rows.map(mapDraft);
	}

	/** T2/T4: idempotent delete; missing row no-op. */
	delete(turnExecutionId: string): void {
		this.db.prepare("DELETE FROM response_drafts WHERE turn_execution_id = ?").run(turnExecutionId);
	}

	deleteByThread(threadId: string): number {
		const result = this.db.prepare("DELETE FROM response_drafts WHERE thread_id = ?").run(threadId);
		return Number(result.changes);
	}

	/** Maintenance projection: drafts whose turn is terminal (or R terminal) and older than cutoff. */
	listOrphans(olderThan: number, limit = 100): DraftRecord[] {
		const rows = this.db
			.prepare(
				`SELECT d.* FROM response_drafts d
				 LEFT JOIN turn_executions t ON t.turn_execution_id = d.turn_execution_id
				 LEFT JOIN messages r ON r.id = (
					 SELECT response_message_id FROM invocation_attempts WHERE turn_execution_id = d.turn_execution_id
				 )
				 WHERE (t.status IS NOT 'running' OR t.status IS NULL OR r.lifecycle_json IS NOT NULL)
				 AND d.updated_at < ?
				 LIMIT ?`,
			)
			.all(olderThan, limit) as unknown as DraftRow[];
		return rows.map(mapDraft);
	}
}
