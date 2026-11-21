import type { IncomingMessage, ServerResponse } from "node:http";

import type { A2ARuntime } from "../../domains/a2a/runtime.ts";
import type { ChangeBus } from "../../domains/events/bus.ts";
import { sendError, sendJson } from "../http.ts";
import { requireCsrf } from "../session.ts";
import type { ApiRouteContext } from "./context.ts";

const RETRY_PATH = /^\/api\/threads\/([^/]+)\/invocations\/([^/]+)\/retry$/;

export interface InvocationRoutes {
	handle(request: IncomingMessage, response: ServerResponse, url: URL, context: ApiRouteContext): boolean;
}

export interface InvocationRoutesOptions {
	runtime: A2ARuntime;
	changeBus?: ChangeBus;
}

function decodePath(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

export function createInvocationRoutes(options: InvocationRoutesOptions): InvocationRoutes {
	const { runtime } = options;

	function handle(request: IncomingMessage, response: ServerResponse, url: URL, context: ApiRouteContext): boolean {
		if (request.method !== "POST") return false;
		const match = RETRY_PATH.exec(url.pathname);
		if (!match) return false;

		const csrf = request.headers["x-csrf-token"];
		const csrfToken = Array.isArray(csrf) ? csrf[0] : csrf;
		if (!requireCsrf(context.session, csrfToken)) {
			sendError(response, 403, "csrf_failed", "invalid CSRF token");
			return true;
		}

		const threadId = decodePath(match[1]!);
		const invocationId = decodePath(match[2]!);
		if (threadId === null || invocationId === null) {
			sendError(response, 400, "invalid_input", "thread or invocation id is not valid URL encoding");
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
		const record = runtime.records.get(invocationId);
		if (!record || record.threadId !== threadId) {
			sendError(response, 404, "invocation_not_found", `invocation ${invocationId} not found in this thread`);
			return true;
		}

		let result: ReturnType<A2ARuntime["processor"]["requestRetry"]>;
		try {
			result = runtime.processor.requestRetry(invocationId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message === "invocation_not_found") {
				sendError(response, 404, "invocation_not_found", `invocation ${invocationId} not found`);
				return true;
			}
			if (
				message === "retry_admit_conflict" ||
				message === "retry_anchor_missing" ||
				message === "retry_anchor_not_queued"
			) {
				sendError(response, 409, "retry_conflict", message);
				return true;
			}
			sendError(response, 500, "retry_failed", message);
			return true;
		}

		if (result.outcome === "admitted") {
			options.changeBus?.publish(threadId, ["queue", "live"]);
			sendJson(response, 202, { status: "retrying", retriedAgentIds: result.retriedAgents });
			return true;
		}
		sendError(response, 409, result.outcome, `invocation ${invocationId} is not retryable`);
		return true;
	}

	return { handle };
}
