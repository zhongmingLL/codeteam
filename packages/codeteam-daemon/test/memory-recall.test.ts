import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type MemoryDatabase, openMemoryDatabase } from "../src/memory/database.ts";
import { MemoryIndexer } from "../src/memory/indexer.ts";
import { MemoryRecall } from "../src/memory/recall.ts";

const dirs: string[] = [];
let memory: MemoryDatabase | null = null;

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codeteam-memory-recall-"));
	dirs.push(dir);
	return dir;
}

function write(root: string, relativePath: string, content: string): void {
	const absolute = join(root, relativePath);
	mkdirSync(join(absolute, ".."), { recursive: true });
	writeFileSync(absolute, content);
}

function cleanRoot(): string {
	const root = tempDir();
	write(
		root,
		"docs/features/F001.md",
		`---
title: "Memory evidence"
status: active
tags: [memory]
---

# Memory evidence

The first paragraph explains evidence recall.

记忆回源用于证据召回，并保留 source ref。

## Drill-down

The memory index stores passages and returns source refs for drill-down.
`,
	);
	write(
		root,
		"docs/decisions/001-independent-memory.md",
		`---
title: "Independent memory DB"
status: approved
---

Memory uses an independent database and never ATTACHes the control database.
`,
	);
	return root;
}

afterEach(() => {
	memory?.close();
	memory = null;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function indexed(root: string): { dataDir: string; recall: MemoryRecall } {
	const dataDir = tempDir();
	memory = openMemoryDatabase({ path: join(dataDir, "memory.db") });
	new MemoryIndexer(memory, { root, dataDir, mode: "full" }).run();
	return { dataDir, recall: new MemoryRecall(memory) };
}

describe("memory recall", () => {
	it("returns FTS hits with passage, source ref, drill-down and coverage", () => {
		const root = cleanRoot();
		const { recall } = indexed(root);
		const result = recall.search({ query: "passages" });
		expect(result.items.length).toBe(1);
		const hit = result.items[0]!;
		expect(hit.anchor).toBe("file:docs/features/F001.md");
		expect(hit.passage).toContain("passages");
		expect(hit.source).toMatchObject({
			kind: "file",
			ref: "file:docs/features/F001.md",
			path: "docs/features/F001.md",
		});
		expect(hit.drillDown).toMatchObject({ kind: "file", path: "docs/features/F001.md" });
		expect(hit.match).toBe("fts");
		expect(result.coverage).toMatchObject({
			scope: "indexed_scope_only",
			indexStatus: "fresh",
			degraded: true,
			counts: { evidence: 2, file: 2, control: 0 },
		});
		expect(result.coverage.reasons).toContain("control_db_absent");
	});

	it("falls back to lexical substring matching for short CJK queries and filters by kind", () => {
		const root = cleanRoot();
		const { recall } = indexed(root);
		const short = recall.search({ query: "记忆" });
		expect(short.items[0]?.anchor).toBe("file:docs/features/F001.md");
		expect(short.items[0]?.match).toBe("lexical_fallback");
		const decision = recall.search({ query: "memory", kinds: ["decision"] });
		expect(decision.items.map((hit) => hit.anchor)).toEqual(["file:docs/decisions/001-independent-memory.md"]);
	});

	it("returns an explicit empty result with indexed scope and no fake existence claim", () => {
		const root = cleanRoot();
		const { recall } = indexed(root);
		const result = recall.search({ query: "definitely-not-present-term" });
		expect(result.items).toEqual([]);
		expect(result.coverage.scope).toBe("indexed_scope_only");
		expect(result.coverage.indexStatus).toBe("fresh");
	});

	it("reads an anchor with passages and content, and reports not-indexed with coverage", () => {
		const root = cleanRoot();
		const { recall } = indexed(root);
		const found = recall.read("file:docs/features/F001.md");
		expect(found.found).toBe(true);
		if (!found.found) throw new Error("expected found");
		expect(found.item.title).toBe("Memory evidence");
		expect(found.content).toContain("source refs");
		expect(found.passages.length).toBeGreaterThan(0);
		expect(found.redacted).toBe(false);
		const missing = recall.read("file:docs/features/missing.md");
		expect(missing).toMatchObject({
			found: false,
			anchor: "file:docs/features/missing.md",
			reason: "not_indexed",
		});
		if (!missing.found) expect(missing.coverage.scope).toBe("indexed_scope_only");
	});

	it("marks a hit stale when the file changed after indexing", () => {
		const root = cleanRoot();
		const { recall } = indexed(root);
		write(root, "docs/features/F001.md", "# Memory evidence\n\nCompletely different content about recall.\n");
		const result = recall.search({ query: "memory" });
		const hit = result.items.find((entry) => entry.anchor === "file:docs/features/F001.md");
		expect(hit?.stale).toBe(true);
		expect(hit?.staleReasons).toContain("source_changed");
		const read = recall.read("file:docs/features/F001.md");
		if (!read.found) throw new Error("expected found");
		expect(read.stale).toBe(true);
	});

	it("reports never_run coverage when the memory DB has no index", () => {
		const dataDir = tempDir();
		memory = openMemoryDatabase({ path: join(dataDir, "memory.db") });
		const recall = new MemoryRecall(memory);
		const result = recall.search({ query: "anything" });
		expect(result.items).toEqual([]);
		expect(result.coverage.indexStatus).toBe("never_run");
		expect(result.coverage.degraded).toBe(true);
		expect(result.coverage.reasons).toContain("index_never_run");
	});

	it("redacts secrets again at the read outlet even if they reached the index", () => {
		const root = cleanRoot();
		const { recall } = indexed(root);
		const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
		memory!.database
			.prepare("UPDATE evidence_items SET content = ? WHERE anchor = ?")
			.run(`leaked ${secret}`, "file:docs/features/F001.md");
		const read = recall.read("file:docs/features/F001.md");
		if (!read.found) throw new Error("expected found");
		expect(read.redacted).toBe(true);
		expect(read.redactionFindings).toContain("github_token");
		expect(read.content).not.toContain(secret);
	});
});
