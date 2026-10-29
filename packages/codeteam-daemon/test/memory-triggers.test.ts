import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type MemoryDatabase, openMemoryDatabase } from "../src/memory/database.ts";
import { MemoryIndexer } from "../src/memory/indexer.ts";
import { MemoryService } from "../src/memory/service.ts";
import { buildTriggerRequest, renderTriggerContext } from "../src/memory/triggers.ts";

const dirs: string[] = [];
let memory: MemoryDatabase | null = null;

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codeteam-memory-trigger-"));
	dirs.push(dir);
	return dir;
}

function write(root: string, relativePath: string, content: string): void {
	const absolute = join(root, relativePath);
	mkdirSync(join(absolute, ".."), { recursive: true });
	writeFileSync(absolute, content);
}

function fixture(): { dataDir: string; service: MemoryService } {
	const root = tempDir();
	write(
		root,
		"docs/features/F012.md",
		"---\ntitle: Memory evidence\ntags: [memory]\n---\n\n# Memory evidence\n\nMemory recall uses source refs and drill-down.\n",
	);
	write(
		root,
		"docs/architecture/001-memory.md",
		"---\ntitle: Independent memory DB\ntags: [memory]\n---\n\n# Independent memory DB\n\nThe memory DB never ATTACHes the control database.\n",
	);
	write(
		root,
		"docs/plans/0014-w6a.md",
		"---\ntitle: W6a plan\ntags: [memory, W6a]\n---\n\n# W6a plan\n\nDeliver memory recall and evidence triggers.\n",
	);
	const dataDir = tempDir();
	memory = openMemoryDatabase({ path: join(dataDir, "memory.db") });
	new MemoryIndexer(memory, { root, dataDir, mode: "full" }).run();
	return { dataDir, service: new MemoryService(memory) };
}

afterEach(() => {
	memory?.close();
	memory = null;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("retrieval triggers", () => {
	it("builds code-only requests with the documented kind sets", () => {
		const impl = buildTriggerRequest("impl", {
			taskTitle: "Memory evidence",
			files: ["src/memory/indexer.ts", "test/memory-recall.test.ts"],
		});
		expect(impl.query).toContain("Memory evidence");
		expect(impl.query).toContain("indexer");
		expect(impl.kinds).toContain("artifact");
		expect(impl.kinds).not.toContain("thread");
		expect(impl.kinds).not.toContain("session");
		expect(impl.limit).toBe(8);
		const review = buildTriggerRequest("review", { taskTitle: "Memory evidence" });
		expect(review.kinds).toEqual(["review", "verification", "feature", "plan", "decision", "lesson"]);
		const merge = buildTriggerRequest("merge", { taskTitle: "Memory evidence" });
		expect(merge.kinds[0]).toBe("merge");
	});

	it("returns cited, bounded context for a trigger", () => {
		const { service } = fixture();
		const result = service.retrieveForTrigger("kickoff", { taskTitle: "Memory evidence" });
		expect(result.trigger).toBe("kickoff");
		expect(result.result.items.length).toBeGreaterThan(0);
		expect(result.contextBlock).toContain("file:docs/features/F012.md");
		expect(result.contextBlock).toContain("Evidence (indexed_scope_only");
		expect(result.contextBlock.length).toBeLessThanOrEqual(6000);
		expect(result.request.kinds).not.toContain("thread");
	});

	it("keeps empty results explicit with coverage and never claims absence of the source", () => {
		const { service } = fixture();
		const result = service.retrieveForTrigger("verify", { taskTitle: "definitely-not-present-term" });
		expect(result.result.items).toEqual([]);
		expect(result.contextBlock).toContain("no indexed evidence in scope");
		expect(result.contextBlock).toContain("indexStatus=");
	});

	it("bounds a large context block", () => {
		const result = {
			query: "x",
			items: Array.from({ length: 20 }, (_, index) => ({
				anchor: `file:docs/${index}.md`,
				kind: "feature" as const,
				status: "active" as const,
				title: `Doc ${index}`,
				summary: "summary",
				passage: "x".repeat(500),
				score: 1,
				match: "fts" as const,
				source: {
					kind: "file" as const,
					ref: `file:docs/${index}.md` as `file:${string}`,
					path: `docs/${index}.md`,
					sha256: "a".repeat(64),
					updatedAt: 1,
				},
				drillDown: { kind: "file" as const, sourceRef: `file:docs/${index}.md`, path: `docs/${index}.md` },
				stale: false,
				staleReasons: [],
			})),
			coverage: {
				workspaceId: "ws",
				collectionId: "project:ws",
				scope: "indexed_scope_only" as const,
				indexRunId: "run",
				indexedAt: 1,
				indexStatus: "fresh" as const,
				stale: false,
				degraded: false,
				reasons: [],
				counts: { evidence: 20, file: 20, control: 0 },
			},
		};
		const block = renderTriggerContext(result, 500);
		expect(block.length).toBeLessThanOrEqual(500);
	});
});
