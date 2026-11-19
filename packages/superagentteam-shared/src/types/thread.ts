// F018 v1 shared contract types — Thread model (0009).
// Dual-generation rule: defined fresh from the F018 architecture docs; must
// not import/extend/alias legacy task-first types (see types/index.ts header).

export type ThreadTitleSource = "user" | "agent" | "system";

/** 0009 §1: user-owned conversation aggregate; v1 has no archive state. */
export interface Thread {
	id: string;
	/** Required; worker cwd root. Empty is a typed reject at ingress, not here. */
	projectPath: string;
	title: string | null;
	titleSource?: ThreadTitleSource;
	/** Ownership root; the only userId anchor for thread scope (0011 §11). */
	createdBy: string;
	/** Resolved from thread_participants; routing/context, not ACL. */
	participants: string[];
	lastActiveAt: number;
	createdAt: number;
	updatedAt: number;
	/** Soft delete only (0009 §2.1); null = active. */
	deletedAt?: number | null;
}

/** Row shape for the thread_participants table (join order preserved). */
export interface ThreadParticipant {
	threadId: string;
	agentId: string;
	joinedAt: number;
}

/** 0007 §4.5: per (thread, agent) delivery cursor. */
export interface AgentReadState {
	threadId: string;
	agentId: string;
	/** Thread-global messages.seq the agent has consumed up to. */
	deliveryCursor: number;
	updatedAt: number;
}
