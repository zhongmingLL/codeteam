import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import { type Clock, changesOf, jsonObject, mapStoreError, newId, nonEmpty, parseJsonObject } from "./helpers.ts";
import type {
	CreateInvocationCredentialInput,
	CredentialDisposition,
	CredentialState,
	InvocationCredential,
	OwnerAuthProvenance,
} from "./types.ts";

interface CredentialRow {
	id: string;
	run_id: string;
	task_id: string;
	role: string;
	agent_session_id: string;
	agent_profile_id: string;
	thread_id: string;
	user_id: string;
	owner_auth_provenance: OwnerAuthProvenance;
	parent_run_id: string | null;
	tool_policy_json: string;
	state: CredentialState;
	disposition: CredentialDisposition | null;
	last_refresh_at: number;
	expires_at: number | null;
	created_at: number;
	updated_at: number;
}

function mapCredential(row: CredentialRow): InvocationCredential {
	return {
		id: row.id,
		runId: row.run_id,
		taskId: row.task_id,
		role: row.role,
		agentSessionId: row.agent_session_id,
		agentProfileId: row.agent_profile_id,
		threadId: row.thread_id,
		userId: row.user_id,
		ownerAuthProvenance: row.owner_auth_provenance,
		parentRunId: row.parent_run_id,
		toolPolicy: parseJsonObject(row.tool_policy_json),
		state: row.state,
		disposition: row.disposition,
		lastRefreshAt: row.last_refresh_at,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class InvocationCredentialStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
	}

	get(id: string): InvocationCredential | null {
		const row = this.database.prepare("SELECT * FROM invocation_credentials WHERE id = ?").get(id) as
			| CredentialRow
			| undefined;
		return row ? mapCredential(row) : null;
	}

	getByRun(runId: string): InvocationCredential | null {
		const row = this.database.prepare("SELECT * FROM invocation_credentials WHERE run_id = ?").get(runId) as
			| CredentialRow
			| undefined;
		return row ? mapCredential(row) : null;
	}

	listActiveBySession(agentSessionId: string): InvocationCredential[] {
		const rows = this.database
			.prepare(
				"SELECT * FROM invocation_credentials WHERE agent_session_id = ? AND state = 'active' ORDER BY created_at",
			)
			.all(agentSessionId) as unknown as CredentialRow[];
		return rows.map(mapCredential);
	}

	create(input: CreateInvocationCredentialInput): InvocationCredential {
		const id = input.id ?? newId();
		const now = this.clock();
		try {
			const run = this.database
				.prepare("SELECT task_id, role, agent_session_id, recipient_profile_id FROM runs WHERE id = ?")
				.get(input.runId) as
				| { task_id?: string; role?: string; agent_session_id?: string; recipient_profile_id?: string }
				| undefined;
			if (!run) throw new ControlError("not_found", `run ${input.runId} not found`);
			if (
				run.task_id !== input.taskId ||
				run.role !== input.role ||
				run.agent_session_id !== input.agentSessionId ||
				run.recipient_profile_id !== input.agentProfileId
			) {
				throw new ControlError("invalid_input", "credential run coordinates do not match");
			}
			const session = this.database
				.prepare("SELECT task_id, thread_id, profile_id, role FROM agent_sessions WHERE id = ?")
				.get(input.agentSessionId) as
				| { task_id?: string | null; thread_id?: string; profile_id?: string; role?: string }
				| undefined;
			if (
				!session ||
				session.task_id !== input.taskId ||
				session.thread_id !== input.threadId ||
				session.profile_id !== input.agentProfileId ||
				session.role !== input.role
			) {
				throw new ControlError("invalid_input", "credential session coordinates do not match");
			}
			this.database
				.prepare(
					"INSERT INTO invocation_credentials (id, token_hash, token_salt, run_id, task_id, role, agent_session_id, agent_profile_id, thread_id, user_id, owner_auth_provenance, parent_run_id, tool_policy_json, state, disposition, last_refresh_at, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?)",
				)
				.run(
					id,
					nonEmpty(input.tokenHash, "tokenHash"),
					nonEmpty(input.tokenSalt, "tokenSalt"),
					nonEmpty(input.runId, "runId"),
					nonEmpty(input.taskId, "taskId"),
					nonEmpty(input.role, "role"),
					nonEmpty(input.agentSessionId, "agentSessionId"),
					nonEmpty(input.agentProfileId, "agentProfileId"),
					nonEmpty(input.threadId, "threadId"),
					nonEmpty(input.userId, "userId"),
					input.ownerAuthProvenance,
					input.parentRunId ?? null,
					jsonObject(input.toolPolicy, "toolPolicy"),
					input.lastRefreshAt ?? now,
					input.expiresAt ?? null,
					now,
					now,
				);
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
		return this.get(id)!;
	}

	terminalize(id: string, disposition: CredentialDisposition): InvocationCredential {
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `invocation credential ${id} not found`);
				if (current.state === "terminal") {
					if (current.disposition === disposition) return current;
					throw new ControlError("invalid_state", `credential ${id} is already terminal`);
				}
				const now = this.clock();
				const result = this.database
					.prepare(
						"UPDATE invocation_credentials SET state = 'terminal', disposition = ?, updated_at = ? WHERE id = ? AND state = 'active'",
					)
					.run(disposition, now, id);
				if (changesOf(result) === 0) throw new ControlError("version_conflict", `credential ${id} changed state`);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}
}
