---
title: "codeteam operator message journey — component audit"
doc_kind: architecture
status: historical
created: 2026-11-11
updated: 2026-11-14
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related_features: [codeteam/F018]
related: [0005-thread-first-runtime.md, 0007-a2a-runtime-chain.md, 0011-identity-contract.md, 0013-idempotency-key-map.md, 0014-operator-message-journey.md]
source: "Clowder local reference checkout; codeteam F018 design docs + current task-first code"
---

# codeteam operator message journey — component audit

> **历史审计：** 2026-11-11 的组件审计与决策证据；DP-A/B/C/D/E 与 F-07/F-08/F-09
> 已折入 `0007`/`0014`/`0016`/`0017`。本文不再作为实现基线；文档地图见
> `0000-architecture-map.md`。

> 目的：以 `0014` 的 Clowder 全链路为参照，给出 **codeteam 版本**的 operator
> message journey，并逐组件回答三件事：
> 1. codeteam 已设计/已实现什么；
> 2. 还缺什么；
> 3. 与 Clowder 的差异是“必要适配”还是“意外分叉/过度设计”。
>
> 审计对象是 F018 设计契约，不是宣称这些组件已经实现。当前代码仍是 task-first：
> `queue_entries` / `runs` / `agent_sessions` / `a2a_requests` 等是 legacy 或待迁移
> 组件；F018 新表与新服务在 R1/R2 才落地。

## 0. 结论先行

1. **核心链路结构是对的**：codeteam 的 `MessageStore → InvocationQueue → QueueProcessor →
   InvocationRecord → TurnExecution → AgentRouter → invoke-single-agent → response R`
   与 Clowder 的 10 组件骨架同构；这不是“另造一套轻量链路”。
2. **真正缺的是边界层，不是核心组件**：
   - Hub ingress（`POST /api/messages` 等价物）、WebSocket/SSE/event replay；
   - queue/unread/mention/live 的 read models；
   - single/all cancel 的控制面；
   - operator decision 的关联与未读投影。
   这些主要归 W7a/F016c，但 F018 必须写清依赖，否则“operator journey”无法端到端验收。
3. **有三个不必要的语义分叉，建议在 R1 前解决**：
   - `multi_mention` 的名字与 Clowder 不一致：Clowder 是带 timeout/status/aggregate 的
     orchestrator；codeteam v1 只是并行 post。**要么改名/删掉，要么实现 Clowder 语义。**
   - operator 被提升为 `QueueTarget`；Clowder 用 message 的 `mentionsUser` 标记。
     operator 不是执行 target，当前设计增加了 union/queue/depth 复杂度，收益不明确。
   - `TurnExecution.status` 与 `InvocationAttempt.state` 双终态；同一个 child 有两个
     canonical state，容易出现 TERM/RECOVERY 分叉。
4. **存储/transport 差异是必要的**：SQLite vs Redis、pi extension vs MCP、control socket
   vs HTTP callback、无 task/custody。它们不应被当成“偏离 Clowder”；真正该审的是语义
   分叉。
5. **不要用“复用 Clowder”掩盖 scope cut**：v1 不做 custody、session
   restore/compaction、connector/IM；这些是明确决策，必须写成“有意不做”。
   `multi_mention` 已拍板做完整 orchestrator，不属于 scope cut。

**审计 verdict：方向 approve，changes requested。**

- P1：F-01 Hub ingress/transport 缺件（DP-E 已定依赖）；F-02 operator target
  （DP-A 已解决）；F-03 multi_mention（DP-B 已解决）；F-04 TurnExecution/Attempt
  双终态（DP-C 已拍 A）。
- P2（R2/R3 前解决）：F-05 settlement ownership、F-06 response_missing/audit、
  F-07 post_message 多 target、F-08 A2A depth 15、F-09 read models、F-10 queue cap、
  F-11 session restore scope。
- P3（可后置）：F-12 draft flush 调参、F-13 命名、F-14 queue admissions receipt。

> 2026-11-12 更新：DP-A=A、DP-B=B、DP-E=A 已拍板；DP-C=A、DP-D=A 也已拍板，
> 0007 §3.5/§3.6/§3.9/§4.3.1/§5.2.1/§9、0005 与 plan 0020 已同步；`settleAgentTurn`
> 已删除，生产代码不得重新引入。

## 1. codeteam 目标链路（与 0014 对应）

```text
Hub / CLI / API（W7a，当前缺失）
  → POST /api/messages（operator identity + idempotencyKey）
  → OperatorMessageIngress
      target resolution：显式 typed targets / 隐式 fallback
  → MessageStore + InvocationQueue.enqueue（同一 SQLite 事务）
      source message(deliveryStatus=queued) + queue entry + queue_admissions
  → QueueProcessor.drain / claim
  → InvocationRecordStore.create(parent)
  → InvocationTracker.startAll(thread, agent, parentInvocationId)
  → AgentRouter.routeAgents(mode)
      serial：薄循环；parallel：merge streams
  → runAgentTurn
      SystemPromptBuilder + ContextAssembler + AgentReadState.deliveryCursor
  → invoke-single-agent
      TurnExecution.createRunning + response R(processing) + credential
      pi RPC → AgentStreamEvent
  → ResponseDraftStore（in-flight body）
      + ephemeral Hub stream event
  → T1 invoke-single-agent / TurnExecutionLifecycle
      child terminal + attempt projection + credential terminalize
  → T2 route / RouteResponseCommitter
      response R + draft delete + A2A successor
  → T3 QueueProcessor + collector
      parent aggregate + queue/retry + tracker slot
  → Hub projection（W7a）
      agent_message / message_lifecycle_updated / messages_delivered / queue_updated
```

这条链路与 0014 的 Clowder 链路一一对应；差异集中在：

- **入口/出口 transport**：Clowder socket.io + HTTP；codeteam W7a + SQLite。
- **target 语义**：Clowder 只有 agent targets + `mentionsUser`；codeteam 曾增加
  operator target，DP-A 已退回 `mentionsUser`。
- **fan-out 工具**：Clowder `multi_mention` 有 orchestrator；codeteam v1 明确无聚合。
- **child 状态**：Clowder `TurnExecution` 单状态；codeteam 增加 attempt 状态。

## 2. Journey 矩阵：codeteam 目标态与缺口

| Journey | codeteam 设计 | 当前缺口 | 归属 |
|---|---|---|---|
| A 简单问答 | 完整：隐式路由 → queue → parent/child → R | Hub ingress/transport；prompt/session 实现 | W7a + F018 R2 |
| B `@A → A→B → B→operator → operator 回复 → B` | 设计存在；operator 用 `mentionsUser`，不是 QueueTarget | operator 未读投影；operator decision 关联 | F018 + W7a |
| C `@A @B` 并行 | 设计存在：1 source + 1 queue + 1 parent + N child | `routeAgents` 并行实现；Hub 多 bubble 投影 | F018 R2/R3 + W7a |
| D 单 agent cancel | tracker exact cancel 设计存在 | cancel API/CLI；exact execution identity 负例 | W7a + F018 R2 |
| E cancel all | cancelAll + prestart retirement 设计存在 | 控制面 API；queue entry preserve/withdraw 规则 | W7a + F018 R4 |
| F 失败/retry | TERM/RECOVERY 决策已落 | attempt 双状态；retry 控制面；queue TTL/abandon | F018 R2/R4 |
| G 消息排队 | queue/admission 设计完整 | queue cap/priority/position；queued 可见性 | F018 R2 |
| H 刷新/重连/重启 | response_pending + startup reaper 设计存在 | Hub event replay/catch-up；live read model | W7a + F018 R4 |

## 3. 逐组件审计

### 3.1 组件矩阵

| 组件 | Clowder | codeteam F018 | 判断 | 最高 severity |
|---|---|---|---|---|
| Hub ingress | `POST /api/messages` + socket.io | W7a 未落地；0014 只定义概念 | **missing** | P1 |
| MessageStore | `Message` + `StoredMessage`；Redis | 只保留 `StoredMessage`；SQLite | adapted（合理） | P3 |
| InvocationQueue | Queue + QueueLedger；Redis/Lua | `invocation_queue` + `queue_admissions`；SQLite | adapted（合理） | P2 |
| QueueProcessor | event-driven drain + target-level claim | 同构；单 SQLite 事务 | aligned | P2 |
| InvocationRecord | parent record；idempotent create | 同构；parent 在 claim 后创建 | aligned | P3 |
| InvocationTracker | per `(thread, cat)` slot + AbortController | 同构；exact cancel | aligned | P2 |
| AgentRouter | serial/parallel + target intent | `routeAgents`；显式 targets | aligned | P2 |
| Prompt/history | SystemPromptBuilder + ContextAssembler + cursor | 同构；delivery cursor 简化 | adapted | P2 |
| Session/Worker | session chain + ACP pool + restore/compact | active + lightweight seal；ephemeral worker | **scope cut** | P2 |
| invoke-single-agent | invokeSingleCat；provider/stream/retry | 同构；只负责 provider/stream | aligned | P2 |
| TurnExecution | child canonical execution | 同构；`completed` 命名 | aligned | P1（与 attempt 双状态） |
| InvocationAttempt | 无独立 child attempt 状态 | 新增 append-only attempt 台账 + state | **problem** | P1 |
| ResponseDraft/R | DraftStore + processing R | `response_drafts` + `0017` ResponseDraftStore 契约（snapshot/seq/delete/orphan） | adapted | P2 |
| Credential/A2A tools | MCP callback + `clientMessageId` | pi extension + `piExtToolCallId` | adapted（合理） | P2 |
| Terminal collector | `PerCatTerminalDispositionCollector` | `PerAgent...`；DB latest attempt | aligned | P2 |
| Recovery | startup + zombie + owner reaper | 单 startup + 单 serialized reaper | adapted | P2 |
| Read models | live invocations + dispatch summary | `QueueView`/`LiveInvocationView`/`MessageDispatchSummary` DTO 已定义；Hub transport 归 W7a | adapted | P2 |
| Operator notification | `mentionsUser` + unread index | message `mentionsUser`（DP-A 已改） | fixed | P1 |

### 3.2 详细 findings

#### F-01 Hub ingress / event transport 缺失（P1，缺件）

> 已拍 DP-E=A：W7a 独立验收，F018 只验收 daemon/CLI；本条保留为依赖声明。

- Clowder：`routes/messages.ts:328` 是唯一 operator ingress；`SocketManager.ts:437`
  发 `agent_message`；`useSocket.ts` 消费 `agent_message` / `queue_updated` /
  `message_lifecycle_updated` / `messages_delivered`。
- codeteam：F018 只定义 `AgentStreamEvent` / response_drafts / live projection；
  `POST /api/messages`、WebSocket/SSE、event replay、operator auth 都在 W7a/F016c，
  而 F016c 仍是 discovery/signoff pending（`F016-w7a-headless-surface.md:65`）。
- 问题：没有 ingress/transport，§2 的 Journey A–H 都无法端到端验收；当前只能验证
  daemon 内部 service/E2E，不能声称 Hub 用户旅程完成。
- 建议：把 W7a 明确列为 F018 operator-journey 的依赖；F018 验收拆成
  “daemon/CLI E2E”与“Hub E2E”两层，不要把后者算进 R2/R3。
- 立场：**缺件，必须显式挂依赖；不建议 F018 内重写 W7a。**

#### F-02 operator 被提升为 QueueTarget（P1，意外分叉）

> 已拍 DP-A=A：operator 不进入 QueueTarget；0007/0005/0014 已改为
> message `mentionsUser`。以下保留为决策依据。

- Clowder：agent `post_message` 的 `targetCats` 只放 cat；operator 通知由正文行首
  `@co-creator`/配置 handle 触发 `detectUserMention`，写 message `mentionsUser=true`；
  operator 回复是一条新的 user message（`user-mention.ts`、`callbacks.ts:1875`）。
- codeteam：`0007` §3.8 把 targets 定义为 `{kind:"agent"|"operator", id}`；operator-only
  只通知、不建 parent/TurnExecution，`delivery.operatorNotifiedAt` 写 queue entry；
  `StoredMessage` 明确不存 `mentionsUser`。
- 问题：operator 不是执行 target，却进入 QueueTarget union，导致 queue target 解析、
  depth/loop、dispatchRefs、operator-only entry 删除、未读/mention 投影都要分叉；
  而 Clowder 用一个 message flag 就解决了。当前收益（typed target）不足以解释这层复杂度。
- 建议：优先对齐 Clowder：targets 只放 agent；operator 通知用 message-level
  `mentionsUser`/`extra.operatorMention` + 读模型投影。若必须保留 operator target，
  需要写出“为什么 message flag 不够”的具体场景（例如 durable ack/notification receipt），
  并删除 `StoredMessage` 无 `mentionsUser` 的矛盾。
- 立场：**退回设计，先论证；默认改为 `mentionsUser`。**

#### F-03 `multi_mention` 语义与 Clowder 不一致（P1，意外分叉）

> 已拍 DP-B=B：实现完整 Clowder orchestrator；0007 §3.8 multi_mention 已补
> status/timeout/callback/aggregate 设计。以下保留为决策依据。

- Clowder：`multi_mention` 是完整 orchestrator：`MultiMentionOrchestrator` 维护
  `pending/running/partial/done/timeout/failed`、3–20 分钟 timeout、`callbackTo`、
  每 target response、聚合结果消息、status endpoint、anti-cascade；见
  `MultiMentionOrchestrator.ts`、`callback-multi-mention-routes.ts`、
  `packages/shared/src/types/multi-mention.ts`。
- codeteam：`0007` §3.8 / `0020` R3 定义 `multi_mention` 为 2–3 targets 的 fan-out，
  明确 **no orchestrator/status/timeout/aggregate callback**；只是“一条 message + 一个
  queue entry + 一个 parent + N children”。
- 问题：同名不同义是最危险的复用偏差。调用方会以为能拿到聚合结果/超时/状态，
  实际只得到普通并行 post；后续实现者也可能按 Clowder 语义补 orchestrator，造成双路径。
- 建议：二选一——(A) 删除 `codeteam_multi_mention`，用 `post_message` 多 targets
  表达并行（codeteam 已有多 target 路由）；(B) 真正实现 Clowder 的 orchestrator
  （status/timeout/callback/aggregate），并把它纳入 R3/R4 验收。不要保留“假 multi_mention”。
- 立场：**P1，必须在 R1/R2 前定；默认 A（删除/改名）。**

#### F-04 TurnExecution 与 InvocationAttempt 双终态（P1，设计问题）

> 2026-11-12 已拍 A：采用 §3.3 修正；0007 schema 已改为 `delivery_state`。

- Clowder：`TurnExecutionRecord` 是 child canonical；status
  `running/completed/failed/interrupted/canceled`，terminal first-write-wins。
  `InvocationRecord` 是 parent；没有第二个 child state。
- codeteam：`0007` §4.3 `TurnExecution` 有 status；§4.3.1 `invocation_attempts` 又有
  `state`（同五态）和 `settlement`；child terminal 与 attempt terminal 同事务更新。
- 问题：同一个 child 有两个 canonical state。只要任一路径漏写/重试/恢复顺序不同，
  collector、reaper、response settlement 就会读到矛盾状态；`state` 还会与
  `TurnExecution.status` 的 first-write-wins 语义重复。
- 决定：`TurnExecution.status` 对已启动 child 是唯一 canonical；
  `invocation_attempts.delivery_state` 只做投递状态
  （`queued/starting/appended/handled/failed/interrupted/canceled`），由
  `projectChildTerminal` 投影；禁止两个字段各自接受 terminal write。
- 立场：**P1，改成单状态源；否则 R2 的 terminal/E2E 会分叉。**

#### F-05 settleAgentTurn 与 route/invokeSingleAgent 职责重叠（P2，设计问题）

> 2026-11-12 已拍 A：按 §3.4 拆回四层；`settleAgentTurn` 已删除。

- Clowder：routeSerial/routeParallel 负责 response commit、draft delete、A2A successor；
  QueueProcessor 负责 parent/child/admission；`invokeSingleCat` 只产流。
- codeteam：`0007` §3.6/§3.9 说 `invoke-single-agent` 只负责 provider/stream；
  `settleAgentTurn` 封装 child terminal + attempt terminal + parent aggregate +
  credential + response settlement；但 `routeExecution` 仍被描述为执行链的一环，
  没有写清谁调用 `settleAgentTurn`、谁提交 R、谁删 draft。
- 问题：如果 route 和 QueueProcessor 都能触发 terminal/settlement，会出现双提交或
  “child terminal 了但 R 未 settle”的中间态。
- 决定：T1 `invoke-single-agent` + `TurnExecutionLifecycle` 写 child terminal/
  credential/attempt projection；T2 `route`/`RouteResponseCommitter` 写 R/draft/A2A
  successor；T3 `QueueProcessor` + collector 写 parent/queue/retry/slot；T4
  `ResponseRecoveryService` 只修未完成 R。route 不写 child/parent，生产代码不引入
  `settleAgentTurn`。
- 立场：**P2，先钉 owner 再实现。**

#### F-06 `response_missing` 使用 legacy audit（P2，已修）

> 2026-11-13 已去掉 legacy audit：`response_missing` 只写 typed system message +
> `terminalReason`；abandon/TTL 写 thread event。

- codeteam：`0007` §3.10 / §9.5 说 R 缺失走 `response_missing` recovery：
  曾写 attempt failed + system message/audit；同时 §3.1 又说 `audit` 是 task-first
  遗留，不属于 A2A message/lifecycle 契约。
- 问题：A2A 恢复依赖一个被声明为 legacy 的表面，读模型/审计边界会漂移。
- 建议：`response_missing` 只写 typed system message + `TurnExecution.terminalReason`
  （必要时再加独立 recovery event），不要写 legacy `audit`。
- 立场：**P2，已关闭。**

#### F-07 `post_message` 多 target 上限与 Clowder 单 successor 不一致（P2，已拍 A）

> 2026-11-13 已拍 `DP-F018SURFACE-1=A`：`post_message`/`cross_post_message` 单
> successor；`multi_mention` 是唯一多 target fan-out。0007/0014/plan/F018 已同步。

- Clowder：`post_message` 工具描述强调 same-thread single successor；多 cat 的
  deliberate fan-out 走 `multi_mention`。
- codeteam：`0007` §3.8 曾允许 `post_message` / `cross_post_message` targets ≤8；
  2026-11-13 DP-F018SURFACE-1=A 已收敛为单 successor。
- 问题：如果 `post_message` 自己就能 8-way fan-out，`multi_mention` 的独立存在更没
  语义；如果 `multi_mention` 保留 Clowder 聚合语义，`post_message` 多 target 又成了
  第二套 fan-out。
- 建议：先定工具分工：`post_message` 单 successor；多 target 只走一个明确的 fan-out
  入口（删除 multi_mention 或让它成为唯一 fan-out）。不要同时保留两套。
- 立场：**P2，已关闭为 A。**

#### F-08 A2A depth：audit 前提错误，Clowder 实际默认 15（P2，已拍 A：15+guards）

> 2026-11-13 source audit correction：`route-helpers.ts` 注释写 “default: ... or 2”，
> 但实际 `getMaxA2ADepth()` 返回 `Number(process.env.MAX_A2A_DEPTH) || 15`；
> `env-registry.ts` 默认 15，`ConfigRegistry.ts` 也是 15。`ConfigStore` 的 UI
> 校验范围是 0–10；callback 路径无 worklist 时 fallback 10。`MAX_A2A_MENTION_TARGETS=2`
> 是“单条消息最多 @ 2 只猫”，不是 depth。

- Clowder review 链 `A→B→A→B→A` 是预期场景：durable lineage 的 depth 是“接收 turn
  前已完成的 A2A edges”，不是“同一只猫连续次数”；15 正是为多轮 review 保留的。
- Ping-pong breaker 在同 pair 连续 4 次**且无实质工作**时才断；F167 Phase D 已加
  substantive tool/long-output 豁免，避免误杀正常 review。depth 是成本兜底，不是
  review 的主要限制器。
- codeteam 旧建议“回到 2–3”会直接杀掉用户举的 review 链，**撤回**。
- 决定（2026-11-13 `DP-F018SURFACE-2=A`）：保留 15 + per-thread queue cap 5 +
  substantive-aware ping-pong（warn 2/block 4，实质 tool/长输出豁免）+ early-stop。
  10 作为成本敏感备选，不再需要。
- 立场：**P2，已关闭为 A。**

#### F-09 Hub read models 只有概念，没有契约（P2，已拍 A：DTO ownership）

> 2026-11-13 已拍 `DP-F018SURFACE-3=A`：F018 定义 `QueueView` /
> `LiveInvocationView` / `MessageDispatchSummary` domain DTO；W7a 只做 Hub transport
> 映射；`ThreadUnread/MentionView` 归 W7a/v2。0007 §3.10 已补 DTO 字段/排序/降级。

- codeteam：`0007` 有 `MessageDispatchSummary`、`getThreadLiveInvocations` 的名字。
  `getThreadLiveInvocations` 已在 DP-F018RECOVERY 补字段/evidence rank；
  `MessageDispatchSummary` 仍只有一句，`QueueView` / unread / mention 没有契约。
- 问题：Hub 需要 queue 面板、processing/live、dispatch 状态、unread/mention；
  这些不能靠 UI 直接拼 `invocation_attempts`。没有 read model 契约，W7a 会各拼一套。
- 决定：F018 定义前三个 domain DTO；W7a 只做 transport/DTO 映射；
  `ThreadUnread/MentionView` 归 W7a/v2，不反推 F018 状态。
- 立场：**P2，已关闭为 A；W7a 按 DTO 映射实现。**

#### F-10 queue cap/priority 未定（P2，已自决）

> 2026-11-13 已按推荐落 0007 §3.1：user/A2A 分开计数，cap 5；urgent 先、同
> priority FIFO；operator processNext 只处理自己的 head；queue full 429 不写 source。

- Clowder：user source queue cap 5（`InvocationQueue.ts:167`）；priority 有
  urgent/normal；position/order 明确。
- codeteam：`0007` 曾只有 invocation_queue 的 priority/position，没有 cap/排序/
  operator processNext 的边界；post/cross 单 target、multi_mention 2-3 与 queue cap
  不是同一维度。
- 问题：没有 cap，Hub 可能无限排队；没有排序，operator 手动 processNext 与自动
  drain 可能不一致。
- 建议：R2 前定：source queue cap（建议先 5，与 Clowder 对齐）、priority 规则、
  同 priority FIFO、operator 手动处理只能处理自己的 head、queue full 429 不写 source。
- 立场：**P2，已关闭。**

#### F-11 session restore/compaction 缺失（P2，scope cut）

- Clowder：session chain active/sealing/sealed + restore/compact/transcript；长 thread
  可以恢复和压缩。
- codeteam：v1 只做 active + lightweight seal；无 restore/compact/transcript。
- 问题：长 thread 的 prompt 只靠 ContextAssembler + delivery cursor；上下文膨胀、
  provider 重启/恢复、跨 session 连续性都没有 Clowder 的兜底。对 operator journey
  不是立即 blocking，但会是长会话体验缺口。
- 建议：保留 v2 决策，但在 F018 验收里明确“长 thread/恢复不在 v1”；W7a 需要
  `session_restore_unavailable` 的显式降级，不要让 UI 以为有 restore。
- 立场：**P2，scope 明确即可，不在 v1 硬补。**

#### F-12 draft flush 100ms/4KB vs Clowder 2s/2000 chars（P3，R2 benchmark）

> 2026-11-13 0007/plan 已标 100ms/4KB 为 provisional；R2 做 write amplification/
> 延迟 benchmark，允许调 250–500ms。

- Clowder：`route-serial.ts:1762` / `route-parallel.ts:1137` 是 2s / 2000 chars。
- codeteam：`0007` §3.6.1 目标 100ms/4KB，理由是更快的刷新/重连体验。
- 问题：SQLite 单写者 + 100ms flush 可能放大写锁竞争；Clowder 的 2s 是 Redis/
  低写入压力的选择。没有 benchmark 就改 20 倍频率，属于“体验目标未验证”。
- 建议：R2 做一次 write amplification/延迟 benchmark；先保留 100ms 作为目标，但
  允许按实测调到 250–500ms；不要把它写成不可变契约。
- 立场：**P3，benchmark 后再定。**

#### F-13 命名差异（P3，合理）

- Clowder `succeeded` → codeteam `completed`；Clowder `invocationId` 是 child，
  codeteam `invocationId` 是 parent、child 用 `turnExecutionId`、
  `parentInvocationId` 是 FK；Clowder `clientMessageId` → codeteam
  `piExtToolCallId`。
- 判断：这些是必要的命名/坐标适配，已有 `0011`/`0013` 解释；保留。
- 建议：在 0007/0011 的对照表里继续标注“Clowder 名 / codeteam 名”，避免读者把
  `invocationId` 当 child。
- 立场：**P3，保留。**

#### F-14 `queue_admissions` receipt（P3，合理适配）

- Clowder：Redis queue ledger + message store idempotency；queue row 删除后靠
  ledger/message 索引重放。
- codeteam：SQLite queue row 会删除，所以加 `queue_admissions`
  `(source_record_id, attempt)` receipt + fingerprint。
- 判断：这是存储适配，不是语义分叉；保留。
- 注意：receipt 的 fingerprint 必须覆盖 immutable admission fields；queue entry
  terminal 删除后仍能 replay/conflict。
- 立场：**P3，保留。**

#### F-15 ResponseDraftStore 只有表/行为草图，没有 Store 契约（P2，已设计）

> 2026-11-13 契约已落 `0017-response-draft-store.md`：create + 全量 snapshot
> upsert(seq CAS) + getByTurn/getByThread + delete/listOrphans；无 TTL；T2 删除失败
> 保留 `response_pending`，T4 重试。状态 draft-for-review，待非作者 review 后实现。

- 已有：`response_drafts` 表、100ms/4KB bounded flush、`message_end` 覆盖、T2 删除、
  T4 用 draft 恢复 R。
- 本轮补齐：`ResponseDraftStore` interface；`create`/`upsertSnapshot(seq CAS)`；
  tool event 在 WorkerEventSink 内存按 `toolId` 合并；单 writer；初始行由 T1 dispatch
  创建；T2 删除失败/T4 重试；Hub 重连读取；orphan 清理；测试矩阵。
- 判断：契约已冻结，不再靠“表 + 一句行为”实现。
- 立场：**P2，契约已落；待非作者 review 后实现。**

### 3.3 DP-C 调查：Clowder 到底有没有 InvocationAttempt？

**结论：Clowder 没有“child 执行状态”的 InvocationAttempt。**

> 完整目标设计（attempt schema、状态机、migration、测试）见
> `0016-turn-terminal-and-settlement-design.md`。

Clowder 的 attempt 是 **QueueTargetAttempt**，属于 Queue 投递/重试台账：

- `packages/shared/src/types/queue-receipt.ts:250-287`：
  `QueueTargetAttempt` = “one immutable delivery attempt for one target of an authored
  Queue message”；retry 永远 append 新 attempt，不重写旧 attempt。
- 它的 state 是投递状态：`queued | starting | appended | failed | interrupted |
  cancelled | handled`；字段含 `sequence`、`invocationId`、`seenAt`、
  `activeAppendAcceptedAt`、`terminalReason`。
- child 执行状态只有 `TurnExecutionRecord.status`：
  `running | succeeded | failed | canceled | interrupted`（`TurnExecutionStore.ts`、
  `RedisTurnExecutionStore.ts`）。
- parent `InvocationRecord` 只有 `status`（queued/running/succeeded/failed/canceled）
  和 attempt-scoped `executionStartedAt`；`executionStartedAt` 是“本轮 claim 到达 route”
  的 receipt，不是第二套终态机。
- retry 时 parent `failed → running` 重新 claim；新的 attempt append；新的 child
  `TurnExecution`；旧 child/attempt 不改。

**codeteam 的根因**：`0007` 的 `invocation_attempts` 把两层合并了：

- `state` 复制了 TurnExecution 的五态（running/completed/failed/...）；
- 同时又有 `turnExecutionId` 指向 child；
- 于是同一个 child 既有 `TurnExecution.status`，又有 `InvocationAttempt.state`，
  且两者都接受 terminal 写入。这不是 Clowder 的模型，是 codeteam 自己造的第三层。

**修正（已拍 A）**：

- `InvocationAttempt` 改名为/收敛为 `QueueTargetAttempt` 语义：
  `delivery_state = queued | starting | appended | handled | failed | interrupted | canceled`；
  它只回答“这次投递/执行尝试走到了哪”，不回答 child 的 provider 终态。
- `TurnExecution.status` 是 child canonical；`InvocationAttempt` 的
  `handled/failed/interrupted/canceled` 是从 child terminal + delivery outcome
  投影/同事务记录，不是第二个 terminal 决策者。
- `settlement` 仍可保留在 attempt 上，但它是 response settlement 投影，不是 child
  execution state；`running/completed` 不再出现在 attempt state。
- 迁移：`invocation_attempts.state` → `delivery_state` 映射
  `queued→queued`、`running→appended`、`completed→handled`、
  `failed→failed`、`interrupted→interrupted`、`canceled→canceled`；
  `turn_execution_id` 保留为 child 链接。

### 3.4 DP-D 调查：settlement 为什么重叠？

**结论：Clowder 的 settlement 是四层分工；codeteam 的 `settleAgentTurn` 把它们
压成了一个 god-service，所以看起来和 route/invokeSingleAgent 重叠。**

> 完整目标设计（四层 owner、事务边界、错误/取消/恢复）见
> `0016-turn-terminal-and-settlement-design.md`。

Clowder 实际 owner：

| 阶段 | owner | 做什么 | 证据 |
|---|---|---|---|
| child terminal | `invoke-single-cat.ts`（`finally`） | `TurnExecutionStore.transitionTerminal`；注册失败时 `registry.commitTerminal(failed)` | `invoke-single-cat.ts:2118/2133`、`:6397` |
| auth projection | `CallbackAuthTurnExecutionLifecycle` | 先 canonical `TurnExecution.transitionTerminal`，再 `registry.commitTerminal`；startup 修复 crash window | `CallbackAuthTurnExecutionLifecycle.ts:66-83` |
| response R + draft | `route-serial` / `route-parallel` | append/commit response R；`draftStore.delete`；A2A successor admission | `route-serial.ts:3488+`、`route-parallel.ts:2015+` |
| parent aggregate + queue | `QueueProcessor` | `InvocationRecord` aggregate、queue entry terminal/retry、`onInvocationComplete`；失败后 `settleResponseFromDraft` 是 recovery | `QueueProcessor.ts:2865`、`:2669`、`:2717` |

关键点：

- `invoke-single-cat` 只负责“child 执行 + child terminal + auth terminal”；
  它不提交 response R，也不删 draft。
- route 只负责“这次 route 的 response 产物 + draft + A2A 后继”；
  它不写 parent aggregate，也不写 credential。
- `QueueProcessor` 只负责“parent/queue/retry”和 recovery；
  正常 route 的 R 不是它提交的。
- `settleResponseFromDraft` 是 recovery/second phase，不是正常 path 的唯一 settlement。

**codeteam 的根因**：`0007` §3.9 的 `settleAgentTurn` 同时封装
child terminal + attempt terminal + parent aggregate + credential + response settlement；
它把四个 owner 的职责合并，却没有定义“谁在正常路径调用它、谁在异常路径调用它”。
于是 `invoke-single-agent`、route、QueueProcessor 都可能触发 terminal/settlement，
既可能双提交，也可能留下 child terminal 但 R 未 settle 的中间态。

**修正（已拍 A）**：

- 删除 `settleAgentTurn` 这个 god-service 名称，改成一张明确 owner 表：
  1. `invoke-single-agent`：child `TurnExecution` terminal + credential terminalize；
  2. route（serial/parallel）：response R commit + draft delete + A2A successor；
  3. `QueueProcessor`：parent aggregate + queue entry terminal/retry；
  4. `settleResponseFromDraft`：只用于 recovery/response_pending 第二段。
- 正常路径的顺序：provider 结束 → child terminal（含 credential）→ route 提交 R →
  QueueProcessor 聚合 parent/queue；任何一步失败，由 `response_pending`/startup 恢复，
  不允许第二个 writer 重新 terminal child。
- 如果 codeteam 想要一个事务边界，应该叫 `commitRouteTurn` 或
  `commitResponseAndAggregate`，并明确只由 QueueProcessor/route 其中一个调用；
  不要叫 `settleAgentTurn` 并暗示所有层都调用。

> DP-C/DP-D 已于 2026-11-12 拍板 A/A；0007 §3.5/§3.6/§3.9/§4.3.1/§5.2.1/§9、
> 0005 和 plan P0-1 已同步。

### 3.5 设计史：为什么 codeteam 会留下这两个重叠

不是 Clowder 原有问题，而是 codeteam 两次设计动作的叠加：

1. **`28cfee444`（adopt Clowder-style target attempt retry）**：为了做
   append-only target attempt retry，引入 `invocation_attempts`。目标是“retry 追加
   attempt、旧 attempt 不可变”；但 schema 把 attempt state 写成了 TurnExecution 的
   五态（queued/running/completed/failed/...），而不是 Clowder `QueueTargetAttempt`
   的投递状态。于是 child 有了两个终态 writer。
2. **`086b4b1f2`（close Phase A contract gaps after re-triage）**：为了把
   provider/stream 与 terminal/settlement 分开，新增 `settleAgentTurn`（P0-1=A），
   把 child terminal + attempt terminal + parent aggregate + credential + R
   settlement 合成一个接口。它解决的是“routeSerial/routeParallel/QueueProcessor
   都写 terminal 会重复”的局部问题，但把 Clowder 已有的四层 owner 合并了。
3. **`a654788e5` / `09bdb678d`（runAgentTurn + routeAgents）**：routeSerial/routeParallel
   被抽成薄 scheduler，provider/stream 移到 invoke-single-agent；terminal/R/draft
   的归属随之下沉。`settleAgentTurn` 被设计成共享出口，但没有重新分配
   invoke/route/QueueProcessor 的 writer 边界，导致三处都能触发 settlement。

结论：这两个问题不是“Clowder 复用失败”，而是 codeteam 在两次局部收敛中用了
新的抽象（attempt 五态、god-service）替代 Clowder 已有的分层。修正方向应回到
Clowder 的边界，而不是再给 `settleAgentTurn` 加参数。

## 4. 当前 codeteam 还缺什么

按 owner 分，不要把所有缺件都塞给 F018。F018 是核心 runtime；Hub/CLI 是 W7a；
长会话/高级读模型是 v2。

### 4.1 F018 必须补的组件/契约

| 缺件 | 现状 | 建议 |
|---|---|---|
| `OperatorMessageIngress` 契约 | `0014` 只有概念；`0007` 没有 request/response/error/idempotency 定义 | 冻结输入（`threadId`/`content`/`targets`/`idempotencyKey`/`replyTo`）、输出（`message`/`queueEntryId`/`replayed`）、typed reject |
| Queue cap/priority/order | `invocation_queue` 有字段，没有常量/规则 | 建议 source cap 5、urgent/normal、同优先级 FIFO、operator 手动 processNext 只处理自己的 head |
| Read model DTO | `MessageDispatchSummary` 只有一句；live evidence rank 未定义 | 冻结 `QueueView` / `LiveInvocationView` / `DispatchSummary` / `UnreadMentionView` 字段、排序、分页、降级 |
| Operator decision 关联 | `replyTo`/`causal.triggerMessageId` 有，但没有“这是一个待决策问题”的 typed 关联 | 明确用 `replyTo` + `mentionsUser` 关联；定义 decision request/answer 的读模型 |
| Settlement single-writer | 已钉死 T1/T2/T3/T4 四层 owner | 只允许 T1 写 child/credential，T2 写 R/draft，T3 写 parent/queue，T4 修 R |

### 4.2 W7a / F016c 必须补的组件

| 缺件 | 现状 | 影响 |
|---|---|---|
| `POST /api/messages` 等 operator ingress | F016c discovery/signoff pending | 没有 operator 发消息入口，Journey A–H 无法端到端 |
| WebSocket/SSE + event replay/catch-up | 0007 只定义 `AgentStreamEvent` 语义 | Hub 无法收流式答复/断线恢复 |
| cancel / cancel-all / retry 控制 API | F018 只有 tracker/service 语义 | operator 无法从 UI 执行取消/重试 |
| operator auth/session | W7a 鉴权矩阵未落地 | 无法区分 operator / worker / webhook |
| Hub 兼容 DTO / thread/message 读面 | W7a 兼容子集未落地 | Hub 无法读 thread/queue/dispatch |

### 4.3 v2 / 明确不做

- session restore / compaction / transcript / full seal；
- unread badge / seenCursor / mentionAck（v1 只有 deliveryCursor）；
- connector/IM outbound streaming（Clowder StreamingOutboundHook 的对应面）；
- trajectory projector 完整版；
- custody / action lease / wait continuation / handoff。

### 4.4 迁移面（不是缺件）

当前 task-first `queue_entries` / `runs` / `agent_sessions` / `a2a_requests` /
`invocation_credentials` 不能直接当 F018 组件用。R1 要做的是：

- 旧表冻结/只读，新表重建；
- `runs → turn_executions`；`queue_entries → invocation_queue`；
- `a2a_requests` legacy；claim 迁到 credential `toolCallClaims`；
- `agent_sessions` 只迁 active，sealing/sealed 留 legacy。

这不是“再设计一套”，而是 0007 R1 已写明的迁移；不要把 legacy 代码的 task-first
字段带进新表。

## 5. 与 Clowder 的差异：哪些合理，哪些不合理

“理论上复用 Clowder 不应该有大差异”这句话只对**语义层**成立；存储/transport
本来就要换。把差异分三类，才能判断该不该保留。

| 差异 | 类型 | 是否有必要 | 判断 |
|---|---|---|---|
| SQLite vs Redis、单事务 vs Lua/CAS | 运行时基底 | 必要 | 保留；语义对齐，事务边界重写 |
| pi extension + control socket vs MCP callback | transport/auth | 必要 | 保留；principal/credential 语义对齐 |
| 无 task/custody/action/wait | v1 scope cut | 有意 | 保留；必须写成“不做”，不能写成“对齐” |
| 无 connector/IM/多租户 | 产品边界 | 必要/scope | 保留 |
| operator target vs `mentionsUser` | **语义新增（已退回）** | 已拍 DP-A=A | 已解决：`mentionsUser` |
| `multi_mention` 无 orchestrator | **同名异义** | **未证明** | P1，删除/改名或实现 Clowder 语义 |
| TurnExecution + Attempt 双状态 | **过度设计** | **未证明** | P1，单 canonical state |
| post_message targets ≤8 | **能力扩张** | **已拍 A：退回单 successor** | closed |
| A2A depth 15 vs 2 | **参数分叉（audit 前提错误：Clowder 实际 15）** | **已拍 A：15+guards** | P2；DP-F018SURFACE-2=A |
| draft flush 100ms/4KB vs 2s/2000 | **性能取舍** | **待 benchmark** | P3，实测后定 |
| `completed` vs `succeeded`、parent/child 命名 | 命名适配 | 必要 | 保留，持续标注对照 |
| `queue_admissions` receipt | SQLite 适配 | 必要 | 保留 |
| 无 session restore/compact | scope cut | 有意 | 保留 v2，但写明长会话缺口 |

**结论：**

- 核心 10 组件结构没有大分叉；分叉集中在 **operator 通知、fan-out 工具、child 状态**
  三个语义点，以及 **Hub 边缘层缺失**。
- 这三类语义分叉不是“复用 Clowder 必然产生的”，而是 codeteam 在 v1 自己新增的概念。
  如果它们没有比 Clowder 更简单的理由，就应该退回 Clowder 语义。
- 存储/transport/scope cut 的差异可以被“codeteam 是本地 SQLite + pi runtime +
  pure A2A v1”解释；operator target 已退回，multi_mention 已决定做全；只剩 attempt
  双状态和 settlement owner 已拍 A/A。

## 6. R1 前必须拍的决策

这不是要 operator 选技术 A/B，而是三个“要不要保留新增语义”的价值取舍。

| 决策 | 推荐 | 为什么 | 不拍的后果 |
|---|---|---|---|
| DP-A operator 通知 | **已拍 A：退回 `mentionsUser`**；B 不再考虑 | operator 不是执行 target；Clowder 已有 message flag；少一层 union/queue/depth | 已关闭 |
| DP-B `multi_mention` | **已拍 B：实现 Clowder orchestrator（status/timeout/callback/aggregate）**；A 不再考虑 | 同名异义会误导调用方；做就做全 | 已关闭；设计补进 0007 §3.8 |
| DP-C child 终态 | **已拍 A：TurnExecution 单 canonical，attempt 收敛为 QueueTargetAttempt** | Clowder 没有 child InvocationAttempt；codeteam 把投递 attempt 和 child state 混了 | 0007 §3.5/§4.3.1/§5.2.1 已同步 |
| DP-D settlement owner | **已拍 A：拆回四层 owner，删除 settleAgentTurn god-service** | Clowder 是 invoke/route/QueueProcessor/recovery 分层 | 0007 §3.6/§3.9/§9 已同步 |
| DP-E Hub 依赖 | **已拍 A：W7a 独立验收，F018 只验收 daemon/CLI**；B 不再考虑 | F016c 仍 discovery；F018 不应重写 transport | 已关闭 |

DP-A–E 已关闭；F-07/F-08/F-09 均已拍 A（见
`decision-packets/2026-11-12-dp-f018-surface-depth-readmodels.md`）。queue cap 可按推荐
自决，F-12 draft flush 留 R2 benchmark，不要现在写成不可变契约。

## 7. 证据索引

| 主题 | 证据 |
|---|---|
| Clowder multi_mention orchestrator | `packages/api/src/domains/cats/services/agents/routing/MultiMentionOrchestrator.ts`、`packages/api/src/routes/callback-multi-mention-routes.ts`、`packages/shared/src/types/multi-mention.ts` |
| Clowder operator mention | `packages/api/src/routes/user-mention.ts`、`packages/api/src/routes/callbacks.ts:1875`、`packages/api/src/domains/cats/services/stores/ports/MessageStore.ts:532` |
| Clowder child state | `packages/api/src/domains/cats/services/agents/invocation/QueueProcessor.ts:4113`、`PerCatTerminalDispositionCollector.ts` |
| Clowder route/stream | `route-serial.ts:481`、`route-parallel.ts:181`、`SocketManager.ts:437` |
| Clowder queue/retry | `InvocationQueue.ts:167`、`queue-retry-deferrals.ts` |
| codeteam operator target（历史） | `docs/architecture/0007-a2a-runtime-chain.md` §3.8；`0005` §3.3 |
| codeteam multi_mention | `docs/architecture/0007-a2a-runtime-chain.md` §3.8；`docs/plans/0020-f018-thread-first-runtime.md` R3 |
| codeteam terminal/attempt | `docs/architecture/0007-a2a-runtime-chain.md` §3.9、§4.3、§4.3.1、§5.2.1 |
| codeteam settlement | `docs/architecture/0007-a2a-runtime-chain.md` §3.6、§3.9；DP-F018TERM |
| codeteam recovery | `docs/architecture/0007-a2a-runtime-chain.md` §3.10；DP-F018RECOVERY |
| codeteam read models | `docs/architecture/0007-a2a-runtime-chain.md` §3.10；`0005` §5 |
| W7a/Hub dependency | `docs/features/F016-w7a-headless-surface.md:65`；`docs/plans/0004-w5-w8-scale-product.md:390` |



