import { api } from "@/lib/api";
import type { ApiClient } from "@/lib/api/client.ts";

export type AgentStatus = "idle" | "thinking" | "working" | "error" | "offline";

export interface AgentView {
	id: string;
	displayName: string;
	avatar?: string;
	color?: { primary: string; secondary: string };
	enabled: boolean;
	status?: AgentStatus;
}

export interface AgentApi {
	list(): Promise<{ agents: AgentView[] }>;
}

export function createAgentApi(client: Pick<ApiClient, "get">): AgentApi {
	return {
		list: () => client.get<{ agents: AgentView[] }>("/api/agents"),
	};
}

export const agentApi = createAgentApi(api);
