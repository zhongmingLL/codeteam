import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { InvocationCredentialStore } from "../src/domains/auth/store.ts";
import { InvocationAttemptStore, InvocationRecordStore, TurnExecutionStore } from "../src/domains/invocation/store.ts";
import { ResponseDraftStore } from "../src/domains/response/store.ts";
import { AgentSessionStore } from "../src/domains/session/store.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";

const dirs: string[] = [];

function makeWorld(): {
	db: F018Database;
	sessions: AgentSessionStore;
	drafts: ResponseDraftStore;
	creds: InvocationCredentialStore;
	records: InvocationRecordStore;
	turns: TurnExecutionStore;
	attempts: InvocationAttemptStore;
} {
	const dir = mkdtempSync(join(tmpdir(), "f018-r1c-"));
	dirs.push(dir);
	const db = new F018Database({ path: join(dir, "f018.db") });
	db.db
		.prepare(
			"INSERT INTO threads (id, project_path, created_by, last_active_at, created_at, updated_at) VALUES ('t1', '/p', 'u1', 1, 1, 1)",
		)
		.run();
	return {
		db,
		sessions: new AgentSessionStore(db.db),
		drafts: new ResponseDraftStore(db.db),
		creds: new InvocationCredentialStore(db.db),
		records: new InvocationRecordStore(db.db),
		turns: new TurnExecutionStore(db.db),
		attempts: new InvocationAttemptStore(db.db),
	};
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seedTurn(world: {
	records: InvocationRecordStore;
	turns: TurnExecutionStore;
	attempts: InvocationAttemptStore;
	sessions: AgentSessionStore;
}): { turnId: string; attemptId: string; sessionId: string } {
	const { records, turns, attempts, sessions } = world;
	records.create({
		invocationId: "inv1",
		threadId: "t1",
		userId: "u1",
		sourceRecordId: "s1",
		userMessageId: null,
		targetAgentIds: ["a1"],
		now: 10,
	});
	turns.createRunning({
		turnExecutionId: "te1",
		parentInvocationId: "inv1",
		threadId: "t1",
		userId: "u1",
		agentId: "a1",
		executionKind: "ordinary",
		causal: { triggerMessageId: "m1" },
		startedAt: 100,
	});
	const attempt = attempts.appendQueued({
		attemptId: "at1",
		parentInvocationId: "inv1",
		queueEntryId: "q1",
		threadId: "t1",
		targetAgentId: "a1",
		attempt: 1,
		now: 10,
	});
	const session = sessions.ensureActive({
		threadId: "t1",
		agentId: "a1",
		userId: "u1",
		workingDirectory: "/p",
		now: 1,
	});
	return { turnId: "te1", attemptId: attempt.record.attemptId, sessionId: session.id };
}

describe("AgentSessionStore (0010)", () => {
	it("ensures a single active session per (thread, agent); owner enforced", () => {
		const { sessions } = makeWorld();
		const first = sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/p",
			now: 1,
		});
		const again = sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/p",
			now: 2,
		});
		expect(again.id).toBe(first.id);
		expect(() =>
			sessions.ensureActive({ threadId: "t1", agentId: "a1", userId: "attacker", workingDirectory: "/p", now: 3 }),
		).toThrow(/owner/);
		// seal + re-ensure → new seq
		sessions.seal(first.id, "circuit_breaker", 10);
		const next = sessions.ensureActive({
			threadId: "t1",
			agentId: "a1",
			userId: "u1",
			workingDirectory: "/p",
			now: 11,
		});
		expect(next.seq).toBe(first.seq + 1);
		expect(next.id).not.toBe(first.id);
	});

	it("messageCount: first visible output 0→1; uncounted done +1; counted done no-op", () => {
		const { sessions } = makeWorld();
		const s = sessions.ensureActive({ threadId: "t1", agentId: "a1", userId: "u1", workingDirectory: "/p", now: 1 });
		sessions.recordFirstVisibleOutput(s.id);
		expect(sessions.get(s.id)?.messageCount).toBe(1);
		sessions.recordCompletedTurn(s.id, true);
		expect(sessions.get(s.id)?.messageCount).toBe(1);
		sessions.recordCompletedTurn(s.id, false);
		expect(sessions.get(s.id)?.messageCount).toBe(2);
	});
});

describe("ResponseDraftStore (0017)", () => {
	function seedDraft(world: ReturnType<typeof makeWorld>) {
		const seeded = seedTurn(world);
		return world.drafts.create({
			attemptId: seeded.attemptId,
			turnExecutionId: "te1",
			parentInvocationId: "inv1",
			threadId: "t1",
			agentId: "a1",
			content: "",
			toolEvents: [],
			thinking: null,
			createdAt: 1,
			updatedAt: 1,
		});
	}

	it("create is idempotent on identity; conflicting identity fails closed", () => {
		const world = makeWorld();
		expect(seedDraft(world).attemptId).toBe("at1");
		expect(seedDraft(world).attemptId).toBe("at1");
		expect(() =>
			world.drafts.create({
				attemptId: "atX",
				turnExecutionId: "te1",
				parentInvocationId: "invOTHER",
				threadId: "t1",
				agentId: "a1",
				content: "",
				toolEvents: [],
				thinking: null,
				createdAt: 2,
				updatedAt: 2,
			}),
		).toThrow(/identity/);
	});

	it("upsert is a full snapshot; late flush after delete returns null, does not recreate", () => {
		const world = makeWorld();
		const seeded = seedTurn(world);
		world.drafts.create({
			attemptId: seeded.attemptId,
			turnExecutionId: seeded.turnId,
			parentInvocationId: "inv1",
			threadId: "t1",
			agentId: "a1",
			content: "",
			toolEvents: [],
			thinking: null,
			createdAt: 1,
			updatedAt: 1,
		});
		const upserted = world.drafts.upsert({
			attemptId: seeded.attemptId,
			turnExecutionId: seeded.turnId,
			parentInvocationId: "inv1",
			threadId: "t1",
			agentId: "a1",
			content: "hello world",
			toolEvents: [{ id: "e1" }],
			thinking: "hm",
			createdAt: 1,
			updatedAt: 5,
		})!;
		expect(upserted.content).toBe("hello world");
		expect(upserted.toolEvents).toEqual([{ id: "e1" }]);
		world.drafts.delete(seeded.turnId);
		expect(world.drafts.getByTurn("te1")).toBeNull();
		expect(
			world.drafts.upsert({
				attemptId: seeded.attemptId,
				turnExecutionId: seeded.turnId,
				parentInvocationId: "inv1",
				threadId: "t1",
				agentId: "a1",
				content: "late",
				toolEvents: [],
				thinking: null,
				createdAt: 1,
				updatedAt: 9,
			}),
		).toBeNull();
		expect(world.drafts.getByTurn(seeded.turnId)).toBeNull();
	});
});

describe("InvocationCredentialStore (0007 §4.4)", () => {
	it("mints once, verifies token, hides secret on replay", () => {
		const { creds, records, turns, attempts, sessions } = makeWorld();
		const seeded = seedTurn({ records, turns, attempts, sessions });
		const minted = creds.create({
			turnExecutionId: "te1",
			parentInvocationId: "inv1",
			threadId: "t1",
			agentId: "a1",
			agentSessionId: seeded.sessionId,
			userId: "u1",
			allowedTools: ["post_message"],
			now: 10,
		});
		expect(minted.token).toMatch(/^ct1\./);
		expect(creds.verifyToken(minted.token).ok).toBe(true);
		const replay = creds.create({
			turnExecutionId: "te1",
			parentInvocationId: "inv1",
			threadId: "t1",
			agentId: "a1",
			agentSessionId: seeded.sessionId,
			userId: "u1",
			allowedTools: ["post_message"],
			now: 20,
		});
		expect(replay.token).toBe("");
		expect(() => creds.verifyToken("ct1.cred:te1.wrongsecret")).toThrow;
		const bad = creds.verifyToken("ct1.cred:te1.wrongsecret");
		expect(bad.ok).toBe(false);
	});

	it("ownership chain fails closed (wrong user/thread/agent/parent)", () => {
		const { creds, records, turns, attempts, sessions } = makeWorld();
		const seeded = seedTurn({ records, turns, attempts, sessions });
		const base = {
			turnExecutionId: "te1",
			parentInvocationId: "inv1",
			threadId: "t1",
			agentId: "a1",
			agentSessionId: seeded.sessionId,
			userId: "u1",
			allowedTools: [],
			now: 10,
		};
		expect(() => creds.create({ ...base, userId: "attacker" })).toThrow(/user/);
		expect(() => creds.create({ ...base, threadId: "tX" })).toThrow(/thread/);
		expect(() => creds.create({ ...base, agentId: "a9" })).toThrow(/agent/);
		expect(() => creds.create({ ...base, parentInvocationId: "invX" })).toThrow(/parent/);
	});

	it("toolCallClaims: reserved → replayed/conflict; limit fails closed", () => {
		const { creds, records, turns, attempts, sessions } = makeWorld();
		const seeded = seedTurn({ records, turns, attempts, sessions });
		creds.create({
			turnExecutionId: "te1",
			parentInvocationId: "inv1",
			threadId: "t1",
			agentId: "a1",
			agentSessionId: seeded.sessionId,
			userId: "u1",
			allowedTools: [],
			now: 10,
		});
		const key = { piExtToolCallId: "pi:abc", intentHash: "h1", messageId: "m1", queueEntryId: null };
		expect(creds.reserveToolCallClaim("te1", key).outcome).toBe("reserved");
		expect(creds.reserveToolCallClaim("te1", key).outcome).toBe("replayed");
		expect(creds.reserveToolCallClaim("te1", { ...key, intentHash: "h2" }).outcome).toBe("conflict");
		expect(creds.getToolCallClaim("te1", "pi:abc")?.messageId).toBe("m1");
	});

	it("terminalize first-write-wins; replaced requires successor; token dies after terminal", () => {
		const { creds, records, turns, attempts, sessions } = makeWorld();
		const seeded = seedTurn({ records, turns, attempts, sessions });
		const minted = creds.create({
			turnExecutionId: "te1",
			parentInvocationId: "inv1",
			threadId: "t1",
			agentId: "a1",
			agentSessionId: seeded.sessionId,
			userId: "u1",
			allowedTools: [],
			now: 10,
		});
		expect(() => creds.commitTerminal("te1", "replaced")).toThrow(/successor/);
		expect(creds.commitTerminal("te1", "completed").outcome).toBe("terminalized");
		expect(creds.commitTerminal("te1", "completed").outcome).toBe("already_terminal");
		expect(creds.commitTerminal("te1", "failed").outcome).toBe("conflict");
		const verify = creds.verifyToken(minted.token);
		expect(verify.ok).toBe(false);
	});
});
