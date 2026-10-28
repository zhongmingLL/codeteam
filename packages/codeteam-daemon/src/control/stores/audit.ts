import type { DatabaseSync } from "node:sqlite";
import { type Clock, jsonObject, mapStoreError, newId, nonEmpty, parseJsonObject } from "./helpers.ts";
import type { AppendAuditInput, AuditEntry } from "./types.ts";

interface AuditRow {
	id: string;
	actor: string;
	action: string;
	subject: string;
	args_json: string;
	result: string;
	ts: number;
}

function mapAudit(row: AuditRow): AuditEntry {
	return {
		id: row.id,
		actor: row.actor,
		action: row.action,
		subject: row.subject,
		args: parseJsonObject(row.args_json),
		result: row.result,
		ts: row.ts,
	};
}

export class AuditStore {
	private readonly database: DatabaseSync;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, clock: Clock) {
		this.database = database;
		this.clock = clock;
	}

	append(input: AppendAuditInput): AuditEntry {
		const id = input.id ?? newId();
		try {
			this.database
				.prepare(
					"INSERT INTO audit (id, actor, action, subject, args_json, result, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					nonEmpty(input.actor, "actor"),
					nonEmpty(input.action, "action"),
					nonEmpty(input.subject, "subject"),
					jsonObject(input.args ?? {}, "args"),
					input.result ?? "ok",
					input.ts ?? this.clock(),
				);
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
		return this.get(id)!;
	}

	get(id: string): AuditEntry | null {
		const row = this.database.prepare("SELECT * FROM audit WHERE id = ?").get(id) as AuditRow | undefined;
		return row ? mapAudit(row) : null;
	}

	listSubject(subject: string, limit = 100): AuditEntry[] {
		const rows = this.database
			.prepare("SELECT * FROM audit WHERE subject = ? ORDER BY ts DESC, rowid DESC LIMIT ?")
			.all(subject, Math.min(Math.max(limit, 1), 500)) as unknown as AuditRow[];
		return rows.map(mapAudit);
	}

	latest(subject: string, action?: string): AuditEntry | null {
		const row = action
			? (this.database
					.prepare("SELECT * FROM audit WHERE subject = ? AND action = ? ORDER BY ts DESC, rowid DESC LIMIT 1")
					.get(subject, action) as AuditRow | undefined)
			: (this.database
					.prepare("SELECT * FROM audit WHERE subject = ? ORDER BY ts DESC, rowid DESC LIMIT 1")
					.get(subject) as AuditRow | undefined);
		return row ? mapAudit(row) : null;
	}
}
