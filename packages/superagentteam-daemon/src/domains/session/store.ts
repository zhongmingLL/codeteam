import type { DatabaseSync } from "node:sqlite";

import type { AgentSession } from "@superagentteam/shared/types";

// F018 R1-c AgentSessionStore (0010 §6) — thread×agent durable identity,
// single active per pair; fresh implementation, no legacy skeleton.

interface SessionRow {
	id: string;
	thread_id: string;
	agent_id: string;
	user_id: string;
	seq: number;
	status: "active" | "sealing" | "sealed";
	pi_session_id: string | null;
	pi_session_file: string | null;
	working_directory: string;
	message_count: number;
	consecutive_resume_failures: number;
	seal_reason: string | null;
	last_counted_turn_execution_id: string | null;
	created_at: number;
	updated_at: number;
	sealed_at: number | null;
}

function mapSession(row: SessionRow): AgentSession {
	return {
		id: row.id,
		threadId: row.thread_id,
		agentId: row.agent_id,
		userId: row.user_id,
		seq: row.seq,
		status: row.status,
		piSessionId: row.pi_session_id,
		piSessionFile: row.pi_session_file,
		workingDirectory: row.working_directory,
		messageCount: row.message_count,
		consecutiveResumeFailures: row.consecutive_resume_failures,
		sealReason: row.seal_reason,
		lastCountedTurnExecutionId: row.last_counted_turn_execution_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		sealedAt: row.sealed_at,
	};
}

export interface EnsureSessionInput {
	threadId: string;
	agentId: string;
	userId: string;
	workingDirectory: string;
	now: number;
}

export class AgentSessionStore {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/** Returns the single active session, creating one if none exists (0010 §2). */
	ensureActive(input: EnsureSessionInput): AgentSession {
		const thread = this.db.prepare("SELECT created_by, project_path FROM threads WHERE id = ?").get(input.threadId) as
			| { created_by: string; project_path: string }
			| undefined;
		if (!thread) throw new Error("session_thread_not_found");
		if (thread.created_by !== input.userId) throw new Error("session_user_not_thread_owner");
		const existing = this.getActive(input.threadId, input.agentId);
		if (existing) {
			if (existing.workingDirectory !== input.workingDirectory) {
				throw new Error("session_workspace_changed");
			}
			return existing;
		}
		if (input.workingDirectory !== thread.project_path) {
			throw new Error("session_workspace_not_thread_project");
		}
		// 0010 §2: seq is 0-based — COALESCE(MAX,-1)+1 gives 0 on first create.
		const seq = (
			this.db
				.prepare(
					"SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM agent_sessions WHERE thread_id = ? AND agent_id = ?",
				)
				.get(input.threadId, input.agentId) as { next: number }
		).next;
		const id = `sess:${input.threadId}:${input.agentId}:${seq}`;
		this.db
			.prepare(
				`INSERT INTO agent_sessions (id, thread_id, agent_id, user_id, seq, status, working_directory, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
			)
			.run(id, input.threadId, input.agentId, input.userId, seq, input.workingDirectory, input.now, input.now);
		return this.getActive(input.threadId, input.agentId)!;
	}

	getActive(threadId: string, agentId: string): AgentSession | null {
		const row = this.db
			.prepare("SELECT * FROM agent_sessions WHERE thread_id = ? AND agent_id = ? AND status = 'active'")
			.get(threadId, agentId) as SessionRow | undefined;
		return row ? mapSession(row) : null;
	}

	get(sessionId: string): AgentSession | null {
		const row = this.db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
		return row ? mapSession(row) : null;
	}

	/** Lightweight seal (0010): active → sealed + seq increments on next ensure. */
	seal(sessionId: string, reason: string, now: number): AgentSession | null {
		const changes = this.db
			.prepare(
				"UPDATE agent_sessions SET status = 'sealed', seal_reason = ?, sealed_at = ?, updated_at = ? WHERE id = ? AND status = 'active'",
			)
			.run(reason, now, now, sessionId).changes;
		return changes > 0 ? this.get(sessionId) : this.get(sessionId);
	}

	recordResumeFailure(sessionId: string): AgentSession | null {
		this.db
			.prepare(
				"UPDATE agent_sessions SET consecutive_resume_failures = consecutive_resume_failures + 1, updated_at = ? WHERE id = ?",
			)
			.run(Date.now(), sessionId);
		return this.get(sessionId);
	}

	/**
	 * messageCount semantics (0010 §6.1): first visible output 0→1; a done
	 * turn with NO visible output also +1; a turn that already counted its
	 * visible output does not double-count.
	 */
	/**
	 * 0010 §6.1 messageCount with durable dedup: each turn counts exactly
	 * once — visible output or done; last_counted_turn_execution_id blocks
	 * crash-replay double counts.
	 */
	recordUserVisibleOutput(sessionId: string, turnExecutionId: string): AgentSession | null {
		const current = this.get(sessionId);
		if (!current) return null;
		if (current.lastCountedTurnExecutionId === turnExecutionId) return current;
		this.db
			.prepare(
				"UPDATE agent_sessions SET message_count = message_count + 1, last_counted_turn_execution_id = ?, updated_at = ? WHERE id = ?",
			)
			.run(turnExecutionId, Date.now(), sessionId);
		return this.get(sessionId);
	}

	recordCompletedTurn(sessionId: string, turnExecutionId: string): AgentSession | null {
		return this.recordUserVisibleOutput(sessionId, turnExecutionId);
	}

	/** 0010 §6: 3 consecutive resume failures → circuit-breaker seal. */
	recordResumeFailureWithSeal(sessionId: string, reason: string, now: number): AgentSession | null {
		const current = this.get(sessionId);
		if (!current) return null;
		const failures = current.consecutiveResumeFailures + 1;
		if (failures >= 3) return this.seal(sessionId, reason || "circuit_breaker", now);
		this.db
			.prepare("UPDATE agent_sessions SET consecutive_resume_failures = ?, updated_at = ? WHERE id = ?")
			.run(failures, now, sessionId);
		return this.get(sessionId);
	}

	resetResumeFailures(sessionId: string, now: number): AgentSession | null {
		this.db
			.prepare("UPDATE agent_sessions SET consecutive_resume_failures = 0, updated_at = ? WHERE id = ?")
			.run(now, sessionId);
		return this.get(sessionId);
	}
}
