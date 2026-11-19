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

	/** Soft delete only (0009 §2.1); data preserved, operator can clear deleted_at. */
	softDelete(id: string, now: number): boolean {
		return (
			this.db
				.prepare("UPDATE threads SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
				.run(now, now, id).changes > 0
		);
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
