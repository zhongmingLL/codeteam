import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export type CodeteamRole = "architect" | "coder" | "reviewer" | "verifier";

export interface RoleDefinition {
	role: CodeteamRole;
	tools: string[];
	systemPrompt: string;
	persistentSession: boolean;
}

export const ROLE_DEFINITIONS: Record<CodeteamRole, RoleDefinition> = {
	architect: {
		role: "architect",
		tools: ["read", "grep", "find", "ls"],
		systemPrompt:
			"You are codeteam's architect. Clarify the goal, identify constraints, and produce a short spec and plan with acceptance criteria. Do not modify files. Prefer facts from the repository over assumptions.",
		persistentSession: true,
	},
	coder: {
		role: "coder",
		tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
		systemPrompt:
			"You are codeteam's coder. Implement the requested change in the current worktree. Read before editing, keep changes minimal, run targeted tests, and report the exact commands and results. Do not merge, push, or run destructive commands.",
		persistentSession: true,
	},
	reviewer: {
		role: "reviewer",
		tools: ["read", "grep", "find", "ls"],
		systemPrompt:
			"You are codeteam's reviewer. Review only the provided diff, constraints, and evidence. Do not trust the author's summary. Every P1/P2 finding must include an executable falsifier; if you cannot substantiate it, mark it P3. Return a typed verdict with findings.",
		persistentSession: false,
	},
	verifier: {
		role: "verifier",
		tools: ["read", "bash", "grep", "find", "ls"],
		systemPrompt:
			"You are codeteam's verifier. Execute the provided falsifiers and tests, then report pass/fail with exact commands and artifacts. Do not modify source. A finding is closed only by evidence.",
		persistentSession: false,
	},
};

export interface CreateCodeteamSessionOptions {
	role: CodeteamRole;
	cwd: string;
	agentDir?: string;
	model: Model<Api>;
	modelRuntime: ModelRuntime;
	sessionManager?: SessionManager;
	tools?: string[];
	customTools?: ToolDefinition[];
	extensionFactories?: ExtensionFactory[];
}

/**
 * Create one role-scoped pi AgentSession.
 *
 * Role policy lives here; the agent loop, built-in tools, session persistence,
 * compaction, and model runtime stay owned by pi. Callers can override tools or
 * inject codeteam custom tools without patching the kernel.
 */
export async function createCodeteamSession(options: CreateCodeteamSessionOptions): Promise<AgentSession> {
	const definition = ROLE_DEFINITIONS[options.role];
	const agentDir = options.agentDir ?? join(options.cwd, ".codeteam", "agent");
	mkdirSync(agentDir, { recursive: true });

	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		appendSystemPrompt: [definition.systemPrompt],
		...(options.extensionFactories ? { extensionFactories: options.extensionFactories } : {}),
	});
	await resourceLoader.reload();

	const sessionManager =
		options.sessionManager ??
		(definition.persistentSession
			? SessionManager.create(options.cwd, join(agentDir, "sessions"))
			: SessionManager.inMemory(options.cwd));

	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir,
		model: options.model,
		modelRuntime: options.modelRuntime,
		settingsManager,
		sessionManager,
		resourceLoader,
		tools: options.tools ?? definition.tools,
		...(options.customTools ? { customTools: options.customTools } : {}),
	});
	return session;
}
