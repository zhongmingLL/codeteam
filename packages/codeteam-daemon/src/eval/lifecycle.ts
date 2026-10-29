import { createHash } from "node:crypto";
import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import { newId } from "../control/stores/helpers.ts";
import type { Eval, Message } from "../control/stores/types.ts";
import {
	EVAL_CASE_ID_PATTERN,
	EVAL_LIFECYCLE_ACTOR_KINDS,
	EVAL_LIFECYCLE_EVENT_TYPES,
	EVAL_SHA_PATTERN,
	type EvalCaseListItem,
	type EvalCaseProjection,
	type EvalDomainSla,
	type EvalLifecycleActor,
	type EvalLifecycleActorKind,
	type EvalLifecycleEvent,
	type EvalLifecycleEventPayloadV1,
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
	domain_id: string;
	event_type: EvalLifecycleEventType;
	actor_kind: EvalLifecycleActorKind;
	actor_id: string;
	payload_json: string;
	occurred_at: string;
	created_at: string;
}

export interface AppendEvalLifecycleEventInput {
	readonly eventId?: string;
	readonly verdictId?: string;
	readonly caseId?: string;
	readonly expectedSequence?: number;
	readonly type: Exclude<EvalLifecycleEventType, "verdict_opened" | "verdict_cycle_observed" | "migration">;
	readonly actor: EvalLifecycleActor;
	readonly reason: string;
	readonly refs?: readonly string[];
	readonly commitSha?: string;
	readonly targetOwnerProfileId?: string;
	readonly occurredAt?: string;
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

const ALLOWED_FROM: Readonly<
	Record<EvalLifecycleEventType, readonly EvalLifecycleStatus[] | "any_non_terminal" | "first">
> = {
	verdict_opened: "first",
	verdict_cycle_observed: ["resolved"],
	owner_acknowledged: ["open", "escalated"],
	action_planned: ["open", "acknowledged", "escalated"],
	fix_recorded: ["action_planned"],
	main_landed: ["fix_landed"],
	reeval_requested: ["main_landed"],
	reeval_passed: ["reeval_pending"],
	reeval_failed: ["reeval_pending"],
	cvo_suppressed: "any_non_terminal",
	sla_escalated: ["open", "acknowledged", "action_planned", "fix_landed", "main_landed", "reeval_pending"],
	owner_reassigned: "any_non_terminal",
	migration: "first",
	sunset_accepted: "any_non_terminal",
};

const ACTOR_RULES: Readonly<Record<EvalLifecycleEventType, readonly EvalLifecycleActorKind[]>> = {
	verdict_opened: ["system"],
	verdict_cycle_observed: ["system"],
	owner_acknowledged: ["agent", "operator"],
	action_planned: ["agent", "operator"],
	fix_recorded: ["agent", "operator"],
	main_landed: ["system", "operator"],
	reeval_requested: ["system"],
	reeval_passed: ["agent", "system"],
	reeval_failed: ["agent", "system"],
	cvo_suppressed: ["operator"],
	sla_escalated: ["system"],
	owner_reassigned: ["operator"],
	migration: ["migration"],
	sunset_accepted: ["operator"],
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

function nowIso(now: () => number): string {
	return new Date(now()).toISOString();
}

function isoToMs(value: string): number {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new ControlError("invalid_state", `invalid ISO timestamp ${value}`);
	return parsed;
}

function actorPrefix(kind: EvalLifecycleActorKind, id: string): string {
	return `${kind}:${id}`;
}

function actorFromStorage(kind: EvalLifecycleActorKind, stored: string): EvalLifecycleActor {
	const prefix = `${kind}:`;
	if (!stored.startsWith(prefix) || stored.length === prefix.length) {
		throw new ControlError("invalid_state", `actor_id ${stored} does not match actor_kind ${kind}`);
	}
	return { kind, id: stored.slice(prefix.length) };
}

function mapEvent(row: LifecycleEventRow): EvalLifecycleEvent {
	return {
		eventId: row.event_id,
		caseId: row.case_id,
		seq: row.seq,
		domainId: row.domain_id,
		type: row.event_type,
		actor: actorFromStorage(row.actor_kind, row.actor_id),
		payload: JSON.parse(row.payload_json) as EvalLifecycleEventPayloadV1,
		occurredAt: row.occurred_at,
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
	readonly createdAt: string;
	readonly ownerProfileId: string;
	readonly evalAgentProfileId: string;
	readonly events: readonly EvalLifecycleEvent[];
}

function latestVerdictId(events: readonly EvalLifecycleEvent[]): string | undefined {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index]!;
		if (event.type === "verdict_opened" || event.type === "verdict_cycle_observed") {
			return event.payload.verdictId;
		}
	}
	return undefined;
}

function resolveVerdictContext(
	store: ControlStore,
	input: { caseId?: string; verdictId?: string; exactVerdict?: boolean },
): VerdictContext {
	let caseId = input.caseId ? nonEmpty(input.caseId, "caseId") : null;
	let record: Eval | null = null;
	let events: EvalLifecycleEvent[] = [];
	if (input.verdictId) {
		record = store.evals.get(nonEmpty(input.verdictId, "verdictId"));
	} else if (caseId) {
		events = listEvents(store, caseId);
		const verdictId = latestVerdictId(events);
		if (verdictId) record = store.evals.get(verdictId);
	}
	if (!record) throw new ControlError("not_found", "eval verdict case not found");
	const metrics = readEvalVerdictMetrics(record);
	const findingKey = metrics.findingKey;
	if (!findingKey) throw new ControlError("invalid_state", "eval verdict has no findingKey and no lifecycle case");
	const derivedCaseId = deriveEvalCaseId(record.domainId!, findingKey);
	if (caseId && caseId !== derivedCaseId) {
		throw new ControlError("invalid_input", "caseId does not match the verdict findingKey identity");
	}
	caseId = derivedCaseId;
	if (!EVAL_CASE_ID_PATTERN.test(caseId)) {
		throw new ControlError("invalid_state", "derived eval caseId is invalid");
	}
	if (events.length === 0) events = listEvents(store, caseId);
	if (!input.exactVerdict) {
		const latestId = latestVerdictId(events);
		if (latestId && latestId !== record.id) record = store.evals.get(latestId);
	}
	if (!record) throw new ControlError("not_found", "active eval verdict not found");
	const activeMetrics = readEvalVerdictMetrics(record);
	const activeFindingKey = activeMetrics.findingKey;
	if (!activeFindingKey) throw new ControlError("invalid_state", "active eval verdict has no findingKey");
	if (activeFindingKey !== findingKey) {
		throw new ControlError("invalid_state", "eval case verdict cycle changed findingKey");
	}
	const ownerProfileId = currentOwner(events, activeMetrics.packet.ownerAsk.targetOwnerProfileId);
	return {
		record,
		metrics: activeMetrics,
		verdict: activeMetrics.packet.verdict,
		domainId: record.domainId!,
		findingKey,
		caseId,
		sla: activeMetrics.sla,
		createdAt: activeMetrics.packet.createdAt,
		ownerProfileId,
		evalAgentProfileId: activeMetrics.evalAgentProfileId,
		events,
	};
}

function currentOwner(events: readonly EvalLifecycleEvent[], rootOwner: string): string {
	let owner = rootOwner;
	for (const event of events) {
		if (event.type === "owner_reassigned" && event.payload.targetOwnerProfileId) {
			owner = event.payload.targetOwnerProfileId;
		}
	}
	return owner;
}

function statusAfterEvent(status: EvalLifecycleStatus, type: EvalLifecycleEventType): EvalLifecycleStatus {
	switch (type) {
		case "verdict_opened":
		case "verdict_cycle_observed":
			return "open";
		case "owner_acknowledged":
			return "acknowledged";
		case "action_planned":
			return "action_planned";
		case "fix_recorded":
			return "fix_landed";
		case "main_landed":
			return "main_landed";
		case "reeval_requested":
			return "reeval_pending";
		case "reeval_passed":
			return "resolved";
		case "reeval_failed":
			return status === "monitoring" ? "open" : "action_planned";
		case "cvo_suppressed":
			return "suppressed_with_reason";
		case "sla_escalated":
			return "escalated";
		case "owner_reassigned":
			return status;
		case "migration":
			return status;
		case "sunset_accepted":
			return "resolved";
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
		status = statusAfterEvent(status, event.type);
	}
	return status;
}

function contextForEvent(
	store: ControlStore,
	base: VerdictContext,
	event: EvalLifecycleEvent,
	ownerProfileId: string,
): VerdictContext {
	const verdictId = event.payload.verdictId ?? base.record.id;
	const record = store.evals.get(verdictId);
	if (!record) {
		throw new ControlError("not_found", `eval verdict ${verdictId} for history event ${event.eventId} not found`);
	}
	const metrics = readEvalVerdictMetrics(record);
	const findingKey = metrics.findingKey;
	if (!findingKey) {
		throw new ControlError("invalid_state", `eval verdict ${verdictId} has no findingKey in history`);
	}
	if (findingKey !== base.findingKey) {
		throw new ControlError("invalid_state", "eval history switched findingKey");
	}
	return {
		record,
		metrics,
		verdict: metrics.packet.verdict,
		domainId: record.domainId!,
		findingKey,
		caseId: base.caseId,
		sla: metrics.sla,
		createdAt: metrics.packet.createdAt,
		ownerProfileId,
		evalAgentProfileId: metrics.evalAgentProfileId,
		events: [],
	};
}

/**
 * Read-side replay guard required by the approved architecture review:
 * append-only triggers protect bytes, not semantics. Every history read must
 * revalidate transition and authority, including raw INSERTs that bypassed the
 * service layer.
 */
function validateEventHistory(store: ControlStore, base: VerdictContext, events: readonly EvalLifecycleEvent[]): void {
	if (events.length === 0) throw new ControlError("not_found", "eval case has no lifecycle events");
	const first = events[0]!;
	if (first.seq !== 1 || first.type !== "verdict_opened") {
		throw new ControlError("invalid_state", "eval lifecycle must start with verdict_opened at seq 1");
	}
	const root = contextForEvent(store, base, first, base.ownerProfileId);
	assertActorAllowed({
		context: root,
		type: first.type,
		actor: first.actor,
		payload: first.payload,
		store,
	});
	let status: EvalLifecycleStatus = "open";
	let ownerProfileId = root.metrics.packet.ownerAsk.targetOwnerProfileId;
	for (let index = 1; index < events.length; index += 1) {
		const event = events[index]!;
		if (event.seq !== index + 1) {
			throw new ControlError("invalid_state", `eval lifecycle seq gap at ${event.eventId}`);
		}
		const context = contextForEvent(store, base, event, ownerProfileId);
		assertTransition(context, status, event.type);
		assertActorAllowed({ context, type: event.type, actor: event.actor, payload: event.payload, store });
		status = statusAfterEvent(status, event.type);
		if (event.type === "owner_reassigned" && event.payload.targetOwnerProfileId) {
			ownerProfileId = event.payload.targetOwnerProfileId;
		}
		if (event.type === "verdict_cycle_observed") {
			ownerProfileId = context.metrics.packet.ownerAsk.targetOwnerProfileId;
		}
	}
}

function isOverdue(status: EvalLifecycleStatus, createdAt: string, sla: EvalDomainSla, now: number): boolean {
	if (TERMINAL_EVAL_STATUSES.includes(status)) return false;
	if (status === "escalated") return true;
	const createdMs = isoToMs(createdAt);
	const ackDeadline = createdMs + sla.acknowledgeHours * HOUR_MS;
	const reevalDeadline = createdMs + sla.reevalWithinHours * HOUR_MS;
	if (status === "open" || status === "acknowledged") return now > ackDeadline;
	return now > reevalDeadline;
}

export function projectEvalCase(options: {
	readonly store: ControlStore;
	readonly context: VerdictContext;
	readonly events: readonly EvalLifecycleEvent[];
	readonly now: number;
}): EvalCaseProjection {
	const { store, context, events, now } = options;
	validateEventHistory(store, context, events);
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
		overdue: isOverdue(status, context.createdAt, context.sla, now),
		lastEventAt: lastEvent.occurredAt,
		nextSequence: events.length + 1,
		createdAt: context.createdAt,
		sla: context.sla,
		events,
	};
}

export function getEvalCase(store: ControlStore, caseOrVerdictId: string, now = Date.now()): EvalCaseProjection {
	const id = nonEmpty(caseOrVerdictId, "caseId");
	let caseId = EVAL_CASE_ID_PATTERN.test(id) ? id : null;
	if (!caseId) {
		const record = store.evals.get(id);
		if (record) {
			const metrics = readEvalVerdictMetrics(record);
			if (metrics.findingKey) caseId = deriveEvalCaseId(record.domainId!, metrics.findingKey);
		}
	}
	if (!caseId) throw new ControlError("not_found", `eval case ${id} not found`);
	const events = listEvents(store, caseId);
	if (events.length === 0) throw new ControlError("not_found", `eval case ${caseId} not found`);
	const context = resolveVerdictContext(store, { caseId });
	return projectEvalCase({ store, context, events, now });
}

export function listEvalCases(store: ControlStore, filter: EvalCaseListFilter = {}): EvalCaseListItem[] {
	const rows = store.database
		.prepare(
			"SELECT case_id, MAX(created_at) AS last_at FROM eval_lifecycle_events GROUP BY case_id ORDER BY last_at DESC, case_id",
		)
		.all() as unknown as { case_id: string; last_at: string }[];
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

function assertActorAllowed(options: {
	readonly context: VerdictContext;
	readonly type: EvalLifecycleEventType;
	readonly actor: EvalLifecycleActor;
	readonly payload: EvalLifecycleEventPayloadV1;
	readonly store: ControlStore;
}): void {
	const { context, type, actor, payload, store } = options;
	const allowed = ACTOR_RULES[type];
	if (!allowed.includes(actor.kind)) {
		throw new ControlError("forbidden", `${type} requires actor kind ${allowed.join(" or ")}, got ${actor.kind}`);
	}
	if (type === "verdict_opened" || type === "verdict_cycle_observed") {
		if (actor.kind !== "system" || actor.id !== "publish-pipeline") {
			throw new ControlError("forbidden", `${type} can only be written by system:publish-pipeline`);
		}
	}
	if (type === "owner_acknowledged" || type === "action_planned") {
		if (actor.kind === "agent" && actor.id !== context.ownerProfileId) {
			throw new ControlError("forbidden", `${type} agent must match case owner ${context.ownerProfileId}`);
		}
	}
	if (type === "fix_recorded") {
		if (actor.kind === "agent" && actor.id !== context.ownerProfileId) {
			throw new ControlError("forbidden", `${type} agent must match case owner ${context.ownerProfileId}`);
		}
	}
	if (type === "main_landed") {
		if (actor.kind === "system" && actor.id !== "merge-owner") {
			throw new ControlError("forbidden", "main_landed system actor must be system:merge-owner");
		}
		const commitSha = payload.commitSha;
		if (!commitSha || !EVAL_SHA_PATTERN.test(commitSha)) {
			throw new ControlError("invalid_input", "main_landed payload.commitSha must be a full 40/64 hex SHA");
		}
	}
	if (type === "reeval_requested" || type === "sla_escalated") {
		if (actor.kind !== "system" || actor.id !== "sla-reconciler") {
			throw new ControlError("forbidden", `${type} can only be written by system:sla-reconciler`);
		}
	}
	if (type === "reeval_passed" || type === "reeval_failed") {
		if (actor.kind === "agent" && actor.id !== context.evalAgentProfileId) {
			throw new ControlError("forbidden", `${type} agent must match eval agent ${context.evalAgentProfileId}`);
		}
		if (actor.kind === "system" && actor.id !== "eval-pipeline") {
			throw new ControlError("forbidden", `${type} system actor must be system:eval-pipeline`);
		}
	}
	if (type === "owner_reassigned") {
		const target = payload.targetOwnerProfileId;
		if (!target) throw new ControlError("invalid_input", "owner_reassigned requires targetOwnerProfileId");
		const profile = store.profiles.get(target);
		if (!profile) throw new ControlError("not_found", `owner profile ${target} not found`);
		if (profile.status !== "active") throw new ControlError("invalid_state", `owner profile ${target} is disabled`);
	}
	if (type === "migration") {
		if (actor.kind !== "migration" || !payload.sourceRef) {
			throw new ControlError("invalid_input", "migration requires migration actor and payload.sourceRef");
		}
	}
	if (type === "sunset_accepted" && context.verdict !== "delete_sunset") {
		throw new ControlError("invalid_state", "sunset_accepted requires a delete_sunset verdict");
	}
}

function assertTransition(context: VerdictContext, status: EvalLifecycleStatus, type: EvalLifecycleEventType): void {
	if (type === "verdict_opened") {
		if (context.events.length > 0) throw new ControlError("invalid_state", "verdict_opened must be first");
		return;
	}
	if (type === "verdict_cycle_observed") {
		if (status !== "resolved") {
			throw new ControlError("invalid_state", "verdict_cycle_observed requires a resolved case");
		}
		return;
	}
	if (type === "migration") {
		throw new ControlError("invalid_state", "migration backfill is not wired in W6b");
	}
	if (TERMINAL_EVAL_STATUSES.includes(status)) {
		throw new ControlError("invalid_state", `illegal transition: ${type} cannot follow terminal status ${status}`);
	}
	const allowed = ALLOWED_FROM[type];
	if (allowed === "any_non_terminal") return;
	if (allowed === "first") {
		throw new ControlError("invalid_state", `${type} must be first`);
	}
	if (!Array.isArray(allowed) || !allowed.includes(status)) {
		throw new ControlError("invalid_state", `illegal transition: ${type} cannot follow ${status}`);
	}
}

function assertSameEvent(
	existing: EvalLifecycleEvent,
	expected: {
		readonly caseId: string;
		readonly domainId: string;
		readonly type: EvalLifecycleEventType;
		readonly actor: EvalLifecycleActor;
		readonly payload: EvalLifecycleEventPayloadV1;
	},
): boolean {
	const canonical = (value: unknown): string => {
		if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
		if (value && typeof value === "object") {
			return `{${Object.entries(value as Record<string, unknown>)
				.filter(([, child]) => child !== undefined)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
				.join(",")}}`;
		}
		return JSON.stringify(value);
	};
	return (
		existing.caseId === expected.caseId &&
		existing.domainId === expected.domainId &&
		existing.type === expected.type &&
		existing.actor.kind === expected.actor.kind &&
		existing.actor.id === expected.actor.id &&
		canonical(existing.payload) === canonical(expected.payload)
	);
}

function insertEvent(options: {
	readonly store: ControlStore;
	readonly context: VerdictContext;
	readonly eventId: string;
	readonly type: EvalLifecycleEventType;
	readonly actor: EvalLifecycleActor;
	readonly payload: EvalLifecycleEventPayloadV1;
	readonly expectedSequence?: number;
	readonly occurredAt: string;
	readonly createdAt: string;
}): EvalLifecycleEvent {
	const events = listEvents(options.store, options.context.caseId);
	const nextSequence = events.length + 1;
	if (options.expectedSequence !== undefined && options.expectedSequence !== events.length) {
		throw new ControlError(
			"version_conflict",
			`expected eval case sequence ${options.expectedSequence}, current sequence is ${events.length}`,
		);
	}
	const status = events.length === 0 ? "open" : projectStatus(events);
	assertTransition(options.context, status, options.type);
	assertActorAllowed({
		context: options.context,
		type: options.type,
		actor: options.actor,
		payload: options.payload,
		store: options.store,
	});
	let payload = options.payload;
	if (options.type === "reeval_requested") {
		const dueAt = new Date(
			isoToMs(options.context.createdAt) + options.context.sla.reevalWithinHours * HOUR_MS,
		).toISOString();
		payload = { ...payload, dueAt };
	}
	const row: LifecycleEventRow = {
		event_id: options.eventId,
		case_id: options.context.caseId,
		seq: nextSequence,
		domain_id: options.context.domainId,
		event_type: options.type,
		actor_kind: options.actor.kind,
		actor_id: actorPrefix(options.actor.kind, options.actor.id),
		payload_json: JSON.stringify(payload),
		occurred_at: options.occurredAt,
		created_at: options.createdAt,
	};
	try {
		options.store.database
			.prepare(
				"INSERT INTO eval_lifecycle_events (event_id, case_id, seq, domain_id, event_type, actor_kind, actor_id, payload_json, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				row.event_id,
				row.case_id,
				row.seq,
				row.domain_id,
				row.event_type,
				row.actor_kind,
				row.actor_id,
				row.payload_json,
				row.occurred_at,
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
	assertNoEvalSecrets({ reason, refs, commitSha: input.commitSha }, "eval_lifecycle_event");
	const eventId = input.eventId ? nonEmpty(input.eventId, "eventId") : newId();
	const occurredAt = input.occurredAt ?? nowIso(now);
	if (Number.isNaN(Date.parse(occurredAt))) {
		throw new ControlError("invalid_input", "occurredAt must be an ISO timestamp");
	}
	const createdAt = nowIso(now);
	return store.transaction.run(() => {
		const context = resolveVerdictContext(store, { caseId: input.caseId, verdictId: input.verdictId });
		let payload: EvalLifecycleEventPayloadV1 = {
			...(context.record.id ? { verdictId: context.record.id } : {}),
			...(refs.length > 0 ? { refs } : {}),
			reason,
			...(input.commitSha ? { commitSha: input.commitSha } : {}),
			...(input.targetOwnerProfileId ? { targetOwnerProfileId: input.targetOwnerProfileId } : {}),
		};
		if (input.type === "reeval_requested") {
			payload = {
				...payload,
				dueAt: new Date(isoToMs(context.createdAt) + context.sla.reevalWithinHours * HOUR_MS).toISOString(),
			};
		}
		const existing = getEventById(store, eventId);
		if (existing) {
			if (
				!assertSameEvent(existing, {
					caseId: context.caseId,
					domainId: context.domainId,
					type: input.type,
					actor: { kind: input.actor.kind, id: nonEmpty(input.actor.id, "actor.id") },
					payload,
				})
			) {
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
			payload,
			expectedSequence: input.expectedSequence,
			occurredAt,
			createdAt,
		});
		return { event, replayed: false };
	});
}

export interface AppendVerdictOpenedInput {
	readonly verdictId: string;
	readonly eventId: string;
	readonly refs?: readonly string[];
	readonly occurredAt?: string;
}

export function appendVerdictOpenedEvent(
	store: ControlStore,
	input: AppendVerdictOpenedInput,
	now = Date.now,
): EvalLifecycleEvent {
	const eventId = nonEmpty(input.eventId, "eventId");
	const refs = normalizeRefs(input.refs);
	return store.transaction.run(() => {
		const context = resolveVerdictContext(store, { verdictId: input.verdictId, exactVerdict: true });
		const existing = getEventById(store, eventId);
		const payload: EvalLifecycleEventPayloadV1 = {
			verdictId: context.record.id,
			...(refs.length > 0 ? { refs } : {}),
			reason: "verdict published",
		};
		if (existing) {
			if (
				!assertSameEvent(existing, {
					caseId: context.caseId,
					domainId: context.domainId,
					type: "verdict_opened",
					actor: { kind: "system", id: "publish-pipeline" },
					payload,
				})
			) {
				throw new ControlError("conflict", `eval lifecycle event ${eventId} already exists with different content`);
			}
			return existing;
		}
		return insertEvent({
			store,
			context,
			eventId,
			type: "verdict_opened",
			actor: { kind: "system", id: "publish-pipeline" },
			payload,
			occurredAt: input.occurredAt ?? nowIso(now),
			createdAt: nowIso(now),
		});
	});
}

export interface AppendVerdictCycleInput {
	readonly verdictId: string;
	readonly eventId: string;
	readonly refs?: readonly string[];
	readonly occurredAt?: string;
}

export function appendVerdictCycleEvent(
	store: ControlStore,
	input: AppendVerdictCycleInput,
	now = Date.now,
): EvalLifecycleEvent {
	const eventId = nonEmpty(input.eventId, "eventId");
	const refs = normalizeRefs(input.refs);
	return store.transaction.run(() => {
		const context = resolveVerdictContext(store, { verdictId: input.verdictId, exactVerdict: true });
		const payload: EvalLifecycleEventPayloadV1 = {
			verdictId: context.record.id,
			...(refs.length > 0 ? { refs } : {}),
			reason: "verdict cycle observed",
		};
		const existing = getEventById(store, eventId);
		if (existing) {
			if (
				!assertSameEvent(existing, {
					caseId: context.caseId,
					domainId: context.domainId,
					type: "verdict_cycle_observed",
					actor: { kind: "system", id: "publish-pipeline" },
					payload,
				})
			) {
				throw new ControlError("conflict", `eval lifecycle event ${eventId} already exists with different content`);
			}
			return existing;
		}
		return insertEvent({
			store,
			context,
			eventId,
			type: "verdict_cycle_observed",
			actor: { kind: "system", id: "publish-pipeline" },
			payload,
			occurredAt: input.occurredAt ?? nowIso(now),
			createdAt: nowIso(now),
		});
	});
}

export interface AcceptSunsetInput {
	readonly caseId?: string;
	readonly verdictId?: string;
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
		const context = resolveVerdictContext(store, { caseId: input.caseId, verdictId: input.verdictId });
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
		return { event, case: projectEvalCase({ store, context, events, now: now() }), message };
	});
}

export interface SuppressCaseInput {
	readonly caseId?: string;
	readonly verdictId?: string;
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
			verdictId: input.verdictId,
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
