import type { IncomingMessage, ServerResponse } from "node:http";

import type { A2ARuntime } from "../../domains/a2a/runtime.ts";
import { getThreadLiveInvocations } from "../../domains/invocation/live.ts";
import { sendError, sendJson } from "../http.ts";
import type { ApiRouteContext } from "./context.ts";

const LIVE_PATH = /^\/api\/threads\/([^/]+)\/live$/;

export interface LiveRoutes {
	handle(request: IncomingMessage, response: ServerResponse, url: URL, context: ApiRouteContext): boolean;
}

export interface LiveRoutesOptions {
	runtime: A2ARuntime;
}

export function createLiveRoutes(options: LiveRoutesOptions): LiveRoutes {
	const { runtime } = options;

	function handle(request: IncomingMessage, response: ServerResponse, url: URL, context: ApiRouteContext): boolean {
		if (request.method !== "GET") return false;
		const match = LIVE_PATH.exec(url.pathname);
		if (!match) return false;
		let threadId: string;
		try {
			threadId = decodeURIComponent(match[1]!);
		} catch {
			sendError(response, 400, "invalid_input", "thread id is not valid URL encoding");
			return true;
		}
		const thread = runtime.threads.get(threadId);
		if (!thread || (thread.deletedAt !== null && thread.deletedAt !== undefined)) {
			sendError(response, 404, "thread_not_found", `thread ${threadId} not found`);
			return true;
		}
		if (thread.createdBy !== context.session.userId) {
			sendError(response, 403, "forbidden", `thread ${threadId} belongs to another user`);
			return true;
		}
		const invocations = getThreadLiveInvocations(
			{ tracker: runtime.tracker, turns: runtime.turns, attempts: runtime.attempts, messages: runtime.messages },
			threadId,
		);
		sendJson(response, 200, { threadId, invocations });
		return true;
	}

	return { handle };
}
