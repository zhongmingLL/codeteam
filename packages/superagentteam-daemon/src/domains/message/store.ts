import type { DatabaseSync } from "node:sqlite";

import type { AgentReadState, MessageFrom, MessageLifecycle, StoredMessage } from "@superagentteam/shared/types";

// F018 R1-a MessageStore + AgentReadStateStore (0007 §3.1/§3.5.1, 0005 D9).
// Fresh implementation against the v1 greenfield schema.

interface MessageRow {
	id: string;
	thread_id: string;
	seq: number;
	from_json: string;
	body_md: string;
	content_json: string | null;
	tool_events_json: string | null;
	lifecycle_json: string | null;
	thinking: string | null;
	reply_to: string | null;
	mentions_user: number;
	deleted_at: number | null;
	deleted_by: string | null;
	extra_json: string | null;
	created_at: number;
	updated_at: number;
}

function parseJson<T>(raw: string | null): T | undefined {
	return raw === null ? undefined : (JSON.parse(raw) as T);
}

function mapMessage(row: MessageRow): StoredMessage {
	return {
		id: row.id,
		threadId: row.thread_id,
		from: JSON.parse(row.from_json) as MessageFrom,
		content: row.body_md,
		contentBlocks: parseJson(row.content_json),
		toolEvents: parseJson(row.tool_events_json),
		lifecycle: parseJson(row.lifecycle_json),
		replyTo: row.reply_to ?? undefined,
		mentionsUser: row.mentions_user === 1,
		seq: row.seq,
		timestamp: row.created_at,
		updatedAt: row.updated_at,
		thinking: row.thinking ?? undefined,
		deletedAt: row.deleted_at ?? undefined,
		deletedBy: row.deleted_by ?? undefined,
		extra: parseJson(row.extra_json),
	};
}

export interface AppendMessageInput {
	id: string;
	threadId: string;
	from: MessageFrom;
	content: string;
	contentBlocks?: StoredMessage["contentBlocks"];
	toolEvents?: StoredMessage["toolEvents"];
	lifecycle?: MessageLifecycle;
	replyTo?: string;
	mentionsUser?: boolean;
	extra?: StoredMessage["extra"];
	thinking?: string;
	now: number;
}

export class MessageStore {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/** Appends with thread-global seq allocation (max+1) inside the caller's transaction. */
	append(input: AppendMessageInput): StoredMessage {
		const seqRow = this.db
			.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE thread_id = ?")
			.get(input.threadId) as { next: number };
		this.db
			.prepare(
				`INSERT INTO messages (id, thread_id, seq, from_json, body_md, content_json, tool_events_json, lifecycle_json, thinking, reply_to, mentions_user, extra_json, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.id,
				input.threadId,
				seqRow.next,
				JSON.stringify(input.from),
				input.content,
				input.contentBlocks ? JSON.stringify(input.contentBlocks) : null,
				input.toolEvents ? JSON.stringify(input.toolEvents) : null,
				input.lifecycle ? JSON.stringify(input.lifecycle) : null,
				input.thinking ?? null,
				input.replyTo ?? null,
				input.mentionsUser ? 1 : 0,
				input.extra ? JSON.stringify(input.extra) : null,
				input.now,
				input.now,
			);
		return this.get(input.id)!;
	}

	get(id: string): StoredMessage | null {
		const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
		return row ? mapMessage(row) : null;
	}

	/** Ascending window after a cursor (0007 §3.5.1 read surface). */
	getByThreadAfter(threadId: string, afterSeq: number, limit = 50): StoredMessage[] {
		const rows = this.db
			.prepare("SELECT * FROM messages WHERE thread_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
			.all(threadId, afterSeq, limit) as unknown as MessageRow[];
		return rows.map(mapMessage);
	}

	getByThread(threadId: string, limit = 50): StoredMessage[] {
		const rows = this.db
			.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT ?")
			.all(threadId, limit) as unknown as MessageRow[];
		return rows.map(mapMessage).reverse();
	}

	softDelete(id: string, deletedBy: string, now: number): boolean {
		return (
			this.db
				.prepare("UPDATE messages SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
				.run(now, deletedBy, now, id).changes > 0
		);
	}

	updateLifecycle(id: string, lifecycle: MessageLifecycle, now: number): boolean {
		return (
			this.db
				.prepare("UPDATE messages SET lifecycle_json = ?, updated_at = ? WHERE id = ?")
				.run(JSON.stringify(lifecycle), now, id).changes > 0
		);
	}
}

/** 0007 §4.5: per (thread, agent) delivery cursor; monotonic ack, explicit rewind. */
export class AgentReadStateStore {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	get(threadId: string, agentId: string): AgentReadState | null {
		const row = this.db
			.prepare("SELECT thread_id, agent_id, delivery_cursor, updated_at FROM agent_read_state WHERE thread_id = ? AND agent_id = ?")
			.get(threadId, agentId) as
			| { thread_id: string; agent_id: string; delivery_cursor: number; updated_at: number }
			| undefined;
		if (!row) return null;
		return {
			threadId: row.thread_id,
			agentId: row.agent_id,
			deliveryCursor: row.delivery_cursor,
			updatedAt: row.updated_at,
		};
	}

	/** Monotonic CAS: never moves backwards; normal ack path. */
	ack(threadId: string, agentId: string, seq: number, now: number): void {
		this.db
			.prepare(
				`INSERT INTO agent_read_state (thread_id, agent_id, delivery_cursor, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT (thread_id, agent_id) DO UPDATE SET
				 delivery_cursor = MAX(delivery_cursor, excluded.delivery_cursor),
				 updated_at = excluded.updated_at`,
			)
			.run(threadId, agentId, seq, now);
	}

	/** Reset-only rewind (session fresh); explicit API, never from ack. */
	rewind(threadId: string, agentId: string, seq: number, now: number): void {
		this.db
			.prepare(
				"UPDATE agent_read_state SET delivery_cursor = ?, updated_at = ? WHERE thread_id = ? AND agent_id = ?",
			)
			.run(seq, now, threadId, agentId);
	}
}
