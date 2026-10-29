---
title: "codeteam memory schema（独立 memory.db）"
doc_kind: schema-annex
status: approved
created: 2026-10-25
updated: 2026-10-29
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related_review: reuse-review/memory.md
---

# codeteam memory schema

`memory.db` 是**纯派生 evidence index**，不是 control-plane truth，不放进
`0001 §12.2` 的 control store schema。

- 物理位置：`CODETEAM_DATA_DIR/memory.db`（`CODETEAM_MEMORY_DB`）。
- 锁域：独立 SQLite 文件；**禁止 ATTACH control DB 与 memory DB**；跨库一致性走
  应用层 join + `source_hash`/stale 标记。`openMemoryDatabase` 在打开和索引收口
  时检查 `PRAGMA database_list`，发现非 `main`/`temp` 连接即 fail closed。
- WAL：`journal_mode=WAL`、`foreign_keys=ON`、busy timeout 引用
  `CODETEAM_SQLITE_BUSY_TIMEOUT_MS`。
- 备份：**不进 control DB 备份清单**；删除/rebuild 即恢复。stale 索引不得当 truth
  还原。
- 写者：`codeteam memory index` 独立进程单写者；`memory.db.lock` 记录 PID +
  startedAt；daemon 事件循环不跑大扫描/FTS 重建。
- 内容安全：path allowlist + 绝对前缀 hard deny + 内容级 secret 扫描
  （pattern/entropy）；命中 skip/redact + `index_errors`；`read`/`recall`/`digest`
  出口再脱敏一次。`metadata_json` 是派生元数据；artifact `provenance_json` 写入前
  redact，W7 read API surfacing 前必须再过 redact 或显式 raw 语义。

> **W6a v2 delta（2026-10-29）。** 在 2026-10-25 approved v1 上做 additive 扩展：
> ① `source_kind` 增加 `control`，承载 task/artifact/review/verification/merge
> 的派生投影；② `kind` 增加对应类型；③ 新增 `source_ref`/`source_updated_at`；
> ④ 新增 `evidence_passage_fts`；⑤ `index_runs` 增加 `mode`/`skipped_count`，
> `source_kind` 增加 `control|mixed`。v1 的 file-only 语义仍成立；control 投影
> 不改变 canonical truth，thread messages/run_events 仍不进入本 store。

> **Review/merge.** W6a P2/P3 修复在 `aeeb1420a` 由墨墨/砚砚复核通过；PR #62
> 于 `c82b0679c` 合入 `codeteam-work`。

## Tables

部署顺序：`collections` → `evidence_items` → FTS/ passages/vectors →
`index_runs`/`index_errors`。FTS 使用 external-content + insert/update/delete
同步 trigger，以 `rowid` 为 content rowid；tokenizer 用 `trigram`，让中文子串和
英文词都能走 BM25。

```sql
collections(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project')),
  display_name TEXT NOT NULL,
  root TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('internal')),
  status TEXT NOT NULL CHECK (status IN ('active','stale','archived'))
);

evidence_items(
  anchor TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN (
    'feature','decision','plan','lesson','architecture','thread','session','research','discussion',
    'task','artifact','review','verification','merge'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'active','done','archived','review','invalidated','superseded','drifted','stale','historical','retired'
  )),
  title TEXT NOT NULL,
  summary TEXT,
  keywords TEXT,                        -- U+001F separated; legacy whitespace accepted on read
  content TEXT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('file','control')),
  source_ref TEXT NOT NULL,              -- file:<repo-relative-path> | task:<id> | artifact:<id> | ...
  source_path TEXT,                      -- file only; NULL for control
  source_hash TEXT NOT NULL,
  source_updated_at INTEGER,
  provenance_tier TEXT CHECK (provenance_tier IN ('authoritative','derived','soft_clue')),
  provenance_source TEXT,
  drill_down_json TEXT CHECK (drill_down_json IS NULL OR json_valid(drill_down_json)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  updated_at INTEGER NOT NULL,
  CHECK ((source_kind = 'file' AND source_path IS NOT NULL) OR (source_kind = 'control' AND source_path IS NULL)),
  UNIQUE (workspace_id, source_kind, source_ref)
);

evidence_fts USING fts5(
  title, summary, keywords, content,
  content='evidence_items', content_rowid='rowid',
  tokenize='trigram'
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

evidence_passage_fts USING fts5(
  content,
  content='evidence_passages', content_rowid='rowid',
  tokenize='trigram'
);

passage_vectors(
  passage_id TEXT PRIMARY KEY REFERENCES evidence_passages(passage_id) ON DELETE CASCADE,
  vector_blob BLOB NOT NULL,
  model TEXT NOT NULL,
  model_revision TEXT,
  created_at INTEGER NOT NULL
);

index_runs(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('file','control','mixed')),
  mode TEXT NOT NULL CHECK (mode IN ('full','incremental')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('indexing','fresh','degraded','interrupted','failed')),
  worker_pid INTEGER,
  source_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  error_summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(error_summary_json))
);

index_errors(
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES index_runs(id) ON DELETE CASCADE,
  source_path TEXT,
  error_kind TEXT NOT NULL CHECK (error_kind IN (
    'path_denied','secret_redacted','max_file_bytes','parse_error','embedding_unavailable','vector_write_error'
  )),
  detail TEXT,
  at INTEGER NOT NULL
);

CREATE INDEX idx_evidence_workspace_kind ON evidence_items(workspace_id, kind, status);
CREATE INDEX idx_evidence_source ON evidence_items(source_kind, source_ref);
CREATE INDEX idx_evidence_collection ON evidence_items(collection_id);
CREATE INDEX idx_index_runs_latest ON index_runs(workspace_id, started_at DESC);
CREATE INDEX idx_index_errors_run ON index_errors(run_id);
```

## Sync / recovery rules

- `source_kind='file'`：repo docs/ADRs/plan/feature/lesson/architecture/research/
  discussion（`docs/**/*.md` + root `AGENTS.md`/`CODETEAM.md`/`README.md`/
  `UPSTREAM.md`/`KERNEL_GAPS.md`）。thread messages/run_events 仍需要新的 source
  connector（`source_kind='message'` + cursor 列），不得用 roots 伪装。
- `source_kind='control'`：只读 `CODETEAM_DATA_DIR/control.db`，投影
  `tasks/artifacts/reviews/verifications/merges`；`source_ref` 是
  `task:<id>`/`artifact:<id>`/`review:<id>`/`verification:<id>`/`merge:<id>`，
  `drill_down_json` 给 table+id。control truth 仍在 W1/W5 canonical tables；
  memory 不写 control DB，也不复制 control row 为第二 truth。
- `evidence_items` + FTS + `evidence_passages` 的写/清在**同一 per-source 事务**；
  崩溃 → `index_runs.status='interrupted'`，按 `source_hash` 增量续扫。
- 单 source hash 未变 → skip；变更 → 删除旧 passages/vectors + 重写，再更新
  evidence/row。`full` 模式只 prune 本次成功扫描 scope 内未出现的 anchor；
  control DB 不可用时**不 prune** control evidence。
- 单文件上限 `CODETEAM_MEMORY_MAX_FILE_BYTES`（默认 512 KiB）；超限 skip +
  `index_errors.kind='max_file_bytes'`。
- 默认排除 `node_modules|dist|build|.git|target|*.lock|*.min.js|*.map` 以及
  `.env*|*.pem|*.key|*.p12|*.pfx|id_rsa*|credentials*|secrets*`。
- 内容级 secret 扫描：pattern + entropy；命中整条 skip 或 redact 占位（默认
  skip），`index_errors.kind='secret_redacted'`；detail 只记 pattern 名，不记值；
  `memory_read`/`memory_recall`/`memory_digest` 出口再脱敏一次；artifact
  `provenance_json` 进 `metadata_json` 前也 redact。
- 换 embedding model = 全量重嵌；`passage_vectors.model`/`model_revision` 变更时
  先清空 vector 再重建，不混模型。v1 不写 vector，不伪造 semantic 命中。
- `memory_read` not_found 必须带 `coverage=indexed_scope_only` + stale 标志；
  索引内不存在 ≠ 源不存在。
- `keywords` 用 U+001F 分隔以保留含空格的 keyword；读取对 legacy whitespace 回退。
- `digest` 是即时 canonical 投影，不写 memory.db；其 `verifications[].command`、
  `task.title`/`why` 同属 redaction 出口。CLI `recall`/`digest` 的 not-found 是
  成功查询（exit 0），调用方必须读 JSON `coverage`/`found`。
- FTS 零命中 + stale 同时显示；CLI/MCP 文案两条都保留。

[宪宪/deepseek-flash🐾]
