import { describe, expect, it } from "vitest";
import { hasA2AToolCall } from "../src/a2a/observation.ts";
import {
	A2A_ACTION_BY_TOOL,
	A2A_ALL_TOOL_NAMES,
	A2A_ALL_TOOL_SPECS,
	A2A_TOOL_NAMES,
	A2A_TOOL_PREFIX,
	describeA2ATools,
} from "../src/a2a/tool-surface.ts";

describe("A2A tool surface", () => {
	it("registers only canonical superagentteam_* names", () => {
		expect(A2A_TOOL_NAMES.every((name) => name.startsWith(A2A_TOOL_PREFIX))).toBe(true);
		expect(A2A_ALL_TOOL_NAMES).toEqual(A2A_TOOL_NAMES);
		expect(A2A_ALL_TOOL_SPECS).toEqual(describeA2ATools());
		expect(Object.keys(A2A_ACTION_BY_TOOL)).toEqual([...A2A_TOOL_NAMES]);
	});

	it("recognizes only canonical tool calls in observation", () => {
		expect(hasA2AToolCall(["superagentteam_a2a_send"])).toBe(true);
		expect(hasA2AToolCall(["superagentteam_handoff_claim"])).toBe(true);
		expect(hasA2AToolCall(["codeteam_a2a_send"])).toBe(false);
		expect(hasA2AToolCall(["codeteam_handoff_claim"])).toBe(false);
		expect(hasA2AToolCall(["read"])).toBe(false);
	});
});
