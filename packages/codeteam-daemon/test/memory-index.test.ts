import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type MemoryDatabase, openMemoryDatabase } from "../src/memory/database.ts";
import { MemoryError } from "../src/memory/errors.ts";
import { MemoryIndexer } from "../src/memory/indexer.ts";
import { memoryLockPath } from "../src/memory/lock.ts";

const dirs: string[] = [];
let memory: MemoryDatabase | null = null;

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codeteam-memory-index-"));
	dirs.push(dir);
	return dir;
}

function write(root: string, relativePath: string, content: string | Buffer): void {
	const absolute = join(root, relativePath);
	mkdirSync(join(absolute, ".."), { recursive: true });
	writeFileSync(absolute, content);
}

function fixtureRoot(): string {
	const root = tempDir();
	write(
		root,
		"docs/features/F001.md",
		`---
title: "Memory evidence"
status: active
tags: [memory, evidence]
---

# Memory evidence

The memory index stores passages for evidence recall and source refs.
`,
	);
	write(
		root,
		"docs/decisions/001-memory.md",
		`---
title: "Independent memory DB"
status: approved
---

Memory uses an independent database and never ATTACHes the control database.
`,
	);
	write(
		root,
		"docs/plans/secret-plan.md",
		`# Secret plan

The token is ghp_abcdefghijklmnopqrstuvwxyz0123456789 and must never be indexed.
`,
	);
	write(root, "docs/features/large.md", `# Large\n\n${"x".repeat(1000)}`);
	write(root, "docs/features/binary.md", Buffer.from([0x23, 0x20, 0x00, 0x41]));
	write(root, "docs/features/.env", "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n");
	write(root, "node_modules/pkg/readme.md", "# ignored\n");
	write(root, "AGENTS.md", "# Project rules\n\nUse isolated data stores.\n");
	return root;
}

afterEach(() => {
	memory?.close();
	memory = null;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("memory indexer", () => {
	it("indexes files, skips secrets and oversize/binary sources, and audits without leaking values", () => {
		const root = fixtureRoot();
		const dataDir = tempDir();
		memory = openMemoryDatabase({ path: join(dataDir, "memory.db") });
		const summary = new MemoryIndexer(memory, {
			root,
			dataDir,
			maxFileBytes: 256,
			mode: "full",
		}).run();
		expect(summary.status).toBe("degraded");
		expect(summary.counts.file).toBe(3); // F001, decision, AGENTS.md
		expect(summary.errorCount).toBe(3);
		const kinds = summary.errors.map((error) => error.errorKind);
		expect(kinds).toContain("secret_redacted");
		expect(kinds).toContain("max_file_bytes");
		expect(kinds).toContain("parse_error");
		expect(summary.errors.find((error) => error.errorKind === "secret_redacted")?.detail).toBe(
			"skipped:github_token",
		);
		const stored = memory.database
			.prepare("SELECT source_ref, content FROM evidence_items ORDER BY source_ref")
			.all() as unknown as { source_ref: string; content: string }[];
		expect(stored.map((row) => row.source_ref)).not.toContain("file:docs/plans/secret-plan.md");
		expect(stored.some((row) => row.content.includes("ghp_"))).toBe(false);
		const audit = memory.database.prepare("SELECT detail FROM index_errors").all() as unknown as { detail: string }[];
		expect(audit.some((row) => row.detail.includes("ghp_"))).toBe(false);
		const passage = memory.database
			.prepare("SELECT content FROM evidence_passage_fts WHERE evidence_passage_fts MATCH ?")
			.all('"passages"') as unknown as { content: string }[];
		expect(passage.length).toBeGreaterThan(0);
		expect(passage[0]!.content).toContain("passages");
		const item = memory.database
			.prepare("SELECT kind, status, title, provenance_tier FROM evidence_items WHERE source_ref = ?")
			.get("file:docs/features/F001.md") as { kind: string; status: string; title: string; provenance_tier: string };
		expect(item).toMatchObject({
			kind: "feature",
			status: "active",
			title: "Memory evidence",
			provenance_tier: "authoritative",
		});
	});

	it("skips unchanged sources incrementally and updates changed sources", () => {
		const root = fixtureRoot();
		const dataDir = tempDir();
		memory = openMemoryDatabase({ path: join(dataDir, "memory.db") });
		const options = { root, dataDir, maxFileBytes: 256 } as const;
		const first = new MemoryIndexer(memory, { ...options, mode: "full" }).run();
		expect(first.sourceCount).toBe(3);
		const second = new MemoryIndexer(memory, { ...options, mode: "incremental" }).run();
		expect(second.sourceCount).toBe(3);
		expect(second.skippedCount).toBe(3);
		write(
			root,
			"docs/features/F001.md",
			`---\ntitle: "Memory evidence v2"\nstatus: active\n---\n\n# Memory evidence v2\n\nNew passages about drill-down.\n`,
		);
		const third = new MemoryIndexer(memory, { ...options, mode: "incremental" }).run();
		expect(third.skippedCount).toBe(2);
		const title = memory.database
			.prepare("SELECT title FROM evidence_items WHERE source_ref = ?")
			.get("file:docs/features/F001.md") as { title: string };
		expect(title.title).toBe("Memory evidence v2");
	});

	it("prunes missing file evidence only in full mode", () => {
		const root = fixtureRoot();
		const dataDir = tempDir();
		memory = openMemoryDatabase({ path: join(dataDir, "memory.db") });
		const options = { root, dataDir, maxFileBytes: 256 } as const;
		new MemoryIndexer(memory, { ...options, mode: "full" }).run();
		rmSync(join(root, "docs/decisions/001-memory.md"));
		const incremental = new MemoryIndexer(memory, { ...options, mode: "incremental" }).run();
		expect(incremental.counts.file).toBe(3);
		const full = new MemoryIndexer(memory, { ...options, mode: "full" }).run();
		expect(full.counts.file).toBe(2);
		const decision = memory.database
			.prepare("SELECT COUNT(*) AS count FROM evidence_items WHERE source_ref = ?")
			.get("file:docs/decisions/001-memory.md") as { count: number };
		expect(decision.count).toBe(0);
	});

	it("rejects a concurrent indexer but recovers a stale lock", () => {
		const root = fixtureRoot();
		const dataDir = tempDir();
		memory = openMemoryDatabase({ path: join(dataDir, "memory.db") });
		const options = { root, dataDir, maxFileBytes: 256 } as const;
		writeFileSync(
			memoryLockPath(memory.path),
			JSON.stringify({ pid: process.pid, startedAt: Date.now(), host: "test" }),
		);
		expect(() => new MemoryIndexer(memory!, { ...options, mode: "full" }).run()).toThrowError(MemoryError);
		try {
			new MemoryIndexer(memory!, { ...options, mode: "full" }).run();
		} catch (error) {
			expect((error as MemoryError).code).toBe("memory_busy");
		}
		writeFileSync(memoryLockPath(memory.path), JSON.stringify({ pid: 999999, startedAt: Date.now(), host: "test" }));
		const summary = new MemoryIndexer(memory, { ...options, mode: "full" }).run();
		expect(summary.status).toBe("degraded");
	});
});
