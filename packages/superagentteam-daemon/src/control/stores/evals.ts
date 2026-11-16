import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import {
	type Clock,
	jsonArray,
	jsonObject,
	mapStoreError,
	newId,
	nonEmpty,
	parseJsonArray,
	parseJsonObject,
} from "./helpers.ts";
import type { CreateEvalInput, Eval, EvalListFilter, EvalStatus } from "./types.ts";

interface EvalRow {
	id: string;
	task_id: string | null;
	provider: string;
	model: string;
	role: string;
	metrics_json: string;
	created_at: number;
	domain_id: string | null;
	bundle_id: string | null;
	verdict_id: string | null;
	window_start_ms: number | null;
	window_end_ms: number | null;
	measurement_ref: string | null;
	status: EvalStatus | null;
	reasons_json: string | null;
}

function mapEval(row: EvalRow): Eval {
	return {
		id: row.id,
		taskId: row.task_id,
		provider: row.provider,
		model: row.model,
		role: row.role,
		metrics: parseJsonObject(row.metrics_json),
		domainId: row.domain_id,
		bundleId: row.bundle_id,
		verdictId: row.verdict_id,
		windowStartMs: row.window_start_ms,
		windowEndMs: row.window_end_ms,
		measurementRef: row.measurement_ref,
		status: row.status,
		reasons: row.reasons_json ? (parseJsonArray(row.reasons_json) as string[]) : [],
		createdAt: row.created_at,
	};
}

const EVAL_STATUSES: readonly EvalStatus[] = ["ok", "insufficient", "no_data", "degraded"];

function validateWindow(start: number | null, end: number | null): void {
	if (start === null && end === null) return;
	if (start === null || end === null) {
		throw new ControlError("invalid_input", "window_start_ms and window_end_ms must be provided together");
	}
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
		throw new ControlError("invalid_input", "eval window must be non-negative integers with end > start");
	}
}

function normalizeReasons(reasons: readonly string[] | undefined): string[] {
	const normalized = (reasons ?? []).map((reason) => reason.trim()).filter((reason) => reason !== "");
	if (new Set(normalized).size !== normalized.length) {
		throw new ControlError("invalid_input", "eval reasons must be unique");
	}
	return normalized;
}

export class EvalStore {
	private readonly database: DatabaseSync;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, clock: Clock) {
		this.database = database;
		this.clock = clock;
	}

	get(id: string): Eval | null {
		const row = this.database.prepare("SELECT * FROM evals WHERE id = ?").get(id) as EvalRow | undefined;
		return row ? mapEval(row) : null;
	}

	listByTask(taskId: string): Eval[] {
		const rows = this.database
			.prepare("SELECT * FROM evals WHERE task_id = ? ORDER BY created_at, id")
			.all(taskId) as unknown as EvalRow[];
		return rows.map(mapEval);
	}

	listByBundle(bundleId: string): Eval[] {
		const rows = this.database
			.prepare("SELECT * FROM evals WHERE bundle_id = ? ORDER BY created_at, id")
			.all(bundleId) as unknown as EvalRow[];
		return rows.map(mapEval);
	}

	listByDomain(domainId: string): Eval[] {
		const rows = this.database
			.prepare("SELECT * FROM evals WHERE domain_id = ? ORDER BY created_at, id")
			.all(domainId) as unknown as EvalRow[];
		return rows.map(mapEval);
	}

	list(filter: EvalListFilter = {}): Eval[] {
		const clauses: string[] = [];
		const params: (string | number)[] = [];
		if (filter.taskId !== undefined) {
			clauses.push("task_id = ?");
			params.push(filter.taskId);
		}
		if (filter.domainId !== undefined) {
			clauses.push("domain_id = ?");
			params.push(filter.domainId);
		}
		if (filter.bundleId !== undefined) {
			clauses.push("bundle_id = ?");
			params.push(filter.bundleId);
		}
		if (filter.verdictId !== undefined) {
			clauses.push("verdict_id = ?");
			params.push(filter.verdictId);
		}
		if (filter.status !== undefined) {
			clauses.push("status = ?");
			params.push(filter.status);
		}
		if (filter.since !== undefined) {
			clauses.push("created_at >= ?");
			params.push(filter.since);
		}
		if (filter.until !== undefined) {
			clauses.push("created_at <= ?");
			params.push(filter.until);
		}
		const limit = filter.limit === undefined ? null : Math.min(Math.max(filter.limit, 1), 5000);
		const order = filter.order === "desc" ? "DESC" : "ASC";
		const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
		const sql = `SELECT * FROM evals${where} ORDER BY created_at ${order}, id ${order}${limit === null ? "" : " LIMIT ?"}`;
		const rows = this.database
			.prepare(sql)
			.all(...params, ...(limit === null ? [] : [limit])) as unknown as EvalRow[];
		return rows.map(mapEval);
	}

	create(input: CreateEvalInput): Eval {
		const id = input.id ?? newId();
		const taskId = input.taskId ?? null;
		const domainId = input.domainId ?? null;
		if (taskId === null && domainId === null) {
			throw new ControlError("invalid_input", "evals requires taskId or domainId");
		}
		if (taskId !== null && taskId.trim() === "") {
			throw new ControlError("invalid_input", "taskId must not be empty");
		}
		if (domainId !== null && !/^eval:[a-z0-9][a-z0-9-]*$/.test(domainId)) {
			throw new ControlError("invalid_input", `invalid eval domainId: ${domainId}`);
		}
		const status = input.status ?? null;
		if (status !== null && !EVAL_STATUSES.includes(status)) {
			throw new ControlError("invalid_input", `invalid eval status: ${String(status)}`);
		}
		const reasons = normalizeReasons(input.reasons);
		if (status !== null && status !== "ok" && reasons.length === 0) {
			throw new ControlError("invalid_input", `eval status ${status} requires at least one reason`);
		}
		const windowStartMs = input.windowStartMs ?? null;
		const windowEndMs = input.windowEndMs ?? null;
		validateWindow(windowStartMs, windowEndMs);
		try {
			this.database
				.prepare(
					"INSERT INTO evals (id, task_id, provider, model, role, metrics_json, created_at, domain_id, bundle_id, verdict_id, window_start_ms, window_end_ms, measurement_ref, status, reasons_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					taskId,
					nonEmpty(input.provider, "provider"),
					nonEmpty(input.model, "model"),
					nonEmpty(input.role, "role"),
					jsonObject(input.metrics, "metrics"),
					input.createdAt ?? this.clock(),
					domainId,
					input.bundleId ?? null,
					input.verdictId ?? null,
					windowStartMs,
					windowEndMs,
					input.measurementRef ?? null,
					status,
					reasons.length === 0 ? null : jsonArray(reasons, "reasons"),
				);
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
		return this.get(id)!;
	}
}
