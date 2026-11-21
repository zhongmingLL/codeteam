import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RichMessageExtra, StoredMessage } from "@superagentteam/shared/types";

import type { A2ARuntime } from "../../domains/a2a/runtime.ts";
import { HttpError, readJsonBody, sendError, sendJson } from "../http.ts";
import { type BrowserSession, requireCsrf } from "../session.ts";

const MESSAGES_PATH = "/api/messages";
const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 200;

export interface MessageView {
	id: string;
	threadId: string;
	type: "user" | "assistant" | "system" | "connector";
	from: StoredMessage["from"];
	catId?: string;
	content: string;
	contentBlocks?: StoredMessage["contentBlocks"];
	toolEvents?: StoredMessage["toolEvents"];
	lifecycle?: StoredMessage["lifecycle"];
	replyTo?: string;
	mentionsUser?: boolean;
	timestamp: number;
	updatedAt: number;
	thinking?: string;
	extra?: StoredMessage["extra"];
}

export interface MessageRouteContext {
	session: BrowserSession;
	origin: string | undefined;
}

export interface MessageRoutes {
	handle(request: IncomingMessage, response: ServerResponse, url: URL, context: MessageRouteContext): Promise<boolean>;
}

export interface MessageRoutesOptions {
	runtime: A2ARuntime;
	clock?: () => number;
}

function fail(response: ServerResponse, status: number, code: string, message: string): true {
	sendError(response, status, code, message);
	return true;
}

function parseLimit(value: string | null): number | null {
	if (value === null) return DEFAULT_MESSAGE_LIMIT;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_MESSAGE_LIMIT) return null;
	return parsed;
}

function parseBefore(value: string): { timestamp: number; id: string } | null {
	const separator = value.indexOf(":");
	if (separator <= 0 || separator === value.length - 1) return null;
	const timestamp = Number(value.slice(0, separator));
	const id = value.slice(separator + 1);
	if (!Number.isInteger(timestamp) || timestamp < 0 || id.trim() === "") return null;
	return { timestamp, id };
}

function toView(message: StoredMessage): MessageView {
	const type = message.from.kind === "agent" ? "assistant" : message.from.kind;
	return {
		id: message.id,
		threadId: message.threadId,
		type,
		from: message.from,
		...(message.from.kind === "agent" ? { catId: message.from.agentId } : {}),
		content: message.content,
		...(message.contentBlocks ? { contentBlocks: message.contentBlocks } : {}),
		...(message.toolEvents ? { toolEvents: message.toolEvents } : {}),
		...(message.lifecycle ? { lifecycle: message.lifecycle } : {}),
		...(message.replyTo ? { replyTo: message.replyTo } : {}),
		...(message.mentionsUser ? { mentionsUser: true } : {}),
		timestamp: message.timestamp,
		updatedAt: message.updatedAt,
		...(message.thinking ? { thinking: message.thinking } : {}),
		...(message.extra ? { extra: message.extra } : {}),
	};
}

function invalidCursor(response: ServerResponse): true {
	sendJson(response, 200, { messages: [], hasMore: false, query_warnings: ["invalid_cursor"] });
	return true;
}

function readTargets(body: Record<string, unknown>): string[] | null {
	const targets: string[] = [];
	for (const raw of [body.targets, body.mentions]) {
		if (raw === undefined) continue;
		if (!Array.isArray(raw)) return null;
		for (const value of raw) {
			if (typeof value !== "string" || value.trim() === "") return null;
			if (!targets.includes(value)) targets.push(value);
		}
	}
	return targets;
}

function readRichExtra(value: unknown): { rich?: RichMessageExtra } | null {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const rich = (value as Record<string, unknown>).rich;
	if (rich === undefined) return {};
	if (typeof rich !== "object" || rich === null || Array.isArray(rich)) return null;
	const candidate = rich as Record<string, unknown>;
	if (candidate.v !== 1 || !Array.isArray(candidate.blocks)) return null;
	for (const block of candidate.blocks) {
		if (typeof block !== "object" || block === null || Array.isArray(block)) return null;
		const record = block as Record<string, unknown>;
		if (typeof record.id !== "string" || record.id.trim() === "") return null;
		if (typeof record.kind !== "string" || record.kind.trim() === "") return null;
		if (record.v !== 1) return null;
	}
	return { rich: candidate as unknown as RichMessageExtra };
}

export function createMessageRoutes(options: MessageRoutesOptions): MessageRoutes {
	const clock = options.clock ?? Date.now;
	const { threads, messages, ingress } = options.runtime;

	async function listMessages(response: ServerResponse, url: URL, context: MessageRouteContext): Promise<true> {
		const threadId = url.searchParams.get("threadId");
		if (threadId === null || threadId.trim() === "") {
			return fail(response, 400, "invalid_input", "threadId is required");
		}
		const limit = parseLimit(url.searchParams.get("limit"));
		if (limit === null) return fail(response, 400, "invalid_input", "limit must be an integer between 1 and 200");
		const thread = threads.get(threadId);
		if (!thread) return fail(response, 404, "thread_not_found", `thread ${threadId} not found`);
		if (thread.createdBy !== context.session.userId) {
			return fail(response, 403, "forbidden", `thread ${threadId} belongs to another user`);
		}

		const beforeRaw = url.searchParams.get("before");
		let beforeSeq: number | null = null;
		if (beforeRaw !== null) {
			const before = parseBefore(beforeRaw);
			if (!before) return invalidCursor(response);
			const anchor = messages.get(before.id, { includeDeleted: true });
			if (!anchor || anchor.threadId !== threadId || anchor.timestamp !== before.timestamp) {
				return invalidCursor(response);
			}
			beforeSeq = anchor.seq;
		}

		const rows =
			beforeSeq === null
				? messages.getByThread(threadId, limit + 1)
				: messages.getByThreadBefore(threadId, beforeSeq, limit + 1);
		const hasMore = rows.length > limit;
		const window = hasMore ? rows.slice(rows.length - limit) : rows;
		sendJson(response, 200, { messages: window.map(toView), hasMore });
		return true;
	}

	async function appendMessage(
		request: IncomingMessage,
		response: ServerResponse,
		context: MessageRouteContext,
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
		const threadId = input.threadId;
		if (typeof threadId !== "string" || threadId.trim() === "") {
			return fail(response, 400, "invalid_input", "threadId is required");
		}
		const content = input.content;
		if (typeof content !== "string" || content.trim() === "") {
			return fail(response, 400, "invalid_input", "content is required");
		}
		const idempotencyKey = input.idempotencyKey;
		if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
			return fail(response, 400, "invalid_input", "idempotencyKey is required");
		}
		if (input.visibility === "whisper") {
			return fail(response, 422, "unsupported_input", "whisper messages are not supported in M1");
		}
		if (Array.isArray(input.contextAttachments) && input.contextAttachments.length > 0) {
			return fail(response, 422, "unsupported_input", "contextAttachments are not supported in M1");
		}
		const targets = readTargets(input);
		if (targets === null)
			return fail(response, 400, "invalid_input", "targets/mentions must be an array of agent ids");
		if (targets.length > 1)
			return fail(response, 422, "use_multi_mention", "multiple targets must use multi_mention");
		const extra = readRichExtra(input.extra);
		if (extra === null) return fail(response, 422, "invalid_extra", "extra.rich must be {v:1, blocks:[...]}");

		const thread = threads.get(threadId);
		if (!thread || (thread.deletedAt !== null && thread.deletedAt !== undefined)) {
			return fail(response, 404, "thread_not_found", `thread ${threadId} not found`);
		}
		if (thread.createdBy !== context.session.userId) {
			return fail(response, 403, "forbidden", `thread ${threadId} belongs to another user`);
		}

		let replyTo: string | undefined;
		if (input.replyTo !== undefined) {
			if (typeof input.replyTo !== "string" || input.replyTo.trim() === "") {
				return fail(response, 400, "invalid_input", "replyTo must be a message id");
			}
			const quoted = messages.get(input.replyTo);
			if (!quoted || quoted.threadId !== threadId) {
				return fail(response, 400, "invalid_input", "replyTo does not reference a message in this thread");
			}
			replyTo = input.replyTo;
		}

		const messageId = `msg:${createHash("sha256")
			.update(`${threadId}\0${context.session.userId}\0${idempotencyKey}`)
			.digest("hex")
			.slice(0, 32)}`;
		try {
			const result = ingress.submit({
				threadId,
				userId: context.session.userId,
				body: content,
				messageId,
				targetAgentIds: targets.length > 0 ? targets : undefined,
				replyTo,
				extra,
				now: clock(),
			});
			sendJson(response, 202, {
				status: "queued",
				userMessageId: result.message.id,
				entryId: result.queueEntry.queueEntryId,
				queuePosition: result.queueEntry.position,
				merged: false,
				targetAgentIds: result.targetAgentIds,
			});
			return true;
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			if (text.startsWith("ingress_replay_entry_missing")) {
				const existing = messages.get(messageId, { includeDeleted: true });
				if (existing && existing.threadId === threadId && existing.from.kind === "user") {
					sendJson(response, 202, { status: "queued", userMessageId: existing.id, merged: false });
					return true;
				}
				return fail(response, 409, "idempotency_conflict", "message replay is unavailable");
			}
			if (text.startsWith("thread_not_found") || text.startsWith("thread_deleted")) {
				return fail(response, 404, "thread_not_found", `thread ${threadId} not found`);
			}
			if (text.startsWith("ingress_message_id_conflict") || text === "queue_admission_conflict") {
				return fail(response, 409, "idempotency_conflict", "idempotencyKey was used with another payload");
			}
			if (text.startsWith("agent_disabled")) return fail(response, 422, "agent_disabled", text);
			if (text.startsWith("thread_project_path_required")) {
				return fail(
					response,
					422,
					"thread_project_path_required",
					"thread projectPath is required before dispatching",
				);
			}
			if (
				text.startsWith("no_target") ||
				text.startsWith("agent_not_found") ||
				text.startsWith("account_not_found")
			) {
				return fail(response, 422, "target_invalid", text);
			}
			if (text.startsWith("queue_full")) return fail(response, 429, "queue_full", "thread queue is full");
			if (text.startsWith("body_empty")) return fail(response, 400, "invalid_input", "content is required");
			if (text.startsWith("body_too_large"))
				return fail(response, 413, "payload_too_large", "message body is too large");
			if (text.startsWith("message_author_not_thread_owner")) {
				return fail(response, 403, "forbidden", "message author is not the thread owner");
			}
			if (text === "queue_admission_replayed") {
				return fail(response, 409, "idempotency_conflict", "queue admission was already consumed");
			}
			throw error;
		}
	}

	async function handle(
		request: IncomingMessage,
		response: ServerResponse,
		url: URL,
		context: MessageRouteContext,
	): Promise<boolean> {
		if (url.pathname !== MESSAGES_PATH) return false;
		if (request.method === "GET") return listMessages(response, url, context);
		if (request.method === "POST") return appendMessage(request, response, context);
		return false;
	}

	return { handle };
}
