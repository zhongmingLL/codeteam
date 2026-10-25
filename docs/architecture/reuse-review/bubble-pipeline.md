---
title: "bubble-pipeline 架构复用检视"
doc_kind: architecture-review
status: approved
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
review_request: "92a939a1-8e83-47d1-ae0c-24045d1b2472"
operator_signoff: "DP-BUBBLE-1=A (2026-10-25): W1 approved; W7 approved-for-direction (provisional until W4 dogfood)"
source_cell: bubble-pipeline
source_card: ../../reuse/bubble-pipeline.md
template: ../0004-reuse-architecture-review-plan.md
---

# bubble-pipeline 架构复用检视

## 1. 总结

| 项 | 结论 |
|---|---|
| clowder feature 范围 | F177（child execution truth / routing guard / supplement 语义）、F183（single writer / provider-neutral semantic event / thread-scoped seq / hydration）、F264（per-target dispatchRefs / statusMessageId / inputRead / terminal 消费）、F254（attention/closure/supplement 运行时已退役，历史行只读）、F322（InteractiveBlock 继续走普通 MessageStore，不造新 bubble identity）。 |
| codeteam 复用总结 | **R1 适配复用**。复用“服务器 message identity + named-message writer + dispatchRefs”契约；codeteam 不建第二 message store、不建前端 bubble identity/reducer 账本；W1 先锁 message identity/dispatchRefs schema，W7 做只读投影与 live/hydration 收敛。 |
| codeteam W | W1（`messages.seq`、`dispatch_refs_json`、`runs.response_message_id`/`execution_kind`）；W7（thread timeline 只读投影、live/hydration、provisional cache）。 |
| 一句话 | 一条 provider/semantic 事件只投影到服务器命名的那个 message；`dispatchRefs` 只记录真实投递；证据不齐显示 `unknown`，不猜 `processing`。 |
| 明确不含 | 第二套 message store、前端独立 bubble identity、第二套 BubbleReducer 账本、Queue receipt 当 delivery、IDB 当在线合并权威、F254 closure/supplement 运行时、F322 第二 bubble identity、cross-thread 可见性绕过。 |

**组件立场**

| 组件 | 立场 | codeteam 处理 |
|---|---|---|
| `BubbleKind` / `BubbleStableIdentity` / `BubbleEvent` | `reuse now` | kind 只做投影分类；stable identity 映射为 `(thread_id, author_id, run_id, bubble_kind)`，message id 仍是服务器 id |
| `LifecycleDispatchRef` / `dispatchRefs[]` | `reuse now` | 落到 `messages.dispatch_refs_json`；`targetId`→AgentProfile，`statusMessageId`→response message id |
| `LifecycleResponseBubble` | `adapt now` | `messages` + `runs` 投影；status 映射 running→processing、completed/failed/canceled/interrupted |
| `TurnExecutionMessageProjection` | `reuse now` | `runs` + `run_events` 投影；`executionKind` 落 `runs.execution_kind` |
| `hasExactLifecycleProcessingDispatch` | `reuse now` | codeteam pure function；ref/response/active run 三者不齐→`unknown` |
| `named-message-writer` | `adapt now` | W7 client 只 patch 服务器命名 message；不造 bubble id、不合并气泡 |
| `useAgentMessages` / `useSocket` | `adapt now` | 一个 thread runtime；live event 带 `threadId/messageId/seq` |
| `BubbleReducer` 前端账本 | `drop` | 只允许 pure projection function；不建客户端 canonical reducer ledger |
| `chatStore` / IndexedDB cache | `adapt now` | provisional cache，只做冷启动/离线兜底；在线不参与 merge 仲裁 |
| `MessageDispatchAvatars` / `ChatMessage` | `adapt now` | W7 只读投影；avatar 来自 dispatchRefs，terminal 来自 response lifecycle |
| F254 closure/supplement 运行时 | `drop` | 历史行可读；不恢复 attention/closure/supplement 写路径 |
| F322 InteractiveBlock | `adapt now` | 继续走普通 message/rich block；server-only `runtimeInteractionCard` 绑定；不造新 bubble identity |
| F177 child execution / routing guard | `reuse now` | typed child identity；routing guard 显示 system-assisted execution；不复制正文 |
| 第二套 message/bubble store | `forbidden` | 唯一 store = `messages`；唯一 response truth = `runs` + `messages` |

## 2. clowder 架构

### 2.1 架构图

```text
provider raw stream
        │  adapter-specific parse
        ▼
provider-neutral semantic event
  ├─ known structured kind → BubbleEvent
  └─ unknown/invalid → diagnostics + fail closed（不渲染 raw JSON）
        │
        ▼
server MessageStore (canonical message identity)
  ├─ named response message (empty at admission)
  ├─ dispatchRefs[] (actual delivery only)
  ├─ rich_blocks_json
  └─ lifecycle response status
        │
        ├─ live: socket event → named-message-writer → same server message id
        ├─ hydration/F5: same MessageStore DTO → same id
        └─ history: same DTO + dispatchRefs

MessageDispatchAvatars
  └─ dispatchRefs[] → avatar + dispatchedAt + statusMessageId navigation

TurnExecutionMessageProjection
  └─ invocationId + parentInvocationId + executionKind
```

### 2.2 数据流

1. **Semantic event**：provider raw stream 先由 adapter 归一成 provider-neutral semantic event；已知结构化 kind 进入 `BubbleEvent`，未知/非法 payload 保留 diagnostics 并 fail closed，不 `JSON.stringify` 原始协议。
2. **Message identity**：服务器在 admission 时创建空的 response message；后续 stream/tool/rich block/terminal 都写同一个 server message id。前端 `named-message-writer` 只 patch 这个 id，不发明 bubble id。
3. **Dispatch**：用户/外部 source 第一次真实投递时 materialize 一个 source bubble；多 target 只追加 `dispatchRefs[]`，不重复 source bubble。Queue 只拥有 pending targets，不投影 receipt/processing/terminal。
4. **Response**：每个 `dispatchRef` 带 `statusMessageId` 指向 exact response；response bubble 拥有 `processing/streamed/completed/failed/canceled/interrupted`；失败保留 partial content + structured diagnostic。
5. **Hydration**：F5/历史读取同一 MessageStore DTO；live 与 hydration 必须收敛到 content/timestamp/response identity，不从日志文本、Queue 字段或时间邻近猜。
6. **Sequence**：thread-scoped seq 检测丢事件；gap 触发 catch-up，不把 seq 当 thread 归属或业务结果。
7. **Terminal**：one terminal per run；empty terminal 只留 typed lifecycle notice，不创建猫气泡；terminal 结果不写回 bubble 正文作为唯一真相。
8. **Historical compatibility**：F254 历史 closure/supplement 行可读；不恢复 attention/closure/supplement 责任。F322 InteractiveBlock 走普通 MessageStore + server-only binding，不造新 identity。

### 2.3 状态机 / 生命周期

**A. Response bubble**

```text
(empty response at admission)
        │ stream / tool / rich block
        ▼
processing ──completed──► completed
    │
    ├──failed───────────► failed（保留 partial + diagnostic）
    ├──canceled─────────► canceled
    └──interrupted──────► interrupted（recovery 合成）
```

- 同一个 server message id 从空 processing tip 升级为 streamed/terminal bubble；不产生第二个 response bubble。
- `completed/failed/canceled/interrupted` 只来自 canonical response lifecycle，不来自 provider exit 0 或日志文本。

**B. Dispatch ref**

```text
(no ref)
   │ actual dispatch
   ▼
dispatched(phase='dispatched', statusMessageId, dispatchedAt)
   │ response terminal / settlement
   ▼
settled(phase='settled', same statusMessageId)
```

- `dispatchRef` 只在真实 delivery 后出现；Queue pending target 不产生 ref。
- `inputRead` 只是 presentation evidence；`read` 不证明业务 handled，`pending` 不证明未投递。
- `appendAcceptance` 只表达 Append 结果；transport exception 不等于 non-acceptance。

**C. Projection state（UI）**

```text
exact ref + exact response + exact active run
  └─► processing
partial / ambiguous / missing evidence
  └─► unknown（不猜 running）
terminal response
  └─► completed / failed / canceled / interrupted
```

### 2.4 关键数据结构

```ts
// packages/shared/src/types/bubble-pipeline.ts:1,5,26,34,48
type BubbleKind = 'assistant_text' | 'thinking' | 'tool_or_cli' | 'rich_block' | 'system_status';
type BubbleEventType = 'local_placeholder_created' | 'stream_started' | 'stream_chunk' | 'thinking_chunk' | 'tool_event' | 'cli_output' | 'rich_block' | 'callback_final' | 'history_hydrate' | 'draft_restore' | 'cache_restore' | 'done' | 'error' | 'timeout';
type BubbleSourcePath = 'active' | 'background' | 'callback' | 'hydration' | 'queue' | 'draft' | 'idb' | 'replay' | 'unknown';
interface BubbleStableIdentity { threadId: string; actorId: string; canonicalInvocationId: string; bubbleKind: BubbleKind; }
```

```ts
// packages/shared/src/types/message-lifecycle.ts:86,107,363,396
interface LifecycleDispatchRef {
  targetId: string;
  phase: 'dispatched' | 'settled';
  statusMessageId: string;
  dispatchedAt?: number;
  inputRead?: { status: 'pending' } | { status: 'read'; at: number };
  appendAcceptance?: 'pending' | 'accepted';
}
interface LifecycleResponseBubble {
  id: string; threadId: string; invocationId: string; targetId: string;
  status: 'processing' | 'completed' | 'failed' | 'canceled' | 'interrupted';
  dispatchRefs?: readonly LifecycleDispatchRef[];
  startedAt: number; completedAt?: number;
}
function hasExactLifecycleProcessingDispatch(input: {...}): boolean;
```

```ts
// packages/shared/src/types/turn-execution.ts:3,4,45,52
type TurnExecutionKind = 'ordinary' | 'routing_guard';
type TurnExecutionStatus = 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';
interface TurnExecutionMessageProjection { invocationId: string; parentInvocationId: string; executionKind: TurnExecutionKind; }
```

### 2.5 Current truth 与代码路径

| # | 事实 | 代码锚点 |
|---|---|---|
| T1 | `BubbleKind`/`BubbleEvent`/`BubbleStableIdentity` 是投影契约；stable identity 含 thread/actor/invocation/kind | `packages/shared/src/types/bubble-pipeline.ts:1`、`:5`、`:26`、`:34`、`:48` |
| T2 | `LifecycleDispatchRef` 有 target/phase/statusMessageId/dispatchedAt/inputRead/appendAcceptance | `packages/shared/src/types/message-lifecycle.ts:86`、`:107` |
| T3 | `LifecycleResponseBubble` 有 processing/completed/failed/canceled/interrupted 与 dispatchRefs | `packages/shared/src/types/message-lifecycle.ts:363` |
| T4 | `hasExactLifecycleProcessingDispatch` 要求 ref + response + active run 三者 exact；partial/ambiguous fail closed | `packages/shared/src/types/message-lifecycle.ts:396` |
| T5 | MessageStore dispatchRefs 只在真实 delivery 时创建；Queue pending 不产生 ref | `packages/api/src/domains/cats/services/stores/ports/MessageStore.ts:1079`、`:1184`、`:1219` |
| T6 | `useAgentMessages` 没有客户端 bubble identity；事件按 server-named message 写入 | `packages/web/src/hooks/useAgentMessages.ts:32`、`:48`；`packages/web/src/hooks/named-message-writer.ts:1`、`:74`、`:130` |
| T7 | provider semantic registry 对 invalid event suppress + diagnostics，不渲染 raw JSON | `packages/web/src/lib/provider-semantic-registry.ts:14` |
| T8 | `useChatHistory` hydration 的 response terminal 与 live 同 DTO | `packages/web/src/hooks/useChatHistory.ts:472` |
| T9 | `useSocket` 消费 `queue_updated`，但不把 Queue pending 当 delivery | `packages/web/src/hooks/useSocket.ts:834` |
| T10 | `MessageDispatchAvatars` 从 dispatchRefs 投影 avatar/dispatchedAt/statusMessageId；processing 需 exact ref+response | `packages/web/src/components/MessageDispatchAvatars.tsx:64`、`:83`、`:107` |
| T11 | `TurnExecutionMessageProjection` 只带 invocation/parent/executionKind，不带正文 | `packages/shared/src/types/turn-execution.ts:52` |
| T12 | F183 已收敛 single writer、thread-scoped seq、IDB provisional cache、live/hydration convergence | `docs/features/F183-bubble-pipeline-architecture-consolidation.md:150`、`:166`、`:177`、`:259` |
| T13 | F264 的 per-target receipt 以 dispatchRefs 的 `statusMessageId`/`inputRead` 表达 | `packages/shared/src/types/message-lifecycle.ts:86`；cell doc Canonical Owner |
| T14 | F254 运行时 attention/closure/supplement 已退役；历史行只读 | `docs/architecture/ownership/cells/bubble-pipeline.md` Canonical Owner；`docs/features/F254-side-effect-freshness-gate.md` |
| T15 | F322 InteractiveBlock 走普通 MessageStore + server-only binding，不造新 bubble identity | `packages/api/src/domains/runtime-interaction/RuntimeInteractionCardPublisher.ts`；cell doc Canonical Owner |
| T16 | codeteam `messages` 已有 `dispatch_refs_json`/`rich_blocks_json`，但没有 `seq`；`runs` 没有 `response_message_id`/`execution_kind` | `codeteam/architecture/0001-codeteam-architecture-v1.md:1397`、`:1412` |

### 2.5.1 上游已知缺口 → 本卡处置

| # | 上游缺口 | 影响 | 本卡处置 |
|---|---|---|---|
| G1 | clowder 前端有 `BubbleReducer`/chatStore/IDB 多路径 | 照搬会在 codeteam 造第二 bubble 账本 | codeteam 只允许 server-named message + pure projection；前端不建 canonical ledger |
| G2 | clowder 多入口 writer（active/background/callback/hydration） | 写入口爆炸导致 ghost bubble | 所有路径写同一个 `messages.id`；W1 锁 message identity |
| G3 | Queue pending target 容易被当 delivery | 假头像/假 processing | dispatchRef 只在真实 delivery 出现；Queue 只存 pending |
| G4 | `inputRead` 容易被当 handled | 读≠处理 | inputRead 只做 presentation evidence；terminal 由 response lifecycle 决定 |
| G5 | F254 closure/supplement 历史语义重 | 容易恢复已退役责任 | 历史行只读；v1 不写 closure/supplement |
| G6 | IDB 离线缓存容易成为第二真相 | F5 后状态分叉 | IDB 只做 provisional cache；在线 hydration replace，不做 merge 权威 |
| G7 | clowder `succeeded` vs codeteam `completed` | 状态映射错误 | codeteam `runs.status=completed` 映射 response `completed`；不新增 succeeded |
| G8 | clowder catId vs codeteam profile | dispatchRefs target 混淆 | `targetId` 一律 AgentProfile id；avatar/author 从 profile 解析 |
| G9 | F322 InteractiveBlock 容易造新 bubble | 决策卡重复渲染 | block 继续挂 `rich_blocks_json`；server-only binding；返回走普通 message/queue |

## 3. codeteam 架构

### 3.1 架构图

```text
run provider event / tool event
        │  server-side semantic projection
        ▼
messages (server-named message id, thread-scoped seq)
  ├─ dispatch_refs_json[] (source → target → statusMessageId)
  ├─ rich_blocks_json
  └─ body_md / authored identity
        │
        ├─ runs.response_message_id (exact response bubble)
        ├─ runs.execution_kind (ordinary/routing_guard)
        └─ run_events (stream/tool/thinking/terminal)
        │
        ▼
W7 ThreadTimelineDTO (read-only)
  ├─ messages[] + runs[] + activeRuns[] + cursor
  ├─ live socket: message.updated / run.event / dispatch.updated
  └─ hydration: afterSeq catch-up; replace by server id
        │
        ▼
Console / CLI / Hub read-only surface
  ├─ ChatMessage / MessageDispatchAvatars
  ├─ provisional cache (schemaVersion/contractVersion, never authority)
  └─ unknown on incomplete evidence, not processing
```

### 3.2 数据流

1. **Admission**：source message 先持久化；Queue `targets[]` 只记 pending；第一次真实 dispatch 时写 `dispatch_refs_json` 的 `dispatched` ref，不重复 source bubble。多 target 的 JSON append 是 read-modify-write，必须在 `BEGIN IMMEDIATE` 内完成。
2. **Response create**：run admission 在**同一 `BEGIN IMMEDIATE` 事务**内 INSERT empty response message 与 `runs`；`runs.response_message_id` 指向它；`runs.execution_kind` 记 ordinary/routing_guard；response message `seq` 由服务端在该事务内分配。response message 以 `kind='agent_response'` 标记，`author_kind='agent'`、`author_id=<recipientProfileId>`；`system` author 只用于 daemon 的 approval_pointer/backlog_kickoff 类控制消息。两步不可分，crash 不得留下 orphan empty response。
3. **Live event**：provider/tool/stream event 带 `runId/messageId`；server 更新 `run_events` 与 named message；socket 只发增量，不改变 identity。response 已 terminal 后到达的 stream/chunk 一律幂等拒绝，不能覆盖 terminal body。
4. **Terminal**：run terminal（completed/failed/canceled/interrupted）写 response message body/诊断；`dispatch_ref.phase=settled`；one terminal per run，重复 terminal 幂等。二者优先同事务；若分属不同事务，投影以 `runs.status` terminal 为优先，`settled` 滞后只是 presentation lag，不得把已完成 response 判成 unknown。
5. **Hydration**：`GET /api/threads/:id/messages?afterSeq=N` 返回 `ThreadTimelineDTO`；`afterSeq` 只补新 message；同一 message 的 stream/rich block/terminal 更新不产生新 seq，因此 socket reconnect（非首连）时对含 `activeRuns`/processing 投影的 thread 走**全量 snapshot 重取**，用 server id replace；gap 也触发 catch-up；不按时间/内容 merge。
6. **Projection**：`processing` 只在 source dispatchRef、response message、active run 三者 exact 时成立；缺任一 → `unknown`，并带 `missingEvidence: 'ref' | 'response' | 'activeRun'`。W7 按缺失源分层文案（已送出待接 / 回话证据断链 / 排队等认领），unknown 不是单一裸徽章；恢复动作只引用 A1-3 dispatch recovery，不造第二入口。
7. **Cache**：IndexedDB/local cache 只存 provisional snapshot，按 `threadId` 寻址、不跨 thread 合并；在线时 server DTO 覆盖；cache version/contract version 不匹配直接丢弃。provisional 渲染需可见提示“本地缓存，待服务器对齐”。
8. **F322**：InteractiveBlock 存 `rich_blocks_json`，server-only `runtimeInteractionCard` 绑定；用户回答返回普通 message/queue carrier，不新建 bubble identity。

### 3.3 状态机 / 生命周期

**A. Message stream sequence**

```text
thread seq N ──new message──► N+1
  ├─ live event seq = N+1 → patch named message
  └─ gap detected → hydration afterSeq=N → replace by id
```

- `messages.seq` thread-scoped；`UNIQUE(thread_id, seq)`；服务端在 `BEGIN IMMEDIATE` 内用 `COALESCE(MAX(seq),0)+1` 分配；busy 重试一次后 503。
- 同一 message 的 stream/tool/rich block 更新不改 seq；seq 是“可见 message 创建序”，不是内容 revision。seq gap 只侦测新 message 丢失；同一 message 的更新丢失 v1 不自愈侦测，由 TCP + reconnect 全量 snapshot 兜底。未来如需强一致再加 per-message `content_revision`，不把 seq 当 revision。
- socket reconnect（非首连）→ 对含 `activeRuns`/processing 投影的 thread 全量 snapshot 重取；terminal 后到达的 late chunk 幂等拒绝。

**B. Response projection**

```text
runs.status=running + exact ref + exact response
  └─► processing
completed/failed/canceled/interrupted
  └─► terminal
partial/ambiguous evidence
  └─► unknown(state, missingEvidence)
```

- `unknown` 不是单一徽章：`missingEvidence` 区分 `ref`/`response`/`activeRun`，W7 据此给分层文案与恢复入口。
- terminal truth 永远优先于 `dispatchRef.phase`；runs.status 已 terminal 时，settled 滞后不改变投影状态。

**C. Cache state**

```text
cache miss → hydrate → server snapshot
cache hit + contractVersion match → render provisional → hydrate replace
cache hit + version mismatch → discard cache → hydrate
```

- cache 按 `threadId` 寻址，不跨 thread 合并；provisional 渲染必须可见地 provisional。

### 3.4 关键数据结构与存储

| clowder | codeteam | 立场 | 关键差异 |
|---|---|---|---|
| `BubbleKind` | derived `bubble_kind` | `reuse` | 不存第二 identity；从 message/run event 投影 |
| `BubbleStableIdentity` | response bubble only: `(thread_id, author_id, run_id, bubble_kind)` | `adapt` | source message identity 只用 `messages.id`；catId→AgentProfile；message id 仍是服务器 id |
| `LifecycleDispatchRef` | `messages.dispatch_refs_json[]` | `reuse` | targetId=profile；statusMessageId=response message |
| `LifecycleResponseBubble` | `messages` + `runs` | `adapt` | runs.status mapping；response_message_id unique |
| `TurnExecutionMessageProjection` | `runs.execution_kind` + `parent_run_id` | `reuse` | succeeded→completed |
| `hasExactLifecycleProcessingDispatch` | `hasExactProcessingDispatch` pure fn | `reuse` | ref+response+active run 三者 exact；否则 unknown |
| `named-message-writer` | W7 client writer | `adapt` | 只 patch server-named id |
| `BubbleReducer` ledger | pure projection only | `drop` | 不建客户端 canonical reducer |
| `chatStore` / IDB | provisional cache | `adapt` | 在线不参与 merge |
| F254 closure/supplement | none | `drop` | 历史行只读 |
| F322 InteractiveBlock | `rich_blocks_json` + binding | `adapt` | 不造新 bubble identity |

**W1/W7 回写清单**

```sql
-- W1 target: messages.seq INTEGER NOT NULL CHECK (seq > 0)
-- SQLite migration: add nullable → backfill per thread → rebuild 保证 NOT NULL；
-- 不接受长期 nullable seq；UNIQUE 索引在 backfill/rebuild 后的表上创建。
ALTER TABLE messages ADD COLUMN seq INTEGER;
-- backfill per thread + rebuild 为 NOT NULL 后：
CREATE UNIQUE INDEX idx_messages_thread_seq ON messages(thread_id, seq);

-- W1: runs 绑定 exact response bubble + execution kind
ALTER TABLE runs ADD COLUMN response_message_id TEXT REFERENCES messages(id) ON DELETE RESTRICT;
ALTER TABLE runs ADD COLUMN execution_kind TEXT NOT NULL DEFAULT 'ordinary'
  CHECK (execution_kind IN ('ordinary','routing_guard'));
CREATE UNIQUE INDEX idx_runs_response_message ON runs(response_message_id)
  WHERE response_message_id IS NOT NULL;

-- W1: dispatch_refs_json 形状（JSON，不需新表）
-- [{
--   "targetId": "<agent_profile_id>",
--   "phase": "dispatched" | "settled",
--   "statusMessageId": "<response_message_id>",
--   "dispatchedAt": 123,
--   "inputRead": { "status": "pending" } | { "status": "read", "at": 124 },
--   "appendAcceptance": "pending" | "accepted"
-- }]
```

- `messages.seq` 由服务端在 `BEGIN IMMEDIATE` 插入事务分配：`COALESCE(MAX(seq),0)+1 WHERE thread_id`；不信任客户端 seq；busy 重试一次后 503。backfill/rebuild 完成后创建 `UNIQUE(thread_id, seq)`。
- 迁移后 `messages.seq` 必须 NOT NULL + `CHECK(seq > 0)`；不能用 nullable 索引长期运行（SQLite unique 允许多个 NULL）。
- `runs.response_message_id` 是 response bubble 的唯一身份；一个 run 只有一个 response。response message 以 `kind='agent_response'` 标记，INSERT 与 `runs` INSERT 必须同事务；`messages.kind='agent_response'` 但没有 `runs.response_message_id` 指向的行 = orphan，health 告警，不自动删除。
- `dispatch_refs_json` 只写在 source message 上；`statusMessageId` 必须指向 exact response message；`targetId` 是 AgentProfile。多 target append 的 read-modify-write 必须在 `BEGIN IMMEDIATE` 内，禁止无事务 JSON merge。
- `inputRead.status='read'` 的 `at` 必须 >= `dispatchedAt`；`inputRead` 只做 presentation evidence，不裁决 handled。
- `inputRead` 的写入者是 target mark-read 路径（A2-1 inbox/W7）；`appendAcceptance` 的写入者是 A1-3 运输结果。缺写入者时字段保持 pending，W7 不得把 pending 渲染成“未读”红点。
- unread/通知计数引用 A2-1 的 first-body 恰计一次规则；bubble 不建第二 unread 计数器。
- `rich_blocks_json` 可含 InteractiveBlock，但不含 approval 真相；approval 仍只来自 `approvals` + `approval_pointer`。
- `messages.seq` 是 thread 可见消息序；`run_events.seq` 是 run 内事件序，两者不混用。
- `messages.reply_to` 必须同 thread（DB CHECK/写入校验）；跨 thread 只允许**导航引用**（dispatchRef/return carrier），不允许复制消息；跳转必须过目标 thread 的 `threadAccess`，不在 bubble 层新造读权限。
- terminal body 与 `dispatch_ref.phase=settled` 优先同事务；若分居两事务，投影以 `runs.status` terminal 为优先，允许短暂的 terminal + unsettled 中间态，不落 unknown。
- `runs.execution_kind='routing_guard'` 时，W7 response bubble 按 `runs.executionKind` join 标“系统辅助”；不另建状态字段。

**W7 read DTO**

> W7 契约状态：`approved-for-direction`。W4 dogfood 后可据实测修订 unknown 文案、recovery 入口与 cache 提示；不得改动 W1 identity/schema（`messages.seq`/`runs.response_message_id`/`execution_kind`/`dispatch_refs_json`）。

```ts
type MissingEvidence = 'ref' | 'response' | 'activeRun';
interface ProjectionStateDTO {
  sourceMessageId: string;
  state: 'processing' | 'unknown' | 'terminal';
  missingEvidence?: MissingEvidence;
  reason?: string;
}

interface ThreadTimelineDTO {
  threadId: string;
  cursor: { afterSeq: number }; // afterSeq 只补新 message；reconnect 走全量 snapshot
  messages: MessageDTO[];   // id, seq, authorKind, authorId, kind, bodyMd, richBlocks, dispatchRefs, replyTo, controlRef
  runs: RunDTO[];           // id, parentRunId, executionKind, status, responseMessageId, startedAt, terminalAt
  activeRuns: ActiveRunDTO[];
  runEvents: RunEventDTO[]; // bounded for visible/active runs; seq/kind/payload
  projections?: ProjectionStateDTO[]; // state: processing|unknown|terminal; missingEvidence?: ref|response|activeRun
}
```

- `MessageDTO`/`RunDTO` 都是服务器 DTO；客户端不拼第二套 identity。
- `activeRuns` 只从 running run 投影；`processing` 还要 exact ref+response+run。
- `unknown` 不是错误页；是“证据不齐”的诚实状态，必须带 `missingEvidence` 原因，并按缺失源给分层文案与恢复入口（只引用 A1-3 dispatch recovery）。
- socket reconnect（非首连）时，对含 activeRuns/processing 投影的 thread 走全量 snapshot 重取；terminal 后到达的 stream 写幂等拒绝。
- provisional cache 渲染需可见提示“本地缓存，待服务器对齐”；cache 按 threadId 寻址，不跨 thread 合并。
- 深分页/单 run 事件用 `GET /api/runs/:id/events?afterSeq`；`runEvents` 只带 bounded 窗口，避免 thread timeline 无限膨胀。

### 3.5 变量定义表

#### contract

| 变量 | 类型 | 默认/值域 | owner | clowder 来源 | 决定 | 说明 |
|---|---|---|---|---|---|---|
| `MessageId` | TEXT | server opaque | bubble-pipeline | `LifecycleResponseBubble.id` | `reuse` | 唯一 bubble identity |
| `MessageSeq` | INTEGER | thread-scoped >0 | bubble-pipeline | F183 thread-scoped seq | `adapt` | 可见 message 创建序，不是内容 revision；服务端在 BEGIN IMMEDIATE 分配；不信任客户端 |
| `BubbleKind` | enum | assistant_text/thinking/tool_or_cli/rich_block/system_status | bubble-pipeline | `packages/shared/src/types/bubble-pipeline.ts:1` | `reuse` | 投影分类，不是第二 identity |
| `DispatchRef` | JSON | target/phase/statusMessageId/dispatchedAt/inputRead | bubble-pipeline | `packages/shared/src/types/message-lifecycle.ts:86` | `reuse` | 只记真实 delivery |
| `ResponseBubble` | row | messages(kind=agent_response) + runs | bubble-pipeline | `packages/shared/src/types/message-lifecycle.ts:363` | `adapt` | status/terminal from runs；orphan 可按 kind 检测 |
| `ResponseMessageMarker` | enum | `agent_response` | bubble-pipeline | `messages.kind`（codeteam-new） | `new` | 只标记 run 的 exact response bubble，供 identity/orphan 检测；不替代 `approvals` |
| `TurnExecutionProjection` | row | invocation/parent/executionKind | bubble-pipeline | `packages/shared/src/types/turn-execution.ts:52` | `reuse` | 只带身份，不带正文 |
| `RunEventProjection` | row | runId/seq/kind/payload | bubble-pipeline | `run_events` | `adapt` | bounded window；深分页走 `/api/runs/:id/events` |
| `ThreadTimelineCursor` | object | afterSeq + reconnect snapshot | bubble-pipeline | F183 seq/hydration | `adapt` | afterSeq 只补新 message；同 message 更新走 reconnect 全量 snapshot |
| `ProjectionState` | object | processing/unknown/terminal + missingEvidence | bubble-pipeline | F264 unknown 分层 | `adapt` | unknown 必须说明缺 ref/response/activeRun 哪一类 |
| `RichBlock` | JSON | bounded | bubble-pipeline | `messages.rich_blocks_json` | `reuse` | 不含 approval 真相 |

#### state

| 变量 | 状态机/约束 | owner | 失败语义 |
|---|---|---|---|
| `messages.seq` | thread 内单调、唯一；服务端在 `BEGIN IMMEDIATE` 分配 | bubble-pipeline | busy 重试一次→503；gap → catch-up；不猜顺序 |
| `runs.status` | running→completed/failed/canceled/interrupted | dispatch/runs | terminal 后不覆盖；重复 terminal 幂等 |
| `runs.response_message_id` | 一个 run 一个 response；unique；response INSERT 与 runs INSERT 同事务 | bubble-pipeline | orphan/重复 → health，不猜、不自动删 |
| `dispatch_refs_json[].phase` | dispatched→settled | bubble-pipeline | 非 exact ref → unknown；terminal 后 settled 滞后不改变 terminal |
| `dispatch_refs_json[].inputRead` | pending→read；只做 presentation | bubble-pipeline | read 不证明 handled；writer 缺位时保持 pending |
| `dispatch_refs_json[].appendAcceptance` | pending→accepted；只表达 Append 结果 | dispatch（A1-3） | transport exception 不等于 non-acceptance；writer 缺位时保持 pending |
| `messages.reply_to` | 必须同 thread | bubble-pipeline | 跨 thread reply → 422；跨 thread 只允许导航引用 |
| `cache` | provisional；按 threadId 寻址；version match 才渲染 | W7 | version mismatch → discard + hydrate；不跨 thread merge |
| `projectionState` | processing/unknown/terminal + missingEvidence | W7 | 证据不齐 → unknown + 原因；不猜 processing |
| `terminalBody` | runs.status terminal 优先于 settled | bubble-pipeline | 分事务中间态按 terminal 投影，不落 unknown |

#### config

| 变量 | 默认 | owner | 决定 | 说明 |
|---|---|---|---|---|
| `CODETEAM_MESSAGE_MAX_BODY_BYTES` | 262144 | bubble-pipeline | `new` | 单 message body 上限；超限 422 |
| `CODETEAM_RICH_BLOCK_MAX_BYTES` | 262144 | bubble-pipeline | `new` | rich block 上限 |
| `CODETEAM_HYDRATION_PAGE_SIZE` | 100 | bubble-pipeline | `new` | afterSeq 分页 |
| `CODETEAM_SEQ_GAP_CATCHUP_ENABLED` | 1 | bubble-pipeline | `new` | gap → hydration |
| `CODETEAM_RECONNECT_SNAPSHOT_ENABLED` | 1 | W7 | `new` | 非首连 reconnect 对 activeRuns/processing thread 走全量 snapshot |
| `CODETEAM_CACHE_SCHEMA_VERSION` | 1 | W7 | `new` | provisional cache schema |
| `CODETEAM_CACHE_CONTRACT_VERSION` | 1 | W7 | `new` | identity contract version |
| `CODETEAM_SQLITE_BUSY_TIMEOUT_MS` | 见 plans/0002 W1 | 全局 | `reference` | message/run 事务使用 |

#### security

| 变量/规则 | 值/来源 | owner | 失败语义 |
|---|---|---|---|
| `threadAccess` | identity-session thread access policy | W7 | 越权 thread → 403/空；跨 thread 导航引用也要过目标 thread 权限 |
| `authorIdentity` | server auth/run token；body author 不信任 | bubble-pipeline | 伪造 author → 422/403；response message 为 `author_kind='agent'` + `author_id=recipientProfileId` |
| `clientNoWrite` | 前端只 patch 服务器 message，不写新 message | W7 | 客户端造 id → 丢弃/诊断 |
| `controlRefDaemonOnly` | `control_ref` 只由 daemon 写 | bubble-pipeline | agent 写路径携带 control_ref → 422；进 W1 测试清单 |
| `dispatchDelivery` | Queue pending 不是 delivery；只有 dispatchRef 是 | bubble-pipeline | pending 当 delivered → bug |
| `inputReadEvidence` | presentation only；不裁决 handled | bubble-pipeline | read 当 handled → 拒绝 |
| `terminalTruth` | response lifecycle + runs.status | bubble-pipeline | 文本/日志当 terminal → 拒绝 |
| `lateStream` | terminal 后到达的 stream/chunk | W7 | 幂等拒绝；不覆盖 terminal body |
| `richBlockNoApproval` | `rich_blocks_json` 不含 approval 真相 | bubble-pipeline | 审批卡伪造 → 422 |
| `crossThreadIsolation` | 消息只在所属 thread 投影；导航引用不复制 | W7 | 跨 thread 复制 → 403；引用跳转必须过目标 threadAccess |
| `replyToSameThread` | `reply_to` 必须同 thread | bubble-pipeline | 跨 thread reply → 422 |
| `cacheNotAuthority` | cache 不参与在线 merge；按 threadId 隔离 | W7 | cache 覆盖 server / 跨 thread merge → 丢弃 |
| `unknownFailClosed` | 证据不齐显示 unknown | W7 | 猜 processing → bug |
| `orphanResponse` | messages 有 response 但无 runs.response_message_id 指向 | bubble-pipeline | health 告警；不自动删除 |

#### observability

| 变量/事件 | 值/来源 | owner | 说明 |
|---|---|---|---|
| `bubble_projection_unknown_total` | counter/thread/reason | W7 | 证据不齐 |
| `bubble_projection_unknown_missing_evidence_total` | counter/missingEvidence | W7 | unknown 分层原因 |
| `message_seq_gap_total` | counter/thread | W7 | seq gap |
| `hydration_catchup_total` | counter/thread/reason | W7 | gap catch-up |
| `reconnect_snapshot_refetch_total` | counter/thread | W7 | 非首连 reconnect 全量重取 |
| `duplicate_bubble_rejected_total` | counter | W7 | 第二 bubble identity 被拒 |
| `terminal_overwrite_rejected_total` | counter | bubble-pipeline | 重复/晚到 terminal |
| `late_stream_after_terminal_rejected_total` | counter | bubble-pipeline | terminal 后 late chunk |
| `dispatch_ref_ambiguous_total` | counter | bubble-pipeline | ref/response/run 不一致 |
| `orphan_response_message_total` | gauge | bubble-pipeline | response message 无 run 指向 |
| `cache_used_offline_total` | counter | W7 | provisional cache |
| `message_body_bytes` / `rich_block_bytes` | histogram | bubble-pipeline | 大小/性能 |

### 3.6 明确不做

- 不建第二套 message store；`messages` 是唯一可见 message 真相。
- 不建前端独立 bubble identity / canonical reducer ledger；只做 server-named message projection。
- 不让 Queue pending target 产生 delivery/avatar/processing。
- 不把 provider exit 0、日志文本、response 文本当 terminal truth。
- 不把 IDB/cache 当在线合并权威。
- 不恢复 F254 closure/supplement/attention 写路径。
- 不让 F322 InteractiveBlock 造第二 bubble identity；审批仍只来自 `approvals`。
- 不按时间邻近/内容相似合并 message/ref/supplement。
- 不跨 thread 复制消息或借 Hub 反向成为 review/merge 真相；跨 thread 只允许经 access check 的导航引用。
- v1 不新增 per-message `content_revision` 列；seq 是创建序不是 revision，断线追新靠 reconnect 全量 snapshot，不建第二修订账本。
- 不把 `dispatch_ref.phase=settled` 滞后当作 response 未完成；terminal truth 永远是 `runs.status`。
- 不做单一裸 `unknown` 徽章；unknown 必须带 missingEvidence 与分层文案/恢复入口。

### 3.7 与 A1-3 / A3-1 / A3-3 的边界

- A1-3 `dispatch` 拥有 `queue_entries`、claim、delivery、`dispatch_refs_json` 的运输与跨 thread return carrier；本卡定义 `dispatch_refs_json` 的**展示契约**与 response projection。跨 thread 跳转是导航引用，必须过目标 thread 的 `threadAccess`，不在 bubble 层复制消息或新造读权限。
- A2-1 `sop-bulletin`/inbox 拥有 unread/read 状态与 first-body 恰计一次规则；bubble 只投影 `inputRead`，不建第二 unread 计数器。
- A3-1 `ball-custody` 拥有 handoff/wait/action success；bubble 只投影可见消息和 terminal，不裁决 custody。
- A3-3 `observability` 拥有 trace/trajectory；bubble 不建第二 trace/event store；`inv:`/run id 只做 correlation。
- A2-3 `approval-index` 拥有审批；bubble 只允许 `approval_pointer` 导航，不渲染可审批卡。

## 4. 风险与回滚

| 风险 | 级别 | 处置 |
|---|---|---|
| live 与 hydration 分叉，ghost bubble | P1 | server-named id + same DTO；seq gap catch-up；reconnect 全量 snapshot；contract test |
| reconnect 后同 message 更新丢失，stale bubble | P1 | 非首连 reconnect 对 activeRuns/processing thread 全量 snapshot；terminal 后 late chunk 幂等拒绝；contract test 断言不残留 partial |
| response message 与 runs 分事务，orphan empty response | P2 | 同 `BEGIN IMMEDIATE` 事务 INSERT；orphan health 告警；不自动删除 |
| dispatch_refs_json 并发 append 丢 target | P2 | 所有 read-modify-write 在 `BEGIN IMMEDIATE` 内；多 target append contract test |
| unknown 裸徽章，operator 分不清缺哪条证据 | P2 | `missingEvidence` + 三源分层文案 + 只引用 A1-3 recovery 入口 |
| 跨 thread 导航引用绕过权限 | P2 | 引用不复制；跳转过目标 threadAccess；`reply_to` 同 thread CHECK |
| terminal body 与 settled 分事务的中间态 | P2 | runs.status terminal 优先；允许 terminal+unsettled 短暂共存，不落 unknown |
| 多 target 重复 source bubble | P1 | dispatchRefs append to same source; one source bubble |
| Queue pending 当 delivery | P1 | ref only on actual dispatch; pending not projected |
| terminal 文本覆盖真相 | P1 | terminal from runs.status + response lifecycle; text is presentation |
| 第二 bubble identity / reducer ledger | P1 | client only patches server id; duplicate identity rejected |
| IDB/cache 成为第二真相 | P1 | provisional cache; online replace; version mismatch discard |
| F254 closure/supplement 回流 | P2 | drop runtime; historical rows read-only |
| F322 block 重复渲染/伪造审批 | P2 | rich_blocks_json + server-only binding; approval pointer only |
| cross-thread 可见性泄露 | P1 | thread access policy; projection scoped |
| 大 body/rich block | P2 | byte limits; 422; truncation not silent |
| 晚到/重复 terminal | P1 | one terminal; idempotent replay; reject overwrite |

**回滚**：W1 的 `messages.seq`/`runs.response_message_id`/`execution_kind` 是 additive；回滚只影响 W7 投影，不影响 `messages`/`runs` 真相。cache 可删除重建；不迁移 clowder 历史 supplement/closure。

## 5. Review 与签字

> Review request `92a939a1-8e83-47d1-ae0c-24045d1b2472`（2026-10-25，三猫）。结论：烁烁 accept；砚砚 accept-with-modify；墨墨 accept-with-modify。**无 P1**；3×P2 + 12×P3 已回写，不触发第二轮 review。Operator 2026-10-25 拍 `DP-BUBBLE-1=A`：**W1 approved；W7 approved-for-direction（provisional until W4 dogfood）**。

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | message identity、seq/hydration、W1/W5 事务、dispatchRefs | accept；P3×3 已回写（BEGIN IMMEDIATE/busy 503、seq 边界/content_revision、response author） |
| 砚砚 | 跨 thread 可见性、消息伪造、terminal truth、cache fail-closed | accept-with-modify；P2-1 同事务/orphan health 已回写；P3×4 已回写（dispatchRefs append 事务、跨 thread 导航引用/reply_to、control_ref 422 测试、cache per-thread） |
| 墨墨 | W7 聊天/气泡体验、one terminal、unknown 可读性 | accept-with-modify；P2-1 unknown 分层/missingEvidence、P2-2 reconnect snapshot 已回写；P3×5 已回写（writer ownership、unread 计数、routing_guard 渲染、cache provisional 文案、terminal/settled 顺序） |
| operator | bubble-pipeline W1/W7 契约 | 已签 `DP-BUBBLE-1=A`：W1 approved；W7 approved-for-direction（provisional until W4 dogfood） |

**Findings disposition**

| # | 来源 | Finding | 处置 |
|---|---|---|---|
| P2-1 | 砚砚 | response message 与 `runs` insert 未声明同事务；crash 产生 orphan empty response | **已修**：同 `BEGIN IMMEDIATE` 事务；orphan response health 告警，不自动删除 |
| P2-1 | 墨墨 | unknown 只有状态机，无 missingEvidence/分层文案/恢复入口 | **已修**：ProjectionState 带 `missingEvidence`；W7 三源分层文案；恢复入口只引用 A1-3 dispatch recovery |
| P2-2 | 墨墨 | `afterSeq` 只捕新 message，断线期间同 message 的 stream/terminal 更新丢失 | **已修**：非首连 reconnect 对 activeRuns/processing thread 全量 snapshot；terminal 后 late chunk 幂等拒绝；contract test |
| P3-1 | 烁烁 | `MAX(seq)+1` 依赖写锁，未钉死事务模式 | **已回写**：`BEGIN IMMEDIATE`；busy 重试一次后 503 |
| P3-2 | 烁烁 | same-message 更新丢失不自愈侦测，需边界声明 | **已回写**：seq 只侦测新 message；v1 靠 reconnect snapshot；未来 content_revision 挂点 |
| P3-3 | 烁烁 | response message author 归属未写 | **已回写**：`author_kind='agent'` + `author_id=recipientProfileId`；system 只写 daemon 控制消息 |
| P3-1 | 砚砚 | dispatch_refs_json 多 target append 并发语义未写 | **已回写**：read-modify-write 全在 `BEGIN IMMEDIATE` |
| P3-2 | 砚砚 | 跨 thread 引用语义悬空；reply_to 缺同 thread 约束 | **已回写**：只允许过 threadAccess 的导航引用；`reply_to` 同 thread CHECK |
| P3-3 | 砚砚 | control_ref daemon-only 规则未挂 W1 测试 | **已回写**：agent 写路径携带 control_ref → 422，进 W1 测试清单 |
| P3-4 | 砚砚 | cache 缺 thread 隔离 | **已回写**：cache 按 threadId 寻址，不跨 thread merge |
| P3-1 | 墨墨 | inputRead/appendAcceptance 写入者未列 ownership | **已回写**：read←target mark-read（A2-1/W7）；accepted←A1-3 运输结果；缺位保持 pending |
| P3-2 | 墨墨 | unread 计数契约缺失 | **已回写**：引用 A2-1 first-body 恰计一次；bubble 不建第二计数器 |
| P3-3 | 墨墨 | routing_guard 无 W7 渲染契约 | **已回写**：response bubble join `runs.executionKind` 标“系统辅助” |
| P3-4 | 墨墨 | cache provisional 无可见提示 | **已回写**：渲染“本地缓存，待服务器对齐” |
| P3-5 | 墨墨 | terminal body 与 settled 分事务时投影规则未写 | **已回写**：runs.status terminal 优先；允许短暂 terminal+unsettled，不落 unknown |

**Review 重点**

1. `messages.seq` + `runs.response_message_id` 是否足以锁死 message identity 与 hydration cursor。
2. `dispatch_refs_json` 的 target/phase/statusMessageId/inputRead 是否覆盖 W1/W7，且不把 Queue pending 当 delivery。
3. live/hydration 同 DTO、server-named writer、reconnect 全量 snapshot、cache provisional 是否足以消除 ghost/stale bubble。
4. `unknown` fail-closed 与 one terminal 是否覆盖所有 partial/ambiguous 证据。
5. F254/F322 的 drop/adapt 边界是否清楚；有没有恢复已退役责任或第二 bubble identity。

[宪宪/deepseek-flash🐾]
