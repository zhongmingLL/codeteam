import { describe, expect, it } from "vitest";
import {
	A2A_ACTION_BY_TOOL,
	A2A_ALL_TOOL_NAMES,
	A2A_ALL_TOOL_SPECS,
	A2A_LEGACY_TOOL_NAMES,
	A2A_LEGACY_TOOL_PREFIX,
	A2A_LEGACY_TOOL_SPECS,
	A2A_TOOL_NAMES,
	A2A_TOOL_PREFIX,
	describeA2ATools,
} from "../src/a2a/tool-surface.ts";
import { hasA2AToolCall } from "../src/a2a/observation.ts";

describe("A2A tool naming migration", () => {
	it("maps every codeteam_* alias to the same action as its canonical tool", () => {
		expect(A2A_LEGACY_TOOL_NAMES).toHaveLength(A2A_TOOL_NAMES.length);
		for (const legacy of A2A_LEGACY_TOOL_NAMES) {
			const canonical = legacy.replace(A2A_LEGACY_TOOL_PREFIX, A2A_TOOL_PREFIX);
			expect(A2A_ACTION_BY_TOOL[legacy]).toBe(
				A2A_ACTION_BY_TOOL[canonical as keyof typeof A2A_ACTION_BY_TOOL],
			);
		}
		expect(A2A_LEGACY_TOOL_SPECS.map((spec) => spec.name)).toEqual([...A2A_LEGACY_TOOL_NAMES]);
		expect(A2A_ALL_TOOL_SPECS).toHaveLength(A2A_TOOL_NAMES.length * 2);
		expect(A2A_ALL_TOOL_NAMES).toEqual([...A2A_TOOL_NAMES, ...A2A_LEGACY_TOOL_NAMES]);
	});

	it("keeps the registered surface canonical and recognizes legacy calls in observation", () => {
		expect(describeA2ATools().map((spec) => spec.name)).toEqual([...A2A_TOOL_NAMES]);
		expect(hasA2AToolCall(["superagentteam_a2a_send"])).toBe(true);
		expect(hasA2AToolCall(["codeteam_a2a_send"])).toBe(true);
		expect(hasA2AToolCall(["codeteam_handoff_claim"])).toBe(true);
		expect(hasA2AToolCall(["read"])).toBe(false);
	});
});
