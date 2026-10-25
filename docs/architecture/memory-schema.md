---
title: "codeteam memory schema（独立 memory.db）"
doc_kind: schema-annex
status: approved
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related_review: reuse-review/memory.md
---

# codeteam memory schema

`memory.db` 是**纯派生 evidence index**，不是 control-plane truth，不放进 `0001 §12.2` 的 control store schema。

- 物理位置：`CODETEAM_DATA_DIR/memory.db`（`CODETEAM_MEMORY_DB`）。
- 锁域：独立 SQLite 文件；**禁止 ATTACH control DB 与 memory DB**；跨库一致性走应用层 join + `source_hash`/stale 标记。
- WAL：`journal_mode=WAL`、`foreign_keys=ON`、busy timeout 引用 `CODETEAM_SQLITE_BUSY_TIMEOUT_MS`。
- 备份：**不进 control DB 备份清单**；删除/rebuild 即恢复。stale 索引不得当 truth 还原。
- 写者：index worker 子进程单写者；daemon 事件循环不跑大扫描/FTS 重建。
- 内容安全：path allowlist + 绝对前缀 hard deny + 内容级 secret 扫描（pattern/entropy）；命中 skip/redact + `index_errors`。

## Tables

部署顺序：`collections` → `evidence_items` → FTS/ passages/vectors → `index_runs`/`index_errors`。`evidence_fts` 用 external-content 时必须配套 insert/update/delete 同步 trigger，以 `evidence_items.rowid` 为 content rowid。

```sql
evidence_items(
  anchor TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('feature','decision','plan','lesson','architecture','thread','session','research','discussion')),
  status TEXT NOT NULL CHECK (status IN ('active','done','archived','review','invalidated','superseded','drifted','stale','historical','retired')),
  title TEXT NOT NULL,
  summary TEXT,
  keywords TEXT,
  content TEXT,
  source_kind TEXT NOT NULL CHECK (source_kind = 'file'),
  source_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  provenance_tier TEXT CHECK (provenance_tier IN ('authoritative','derived','soft_clue')),
  provenance_source TEXT,
  drill_down_json TEXT CHECK (drill_down_json IS NULL OR json_valid(drill_down_json)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  updated_at INTEGER NOT NULL
);

-- FTS5 external-content；若实现改用 contentful FTS，必须在 index_runs 记录 2× storage budget。
evidence_fts USING fts5(
  title, summary, keywords, content,
  content='evidence_items', content_rowid='rowid'
);

evidence_passages(
  passage_id TEXT PRIMARY KEY,
  anchor TEXT NOT NULL REFERENCES evidence_items(anchor) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (anchor, ordinal)
);

passage_vectors(
  passage_id TEXT PRIMARY KEY REFERENCES evidence_passages(passage_id) ON DELETE CASCADE,
  vector_blob BLOB NOT NULL,
  model TEXT NOT NULL,
  model_revision TEXT,
  created_at INTEGER NOT NULL
);

collections(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project')),
  display_name TEXT NOT NULL,
  root TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('internal')),
  status TEXT NOT NULL CHECK (status IN ('active','stale','archived'))
);

index_runs(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind = 'file'),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('indexing','fresh','degraded','interrupted','failed')),
  worker_pid INTEGER,
  source_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  error_summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(error_summary_json))
);

index_errors(
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES index_runs(id) ON DELETE CASCADE,
  source_path TEXT,
  error_kind TEXT NOT NULL CHECK (error_kind IN ('path_denied','secret_redacted','max_file_bytes','parse_error','embedding_unavailable','vector_write_error')),
  detail TEXT,
  at INTEGER NOT NULL
);

CREATE INDEX idx_evidence_workspace_kind ON evidence_items(workspace_id, kind, status);
CREATE INDEX idx_evidence_source ON evidence_items(source_path);
CREATE INDEX idx_evidence_collection ON evidence_items(collection_id);
CREATE INDEX idx_index_runs_latest ON index_runs(workspace_id, started_at DESC);
CREATE INDEX idx_index_errors_run ON index_errors(run_id);
```

## Sync / recovery rules

- v1 `source_kind='file'` only：repo/docs/artifact 文件。thread messages/run_events 需要新的 source connector（`source_kind='message'` + cursor 列），不得用 roots 伪装；见 A3-2 P1-1 处置。
- `evidence_items` + `evidence_fts` + `evidence_passages` 的写/清在**同一 per-source 事务**；崩溃 → `index_runs.status='interrupted'`，按 `source_hash` 增量续扫。
- 单 source hash 未变 → skip；变更 → 删除旧 passages/vectors + 重写，再更新 evidence/row。
- 单文件上限 `CODETEAM_MEMORY_MAX_FILE_BYTES`（默认 512 KiB）；超限 skip + `index_errors.kind='max_file_bytes'`。
- 默认排除 `node_modules|dist|build|.git|target|*.lock|*.min.js|*.map`。
- 内容级 secret 扫描：pattern + entropy；命中整条 skip 或 redact 占位（v1 建议整条 skip + audit），`index_errors.kind='secret_redacted'`；`memory_read` 出口再脱敏一次。
- 换 embedding model = 全量重嵌；`passage_vectors.model`/`model_revision` 变更时先清空 vector 再重建，不混模型。
- `memory_read` not_found 必须带 `coverage=indexed_scope_only` + stale 标志；索引内不存在 ≠ 源不存在。
- FTS 零命中 + stale 同时显示；CLI/MCP 文案两条都保留。

[宪宪/deepseek-flash🐾]
