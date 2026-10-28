---
cell: memory
title: "P1 复用卡：Memory / Evidence"
doc_kind: reuse-card
status: approved
operator_signoff: "DP-MEM-1=A, DP-MEM-2=A, DP-MEM-3=A (2026-10-25)"
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
created: 2026-10-25
updated: 2026-10-25
---

# P1 复用卡：Memory / Evidence

## 结论

| 项 | 值 |
|---|---|
| decision | **R1 适配复用** |
| priority | **P1（2026-10-25 operator 提前到 A3）** |
| codeteam W | W6（project evidence/recall）；W7（只读 Console/CLI 投影） |
| 一句话 | 复用 F102 evidence/index 契约与 F209 passage/entity/drill-down，codeteam 只索引项目代码/文档/消息证据；个人记忆、proactive 生产端、cue plane 不进 v1。 |
| operator 签字 | [x] A/A/A（2026-10-25） |

## 覆盖

- canonical: F102 / F152 / F209 / F221 / F227 / F231 / F255 / F260 / F263 / F271 / F276 / F282 / F287 / F321
- v1 取用：F102（IEvidenceStore/IIndexBuilder/SqliteEvidenceStore）、F152（scanner/bootstrap contract）、F209（passage recall/entity anchor/drill-down/Perspective）、F186/F188（collection/library 形状，按需）、F263（lifecycle traces 只读/指标）、F211（session digest 作为 evidence source）。
- v1 明确 drop：F221 taste、F227 event memory、F231 profile primer、F255 auto-dream/diary、F260 person/entity lifecycles、F271 reflection、F276 people relationship、F282 proactive memory、F287 cue plane、F321 memory sky。

## Current truth

- **F102**：`IEvidenceStore` / `IIndexBuilder` / scanner adapters；SQLite evidence DB + FTS5 + passage vectors；`EvidenceItem` 有 anchor/kind/status/provenance/drillDown。
- **F152**：repo scanner / bootstrap contract；provenance tier（authoritative/derived/soft_clue）；不新建 evidence store。
- **F209**：passage-level semantic recall、entity registry anchor、typed drill-down、Perspective query plan；message-unit query 也走同一 evidence path。
- **F186/F188**：collection/library 形状与 health/stewardship；codeteam v1 只保留 project collection 的最小形状。
- **F263**：append-only lifecycle traces（storable:false/indexable:false）与 recall metrics；不进入 evidence search/ranking。
- **F211**：runtime session transcript/digest 是上游 evidence source；memory 只消费 materialized 结果，不拥有 runtime binding。
- **F287/F276/F282/F255/F271/F221/F227/F231/F321**：execution-time cue、private person、proactive、diary、reflection、taste、event memory、profile、memory sky；v1 不进入 codeteam。

## codeteam mapping

- v1 = **project file evidence index**：repo docs、architecture/feature/plan、artifact files 的只读摘要；thread messages/run_events 需 source connector，defer→W6+；不做个人记忆。
- 存储：建议独立 `CODETEAM_MEMORY_DB`（默认 `CODETEAM_DATA_DIR/memory.db`），与控制面 SQLite 分离，避免 FTS/scan 大事务阻塞 handoff/approval。
- 读面：`memory_search` / `memory_read` 只读工具 + CLI；结果带 anchor/kind/status/provenance/drillDown/coverage；不把空结果说成“不存在”。
- 写面：只有 index/rebuild，由 daemon/CLI 触发；不接受 agent 自写 memory，不恢复 reflection/proactive。
- 隐私：workspace/project scope；不索引 secret、home、跨项目私有数据；person/relationship/diary 永不进入 codeteam evidence。

## 风险与回滚

- **P1**：personal/proactive 范围回流，把 codeteam memory 做成第二套 F276/F282。处置：v1 scope 白名单 + out-of-scope 表。
- **P1**：evidence DB 与 control DB 同库导致大扫描阻塞 custody。处置：独立 `memory.db`；busy/超时显式 `memory_unavailable`。
- **P2**：semantic vector 依赖外部 embedding；不可用时降级 lexical 并标注 `degraded`，不伪造语义命中。
- **P2**：索引 stale 被当 current。处置：index run/freshness、`stale_index` warning、不自动扩大 scope。
- **回滚**：删除 `memory.db` + 只读工具/索引任务即可；不影响 control-plane 表。个人记忆从未写入。

## Review

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | evidence/index/scanner、SQLite/FTS、index freshness | accept；P2/P3 已回写 |
| 砚砚 | privacy/tenant、path/secret redaction、no personal memory | accept-with-modify；P2/P3 已回写 |
| 墨墨 | operator 可见 recall、coverage/drill-down、W7 投影 | accept-with-modify；P1/P2/P3 已回写 |
| operator | v1 scope / storage / write path | 已签：A/A/A（2026-10-25） |

[宪宪/deepseek-flash🐾]

## W6a 实现落点（2026-10-29，review pending）

- **契约**：`packages/codeteam-daemon/src/memory/contract.ts` 冻结
  `EvidenceSourceRef` / `EvidenceItem` / `EvidenceHit` / `Coverage` /
  `RetrievalTrigger`；W6b/W6c 从 `packages/codeteam-daemon/src/index.ts` import。
- **存储/索引**：`memory/database.ts`（独立 `CODETEAM_MEMORY_DB`、禁 ATTACH）、
  `memory/indexer.ts`（单写者 lock、full/incremental、FTS/passages）、
  `memory/lock.ts`。
- **adapter**：`memory/sources/file.ts`（repo `docs/**/*.md` + root docs）、
  `memory/sources/control.ts`（只读 control DB 的 task/artifact/review/
  verification/merge 投影；thread messages/run_events 仍未进入 store）。
- **读面**：`memory/recall.ts`（FTS/BM25 + short-query fallback + passage +
  source ref/drill-down + coverage/stale）、`memory/triggers.ts`（六 trigger）、
  `memory/digest.ts`（canonical session/run digest）、`memory/service.ts`。
- **安全**：`memory/redaction.ts`（pattern+entropy secret scan、绝对前缀 deny、
  出口二次脱敏）。
- **CLI**：`codeteam memory index|status|recall|read|digest|trigger`。
- **测试**：8 个文件 / 36 个测试；daemon 全量 416 passed / 2 skipped。
- **与卡的差异**：v1 卡写“source_kind=file only”；W6a dispatch 明确要求
  task/artifact/review/verification/merge source refs，因此 v2 以
  `source_kind='control'` 做派生投影，control truth 仍在 W1/W5 canonical
  tables。个人/主动/私密记忆仍不进入。
