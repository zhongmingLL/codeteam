import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlLogStore } from "../src/observability/logs.ts";
import { createRedactor } from "../src/observability/redaction.ts";

const dirs: string[] = [];
const redactor = createRedactor({ salt: "log-test-salt" });

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(
	options: { maxBytes?: number; maxRotatedFiles?: number; retentionDays?: number; now?: () => number } = {},
) {
	const dataDir = mkdtempSync(join(tmpdir(), "codeteam-logs-"));
	dirs.push(dataDir);
	return new JsonlLogStore({ dataDir, redactor, ...options });
}

describe("W6c JSONL logs", () => {
	it("writes owner-only JSONL and tails in chronological order", () => {
		const logs = store();
		logs.append("info", "run.started", { runId: "run-1" });
		logs.append("warn", "run.retry", { runId: "run-1", attempt: 2 });
		logs.append("error", "run.failed", { runId: "run-1", error: "boom" });
		const result = logs.tail({ limit: 2 });
		expect(result.entries).toHaveLength(2);
		expect(result.entries.map((entry) => entry.event)).toEqual(["run.retry", "run.failed"]);
		expect(result.truncated).toBe(true);
		expect(logs.stats().fileCount).toBe(1);
		if (process.platform !== "win32") expect(statSync(logs.path).mode & 0o777).toBe(0o600);
		logs.close();
	});

	it("redacts credentials and content before writing", () => {
		const logs = store();
		logs.append("info", "tool.finished", {
			authorization: "Bearer secret",
			body_md: "raw body",
			diff: "diff --git a/a b/a",
			runId: "run-1",
		});
		const entries = logs.tail().entries;
		expect(entries[0]?.fields.authorization).toBe("[REDACTED]");
		expect(entries[0]?.fields.body_md).toMatch(/^\[content:sha256:/);
		expect(entries[0]?.fields.diff).toMatch(/^\[content:sha256:/);
		expect(entries[0]?.fields.runId).toBe("run-1");
		const raw = readFileSync(logs.path, "utf8");
		expect(raw).not.toContain("Bearer secret");
		expect(raw).not.toContain("raw body");
		logs.close();
	});

	it("rotates by size and keeps only maxRotatedFiles", () => {
		const logs = store({ maxBytes: 1024, maxRotatedFiles: 2 });
		for (let index = 0; index < 40; index += 1) {
			logs.append("info", "test.event", { index, padding: "x".repeat(80) });
		}
		const names = readdirSync(logs.dir).sort();
		expect(names).toContain("daemon.log");
		expect(names).toContain("daemon.log.1");
		expect(names).toContain("daemon.log.2");
		expect(names).not.toContain("daemon.log.3");
		expect(logs.tail({ limit: 1000 }).entries.length).toBeGreaterThan(0);
		logs.close();
	});

	it("prunes rotated files by retention", () => {
		const logs = store({ maxBytes: 512, maxRotatedFiles: 3, retentionDays: 1 });
		for (let index = 0; index < 10; index += 1) {
			logs.append("info", "retention.event", { index, padding: "x".repeat(100) });
		}
		const rotated = join(logs.dir, "daemon.log.1");
		const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
		utimesSync(rotated, old, old);
		logs.prune();
		expect(() => statSync(rotated)).toThrow();
		logs.close();
	});

	it("filters by level and rejects invalid event names", () => {
		const logs = store();
		logs.append("debug", "debug.event");
		logs.append("error", "error.event");
		expect(logs.tail({ level: "error" }).entries.map((entry) => entry.event)).toEqual(["error.event"]);
		expect(() => logs.append("info", "Bad Event")).toThrowError("invalid_log_event: Bad Event");
		logs.close();
	});
});
