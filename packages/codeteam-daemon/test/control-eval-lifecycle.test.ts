import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	acceptSunset,
	appendEvalLifecycleEvent,
	ControlError,
	getEvalCase,
	listEvalCases,
	openControlStore,
	publishEvalVerdict,
	suppressEvalCase,
} from "../src/index.ts";
import {
	createEvalFixture,
	type EvalFixture,
	makeVerdictPacket,
	publishFixturePacket,
} from "./helpers/eval-fixture.ts";

const fixtures: EvalFixture[] = [];

function fixture(): EvalFixture {
	const value = createEvalFixture();
	fixtures.push(value);
	return value;
}

afterEach(() => {
	for (const value of fixtures.splice(0)) value.cleanup();
});

function expectCode(fn: () => unknown, code: string): void {
	try {
		fn();
		throw new Error("expected ControlError");
	} catch (error) {
		expect(error).toBeInstanceOf(ControlError);
		expect((error as ControlError).code).toBe(code);
	}
}

describe("W6b eval lifecycle", () => {
	it("publishes a verdict with immutable artifacts, a lifecycle case, and a same-transaction message", () => {
		const base = fixture();
		const result = publishFixturePacket(base);
		expect(result.replayed).toBe(false);
		expect(result.eval.domainId).toBe("eval:test-domain");
		expect(result.eval.taskId).toBeNull();
		expect(result.eval.status).toBe("ok");
		expect(result.case?.status).toBe("open");
		expect(result.case?.nextSequence).toBe(2);
		expect(result.artifacts.refs.map((ref) => ref.kind).sort()).toEqual(
			["eval-attribution", "eval-finding", "eval-snapshot", "eval-verdict", "lifecycle-root"].sort(),
		);
		const message = base.store.messages.get(result.message.id)!;
		expect(message.threadId).toBe("thread:eval-domain");
		expect(message.kind).toBe("verdict");
		expect(message.bodyMd).toContain(result.artifacts.lifecycleRootDigest);
		expect(message.bodyMd).toContain("Case: eval-case-v1-");
		expect(base.store.evals.get("verdict-1")?.verdictId).toBe("verdict-1");
	});

	it("is idempotent for the same packet and conflicts on a different packet", () => {
		const base = fixture();
		const first = publishFixturePacket(base);
		const second = publishFixturePacket(base);
		expect(second.replayed).toBe(true);
		expect(second.eval.id).toBe(first.eval.id);
		expectCode(() => publishFixturePacket(base, { phenomenon: "different" }), "conflict");
	});

	it("enforces the transition matrix and owner/eval/system actor identities", () => {
		const base = fixture();
		const published = publishFixturePacket(base);
		const caseId = published.case!.caseId;
		expectCode(
			() =>
				appendEvalLifecycleEvent(base.store, {
					caseId,
					expectedSequence: 1,
					type: "fix_landed",
					actor: { kind: "owner", id: "profile:owner" },
					reason: "skip planning",
				}),
			"invalid_state",
		);
		const ack = appendEvalLifecycleEvent(base.store, {
			caseId,
			expectedSequence: 1,
			type: "owner_acknowledged",
			actor: { kind: "owner", id: "profile:owner" },
			reason: "will fix",
		});
		expect(ack.event.seq).toBe(2);
		expectCode(
			() =>
				appendEvalLifecycleEvent(base.store, {
					caseId,
					expectedSequence: 2,
					type: "action_planned",
					actor: { kind: "owner", id: "profile:not-owner" },
					reason: "wrong owner",
				}),
			"forbidden",
		);
		appendEvalLifecycleEvent(base.store, {
			caseId,
			expectedSequence: 2,
			type: "action_planned",
			actor: { kind: "owner", id: "profile:owner" },
			reason: "plan",
		});
		appendEvalLifecycleEvent(base.store, {
			caseId,
			expectedSequence: 3,
			type: "fix_landed",
			actor: { kind: "owner", id: "profile:owner" },
			reason: "fix",
		});
		appendEvalLifecycleEvent(base.store, {
			caseId,
			expectedSequence: 4,
			type: "reeval_requested",
			actor: { kind: "owner", id: "profile:owner" },
			reason: "recheck",
		});
		appendEvalLifecycleEvent(base.store, {
			caseId,
			expectedSequence: 5,
			type: "reeval_passed",
			actor: { kind: "eval", id: "profile:eval" },
			reason: "passed",
		});
		expectCode(
			() =>
				appendEvalLifecycleEvent(base.store, {
					caseId,
					expectedSequence: 6,
					type: "resolved",
					actor: { kind: "eval", id: "profile:eval" },
					reason: "self-close",
				}),
			"forbidden",
		);
		const resolved = appendEvalLifecycleEvent(base.store, {
			caseId,
			expectedSequence: 6,
			type: "resolved",
			actor: { kind: "system", id: "eval-closure-reconciler" },
			reason: "closure condition met",
		});
		expect(resolved.event.seq).toBe(7);
		expect(getEvalCase(base.store, caseId).status).toBe("resolved");
	});

	it("keeps event replay idempotent and rejects stale sequences", () => {
		const base = fixture();
		const published = publishFixturePacket(base);
		const caseId = published.case!.caseId;
		const first = appendEvalLifecycleEvent(base.store, {
			eventId: "event-ack-1",
			caseId,
			expectedSequence: 1,
			type: "owner_acknowledged",
			actor: { kind: "owner", id: "profile:owner" },
			reason: "ack",
		});
		const replay = appendEvalLifecycleEvent(base.store, {
			eventId: "event-ack-1",
			caseId,
			expectedSequence: 1,
			type: "owner_acknowledged",
			actor: { kind: "owner", id: "profile:owner" },
			reason: "ack",
		});
		expect(replay.replayed).toBe(true);
		expect(replay.event.seq).toBe(first.event.seq);
		expectCode(
			() =>
				appendEvalLifecycleEvent(base.store, {
					eventId: "event-ack-1",
					caseId,
					expectedSequence: 1,
					type: "owner_acknowledged",
					actor: { kind: "owner", id: "profile:owner" },
					reason: "different content",
				}),
			"conflict",
		);
		expectCode(
			() =>
				appendEvalLifecycleEvent(base.store, {
					caseId,
					expectedSequence: 1,
					type: "action_planned",
					actor: { kind: "owner", id: "profile:owner" },
					reason: "stale seq",
				}),
			"version_conflict",
		);
	});

	it("rejects a second verdict that reuses the same case identity", () => {
		const base = fixture();
		publishFixturePacket(base);
		const messageCount = base.store.messages.listThread("thread:eval-domain").length;
		expectCode(
			() =>
				publishFixturePacket(base, {
					id: "verdict-2",
					bundleId: "bundle-2",
					createdAt: base.now() + 1000,
					acceptanceReevalPlan: {
						nextEvalAt: base.now() + 7 * 24 * 60 * 60 * 1000,
						closureCondition: "same case retry",
					},
				}),
			"conflict",
		);
		expect(base.store.evals.get("verdict-2")).toBeNull();
		expect(base.store.messages.listThread("thread:eval-domain")).toHaveLength(messageCount);
		expect(existsSync(join(base.dataDir, "eval-artifacts", "verdict-2"))).toBe(false);
	});

	it("serializes sequence across two control connections", () => {
		const base = fixture();
		const published = publishFixturePacket(base);
		const caseId = published.case!.caseId;
		// Reopen the same data dir through a different ControlStore instance.
		const reopened = openControlStore({ dataDir: base.dataDir });
		try {
			const types = ["owner_acknowledged", "action_planned", "fix_landed", "reeval_requested"] as const;
			let sequence = 1;
			for (const [index, type] of types.entries()) {
				const store = index % 2 === 0 ? base.store : reopened;
				const event = appendEvalLifecycleEvent(store, {
					caseId,
					expectedSequence: sequence,
					type,
					actor: { kind: "owner", id: "profile:owner" },
					reason: `${type}-${index}`,
				}).event;
				expect(event.seq).toBe(sequence + 1);
				sequence += 1;
			}
			expect(getEvalCase(reopened, caseId).events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
		} finally {
			reopened.close();
		}
	});

	it("requires operator for cvo_suppressed and accept-sunset; eval cannot self-close", () => {
		const base = fixture();
		const published = publishFixturePacket(base);
		const caseId = published.case!.caseId;
		expectCode(
			() =>
				suppressEvalCase(base.store, {
					caseId,
					actor: { kind: "owner", id: "profile:owner" },
					reason: "not operator",
				}),
			"forbidden",
		);
		const suppressed = suppressEvalCase(base.store, {
			caseId,
			actor: { kind: "operator", id: "operator:test" },
			reason: "accepted risk",
		});
		expect(suppressed.type).toBe("cvo_suppressed");
		expect(getEvalCase(base.store, caseId).status).toBe("suppressed_with_reason");
		expectCode(
			() =>
				appendEvalLifecycleEvent(base.store, {
					caseId,
					type: "owner_acknowledged",
					actor: { kind: "owner", id: "profile:owner" },
					reason: "terminal",
				}),
			"invalid_state",
		);
	});

	it("keeps delete_sunset awaiting operator accept and never deletes harness files", () => {
		const base = fixture();
		const packet = makeVerdictPacket({
			id: "verdict-sunset",
			bundleId: "bundle-sunset",
			verdict: "delete_sunset",
			findingKey: "sunset-1",
			governance: { cvoAcceptRequired: true, cvoSuppressed: false },
		});
		const published = publishEvalVerdict(base.store, {
			entry: base.entry,
			packet,
			actor: { kind: "eval", id: "profile:eval" },
			dataDir: base.dataDir,
		});
		expect(published.case?.awaitingSunsetDecision).toBe(true);
		expect(published.case?.status).toBe("open");
		expect(published.message.bodyMd).toContain("awaiting operator accept");
		expectCode(
			() =>
				acceptSunset(base.store, {
					caseId: published.case!.caseId,
					actor: { kind: "owner", id: "profile:owner" },
					reason: "not operator",
				}),
			"forbidden",
		);
		const accepted = acceptSunset(base.store, {
			caseId: published.case!.caseId,
			actor: { kind: "operator", id: "operator:test" },
			reason: "sunset trial accepted",
		});
		expect(accepted.case.status).toBe("resolved");
		expect(accepted.case.awaitingSunsetDecision).toBe(false);
		expect(accepted.message.bodyMd).toContain("no harness files or configuration were deleted");
		expect(base.store.evals.get("verdict-sunset")).not.toBeNull();
	});

	it("marks observation-only verdicts without findingKey and does not create a case", () => {
		const base = fixture();
		const packet = makeVerdictPacket({
			id: "verdict-observation",
			bundleId: "bundle-observation",
			verdict: "keep_observe",
			findingKey: undefined,
			findings: [],
			governance: { cvoAcceptRequired: false, cvoSuppressed: false },
		});
		const published = publishEvalVerdict(base.store, {
			entry: base.entry,
			packet,
			actor: { kind: "eval", id: "profile:eval" },
			dataDir: base.dataDir,
		});
		expect(published.case).toBeNull();
		expect(published.message.bodyMd).toContain("observation report · no case tracking");
		expect(listEvalCases(base.store)).toHaveLength(0);
	});

	it("requires reasons for non-ok measurements and surfaces them in the message", () => {
		const base = fixture();
		const packet = makeVerdictPacket({
			id: "verdict-insufficient",
			bundleId: "bundle-insufficient",
			verdict: "keep_observe",
			findingKey: undefined,
			findings: [],
			evidencePacket: {
				...makeVerdictPacket().evidencePacket,
				measurement: {
					status: "insufficient",
					method: "fixture",
					windowStartMs: 1_700_000_000_000,
					windowEndMs: 1_700_000_100_000,
					measurementRef: "measurement:insufficient",
					reasons: ["n=3 below smoke threshold"],
				},
			},
		});
		const published = publishEvalVerdict(base.store, {
			entry: base.entry,
			packet,
			actor: { kind: "eval", id: "profile:eval" },
			dataDir: base.dataDir,
		});
		expect(published.eval.status).toBe("insufficient");
		expect(published.eval.reasons).toEqual(["n=3 below smoke threshold"]);
		expect(published.message.bodyMd).toContain("Reasons: n=3 below smoke threshold");
		expectCode(
			() =>
				publishEvalVerdict(base.store, {
					entry: base.entry,
					packet: makeVerdictPacket({
						id: "verdict-bad-reasons",
						bundleId: "bundle-bad-reasons",
						verdict: "keep_observe",
						evidencePacket: {
							...makeVerdictPacket().evidencePacket,
							measurement: {
								status: "no_data",
								method: "fixture",
								windowStartMs: 1_700_000_000_000,
								windowEndMs: 1_700_000_100_000,
								measurementRef: "measurement:none",
								reasons: [],
							},
						},
					}),
					actor: { kind: "eval", id: "profile:eval" },
					dataDir: base.dataDir,
				}),
			"invalid_input",
		);
	});

	it("rejects secrets before writing eval rows, messages, or artifacts", () => {
		const base = fixture();
		const packet = makeVerdictPacket({
			id: "verdict-secret",
			phenomenon: "leaked AKIAABCDEFGHIJKLMNOP",
		});
		expectCode(
			() =>
				publishEvalVerdict(base.store, {
					entry: base.entry,
					packet,
					actor: { kind: "eval", id: "profile:eval" },
					dataDir: base.dataDir,
				}),
			"forbidden",
		);
		expect(base.store.evals.get("verdict-secret")).toBeNull();
		expect(base.store.messages.listThread("thread:eval-domain")).toHaveLength(0);
	});

	it("makes eval_lifecycle_events append-only", () => {
		const base = fixture();
		const published = publishFixturePacket(base);
		const caseId = published.case!.caseId;
		expect(() =>
			base.store.database
				.prepare("UPDATE eval_lifecycle_events SET reason = 'changed' WHERE case_id = ?")
				.run(caseId),
		).toThrow(/append_only/);
		expect(() =>
			base.store.database.prepare("DELETE FROM eval_lifecycle_events WHERE case_id = ?").run(caseId),
		).toThrow(/append_only/);
	});

	it("does not write review or finding ledgers when eval lifecycle changes", () => {
		const base = fixture();
		const before = {
			reviews: (base.store.database.prepare("SELECT COUNT(*) AS count FROM reviews").get() as { count: number })
				.count,
			findings: (base.store.database.prepare("SELECT COUNT(*) AS count FROM findings").get() as { count: number })
				.count,
			verifications: (
				base.store.database.prepare("SELECT COUNT(*) AS count FROM verifications").get() as { count: number }
			).count,
		};
		const published = publishFixturePacket(base);
		appendEvalLifecycleEvent(base.store, {
			caseId: published.case!.caseId,
			expectedSequence: 1,
			type: "owner_acknowledged",
			actor: { kind: "owner", id: "profile:owner" },
			reason: "ack",
		});
		const after = {
			reviews: (base.store.database.prepare("SELECT COUNT(*) AS count FROM reviews").get() as { count: number })
				.count,
			findings: (base.store.database.prepare("SELECT COUNT(*) AS count FROM findings").get() as { count: number })
				.count,
			verifications: (
				base.store.database.prepare("SELECT COUNT(*) AS count FROM verifications").get() as { count: number }
			).count,
		};
		expect(after).toEqual(before);
	});

	it("fails closed without partial eval rows when the domain thread is unavailable", () => {
		const base = fixture();
		base.store.threads.setStatus("thread:eval-domain", "archived");
		expectCode(
			() => publishFixturePacket(base, { id: "verdict-archived", bundleId: "bundle-archived" }),
			"invalid_state",
		);
		expect(base.store.evals.get("verdict-archived")).toBeNull();
		expect(base.store.messages.listThread("thread:eval-domain")).toHaveLength(0);
	});
});
