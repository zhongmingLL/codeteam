import { createHash, randomBytes } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";

import type { InvocationCredential, ToolCallClaim } from "@superagentteam/shared/types";

// F018 R1-c InvocationCredentialStore (0007 §3.7/§4.4): child TurnExecution
// capability with toolCallClaims replay map. Token material never persists —
// only hash+salt; the caller (registry service) returns the secret once.

interface CredentialRow {
	credential_id: string;
	token_hash: string;
	token_salt: string;
	turn_execution_id: string;
	parent_invocation_id: string;
	thread_id: string;
	agent_id: string;
	agent_session_id: string;
	user_id: string;
	allowed_tools_json: string;
	tool_call_claims_json: string;
	state: "active" | "terminal";
	disposition: InvocationCredential["disposition"];
	replaced_by_turn_execution_id: string | null;
	expires_at: number | null;
	created_at: number;
	updated_at: number;
}

function mapCredential(row: CredentialRow): InvocationCredential {
	return {
		credentialId: row.credential_id,
		turnExecutionId: row.turn_execution_id,
		parentInvocationId: row.parent_invocation_id,
		threadId: row.thread_id,
		agentId: row.agent_id,
		agentSessionId: row.agent_session_id,
		userId: row.user_id,
		allowedTools: JSON.parse(row.allowed_tools_json) as string[],
		toolCallClaims: JSON.parse(row.tool_call_claims_json) as Record<string, ToolCallClaim>,
		state: row.state,
		disposition: row.disposition,
		replacedByTurnExecutionId: row.replaced_by_turn_execution_id,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function hashSecret(salt: string, secret: string): string {
	return createHash("sha256").update(`${salt}:${secret}`).digest("hex");
}

export interface CreateCredentialInput {
	turnExecutionId: string;
	parentInvocationId: string;
	threadId: string;
	agentId: string;
	agentSessionId: string;
	userId: string;
	allowedTools: string[];
	now: number;
}

export interface MintedCredential {
	credential: InvocationCredential;
	/** Token body; only place it exists in the clear. */
	token: string;
}

export const TOOL_CALL_CLAIMS_LIMIT = 1000;

export class InvocationCredentialStore {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/** One credential per child TurnExecution; replay returns the stored row. */
	create(input: CreateCredentialInput): MintedCredential {
		// Ownership (0011 §11): user/thread/session chain must match the child turn.
		const turn = this.db
			.prepare(
				"SELECT thread_id, user_id, agent_id, parent_invocation_id FROM turn_executions WHERE turn_execution_id = ?",
			)
			.get(input.turnExecutionId) as
			| { thread_id: string; user_id: string; agent_id: string; parent_invocation_id: string }
			| undefined;
		if (!turn) throw new Error("credential_turn_not_found");
		if (turn.thread_id !== input.threadId) throw new Error("credential_thread_mismatch");
		if (turn.user_id !== input.userId) throw new Error("credential_user_mismatch");
		if (turn.agent_id !== input.agentId) throw new Error("credential_agent_mismatch");
		if (turn.parent_invocation_id !== input.parentInvocationId) throw new Error("credential_parent_mismatch");
		const existing = this.db
			.prepare("SELECT * FROM invocation_credentials WHERE turn_execution_id = ?")
			.get(input.turnExecutionId) as CredentialRow | undefined;
		if (existing) {
			// Deterministic re-creation returns the stored credential; the secret
			// cannot be re-derived (hash-only), so callers must treat replay as
			// "already minted" and not re-issue the token.
			return { credential: mapCredential(existing), token: "" };
		}
		const credentialId = `cred:${input.turnExecutionId}`;
		const salt = randomBytes(16).toString("hex");
		const secret = randomBytes(32).toString("base64url");
		const token = `ct1.${credentialId}.${secret}`;
		this.db
			.prepare(
				`INSERT INTO invocation_credentials (credential_id, token_hash, token_salt, turn_execution_id, parent_invocation_id, thread_id, agent_id, agent_session_id, user_id, allowed_tools_json, tool_call_claims_json, state, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'active', ?, ?)`,
			)
			.run(
				credentialId,
				hashSecret(salt, secret),
				salt,
				input.turnExecutionId,
				input.parentInvocationId,
				input.threadId,
				input.agentId,
				input.agentSessionId,
				input.userId,
				JSON.stringify(input.allowedTools),
				input.now,
				input.now,
			);
		return { credential: this.getByTurn(input.turnExecutionId)!, token };
	}

	getByTurn(turnExecutionId: string): InvocationCredential | null {
		const row = this.db
			.prepare("SELECT * FROM invocation_credentials WHERE turn_execution_id = ?")
			.get(turnExecutionId) as CredentialRow | undefined;
		return row ? mapCredential(row) : null;
	}

	get(credentialId: string): InvocationCredential | null {
		const row = this.db.prepare("SELECT * FROM invocation_credentials WHERE credential_id = ?").get(credentialId) as
			| CredentialRow
			| undefined;
		return row ? mapCredential(row) : null;
	}

	/** Token verification: hash match + active + not expired. */
	verifyToken(token: string): { ok: true; credential: InvocationCredential } | { ok: false; reason: string } {
		const parts = token.split(".");
		if (parts.length !== 3 || parts[0] !== "ct1") return { ok: false, reason: "token_format" };
		const credentialId = parts[1]!;
		const secret = parts[2]!;
		const row = this.db.prepare("SELECT * FROM invocation_credentials WHERE credential_id = ?").get(credentialId) as
			| CredentialRow
			| undefined;
		if (!row) return { ok: false, reason: "credential_not_found" };
		if (row.token_hash !== hashSecret(row.token_salt, secret)) return { ok: false, reason: "token_hash" };
		if (row.state !== "active") return { ok: false, reason: "credential_terminal" };
		if (row.expires_at !== null && row.expires_at <= Date.now()) return { ok: false, reason: "credential_expired" };
		return { ok: true, credential: mapCredential(row) };
	}

	getToolCallClaim(turnExecutionId: string, piExtToolCallId: string): ToolCallClaim | null {
		const row = this.db
			.prepare("SELECT tool_call_claims_json FROM invocation_credentials WHERE turn_execution_id = ?")
			.get(turnExecutionId) as { tool_call_claims_json: string } | undefined;
		if (!row) return null;
		const claims = JSON.parse(row.tool_call_claims_json) as Record<string, ToolCallClaim>;
		return claims[piExtToolCallId] ?? null;
	}

	/**
	 * Same transaction as message/queue creation: same key + same intentHash →
	 * replayed; different intentHash → conflict; map over limit → fail closed.
	 */
	reserveToolCallClaim(
		turnExecutionId: string,
		input: { piExtToolCallId: string; intentHash: string; messageId: string; queueEntryId: string | null },
	): { outcome: "reserved" | "replayed" | "conflict" } {
		const row = this.db
			.prepare("SELECT tool_call_claims_json, state FROM invocation_credentials WHERE turn_execution_id = ?")
			.get(turnExecutionId) as { tool_call_claims_json: string; state: string } | undefined;
		if (!row) throw new Error("credential_not_found");
		if (row.state !== "active") throw new Error("credential_terminal");
		const claims = JSON.parse(row.tool_call_claims_json) as Record<string, ToolCallClaim>;
		const existing = claims[input.piExtToolCallId];
		if (existing) {
			return existing.intentHash === input.intentHash ? { outcome: "replayed" } : { outcome: "conflict" };
		}
		if (Object.keys(claims).length >= TOOL_CALL_CLAIMS_LIMIT) {
			throw new Error("tool_call_claims_limit");
		}
		claims[input.piExtToolCallId] = {
			intentHash: input.intentHash,
			messageId: input.messageId,
			queueEntryId: input.queueEntryId,
		};
		this.db
			.prepare(
				"UPDATE invocation_credentials SET tool_call_claims_json = ?, updated_at = ? WHERE turn_execution_id = ?",
			)
			.run(JSON.stringify(claims), Date.now(), turnExecutionId);
		return { outcome: "reserved" };
	}

	/** Canonical-first terminalize; same disposition idempotent. */
	commitTerminal(
		turnExecutionId: string,
		disposition: Exclude<InvocationCredential["disposition"], null>,
		options: { replacedByTurnExecutionId?: string; gcDeadline?: number } = {},
	): { outcome: "terminalized" | "already_terminal" | "not_found" | "conflict" } {
		const row = this.db
			.prepare("SELECT * FROM invocation_credentials WHERE turn_execution_id = ?")
			.get(turnExecutionId) as CredentialRow | undefined;
		if (!row) return { outcome: "not_found" };
		if (row.state === "terminal") {
			return row.disposition === disposition ? { outcome: "already_terminal" } : { outcome: "conflict" };
		}
		if (disposition === "replaced" && !options.replacedByTurnExecutionId) {
			throw new Error("credential_replaced_requires_successor");
		}
		this.db
			.prepare(
				"UPDATE invocation_credentials SET state = 'terminal', disposition = ?, replaced_by_turn_execution_id = ?, expires_at = ?, updated_at = ? WHERE turn_execution_id = ? AND state = 'active'",
			)
			.run(
				disposition,
				options.replacedByTurnExecutionId ?? null,
				options.gcDeadline ?? null,
				Date.now(),
				turnExecutionId,
			);
		return { outcome: "terminalized" };
	}

	listActive(): InvocationCredential[] {
		const rows = this.db
			.prepare("SELECT * FROM invocation_credentials WHERE state = 'active'")
			.all() as unknown as CredentialRow[];
		return rows.map(mapCredential);
	}
}
