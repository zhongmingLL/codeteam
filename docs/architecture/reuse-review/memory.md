---
title: "memory 架构复用检视"
doc_kind: architecture-review
status: approved
operator_signoff: "DP-MEM-1=A, DP-MEM-2=A, DP-MEM-3=A (2026-10-25)"
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
source_cell: memory
source_card: ../../reuse/memory.md
template: ../0004-reuse-architecture-review-plan.md
---

# memory 架构复用检视

## 1. 总结

| 项 | 结论 |
|---|---|
| clowder feature 范围 | F102（IEvidenceStore/IIndexBuilder/SqliteEvidenceStore/FTS/passage）、F152（scanner/bootstrap）、F209（passage recall/entity anchor/drill-down/Perspective）、F186/F188（collection/library 形状）、F263（lifecycle traces/metrics）、F211（session digest 作为 evidence source）。 |
| codeteam 复用总结 | **R1 file-evidence subset**。复用 evidence/index/search/drill-down 契约；v1 只索引 repo/docs/artifact 文件；thread messages/run_events、个人记忆、proactive、cue、diary、taste、event memory 全部 out-of-scope 或 defer。 |
| codeteam W | W6（project evidence/index/recall）；W7（只读 Console/CLI 投影）。 |
| 一句话 | codeteam memory 是“项目文件证据索引”，不是个人记忆；索引只读、可重建、可降级，空结果不等于不存在。 |
| 明确不含 | thread messages/run_events（defer→W6+，需 source connector）、F276 people relationship、F282 proactive memory、F287 cue plane、F255 auto-dream/diary、F271 reflection、F221 taste、F227 event memory、F231 profile primer、F321 memory sky、跨项目/跨租户私有数据。 |

**组件立场**

| 组件 | 立场 | codeteam 处理 |
|---|---|---|
| `IEvidenceStore` / `IIndexBuilder` / `RepoScanner` | `reuse now` | 契约与字段对齐；SQLite 实现适配 codeteam data dir |
| `EvidenceItem` / `EvidenceKind` / `EvidenceStatus` / `Provenance` | `reuse now` | anchor/kind/status/provenance/drillDown 保留；不把 cat/person 身份塞进 evidence |
| `SqliteEvidenceStore` FTS5/passage/vector | `adapt now` | 独立 memory DB；FTS 必选，vector 可选；不可用降级 lexical 并标注 |
| F152 scanner/bootstrap | `adapt now` | 只扫 codeteam repo/docs/evidence；不导入外部项目私有数据 |
| F209 passage/drill-down | `adapt now` | 只做 file evidence passage/drill-down；entity anchor/Perspective `defer→W6+`；不接 person/relationship identity |
| F186/F188 collection/library | `defer` | v1 只保留 project collection 最小形状；library federation W6+ |
| F263 lifecycle traces/metrics | `adapt now` | 只读质量/覆盖率指标；不进入 evidence search/ranking |
| F276/F282/F287/F255/F271/F221/F227/F231/F321 | `drop` | 个人/主动/私密/反思/品味/事件/画像记忆不进 codeteam |
| F211 session digest | `reuse now` | 作为只读 evidence source；runtime binding 仍归 identity-session |
| 第二套 memory store | `forbidden` | 只有 `memory.db` 一套 evidence store；不按 feature 建平行库 |

## 2. clowder 架构

### 2.1 架构图

```text
docs / repo / messages / session digest
        │  scanner discovery
        ▼
IIndexBuilder (IndexBuilder)
  ├─ parse frontmatter / passages
  ├─ entity mention extraction
  ├─ evidence_fts + passage_fts
  └─ optional passage_vectors
        │
        ▼
SqliteEvidenceStore (IEvidenceStore)
  ├─ search / searchWithMeta
  ├─ lexical BM25 + optional semantic NN
  ├─ provenance / coverage / degraded flags
  └─ drillDown → read_file_slice / session / perspective
        │
        ├─ KnowledgeResolver / collections (F186)
        ├─ PerspectiveRunner (F209)
        └─ memory lifecycle metrics (F263)

F287 cue plane / F276 person / F282 proactive / F255 diary
  └─ separate owners; memory may project but never owns their truth
```

### 2.2 数据流

1. **Index**：scanner 决定 scan root（CatCafe docs vs generic repo）；`IndexBuilder` 解析文档、passages、entity mentions，写 FTS 与可选 vectors；source hash 绑定文件版本。
2. **Search**：`SqliteEvidenceStore.searchWithMeta` 先 lexical BM25，再可选 semantic NN/entity anchor；返回 `EvidenceItem` + matchReason/rankingFactors/retrievalScore + drillDown；失败/缺 embedding 时 `degraded=true`，不伪造成语义命中。
3. **Drill**：结果带 typed drill-down（file slice / thread / session / perspective）；读取受 workspace/owner/collection 权限约束；不把摘要当原文。
4. **Collections**：F186 collection scope / sensitivity；library/global 搜索只返回允许的 collection；private collection 不进入公共 search。
5. **Metrics**：F263 lifecycle traces 记录 zero-hit/verification/attention 等，只读、不进入 ranking；F200 recall metrics 可消费。
6. **Cue plane**：F287 只在 execution time 投影 bounded cue；codeteam v1 不启用。

### 2.3 状态机 / 生命周期

**A. Evidence status**

```text
active ──supersede──► superseded
  │
  ├──archive──► archived
  ├──invalidate──► invalidated
  ├──drift──► drifted
  ├──stale──► stale
  └──review──► review ──► active / archived
```

- status 是证据生命周期，不是索引状态；索引重建不得改 evidence 语义 status。
- `sourceHash` 变化 → 重新索引；旧 passage/vector 清理在同一事务。

**B. Index run**

```text
idle ──start──► indexing ──success──► fresh
  │                 │
  │                 ├──partial failure──► degraded（保留旧 fresh 数据 + error）
  │                 └──crash────────────► stale / interrupted（启动恢复）
  └──operator rebuild──► indexing
```

- 索引失败不删除旧索引；读面标注 stale/degraded。
- 同一 workspace 单写者；索引任务不阻塞 control plane。

**C. Search degradation**

```text
lexical + semantic available ──► hybrid
embedding unavailable ─────────► lexical + degraded=true
index unavailable ─────────────► memory_unavailable（调用方回退到 repo/file read）
```

### 2.4 关键数据结构

```ts
// packages/api/src/domains/memory/interfaces.ts:34,48,50,92,270,387,428
type EvidenceKind = 'feature' | 'decision' | 'plan' | 'session' | 'lesson' | 'thread' | 'discussion' | 'research' | 'architecture' | 'diary' | 'pack-knowledge';
type EvidenceStatus = 'active' | 'done' | 'archived' | 'review' | 'invalidated' | 'superseded' | 'drifted' | 'stale' | 'historical' | 'retired';
interface EvidenceItem { anchor: string; kind: EvidenceKind; status: EvidenceStatus; title: string; summary?: string; sourcePath?: string; sourceHash?: string; provenance?: Provenance; drillDown?: EvidenceDrillDown; ... }
interface SearchOptions { query: string; scope?: 'docs'|'memory'|'threads'|'sessions'|'all'; mode?: 'lexical'|'semantic'|'hybrid'; depth?: 'summary'|'raw'; collections?: string[]; ... }
interface IEvidenceStore { search(...); searchWithMeta(...); ... }
interface IIndexBuilder { rebuild(...); index(...); ... }
```

### 2.5 Current truth 与代码路径

| # | 事实 | 代码锚点 |
|---|---|---|
| T1 | evidence/index 契约在 `interfaces.ts`；`EvidenceItem` 有 anchor/kind/status/provenance/drillDown | `packages/api/src/domains/memory/interfaces.ts:34`、`:48`、`:50`、`:92`、`:387`、`:428` |
| T2 | `SqliteEvidenceStore` 实现 search/searchWithMeta；FTS5 BM25 + passage/vector；降级标记 | `packages/api/src/domains/memory/SqliteEvidenceStore.ts:163`、`:298`、`:431` |
| T3 | `IndexBuilder` 扫描 docs/repo/passages/entity mentions；rebuild/索引任务 | `packages/api/src/domains/memory/IndexBuilder.ts:171`、`:308` |
| T4 | `CatCafeScanner` / `GenericRepoScanner` 是 scanner 策略 | `packages/api/src/domains/memory/CatCafeScanner.ts:46`、`:60`；`packages/api/src/domains/memory/GenericRepoScanner.ts:55`、`:56` |
| T5 | F209 passage recall/entity anchor/drill-down/Perspective 复用同一 evidence path | `packages/api/src/routes/perspectives.ts:47`、`:80`；`packages/api/src/domains/memory/interfaces.ts:270` SearchOptions |
| T6 | F263 lifecycle traces 是 append-only shadow table，storable:false/indexable:false | `docs/features/F263-memory-lifecycle-repair-and-metrics.md`；`LifecycleTraceStore.ts` |
| T7 | F287 cue plane 是独立 execution-time 投影，不是第二 MemoryStore | `docs/architecture/memory-cue-source-map.md`；`packages/api/src/domains/memory/cue/MemoryCueEpisodeStore.ts` |
| T8 | F276 private person 不进入 workspace/global evidence；F282 proactive 不写 canonical truth | `docs/architecture/ownership/cells/memory.md` Do NOT Unify With |
| T9 | F211 transcript/digest 是 memory 的上游 evidence source，runtime binding 归 identity-session | `docs/architecture/ownership/cells/memory.md` Canonical Owner |
| T10 | codeteam 0001 当前没有 memory 表；A3-2 是首个 evidence schema | `codeteam/architecture/0001-codeteam-architecture-v1.md` §12.2（无 memory 表） |

### 2.5.1 上游已知缺口 → 本卡处置

| # | 上游缺口 | 影响 | 本卡处置 |
|---|---|---|---|
| G1 | clowder evidence DB 与 control-plane 可能同进程/同库 | 大扫描阻塞 custody | codeteam 独立 `memory.db`；索引任务不拿 control DB 写锁 |
| G2 | semantic recall 依赖 embedding provider | 无 provider 时能力下降 | vector 可选；lexical-first；degraded 显式 |
| G3 | scanner 假设 docs/ 结构 | 外部 repo 可能无 docs | `GenericRepoScanner` 适配；scan root 明确；不扫 home/secret |
| G4 | F276/F282/F287 等个人/主动记忆混在同一 cell | 范围回流 | v1 白名单 + drop 表；person/diary/proactive 永不进 codeteam |
| G5 | F263 lifecycle traces 可能被误当 search result | 污染 ranking | `storable:false/indexable:false`；只读 metrics |
| G6 | 空结果被当 absence proof | 误判“没有” | 结果带 coverage/degraded；CLI/MCP 明确“仅覆盖已索引范围” |
| G7 | collection/library 联邦复杂 | W6 范围膨胀 | v1 只做 project collection；library 延后 |
| G8 | 索引 stale | 读到旧证据 | index run/freshness + stale warning；operator reindex |

## 3. codeteam 架构

### 3.1 架构图

```text
codeteam repo / docs / artifact files
        │  explicit file roots + allowlist + absolute-prefix deny
        ▼
MemoryIndexer (worker subprocess, single writer)
  ├─ scanner: codeteam docs | generic repo
  ├─ parse anchors/frontmatter/passages
  ├─ content-level secret scan → skip/redact + audit
  ├─ FTS5 + optional vectors
  └─ index_runs / index_errors
        │  separate SQLite DB (CODETEAM_MEMORY_DB)
        ▼
memory_search / memory_read (read-only)
  ├─ scope: project files only
  ├─ lexical-first; optional semantic
  ├─ coverage/degraded/stale flags
  └─ drillDown: file slice only（message/session defer→W6+）
        │
        ▼
Console W7 / CLI / MCP read-only projection
```

### 3.2 数据流

1. **Index**：operator/daemon 触发 `memory index`；只扫 `CODETEAM_MEMORY_ROOTS`（默认 repo/docs/artifact 文件），按 `$HOME`/`/etc`/credentials 绝对前缀 hard deny，拒绝 `.git` 内部对象；内容级 secret 扫描命中即 skip/redact + audit；每个 file source 计算 hash，变化才重索引。v1 `source_kind='file'` only；thread messages/run_events 需要新 source connector，不能靠 roots 伪装。
2. **Store**：独立 `CODETEAM_MEMORY_DB`；表集见 `codeteam/architecture/memory-schema.md`；全部可 rebuild，不是 control-plane truth。禁 ATTACH control/memory 跨库 join；跨库一致性走应用层 join + source_hash/stale。
3. **Search**：`memory_search(query, scope=project_files|all, mode=lexical|semantic|hybrid, depth=summary|raw)`；默认 lexical；semantic 只在 `CODETEAM_MEMORY_EMBEDDING_ENABLED=1` 且 provider 可用时启用；请求 `mode='semantic'` 但 embedding 关闭或 provider 失败 → lexical 结果 + `degraded=semantic_unavailable`（不 422）；返回 coverage/degraded/stale/drillDown。
4. **Read**：`memory_read(anchor)` 只返回 bounded file slice；不返回 secrets；路径必须在 allowlist；anchor not_found 带 `coverage=indexed_scope_only` + stale 标志（索引内不存在 ≠ 源不存在）。
5. **Freshness**：`index_runs` 记录 start/end/status/sourceCount/errorCount/worker；读面若最后一次成功 run 超过 `CODETEAM_MEMORY_STALE_MS`，结果带 `stale_index=true`，不阻塞读取。index 跑在 worker 子进程，daemon 事件循环不跑大扫描/FTS 重建。
6. **Failure**：DB busy/unavailable → `memory_unavailable`；向量不可用 → `degraded=lexical_only`；空结果 → `coverage=indexed_scope_only`，不说“不存在”；零命中 + stale 两条都显示。
7. **No write-back**：agent 不能通过 memory tool 写 evidence；operator/daemon 只跑 index/rebuild；F276/F282/F287 不进入。lesson/decision 走仓库文档文件被索引，不走 agent 写 memory。

### 3.3 状态机 / 生命周期

**A. Index run**

```text
idle ──start──► indexing ──success──► fresh
  │                 │
  │                 ├──partial failure──► degraded（旧索引保留 + index_errors）
  │                 └──crash────────────► interrupted（启动恢复/重跑）
  └──operator rebuild──► indexing
```

**B. Evidence freshness**

```text
fresh ──sourceHash changed──► pending_reindex ──index success──► fresh
  │
  └──stale threshold──► stale（读仍可用，带 warning）
```

**C. Search mode**

```text
lexical ──embedding available──► hybrid
   │               │
   │               └──vector failure──► lexical + degraded
   └──index unavailable──► memory_unavailable
```

### 3.4 关键数据结构与存储

| clowder | codeteam | 立场 | 关键差异 |
|---|---|---|---|
| `EvidenceItem` | `evidence_items` | `reuse now` | anchor/kind/status/title/summary/sourcePath/sourceHash/provenance |
| `IEvidenceStore.search` | `memory_search` | `adapt now` | scope=project；coverage/degraded/stale 显式 |
| `IIndexBuilder` | `MemoryIndexer` | `adapt now` | 只读 index/rebuild；不写 control DB |
| FTS5 + passage | `evidence_fts` + `evidence_passages` | `reuse` | lexical-first；vector 可选 |
| F186 collections | `collections` | `defer` | v1 单 project collection |
| F263 lifecycle traces | read-only metrics | `adapt` | 不进入 search/ranking |
| F209 Perspective | `perspective_run` read-only | `defer→W6+` | 先做 search/drill-down；Perspective 后接 |
| F287 cue plane | none | `drop` | 不在 execution time 注入 cue |

**W6 schema annex（独立 memory.db，不进 0001 §12.2）**

- 全量 DDL、字段/CHECK/索引、FTS 同步、index worker、redaction 与 recovery 规则见 `codeteam/architecture/memory-schema.md`。
- `0001 §12.2` 只留一行指针：memory 是独立派生索引，不在 control store；实现者不得把 evidence 表建进 control DB。
- v1 `source_kind='file'`：repo/docs/artifact 文件。thread messages / run_events 不在 v1；需要新 source connector + cursor 列，不能靠 roots 伪装。
- `evidence_items` 有 `workspace_id`/`collection_id`/`kind CHECK`/`provenance_tier CHECK`/`drill_down_json`；`evidence_fts` 用 external-content，避免正文双份存储。
- 禁 ATTACH control/memory 跨库 join；跨库一致性走应用层 join + `source_hash`/stale。
- memory.db 不进 control 备份清单；WAL；删除/rebuild 即恢复。

### 3.5 变量定义表

#### contract

| 变量 | 类型 | 默认/值域 | owner | clowder 来源 | 决定 | 说明 |
|---|---|---|---|---|---|---|
| `EvidenceAnchor` | TEXT | stable | memory | `EvidenceItem.anchor` | `reuse` | 证据门牌号；不是球/任务 ID |
| `EvidenceKind` | enum | code evidence subset | memory | `packages/api/src/domains/memory/interfaces.ts:34` | `adapt` | v1 只用 feature/decision/plan/lesson/architecture/thread/session 等；message passage 走 thread/session anchor；diary/pack-knowledge 不写 |
| `EvidenceStatus` | enum | active/.../retired | memory | `packages/api/src/domains/memory/interfaces.ts:50` | `reuse` | 生命周期状态；index 不改语义 |
| `Provenance` | object | tier/source | memory | `interfaces.ts` | `reuse` | authoritative/derived/soft_clue |
| `SearchScope` | enum | project_files/all | memory | `SearchOptions` | `adapt` | v1 不含 library/global/private/threads；threads defer→W6+ |
| `SearchMode` | enum | lexical/semantic/hybrid | memory | `SearchOptions` | `adapt` | lexical-first；semantic/hybrid 可选；不可用降级 lexical + degraded |
| `Coverage` | object | indexed scope/degraded/stale | memory | `SearchEvidence` meta | `codeteam-new` | 空结果诚实边界 |
| `DrillDown` | object | tool/params/hint | memory | `EvidenceDrillDown` | `reuse` | v1 只文件 slice；message/session drill-down defer→W6+ |

#### state

| 变量 | 状态机/约束 | owner | 失败语义 |
|---|---|---|---|
| `evidence_items.status` | active→superseded/archived/invalidated/drifted/stale | memory | 非法迁移拒绝；不自动删除 |
| `evidence_items.source_hash` | 变化→pending reindex | memory | stale warning；不返回旧内容为 current |
| `index_runs.status` | indexing→fresh/degraded/interrupted/failed | memory | 失败保留旧索引；读面 degraded |
| `passage_vectors` | optional；model 绑定 | memory | 缺 vector → lexical + degraded |
| `collections.sensitivity` | v1 只 internal/project | memory | 非 project → 403；schema CHECK 只允许 internal |
| `index_errors` | append-only per run | memory | 只读诊断；不进 search |

#### config

| 变量 | 默认 | owner | 决定 | 说明 |
|---|---|---|---|---|
| `CODETEAM_MEMORY_DB` | `${CODETEAM_DATA_DIR}/memory.db` | memory | `new` | 独立 evidence DB |
| `CODETEAM_MEMORY_ROOTS` | repo + docs | memory | `new` | 逗号分隔 allowlist；拒绝 home/credentials |
| `CODETEAM_MEMORY_INDEX_INTERVAL_MS` | 300000 | memory | `new` | 周期增量索引；0=只手动 |
| `CODETEAM_MEMORY_STALE_MS` | 900000 | memory | `new` | 读面 stale warning 阈值 |
| `CODETEAM_MEMORY_MAX_RESULTS` | 50 | memory | `new` | search 上限 |
| `CODETEAM_MEMORY_EMBEDDING_ENABLED` | 0 | memory | `new` | 0=lexical-only；1=hybrid（需 provider） |
| `CODETEAM_MEMORY_INDEX_CONCURRENCY` | 1 | memory | `new` | 单写者；避免 SQLite 写冲突 |
| `CODETEAM_MEMORY_INDEX_WORKER` | 1 | memory | `new` | index 跑 worker 子进程，隔离 daemon 事件循环 |
| `CODETEAM_MEMORY_MAX_FILE_BYTES` | 524288 | memory | `new` | 单文件上限；超限 skip + index_errors |
| `CODETEAM_MEMORY_EXCLUDE` | node_modules/dist/build/.git/target/*.lock | memory | `new` | 默认排除清单 |
| `CODETEAM_SQLITE_BUSY_TIMEOUT_MS` | 见 plans/0002 W1 | 全局 | `reference` | memory DB 自己用同一 busy timeout；不阻塞 control DB |

#### security

| 变量/规则 | 值/来源 | owner | 失败语义 |
|---|---|---|---|
| `workspaceScope` | 只搜当前 workspace/project | memory | 跨 tenant/项目 → 403/空结果 |
| `pathAllowlist` | `CODETEAM_MEMORY_ROOTS` + repo root；`$HOME`/`/etc`/credentials 绝对前缀 hard deny | memory | 越界路径 → 拒绝索引/读取；不用文件名 pattern |
| `secretRedaction` | path + payload 双层：不索引 `.env`/token/credential/home；内容 pattern/entropy 命中 → skip/redact + audit；memory_read 出口再脱敏 | memory | 内容命中 → skip/redact + index_errors |
| `privateMemoryExcluded` | F276/F255/F282/F287 不在 v1 | memory | 请求 private/person scope → 404/422 |
| `readOnlyTools` | `memory_search`/`memory_read` 只读 | memory | agent 写 memory → 403 |
| `coverageHonesty` | 空结果只代表索引范围 | memory | 不返回“不存在”断言 |
| `collectionSensitivity` | v1 project only | memory | 越级 collection → 403 |

#### observability

| 变量/事件 | 值/来源 | owner | 说明 |
|---|---|---|---|
| `memory_index_run` | index_runs；workspace/run/status/source/error | memory | 每次 index |
| `memory_index_duration_ms` | histogram | memory | index 性能 |
| `memory_index_errors_total` | counter/kind | memory | 扫描/解析失败 |
| `memory_index_worker_restarts_total` | counter | memory | worker 崩溃/重启 |
| `memory_index_budget_exhausted_total` | counter | memory | 分片时间预算耗尽 |
| `memory_search_latency_ms` | histogram | memory | query 性能 |
| `memory_search_zero_hit_total` | counter/scope/mode | memory | 零命中观察 |
| `memory_search_degraded_total` | counter/reason | memory | vector unavailable 等 |
| `memory_stale_reads_total` | counter | memory | stale warning 次数 |
| `memory_coverage_ratio` | gauge | memory | indexed vs eligible sources |

### 3.6 明确不做

- 不做个人记忆/关系/人物 dossier（F276）。
- 不做 proactive/reflection/cue/diary/taste/event memory/profile/memory sky（F282/F271/F287/F255/F221/F227/F231/F321）。
- 不做 thread messages/run_events 索引（defer→W6+；需要 control-DB/export source connector + cursor）。
- 不做 entity mention/Perspective（defer→W6+；v1 只 passage/drill-down）。
- 不做 recall consumption trace（defer→W6+；F263/F200 消费归因后接）。
- 不做 agent 写 memory；只读 search/read。
- 不做 library/global/collection federation（v1 project only）。
- 不做第二套 evidence store；`memory.db` 是唯一 evidence index。
- 不把空结果当 absence proof；不把 stale 当 current。
- 不索引 home/credentials/secret/跨项目私有数据。

### 3.7 DP-MEM-1：v1 memory 范围

| 选项 | 行为 | 取舍 |
|---|---|---|
| **A（推荐）** | file-evidence subset：repo/docs/artifact 文件；thread messages/run_events defer→W6+；个人/主动/私密记忆全 drop | 与 codeteam 代码交付目标一致；W6 可控；隐私面最小；无假承诺 |
| B | 全量 memory：person/proactive/cue/diary/taste/event | 复用面最大；但把 codeteam 变成第二套家庭记忆，隐私/维护成本高 |

### 3.8 DP-MEM-2：memory DB 位置

| 选项 | 行为 | 取舍 |
|---|---|---|
| **A（推荐）** | 独立 `CODETEAM_MEMORY_DB` + index worker 子进程；禁 ATTACH；不进备份 | 文件锁 + 事件循环都隔离；可单独删除/重建 |
| B | 与 control SQLite 同库 | 少一个文件；但 FTS/scan 大事务会与 handoff/approval 抢写锁 |

### 3.9 DP-MEM-3：写路径

| 选项 | 行为 | 取舍 |
|---|---|---|
| **A（推荐）** | 只做 index/rebuild，operator/daemon 触发；agent 只读；lesson/decision 走仓库文件被索引 | 简单、可重建；没有 reflection/proactive 的权限与隐私面 |
| B | 加 reflection/proactive 写入 | 更接近 clowder memory；但需要 F271/F282/F287 的 privacy/lifecycle，W6 放不下 |

## 4. 风险与回滚

| 风险 | 级别 | 处置 |
|---|---|---|
| 个人/主动记忆范围回流 | P1 | v1 白名单 + DP-MEM-1=A；review 拒绝新增 private scope |
| memory DB 阻塞 control plane | P1 | 独立 DB + index worker 子进程 + 单写者 + busy timeout；不共享写锁/事件循环 |
| semantic provider 不可用 | P2 | lexical-first + degraded；不伪装 hybrid |
| 索引 stale 被当 current | P2 | index_runs/freshness + stale warning |
| 空结果被当不存在 | P1 | coverage/indexed_scope_only；调用方回退 repo read |
| secret/越界路径被索引 | P1 | roots allowlist + 绝对前缀 deny + 内容级 redaction + audit；memory_read 出口再脱敏 |
| collection/library 范围膨胀 | P2 | v1 project only；library W6+ |

**回滚**：删除 `memory.db` + 关闭 memory tools/index 即回到无 memory 基线；不影响 control-plane 表。个人/主动记忆从未写入。

## 5. Review 与签字

> Review request `347b68e0-8bf0-4b30-873d-597505cc8fd6`（2026-10-25，三猫）。结论：烁烁 accept；砚砚/墨墨 accept-with-modify。P1-1 已收窄为文件源；P2/P3 已回写。Operator 2026-10-25 拍 `DP-MEM-1=A`、`DP-MEM-2=A`、`DP-MEM-3=A`。

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | evidence/index/scanner、SQLite/FTS、index freshness | accept；P2 schema 归属 + P3×4 已回写（schema annex、禁 ATTACH、FTS 同事务、semantic 降级、绝对前缀 deny） |
| 砚砚 | privacy/tenant、path/secret redaction、no personal memory | accept-with-modify；P2 内容级 redaction 已回写；P3×5 已回写（kind CHECK、exclude/size、备份/WAL、read caveat、entity defer） |
| 墨墨 | operator 可见 recall、coverage/drill-down、W7 投影 | accept-with-modify；P1 源类假承诺已收窄为文件源；P2×3 已回写（内容 redaction、worker、schema 列）；P3×5 已回写 |
| operator | DP-MEM-1/2/3 | 已签：A/A/A（2026-10-25） |

**Findings disposition**

| # | 来源 | Finding | 处置 |
|---|---|---|---|
| P1-1 | 墨墨 | 声称索引 thread messages/run artifacts，但唯一摄取是文件 roots；threads scope 会恒空 | **已修**：v1 收窄为 file-evidence subset；threads/run_events defer→W6+；DP-MEM-1 文本同步 |
| P2 | 烁烁 | memory 表写进 0001 §12.2，与独立 memory.db 矛盾 | **已修**：schema 移到 `architecture/memory-schema.md`；0001 §12.2 只留指针 |
| P2 | 砚砚 | secret 防线只有路径级，消息/artifact 正文无内容级 redaction | **已修**：path + payload 双层 redaction；memory_read 出口再脱敏；v1 文件源先落地 |
| P2 | 墨墨 | 独立 DB 只解文件锁，不解同进程事件循环竞争 | **已修**：index worker 子进程 + 单写者；DP-MEM-2 影响面补全 |
| P2 | 墨墨 | schema 缺 drill_down/collection 关联/provenance CHECK | **已修**：`memory-schema.md` 加 `drill_down_json`/`collection_id`/`workspace_id`/CHECK |
| P3 | 烁烁/砚砚/墨墨 | 禁 ATTACH、FTS 同事务、semantic 降级、绝对前缀 deny、kind CHECK、exclude/size、备份/WAL、read caveat、entity defer、model 重嵌、多用户 drill 权限、consumption trace、零命中+stale 渲染、FTS 存储预算 | **已回写**：见 `memory-schema.md` 与 §3.2/§3.5/§3.6 |

**Review 重点**

1. v1 file-evidence subset 是否足够支撑 W0-W4 dogfood；有没有必须提前的 collection/library。
2. 独立 `memory.db` 是否必要；与 control DB 的边界是否清楚。
3. lexical-first + optional semantic 是否可接受；空结果/coverage 语义是否诚实。
4. 个人/proactive/cue 的 drop 是否彻底；有没有隐私回流。
5. `architecture/memory-schema.md` 是否够 W6 实现；index run/worker/recovery 是否完整。

[宪宪/deepseek-flash🐾]
