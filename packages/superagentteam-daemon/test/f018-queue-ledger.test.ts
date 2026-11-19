import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { QUEUE_CAP_PER_KIND, QueueLedgerStore } from "../src/domains/queue/store.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";

const dirs: string[] = [];

function makeQueue(): { db: F018Database; queue: QueueLedgerStore } {
	const dir = mkdtempSync(join(tmpdir(), "f018-q-"));
	dirs.push(dir);
	const db = new F018Database({ path: join(dir, "f018.db") });
	db.db
		.prepare(
			"INSERT INTO threads (id, project_path, created_by, last_active_at, created_at, updated_at) VALUES ('t1', '/p', 'u1', 1, 1, 1)",
		)
		.run();
	db.db
		.prepare(
			"INSERT INTO messages (id, thread_id, seq, author_kind, author_id, body_md, created_at, updated_at) VALUES ('m1', 't1', 1, 'user', 'u1', 'hello', 1, 1)",
		)
		.run();
	return { db, queue: new QueueLedgerStore(db.db) };
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type EnqueueArgs = Parameters<QueueLedgerStore["enqueue"]>[0];

function baseInput(overrides: Partial<EnqueueArgs> = {}): EnqueueArgs {
	return {
		threadId: "t1",
		sourceRecordId: "s1",
		messageId: "m1",
		owner: { kind: "user", userId: "u1" },
		kind: "conversation_input",
		from: { kind: "user", userId: "u1" },
		content: "hello",
		targets: [{ kind: "agent", id: "a1" }],
		...overrides,
	};
}

describe("QueueLedgerStore (0007 §3.1/§4.1)", () => {
	it("enqueue is replay/conflict on live row AND on admission receipt after row deletion", () => {
		const { db, queue } = makeQueue();
		const eq1 = queue.enqueue(baseInput(), 100);
		expect(eq1.outcome).toBe("enqueued");
		const QID = eq1.outcome === "enqueued" ? eq1.entry.queueEntryId : "";
		void QID;
		expect(queue.enqueue(baseInput(), 110).outcome).toBe("replayed");
		const drifted = queue.enqueue(baseInput({ content: "changed" }), 120);
		expect(drifted.outcome).toBe("conflict");
		// delete live row; receipt still replays
		db.db.prepare("DELETE FROM invocation_queue WHERE thread_id = 't1'").run();
		const receipt = queue.enqueue(baseInput(), 130);
		expect(receipt.outcome).toBe("replayed");
		expect(receipt.entry).toBeNull();
		expect(queue.enqueue(baseInput({ content: "changed" }), 140).outcome).toBe("conflict");
	});

	it("rejects non-owner user admission (0011 §11)", () => {
		const { queue } = makeQueue();
		expect(() => queue.enqueue(baseInput({ owner: { kind: "user", userId: "attacker" } }))).toThrow(/owner/);
	});

	it("per-kind cap 5: sixth same-kind admission throws queue_full", () => {
		const { queue } = makeQueue();
		for (let i = 1; i <= QUEUE_CAP_PER_KIND; i++) {
			expect(queue.enqueue(baseInput({ sourceRecordId: `s${i}` }), 100 + i).outcome).toBe("enqueued");
		}
		expect(() => queue.enqueue(baseInput({ sourceRecordId: "s6" }), 200)).toThrow(/queue_full/);
		// other kind has its own budget
		expect(
			queue.enqueue(
				baseInput({
					sourceRecordId: "w1",
					kind: "message_wake",
					from: { kind: "agent", agentId: "a1" },
					owner: { kind: "system", service: "a2a" },
				}),
				201,
			).outcome,
		).toBe("enqueued");
	});

	it("claim is CAS: queued→claimed once, second claim state_changed; not-found for unknown", () => {
		const { queue } = makeQueue();
		const eq = queue.enqueue(baseInput(), 100);
		const QID = eq.outcome === "enqueued" ? eq.entry.queueEntryId : "";
		expect(
			queue.claim("t1", QID, {
				claimId: "c1",
				owner: "p1",
				ttlMs: 1000,
				targetKeys: ["agent:a1"],
				now: 110,
			}).outcome,
		).toBe("claimed");
		expect(
			queue.claim("t1", QID, {
				claimId: "c2",
				owner: "p2",
				ttlMs: 1000,
				targetKeys: ["agent:a1"],
				now: 120,
			}).outcome,
		).toBe("state_changed");
		expect(
			queue.claim("t1", "queue:none:1", { claimId: "c3", owner: "p1", ttlMs: 1000, targetKeys: [] }).outcome,
		).toBe("not_found");
		// claim covering non-pending target rejected
		const eq2 = queue.enqueue(baseInput({ sourceRecordId: "s2" }), 130);
		const QID2 = eq2.outcome === "enqueued" ? eq2.entry.queueEntryId : "";
		expect(() =>
			queue.claim("t1", QID2, {
				claimId: "c4",
				owner: "p1",
				ttlMs: 1000,
				targetKeys: ["agent:a9"],
				now: 140,
			}),
		).toThrow(/pending/);
	});

	it("retireTargets shrinks and deletes on empty; wrong claim is state_changed", () => {
		const { queue } = makeQueue();
		const eq = queue.enqueue(
			baseInput({
				targets: [
					{ kind: "agent", id: "a1" },
					{ kind: "agent", id: "a2" },
				],
			}),
			100,
		);
		const QID = eq.outcome === "enqueued" ? eq.entry.queueEntryId : "";
		queue.claim("t1", QID, {
			claimId: "c1",
			owner: "p1",
			ttlMs: 10_000,
			targetKeys: ["agent:a1", "agent:a2"],
			now: 110,
		});
		const updated = queue.retireTargets("t1", QID, "c1", { targetKeys: ["agent:a1"], now: 120 });
		expect(updated.outcome).toBe("updated");
		const updatedEntry = updated.outcome === "updated" ? updated.entry : null;
		expect(updatedEntry?.targets.map((t) => t.id)).toEqual(["a2"]);
		expect(queue.retireTargets("t1", QID, "cX", { targetKeys: ["agent:a2"] }).outcome).toBe("state_changed");
		const deleted = queue.retireTargets("t1", QID, "c1", { targetKeys: ["agent:a2"], now: 130 });
		expect(deleted.outcome).toBe("deleted");
		expect(queue.get("t1", QID)).toBeNull();
	});

	it("releaseClaim returns target to queued; restoreExpiredClaims sweeps expired", () => {
		const { queue } = makeQueue();
		const eq = queue.enqueue(baseInput(), 100);
		const QID = eq.outcome === "enqueued" ? eq.entry.queueEntryId : "";
		queue.claim("t1", QID, { claimId: "c1", owner: "p1", ttlMs: 50, targetKeys: ["agent:a1"], now: 110 });
		expect(queue.releaseClaim("t1", QID, "c1", 120).outcome).toBe("updated");
		expect(queue.get("t1", QID)?.status).toBe("queued");
		queue.claim("t1", QID, { claimId: "c2", owner: "p1", ttlMs: 50, targetKeys: ["agent:a1"], now: 200 });
		expect(queue.restoreExpiredClaims(500)).toBe(1);
		expect(queue.get("t1", QID)?.status).toBe("queued");
		expect(queue.restoreExpiredClaims(600)).toBe(0);
	});

	it("priority FIFO ordering in listQueued; countQueued is per-kind", () => {
		const { queue } = makeQueue();
		queue.enqueue(baseInput({ sourceRecordId: "n1" }), 100);
		queue.enqueue(baseInput({ sourceRecordId: "n2", priority: "urgent" }), 101);
		queue.enqueue(baseInput({ sourceRecordId: "n3" }), 102);
		expect(queue.listQueued("t1").map((e) => e.payload.sourceRecordId)).toEqual(["n2", "n1", "n3"]);
		expect(queue.countQueued("t1", "conversation_input")).toBe(3);
		expect(queue.countQueued("t1", "message_wake")).toBe(0);
	});

	it("retireTargets rejects keys outside the claim coverage", () => {
		const { queue } = makeQueue();
		const eqA = queue.enqueue(
			baseInput({
				targets: [
					{ kind: "agent", id: "a1" },
					{ kind: "agent", id: "a2" },
				],
			}),
			100,
		);
		const QID = eqA.outcome === "enqueued" ? eqA.entry.queueEntryId : "";
		queue.claim("t1", QID, { claimId: "c1", owner: "p", ttlMs: 10_000, targetKeys: ["agent:a1"], now: 110 });
		expect(() => queue.retireTargets("t1", QID, "c1", { targetKeys: ["agent:a2"], now: 120 })).toThrow(
			/outside_claim/,
		);
		// covered key still works
		expect(queue.retireTargets("t1", QID, "c1", { targetKeys: ["agent:a1"], now: 121 }).outcome).toBe("updated");
	});

	it("claimed partial withdrawal shrinks claimed keys; release when coverage empties", () => {
		const { queue } = makeQueue();
		const eqB = queue.enqueue(
			baseInput({
				targets: [
					{ kind: "agent", id: "a1" },
					{ kind: "agent", id: "a2" },
				],
			}),
			100,
		);
		const QID = eqB.outcome === "enqueued" ? eqB.entry.queueEntryId : "";
		queue.claim("t1", QID, {
			claimId: "c1",
			owner: "p",
			ttlMs: 10_000,
			targetKeys: ["agent:a1", "agent:a2"],
			now: 110,
		});
		queue.withdrawTargets("t1", QID, { actorRef: "op", reason: "r", claimId: "c1", targetKeys: ["agent:a1"] });
		const after = queue.get("t1", QID)!;
		expect(after.claim?.targetKeys).toEqual(["agent:a2"]);
		expect(after.targets.map((t) => t.id)).toEqual(["a2"]);
		// withdraw the last covered target -> claim released, entry back to queued
		queue.withdrawTargets("t1", QID, { actorRef: "op", reason: "r", claimId: "c1", targetKeys: ["agent:a2"] });
		expect(queue.listQueued("t1")).toHaveLength(0); // no pending targets remain in listQueued
	});

	it("claim rejects empty targetKeys (must be a non-empty subset)", () => {
		const { queue } = makeQueue();
		const eq = queue.enqueue(baseInput(), 100);
		const qid = eq.outcome === "enqueued" ? eq.entry.queueEntryId : "";
		expect(() => queue.claim("t1", qid, { claimId: "c1", owner: "p", ttlMs: 1000, targetKeys: [] })).toThrow(
			/claim_targets_empty/,
		);
	});

	it("long thread/source ids and attempt=2 do not collide on the queue primary key", () => {
		const { db, queue } = makeQueue();
		const longThread = "thread_0123456789abcdef0123456789abcdef0123456789abcdef";
		db.db
			.prepare(
				"INSERT INTO threads (id, project_path, created_by, last_active_at, created_at, updated_at) VALUES (?, '/p', 'u1', 1, 1, 1)",
			)
			.run(longThread);
		const longSource = "msg_0123456789abcdef0123456789abcdef0123456789abcdef";
		const first = queue.enqueue(baseInput({ threadId: longThread, sourceRecordId: longSource }), 100);
		expect(first.outcome).toBe("enqueued");
		// same thread, different long source — no collision
		const second = queue.enqueue(baseInput({ threadId: longThread, sourceRecordId: `${longSource}-x` }), 110);
		expect(second.outcome).toBe("enqueued");
		// same thread/source, attempt=2 — no collision with attempt=1
		const retry = queue.enqueue(baseInput({ threadId: longThread, sourceRecordId: longSource, attempt: 2 }), 120);
		expect(retry.outcome).toBe("enqueued");
		// ids distinct
		const ids = [
			first.outcome === "enqueued" ? first.entry.queueEntryId : "",
			second.outcome === "enqueued" ? second.entry.queueEntryId : "",
			retry.outcome === "enqueued" ? retry.entry.queueEntryId : "",
		];
		expect(new Set(ids).size).toBe(3);
	});

	it("retire/withdraw results carry projections", () => {
		const { queue } = makeQueue();
		const eq = queue.enqueue(
			baseInput({
				targets: [
					{ kind: "agent", id: "a1" },
					{ kind: "agent", id: "a2" },
				],
			}),
			100,
		);
		const qid = eq.outcome === "enqueued" ? eq.entry.queueEntryId : "";
		queue.claim("t1", qid, {
			claimId: "c1",
			owner: "p",
			ttlMs: 10_000,
			targetKeys: ["agent:a1", "agent:a2"],
			now: 110,
		});
		const retired = queue.retireTargets("t1", qid, "c1", { targetKeys: ["agent:a1"], now: 120 });
		if (retired.outcome === "updated") {
			expect(retired.projection.status).toBe("processing");
			expect(retired.projection.queueEntryId).toBe(qid);
		} else {
			throw new Error("expected updated");
		}
		const gone = queue.withdrawTargets("t1", qid, {
			actorRef: "op",
			reason: "r",
			claimId: "c1",
			targetKeys: ["agent:a2"],
		});
		expect(gone.outcome).toBe("deleted");
		if (gone.outcome === "deleted") {
			expect(gone.projection.status).toBe("terminal");
			expect(gone.projection.reason).toBe("withdrawn");
		}
	});

	it("withdrawTargets removes or deletes without a claim", () => {
		const { queue } = makeQueue();
		const eqC = queue.enqueue(
			baseInput({
				targets: [
					{ kind: "agent", id: "a1" },
					{ kind: "agent", id: "a2" },
				],
			}),
			100,
		);
		const QID = eqC.outcome === "enqueued" ? eqC.entry.queueEntryId : "";
		const partial = queue.withdrawTargets("t1", QID, {
			actorRef: "op",
			reason: "r",
			targetKeys: ["agent:a1"],
		});
		expect(partial.outcome).toBe("updated");
		const full = queue.withdrawTargets("t1", QID, { actorRef: "op", reason: "r" });
		expect(full.outcome).toBe("deleted");
	});
});
