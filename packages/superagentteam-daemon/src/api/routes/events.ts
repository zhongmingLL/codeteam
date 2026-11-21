import type { IncomingMessage, ServerResponse } from "node:http";

import type { A2ARuntime } from "../../domains/a2a/runtime.ts";
import type { ChangeBus } from "../../domains/events/bus.ts";
import { sendError } from "../http.ts";
import type { SessionStore } from "../session.ts";
import type { ApiRouteContext } from "./context.ts";

const EVENTS_PATH = "/api/events";
const DEFAULT_HEARTBEAT_MS = 15_000;

export interface EventRoutesOptions {
	runtime: A2ARuntime;
	bus: ChangeBus;
	sessions: SessionStore;
	clock?: () => number;
	heartbeatMs?: number;
}

export interface EventRoutes {
	handle(request: IncomingMessage, response: ServerResponse, url: URL, context: ApiRouteContext): boolean;
}

function writeSse(response: ServerResponse, event: string, data: unknown): void {
	response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createEventRoutes(options: EventRoutesOptions): EventRoutes {
	const clock = options.clock ?? Date.now;
	const heartbeatMs = Math.max(50, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

	function handle(request: IncomingMessage, response: ServerResponse, url: URL, context: ApiRouteContext): boolean {
		if (request.method !== "GET" || url.pathname !== EVENTS_PATH) return false;
		const threadId = url.searchParams.get("threadId");
		if (threadId === null || threadId.trim() === "") {
			sendError(response, 400, "invalid_input", "threadId is required");
			return true;
		}
		const thread = options.runtime.threads.get(threadId);
		if (!thread || (thread.deletedAt !== null && thread.deletedAt !== undefined)) {
			sendError(response, 404, "thread_not_found", `thread ${threadId} not found`);
			return true;
		}
		if (thread.createdBy !== context.session.userId) {
			sendError(response, 403, "forbidden", `thread ${threadId} belongs to another user`);
			return true;
		}

		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		});
		writeSse(response, "ready", { threadId });
		response.flushHeaders?.();

		let closed = false;
		let timer: ReturnType<typeof setInterval> | undefined;
		let unsubscribe: (() => void) | undefined;

		const cleanup = (): void => {
			if (closed) return;
			closed = true;
			if (timer !== undefined) clearInterval(timer);
			unsubscribe?.();
			if (!response.writableEnded) response.end();
		};

		unsubscribe = options.bus.subscribe(threadId, (event) => {
			if (closed) return;
			try {
				writeSse(response, "change", event);
			} catch {
				cleanup();
			}
		});

		timer = setInterval(() => {
			if (closed) return;
			if (!options.sessions.get(context.session.id, clock())) {
				cleanup();
				return;
			}
			try {
				response.write(": ping\n\n");
			} catch {
				cleanup();
			}
		}, heartbeatMs);
		timer.unref?.();

		response.on("close", cleanup);
		return true;
	}

	return { handle };
}
