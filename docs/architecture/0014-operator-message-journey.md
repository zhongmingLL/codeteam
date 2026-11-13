---
title: "Operator message journey — Hub ingress to streaming reply"
doc_kind: architecture
status: draft-for-review
created: 2026-11-11
updated: 2026-11-11
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related_features: [codeteam/F018]
related: [0005-thread-first-runtime.md, 0010-a2a-runtime-chain.md, 0011-identity-contract.md, 0013-idempotency-key-map.md]
source: "Clowder local reference checkout; codeteam F018 0005/0010/0011/0013"
---

# Operator message journey — Hub ingress to streaming reply

> 目的：把 operator 在前端发出一句话，到 Hub 收到流式答复的完整链路拆开。
> 这不是新契约，而是 F018 目标态的全链路说明：哪些组件负责什么、哪些状态落在哪里、
> cancel/retry/queue/operator-decision 分别插在哪一段。
>
> 参考实现：Clowder 本地只读 checkout。本文路径均为 repo-relative，不是 codeteam 的
> runtime dependency。codeteam v1 的规范契约仍以 `0005`、`0010`、`0011`、`0013` 为准。
> codeteam 侧的逐组件缺件/差异审计见 `0015-codeteam-operator-journey-audit.md`。

## 0. 结论先行

1. **一条 operator 消息不是“直接调用模型”**。它先被持久化为 source message，再进入
   Queue；QueueProcessor claim 后创建 parent `InvocationRecord`，每个 target agent 一个
   child `TurnExecution`，最后才进入 prompt/provider。
2. **Hub 看到的不是模型 token，而是四类服务端投影**：
   - `agent_message`：流式 text/tool/done/error；
   - `message_lifecycle_updated`：processing R → terminal R 的 durable 快照；
   - `messages_delivered` / `queue_updated`：source 从 Queue 进入 History、队列变化；
   - `spawn_started` / `intent_mode` / `heartbeat`：运行态提示。
3. **Queue 不是 History**。source message 在 admission 时写 `deliveryStatus='queued'`，
   真正进入 History 是 delivery 时；UI 不能把 queued 行直接渲染成一条永久消息。
4. **draft 不是消息**。流式正文先写 `response_drafts`；它是 processing R 的 in-flight
   body，R terminal 后删除。刷新/重连时，draft 只折叠进它对应的 processing R。
5. **cancel 是控制面，不是再发一条消息**。单 cancel 只 abort 某个 `(thread, agent)`
   slot；cancel all 还 abort 整个 batch gate、retire pre-start reservation，并抑制自动
   resume。两者都不能把已 terminal 的 sibling 重新拉起来。
6. **agent 找 operator 决策不是“给 operator 发 A2A 队列任务”**。Clowder 用
   agent message + 行首 `@co-creator`/`@user`（`mentionsUser`）通知 operator；operator
   回复是一条新的 user message，重新走 ingress。codeteam v1 采用同一语义：
   operator 不是 `QueueTarget`，只写 message `mentionsUser`。

## 1. 组件分层（Clowder 参考）

| 层 | 组件 | 责任 | 关键事实 |
|---|---|---|---|
| Hub / transport | Web Hub、socket.io rooms | 发 `POST /api/messages`；收 `agent_message` / `queue_updated` / `message_lifecycle_updated` / `messages_delivered` | 事件按 `thread:<threadId>` room 隔离；`agent_message` 注入 thread-scoped `seq`/`seqEpoch` |
| Ingress | `routes/messages.ts` | 身份、thread guard、replyTo 校验、target/intent 解析、Queue admission | `POST /api/messages` 在 `messages.ts:328`；`InvocationQueue.send` 在 `InvocationQueue.ts:711` |
| Durable stores | MessageStore、InvocationQueue/QueueLedger、InvocationRecordStore、TurnExecutionStore、DraftStore、InvocationRegistry、DeliveryCursorStore | source/history、queue、parent/child、draft、auth、read cursor | 单条 source + queue entry 在同一事务；Queue row 删除后由 `queue_admissions` 重放 |
| Orchestration | QueueProcessor、AgentRouter、routeSerial/routeParallel、InvocationTracker、PerCatTerminalDispositionCollector | 选下一条、claim、建 parent、start slot、选串/并行、聚合终态 | `QueueProcessor.executeEntry` 是主事务边界；`routeExecution` 才进入 per-agent pipeline |
| Execution | invokeSingleCat、provider adapter、SessionManager、SystemPromptBuilder、ContextAssembler、MCP tools | session、prompt/history、provider、stream、tool calls | `invokeSingleCat` 只负责一次 child 执行；消息持久化在 route 层 |
| Projection/recovery | lifecycle update、live invocation projection、StartupReconciler、InvocationOwnerReaper、TrajectoryProjector | 给 UI 的 durable/live 投影、重启恢复、僵尸收敛 | Clowder 的 `InvocationRegistry` 不提供 live listing；恢复看 canonical TurnExecution + queue |

### 1.1 codeteam v1 映射

| Clowder | codeteam v1 | 差异 |
|---|---|---|
| `routes/messages.ts` + `InvocationQueue.send` | `OperatorMessageIngress` + `InvocationQueue.enqueue` | codeteam 用 SQLite 单事务；A2A 工具走 pi extension，不走 MCP |
| socket.io `agent_message` | daemon control-plane event channel → W7a Hub transport | F018 只定义事件语义；Hub WebSocket/API 路由属 W7a |
| Redis DraftStore | `response_drafts` 表 | codeteam bounded flush 目标 100ms/4KB；Clowder 当前 2s/2000 chars |
| MCP callback auth | `InvocationCredential` + local control socket | token 绑 child TurnExecution；无 task/role/run |
| task-first queue / custody | `invocation_queue` + `invocation_records` | v1 不读不写 tasks/handoffs/custody |
| `@co-creator` mention | message `mentionsUser=true` | 同一语义；operator 不是 QueueTarget，不创建 queue/parent/TurnExecution |

## 2. 入口：Hub 发出消息

### 2.1 `POST /api/messages`

Clowder `messages.ts:328` 的顺序：

1. 解析 JSON/multipart：`content`、`threadId`、`idempotencyKey`、`mentions`、
   `replyTo`、`contentBlocks`、whisper/live 等。
2. 解析 user：`resolveUserId`；strict identity 与 compatibility fallback 分开。
3. thread guard：thread 不存在/soft-deleted/正在删除 → typed reject；首次消息可自动
   title。
4. `replyTo` 校验：必须同 thread、未删除、已发布、非 internal/non-quotable；whisper
   还要求可见性匹配。
5. target resolution（见 §2.2）。
6. `InvocationQueue.send`：**message append + queue entry + queue_admissions 同一事务**；
   `deliveryStatus='queued'`；幂等键由客户端提供或服务端生成。
7. 队列满 → HTTP 429 `QUEUE_FULL`，不写 ghost message。
8. `onQueueEntriesAdmitted` 发布 participants；`messages_queued`/`queue_updated` 只做
   Queue 投影，不把 source 提前塞进 History。
9. `notifyAdmission` 唤醒 QueueProcessor 的 per-thread drain。

### 2.2 target / intent 解析

Clowder `AgentRouter.resolveTargetsAndIntent`（`AgentRouter.ts:1400`）：

- 当前消息有显式 mention（UI `mentions` 或正文行首 `@cat`）→ 只取这些 targets；
- 无显式 mention → 隐式链（`AgentRouter.ts:1240-1272`）：
  1. 上一条 human message 的 mentions；
  2. 最近有响应且 healthy 的 participant（`recent_replier`）；
  3. thread preferred cat；
  4. 任意可用 participant；
  5. default cat。
- `parseIntent`（`IntentParser.ts:162`）：≥2 targets 且无显式 intent → `ideate`；
  1 target → `execute`。
- `strategy`：`ideate && targetCats.length > 1` → `parallel`，否则 `serial`
  （`AgentRouter.ts:1529`）；实际 dispatch 在 `AgentRouter.ts:1584`。

> 注意：`@agentA @agentB` 在 Clowder 默认就是 2 targets → `ideate` → `parallel`。
> `#execute` 可强制串行；`#ideate` 可强制并行。

### 2.3 入口幂等

- Clowder 的 message 幂等键是 `(userId, threadId, idempotencyKey)`；
  `InvocationQueue.send` 先用 `getByIdempotencyKey` 找已提交 source，再在同一事务里
  建 message + queue entry。
- 同 key + 同 payload → 返回原 message/entry；同 key 不同 payload → conflict；
  队列行已删除但 admission receipt 还在 → `queue_admissions` 重放。
- codeteam v1 的 A2A tool 客户端键是 `piExtToolCallId`（pi extension 从
  `toolCallId + toolName` 派生）；claim 放 `InvocationCredential.toolCallClaims`。
  operator/Hub 入口仍用 `(threadId, idempotencyKey)`，Hub API 幂等是 W7a 独立缺口。

## 3. QueueProcessor：排队、claim、admission

### 3.1 drain 是 per-thread 单写者

Clowder `QueueProcessor`（`QueueProcessor.ts:650`）：

- 每个 thread 一个 event-driven drain owner + dirty bit；enqueue/terminal/reorder 都只
  `requestDrain`，不并发抢同一条。
- `tryExecuteNextForUser` 选下一条 queued entry；targetless 的 conversation entry 在
  thread 仍活跃时等待 idle；target busy 时跳过。
- claim 是 target-level：`markProcessingGroupDurable` 先占 exact target 集，再
  `startReservedEntry`。

### 3.2 `executeEntry` 的主顺序

`QueueProcessor.executeEntry`（`QueueProcessor.ts:4113`）：

```text
claim exact target set
  → InvocationRecordStore.create(parent; 幂等)
  → InvocationTracker.startAll(thread, targets, parentInvocationId)
  → parent status=running
  → emit spawn_started
  → AgentRouter.routeExecution(...)
      → per-agent pipeline
  → consume AgentMessage stream
      → broadcast agent_message
      → draft flush
  → terminal disposition collector
  → parent aggregate + credential + tracker release
  → onInvocationComplete → drain next
```

关键点：

- parent 在 claim 后创建；queue entry 在 parent 之前就存在，是 admission/待处理账本。
- `InvocationTracker.startAll` 返回独立 batch controller；单 cat cancel 不 abort batch
  gate，只有 cancelAll/force-reset 才 abort 整个 batch。
- parent `running` 后、route 之前还会做一次 cancellation fence，防止“admission 后、
  provider 前”被 cancel 却仍启动。
- queue entry 保留到所有 target attempt 终态；`completed`/`canceled` 后删除，
  `partial_failed`/`failed` 作为 retry anchor 保留。

### 3.3 Queue 状态与 retry

- `QueueEntry.status` 只持久化 `queued | claimed`；`processing | terminal` 是 transition
  projection，不是 Queue 列。
- 队列深度：Clowder user source 上限 5（`InvocationQueue.ts:167`）；codeteam target
  上限是工具参数（post/cross 1，multi_mention 2-3）；operator ingress 的 multi-target
  不是工具调用，不受该上限约束。Queue cap 需在实现时定。
- retry deferral（`queue-retry-deferrals.ts`）：base 10s，连续失败翻倍，上限 1h；
  只对 pre-handoff 仍 pending 的 failed/interrupted target。已 terminal 失败必须显式
  `requestRetry` 追加 attempt+1，不重新 admission source。
- process-local deferral：重启后 startup drain 会重新尝试所有 queued entry。

## 4. 路由：single / serial / parallel

### 4.1 single

一个 target、`execute` intent → `routeSerial`，但 worklist 只有一个 cat。它仍然是
“parent + 一个 child + 一个 processing R”，不是省略 parent 的快捷路径。

### 4.2 serial

`routeSerial`（`route-serial.ts:481`）：

- 一次只跑一个 cat；后续 cat 看到前面 cat 的已提交 response；
- A2A successor 只在当前 response **durably completed** 后 admission；它成为新的
  `message_wake` queue entry，不在当前 worklist 内继续追加；
- 每个 cat 的 `invokeSingleCat` 独立 session/prompt/stream；route 负责 accumulation、
  response commit、draft delete、next cat。

### 4.3 parallel

`routeParallel`（`route-parallel.ts:181`）：

- 每个 target cat 一个 `invokeSingleCat` stream；
- `mergeStreams` 合并成一条 `AgentMessage` 流；每个 cat 有自己的 `AbortSignal`，
  单 cat cancel 不影响 sibling；
- 每个 cat 有自己的 invocationId、processing R、draft；UI 看到 N 个独立 bubble；
- route 最后仍回到同一个 parent aggregate：all completed → completed；部分成功 →
  partial_failed；全部失败 → failed；全部 canceled → canceled。

### 4.4 A2A hop

agent 调用 `post_message`/`cross_post_message` 时：

- 创建一条新的 agent-authored message + 新 queue entry；不是把当前 parent 的 worklist
  直接延长；
- 目标 cat 得到新的 parent `InvocationRecord` + child `TurnExecution`；
- depth/loop guard 在 admission 前校验（Clowder 实际默认 A2A depth 15；
  `route-helpers` 注释里的 2 是过时注释；codeteam 当前 15 + guards，
  DP-F018SURFACE-2 待重拍，见 `0010` §3.8）；
- 跨 thread 还要求同 user、target thread active/not deleted/有 projectPath，并写
  `extra.crossPost` provenance。

## 5. Prompt / history 组装

### 5.1 SystemPromptBuilder

`SystemPromptBuilder` 负责静态身份与能力面：cat persona、roster、L0/governance、
skills、MCP tools、co-creator mention 约定、A2A 协作规则等。它不读 thread 历史，
也不决定本轮 route。

### 5.2 ContextAssembler

`ContextAssembler` 从 `MessageStore` 选历史并格式化：

- 只包含 delivered/visible 消息；queued/canceled 不作为 prompt 上下文；
- `replyTo` 会内联 preview；
- 默认 token ceiling 2000（可被 invocation budget 覆盖）；超出时按预算截断并产生
  degradation notice；
- 发送者标签区分 co-creator / agent / external，并防止 display name 注入。

### 5.3 incremental mode + delivery cursor

当有 `currentUserMessageId` 和 `DeliveryCursorStore` 时，route 走 incremental：

- `assembleIncrementalContext` 只取 cursor 之后未见消息 + 当前 trigger；
- 先 `ackSeenCursor`（seed），prompt 被 provider 接受后再 `ackCursor`；
- worker_capacity/spawn 失败不 ack；prompt delivered 后 failed/canceled 仍 ack；
- reset 时 cursor rewind 与 pi session binding clear 同事务。

codeteam v1 对应 `AgentReadState.deliveryCursor`（`0010` §3.5.1）；per-`(thread, agent)`
一个 cursor，不做 seenCursor/mentionAck。

### 5.4 invokeSingleCat

`invokeSingleCat` 负责一次 child 执行：

- resolve/restore session；必要时 seal/compact；
- 组装 prompt（静态身份 + mode prompt + history + MCP instructions + continuity）；
- 调 provider，产出 `AgentMessage` 流；
- 处理 provider retry/fallback/session replacement；
- 不直接写最终 message；route 层负责 response commit、draft delete、A2A successor。

codeteam v1 已按 DP-D=A（2026-11-12）拆回四层：T1 `invoke-single-agent` +
`TurnExecutionLifecycle` 写 child terminal/credential/attempt projection；T2
`route`/`RouteResponseCommitter` 写 R/draft/A2A successor；T3 `QueueProcessor` +
collector 写 parent/queue/retry/slot；T4 `ResponseRecoveryService` 只修未完成 R。
生产代码不引入 `settleAgentTurn`；细节见 `0010` §3.6/§3.9。

## 6. 流式回传：draft → R → Hub

### 6.1 AgentMessage 事件面

`invokeSingleCat` / provider adapter 产出的 `AgentMessage` 类型包括：

`session_init | text | tool_use | tool_result | error | done | system_info |
provider_signal | liveness_signal | status | agent_loop`。

Hub 真正消费的主要是 `text` / `tool_use` / `tool_result` / `error` / `done` /
`system_info`；`status`/`provider_signal`/`liveness_signal` 是运行态，不创建气泡正文。

### 6.2 QueueProcessor 的 consume loop

`QueueProcessor.executeEntry` 在 `routeExecution` 外消费事件：

1. 给事件 stamp `invocationId` / `messageId`（response R 的 id）。
2. `socketManager.broadcastAgentMessage(visibleMessage, threadId)` → room
   `thread:<threadId>` 的 `agent_message`。
3. `text` 累积；`tool_use/tool_result` 累积 tool events；`done` 触发 response commit。
4. draft flush：Clowder 每 2s 或 2000 chars（`route-serial.ts:1762` /
   `route-parallel.ts:1137`）；tool-first invocation 首次立即 flush。
5. `done` 后：response R terminal commit → `message_lifecycle_updated` → draft delete →
   source `messages_delivered` → queue entry terminal/retain。

### 6.3 Hub 收到什么

| socket event | 作用 | 前端落点 |
|---|---|---|
| `agent_message` | 流式 text/tool/done/error；带 `threadId`/`seq`/`seqEpoch` | `useSocket` → `useAgentMessages` → active/background handler → `chatStore` 流式 bubble |
| `message_lifecycle_updated` | 同 id 的 durable message snapshot（processing/terminal） | 以服务端 id upsert，替换本地流式副本 |
| `messages_delivered` | source message 从 Queue 进入 History；带 `deliveredAt` | 插入 user bubble、清 queued 投影 |
| `queue_updated` | Queue 面板；`action='processing'` 表示 entry 开始执行 | 更新 queue、恢复 active marker |
| `spawn_started` | 最早 per-cat spawning 信号 | cat status = spawning |
| `intent_mode` | 首个 CLI 事件后确认模式 | cat status / intent 提示 |
| `heartbeat` | 长 turn 心跳 | 维持 running 状态 |
| `thread_updated` | participants/title 等 thread 元数据 | 侧栏/标题 |

### 6.4 刷新/重连/恢复

- `GET /api/messages` 读 History 时，processing R 会吸收对应 `DraftStore` 的正文；
  draft 不会成为独立 message，也不会分配 `messages.seq`。
- 前端重连：`agent_message` 的 `seq/seqEpoch` 做 gap detection；断线期间完成的消息
  由 History catch-up 补；active invocation 由服务端 tracker/live projection 校正。
- daemon 崩溃：`response_pending` + draft 保留；startup reconciler 重新提交 R terminal；
  R 已 terminal 只清 pending；R 缺失走独立 `response_missing` recovery。

### 6.5 codeteam v1 差异

codeteam v1 不在每个 delta 写 messages/run_events；processing R + `response_drafts` 是
唯一 in-flight body。目标 flush 是 100ms/4KB（`0010` §3.6.1），不是 Clowder 当前的
2s/2000 chars。Hub 传输由 W7a 提供；F018 只定义 `AgentStreamEvent` 语义和 daemon
广播边界。

## 7. User Journey 全流程

### 7.0 账本形状速查

| Journey | source message | queue entry | parent | child TurnExecution | response R | parent 终态 |
|---|---|---|---|---|---|---|
| A 简单问答 | 1 | 1 | 1 | 1 | 1 | completed |
| B A→B→operator→B | 3（operator→A、A→B、operator→B） | 3 | 3 | 3（iA、iB、iB2） | 3 | 各自 completed |
| C @A @B 并行 | 1 | 1 | 1 | 2 | 2 | completed / partial_failed |
| D 单 cat cancel | 1 | 1 | 1 | N（其中一个 canceled） | N | completed / partial_failed / canceled |
| E cancel all | 1 | 1（可保留/撤回） | 1 | N（全部 canceled） | N 或中断部分 | canceled |
| F 失败 + retry | 1 | 1（retry anchor） | 1 | 1+（attempt+1 追加） | 1+ | failed → completed |
| G 排队中 | 1 | 1 | 0 | 0 | 0 | 无（尚未 claim） |

### 7.1 Journey A：简单问答，无显式 agent

**场景**：operator 在 Hub 发“这个报错什么意思？”，没有 `@`。

```text
Hub POST /api/messages {threadId, content, idempotencyKey}
  → 身份/thread/replyTo 校验
  → 无显式 mention → 隐式路由
      上一 human mentions? → recent_replier? → preferred cat? → participant? → default cat
  → InvocationQueue.send: message(queued) + queue entry + queue_admissions
  → messages_queued / queue_updated
  → QueueProcessor.requestDrain
  → claim → InvocationRecord(parent) → InvocationTracker.startAll
  → parent running → spawn_started
  → routeSerial(1 cat):
      SystemPromptBuilder(identity)
      + ContextAssembler(history)
      + invokeSingleCat(session/prompt/provider)
  → AgentMessage text/tool/done
  → agent_message → Hub 流式 bubble
  → response R terminal + message_lifecycle_updated
  → draft delete + messages_delivered(source) + queue_updated
  → parent completed
```

**Hub 看到**：先 queue 状态，然后 source 进入 History；接着一个 processing R/流式
bubble；最后 R terminal。没有 A2A、没有 operator target、没有 handoff。

**失败/排队**：如果 target busy，queue entry 保持 queued；如果 queue 满，入口直接
429，不产生 source。若 provider 失败，见 Journey F。

### 7.2 Journey B：@agentA → agentA A2A agentB → agentB 找 operator 决策 → operator 回复 → agentB 结束

这是最容易把“消息”“责任”“排队”混在一起的一条，按三段拆。

**B1. operator → agentA**

```text
operator: "@agentA 请评估这个方案"
  → source s1, queue q1, parent p1, child iA
  → agentA 流式回答；agentA 调 post_message(targetCats=[B])
  → 新 agent message s2 + queue q2（不是延长 p1 的 worklist）
  → agentA response R_A 提交；iA terminal；p1 completed
```

**B2. agentB → operator 决策**

Clowder 当前实现：

```text
QueueProcessor drain q2
  → parent p2, child iB
  → agentB 的最终内容包含行首 "@co-creator" / 配置的 operator handle
  → detectUserMention → message.mentionsUser=true
  → 该 message 是普通 agent response，不是 cat target
  → operator 收到未读/通知；没有 parent/TurnExecution “等 operator”
  → iB terminal；p2 completed
```

关键语义：

- agentB **不是**在 provider 里阻塞等待 operator；它结束这一轮，把问题留在 thread。
- operator 的回复是一条新的 user message，不是对 agentB 的“恢复执行”。
- 如果 operator 回复没有 `@`，隐式路由可能落到 recent_replier（通常就是 B），但
  deterministic 的写法是行首 `@agentB`；`replyTo` 只负责引用，不单独决定 target。

**B3. operator 回复 → agentB 结束**

```text
operator POST /api/messages: "@agentB 选 B，因为..."
  → source s3, queue q3, parent p3, child iB2
  → agentB 的 ContextAssembler 看到 s3 + 自己的 s2 问题
  → agentB 给出最终答复/执行决定；iB2 terminal；p3 completed
```

codeteam v1 目标态与 Clowder 一致：

```text
agentB 结束本轮，final response 行首 @operator
  → response message `mentionsUser=true`；没有 queue/parent
  → operator 通知由 message/read model 投影
  → operator 回复是新的 user message，target B
  → B 新 parent/child，读历史后结束
```

如果 agent 需要在**不结束本轮**时单独写一条 message（例如给另一个 thread 的 letter），
才使用 `post_message`/`cross_post_message` targets=[]；这不是 operator decision 的
必需路径。

### 7.3 Journey C：@agentA @agentB 并行回答

```text
operator: "@agentA @agentB 分别给方案"
  → parseIntent: 2 targets → ideate
  → strategy=parallel
  → 1 source + 1 queue entry + 1 parent
  → 2 children (iA/iB) + 2 processing R + 2 drafts
  → routeParallel mergeStreams:
      A stream → agent_message(A) → Hub bubble A
      B stream → agent_message(B) → Hub bubble B
  → A done → R_A terminal；B done → R_B terminal
  → parent: 两个 completed → completed；一个失败 → partial_failed
```

取消其中一个不影响另一个：parallel 给每个 cat 独立 `AbortSignal`；单 cat cancel 只
abort 该 cat 的 controller，batch gate 不动。

codeteam 对应：operator 的 `@A @B` 是普通 ingress 的 multi-target；`multi_mention`
是 agent 侧工具，也是 2-3 targets 的 fan-out，但额外有完整 orchestrator：
status/timeout/callback/aggregate（`multi_mention_requests/responses`）。两者都遵循
“1 source + 1 queue entry + 1 parent + N children”；普通 ingress 不自动产生
multi_mention 聚合。agent 侧同 thread 多 target 只能走 `multi_mention`；cross-thread
多 target 在 v1 拆成多次 `cross_post_message`。

### 7.4 Journey D：运行中取消某个 agent

Clowder 端点：`POST /api/threads/:threadId/cancel/:catId`
（`routes/queue.ts:1927`）。

```text
operator 点 A 的 Stop
  → guardThreadOwnership
  → InvocationTracker.cancel(threadId, A, userId, 'user_cancel')
  → controller.abort('user_cancel')；slot 保留 canceled tombstone
  → releaseAgentSessionLocks
  → broadcast cancel feedback
  → routeSerial/routeParallel 观察到 signal：
      serial: 当前 cat 结束，后续 worklist 不再启动
      parallel: 只 A 结束；B 继续
  → A 的 response R terminal=canceled（带已 stream 正文）
  → draft delete；parent aggregate
  → onInvocationComplete → drain 下一条
```

边界：

- 如果 tracker 没有 slot，但 durable running record 里 A 是唯一活跃目标，Clowder 会
  走 orphan cancel；如果 sibling 还活跃，则拒绝（404），避免误杀 sibling。
- 单 cat cancel 默认允许自动 drain 下一条；`cancel_all` 才抑制 auto-resume。
- cancel 与 terminal 竞态：R 的 terminal first-write-wins；cancel 不能把已 completed
  的 child 改成 canceled。

codeteam v1 需要提供等价控制面（由 W7a/CLI 承载）；F018 契约要求 tracker exact
cancel、parent aggregate、queue entry retention 三者分离。

### 7.5 Journey E：取消全部 agent

Clowder 端点：`POST /api/threads/:threadId/force-reset`
（`routes/queue.ts:2021`）。

```text
operator 点 Cancel all / force-reset
  → InvocationTracker.cancelAll(threadId, userId, 'cancel_all')
      abort 所有 active slots + batch controllers
  → retireThreadPrestartProcessingGroups
      （覆盖 create→startAll 的 reservation 窗口）
  → durable running InvocationRecord → canceled
  → release slots；suppressAutoResume 60s
  → queue entries：preserve 或 withdraw（按 carrier 规则）
  → broadcast cancel；parent canceled
```

与单 cancel 的区别：

- 单 cancel 只 abort 一个 cat；siblings 继续；下一条 queue 可以自动开始。
- cancel all abort 整个 batch gate，所有 cat 停止；自动 resume 被抑制，避免刚 reset
  又立刻被 queued work 占满。

### 7.6 Journey F：agent 失败与重试

**F0. 失败面有三层，不能混**

| 层 | 表面 | 是否写 source/R |
|---|---|---|
| ingress / pre-admission | typed reject（`no_target` / `agent_disabled` / `thread_deleted` / `thread_access_denied` 等） | 不写 source，不写 queue |
| admitted prestart | `delivery_failure` system message + settle source dispatchRefs | source 已写；R 未创建 |
| R created 之后 | R terminal = failed/interrupted/canceled + reason + 已 stream 正文 | 不写 `delivery_failure` |

**F1. provider 瞬时失败**

`invokeSingleCat` 内对 transient error 做有界 retry/fallback；不创建新 parent/child。
如果最终失败，child terminal=failed，R=failed（带已 stream 正文 + reason）。

**F2. pre-handoff pending 失败**

queue entry 仍留在 Queue，target 仍 pending：

```text
attempt failed / interrupted
  → QueueProcessor.deferFailedAttempt
  → QueueRetryDeferrals: base 10s，指数翻倍，上限 1h
  → 到期后同 entry 再 drain
  → 不重新 admission source，不产生第二条 user message
```

**F3. 已终态失败 + 显式 retry**

codeteam DP-F018TERM：

```text
requestRetry(B)
  → 同一 parent / 同一 source / 同一 queue entry
  → append attempt B=2（旧 attempt B=1 保留 failed）
  → parent status=queued, retryCount+1
  → B attempt=2 bind 新 TurnExecution iB2
  → iB2 running → parent running
  → iB2 completed（T1）→ R settlement（T2）→ parent completed（T3）
```

边界：

- 只 retry failed/interrupted；successful 不重跑；canceled 不复活。
- 每个 target 的最新 attempt + canonical TurnExecution 决定聚合；旧 failed 不能覆盖新成功。
- `dispatchRefs` 每个 target 一条，retry 更新为最新 attempt；旧 R 留在 attempt 台账。

**F4. all targets routing rejected**

Clowder 对 `routing_preflight_rejected` 保留 queue entry，等待恢复；codeteam 在
`0010` §3.9/§9.1 采用同一方向：不要把“当前不可用”误判成永久失败。

### 7.7 Journey G：消息在排队中

```text
operator 发消息
  → target busy / thread active / queue 有前序
  → source message 已持久化，deliveryStatus=queued
  → queue entry queued；Queue panel 显示
  → History 不出现 source（或只显示 queued receipt，按 UI 设计）
  → 前序 terminal → onInvocationComplete → drain
  → claim 后 parent/child 才创建
```

关键边界：

- queue 满 → 429，不写 source；不要产生“看不见的 ghost message”。
- targetless conversation entry 在 thread 仍活跃时等待 idle；有显式 target 的 entry
  可以走 target-level 并发。
- operator 可以手动 `processNext`；但不能绕过 busy slot/claim。
- queued 期间 cancel：entry 撤回/删除；已写 source 的状态要与 message lifecycle 收敛。

### 7.8 Journey H：刷新、重连、daemon 重启

- 刷新：`GET /api/messages` 返回 History；processing R 吸收 draft 正文；queued source
  由 queue API/queue_updated 恢复。
- 重连：`agent_message` 的 `seq/seqEpoch` 检测 gap；History catch-up 补齐断线期间
  完成的消息；processing R + draft 恢复当前气泡。
- daemon 重启：startup reconciler 用 `processStartedAt+1` cutoff + protected IDs，
  只收敛上一进程的 running/response-pending；R 缺失走 `response_missing`；单
  serialized reaper 处理 zombie。
- 取消/失败/终态都不能留下“永远 processing”的 R；settlement 失败保留 pending，
  下次启动重试。

## 8. Clowder ↔ codeteam 差异汇总

| 面 | Clowder | codeteam v1 目标 | 处置 |
|---|---|---|---|
| Hub transport | socket.io room `thread:<id>`；事件名固定 | W7a daemon API/WebSocket；F018 定义事件语义 | W7a 实现 adapter；F018 不硬编码 socket.io |
| 持久化 | Redis + Lua/CAS | SQLite + `BEGIN IMMEDIATE` | 语义复用，事务边界重写 |
| 消息存储 | `Message` + `StoredMessage` | 只保留 `StoredMessage` | 见 0005 D9 |
| 客户端幂等键 | `clientMessageId`（MCP client） | `piExtToolCallId`（pi extension） | 见 0013；有意分歧 |
| operator 寻址 | agent message 行首 `@co-creator` + `mentionsUser` | 同一语义；operator 不是 QueueTarget | operator 回复仍是新 user message |
| custody / handoff | ball custody、action lease、wait continuation | v1 不做 custody；operator decision 是普通 message | 见 0005 §7 |
| A2A depth | 实际默认 15（`route-helpers` 注释 2 过时） | v1 15 + budget/guard | 见 0010 §3.8；DP-F018SURFACE-2 待重拍 |
| draft flush | 2s / 2000 chars | 100ms / 4KB | 见 0010 §3.6.1 |
| queue depth | user source 5 | post/cross 1、multi_mention 2-3；queue cap 待定 | F018 R2 定常量 |
| multi_mention | `MultiMentionOrchestrator`：status/timeout/callback/aggregate | 完整 orchestrator：`multi_mention_requests/responses` + 聚合 system message | v1 对齐，不再做“假 fan-out” |
| recovery | StartupReconciler + Zombie + OwnerReaper 多件套 | 单 startup + 单 serialized reaper | 见 DP-F018RECOVERY |
| session | active/sealing/sealed + restore/compact | active + lightweight seal；无 restore/compact | 见 0009 |

## 9. 风险与待定项

1. **Hub transport 未落地**：F018 的事件名/字段需要 W7a 的 WebSocket/API adapter 才能
   变成真实 Hub 事件；当前文档只能冻结语义，不能声称端到端已实现。
2. **operator mention 的关联**：`mentionsUser` 不创建 queue/parent；如何把 operator
   回复关联回原问题（replyTo/causal trigger）需要在 R2 钉死。
3. **cancel 控制面归属**：单 cancel/cancel all 的 HTTP/CLI 入口属 W7a；F018 需要冻结
   exact execution identity 与 reason taxonomy，避免 cancel 误杀同 slot 的新 child。
4. **queue cap/priority**：Clowder 5 与 codeteam 的 tool target 上限（post/cross 1、
   multi_mention 2-3）不是同一维度；R2 要定 source queue cap、排序、operator 手动
   processNext 的边界。
5. **multi_mention 聚合**：v1 做完整 orchestrator；需要冻结 status/timeout/
   aggregate/callback 的持久化与恢复边界（见 0010 §3.8 multi_mention）。
6. **draft settlement 失败**：R terminal 后 draft delete 失败、credential tombstone
   GC、response_pending 重试都要有可观察状态；不能静默泄漏。
7. **A2A depth 15 与 loop guard**：高上限意味着必须依赖 `a2a_duplicate_delivery` /
   `pi_ext_tool_call_conflict` / depth 计数，不能只靠目标数量。
8. **queued source 的可见性**：Queue 不是 History；UI 必须区分 queued receipt 与
   delivered message，避免刷新后 ghost bubble。
9. **session seal/restore 不在 v1**：长 thread 的 prompt 只靠 deliveryCursor +
   ContextAssembler；跨 session 连续性和 compaction 是后续能力。

## 10. 参考实现索引

| 主题 | Clowder 路径 |
|---|---|
| 消息 ingress | `packages/api/src/routes/messages.ts:328` |
| Queue admission | `packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts:711` |
| QueueProcessor | `packages/api/src/domains/cats/services/agents/invocation/QueueProcessor.ts:4113` |
| Queue retry | `packages/api/src/domains/cats/services/agents/invocation/queue-retry-deferrals.ts` |
| Tracker cancel | `packages/api/src/domains/cats/services/agents/invocation/InvocationTracker.ts:372`、`:463` |
| target/intent | `packages/api/src/domains/cats/services/agents/routing/AgentRouter.ts:1400` |
| serial route | `packages/api/src/domains/cats/services/agents/routing/route-serial.ts:481` |
| parallel route | `packages/api/src/domains/cats/services/agents/routing/route-parallel.ts:181` |
| invoke child | `packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts` |
| prompt identity | `packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts` |
| history assembly | `packages/api/src/domains/cats/services/context/ContextAssembler.ts` |
| draft store | `packages/api/src/domains/cats/services/stores/ports/DraftStore.ts` |
| Hub event | `packages/api/src/infrastructure/websocket/SocketManager.ts:437` |
| lifecycle update | `packages/api/src/domains/cats/services/agents/invocation/lifecycle-message-update.ts` |
| Hub consumer | `packages/web/src/hooks/useSocket.ts`、`packages/web/src/hooks/useAgentMessages.ts` |

> codeteam 当前契约：`docs/architecture/0005-thread-first-runtime.md`、
> `docs/architecture/0010-a2a-runtime-chain.md`、`docs/architecture/0011-identity-contract.md`、
> `docs/architecture/0013-idempotency-key-map.md`。



