import type { IncomingMessage, ServerResponse } from "node:http";

import type { A2ARuntime } from "../../domains/a2a/runtime.ts";
import { sendError, sendJson } from "../http.ts";
import type { ApiRouteContext } from "./context.ts";

const DISABLED_READS: Record<string, Record<string, unknown>> = {
	"/api/backlog/items": { items: [] },
	"/api/approval-hub/pending": { items: [], count: 0 },
	"/api/approval-hub/settled": { items: [], count: 0 },
	"/api/tasks": { tasks: [] },
	"/api/labels": { labels: [] },
	"/api/config/cat-order": { catOrder: [] },
	"/api/config/thread-attention": { aliases: {}, open: {}, groups: [] },
	"/api/governance/health": { status: "ok" },
	"/api/bootcamp/threads": { threads: [] },
	"/api/artifacts": { artifacts: [], total: 0, complete: true, workLineage: "resolved" },
};

const THREAD_READS = /^\/api\/threads\/([^/]+)\/(artifacts|task-progress|active-pane)$/;
const THREAD_SCOPED = /^\/api\/threads\/([^/]+)\//;
const WORKFLOW_SOP = /^\/api\/backlog\/[^/]+\/workflow-sop$/;
const WORKSPACE = /^\/api\/(workspace|projects)(?:\/|$)/;
const LEGACY_WRITE_PREFIXES = [
	"/api/backlog",
	"/api/approval-hub",
	"/api/approvals",
	"/api/tasks",
	"/api/labels",
	"/api/bootcamp",
	"/api/config",
	"/api/workspace",
	"/api/projects",
	"/api/artifacts",
	"/api/guides",
	"/api/votes",
	"/api/search",
	"/api/attachments",
	"/api/message-bundles",
];

function disabled(response: ServerResponse, status: number, body: Record<string, unknown>): true {
	sendJson(response, status, { ...body, disabled: true });
	return true;
}

export interface LegacyRoutes {
	handle(request: IncomingMessage, response: ServerResponse, url: URL, context: ApiRouteContext): boolean;
}

export interface LegacyRoutesOptions {
	runtime: A2ARuntime;
}

export function createLegacyRoutes(options: LegacyRoutesOptions): LegacyRoutes {
	const { runtime } = options;

	function ownedThread(threadId: string, userId: string): "ok" | "missing" | "forbidden" {
		const thread = runtime.threads.get(threadId);
		if (!thread || (thread.deletedAt !== null && thread.deletedAt !== undefined)) return "missing";
		return thread.createdBy === userId ? "ok" : "forbidden";
	}

	function gate(response: ServerResponse, threadId: string, context: ApiRouteContext): boolean {
		const ownership = ownedThread(threadId, context.session.userId);
		if (ownership === "missing") {
			sendError(response, 404, "thread_not_found", `thread ${threadId} not found`);
			return false;
		}
		if (ownership === "forbidden") {
			sendError(response, 403, "forbidden", `thread ${threadId} belongs to another user`);
			return false;
		}
		return true;
	}

	function handle(request: IncomingMessage, response: ServerResponse, url: URL, context: ApiRouteContext): boolean {
		const threadMatch = THREAD_READS.exec(url.pathname);
		if (threadMatch && request.method === "GET") {
			let threadId: string;
			try {
				threadId = decodeURIComponent(threadMatch[1]!);
			} catch {
				sendError(response, 400, "invalid_input", "thread id is not valid URL encoding");
				return true;
			}
			if (!gate(response, threadId, context)) return true;
			const kind = threadMatch[2]!;
			if (kind === "task-progress") return disabled(response, 200, { taskProgress: {} });
			if (kind === "active-pane") return disabled(response, 200, { active: false });
			const view = url.searchParams.get("view");
			return disabled(response, 200, {
				artifacts: [],
				total: 0,
				complete: true,
				workLineage: "resolved",
				...(view === "works" ? { view: "works" } : {}),
			});
		}

		if (request.method === "GET") {
			const read = DISABLED_READS[url.pathname];
			if (read) {
				if (url.pathname === "/api/tasks") {
					const threadId = url.searchParams.get("threadId");
					if (threadId !== null && threadId.trim() !== "" && !gate(response, threadId, context)) return true;
				}
				return disabled(response, 200, read);
			}
			if (WORKFLOW_SOP.test(url.pathname)) {
				return disabled(response, 404, { error: "not_found", message: "workflow SOP is not available in v1" });
			}
		}

		if (request.method === "GET" && WORKSPACE.test(url.pathname)) {
			return disabled(response, 404, { error: "not_found", message: "workspace surface is not available in v1" });
		}
		if (WORKSPACE.test(url.pathname)) return disabled(response, 501, { error: "not_implemented" });

		const threadScoped = THREAD_SCOPED.exec(url.pathname);
		if (threadScoped && request.method !== "GET") {
			let threadId: string;
			try {
				threadId = decodeURIComponent(threadScoped[1]!);
			} catch {
				sendError(response, 400, "invalid_input", "thread id is not valid URL encoding");
				return true;
			}
			if (!gate(response, threadId, context)) return true;
			return disabled(response, 501, { error: "not_implemented" });
		}

		if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
			if (
				url.pathname.startsWith("/api/messages") ||
				LEGACY_WRITE_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
			) {
				if (url.pathname.startsWith("/api/messages")) {
					const threadId = url.searchParams.get("threadId");
					if (threadId !== null && threadId.trim() !== "" && !gate(response, threadId, context)) return true;
				}
				return disabled(response, 501, { error: "not_implemented" });
			}
		}

		return false;
	}

	return { handle };
}
