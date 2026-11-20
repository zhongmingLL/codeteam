import type {
	MessageLifecycle,
	StoredMessage,
	ThreadContextInput,
	ThreadContextMessageView,
	ThreadContextResult,
} from "@superagentteam/shared/types";
import { visibleTo } from "../history/assembler.ts";
import type { MessageStore } from "../message/store.ts";
import type { ThreadStore } from "../thread/store.ts";
import { A2AToolError } from "./tool-service.ts";

// F018 R4-a thread_context (0007 §3.8): bounded, read-only thread window.
// Visibility reuses HistoryAssembler.visibleTo; nothing is acked or queued.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_ANCHOR_BEFORE = 10;
const DEFAULT_ANCHOR_AFTER = 10;
const MAX_ANCHOR_WINDOW = 50;

export interface ThreadContextCaller {
	threadId: string;
	userId: string;
	callerAgentId: string;
}

function fail(code: ConstructorParameters<typeof A2AToolError>[0], message?: string): never {
	throw new A2AToolError(code, message);
}

function readInt(value: unknown, fallback: number, min: number, max: number, field: string): number {
	if (value === undefined || value === null) return fallback;
	if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
		fail("invalid_window", `${field} must be an integer in ${min}..${max}`);
	}
	return value as number;
}

function encodeCursor(seq: number): string {
	return `seq:${seq}`;
}

function decodeCursor(cursor: string): number {
	const match = /^seq:(\d+)$/.exec(cursor);
	const seq = match ? Number(match[1]) : Number.NaN;
	if (!Number.isSafeInteger(seq) || seq <= 0) fail("invalid_cursor", "invalid thread_context cursor");
	return seq;
}

function lifecycleView(lifecycle: MessageLifecycle | undefined): ThreadContextMessageView["lifecycle"] {
	if (!lifecycle) return undefined;
	if ("status" in lifecycle && typeof lifecycle.status === "string") {
		return { kind: lifecycle.kind, status: lifecycle.status };
	}
	return { kind: lifecycle.kind };
}

function toView(message: StoredMessage): ThreadContextMessageView {
	return {
		messageId: message.id,
		seq: message.seq,
		from: message.from,
		content: message.content,
		...(message.contentBlocks ? { contentBlocks: message.contentBlocks } : {}),
		...(message.lifecycle ? { lifecycle: lifecycleView(message.lifecycle) } : {}),
		createdAt: message.timestamp,
	};
}

export class ThreadContextService {
	private readonly threads: ThreadStore;
	private readonly messages: MessageStore;

	constructor(deps: { threads: ThreadStore; messages: MessageStore }) {
		this.threads = deps.threads;
		this.messages = deps.messages;
	}

	read(caller: ThreadContextCaller, input: ThreadContextInput = {}): ThreadContextResult {
		if (input.anchor !== undefined && input.cursor !== undefined) {
			fail("invalid_cursor", "cursor cannot be combined with anchor");
		}
		const limit = readInt(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, "limit");
		const threadId = input.threadId ?? caller.threadId;
		const thread = this.threads.get(threadId);
		if (!thread) fail("thread_not_found");
		if (thread.deletedAt !== null && thread.deletedAt !== undefined) fail("thread_deleted");
		if (thread.createdBy !== caller.userId) fail("thread_access_denied");

		if (input.anchor !== undefined) {
			return this.readAnchor(caller, threadId, input);
		}
		const beforeSeq = input.cursor !== undefined ? decodeCursor(input.cursor) : undefined;
		const raw =
			beforeSeq !== undefined
				? this.messages.getByThreadBefore(threadId, beforeSeq, limit)
				: this.messages.getByThread(threadId, limit);
		return this.window(caller, threadId, raw, true);
	}

	private readAnchor(caller: ThreadContextCaller, threadId: string, input: ThreadContextInput): ThreadContextResult {
		const anchor = this.messages.get(input.anchor!);
		if (!anchor || anchor.threadId !== threadId) fail("invalid_anchor");
		const before = readInt(input.before, DEFAULT_ANCHOR_BEFORE, 0, MAX_ANCHOR_WINDOW, "before");
		const after = readInt(input.after, DEFAULT_ANCHOR_AFTER, 0, MAX_ANCHOR_WINDOW, "after");
		if (before + after + 1 > MAX_LIMIT) {
			fail("invalid_window", `anchor window exceeds ${MAX_LIMIT}`);
		}
		const beforeRows = before > 0 ? this.messages.getByThreadBefore(threadId, anchor.seq, before) : [];
		const afterRows = after > 0 ? this.messages.getByThreadAfter(threadId, anchor.seq, after) : [];
		const raw = [...beforeRows, anchor, ...afterRows];
		const visible = raw.filter((message) => visibleTo(message, caller.callerAgentId)).map(toView);
		const oldest = beforeRows[0]?.seq ?? anchor.seq;
		const hasMore = this.messages.getByThreadBefore(threadId, oldest, 1).length > 0;
		return {
			threadId,
			messages: visible,
			hasMore,
			...(hasMore ? { nextCursor: encodeCursor(oldest) } : {}),
		};
	}

	private window(
		caller: ThreadContextCaller,
		threadId: string,
		raw: StoredMessage[],
		allowOlder: boolean,
	): ThreadContextResult {
		const visible = raw.filter((message) => visibleTo(message, caller.callerAgentId)).map(toView);
		const oldest = raw[0]?.seq;
		const hasMore =
			allowOlder && oldest !== undefined && this.messages.getByThreadBefore(threadId, oldest, 1).length > 0;
		return {
			threadId,
			messages: visible,
			hasMore,
			...(hasMore ? { nextCursor: encodeCursor(oldest!) } : {}),
		};
	}
}
