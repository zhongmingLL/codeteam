import { create } from "zustand";

import { type AgentApi, type AgentView, agentApi } from "./api.ts";

export type AgentListStatus = "idle" | "loading" | "ready" | "error";

export interface AgentState {
	agents: AgentView[];
	status: AgentListStatus;
	error?: string;
	load(): Promise<void>;
	refresh(): Promise<boolean>;
}

export interface AgentStoreDeps {
	api: Pick<AgentApi, "list">;
}

function messageOf(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

export function createAgentStore(deps: AgentStoreDeps) {
	return create<AgentState>((set, get) => ({
		agents: [],
		status: "idle",
		error: undefined,

		async load() {
			set({ status: "loading", error: undefined });
			try {
				const body = await deps.api.list();
				set({ agents: body.agents, status: "ready", error: undefined });
			} catch (error) {
				set({ status: "error", error: messageOf(error, "无法加载 agents") });
			}
		},

		async refresh() {
			try {
				const body = await deps.api.list();
				set({ agents: body.agents, status: "ready", error: undefined });
				return true;
			} catch (error) {
				set({
					status: get().agents.length === 0 ? "error" : "ready",
					error: messageOf(error, "无法加载 agents"),
				});
				return false;
			}
		},
	}));
}

export const useAgentStore = createAgentStore({ api: agentApi });
