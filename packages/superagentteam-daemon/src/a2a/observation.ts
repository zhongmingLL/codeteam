import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";

const INTENT_PATTERNS: readonly RegExp[] = [
	/^\s*@[A-Za-z0-9._:-]+/m,
	/(?:交给|转给|请\s*[^\n。]{1,24}?(?:review|审|看|处理|接手))/i,
	/(?:handoff\s+to|assign\s+to)\b/i,
	/(?:→\s*@[A-Za-z0-9._:-]+)/i,
];

export const A2A_SCHEMA_CORRECTION =
	"A2A routing requires a typed tool call. Use codeteam_a2a_send for discussion; use codeteam_handoff_create for responsibility transfer. Body @ mentions do not route.";

export interface ObserveTerminalInput {
	readonly runId: string;
	readonly bodyMd: string;
	readonly toolCalls: readonly string[];
}

export interface MissingA2AToolCallObservation {
	readonly kind: "missing_a2a_tool_call";
	readonly correction: string;
	readonly auditId: string;
	readonly evalId: string;
}

export function hasUnroutedA2AIntent(bodyMd: string): boolean {
	return INTENT_PATTERNS.some((pattern) => pattern.test(bodyMd));
}

export function hasA2AToolCall(toolCalls: readonly string[]): boolean {
	return toolCalls.some((name) => name === "codeteam_a2a_send" || name.startsWith("codeteam_handoff_"));
}

export function observeMissingA2AToolCall(
	store: ControlStore,
	input: ObserveTerminalInput,
): MissingA2AToolCallObservation | null {
	const run = store.runs.get(input.runId);
	if (!run) throw new ControlError("not_found", `run ${input.runId} not found`);
	if (hasA2AToolCall(input.toolCalls) || !hasUnroutedA2AIntent(input.bodyMd)) return null;
	const subject = `run:${run.id}`;
	if (store.audit.latest(subject, "missing_a2a_tool_call")) return null;
	return store.transaction.run(() => {
		const audit = store.audit.append({
			actor: "system:a2a-observer",
			action: "missing_a2a_tool_call",
			subject,
			args: { tools: [...input.toolCalls] },
		});
		const evalRecord = store.evals.create({
			taskId: run.taskId,
			provider: run.provider,
			model: run.model,
			role: run.role,
			metrics: { a2a_tool_call_success: 0, missing_a2a_tool_call: 1 },
		});
		return {
			kind: "missing_a2a_tool_call",
			correction: A2A_SCHEMA_CORRECTION,
			auditId: audit.id,
			evalId: evalRecord.id,
		};
	});
}
