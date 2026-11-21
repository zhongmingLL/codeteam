import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Thread, ThreadTitleSource } from "@superagentteam/shared/types";

import type { A2ARuntime } from "../../domains/a2a/runtime.ts";
import { HttpError, readJsonBody, sendError, sendJson } from "../http.ts";
import { type BrowserSession, requireCsrf } from "../session.ts";

const THREADS_PATH = "/api/threads";
const DEFAULT_THREAD_LIMIT = 50;
const MAX_THREAD_LIMIT = 200;

export interface ThreadView {
	id: string;
	projectPath: string;
	title: string | null;
	titleSource?: ThreadTitleSource;
	createdBy: string;
	participants: string[];
	lastActiveAt: number;
	createdAt: number;
	updatedAt: number;
	deletedAt?: number | null;
}

export interface ThreadRouteContext {
	session: BrowserSession;
	origin: string | undefined;
}

export interface ThreadRoutes {
	handle(request: IncomingMessage, response: ServerResponse, url: URL, context: ThreadRouteContext): Promise<boolean>;
}

export interface ThreadRoutesOptions {
	runtime: A2ARuntime;
	clock?: () => number;
}

function toView(thread: Thread): ThreadView {
	return {
		id: thread.id,
		projectPath: thread.projectPath,
		title: thread.title,
		titleSource: thread.titleSource,
		createdBy: thread.createdBy,
		participants: [...thread.participants],
		lastActiveAt: thread.lastActiveAt,
		createdAt: thread.createdAt,
		updatedAt: thread.updatedAt,
		deletedAt: thread.deletedAt ?? null,
	};
}

function fail(response: ServerResponse, status: number, code: string, message: string): true {
	sendError(response, status, code, message);
	return true;
}

function parseLimit(value: string | null): number | null {
	if (value === null) return DEFAULT_THREAD_LIMIT;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_THREAD_LIMIT) return null;
	return parsed;
}

function parseTitle(body: Record<string, unknown>): { title: string | null; titleSource?: ThreadTitleSource } | null {
	const title = body.title;
	const temporary = body.temporaryTitle;
	if (title !== undefined) {
		if (title === null) return { title: null };
		if (typeof title !== "string" || title.trim() === "") return null;
		return { title, titleSource: "user" };
	}
	if (temporary !== undefined) {
		if (typeof temporary !== "string" || temporary.trim() === "") return null;
		return { title: temporary, titleSource: "system" };
	}
	return { title: null };
}

export function createThreadRoutes(options: ThreadRoutesOptions): ThreadRoutes {
	const clock = options.clock ?? Date.now;
	const threads = options.runtime.threads;

	async function createThread(
		request: IncomingMessage,
		response: ServerResponse,
		context: ThreadRouteContext,
	): Promise<true> {
		const csrf = request.headers["x-csrf-token"];
		const csrfToken = Array.isArray(csrf) ? csrf[0] : csrf;
		if (!requireCsrf(context.session, csrfToken)) return fail(response, 403, "csrf_failed", "invalid CSRF token");

		let body: unknown;
		try {
			body = await readJsonBody(request);
		} catch (error) {
			if (error instanceof HttpError) return fail(response, error.status, error.code, error.message);
			throw error;
		}
		if (body === undefined || typeof body !== "object" || body === null || Array.isArray(body)) {
			return fail(response, 400, "invalid_input", "request body must be a JSON object");
		}
		const input = body as Record<string, unknown>;
		const idempotencyKey = input.idempotencyKey;
		if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
			return fail(response, 400, "invalid_input", "idempotencyKey is required");
		}
		const projectPathValue = input.projectPath;
		if (projectPathValue === undefined) {
			return fail(response, 400, "invalid_input", "projectPath is required for thread create");
		}
		if (typeof projectPathValue !== "string" || projectPathValue.trim() === "") {
			return fail(response, 400, "invalid_input", "projectPath must be a non-empty string");
		}
		const projectPath = projectPathValue;
		const parsedTitle = parseTitle(input);
		if (!parsedTitle) return fail(response, 400, "invalid_input", "title must be a non-empty string when provided");

		const id = `thread:${createHash("sha256")
			.update(`${context.session.userId}\0${idempotencyKey}`)
			.digest("hex")
			.slice(0, 32)}`;
		const existing = threads.get(id);
		if (existing) {
			const replay =
				existing.createdBy === context.session.userId &&
				existing.projectPath === projectPath &&
				(existing.title ?? null) === (parsedTitle.title ?? null) &&
				existing.titleSource === parsedTitle.titleSource;
			if (!replay)
				return fail(response, 409, "idempotency_conflict", "idempotencyKey was used with another payload");
			sendJson(response, 200, toView(existing));
			return true;
		}

		try {
			const thread = threads.create({
				id,
				projectPath,
				title: parsedTitle.title,
				titleSource: parsedTitle.titleSource,
				createdBy: context.session.userId,
				now: clock(),
			});
			sendJson(response, 201, toView(thread));
		} catch (error) {
			const raced = threads.get(id);
			if (!raced) throw error;
			const replay =
				raced.createdBy === context.session.userId &&
				raced.projectPath === projectPath &&
				(raced.title ?? null) === (parsedTitle.title ?? null) &&
				raced.titleSource === parsedTitle.titleSource;
			if (!replay)
				return fail(response, 409, "idempotency_conflict", "idempotencyKey was used with another payload");
			sendJson(response, 200, toView(raced));
		}
		return true;
	}

	async function handle(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		context: ThreadRouteContext,
	): Promise<boolean> {
		if (url.pathname !== THREADS_PATH && !url.pathname.startsWith(`${THREADS_PATH}/`)) return false;

		if (url.pathname === THREADS_PATH) {
			if (request.method === "GET") {
				if (url.searchParams.get("deleted") === "true") {
					sendJson(response, 200, { threads: [] });
					return true;
				}
				const limit = parseLimit(url.searchParams.get("limit"));
				if (limit === null)
					return fail(response, 400, "invalid_input", "limit must be an integer between 1 and 200");
				const items = threads.list({ createdBy: context.session.userId, limit }).map(toView);
				sendJson(response, 200, { threads: items });
				return true;
			}
			if (request.method === "POST") return createThread(request, response, context);
			return false;
		}

		const suffix = url.pathname.slice(THREADS_PATH.length + 1);
		if (suffix === "" || suffix.includes("/")) return false;
		if (request.method !== "GET") return false;
		let threadId: string;
		try {
			threadId = decodeURIComponent(suffix);
		} catch {
			return fail(response, 400, "invalid_input", "thread id is not valid URL encoding");
		}
		const thread = threads.get(threadId);
		if (!thread) return fail(response, 404, "thread_not_found", `thread ${threadId} not found`);
		if (thread.createdBy !== context.session.userId) {
			return fail(response, 403, "forbidden", `thread ${threadId} belongs to another user`);
		}
		sendJson(response, 200, toView(thread));
		return true;
	}

	return { handle };
}
