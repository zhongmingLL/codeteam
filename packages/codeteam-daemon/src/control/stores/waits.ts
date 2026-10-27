import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import { type Clock, changesOf, jsonObject, mapStoreError, newId, nonEmpty, parseJsonObject } from "./helpers.ts";
import type {
	CreateWaitInput,
	RenewWaitInput,
	TerminateWaitInput,
	Wait,
	WaitKind,
	WaitOutcomeDelivery,
	WaitStatus,
	WaitTermination,
} from "./types.ts";

interface WaitRow {
	id: string;
	wait_id: string;
	generation: number;
	subject_ref: string;
	kind: WaitKind;
	wait_source_ref: string;
	expected_signal: string | null;
	baseline_json: string;
	continuation_json: string;
	owner_fence_json: string;
	status: WaitStatus;
	expires_at: number | null;
	auto_renew: number;
	sla_until: number;
	outcome_json: string | null;
	outcome_delivery: WaitOutcomeDelivery | null;
	publish_claimed_at: number | null;
	consumed_at: number | null;
	approval_id: string | null;
	created_at: number;
	terminalized_at: number | null;
}

interface TerminationRow {
	event_id: string;
	wait_id: string;
	generation: number;
	wait_kind: WaitKind;
	reason: string;
	actor_json: string;
	subject_ref: string;
	owner_user_id: string;
	owner_profile_id: string | null;
	thread_id: string;
	at: number;
	disposition_ref: string | null;
}

function mapWait(row: WaitRow): Wait {
	return {
		id: row.id,
		waitId: row.wait_id,
		generation: row.generation,
		subjectRef: row.subject_ref,
		kind: row.kind,
		waitSourceRef: row.wait_source_ref,
		expectedSignal: row.expected_signal,
		baseline: parseJsonObject(row.baseline_json),
		continuation: parseJsonObject(row.continuation_json),
		ownerFence: parseJsonObject(row.owner_fence_json),
		status: row.status,
		expiresAt: row.expires_at,
		autoRenew: row.auto_renew === 1,
		slaUntil: row.sla_until,
		outcome: row.outcome_json ? parseJsonObject(row.outcome_json) : null,
		outcomeDelivery: row.outcome_delivery,
		publishClaimedAt: row.publish_claimed_at,
		consumedAt: row.consumed_at,
		approvalId: row.approval_id,
		createdAt: row.created_at,
		terminalizedAt: row.terminalized_at,
	};
}

function mapTermination(row: TerminationRow): WaitTermination {
	return {
		eventId: row.event_id,
		waitId: row.wait_id,
		generation: row.generation,
		waitKind: row.wait_kind,
		reason: row.reason,
		actor: parseJsonObject(row.actor_json),
		subjectRef: row.subject_ref,
		ownerUserId: row.owner_user_id,
		ownerProfileId: row.owner_profile_id,
		threadId: row.thread_id,
		at: row.at,
		dispositionRef: row.disposition_ref,
	};
}

export class WaitStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
	}

	get(id: string): Wait | null {
		const row = this.database.prepare("SELECT * FROM waits WHERE id = ?").get(id) as WaitRow | undefined;
		return row ? mapWait(row) : null;
	}

	getBySeries(waitId: string, generation: number): Wait | null {
		const row = this.database
			.prepare("SELECT * FROM waits WHERE wait_id = ? AND generation = ?")
			.get(waitId, generation) as WaitRow | undefined;
		return row ? mapWait(row) : null;
	}

	listActive(subjectRef?: string): Wait[] {
		const rows = subjectRef
			? (this.database
					.prepare("SELECT * FROM waits WHERE subject_ref = ? AND status = 'active' ORDER BY created_at, id")
					.all(subjectRef) as unknown as WaitRow[])
			: (this.database
					.prepare("SELECT * FROM waits WHERE status = 'active' ORDER BY created_at, id")
					.all() as unknown as WaitRow[]);
		return rows.map(mapWait);
	}

	create(input: CreateWaitInput): Wait {
		if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
			throw new ControlError("invalid_input", "wait generation must be a positive integer");
		}
		if (input.kind === "event" && (!input.expectedSignal || input.expectedSignal.trim() === "")) {
			throw new ControlError("invalid_input", "event waits require expectedSignal");
		}
		const id = `wait:${nonEmpty(input.waitId, "waitId")}:g${input.generation}`;
		const now = this.clock();
		try {
			this.database
				.prepare(
					"INSERT INTO waits (id, wait_id, generation, subject_ref, kind, wait_source_ref, expected_signal, baseline_json, continuation_json, owner_fence_json, status, expires_at, auto_renew, sla_until, approval_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					input.waitId,
					input.generation,
					nonEmpty(input.subjectRef, "subjectRef"),
					input.kind,
					nonEmpty(input.waitSourceRef, "waitSourceRef"),
					input.expectedSignal ?? null,
					jsonObject(input.baseline, "baseline"),
					jsonObject(input.continuation, "continuation"),
					jsonObject(input.ownerFence, "ownerFence"),
					input.expiresAt ?? null,
					input.autoRenew === false ? 0 : 1,
					input.slaUntil,
					input.approvalId ?? null,
					now,
				);
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
		return this.get(id)!;
	}

	terminate(input: TerminateWaitInput): WaitTermination {
		try {
			return this.transaction.run(() => {
				const current = this.getBySeries(input.waitId, input.generation);
				if (!current) throw new ControlError("not_found", `wait ${input.waitId}:g${input.generation} not found`);
				if (current.status !== "active")
					throw new ControlError("invalid_state", `wait ${current.id} is terminated`);
				const now = this.clock();
				const result = this.database
					.prepare(
						"UPDATE waits SET status = 'terminated', terminalized_at = ?, outcome_json = ?, outcome_delivery = NULL WHERE id = ? AND status = 'active'",
					)
					.run(now, jsonObject({ reason: input.reason, actor: input.actor }, "outcome"), current.id);
				if (changesOf(result) === 0) throw new ControlError("conflict", `wait ${current.id} changed state`);
				const eventId = newId();
				this.database
					.prepare(
						"INSERT INTO wait_terminations (event_id, wait_id, generation, wait_kind, reason, actor_json, subject_ref, owner_user_id, owner_profile_id, thread_id, at, disposition_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						eventId,
						input.waitId,
						input.generation,
						current.kind,
						nonEmpty(input.reason, "reason"),
						jsonObject(input.actor, "actor"),
						current.subjectRef,
						nonEmpty(input.ownerUserId, "ownerUserId"),
						input.ownerProfileId ?? null,
						nonEmpty(input.threadId, "threadId"),
						now,
						input.dispositionRef ?? null,
					);
				return {
					eventId,
					waitId: input.waitId,
					generation: input.generation,
					waitKind: current.kind,
					reason: input.reason,
					actor: input.actor,
					subjectRef: current.subjectRef,
					ownerUserId: input.ownerUserId,
					ownerProfileId: input.ownerProfileId ?? null,
					threadId: input.threadId,
					at: now,
					dispositionRef: input.dispositionRef ?? null,
				};
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	renew(input: RenewWaitInput): Wait {
		if (input.next.waitId !== input.waitId || input.next.generation !== input.generation + 1) {
			throw new ControlError("invalid_input", "renew must create the next generation of the same wait series");
		}
		return this.transaction.run(() => {
			this.terminate({
				waitId: input.waitId,
				generation: input.generation,
				reason: "auto_renew",
				actor: { kind: "system", id: "auto_renew" },
				ownerUserId: input.ownerUserId,
				ownerProfileId: input.ownerProfileId ?? null,
				threadId: input.threadId,
			});
			return this.create(input.next);
		});
	}

	consume(id: string): Wait {
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `wait ${id} not found`);
				if (current.status !== "active") throw new ControlError("invalid_state", `wait ${id} is terminated`);
				const now = this.clock();
				const result = this.database
					.prepare("UPDATE waits SET consumed_at = ? WHERE id = ? AND status = 'active'")
					.run(now, id);
				if (changesOf(result) === 0) throw new ControlError("conflict", `wait ${id} changed state`);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	listTerminations(waitId: string): WaitTermination[] {
		const rows = this.database
			.prepare("SELECT * FROM wait_terminations WHERE wait_id = ? ORDER BY generation")
			.all(waitId) as unknown as TerminationRow[];
		return rows.map(mapTermination);
	}
}
