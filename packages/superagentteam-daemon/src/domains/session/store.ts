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

	/** Lightweight seal (0010 §6): active → sealed only; next active gets seq+1. */
	sealActive(sessionId: string, reason: string, now: number): AgentSession | null {
		const changes = this.db
			.prepare(
				"UPDATE agent_sessions SET status = 'sealed', seal_reason = ?, sealed_at = ?, updated_at = ? WHERE id = ? AND status = 'active'",
			)
			.run(reason, now, now, sessionId).changes;
		return changes > 0 ? this.get(sessionId) : this.get(sessionId);
	}

	/**
	 * 0010 §6: first pi binding. Both values must be non-null; replaying the
	 * same pair is a no-op; a different pair on a bound session is
	 * `invalid_input` (must go through replacePiSession).
	 */
	bindPiSession(
		sessionId: string,
		input: { piSessionId: string | null; piSessionFile: string | null; now: number },
	): AgentSession {
		const current = this.get(sessionId);
		if (!current) throw new Error("session_not_found");
		if (current.status !== "active") throw new Error("session_not_active");
		if (!input.piSessionId || !input.piSessionFile) throw new Error("invalid_input");
		if (current.piSessionId === null && current.piSessionFile === null) {
			this.db
				.prepare("UPDATE agent_sessions SET pi_session_id = ?, pi_session_file = ?, updated_at = ? WHERE id = ?")
				.run(input.piSessionId, input.piSessionFile, input.now, sessionId);
			return this.get(sessionId)!;
		}
		if (current.piSessionId === input.piSessionId && current.piSessionFile === input.piSessionFile) {
			return current;
		}
		throw new Error("invalid_input");
	}

	/**
	 * 0010 §6: resume-failure / reset path only. Both null (clear, pre-fresh)
	 * or both non-null (rebind after fresh — current binding must already be
	 * null); anything else is `invalid_input`.
	 */
	replacePiSession(
		sessionId: string,
		input: { piSessionId: string | null; piSessionFile: string | null; now: number },
	): AgentSession {
		const current = this.get(sessionId);
		if (!current) throw new Error("session_not_found");
		if (current.status !== "active") throw new Error("session_not_active");
		const bothNull = input.piSessionId === null && input.piSessionFile === null;
		const bothSet = input.piSessionId !== null && input.piSessionFile !== null;
		if (!bothNull && !bothSet) throw new Error("invalid_input");
		if (bothSet && current.piSessionId !== null) throw new Error("invalid_input");
		this.db
			.prepare("UPDATE agent_sessions SET pi_session_id = ?, pi_session_file = ?, updated_at = ? WHERE id = ?")
			.run(input.piSessionId, input.piSessionFile, input.now, sessionId);
		return this.get(sessionId)!;
	}

	/**
	 * 0010 §6: post-seal next active row (seq = MAX+1, null pi binding).
	 * Caller (AgentSessionManager.reset) seals the old active in the same
	 * transaction first; a live active row here is a typed conflict.
	 */
	createNextActive(input: EnsureSessionInput): AgentSession {
		const thread = this.db.prepare("SELECT created_by, project_path FROM threads WHERE id = ?").get(input.threadId) as
			| { created_by: string; project_path: string }
			| undefined;
		if (!thread) throw new Error("session_thread_not_found");
		if (thread.created_by !== input.userId) throw new Error("session_user_not_thread_owner");
		if (input.workingDirectory !== thread.project_path) {
			throw new Error("session_workspace_not_thread_project");
		}
		if (this.getActive(input.threadId, input.agentId)) {
			throw new Error("session_active_exists");
		}
		const predecessor = this.db
			.prepare("SELECT status FROM agent_sessions WHERE thread_id = ? AND agent_id = ? ORDER BY seq DESC LIMIT 1")
			.get(input.threadId, input.agentId) as { status: string } | undefined;
		if (!predecessor || predecessor.status !== "sealed") {
			throw new Error("session_no_sealed_predecessor");
		}
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

	recordResumeFailure(sessionId: string, now = Date.now()): { session: AgentSession | null; failures: number } {
		this.db
			.prepare(
				"UPDATE agent_sessions SET consecutive_resume_failures = consecutive_resume_failures + 1, updated_at = ? WHERE id = ?",
			)
			.run(now, sessionId);
		const session = this.get(sessionId);
		return { session, failures: session?.consecutiveResumeFailures ?? 0 };
	}

	/**
	 * 0010 §6: first user-visible output does the 0→1 unseal-safety count and
	 * marks the turn; with messageCount ≥ 1 the per-turn counting is owned by
	 * recordCompletedTurn — output time never increments past the first one.
	 */
	recordUserVisibleOutput(sessionId: string, turnExecutionId: string, now = Date.now()): AgentSession | null {
		const current = this.get(sessionId);
		if (!current) return null;
		if (current.messageCount === 0 && current.lastCountedTurnExecutionId !== turnExecutionId) {
			this.db
				.prepare(
					"UPDATE agent_sessions SET message_count = 1, last_counted_turn_execution_id = ?, updated_at = ? WHERE id = ?",
				)
				.run(turnExecutionId, now, sessionId);
			return this.get(sessionId);
		}
		return current;
	}

	/**
	 * 0010 §6: a completed turn counts +1 when this turn was not counted yet
	 * (with or without visible output), deduped via
	 * last_counted_turn_execution_id, and resets the resume-failure breaker.
	 * `userVisibleOutput` is kept in the signature for 0010 §6 contract
	 * fidelity / caller telemetry; counting does NOT branch on it — every
	 * completed turn counts exactly once regardless of visibility (the
	 * 0→1 first-visible case is recordUserVisibleOutput's job).
	 */
	recordCompletedTurn(
		sessionId: string,
		input: { turnExecutionId: string; userVisibleOutput: boolean; now: number },
	): AgentSession | null {
		const current = this.get(sessionId);
		if (!current) return null;
		if (current.lastCountedTurnExecutionId !== input.turnExecutionId) {
			this.db
				.prepare(
					"UPDATE agent_sessions SET message_count = message_count + 1, last_counted_turn_execution_id = ?, updated_at = ? WHERE id = ?",
				)
				.run(input.turnExecutionId, input.now, sessionId);
		}
		this.db
			.prepare(
				"UPDATE agent_sessions SET consecutive_resume_failures = 0, updated_at = ? WHERE id = ? AND consecutive_resume_failures <> 0",
			)
			.run(input.now, sessionId);
		return this.get(sessionId);
	}

	/** 0010 §6: 3 consecutive resume failures → circuit-breaker seal. */
	recordResumeFailureWithSeal(sessionId: string, reason: string, now: number): AgentSession | null {
		const { session: current, failures } = this.recordResumeFailure(sessionId, now);
		if (!current) return null;
		if (failures >= 3) return this.sealActive(sessionId, reason || "circuit_breaker", now);
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
