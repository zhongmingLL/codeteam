---
title: "codeteam operator message journey — component audit"
doc_kind: architecture
status: draft-for-review
created: 2026-11-11
updated: 2026-11-11
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related_features: [codeteam/F018]
related: [0005-thread-first-runtime.md, 0010-a2a-runtime-chain.md, 0011-identity-contract.md, 0013-idempotency-key-map.md, 0014-operator-message-journey.md]
source: "Clowder local reference checkout; codeteam F018 design docs + current task-first code"
---

# codeteam operator message journey — component audit

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
5. **不要用“复用 Clowder”掩盖 scope cut**：v1 不做 custody、multi_mention 聚合、
   session restore/compaction、connector/IM；这些是明确决策，必须写成“有意不做”，
   不能写成“已对齐 Clowder”。

**审计 verdict：方向 approve，changes requested。**

- P1（R1 前必须解决）：F-01 Hub ingress/transport 缺件、F-02 operator target 分叉、
  F-03 multi_mention 语义不一致、F-04 TurnExecution/Attempt 双终态。
- P2（R2/R3 前解决）：F-05 settlement ownership、F-06 response_missing/audit、
  F-07 post_message 多 target、F-08 A2A depth 15、F-09 read models、F-10 queue cap、
  F-11 session restore scope。
- P3（可后置）：F-12 draft flush 调参、F-13 命名、F-14 queue admissions receipt。

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
  → settleAgentTurn
      child terminal + attempt terminal + parent aggregate
      + credential terminalize + response settlement
  → Hub projection（W7a）
      agent_message / message_lifecycle_updated / messages_delivered / queue_updated
```

这条链路与 0014 的 Clowder 链路一一对应；差异集中在：

- **入口/出口 transport**：Clowder socket.io + HTTP；codeteam W7a + SQLite。
- **target 语义**：Clowder 只有 agent targets + `mentionsUser`；codeteam 增加 operator target。
- **fan-out 工具**：Clowder `multi_mention` 有 orchestrator；codeteam v1 明确无聚合。
- **child 状态**：Clowder `TurnExecution` 单状态；codeteam 增加 attempt 状态。

## 2. Journey 矩阵：codeteam 目标态与缺口

| Journey | codeteam 设计 | 当前缺口 | 归属 |
|---|---|---|---|
| A 简单问答 | 完整：隐式路由 → queue → parent/child → R | Hub ingress/transport；prompt/session 实现 | W7a + F018 R2 |
| B `@A → A→B → B→operator → operator 回复 → B` | 设计存在，但 operator target 是新增语义 | `mentionsUser`/operator 未读投影；operator decision 关联 | F018 + W7a |
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
| ResponseDraft/R | DraftStore + processing R | `response_drafts` + attempt settlement | adapted | P2 |
| Credential/A2A tools | MCP callback + `clientMessageId` | pi extension + `piExtToolCallId` | adapted（合理） | P2 |
| Terminal collector | `PerCatTerminalDispositionCollector` | `PerAgent...`；DB latest attempt | aligned | P2 |
| Recovery | startup + zombie + owner reaper | 单 startup + 单 serialized reaper | adapted | P2 |
| Read models | live invocations + dispatch summary | 设计有 `MessageDispatchSummary`/live，Hub transport 缺 | **partial/missing** | P2 |
| Operator notification | `mentionsUser` + unread index | `QueueTarget operator` + `operatorNotifiedAt` | **problem** | P1 |

### 3.2 详细 findings

#### F-01 Hub ingress / event transport 缺失（P1，缺件）

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

- Clowder：agent `post_message` 的 `targetCats` 只放 cat；operator 通知由正文行首
  `@co-creator`/配置 handle 触发 `detectUserMention`，写 message `mentionsUser=true`；
  operator 回复是一条新的 user message（`user-mention.ts`、`callbacks.ts:1875`）。
- codeteam：`0010` §3.8 把 targets 定义为 `{kind:"agent"|"operator", id}`；operator-only
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

- Clowder：`multi_mention` 是完整 orchestrator：`MultiMentionOrchestrator` 维护
  `pending/running/partial/done/timeout/failed`、3–20 分钟 timeout、`callbackTo`、
  每 target response、聚合结果消息、status endpoint、anti-cascade；见
  `MultiMentionOrchestrator.ts`、`callback-multi-mention-routes.ts`、
  `packages/shared/src/types/multi-mention.ts`。
- codeteam：`0010` §3.8 / `0020` R3 定义 `multi_mention` 为 2–3 targets 的 fan-out，
  明确 **no orchestrator/status/timeout/aggregate callback**；只是“一条 message + 一个
  queue entry + 一个 parent + N children”。
- 问题：同名不同义是最危险的复用偏差。调用方会以为能拿到聚合结果/超时/状态，
  实际只得到普通并行 post；后续实现者也可能按 Clowder 语义补 orchestrator，造成双路径。
- 建议：二选一——(A) 删除 `codeteam_multi_mention`，用 `post_message` 多 targets
  表达并行（codeteam 已有多 target 路由）；(B) 真正实现 Clowder 的 orchestrator
  （status/timeout/callback/aggregate），并把它纳入 R3/R4 验收。不要保留“假 multi_mention”。
- 立场：**P1，必须在 R1/R2 前定；默认 A（删除/改名）。**

#### F-04 TurnExecution 与 InvocationAttempt 双终态（P1，设计问题）

- Clowder：`TurnExecutionRecord` 是 child canonical；status
  `running/completed/failed/interrupted/canceled`，terminal first-write-wins。
  `InvocationRecord` 是 parent；没有第二个 child state。
- codeteam：`0010` §4.3 `TurnExecution` 有 status；§4.3.1 `invocation_attempts` 又有
  `state`（同五态）和 `settlement`；child terminal 与 attempt terminal 同事务更新。
- 问题：同一个 child 有两个 canonical state。只要任一路径漏写/重试/恢复顺序不同，
  collector、reaper、response settlement 就会读到矛盾状态；`state` 还会与
  `TurnExecution.status` 的 first-write-wins 语义重复。
- 建议：定义唯一 canonical——`TurnExecution.status` 对已启动 child 是 canonical；
  `invocation_attempts.state` 只保留 prestart 状态（无 TurnExecution 的 failed/canceled）
  或改为从 TurnExecution 派生的 projection；禁止两个字段各自接受 terminal write。
- 立场：**P1，改成单状态源；否则 R2 的 terminal/E2E 会分叉。**

#### F-05 settleAgentTurn 与 route/invokeSingleAgent 职责重叠（P2，设计问题）

- Clowder：routeSerial/routeParallel 负责 response commit、draft delete、A2A successor；
  QueueProcessor 负责 parent/child/admission；`invokeSingleCat` 只产流。
- codeteam：`0010` §3.6/§3.9 说 `invoke-single-agent` 只负责 provider/stream；
  `settleAgentTurn` 封装 child terminal + attempt terminal + parent aggregate +
  credential + response settlement；但 `routeExecution` 仍被描述为执行链的一环，
  没有写清谁调用 `settleAgentTurn`、谁提交 R、谁删 draft。
- 问题：如果 route 和 QueueProcessor 都能触发 terminal/settlement，会出现双提交或
  “child terminal 了但 R 未 settle”的中间态。
- 建议：写一张“单一 writer”表：QueueProcessor 只做 admission/parent 生命周期；
  route 只返回 `AgentTurnResult`；`settleAgentTurn` 是唯一 child/attempt/credential/R
  settlement 入口；`invoke-single-agent` 不写 terminal。或者反过来，明确 route 是
  per-child settlement owner，QueueProcessor 只聚合 parent。二选一。
- 立场：**P2，先钉 owner 再实现。**

#### F-06 `response_missing` 使用 legacy audit（P2，不一致）

- codeteam：`0010` §3.10 / §9.5 说 R 缺失走 `response_missing` recovery：
  attempt failed + system message/audit；同时 §3.1 又说 `audit` 是 task-first 遗留，
  不属于 A2A message/lifecycle 契约。
- 问题：A2A 恢复依赖一个被声明为 legacy 的表面，读模型/审计边界会漂移。
- 建议：`response_missing` 只写 typed system message + `TurnExecution.terminalReason`
  （必要时再加独立 recovery event），不要写 legacy `audit`。
- 立场：**P2，改。**

#### F-07 `post_message` 多 target 上限与 Clowder 单 successor 不一致（P2，待论证）

- Clowder：`post_message` 工具描述强调 same-thread single successor；多 cat 的
  deliberate fan-out 走 `multi_mention`。
- codeteam：`0010` §3.8 允许 `post_message` / `cross_post_message` targets ≤8。
- 问题：如果 `post_message` 自己就能 8-way fan-out，`multi_mention` 的独立存在更没
  语义；如果 `multi_mention` 保留 Clowder 聚合语义，`post_message` 多 target 又成了
  第二套 fan-out。
- 建议：先定工具分工：`post_message` 单 successor；多 target 只走一个明确的 fan-out
  入口（删除 multi_mention 或让它成为唯一 fan-out）。不要同时保留两套。
- 立场：**P2，随 F-03 一起定。**

#### F-08 A2A depth 15 与 Clowder 2 的差异（P2，待论证）

- Clowder：route-helpers 默认 `MAX_A2A_DEPTH` 2（env 可调）。
- codeteam：`0010` §3.8 定 depth 15。
- 问题：15 跳会显著放大 loop/延迟/成本；仅靠 `a2a_duplicate_delivery` 和
  `pi_ext_tool_call_conflict` 不足以解释为什么需要 7.5 倍于 Clowder 的上限。
- 建议：给出真实场景（例如多 agent review 链）和成本估算；否则回到 2–3。若保留 15，
  必须有 per-thread depth budget 和 early-stop 测试。
- 立场：**P2，先证明再保留。**

#### F-09 Hub read models 只有概念，没有契约（P2，缺件）

- codeteam：`0010` 有 `MessageDispatchSummary`、`getThreadLiveInvocations` 的名字，
  但 `MessageDispatchSummary` 只有一句“简单 read model”；没有字段、分页、排序、
  evidence rank；`getThreadLiveInvocations` 的 evidence rank 也没定义。
- 问题：Hub 需要 queue 面板、processing/live、dispatch 状态、unread/mention；
  这些不能靠 UI 直接拼 `invocation_attempts`。没有 read model 契约，W7a 会各拼一套。
- 建议：在 W7a/F018 交界处冻结 4 个 read DTO：`QueueView`、`LiveInvocationView`、
  `MessageDispatchSummary`、`ThreadUnread/MentionView`；每个给字段、排序、分页、
  新鲜度/降级语义。
- 立场：**P2，补契约；实现可后置。**

#### F-10 queue cap/priority 未定（P2，缺件）

- Clowder：user source queue cap 5（`InvocationQueue.ts:167`）；priority 有
  urgent/normal；position/order 明确。
- codeteam：`0010` 只说 invocation_queue 有 priority/position，没有 cap/排序/
  operator processNext 的边界；targets ≤8 与 queue cap 不是同一维度。
- 问题：没有 cap，Hub 可能无限排队；没有排序，operator 手动 processNext 与自动
  drain 可能不一致。
- 建议：R2 前定：source queue cap（建议先 5，与 Clowder 对齐）、priority 规则、
  同 priority FIFO、operator 手动处理只能处理自己的 head、queue full 429 不写 source。
- 立场：**P2，补常量/规则。**

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

#### F-12 draft flush 100ms/4KB vs Clowder 2s/2000 chars（P3，待 benchmark）

- Clowder：`route-serial.ts:1762` / `route-parallel.ts:1137` 是 2s / 2000 chars。
- codeteam：`0010` §3.6.1 目标 100ms/4KB，理由是更快的刷新/重连体验。
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
- 建议：在 0010/0011 的对照表里继续标注“Clowder 名 / codeteam 名”，避免读者把
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

## 4. 当前 codeteam 还缺什么

按 owner 分，不要把所有缺件都塞给 F018。F018 是核心 runtime；Hub/CLI 是 W7a；
长会话/高级读模型是 v2。

### 4.1 F018 必须补的组件/契约

| 缺件 | 现状 | 建议 |
|---|---|---|
| `OperatorMessageIngress` 契约 | `0014` 只有概念；`0010` 没有 request/response/error/idempotency 定义 | 冻结输入（`threadId`/`content`/`targets`/`idempotencyKey`/`replyTo`）、输出（`message`/`queueEntryId`/`replayed`）、typed reject |
| Queue cap/priority/order | `invocation_queue` 有字段，没有常量/规则 | 建议 source cap 5、urgent/normal、同优先级 FIFO、operator 手动 processNext 只处理自己的 head |
| Read model DTO | `MessageDispatchSummary` 只有一句；live evidence rank 未定义 | 冻结 `QueueView` / `LiveInvocationView` / `DispatchSummary` / `UnreadMentionView` 字段、排序、分页、降级 |
| Operator decision 关联 | `replyTo`/`causal.triggerMessageId` 有，但没有“这是一个待决策问题”的 typed 关联 | 明确用 `replyTo` + `mentionsUser`（或 operator target）关联；定义 decision request/answer 的读模型 |
| Settlement single-writer | `settleAgentTurn`/route/QueueProcessor 边界未钉死 | 写一张 owner 表，只允许一个组件提交 child/attempt/R/credential terminal |

### 4.2 W7a / F016c 必须补的组件

| 缺件 | 现状 | 影响 |
|---|---|---|
| `POST /api/messages` 等 operator ingress | F016c discovery/signoff pending | 没有 operator 发消息入口，Journey A–H 无法端到端 |
| WebSocket/SSE + event replay/catch-up | 0010 只定义 `AgentStreamEvent` 语义 | Hub 无法收流式答复/断线恢复 |
| cancel / cancel-all / retry 控制 API | F018 只有 tracker/service 语义 | operator 无法从 UI 执行取消/重试 |
| operator auth/session | W7a 鉴权矩阵未落地 | 无法区分 operator / worker / webhook |
| Hub 兼容 DTO / thread/message 读面 | W7a 兼容子集未落地 | Hub 无法读 thread/queue/dispatch |

### 4.3 v2 / 明确不做

- session restore / compaction / transcript / full seal；
- unread badge / seenCursor / mentionAck（v1 只有 deliveryCursor）；
- connector/IM outbound streaming（Clowder StreamingOutboundHook 的对应面）；
- `multi_mention` orchestrator（如果 F-03 选择保留 Clowder 语义，则升级为 v1/F018；
  如果选择删除，则不需要）；
- trajectory projector 完整版；
- custody / action lease / wait continuation / handoff。

### 4.4 迁移面（不是缺件）

当前 task-first `queue_entries` / `runs` / `agent_sessions` / `a2a_requests` /
`invocation_credentials` 不能直接当 F018 组件用。R1 要做的是：

- 旧表冻结/只读，新表重建；
- `runs → turn_executions`；`queue_entries → invocation_queue`；
- `a2a_requests` legacy；claim 迁到 credential `toolCallClaims`；
- `agent_sessions` 只迁 active，sealing/sealed 留 legacy。

这不是“再设计一套”，而是 0010 R1 已写明的迁移；不要把 legacy 代码的 task-first
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
| operator target vs `mentionsUser` | **语义新增** | **未证明** | P1，默认退回 `mentionsUser` |
| `multi_mention` 无 orchestrator | **同名异义** | **未证明** | P1，删除/改名或实现 Clowder 语义 |
| TurnExecution + Attempt 双状态 | **过度设计** | **未证明** | P1，单 canonical state |
| post_message targets ≤8 | **能力扩张** | **未证明** | P2，和 F-03 一起定 |
| A2A depth 15 vs 2 | **参数分叉** | **未证明** | P2，先证明场景/成本 |
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
  pure A2A v1”解释；operator target / multi_mention / attempt 双状态不能。

## 6. R1 前必须拍的决策

这不是要 operator 选技术 A/B，而是三个“要不要保留新增语义”的价值取舍。

| 决策 | 推荐 | 为什么 | 不拍的后果 |
|---|---|---|---|
| DP-A operator 通知 | **A：退回 `mentionsUser`**；B：保留 operator QueueTarget 并补论证 | operator 不是执行 target；Clowder 已有 message flag；少一层 union/queue/depth | queue/dispatchRefs/未读投影会围绕错误概念建表 |
| DP-B `multi_mention` | **A：删除/改名为 parallel post**；B：实现 Clowder orchestrator | 同名异义会误导调用方；codeteam 已有多 target 并行 | R3 会做出一个“没有聚合的 multi_mention”，以后再加 orchestrator 变双路径 |
| DP-C child 终态 | **A：TurnExecution 单 canonical，attempt 只做 prestart/binding**；B：attempt 单 canonical | 两个 state 会出现 terminal 分叉；Clowder 是单 child state | collector/reaper/R settlement 读错状态，E2E 难收敛 |
| DP-D settlement owner | **A：`settleAgentTurn` 单一 writer**；B：route per-child writer | 双 writer 会双提交/漏提交 | terminal/R/draft 中间态无法证明 |
| DP-E Hub 依赖 | **A：W7a 作为独立依赖，F018 只验收 daemon/CLI**；B：F018 内做 Hub | F016c 仍 discovery；F018 不应重写 transport | 把 W7a 缺件算进 F018，验收口径失真 |

建议 R1 前只拍 A–E 五项；其余（queue cap、draft flush、A2A depth）可以在 R2
实现时用 benchmark/真实场景补证，不要现在写成不可变契约。

## 7. 证据索引

| 主题 | 证据 |
|---|---|
| Clowder multi_mention orchestrator | `packages/api/src/domains/cats/services/agents/routing/MultiMentionOrchestrator.ts`、`packages/api/src/routes/callback-multi-mention-routes.ts`、`packages/shared/src/types/multi-mention.ts` |
| Clowder operator mention | `packages/api/src/routes/user-mention.ts`、`packages/api/src/routes/callbacks.ts:1875`、`packages/api/src/domains/cats/services/stores/ports/MessageStore.ts:532` |
| Clowder child state | `packages/api/src/domains/cats/services/agents/invocation/QueueProcessor.ts:4113`、`PerCatTerminalDispositionCollector.ts` |
| Clowder route/stream | `route-serial.ts:481`、`route-parallel.ts:181`、`SocketManager.ts:437` |
| Clowder queue/retry | `InvocationQueue.ts:167`、`queue-retry-deferrals.ts` |
| codeteam operator target | `docs/architecture/0010-a2a-runtime-chain.md` §3.8；`0005` §3.3 |
| codeteam multi_mention | `docs/architecture/0010-a2a-runtime-chain.md` §3.8；`docs/plans/0020-f018-thread-first-runtime.md` R3 |
| codeteam terminal/attempt | `docs/architecture/0010-a2a-runtime-chain.md` §3.9、§4.3、§4.3.1、§5.2.1 |
| codeteam settlement | `docs/architecture/0010-a2a-runtime-chain.md` §3.6、§3.9；DP-F018TERM |
| codeteam recovery | `docs/architecture/0010-a2a-runtime-chain.md` §3.10；DP-F018RECOVERY |
| codeteam read models | `docs/architecture/0010-a2a-runtime-chain.md` §3.10；`0005` §5 |
| W7a/Hub dependency | `docs/features/F016-w7a-headless-surface.md:65`；`docs/plans/0004-w5-w8-scale-product.md:390` |



