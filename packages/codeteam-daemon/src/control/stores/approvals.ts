import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import type { AuditStore } from "./audit.ts";
import { type Clock, changesOf, jsonObject, mapStoreError, newId, nonEmpty, parseJsonObject } from "./helpers.ts";
import type {
	Approval,
	ApprovalKind,
	ApprovalListFilter,
	ApprovalResolution,
	CreateApprovalInput,
	DecideApprovalInput,
	MaterializeApprovalInput,
} from "./types.ts";

interface ApprovalRow {
	id: string;
	thread_id: string;
	task_id: string;
	kind: ApprovalKind;
	idempotency_key: string;
	origin_ref_json: string;
	card_ref_json: string;
	resolution: ApprovalResolution;
	materialization_json: string;
	effect_reservation_ref: string | null;
	effect_ref: string | null;
	payload_json: string;
	requested_by: string;
	decided_by: string | null;
	decided_at: number | null;
	decided_note: string | null;
	expires_at: number | null;
	created_at: number;
	updated_at: number;
}

function mapApproval(row: ApprovalRow): Approval {
	return {
		id: row.id,
		threadId: row.thread_id,
		taskId: row.task_id,
		kind: row.kind,
		idempotencyKey: row.idempotency_key,
		originRef: parseJsonObject(row.origin_ref_json),
		cardRef: parseJsonObject(row.card_ref_json),
		resolution: row.resolution,
		materialization: parseJsonObject(row.materialization_json),
		effectReservationRef: row.effect_reservation_ref,
		effectRef: row.effect_ref,
		payload: parseJsonObject(row.payload_json),
		requestedBy: row.requested_by,
		decidedBy: row.decided_by,
		decidedAt: row.decided_at,
		decidedNote: row.decided_note,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class ApprovalStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;
	private readonly audit: AuditStore;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock, audit: AuditStore) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
		this.audit = audit;
	}

	get(id: string): Approval | null {
		const row = this.database.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
		return row ? mapApproval(row) : null;
	}

	list(filter: ApprovalListFilter = {}): Approval[] {
		const clauses: string[] = [];
		const params: string[] = [];
		if (filter.taskId !== undefined) {
			clauses.push("task_id = ?");
			params.push(filter.taskId);
		}
		if (filter.kind !== undefined) {
			clauses.push("kind = ?");
			params.push(filter.kind);
		}
		if (filter.resolution !== undefined) {
			clauses.push("resolution = ?");
			params.push(filter.resolution);
		}
		const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.database
			.prepare(`SELECT * FROM approvals${where} ORDER BY created_at, id`)
			.all(...params) as unknown as ApprovalRow[];
		return rows.map(mapApproval);
	}

	isStale(approval: Approval, at = this.clock()): boolean {
		return approval.resolution === "open" && approval.expiresAt !== null && approval.expiresAt <= at;
	}

	create(input: CreateApprovalInput): Approval {
		const id = input.id ?? newId();
		const now = this.clock();
		const reservation = `approval-effect:${id}`;
		try {
			return this.transaction.run(() => {
				this.database
					.prepare(
						"INSERT INTO approvals (id, thread_id, task_id, kind, idempotency_key, origin_ref_json, card_ref_json, resolution, materialization_json, effect_reservation_ref, payload_json, requested_by, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', '{\"state\":\"not_started\"}', ?, ?, ?, ?, ?, ?)",
					)
					.run(
						id,
						nonEmpty(input.threadId, "threadId"),
						nonEmpty(input.taskId, "taskId"),
						input.kind,
						nonEmpty(input.idempotencyKey, "idempotencyKey"),
						jsonObject(input.originRef, "originRef"),
						jsonObject(input.cardRef, "cardRef"),
						reservation,
						jsonObject(input.payload ?? {}, "payload"),
						nonEmpty(input.requestedBy, "requestedBy"),
						input.expiresAt ?? null,
						now,
						now,
					);
				this.audit.append({
					actor: `profile:${input.requestedBy}`,
					action: "approval_requested",
					subject: `approval:${id}`,
					args: { kind: input.kind, idempotencyKey: input.idempotencyKey },
				});
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}

	decide(id: string, input: DecideApprovalInput): Approval {
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `approval ${id} not found`);
				if (current.resolution !== "open")
					throw new ControlError("invalid_state", `approval ${id} is ${current.resolution}`);
				if (this.isStale(current)) throw new ControlError("conflict", "approval_stale");
				if (input.resolution === "rejected" && (!input.note || input.note.trim() === "")) {
					throw new ControlError("invalid_input", "rejected approval requires a note");
				}
				const now = this.clock();
				const result = this.database
					.prepare(
						"UPDATE approvals SET resolution = ?, decided_by = ?, decided_at = ?, decided_note = ?, updated_at = ? WHERE id = ? AND resolution = 'open'",
					)
					.run(input.resolution, nonEmpty(input.decidedBy, "decidedBy"), now, input.note ?? null, now, id);
				if (changesOf(result) === 0) throw new ControlError("version_conflict", `approval ${id} changed state`);
				this.audit.append({
					actor: `user:${input.decidedBy}`,
					action: `approval_${input.resolution}`,
					subject: `approval:${id}`,
					args: input.note ? { note: input.note } : {},
				});
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	materialize(id: string, input: MaterializeApprovalInput): Approval {
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `approval ${id} not found`);
				if (current.resolution !== "accepted") {
					throw new ControlError("invalid_state", `approval ${id} is ${current.resolution}`);
				}
				if (input.state === "succeeded") {
					const effectRef = nonEmpty(input.effectRef ?? undefined, "effectRef");
					if (effectRef !== current.effectReservationRef) {
						throw new ControlError("conflict", "effectRef must match the reservation");
					}
				} else if (input.effectRef) {
					throw new ControlError("invalid_input", "effectRef is only valid for succeeded materialization");
				}
				const materialization: Record<string, unknown> = { state: input.state };
				if (input.failureRef) materialization.failureRef = input.failureRef;
				if (input.retryable !== undefined) materialization.retryable = input.retryable;
				const now = this.clock();
				const result = this.database
					.prepare(
						"UPDATE approvals SET materialization_json = ?, effect_ref = ?, updated_at = ? WHERE id = ? AND resolution = 'accepted'",
					)
					.run(
						jsonObject(materialization, "materialization"),
						input.state === "succeeded" ? (input.effectRef ?? null) : null,
						now,
						id,
					);
				if (changesOf(result) === 0) throw new ControlError("version_conflict", `approval ${id} changed state`);
				this.audit.append({
					actor: "system:approval",
					action: `approval_materialization_${input.state}`,
					subject: `approval:${id}`,
					args: input.failureRef ? { failureRef: input.failureRef } : {},
				});
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}
}
