import type { DatabaseSync } from "node:sqlite";
import type {
	ToolCategory,
	ToolUsageQuery,
	ToolUsageRecordInput,
	ToolUsageRecordResult,
	ToolUsageReport,
} from "../../observability/contracts.ts";
import { classifyTool, normalizeToolName } from "../../observability/tool-classification.ts";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import { type Clock, changesOf, mapStoreError, nonEmpty } from "./helpers.ts";

interface CounterRow {
	day: string;
	profile_id: string;
	category: ToolCategory;
	tool_name: string;
	count: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RETENTION_DAYS = 90;
const TOP_TOOLS_LIMIT = 20;

/**
 * F150 parity: independent tool-usage counters in the control SQLite database.
 * Idempotency is keyed by the canonical run_events.id; there is no foreign key
 * to runs so the counter store remains an independent projection.
 */
export class ToolUsageStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
		try {
			this.prune();
		} catch {
			// Retention is best effort; it must never block opening the control store.
		}
	}

	record(input: ToolUsageRecordInput): ToolUsageRecordResult {
		const eventId = nonEmpty(input.eventId, "eventId");
		const runId = nonEmpty(input.runId, "runId");
		const profileId = nonEmpty(input.profileId, "profileId");
		const toolName = normalizeToolName(input.toolName);
		const classification = classifyTool(toolName, input.toolInput);
		const at = input.at ?? this.clock();
		const day = toDay(at);
		try {
			return this.transaction.run(() => {
				const inserted = this.database
					.prepare(
						"INSERT OR IGNORE INTO tool_usage_events (id, run_id, profile_id, day, category, tool_name, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					)
					.run(eventId, runId, profileId, day, classification.category, classification.toolName, at);
				if (changesOf(inserted) === 0) {
					return {
						recorded: false,
						count: this.currentCount(day, profileId, classification.category, classification.toolName),
					};
				}
				this.database
					.prepare(
						`INSERT INTO tool_usage_counters (day, profile_id, category, tool_name, count, updated_at)
						 VALUES (?, ?, ?, ?, 1, ?)
						 ON CONFLICT(day, profile_id, category, tool_name)
						 DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`,
					)
					.run(day, profileId, classification.category, classification.toolName, at);
				return {
					recorded: true,
					count: this.currentCount(day, profileId, classification.category, classification.toolName),
				};
			});
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}

	report(query: ToolUsageQuery = {}): ToolUsageReport {
		const now = this.clock();
		const to = normalizeDay(query.to ?? toDay(now));
		const days = query.days ?? 30;
		const minDay = this.minCounterDay();
		const from =
			query.from !== undefined
				? normalizeDay(query.from)
				: days <= 0
					? (minDay ?? to)
					: addDays(to, -(Math.max(1, Math.trunc(days)) - 1));
		if (compareDays(from, to) > 0) throw new ControlError("invalid_input", "from_after_to");
		const clauses = ["day >= ?", "day <= ?"];
		const params: Array<string> = [from, to];
		if (query.profileId) {
			clauses.push("profile_id = ?");
			params.push(query.profileId);
		}
		if (query.category) {
			clauses.push("category = ?");
			params.push(query.category);
		}
		const rows = this.database
			.prepare(
				`SELECT day, profile_id, category, tool_name, count FROM tool_usage_counters WHERE ${clauses.join(" AND ")}`,
			)
			.all(...params) as unknown as CounterRow[];

		const byCategory: Record<ToolCategory, number> = { native: 0, mcp: 0, skill: 0 };
		const byProfile: Record<string, Record<ToolCategory, number>> = {};
		const byDay = new Map<string, Record<ToolCategory, number>>();
		const toolTotals = new Map<string, { name: string; category: ToolCategory; count: number }>();
		let totalCalls = 0;
		for (const row of rows) {
			totalCalls += row.count;
			byCategory[row.category] += row.count;
			const profile = byProfile[row.profile_id] ?? { native: 0, mcp: 0, skill: 0 };
			profile[row.category] += row.count;
			byProfile[row.profile_id] = profile;
			const day = byDay.get(row.day) ?? { native: 0, mcp: 0, skill: 0 };
			day[row.category] += row.count;
			byDay.set(row.day, day);
			const key = `${row.category}:${row.tool_name}`;
			const tool = toolTotals.get(key) ?? { name: row.tool_name, category: row.category, count: 0 };
			tool.count += row.count;
			toolTotals.set(key, tool);
		}
		const topTools = [...toolTotals.values()].sort((a, b) => b.count - a.count).slice(0, TOP_TOOLS_LIMIT);
		const daily: Array<{ date: string; native: number; mcp: number; skill: number }> = [];
		const boundedTo = compareDays(from, to) > 0 ? from : to;
		let cursor = from;
		let guard = 0;
		while (compareDays(cursor, boundedTo) <= 0 && guard < 3660) {
			const counts = byDay.get(cursor) ?? { native: 0, mcp: 0, skill: 0 };
			daily.push({ date: cursor, ...counts });
			cursor = addDays(cursor, 1);
			guard += 1;
		}
		return {
			period: { from, to },
			summary: { totalCalls, byCategory },
			topTools,
			daily,
			byProfile,
		};
	}

	prune(retentionDays = DEFAULT_RETENTION_DAYS): { events: number; counters: number } {
		const days = Math.max(1, Math.trunc(retentionDays));
		const cutoff = addDays(toDay(this.clock()), -days);
		const cutoffMs = Date.parse(`${cutoff}T00:00:00.000Z`);
		try {
			return this.transaction.run(() => {
				const counters = this.database.prepare("DELETE FROM tool_usage_counters WHERE day < ?").run(cutoff);
				const events = this.database.prepare("DELETE FROM tool_usage_events WHERE recorded_at < ?").run(cutoffMs);
				return { events: changesOf(events), counters: changesOf(counters) };
			});
		} catch (error) {
			throw mapStoreError(error, "conflict");
		}
	}

	private currentCount(day: string, profileId: string, category: ToolCategory, toolName: string): number {
		const row = this.database
			.prepare(
				"SELECT count FROM tool_usage_counters WHERE day = ? AND profile_id = ? AND category = ? AND tool_name = ?",
			)
			.get(day, profileId, category, toolName) as { count?: number } | undefined;
		return row?.count ?? 0;
	}

	private minCounterDay(): string | null {
		const row = this.database.prepare("SELECT MIN(day) AS day FROM tool_usage_counters").get() as
			| { day?: string | null }
			| undefined;
		return row?.day ?? null;
	}
}

function toDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

function normalizeDay(value: string): string {
	if (!DAY.test(value)) throw new ControlError("invalid_input", `invalid_day: ${value}`);
	const parsed = Date.parse(`${value}T00:00:00.000Z`);
	if (!Number.isFinite(parsed) || toDay(parsed) !== value) {
		throw new ControlError("invalid_input", `invalid_day: ${value}`);
	}
	return value;
}

function addDays(day: string, delta: number): string {
	const date = new Date(`${day}T00:00:00.000Z`);
	date.setUTCDate(date.getUTCDate() + delta);
	return date.toISOString().slice(0, 10);
}

function compareDays(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
