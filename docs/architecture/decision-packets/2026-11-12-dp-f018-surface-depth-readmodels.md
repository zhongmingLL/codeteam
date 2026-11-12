---
title: "DP-F018SURFACE: fan-out surface / A2A depth / read models"
doc_kind: decision-packet
status: open
created: 2026-11-12
updated: 2026-11-12
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related: [../0010-a2a-runtime-chain.md, ../0014-operator-message-journey.md, ../0015-codeteam-operator-journey-audit.md, ../../plans/0020-f018-thread-first-runtime.md]
related_features: [codeteam/F018]
---

# DP-F018SURFACE

## 0. 一句话

DP-A/B/C/D/E 已关闭 operator、attempt、settlement 语义；本 packet 只解决
`0015` §3.2 剩余三个 surface 选择：**工具 fan-out、A2A depth、read model 边界**。
另附 `ResponseDraftStore` 缺口（F-15），它不是本次三选一，但必须在 R2 stream 实现前补。

## 1. 前因

- DP-A=A：operator 不是 `QueueTarget`，只用 message `mentionsUser`。
- DP-B=B：`multi_mention` 做完整 Clowder orchestrator（status/timeout/callback/aggregate）。
- DP-C=A：`TurnExecution` 单 canonical，`invocation_attempts` 只做 `delivery_state`。
- DP-D=A：settlement 拆回 T1/T2/T3/T4，`settleAgentTurn` 删除。
- DP-E=A：Hub ingress/WS/SSE/replay 归 W7a/F016c，F018 只验收 daemon/CLI。

这三个剩余项不改变上面的核心链路，但会改变**工具面、A2A 成本和 Hub 读模型边界**；
不先定，R2/R3 实现会分叉。

## 2. DP-F018SURFACE-1：`post_message` / `multi_mention` 的 fan-out 分工

### 前因

- Clowder：`post_message` 是 same-thread **single successor**；多 target 的 deliberate
  fan-out 走 `multi_mention` orchestrator。两者语义不同：前者是“传给下一棒”，后者有
  status/timeout/callback/aggregate。
- codeteam：`0010` §3.8 当前允许 `post_message` / `cross_post_message` targets ≤8，
  `multi_mention` 固定 2–3 个 agent。DP-B 又把 `multi_mention` 定为完整 orchestrator。
- 结果：同一个“多 target”能力有两条入口；调用方无法从工具名判断要不要聚合/超时/回调，
  实现和测试也会出现两套 fan-out。

### 选项

| 选项 | 内容 | 优点 | 代价 |
|---|---|---|---|
| **A（推荐）** | `post_message`/`cross_post_message` 单 successor；`multi_mention` 是唯一多 target fan-out | 与 Clowder 对齐；工具语义唯一；聚合/超时只在一个入口 | 简单 fan-out 也要走 `multi_mention`，或调用方分多次 post |
| B | 保留 post/cross 多 target 做“无聚合 fan-out”；`multi_mention` 只做 orchestrator | 简单 fan-out 成本低 | 两套 fan-out；调用方要理解“要不要聚合”；测试/文档双份 |
| C | 删除 `multi_mention`，只用 post 多 target | 工具最少 | 推翻 DP-B；失去 status/timeout/aggregate |

### 推荐

**A**。理由：DP-B 已经选择完整 orchestrator；再保留 post 多 target 会让
`multi_mention` 的独立价值变弱，并让“下一棒”与“并行征集”混在一个工具里。

### 不拍的后果

- 工具描述无法稳定：同一个 targets 参数既可能创建普通 fan-out，也可能创建带聚合的
  orchestrator；Hub/CLI 的提示和权限也会分叉。
- R3/R4 要同时实现两套 fan-out 的队列、parent、取消和测试；后续很可能再收敛一次。

### 落点

- `0010` §3.8：post/cross targets=1；`multi_mention` 2–3 且唯一多 target。
- `0014` Journey C（`@A @B` 并行）改用 `multi_mention`。
- plan 0020 R3/R4、F018 E4/E14；CLI/tool 描述同步。
- 错误码：post 多 target → `use_multi_mention`。

**决策：`DP-F018SURFACE-1=A`**

## 3. DP-F018SURFACE-2：A2A depth 15 vs 2–3

### 前因

- Clowder 的 route-helpers 默认 `MAX_A2A_DEPTH=2`（env 可调）；实际链路通常是
  `operator → A → B → operator`。
- codeteam `0010`/plan 当前定 15。15 跳会放大 loop、延迟和成本；现有
  `a2a_duplicate_delivery`/`pi_ext_tool_call_conflict` 只防重复，不防长链。
- 需要区分“正常多 agent review 链”和“失控乒乓”：前者可能 3–5 跳，后者应尽早断。

### 选项

| 选项 | 内容 | 优点 | 代价 |
|---|---|---|---|
| **A（推荐）** | 默认 3、硬上限 5；per-thread depth budget + early-stop | 覆盖 A→B→C→operator；成本可控；仍有扩展空间 | 超过 5 的链需要拆消息/新 thread |
| B | Clowder 默认 2、硬上限 3 | 最省成本；最接近 Clowder | 三 agent 串行 review 会顶到上限 |
| C | 保留 15 + per-thread budget + 场景/成本证明 | 支持极长链 | 需要真实证据；否则只是把风险留给运行时 |

### 推荐

**A**。默认 3 足够覆盖 operator journey 和多 agent review；硬上限 5 给复杂链留余量。
如果以后确实需要 15，必须补真实场景、成本估算和 early-stop 测试，不能只改常量。

### 不拍的后果

- 一个误配置的 A2A 链可以在 15 跳内持续产生 message/queue/child，成本和延迟不可控。
- depth 错误只在运行时暴露，R4 的 loop guard 验收没有稳定边界。

### 落点

- `0010` §3.8、§5.1、§9；plan 0020 R4；E15/E16。
- `a2a_depth_exceeded` 的阈值和 per-thread budget 测试。

**决策：`DP-F018SURFACE-2=A`**

## 4. DP-F018SURFACE-3：read model 的 ownership 与最小 DTO

### 前因

- `getThreadLiveInvocations` 经 DP-F018RECOVERY 已有字段、evidence rank、过滤 terminal R；
  但 `MessageDispatchSummary` 仍只有一句“简单 read model”，`QueueView` / unread /
  mention 没有字段、排序、分页、新鲜度契约。
- DP-E 把 Hub ingress/WS/SSE/replay 划给 W7a；如果 read DTO 也全部丢给 W7a，W7a 会直接
  拼 `invocation_queue` / `invocation_attempts` / `turn_executions`，和 F018 语义漂移。

### 选项

| 选项 | 内容 | 优点 | 代价 |
|---|---|---|---|
| **A（推荐）** | F018 定义 `QueueView` / `LiveInvocationView` / `MessageDispatchSummary` 三个 domain DTO；W7a 只做 Hub transport 映射；unread/mention 归 W7a/v2 | 语义单源；W7a 不读内部表；F018 范围可控 | 需要一次 DTO 冻结 |
| B | W7a 定义全部 read DTO；F018 只暴露 stores | W7a 自由 | W7a 直接拼内部表；F018 语义被复制 |
| C | F018 定义全部四个（含 ThreadUnread/MentionView） | Hub 完全复用 | F018 scope 膨胀；unread 不是 A2A 核心 |

### 推荐

**A**。最小 DTO：

| DTO | 最小字段 | 排序/分页 | 新鲜度/降级 |
|---|---|---|---|
| `QueueView` | threadId、entries[{queueEntryId, sourceRecordId, status, priority, position, targetAgentIds, claimedBy, enqueuedAt, updatedAt}]、cap | priority 先、同 priority FIFO；按 position | `stale`/`degraded` 标记；不返回已删除 entry |
| `LiveInvocationView` | agentId、turnExecutionId、parentInvocationId、startedAt、childStatus、responseStatus、evidenceRank | startedAt 升序；thread/user scoped | 过滤 terminal R；tracker/durable 去重 |
| `MessageDispatchSummary` | parentInvocationId、sourceMessageId、targetAgentIds、status、successfulAgentIds、failed/canceled 派生、responseMessageIds、terminalReason、updatedAt | updatedAt desc；cursor 分页 | terminal 后保留；parent 未 terminal 时标注 live |

`ThreadUnread/MentionView` 不在 F018 冻结，归 W7a/v2；如果 Hub 需要，W7a 自己定义但不得
反推 F018 的 message/attempt 状态。

### 不拍的后果

- W7a 会为 queue/live/dispatch 各拼一套 SQL；同一个 target 在 Hub 和 CLI 显示不同状态。
- `MessageDispatchSummary` 没有字段/分页，Hub 只能先做假数据或临时接口，后面再破坏性改。

### 落点

- `0010` §3.10 + 新 read DTO 小节；W7a API contract；plan 0020 验收。
- 测试：queue 排序/cap、live 去重/过滤、dispatch 分页/降级。

**决策：`DP-F018SURFACE-3=A`**

## 5. 附：`ResponseDraftStore` 缺口（F-15，不是本次三选一）

### 现状

codeteam **有表和行为草图，但没有完整 Store 契约**：

- 已有：`response_drafts` 表（§4.3.2）、`attempt_id`/`turn_execution_id` 1:1、
  100ms/4KB bounded flush、`message_end` 覆盖、T2 删除、T4 用 draft 恢复 R。
- 未定义：`ResponseDraftStore` interface；append/upsert/merge 语义；`seq` 单调与乱序/
  重复事件处理；tool event 按 `toolId` 合并；thinking 追加；并发写/乐观锁；初始行由谁创建；
  orphan/失败删除/保留策略；Hub 重连读取 API；draft 大小上限；对应测试。

### 判断

这是 **P2 缺件**，不是“已经有设计”。它不阻塞 F-07/F-08/F-09 的三个拍板，但阻塞 R2 的
durable stream 实现。建议在 R2 前补 `ResponseDraftStore` 契约（0010 §3.6.1/§4.3.2 或
独立 0017），至少覆盖：

```ts
interface ResponseDraftStore {
  create(input: { attemptId; turnExecutionId; parentInvocationId; threadId; agentId }): ResponseDraft;
  appendText(input: { turnExecutionId; seq; delta }): ResponseDraft;
  appendThinking(input: { turnExecutionId; seq; delta }): ResponseDraft;
  upsertToolEvent(input: { turnExecutionId; seq; toolId; event }): ResponseDraft;
  replaceFromMessageEnd(input: { turnExecutionId; content; contentBlocks; toolEvents; thinking }): ResponseDraft;
  getByTurn(turnExecutionId: string): ResponseDraft | null;
  listByThread(threadId: string, cursor?): ResponseDraft[];
  delete(turnExecutionId: string): void;
  listOrphans(olderThan: number): ResponseDraft[];
}
```

具体签名可在实现时调整；关键是**单写者、seq 幂等、并发合并、保留/清理**要有契约。

## 6. 决策请求

只需回一行：

`DP-F018SURFACE-1=A, DP-F018SURFACE-2=A, DP-F018SURFACE-3=A`

## 7. 参考

- `0015` §3.2 F-07/F-08/F-09；§3.1 组件矩阵。
- `0010` §3.8（targets/depth/multi_mention）、§3.10（read models）、§4.3.2（draft 表）。
- Clowder `MultiMentionOrchestrator.ts`、`route-helpers` `MAX_A2A_DEPTH`、
  `InvocationQueue.ts:167` queue cap 5、`DraftStore` / `response-draft-settlement.ts`。

[宪宪/deepseek-flash🐾]
