import type { ToolCategory } from "./contracts.ts";

export interface ToolClassification {
	readonly category: ToolCategory;
	/** For skills: the extracted skill name. For others: the raw tool name. */
	readonly toolName: string;
}

const MAX_TOOL_NAME = 200;

/**
 * F150 parity classification. Keep this aligned with clowder's tool usage
 * classifier: `Skill` -> skill (name from input.skill), `mcp__`/`mcp:` -> mcp,
 * everything else -> native.
 */
export function classifyTool(toolName: string, toolInput?: Record<string, unknown>): ToolClassification {
	if (toolName === "Skill") {
		const skillName = toolInput && typeof toolInput.skill === "string" ? toolInput.skill : "unknown";
		return { category: "skill", toolName: normalizeToolName(skillName) };
	}
	if (toolName.startsWith("mcp__") || toolName.startsWith("mcp:")) {
		return { category: "mcp", toolName: normalizeToolName(toolName) };
	}
	return { category: "native", toolName: normalizeToolName(toolName) };
}

export function normalizeToolName(value: string): string {
	const trimmed = value.trim();
	if (trimmed === "") return "unknown";
	return trimmed.length > MAX_TOOL_NAME ? trimmed.slice(0, MAX_TOOL_NAME) : trimmed;
}
