---
title: "DP-F018Q: A2A Queue v1 接口拍板包"
doc_kind: decision-packet
status: decided
created: 2026-11-07
updated: 2026-11-07
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related: ../../architecture/0010-a2a-runtime-chain.md
related_features: [codeteam/F018, codeteam/F017]
operator_decision: "DP-F018Q-1=A, DP-F018Q-2=B, DP-F018Q-3=A (2026-11-07)"
---

# DP-F018Q: A2A Queue v1 接口拍板包

> **Operator 决定（2026-11-07）**：`DP-F018Q-1=A`、`DP-F018Q-2=B`、`DP-F018Q-3=A`。本 packet 已冻结。

> **2026-11-12 后续决策**：DP-C=A、DP-D=A 已把 child terminal / R / parent
> aggregate 拆成 T1/T2/T3/T4；本 packet 中“response 与 parent/credential 同事务”
> 的旧表述由 `0010` §3.9 与 `0016` 取代。历史决策本身不变。

> 只给价值取舍、推荐、证据和“不拍的后果”。不需要 operator 选技术实现。

## 0. 一句话

Queue v1 的接口范围、持久状态和重放保护会影响“v1 能不能快速跑通 A2A E2E”和“会不会重复执行 agent”。其余命名/字段/事务细节我已按 Clowder 源码和既有决策自决。

## 1. 先看结论

| 决策 | 选项 | 推荐 | 影响面 | 不拍的后果 |
|---|---|---|---|---|
| DP-F018Q-1 v1 队列接口范围 | A=只做调度；B=Clowder 全量 delivery/steer/continuation；C=调度 + append recovery | **A** | 实现周期、QueueEntry 字段面、与 message lifecycle 的边界 | 接口范围继续膨胀，QueueProcessor 无法拆分，v1 E2E 被 append/continuation 拖住 |
| DP-F018Q-2 durable 状态模型 | A=只持久化 `queued/claimed`；B=持久化 `processing` 到 child 终态 | **A** | SQL schema、崩溃恢复、父子生命周期真相源 | 队列与 parent/child 双写生命周期，恢复路径分叉 |
| DP-F018Q-3 重放保护 | A=新增 `queue_admissions` receipt；B=不加 receipt，靠 parent/child 唯一键兜底 | **A** | 一张小表 vs 重复执行风险 | `enqueue` 无法回答“已派发过”，重试可能二次执行 agent |

## 2. DP-F018Q-1：v1 队列接口范围

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | 只保留 admission / claim / retire / release / withdraw / 过期恢复；append recovery、Steer、continuation、live companion、freshness、action successor 全部 defer | 最小可交付面；Queue 只做“还有谁没派发”；v1 能尽快跑 A2A E2E | 没有队列级 append 回执恢复；依赖 child terminal + response append 同事务 |
| B | 按 Clowder 全量接口：`appendPendingByTarget`、`appendRecoveryByTarget`、`routingHeldTargetIds`、`authorIntentByTarget`、`steerRequestedAt`、continuation | 未来迁移少；最接近 Clowder | 需要 message lifecycle / append handoff / continuation 一起设计，v1 放不下；容易做出半套未验证机制 |
| C | A + 只补 append recovery（不做 Steer/continuation） | 覆盖“response 丢失”窗口 | QueueEntry 增加 delivery 映射和恢复逻辑；v1 事务模型下收益有限 |

**推荐理由**：

- codeteam v1 的 response 在 child terminal 时与 parent aggregate、credential terminalize 同事务提交；没有 Clowder 那种“provider 流式写消息、append 尚未被接受”的独立窗口。因此 v1 不需要 `appendPendingByTarget`。
- Steer/continuation 依赖尚未设计的 message lifecycle 和 continuation capsule；现在纳入会让 Queue 承担第二套生命周期。
- 与已确认的“Queue 只做调度、parent/child 拥有执行终态”一致。

**不拍的后果**：接口面无法冻结；实现会边写边加字段，QueueProcessor 的 `processEntry` 无法稳定拆分。

## 3. DP-F018Q-2：durable 状态模型

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | 持久行只有 `queued | claimed`；`processing` 只是 `retireTargets` 前的瞬时投影，不落库 | 单一生命周期真相：执行中由 `InvocationRecord` + `TurnExecution` 拥有；队列行在派发提交后收缩/删除；恢复简单 | 崩溃恢复依赖“parent/child 创建 + queue retire 同事务”；需要守住这个不变量 |
| B | 持久化 `processing`，队列行保留 in-flight targets 到 child 终态 | 崩溃后可从队列行重建“哪些 target 在执行” | 队列与 parent/child 双写生命周期；需要 `processingTargetKeys`、额外的 stale 清理和恢复分支 |

**证据**：Clowder `queue-ledger/QueueLedger.ts:17` 明确写：

> `processing`/`terminal` are transient transition snapshots; durable rows are only queued or short-claimed.

Clowder `InMemoryQueueLedgerCommit.ts` 的 `commit(mode='processing')` 返回的是 claimed targets 的**投影**，源行只保留剩余 pending targets，并不持久化 processing 行。

**推荐理由**：v1 已经有 `InvocationRecord`（消息生命周期）和 `TurnExecution`（单 agent 执行）；再让队列行持久化 processing，会出现两个“谁在执行”的真相源。A 把执行真相留给 parent/child，队列只回答“还没派发给谁”。

**不拍的后果**：SQL `status` CHECK、claim 约束、启动恢复都无法定稿。

## 4. DP-F018Q-3：重放保护

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | 新增 `queue_admissions(source_message_id PK, entry_id, fingerprint, admitted_at)`；行删除后重放同一 source 返回 `replayed`，不同 fingerprint 返回 `conflict` | 关闭“队列行已删除、调用方重试同一 source”导致的二次派发窗口；语义清晰 | 多一张小表；需要 admission fingerprint 比较和保留策略 |
| B | 不加 receipt；`enqueue` 只查 live row；行删除后重复 enqueue 会新建行，靠 `InvocationRecord.source_message_id UNIQUE` + `TurnExecution.createRunning` 兜底 | 少一张表 | `enqueue` 无法区分“首次”与“已派发后重试”；QueueProcessor 必须跨 store 查 parent 终态，否则可能二次执行 agent |

**推荐理由**：A2A tool 的 `requestId` 只能保证消息创建幂等；如果进程在“队列行已删除、tool 响应未返回”之间崩溃，调用方重试会再次 enqueue 同一 source。receipt 是最便宜的持久化答案，且不把执行语义塞进 QueueProcessor。

**不拍的后果**：`enqueue` 的 `replayed/conflict` 语义无法定稿；实现只能先按 B 做，后续再迁移 receipt。

## 5. 不需要拍、我已自决的边界

| 事项 | 决定 | 依据 |
|---|---|---|
| 命名 | port = `QueueLedgerStore`；SQLite adapter = `SqliteQueueLedgerStore`；服务 = `InvocationQueue` | 与 Clowder 对齐；替换当前 `QueueStore`/`InvocationQueueStore` |
| `invocation_record_id` 列 | 删除列和 FK | `QueueEntry` 模型没有该字段；parent 通过 `source_message_id` + `turn_executions.queue_entry_id` 关联 |
| `claimNext` | 从 `InvocationQueue` 移除；QueueProcessor 用 `listQueued` + `claim` 自选候选 | 多 target 调度需要跳过 target busy 的 entry，store 不该知道 target 忙闲 |
| `retireTargets` 原子性 | 与 child `createRunning`、parent 创建同事务；provider 启动在事务外 | 避免队列行与执行记录分叉 |
| 排序 | `urgent → position → enqueuedAt → id`；`position` 由 store 在同 thread 内 `MAX+1` | 沿用已确认的 QueueEntry 字段 |
| operator-only | 只通知、不创建 parent/TurnExecution；写 `delivery.operatorNotifiedAt` 后 retire | 已由 2026-11-06 五条决策确认 |

## 6. 拍板方式

回复一行即可，例如：

`DP-F018Q-1=A, DP-F018Q-2=A, DP-F018Q-3=A`

若某项要改选，只写改选的项，例如 `DP-F018Q-3=B`。

## 7. 澄清记录（2026-11-07）

### 7.1 为什么 durable 状态只留 `queued | claimed`

Clowder 的 `QueueLedgerStatus` 类型有 4 个值，但 **type 允许 ≠ 持久行会写**：

- `QueueLedger.ts:17` 注释：`processing`/`terminal` 是 transient transition snapshots；durable rows 只有 `queued` 或 short-claimed。
- `InMemoryQueueLedgerCommit.ts` 的 `commitClaimedTarget` 只把 `attempted`（status=`processing`）作为返回值，不写回 `current`；`commitWithdrawn` 把行从 `current` 删除，返回 `terminal` tombstone。
- `queue-ledger-redis-transition-scripts.ts` 的 `COMMIT_QUEUE_ROW_LUA`：`mode='processing'` 只构造 `attempted` 返回，不 `HSET` 它；持久行只更新剩余 targets 或删除。

所以 codeteam 的 `QueueEntry.status` 只表示**持久行状态**，取 `queued | claimed`。`processing` 作为 `retireTargets` 的返回投影保留（`retiredTargets`），`terminal` 由 `{outcome:'deleted'}` 表达。

如果 operator 要求字面保留 Clowder 的 4 值 union，可以拆成：

```ts
type QueueDurableStatus = 'queued' | 'claimed';          // QueueEntry.status
type QueueProjectionStatus = 'processing' | 'terminal';  // transition result only
```

这样既保留 Clowder 的投影语义，又不会让 `processing` 被误持久化。

### 7.2 重放保护是什么

场景（不是“重试 agent”，而是“重试 admission”）：

1. 调用方创建 message `m1`，`post_message` 在同一事务里 `enqueue(queue:m1)`。
2. QueueProcessor claim `queue:m1`，创建 parent + child，`retireTargets` 删除队列行，启动 provider。
3. provider 正常跑完，但 `post_message` 的 tool 响应在返回给调用方之前丢失（daemon 在 commit 后、响应前崩溃，或客户端超时重试）。
4. 调用方重试同一个 `requestId`：message store 幂等返回 `m1`；但队列行已经被删除，`enqueue` 看到的是“没有 live row”，于是插入一条新的 `queue:m1`，再次派发 agent。

现有幂等键为什么不够：

- message 幂等 → 只保证不会创建第二条消息，不保证不会再派发一次。
- `InvocationRecord.source_message_id UNIQUE` → 只保证不会创建第二个 parent；但重新入队后 QueueProcessor 仍要先 claim、再发现 parent 已存在/已终态，处理不当就会创建新 attempt。
- `TurnExecution.createRunning` → 只保护同一个 child id 的重复创建；新一次派发会生成新 child id。

`queue_admissions` receipt 就是“admission 层的幂等键”：

```text
source_message_id | entry_id | fingerprint | admitted_at
```

`enqueue` 顺序：

1. 有 live row → 比较 immutable admission 字段；一致 `replayed`，不一致 `conflict`。
2. 无 live row，有 receipt → 比较 fingerprint；一致 `replayed`（`entry:null`），不一致 `conflict`。
3. 都没有 → 插入 row + receipt → `enqueued`。

fingerprint 只覆盖不可变字段（source、owner、kind、from、payload、requestedTargets、priority、execution），不覆盖 `targets/status/claim/delivery`。

代价：一张小表 + 一次 fingerprint 比较；收益：关闭“队列行已删除、调用方重试”导致的二次执行窗口。

### 7.3 最终拍板

- `DP-F018Q-1=A`：v1 队列只做调度；append recovery / Steer / continuation / live / freshness / action 全部 defer。
- `DP-F018Q-2=B`：保留 `QueueLedgerStatus` 四值 union；拆成 `QueueDurableStatus`（queued/claimed，落库）与 `QueueProjectionStatus`（processing/terminal，只出现在 transition projection）。
- `DP-F018Q-3=A`：新增 `queue_admissions` receipt，关闭“队列行已删除后同一 source 重试”的二次执行窗口。

落点：`0010-a2a-runtime-chain.md` §3.1（接口与投影）、§4.1（DDL）、§11（决策记录 16-19）。

[宪宪/deepseek-flash🐾]
