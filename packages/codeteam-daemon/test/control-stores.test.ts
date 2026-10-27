import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdmitQueueEntryInput } from "../src/control/stores/types.ts";
import { ControlError, type ControlStore, openControlStore } from "../src/index.ts";

const NOW = 1_700_000_000_000;

const dirs: string[] = [];
let now: number;
let store: ControlStore;

function createProfile(id = "profile-coder") {
	return store.profiles.create({
		id,
		role: "coder",
		displayName: "Coder",
		provider: "test",
		model: "model",
		modelFamily: "family",
		toolPolicyProfile: "default",
		clowderCatId: "cat-1",
	});
}

function createThread(id = "thread-1") {
	return store.threads.create({ id, title: "Thread" });
}

function admit(sourceId: string, overrides: Partial<AdmitQueueEntryInput> = {}) {
	return store.queue.admit({
		threadId: "thread-1",
		sourceId,
		sourceKind: "conversation_input",
		targets: ["profile-1"],
		sourceCategory: "a2a",
		orderKey: "1",
		...overrides,
	});
}

beforeEach(() => {
	const dataDir = mkdtempSync(join(tmpdir(), "codeteam-store-"));
	dirs.push(dataDir);
	now = NOW;
	store = openControlStore({ dataDir, clock: () => now });
	store.seedIdentity({
		eval: { provider: "test", model: "eval-model", modelFamily: "test-family" },
		compress: { provider: "test", model: "compress-model", modelFamily: "test-family" },
	});
});

afterEach(() => {
	store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codeteam control stores", () => {
	it("seeds built-in roles and configurable eval/compress profiles idempotently", () => {
		expect(store.roles.list().map((role) => role.id)).toEqual(
			expect.arrayContaining(["architect", "coder", "reviewer", "verifier", "eval", "compress"]),
		);
		expect(store.profiles.get("profile:eval")).toMatchObject({
			role: "eval",
			model: "eval-model",
			status: "active",
		});
		expect(store.profiles.get("profile:compress")).toMatchObject({
			role: "compress",
			model: "compress-model",
			status: "active",
		});
		store.seedIdentity({
			eval: { provider: "test", model: "eval-model-2", modelFamily: "test-family" },
			compress: { provider: "test", model: "compress-model-2", modelFamily: "test-family" },
		});
		expect(store.profiles.list({ role: "eval" })).toHaveLength(1);
		expect(store.profiles.get("profile:eval")?.model).toBe("eval-model");
	});

	it("allows multiple profiles per role and treats clowder_cat_id as provenance only", () => {
		createProfile("coder-a");
		createProfile("coder-b");
		expect(store.profiles.list({ role: "coder" })).toHaveLength(2);
		expect(() =>
			store.profiles.create({
				id: "bad-role",
				role: "missing",
				displayName: "Bad",
				provider: "test",
				model: "model",
				modelFamily: "family",
				toolPolicyProfile: "default",
			}),
		).toThrow(ControlError);
	});

	it("seals a session while keeping the cat handoff note separate from the continuity capsule", () => {
		const profile = createProfile();
		const thread = createThread();
		const session = store.sessions.create({
			id: "session-1",
			threadId: thread.id,
			profileId: profile.id,
			role: "reviewer",
			effectiveToolPolicy: "default",
			provider: "test",
			model: "model",
			modelFamily: "family",
			seq: 0,
		});
		expect(session.status).toBe("active");
		expect(session.role).toBe("reviewer");
		now += 1000;
		const sealed = store.sessions.seal("session-1", {
			sealReason: "threshold",
			catHandoffNote: { done: "x", nextSteps: "y" },
			continuityCapsule: { goal: "z" },
		});
		expect(sealed.status).toBe("sealed");
		expect(sealed.sealedAt).toBe(now);
		expect(sealed.catHandoffNote).toEqual({ done: "x", nextSteps: "y" });
		expect(sealed.continuityCapsule).toEqual({ goal: "z" });
		expect((sealed.continuityCapsule as Record<string, unknown>).done).toBeUndefined();
		expect(() => store.sessions.seal("session-1", { sealReason: "manual" })).toThrow(ControlError);
	});

	it("updates thread status with CAS and links a backlog item", () => {
		const thread = createThread();
		now += 1000;
		expect(store.threads.setStatus(thread.id, "archived", { expectedUpdatedAt: NOW }).status).toBe("archived");
		expect(() => store.threads.setStatus(thread.id, "active", { expectedUpdatedAt: NOW })).toThrow(ControlError);
		store.database
			.prepare(
				"INSERT INTO backlog_items (id, user_id, title, summary, priority, tags_json, status, created_by_kind, created_by_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run("backlog-1", "user-1", "Backlog", "Summary", "p1", "[]", "open", "user", "user-1", NOW, NOW);
		const linked = store.threads.linkBacklogItem(thread.id, { backlogItemId: "backlog-1", phase: "coding" });
		expect(linked.backlogItemId).toBe("backlog-1");
		expect(linked.phase).toBe("coding");
		expect(() => store.threads.linkBacklogItem(thread.id, { backlogItemId: "missing", phase: "coding" })).toThrow(
			ControlError,
		);
	});

	it("allocates thread-scoped message seq and honors expectedSeq", () => {
		createThread("thread-1");
		createThread("thread-2");
		const first = store.messages.append({
			threadId: "thread-1",
			authorKind: "user",
			authorId: "user-1",
			kind: "chat",
			bodyMd: "one",
		});
		const second = store.messages.append({
			threadId: "thread-1",
			authorKind: "agent",
			authorId: "profile-1",
			kind: "agent_response",
			bodyMd: "two",
		});
		const other = store.messages.append({
			threadId: "thread-2",
			authorKind: "user",
			authorId: "user-1",
			kind: "chat",
			bodyMd: "other",
		});
		expect([first.seq, second.seq, other.seq]).toEqual([1, 2, 1]);
		expect(store.messages.latestSeq("thread-1")).toBe(2);
		expect(() =>
			store.messages.append({
				threadId: "thread-1",
				authorKind: "user",
				authorId: "user-1",
				kind: "chat",
				expectedSeq: 4,
			}),
		).toThrow(ControlError);
		const third = store.messages.append({
			threadId: "thread-1",
			authorKind: "user",
			authorId: "user-1",
			kind: "chat",
			expectedSeq: 3,
		});
		expect(third.seq).toBe(3);
		expect(store.messages.listThread("thread-1", { limit: 2 }).map((message) => message.seq)).toEqual([2, 3]);
	});

	it("rejects cross-thread replies and approval rich blocks", () => {
		createThread("thread-1");
		createThread("thread-2");
		const parent = store.messages.append({
			threadId: "thread-1",
			authorKind: "user",
			authorId: "user-1",
			kind: "chat",
		});
		expect(() =>
			store.messages.append({
				threadId: "thread-2",
				authorKind: "user",
				authorId: "user-1",
				kind: "chat",
				replyTo: parent.id,
			}),
		).toThrow(ControlError);
		expect(() =>
			store.messages.append({
				threadId: "thread-1",
				authorKind: "agent",
				authorId: "profile-1",
				kind: "chat",
				richBlocks: [{ kind: "approval" }],
			}),
		).toThrow(ControlError);
		const reply = store.messages.append({
			threadId: "thread-1",
			authorKind: "agent",
			authorId: "profile-1",
			kind: "chat",
			replyTo: parent.id,
		});
		expect(reply.replyTo).toBe(parent.id);
	});

	it("keeps control_ref daemon-owned and appends dispatch refs transactionally", () => {
		createThread();
		const message = store.messages.append({
			threadId: "thread-1",
			authorKind: "user",
			authorId: "user-1",
			kind: "chat",
		});
		now += 1000;
		expect(store.messages.setControlRef(message.id, "handoff-1").controlRef).toBe("handoff-1");
		const withRef = store.messages.appendDispatchRef(message.id, {
			targetId: "profile-1",
			phase: "dispatched",
			statusMessageId: "message-2",
		});
		expect(withRef.dispatchRefs).toHaveLength(1);
		expect(() => store.messages.setControlRef(message.id, "handoff-2", { expectedUpdatedAt: NOW })).toThrow(
			ControlError,
		);
		const before = store.messages.latestSeq("thread-1");
		expect(() =>
			store.transaction.run(() => {
				store.messages.append({
					threadId: "thread-1",
					authorKind: "user",
					authorId: "user-1",
					kind: "chat",
				});
				throw new Error("rollback");
			}),
		).toThrow("rollback");
		expect(store.messages.latestSeq("thread-1")).toBe(before);
	});

	it("admits one idempotent queue entry per source with multiple targets in one row", () => {
		createThread();
		const entry = admit("message-1", { targets: ["profile-1", "profile-2"], priority: "urgent" });
		expect(entry.id).toBe("queue:message-1");
		expect(entry.targets).toEqual(["profile-1", "profile-2"]);
		const again = admit("message-1", { targets: ["profile-3"] });
		expect(again.id).toBe(entry.id);
		expect(again.targets).toEqual(["profile-1", "profile-2"]);
		expect(store.queue.listPending()).toHaveLength(1);
	});

	it("claims, releases, and completes a queue entry without a second ledger", () => {
		createThread();
		const entry = admit("message-1");
		now += 1000;
		const claimed = store.queue.claim(entry.id, { claimId: "claim-1", ttlMs: 1000 });
		expect(claimed.status).toBe("claimed");
		expect(claimed.claimId).toBe("claim-1");
		expect(claimed.claimExpiresAt).toBe(now + 1000);
		expect(claimed.revision).toBe(1);
		expect(() => store.queue.claim(entry.id, { claimId: "claim-2" })).toThrow(ControlError);
		const released = store.queue.release(entry.id, "claim-1");
		expect(released.status).toBe("queued");
		expect(released.claimId).toBeNull();
		const next = store.queue.claimNext({ claimId: "claim-2" });
		expect(next?.id).toBe(entry.id);
		store.queue.complete(entry.id, "claim-2");
		expect(store.queue.get(entry.id)).toBeNull();
		expect(store.queue.listPending()).toHaveLength(0);
		expect(() => store.queue.complete("missing", "claim-3")).toThrow(ControlError);
	});

	it("claims urgent queue entries first", () => {
		createThread();
		admit("normal-source", { orderKey: "1", priority: "normal" });
		admit("urgent-source", { orderKey: "2", priority: "urgent" });
		const next = store.queue.claimNext({ claimId: "claim-1" });
		expect(next?.sourceId).toBe("urgent-source");
	});
});
