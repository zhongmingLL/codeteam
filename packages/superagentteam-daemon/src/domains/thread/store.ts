import type { DatabaseSync } from "node:sqlite";

import type { Thread, ThreadParticipant } from "@superagentteam/shared/types";

// F018 R1-a ThreadStore (0009). Written fresh against the v1 schema; legacy
// task-first thread code is frozen and was not used as a skeleton.

export interface CreateThreadInput {
	id: string;
	projectPath: string;
	title?: string | null;
	titleSource?: "user" | "agent" | "system";
	createdBy: string;
	now: number;
}

export interface ListThreadsFilter {
	/** Owner scope; v1 single-user still filters explicitly. */
	createdBy: string;
	includeDeleted?: boolean;
	limit?: number;
}

export interface ThreadListItem {
	thread: Thread;
	lastReadSeq: number;
	unreadCount: number;
}

export interface ThreadReadState {
	lastReadSeq: number;
	updatedAt: number;
}

interface ThreadRow {
	id: string;
	project_path: string;
	title: string | null;
	title_source: "user" | "agent" | "system" | null;
	created_by: string;
	last_active_at: number;
	created_at: number;
	updated_at: number;
	deleted_at: number | null;
}

function mapThread(row: ThreadRow, participants: string[]): Thread {
	return {
		id: row.id,
		projectPath: row.project_path,
		title: row.title,
		titleSource: row.title_source ?? undefined,
		createdBy: row.created_by,
		participants,
		lastActiveAt: row.last_active_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		deletedAt: row.deleted_at,
	};
}

export class ThreadStore {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	create(input: CreateThreadInput): Thread {
		if (!input.projectPath.trim()) throw new Error("thread_project_path_empty");
		if (!input.createdBy.trim()) throw new Error("thread_created_by_empty");
		this.db
			.prepare(
				"INSERT INTO threads (id, project_path, title, title_source, created_by, last_active_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				input.id,
				input.projectPath,
				input.title ?? null,
				input.titleSource ?? null,
				input.createdBy,
				input.now,
				input.now,
				input.now,
			);
		return this.get(input.id)!;
	}

	get(id: string): Thread | null {
		const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
		if (!row) return null;
		return mapThread(row, this.listParticipants(id));
	}

	list(filter: ListThreadsFilter): Thread[] {
		const limit = filter.limit ?? 50;
		const rows = (filter.includeDeleted
			? this.db
					.prepare("SELECT * FROM threads WHERE created_by = ? ORDER BY last_active_at DESC LIMIT ?")
					.all(filter.createdBy, limit)
			: this.db
					.prepare(
						"SELECT * FROM threads WHERE created_by = ? AND deleted_at IS NULL ORDER BY last_active_at DESC LIMIT ?",
					)
					.all(filter.createdBy, limit)) as unknown as ThreadRow[];
		return rows.map((row) => mapThread(row, this.listParticipants(row.id)));
	}

	/** Operator-facing list with derived unread counts in one query. */
	listWithReadState(filter: ListThreadsFilter): ThreadListItem[] {
		const limit = filter.limit ?? 50;
		const rows = this.db
			.prepare(
				`SELECT t.*, COALESCE(rs.last_read_seq, 0) AS last_read_seq,
					(SELECT COUNT(*) FROM messages m
					 WHERE m.thread_id = t.id AND m.seq > COALESCE(rs.last_read_seq, 0)
					   AND m.deleted_at IS NULL AND m.author_kind != 'user') AS unread_count
				 FROM threads t
				 LEFT JOIN thread_read_state rs ON rs.thread_id = t.id AND rs.user_id = ?
				 WHERE t.created_by = ? AND t.deleted_at IS NULL
				 ORDER BY t.last_active_at DESC LIMIT ?`,
			)
			.all(filter.createdBy, filter.createdBy, limit) as unknown as Array<
			ThreadRow & { last_read_seq: number; unread_count: number }
		>;
		return rows.map((row) => ({
			thread: mapThread(row, this.listParticipants(row.id)),
			lastReadSeq: row.last_read_seq,
			unreadCount: row.unread_count,
		}));
	}

	getReadState(userId: string, threadId: string): ThreadReadState | null {
		const row = this.db
			.prepare("SELECT last_read_seq, updated_at FROM thread_read_state WHERE user_id = ? AND thread_id = ?")
			.get(userId, threadId) as { last_read_seq: number; updated_at: number } | undefined;
		return row ? { lastReadSeq: row.last_read_seq, updatedAt: row.updated_at } : null;
	}

	/** Monotonic read cursor; older marks are no-ops. */
	markRead(userId: string, threadId: string, seq: number, now: number): ThreadReadState {
		this.db
			.prepare(
				`INSERT INTO thread_read_state (user_id, thread_id, last_read_seq, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(user_id, thread_id) DO UPDATE SET
				   last_read_seq = MAX(thread_read_state.last_read_seq, excluded.last_read_seq),
				   updated_at = excluded.updated_at`,
			)
			.run(userId, threadId, seq, now);
		return this.getReadState(userId, threadId)!;
	}

	unreadCount(userId: string, threadId: string): number {
		const lastReadSeq = this.getReadState(userId, threadId)?.lastReadSeq ?? 0;
		const row = this.db
			.prepare(
				`SELECT COUNT(*) AS count FROM messages
				 WHERE thread_id = ? AND seq > ? AND deleted_at IS NULL AND author_kind != 'user'`,
			)
			.get(threadId, lastReadSeq) as { count: number };
		return row.count;
	}

	/** Soft delete only (0009 §2.1); data preserved, operator can clear deleted_at. */
	softDelete(id: string, now: number): boolean {
		return (
			this.db
				.prepare("UPDATE threads SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
				.run(now, now, id).changes > 0
		);
	}

	/** Rename without touching last_active_at; updated_at tracks config changes. */
	updateTitle(id: string, title: string, titleSource: "user" | "agent" | "system", now: number): Thread | null {
		if (!title.trim()) throw new Error("thread_title_empty");
		const changed =
			this.db
				.prepare(
					"UPDATE threads SET title = ?, title_source = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
				)
				.run(title, titleSource, now, id).changes > 0;
		return changed ? this.get(id) : null;
	}

	restore(id: string, now: number): boolean {
		return (
			this.db.prepare("UPDATE threads SET deleted_at = NULL, updated_at = ? WHERE id = ?").run(now, id).changes > 0
		);
	}

	/** Updates last_active_at only; updated_at tracks config changes (0009 §2.3). */
	touchLastActive(id: string, now: number): void {
		this.db.prepare("UPDATE threads SET last_active_at = ? WHERE id = ?").run(now, id);
	}

	/** Participants: routing/context membership, not ACL (0009 §2.2). */
	addParticipant(threadId: string, agentId: string, now: number): void {
		this.db
			.prepare("INSERT OR IGNORE INTO thread_participants (thread_id, agent_id, joined_at) VALUES (?, ?, ?)")
			.run(threadId, agentId, now);
	}

	listParticipants(threadId: string): string[] {
		const rows = this.db
			.prepare("SELECT agent_id FROM thread_participants WHERE thread_id = ? ORDER BY joined_at, agent_id")
			.all(threadId) as Array<{ agent_id: string }>;
		return rows.map((row) => row.agent_id);
	}

	listParticipantRows(threadId: string): ThreadParticipant[] {
		return this.db
			.prepare(
				"SELECT thread_id, agent_id, joined_at FROM thread_participants WHERE thread_id = ? ORDER BY joined_at, agent_id",
			)
			.all(threadId) as unknown as ThreadParticipant[];
	}
}
