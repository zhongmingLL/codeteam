import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import { type Clock, changesOf, jsonObject, mapStoreError, newId, parseJsonObject } from "./helpers.ts";
import type { CreateInboxInput, InboxItem, InboxKind, InboxListFilter, InboxStatus } from "./types.ts";

interface InboxRow {
	id: string;
	task_id: string;
	run_id: string | null;
	kind: InboxKind;
	payload_json: string;
	status: InboxStatus;
	created_at: number;
	consumed_at: number | null;
}

function mapInbox(row: InboxRow): InboxItem {
	return {
		id: row.id,
		taskId: row.task_id,
		runId: row.run_id,
		kind: row.kind,
		payload: parseJsonObject(row.payload_json),
		status: row.status,
		createdAt: row.created_at,
		consumedAt: row.consumed_at,
	};
}

export class InboxStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
	}

	get(id: string): InboxItem | null {
		const row = this.database.prepare("SELECT * FROM inbox WHERE id = ?").get(id) as InboxRow | undefined;
		return row ? mapInbox(row) : null;
	}

	list(filter: InboxListFilter = {}): InboxItem[] {
		const clauses: string[] = [];
		const params: string[] = [];
		if (filter.taskId !== undefined) {
			clauses.push("task_id = ?");
			params.push(filter.taskId);
		}
		if (filter.status !== undefined) {
			clauses.push("status = ?");
			params.push(filter.status);
		}
		const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.database
			.prepare(`SELECT * FROM inbox${where} ORDER BY created_at, id`)
			.all(...params) as unknown as InboxRow[];
		return rows.map(mapInbox);
	}

	create(input: CreateInboxInput): InboxItem {
		const id = input.id ?? newId();
		try {
			this.database
				.prepare(
					"INSERT INTO inbox (id, task_id, run_id, kind, payload_json, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
				)
				.run(
					id,
					input.taskId,
					input.runId ?? null,
					input.kind,
					jsonObject(input.payload ?? {}, "payload"),
					this.clock(),
				);
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
		return this.get(id)!;
	}

	consume(id: string): InboxItem {
		return this.transition(id, "consumed");
	}

	expire(id: string): InboxItem {
		return this.transition(id, "expired");
	}

	private transition(id: string, status: "consumed" | "expired"): InboxItem {
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `inbox item ${id} not found`);
				if (current.status !== "pending") {
					throw new ControlError("invalid_state", `inbox item ${id} is ${current.status}`);
				}
				const now = this.clock();
				const result =
					status === "consumed"
						? this.database
								.prepare(
									"UPDATE inbox SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'pending'",
								)
								.run(now, id)
						: this.database
								.prepare(
									"UPDATE inbox SET status = 'expired', consumed_at = NULL WHERE id = ? AND status = 'pending'",
								)
								.run(id);
				if (changesOf(result) === 0) {
					throw new ControlError("invalid_state", `inbox item ${id} changed state`);
				}
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}
}
