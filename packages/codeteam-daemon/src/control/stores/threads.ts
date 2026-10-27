import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import { type Clock, changesOf, mapStoreError, newId } from "./helpers.ts";
import type {
	CreateThreadInput,
	LinkThreadBacklogInput,
	Thread,
	ThreadListFilter,
	ThreadPhase,
	ThreadStatus,
} from "./types.ts";

interface ThreadRow {
	id: string;
	title: string | null;
	repo: string | null;
	status: ThreadStatus;
	phase: ThreadPhase | null;
	backlog_item_id: string | null;
	created_at: number;
	updated_at: number;
}

function mapThread(row: ThreadRow): Thread {
	return {
		id: row.id,
		title: row.title,
		repo: row.repo,
		status: row.status,
		phase: row.phase,
		backlogItemId: row.backlog_item_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class ThreadStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
	}

	get(id: string): Thread | null {
		const row = this.database.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
		return row ? mapThread(row) : null;
	}

	list(filter: ThreadListFilter = {}): Thread[] {
		const clauses: string[] = [];
		const params: string[] = [];
		if (filter.status !== undefined) {
			clauses.push("status = ?");
			params.push(filter.status);
		}
		if (filter.phase !== undefined) {
			clauses.push("phase = ?");
			params.push(filter.phase);
		}
		if (filter.backlogItemId !== undefined) {
			clauses.push("backlog_item_id = ?");
			params.push(filter.backlogItemId);
		}
		const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.database
			.prepare(`SELECT * FROM threads${where} ORDER BY updated_at DESC, id`)
			.all(...params) as unknown as ThreadRow[];
		return rows.map(mapThread);
	}

	create(input: CreateThreadInput = {}): Thread {
		const id = input.id ?? newId();
		const now = this.clock();
		try {
			this.database
				.prepare(
					"INSERT INTO threads (id, title, repo, status, phase, backlog_item_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					input.title ?? null,
					input.repo ?? null,
					input.status ?? "active",
					input.phase ?? null,
					input.backlogItemId ?? null,
					now,
					now,
				);
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
		return this.get(id)!;
	}

	setStatus(id: string, status: ThreadStatus, options: { expectedUpdatedAt?: number } = {}): Thread {
		const now = this.clock();
		try {
			const result =
				options.expectedUpdatedAt === undefined
					? this.database
							.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?")
							.run(status, now, id)
					: this.database
							.prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ? AND updated_at = ?")
							.run(status, now, id, options.expectedUpdatedAt);
			if (changesOf(result) === 0) {
				if (!this.get(id)) throw new ControlError("not_found", `thread ${id} not found`);
				throw new ControlError("version_conflict", `thread ${id} changed since the expected revision`);
			}
			return this.get(id)!;
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}

	linkBacklogItem(id: string, input: LinkThreadBacklogInput): Thread {
		try {
			return this.transaction.run(() => {
				const backlog = this.database.prepare("SELECT id FROM backlog_items WHERE id = ?").get(input.backlogItemId);
				if (!backlog) throw new ControlError("not_found", `backlog item ${input.backlogItemId} not found`);
				const now = this.clock();
				const result =
					input.expectedUpdatedAt === undefined
						? this.database
								.prepare("UPDATE threads SET backlog_item_id = ?, phase = ?, updated_at = ? WHERE id = ?")
								.run(input.backlogItemId, input.phase, now, id)
						: this.database
								.prepare(
									"UPDATE threads SET backlog_item_id = ?, phase = ?, updated_at = ? WHERE id = ? AND updated_at = ?",
								)
								.run(input.backlogItemId, input.phase, now, id, input.expectedUpdatedAt);
				if (changesOf(result) === 0) {
					if (!this.get(id)) throw new ControlError("not_found", `thread ${id} not found`);
					throw new ControlError("version_conflict", `thread ${id} changed since the expected revision`);
				}
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}
}
