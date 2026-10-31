/**
 * Pure A2A tool surface metadata.
 *
 * This module deliberately has no store, handler, or Node-only imports so the
 * RPC worker extension can load the same names/schemas without pulling the
 * daemon control plane into the pi process.
 */

export const A2A_TOOL_PREFIX = "codeteam_";

export const A2A_TOOL_NAMES = [
	"codeteam_a2a_send",
	"codeteam_handoff_create",
	"codeteam_handoff_claim",
	"codeteam_handoff_complete",
	"codeteam_handoff_withdraw",
	"codeteam_thread_context",
] as const;

export type A2AToolName = (typeof A2A_TOOL_NAMES)[number];

export type A2AAction =
	| "a2a_send"
	| "handoff_create"
	| "handoff_claim"
	| "handoff_complete"
	| "handoff_withdraw"
	| "thread_context";

export const A2A_ACTION_BY_TOOL: Record<A2AToolName, A2AAction> = {
	codeteam_a2a_send: "a2a_send",
	codeteam_handoff_create: "handoff_create",
	codeteam_handoff_claim: "handoff_claim",
	codeteam_handoff_complete: "handoff_complete",
	codeteam_handoff_withdraw: "handoff_withdraw",
	codeteam_thread_context: "thread_context",
};

export interface A2AToolSpec {
	readonly name: A2AToolName;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
}

export const A2A_TOOL_SPECS: readonly A2AToolSpec[] = [
	{
		name: "codeteam_a2a_send",
		description:
			"Send an agent discussion message and wake the typed targets. Does not change custody. targets are profile ids; text @ does not route.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["kind", "targets", "bodyMd"],
			properties: {
				kind: { enum: ["question", "answer", "proposal", "finding", "status"] },
				targets: {
					type: "array",
					minItems: 1,
					items: { type: "string", description: "Target AgentProfile id, for example profile:reviewer" },
				},
				bodyMd: { type: "string", minLength: 1 },
				replyTo: { type: ["string", "null"] },
				requestId: {
					type: ["string", "null"],
					description: "Stable idempotency key for transport retries; scoped to sender task + profile.",
				},
			},
		},
	},
	{
		name: "codeteam_handoff_create",
		description:
			"Create a typed responsibility handoff, visible message shell, and one pending-wake queue entry. targets are profile ids; text @ does not route.",
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
		name: "codeteam_handoff_claim",
		description: "Claim a handoff as an exact holder run; non-holders receive safe_wait.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["handoffId"],
			properties: { handoffId: { type: "string" } },
		},
	},
	{
		name: "codeteam_handoff_complete",
		description:
			"Record a completion candidate for the calling holder run; verified commit remains a separate server-owned step.",
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
		name: "codeteam_handoff_withdraw",
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
	{
		name: "codeteam_thread_context",
		description:
			"Read a bounded window of the caller's thread. The thread is always derived from the caller principal; no thread id is accepted. Use anchorMessageId for a window around one message, or cursor for older pages.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				anchorMessageId: { type: "string", minLength: 1 },
				before: { type: "integer", minimum: 0, maximum: 200 },
				after: { type: "integer", minimum: 0, maximum: 200 },
				limit: { type: "integer", minimum: 1, maximum: 200 },
				cursor: { type: "string", minLength: 1 },
			},
		},
	},
];

export function describeA2ATools(): readonly A2AToolSpec[] {
	return A2A_TOOL_SPECS;
}
