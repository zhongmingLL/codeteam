import { createHash } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";

import type {
	MessageFrom,
	QueueAttemptProjection,
	QueueEntry,
	QueueEntryKind,
	QueueExecution,
	QueueOwner,
	QueuePayload,
	QueueTarget,
	QueueTerminalProjection,
} from "@superagentteam/shared/types";

// F018 R1-b queue ledger store (0007 §3.1 QueueLedgerStore + §4.1 schema).
// Fresh implementation; the task-first queue was frozen and not used.

/** Immutable-admission fingerprint fields (§3.1 replay protection). */
export interface AdmissionFingerprintInput {
	owner: QueueOwner;
	kind: QueueEntryKind;
	from: MessageFrom;
	payload: QueuePayload;
	priority: "urgent" | "normal";
	execution: QueueExecution;
}

export function computeAdmissionFingerprint(input: AdmissionFingerprintInput): string {
	// Canonical JSON: sorted keys, stable stringify.
	const canonical = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(canonical);
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>)
					.sort(([a], [b]) => (a < b ? -1 : 1))
					.map(([k, v]) => [k, canonical(v)]),
			);
		}
		return value;
	};
	return JSON.stringify(canonical(input));
}

interface QueueRow {
	version: number;
	queue_entry_id: string;
	thread_id: string;
	source_record_id: string;
	message_id: string | null;
	origin_record_id: string | null;
	attempt: number;
	owner_json: string;
	kind: string;
	from_json: string;
	targets_json: string;
	payload_json: string;
	execution_json: string;
	priority: string;
	position: number;
	status: "queued" | "claimed";
	claim_id: string | null;
	claim_owner: string | null;
	claimed_at: number | null;
	claim_expires_at: number | null;
	claimed_target_keys_json: string | null;
	enqueued_at: number;
	updated_at: number;
}

function mapEntry(row: QueueRow): QueueEntry {
	return {
		version: 1,
		queueEntryId: row.queue_entry_id,
		threadId: row.thread_id,
		owner: JSON.parse(row.owner_json) as QueueOwner,
		kind: row.kind as QueueEntryKind,
		from: JSON.parse(row.from_json) as MessageFrom,
		targets: JSON.parse(row.targets_json) as QueueTarget[],
		payload: JSON.parse(row.payload_json) as QueuePayload,
		execution: JSON.parse(row.execution_json) as QueueExecution,
		claim: row.claim_id
			? {
					claimId: row.claim_id,
					owner: row.claim_owner!,
					claimedAt: row.claimed_at!,
					expiresAt: row.claim_expires_at!,
					targetKeys: JSON.parse(row.claimed_target_keys_json!) as string[],
				}
			: null,
		status: row.status,
		priority: row.priority as "urgent" | "normal",
		position: row.position,
		enqueuedAt: row.enqueued_at,
		updatedAt: row.updated_at,
	};
}

export interface EnqueueInput {
	threadId: string;
	sourceRecordId: string;
	messageId: string | null;
	originRecordId?: string | null;
	attempt?: number;
	owner: QueueOwner;
	kind: QueueEntryKind;
	from: MessageFrom;
	content: string;
	targets: QueueTarget[];
	priority?: "urgent" | "normal";
	execution?: Partial<QueueExecution>;
	piExtToolCallId?: string;
}

export type EnqueueOutcome =
	| { outcome: "enqueued"; entry: QueueEntry }
	| { outcome: "replayed"; entry: QueueEntry | null }
	| { outcome: "conflict"; entry: null };

export interface ClaimInput {
	claimId: string;
	owner: string;
	ttlMs: number;
	targetKeys: string[];
	now?: number;
}

export type ClaimResult =
	| { outcome: "claimed"; entry: QueueEntry }
	| { outcome: "not_found" }
	| { outcome: "state_changed" };

export interface RetireInput {
	targetKeys: string[];
	now?: number;
}

function targetsForKeys(entry: QueueEntry, keys: readonly string[]): QueueTarget[] {
	return entry.targets.filter((t) => keys.includes(`agent:${t.id}`));
}

/** §3.1: projection targets are THIS retire/withdraw slice, not the remaining set. */
function attemptProjection(entry: QueueEntry, slice: readonly QueueTarget[]): QueueAttemptProjection {
	return {
		status: "processing",
		queueEntryId: entry.queueEntryId,
		targets: [...slice],
		startedAt: entry.claim?.claimedAt ?? entry.enqueuedAt,
	};
}

function terminalProjection(
	entry: QueueEntry,
	slice: readonly QueueTarget[],
	reason: "dispatched" | "withdrawn",
	now: number,
): QueueTerminalProjection {
	return {
		status: "terminal",
		queueEntryId: entry.queueEntryId,
		targets: [...slice],
		endedAt: now,
		reason,
	};
}

export type RetireResult =
	| { outcome: "updated"; entry: QueueEntry; projection: QueueAttemptProjection }
	| { outcome: "retired_all"; entry: QueueEntry }
	| { outcome: "not_found" }
	| { outcome: "state_changed" };

/** §3.1 release has no projection: it returns targets to queued unchanged. */
export type QueueReleaseResult =
	| { outcome: "updated"; entry: QueueEntry }
	| { outcome: "not_found" }
	| { outcome: "state_changed" };

export interface WithdrawInput {
	claimId?: string;
	targetKeys?: string[];
	actorRef: string;
	reason: string;
	now?: number;
}

export type WithdrawResult =
	| { outcome: "updated"; entry: QueueEntry; projection: QueueAttemptProjection }
	| { outcome: "deleted"; entry: QueueEntry; projection: QueueTerminalProjection }
	| { outcome: "not_found" }
	| { outcome: "state_changed" };

/** Per-thread cap, counted separately per kind (0007 §3.1). */
export const QUEUE_CAP_PER_KIND = 5;

export class QueueLedgerStore {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	enqueue(input: EnqueueInput, now = Date.now()): EnqueueOutcome {
		const attempt = input.attempt ?? 1;
		const thread = this.db.prepare("SELECT created_by FROM threads WHERE id = ?").get(input.threadId) as
			| { created_by: string }
			| undefined;
		if (!thread) throw new Error("queue_thread_not_found");
		if (input.owner.kind === "user" && input.owner.userId !== thread.created_by) {
			throw new Error("queue_owner_not_thread_owner");
		}
		const payload: QueuePayload = {
			sourceRecordId: input.sourceRecordId,
			messageId: input.messageId,
			originRecordId: input.originRecordId ?? null,
			attempt,
			content: input.content,
			requestedTargets: input.targets,
		};
		const execution: QueueExecution = {
			a2aParentTurnExecutionId: input.execution?.a2aParentTurnExecutionId ?? null,
			a2aTriggerMessageId: input.execution?.a2aTriggerMessageId ?? null,
			a2aDepth: input.execution?.a2aDepth ?? 0,
			multiMentionRequestId: input.execution?.multiMentionRequestId ?? null,
			multiMentionCallbackDepth: input.execution?.multiMentionCallbackDepth ?? null,
		};
		const priority = input.priority ?? "normal";
		if (input.piExtToolCallId) payload.piExtToolCallId = input.piExtToolCallId;
		const fingerprint = computeAdmissionFingerprint({
			owner: input.owner,
			kind: input.kind,
			from: input.from,
			payload,
			priority,
			execution,
		});

		const live = this.db
			.prepare("SELECT * FROM invocation_queue WHERE thread_id = ? AND source_record_id = ? AND attempt = ?")
			.get(input.threadId, input.sourceRecordId, attempt) as QueueRow | undefined;
		if (live) {
			return this.matchesFingerprint(live, fingerprint)
				? { outcome: "replayed", entry: mapEntry(live) }
				: { outcome: "conflict", entry: null };
		}
		const receipt = this.db
			.prepare(
				"SELECT fingerprint FROM queue_admissions WHERE thread_id = ? AND source_record_id = ? AND attempt = ?",
			)
			.get(input.threadId, input.sourceRecordId, attempt) as { fingerprint: string } | undefined;
		if (receipt) {
			return receipt.fingerprint === fingerprint
				? { outcome: "replayed", entry: null }
				: { outcome: "conflict", entry: null };
		}
		// Cap check (admission-time; per kind).
		if (input.targets.length > 0) {
			const count = this.countQueued(input.threadId, input.kind);
			if (count >= QUEUE_CAP_PER_KIND) throw new Error("queue_full");
		}
		const position = (
			this.db
				.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM invocation_queue WHERE thread_id = ?")
				.get(input.threadId) as { next: number }
		).next;
		const queueEntryId = `queue:${createHash("sha256")
			.update(`${input.threadId}\u0000${input.sourceRecordId}\u0000${attempt}`)
			.digest("hex")}`;
		this.db
			.prepare(
				`INSERT INTO invocation_queue (version, queue_entry_id, thread_id, source_record_id, message_id, origin_record_id, attempt, owner_json, kind, from_json, targets_json, payload_json, execution_json, priority, position, status, enqueued_at, updated_at)
				 VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
			)
			.run(
				queueEntryId,
				input.threadId,
				input.sourceRecordId,
				input.messageId,
				input.originRecordId ?? null,
				attempt,
				JSON.stringify(input.owner),
				input.kind,
				JSON.stringify(input.from),
				JSON.stringify(input.targets),
				JSON.stringify(payload),
				JSON.stringify(execution),
				priority,
				position,
				now,
				now,
			);
		this.db
			.prepare(
				"INSERT INTO queue_admissions (thread_id, source_record_id, attempt, queue_entry_id, fingerprint, admitted_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(input.threadId, input.sourceRecordId, attempt, queueEntryId, fingerprint, now);
		return { outcome: "enqueued", entry: this.get(input.threadId, queueEntryId)! };
	}

	private matchesFingerprint(row: QueueRow, fingerprint: string): boolean {
		const entry = mapEntry(row);
		return (
			computeAdmissionFingerprint({
				owner: entry.owner,
				kind: entry.kind,
				from: entry.from,
				payload: entry.payload,
				priority: entry.priority,
				execution: entry.execution,
			}) === fingerprint
		);
	}

	get(threadId: string, queueEntryId: string): QueueEntry | null {
		const row = this.db
			.prepare("SELECT * FROM invocation_queue WHERE thread_id = ? AND queue_entry_id = ?")
			.get(threadId, queueEntryId) as QueueRow | undefined;
		return row ? mapEntry(row) : null;
	}

	listQueued(threadId: string): QueueEntry[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM invocation_queue WHERE thread_id = ? AND status = 'queued'
				 AND json_array_length(targets_json) > 0
				 ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END, position, enqueued_at, queue_entry_id`,
			)
			.all(threadId) as unknown as QueueRow[];
		return rows.map(mapEntry);
	}

	listActive(threadId: string): QueueEntry[] {
		const rows = this.db
			.prepare("SELECT * FROM invocation_queue WHERE thread_id = ? AND status = 'claimed'")
			.all(threadId) as unknown as QueueRow[];
		return rows.map(mapEntry);
	}

	countQueued(threadId: string, kind: QueueEntryKind): number {
		const row = this.db
			.prepare(
				"SELECT COUNT(*) AS n FROM invocation_queue WHERE thread_id = ? AND kind = ? AND status IN ('queued', 'claimed')",
			)
			.get(threadId, kind) as { n: number };
		return row.n;
	}

	claim(threadId: string, queueEntryId: string, input: ClaimInput): ClaimResult {
		const now = input.now ?? Date.now();
		const row = this.db
			.prepare("SELECT * FROM invocation_queue WHERE thread_id = ? AND queue_entry_id = ?")
			.get(threadId, queueEntryId) as QueueRow | undefined;
		if (!row) return { outcome: "not_found" };
		const entry = mapEntry(row);
		if (input.targetKeys.length === 0) throw new Error("claim_targets_empty");
		const targetKeys = input.targetKeys;
		const covered = targetKeys.every((key) => entry.targets.some((t) => `agent:${t.id}` === key));
		if (!covered) throw new Error("claim_targets_not_pending");
		const changes = this.db
			.prepare(
				`UPDATE invocation_queue SET status = 'claimed', claim_id = ?, claim_owner = ?, claimed_at = ?, claim_expires_at = ?, claimed_target_keys_json = ?, updated_at = ?
				 WHERE thread_id = ? AND queue_entry_id = ? AND status = 'queued'`,
			)
			.run(
				input.claimId,
				input.owner,
				now,
				now + input.ttlMs,
				JSON.stringify(targetKeys),
				now,
				threadId,
				queueEntryId,
			).changes;
		return changes > 0
			? { outcome: "claimed", entry: this.get(threadId, queueEntryId)! }
			: { outcome: "state_changed" };
	}

	retireTargets(threadId: string, queueEntryId: string, claimId: string, input: RetireInput): RetireResult {
		const now = input.now ?? Date.now();
		const row = this.db
			.prepare("SELECT * FROM invocation_queue WHERE thread_id = ? AND queue_entry_id = ?")
			.get(threadId, queueEntryId) as QueueRow | undefined;
		if (!row) return { outcome: "not_found" };
		if (row.claim_id !== claimId) return { outcome: "state_changed" };
		const claimKeys = JSON.parse(row.claimed_target_keys_json ?? "[]") as string[];
		const outsideClaim = input.targetKeys.filter((key) => !claimKeys.includes(key));
		if (outsideClaim.length > 0) {
			throw new Error(`retire_targets_outside_claim: ${outsideClaim.join(",")}`);
		}
		const remaining = (JSON.parse(row.targets_json) as QueueTarget[]).filter(
			(t) => !input.targetKeys.includes(`agent:${t.id}`),
		);
		// §3.2: the queue entry is the route anchor — retiring the last target
		// keeps the row with empty targets (retry/terminal association survives
		// provider-phase failures; T3/abandon deletes via deleteEntry).
		if (remaining.length === 0) {
			this.db
				.prepare(
					`UPDATE invocation_queue SET targets_json = '[]', updated_at = ? WHERE thread_id = ? AND queue_entry_id = ? AND claim_id = ?`,
				)
				.run(now, threadId, queueEntryId, claimId);
			return { outcome: "retired_all", entry: this.get(threadId, queueEntryId)! };
		}
		const changes = this.db
			.prepare(
				`UPDATE invocation_queue SET targets_json = ?, updated_at = ? WHERE thread_id = ? AND queue_entry_id = ? AND claim_id = ?`,
			)
			.run(JSON.stringify(remaining), now, threadId, queueEntryId, claimId).changes;
		if (changes > 0) {
			const updatedEntry = this.get(threadId, queueEntryId)!;
			return {
				outcome: "updated",
				entry: updatedEntry,
				projection: attemptProjection(updatedEntry, targetsForKeys(mapEntry(row), input.targetKeys)),
			};
		}
		return { outcome: "state_changed" };
	}

	releaseClaim(threadId: string, queueEntryId: string, claimId: string, now = Date.now()): QueueReleaseResult {
		const row = this.db
			.prepare("SELECT * FROM invocation_queue WHERE thread_id = ? AND queue_entry_id = ?")
			.get(threadId, queueEntryId) as QueueRow | undefined;
		if (!row) return { outcome: "not_found" };
		if (row.claim_id !== claimId) return { outcome: "state_changed" };
		const changes = this.db
			.prepare(
				`UPDATE invocation_queue SET status = 'queued', claim_id = NULL, claim_owner = NULL, claimed_at = NULL, claim_expires_at = NULL, claimed_target_keys_json = NULL, updated_at = ?
				 WHERE thread_id = ? AND queue_entry_id = ? AND status = 'claimed' AND claim_id = ?`,
			)
			.run(now, threadId, queueEntryId, claimId).changes;
		return changes > 0
			? { outcome: "updated", entry: this.get(threadId, queueEntryId)! }
			: { outcome: "state_changed" };
	}

	/**
	 * F018 R2-a review P1-2: claim-fenced re-add of retired target keys
	 * (provider-phase failure replay). Only the current claim holder may
	 * restore; keys already pending are no-ops.
	 */
	restoreTargets(
		threadId: string,
		queueEntryId: string,
		claimId: string,
		input: { targets: QueueTarget[]; now?: number },
	): QueueReleaseResult {
		const now = input.now ?? Date.now();
		const row = this.db
			.prepare("SELECT * FROM invocation_queue WHERE thread_id = ? AND queue_entry_id = ?")
			.get(threadId, queueEntryId) as QueueRow | undefined;
		if (!row) return { outcome: "not_found" };
		if (row.claim_id !== claimId) return { outcome: "state_changed" };
		const current = JSON.parse(row.targets_json) as QueueTarget[];
		const currentKeys = new Set(current.map((t) => `agent:${t.id}`));
		for (const target of input.targets) {
			if (!currentKeys.has(`agent:${target.id}`)) current.push(target);
		}
		this.db
			.prepare(
				"UPDATE invocation_queue SET targets_json = ?, updated_at = ? WHERE thread_id = ? AND queue_entry_id = ? AND claim_id = ?",
			)
			.run(JSON.stringify(current), now, threadId, queueEntryId, claimId);
		return { outcome: "updated", entry: this.get(threadId, queueEntryId)! };
	}

	/**
	 * §3.2 explicit entry deletion — T3 parent-terminal / operator abandon /
	 * TTL path (R2-c/R2-d). Retire never deletes on its own anymore.
	 */
	deleteEntry(
		threadId: string,
		queueEntryId: string,
		input: { claimId?: string } = {},
	): {
		outcome: "deleted" | "not_found" | "state_changed";
	} {
		const row = this.db
			.prepare("SELECT claim_id FROM invocation_queue WHERE thread_id = ? AND queue_entry_id = ?")
			.get(threadId, queueEntryId) as { claim_id: string | null } | undefined;
		if (!row) return { outcome: "not_found" };
		if (input.claimId && row.claim_id !== input.claimId) return { outcome: "state_changed" };
		this.db
			.prepare("DELETE FROM invocation_queue WHERE thread_id = ? AND queue_entry_id = ?")
			.run(threadId, queueEntryId);
		return { outcome: "deleted" };
	}

	/** Ingress replay support: live entry by admission identity. */
	getBySource(threadId: string, sourceRecordId: string, attempt = 1): QueueEntry | null {
		const row = this.db
			.prepare("SELECT * FROM invocation_queue WHERE thread_id = ? AND source_record_id = ? AND attempt = ?")
			.get(threadId, sourceRecordId, attempt) as QueueRow | undefined;
		return row ? mapEntry(row) : null;
	}

	withdrawTargets(threadId: string, queueEntryId: string, input: WithdrawInput): WithdrawResult {
		const now = input.now ?? Date.now();
		const row = this.db
			.prepare("SELECT * FROM invocation_queue WHERE thread_id = ? AND queue_entry_id = ?")
			.get(threadId, queueEntryId) as QueueRow | undefined;
		if (!row) return { outcome: "not_found" };
		if (row.status === "claimed") {
			if (!input.claimId || row.claim_id !== input.claimId) return { outcome: "state_changed" };
		}
		const current = mapEntry(row);
		const keys = input.targetKeys ?? current.targets.map((t) => `agent:${t.id}`);
		const remaining = current.targets.filter((t) => !keys.includes(`agent:${t.id}`));
		if (remaining.length === 0) {
			this.db
				.prepare("DELETE FROM invocation_queue WHERE thread_id = ? AND queue_entry_id = ?")
				.run(threadId, queueEntryId);
			return {
				outcome: "deleted",
				entry: current,
				projection: terminalProjection(current, targetsForKeys(current, keys), "withdrawn", now),
			};
		}
		if (row.status === "claimed" && row.claimed_target_keys_json) {
			// Claimed partial withdrawal: shrink claimed keys to pending
			// targets still covered; release the claim when nothing remains.
			const remainingPendingKeys = remaining.map((t) => `agent:${t.id}`);
			const stillCovered = (JSON.parse(row.claimed_target_keys_json) as string[]).filter((k) =>
				remainingPendingKeys.includes(k),
			);
			if (stillCovered.length === 0) {
				this.db
					.prepare(
						`UPDATE invocation_queue SET targets_json = ?, status = 'queued', claim_id = NULL, claim_owner = NULL, claimed_at = NULL, claim_expires_at = NULL, claimed_target_keys_json = NULL, updated_at = ?
						 WHERE thread_id = ? AND queue_entry_id = ?`,
					)
					.run(JSON.stringify(remaining), now, threadId, queueEntryId);
			} else {
				this.db
					.prepare(
						"UPDATE invocation_queue SET targets_json = ?, claimed_target_keys_json = ?, updated_at = ? WHERE thread_id = ? AND queue_entry_id = ?",
					)
					.run(JSON.stringify(remaining), JSON.stringify(stillCovered), now, threadId, queueEntryId);
			}
			const claimUpdated = this.get(threadId, queueEntryId)!;
			return {
				outcome: "updated",
				entry: claimUpdated,
				projection: attemptProjection(claimUpdated, targetsForKeys(current, keys)),
			};
		}
		this.db
			.prepare(
				"UPDATE invocation_queue SET targets_json = ?, updated_at = ? WHERE thread_id = ? AND queue_entry_id = ?",
			)
			.run(JSON.stringify(remaining), now, threadId, queueEntryId);
		const finalEntry = this.get(threadId, queueEntryId)!;
		return {
			outcome: "updated",
			entry: finalEntry,
			projection: attemptProjection(finalEntry, targetsForKeys(current, keys)),
		};
	}

	/** Startup/reaper: expired claims return to queued; returns restored count. */
	restoreExpiredClaims(now = Date.now()): number {
		const result = this.db
			.prepare(
				`UPDATE invocation_queue SET status = 'queued', claim_id = NULL, claim_owner = NULL, claimed_at = NULL, claim_expires_at = NULL, claimed_target_keys_json = NULL, updated_at = ?
				 WHERE status = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?`,
			)
			.run(now, now);
		return Number(result.changes);
	}
}
