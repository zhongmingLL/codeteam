import { createHash } from "node:crypto";
import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import { newId } from "../control/stores/helpers.ts";
import type { Eval, Message } from "../control/stores/types.ts";
import {
	EVAL_CASE_ID_PATTERN,
	EVAL_LIFECYCLE_ACTOR_KINDS,
	EVAL_LIFECYCLE_EVENT_TYPES,
	type EvalCaseListItem,
	type EvalCaseProjection,
	type EvalDomainSla,
	type EvalLifecycleActor,
	type EvalLifecycleActorKind,
	type EvalLifecycleEvent,
	type EvalLifecycleEventType,
	type EvalLifecycleStatus,
	type EvalVerdictKind,
	type EvalVerdictMetricsV1,
	TERMINAL_EVAL_STATUSES,
} from "./contract.ts";
import { assertNoEvalSecrets } from "./redaction.ts";

interface LifecycleEventRow {
	event_id: string;
	case_id: string;
	seq: number;
	verdict_id: string;
	domain_id: string;
	type: EvalLifecycleEventType;
	actor_kind: EvalLifecycleActorKind;
	actor_id: string;
	reason: string;
	refs_json: string;
	created_at: number;
}

export interface AppendEvalLifecycleEventInput {
	readonly eventId?: string;
	readonly verdictId?: string;
	readonly caseId?: string;
	readonly expectedSequence?: number;
	readonly type: Exclude<EvalLifecycleEventType, "verdict_opened">;
	readonly actor: EvalLifecycleActor;
	readonly reason: string;
	readonly refs?: readonly string[];
	readonly createdAt?: number;
}

export interface AppendEvalLifecycleEventResult {
	readonly event: EvalLifecycleEvent;
	readonly replayed: boolean;
}

export interface EvalCaseListFilter {
	readonly domainId?: string;
	readonly status?: EvalLifecycleStatus;
	readonly openOnly?: boolean;
	readonly overdueOnly?: boolean;
	readonly limit?: number;
	readonly now?: number;
}

const HOUR_MS = 60 * 60 * 1000;

const ALLOWED_FROM: Readonly<Record<EvalLifecycleEventType, readonly EvalLifecycleStatus[] | "any_non_terminal">> = {
	verdict_opened: [],
	owner_acknowledged: ["open", "escalated"],
	action_planned: ["open", "acknowledged"],
	fix_landed: ["action_planned"],
	reeval_requested: ["fix_landed"],
	reeval_passed: ["reeval_pending"],
	reeval_failed: ["reeval_pending"],
	escalated: ["open", "acknowledged", "action_planned", "fix_landed", "reeval_pending"],
	cvo_suppressed: "any_non_terminal",
	sunset_accepted: "any_non_terminal",
	resolved: ["monitoring", "escalated"],
};

const ACTOR_RULES: Readonly<Record<EvalLifecycleEventType, readonly EvalLifecycleActorKind[]>> = {
	verdict_opened: ["eval"],
	owner_acknowledged: ["owner"],
	action_planned: ["owner"],
	fix_landed: ["owner"],
	reeval_requested: ["owner"],
	reeval_passed: ["eval"],
	reeval_failed: ["eval"],
	escalated: ["operator", "system"],
	cvo_suppressed: ["operator"],
	sunset_accepted: ["operator"],
	resolved: ["operator", "system"],
};

export function deriveEvalCaseId(domainId: string, findingKey: string): string {
	const digest = createHash("sha256").update(`${domainId}\u001f${findingKey}`, "utf8").digest("hex");
	return `eval-case-v1-${digest}`;
}

function nonEmpty(value: string | undefined, label: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new ControlError("invalid_input", `${label} must be a non-empty string`);
	}
	return value.trim();
}

function normalizeRefs(refs: readonly string[] | undefined): string[] {
	const normalized = (refs ?? []).map((ref) => ref.trim());
	if (normalized.some((ref) => ref === "")) {
		throw new ControlError("invalid_input", "lifecycle refs must not contain empty values");
	}
	return [...new Set(normalized)];
}

function mapEvent(row: LifecycleEventRow): EvalLifecycleEvent {
	return {
		eventId: row.event_id,
		caseId: row.case_id,
		seq: row.seq,
		verdictId: row.verdict_id,
		domainId: row.domain_id,
		type: row.type,
		actor: { kind: row.actor_kind, id: row.actor_id },
		reason: row.reason,
		refs: JSON.parse(row.refs_json) as string[],
		createdAt: row.created_at,
	};
}

function listEvents(store: ControlStore, caseId: string): EvalLifecycleEvent[] {
	const rows = store.database
		.prepare("SELECT * FROM eval_lifecycle_events WHERE case_id = ? ORDER BY seq")
		.all(caseId) as unknown as LifecycleEventRow[];
	return rows.map(mapEvent);
}

function getEventById(store: ControlStore, eventId: string): EvalLifecycleEvent | null {
	const row = store.database.prepare("SELECT * FROM eval_lifecycle_events WHERE event_id = ?").get(eventId) as
		| LifecycleEventRow
		| undefined;
	return row ? mapEvent(row) : null;
}

export function readEvalVerdictMetrics(record: Eval): EvalVerdictMetricsV1 {
	const metrics = record.metrics as unknown as EvalVerdictMetricsV1;
	if (!metrics || metrics.kind !== "eval_verdict" || metrics.v !== 1) {
		throw new ControlError("invalid_state", `eval ${record.id} is not an eval verdict`);
	}
	if (!record.domainId) {
		throw new ControlError("invalid_state", `eval verdict ${record.id} has no domain_id`);
	}
	if (!metrics.packet || metrics.packet.id !== record.id) {
		throw new ControlError("invalid_state", `eval verdict ${record.id} has an inconsistent packet`);
	}
	return metrics;
}

interface VerdictContext {
	readonly record: Eval;
	readonly metrics: EvalVerdictMetricsV1;
	readonly verdict: EvalVerdictKind;
	readonly domainId: string;
	readonly findingKey: string;
	readonly caseId: string;
	readonly sla: EvalDomainSla;
}

function resolveVerdictContext(store: ControlStore, input: { caseId?: string; verdictId?: string }): VerdictContext {
	let record: Eval | null = null;
	if (input.verdictId) record = store.evals.get(nonEmpty(input.verdictId, "verdictId"));
	if (!record && input.caseId) {
		const first = store.database
			.prepare("SELECT verdict_id FROM eval_lifecycle_events WHERE case_id = ? ORDER BY seq LIMIT 1")
			.get(nonEmpty(input.caseId, "caseId")) as { verdict_id?: string } | undefined;
		if (first?.verdict_id) record = store.evals.get(first.verdict_id);
	}
	if (!record) throw new ControlError("not_found", "eval verdict case not found");
	const metrics = readEvalVerdictMetrics(record);
	const findingKey = metrics.findingKey;
	if (!findingKey) throw new ControlError("invalid_state", "eval verdict has no findingKey and no lifecycle case");
	const caseId = deriveEvalCaseId(record.domainId!, findingKey);
	if (input.caseId && input.caseId !== caseId) {
		throw new ControlError("invalid_input", "caseId does not match the verdict findingKey identity");
	}
	if (!EVAL_CASE_ID_PATTERN.test(caseId)) {
		throw new ControlError("invalid_state", "derived eval caseId is invalid");
	}
	return {
		record,
		metrics,
		verdict: metrics.packet.verdict,
		domainId: record.domainId!,
		findingKey,
		caseId,
		sla: metrics.sla,
	};
}

function statusAfterEvent(type: EvalLifecycleEventType): EvalLifecycleStatus {
	switch (type) {
		case "verdict_opened":
			return "open";
		case "owner_acknowledged":
			return "acknowledged";
		case "action_planned":
			return "action_planned";
		case "fix_landed":
			return "fix_landed";
		case "reeval_requested":
			return "reeval_pending";
		case "reeval_passed":
			return "monitoring";
		case "reeval_failed":
			return "open";
		case "escalated":
			return "escalated";
		case "cvo_suppressed":
			return "suppressed_with_reason";
		case "sunset_accepted":
			return "resolved";
		case "resolved":
			return "resolved";
	}
}

function assertActorAllowed(context: VerdictContext, type: EvalLifecycleEventType, actor: EvalLifecycleActor): void {
	const allowed = ACTOR_RULES[type];
	if (!allowed.includes(actor.kind)) {
		throw new ControlError("forbidden", `${type} requires actor kind ${allowed.join(" or ")}, got ${actor.kind}`);
	}
	if (type === "verdict_opened" || type === "reeval_passed" || type === "reeval_failed") {
		if (actor.id !== context.metrics.evalAgent) {
			throw new ControlError(
				"forbidden",
				`${type} actor must be the domain eval agent ${context.metrics.evalAgent}`,
			);
		}
	}
	if (
		type === "owner_acknowledged" ||
		type === "action_planned" ||
		type === "fix_landed" ||
		type === "reeval_requested"
	) {
		const owner = context.metrics.packet.ownerAsk.targetOwnerProfileId;
		if (actor.id !== owner) {
			throw new ControlError("forbidden", `${type} actor must be the verdict owner ${owner}`);
		}
	}
}

function assertTransition(context: VerdictContext, status: EvalLifecycleStatus, type: EvalLifecycleEventType): void {
	if (TERMINAL_EVAL_STATUSES.includes(status)) {
		throw new ControlError("invalid_state", `illegal transition: ${type} cannot follow terminal status ${status}`);
	}
	if (type === "sunset_accepted" && context.verdict !== "delete_sunset") {
		throw new ControlError("invalid_state", "sunset_accepted requires a delete_sunset verdict");
	}
	if (type === "cvo_suppressed" || type === "sunset_accepted") return;
	const allowed = ALLOWED_FROM[type];
	if (allowed === "any_non_terminal") return;
	if (!Array.isArray(allowed) || !allowed.includes(status)) {
		throw new ControlError("invalid_state", `illegal transition: ${type} cannot follow ${status}`);
	}
}

function projectStatus(events: readonly EvalLifecycleEvent[]): EvalLifecycleStatus {
	if (events.length === 0) throw new ControlError("not_found", "eval case has no lifecycle events");
	if (events[0]!.type !== "verdict_opened") {
		throw new ControlError("invalid_state", "eval lifecycle must start with verdict_opened");
	}
	let status: EvalLifecycleStatus = "open";
	for (const [index, event] of events.entries()) {
		if (event.seq !== index + 1) {
			throw new ControlError("invalid_state", `eval lifecycle seq gap at ${event.eventId}`);
		}
		if (index === 0) continue;
		status = statusAfterEvent(event.type);
	}
	return status;
}

function isOverdue(status: EvalLifecycleStatus, createdAt: number, sla: EvalDomainSla, now: number): boolean {
	if (TERMINAL_EVAL_STATUSES.includes(status)) return false;
	if (status === "escalated") return true;
	const ackDeadline = createdAt + sla.acknowledgementHours * HOUR_MS;
	const reevalDeadline = createdAt + sla.reevaluationHours * HOUR_MS;
	if (status === "open" || status === "acknowledged") return now > ackDeadline;
	return now > reevalDeadline;
}

export function projectEvalCase(options: {
	readonly context: VerdictContext;
	readonly events: readonly EvalLifecycleEvent[];
	readonly now: number;
}): EvalCaseProjection {
	const { context, events, now } = options;
	const status = projectStatus(events);
	const lastEvent = events.at(-1)!;
	const awaitingSunsetDecision = context.verdict === "delete_sunset" && !TERMINAL_EVAL_STATUSES.includes(status);
	return {
		caseId: context.caseId,
		verdictId: context.record.id,
		domainId: context.domainId,
		findingKey: context.findingKey,
		verdict: context.verdict,
		status,
		awaitingSunsetDecision,
		overdue: isOverdue(status, context.record.createdAt, context.sla, now),
		lastEventAt: lastEvent.createdAt,
		nextSequence: events.length + 1,
		createdAt: context.record.createdAt,
		sla: context.sla,
		events,
	};
}

export function getEvalCase(store: ControlStore, caseId: string, now = Date.now()): EvalCaseProjection {
	const id = nonEmpty(caseId, "caseId");
	const events = listEvents(store, id);
	if (events.length === 0) throw new ControlError("not_found", `eval case ${id} not found`);
	const context = resolveVerdictContext(store, { caseId: id });
	return projectEvalCase({ context, events, now });
}

export function listEvalCases(store: ControlStore, filter: EvalCaseListFilter = {}): EvalCaseListItem[] {
	const rows = store.database
		.prepare(
			"SELECT case_id, MAX(created_at) AS last_at FROM eval_lifecycle_events GROUP BY case_id ORDER BY last_at DESC, case_id",
		)
		.all() as unknown as { case_id: string; last_at: number }[];
	const now = filter.now ?? Date.now();
	const items: EvalCaseListItem[] = [];
	for (const row of rows) {
		let projection: EvalCaseProjection;
		try {
			projection = getEvalCase(store, row.case_id, now);
		} catch (error) {
			if (error instanceof ControlError && error.code === "not_found") continue;
			throw error;
		}
		if (filter.domainId && projection.domainId !== filter.domainId) continue;
		if (filter.status && projection.status !== filter.status) continue;
		if (filter.openOnly && TERMINAL_EVAL_STATUSES.includes(projection.status)) continue;
		if (filter.overdueOnly && !projection.overdue) continue;
		items.push({
			caseId: projection.caseId,
			verdictId: projection.verdictId,
			domainId: projection.domainId,
			findingKey: projection.findingKey,
			verdict: projection.verdict,
			status: projection.status,
			awaitingSunsetDecision: projection.awaitingSunsetDecision,
			overdue: projection.overdue,
			createdAt: projection.createdAt,
			lastEventAt: projection.lastEventAt,
		});
		if (items.length >= (filter.limit ?? 500)) break;
	}
	return items;
}

function assertSameEvent(
	existing: EvalLifecycleEvent,
	input: {
		readonly caseId: string;
		readonly verdictId: string;
		readonly domainId: string;
		readonly type: EvalLifecycleEventType;
		readonly actor: EvalLifecycleActor;
		readonly reason: string;
		readonly refs: readonly string[];
	},
): boolean {
	return (
		existing.caseId === input.caseId &&
		existing.verdictId === input.verdictId &&
		existing.domainId === input.domainId &&
		existing.type === input.type &&
		existing.actor.kind === input.actor.kind &&
		existing.actor.id === input.actor.id &&
		existing.reason === input.reason &&
		existing.refs.length === input.refs.length &&
		existing.refs.every((ref, index) => ref === input.refs[index])
	);
}

function insertEvent(options: {
	readonly store: ControlStore;
	readonly context: VerdictContext;
	readonly eventId: string;
	readonly type: EvalLifecycleEventType;
	readonly actor: EvalLifecycleActor;
	readonly reason: string;
	readonly refs: readonly string[];
	readonly expectedSequence?: number;
	readonly createdAt: number;
	readonly enforceTransition: boolean;
}): EvalLifecycleEvent {
	const events = listEvents(options.store, options.context.caseId);
	const nextSequence = events.length + 1;
	if (options.expectedSequence !== undefined && options.expectedSequence !== events.length) {
		throw new ControlError(
			"version_conflict",
			`expected eval case sequence ${options.expectedSequence}, current sequence is ${events.length}`,
		);
	}
	if (options.enforceTransition) {
		const status = projectStatus(events);
		assertTransition(options.context, status, options.type);
	} else if (events.length > 0) {
		throw new ControlError("invalid_state", "verdict_opened is only valid as the first lifecycle event");
	}
	assertActorAllowed(options.context, options.type, options.actor);
	const row: LifecycleEventRow = {
		event_id: options.eventId,
		case_id: options.context.caseId,
		seq: nextSequence,
		verdict_id: options.context.record.id,
		domain_id: options.context.domainId,
		type: options.type,
		actor_kind: options.actor.kind,
		actor_id: options.actor.id,
		reason: options.reason,
		refs_json: JSON.stringify(options.refs),
		created_at: options.createdAt,
	};
	try {
		options.store.database
			.prepare(
				"INSERT INTO eval_lifecycle_events (event_id, case_id, seq, verdict_id, domain_id, type, actor_kind, actor_id, reason, refs_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				row.event_id,
				row.case_id,
				row.seq,
				row.verdict_id,
				row.domain_id,
				row.type,
				row.actor_kind,
				row.actor_id,
				row.reason,
				row.refs_json,
				row.created_at,
			);
	} catch (error) {
		throw new ControlError("conflict", `cannot append eval lifecycle event ${options.eventId}`, { cause: error });
	}
	return mapEvent(row);
}

export function appendEvalLifecycleEvent(
	store: ControlStore,
	input: AppendEvalLifecycleEventInput,
	now = Date.now,
): AppendEvalLifecycleEventResult {
	if (!EVAL_LIFECYCLE_EVENT_TYPES.includes(input.type)) {
		throw new ControlError("invalid_input", `unknown eval lifecycle event ${String(input.type)}`);
	}
	if (!EVAL_LIFECYCLE_ACTOR_KINDS.includes(input.actor.kind)) {
		throw new ControlError("invalid_input", `unknown eval lifecycle actor kind ${String(input.actor.kind)}`);
	}
	const reason = nonEmpty(input.reason, "reason");
	const refs = normalizeRefs(input.refs);
	assertNoEvalSecrets({ reason, refs }, "eval_lifecycle_event");
	const eventId = input.eventId ? nonEmpty(input.eventId, "eventId") : newId();
	const createdAt = input.createdAt ?? now();
	return store.transaction.run(() => {
		const context = resolveVerdictContext(store, { caseId: input.caseId, verdictId: input.verdictId });
		const existing = getEventById(store, eventId);
		if (existing) {
			const same = assertSameEvent(existing, {
				caseId: context.caseId,
				verdictId: context.record.id,
				domainId: context.domainId,
				type: input.type,
				actor: { kind: input.actor.kind, id: nonEmpty(input.actor.id, "actor.id") },
				reason,
				refs,
			});
			if (!same) {
				throw new ControlError("conflict", `eval lifecycle event ${eventId} already exists with different content`);
			}
			return { event: existing, replayed: true };
		}
		const actor = { kind: input.actor.kind, id: nonEmpty(input.actor.id, "actor.id") };
		const event = insertEvent({
			store,
			context,
			eventId,
			type: input.type,
			actor,
			reason,
			refs,
			expectedSequence: input.expectedSequence,
			createdAt,
			enforceTransition: true,
		});
		return { event, replayed: false };
	});
}

export interface AppendVerdictOpenedInput {
	readonly verdictId: string;
	readonly eventId: string;
	readonly actor: EvalLifecycleActor;
	readonly refs?: readonly string[];
	readonly createdAt?: number;
}

/**
 * Internal publish seam. Public callers cannot open arbitrary cases; the
 * verdict row must already exist in `evals` and carry an eval packet.
 */
export function appendVerdictOpenedEvent(
	store: ControlStore,
	input: AppendVerdictOpenedInput,
	now = Date.now,
): EvalLifecycleEvent {
	const eventId = nonEmpty(input.eventId, "eventId");
	const reason = "verdict published";
	const refs = normalizeRefs(input.refs);
	assertNoEvalSecrets({ reason, refs }, "verdict_opened");
	return store.transaction.run(() => {
		const context = resolveVerdictContext(store, { verdictId: input.verdictId });
		const existing = getEventById(store, eventId);
		if (existing) {
			const same = assertSameEvent(existing, {
				caseId: context.caseId,
				verdictId: context.record.id,
				domainId: context.domainId,
				type: "verdict_opened",
				actor: { kind: input.actor.kind, id: nonEmpty(input.actor.id, "actor.id") },
				reason,
				refs,
			});
			if (!same)
				throw new ControlError("conflict", `eval lifecycle event ${eventId} already exists with different content`);
			return existing;
		}
		return insertEvent({
			store,
			context,
			eventId,
			type: "verdict_opened",
			actor: { kind: input.actor.kind, id: nonEmpty(input.actor.id, "actor.id") },
			reason,
			refs,
			createdAt: input.createdAt ?? now(),
			enforceTransition: false,
		});
	});
}

export interface AcceptSunsetInput {
	readonly caseId: string;
	readonly actor: EvalLifecycleActor;
	readonly reason: string;
	readonly expectedSequence?: number;
	readonly eventId?: string;
}

export interface AcceptSunsetResult {
	readonly event: EvalLifecycleEvent;
	readonly case: EvalCaseProjection;
	readonly message: Message;
}

export function acceptSunset(store: ControlStore, input: AcceptSunsetInput, now = Date.now): AcceptSunsetResult {
	if (input.actor.kind !== "operator") {
		throw new ControlError("forbidden", "accept-sunset is operator-only");
	}
	const reason = nonEmpty(input.reason, "reason");
	assertNoEvalSecrets(reason, "accept_sunset");
	return store.transaction.run(() => {
		const context = resolveVerdictContext(store, { caseId: input.caseId });
		if (context.verdict !== "delete_sunset") {
			throw new ControlError("invalid_state", "accept-sunset requires a delete_sunset verdict");
		}
		const event = appendEvalLifecycleEvent(
			store,
			{
				eventId: input.eventId,
				caseId: context.caseId,
				expectedSequence: input.expectedSequence,
				type: "sunset_accepted",
				actor: input.actor,
				reason,
				refs: [`verdict:${context.record.id}`],
			},
			now,
		).event;
		const message = store.messages.append({
			threadId: context.metrics.systemThreadId,
			authorKind: "system",
			authorId: "eval:lifecycle",
			kind: "status",
			bodyMd: [
				`Sunset accepted for ${context.caseId}.`,
				"",
				`Operator: ${input.actor.id}`,
				`Reason: ${reason}`,
				"",
				"W6b recorded the decision only; no harness files or configuration were deleted.",
			].join("\n"),
		});
		const events = listEvents(store, context.caseId);
		return { event, case: projectEvalCase({ context, events, now: now() }), message };
	});
}

export interface SuppressCaseInput {
	readonly caseId: string;
	readonly actor: EvalLifecycleActor;
	readonly reason: string;
	readonly expectedSequence?: number;
	readonly eventId?: string;
}

export function suppressEvalCase(store: ControlStore, input: SuppressCaseInput, now = Date.now): EvalLifecycleEvent {
	if (input.actor.kind !== "operator") {
		throw new ControlError("forbidden", "cvo_suppressed is operator-only");
	}
	const result = appendEvalLifecycleEvent(
		store,
		{
			eventId: input.eventId,
			caseId: input.caseId,
			expectedSequence: input.expectedSequence,
			type: "cvo_suppressed",
			actor: input.actor,
			reason: input.reason,
			refs: [],
		},
		now,
	);
	return result.event;
}
