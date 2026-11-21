import type { IncomingMessage, ServerResponse } from "node:http";

import { verifyConsoleToken } from "./console-link.ts";
import { sendError, sendJson } from "./http.ts";
import {
	hasForbiddenIdentityHeaders,
	isAllowedOrigin,
	readSessionId,
	serializeSessionCookie,
	SessionStore,
} from "./session.ts";

export interface BrowserApiOptions {
	dataDir: string;
	hubOrigin: string;
	clock?: () => number;
	secureCookies?: boolean;
	sessionStore?: SessionStore;
}

export interface BrowserApi {
	handle(request: IncomingMessage, response: ServerResponse): boolean;
	sessions: SessionStore;
}

export function createBrowserApi(options: BrowserApiOptions): BrowserApi {
	const clock = options.clock ?? Date.now;
	const sessions = options.sessionStore ?? new SessionStore({ clock });
	const nonces = new Map<string, number>();

	function consumeNonce(nonce: string, expiresAt: number, now: number): boolean {
		for (const [value, expiry] of nonces) {
			if (expiry <= now) nonces.delete(value);
		}
		if (nonces.has(nonce)) return false;
		if (expiresAt <= now) return false;
		nonces.set(nonce, expiresAt);
		return true;
	}

	function handle(request: IncomingMessage, response: ServerResponse): boolean {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");

		if (request.method === "GET" && url.pathname === "/auth/console") {
			const origin = request.headers.origin;
			if (origin !== undefined && !isAllowedOrigin(origin, options.hubOrigin)) {
				sendError(response, 403, "forbidden", "origin not allowed");
				return true;
			}
			const token = url.searchParams.get("token");
			if (!token) {
				sendError(response, 401, "unauthorized", "missing console token");
				return true;
			}
			try {
				const payload = verifyConsoleToken({ dataDir: options.dataDir, token, now: clock() });
				if (!consumeNonce(payload.nonce, payload.exp, clock())) {
					sendError(response, 401, "unauthorized", "console token was already used or expired");
					return true;
				}
				const session = sessions.create(payload.sub, clock());
				response.writeHead(302, {
					location: options.hubOrigin,
					"cache-control": "no-store",
					"set-cookie": serializeSessionCookie(session.id, {
						secure: options.secureCookies ?? false,
					}),
				});
				response.end();
			} catch {
				sendError(response, 401, "unauthorized", "invalid console token");
			}
			return true;
		}

		if (request.method === "GET" && url.pathname === "/api/session") {
			const origin = request.headers.origin;
			if (origin !== undefined && !isAllowedOrigin(origin, options.hubOrigin)) {
				sendError(response, 403, "forbidden", "origin not allowed");
				return true;
			}
			if (hasForbiddenIdentityHeaders(request.headers)) {
				sendError(response, 403, "forbidden", "identity must come from the browser session");
				return true;
			}
			const sessionId = readSessionId(request.headers);
			if (!sessionId) {
				sendError(response, 401, "unauthorized", "missing browser session");
				return true;
			}
			const session = sessions.get(sessionId, clock());
			if (!session) {
				sendError(response, 401, "unauthorized", "browser session expired");
				return true;
			}
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

		return false;
	}

	return { handle, sessions };
}
