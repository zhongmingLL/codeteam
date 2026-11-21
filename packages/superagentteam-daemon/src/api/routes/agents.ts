import type { IncomingMessage, ServerResponse } from "node:http";

import type { AgentConfig } from "@superagentteam/shared/types";

import type { AgentRegistry } from "../../domains/agent/registry.ts";
import type { InvocationTracker } from "../../domains/queue/tracker.ts";
import { sendJson } from "../http.ts";

export type AgentStatus = "idle" | "thinking" | "working" | "error" | "offline";

export interface AgentView {
	id: string;
	displayName: string;
	avatar?: string;
	color?: { primary: string; secondary: string };
	enabled: boolean;
	status?: AgentStatus;
}

export interface HubCatView extends AgentView {
	catId: string;
}

export interface AgentRoutes {
	handle(request: IncomingMessage, response: ServerResponse, url: URL): boolean;
}

export interface AgentRoutesOptions {
	registry: AgentRegistry;
	tracker: InvocationTracker;
	clock?: () => number;
}

function toView(agent: AgentConfig, activeAgents: ReadonlySet<string>): AgentView {
	// Global summary only. Multi-thread busy state belongs to
	// GET /api/threads/:id/live; do not paint this as per-thread presence.
	const status: AgentStatus = !agent.enabled ? "offline" : activeAgents.has(agent.id) ? "working" : "idle";
	return {
		id: agent.id,
		displayName: agent.displayName,
		...(agent.avatar ? { avatar: agent.avatar } : {}),
		...(agent.color ? { color: { ...agent.color } } : {}),
		enabled: agent.enabled,
		status,
	};
}

export function createAgentRoutes(options: AgentRoutesOptions): AgentRoutes {
	const { registry, tracker } = options;
	const clock = options.clock ?? Date.now;

	function views(): AgentView[] {
		const activeAgents = new Set(tracker.listStaleSlots(clock(), 0).map((slot) => slot.agentId));
		return [...registry.agents.values()].map((agent) => toView(agent, activeAgents));
	}

	function handle(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
		if (request.method !== "GET") return false;
		if (url.pathname === "/api/agents") {
			sendJson(response, 200, { agents: views() });
			return true;
		}
		if (url.pathname === "/api/cats") {
			const cats: HubCatView[] = views().map((agent) => ({ ...agent, catId: agent.id }));
			sendJson(response, 200, { cats });
			return true;
		}
		if (url.pathname === "/api/config") {
			sendJson(response, 200, { config: { ui: { bubbleDefaults: {} } } });
			return true;
		}
		return false;
	}

	return { handle };
}
