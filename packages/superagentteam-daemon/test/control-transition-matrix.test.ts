import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlError, type ControlStore, openControlStore } from "../src/index.ts";

const NOW = 1_700_000_000_000;
const dirs: string[] = [];
let store: ControlStore;
let now: number;
let sequence: number;

function createBacklog() {
	sequence += 1;
	return store.backlog.create({
		id: `matrix-${sequence}`,
		userId: "user-1",
		title: `Matrix ${sequence}`,
		summary: "transition matrix",
		priority: "p2",
		tags: ["feature:F007"],
		createdByKind: "user",
		createdById: "user-1",
	});
}

function createStatus(status: "open" | "suggested" | "approved" | "dispatched" | "done") {
	const item = createBacklog();
	if (status === "open") return item;
	store.backlog.suggest(item.id, {
		catId: "profile:eval",
		why: "matrix",
		plan: "matrix",
		requestedPhase: "coding",
	});
	if (status === "suggested") return item;
	store.backlog.decideSuggestion(item.id, { decision: "approve", decidedBy: "operator:test" });
	if (status === "approved") return item;
	store.dispatchBacklog({
		backlogItemId: item.id,
		targets: ["profile:eval"],
		threadPhase: "coding",
		dispatchAttemptId: `dispatch:${item.id}`,
		kickoffBody: "matrix",
	});
	if (status === "dispatched") return item;
	return store.backlog.markDone(item.id, "operator:test");
}

type Operation =
	| "suggest-same"
	| "suggest-other"
	| "decide-approve"
	| "decide-reject"
	| "approve"
	| "dispatch-same"
	| "dispatch-other"
	| "markDone"
	| "overrideDone"
	| "overrideNoReason";

function runOperation(itemId: string, operation: Operation) {
	switch (operation) {
		case "suggest-same":
			return store.backlog.suggest(itemId, {
				catId: "profile:eval",
				why: "matrix",
				plan: "matrix",
				requestedPhase: "coding",
			});
		case "suggest-other":
			return store.backlog.suggest(itemId, {
				catId: "profile:compress",
				why: "matrix",
				plan: "matrix",
				requestedPhase: "coding",
			});
		case "decide-approve":
			return store.backlog.decideSuggestion(itemId, { decision: "approve", decidedBy: "operator:test" });
		case "decide-reject":
			return store.backlog.decideSuggestion(itemId, {
				decision: "reject",
				decidedBy: "operator:test",
				note: "matrix reject",
			});
		case "approve":
			return store.backlog.approve(itemId, "operator:test");
		case "dispatch-same":
			return store.dispatchBacklog({
				backlogItemId: itemId,
				targets: ["profile:eval"],
				threadPhase: "coding",
				dispatchAttemptId: `dispatch:${itemId}`,
			});
		case "dispatch-other":
			return store.dispatchBacklog({
				backlogItemId: itemId,
				targets: ["profile:eval"],
				threadPhase: "coding",
				dispatchAttemptId: `other:${itemId}`,
			});
		case "markDone":
			return store.backlog.markDone(itemId, "operator:test");
		case "overrideDone":
			return store.backlog.overrideDone(itemId, "matrix override", "operator:test");
		case "overrideNoReason":
			return store.backlog.overrideDone(itemId, "", "operator:test");
	}
}

interface Case {
	readonly status: "open" | "suggested" | "approved" | "dispatched" | "done";
	readonly operation: Operation;
	readonly outcome: "ok" | "invalid_state" | "conflict" | "invalid_input";
}

const cases: Case[] = [
	{ status: "open", operation: "suggest-same", outcome: "ok" },
	{ status: "open", operation: "decide-approve", outcome: "invalid_state" },
	{ status: "open", operation: "approve", outcome: "ok" },
	{ status: "open", operation: "dispatch-same", outcome: "invalid_state" },
	{ status: "open", operation: "markDone", outcome: "invalid_state" },
	{ status: "open", operation: "overrideDone", outcome: "ok" },
	{ status: "open", operation: "overrideNoReason", outcome: "invalid_input" },
	{ status: "suggested", operation: "suggest-same", outcome: "ok" },
	{ status: "suggested", operation: "suggest-other", outcome: "conflict" },
	{ status: "suggested", operation: "decide-approve", outcome: "ok" },
	{ status: "suggested", operation: "decide-reject", outcome: "ok" },
	{ status: "suggested", operation: "approve", outcome: "invalid_state" },
	{ status: "suggested", operation: "dispatch-same", outcome: "invalid_state" },
	{ status: "suggested", operation: "markDone", outcome: "invalid_state" },
	{ status: "suggested", operation: "overrideDone", outcome: "ok" },
	{ status: "approved", operation: "suggest-same", outcome: "invalid_state" },
	{ status: "approved", operation: "decide-approve", outcome: "invalid_state" },
	{ status: "approved", operation: "approve", outcome: "ok" },
	{ status: "approved", operation: "dispatch-same", outcome: "ok" },
	{ status: "approved", operation: "dispatch-other", outcome: "ok" },
	{ status: "approved", operation: "markDone", outcome: "invalid_state" },
	{ status: "approved", operation: "overrideDone", outcome: "ok" },
	{ status: "dispatched", operation: "suggest-same", outcome: "invalid_state" },
	{ status: "dispatched", operation: "decide-approve", outcome: "invalid_state" },
	{ status: "dispatched", operation: "approve", outcome: "invalid_state" },
	{ status: "dispatched", operation: "dispatch-same", outcome: "ok" },
	{ status: "dispatched", operation: "dispatch-other", outcome: "conflict" },
	{ status: "dispatched", operation: "markDone", outcome: "ok" },
	{ status: "dispatched", operation: "overrideDone", outcome: "ok" },
	{ status: "done", operation: "suggest-same", outcome: "invalid_state" },
	{ status: "done", operation: "decide-approve", outcome: "invalid_state" },
	{ status: "done", operation: "approve", outcome: "invalid_state" },
	{ status: "done", operation: "dispatch-same", outcome: "invalid_state" },
	{ status: "done", operation: "markDone", outcome: "ok" },
	{ status: "done", operation: "overrideDone", outcome: "ok" },
];

beforeEach(() => {
	const dataDir = mkdtempSync(join(tmpdir(), "codeteam-transition-"));
	dirs.push(dataDir);
	now = NOW;
	sequence = 0;
	store = openControlStore({ dataDir, clock: () => now });
	store.seedIdentity({
		eval: { provider: "test", model: "glm-5.3-flash", modelFamily: "glm" },
		compress: { provider: "test", model: "qwen3.8-flash", modelFamily: "qwen" },
	});
});

afterEach(() => {
	store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("backlog transition matrix", () => {
	it.each(cases)("$status + $operation -> $outcome", ({ status, operation, outcome }) => {
		const item = createStatus(status);
		if (outcome === "ok") {
			expect(() => runOperation(item.id, operation)).not.toThrow();
			return;
		}
		let thrown: unknown;
		try {
			runOperation(item.id, operation);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ControlError);
		expect((thrown as ControlError).code).toBe(outcome);
	});
});
