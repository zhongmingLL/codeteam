import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
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
import type { CreateTaskInput, Task, TaskDisposition, TaskKind, TaskListFilter, TaskStatus } from "./types.ts";

interface TaskRow {
	id: string;
	kind: TaskKind;
	thread_id: string;
	subject_key: string | null;
	title: string;
	why: string;
	owner_profile_id: string | null;
	status: TaskStatus;
	created_by: string;
	user_id: string | null;
	source_message_id: string | null;
	source_summary_id: string | null;
	related_feature_id: string | null;
	detected_feature_ids_json: string;
	dispatch_gate_json: string | null;
	probe_json: string | null;
	resolve_mode: string | null;
	entrusted_work_json: string | null;
	deployment_wait_json: string | null;
	automation_state_json: string | null;
	backlog_item_id: string | null;
	repo: string | null;
	base_ref: string | null;
	base_sha: string | null;
	worktree: string | null;
	branch: string | null;
	risk: string | null;
	risk_axes_json: string;
	disposition: TaskDisposition | null;
	lane: Task["lane"];
	budget_json: string | null;
	created_at: number;
	updated_at: number;
}

function optionalObject(value: string | null): Record<string, unknown> | null {
	return value ? parseJsonObject(value) : null;
}

function mapTask(row: TaskRow): Task {
	return {
		id: row.id,
		kind: row.kind,
		threadId: row.thread_id,
		subjectKey: row.subject_key,
		title: row.title,
		why: row.why,
		ownerProfileId: row.owner_profile_id,
		status: row.status,
		createdBy: row.created_by,
		userId: row.user_id,
		sourceMessageId: row.source_message_id,
		sourceSummaryId: row.source_summary_id,
		relatedFeatureId: row.related_feature_id,
		detectedFeatureIds: parseJsonArray(row.detected_feature_ids_json),
		dispatchGate: optionalObject(row.dispatch_gate_json),
		probe: optionalObject(row.probe_json),
		resolveMode: row.resolve_mode,
		entrustedWork: optionalObject(row.entrusted_work_json),
		deploymentWait: optionalObject(row.deployment_wait_json),
		automationState: optionalObject(row.automation_state_json),
		backlogItemId: row.backlog_item_id,
		repo: row.repo,
		baseRef: row.base_ref,
		baseSha: row.base_sha,
		worktree: row.worktree,
		branch: row.branch,
		risk: row.risk,
		riskAxes: parseJsonArray(row.risk_axes_json),
		disposition: row.disposition,
		lane: row.lane,
		budget: optionalObject(row.budget_json),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class TaskStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
	}

	get(id: string): Task | null {
		const row = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
		return row ? mapTask(row) : null;
	}

	list(filter: TaskListFilter = {}): Task[] {
		const clauses: string[] = [];
		const params: string[] = [];
		if (filter.threadId !== undefined) {
			clauses.push("thread_id = ?");
			params.push(filter.threadId);
		}
		if (filter.ownerProfileId !== undefined) {
			clauses.push("owner_profile_id = ?");
			params.push(filter.ownerProfileId);
		}
		if (filter.status !== undefined) {
			clauses.push("status = ?");
			params.push(filter.status);
		}
		if (filter.kind !== undefined) {
			clauses.push("kind = ?");
			params.push(filter.kind);
		}
		const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.database
			.prepare(`SELECT * FROM tasks${where} ORDER BY created_at, id`)
			.all(...params) as unknown as TaskRow[];
		return rows.map(mapTask);
	}

	findWorkByBacklog(backlogItemId: string): Task | null {
		const row = this.database
			.prepare("SELECT * FROM tasks WHERE kind = 'work' AND backlog_item_id = ? ORDER BY created_at, id LIMIT 1")
			.get(backlogItemId) as TaskRow | undefined;
		return row ? mapTask(row) : null;
	}

	findBySubjectKey(kind: TaskKind, subjectKey: string): Task | null {
		const row = this.database
			.prepare("SELECT * FROM tasks WHERE kind = ? AND subject_key = ? ORDER BY created_at, id LIMIT 1")
			.get(kind, subjectKey) as TaskRow | undefined;
		return row ? mapTask(row) : null;
	}

	listWithDeploymentWait(): Task[] {
		const rows = this.database
			.prepare("SELECT * FROM tasks WHERE deployment_wait_json IS NOT NULL ORDER BY created_at, id")
			.all() as unknown as TaskRow[];
		return rows.map(mapTask);
	}

	setDeploymentWait(
		id: string,
		value: Record<string, unknown> | null,
		options: { expectedUpdatedAt?: number } = {},
	): Task {
		const now = this.clock();
		try {
			return this.transaction.run(() => {
				const result =
					options.expectedUpdatedAt === undefined
						? this.database
								.prepare("UPDATE tasks SET deployment_wait_json = ?, updated_at = ? WHERE id = ?")
								.run(value === null ? null : jsonObject(value, "deploymentWait"), now, id)
						: this.database
								.prepare(
									"UPDATE tasks SET deployment_wait_json = ?, updated_at = ? WHERE id = ? AND updated_at = ?",
								)
								.run(
									value === null ? null : jsonObject(value, "deploymentWait"),
									now,
									id,
									options.expectedUpdatedAt,
								);
				if (changesOf(result) === 0) {
					if (!this.get(id)) throw new ControlError("not_found", `task ${id} not found`);
					throw new ControlError("version_conflict", `task ${id} changed since the expected revision`);
				}
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	create(input: CreateTaskInput): Task {
		const id = input.id ?? newId();
		const kind = input.kind;
		const subjectKey = input.subjectKey ?? null;
		if (kind !== "work" && (!subjectKey || subjectKey.trim() === "")) {
			throw new ControlError("invalid_input", "tracking tasks require subjectKey");
		}
		if (kind === "work" && (!input.backlogItemId || input.backlogItemId.trim() === "")) {
			throw new ControlError("backlog_not_imported", "work tasks require an existing backlog item");
		}
		const now = this.clock();
		try {
			return this.transaction.run(() => {
				this.database
					.prepare(
						"INSERT INTO tasks (id, kind, thread_id, subject_key, title, why, owner_profile_id, status, created_by, user_id, source_message_id, source_summary_id, related_feature_id, detected_feature_ids_json, backlog_item_id, repo, base_ref, base_sha, worktree, branch, risk, risk_axes_json, lane, budget_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						id,
						kind,
						nonEmpty(input.threadId, "threadId"),
						subjectKey,
						nonEmpty(input.title, "title"),
						nonEmpty(input.why, "why"),
						input.ownerProfileId ?? null,
						input.status ?? "todo",
						nonEmpty(input.createdBy, "createdBy"),
						input.userId ?? null,
						input.sourceMessageId ?? null,
						input.sourceSummaryId ?? null,
						input.relatedFeatureId ?? null,
						jsonArray(input.detectedFeatureIds ?? [], "detectedFeatureIds"),
						input.backlogItemId ?? null,
						input.repo ?? null,
						input.baseRef ?? null,
						input.baseSha ?? null,
						input.worktree ?? null,
						input.branch ?? null,
						input.risk ?? null,
						jsonArray(input.riskAxes ?? [], "riskAxes"),
						input.lane ?? null,
						input.budget ? jsonObject(input.budget, "budget") : null,
						now,
						now,
					);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}

	setStatus(id: string, status: TaskStatus, options: { expectedUpdatedAt?: number } = {}): Task {
		const now = this.clock();
		try {
			const result =
				options.expectedUpdatedAt === undefined
					? this.database.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id)
					: this.database
							.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND updated_at = ?")
							.run(status, now, id, options.expectedUpdatedAt);
			if (changesOf(result) === 0) {
				if (!this.get(id)) throw new ControlError("not_found", `task ${id} not found`);
				throw new ControlError("version_conflict", `task ${id} changed since the expected revision`);
			}
			return this.get(id)!;
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}

	bindWorktree(
		id: string,
		input: {
			worktree: string;
			repo?: string | null;
			baseRef?: string | null;
			baseSha?: string | null;
			branch?: string | null;
		},
	): Task {
		const worktree = nonEmpty(input.worktree, "worktree");
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `task ${id} not found`);
				if (current.worktree !== null && current.worktree !== worktree) {
					throw new ControlError("invalid_state", `task ${id} is already bound to worktree ${current.worktree}`);
				}
				const result = this.database
					.prepare(
						"UPDATE tasks SET worktree = ?, repo = COALESCE(?, repo), base_ref = COALESCE(?, base_ref), base_sha = COALESCE(?, base_sha), branch = COALESCE(?, branch), updated_at = ? WHERE id = ?",
					)
					.run(
						worktree,
						input.repo ?? null,
						input.baseRef ?? null,
						input.baseSha ?? null,
						input.branch ?? null,
						this.clock(),
						id,
					);
				if (changesOf(result) === 0) throw new ControlError("not_found", `task ${id} not found`);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	setDisposition(id: string, disposition: TaskDisposition, options: { expectedUpdatedAt?: number } = {}): Task {
		const current = this.get(id);
		if (!current) throw new ControlError("not_found", `task ${id} not found`);
		if (current.status === "done") {
			if (current.disposition === disposition) return current;
			throw new ControlError("invalid_state", `task ${id} is already done`);
		}
		const now = this.clock();
		try {
			const result =
				options.expectedUpdatedAt === undefined
					? this.database
							.prepare("UPDATE tasks SET status = 'done', disposition = ?, updated_at = ? WHERE id = ?")
							.run(disposition, now, id)
					: this.database
							.prepare(
								"UPDATE tasks SET status = 'done', disposition = ?, updated_at = ? WHERE id = ? AND updated_at = ?",
							)
							.run(disposition, now, id, options.expectedUpdatedAt);
			if (changesOf(result) === 0) {
				if (!this.get(id)) throw new ControlError("not_found", `task ${id} not found`);
				throw new ControlError("version_conflict", `task ${id} changed since the expected revision`);
			}
			return this.get(id)!;
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}
}
