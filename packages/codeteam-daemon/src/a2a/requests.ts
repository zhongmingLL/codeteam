import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../control/errors.ts";
import { type Clock, newId, nonEmpty } from "../control/stores/helpers.ts";
import type { ControlTransaction } from "../control/transaction.ts";

export interface A2ARequestRecord {
	readonly id: string;
	readonly taskId: string;
	readonly profileId: string;
	readonly requestId: string;
	readonly intentHash: string;
	readonly messageId: string;
	readonly queueEntryId: string | null;
	readonly createdAt: number;
}

interface A2ARequestRow {
	id: string;
	task_id: string;
	profile_id: string;
	request_id: string;
	intent_hash: string;
	message_id: string;
	queue_entry_id: string | null;
	created_at: number;
}

export interface ReserveA2ARequestInput {
	readonly taskId: string;
	readonly profileId: string;
	readonly requestId: string;
	readonly intentHash: string;
	readonly messageId: string;
	readonly queueEntryId: string | null;
}

function mapRecord(row: A2ARequestRow): A2ARequestRecord {
	return {
		id: row.id,
		taskId: row.task_id,
		profileId: row.profile_id,
		requestId: row.request_id,
		intentHash: row.intent_hash,
		messageId: row.message_id,
		queueEntryId: row.queue_entry_id,
		createdAt: row.created_at,
	};
}

function assertIntentHash(value: string): string {
	const hash = nonEmpty(value, "intentHash");
	if (!/^[0-9a-f]{64}$/.test(hash)) {
		throw new ControlError("invalid_input", "intentHash must be 64 lowercase hex characters");
	}
	return hash;
}

export class A2ARequestStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
	}

	get(taskId: string, profileId: string, requestId: string): A2ARequestRecord | null {
		const row = this.database
			.prepare("SELECT * FROM a2a_requests WHERE task_id = ? AND profile_id = ? AND request_id = ?")
			.get(taskId, profileId, requestId) as A2ARequestRow | undefined;
		return row ? mapRecord(row) : null;
	}

	/**
	 * Reserve one sender-scoped request id. The caller must already have created
	 * the target message/queue inside the same transaction; a race returns the
	 * existing record so the handler can replay it.
	 */
	reserve(input: ReserveA2ARequestInput): A2ARequestRecord {
		const taskId = nonEmpty(input.taskId, "taskId");
		const profileId = nonEmpty(input.profileId, "profileId");
		const requestId = nonEmpty(input.requestId, "requestId");
		const intentHash = assertIntentHash(input.intentHash);
		const messageId = nonEmpty(input.messageId, "messageId");
		const existing = this.get(taskId, profileId, requestId);
		if (existing) return this.assertSameIntent(existing, intentHash);
		try {
			return this.transaction.run(() => {
				const id = newId();
				this.database
					.prepare(
						"INSERT INTO a2a_requests (id, task_id, profile_id, request_id, intent_hash, message_id, queue_entry_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(id, taskId, profileId, requestId, intentHash, messageId, input.queueEntryId, this.clock());
				return this.get(taskId, profileId, requestId)!;
			});
		} catch (error) {
			const raced = this.get(taskId, profileId, requestId);
			if (raced) return this.assertSameIntent(raced, intentHash);
			throw error;
		}
	}

	private assertSameIntent(existing: A2ARequestRecord, intentHash: string): A2ARequestRecord {
		if (existing.intentHash !== intentHash) {
			throw new ControlError(
				"conflict",
				`codeteam_a2a_send requestId ${existing.requestId} was used by another intent`,
			);
		}
		return existing;
	}
}
