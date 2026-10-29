import { afterEach, describe, expect, it } from "vitest";
import { openControlStore } from "../src/index.ts";
import { createW5AFixture, type W5AFixture } from "./helpers/w5a-fixture.ts";

const fixtures: W5AFixture[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function fixture(): W5AFixture {
	const created = createW5AFixture();
	fixtures.push(created);
	return created;
}

describe("W6c tool usage counters", () => {
	it("increments exactly once per run_events.id", () => {
		const base = fixture();
		const first = base.store.toolUsage.record({
			eventId: "event-1",
			runId: "run-1",
			profileId: "profile:coder",
			toolName: "bash",
		});
		const replay = base.store.toolUsage.record({
			eventId: "event-1",
			runId: "run-1",
			profileId: "profile:coder",
			toolName: "bash",
		});
		expect(first).toEqual({ recorded: true, count: 1 });
		expect(replay).toEqual({ recorded: false, count: 1 });
		expect(base.store.toolUsage.report({ days: 1 }).summary.totalCalls).toBe(1);
	});

	it("classifies native, mcp, and skill tools and aggregates reports", () => {
		const base = fixture();
		base.store.toolUsage.record({
			eventId: "event-1",
			runId: "run-1",
			profileId: "profile:coder",
			toolName: "bash",
			at: Date.parse("2026-10-27T10:00:00.000Z"),
		});
		base.store.toolUsage.record({
			eventId: "event-2",
			runId: "run-1",
			profileId: "profile:coder",
			toolName: "mcp__fs__read",
			at: Date.parse("2026-10-27T10:05:00.000Z"),
		});
		base.store.toolUsage.record({
			eventId: "event-3",
			runId: "run-2",
			profileId: "profile:reviewer-a",
			toolName: "Skill",
			toolInput: { skill: "tdd" },
			at: Date.parse("2026-10-28T09:00:00.000Z"),
		});
		const report = base.store.toolUsage.report({ from: "2026-10-27", to: "2026-10-28" });
		expect(report.summary.totalCalls).toBe(3);
		expect(report.summary.byCategory).toEqual({ native: 1, mcp: 1, skill: 1 });
		expect(report.topTools).toEqual(
			expect.arrayContaining([
				{ name: "bash", category: "native", count: 1 },
				{ name: "mcp__fs__read", category: "mcp", count: 1 },
				{ name: "tdd", category: "skill", count: 1 },
			]),
		);
		expect(report.daily).toEqual([
			{ date: "2026-10-27", native: 1, mcp: 1, skill: 0 },
			{ date: "2026-10-28", native: 0, mcp: 0, skill: 1 },
		]);
		expect(report.byProfile["profile:coder"]).toEqual({ native: 1, mcp: 1, skill: 0 });
		expect(report.byProfile["profile:reviewer-a"]).toEqual({ native: 0, mcp: 0, skill: 1 });
	});

	it("filters by profile and category and honors UTC day boundaries", () => {
		const base = fixture();
		base.store.toolUsage.record({
			eventId: "event-1",
			runId: "run-1",
			profileId: "profile:coder",
			toolName: "bash",
			at: Date.parse("2026-10-27T23:59:59.000Z"),
		});
		base.store.toolUsage.record({
			eventId: "event-2",
			runId: "run-1",
			profileId: "profile:coder",
			toolName: "mcp__fs__read",
			at: Date.parse("2026-10-28T00:00:01.000Z"),
		});
		const filtered = base.store.toolUsage.report({
			from: "2026-10-27",
			to: "2026-10-28",
			profileId: "profile:coder",
			category: "mcp",
		});
		expect(filtered.summary.totalCalls).toBe(1);
		expect(filtered.summary.byCategory).toEqual({ native: 0, mcp: 1, skill: 0 });
		const days = base.store.toolUsage.report({ from: "2026-10-27", to: "2026-10-28" });
		expect(days.daily).toEqual([
			{ date: "2026-10-27", native: 1, mcp: 0, skill: 0 },
			{ date: "2026-10-28", native: 0, mcp: 1, skill: 0 },
		]);
	});

	it("prunes counters and dedupe events by retention", () => {
		const base = fixture();
		base.store.toolUsage.record({
			eventId: "old-event",
			runId: "run-1",
			profileId: "profile:coder",
			toolName: "bash",
			at: Date.parse("2023-01-01T00:00:00.000Z"),
		});
		base.store.toolUsage.record({
			eventId: "new-event",
			runId: "run-1",
			profileId: "profile:coder",
			toolName: "bash",
			at: base.now(),
		});
		const pruned = base.store.toolUsage.prune(30);
		expect(pruned.counters).toBe(1);
		expect(pruned.events).toBe(1);
		expect(base.store.toolUsage.report({ days: 0 }).summary.totalCalls).toBe(1);
	});

	it("applies retention when the control store is reopened", () => {
		const base = fixture();
		base.store.toolUsage.record({
			eventId: "old-event",
			runId: "run-1",
			profileId: "profile:coder",
			toolName: "bash",
			at: Date.parse("2023-01-01T00:00:00.000Z"),
		});
		const reopened = openControlStore({ dataDir: base.dataDir, clock: () => base.now() });
		try {
			expect(reopened.toolUsage.report({ days: 0 }).summary.totalCalls).toBe(0);
		} finally {
			reopened.close();
		}
	});

	it("rejects an inverted report window", () => {
		const base = fixture();
		expect(() => base.store.toolUsage.report({ from: "2026-10-29", to: "2026-10-28" })).toThrowError(
			expect.objectContaining({ code: "invalid_input" }),
		);
	});
});
