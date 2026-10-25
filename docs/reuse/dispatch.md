---
cell: dispatch
title: "P0 复用卡：Dispatch / Queue"
doc_kind: reuse-card
status: approved
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_signoff: "approved 2026-10-24"
created: 2026-10-24
updated: 2026-10-24
---

# P0 复用卡：Dispatch / Queue

## 结论

| 项 | 值 |
|---|---|
| decision | **R0 直接复用契约** |
| priority | **P0** |
| codeteam W | W1 / W5 |
| 一句话 | 复用完整 A2A 执行链（Queue Entry → QueueProcessor → AgentRouter → routeSerial/routeParallel → invokeSingleCat）；codeteam 只换 recipient/store 与单次执行内核，不另造队列/路由。 |
| operator 签字 | [x] 已签（2026-10-24） |

## 覆盖

- canonical: F047 / F117 / F167 / F175 / F177 / F185 / F247 / F254 / F264 / F280 / F295
- explicit: F116 / F117 / F167 / F177 / F220 / F224 / F247 / F254 / F295 / F304 / F323 / F325
- Batch 0 legacy 归属：A2A routing、message queue、side-dispatch、queue steer、busy gate 等（见 `reuse-inventory.tsv` 中 `architecture_cell=dispatch`）。

## Current truth

- **唯一 pending-wake 账本**：ADR-043 / F117 一条 source message 对应一条 durable `QueueLedgerEntry`；`targets[]` 只放仍未投递的成员，entry 拥有 source identity、顺序、launch fence、per-target author intent、revision 和短时 claim。
- **A2A 执行链**：A2A ingress → `InvocationQueue/QueueLedgerAdmission` → `QueueProcessor` → `AgentRouter.routeExecution` → `routeSerial`/`routeParallel` → `invokeSingleCat` → `AgentMessage`/response/terminal。queue 多 recipient 恒 parallel；`ideate` 只作直调兜底；链式 serial 来自“每跳独立 source + 单 recipient”的结构。
- **交付与终态分家**：实际投递写 MessageStore `dispatchRefs[]`；response processing、terminal outcome、body exposure、handled state 都不归 Queue。Queue 不保留 per-target 行或 terminal tombstone。
- **代码面**：`QueueLedger.ts`、`QueueLedgerAdmission.ts`、`RedisQueueLedgerStore.ts`、`InvocationQueue.ts`、`QueueProcessor.ts`、`routes/queue.ts`。
- **不采用的历史语义**：F122 旧文档的 per-target 拆行与 steer 预留；当前以 ADR-043 + F117 Phase D 的 single-ledger 为准。

## codeteam mapping

- W1：建 `queue_entries`（source / targets / priority / claim）；`messages.dispatch_refs_json` 记录实际投递；`runs.queue_entry_id` 指向 claim 的 entry。
- W5：把 operator、agent、connector 三种来源都映射成同一种 Queue Entry；`handoff(pending)` / `inbox(pending)` 只是 source/admission，不另建队列。`AgentRouter`/`routeSerial`/`routeParallel` 复用，唯一替换点是 `invokeSingleCat → invokeSingleAgent → pi kernel`。
- 与 `0004` 的同步点：Queue Entry 的行是 `queue_entries`；`handoff`/`inbox` 只是 source/admission；`0001 §5.2` 已补“pending 的唤醒账本在 queue_entries”。
- codeteam-specific：task DAG、priority、budget、worktree pool 只决定 admission 顺序，不另起 drain/comparator。
- 不新增：第二套 queue、per-target queue rows、Queue 侧 terminal receipt、正文 @ 路由推断。

## 风险与回滚

- **风险 P1**：把 codeteam 的 task readiness 写成第二个 scheduler，和 ADR-043/F117 dispatch queue 的 steer / one terminal / response bubble 打架。
- **风险 P2**：SQLite store 与 clowder Redis ledger 语义漂移；W5 前必须用 single-ledger 对账测试锁住。
- **风险 P1**：只复用 Queue、重写 `routeSerial/routeParallel`，会丢掉 A2A chain/worklist/parallel ideate/response 聚合。
- **回滚**：`queue_entries` 与 `runs.queue_entry_id` 都是新增表/列；回滚到 W1 基线即可，不影响 clowder 侧数据。

## Review

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | Queue/Redis 语义、W5 adapter、恢复路径 | accept（本轮已处置） |
| 砚砚 | target 授权、跨 thread 投递边界 | accept（本轮已处置） |
| 墨墨 | operator 可见的 queue/steer/terminal 行为 | accept（本轮已处置） |
| operator | cell 级决策 | [x] 已签（2026-10-24） |

[宪宪/deepseek-flash🐾]
