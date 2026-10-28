import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import {
	type Clock,
	changesOf,
	jsonObject,
	mapStoreError,
	newId,
	nonEmpty,
	parseJson,
	parseJsonObject,
} from "./helpers.ts";
import type {
	AgentSession,
	CreateAgentSessionInput,
	SealAgentSessionInput,
	SessionListFilter,
	SessionStatus,
	WorkerBindingState,
} from "./types.ts";

interface AgentSessionRow {
	id: string;
	thread_id: string;
	task_id: string | null;
	profile_id: string;
	role: string;
	stage_id: string | null;
	pi_session_id: string | null;
	effective_tool_policy: string;
	chain_key: string | null;
	provider: string;
	model: string;
	model_family: string;
	status: SessionStatus;
	seq: number;
	native_session_binding_json: string | null;
	context_health_json: string | null;
	capacity_pin_json: string | null;
	seal_reason: string | null;
	cat_handoff_note_json: string | null;
	compression_count: number | null;
	continuity_capsule_json: string | null;
	latest_resume_session_id: string | null;
	last_usage_json: string | null;
	message_count: number;
	working_directory: string | null;
	workspace_fingerprint: string | null;
	worker_id: string | null;
	worker_binding_state: WorkerBindingState;
	worker_attached_at: number | null;
	user_id: string | null;
	created_at: number;
	updated_at: number;
	sealed_at: number | null;
}

function optionalJson(value: unknown, field: string, objectOnly = false): string | null {
	if (value === undefined || value === null) return null;
	return objectOnly ? jsonObject(value, field) : JSON.stringify(value);
}

function mapSession(row: AgentSessionRow): AgentSession {
	return {
		id: row.id,
		threadId: row.thread_id,
		taskId: row.task_id,
		profileId: row.profile_id,
		role: row.role,
		stageId: row.stage_id,
		piSessionId: row.pi_session_id,
		effectiveToolPolicy: row.effective_tool_policy,
		chainKey: row.chain_key,
		provider: row.provider,
		model: row.model,
		modelFamily: row.model_family,
		status: row.status,
		seq: row.seq,
		nativeSessionBinding: row.native_session_binding_json ? parseJson(row.native_session_binding_json) : null,
		contextHealth: row.context_health_json ? parseJsonObject(row.context_health_json) : null,
		capacityPin: row.capacity_pin_json ? parseJson(row.capacity_pin_json) : null,
		sealReason: row.seal_reason,
		catHandoffNote: row.cat_handoff_note_json ? parseJsonObject(row.cat_handoff_note_json) : null,
		compressionCount: row.compression_count,
		continuityCapsule: row.continuity_capsule_json ? parseJson(row.continuity_capsule_json) : null,
		latestResumeSessionId: row.latest_resume_session_id,
		lastUsage: row.last_usage_json ? parseJsonObject(row.last_usage_json) : null,
		messageCount: row.message_count,
		workingDirectory: row.working_directory,
		workspaceFingerprint: row.workspace_fingerprint,
		workerId: row.worker_id,
		workerBindingState: row.worker_binding_state,
		workerAttachedAt: row.worker_attached_at,
		userId: row.user_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		sealedAt: row.sealed_at,
	};
}

export class AgentSessionStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
	}

	get(id: string): AgentSession | null {
		const row = this.database.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id) as
			| AgentSessionRow
			| undefined;
		return row ? mapSession(row) : null;
	}

	list(filter: SessionListFilter = {}): AgentSession[] {
		const clauses: string[] = [];
		const params: string[] = [];
		if (filter.threadId !== undefined) {
			clauses.push("thread_id = ?");
			params.push(filter.threadId);
		}
		if (filter.taskId !== undefined) {
			clauses.push("task_id = ?");
			params.push(filter.taskId);
		}
		if (filter.profileId !== undefined) {
			clauses.push("profile_id = ?");
			params.push(filter.profileId);
		}
		if (filter.status !== undefined) {
			clauses.push("status = ?");
			params.push(filter.status);
		}
		const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.database
			.prepare(`SELECT * FROM agent_sessions${where} ORDER BY created_at, id`)
			.all(...params) as unknown as AgentSessionRow[];
		return rows.map(mapSession);
	}

	create(input: CreateAgentSessionInput): AgentSession {
		const id = input.id ?? newId();
		const now = this.clock();
		const status = input.status ?? "active";
		try {
			this.database
				.prepare(
					"INSERT INTO agent_sessions (id, thread_id, task_id, profile_id, role, stage_id, pi_session_id, effective_tool_policy, chain_key, provider, model, model_family, status, seq, native_session_binding_json, context_health_json, capacity_pin_json, seal_reason, cat_handoff_note_json, compression_count, continuity_capsule_json, latest_resume_session_id, last_usage_json, message_count, working_directory, workspace_fingerprint, worker_id, worker_binding_state, worker_attached_at, user_id, created_at, updated_at, sealed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					nonEmpty(input.threadId, "threadId"),
					input.taskId ?? null,
					nonEmpty(input.profileId, "profileId"),
					nonEmpty(input.role, "role"),
					input.stageId ?? null,
					input.piSessionId ?? null,
					nonEmpty(input.effectiveToolPolicy, "effectiveToolPolicy"),
					input.chainKey ?? null,
					nonEmpty(input.provider, "provider"),
					nonEmpty(input.model, "model"),
					nonEmpty(input.modelFamily, "modelFamily"),
					status,
					input.seq,
					optionalJson(input.nativeSessionBinding, "nativeSessionBinding"),
					optionalJson(input.contextHealth, "contextHealth", true),
					optionalJson(input.capacityPin, "capacityPin"),
					input.sealReason ?? null,
					optionalJson(input.catHandoffNote, "catHandoffNote", true),
					input.compressionCount ?? null,
					optionalJson(input.continuityCapsule, "continuityCapsule"),
					input.latestResumeSessionId ?? null,
					optionalJson(input.lastUsage, "lastUsage", true),
					input.messageCount ?? 0,
					input.workingDirectory ?? null,
					input.workspaceFingerprint ?? null,
					input.workerId ?? null,
					input.workerBindingState ?? "unbound",
					input.workerAttachedAt ?? null,
					input.userId ?? null,
					now,
					now,
					status === "sealed" ? now : null,
				);
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
		return this.get(id)!;
	}

	bindWorker(
		id: string,
		workerId: string,
		input: { state?: WorkerBindingState; attachedAt?: number } = {},
	): AgentSession {
		const state = input.state ?? "attached";
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `agent session ${id} not found`);
				if (current.status !== "active") {
					throw new ControlError("invalid_state", `agent session ${id} is ${current.status}`);
				}
				const now = input.attachedAt ?? this.clock();
				const result = this.database
					.prepare(
						"UPDATE agent_sessions SET worker_id = ?, worker_binding_state = ?, worker_attached_at = ?, updated_at = ? WHERE id = ?",
					)
					.run(workerId, state, now, now, id);
				if (changesOf(result) === 0) throw new ControlError("not_found", `agent session ${id} not found`);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	markReattachPending(id: string): AgentSession {
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `agent session ${id} not found`);
				if (current.status !== "active") return current;
				if (current.workerBindingState === "re_attach_pending") return current;
				const now = this.clock();
				const result = this.database
					.prepare(
						"UPDATE agent_sessions SET worker_binding_state = 're_attach_pending', updated_at = ? WHERE id = ?",
					)
					.run(now, id);
				if (changesOf(result) === 0) throw new ControlError("not_found", `agent session ${id} not found`);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	updateRuntimeBinding(
		id: string,
		input: {
			piSessionId?: string | null;
			nativeSessionBinding?: unknown;
			continuityCapsule?: unknown;
			messageCount?: number;
			lastUsage?: unknown;
		},
	): AgentSession {
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `agent session ${id} not found`);
				const sets: string[] = ["updated_at = ?"];
				const params: (string | number | null)[] = [this.clock()];
				if (input.piSessionId !== undefined) {
					sets.push("pi_session_id = ?");
					params.push(input.piSessionId);
				}
				if (input.nativeSessionBinding !== undefined) {
					sets.push("native_session_binding_json = ?");
					params.push(optionalJson(input.nativeSessionBinding, "nativeSessionBinding"));
				}
				if (input.continuityCapsule !== undefined) {
					sets.push("continuity_capsule_json = ?");
					params.push(optionalJson(input.continuityCapsule, "continuityCapsule"));
				}
				if (input.messageCount !== undefined) {
					sets.push("message_count = ?");
					params.push(input.messageCount);
				}
				if (input.lastUsage !== undefined) {
					sets.push("last_usage_json = ?");
					params.push(optionalJson(input.lastUsage, "lastUsage", true));
				}
				params.push(id);
				const result = this.database
					.prepare(`UPDATE agent_sessions SET ${sets.join(", ")} WHERE id = ?`)
					.run(...params);
				if (changesOf(result) === 0) throw new ControlError("not_found", `agent session ${id} not found`);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	seal(id: string, input: SealAgentSessionInput): AgentSession {
		const sealReason = nonEmpty(input.sealReason, "sealReason");
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `agent session ${id} not found`);
				if (current.status === "sealed")
					throw new ControlError("invalid_state", `agent session ${id} is already sealed`);
				const now = this.clock();
				const sets = ["status = 'sealed'", "sealed_at = ?", "seal_reason = ?", "updated_at = ?"];
				const params: (string | number | null)[] = [now, sealReason, now];
				if (input.catHandoffNote !== undefined) {
					sets.push("cat_handoff_note_json = ?");
					params.push(optionalJson(input.catHandoffNote, "catHandoffNote", true));
				}
				if (input.continuityCapsule !== undefined) {
					sets.push("continuity_capsule_json = ?");
					params.push(optionalJson(input.continuityCapsule, "continuityCapsule"));
				}
				if (input.compressionCount !== undefined) {
					sets.push("compression_count = ?");
					params.push(input.compressionCount);
				}
				if (input.latestResumeSessionId !== undefined) {
					sets.push("latest_resume_session_id = ?");
					params.push(input.latestResumeSessionId);
				}
				if (input.messageCount !== undefined) {
					sets.push("message_count = ?");
					params.push(input.messageCount);
				}
				params.push(id);
				let sql = `UPDATE agent_sessions SET ${sets.join(", ")} WHERE id = ?`;
				if (input.expectedUpdatedAt !== undefined) {
					sql += " AND updated_at = ?";
					params.push(input.expectedUpdatedAt);
				}
				const result = this.database.prepare(sql).run(...params);
				if (changesOf(result) === 0) {
					throw new ControlError("version_conflict", `agent session ${id} changed since the expected revision`);
				}
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}
}
