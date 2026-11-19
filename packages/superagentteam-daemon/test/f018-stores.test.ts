import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentReadStateStore, MessageStore } from "../src/domains/message/store.ts";
import { ThreadStore } from "../src/domains/thread/store.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";

const dirs: string[] = [];

function makeStores(): {
	thread: ThreadStore;
	message: MessageStore;
	read: AgentReadStateStore;
	db: F018Database;
} {
	const dir = mkdtempSync(join(tmpdir(), "f018-stores-"));
	dirs.push(dir);
	const db = new F018Database({ path: join(dir, "f018.db") });
	return {
		thread: new ThreadStore(db.db),
		message: new MessageStore(db.db),
		read: new AgentReadStateStore(db.db),
		db,
	};
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ThreadStore (0009)", () => {
	it("creates, gets, and scopes listing by owner excluding deleted", () => {
		const { thread } = makeStores();
		thread.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 100 });
		thread.create({ id: "t2", projectPath: "/q", createdBy: "u1", now: 200 });
		thread.create({ id: "t3", projectPath: "/r", createdBy: "u2", now: 300 });
		thread.softDelete("t2", 250);
		expect(thread.list({ createdBy: "u1" }).map((t) => t.id)).toEqual(["t1"]);
		expect(thread.list({ createdBy: "u1", includeDeleted: true }).map((t) => t.id)).toEqual(["t2", "t1"]);
		expect(thread.list({ createdBy: "u2" }).map((t) => t.id)).toEqual(["t3"]);
	});

	it("participants preserve join order and dedupe", () => {
		const { thread } = makeStores();
		thread.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
		thread.addParticipant("t1", "a2", 10);
		thread.addParticipant("t1", "a1", 20);
		thread.addParticipant("t1", "a2", 30);
		expect(thread.get("t1")?.participants).toEqual(["a2", "a1"]);
	});

	it("soft delete is recoverable and updates timestamps", () => {
		const { thread } = makeStores();
		thread.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 100 });
		expect(thread.softDelete("t1", 150)).toBe(true);
		expect(thread.softDelete("t1", 160)).toBe(false);
		expect(thread.get("t1")?.deletedAt).toBe(150);
		expect(thread.restore("t1", 200)).toBe(true);
		expect(thread.get("t1")?.deletedAt).toBeNull();
	});
});

describe("MessageStore (0007 §3.1)", () => {
	it("allocates thread-global seq in append order and reads ascending windows", () => {
		const { thread, message } = makeStores();
		thread.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
		for (const [i, id] of ["m1", "m2", "m3"].entries()) {
			message.append({
				id,
				threadId: "t1",
				from: { kind: "user", userId: "u1" },
				content: `body-${i}`,
				now: 10 + i,
			});
		}
		expect(message.get("m1")?.seq).toBe(1);
		expect(message.get("m2")?.seq).toBe(2);
		expect(message.getByThreadAfter("t1", 0, 10).map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
		expect(message.getByThreadAfter("t1", 1, 10).map((m) => m.id)).toEqual(["m2", "m3"]);
		expect(message.getByThreadAfter("t1", 1, 1).map((m) => m.id)).toEqual(["m2"]);
	});

	it("round-trips from/lifecycle/extra/mentionsUser JSON columns", () => {
		const { thread, message } = makeStores();
		thread.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
		message.append({
			id: "m1",
			threadId: "t1",
			from: { kind: "agent", agentId: "a1" },
			content: "hello",
			lifecycle: { kind: "input", dispatchRefs: [] },
			mentionsUser: true,
			extra: { targetAgentIds: ["a1"] },
			now: 5,
		});
		const stored = message.get("m1")!;
		expect(stored.from).toEqual({ kind: "agent", agentId: "a1" });
		expect(stored.lifecycle?.kind).toBe("input");
		expect(stored.mentionsUser).toBe(true);
		expect(stored.extra?.targetAgentIds).toEqual(["a1"]);
	});

	it("append updates threads.last_active_at but not updated_at (0009 §2.3)", () => {
		const { thread, message } = makeStores();
		thread.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 100 });
		message.append({ id: "m1", threadId: "t1", from: { kind: "user", userId: "u1" }, content: "hi", now: 500 });
		const t = thread.get("t1")!;
		expect(t.lastActiveAt).toBe(500);
		expect(t.updatedAt).toBe(100);
	});

	it("append rejects user messages from a non-owner (0011 §11)", () => {
		const { thread, message } = makeStores();
		thread.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
		expect(() =>
			message.append({ id: "mx", threadId: "t1", from: { kind: "user", userId: "u2" }, content: "x", now: 2 }),
		).toThrow(/owner/);
	});

	it("reads exclude soft-deleted messages by default; includeDeleted opts in", () => {
		const { thread, message } = makeStores();
		thread.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
		message.append({ id: "m1", threadId: "t1", from: { kind: "user", userId: "u1" }, content: "a", now: 2 });
		message.append({ id: "m2", threadId: "t1", from: { kind: "user", userId: "u1" }, content: "b", now: 3 });
		message.softDelete("m1", "u1", 4);
		expect(message.getByThreadAfter("t1", 0, 10).map((m) => m.id)).toEqual(["m2"]);
		expect(message.getByThreadAfter("t1", 0, 10, { includeDeleted: true }).map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(message.get("m1")).toBeNull();
		expect(message.get("m1", { includeDeleted: true })?.id).toBe("m1");
	});

	it("round-trips author mapping for all three sender kinds", () => {
		const { thread, message } = makeStores();
		thread.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
		message.append({ id: "m1", threadId: "t1", from: { kind: "agent", agentId: "a9" }, content: "", now: 2 });
		message.append({ id: "m2", threadId: "t1", from: { kind: "system", service: "svc" }, content: "", now: 3 });
		expect(message.get("m1")?.from).toEqual({ kind: "agent", agentId: "a9" });
		expect(message.get("m2")?.from).toEqual({ kind: "system", service: "svc" });
	});

	it("soft delete and lifecycle update persist", () => {
		const { thread, message } = makeStores();
		thread.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
		message.append({ id: "m1", threadId: "t1", from: { kind: "system", service: "x" }, content: "", now: 2 });
		message.updateLifecycle("m1", { kind: "input", dispatchRefs: [] }, 3);
		expect(message.get("m1")?.lifecycle?.kind).toBe("input");
		expect(message.softDelete("m1", "u1", 4)).toBe(true);
		expect(message.get("m1", { includeDeleted: true })?.deletedAt).toBe(4);
	});
});

describe("R1-a P3 leftovers", () => {
	it("seq allocation: interleaved appends allocate unique monotonic seqs", () => {
		const { thread, message } = makeStores();
		thread.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
		const ids: number[] = [];
		for (let i = 0; i < 20; i++) {
			const from =
				i % 2 === 0 ? ({ kind: "user", userId: "u1" } as const) : ({ kind: "agent", agentId: "a1" } as const);
			const m = message.append({ id: `m${i}`, threadId: "t1", from, content: `c${i}`, now: 2 + i });
			ids.push(m.seq);
		}
		expect(new Set(ids).size).toBe(20);
		expect(Math.min(...ids)).toBe(1);
		expect(Math.max(...ids)).toBe(20);
	});

	it("MessageOwnerError is a typed error", () => {
		const { thread, message } = makeStores();
		thread.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
		try {
			message.append({ id: "mx", threadId: "t1", from: { kind: "user", userId: "u2" }, content: "", now: 2 });
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as { code?: string }).code).toBe("message_author_not_thread_owner");
		}
	});
});

describe("AgentReadStateStore (0007 §4.5)", () => {
	it("ack is monotonic; rewind is explicit", () => {
		const { read, thread } = makeStores();
		thread.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
		read.ack("t1", "a1", 5, 1);
		read.ack("t1", "a1", 3, 2);
		expect(read.get("t1", "a1")?.deliveryCursor).toBe(5);
		read.rewind("t1", "a1", 0, 3);
		expect(read.get("t1", "a1")?.deliveryCursor).toBe(0);
	});
});
