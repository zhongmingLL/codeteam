import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import type { Thread, ThreadTitleSource } from "@superagentteam/shared/types";

import type { A2ARuntime } from "../../domains/a2a/runtime.ts";
import type { ChangeBus } from "../../domains/events/bus.ts";
import { HttpError, readJsonBody, sendError, sendJson } from "../http.ts";
import { requireCsrf } from "../session.ts";
import type { ApiRouteContext } from "./context.ts";

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
	unreadCount: number;
}

export interface ThreadRoutes {
	handle(request: IncomingMessage, response: ServerResponse, url: URL, context: ApiRouteContext): Promise<boolean>;
}

export interface ThreadRoutesOptions {
	runtime: A2ARuntime;
	changeBus?: ChangeBus;
	clock?: () => number;
}

function toView(thread: Thread, unreadCount = 0): ThreadView {
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
		unreadCount,
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
		context: ApiRouteContext,
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
		const projectPath = projectPathValue.trim();
		if (!isAbsolute(projectPath)) {
			return fail(response, 422, "project_path_invalid", "projectPath must be an absolute directory path");
		}
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
			options.changeBus?.publish(existing.id, ["thread"]);
			sendJson(response, 200, toView(existing, threads.unreadCount(context.session.userId, existing.id)));
			return true;
		}

		try {
			if (!statSync(projectPath).isDirectory()) {
				return fail(response, 422, "project_path_invalid", "projectPath must be a directory");
			}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			return fail(
				response,
				422,
				"project_path_invalid",
				code === "ENOENT" ? "projectPath does not exist" : "projectPath is not accessible",
			);
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
			options.changeBus?.publish(thread.id, ["thread"]);
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
			options.changeBus?.publish(raced.id, ["thread"]);
			sendJson(response, 200, toView(raced, threads.unreadCount(context.session.userId, raced.id)));
		}
		return true;
	}

	async function readThread(
		request: IncomingMessage,
		response: ServerResponse,
		context: ApiRouteContext,
		rawThreadId: string,
	): Promise<true> {
		const csrf = request.headers["x-csrf-token"];
		const csrfToken = Array.isArray(csrf) ? csrf[0] : csrf;
		if (!requireCsrf(context.session, csrfToken)) return fail(response, 403, "csrf_failed", "invalid CSRF token");

		let threadId: string;
		try {
			threadId = decodeURIComponent(rawThreadId);
		} catch {
			return fail(response, 400, "invalid_input", "thread id is not valid URL encoding");
		}
		const thread = threads.get(threadId);
		if (!thread || (thread.deletedAt !== null && thread.deletedAt !== undefined)) {
			return fail(response, 404, "thread_not_found", `thread ${threadId} not found`);
		}
		if (thread.createdBy !== context.session.userId) {
			return fail(response, 403, "forbidden", `thread ${threadId} belongs to another user`);
		}

		let body: unknown;
		try {
			body = await readJsonBody(request);
		} catch (error) {
			if (error instanceof HttpError) return fail(response, error.status, error.code, error.message);
			throw error;
		}
		let messageId: string | undefined;
		if (body !== undefined) {
			if (typeof body !== "object" || body === null || Array.isArray(body)) {
				return fail(response, 400, "invalid_input", "request body must be a JSON object");
			}
			const input = body as Record<string, unknown>;
			if (input.messageId !== undefined) {
				if (typeof input.messageId !== "string" || input.messageId.trim() === "") {
					return fail(response, 400, "invalid_input", "messageId must be a non-empty string");
				}
				messageId = input.messageId;
			}
		}

		let seq: number;
		if (messageId !== undefined) {
			const message = options.runtime.messages.get(messageId);
			if (!message || message.threadId !== threadId) {
				return fail(response, 400, "invalid_input", "messageId does not reference a message in this thread");
			}
			seq = message.seq;
		} else {
			seq = options.runtime.messages.latestSeq(threadId);
		}
		threads.markRead(context.session.userId, threadId, seq, clock());
		const unreadCount = threads.unreadCount(context.session.userId, threadId);
		options.changeBus?.publish(threadId, ["thread"]);
		sendJson(response, 200, { threadId, unreadCount });
		return true;
	}

	async function handle(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		context: ApiRouteContext,
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
				const items = threads
					.listWithReadState({ createdBy: context.session.userId, limit })
					.map((item) => toView(item.thread, item.unreadCount));
				sendJson(response, 200, { threads: items });
				return true;
			}
			if (request.method === "POST") return createThread(request, response, context);
			return false;
		}

		const suffix = url.pathname.slice(THREADS_PATH.length + 1);
		if (suffix === "") return false;
		const segments = suffix.split("/");
		if (segments.length === 2 && segments[1] === "read") {
			if (request.method !== "POST") return false;
			return readThread(request, response, context, segments[0]!);
		}
		if (segments.length !== 1) return false;
		if (request.method !== "GET") return false;
		let threadId: string;
		try {
			threadId = decodeURIComponent(segments[0]!);
		} catch {
			return fail(response, 400, "invalid_input", "thread id is not valid URL encoding");
		}
		const thread = threads.get(threadId);
		if (!thread) return fail(response, 404, "thread_not_found", `thread ${threadId} not found`);
		if (thread.createdBy !== context.session.userId) {
			return fail(response, 403, "forbidden", `thread ${threadId} belongs to another user`);
		}
		sendJson(response, 200, toView(thread, threads.unreadCount(context.session.userId, threadId)));
		return true;
	}

	return { handle };
}
