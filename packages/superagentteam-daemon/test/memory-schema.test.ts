import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "../src/memory/database.ts";
import { MemoryError } from "../src/memory/errors.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codeteam-memory-schema-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("memory schema", () => {
	it("opens an independent memory DB with FTS and passage tables", () => {
		const dir = tempDir();
		const memory = openMemoryDatabase({ path: join(dir, "memory.db") });
		try {
			const tables = memory.database
				.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
				.all() as unknown as { name: string }[];
			const names = tables.map((row) => row.name);
			expect(names).toEqual(
				expect.arrayContaining([
					"collections",
					"evidence_items",
					"evidence_fts",
					"evidence_passages",
					"evidence_passage_fts",
					"passage_vectors",
					"index_runs",
					"index_errors",
					"schema_migrations",
				]),
			);
			expect(memory.schemaVersion).toBe(1);
			expect(memory.verifyIsolation()).toEqual({ databaseCount: 1, attached: [] });
		} finally {
			memory.close();
		}
	});

	it("rejects opening a missing memory DB for read-only consumers", () => {
		const dir = tempDir();
		expect(() => openMemoryDatabase({ path: join(dir, "missing.db"), create: false })).toThrowError(MemoryError);
		try {
			openMemoryDatabase({ path: join(dir, "missing.db"), create: false });
		} catch (error) {
			expect((error as MemoryError).code).toBe("memory_unavailable");
			expect((error as MemoryError).details).toMatchObject({ reason: "memory_db_absent" });
		}
	});

	it("keeps external-content FTS in sync for CJK and English writes, updates and deletes", () => {
		const dir = tempDir();
		const memory = openMemoryDatabase({ path: join(dir, "memory.db") });
		try {
			const now = 1_700_000_000_000;
			memory.database
				.prepare(
					"INSERT INTO collections (id, workspace_id, kind, display_name, root, sensitivity, status) VALUES (?, ?, 'project', ?, ?, 'internal', 'active')",
				)
				.run("project:test", "ws-test", "Test", dir);
			memory.database
				.prepare(
					"INSERT INTO evidence_items (anchor, workspace_id, collection_id, kind, status, title, summary, keywords, content, source_kind, source_ref, source_path, source_hash, source_updated_at, provenance_tier, provenance_source, drill_down_json, metadata_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'file', ?, ?, ?, ?, 'authoritative', 'test', ?, '{}', ?)",
				)
				.run(
					"file:docs/features/F001.md",
					"ws-test",
					"project:test",
					"feature",
					"active",
					"记忆回源协议",
					"证据索引与召回",
					"memory evidence",
					"这是关于记忆回源的完整说明，包含 source ref 与 drill down。",
					"file:docs/features/F001.md",
					"docs/features/F001.md",
					"a".repeat(64),
					now,
					JSON.stringify({ kind: "file", sourceRef: "file:docs/features/F001.md", path: "docs/features/F001.md" }),
					now,
				);
			const row = memory.database
				.prepare("SELECT rowid FROM evidence_items WHERE anchor = ?")
				.get("file:docs/features/F001.md") as { rowid: number };
			memory.database
				.prepare(
					"INSERT INTO evidence_passages (passage_id, anchor, ordinal, content, content_hash, created_at) VALUES (?, ?, 0, ?, ?, ?)",
				)
				.run("p1", "file:docs/features/F001.md", "记忆回源的 passage 内容", "b".repeat(64), now);

			const cjk = memory.database
				.prepare("SELECT rowid FROM evidence_fts WHERE evidence_fts MATCH ?")
				.all('"记忆回源"') as unknown as { rowid: number }[];
			expect(cjk.map((entry) => entry.rowid)).toContain(row.rowid);
			const english = memory.database
				.prepare("SELECT rowid FROM evidence_fts WHERE evidence_fts MATCH ?")
				.all("memory") as unknown as { rowid: number }[];
			expect(english.map((entry) => entry.rowid)).toContain(row.rowid);
			const passage = memory.database
				.prepare("SELECT rowid FROM evidence_passage_fts WHERE evidence_passage_fts MATCH ?")
				.all('"passage"') as unknown as { rowid: number }[];
			expect(passage).toHaveLength(1);

			memory.database
				.prepare("UPDATE evidence_items SET title = ? WHERE anchor = ?")
				.run("新的标题", "file:docs/features/F001.md");
			const stale = memory.database
				.prepare("SELECT rowid FROM evidence_fts WHERE evidence_fts MATCH ?")
				.all('"记忆回源协议"') as unknown as { rowid: number }[];
			expect(stale).toHaveLength(0);
			const fresh = memory.database
				.prepare("SELECT rowid FROM evidence_fts WHERE evidence_fts MATCH ?")
				.all('"新的标题"') as unknown as { rowid: number }[];
			expect(fresh.map((entry) => entry.rowid)).toContain(row.rowid);

			memory.database.prepare("DELETE FROM evidence_items WHERE anchor = ?").run("file:docs/features/F001.md");
			expect(memory.database.prepare("SELECT COUNT(*) AS count FROM evidence_passages").get()).toMatchObject({
				count: 0,
			});
			expect(memory.database.prepare("SELECT COUNT(*) AS count FROM evidence_fts").get()).toMatchObject({
				count: 0,
			});
		} finally {
			memory.close();
		}
	});

	it("detects an ATTACH that would create a cross-database read path", () => {
		const dir = tempDir();
		const memory = openMemoryDatabase({ path: join(dir, "memory.db") });
		try {
			memory.database.exec("ATTACH DATABASE ':memory:' AS forbidden");
			expect(() => memory.verifyIsolation()).toThrowError(MemoryError);
			expect(() => memory.verifyIsolation()).toThrowError(/attach/i);
		} finally {
			memory.close();
		}
	});
});
