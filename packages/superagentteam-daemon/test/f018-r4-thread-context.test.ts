import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ThreadContextService } from "../src/domains/a2a/thread-context.ts";
import { A2AToolError } from "../src/domains/a2a/tool-service.ts";
import { MessageStore } from "../src/domains/message/store.ts";
import { ThreadStore } from "../src/domains/thread/store.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";

const dirs: string[] = [];

function makeWorld() {
	const dir = mkdtempSync(join(tmpdir(), "f018-r4a-"));
	dirs.push(dir);
	const fd = new F018Database({ path: join(dir, "f018.db") });
	const threads = new ThreadStore(fd.db);
	const messages = new MessageStore(fd.db);
	const service = new ThreadContextService({ threads, messages });
	threads.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
	threads.create({ id: "t2", projectPath: "/p", createdBy: "u2", now: 1 });
	threads.create({ id: "t3", projectPath: "/p", createdBy: "u1", now: 1 });
	threads.softDelete("t3", 2);
	return { fd, threads, messages, service };
}

function append(
	world: ReturnType<typeof makeWorld>,
	input: Partial<Parameters<MessageStore["append"]>[0]> & { threadId?: string } = {},
) {
	const threadId = input.threadId ?? "t1";
	return world.messages.append({
		id: input.id ?? `msg:${threadId}:${randomUUID()}`,
		threadId,
		from: input.from ?? { kind: "user", userId: "u1" },
		content: input.content ?? "hello",
		...(input.extra ? { extra: input.extra } : {}),
		...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
		now: input.now ?? 10,
	});
}

function caller(overrides: Partial<{ threadId: string; userId: string; callerAgentId: string }> = {}) {
	return { threadId: "t1", userId: "u1", callerAgentId: "a1", ...overrides };
}

function expectCode(error: unknown, code: string): void {
	expect(error).toBeInstanceOf(A2AToolError);
	expect((error as A2AToolError).code).toBe(code);
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("F018 R4-a thread_context", () => {
	it("returns the recent window ascending and paginates older messages without side effects", () => {
		const w = makeWorld();
		for (let index = 1; index <= 5; index += 1) append(w, { content: `m${index}`, now: 10 + index });

		const first = w.service.read(caller(), { limit: 2 });
		expect(first.threadId).toBe("t1");
		expect(first.messages.map((message) => message.content)).toEqual(["m4", "m5"]);
		expect(first.hasMore).toBe(true);
		expect(first.nextCursor).toBeTruthy();

		const second = w.service.read(caller(), { limit: 2, cursor: first.nextCursor! });
		expect(second.messages.map((message) => message.content)).toEqual(["m2", "m3"]);
		expect(second.hasMore).toBe(true);
		const third = w.service.read(caller(), { limit: 2, cursor: second.nextCursor! });
		expect(third.messages.map((message) => message.content)).toEqual(["m1"]);
		expect(third.hasMore).toBe(false);

		expect(w.fd.db.prepare("SELECT COUNT(*) AS count FROM agent_read_state").get()).toEqual({ count: 0 });
		expect(w.fd.db.prepare("SELECT COUNT(*) AS count FROM invocation_queue").get()).toEqual({ count: 0 });
	});

	it("enforces thread existence, ownership and soft-delete", () => {
		const w = makeWorld();
		append(w, { content: "t1" });
		append(w, { threadId: "t2", from: { kind: "user", userId: "u2" }, content: "t2" });
		try {
			w.service.read(caller({ threadId: "missing" }));
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "thread_not_found");
		}
		try {
			w.service.read(caller({ threadId: "t2" }));
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "thread_access_denied");
		}
		try {
			w.service.read(caller({ threadId: "t3" }));
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "thread_deleted");
		}
		expect(w.service.read(caller({ threadId: "t2", userId: "u2" })).threadId).toBe("t2");
	});

	it("reads an anchor window and rejects invalid anchor/cursor windows", () => {
		const w = makeWorld();
		for (let index = 1; index <= 5; index += 1) append(w, { content: `m${index}`, now: 10 + index });
		const anchor = w.messages.getByThread("t1", 5)[2]!;
		const window = w.service.read(caller(), { anchor: anchor.id, before: 1, after: 1 });
		expect(window.messages.map((message) => message.content)).toEqual(["m2", "m3", "m4"]);
		try {
			w.service.read(caller(), { anchor: "missing" });
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "invalid_anchor");
		}
		try {
			w.service.read(caller(), { anchor: anchor.id, cursor: "seq:1" });
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "invalid_cursor");
		}
		try {
			w.service.read(caller(), { anchor: anchor.id, before: 51 });
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "invalid_window");
		}
		try {
			w.service.read(caller(), { limit: 0 });
			throw new Error("expected error");
		} catch (error) {
			expectCode(error, "invalid_window");
		}
	});

	it("applies HistoryAssembler visibility per caller", () => {
		const w = makeWorld();
		append(w, { content: "broadcast" });
		append(w, { content: "only a2", extra: { targetAgentIds: ["a2"] } });
		append(w, {
			content: "a1 response",
			from: { kind: "agent", agentId: "a1" },
			lifecycle: {
				kind: "response",
				parentInvocationId: "inv1",
				turnExecutionId: "te1",
				target: { kind: "agent", id: "a1" },
				status: "processing",
				startedAt: 3,
			},
		});
		const asA1 = w.service.read(caller(), { limit: 10 });
		expect(asA1.messages.map((message) => message.content)).toEqual(["broadcast"]);
		const asA2 = w.service.read(caller({ callerAgentId: "a2" }), { limit: 10 });
		expect(asA2.messages.map((message) => message.content)).toEqual(["broadcast", "only a2", "a1 response"]);
		expect(asA2.messages[2]?.lifecycle).toEqual({ kind: "response", status: "processing" });
	});
});
