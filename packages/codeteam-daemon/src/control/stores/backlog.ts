import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import type { AuditStore } from "./audit.ts";
import {
	type Clock,
	changesOf,
	jsonArray,
	jsonObject,
	mapStoreError,
	newId,
	nonEmpty,
	parseJsonArray,
	parseJsonObject,
} from "./helpers.ts";
import type {
	BacklogAuditProjection,
	BacklogItem,
	BacklogItemView,
	BacklogListFilter,
	BacklogPriority,
	BacklogStatus,
	BacklogSuggestion,
	CreateBacklogItemInput,
	DecideBacklogSuggestionInput,
	MarkBacklogDispatchedInput,
	SuggestBacklogInput,
	ThreadPhase,
} from "./types.ts";

interface BacklogRow {
	id: string;
	user_id: string;
	project_id: string | null;
	title: string;
	summary: string;
	priority: BacklogPriority;
	tags_json: string;
	status: BacklogStatus;
	created_by_kind: "cat" | "user" | "system";
	created_by_id: string;
	suggestion_json: string | null;
	lease_json: string | null;
	dependencies_json: string | null;
	dispatched_thread_id: string | null;
	dispatched_thread_phase: ThreadPhase | null;
	dispatch_attempt_id: string | null;
	pending_thread_id: string | null;
	kickoff_message_id: string | null;
	approved_at: number | null;
	dispatched_at: number | null;
	done_at: number | null;
	created_at: number;
	updated_at: number;
}

function optionalObject(value: string | null): Record<string, unknown> | null {
	return value ? parseJsonObject(value) : null;
}

function mapBacklog(row: BacklogRow): BacklogItem {
	const tags = parseJsonArray(row.tags_json);
	if (!tags.every((tag) => typeof tag === "string")) {
		throw new ControlError("invalid_input", "backlog tags must be strings");
	}
	return {
		id: row.id,
		userId: row.user_id,
		projectId: row.project_id,
		title: row.title,
		summary: row.summary,
		priority: row.priority,
		tags: tags as string[],
		status: row.status,
		createdByKind: row.created_by_kind,
		createdById: row.created_by_id,
		suggestion: row.suggestion_json ? (parseJsonObject(row.suggestion_json) as unknown as BacklogSuggestion) : null,
		lease: optionalObject(row.lease_json),
		dependencies: optionalObject(row.dependencies_json),
		dispatchedThreadId: row.dispatched_thread_id,
		dispatchedThreadPhase: row.dispatched_thread_phase,
		dispatchAttemptId: row.dispatch_attempt_id,
		pendingThreadId: row.pending_thread_id,
		kickoffMessageId: row.kickoff_message_id,
		approvedAt: row.approved_at,
		dispatchedAt: row.dispatched_at,
		doneAt: row.done_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function uniqueTags(tags: string[]): string[] {
	if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string" && tag.trim() !== "")) {
		throw new ControlError("invalid_input", "tags must be a string array");
	}
	const unique = [...new Set(tags)];
	if (unique.length !== tags.length) throw new ControlError("invalid_input", "tags must be unique");
	return unique;
}

export class BacklogStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;
	private readonly audit: AuditStore;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock, audit: AuditStore) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
		this.audit = audit;
	}

	get(id: string): BacklogItem | null {
		const row = this.database.prepare("SELECT * FROM backlog_items WHERE id = ?").get(id) as BacklogRow | undefined;
		return row ? mapBacklog(row) : null;
	}

	getAudit(id: string, limit = 100): BacklogAuditProjection {
		this.require(id);
		const bounded = Math.min(Math.max(limit, 1), 100);
		const entries = this.audit.listSubject(`backlog:${id}`, bounded + 1);
		const truncated = entries.length > bounded;
		const audit = entries.slice(0, bounded);
		return {
			audit,
			auditTruncated: truncated,
			auditCursor: truncated ? (audit[audit.length - 1]?.id ?? null) : null,
		};
	}

	getView(id: string, limit = 100): BacklogItemView | null {
		const item = this.get(id);
		if (!item) return null;
		return { ...item, ...this.getAudit(id, limit) };
	}

	list(filter: BacklogListFilter = {}): BacklogItem[] {
		const clauses: string[] = [];
		const params: string[] = [];
		if (filter.status !== undefined) {
			clauses.push("status = ?");
			params.push(filter.status);
		}
		if (filter.priority !== undefined) {
			clauses.push("priority = ?");
			params.push(filter.priority);
		}
		if (filter.projectId !== undefined) {
			clauses.push("project_id = ?");
			params.push(filter.projectId);
		}
		const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
		const limit = Math.min(Math.max(filter.limit ?? 200, 1), 200);
		const rows = this.database
			.prepare(`SELECT * FROM backlog_items${where} ORDER BY priority, created_at, id LIMIT ?`)
			.all(...params, limit) as unknown as BacklogRow[];
		return rows.map(mapBacklog);
	}

	create(input: CreateBacklogItemInput): BacklogItem {
		const id = input.id ?? newId();
		const status = input.initialStatus ?? "open";
		if (input.createdByKind === "system" && status !== "open" && status !== "suggested") {
			throw new ControlError("invalid_input", "system backlog items may only start open or suggested");
		}
		if (status !== "open" && status !== "suggested" && (!input.importReason || input.importReason.trim() === "")) {
			throw new ControlError("invalid_input", "imported backlog status requires a reason");
		}
		const tags = uniqueTags(input.tags);
		const now = this.clock();
		try {
			return this.transaction.run(() => {
				this.database
					.prepare(
						"INSERT INTO backlog_items (id, user_id, project_id, title, summary, priority, tags_json, status, created_by_kind, created_by_id, dependencies_json, approved_at, dispatched_at, done_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						id,
						nonEmpty(input.userId, "userId"),
						input.projectId ?? null,
						nonEmpty(input.title, "title"),
						nonEmpty(input.summary, "summary"),
						input.priority,
						jsonArray(tags, "tags"),
						status,
						input.createdByKind,
						nonEmpty(input.createdById, "createdById"),
						input.dependencies ? jsonObject(input.dependencies, "dependencies") : null,
						status === "approved" || status === "dispatched" ? now : null,
						status === "dispatched" ? now : null,
						status === "done" ? now : null,
						now,
						now,
					);
				this.audit.append({
					actor: `${input.createdByKind}:${input.createdById}`,
					action: status === "open" ? "created" : "imported",
					subject: `backlog:${id}`,
					args: status === "open" ? { status } : { status, reason: input.importReason ?? null },
				});
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}

	suggest(id: string, input: SuggestBacklogInput): BacklogItem {
		try {
			return this.transaction.run(() => {
				const current = this.require(id);
				if (current.status === "suggested" && current.suggestion?.catId === input.catId) return current;
				if (current.status !== "open") {
					throw new ControlError("invalid_state", `backlog item ${id} cannot be suggested from ${current.status}`);
				}
				const now = this.clock();
				const suggestion: BacklogSuggestion = {
					catId: nonEmpty(input.catId, "catId"),
					why: nonEmpty(input.why, "why"),
					plan: nonEmpty(input.plan, "plan"),
					requestedPhase: input.requestedPhase,
					status: "pending",
					suggestedAt: now,
				};
				this.database
					.prepare(
						"UPDATE backlog_items SET status = 'suggested', suggestion_json = ?, updated_at = ? WHERE id = ? AND status = 'open'",
					)
					.run(JSON.stringify(suggestion), now, id);
				this.audit.append({
					actor: `cat:${input.catId}`,
					action: "suggested",
					subject: `backlog:${id}`,
					args: { requestedPhase: input.requestedPhase },
				});
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	decideSuggestion(id: string, input: DecideBacklogSuggestionInput): BacklogItem {
		try {
			return this.transaction.run(() => {
				const current = this.require(id);
				if (current.status !== "suggested" || !current.suggestion || current.suggestion.status !== "pending") {
					throw new ControlError("invalid_state", `backlog item ${id} has no pending suggestion`);
				}
				const now = this.clock();
				const approved = input.decision === "approve";
				const suggestion: BacklogSuggestion = {
					...current.suggestion,
					status: approved ? "approved" : "rejected",
					decidedAt: now,
					decidedBy: input.decidedBy,
					...(input.note ? { note: input.note } : {}),
				};
				this.database
					.prepare(
						"UPDATE backlog_items SET status = ?, suggestion_json = ?, approved_at = CASE WHEN ? THEN ? ELSE approved_at END, updated_at = ? WHERE id = ?",
					)
					.run(approved ? "approved" : "open", JSON.stringify(suggestion), approved ? 1 : 0, now, now, id);
				this.audit.append({
					actor: `user:${input.decidedBy}`,
					action: approved ? "approved" : "rejected",
					subject: `backlog:${id}`,
					args: input.note ? { note: input.note } : {},
				});
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	approve(id: string, approvedBy: string): BacklogItem {
		try {
			return this.transaction.run(() => {
				const current = this.require(id);
				if (current.status === "approved") return current;
				if (current.status !== "open") {
					throw new ControlError("invalid_state", `backlog item ${id} cannot be approved from ${current.status}`);
				}
				const now = this.clock();
				this.database
					.prepare(
						"UPDATE backlog_items SET status = 'approved', approved_at = ?, updated_at = ? WHERE id = ? AND status = 'open'",
					)
					.run(now, now, id);
				this.audit.append({
					actor: `user:${approvedBy}`,
					action: "approved_without_suggestion",
					subject: `backlog:${id}`,
					args: {},
				});
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	updateTags(id: string, tags: string[], actorKind: "user" | "cat" | "system", actorId: string): BacklogItem {
		if (actorKind !== "user") throw new ControlError("invalid_input", "only operator can update tags");
		const nextTags = uniqueTags(tags);
		try {
			return this.transaction.run(() => {
				this.require(id);
				const sop = this.database
					.prepare("SELECT feature_id FROM workflow_sops WHERE backlog_item_id = ?")
					.get(id) as { feature_id?: string } | undefined;
				if (sop?.feature_id) {
					const anchor = `feature:${sop.feature_id}`;
					if (!nextTags.includes(anchor)) {
						throw new ControlError("invalid_input", "feature_anchor_locked");
					}
				}
				const now = this.clock();
				this.database
					.prepare("UPDATE backlog_items SET tags_json = ?, updated_at = ? WHERE id = ?")
					.run(jsonArray(nextTags, "tags"), now, id);
				this.audit.append({
					actor: `user:${actorId}`,
					action: "tags_updated",
					subject: `backlog:${id}`,
					args: { tags: nextTags },
				});
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	markDispatched(id: string, input: MarkBacklogDispatchedInput): BacklogItem {
		try {
			return this.transaction.run(() => {
				const current = this.require(id);
				if (current.status === "dispatched") {
					if (current.dispatchAttemptId === input.dispatchAttemptId) return current;
					throw new ControlError("conflict", `backlog item ${id} was dispatched by another attempt`);
				}
				if (current.status !== "approved") {
					throw new ControlError(
						"invalid_state",
						`backlog item ${id} cannot be dispatched from ${current.status}`,
					);
				}
				const now = this.clock();
				const result = this.database
					.prepare(
						"UPDATE backlog_items SET status = 'dispatched', dispatched_thread_id = ?, dispatched_thread_phase = ?, dispatch_attempt_id = ?, pending_thread_id = NULL, kickoff_message_id = ?, dispatched_at = ?, updated_at = ? WHERE id = ? AND status = 'approved'",
					)
					.run(input.threadId, input.phase, input.dispatchAttemptId, input.kickoffMessageId, now, now, id);
				if (changesOf(result) === 0) {
					throw new ControlError("version_conflict", `backlog item ${id} changed during dispatch`);
				}
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	markDone(id: string, actorId: string): BacklogItem {
		try {
			return this.transaction.run(() => {
				const current = this.require(id);
				if (current.status === "done") return current;
				if (current.status !== "dispatched") {
					throw new ControlError("invalid_state", `backlog item ${id} cannot be done from ${current.status}`);
				}
				const now = this.clock();
				this.database
					.prepare(
						"UPDATE backlog_items SET status = 'done', done_at = ?, updated_at = ? WHERE id = ? AND status = 'dispatched'",
					)
					.run(now, now, id);
				this.audit.append({ actor: `user:${actorId}`, action: "done", subject: `backlog:${id}`, args: {} });
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	overrideDone(id: string, reason: string, actorId: string): BacklogItem {
		const note = nonEmpty(reason, "reason");
		try {
			return this.transaction.run(() => {
				const current = this.require(id);
				if (current.status === "done") return current;
				const now = this.clock();
				this.database
					.prepare("UPDATE backlog_items SET status = 'done', done_at = ?, updated_at = ? WHERE id = ?")
					.run(now, now, id);
				this.audit.append({
					actor: `user:${actorId}`,
					action: "done_override",
					subject: `backlog:${id}`,
					args: { reason: note, fromStatus: current.status },
				});
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	private require(id: string): BacklogItem {
		const current = this.get(id);
		if (!current) throw new ControlError("not_found", `backlog item ${id} not found`);
		return current;
	}
}
