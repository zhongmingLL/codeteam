import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MessageStore } from "../src/domains/message/store.ts";
import { ThreadStore } from "../src/domains/thread/store.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";

const dirs: string[] = [];

function makeStores(): { db: F018Database; threads: ThreadStore; messages: MessageStore } {
	const dir = mkdtempSync(join(tmpdir(), "f022-read-state-"));
	dirs.push(dir);
	const db = new F018Database({ path: join(dir, "f018.db") });
	return { db, threads: new ThreadStore(db.db), messages: new MessageStore(db.db) };
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("F022 thread read state", () => {
	it("derives unread from agent/system messages and keeps the cursor monotonic", () => {
		const { db, threads, messages } = makeStores();
		const now = 1_000;
		const thread = threads.create({
			id: "thread:1",
			projectPath: "/tmp/project",
			createdBy: "operator:1",
			now,
		});
		const user = messages.append({
			id: "msg:user",
			threadId: thread.id,
			from: { kind: "user", userId: "operator:1" },
			content: "hello",
			now: now + 1,
		});
		const agent = messages.append({
			id: "msg:agent",
			threadId: thread.id,
			from: { kind: "agent", agentId: "a1" },
			content: "reply",
			now: now + 2,
		});
		const system = messages.append({
			id: "msg:system",
			threadId: thread.id,
			from: { kind: "system", service: "worker" },
			content: "failed",
			now: now + 3,
		});

		const listed = threads.listWithReadState({ createdBy: "operator:1" });
		expect(listed).toHaveLength(1);
		expect(listed[0]?.thread.id).toBe(thread.id);
		expect(listed[0]?.lastReadSeq).toBe(0);
		expect(listed[0]?.unreadCount).toBe(2);
		expect(threads.unreadCount("operator:1", thread.id)).toBe(2);

		expect(threads.markRead("operator:1", thread.id, agent.seq, now + 4).lastReadSeq).toBe(agent.seq);
		expect(threads.unreadCount("operator:1", thread.id)).toBe(1);
		expect(threads.markRead("operator:1", thread.id, user.seq, now + 5).lastReadSeq).toBe(agent.seq);
		expect(threads.unreadCount("operator:1", thread.id)).toBe(1);
		expect(threads.markRead("operator:1", thread.id, system.seq, now + 6).lastReadSeq).toBe(system.seq);
		expect(threads.unreadCount("operator:1", thread.id)).toBe(0);

		// Per-user cursors are isolated.
		expect(threads.unreadCount("operator:2", thread.id)).toBe(2);
		db.close();
	});

	it("does not count the operator's own or soft-deleted messages", () => {
		const { db, threads, messages } = makeStores();
		const now = 2_000;
		const thread = threads.create({
			id: "thread:1",
			projectPath: "/tmp/project",
			createdBy: "operator:1",
			now,
		});
		const deleted = messages.append({
			id: "msg:deleted",
			threadId: thread.id,
			from: { kind: "agent", agentId: "a1" },
			content: "deleted",
			now: now + 1,
		});
		messages.softDelete(deleted.id, "operator:1", now + 2);
		messages.append({
			id: "msg:user",
			threadId: thread.id,
			from: { kind: "user", userId: "operator:1" },
			content: "mine",
			now: now + 3,
		});
		expect(threads.unreadCount("operator:1", thread.id)).toBe(0);

		messages.append({
			id: "msg:agent",
			threadId: thread.id,
			from: { kind: "agent", agentId: "a1" },
			content: "new reply",
			now: now + 4,
		});
		expect(threads.unreadCount("operator:1", thread.id)).toBe(1);
		db.close();
	});
});
