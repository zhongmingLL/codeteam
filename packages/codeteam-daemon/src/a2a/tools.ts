import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import { newId } from "../control/stores/helpers.ts";
import type {
	AgentProfile,
	AgentSession,
	CreateHandoffInput,
	Handoff,
	HandoffActionFamily,
	HandoffKind,
	HandoffMode,
	HandoffSuccessorSlot,
	Message,
	QueueEntry,
} from "../control/stores/types.ts";
import { assertHandoffDirection } from "../policy/handoffs.ts";
import type { RunPrincipal } from "./principal.ts";

const A2A_MESSAGE_KINDS = new Set(["question", "answer", "proposal", "finding", "status"]);
export const DEFAULT_MAX_A2A_DEPTH = 32;

function configuredMaxA2ADepth(): number {
	const configured = Number(process.env.CODETEAM_A2A_MAX_DEPTH ?? String(DEFAULT_MAX_A2A_DEPTH));
	return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_A2A_DEPTH;
}

export const MAX_A2A_DEPTH = configuredMaxA2ADepth();
const HANDOFF_KINDS = new Set<HandoffKind>([
	"handoff",
	"review_request",
	"verdict",
	"blocker",
	"spec_change",
	"plan_revision",
	"question",
]);
const ACTION_FAMILIES = new Set<HandoffActionFamily>([
	"review",
	"merge",
	"investigate",
	"implement",
	"verify",
	"vision_guard",
]);
const SUCCESSOR_SLOTS = new Set<HandoffSuccessorSlot>([
	"reviewer",
	"merge_owner",
	"vision_guardian",
	"investigator",
	"implementer",
	"verifier",
]);
const BLOCKED_ON_RESOLVE = new Set(["completes", "bounces_back_to_owner"]);

interface DeliverableTarget {
	readonly profile: AgentProfile;
	readonly session: AgentSession;
}

export interface A2AHandlersOptions {
	readonly store: ControlStore;
	readonly principal: RunPrincipal;
	readonly clock?: () => number;
}

export interface A2ASendInput {
	kind: string;
	targets: string[];
	bodyMd: string;
	replyTo?: string | null;
}

export interface HandoffCreateInput {
	kind: string;
	targets: string[];
	subject: string;
	subjectRef: string;
	actionFamily: string;
	successorSlot: string;
	expectedArtifact: string;
	deadline: number;
	idempotencyKey: string;
	mode?: string;
	parallelIntent?: string | null;
	terminalPredicate: Record<string, unknown>;
	payload?: Record<string, unknown>;
	replyTo?: string | null;
	stageId?: string | null;
	resolveMode?: string | null;
	bodyMd?: string;
}

export interface A2ASendResult {
	message: Message;
	queueEntry: QueueEntry;
}

export interface HandoffCreateResult {
	handoff: Handoff;
	message: Message;
	queueEntry: QueueEntry | null;
}

export type HandoffClaimResult =
	| { status: "claimed"; handoff: Handoff }
	| { status: "safe_wait"; reason: string; handoff: Handoff | null }
	| { status: "terminal_handoff"; handoff: Handoff };

function assertObject(value: unknown, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ControlError("invalid_input", `${field} must be an object`);
	}
	return value as Record<string, unknown>;
}

function assertAllowedKeys(input: Record<string, unknown>, allowed: readonly string[], tool: string): void {
	for (const key of Object.keys(input)) {
		if (!allowed.includes(key)) {
			throw new ControlError("invalid_input", `${tool} does not accept field ${key}`);
		}
	}
}

function nonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new ControlError("invalid_input", `${field} is required`);
	}
	return value;
}

function positiveInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new ControlError("invalid_input", `${field} must be a positive integer`);
	}
	return value;
}

function uniqueTargets(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new ControlError("invalid_input", "targets must be a non-empty array");
	}
	const targets = value.filter((target): target is string => typeof target === "string" && target.trim() !== "");
	if (targets.length !== value.length) throw new ControlError("invalid_input", "targets must be non-empty strings");
	const unique = [...new Set(targets)];
	if (unique.length !== targets.length) throw new ControlError("invalid_input", "targets must be unique");
	return unique;
}

function markerFor(target: DeliverableTarget): string {
	return `→ @${target.profile.displayName}`;
}

function withMarkers(bodyMd: string, targets: readonly DeliverableTarget[]): string {
	const markers = targets.map(markerFor).join(" ");
	return markers ? `${bodyMd.trimEnd()}\n\n${markers}` : bodyMd;
}

function nextDepth(principal: RunPrincipal): number {
	const depth = principal.chainMetadata.a2aDepth;
	return typeof depth === "number" && Number.isSafeInteger(depth) && depth >= 0 ? depth + 1 : 1;
}

function assertDepth(depth: number): void {
	if (depth > MAX_A2A_DEPTH) {
		throw new ControlError("a2a_depth_exceeded", `A2A depth ${depth} exceeds the configured limit ${MAX_A2A_DEPTH}`);
	}
}

export class A2AToolHandlers {
	private readonly store: ControlStore;
	private readonly principal: RunPrincipal;
	private readonly clock: () => number;

	constructor(options: A2AHandlersOptions) {
		this.store = options.store;
		this.principal = options.principal;
		this.clock = options.clock ?? Date.now;
	}

	send(input: A2ASendInput): A2ASendResult {
		const raw = assertObject(input, "a2a_send input");
		assertAllowedKeys(raw, ["kind", "targets", "bodyMd", "replyTo"], "a2a_send");
		const kind = nonEmptyString(raw.kind, "kind");
		if (!A2A_MESSAGE_KINDS.has(kind)) {
			throw new ControlError("invalid_input", `a2a_send kind ${kind} is not a discussion kind`);
		}
		const bodyMd = nonEmptyString(raw.bodyMd, "bodyMd");
		const targets = this.deliverableTargets(uniqueTargets(raw.targets));
		const replyTo = raw.replyTo === undefined || raw.replyTo === null ? null : nonEmptyString(raw.replyTo, "replyTo");
		if (replyTo) this.assertReplyTarget(replyTo);
		const depth = nextDepth(this.principal);
		assertDepth(depth);
		return this.store.transaction.run(() => {
			const message = this.store.messages.append({
				threadId: this.principal.threadId,
				taskId: this.principal.taskId,
				authorKind: "agent",
				authorId: this.principal.profileId,
				kind: kind as Message["kind"],
				bodyMd: withMarkers(bodyMd, targets),
				replyTo,
			});
			const queueEntry = this.store.queue.admit({
				threadId: this.principal.threadId,
				sourceId: message.id,
				sourceRecordId: this.principal.runId,
				sourceKind: "message_wake",
				targets: targets.map((target) => target.profile.id),
				authorIntent: Object.fromEntries(
					targets.map((target) => [
						target.profile.id,
						{
							intent: "next_work",
							chainMetadata: { a2aDepth: depth, parentRunId: this.principal.runId },
						},
					]),
				),
				sourceCategory: "a2a",
				orderKey: `${message.createdAt}:${message.seq}`,
			});
			this.store.audit.append({
				actor: `profile:${this.principal.profileId}`,
				action: "a2a_send",
				subject: `message:${message.id}`,
				args: { kind, targets: targets.map((target) => target.profile.id), queueEntryId: queueEntry.id },
			});
			this.recordToolCall("a2a_send");
			return { message, queueEntry };
		});
	}

	createHandoff(input: HandoffCreateInput): HandoffCreateResult {
		const raw = assertObject(input, "handoff_create input");
		assertAllowedKeys(
			raw,
			[
				"kind",
				"targets",
				"subject",
				"subjectRef",
				"actionFamily",
				"successorSlot",
				"expectedArtifact",
				"deadline",
				"idempotencyKey",
				"mode",
				"parallelIntent",
				"terminalPredicate",
				"payload",
				"replyTo",
				"stageId",
				"resolveMode",
				"bodyMd",
			],
			"handoff_create",
		);
		const kind = nonEmptyString(raw.kind, "kind") as HandoffKind;
		if (!HANDOFF_KINDS.has(kind)) throw new ControlError("invalid_input", `handoff_create kind ${kind} is invalid`);
		const actionFamily = nonEmptyString(raw.actionFamily, "actionFamily") as HandoffActionFamily;
		if (!ACTION_FAMILIES.has(actionFamily)) {
			throw new ControlError("invalid_input", `handoff_create actionFamily ${actionFamily} is invalid`);
		}
		const successorSlot = nonEmptyString(raw.successorSlot, "successorSlot") as HandoffSuccessorSlot;
		if (!SUCCESSOR_SLOTS.has(successorSlot)) {
			throw new ControlError("invalid_input", `handoff_create successorSlot ${successorSlot} is invalid`);
		}
		const targets = this.deliverableTargets(uniqueTargets(raw.targets));
		const roles = new Set(targets.map((target) => target.session.role));
		if (roles.size !== 1) {
			throw new ControlError("invalid_input", "handoff targets must share one role");
		}
		const toRole = [...roles][0]!;
		assertHandoffDirection({ role: this.principal.role, runId: this.principal.runId }, { toRole, kind });
		const mode = (
			raw.mode === undefined ? (targets.length === 1 ? "single" : "parallel") : nonEmptyString(raw.mode, "mode")
		) as HandoffMode;
		if (mode !== "single" && mode !== "parallel") {
			throw new ControlError("invalid_input", `handoff_create mode ${mode} is invalid`);
		}
		if (mode === "single" && targets.length !== 1) {
			throw new ControlError("invalid_input", "single handoff requires exactly one target");
		}
		if (mode === "parallel" && targets.length < 2) {
			throw new ControlError("invalid_input", "parallel handoff requires at least two targets");
		}
		const parallelIntent =
			raw.parallelIntent === undefined || raw.parallelIntent === null
				? null
				: nonEmptyString(raw.parallelIntent, "parallelIntent");
		const subject = nonEmptyString(raw.subject, "subject");
		const subjectRef = nonEmptyString(raw.subjectRef, "subjectRef");
		const expectedArtifact = nonEmptyString(raw.expectedArtifact, "expectedArtifact");
		const deadline = positiveInteger(raw.deadline, "deadline");
		if (deadline <= this.clock()) throw new ControlError("invalid_input", "handoff deadline must be in the future");
		const idempotencyKey = nonEmptyString(raw.idempotencyKey, "idempotencyKey");
		const terminalPredicate = assertObject(raw.terminalPredicate, "terminalPredicate");
		const payload = raw.payload === undefined ? {} : assertObject(raw.payload, "payload");
		if (kind === "blocker") {
			const resolveMode = nonEmptyString(raw.resolveMode, "resolveMode");
			if (!BLOCKED_ON_RESOLVE.has(resolveMode)) {
				throw new ControlError("invalid_input", "blocker resolveMode must be completes or bounces_back_to_owner");
			}
			payload.blockedOnResolve = resolveMode;
		} else if (raw.resolveMode !== undefined && raw.resolveMode !== null) {
			throw new ControlError("invalid_input", "resolveMode is only valid for blocker handoffs");
		}
		const replyTo = raw.replyTo === undefined || raw.replyTo === null ? null : nonEmptyString(raw.replyTo, "replyTo");
		if (replyTo) this.assertReplyTarget(replyTo);
		const bodyMd = raw.bodyMd === undefined ? subject : nonEmptyString(raw.bodyMd, "bodyMd");
		const depth = nextDepth(this.principal);
		assertDepth(depth);
		const canonicalActionKey = `${subjectRef}:${actionFamily}:${successorSlot}`;
		const existing = this.store.handoffs.getByTaskIdempotencyKey(this.principal.taskId, idempotencyKey);
		if (existing) {
			const sameTargets =
				existing.holderProfileIds.length === targets.length &&
				targets.every((target) => existing.holderProfileIds.includes(target.profile.id));
			if (
				!sameTargets ||
				existing.subjectRef !== subjectRef ||
				existing.actionFamily !== actionFamily ||
				existing.successorSlot !== successorSlot
			) {
				throw new ControlError("conflict", `handoff idempotency key ${idempotencyKey} was used by another intent`);
			}
			const message = this.store.messages.findByControlRef(existing.id);
			if (!message) throw new ControlError("conflict", `handoff ${existing.id} has no visible message`);
			return {
				handoff: existing,
				message,
				queueEntry: this.store.queue.get(`queue:${message.id}`),
			};
		}
		return this.store.transaction.run(() => {
			const message = this.store.messages.append({
				threadId: this.principal.threadId,
				taskId: this.principal.taskId,
				authorKind: "agent",
				authorId: this.principal.profileId,
				kind: "handoff",
				bodyMd: withMarkers(bodyMd, targets),
				replyTo,
			});
			const create: CreateHandoffInput = {
				taskId: this.principal.taskId,
				stageId: raw.stageId === undefined || raw.stageId === null ? null : nonEmptyString(raw.stageId, "stageId"),
				kind,
				fromRole: this.principal.role,
				toRole,
				subject,
				subjectRef,
				actionFamily,
				successorSlot,
				mode,
				parallelIntent,
				ownerUserId: this.principal.userId,
				createdByActorRef: `profile:${this.principal.profileId}`,
				canonicalActionKey,
				holderProfileIds: targets.map((target) => target.profile.id),
				holderThreadId: this.principal.threadId,
				predecessorProfileId: this.principal.profileId,
				predecessorThreadId: this.principal.threadId,
				claimOrigin: "structured_transfer",
				dispatchId: newId(),
				terminalPredicate,
				expectedArtifact,
				payload,
				idempotencyKey,
				replyTo,
				deadline,
			};
			const handoff = this.store.handoffs.create(create);
			this.store.messages.setControlRef(message.id, handoff.id);
			const queueEntry = this.store.queue.admit({
				threadId: this.principal.threadId,
				sourceId: message.id,
				sourceRecordId: handoff.id,
				sourceKind: "message_wake",
				targets: targets.map((target) => target.profile.id),
				authorIntent: Object.fromEntries(
					targets.map((target) => [
						target.profile.id,
						{
							intent: "handoff",
							actionFamily,
							chainMetadata: { a2aDepth: depth, parentRunId: this.principal.runId },
						},
					]),
				),
				sourceCategory: "a2a_handoff",
				orderKey: `${message.createdAt}:${message.seq}`,
			});
			this.store.handoffs.markDispatched({
				handoffId: handoff.id,
				messageId: message.id,
				queueEntryId: queueEntry.id,
				actorRef: `profile:${this.principal.profileId}`,
			});
			this.store.audit.append({
				actor: `profile:${this.principal.profileId}`,
				action: "a2a_handoff_created",
				subject: `handoff:${handoff.id}`,
				args: { messageId: message.id, queueEntryId: queueEntry.id, targets: handoff.holderProfileIds },
			});
			this.recordToolCall("handoff_create");
			return {
				handoff: this.store.handoffs.get(handoff.id)!,
				message: this.store.messages.get(message.id)!,
				queueEntry,
			};
		});
	}

	claimHandoff(handoffId: string): HandoffClaimResult {
		const handoff = this.store.handoffs.get(handoffId);
		if (!handoff) throw new ControlError("not_found", `handoff ${handoffId} not found`);
		if (handoff.taskId !== this.principal.taskId || handoff.holderThreadId !== this.principal.threadId) {
			return { status: "safe_wait", reason: "task_scope_mismatch", handoff };
		}
		if (!handoff.holderProfileIds.includes(this.principal.profileId)) {
			return { status: "safe_wait", reason: "not_holder", handoff };
		}
		if (handoff.status !== "pending" && handoff.status !== "claimed") {
			return { status: "terminal_handoff", handoff };
		}
		try {
			const claimed = this.store.handoffs.claim({
				handoffId,
				profileId: this.principal.profileId,
				runId: this.principal.runId,
			});
			return { status: "claimed", handoff: claimed };
		} catch (error) {
			if (error instanceof ControlError && (error.code === "claim_conflict" || error.code === "invalid_input")) {
				return { status: "safe_wait", reason: error.message, handoff: this.store.handoffs.get(handoffId) };
			}
			throw error;
		}
	}

	completeHandoff(handoffId: string, evidenceRef: string, result: Record<string, unknown>): Handoff {
		return this.store.handoffs.recordCompletionCandidate({
			handoffId,
			profileId: this.principal.profileId,
			runId: this.principal.runId,
			evidenceRef: nonEmptyString(evidenceRef, "evidenceRef"),
			result: assertObject(result, "result"),
		});
	}

	withdrawHandoff(handoffId: string, reason: string): Handoff {
		const handoff = this.store.handoffs.get(handoffId);
		if (!handoff) throw new ControlError("not_found", `handoff ${handoffId} not found`);
		if (handoff.taskId !== this.principal.taskId || handoff.holderThreadId !== this.principal.threadId) {
			throw new ControlError("forbidden", "handoff is outside the caller task scope");
		}
		if (handoff.predecessorProfileId !== this.principal.profileId) {
			throw new ControlError("forbidden", "only the handoff author can withdraw it");
		}
		return this.store.handoffs.withdraw(
			handoffId,
			`profile:${this.principal.profileId}`,
			nonEmptyString(reason, "reason"),
		);
	}

	private recordToolCall(tool: "a2a_send" | "handoff_create"): void {
		this.store.evals.create({
			taskId: this.principal.taskId,
			provider: this.principal.provider,
			model: this.principal.model,
			role: this.principal.role,
			metrics: { a2a_tool_call_success: 1, a2a_tool: tool },
		});
	}

	private deliverableTargets(targets: readonly string[]): DeliverableTarget[] {
		return targets.map((targetId) => {
			const profile = this.store.profiles.get(targetId);
			if (!profile) throw new ControlError("not_found", `target profile ${targetId} not found`);
			if (profile.status !== "active") throw new ControlError("invalid_state", `target ${targetId} is disabled`);
			const sessions = this.store.sessions.list({
				taskId: this.principal.taskId,
				profileId: targetId,
				status: "active",
			});
			if (sessions.length === 0) {
				throw new ControlError("invalid_state", `target ${targetId} has no active session for this task`);
			}
			if (sessions.length > 1) {
				throw new ControlError("invalid_state", `target ${targetId} has ambiguous active sessions`);
			}
			const session = sessions[0]!;
			if (session.threadId !== this.principal.threadId) {
				throw new ControlError("invalid_input", `target ${targetId} is not in the same thread`);
			}
			return { profile, session };
		});
	}

	private assertReplyTarget(messageId: string): void {
		const message = this.store.messages.get(messageId);
		if (!message) throw new ControlError("not_found", `reply target ${messageId} not found`);
		if (message.threadId !== this.principal.threadId) {
			throw new ControlError("invalid_input", "reply_to_cross_thread");
		}
	}
}

export function createA2AHandlers(options: A2AHandlersOptions): A2AToolHandlers {
	return new A2AToolHandlers(options);
}

export const A2A_TOOL_NAMES = [
	"a2a_send",
	"handoff_create",
	"handoff_claim",
	"handoff_complete",
	"handoff_withdraw",
] as const;
export type A2AToolName = (typeof A2A_TOOL_NAMES)[number];

export interface A2AToolSpec {
	readonly name: A2AToolName;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
}

export const A2A_TOOL_SPECS: readonly A2AToolSpec[] = [
	{
		name: "a2a_send",
		description: "Send an agent discussion message and wake the typed targets. Does not change custody.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["kind", "targets", "bodyMd"],
			properties: {
				kind: { enum: ["question", "answer", "proposal", "finding", "status"] },
				targets: { type: "array", minItems: 1, items: { type: "string" } },
				bodyMd: { type: "string", minLength: 1 },
				replyTo: { type: ["string", "null"] },
			},
		},
	},
	{
		name: "handoff_create",
		description: "Create a typed responsibility handoff, visible message shell, and one pending-wake queue entry.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: [
				"kind",
				"targets",
				"subject",
				"subjectRef",
				"actionFamily",
				"successorSlot",
				"expectedArtifact",
				"deadline",
				"idempotencyKey",
				"terminalPredicate",
			],
			properties: {
				kind: { type: "string" },
				targets: { type: "array", minItems: 1, items: { type: "string" } },
				subject: { type: "string", minLength: 1 },
				subjectRef: { type: "string", minLength: 1 },
				actionFamily: { type: "string" },
				successorSlot: { type: "string" },
				expectedArtifact: { type: "string", minLength: 1 },
				deadline: { type: "integer" },
				idempotencyKey: { type: "string", minLength: 1 },
				terminalPredicate: { type: "object" },
				payload: { type: "object" },
				mode: { enum: ["single", "parallel"] },
				parallelIntent: { type: ["string", "null"] },
				replyTo: { type: ["string", "null"] },
				stageId: { type: ["string", "null"] },
				resolveMode: { enum: ["completes", "bounces_back_to_owner", null] },
				bodyMd: { type: "string" },
			},
		},
	},
	{
		name: "handoff_claim",
		description: "Claim a handoff as an exact holder run; non-holders receive safe_wait.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["handoffId"],
			properties: { handoffId: { type: "string" } },
		},
	},
	{
		name: "handoff_complete",
		description: "Record a completion candidate for the calling holder run; verified commit remains separate.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["handoffId", "evidenceRef", "result"],
			properties: {
				handoffId: { type: "string" },
				evidenceRef: { type: "string", minLength: 1 },
				result: { type: "object" },
			},
		},
	},
	{
		name: "handoff_withdraw",
		description: "Withdraw a handoff as its author.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["handoffId", "reason"],
			properties: {
				handoffId: { type: "string" },
				reason: { type: "string", minLength: 1 },
			},
		},
	},
];

export function describeA2ATools(): readonly A2AToolSpec[] {
	return A2A_TOOL_SPECS;
}
