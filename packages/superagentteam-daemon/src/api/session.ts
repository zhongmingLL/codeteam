import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const SESSION_COOKIE_NAME = "superagentteam_session";
export const DEFAULT_SESSION_IDLE_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000;

const FORBIDDEN_IDENTITY_HEADERS = [
	"authorization",
	"x-invocation-id",
	"x-callback-token",
	"x-agent-key-secret",
	"x-cat-cafe-user",
] as const;

export interface BrowserSession {
	id: string;
	userId: string;
	csrfToken: string;
	createdAt: number;
	lastSeenAt: number;
	expiresAt: number;
}

export interface SessionStoreOptions {
	clock?: () => number;
	idleTtlMs?: number;
	absoluteTtlMs?: number;
}

export class SessionStore {
	private readonly sessions = new Map<string, BrowserSession>();
	private readonly clock: () => number;
	private readonly idleTtlMs: number;
	private readonly absoluteTtlMs: number;

	constructor(options: SessionStoreOptions = {}) {
		this.clock = options.clock ?? Date.now;
		this.idleTtlMs = options.idleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;
		this.absoluteTtlMs = options.absoluteTtlMs ?? DEFAULT_SESSION_ABSOLUTE_TTL_MS;
	}

	create(userId: string, now = this.clock()): BrowserSession {
		const session: BrowserSession = {
			id: randomUUID(),
			userId,
			csrfToken: randomUUID(),
			createdAt: now,
			lastSeenAt: now,
			expiresAt: Math.min(now + this.idleTtlMs, now + this.absoluteTtlMs),
		};
		this.sessions.set(session.id, session);
		return session;
	}

	get(id: string, now = this.clock()): BrowserSession | null {
		const session = this.sessions.get(id);
		if (!session) return null;
		if (now >= session.expiresAt || now >= session.createdAt + this.absoluteTtlMs) {
			this.sessions.delete(id);
			return null;
		}
		session.lastSeenAt = now;
		session.expiresAt = Math.min(now + this.idleTtlMs, session.createdAt + this.absoluteTtlMs);
		return session;
	}

	delete(id: string): void {
		this.sessions.delete(id);
	}
}

export function parseCookies(header: string | undefined): Record<string, string> {
	if (!header) return {};
	const cookies: Record<string, string> = {};
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index <= 0) continue;
		const name = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();
		if (name) cookies[name] = value;
	}
	return cookies;
}

export function readSessionId(headers: IncomingHttpHeaders): string | null {
	const value = parseCookies(headers.cookie)?.[SESSION_COOKIE_NAME];
	return value && value.trim() !== "" ? value : null;
}

export function serializeSessionCookie(id: string, options: { maxAgeSeconds?: number; secure?: boolean } = {}): string {
	const parts = [
		`${SESSION_COOKIE_NAME}=${id}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Strict",
		// Keep the cookie while the server-side absolute TTL can still accept it.
		// Idle expiry is enforced by SessionStore.get, not by the browser.
		`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds ?? DEFAULT_SESSION_ABSOLUTE_TTL_MS / 1000))}`,
	];
	if (options.secure) parts.push("Secure");
	return parts.join("; ");
}

export function hasForbiddenIdentityHeaders(headers: IncomingHttpHeaders): boolean {
	return FORBIDDEN_IDENTITY_HEADERS.some((name) => headers[name] !== undefined);
}

export function isAllowedOrigin(origin: string | undefined, allowedOrigin: string): boolean {
	return origin !== undefined && origin === allowedOrigin;
}

export function requireCsrf(session: BrowserSession, token: string | undefined): boolean {
	return token !== undefined && token !== "" && token === session.csrfToken;
}
