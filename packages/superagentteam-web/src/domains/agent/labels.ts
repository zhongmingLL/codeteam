import type { AgentStatus, AgentView } from "./api.ts";

export function agentDisplayName(agents: readonly AgentView[], agentId: string): string {
	return agents.find((agent) => agent.id === agentId)?.displayName ?? agentId;
}

export function agentStatusLabel(status: AgentStatus | undefined): string {
	switch (status) {
		case "idle":
			return "空闲";
		case "thinking":
			return "思考中";
		case "working":
			return "工作中";
		case "error":
			return "出错";
		case "offline":
			return "离线";
		default:
			return "状态未知";
	}
}
