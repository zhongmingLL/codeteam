import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import { type Clock, mapStoreError, newId } from "./helpers.ts";
import type { ThreadEvent, ThreadEventKind } from "./types.ts";

interface ThreadEventRow {
	id: string;
	thread_id: string;
	seq: number;
	kind: ThreadEventKind;
	payload_json: string;
	ts: number;
}

function mapThreadEvent(row: ThreadEventRow): ThreadEvent {
	return {
		id: row.id,
		threadId: row.thread_id,
		seq: row.seq,
		kind: row.kind,
		payload: JSON.parse(row.payload_json) as unknown,
		ts: row.ts,
	};
}

export class ThreadEventStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
	}

	append(threadId: string, kind: ThreadEventKind, payload: unknown): ThreadEvent {
		try {
			return this.transaction.run(() => {
				if (!this.database.prepare("SELECT id FROM threads WHERE id = ?").get(threadId)) {
					throw new ControlError("not_found", `thread ${threadId} not found`);
				}
				const row = this.database
					.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM thread_events WHERE thread_id = ?")
					.get(threadId) as { next: number };
				const id = newId();
				const ts = this.clock();
				this.database
					.prepare(
						"INSERT INTO thread_events (id, thread_id, seq, kind, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?)",
					)
					.run(id, threadId, row.next, kind, JSON.stringify(payload), ts);
				return { id, threadId, seq: row.next, kind, payload, ts };
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	list(threadId: string, limit = 100): ThreadEvent[] {
		const rows = this.database
			.prepare("SELECT * FROM thread_events WHERE thread_id = ? ORDER BY seq ASC LIMIT ?")
			.all(threadId, Math.min(Math.max(limit, 1), 500)) as unknown as ThreadEventRow[];
		return rows.map(mapThreadEvent);
	}
}
