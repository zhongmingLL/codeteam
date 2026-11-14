---
title: "codeteam A2A v1 — global design review (2026-11-14)"
doc_kind: review
status: review
created: 2026-11-14
updated: 2026-11-14
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related_features: [codeteam/F018]
related: [0000-architecture-map.md, 0005-thread-first-runtime.md, 0007-a2a-runtime-chain.md, 0010-session-model.md, 0014-operator-message-journey.md, 0016-turn-terminal-and-settlement-design.md, 0017-response-draft-store.md]
---

# codeteam A2A v1 — global design review

> 这是一次**全局设计检视记录**，不是新契约。canonical 仍是 `0005`/`0007` +
> 分册；本文只记录本轮发现的冲突、处置和剩余决策。历史审计见 `0015`；
> 决策记录见 `decision-packets/2026-11-14-dp-f018-global-review.md`。

## 0. 结论

**方向 approve；Phase A 契约可进入最终 review；R1 可以开始。**
**2026-11-14 operator 已拍板：`BBBA`（mention 正文匹配 / callback child /
completed 去重接受风险 / 全 failed 保持 done+allFailed）。**

- 架构骨架与 Clowder 同构，主要问题集中在**所有权边界**、**prestart 失败路径**、
  **response settlement 的 recovery 语义**和**文档残留的第二套契约**。
- 本轮已把会直接导致 R1/R2 实现错误的问题写回 canonical docs，并修复了 20+ 处
  文档冲突。
- 剩余工作不是“再选方向”，而是按 `BBBA` 落地：正文 `@` 解析、callback child
  生命周期、completed 去重风险记录、`allFailed` 派生。

## 1. 检视范围与方法

通读并交叉核对：

- 方向/范围：`0005`、`F018-thread-first-runtime.md`、`0020` plan。
- V1 机制：`0007` 全链路、数据模型、状态机、恢复、验收、决策记录。
- 分册：`0008` AgentConfig、`0009` Thread、`0010` Session、`0011` Identity、
  `0013` Idempotency、`0014` operator journey、`0016` terminal/settlement、
  `0017` DraftStore。
- 必要处回读 Clowder 只读参考仓：`InvocationQueue`、`QueueProcessor`、
  `TurnExecutionStore`、`DraftStore`、`onQueueEntriesAdmitted`。

检视四条线：

1. **operator journey 端到端**：ingress → queue → parent/child → stream → terminal。
2. **数据所有权**：每个事实只有一个 writer；同一 child 不出现第二套终态。
3. **事务/恢复**：dispatch、T1/T2/T3/T4、crash window、expired claim。
4. **验收覆盖**：E1-E18 是否覆盖所有失败面；文档是否留下第二套契约。

## 2. 本轮已修复的硬问题

| # | 严重度 | 问题 | 处置 |
|---|---|---|---|
| G-01 | P0 | `0017` 仍有 `DraftSnapshotInput` / `DraftWriteOutcome` 两套写侧类型 + 公开 `seq` CAS；operator 要求的单 `DraftRecord` 没有真正落地 | `0017` 收敛为一个 `DraftRecord` + `create/upsert/get/delete`；单 writer 串行 flush；删除 `seq`、`contentBlocks`、`DraftWriteOutcome`；0007/0005/plan 同步 |
| G-02 | P0 | parent 在 claim 后仍是 `queued`，全部 prestart 失败时 `applyTerminalAggregate`（只接受 running）无法收敛 | `processEntry` 事务内 parent `markRunning`；状态机改为 claim/startAll → running；prestart 失败可聚合 |
| G-03 | P0 | `0016` attempt DDL 的 `prompt_delivered_at IS NULL OR delivery_state='appended'` 会让 `handled` 永远无法落库 | 改为 `handled → prompt_delivered_at 非空`，prompt 后 terminal 状态允许；与 0007 DDL 对齐 |
| G-04 | P0 | `0010` 先 `createRunning` 再 `markStarting/bindAppended`，绕过 attempt 唯一 active delivery，可能双开 | 先 `markStarting` 拿唯一 active delivery，再 createRunning/bindAppended；credential 回到 dispatch 事务 |
| G-05 | P0 | `restoreExpiredClaims` 只有接口，没有 startup/reaper 调用；崩溃后 claimed row 永远不出现在 `listQueued` | startup reconciler 与 reaper 每轮先 `restoreExpiredClaims`；补依赖和验收 |
| G-06 | P1 | `runAgentTurn` 仍被写成 T2/T3 owner，和 0016 的四层 owner 冲突 | 0007 改为 `runAgentTurn` 只编排 T1 并返回 result；T2 route/committer、T3 QueueProcessor、T4 recovery |
| G-07 | P1 | prestart 失败分不清“dispatch 事务回滚”和“dispatch 后 spawn/prompt 失败”；worker_capacity 与 attempt 是否存在矛盾 | 增加 `WorkerPool.checkCapacity` dispatch 前预检；0010 失败矩阵拆分 dispatch 内/后；0007 worker 段同步 |
| G-08 | P1 | `response_missing` 被写成 `attempt failed`，会反向改写 child canonical | 改为 typed system message + `terminalReason`；child/attempt delivery_state 不改写，仍以 TurnExecution 为准 |
| G-09 | P1 | cancel 未开始 target 不写 attempt，但聚合从最新 attempt 推导 canceled，target 会被漏掉 | cancel 同事务为未开始 target 追加 `queued → canceled` prestart attempt |
| G-10 | P1 | `extra.multiMention` 被 multi_mention 写入，但 `StoredMessage.extra` 只允许 3 个 key | extra 扩为 4 个 key；0005/plan/0007 类型同步 |
| G-11 | P1 | `post_message` 空 targets 在 §9.5 被写成“仅 `mentionsUser` 时”，和 §3.8 的 message-only write 冲突 | §9.5 改为 targets=0 一律 message-only；表行同步 |
| G-12 | P1 | AgentConfig 没有 operator mention 字段；`handle` 单值也不表意，丢失多别名/大小写/边界语义 | 改用 Clowder `CatConfig` 的 `readonly mentionPatterns: readonly string[]`；最长匹配 + token boundary + 大小写不敏感；displayName 只展示 |
| G-13 | P1 | participants 写入时机只有“首次成功”一句话，没有 owner | T1 completed 同事务 `INSERT OR IGNORE thread_participants`；failed/canceled 不写；0014 标注 codeteam 有意偏离 Clowder admission-time |
| G-14 | P2 | queue cap 要求 user/A2A 分开计数，但 `countQueued(threadId)` 只有一个总数 | 改为 `countQueued(threadId, kind)`；QueueView/验收同步 |
| G-15 | P2 | `multi_mention_requests.idempotency_key` 是未使用的第二套 key | 删除列和 unique；幂等仍由 credential `toolCallClaims` 承担 |
| G-16 | P2 | `markStarting(claimId)` 的 claimId 不落库、无法校验 | 改为 `markStarting(attemptId, { now })`；调用方必须已持有 queue claim |
| G-17 | P2 | `routing_guard` 有 enum/表，但没有 creator/terminal owner | 明确 v1 不创建；保留 enum 只为 Clowder 对齐；后续引入时补 owner |
| G-18 | P2 | `lastActiveAt` 没有写入 owner | MessageStore `append` 与 T2 response terminal 同事务更新 `threads.last_active_at` |
| G-19 | P2 | 错误码 `unknown_target` / `unknown_agent` / `agent_not_found`、`account_missing` / `account_not_found` 混用 | canonical 统一为 `agent_not_found` / `account_not_found`；0007/0008 同步 |
| G-20 | P2 | `completedAt` / `endedAt`、0005 allowedTools 漏 multi_mention、TurnExecution 1:1 AgentSession、0014 存储 `deliveryStatus`、queue cap “待定” | 全部按 canonical 修正 |
| G-21 | P2 | `0016` T1a 先 `appended` 再建 R，顺序不可实现；T2 漏 settle inputs | T1a 改为 attempt→R→createRunning→bindAppended；T2 补 settle inputs |
| G-22 | P2 | `response_drafts` 的 `contentBlocks`/`seq` 与 `DraftStore` 单类型不一致 | 0007 DDL/0005 schema/plan/0016 同步删除；contentBlocks 在 T2 生成 |

## 3. 已拍板的分叉（2026-11-14 `BBBA`）

| ID | 决定 | 含义 |
|---|---|---|
| DP-F018MENTION-1 | **B** | operator 用户消息允许正文任意显式 `@`；A2A/final response 仍不解析 |
| DP-F018MM-1 | **B** | multi_mention group terminal 后为 callbackTo 创建新的 callback child |
| DP-F018IDEM-1 | **B** | v1 接受 completed 跨 tool-call 重试重复风险；不新增去重索引 |
| DP-F018MM-2 | **A** | 全 failed group 保持 `done`，status read/聚合附 `allFailed=true` |

### D-0 `mentionPatterns` 的匹配范围（决定：B）

字段已按 Clowder `CatConfig` 改为 `readonly mentionPatterns: readonly string[]`；
剩余是**在文本哪里匹配**：

- **A（推荐 v1）**：只解析行首 `@`（含列表/引用前缀），正文中间 `@` 不路由。保持
  0007 现有 operator ingress 语义，误路由风险最低。
- **B（Clowder 用户消息行为）**：用户消息里的正文 `@` 也可路由；需要额外处理
  代码块、URL、边界、歧义和多 target 顺序。A2A tool body / agent final response
  仍不解析正文 `@`。

**已拍板 B**：正文任意显式 `@` 路由；必须补代码块/URL 排除、token boundary、
歧义和多 target 顺序，以及“agent final response 正文 @ 不路由”的负例。

> 决策包：`decision-packets/2026-11-14-dp-f018-global-review.md` DP-F018MENTION-1。

### D-1 `multi_mention.callbackTo`：metadata-only 还是真正唤醒（决定：B）

当前 canonical 写的是“完整 group lifecycle（status/timeout/aggregate），但 `callbackTo`
只做聚合地址/metadata，不新建 child/queue”。Clowder 参考仓当前同样只把 callbackTo
写进聚合 metadata；B 是 codeteam 扩展，不是 1:1 复用。

**选项**

- **A（推荐保持 v1 轻量）**：callbackTo metadata-only；把文案改成“full group lifecycle，
  callback 不 cascade”。R3/R4 验收只测聚合消息可读。
- **B（codeteam 扩展）**：callbackTo 触发一个新的 `post_message`-equivalent child，
  需要 anti-cascade、depth、queue cap、return/aggregate 的新设计；R3/R4 范围变大。

**已拍板 B**：callbackTo 创建新的 callback child；设计、schema、recovery 和验收见
`0007` §3.8。

> 决策包：DP-F018MM-1。

### D-2 completed 消息的跨 tool-call 重试去重（决定：B）

`piExtToolCallId` 只在同一个 tool call 重试内稳定。如果模型在 tool 成功返回后重新生成
一个新 `toolCallId` 再发一次相同 intent，`toolCallClaims` 不会命中；
`a2a_duplicate_delivery` 只拦 queued/running，不拦已 completed 的 source。结果是同一
intent 可能产生第二条消息。

**选项**

- **A（推荐）**：在 message/claim 层加一个短窗口（如 10 分钟）的
  `(threadId, senderAgentId, intentHash)` 去重索引；命中 completed source 时返回原
  message/queue 结果。需要 message 表存 `intent_hash` 或单独 receipt 表。
- **B（接受风险）**：保留现状，只在 0013 记为已知 v1 风险；R3/R4 不做。

**已拍板 B**：接受风险；0013 记录已知缺口，E10 只覆盖同一 tool call 的 replay。

> 决策包：DP-F018IDEM-1。

### D-3 `multi_mention` 全部 target failed 时的 group 状态（决定：A）

当前 `done` 定义为“全部 target 都有 outcome（received 或 failed 都算 accounted）”，
所以全部 failed 的 group 也是 `done`，`failed` 只表示 group admission/orchestrator
自身失败。这与直觉“全失败 = failed”不同。

**已拍板 A**：保留 accounted 语义，group `done`；status read/聚合正文加
`allFailed=true`。

> 决策包：DP-F018MM-2。

## 4. 剩余 P2 / R1 前可顺手收紧

| # | 问题 | 建议 |
|---|---|---|
| R-01 | `queue_admissions` PK 是 `(source_record_id, attempt)`，parent unique 是全局 `source_record_id`；v1 messageId 全局唯一所以安全，但 connector 未来可能跨 thread 碰撞 | 在 R1 加 `thread_id` 到 `queue_admissions`，parent 改 `(thread_id, source_record_id)` unique；成本低 |
| R-02 | `TurnExecution` “同 session 唯一 running”没有直接 DB 约束，靠 attempt 唯一 active delivery 间接保证 | 在 R1/R2 测试里加“无 attempt 的 ordinary TurnExecution 被拒绝”；不要只靠注释 |
| R-03 | `response_missing` 在“R 行完全不存在”时没有精确的 R 替代策略 | R2 钉死：写 typed system message，attempt settlement 收敛为 settled；不伪造 R，不改 child |
| R-04 | `multi_mention` 的 `partial` 与 timeout 聚合需要真实 reaper 测试 | R3 用 fake clock + 单 reaper 循环测；不要用第二个 timer |
| R-05 | `thread_context` 的可见性复用 HistoryAssembler，是否应让 agent 看到其他 target 的定向消息 | R2 前明确产品语义；当前按 per-agent visibility 过滤 |
| R-06 | `AgentConfig.mentionPatterns` 变更会影响 `@` 路由；目前没有改名流程 | R1 只允许 operator/CLI 显式改；改名不需要迁移历史消息；matching policy 见 DP-F018MENTION-1 |

## 5. R1/R2 gate

**R1 可以开始**，前置：

- 本 review + 0007/0016/0017 的最终非作者 review verdict 覆盖 exact HEAD。
- migration 以本轮的 attempt `delivery_state`、parent `markRunning`、draft 单类型为准。

**R2 开始前**：

- D-0=B 的正文 `@` 解析、E6 负例更新进入 R2 实现清单。
- D-2=B 的 accepted-risk note 进入 0013；不新增 completed 去重索引。
- `WorkerPool.checkCapacity`、`restoreExpiredClaims`、participants insert 进入实现清单。

**R3/R4 开始前**：

- D-1=B 的 callback child schema/queue/recovery 进入 R3/R4 实现清单。
- D-3=A 的 `allFailed` 派生进入 multi_mention status read/aggregate。
- multi_mention status read/aggregate 的 W7a/CLI 暴露方式确定。

## 6. 证据入口

- 本轮修改：`0005`、`0007`、`0008`、`0010`、`0014`、`0016`、`0017`、`0020`。
- Clowder 参考回读点：`InvocationQueue.onQueueEntriesAdmitted`、
  `QueueProcessor.executeEntry`、`TurnExecutionStore`、`IDraftStore`。
- 历史审计/决策：`0015`、`decision-packets/`。

[宪宪/deepseek-flash🐾]
