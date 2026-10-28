---
title: "W6a Memory / Evidence 回源：实施计划与契约冻结"
doc_kind: plan
status: active
created: 2026-10-29
updated: 2026-10-29
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [墨墨 (Qwen 3.8 Flash), 砚砚 (GLM 5.3 Flash)]
---

# W6a Memory / Evidence 回源

> 来源：`docs/plans/0004-w5-w8-scale-product.md` §W6 6A/6A.1；
> dispatch `0001793205127887-003820-89a2ea80`；基线
> `codeteam-work @ 6ac622ad0`。
>
> 本切片只交付可测试的 in-process service + CLI 边界。W7 read API/Console、
> 6B Eval/Outcome、6E Observability/Trajectory、6C lessons/decisions、
> 6D cue plane 不在本切片；它们消费本文件冻结的 evidence/source-ref 契约。

## 1. Goal

让 codeteam agent 在正确时机拿到**可回源**的项目证据，而不是把历史对话塞进
上下文：

- 索引 repo docs/ADRs/plan/feature，以及 control-plane 的
  task/artifact/review/verification/merge receipt。
- 每条 recall 都带 canonical `sourceRef`、drill-down 坐标、freshness/coverage。
- 空结果只说明“索引范围内没有”，不说明“源不存在”。
- 独立 `memory.db`，可删除/重建；不成为第二 truth store，也不阻塞 control plane。

## 2. Scope

### 2.1 In scope（本切片）

- `packages/codeteam-daemon/src/memory/`：独立 memory DB、schema、index worker、
  file/control evidence adapter、FTS5/BM25 passage recall、source ref/drill-down、
  coverage/degraded/stale、session digest、6 个 retrieval trigger、redaction。
- `codeteam memory` CLI：`index | status | recall | read | digest | trigger`。
- 冻结 `EvidenceSourceRef` / `EvidenceItem` / `EvidenceHit` / `Coverage` 契约。
- 对应 vitest 与 CLI 测试。

### 2.2 Out of scope（明确不做）

- 6B Eval/Outcome；6F Harness Eval（W6b）。
- 6E Observability/Trajectory + F150/F130（W6c）。
- 6C lessons/decisions 的 propose/defer/abstain 写面；本切片只读索引既有 lesson doc。
- 6D cue plane / context presentation / graph。
- 个人记忆、diary/dream、person/relationship、跨项目偏好。
- thread messages / run_events 的对外 evidence scope（需要 connector；本切片只在
  session digest 中按 canonical control 数据即时读取，不写入 memory.db）。
- W7 read API / Console / 事件重放。

## 3. Frozen contract v1

> 这是 W6b/W6c 可消费的最小契约。实现文件：
> `packages/codeteam-daemon/src/memory/contract.ts`。修改以下字段/语义必须同时
> 更新 W6b/W6c consumer 与本文件；不得在 adapter 内私自定义第二种形状。

### 3.1 EvidenceSourceRef

```ts
type EvidenceSourceKind = "file" | "control";

type FileEvidenceSourceRef = {
  kind: "file";
  ref: `file:${string}`;        // file:<repo-relative-path>, POSIX separators
  path: string;                 // repo-relative path
  sha256: string;               // sha256 of the indexed bytes
  updatedAt: number;            // source mtime (epoch ms)
};

type ControlEvidenceSourceRef = {
  kind: "control";
  ref: `task:${string}` | `artifact:${string}` | `review:${string}`
     | `verification:${string}` | `merge:${string}`;
  table: "tasks" | "artifacts" | "reviews" | "verifications" | "merges";
  id: string;
  sha256: string;               // sha256 of the canonical row projection
  updatedAt: number;            // canonical row updated_at/created_at
};

type EvidenceSourceRef = FileEvidenceSourceRef | ControlEvidenceSourceRef;
```

- `ref` 是跨 W6b/W6c 的 join key；**不是** anchor。`anchor` 是 memory DB 内部
  primary key，当前等于 `ref` 的稳定派生（见 §4）。
- `control` source 的 truth 仍在 W1/W5 canonical tables；memory 只存派生投影。
- 不允许把 control row 的整行 JSON 作为 `ref`；`ref` 只含表名语义 + id。

### 3.2 EvidenceItem / EvidenceHit / Coverage

```ts
type EvidenceKind =
  | "feature" | "decision" | "plan" | "lesson" | "architecture"
  | "thread" | "session" | "research" | "discussion"
  | "task" | "artifact" | "review" | "verification" | "merge";

type EvidenceStatus =
  | "active" | "done" | "archived" | "review" | "invalidated"
  | "superseded" | "drifted" | "stale" | "historical" | "retired";

type ProvenanceTier = "authoritative" | "derived" | "soft_clue";

interface EvidenceItem {
  anchor: string;
  kind: EvidenceKind;
  status: EvidenceStatus;
  title: string;
  summary: string | null;
  keywords: string[];
  provenanceTier: ProvenanceTier;
  source: EvidenceSourceRef;
  drillDown: EvidenceDrillDown;
  updatedAt: number;
}

interface EvidenceHit {
  anchor: string;
  kind: EvidenceKind;
  status: EvidenceStatus;
  title: string;
  summary: string | null;
  passage: string;              // bounded, redacted at the outlet
  score: number;                // higher is better; normalized ordering only
  match: "fts" | "lexical_fallback";
  source: EvidenceSourceRef;
  drillDown: EvidenceDrillDown;
  stale: boolean;
  staleReasons: string[];       // source_missing | source_changed | control_unavailable
}

interface Coverage {
  workspaceId: string;
  collectionId: string;
  scope: "indexed_scope_only";
  indexRunId: string | null;
  indexedAt: number | null;
  indexStatus: "fresh" | "degraded" | "interrupted" | "failed" | "indexing" | "never_run";
  stale: boolean;
  degraded: boolean;
  reasons: string[];            // index_never_run | index_in_progress | index_degraded
                                // | index_failed | control_db_absent | memory_db_absent
  counts: { evidence: number; file: number; control: number };
}
```

- `Coverage` 必须随 `recall` / `read` / `trigger` 返回；空结果不得省略。
- `stale` 是 source 级 freshness；`degraded` 是索引/数据源能力级信号。二者可同时为真。
- 命中 secret 的内容在出口再次脱敏；`EvidenceHit.passage` 与 `read` 的 `content`
  必须是出口安全文本。

### 3.3 EvidenceDrillDown

```ts
type EvidenceDrillDown =
  | { kind: "file"; sourceRef: string; path: string; line?: number }
  | { kind: "control"; sourceRef: string; table: ControlTable; id: string };
```

- file drill-down 的 `path` 是 repo-relative；调用方用 workspace root 拼绝对路径。
- control drill-down 只给表 + id；调用方用 canonical control store 读取，不读 memory
  DB 冒充 truth。

### 3.4 Retrieval triggers

固定六值；只注入 code-related context：

```ts
type RetrievalTrigger = "kickoff" | "design" | "impl" | "review" | "verify" | "merge" | "completion";
```

| Trigger | 注入意图 | 主要 kinds |
|---|---|---|
| kickoff | 项目约定、相关历史 task、已知坑 | feature, plan, decision, architecture, lesson, task, merge |
| design | 架构/决策、受影响模块 | architecture, decision, plan, feature, lesson |
| impl | 当前文件、相关测试、最近 diff、编码约定 | architecture, decision, plan, feature, lesson, task, artifact |
| review | acceptance criteria、impact surface、历史 finding 模式 | review, verification, feature, plan, decision, lesson |
| verify | 验收命令、环境约束、回归样本 | verification, review, artifact, plan, feature |
| merge | 风险清单、rollback 方案 | merge, review, verification, plan, feature, artifact |
| completion | 交付证据、剩余差距 | task, artifact, merge, review, verification, feature, plan, lesson |

- `trigger` 只决定 kinds/query 组合，不新增 evidence store；空结果同样带 coverage。
- `buildTriggerRequest()` 是纯函数，可单测；`MemoryService.retrieveForTrigger()` 负责
  recall + 有界 context block。

## 4. Storage（独立 memory.db）

物理位置：`CODETEAM_MEMORY_DB`，默认 `CODETEAM_DATA_DIR/memory.db`。

- 独立 SQLite 文件；**禁止 ATTACH control DB**；control 通过只读连接 + 应用层
  join。
- 不进 control backup；删除/rebuild 即恢复。
- `journal_mode=WAL`、`foreign_keys=ON`、busy timeout 复用
  `CODETEAM_SQLITE_BUSY_TIMEOUT_MS`。
- 单写者：`memory.db` 旁的 `memory.lock`（PID + startedAt）；并发 index 返回
  `memory_busy`；死 PID 自动清理并把残留 `indexing` run 标为 `interrupted`。
- 写者边界：`codeteam memory index` 是独立进程入口；daemon/W7 只 spawn 它，不在
  事件循环里跑扫描。
- v1 一个 memory DB 对应一个 workspace/collection；`anchor` 是 sourceRef 的单 workspace
  命名。多 workspace 需要 anchor 命名空间（未来 migration）；W6b/W6c 用 `sourceRef`
  而不是 `anchor` 做 join。

Schema v2（相对 `docs/architecture/memory-schema.md` 的增量）：

- `evidence_items.source_kind IN ('file','control')`；新增 `source_ref`、
  `source_updated_at`；`source_path` 仅 file 必填。
- `evidence_items.kind` 增加 `task|artifact|review|verification|merge`。
- `evidence_fts` 使用 `tokenize='trigram'`（CJK 子串可用）；FTS external-content
  同步 trigger 必须齐全。
- 新增 `evidence_passage_fts`（external content on `evidence_passages`，trigram），
  支持 passage 级召回。
- `index_runs.source_kind IN ('file','control','mixed')`；新增 `skipped_count`。
- `passage_vectors` 保留为未来 embedding 槽位；v1 不写 vector，不伪造 semantic。

## 5. Adapters

### 5.1 File adapter

- 扫描 root：`docs/**/*.md` + root `AGENTS.md`、`CODETEAM.md`、`README.md`、
  `UPSTREAM.md`、`KERNEL_GAPS.md`（存在才扫）。
- kind 由路径推断：features→feature、decisions→decision、plans→plan、
  lessons→lesson、architecture→architecture、research→research、
  discussions→discussion、reuse/reports/upstream→architecture/research；
  root 文档→architecture。
- status 读 frontmatter `status`；title 读 frontmatter `title` / 首个 `# ` /
  文件名；summary 读 frontmatter `summary` / 首段；keywords 读 frontmatter
  `tags|keywords`。
- provenance tier：decision/architecture/feature→authoritative；
  plan/lesson→derived；discussion/research/report→soft_clue。
- 每个文件按 heading/段落切 passage（默认 1200 chars，150 overlap）；空内容也
  保留 1 个 passage，避免 read 无内容。
- 默认排除：`node_modules|dist|build|target|.git|.worktrees`、`*.lock`、
  `*.min.js`、`*.map`、`.env*`、`*.pem|*.key|*.p12|*.pfx`、`id_rsa*`、
  `credentials*`、`secrets*`。

### 5.2 Control adapter

只读 `CODETEAM_DATA_DIR/control.db`（`readOnly: true`）；不存在则 file-only，
coverage 标 `control_db_absent`。

| Table | kind | 投影内容 | status |
|---|---|---|---|
| tasks | task | title/why/status/related_feature_id/repo/risk/lane | todo/doing→active, blocked→review, done→done |
| artifacts | artifact | metadata + 文本内容（可读且通过 redaction） | active |
| reviews | review | verdict/headSha/reviewer model/findings claims/required actions | approve→done, changes_requested/blocked→review |
| verifications | verification | status/reason/command/exit code/stdout_tail/stderr_tail | confirmed→done, rejected→invalidated, blocked→review |
| merges | merge | base/head/merge SHA/policy/receipt/status | succeeded→done, failed→invalidated, unknown→review |

- 不索引 thread messages / run_events（deferred）。session digest 需要时按 canonical
  control 数据即时读取。
- control source hash = canonical projection 的 sha256；`updatedAt` 取 row 的
  `updated_at` 或 `created_at`。
- 不新增 control migration；只读现有 W1/W5 schema。

## 6. Index worker & freshness

- `MemoryIndexer.run({ mode: 'full' | 'incremental' })`：
  1. 获取 lock；恢复残留 `indexing` run → `interrupted`。
  2. 插入 `index_runs(status='indexing')`。
  3. 扫 file scope（若 root 存在）与 control scope（若 DB 存在）。
  4. 每 source 一个事务：path/secret/size 检查 → skip+`index_errors`，或写
     `evidence_items` + `evidence_passages`；hash 未变且增量 → skip。
  5. full 模式只 prune 本次成功扫描 scope 内未出现的 anchor；control DB 不可用
     时**不 prune** control evidence。
  6. 收口 `fresh`（0 error）或 `degraded`（有 error）；fatal → `failed`。
- `index_errors.kind`：`path_denied|secret_redacted|max_file_bytes|parse_error|
  embedding_unavailable|vector_write_error`。detail 只记 pattern 名/行号/原因，
  **绝不记 secret 值**。
- `status` 返回 latest run、counts、collection、stale/degraded 原因。

## 7. Recall & trigger injection

- `MemoryRecall.search({ query, kinds?, limit?, trigger? })`：
  - FTS5 `bm25()` 排序；trigram 查询失败或短查询（<3 chars）→ `instr` lexical
    fallback，并标 `match: 'lexical_fallback'`。
  - 每个 hit 选最佳 passage：passage FTS 优先，否则 `instr`，否则首 passage。
  - 逐 hit 检查 source freshness：file hash/mtime；control row 仍存在且 hash 未变。
    control DB 不可用 → `control_unavailable`，不伪造 stale。
  - 返回 bounded hits + `Coverage`。
- `MemoryRecall.read(anchor)`：
  - 返回 item + passages + coverage；不存在 → `{ found:false, coverage }`。
  - 出口再次 redaction；`redacted: true` + pattern names。
- `MemoryService.retrieveForTrigger()`：
  - `buildTriggerRequest()` 组合 query/kinds；recall；生成有界 `contextBlock`
    （默认 ≤ 6000 chars，含 `sourceRef` 与标题，不塞全文）。
  - context block 只含 code evidence；不引入个人记忆。

## 8. Redaction & path policy

- 内容级 secret 扫描：pattern + entropy。v1 命中**整条 source skip**（默认），
  可用 `--redact-secrets` 选择 redact 占位；两种都写 `index_errors`。
- 出口 redaction：`read`/`recall` 返回前再扫一次，防旧索引/边缘漏网。
- 绝对前缀 deny：默认 `$HOME/.ssh`、`$HOME/.aws`、`$HOME/.gnupg`、
  `$HOME/.config`、`$HOME/.cat-cafe`、`$HOME/.codeteam/auth`、`/etc`、`/proc`、
  `/sys`、`/dev`；可用 `CODETEAM_MEMORY_DENY_PREFIXES`（`path.delimiter` 分隔）
  追加。
- root containment：`realpath` 后必须仍在 collection root / artifact root 内；
  symlink 逃逸 → `path_denied`。
- max file bytes：`CODETEAM_MEMORY_MAX_FILE_BYTES`（默认 512 KiB）。
- 索引与出口都不把 secret 值写进 `index_errors`、日志或 recall 结果。

## 9. Session digest

- `buildSessionDigest({ runId } | { sessionId })` 只读 control DB：
  run/session/task/messages/run_events/reviews/verifications/merges。
- 输出：task 坐标、role/provider/model、status/timing、event counts、bounded event
  summaries（≤200）、review/verification/merge refs、`sourceRefs`、coverage。
- digest 是即时投影，不写入 memory.db；thread messages/run_events 仍不作为对外
  evidence scope。
- 不可用 control DB → `{ found:false, coverage degraded }`，不猜。

## 10. AC mapping

| AC | 验收结果 | 验证 |
|---|---|---|
| AC-1 独立 memory DB | `CODETEAM_MEMORY_DB` 生效；无 ATTACH；control DB 不被写；删除 memory.db 可 rebuild | schema/open 测试 + ATTACH 拒绝测试 |
| AC-2 代码 evidence adapter | file 与 control 七类 source 都有 canonical `sourceRef`；不新建 truth store | index 测试断言 ref/table/id/hash |
| AC-3 FTS/BM25 + passages | 中英文查询命中；passage 级 recall；BM25 排序；短查询 fallback | recall 测试 |
| AC-4 source ref + drill-down | 每个 hit 有 sourceRef + drillDown；read 按 anchor 返回 passages | recall/read 测试 |
| AC-5 coverage/degraded/stale | 空结果带 `indexed_scope_only`；无索引/索引中/失败/control 缺失都有原因；source 变更标 stale | coverage 测试 |
| AC-6 6 个 retrieval trigger | 六 trigger 的 kinds/query/context block 正确；只含 code evidence | trigger 测试 |
| AC-7 secret redaction + path deny | pattern/entropy 命中 skip+audit；绝对前缀 deny；出口二次脱敏 | redaction 测试 |
| AC-8 session digest | run/session digest 有 task/events/reviews/merges + sourceRefs | digest 测试 |
| AC-9 CLI 边界 | `memory index/status/recall/read/digest/trigger` 可运行、JSON 稳定 | CLI 测试 |
| AC-10 契约冻结 | contract.ts 导出、计划文档 §3 与实现一致；W6b/W6c 可直接 import | 文档 + typecheck |

## 11. Test plan

新增：

- `test/memory-schema.test.ts` — DB open/migrations/ATTACH deny/FTS triggers。
- `test/memory-redaction.test.ts` — secret patterns/entropy/path deny/outlet redact。
- `test/memory-index.test.ts` — file index/incremental/max bytes/passages/prune。
- `test/memory-control.test.ts` — tasks/artifacts/reviews/verifications/merges。
- `test/memory-recall.test.ts` — FTS/fallback/passage/stale/coverage/read not_found。
- `test/memory-triggers.test.ts` — six triggers + bounded context block。
- `test/memory-digest.test.ts` — run/session digest。
- `test/cli-memory.test.ts` — CLI index/status/recall/read/digest/trigger。

命令：

```bash
NODE_ENV=development npm --prefix packages/codeteam-daemon test
npx tsc --noEmit -p tsconfig.json
npx biome check packages/codeteam-daemon/src/memory packages/codeteam-daemon/test/memory-*.test.ts packages/codeteam-daemon/src/cli/memory.ts
```

## 12. Risks / rollback

- **P1 第二 truth store**：memory.db 只存派生投影；control/file 仍是 truth；
  `sourceRef` 可回源；删除 memory.db 不丢 control 数据。回滚 = 删除 memory.db +
  CLI 子命令。
- **P1 secret 泄漏**：索引 skip + 出口 redaction + index_errors 不记值；path deny
  默认关闭 home 敏感前缀。
- **P2 stale 当 current**：每次 recall 计算 coverage + per-hit stale；文案明确
  `indexed_scope_only`。
- **P2 control DB 读锁**：只读连接 + busy timeout；control 不可用降级为 file-only。
- **P2 index 阻塞 daemon**：CLI 独立进程 + lock；daemon 不内联扫描。
- **回滚**：删除 `memory.db`/`memory.db-wal`/`memory.db-shm` 与 `memory.lock`；
  不触碰 control.db。

## 13. Review routing

- 墨墨：memory/reuse/真实路径 review（adapter 是否覆盖真实 docs/control 路径、
  recall 是否可用、coverage 文案）。
- 砚砚：provenance/redaction review（sourceRef 是否可回源、path deny/secret
  skip/出口 redaction、control 只读边界）。
- 作者不审自己；P1/P2 修复后由提出 finding 的 active source 覆盖。
