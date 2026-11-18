// TASK-BOUND LEGACY (F018 R1-0 boundary marker): this shared module still
// contains task-first branches. It is NOT split in R1-0; the task-bound parts
// move to src/legacy/task-first/ in later rounds (see docs/legacy/task-first/INDEX.md).
// Do not add new task-first behavior here.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { A2A_ALL_TOOL_NAMES, A2A_TOOL_NAMES } from "../a2a/tool-surface.ts";
import { ControlError } from "../control/errors.ts";
import type { Task } from "../control/stores/types.ts";
import { assertReadablePath, assertWritablePath, createToolPolicy, evaluateCommand } from "../policy/index.ts";
import type { ToolPolicy, ToolRole } from "../policy/types.ts";

export const READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];
export const CODER_TOOLS: readonly string[] = [...READ_ONLY_TOOLS, "bash", "edit", "write"];

function a2aTool(suffix: string): readonly string[] {
	return A2A_TOOL_NAMES.filter((name) => name.endsWith(`_${suffix}`));
}

const A2A_SEND_TOOLS = a2aTool("a2a_send");
const A2A_HANDOFF_CREATE = a2aTool("handoff_create");
const A2A_HANDOFF_CLAIM = a2aTool("handoff_claim");
const A2A_HANDOFF_COMPLETE = a2aTool("handoff_complete");
const A2A_HANDOFF_WITHDRAW = a2aTool("handoff_withdraw");
const THREAD_CONTEXT_TOOLS = a2aTool("thread_context");
if (A2A_SEND_TOOLS.length === 0 || THREAD_CONTEXT_TOOLS.length === 0) {
	throw new ControlError("invalid_state", "A2A tool names are not registered");
}

const A2A_ROLE_TOOLS: Record<string, readonly string[]> = {
	architect: [...A2A_SEND_TOOLS, ...A2A_HANDOFF_CREATE, ...A2A_HANDOFF_WITHDRAW, ...THREAD_CONTEXT_TOOLS],
	coder: [
		...A2A_SEND_TOOLS,
		...A2A_HANDOFF_CREATE,
		...A2A_HANDOFF_CLAIM,
		...A2A_HANDOFF_COMPLETE,
		...A2A_HANDOFF_WITHDRAW,
		...THREAD_CONTEXT_TOOLS,
	],
	reviewer: [...A2A_SEND_TOOLS, ...A2A_HANDOFF_CLAIM, ...A2A_HANDOFF_COMPLETE, ...THREAD_CONTEXT_TOOLS],
	verifier: [...A2A_SEND_TOOLS, ...A2A_HANDOFF_CLAIM, ...A2A_HANDOFF_COMPLETE, ...THREAD_CONTEXT_TOOLS],
};

const DEFAULT_A2A_TOOLS = [...A2A_SEND_TOOLS, ...THREAD_CONTEXT_TOOLS];

export interface WorkerToolPolicyContext {
	readonly role: string;
	readonly task: Task;
	readonly dataDir: string;
	readonly runId: string;
}

export interface WorkerToolCall {
	readonly toolName: string;
	readonly input: Record<string, unknown>;
}

export interface WorkerToolPolicyDecision {
	readonly allow: boolean;
	readonly code?: string;
	readonly reason?: string;
}

export function toolRoleForSessionRole(role: string): ToolRole {
	if (role === "coder") return "coder";
	if (role === "verifier") return "verifier";
	return "reviewer";
}

export function allowedToolsForRole(role: string): readonly string[] {
	const toolRole = toolRoleForSessionRole(role);
	const fileTools = toolRole === "coder" || toolRole === "verifier" ? CODER_TOOLS : READ_ONLY_TOOLS;
	return [...fileTools, ...a2aToolsForRole(role)];
}

export function a2aToolsForRole(role: string): readonly string[] {
	return A2A_ROLE_TOOLS[role] ?? DEFAULT_A2A_TOOLS;
}

export function allowedToolsForToolRole(role: ToolRole): readonly string[] {
	return role === "reviewer" ? READ_ONLY_TOOLS : CODER_TOOLS;
}

export function isReadOnlyTool(toolName: string): boolean {
	return READ_ONLY_TOOLS.includes(toolName);
}

export function evaluateWorkerToolCall(
	context: WorkerToolPolicyContext,
	call: WorkerToolCall,
): WorkerToolPolicyDecision {
	try {
		if ((A2A_ALL_TOOL_NAMES as readonly string[]).includes(call.toolName)) {
			if (!a2aToolsForRole(context.role).includes(call.toolName)) {
				return {
					allow: false,
					code: "tool_not_allowed_for_role",
					reason: `A2A tool ${call.toolName} is not allowed for role ${context.role}`,
				};
			}
			return { allow: true };
		}
		const toolRole = toolRoleForSessionRole(context.role);
		const allowed = allowedToolsForToolRole(toolRole);
		if (!allowed.includes(call.toolName)) {
			return {
				allow: false,
				code: "tool_not_allowed_for_role",
				reason: `tool ${call.toolName} is not allowed for role ${context.role}`,
			};
		}
		const policy = policyForWorker(context, toolRole);
		switch (call.toolName) {
			case "read": {
				const path = pathInput(call.input);
				if (path === null) return { allow: false, code: "missing_path", reason: "path is required" };
				assertReadablePath(policy, path, policy.cwd);
				return { allow: true };
			}
			case "grep":
			case "find":
			case "ls": {
				const path = pathInput(call.input);
				if (path !== null) assertReadablePath(policy, path, policy.cwd);
				return { allow: true };
			}
			case "edit":
			case "write": {
				const path = pathInput(call.input);
				if (path === null) return { allow: false, code: "missing_path", reason: "path is required" };
				assertWritablePath(policy, path, policy.cwd);
				return { allow: true };
			}
			case "bash": {
				const command = typeof call.input.command === "string" ? call.input.command : "";
				if (command.trim() === "") return { allow: false, code: "missing_command", reason: "command is required" };
				const argv = parseSimpleCommand(command);
				const execution = evaluateCommand(policy, { argv, cwd: policy.cwd });
				if (execution.argv.length === 0) {
					return { allow: false, code: "empty_command", reason: "empty command" };
				}
				return { allow: true };
			}
			default:
				return { allow: false, code: "unknown_tool", reason: `unknown tool ${call.toolName}` };
		}
	} catch (error) {
		if (error instanceof ControlError) {
			return { allow: false, code: error.code, reason: error.message };
		}
		return {
			allow: false,
			code: "policy_error",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

export function policyForWorker(context: WorkerToolPolicyContext, toolRole: ToolRole): ToolPolicy {
	if (!context.task.worktree) {
		throw new ControlError("invalid_input", `task ${context.task.id} has no worktree`);
	}
	const evidenceRoot = join(context.dataDir, "evidence", context.runId);
	mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
	return createToolPolicy({
		role: toolRole,
		dataDir: context.dataDir,
		worktreeRoot: context.task.worktree,
		evidenceRoot: toolRole === "coder" ? null : evidenceRoot,
	});
}

function pathInput(input: Record<string, unknown>): string | null {
	const value = input.path;
	if (typeof value !== "string" || value.trim() === "") return null;
	return value;
}

/**
 * Parse a conservative subset of shell syntax into argv.
 *
 * pi's bash tool ultimately executes through a shell. This parser is intentionally
 * narrower: it accepts whitespace and single/double quoted literal words, while
 * rejecting every construct whose shell meaning differs from argv splitting
 * (metacharacters, expansion, backslash escapes, comments outside quotes).
 */
export function parseSimpleCommand(command: string): string[] {
	const argv: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let started = false;
	for (const char of command) {
		if (quote === null) {
			if (char === "'" || char === '"') {
				quote = char;
				started = true;
				continue;
			}
			if (/\s/.test(char)) {
				if (started) {
					argv.push(current);
					current = "";
					started = false;
				}
				continue;
			}
			if (/[|&;<>()`$\\\n\r]/.test(char) || char === "#") {
				throw new ControlError("forbidden", `shell syntax is not allowed: ${char}`);
			}
			current += char;
			started = true;
			continue;
		}
		if (char === quote) {
			quote = null;
			continue;
		}
		if (quote === '"' && /[\\$`]/.test(char)) {
			throw new ControlError("forbidden", `shell expansion is not allowed inside double quotes: ${char}`);
		}
		current += char;
		started = true;
	}
	if (quote !== null) throw new ControlError("forbidden", "unterminated shell quote");
	if (started) argv.push(current);
	if (argv.length === 0) throw new ControlError("forbidden", "empty command");
	return argv;
}
