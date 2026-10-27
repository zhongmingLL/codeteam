import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import {
	assertNoApprovalBlock,
	type Clock,
	changesOf,
	jsonArray,
	mapStoreError,
	newId,
	nonEmpty,
	parseJsonArray,
} from "./helpers.ts";
import type {
	AppendMessageInput,
	Message,
	MessageAuthorKind,
	MessageKind,
	MessageListOptions,
	MessageMutationOptions,
} from "./types.ts";

interface MessageRow {
	id: string;
	thread_id: string;
	task_id: string | null;
	author_kind: MessageAuthorKind;
	author_id: string;
	kind: MessageKind;
	body_md: string;
	rich_blocks_json: string;
	dispatch_refs_json: string;
	reply_to: string | null;
	control_ref: string | null;
	seq: number;
	created_at: number;
	updated_at: number;
}

function validateDispatchRef(ref: unknown): void {
	if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
		throw new ControlError("invalid_input", "dispatch ref must be an object");
	}
	const candidate = ref as Record<string, unknown>;
	if (typeof candidate.targetId !== "string" || candidate.targetId.trim() === "") {
		throw new ControlError("invalid_input", "dispatch ref targetId is required");
	}
	if (candidate.phase !== "dispatched" && candidate.phase !== "settled") {
		throw new ControlError("invalid_input", "dispatch ref phase must be dispatched or settled");
	}
	if (typeof candidate.statusMessageId !== "string" || candidate.statusMessageId.trim() === "") {
		throw new ControlError("invalid_input", "dispatch ref statusMessageId is required");
	}
}

function mapMessage(row: MessageRow): Message {
	return {
		id: row.id,
		threadId: row.thread_id,
		taskId: row.task_id,
		authorKind: row.author_kind,
		authorId: row.author_id,
		kind: row.kind,
		bodyMd: row.body_md,
		richBlocks: parseJsonArray(row.rich_blocks_json),
		dispatchRefs: parseJsonArray(row.dispatch_refs_json),
		replyTo: row.reply_to,
		controlRef: row.control_ref,
		seq: row.seq,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class MessageStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
	}

	get(id: string): Message | null {
		const row = this.database.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
		return row ? mapMessage(row) : null;
	}

	latestSeq(threadId: string): number {
		const row = this.database
			.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE thread_id = ?")
			.get(threadId) as { seq?: number } | undefined;
		return row?.seq ?? 0;
	}

	listThread(threadId: string, options: MessageListOptions = {}): Message[] {
		const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
		const beforeSeq = options.beforeSeq ?? null;
		const rows = this.database
			.prepare(
				"SELECT * FROM (SELECT * FROM messages WHERE thread_id = ? AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC",
			)
			.all(threadId, beforeSeq, beforeSeq, limit) as unknown as MessageRow[];
		return rows.map(mapMessage);
	}

	append(input: AppendMessageInput): Message {
		try {
			return this.transaction.run(() => {
				const thread = this.database.prepare("SELECT id FROM threads WHERE id = ?").get(input.threadId);
				if (!thread) throw new ControlError("not_found", `thread ${input.threadId} not found`);
				if (input.replyTo) {
					const parent = this.database.prepare("SELECT thread_id FROM messages WHERE id = ?").get(input.replyTo) as
						| { thread_id?: string }
						| undefined;
					if (!parent) throw new ControlError("invalid_input", `reply target ${input.replyTo} not found`);
					if (parent.thread_id !== input.threadId) {
						throw new ControlError("invalid_input", "reply_to_cross_thread");
					}
				}
				const richBlocks = input.richBlocks ?? [];
				if (!Array.isArray(richBlocks)) {
					throw new ControlError("invalid_input", "richBlocks must be an array");
				}
				assertNoApprovalBlock(richBlocks);
				const dispatchRefs = input.dispatchRefs ?? [];
				if (!Array.isArray(dispatchRefs)) {
					throw new ControlError("invalid_input", "dispatchRefs must be an array");
				}
				for (const ref of dispatchRefs) validateDispatchRef(ref);
				const nextRow = this.database
					.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE thread_id = ?")
					.get(input.threadId) as { next: number };
				const seq = nextRow.next;
				if (input.expectedSeq !== undefined && input.expectedSeq !== seq) {
					throw new ControlError(
						"version_conflict",
						`expected message seq ${input.expectedSeq}, next seq is ${seq}`,
					);
				}
				const id = input.id ?? newId();
				const now = this.clock();
				this.database
					.prepare(
						"INSERT INTO messages (id, thread_id, task_id, author_kind, author_id, kind, body_md, rich_blocks_json, dispatch_refs_json, reply_to, control_ref, seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
					)
					.run(
						id,
						nonEmpty(input.threadId, "threadId"),
						input.taskId ?? null,
						input.authorKind,
						nonEmpty(input.authorId, "authorId"),
						input.kind,
						input.bodyMd ?? "",
						jsonArray(richBlocks, "richBlocks"),
						jsonArray(dispatchRefs, "dispatchRefs"),
						input.replyTo ?? null,
						seq,
						now,
						now,
					);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	setControlRef(id: string, controlRef: string | null, options: MessageMutationOptions = {}): Message {
		const value = controlRef === null ? null : nonEmpty(controlRef, "controlRef");
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `message ${id} not found`);
				const now = this.clock();
				const result =
					options.expectedUpdatedAt === undefined
						? this.database
								.prepare("UPDATE messages SET control_ref = ?, updated_at = ? WHERE id = ?")
								.run(value, now, id)
						: this.database
								.prepare("UPDATE messages SET control_ref = ?, updated_at = ? WHERE id = ? AND updated_at = ?")
								.run(value, now, id, options.expectedUpdatedAt);
				if (changesOf(result) === 0) {
					throw new ControlError("version_conflict", `message ${id} changed since the expected revision`);
				}
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	appendDispatchRef(id: string, ref: unknown, options: MessageMutationOptions = {}): Message {
		validateDispatchRef(ref);
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `message ${id} not found`);
				const refs = [...current.dispatchRefs, ref];
				const now = this.clock();
				const result =
					options.expectedUpdatedAt === undefined
						? this.database
								.prepare("UPDATE messages SET dispatch_refs_json = ?, updated_at = ? WHERE id = ?")
								.run(JSON.stringify(refs), now, id)
						: this.database
								.prepare(
									"UPDATE messages SET dispatch_refs_json = ?, updated_at = ? WHERE id = ? AND updated_at = ?",
								)
								.run(JSON.stringify(refs), now, id, options.expectedUpdatedAt);
				if (changesOf(result) === 0) {
					throw new ControlError("version_conflict", `message ${id} changed since the expected revision`);
				}
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}
}
