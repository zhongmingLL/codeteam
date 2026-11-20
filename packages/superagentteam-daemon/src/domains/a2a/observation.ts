// F018 R4-d observation (0005 E12 / 0007 §3.0, §3.8).
//
// v1 has four model-facing A2A tools. Observation recognizes those typed
// calls only; it never scans an agent final response for routing intent.
// 0007 §3.0 is explicit: agent final responses and A2A tool bodies are not
// parsed for `@`, and text `@` is a visible marker rather than a route.
// The legacy `missing_a2a_tool_call` signal is therefore retired for
// final-response text in v1; keeping it would recreate text-routing
// authority through the telemetry path.

export const V1_A2A_TOOL_NAMES = [
	"superagentteam_post_message",
	"superagentteam_cross_post_message",
	"superagentteam_multi_mention",
	"superagentteam_thread_context",
] as const;

export type V1A2AToolName = (typeof V1_A2A_TOOL_NAMES)[number];

const A2A_TOOL_PREFIX = "superagentteam_";
const V1_TOOL_SET: ReadonlySet<string> = new Set(V1_A2A_TOOL_NAMES);
const BARE_TO_CANONICAL: ReadonlyMap<string, V1A2AToolName> = new Map(
	V1_A2A_TOOL_NAMES.map((name) => [name.slice(A2A_TOOL_PREFIX.length), name]),
);

/**
 * Canonical is `superagentteam_*`; the credential allowlist stores the bare
 * suffix (`post_message` …). Accept either at the observation boundary so a
 * worker event cannot be misclassified by transport naming, but never accept
 * the retired send / handoff families.
 */
export function normalizeV1A2AToolName(toolName: string): V1A2AToolName | null {
	const name = toolName.trim();
	if (V1_TOOL_SET.has(name)) return name as V1A2AToolName;
	return BARE_TO_CANONICAL.get(name) ?? null;
}

export function findV1A2AToolCall(toolNames: readonly string[]): V1A2AToolName | null {
	for (const toolName of toolNames) {
		const normalized = normalizeV1A2AToolName(toolName);
		if (normalized) return normalized;
	}
	return null;
}

export function hasV1A2AToolCall(toolNames: readonly string[]): boolean {
	return findV1A2AToolCall(toolNames) !== null;
}

export interface ObserveA2ATurnInput {
	/** Agent final response; intentionally not parsed for routing (0007 §3.0). */
	readonly finalResponse: string;
	readonly toolCalls: readonly string[];
}

export interface A2ATurnObservation {
	readonly kind: "a2a_tool_call" | "no_a2a_tool_call";
	readonly tool: V1A2AToolName | null;
	/** v1 always null: final-response text `@` is never a missing-tool error. */
	readonly missingA2AToolCall: null;
}

export function observeA2ATurn(input: ObserveA2ATurnInput): A2ATurnObservation {
	const tool = findV1A2AToolCall(input.toolCalls);
	// `input.finalResponse` is deliberately ignored. v1 does not infer an
	// intended route from prose, so there is no positive signal to emit.
	void input.finalResponse;
	return {
		kind: tool ? "a2a_tool_call" : "no_a2a_tool_call",
		tool,
		missingA2AToolCall: null,
	};
}

/**
 * Compatibility shape for eval consumers that used the legacy observer.
 * v1 always returns null: text `@` in an agent final response is plain text,
 * and only typed tool calls carry A2A routing authority.
 */
export function observeMissingA2AToolCall(input: ObserveA2ATurnInput): null {
	return observeA2ATurn(input).missingA2AToolCall;
}
