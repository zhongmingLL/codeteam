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
	makeMeasurement,
	makeVerdictPacket,
	publishFixturePacket,
} from "./helpers/eval-fixture.ts";

const fixtures: EvalFixture[] = [];
const OWNER = { kind: "agent", id: "profile:owner" } as const;
const EVAL = { kind: "agent", id: "profile:eval" } as const;
const OPERATOR = { kind: "operator", id: "operator:test" } as const;
const SLA = { kind: "system", id: "sla-reconciler" } as const;
const MERGE = { kind: "system", id: "merge-owner" } as const;

type OwnerStep = "owner_acknowledged" | "action_planned" | "fix_recorded" | "main_landed" | "reeval_requested";

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

function publishUnique(base: EvalFixture, id: string, findingKey: string) {
	return publishFixturePacket(base, { id, findingKey });
}

function append(
	base: EvalFixture,
	caseId: string,
	type: Exclude<Parameters<typeof appendEvalLifecycleEvent>[1]["type"], "verdict_opened" | "verdict_cycle_observed">,
	actor: { kind: "agent" | "operator" | "system" | "migration"; id: string },
	expectedSequence: number,
	extra: { commitSha?: string; targetOwnerProfileId?: string } = {},
) {
	return appendEvalLifecycleEvent(base.store, {
		caseId,
		expectedSequence,
		type,
		actor,
		reason: type,
		...extra,
	}).event;
}

function driveOwner(base: EvalFixture, caseId: string, steps: readonly OwnerStep[]): number {
	let last = getEvalCase(base.store, caseId).nextSequence - 1;
	for (const type of steps) {
		const extra = type === "main_landed" ? { commitSha: "a".repeat(40) } : {};
		const actor = type === "main_landed" ? MERGE : type === "reeval_requested" ? SLA : OWNER;
		append(base, caseId, type, actor, last, extra);
		last += 1;
	}
	return last;
}

function driveToResolved(base: EvalFixture, caseId: string): void {
	const last = driveOwner(base, caseId, [
		"owner_acknowledged",
		"action_planned",
		"fix_recorded",
		"main_landed",
		"reeval_requested",
	]);
	append(base, caseId, "reeval_passed", EVAL, last);
}

function rawInsert(
	base: EvalFixture,
	caseId: string,
	seq: number,
	type: string,
	actorKind: string,
	actorId: string,
	payload: Record<string, unknown> = { reason: "raw" },
): void {
	const now = new Date().toISOString();
	base.store.database
		.prepare(
			"INSERT INTO eval_lifecycle_events (event_id, case_id, seq, domain_id, event_type, actor_kind, actor_id, payload_json, occurred_at, created_at) VALUES (?, ?, ?, 'eval:test-domain', ?, ?, ?, ?, ?, ?)",
		)
		.run(`raw-${caseId}-${seq}`, caseId, seq, type, actorKind, actorId, JSON.stringify(payload), now, now);
}

describe("W6b eval lifecycle", () => {
	it("publishes a verdict with immutable artifact-table entries, a lifecycle case, and a same-transaction message", () => {
		const base = fixture();
		const result = publishFixturePacket(base);
		expect(result.replayed).toBe(false);
		expect(result.eval.domainId).toBe("eval:test-domain");
		expect(result.eval.taskId).toBeNull();
		expect(result.eval.status).toBe("ok");
		expect(result.case?.status).toBe("open");
		expect(result.case?.nextSequence).toBe(2);
		expect(result.artifacts.refs.map((ref) => ref.kind).sort()).toEqual(
			[
				"eval-attribution",
				"eval-finding",
				"eval-lifecycle-root",
				"eval-measurement-result",
				"eval-snapshot",
				"eval-verdict",
			].sort(),
		);
		for (const ref of result.artifacts.refs) {
			expect(base.store.evalArtifacts.get(ref.artifactId)).not.toBeNull();
			expect(ref.path.startsWith(join(base.dataDir, "evals", "bundles"))).toBe(true);
		}
		const message = base.store.messages.get(result.message.id)!;
		expect(message.threadId).toBe("thread:eval-domain");
		expect(message.kind).toBe("verdict");
		expect(message.bodyMd).toContain(result.artifacts.lifecycleRootDigest);
		expect(message.bodyMd).toContain("Case: eval-case-v1-");
		const events = getEvalCase(base.store, result.case!.caseId).events;
		expect(events[0]).toMatchObject({
			type: "verdict_opened",
			actor: { kind: "system", id: "publish-pipeline" },
			payload: { verdictId: "verdict-1" },
		});
	});

	it("is idempotent for the same packet and conflicts on a different packet", () => {
		const base = fixture();
		const first = publishFixturePacket(base);
		const second = publishFixturePacket(base);
		expect(second.replayed).toBe(true);
		expect(second.eval.id).toBe(first.eval.id);
		expectCode(() => publishFixturePacket(base, { phenomenon: "different" }), "conflict");
	});

	it("drives the approved lifecycle with owner/eval/operator/system authority", () => {
		const base = fixture();
		const published = publishUnique(base, "verdict-flow", "flow-1");
		const caseId = published.case!.caseId;
		expectCode(() => append(base, caseId, "owner_acknowledged", EVAL, 1), "forbidden");
		let seq = 1;
		append(base, caseId, "owner_acknowledged", OWNER, seq);
		seq += 1;
		append(base, caseId, "action_planned", OWNER, seq);
		seq += 1;
		expectCode(() => append(base, caseId, "fix_recorded", EVAL, seq), "forbidden");
		append(base, caseId, "fix_recorded", OWNER, seq);
		seq += 1;
		expectCode(() => append(base, caseId, "main_landed", OWNER, seq, { commitSha: "a".repeat(40) }), "forbidden");
		expectCode(() => append(base, caseId, "main_landed", MERGE, seq, { commitSha: "abc" }), "invalid_input");
		append(base, caseId, "main_landed", MERGE, seq, { commitSha: "a".repeat(40) });
		seq += 1;
		expectCode(() => append(base, caseId, "reeval_requested", OWNER, seq), "forbidden");
		const requested = append(base, caseId, "reeval_requested", SLA, seq);
		expect(requested.payload.dueAt).toBe(
			new Date(Date.parse(published.case!.createdAt) + 168 * 60 * 60 * 1000).toISOString(),
		);
		seq += 1;
		expectCode(() => append(base, caseId, "reeval_passed", OWNER, seq), "forbidden");
		const passed = append(base, caseId, "reeval_passed", EVAL, seq);
		expect(passed.seq).toBe(seq + 1);
		expect(getEvalCase(base.store, caseId).status).toBe("resolved");
	});

	it("supports operator acknowledgement, owner reassignment, and escalated recovery", () => {
		const base = fixture();
		base.store.profiles.create({
			id: "profile:owner-2",
			role: "coder",
			displayName: "Owner 2",
			provider: "owner-provider",
			model: "glm-owner-2",
			modelFamily: "glm",
			toolPolicyProfile: "default",
		});
		const published = publishUnique(base, "verdict-owner", "owner-1");
		const caseId = published.case!.caseId;
		append(base, caseId, "owner_acknowledged", OPERATOR, 1);
		expect(getEvalCase(base.store, caseId).status).toBe("acknowledged");
		append(base, caseId, "owner_reassigned", OPERATOR, 2, { targetOwnerProfileId: "profile:owner-2" });
		expect(getEvalCase(base.store, caseId).status).toBe("acknowledged");
		expectCode(() => append(base, caseId, "action_planned", OWNER, 3), "forbidden");
		append(base, caseId, "action_planned", { kind: "agent", id: "profile:owner-2" }, 3);
		expect(getEvalCase(base.store, caseId).status).toBe("action_planned");
		append(base, caseId, "fix_recorded", OPERATOR, 4);
		expect(getEvalCase(base.store, caseId).status).toBe("fix_landed");
		append(base, caseId, "main_landed", OPERATOR, 5, { commitSha: "b".repeat(40) });
		expect(getEvalCase(base.store, caseId).status).toBe("main_landed");
		const escalation = append(base, caseId, "sla_escalated", SLA, 6);
		expect(escalation.actor).toEqual({ kind: "system", id: "sla-reconciler" });
		const projection = getEvalCase(base.store, caseId, Date.parse(published.case!.createdAt) + 1000);
		expect(projection.status).toBe("escalated");
		expect(projection.overdue).toBe(true);
		append(base, caseId, "action_planned", { kind: "agent", id: "profile:owner-2" }, 7);
		expect(getEvalCase(base.store, caseId).status).toBe("action_planned");
	});

	it("returns to action_planned on reeval_failed and can record a new fix", () => {
		const base = fixture();
		const published = publishUnique(base, "verdict-reeval-failed", "reeval-failed");
		const caseId = published.case!.caseId;
		let seq = driveOwner(base, caseId, [
			"owner_acknowledged",
			"action_planned",
			"fix_recorded",
			"main_landed",
			"reeval_requested",
		]);
		expectCode(() => append(base, caseId, "reeval_failed", OWNER, seq), "forbidden");
		append(base, caseId, "reeval_failed", EVAL, seq);
		expect(getEvalCase(base.store, caseId).status).toBe("action_planned");
		seq += 1;
		append(base, caseId, "fix_recorded", OWNER, seq);
		expect(getEvalCase(base.store, caseId).status).toBe("fix_landed");
	});

	it("rejects actionable verdicts without findingKey", () => {
		const base = fixture();
		expectCode(
			() =>
				publishFixturePacket(base, {
					id: "verdict-observation-fix",
					findingKey: undefined,
					verdict: "fix",
				}),
			"invalid_input",
		);
		expect(base.store.evals.get("verdict-observation-fix")).toBeNull();
		expectCode(
			() =>
				publishFixturePacket(base, {
					id: "verdict-observation-sunset",
					findingKey: undefined,
					verdict: "delete_sunset",
					governance: { cvoAcceptRequired: true },
				}),
			"invalid_input",
		);
		expect(base.store.evals.get("verdict-observation-sunset")).toBeNull();
	});

	it("rejects raw lifecycle history that bypasses transition or authority checks", () => {
		const base = fixture();
		const authority = publishUnique(base, "verdict-raw-authority", "raw-authority");
		rawInsert(base, authority.case!.caseId, 2, "owner_acknowledged", "agent", "agent:profile:not-owner");
		expectCode(() => getEvalCase(base.store, authority.case!.caseId), "forbidden");

		const transition = publishUnique(base, "verdict-raw-transition", "raw-transition");
		rawInsert(base, transition.case!.caseId, 2, "main_landed", "system", "system:merge-owner");
		expectCode(() => getEvalCase(base.store, transition.case!.caseId), "invalid_state");
	});

	it("escalates from all six legal source states and is always overdue", () => {
		const base = fixture();
		const scenarios: ReadonlyArray<{ readonly state: string; readonly steps: readonly OwnerStep[] }> = [
			{ state: "open", steps: [] },
			{ state: "acknowledged", steps: ["owner_acknowledged"] },
			{ state: "action_planned", steps: ["owner_acknowledged", "action_planned"] },
			{ state: "fix_landed", steps: ["owner_acknowledged", "action_planned", "fix_recorded"] },
			{
				state: "main_landed",
				steps: ["owner_acknowledged", "action_planned", "fix_recorded", "main_landed"],
			},
			{
				state: "reeval_pending",
				steps: ["owner_acknowledged", "action_planned", "fix_recorded", "main_landed", "reeval_requested"],
			},
		];
		for (const [index, scenario] of scenarios.entries()) {
			const published = publishUnique(base, `verdict-escalate-${index}`, `escalate-${index}`);
			const caseId = published.case!.caseId;
			const last = driveOwner(base, caseId, scenario.steps);
			expect(getEvalCase(base.store, caseId).status).toBe(scenario.state);
			append(base, caseId, "sla_escalated", SLA, last);
			const projection = getEvalCase(base.store, caseId, Date.parse(published.case!.createdAt) + 1000);
			expect(projection.status).toBe("escalated");
			expect(projection.overdue).toBe(true);
		}
	});

	it("rejects unwired migration and unknown lifecycle event types", () => {
		const base = fixture();
		const published = publishUnique(base, "verdict-unwired", "unwired-1");
		expectCode(
			() =>
				appendEvalLifecycleEvent(base.store, {
					caseId: published.case!.caseId,
					type: "migration" as never,
					actor: { kind: "migration", id: "legacy" },
					reason: "backfill",
				}),
			"invalid_state",
		);
		expectCode(
			() =>
				appendEvalLifecycleEvent(base.store, {
					caseId: published.case!.caseId,
					type: "live_active" as never,
					actor: { kind: "system", id: "publish-pipeline" },
					reason: "unwired",
				}),
			"invalid_input",
		);
	});

	it("opens a new verdict cycle on the same case after resolution", () => {
		const base = fixture();
		const first = publishUnique(base, "verdict-cycle-1", "cycle-1");
		driveToResolved(base, first.case!.caseId);
		expect(getEvalCase(base.store, first.case!.caseId).status).toBe("resolved");
		const second = publishUnique(base, "verdict-cycle-2", "cycle-1");
		expect(second.case?.caseId).toBe(first.case!.caseId);
		expect(second.case?.verdictId).toBe("verdict-cycle-2");
		expect(second.case?.status).toBe("open");
		expect(listEvalCases(base.store)).toHaveLength(1);
		const events = getEvalCase(base.store, first.case!.caseId).events;
		expect(
			events.some(
				(event) => event.type === "verdict_cycle_observed" && event.payload.verdictId === "verdict-cycle-2",
			),
		).toBe(true);
		expect(base.store.evals.listByDomain("eval:test-domain")).toHaveLength(2);
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
			actor: OWNER,
			reason: "ack",
		});
		const replay = appendEvalLifecycleEvent(base.store, {
			eventId: "event-ack-1",
			caseId,
			expectedSequence: 1,
			type: "owner_acknowledged",
			actor: OWNER,
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
					actor: OWNER,
					reason: "different content",
				}),
			"conflict",
		);
		expectCode(() => append(base, caseId, "action_planned", OWNER, 1), "version_conflict");
	});

	it("rejects a second verdict while the case is not resolved", () => {
		const base = fixture();
		publishFixturePacket(base);
		const messageCount = base.store.messages.listThread("thread:eval-domain").length;
		expectCode(() => publishFixturePacket(base, { id: "verdict-2", findingKey: "review-quality-1" }), "conflict");
		expect(base.store.evals.get("verdict-2")).toBeNull();
		expect(base.store.messages.listThread("thread:eval-domain")).toHaveLength(messageCount);
		expect(existsSync(join(base.dataDir, "evals", "bundles"))).toBe(true);
	});

	it("serializes sequence across two control connections", () => {
		const base = fixture();
		const published = publishFixturePacket(base);
		const caseId = published.case!.caseId;
		const reopened = openControlStore({ dataDir: base.dataDir });
		try {
			const steps: OwnerStep[] = ["owner_acknowledged", "action_planned"];
			let sequence = 1;
			for (const [index, type] of steps.entries()) {
				const store = index % 2 === 0 ? base.store : reopened;
				const event = appendEvalLifecycleEvent(store, {
					caseId,
					expectedSequence: sequence,
					type,
					actor: OWNER,
					reason: `${type}-${index}`,
				}).event;
				expect(event.seq).toBe(sequence + 1);
				sequence += 1;
			}
			expect(getEvalCase(reopened, caseId).events.map((event) => event.seq)).toEqual([1, 2, 3]);
		} finally {
			reopened.close();
		}
	});

	it("requires operator for cvo_suppressed and accept-sunset", () => {
		const base = fixture();
		const published = publishFixturePacket(base);
		const caseId = published.case!.caseId;
		expectCode(() => suppressEvalCase(base.store, { caseId, actor: OWNER, reason: "not operator" }), "forbidden");
		const suppressed = suppressEvalCase(base.store, { caseId, actor: OPERATOR, reason: "accepted risk" });
		expect(suppressed.type).toBe("cvo_suppressed");
		expect(getEvalCase(base.store, caseId).status).toBe("suppressed_with_reason");
	});

	it("keeps delete_sunset awaiting operator accept and never deletes harness files", () => {
		const base = fixture();
		const packet = makeVerdictPacket({
			id: "verdict-sunset",
			findingKey: "sunset-1",
			verdict: "delete_sunset",
			governance: { cvoAcceptRequired: true },
		});
		const published = publishEvalVerdict(base.store, {
			entry: base.entry,
			packet,
			measurement: makeMeasurement(packet),
			actor: EVAL,
		});
		expect(published.case?.awaitingSunsetDecision).toBe(true);
		expect(published.case?.status).toBe("open");
		expect(published.message.bodyMd).toContain("awaiting operator accept");
		expectCode(
			() => acceptSunset(base.store, { caseId: published.case!.caseId, actor: OWNER, reason: "not operator" }),
			"forbidden",
		);
		const accepted = acceptSunset(base.store, {
			caseId: published.case!.caseId,
			actor: OPERATOR,
			reason: "sunset trial accepted",
		});
		expect(accepted.case.status).toBe("resolved");
		expect(accepted.case.awaitingSunsetDecision).toBe(false);
		expect(accepted.message.bodyMd).toContain("no harness files or configuration were deleted");
		expect(base.store.evals.get("verdict-sunset")).not.toBeNull();
	});

	it("marks observation-only verdicts without findingKey and does not create a case", () => {
		const base = fixture();
		const published = publishFixturePacket(base, {
			id: "verdict-observation",
			findingKey: undefined,
			verdict: "keep_observe",
		});
		expect(published.case).toBeNull();
		expect(published.message.bodyMd).toContain("observation report · no finding tracking");
		expect(listEvalCases(base.store)).toHaveLength(0);
	});

	it("requires reasons for non-ok measurements and surfaces them in the message", () => {
		const base = fixture();
		const packet = makeVerdictPacket({
			id: "verdict-insufficient",
			findingKey: undefined,
			verdict: "keep_observe",
		});
		const published = publishFixturePacket(base, packet, { status: "insufficient" });
		expect(published.eval.status).toBe("insufficient");
		expect(published.eval.reasons).toEqual(["n=3 below smoke threshold"]);
		expect(published.message.bodyMd).toContain("Reasons: n=3 below smoke threshold");
		expectCode(
			() =>
				publishFixturePacket(base, packet, {
					status: "insufficient",
					decision: {
						status: "insufficient",
						reasons: ["n=3 below smoke threshold"],
						withdrawalConditions: [],
					},
					actionProposal: { action: "keep_observe", rationale: "fixture" },
				}),
			"invalid_input",
		);
	});

	it("enforces the DB event_type CHECK independently of the service enum", () => {
		const base = fixture();
		const published = publishUnique(base, "verdict-db-check", "db-check");
		expect(() => rawInsert(base, published.case!.caseId, 2, "not_a_real_event", "system", "system:test")).toThrow(
			/CHECK constraint failed/,
		);
	});

	it("rejects secrets and unknown governance flags before writing anything", () => {
		const base = fixture();
		expectCode(
			() => publishFixturePacket(base, { id: "verdict-secret", phenomenon: "leaked AKIAABCDEFGHIJKLMNOP" }),
			"forbidden",
		);
		expect(base.store.evals.get("verdict-secret")).toBeNull();
		expect(base.store.messages.listThread("thread:eval-domain")).toHaveLength(0);
		expectCode(
			() =>
				publishFixturePacket(base, {
					id: "verdict-suppressed",
					governance: { cvoSuppressed: true } as unknown as { cvoAcceptRequired: boolean },
				}),
			"invalid_input",
		);
		expect(base.store.evals.get("verdict-suppressed")).toBeNull();
	});

	it("makes eval_lifecycle_events append-only and keeps review/eval ledgers separate", () => {
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
		append(base, published.case!.caseId, "owner_acknowledged", OWNER, 1);
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
		expect(() =>
			base.store.database.prepare("UPDATE eval_lifecycle_events SET event_type = 'action_planned'").run(),
		).toThrow(/append_only/);
		expect(() => base.store.database.prepare("DELETE FROM eval_lifecycle_events").run()).toThrow(/append_only/);
	});
});
