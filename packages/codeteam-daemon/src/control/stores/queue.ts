import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import {
	type Clock,
	changesOf,
	jsonArray,
	jsonObject,
	mapStoreError,
	nonEmpty,
	parseJsonArray,
	parseJsonObject,
} from "./helpers.ts";
import type {
	AdmitQueueEntryInput,
	ClaimQueueEntryInput,
	QueueEntry,
	QueuePriority,
	QueueSourceKind,
	QueueStatus,
} from "./types.ts";

export const DEFAULT_QUEUE_CLAIM_TTL_MS = 5 * 60 * 1000;

interface QueueEntryRow {
	id: string;
	thread_id: string;
	source_id: string;
	source_record_id: string | null;
	source_kind: QueueSourceKind;
	targets_json: string;
	author_intent_json: string;
	priority: QueuePriority;
	source_category: string;
	order_key: string;
	revision: number;
	fence_refs_json: string;
	status: QueueStatus;
	claim_id: string | null;
	claim_owner_run_id: string | null;
	claim_expires_at: number | null;
	enqueued_at: number;
	updated_at: number;
}

function mapQueueEntry(row: QueueEntryRow): QueueEntry {
	const targets = parseJsonArray(row.targets_json);
	if (!targets.every((target) => typeof target === "string")) {
		throw new ControlError("invalid_input", "queue targets must be strings");
	}
	return {
		id: row.id,
		threadId: row.thread_id,
		sourceId: row.source_id,
		sourceRecordId: row.source_record_id,
		sourceKind: row.source_kind,
		targets: targets as string[],
		authorIntent: parseJsonObject(row.author_intent_json),
		priority: row.priority,
		sourceCategory: row.source_category,
		orderKey: row.order_key,
		revision: row.revision,
		fenceRefs: parseJsonArray(row.fence_refs_json),
		status: row.status,
		claimId: row.claim_id,
		claimOwnerRunId: row.claim_owner_run_id,
		claimExpiresAt: row.claim_expires_at,
		enqueuedAt: row.enqueued_at,
		updatedAt: row.updated_at,
	};
}

export class QueueStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
	}

	get(id: string): QueueEntry | null {
		const row = this.database.prepare("SELECT * FROM queue_entries WHERE id = ?").get(id) as
			| QueueEntryRow
			| undefined;
		return row ? mapQueueEntry(row) : null;
	}

	listPending(limit = 100): QueueEntry[] {
		const rows = this.database
			.prepare(
				"SELECT * FROM queue_entries WHERE status = 'queued' ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END, order_key, enqueued_at LIMIT ?",
			)
			.all(Math.min(Math.max(limit, 1), 500)) as unknown as QueueEntryRow[];
		return rows.map(mapQueueEntry);
	}

	admit(input: AdmitQueueEntryInput): QueueEntry {
		if (!Array.isArray(input.targets)) {
			throw new ControlError("invalid_input", "queue targets must be a non-empty string array");
		}
		const targets = input.targets.filter((target) => typeof target === "string" && target.trim() !== "");
		if (targets.length !== input.targets.length || targets.length === 0) {
			throw new ControlError("invalid_input", "queue targets must be a non-empty string array");
		}
		const uniqueTargets = [...new Set(targets)];
		if (uniqueTargets.length !== targets.length) {
			throw new ControlError("invalid_input", "queue targets must be unique");
		}
		const authorIntent = input.authorIntent ?? {};
		for (const target of Object.keys(authorIntent)) {
			if (!uniqueTargets.includes(target)) {
				throw new ControlError("invalid_input", `authorIntent target ${target} is not in targets`);
			}
		}
		const id = input.id ?? `queue:${input.sourceId}`;
		const existing = this.get(id);
		if (existing) {
			if (existing.sourceId !== input.sourceId) {
				throw new ControlError("conflict", `queue id ${id} belongs to another source`);
			}
			return existing;
		}
		const bySource = this.database
			.prepare("SELECT * FROM queue_entries WHERE source_id = ? ORDER BY enqueued_at, id LIMIT 1")
			.get(input.sourceId) as QueueEntryRow | undefined;
		if (bySource) return mapQueueEntry(bySource);
		const now = this.clock();
		try {
			this.database
				.prepare(
					"INSERT INTO queue_entries (id, thread_id, source_id, source_record_id, source_kind, targets_json, author_intent_json, priority, source_category, order_key, revision, fence_refs_json, status, enqueued_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'queued', ?, ?)",
				)
				.run(
					id,
					nonEmpty(input.threadId, "threadId"),
					nonEmpty(input.sourceId, "sourceId"),
					input.sourceRecordId ?? null,
					input.sourceKind,
					jsonArray(uniqueTargets, "targets"),
					jsonObject(authorIntent, "authorIntent"),
					input.priority ?? "normal",
					nonEmpty(input.sourceCategory, "sourceCategory"),
					nonEmpty(input.orderKey, "orderKey"),
					jsonArray(input.fenceRefs ?? [], "fenceRefs"),
					now,
					now,
				);
		} catch (error) {
			const raced = this.get(id);
			if (raced) return raced;
			throw mapStoreError(error, "invalid_input");
		}
		return this.get(id)!;
	}

	claimNext(input: ClaimQueueEntryInput): QueueEntry | null {
		try {
			return this.transaction.run(() => {
				const row = this.database
					.prepare(
						"SELECT id FROM queue_entries WHERE status = 'queued' ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END, order_key, enqueued_at LIMIT 1",
					)
					.get() as { id?: string } | undefined;
				if (!row?.id) return null;
				return this.claim(row.id, input);
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	claim(id: string, input: ClaimQueueEntryInput): QueueEntry {
		const claimId = nonEmpty(input.claimId, "claimId");
		const ttlMs = input.ttlMs ?? DEFAULT_QUEUE_CLAIM_TTL_MS;
		if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
			throw new ControlError("invalid_input", "ttlMs must be a positive integer");
		}
		try {
			return this.transaction.run(() => {
				const now = this.clock();
				const result = this.database
					.prepare(
						"UPDATE queue_entries SET status = 'claimed', claim_id = ?, claim_owner_run_id = ?, claim_expires_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'queued'",
					)
					.run(claimId, input.ownerRunId ?? null, now + ttlMs, now, id);
				if (changesOf(result) === 0) {
					const existing = this.get(id);
					if (!existing) throw new ControlError("not_found", `queue entry ${id} not found`);
					throw new ControlError("claim_conflict", `queue entry ${id} is not queued`);
				}
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	release(id: string, claimId: string): QueueEntry {
		const claim = nonEmpty(claimId, "claimId");
		try {
			return this.transaction.run(() => {
				const now = this.clock();
				const result = this.database
					.prepare(
						"UPDATE queue_entries SET status = 'queued', claim_id = NULL, claim_owner_run_id = NULL, claim_expires_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'claimed' AND claim_id = ?",
					)
					.run(now, id, claim);
				if (changesOf(result) === 0) {
					const existing = this.get(id);
					if (!existing) throw new ControlError("not_found", `queue entry ${id} not found`);
					throw new ControlError("claim_conflict", `queue entry ${id} is not claimed by ${claim}`);
				}
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	complete(id: string, claimId: string): void {
		const claim = nonEmpty(claimId, "claimId");
		try {
			this.transaction.run(() => {
				const result = this.database
					.prepare("DELETE FROM queue_entries WHERE id = ? AND status = 'claimed' AND claim_id = ?")
					.run(id, claim);
				if (changesOf(result) === 0) {
					const existing = this.get(id);
					if (!existing) throw new ControlError("not_found", `queue entry ${id} not found`);
					throw new ControlError("claim_conflict", `queue entry ${id} is not claimed by ${claim}`);
				}
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}
}
