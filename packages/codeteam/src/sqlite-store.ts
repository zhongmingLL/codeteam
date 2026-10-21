import { DatabaseSync } from "node:sqlite";
import type { ControlSnapshot, ControlStore } from "./store.ts";
import type { Handoff, Run, Task } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
	id TEXT PRIMARY KEY,
	stage TEXT NOT NULL,
	status TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS runs (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL,
	role TEXT NOT NULL,
	status TEXT NOT NULL,
	handoff_id TEXT,
	terminal_at INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS handoffs (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	from_role TEXT NOT NULL,
	to_role TEXT NOT NULL,
	status TEXT NOT NULL,
	subject TEXT NOT NULL,
	action_pair TEXT NOT NULL,
	expected_artifact TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	deadline INTEGER NOT NULL,
	attempt INTEGER NOT NULL,
	claimed_by_run_id TEXT,
	claimed_at INTEGER,
	terminal_at INTEGER,
	result_json TEXT,
	created_at INTEGER NOT NULL
) STRICT;
`;

interface TaskRow {
	id: string;
	stage: string;
	status: string;
}

interface RunRow {
	id: string;
	task_id: string;
	role: string;
	status: string;
	handoff_id: string | null;
	terminal_at: number | null;
}

interface HandoffRow {
	id: string;
	task_id: string;
	kind: string;
	from_role: string;
	to_role: string;
	status: string;
	subject: string;
	action_pair: string;
	expected_artifact: string;
	payload_json: string;
	deadline: number;
	attempt: number;
	claimed_by_run_id: string | null;
	claimed_at: number | null;
	terminal_at: number | null;
	result_json: string | null;
	created_at: number;
}

export class SqliteControlStore implements ControlStore {
	private readonly db: DatabaseSync;

	constructor(path = ":memory:") {
		this.db = new DatabaseSync(path);
		this.db.exec(SCHEMA);
	}

	saveTask(task: Task): void {
		this.db
			.prepare(
				`INSERT INTO tasks (id, stage, status) VALUES (?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET stage = excluded.stage, status = excluded.status`,
			)
			.run(task.id, task.stage, task.status);
	}

	saveRun(run: Run): void {
		this.db
			.prepare(
				`INSERT INTO runs (id, task_id, role, status, handoff_id, terminal_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   task_id = excluded.task_id,
				   role = excluded.role,
				   status = excluded.status,
				   handoff_id = excluded.handoff_id,
				   terminal_at = excluded.terminal_at`,
			)
			.run(run.id, run.taskId, run.role, run.status, run.handoffId ?? null, run.terminalAt ?? null);
	}

	saveHandoff(handoff: Handoff): void {
		this.db
			.prepare(
				`INSERT INTO handoffs (
				   id, task_id, kind, from_role, to_role, status, subject, action_pair,
				   expected_artifact, payload_json, deadline, attempt, claimed_by_run_id,
				   claimed_at, terminal_at, result_json, created_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   task_id = excluded.task_id,
				   kind = excluded.kind,
				   from_role = excluded.from_role,
				   to_role = excluded.to_role,
				   status = excluded.status,
				   subject = excluded.subject,
				   action_pair = excluded.action_pair,
				   expected_artifact = excluded.expected_artifact,
				   payload_json = excluded.payload_json,
				   deadline = excluded.deadline,
				   attempt = excluded.attempt,
				   claimed_by_run_id = excluded.claimed_by_run_id,
				   claimed_at = excluded.claimed_at,
				   terminal_at = excluded.terminal_at,
				   result_json = excluded.result_json,
				   created_at = excluded.created_at`,
			)
			.run(
				handoff.id,
				handoff.taskId,
				handoff.kind,
				handoff.fromRole,
				handoff.toRole,
				handoff.status,
				handoff.subject,
				handoff.actionPair,
				handoff.expectedArtifact,
				JSON.stringify(handoff.payload),
				handoff.deadline,
				handoff.attempt,
				handoff.claimedByRunId ?? null,
				handoff.claimedAt ?? null,
				handoff.terminalAt ?? null,
				handoff.result === undefined ? null : JSON.stringify(handoff.result),
				handoff.createdAt,
			);
	}

	loadSnapshot(): ControlSnapshot {
		const tasks = this.db.prepare("SELECT id, stage, status FROM tasks ORDER BY id").all() as unknown as TaskRow[];
		const runs = this.db
			.prepare("SELECT id, task_id, role, status, handoff_id, terminal_at FROM runs ORDER BY id")
			.all() as unknown as RunRow[];
		const handoffs = this.db
			.prepare(
				`SELECT id, task_id, kind, from_role, to_role, status, subject, action_pair,
				   expected_artifact, payload_json, deadline, attempt, claimed_by_run_id,
				   claimed_at, terminal_at, result_json, created_at
				 FROM handoffs ORDER BY created_at, id`,
			)
			.all() as unknown as HandoffRow[];

		return {
			tasks: tasks.map((row) => ({
				id: row.id,
				stage: row.stage as Task["stage"],
				status: row.status as Task["status"],
			})),
			runs: runs.map((row) => ({
				id: row.id,
				taskId: row.task_id,
				role: row.role as Run["role"],
				status: row.status as Run["status"],
				...(row.handoff_id === null ? {} : { handoffId: row.handoff_id }),
				...(row.terminal_at === null ? {} : { terminalAt: row.terminal_at }),
			})),
			handoffs: handoffs.map((row) => ({
				id: row.id,
				taskId: row.task_id,
				kind: row.kind as Handoff["kind"],
				fromRole: row.from_role as Handoff["fromRole"],
				toRole: row.to_role as Handoff["toRole"],
				status: row.status as Handoff["status"],
				subject: row.subject,
				actionPair: row.action_pair,
				expectedArtifact: row.expected_artifact,
				payload: JSON.parse(row.payload_json) as Record<string, unknown>,
				deadline: row.deadline,
				attempt: row.attempt,
				...(row.claimed_by_run_id === null ? {} : { claimedByRunId: row.claimed_by_run_id }),
				...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at }),
				...(row.terminal_at === null ? {} : { terminalAt: row.terminal_at }),
				...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as Record<string, unknown> }),
				createdAt: row.created_at,
			})),
		};
	}

	close(): void {
		this.db.close();
	}
}
