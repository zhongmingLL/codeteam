import type { IncomingMessage, ServerResponse } from "node:http";

import type { A2ARuntime } from "../domains/a2a/runtime.ts";
import type { AgentRegistry } from "../domains/agent/registry.ts";
import { verifyConsoleToken } from "./console-link.ts";
import { sendError, sendJson } from "./http.ts";
import { type AgentRoutes, createAgentRoutes } from "./routes/agents.ts";
import type { ApiRouteContext } from "./routes/context.ts";
import { createLiveRoutes, type LiveRoutes } from "./routes/live.ts";
import { createMessageRoutes, type MessageRoutes } from "./routes/messages.ts";
import { createQueueRoutes, type QueueRoutes } from "./routes/queue.ts";
import { createThreadRoutes } from "./routes/threads.ts";
import {
	hasForbiddenIdentityHeaders,
	isAllowedOrigin,
	readSessionId,
	SessionStore,
	serializeSessionCookie,
} from "./session.ts";

export const RELOGIN_HINT = "run `superagentteam auth console-link` and open the printed URL";

export interface BrowserApiOptions {
	dataDir: string;
	hubOrigin: string;
	clock?: () => number;
	secureCookies?: boolean;
	sessionStore?: SessionStore;
	a2a?: { runtime: A2ARuntime; registry: AgentRegistry };
}

export interface BrowserApi {
	handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
	sessions: SessionStore;
}

export function createBrowserApi(options: BrowserApiOptions): BrowserApi {
	const clock = options.clock ?? Date.now;
	const sessions = options.sessionStore ?? new SessionStore({ clock });
	const nonces = new Map<string, number>();
	const threadRoutes = options.a2a ? createThreadRoutes({ runtime: options.a2a.runtime, clock }) : null;
	const messageRoutes: MessageRoutes | null = options.a2a
		? createMessageRoutes({ runtime: options.a2a.runtime, clock })
		: null;
	const queueRoutes: QueueRoutes | null = options.a2a ? createQueueRoutes({ runtime: options.a2a.runtime }) : null;
	const liveRoutes: LiveRoutes | null = options.a2a ? createLiveRoutes({ runtime: options.a2a.runtime }) : null;
	const agentRoutes: AgentRoutes | null = options.a2a
		? createAgentRoutes({ registry: options.a2a.registry, tracker: options.a2a.runtime.tracker, clock })
		: null;

	function sendUnauthorized(response: ServerResponse, message: string): void {
		sendJson(response, 401, { error: "unauthorized", message, relogin_hint: RELOGIN_HINT });
	}

	function consumeNonce(nonce: string, expiresAt: number, now: number): boolean {
		for (const [value, expiry] of nonces) {
			if (expiry <= now) nonces.delete(value);
		}
		if (nonces.has(nonce)) return false;
		if (expiresAt <= now) return false;
		nonces.set(nonce, expiresAt);
		return true;
	}

	function authenticate(request: IncomingMessage, response: ServerResponse): ApiRouteContext | null {
		const origin = request.headers.origin;
		if (origin !== undefined && !isAllowedOrigin(origin, options.hubOrigin)) {
			sendError(response, 403, "forbidden", "origin not allowed");
			return null;
		}
		if (hasForbiddenIdentityHeaders(request.headers)) {
			sendError(response, 403, "forbidden", "identity must come from the browser session");
			return null;
		}
		const sessionId = readSessionId(request.headers);
		if (!sessionId) {
			sendUnauthorized(response, "missing browser session");
			return null;
		}
		const session = sessions.get(sessionId, clock());
		if (!session) {
			sendUnauthorized(response, "browser session expired");
			return null;
		}
		return { session, origin };
	}

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");

		if (request.method === "GET" && url.pathname === "/auth/console") {
			const origin = request.headers.origin;
			if (origin !== undefined && !isAllowedOrigin(origin, options.hubOrigin)) {
				sendError(response, 403, "forbidden", "origin not allowed");
				return true;
			}
			const token = url.searchParams.get("token");
			if (!token) {
				sendUnauthorized(response, "missing console token");
				return true;
			}
			try {
				const payload = verifyConsoleToken({ dataDir: options.dataDir, token, now: clock() });
				if (!consumeNonce(payload.nonce, payload.exp, clock())) {
					sendUnauthorized(response, "console token was already used or expired");
					return true;
				}
				const session = sessions.create(payload.sub, clock());
				// Keep the token-bearing URL out of any Referer; a future multi-origin
				// allowlist must choose the matched origin rather than a single field.
				response.writeHead(302, {
					location: options.hubOrigin,
					"cache-control": "no-store",
					"referrer-policy": "no-referrer",
					"set-cookie": serializeSessionCookie(session.id, {
						secure: options.secureCookies ?? false,
					}),
				});
				response.end();
			} catch {
				sendUnauthorized(response, "invalid console token");
			}
			return true;
		}

		if (request.method === "GET" && url.pathname === "/api/session") {
			const context = authenticate(request, response);
			if (!context) return true;
			const { session } = context;
			sendJson(
				response,
				200,
				{ userId: session.userId, csrfToken: session.csrfToken },
				{
					"set-cookie": serializeSessionCookie(session.id, {
						secure: options.secureCookies ?? false,
					}),
				},
			);
			return true;
		}

		if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
			const context = authenticate(request, response);
			if (!context) return true;
			if (threadRoutes && (await threadRoutes.handle(request, response, url, context))) return true;
			if (queueRoutes?.handle(request, response, url, context)) return true;
			if (liveRoutes?.handle(request, response, url, context)) return true;
			if (messageRoutes && (await messageRoutes.handle(request, response, url, context))) return true;
			if (agentRoutes?.handle(request, response, url)) return true;
			if (!threadRoutes || !messageRoutes || !queueRoutes || !liveRoutes || !agentRoutes) {
				sendError(response, 503, "unavailable", "A2A runtime is not available in this daemon mode");
				return true;
			}
			sendError(response, 404, "not_found", "unknown API route");
			return true;
		}

		return false;
	}

	return { handle, sessions };
}
