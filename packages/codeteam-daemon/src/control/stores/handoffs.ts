import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import type { AuditStore } from "./audit.ts";
import {
	type Clock,
	jsonArray,
	jsonObject,
	mapStoreError,
	newId,
	nonEmpty,
	parseJsonArray,
	parseJsonObject,
} from "./helpers.ts";
import type {
	ClaimHandoffInput,
	CreateHandoffInput,
	CustodyEvent,
	CustodyEventClassification,
	CustodyEventKind,
	Handoff,
	HandoffCompletionCandidateInput,
	HandoffHolderClaim,
	HandoffListFilter,
	HandoffStatus,
} from "./types.ts";

export const DEFAULT_HANDOFF_CLAIM_LEASE_MS = 5 * 60 * 1000;

interface HandoffRow {
	id: string;
	task_id: string;
	stage_id: string | null;
	kind: Handoff["kind"];
	from_role: string;
	to_role: string;
	status: HandoffStatus;
	subject: string;
	subject_ref: string;
	action_family: Handoff["actionFamily"];
	successor_slot: Handoff["successorSlot"];
	mode: Handoff["mode"];
	parallel_intent: string | null;
	owner_user_id: string;
	canonical_action_key: string;
	holder_profile_ids_json: string;
	holder_thread_id: string;
	predecessor_profile_id: string | null;
	predecessor_thread_id: string | null;
	claim_origin: Handoff["claimOrigin"];
	issuer_standing_evidence_ref: string | null;
	generation: number;
	revision: number;
	dispatch_id: string;
	terminal_predicate_json: string;
	completion_candidates_json: string;
	holder_outcomes_json: string;
	return_transitions_json: string;
	replacement_transitions_json: string;
	terminal_actor_ref: string | null;
	terminal_reason: string | null;
	terminal_evidence_ref: string | null;
	expected_artifact: string;
	payload_json: string;
	idempotency_key: string;
	reply_to: string | null;
	deadline: number;
	attempt: number;
	claimed_by_run_id: string | null;
	claimed_at: number | null;
	claimed_lease_until: number | null;
	last_heartbeat_at: number | null;
	terminal_at: number | null;
	result_json: string | null;
	created_at: number;
}

interface ClaimRow {
	handoff_id: string;
	profile_id: string;
	generation: number;
	run_id: string;
	status: HandoffHolderClaim["status"];
	claimed_at: number;
	lease_until: number | null;
	last_heartbeat_at: number | null;
	released_at: number | null;
	release_reason: string | null;
}

interface CustodyRow {
	id: string;
	subject_ref: string;
	handoff_id: string;
	generation: number;
	seq: number;
	classification: CustodyEventClassification;
	kind: CustodyEventKind;
	actor_ref: string;
	payload_json: string;
	ts: number;
}

function optionalObject(value: string | null): Record<string, unknown> | null {
	return value ? parseJsonObject(value) : null;
}

function mapHandoff(row: HandoffRow): Handoff {
	const holderIds = parseJsonArray(row.holder_profile_ids_json);
	if (!holderIds.every((id) => typeof id === "string")) {
		throw new ControlError("invalid_input", "handoff holder profile ids must be strings");
	}
	return {
		id: row.id,
		taskId: row.task_id,
		stageId: row.stage_id,
		kind: row.kind,
		fromRole: row.from_role,
		toRole: row.to_role,
		status: row.status,
		subject: row.subject,
		subjectRef: row.subject_ref,
		actionFamily: row.action_family,
		successorSlot: row.successor_slot,
		mode: row.mode,
		parallelIntent: row.parallel_intent,
		ownerUserId: row.owner_user_id,
		canonicalActionKey: row.canonical_action_key,
		holderProfileIds: holderIds as string[],
		holderThreadId: row.holder_thread_id,
		predecessorProfileId: row.predecessor_profile_id,
		predecessorThreadId: row.predecessor_thread_id,
		claimOrigin: row.claim_origin,
		issuerStandingEvidenceRef: row.issuer_standing_evidence_ref,
		generation: row.generation,
		revision: row.revision,
		dispatchId: row.dispatch_id,
		terminalPredicate: parseJsonObject(row.terminal_predicate_json),
		completionCandidates: parseJsonObject(row.completion_candidates_json),
		holderOutcomes: parseJsonObject(row.holder_outcomes_json),
		returnTransitions: parseJsonArray(row.return_transitions_json),
		replacementTransitions: parseJsonArray(row.replacement_transitions_json),
		terminalActorRef: row.terminal_actor_ref,
		terminalReason: row.terminal_reason,
		terminalEvidenceRef: row.terminal_evidence_ref,
		expectedArtifact: row.expected_artifact,
		payload: parseJsonObject(row.payload_json),
		idempotencyKey: row.idempotency_key,
		replyTo: row.reply_to,
		deadline: row.deadline,
		attempt: row.attempt,
		claimedByRunId: row.claimed_by_run_id,
		claimedAt: row.claimed_at,
		claimedLeaseUntil: row.claimed_lease_until,
		lastHeartbeatAt: row.last_heartbeat_at,
		terminalAt: row.terminal_at,
		result: optionalObject(row.result_json),
		createdAt: row.created_at,
	};
}

function mapClaim(row: ClaimRow): HandoffHolderClaim {
	return {
		handoffId: row.handoff_id,
		profileId: row.profile_id,
		generation: row.generation,
		runId: row.run_id,
		status: row.status,
		claimedAt: row.claimed_at,
		leaseUntil: row.lease_until,
		lastHeartbeatAt: row.last_heartbeat_at,
		releasedAt: row.released_at,
		releaseReason: row.release_reason,
	};
}

function mapCustody(row: CustodyRow): CustodyEvent {
	return {
		id: row.id,
		subjectRef: row.subject_ref,
		handoffId: row.handoff_id,
		generation: row.generation,
		seq: row.seq,
		classification: row.classification,
		kind: row.kind,
		actorRef: row.actor_ref,
		payload: parseJsonObject(row.payload_json),
		ts: row.ts,
	};
}

export class HandoffStore {
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

	get(id: string): Handoff | null {
		const row = this.database.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as HandoffRow | undefined;
		return row ? mapHandoff(row) : null;
	}

	list(filter: HandoffListFilter = {}): Handoff[] {
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
		if (filter.actionFamily !== undefined) {
			clauses.push("action_family = ?");
			params.push(filter.actionFamily);
		}
		const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.database
			.prepare(`SELECT * FROM handoffs${where} ORDER BY created_at, id`)
			.all(...params) as unknown as HandoffRow[];
		return rows.map(mapHandoff);
	}

	create(input: CreateHandoffInput): Handoff {
		const holders = [...new Set(input.holderProfileIds)];
		if (holders.length !== input.holderProfileIds.length || holders.length === 0) {
			throw new ControlError("invalid_input", "handoff holder profiles must be non-empty and unique");
		}
		if (input.mode === "single" && holders.length !== 1) {
			throw new ControlError("invalid_input", "single handoff requires exactly one holder");
		}
		if (input.mode === "parallel" && holders.length < 2) {
			throw new ControlError("invalid_input", "parallel handoff requires at least two holders");
		}
		const id = input.id ?? newId();
		const now = this.clock();
		try {
			return this.transaction.run(() => {
				this.database
					.prepare(
						"INSERT INTO handoffs (id, task_id, stage_id, kind, from_role, to_role, status, subject, subject_ref, action_family, successor_slot, mode, parallel_intent, owner_user_id, canonical_action_key, holder_profile_ids_json, holder_thread_id, predecessor_profile_id, predecessor_thread_id, claim_origin, issuer_standing_evidence_ref, generation, revision, dispatch_id, terminal_predicate_json, completion_candidates_json, holder_outcomes_json, return_transitions_json, replacement_transitions_json, expected_artifact, payload_json, idempotency_key, reply_to, deadline, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, '{}', '{}', '[]', '[]', ?, ?, ?, ?, ?, 1, ?)",
					)
					.run(
						id,
						nonEmpty(input.taskId, "taskId"),
						input.stageId ?? null,
						input.kind,
						nonEmpty(input.fromRole, "fromRole"),
						nonEmpty(input.toRole, "toRole"),
						nonEmpty(input.subject, "subject"),
						nonEmpty(input.subjectRef, "subjectRef"),
						input.actionFamily,
						input.successorSlot,
						input.mode,
						input.parallelIntent ?? null,
						nonEmpty(input.ownerUserId, "ownerUserId"),
						nonEmpty(input.canonicalActionKey, "canonicalActionKey"),
						jsonArray(holders, "holderProfileIds"),
						nonEmpty(input.holderThreadId, "holderThreadId"),
						input.predecessorProfileId ?? null,
						input.predecessorThreadId ?? null,
						input.claimOrigin,
						input.issuerStandingEvidenceRef ?? null,
						nonEmpty(input.dispatchId, "dispatchId"),
						jsonObject(input.terminalPredicate, "terminalPredicate"),
						nonEmpty(input.expectedArtifact, "expectedArtifact"),
						jsonObject(input.payload, "payload"),
						nonEmpty(input.idempotencyKey, "idempotencyKey"),
						input.replyTo ?? null,
						input.deadline,
						now,
					);
				this.appendCustodyEvent({
					handoffId: id,
					subjectRef: input.subjectRef,
					generation: 1,
					classification: "state-changing",
					kind: "handoff.created",
					actorRef: `user:${input.ownerUserId}`,
					payload: { actionFamily: input.actionFamily, holderProfileIds: holders },
				});
				this.audit.append({
					actor: `user:${input.ownerUserId}`,
					action: "handoff_created",
					subject: `handoff:${id}`,
					args: { actionFamily: input.actionFamily, successorSlot: input.successorSlot },
				});
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}

	claim(input: ClaimHandoffInput): Handoff {
		const leaseMs = input.leaseMs ?? DEFAULT_HANDOFF_CLAIM_LEASE_MS;
		if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
			throw new ControlError("invalid_input", "leaseMs must be a positive integer");
		}
		try {
			return this.transaction.run(() => {
				const current = this.require(input.handoffId);
				if (current.status !== "pending" && current.status !== "claimed") {
					throw new ControlError("invalid_state", `handoff ${current.id} is ${current.status}`);
				}
				if (!current.holderProfileIds.includes(input.profileId)) {
					throw new ControlError("invalid_input", `profile ${input.profileId} is not a handoff holder`);
				}
				const run = this.database.prepare("SELECT status FROM runs WHERE id = ?").get(input.runId) as
					| { status?: string }
					| undefined;
				if (!run || run.status !== "running") {
					throw new ControlError("invalid_input", `run ${input.runId} is not running`);
				}
				const existing = this.getClaim(current.id, input.profileId, current.generation);
				if (existing?.status === "active") {
					if (existing.runId === input.runId) return current;
					throw new ControlError("claim_conflict", `handoff ${current.id} is already claimed by this holder`);
				}
				if (current.mode === "single") {
					const other = this.database
						.prepare(
							"SELECT profile_id FROM handoff_holder_claims WHERE handoff_id = ? AND generation = ? AND status = 'active' AND profile_id <> ?",
						)
						.get(current.id, current.generation, input.profileId) as { profile_id?: string } | undefined;
					if (other?.profile_id) {
						throw new ControlError("claim_conflict", `handoff ${current.id} is held by ${other.profile_id}`);
					}
				}
				const now = this.clock();
				const leaseUntil = now + leaseMs;
				if (existing) {
					this.database
						.prepare(
							"UPDATE handoff_holder_claims SET run_id = ?, status = 'active', claimed_at = ?, lease_until = ?, last_heartbeat_at = ?, released_at = NULL, release_reason = NULL WHERE handoff_id = ? AND profile_id = ? AND generation = ?",
						)
						.run(input.runId, now, leaseUntil, now, current.id, input.profileId, current.generation);
				} else {
					this.database
						.prepare(
							"INSERT INTO handoff_holder_claims (handoff_id, profile_id, generation, run_id, status, claimed_at, lease_until, last_heartbeat_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)",
						)
						.run(current.id, input.profileId, current.generation, input.runId, now, leaseUntil, now);
				}
				this.database
					.prepare(
						"UPDATE handoffs SET status = 'claimed', claimed_by_run_id = ?, claimed_at = ?, claimed_lease_until = ?, last_heartbeat_at = ?, revision = revision + 1 WHERE id = ?",
					)
					.run(input.runId, now, leaseUntil, now, current.id);
				this.appendCustodyEvent({
					handoffId: current.id,
					subjectRef: current.subjectRef,
					generation: current.generation,
					classification: "state-changing",
					kind: "handoff.claimed",
					actorRef: `profile:${input.profileId}`,
					payload: { runId: input.runId, leaseUntil },
				});
				this.audit.append({
					actor: `profile:${input.profileId}`,
					action: "handoff_claimed",
					subject: `handoff:${current.id}`,
					args: { runId: input.runId },
				});
				return this.get(current.id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	heartbeat(handoffId: string, profileId: string, runId: string, leaseMs = DEFAULT_HANDOFF_CLAIM_LEASE_MS): Handoff {
		try {
			return this.transaction.run(() => {
				const current = this.require(handoffId);
				const claim = this.getClaim(handoffId, profileId, current.generation);
				if (!claim || claim.status !== "active" || claim.runId !== runId) {
					throw new ControlError("claim_conflict", `handoff ${handoffId} is not claimed by ${runId}`);
				}
				const now = this.clock();
				const leaseUntil = now + leaseMs;
				this.database
					.prepare(
						"UPDATE handoff_holder_claims SET lease_until = ?, last_heartbeat_at = ? WHERE handoff_id = ? AND profile_id = ? AND generation = ?",
					)
					.run(leaseUntil, now, handoffId, profileId, current.generation);
				this.database
					.prepare(
						"UPDATE handoffs SET claimed_lease_until = ?, last_heartbeat_at = ?, revision = revision + 1 WHERE id = ?",
					)
					.run(leaseUntil, now, handoffId);
				return this.get(handoffId)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	recordCompletionCandidate(input: HandoffCompletionCandidateInput): Handoff {
		try {
			return this.transaction.run(() => {
				const current = this.require(input.handoffId);
				if (current.status !== "claimed") {
					throw new ControlError("invalid_state", `handoff ${input.handoffId} is ${current.status}`);
				}
				const claim = this.getClaim(input.handoffId, input.profileId, current.generation);
				if (!claim || claim.status !== "active" || claim.runId !== input.runId) {
					throw new ControlError("claim_conflict", `handoff ${input.handoffId} is not claimed by ${input.runId}`);
				}
				const candidates = { ...current.completionCandidates };
				candidates[input.runId] = {
					runId: input.runId,
					profileId: input.profileId,
					evidenceRef: input.evidenceRef,
					result: input.result,
					at: this.clock(),
				};
				this.database
					.prepare("UPDATE handoffs SET completion_candidates_json = ?, revision = revision + 1 WHERE id = ?")
					.run(jsonObject(candidates, "completionCandidates"), current.id);
				this.appendCustodyEvent({
					handoffId: current.id,
					subjectRef: current.subjectRef,
					generation: current.generation,
					classification: "state-changing",
					kind: "handoff.completion_candidate",
					actorRef: `profile:${input.profileId}`,
					payload: { runId: input.runId, evidenceRef: input.evidenceRef },
				});
				this.audit.append({
					actor: `profile:${input.profileId}`,
					action: "handoff_completion_candidate",
					subject: `handoff:${current.id}`,
					args: { runId: input.runId, evidenceRef: input.evidenceRef },
				});
				return this.get(current.id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	commitCompletion(input: HandoffCompletionCandidateInput): Handoff {
		if (input.verified !== true) {
			throw new ControlError("invalid_input", "handoff completion requires verified evidence");
		}
		try {
			return this.transaction.run(() => {
				const current = this.require(input.handoffId);
				if (current.status !== "claimed") {
					throw new ControlError("invalid_state", `handoff ${input.handoffId} is ${current.status}`);
				}
				const candidate = current.completionCandidates[input.runId] as Record<string, unknown> | undefined;
				if (!candidate) {
					throw new ControlError("invalid_state", "handoff has no completion candidate for this run");
				}
				const now = this.clock();
				const outcomes = { ...current.holderOutcomes };
				outcomes[input.profileId] = { outcome: "succeeded", evidenceRef: input.evidenceRef, at: now };
				this.database
					.prepare(
						"UPDATE handoffs SET status = 'consumed', terminal_at = ?, terminal_actor_ref = ?, terminal_reason = 'completed', terminal_evidence_ref = ?, holder_outcomes_json = ?, result_json = ?, revision = revision + 1 WHERE id = ?",
					)
					.run(
						now,
						`profile:${input.profileId}`,
						input.evidenceRef,
						jsonObject(outcomes, "holderOutcomes"),
						jsonObject(input.result, "result"),
						current.id,
					);
				this.releaseActiveClaims(current.id, current.generation, "handoff_completed");
				this.appendCustodyEvent({
					handoffId: current.id,
					subjectRef: current.subjectRef,
					generation: current.generation,
					classification: "state-changing",
					kind: "handoff.completed",
					actorRef: `profile:${input.profileId}`,
					payload: { runId: input.runId, evidenceRef: input.evidenceRef },
				});
				this.audit.append({
					actor: `profile:${input.profileId}`,
					action: "handoff_completed",
					subject: `handoff:${current.id}`,
					args: { runId: input.runId, evidenceRef: input.evidenceRef },
				});
				return this.get(current.id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	withdraw(handoffId: string, actorRef: string, reason: string): Handoff {
		return this.terminateWith(handoffId, "withdrawn", "handoff.withdrawn", actorRef, reason);
	}

	expire(handoffId: string, actorRef: string, reason: string): Handoff {
		return this.terminateWith(handoffId, "expired", "handoff.expired", actorRef, reason);
	}

	releaseClaim(handoffId: string, profileId: string, reason: string): Handoff {
		try {
			return this.transaction.run(() => {
				const current = this.require(handoffId);
				const claim = this.getClaim(handoffId, profileId, current.generation);
				if (!claim || claim.status !== "active") {
					throw new ControlError("claim_conflict", `handoff ${handoffId} has no active claim for ${profileId}`);
				}
				const now = this.clock();
				this.database
					.prepare(
						"UPDATE handoff_holder_claims SET status = 'released', released_at = ?, release_reason = ?, lease_until = NULL WHERE handoff_id = ? AND profile_id = ? AND generation = ?",
					)
					.run(now, reason, handoffId, profileId, current.generation);
				const active = this.activeClaimCount(handoffId, current.generation);
				if (active === 0) {
					this.database
						.prepare(
							"UPDATE handoffs SET status = 'pending', claimed_by_run_id = NULL, claimed_at = NULL, claimed_lease_until = NULL, last_heartbeat_at = NULL, revision = revision + 1 WHERE id = ?",
						)
						.run(handoffId);
				}
				this.appendCustodyEvent({
					handoffId,
					subjectRef: current.subjectRef,
					generation: current.generation,
					classification: "state-changing",
					kind: "handoff.returned",
					actorRef: `profile:${profileId}`,
					payload: { reason },
				});
				this.audit.append({
					actor: `profile:${profileId}`,
					action: "handoff_claim_released",
					subject: `handoff:${handoffId}`,
					args: { reason },
				});
				return this.get(handoffId)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	listClaims(handoffId: string): HandoffHolderClaim[] {
		const rows = this.database
			.prepare("SELECT * FROM handoff_holder_claims WHERE handoff_id = ? ORDER BY profile_id")
			.all(handoffId) as unknown as ClaimRow[];
		return rows.map(mapClaim);
	}

	custodyEvents(handoffId: string): CustodyEvent[] {
		const rows = this.database
			.prepare("SELECT * FROM custody_events WHERE handoff_id = ? ORDER BY generation, seq")
			.all(handoffId) as unknown as CustodyRow[];
		return rows.map(mapCustody);
	}

	private terminateWith(
		handoffId: string,
		status: "withdrawn" | "expired",
		kind: "handoff.withdrawn" | "handoff.expired",
		actorRef: string,
		reason: string,
	): Handoff {
		try {
			return this.transaction.run(() => {
				const current = this.require(handoffId);
				if (current.status !== "pending" && current.status !== "claimed") {
					throw new ControlError("invalid_state", `handoff ${handoffId} is ${current.status}`);
				}
				const now = this.clock();
				this.database
					.prepare(
						"UPDATE handoffs SET status = ?, terminal_at = ?, terminal_actor_ref = ?, terminal_reason = ?, revision = revision + 1 WHERE id = ?",
					)
					.run(status, now, actorRef, reason, handoffId);
				this.releaseActiveClaims(handoffId, current.generation, status);
				this.appendCustodyEvent({
					handoffId,
					subjectRef: current.subjectRef,
					generation: current.generation,
					classification: "state-changing",
					kind,
					actorRef,
					payload: { reason },
				});
				this.audit.append({
					actor: actorRef,
					action: status === "withdrawn" ? "handoff_withdrawn" : "handoff_expired",
					subject: `handoff:${handoffId}`,
					args: { reason },
				});
				return this.get(handoffId)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	private releaseActiveClaims(handoffId: string, generation: number, reason: string): void {
		const now = this.clock();
		this.database
			.prepare(
				"UPDATE handoff_holder_claims SET status = 'released', released_at = ?, release_reason = ?, lease_until = NULL WHERE handoff_id = ? AND generation = ? AND status = 'active'",
			)
			.run(now, reason, handoffId, generation);
	}

	private activeClaimCount(handoffId: string, generation: number): number {
		const row = this.database
			.prepare(
				"SELECT COUNT(*) AS count FROM handoff_holder_claims WHERE handoff_id = ? AND generation = ? AND status = 'active'",
			)
			.get(handoffId, generation) as { count?: number } | undefined;
		return row?.count ?? 0;
	}

	private getClaim(handoffId: string, profileId: string, generation: number): HandoffHolderClaim | null {
		const row = this.database
			.prepare("SELECT * FROM handoff_holder_claims WHERE handoff_id = ? AND profile_id = ? AND generation = ?")
			.get(handoffId, profileId, generation) as ClaimRow | undefined;
		return row ? mapClaim(row) : null;
	}

	private appendCustodyEvent(input: {
		handoffId: string;
		subjectRef: string;
		generation: number;
		classification: CustodyEventClassification;
		kind: CustodyEventKind;
		actorRef: string;
		payload: Record<string, unknown>;
	}): CustodyEvent {
		const row = this.database
			.prepare(
				"SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM custody_events WHERE handoff_id = ? AND generation = ?",
			)
			.get(input.handoffId, input.generation) as { next: number };
		const id = newId();
		const ts = this.clock();
		this.database
			.prepare(
				"INSERT INTO custody_events (id, subject_ref, handoff_id, generation, seq, classification, kind, actor_ref, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				id,
				input.subjectRef,
				input.handoffId,
				input.generation,
				row.next,
				input.classification,
				input.kind,
				input.actorRef,
				jsonObject(input.payload, "payload"),
				ts,
			);
		return {
			id,
			subjectRef: input.subjectRef,
			handoffId: input.handoffId,
			generation: input.generation,
			seq: row.next,
			classification: input.classification,
			kind: input.kind,
			actorRef: input.actorRef,
			payload: input.payload,
			ts,
		};
	}

	private require(id: string): Handoff {
		const current = this.get(id);
		if (!current) throw new ControlError("not_found", `handoff ${id} not found`);
		return current;
	}
}
