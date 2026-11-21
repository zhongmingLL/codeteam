// F018 R5-a: the four model-facing A2A tools (0005 §3.3, 0007 §3.8).
// This module is intentionally dependency-free so the pi worker extension can
// import the same names/schemas without pulling the daemon control plane into
// the worker process.

export const A2A_V1_TOOL_NAMES = [
	"superagentteam_post_message",
	"superagentteam_cross_post_message",
	"superagentteam_multi_mention",
	"superagentteam_thread_context",
] as const;

export type A2A_V1ToolName = (typeof A2A_V1_TOOL_NAMES)[number];

export interface A2A_V1ToolSpec {
	readonly name: A2A_V1ToolName;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
}

const TARGET_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["kind", "id"],
	properties: {
		kind: { const: "agent" },
		id: { type: "string", minLength: 1 },
	},
} as const;

export const A2A_V1_TOOL_SPECS: readonly A2A_V1ToolSpec[] = [
	{
		name: "superagentteam_post_message",
		description:
			"Write a message to the current thread. Optional targets wake one agent; empty targets are message-only. Text @ does not route.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["bodyMd"],
			properties: {
				targets: { type: "array", items: TARGET_SCHEMA },
				bodyMd: { type: "string", minLength: 1, maxLength: 32 * 1024 },
				replyTo: { type: "string", minLength: 1 },
			},
		},
	},
	{
		name: "superagentteam_cross_post_message",
		description: "Write a message to another thread and optionally wake one agent there. Text @ does not route.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["threadId", "bodyMd"],
			properties: {
				threadId: { type: "string", minLength: 1 },
				targets: { type: "array", items: TARGET_SCHEMA },
				bodyMd: { type: "string", minLength: 1, maxLength: 32 * 1024 },
				replyTo: { type: "string", minLength: 1 },
			},
		},
	},
	{
		name: "superagentteam_multi_mention",
		description:
			"Fan out one question to 2-3 agents in the current thread, aggregate their responses, and wake callbackTo with the aggregate.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["targets", "question", "callbackTo"],
			properties: {
				targets: { type: "array", items: TARGET_SCHEMA, minItems: 2, maxItems: 3 },
				question: { type: "string", minLength: 1, maxLength: 5 * 1024 },
				context: { type: "string", maxLength: 5 * 1024 },
				callbackTo: { type: "string", minLength: 1 },
				timeoutMinutes: { type: "integer", minimum: 3, maximum: 20 },
				triggerType: {
					enum: ["high-impact", "cross-domain", "uncertain", "info-gap", "recon"],
				},
				searchEvidenceRefs: { type: "array", items: { type: "string", minLength: 1 } },
				overrideReason: { type: "string", minLength: 1 },
			},
		},
	},
	{
		name: "superagentteam_thread_context",
		description:
			"Read a bounded window of a thread. The caller's thread is the default; explicit threads must belong to the same user.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				threadId: { type: "string", minLength: 1 },
				anchor: { type: "string", minLength: 1 },
				before: { type: "integer", minimum: 0, maximum: 50 },
				after: { type: "integer", minimum: 0, maximum: 50 },
				limit: { type: "integer", minimum: 1, maximum: 200 },
				cursor: { type: "string", minLength: 1 },
			},
		},
	},
];

export function describeA2AV1Tools(): readonly A2A_V1ToolSpec[] {
	return A2A_V1_TOOL_SPECS;
}
