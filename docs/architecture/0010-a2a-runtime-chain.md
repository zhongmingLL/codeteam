---
title: "codeteam A2A runtime chain v1 — Clowder-aligned"
doc_kind: architecture
status: accepted
created: 2026-11-06
updated: 2026-11-10
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_signoff: "confirmed 2026-11-06"
operator_direction: "直接复用 Clowder A2A runtime 骨架；v1 轻量化；MCP callback → pi extension tools；不做 task-first/custody/action/wait/compaction；session active-only"
related_features: [codeteam/F018, codeteam/F017]
---

# codeteam A2A runtime chain v1

> 直接复用 Clowder 已经验证过的 A2A runtime 骨架：
> **Message/InvocationQueue → QueueProcessor → InvocationRecord → InvocationTracker → AgentRouter → invoke-single-agent/TurnExecution → InvocationRegistry → A2A tools → terminal collector → recovery/read models**。
>
> codeteam 只替换 runtime 适配：pi 执行层、pi extension tools、active-only session；
> 不另造一套缺 tracker/processor/collector 的轻量链路。
>
> 身份/引用命名以 `0011-identity-contract.md` 为准；本文旧名只出现在迁移/映射表。

## 0. 结论先行

1. **10 个组件按 Clowder 结构复用**，只做 v1 轻量化；`routeSerial` 单体实现去掉，per-agent pipeline 抽成 `runAgentTurn`，`routeAgents` 保留 parallel/serial 调度。
2. **父/子/认证三层固定**：
   - `InvocationRecord`（parent）管消息生命周期；
   - `TurnExecution`（child）管单 agent 执行；
   - `InvocationCredential`（auth）管 pi extension 工具能力。
3. **Queue 只做调度**：`InvocationQueue`/`QueueEntry` 负责 admission/claim/lease；不持有消息终态。
4. **Parent 在 QueueProcessor claim 后创建**（对齐 Clowder）：queue entry 是待处理账本，parent 是处理生命周期。
5. **`TurnExecutionStore.createRunning` 是执行幂等入口**：`created/replayed/conflict`；
   provider 启动前必须有 attempt + core TurnExecution + credential。
6. **终态路径只有一条**：`transitionTerminal` → `PerAgentTerminalDispositionCollector` →
   parent aggregate → credential terminalize，同一事务；R terminal 由
   `response_pending` settlement 作为可恢复的第二段提交。
7. **v1 不做**：MCP、task/role/run 字段、custody/action/wait、compaction、session sealed、outputFence/coveredMessageIds、trajectory projector、idempotencyKey/intent。

## 1. 设计原则

- **直接复用结构，不复制特性**：组件/职责照 Clowder；v1 不需要的字段和分支删掉。
- **单一真相**：
  - `InvocationQueue`：待处理/调度真相；
  - `InvocationRecord`：消息级生命周期真相；
  - `TurnExecution`：单 agent 执行真相；
  - `InvocationCredential`：工具回调能力真相；
  - `InvocationTracker`：进程内活跃槽，不是 durable 真相。
- **一个 child 一次 terminal**；一个 parent 一个 aggregate。
- **terminal 原子性**：child terminal + parent aggregate + credential terminal 必须同事务；
  R terminal 通过 `response_pending` 账本单独提交，崩溃后可重放。
- **A2A hop 是消息级递归**：新 message + 新 queue entry + 新 parent，不在同一 route 内递归 push target。

## 2. 全链路

```text
Message
  → InvocationQueue.enqueue（QueueEntry）
  → QueueProcessor.drain/processEntry
      → InvocationRecordStore.create（parent，claim 后）
      → InvocationTracker.start(thread, agent)
      → AgentRouter.routeAgents
          → runAgentTurn（parallel merge）
              → invoke-single-agent
                  → InvocationAttemptStore.appendQueued
                  → MessageStore.append（processing R）
                  → TurnExecutionStore.createRunning
                  → InvocationAttemptStore.bindExecution
                  → InvocationRegistry.create（credential）
                  → pi worker / provider
                  → WorkerEventSink → response_drafts
                  → TurnExecution.transitionTerminal
                  → attempt terminal + settlement='response_pending'
                  → InvocationRegistry.commitTerminal
                  → PerAgentTerminalDispositionCollector
                  → InvocationRecordStore.applyTerminalAggregate
                  → ResponseSettlementService.settleResponseFromDraft
      → QueueProcessor retire target / release tracker
  → StartupReconciler / ZombieRecovery / LiveInvocations / DispatchSummary
```

A2A hop：

```text
TurnExecution A 调 post_message
  → 新 Message m2 + InvocationQueue.enqueue
  → 新 parent InvocationRecord invP2
  → 新 TurnExecution C：
      invocationRecordId=invP2
      a2aParentTurnExecutionId=A.turnExecutionId（A2A 因果父）
      a2aTriggerMessageId=m2
      a2aDepth=A.depth+1
  → 超过 15 拒绝
```

## 3. 组件设计

### 3.0 Operator ingress + target resolution

**定位**：operator 没有 tools，行首 `@` 是 operator 侧的 A2A admission；agent 侧仍然用 typed tool targets。

**Message 字段**

`StoredMessage.targetAgentIds` 保存 user message 本次 admission 的 agent targets；
agent-authored A2A message 的 targets 由 `lifecycle.dispatchRefs` 承载。

**解析顺序**

1. `parseOperatorMentions(body)`：纯函数，只解析行首 `@`（含列表/引用前缀），跳过 fenced/inline code；返回 handles。
2. `resolveExplicitTargets(handles)`：AgentRegistry 校验存在/enabled；未知/歧义/disabled → typed reject（fail closed）。
3. 无显式 `@` → `resolveImplicitTargets(threadId)`：
   1. 最近一条 user message 的 `targetAgentIds`；
   2. 最近成功响应过的 agent（TurnExecution completed）；
   3. thread participants 的第一个（加入顺序）；
   4. AgentRegistry `defaultAgentId`；
   5. 都没有 → `no_target`。
4. 同一事务：`messages.append({ targetAgentIds })` + `invocationQueue.enqueue({ sourceRecordId: message.id, messageId: message.id, attempt: 1, targets })`。

**operator target**

- operator 作为 target 只由 agent tools 传入 `{kind:"operator", id:userId}`；
- operator 自己不发 operator target；行首 `@` 只解析为 agent target；
- operator target 只通知/可见，不创建 parent/TurnExecution。

**边界**

- QueueProcessor / AgentRouter / invoke-single-agent 不再解析 `@`；
- agent final response 不解析 `@`；
- A2A tools 只接受 typed `{kind,id}`；
- 未知/歧义/disabled handle 不静默当普通文本，fail closed。

### 3.1 Message + InvocationQueue / QueueLedger

**命名**
- `queue_entries` → `invocation_queue`
- `QueueStore` → `SqliteQueueLedgerStore`（implements `QueueLedgerStore`）
- 服务 `InvocationQueue`
- 记录类型 `QueueEntry`

**v1 `QueueEntry`（多層次，Clowder-aligned）**

```ts
type QueueOwner =
  | { kind: "user"; userId: string }
  | { kind: "system"; service: string };

type QueueTarget =
  | { kind: "agent"; id: string }     // id = AgentConfig.agentId
  | { kind: "operator"; id: string }; // id = thread owner userId

type QueueEntryKind = "conversation_input" | "message_wake";

// durable row 只允许 queued/claimed；processing/terminal 只出现在 projection/读模型。
type QueueDurableStatus = "queued" | "claimed";
type QueueProjectionStatus = "processing" | "terminal";
type QueueLedgerStatus = QueueDurableStatus | QueueProjectionStatus;

interface QueueEntry {
  version: 1;
  queueEntryId: string;          // queue:<sha256(sourceRecordId:attempt)>
  threadId: string;
  owner: QueueOwner;
  kind: QueueEntryKind;
  from: MessageFrom;             // user | agent | system
  targets: QueueTarget[];        // pending targets；派发后收缩
  payload: QueuePayload;
  execution: QueueExecution;
  delivery: QueueDelivery;
  claim: QueueClaim | null;
  status: QueueDurableStatus;
  priority: "urgent" | "normal";
  position: number;
  enqueuedAt: number;
  updatedAt: number;
}

interface QueuePayload {
  sourceRecordId: string;        // 队列身份；v1 = messageId
  messageId: string | null;      // 持久消息；v1 恒非空
  originRecordId: string | null; // run/backlog/schedule/handoff provenance
  attempt: number;               // 1-based
  content: string;               // admission 时正文快照
  requestedTargets: QueueTarget[]; // admission 全量快照
  requestId?: string;            // A2A requestId 幂等
}

interface QueueExecution {
  a2aParentTurnExecutionId: string | null;
  a2aTriggerMessageId: string | null;
  a2aDepth: number;
}

interface QueueDelivery {
  operatorNotifiedAt: number | null;
}

interface QueueClaim {
  claimId: string;
  owner: string;                 // QueueProcessor claim identity
  claimedAt: number;
  expiresAt: number;
  targetKeys: string[];          // 本次 claim 保护的精确 pending targets
}

// transition projection：只在返回值/读模型出现，不写 invocation_queue。
interface QueueAttemptProjection {
  status: "processing";
  queueEntryId: string;
  targets: QueueTarget[];        // 本次 retire 的 targets 切片
  startedAt: number;
}

interface QueueTerminalProjection {
  status: "terminal";
  queueEntryId: string;
  targets: QueueTarget[];
  endedAt: number;
  reason: "dispatched" | "withdrawn";
}
```

**`QueueTarget`**

- `targetKey(target)`：`agent:<id>` / `operator:<id>`；用于去重、claim、移除。
- `agent` target → 创建 `invocation_attempts` + core `TurnExecution` + processing R，
  调用 pi worker。
- `operator` target → 不创建 TurnExecution；只做消息可见/通知，标记 `delivery.operatorNotifiedAt` 后移除。
- 允许 **operator-only**：没有 agent target 时只通知，不创建 parent `InvocationRecord` / TurnExecution。

**`parseTarget`（仅 operator conversation ingress）**

- 只解析**行首 `@handle`**（含列表/引用前缀）；正文中间 `@` 不路由。
- 多个 `@` → 多个 `QueueTarget`；按 targetKey 去重。
- 通过 AgentConfig handle/alias 解析；未知/歧义 → typed reject `unknown_target`；disabled → `agent_disabled`。
- 没有行首 `@` → 隐式路由（上一 human `targetAgentIds` → 最近成功 replier → participant → default agent）；都没有才 `no_target`。
- **不解析 agent final response 的 `@`，也不解析 A2A tool 正文的 `@`。**
- A2A tools 的 `targets` 是显式 `{kind,id}` 对象数组；operator target 只能从这里进入。

**`QueueLedgerStore`（SQLite port）**

只做持久化与原子 CAS，不决定“谁该跑”：

```ts
interface QueueLedgerStore {
  enqueue(entry: QueueEntry): QueueEnqueueResult;
  get(threadId: string, queueEntryId: string): QueueEntry | null;
  listQueued(threadId: string): QueueEntry[];
  listActive(threadId: string): QueueEntry[];
  countQueued(threadId: string): number;

  claim(threadId: string, queueEntryId: string, input: QueueClaimInput): QueueClaimResult;
  retireTargets(
    threadId: string,
    queueEntryId: string,
    claimId: string,
    input: QueueRetireInput,
  ): QueueRetireResult;
  releaseClaim(threadId: string, queueEntryId: string, claimId: string): QueueReleaseResult;
  withdrawTargets(threadId: string, queueEntryId: string, input: QueueWithdrawInput): QueueWithdrawResult;

  restoreExpiredClaims(now: number): number;
}

type QueueEnqueueResult =
  | { outcome: "enqueued"; entry: QueueEntry }
  | { outcome: "replayed"; entry: QueueEntry | null }
  | { outcome: "conflict"; entry: null };

interface QueueClaimInput {
  claimId: string;
  owner: string;
  ttlMs: number;
  targetKeys: string[];          // entry.targets 的非空子集
  now?: number;
}

type QueueClaimResult =
  | { outcome: "claimed"; entry: QueueEntry }
  | { outcome: "not_found" }
  | { outcome: "state_changed" };

interface QueueRetireInput {
  targetKeys: string[];          // claim.targetKeys 的子集
  delivery?: { operatorNotifiedAt?: number };
  now?: number;
}

interface QueueWithdrawInput {
  claimId?: string;              // entry 处于 claimed 时必填
  targetKeys?: string[];         // 省略 = 全部 targets
  actorRef: string;
  reason: string;
  now?: number;
}

type QueueRetireResult =
  | {
      outcome: "updated";
      entry: QueueEntry;
      projection: QueueAttemptProjection;
    }
  | {
      outcome: "deleted";
      entry: QueueEntry;
      projection: QueueAttemptProjection;
    }
  | { outcome: "not_found" }
  | { outcome: "state_changed" };

type QueueReleaseResult =
  | { outcome: "updated"; entry: QueueEntry }
  | { outcome: "not_found" }
  | { outcome: "state_changed" };

type QueueWithdrawResult =
  | { outcome: "updated"; entry: QueueEntry; projection?: QueueTerminalProjection }
  | { outcome: "deleted"; entry: QueueEntry; projection: QueueTerminalProjection }
  | { outcome: "not_found" }
  | { outcome: "state_changed" };
```

**`InvocationQueue`（服务）**

准入校验、默认值、稳定 id、调用 store；QueueProcessor 只依赖这一层：

```ts
interface QueueEnqueueInput {
  threadId: string;
  kind: QueueEntryKind;
  owner: QueueOwner;
  from: MessageFrom;
  sourceRecordId: string;        // 队列身份；v1 = messageId
  messageId: string | null;      // 持久消息；v1 恒非空
  originRecordId?: string | null;
  attempt?: number;              // 默认 1
  content: string;               // admission 正文快照
  targets: QueueTarget[];
  priority?: "urgent" | "normal";
  execution?: Partial<QueueExecution>;
  requestId?: string;
}

class InvocationQueue {
  enqueue(input: QueueEnqueueInput): QueueEnqueueResult;

  get(threadId: string, queueEntryId: string): QueueEntry | null;
  listQueued(threadId: string): QueueEntry[];
  listActive(threadId: string): QueueEntry[];
  countQueued(threadId: string): number;

  claim(threadId: string, queueEntryId: string, input: QueueClaimInput): QueueClaimResult;
  retireTargets(
    threadId: string,
    queueEntryId: string,
    claimId: string,
    input: QueueRetireInput,
  ): QueueRetireResult;
  releaseClaim(threadId: string, queueEntryId: string, claimId: string): QueueReleaseResult;
  withdrawTargets(threadId: string, queueEntryId: string, input: QueueWithdrawInput): QueueWithdrawResult;

  restoreExpiredClaims(now?: number): number;
}
```

**`claim` / `retire` 语义**

- 一条 entry 同时只有一个 active claim；`claim.targetKeys` 是本次受保护的 pending targets 子集。
- `claim` 是短时、可撤销租约，不是执行状态，不创建 TurnExecution。
- `retireTargets` 是“派发完成”的提交点：从 `targets` 移除已派发/已通知的 target；全部移除后删除 entry。
- `releaseClaim` 用于派发前失败/超时；targets 保持不变，退回 `queued`。
- `retireTargets` 必须与 parent 创建、child `createRunning` 同事务；provider 启动在事务外。

**状态投影（DP-F018Q-2=B）**

- `QueueLedgerStatus` 保留 `queued | claimed | processing | terminal` 四值 union。
- `QueueEntry.status` 只取 `QueueDurableStatus = queued | claimed`；durable row 不写 processing/terminal。
- `processing` 只出现在 `QueueAttemptProjection`（retire 切片）；`terminal` 只出现在 `QueueTerminalProjection`（withdraw 删除）。
- `invocation_queue.status` 的 SQL CHECK 只允许 `queued | claimed`；投影不落库。

**重放保护（DP-F018Q-3=A）**

新增 `queue_admissions` receipt，保证“队列行已删除后，同一 source 重试”仍是 `replayed`：

```text
source_record_id | attempt | queue_entry_id | fingerprint | admitted_at
```

`enqueue` 顺序：

1. 有 live row → 比较不可变 admission 字段；一致 `replayed`，不一致 `conflict`。
2. 无 live row，有 receipt → 比较 fingerprint；一致 `replayed`（`entry:null`），不一致 `conflict`。
3. 都没有 → 插入 row + receipt → `enqueued`。

fingerprint 只覆盖不可变字段（source、owner、kind、from、payload、requestedTargets、priority、execution），不覆盖 `targets/status/claim/delivery`。

**StoredMessage（单层，durable history）**

`invocation_queue` 只持有“尚未派发的 pending targets”；target 派发后 live row 会收缩或删除。
durable 回执不能靠 queue row，必须落在 Message lifecycle。对齐 Clowder 的两层模型：

```ts
type MessageSender =
  | { kind: "user"; userId: string }
  | { kind: "agent"; agentId: string }
  | { kind: "system"; service: string };

type MessageFrom = MessageSender; // Queue/storage alias

type TextContent = { type: "text"; text: string };
type ToolCallContent = {
  type: "tool_call";
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
};
type ToolResultContent = {
  type: "tool_result";
  toolId: string;
  result: unknown;
  isError?: boolean;
};

type MessageContent = TextContent | ToolCallContent | ToolResultContent;
// v1 只做这三种；image/file/code/context_attachment 后续按 Clowder 扩展

type RichBlockKind =
  | "card" | "diff" | "checklist" | "media_gallery"
  | "audio" | "interactive" | "html_widget" | "file";

/** Hub 呈现块容器；RichBlock 的具体形状按 0001 的 RichBlock 契约，
 *  不在 MessageStore 里复制 8 种 block 的字段。 */
interface RichMessageExtra {
  v: 1;
  blocks: Array<{ id: string; kind: RichBlockKind; v: 1; [key: string]: unknown }>;
}

/** execution replay；与 contentBlocks 的语义内容分开 */
interface StoredToolEvent {
  id: string;
  executionRef?: string;             // turnExecutionId
  type: "tool_use" | "tool_result";
  label: string;
  detail?: string;
  timestamp: number;
  toolUseId?: string;
  status?: "ok" | "error" | "unknown";
  startTimeMs?: number;
  endTimeMs?: number;
  toolName?: string;
}

/** storage：v1 唯一消息记录；不再定义 domain Message */
interface StoredMessage {
  id: string;
  threadId: string;

  from: MessageFrom;                 // canonical sender；不另存 catId/agentId
  content: string;                   // plain text body（DB body_md）
  contentBlocks?: MessageContent[];  // semantic blocks（DB content_json）
  toolEvents?: StoredToolEvent[];    // execution replay（DB tool_events_json）

  lifecycle?: MessageLifecycle;      // input / response / delivery_failure
  replyTo?: string;

  seq: number;                       // thread-global order
  timestamp: number;                 // message time
  updatedAt: number;

  thinking?: string;                 // optional sidecar
  deletedAt?: number;                // soft delete
  deletedBy?: string;

  extra?: {
    kind?: MessageKind;              // codeteam extension
    targetAgentIds?: string[];       // user admission snapshot
    rich?: RichMessageExtra;         // Hub presentation；不是 MessageContent
    crossPost?: { sourceThreadId: string; sourceMessageId?: string };
  };
}

type MessageLifecycle =
  | { kind: "input"; dispatchRefs: DispatchRef[] }
  | {
      kind: "response";
      invocationRecordId: string;
      turnExecutionId: string;
      target: QueueTarget;
      status: "processing" | "completed" | "failed" | "interrupted" | "canceled";
      startedAt: number;
      endedAt?: number;
    }
  | {
      kind: "delivery_failure";
      status: "failed";
      sourceEntryId: string;
      inputMessageId: string;
      requestedTargets: QueueTarget[];
      reason:
        | "no_target"
        | "unknown_agent"
        | "agent_disabled"
        | "account_missing"
        | "thread_deleted"
        | "worker_capacity"
        | "worker_start_failed"
        | "credential_mint_failed";
      createdAt: number;
    };

interface DispatchRef {
  target: QueueTarget;
  queueEntryId: string;
  attempt: number;
  phase: "dispatched" | "settled";
  responseMessageId?: string;
  turnExecutionId?: string;
  at: number;
}
```

- v1 **不定义 domain `Message`**：当前没有独立消费者；`StoredMessage` 就是唯一消息记录，
  `MessageStore` 持久化/返回 `StoredMessage`，API/CLI 直接使用；以后出现外部 SDK/stream
  contract 再加投影。
- **一条 StoredMessage 只代表一条消息，不代表整个 thread**：`threadId` 是归属指针；
  thread 历史是同一 `threadId` 下的多条 StoredMessage，按 `seq` 排序。
- `from` 是 canonical sender；不另存 `catId`/`agentId` 兼容字段。Clowder 的 `catId` 是
  `from.kind='agent'` 的兼容投影；codeteam 新 schema 不需要重复。
- `content` 是 plain text body（DB `body_md`）；`contentBlocks` 是语义内容
  （DB `content_json`）；`toolEvents` 是执行回放（DB `tool_events_json`）；
  `extra.rich` 是 Hub 呈现块（不是 MessageContent）。
- `extra` 是开放 bag；v1 只写 4 个 key：`kind` / `targetAgentIds` / `rich` / `crossPost`。
  `kind` 是 codeteam 扩展；`targetAgentIds` 仅 user admission；agent A2A targets 走
  `lifecycle.dispatchRefs`；`rich` 是 Hub presentation；`crossPost` 是跨 thread provenance。
- `extra.rich` 不是 `unknown[]`：它是 `RichMessageExtra = {v:1, blocks: RichBlock[]}`，
  kind 为 `card/diff/checklist/media_gallery/audio/interactive/html_widget/file`；
  block 具体形状复用 `0001-codeteam-architecture-v1.md` 的 RichBlock 契约，不在这里复制。
- `timestamp` 是消息时间；`updatedAt` 是修订时间；`seq` 是 thread 内顺序。
  `thinking?` 是可选的模型思考 sidecar，不放进 `contentBlocks`。
- `userId` 不存 message：thread owner 派生；v1 单 user。完整矩阵见
  `0011-identity-contract.md` §11；Clowder 存 `StoredMessage.userId`，v1 有意省。
- `status` 不存 StoredMessage：持久消息即 complete；展示/流式状态由读模型投影。
- `deletedAt` / `deletedBy` 保留软删除；`deliveryStatus` 不存（queue/lifecycle 派生）；
  `_tombstone` / `recall` v1 不做。
- `mentions` / `mentionsUser` 不存：A2A targets 是 typed `dispatchRefs`；
  文本 `@` 不路由；UI 从 dispatchRefs 渲染目标。
- `lifecycle` 是 server-owned typed sidecar；**不要**塞进 `extra`。
- `input` 的 `dispatchRefs`：`dispatched` → `settled`；同一
  `(target, queueEntryId, attempt)` 唯一，重放不得二次 dispatch。
- `response` lifecycle 记录 parent/child/target/status（processing|terminal）/reason；
  response 状态用 CAS 推进。
- `delivery_failure` 是 **独立 system message**（`from.kind='system'`,
  `service='message_delivery'`）：记录 `inputMessageId` / `requestedTargets` / `reason`；
  source 的 dispatchRefs 同时 settle；只在 processing R 尚未创建时使用。
- `audit` 是 task-first 遗留的运维日志（actor/action/subject/args/ts），不属于 A2A
  message/lifecycle 契约，也不作为 delivery_failure 的替代；A2A 失败面只看
  `delivery_failure` 消息 + `TurnExecution`。
- queue live row 保留到 attempt 终态；读模型从 `StoredMessage.lifecycle` +
  `invocation_attempts` + `turn_executions` 还原“发给了谁、谁处理、对应哪条 response”；
  `queue_admissions` 只负责 admission 幂等。
- v1 不做 Clowder 的 `appendAcceptance` / `inputRead` / `coveredMessageIds`；
  这些属于 append acceptance / carrier 审计，v2 再加。

**v1 不做**
- `author_intent_json`、message disposition、action/wait carrier、fence refs、cloud provenance、steer。
- 路由/解析错误：pre-admission 走 typed reject；admitted 后失败写 `delivery_failure`
  system message；QueueEntry 不存 `routingWarnings`/`lastError`；audit 不再作为 A2A 错误面。

### 3.1.1 MessageStore（基于 StoredMessage）

**表（物理映射）**

```sql
-- 现有列继续用：id / thread_id / author_kind / author_id / body_md /
-- reply_to / seq / created_at / updated_at
ALTER TABLE messages ADD COLUMN content_json TEXT
  CHECK (content_json IS NULL OR
    (json_valid(content_json) AND json_type(content_json) = 'array'));
ALTER TABLE messages ADD COLUMN tool_events_json TEXT
  CHECK (tool_events_json IS NULL OR
    (json_valid(tool_events_json) AND json_type(tool_events_json) = 'array'));
ALTER TABLE messages ADD COLUMN lifecycle_json TEXT
  CHECK (lifecycle_json IS NULL OR
    (json_valid(lifecycle_json) AND json_type(lifecycle_json) = 'object'));
ALTER TABLE messages ADD COLUMN extra_json TEXT
  CHECK (extra_json IS NULL OR
    (json_valid(extra_json) AND json_type(extra_json) = 'object'));
ALTER TABLE messages ADD COLUMN thinking TEXT;
ALTER TABLE messages ADD COLUMN deleted_at INTEGER;
ALTER TABLE messages ADD COLUMN deleted_by TEXT;
```

- `author_kind` + `author_id` 是 `StoredMessage.from` 的物理映射；不另加 `from` 列。
- `body_md` 映射 `StoredMessage.content`；`created_at` 映射 `timestamp`。
- `content_json` = `contentBlocks`；`tool_events_json` = `toolEvents`；
  `lifecycle_json` = `lifecycle`；`extra_json` = `extra`。
- legacy `task_id/control_ref/dispatch_refs_json/rich_blocks_json/kind` 停止写入；
  R1 回填 `extra.kind` / `extra.rich` 后只读，R5 drop。

**接口**

```ts
interface MessageStore {
  getById(id: string, options?: { includeDeleted?: boolean }): StoredMessage | null;
  latestSeq(threadId: string): number;

  getByThread(threadId: string, limit: number, options?: {
    includeDeleted?: boolean;
  }): StoredMessage[];
  getByThreadAfter(threadId: string, afterSeq: number, limit: number, options?: {
    includeDeleted?: boolean;
  }): StoredMessage[];
  getByThreadBefore(threadId: string, beforeSeq: number, limit: number, options?: {
    includeDeleted?: boolean;
  }): StoredMessage[];

  append(input: AppendMessageInput): StoredMessage;
  appendIdempotent(input: AppendMessageInput): {
    message: StoredMessage;
    replayed: boolean;
  };

  advanceLifecycleInputDispatch(id: string, patch: LifecycleInputDispatchPatch): StoredMessage;
  commitLifecycleResponseTerminal(id: string, patch: LifecycleResponseTerminalPatch): StoredMessage;
  commitLifecyclePreAdmissionFailure(input: LifecyclePreAdmissionFailureInput): {
    source: StoredMessage;
    failure: StoredMessage;
  };

  updateExtra(id: string, extra: NonNullable<StoredMessage["extra"]>): StoredMessage | null;
  softDelete(id: string, deletedBy: string, options?: { expectedUpdatedAt?: number }): StoredMessage;
}
```

**方法语义**

- `append`：分配 `seq = max(seq)+1`；`expectedSeq` 可选 CAS；写入
  `from/content/contentBlocks/toolEvents/lifecycle/extra`。response lifecycle 必须绑定
  `invocationRecordId/turnExecutionId/target/status/startedAt`；processing R 用
  `status='processing'` + 空 content，在 dispatch 事务内创建。
- `appendIdempotent`：与 `append` 相同，但按 `id`/幂等键返回 `replayed`；不同 payload → conflict。
- `advanceLifecycleInputDispatch`：按 `(targetKey, queueEntryId, attempt)` 精确匹配；
  只允许 `dispatched → settled`；同 phase 同 payload = idempotent no-op。
- `commitLifecycleResponseTerminal`：只允许 response lifecycle；status 只能
  `processing → completed|failed|interrupted|canceled`；terminal 后不可改。patch 带
  final `content/contentBlocks/toolEvents/thinking/extra`；failed/interrupted/canceled
  必须带 reason。v1 durable streaming 的 R terminal 走这里。
- `commitLifecyclePreAdmissionFailure`：同事务追加 system message（`from.kind='system'`,
  `service='message_delivery'`）+ settle source 的 `dispatchRefs`；reason 必须是
  `no_target/unknown_agent/agent_disabled/account_missing/thread_deleted/worker_capacity/
  worker_start_failed/credential_mint_failed`。只在 dispatch 事务未创建 processing R 时使用；
  R 已创建后的失败走 R terminal settlement。
- `updateExtra`：更新 `extra`（kind/targetAgentIds/rich/crossPost）；CAS 可选。
- `softDelete`：写 `deleted_at/deleted_by`；不改 `seq`/lifecycle；默认读排除删除行。
- `getBy*` 默认 `deleted_at IS NULL`；`includeDeleted` 给 read model 用。
- **不拥有** queue/cursor/session；不做可见性过滤；`seq` 只保证 thread 内顺序。

**事务边界**

| 场景 | 同一事务 |
|---|---|
| admission | `append` + `InvocationQueue.enqueue` + `queue_admissions` |
| dispatch | `advanceLifecycleInputDispatch(dispatched)` + parent/attempt + TurnExecution + processing R + credential + `retireTargets` |
| child terminal | TurnExecution `transitionTerminal` + attempt terminal + attempt `settlement='response_pending'` + parent aggregate + credential terminalize |
| response settlement | `commitLifecycleResponseTerminal` + `advanceLifecycleInputDispatch(settled)` + attempt `settled` + `clearResponsePending` |
| delivery failure | `commitLifecyclePreAdmissionFailure` + source dispatchRefs settle |
| soft delete | `softDelete`（可选 thread event） |

`ControlTransaction` 可重入；上层 service 打开事务，store 内调用不会重复 BEGIN。

**与 Clowder `IMessageStore` 的关系**

- 核心方法名/语义对齐 Clowder：`getById` / `append` / `appendIdempotent` /
  `getByThread` / `getByThreadAfter` / `getByThreadBefore` /
  `advanceLifecycleInputDispatch` / `commitLifecycleResponseTerminal` /
  `commitLifecyclePreAdmissionFailure` / `softDelete` / `updateExtra`。
- Clowder 的 `IMessageStore` 还有约 40 个 surface-specific 方法：mention inbox、
  composer drafts、recall/restore、whisper、connector source、delivery status、
  hard delete、stream metadata、custody/plugin、unread projection 等。v1 纯 A2A
  不需要，故意不加，避免造死接口。
- Clowder 的 `appendWithQueueLedgerAdmission` 和 codeteam 的“`append` +
  `InvocationQueue.enqueue` 外包 `ControlTransaction`”**语义相同**，没有理论差异；
  差别只是 API 边界：Clowder 把它做成依赖同一 Redis ledger 的 store 复合方法，
  codeteam 放在 service transaction 里。若需要 API 对齐，可加一个薄 wrapper，
  不需要改存储语义。
- Clowder 的 response 是 streaming 的 processing row → terminal；codeteam v1
  `DP-F018X-2=B` 采用同一形态：dispatch 事务创建 processing R，draft 承接 stream，
  `commitLifecycleResponseTerminal` 在 settlement 落终态。

### 3.2 QueueProcessor + QueueEntry

**拆分**
- `DispatchService.drainLoop` → `QueueProcessor.drain`；
- `DispatchService.claimNext` → QueueProcessor 内部候选选择（`listQueued` + `claim`）；
- `DispatchService` 只保留组合根/兼容 facade，内部委托 `QueueProcessor`。

**v1 依赖**

```ts
interface QueueProcessorDeps {
  queue: InvocationQueue;
  tracker: InvocationTracker;
  invocationRecords: InvocationRecordStore;
  turnExecutions: TurnExecutionStore;
  credentials: InvocationRegistry;
  router: AgentRouter;
  terminal: PerAgentTerminalDispositionCollector;
  clock: () => number;
  log: Logger;
}
```

**v1 方法**

```ts
class QueueProcessor {
  requestDrain(threadId: string): void;
  processNext(threadId: string, userId: string): Promise<ProcessNextResult>;
  drain(threadId: string, options?: DrainOptions): Promise<DrainResult>;
  processEntry(entry: QueueEntry, claimId: string): Promise<ProcessEntryResult>;
  recoverStartup(): Promise<RecoveryResult>;
  onInvocationComplete(threadId: string, agentId: string, outcome: InvocationOutcome): Promise<void>;

  isThreadBusy(threadId: string): boolean;
  isAgentBusy(threadId: string, agentId: string): boolean;
  hasQueuedForThread(threadId: string): boolean;
}
```

- 候选选择在 QueueProcessor 内完成：`InvocationQueue.listQueued` → 过滤 target busy → `InvocationQueue.claim`。
- `claimNext` 只是 QueueProcessor 的内部 helper，不是 InvocationQueue/QueueLedgerStore 的方法。

**候选选择**

```text
entries = queue.listQueued(threadId)
held = Set<string>

for entry of entries:
  startable = entry.targets.filter(target =>
    target.kind === "operator" || !tracker.isBusy(threadId, target.id)
  )
  if startable.isEmpty:
    held.add(all targetKeys(entry))
    continue
  if targetKeys(entry).intersect(held):
    continue
  claimed = queue.claim(entry.queueEntryId, { claimId, owner, ttlMs, targetKeys: startable })
  if claimed:
    return processEntry(claimed.entry, claimId)
  held.add(targetKeys(entry))
```

- 每次 drain 启动一个 entry；不同 target 的 entry 可由后续 drain 并行。
- 同一 target 的后续 entry 被 `held` 挡住，保持 per-target 顺序。

**`processEntry` 顺序**
1. 校验 claim（`claim.targetKeys` ⊆ entry pending targets）；
2. 拆分 targets：`operatorTargets` / `agentTargets`；
3. operator targets → 准备通知/可见性；`delivery.operatorNotifiedAt` 在步骤 6 同事务写，socket emit 在 commit 后；
4. agent targets → 创建/复用 parent `InvocationRecord`（`sourceRecordId` 幂等）；
5. 每个 agent target：追加 `invocation_attempts` 行（`state='queued'`，
   `attempt = 该 target 的最新 attempt + 1`，无历史则为 1，即 target attempt）
   + 创建 processing R + `TurnExecutionStore.createRunning`（core）
   + 回填 attempt 的 `turn_execution_id`/`response_message_id`/`settlement='streaming'`
   + `InvocationRegistry.create`；
6. **同一事务**：parent + attempts + processing R + TurnExecutions + credentials +
   `retireTargets(claimId, 已派发/已通知 targetKeys)`；
7. 事务外：启动 provider（pi worker）；
8. child terminal → `PerAgentTerminalDispositionCollector` → parent aggregate → credential terminalize；
9. operator-only：不创建 parent/child；通知后 retire，全部移除则删除 entry；
10. 异常/超时 `releaseClaim(claimId)`；不要把 operator-only 当失败。

**不变量**

- `retireTargets` 与 parent/attempt/R/TurnExecution/credential 同事务；provider 启动在事务外。
- queue entry 是 route anchor，不再在全部 target dispatch 后立即删除：保留到所有
  agent target 的 attempt 终态；`targets_json` 可以为空（pending targets 为空），
  但 row 仍承载 retry/terminal 关联。parent `completed`/`canceled` 后才删除；
  `partial_failed`/`failed` 保留到显式 retry 或 operator abandon。
- `partial_failed`/`failed` 保留时释放 claim、durable status 回到 `queued`、
  `targets_json=[]`；`listQueued` 过滤空 pending，不会自动 dispatch；`requestRetry`
  用 exact-entry claim 重新加入失败 target。`completed`/`canceled` 直接删除 row。
- provider 启动前失败：attempt `failed` + TurnExecution `transitionTerminal(failed)` +
  R settlement + parent aggregate + credential terminalize；target 仍在 pending 时按
  bounded backoff 追加新 attempt
  （旧 attempt 保留为 failed）；已终态失败则等待显式 `requestRetry` 追加新 attempt，
  不新建 queue entry、不重新 admission 消息。
- parent `sourceRecordId` unique；child `createRunning` 幂等；重放不会二次执行。
- operator notification 先写 durable `operatorNotifiedAt`，socket emit 在 commit 后；emit 失败不影响消息可见性。

**v1 不做**
- Clowder 的 batching、caller dispatch observations、action successor、wait continuation、cloud bridge、multi-user grouping。
- append lifecycle、Steer、continuation、live companion、freshness、auto-resume suppression、prestart processing groups。
- v1 一个 queue entry 的 targets 直接并行 dispatch；pre-handoff 失败按 bounded backoff
  自动重试仍 pending 的 target；已终态失败的 target 不自动重跑，只接受显式
  `requestRetry`。retry 不重新 admission 消息、不新建 queue entry。

### 3.3 InvocationRecordStore + InvocationRecord

**定位**：消息级生命周期 parent；由 `QueueProcessor` 在 claim 后创建。

**v1 字段**

```ts
interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
}

type InvocationRecordStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial_failed"
  | "failed"
  | "canceled";

interface InvocationRecord {
  invocationRecordId: string;
  threadId: string;
  userId: string;
  sourceRecordId: string;         // unique；一个 source 一个 parent
  userMessageId: string | null;   // v1 = payload.messageId
  targetAgentIds: string[];       // admission snapshot，不可变
  status: InvocationRecordStatus;
  successfulAgentIds: string[];   // exact success witness，单调递增
  usageByAgent: Record<string, TokenUsage>; // cumulative across attempts
  usageRecordedAt: number | null;           // first write; stable for daily bucketing
  retryCount: number;
  terminalReason: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}
```

**`InvocationRecordStore` v1**

```ts
interface CreateQueuedInput {
  invocationRecordId?: string;     // 可选；测试/重放
  threadId: string;
  userId: string;
  sourceRecordId: string;
  userMessageId: string | null;
  targetAgentIds: string[];
  now?: number;
}

type CreateQueuedResult =
  | { outcome: "created"; record: InvocationRecord }
  | { outcome: "replayed"; record: InvocationRecord }
  | { outcome: "conflict" };

interface TerminalAggregateInput {
  status: "completed" | "partial_failed" | "failed" | "canceled";
  successfulAgentIds: string[];
  terminalReason: string | null;
  // cumulative across all child attempts; omitted = keep existing
  usageByAgent?: Record<string, TokenUsage>;
  // backfill only; normal path stamps first-write time
  usageRecordedAt?: number;
  now?: number;
}

interface InvocationRecordStore {
  createQueued(input: CreateQueuedInput): CreateQueuedResult;

  get(invocationRecordId: string): InvocationRecord | null;
  getBySource(threadId: string, sourceRecordId: string): InvocationRecord | null;
  listByThread(threadId: string): InvocationRecord[];
  listBySource(threadId: string, sourceRecordIds: string[]): InvocationRecord[];
  listRunning(threadId?: string): InvocationRecord[];

  markRunning(invocationRecordId: string, now?: number): InvocationRecord | null;
  applyTerminalAggregate(
    invocationRecordId: string,
    input: TerminalAggregateInput,
  ): InvocationRecord | null;
  requestRetry(
    invocationRecordId: string,
    input?: { targetAgentIds?: string[]; now?: number },
  ): InvocationRecord | null;
}
```

**状态机**

```text
queued         → running | failed | canceled
running        → completed | partial_failed | failed | canceled
failed         → queued | canceled        // retry admitted
partial_failed → queued | canceled        // retry admitted
completed      → terminal
canceled       → terminal
```

**聚合/usage 语义**

- `successfulAgentIds` 是唯一成功见证；`failedAgentIds`/`canceledAgentIds` 由
  `invocation_attempts` 每个 target 的最新 attempt 推导，不在 parent 存储。
- `usageByAgent` 按 `agentId` 跨 attempt 累计；`applyTerminalAggregate` 接收的是**累计值**，不是 delta。
- `usageRecordedAt` 只在第一次写入 usage 时设置；之后不覆盖（backfill 显式传入除外）。
- `requestRetry` 保留 `usageByAgent`/`usageRecordedAt`；status `failed|partial_failed → queued`，
  `retryCount++`，清 `endedAt`/`terminalReason`。省略 `input.targetAgentIds` 表示所有失败/取消
  target；显式传入时必须是 `targetAgentIds - successfulAgentIds` 的子集。
- retry 不新建 queue entry、不重新 admission 消息；`InvocationAttemptStore` 为每个被重试
  target 追加 `attempt+1`，旧 attempt 不可改写。parent 在 retry child 启动后由
  `markRunning` 进入 running。`retryCount` 是显式重试波次计数，不是 target attempt。

**`markRunning` / `applyTerminalAggregate` 校验**

- `markRunning`：`queued → running`；已是 `running` 幂等返回；terminal 返回 null。
- `applyTerminalAggregate`：只接受 `running`；`successfulAgentIds ⊆ targetAgentIds` 且单调递增；`completed` 必须等于全部 targets；`partial_failed` 非空且不等于全部；`failed` 为空；`canceled` 允许任意子集。
- `terminalReason`：`completed` 为 null；其余非 null。

**operator target 边界**
- `InvocationRecord` 只在 queue entry 存在至少一个 `agent` target 时创建。
- `targetAgentIds` 只含 agent targets；operator targets 不进入 parent。
- operator-only entry 没有 parent/TurnExecution；只写 queue entry 的
  `delivery.operatorNotifiedAt`。
- mixed targets：parent 只聚合 agent targets；operator 通知记录在 queue entry。

**v1 不做**
- `intent (execute/ideate)`、`idempotencyKey`、`actionLeaseCarrier`、`waitContinuationCarrier`。
- `sourceRecordId` unique + `queue_admissions` 已足够做 admission 幂等。
- usage 按 `invocation_attempts.usage` 汇总到 `usageByAgent`；不在 parent 存 failed/canceled 列表。

### 3.4 InvocationTracker + InvocationOwnerReaper

**InvocationTracker（进程内）**

```ts
// Clowder 有 active | canceled | absent；codeteam v1 取消即释放，不产生 canceled。
type SlotState = "active" | "absent";

interface InvocationSlot {
  threadId: string;
  agentId: string;
  userId: string;
  turnExecutionId: string;
  controller: AbortController;
  startedAt: number;
}

class InvocationTracker {
  start(threadId, agentId, userId, turnExecutionId): AbortController;
  startAll(threadId, agentIds, userId, turnExecutionId): Map<string, AbortController>;
  complete(threadId, agentId, turnExecutionId?): void;
  completeAll(threadId, agentIds, turnExecutionId?): void;
  cancel(threadId, agentId, reason): boolean;
  cancelAll(threadId, reason): string[];
  has(threadId, agentId?): boolean;
  isBusy(threadId, agentId): boolean;
  getSlotState(threadId, agentId): SlotState;
  getController(threadId, agentId): AbortController | undefined;
  getExecutionId(threadId, agentId): string | undefined;
  getActiveSlots(threadId): Array<{ agentId; turnExecutionId; startedAt }>;
  listStaleSlots(now): Array<{
    threadId; agentId; userId; turnExecutionId; startedAt; ageMs;
  }>;
}
```

**语义（DP-F018T-1=B / DP-F018T-2=B）**

- 同一 `(threadId, agentId)` 一个 active slot。
- `start` 是抢占语义：同 slot 旧 controller 先发中断信号；旧 `TurnExecution` 标 `interrupted/preempted`；新 slot 立刻登记。
- 取消即释放：`cancel` 发中断信号后直接删除 slot；不保留 canceled 墓碑。
- **真正的执行互斥在 attempt binding + worker**：`invocation_attempts` 对同一
  `agent_session_id` 只允许一条 `running`；`RpcConnection.prompting` 保证进程单飞；
  旧 worker 未退出时新 start 返回 `worker_busy`，QueueProcessor 释放 claim 稍后重试。
- `startAll` all-or-nothing：任一 target 的 slot 或 worker 不可用则全部不启动。
- `complete` / `completeAll` 只释放匹配 `turnExecutionId` 的 slot（ownership fence），防止 late terminal 清掉 replacement。
- `isBusy` = slot active；取消即释放后不再有 pending teardown 状态；旧 worker 的忙由 `TurnExecution` 唯一 running + `RpcConnection.prompting` 表达。
- 进程内，不持久化；durable truth 是 `TurnExecution.status`。

**Steer / 插队原语**

- v1 提供：`cancel` + `priority:"urgent"` queue entry + `start` 抢占。
- 后续 Steer：operator 选中当前执行 → 停止 → urgent entry 插队；旧 child 标 `interrupted/preempted`。
- 普通消息默认不抢占；只有显式 Steer/停止动作走抢占路径。

**InvocationOwnerReaper（v1，DP-F018T-3=A）**

**为什么需要它（从零）**

- `TurnExecution.status` 是 durable 真相，但它不会自己从 `running` 变成 terminal；daemon 崩溃、worker 进程丢失后，没有任何代码会去写终态。
- 没有 reaper：parent 永远 `running`，credential 永远 `active`，UI 永远显示“在跑”，对应 agent 的 slot 也可能永远占着。
- reaper 是周期性的 janitor：把 `TurnExecution.listRunning()`、tracker slot、`WorkerStore` heartbeat/lease 对账。
- 只有“running 但没有任何 live worker/heartbeat”的记录才判僵尸；有 live worker 的长任务保留。
- `TurnExecutionStartupReconciler` 是开机一次性扫描；`InvocationOwnerReaper` 是运行期周期扫描；两者共用同一套 `reconcileRunningTurn`。

**一个最小时间线**

```text
1. agent A 开始执行：TurnExecution=running；tracker slot active；worker heartbeat 有效
2. daemon 崩溃：DB 仍是 running；重启后 tracker 为空；worker 已不在
3. startup reconciler 扫描：无 live worker → TurnExecution=interrupted/owner_reaped
4. parent aggregate（partial_failed/failed）；credential terminalize；slot 释放
5. operator 可 retry：同一 parent/queue entry 追加 attempt+1 → 新 child；旧 attempt 保留
```

**注意**：被抢占但旧 worker 还活着的 child 不算僵尸；它保留到旧 worker 结束。`TurnExecution` 唯一 running + worker binding generation 负责防止新旧叠跑。

```ts
interface InvocationOwnerReaperDeps {
  tracker: InvocationTracker;
  turnExecutions: TurnExecutionStore;
  invocationRecords: InvocationRecordStore;
  credentials: InvocationRegistry;
  workers: WorkerStore;
  clock: () => number;
  log: Logger;
}

class InvocationOwnerReaper {
  runOnce(): Promise<ReaperResult>;
}
```

清理顺序：

1. `TurnExecution.listRunning()` + tracker stale slots。
2. child 已 terminal / 不存在 → 释放 tracker slot。
3. child running + 该 `(agentId, agentSessionId)` 有 live worker/heartbeat/未过期 lease → 保留。
4. child running + 无 live worker → `interrupted/owner_reaped`；credential terminalize；parent aggregate；释放 slot。
5. worker 状态读不到 → defer，不误判。

- 被抢占但旧 worker 还活着的 child：保留，等旧 worker 结束；`TurnExecution` 唯一 running + worker binding generation 防止新旧叠跑。
- 旧 worker 结束后 heartbeat/lease 过期；下一轮 reaper 再标 `interrupted/owner_reaped`。
- 如果旧 worker 永久挂住且 heartbeat 一直有效，不清理；这是 DP-F018T-3=A 的接受代价。
- `recoverStartup()` 做一次性扫描：tracker 为空时按同一 worker heartbeat 规则收敛。

### 3.5 AgentRouter + runAgentTurn + routeAgents

**全链路**

```text
OperatorMessageIngress
  ├─ parseOperatorMentions(body)
  ├─ resolveExplicitTargets / resolveImplicitTargets
  └─ transaction: StoredMessage.targetAgentIds + invocation_queue(targets, attempt=1)

QueueProcessor
  ├─ claim queue entry
  ├─ create InvocationRecord(parent)
  ├─ InvocationTracker.startAll(...)
  └─ AgentRouter.routeAgents(mode)

AgentRouter
  ├─ resolveTargets(...)
  └─ routeAgents(mode)
       ├─ parallel: mergeStreams(targets.map(runAgentTurn))
       └─ serial:   for target: runAgentTurn(target, priorResponses)

runAgentTurn
  1. resolve AgentConfig
  2. ensure AgentSession（active-only）
  3. attempt(queued) + TurnExecution.createRunning（同 session 唯一 running）
  4. bind attempt（session/worker/provider/model/R/settlement=streaming）
  5. workerPool.ensure（ephemeral；spawn ~0.5s）
  6. InvocationCredential.create
  7. build context + prompt
  8. invoke pi worker；stream → response_drafts；usage → attempt
  9. transitionTerminal + attempt terminal/settlement=response_pending + collector +
     parent aggregate + credential terminalize
 10. settle R + attempt settled + retire worker（warmTtl=0）/ release tracker slot
```

**定位与边界**

| 组件 | 拥有 | 不拥有 |
|---|---|---|
| OperatorMessageIngress | 行首 @ 解析、隐式路由、`StoredMessage.targetAgentIds`、message+queue 事务 | child/execution |
| AgentRouter | target 校验、parallel/serial 调度、per-target signal | prompt/session/response/terminal |
| routeParallel | 并行 merge、单 target 错误隔离 | 写 response、parent aggregate |
| routeSerial | 顺序循环、priorResponses | 单体 per-agent 逻辑 |
| runAgentTurn | session/prompt/invoke/response/terminal/usage | 队列 claim、parent 创建、tracker 占用 |
| QueueProcessor | claim、parent、tracker、collector 调用 | @ 解析、per-agent prompt |

**接口**

```ts
type RoutingReason =
  | "current_message_mentions"
  | "previous_user_mentions"
  | "recent_replier"
  | "thread_participant"
  | "default_agent";

interface RouteInput {
  threadId: string;
  userId: string;
  sourceMessageId: string;
  content: string;
  targetAgentIds: string[];
  signalForAgent: (agentId: string) => AbortSignal | undefined;
}

interface AgentTurnInput extends RouteInput {
  agentId: string;
  signal: AbortSignal | undefined;
  priorResponses?: Array<{ agentId: string; content: string }>;
}

type AgentStreamEvent =
  | { type: "text"; agentId: string; turnExecutionId: string; content: string; timestamp: number }
  | { type: "thinking"; agentId: string; turnExecutionId: string; content: string; timestamp: number }
  | { type: "tool_call"; agentId: string; turnExecutionId: string; name: string; args: unknown; timestamp: number }
  | { type: "tool_result"; agentId: string; turnExecutionId: string; name: string; result: unknown; timestamp: number }
  | { type: "error"; agentId: string; turnExecutionId: string; error: string; timestamp: number }
  | { type: "done"; agentId: string; turnExecutionId: string; timestamp: number };

interface AgentTurnResult {
  agentId: string;
  turnExecutionId: string;
  responseMessageId: string;
  responseText: string;
  status: "completed" | "failed" | "interrupted" | "canceled";
  usage: TokenUsage | null;
}

class AgentRouter {
  resolveTargets(input: {
    threadId: string;
    body: string;
    explicitHandles?: string[];
  }): Promise<{ targetAgentIds: string[]; reason: RoutingReason }>;

  routeAgents(input: RouteInput, mode: "parallel" | "serial"): AsyncIterable<AgentStreamEvent>;
}

async function* runAgentTurn(
  input: AgentTurnInput,
): AsyncGenerator<AgentStreamEvent, AgentTurnResult>;
```

**route-parallel 形态**

```ts
async function* routeParallel(input: RouteInput): AsyncIterable<AgentStreamEvent> {
  const streams = input.targetAgentIds.map((agentId) =>
    runAgentTurn({
      ...input,
      agentId,
      signal: input.signalForAgent(agentId),
    }),
  );
  yield* mergeStreams(streams, {
    signalForIndex: (i) => input.signalForAgent(input.targetAgentIds[i]),
    valueForAbort: (i) => ({ type: "done", agentId: input.targetAgentIds[i] }),
  });
}
```

- 每个 target 一个独立 `runAgentTurn`；
- 单 target 失败/中断不波及兄弟；
- 流错误合成 `error + done`；
- 不写 response、不做 parent aggregate。

**route-serial 形态**

```ts
async function* routeSerial(input: RouteInput): AsyncIterable<AgentStreamEvent> {
  const priorResponses: Array<{ agentId: string; content: string }> = [];
  for (const agentId of input.targetAgentIds) {
    const result = yield* runAgentTurn({
      ...input,
      agentId,
      priorResponses,
      signal: input.signalForAgent(agentId),
    });
    priorResponses.push({ agentId, content: result.responseText });
  }
}
```

- 顺序执行同一个 `runAgentTurn`；
- 后一个 agent 能看到前一个 agent 的 response；
- v1 保留薄循环，不默认启用；
- 不是 Clowder 的 4334 行单体。

**`runAgentTurn` 顺序**

1. resolve AgentConfig（存在/enabled/provider/model）；
2. ensure AgentSession（active-only）；
3. 读取/派生可重放的 `turnExecutionId`；
4. 同一 dispatch 事务创建 attempt(queued) + processing R（`invocationId=turnExecutionId`）；
5. `TurnExecutionStore.createRunning`（core；幂等；同 session 唯一 running）；
6. 回填 attempt `turn_execution_id`/`response_message_id`/`settlement='streaming'`；
7. `workerPool.ensure`（ephemeral；spawn ~0.5s；pi v1 一 worker 一 session）；
8. `InvocationRegistry.create`（credential）；
9. build context（thread/participants/recent messages/priorResponses；delivery cursor 见 §3.5.1）+ build prompt（system + history + context）；
10. invoke pi worker（stream events）；deltas/tool events 写 `response_drafts`；
11. `transitionTerminal` + attempt terminal + attempt `settlement='response_pending'`
    + collector + parent aggregate + credential terminalize（same transaction）；
12. `settleResponseFromDraft`：R terminal + attempt `settled` + settle input
    dispatchRefs + delete draft + clear pending；
13. retire worker（warmTtl=0）+ release tracker slot。

**`routeAgents` 模式选择**

- v1 默认 `parallel`；
- `serial` 是同一个 `runAgentTurn` 的薄循环，保留接口但不默认启用；
- route 不做 prompt/context/session/response；这些全部在 `runAgentTurn`。

**routeSerial 责任拆解**

| routeSerial 内容 | 去处 |
|---|---|
| session/prompt/context/invoke/response/terminal | `runAgentTurn` |
| serial order / priorResponses | `routeAgents(mode="serial")` |
| guide/concierge/memory/SOP/entity nudge | `runAgentTurn` feature hooks；v1 不挂 |
| 静态 worklist 不 push 新 target | 保留：A2A hop 是新 queue entry |

**v1 启用状态**

- `parallel` 默认启用；
- `serial` 保留薄循环，不默认启用；
- guide/concierge/memory/SOP/entity nudge 只保留 hook 位，v1 不挂实现。

**v1 不做**

- `routeSerial` 单体实现、intent-derived serial/parallel、per-cat prompt prep 的复制分支。
- batching、`seenCursor` / `mentionAck` / unread badge、collective/custody；
  `deliveryCursor` 在 v1 做（§3.5.1）。

### 3.5.1 History assembly + delivery cursor

**问题**：同一 thread 的不同 agent 从哪个位置加载历史？不能共用“thread 最后一条”，
也不能为每个 target 单独维护 cursor。

**存储**

```ts
interface AgentReadState {
  threadId: string;
  agentId: string;
  deliveryCursor: number;   // 已消费到的 thread-global messages.seq
  updatedAt: number;
}
```

- key = `(threadId, agentId)`；与 AgentSession 分开：session 是执行身份，
  read state 是投递进度。
- `messages.seq` 是 thread-global visibility order，不是 per-target 顺序。
- v1 只做 `deliveryCursor`；`seenCursor` / `mentionAck` / unread badge 是 v2。
- 存储接口 `AgentReadStateStore`：`get(threadId, agentId)` /
  `ack(threadId, agentId, seq)` / `rewind(threadId, agentId, seq)`；`rewind` 只给
  session fresh/reset 用。

**加载**

```text
bootstrap（没有 read state）:
  rows = messages.getByThread(threadId, BOOTSTRAP_WINDOW)   // 最近 N 条，默认 200
  boundary = rows 中最大的 seq（thread tail）
  agentReadState.ack(threadId, agentId, boundary)

normal:
  cursor = agentReadState.deliveryCursor ?? 0
  rows = messages.getByThreadAfter(threadId, cursor, BOOTSTRAP_WINDOW)
  filter:
    - response message → broadcast；默认排除自己刚写的 response
    - input message 有 targetAgentIds → 仅包含本 agent 的
    - 否则 input lifecycle.dispatchRefs 有 agent targets → 仅这些 agent
    - 都没有 → broadcast/system
  build prompt from rows（token budget 内）
  boundary = rows 中最后一条的 seq
  agentReadState.ack(threadId, agentId, boundary)  // 单调前进
```

- **processing R 不推进 cursor 越过它**：boundary 只能取 earliest processing response 的前一条；
  否则并行的另一个 agent 可能只看到空 processing R，错过最终 terminal response。
- terminal R 正常 ack；`response_drafts` 不是 history，不单独进入 prompt。

- **cursor 是全局可见序，不是“发给这个 agent 的最后一条”**：A 的 cursor 会越过对 A
  不可见的定向消息；B 仍会在自己的 cursor 位置看到它。不需要 per-target cursor。
- codeteam v1 **没有单独的 `visibilitySeq`**：`messages.seq` 同时承担 thread-global
  order 和 visibility coordinate；`AgentReadState.deliveryCursor` 指向 `seq`。
  Clowder 的 visibility cursor 是 `v2:<seq>:<messageId>`，因为它有 whisper/queued
  visibility；codeteam v1 没有这些 gating，`seq` 就是可见序。
- `MessageStore.getByThreadAfter` / `getByThread` 返回的是 **`StoredMessage[]`**；cursor 组装的是
  “thread 内从 cursor 之后的多条 StoredMessage 窗口”，不是单条消息的 content，
  也不是把整个 thread 塞进一条 Message。
- MessageStore 读面只需要两个方法：`getByThread(threadId, limit)` 和
  `getByThreadAfter(threadId, afterSeq, limit)`，都按 `seq` 升序返回。
- 先 fetch after cursor，再按上面的可见性规则过滤；被过滤掉的 message 也让 cursor
  前进，避免下次重复拉取。
- 同一 thread 的 A/B 各自一个 cursor；A 看到 msg1/msg3、B 看到 msg1/msg2/msg3 是正常的。
- `boundary` 取**已消费**的最后 seq，而不是“进入 prompt 的最后一条”；token trim 不阻塞
  cursor 前进。
- normal 路径一次最多消费 `BOOTSTRAP_WINDOW` 条；待处理超过窗口时 cursor 只推进到本批末尾，
  下一轮继续，不跳消息。
- 新 agent 第一次执行走 bootstrap：只回放最近 `BOOTSTRAP_WINDOW` 条，更早历史不自动全量回放。
- session fresh / reset：显式把该 agent 的 `deliveryCursor` rewind 到
  `max(0, tailSeq - BOOTSTRAP_WINDOW)`，让新 pi session 拿到最近上下文；rewind 只能通过
  reset API 发生，普通 ack 不允许回退。
- 并发：`ack` 必须单调 CAS（`max(delivery_cursor, ?)`）；回退只允许显式 rewind。
- v1 不做 `coveredMessageIds`、same-route isolation、`appendAcceptance` 驱动的投递边界；
  这些是 v2 的审计/多 agent 精细投递能力。

### 3.5.2 WorkerPool + WorkerBinding（ephemeral）

**定位**：worker 是每次 turn 的执行载体，不是 session 的常驻所有者。Session 的连续性由
`AgentSession.piSessionFile` 保证；worker 退出不影响 session identity。

**表**

```sql
CREATE TABLE workers (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting','online','draining','stale','retired')),
  capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity = 1),
  pid INTEGER,
  heartbeat_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  idle_since INTEGER,
  retired_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (state <> 'retired' OR retired_at IS NOT NULL)
) STRICT;

CREATE TABLE worker_bindings (
  agent_session_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('attached','idle','reattach_pending')),
  bound_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
) STRICT;
```

- `agent_session_id` 主键：一个 session 同时只绑一个 worker。
- `worker_id UNIQUE`：pi v1 一个 worker 同时只服务一个 session；未来 pi 支持
  `session/new` / `session/load` 时再放开。
- `capacity=1` 是 pi v1 的诚实约束；不做 multiplexing。
- session 不再有 `worker_id` / `worker_binding_state`。

**接口**

```ts
interface WorkerPool {
  ensure(input: {
    poolKey: { projectPath; accountRef; provider; model };
    session: AgentSession;
  }): Promise<WorkerHandle>;

  release(handle: WorkerHandle, reason: string): Promise<void>; // warmTtl=0 → retire
  revokeSession(agentSessionId: string, reason: string): Promise<void>;
  heartbeat(workerId: string, pid?: number | null): Promise<void>;
  reapExpired(now: number): Promise<ReapResult>;
  snapshot(): WorkerSnapshot[];
}
```

**生命周期**

```text
ensure:
  1. 有 binding 且 worker live + poolKey 匹配 → 复用
  2. 无 binding / worker dead / poolKey 不匹配 → spawn
     - piSessionFile 存在则 --session，否则 --session-id
     - spawn 到 online；写 worker_bindings(state=attached)
  3. live workers >= maxLiveWorkers(8) → 先驱逐 idle；否则 worker_capacity

release（v1 默认 warmTtl=0）:
  RpcConnection.finish → worker retire → 删 binding

reapExpired:
  - heartbeat/lease 过期 → stale；binding reattach_pending；
    running TurnExecution → interrupted/owner_reaped
  - idle_since + warmTtl < now → retire + 删 binding

配置变化:
  project/account/provider/model 任一变化 → 旧 worker retire，新 worker spawn
```

**执行互斥**

- `invocation_attempts` 唯一 running per session：
  `CREATE UNIQUE INDEX invocation_attempts_one_running_per_session ON invocation_attempts(agent_session_id) WHERE state = 'running' AND agent_session_id IS NOT NULL;`
- `RpcConnection.prompting` 进程级单飞。
- `worker_bindings.generation`：旧 release 在 generation 变化后 no-op。
- 不建 per-turn `worker_leases` 表。

**spawn 预算**：本地实测 RPC 启动到首个 `get_state` 约 475ms；带 worker-extension +
session resume 约 0.49–0.53s（1–10MB session）。5min turn 下约 0.17%，不作为常驻理由。

### 3.6 invoke-single-agent + TurnExecutionStore + TurnExecutionRecord

**`createRunning` 是什么**
- 在 provider 启动前，把“这次 child 执行”持久化；
- 幂等：同一个 `turnExecutionId` 重复 create 不会执行两次；
- 结果 `created | replayed | conflict`：
  - `created`：新建，获得执行权；
  - `replayed`：已有同 id/同身份记录，不再授予 provider lease；
  - `conflict`：同 id 但身份不同，fail closed。

**v1 `TurnExecution`（Clowder core，DP-F018TE-1=A）**

```ts
type TurnExecutionKind = "ordinary" | "routing_guard";
type TurnExecutionStatus = "running" | "completed" | "failed" | "interrupted" | "canceled";
type TurnExecutionTerminalStatus = Exclude<TurnExecutionStatus, "running">;

interface TurnExecutionCausalRefs {
  triggerMessageId: string;
  a2aParentTurnExecutionId?: string;
  a2aTriggerMessageId?: string;
  a2aDepth?: number;
  routingGuardReason?: "missing_routing_exit";
}

interface CreateTurnExecutionInput {
  turnExecutionId: string;       // Clowder invocationId
  invocationRecordId: string;    // Clowder parentInvocationId
  threadId: string;
  userId: string;                // scope snapshot；必须等于 parent/thread owner
  agentId: string;               // Clowder catId
  executionKind: TurnExecutionKind;
  causal: TurnExecutionCausalRefs;
  startedAt: number;
}

interface TurnExecution extends CreateTurnExecutionInput {
  status: TurnExecutionStatus;
  terminalReason: string | null;
  endedAt: number | null;
}

interface TurnExecutionTerminalInput {
  status: TurnExecutionTerminalStatus;
  endedAt: number;
  terminalReason?: string | null;
}

interface InterruptRunningTurnExecutionsInput {
  endedAt: number;
  terminalReason: string;
  excludedTurnExecutionIds?: readonly string[];
}

type CreateTurnExecutionOutcome = "created" | "replayed" | "conflict";
interface CreateTurnExecutionResult {
  outcome: CreateTurnExecutionOutcome;
  record: TurnExecution;
}

type TransitionTurnExecutionOutcome = "transitioned" | "already_terminal" | "not_found";
interface TransitionTurnExecutionResult {
  outcome: TransitionTurnExecutionOutcome;
  record: TurnExecution | null;
}

type ClearResponsePendingOutcome =
  | "settled"
  | "already_settled"
  | "not_pending"
  | "not_found";
interface ClearResponsePendingResult {
  outcome: ClearResponsePendingOutcome;
  record: TurnExecution | null;
}
```

- `TurnExecution` 只保留 Clowder `TurnExecutionRecord` 的 core；session/worker/
  provider/model/usage/queueEntryId/attempt/settlement/responseMessageId 全部在
  `invocation_attempts`（§3.9 / §4.3.1）。
- `userId` 是 **scope snapshot**，不是第二身份：创建时必须等于
  `InvocationRecord.userId` 和 `Thread.created_by`；不一致 fail closed。v1 单 user
  仍保留该字段，避免 recovery/security 退化为跨 user 查询；未来 multi-user 直接可用。
  完整矩阵见 `0011-identity-contract.md` §11。
- `routing_guard` 没有 attempt/R；它只有 core TurnExecution，status/routing reason 在
  `causal`。

**`TurnExecutionStore` v1**

```ts
interface TurnExecutionStore {
  createRunning(input: CreateTurnExecutionInput): CreateTurnExecutionResult;

  transitionTerminal(
    turnExecutionId: string,
    input: TurnExecutionTerminalInput,
  ): TransitionTurnExecutionResult;

  interruptRunningBefore(
    cutoffStartedAt: number,
    input: InterruptRunningTurnExecutionsInput,
  ): TurnExecution[];

  get(turnExecutionId: string): TurnExecution | null;
  listByInvocationRecord(invocationRecordId: string): TurnExecution[];
  listRunning(): TurnExecution[];

  /** Join over invocation_attempts.settlement='response_pending'. */
  listResponsePending(): TurnExecution[];
  /** Update the attempt settlement for this child to 'settled'. */
  clearResponsePending(turnExecutionId: string): ClearResponsePendingResult;
}
```

- 唯一约束：`turnExecutionId`；`invocation_attempts.turn_execution_id` 非空时唯一。
- `TurnExecutionTerminalInput.status` 只能是 terminal status；`endedAt >= startedAt`；
  非 `completed` 必须有 `terminalReason`。
- `interruptRunningBefore` 只匹配 `status='running' AND startedAt < cutoffStartedAt`；
  `excludedTurnExecutionIds` 不收敛；返回被收敛记录；attempt/credential 由调用方在同一
  恢复流程处理。
- `get` / `listByInvocationRecord` / `listRunning` 只读；`listByInvocationRecord` 对应
  Clowder `listByParent`；`listRunning` 是 v1 单 user 的 `listRunningByUser` 等价。
- `listResponsePending` / `clearResponsePending` 是 `invocation_attempts.settlement` 的
  投影；不直接改 attempt 的 execution state。
- ordinary `createRunning` input：`turnExecutionId + invocationRecordId + threadId +
  userId + agentId + executionKind + causal`；`routing_guard` 同，但没有 attempt/R。
- **`createRunning` identity（DP-F018X-1=A）** = `turnExecutionId + invocationRecordId +
  threadId + userId + agentId + executionKind + causal`。身份相同即 `replayed`，
  身份不同即 `conflict`；`startedAt` 只做 metadata，不进 identity。
- `causal` 参与 identity 时必须 canonical JSON（key 排序/稳定序列化）；否则同内容不同
  key 顺序会误判 `conflict`。
- **`turnExecutionId` 必须可重放**：从 `(invocationRecordId, agentId, attempt)`
  确定性派生，或提前持久化在 `invocation_attempts.turn_execution_id`；不能每次 crash
  后重新生成随机 id，否则永远不会命中 `replayed`。
- ordinary `createRunning` 前先创建 attempt 行和 processing R；attempt 行绑定
  `turn_execution_id`/`response_message_id`。`routing_guard` 不建 attempt/R。
- `replayed` 时 `invoke-single-agent` 不启动 provider；必须复用 attempt 行的
  `responseMessageId`/draft，不得为同一 attempt 再建 R。
- `transitionTerminal` 只允许一次；status 为 `failed/interrupted/canceled` 时必须有
  `terminalReason`。attempt terminal 与 TurnExecution terminal 同事务；R settlement
  由 attempt 的 `settlement` 字段单独推进。
- v1 不做 `causal.coveredMessageIds`、`outputFence`、`queueCompletionPolicy`；
  `listBySource`/`settleOutputFence` 也留 v2。

**Response settlement（DP-F018X-2=B）**

v1 采用 durable streaming：processing response R 在 attempt 启动时创建；stream 写
`response_drafts`；child terminal 与 R terminal 分开提交，用 `response_pending` 账本
保证崩溃后可恢复。

```text
attempt start（dispatch transaction）:
  create attempt(queued)                         // per-target attempt ledger
  append R: lifecycle.kind='response', status='processing',
            invocationId=turnExecutionId
  create TurnExecution(core)
  bind attempt.turn_execution_id = turnExecutionId
       attempt.response_message_id = R.id
       attempt.settlement = 'streaming'
  → credential + retireTargets                   // same transaction
stream:
  message_update.text_delta / tool events → response_drafts(turnExecutionId)
  （bounded flush，如 100ms/4KB；同时发 ephemeral AgentStreamEvent 给 UI）
child terminal（same transaction）:
  TurnExecution.transitionTerminal(status, endedAt, terminalReason)
  attempt.state = terminal
  attempt.settlement = 'response_pending'
  → parent aggregate + credential terminalize
response settlement（通常紧接着；崩溃后由 reconciler 重放）:
  settleResponseFromDraft(turnExecutionId):
    load attempt by turn_execution_id；load R by attempt.response_message_id
    if R.status='processing' → commitLifecycleResponseTerminal(R, draft body, child terminal state)
    settleLifecycleResponseInputs(R) / advanceLifecycleInputDispatch(settled)
    delete draft
    attempt.settlement = 'settled'
    clearResponsePending(turnExecutionId)        // projection over attempts
```

- `response_message_id` 在 attempt start 就写入 processing R；`response_pending` 时也非 null。
- attempt `settlement` 四态：`NULL`（queued，尚无 R）、`streaming`（R 还在生成）、
  `response_pending`（child terminal，R 未 terminal）、`settled`（R terminal 且 inputs settled）。
- `listResponsePending()` 是恢复入口；`TurnExecutionStartupReconciler` 重启后扫描 pending，
  调用 `settleResponseFromDraft`；R 已 terminal 则只清 pending，R 不存在则按
  `response_missing` 失败并写 `delivery_failure`。
- parent aggregate 和 credential terminalize 在 child terminal 事务完成，不等待 R terminal；
  `response_pending` 的 child 已经是 terminal，参与聚合。
- `routing_guard` 没有 attempt/R；它只有 core TurnExecution。
- 与 Clowder 的差异只在存储：Clowder 用 message idempotency key + Redis responsePending set
  跨 store 定位 R；codeteam 单 SQLite 用 `invocation_attempts.response_message_id` 定位 R，
  语义相同，少一层幂等键查找。

**`invoke-single-agent` 顺序**
1. 从 AgentConfig/AccountConfig 解析 provider/model/modelFamily；
2. ensure `AgentSession`（active-only）+ worker；
3. 读取/派生可重放的 `turnExecutionId`（`invocation_attempts` 已有则复用）；
4. 同一 dispatch 事务创建 attempt(queued) + processing R（`invocationId=turnExecutionId`）；
5. `TurnExecutionStore.createRunning`（core）；
6. 回填 attempt `turn_execution_id`/`response_message_id`/`settlement='streaming'`；
7. `InvocationRegistry.create`（credential，绑 child id）——codeteam 因 FK 先 child 后 auth；Clowder 是 auth-first，但“两者都在 provider 之前”不变；
8. provider/prompt/stream；deltas/tool events 写 `response_drafts`；
9. child terminal：TurnExecution terminal + attempt terminal + attempt
   `settlement='response_pending'` + parent aggregate + credential terminalize；
10. `settleResponseFromDraft`：commit R terminal + settle input dispatchRefs +
    delete draft + attempt `settled` + clear pending。

若 dispatch 事务内任一步失败：整个事务回滚，不启动 provider；写 `delivery_failure`
system message（prestart 失败）。若 provider 启动后失败：child/attempt failed；
R 由 settlement 提交为 failed/interrupted，不另写 `delivery_failure`。

### 3.6.1 Durable response stream（v1，DP-F018X-2=B）

**问题**：模型跑 2min 期间，用户需要实时看到输出；刷新/重连/崩溃后，也不能只剩空泡或
半截不可恢复的消息。

**pi RPC 已有事件**：`message_start` / `message_update`（含 `text_delta`）/
`message_end` / `tool_execution_start` / `tool_execution_end` / `agent_settled`。
codeteam 当前 `WorkerEventSink` 只处理 `message_end` 和 tool 事件，**忽略了
`message_update`**；这是要补的。

**v1 设计：processing response R + response_drafts + responsePending**

```ts
type AgentStreamEvent =
  | { type: "start"; turnExecutionId: string; agentId: string }
  | { type: "text_delta"; turnExecutionId: string; delta: string }
  | { type: "tool_call_start"; turnExecutionId: string; toolName: string; toolId: string }
  | { type: "tool_call_end"; turnExecutionId: string; toolId: string; status: "ok" | "error" | "unknown" }
  | { type: "complete"; turnExecutionId: string; responseMessageId: string }
  | { type: "error"; turnExecutionId: string; code: string; message: string };
```

- attempt start：同 dispatch 事务创建 attempt + processing R（`lifecycle.kind='response'`,
  `status='processing'`, `invocationId=turnExecutionId`），并把
  `attempt.response_message_id=R.id`、`attempt.settlement='streaming'`。
- processing R 是 `messages` 行；history assembly/read model 必须按 `lifecycle.status`
  区分 processing 与 terminal，不能把 processing R 当 completed response。
- stream：
  - `WorkerEventSink` 处理 `message_update.text_delta` → 追加到
    `response_drafts(turnExecutionId)`；
  - tool start/end → 追加 tool event 到 draft；
  - bounded flush（如 100ms / 4KB）；同时发 ephemeral `AgentStreamEvent` 给 UI 做即时反馈；
  - **每个 delta 不写 messages/run_events**；draft 是唯一 in-flight body。
- `message_end`：用最终 text/tool events 覆盖 draft，避免 delta 重复。
- `agent_settled`：触发 terminal；child terminal 事务把 TurnExecution 标 terminal、
  attempt.state 标 terminal、attempt.settlement 标 `response_pending`。
- settlement：`commitLifecycleResponseTerminal(R, draft body, child terminal state)` →
  settle input dispatchRefs → delete draft → `attempt.settlement='settled'` →
  clear pending。`extra.rich` 在 settlement 由最终 text/contentBlocks 生成
  （Clowder `extractRichFromText`），draft 不存 rich。
- UI：processing R + draft 渲染为 processing bubble；刷新/重连从 R + draft 恢复；
  terminal 后 draft 删除，R 变为持久终态消息。
- crash：`responsePending` + draft 保留；startup reconciler 调
  `settleResponseFromDraft`。R 已 terminal 则只清 pending；R processing 则按 child
  terminal 状态提交；R 不存在则 `response_missing` + `delivery_failure`。
- failed/interrupted/canceled：R 也走 terminal settlement，正文带已 stream 的部分 +
  explanation；不再产生第二条 `delivery_failure`（prestart 未创建 R 除外）。

**为什么不是每 delta 写 messages**

- 避免 message 行爆炸和 `seq` 污染；draft 是 bounded in-flight state。
- 终态只有一条 R，`contentBlocks`/`toolEvents`/`rich` 都是最终值。
- 代价是 `response_drafts` 表 + settlement 服务；v1 接受，换来刷新/重连/崩溃恢复。

**与 Clowder F117 KD-21 的对应**

- Clowder：processing R + `DraftStore` + `responsePending` ledger +
  `response-draft-settlement.ts`。
- codeteam：processing R + `response_drafts` + `invocation_attempts.settlement` +
  `settleResponseFromDraft`。
- 差异：Clowder 用 message idempotency key 跨 store；codeteam 用
  `attempt.response_message_id` FK；Clowder 有 `outputFence`/`appendAcceptance`，
  codeteam v1 不做。

### 3.6.2 与 Clowder TurnExecution / TurnExecutionStore 对照

**结论先行**：codeteam 的 core 与 Clowder 基本 1:1。“差异大”的原因不是 core 语义
不同，而是 execution binding、retry trace、response settlement 曾全部塞进
`TurnExecution`。`DP-F018TE-1=A` 已把这些 extension 移到 `invocation_attempts`，
`TurnExecution` 现在是 Clowder 的薄记录。

**字段对照**

| Clowder `TurnExecutionRecord` | codeteam `TurnExecution` | 分类 |
|---|---|---|
| `invocationId` | `turnExecutionId` | 命名 |
| `parentInvocationId` | `invocationRecordId` | 命名 |
| `threadId` / `userId` | 同 | 1:1 |
| `catId` | `agentId` | 命名 |
| `executionKind` | 同 | 1:1 |
| `startedAt` | 同 | 1:1；但不进 codeteam identity（DP-F018X-1=A） |
| `causal.triggerMessageId` | `causal.triggerMessageId` | 已对齐 |
| `status` / `endedAt` / `terminalReason` | 同；`succeeded` → `completed` | 命名 |
| `causal.coveredMessageIds` | 无 | v2（`coveredMessageIds`） |
| `outputFence` / `queueCompletionPolicy` | 无 | v2（action fence / carrier 审计） |
| — | `agentSessionId` / `workerId` | 已移到 `invocation_attempts` |
| — | `provider` / `model` / `modelFamily` / `usage` | 已移到 `invocation_attempts` |
| — | `queueEntryId` / `attempt` | 已在 `invocation_attempts`；已从 TurnExecution 删除 |
| — | `a2aParentTurnExecutionId` / `a2aTriggerMessageId` / `a2aDepth` | 已收进 `TurnExecution.causal` |
| — | `settlement` / `responseMessageId` | 已移到 `invocation_attempts` |

**方法对照**

| Clowder `ITurnExecutionStore` | codeteam `TurnExecutionStore` | 处置 |
|---|---|---|
| `createRunning` | 同 | 保留；identity 不含 `startedAt`（有意） |
| `transitionTerminal` | 同 | 保留 |
| `get` | 同 | 保留 |
| `listByParent` | `listByInvocationRecord` | 命名；保留 codeteam 名或加 alias |
| `listRunningByUser` | `listRunning` | v1 单 user；`listRunning` 是等价简化 |
| `interruptRunningBefore` | 同 | 已补；startup reconciler 直接使用 |
| `listResponsePending` | 同 | 保留；实现为 `invocation_attempts` join 投影 |
| `clearResponsePending` | 同 | 已改名对齐 |
| `bindCoveredMessageIds` | 无 | v2（`coveredMessageIds`） |
| `listBySource` | 无 | v2（recovery/trace 不在 v1 主路径） |
| `settleOutputFence` | 无 | v2（action fence） |

**差异分类**

1. **命名/状态词**：`invocationId`/`parentInvocationId`/`catId`/`succeeded` 改名；
   无行为差异。
2. **存储表示**：Clowder Redis + Lua CAS、`responsePending` set、R 用 message
   idempotency key 定位；codeteam SQLite 唯一约束/事务、attempt `settlement` 列、
   `attempt.response_message_id` FK。语义等价，属于 runtime 适配。
3. **Additive extension**：session/worker/provider/model/usage/queueEntryId/attempt/
   settlement/responseMessageId。它们现在都在 `invocation_attempts`，不在
   `TurnExecutionRecord`。
4. **v1 scope**：`coveredMessageIds`、`outputFence`、`settleOutputFence`、
   `listBySource`、`queueCompletionPolicy` 留 v2。
5. **已去掉的重复**：`queueEntryId`/`attempt`、`usage`、`settlement`/
   `responseMessageId` 都归 `invocation_attempts`，TurnExecution 不再承担。

**DP-F018TE-1=A 已拍板（2026-11-10）**

- `TurnExecution` = Clowder core + `causal`。
- `invocation_attempts` = per-target execution binding + response settlement。
- `TurnExecutionStore` 补 `interruptRunningBefore`；`completeResponseSettlement` 改名
  `clearResponsePending`；`listResponsePending` 投影 attempt settlement。
- `coveredMessageIds` / `outputFence` / `listBySource` / `settleOutputFence` 留 v2。

### 3.7 InvocationRegistry + InvocationCredential（MCP → pi extension）

**定位**：`InvocationRegistry` 是 service；`InvocationCredential` 是存储记录。鉴权对象从 MCP callback 改为 pi extension tools。

**v1 `InvocationCredential`**

```ts
interface InvocationCredential {
  credentialId: string;
  turnExecutionId: string;       // child TurnExecution
  threadId: string;
  agentId: string;
  agentSessionId: string;
  userId: string;
  allowedTools: string[];        // post_message / cross_post_message / thread_context
  state: "active" | "terminal";
  disposition: "completed" | "failed" | "interrupted" | "canceled" | "revoked" | null;
  lastRefreshAt: number;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}
```

**Registry v1**
- `create(userId, threadId, agentId, sessionId, turnExecutionId, allowedTools)`；
- `verify(turnExecutionId, token)`：token hash+salt、state active、未过期、child running、parent status ∈ `queued | running`、tool allowed。
- `commitTerminal(turnExecutionId, disposition)`；
- `repairFromCanonical(turnExecutionId)`：child 已 terminal/不存在但 credential active → terminalize/revoke。

**v1 不做**
- `clientMessageIds`、`expectedCompactionCarrier`、managed/collective grants、MCP callback token、task/role/profile/run 字段。

### 3.8 a2a/tools（pi extension tools）+ InvocationQueue.enqueue

**v1 工具面**
- `post_message`
- `cross_post_message`
- `thread_context`（只读，不入队）

**targets schema**

```ts
targets: Array<
  | { kind: "agent"; id: string }
  | { kind: "operator"; id: string }
>
```

- 不解析正文行首 `@`；tool body 的 `@` 只是内容。
- 至少一个 target；agent target 必须存在且 enabled；operator target 必须是 thread owner。
- 允许 operator-only：只通知，不执行 agent。
- `multi_mention` targets 仅 agent（2-3 个），不做聚合回调。

**`post_message` / `cross_post_message` 流程**
1. 校验 caller credential + target/thread access；
2. 创建 message；
3. `InvocationQueue.enqueue`（sourceRecordId、messageId、originRecordId、attempt、content、targets、requestedTargets、requestId、priority）；
4. QueueProcessor claim 后拆分 targets：
   - operator → 通知/可见性，写 `delivery.operatorNotifiedAt`；
   - agent → 创建 parent `InvocationRecord` + child `TurnExecution`；
5. 若有 agent targets：child `causal = { triggerMessageId: 新 message,
   a2aParentTurnExecutionId: caller.turnExecutionId, a2aTriggerMessageId: 新 message,
   a2aDepth: caller.causal.a2aDepth + 1 }`；
6. operator-only：不创建 parent/TurnExecution；只通知并删除 queue entry；
7. 超过 15 拒绝。

**v1 不做**
- `a2a_send`、`handoff_*`、multi_mention 聚合回调、cross-thread custody。
- `multi_mention` 如果保留，按普通多 target post 处理，不做聚合回调。

### 3.9 PerAgentTerminalDispositionCollector + transitionTerminal + QueueProcessor

**正常终态路径**

1. child 执行结束：
   - `TurnExecutionStore.transitionTerminal(turnId, { status, endedAt, terminalReason })`；
   - attempt `state` 同事务写 terminal，`settlement='response_pending'`；
   - 只允许一次；返回 child 终态。
2. `PerAgentTerminalDispositionCollector`：
   - 输入 parent `targetAgentIds` + `invocation_attempts` 中每个 target 的**最新 attempt**
     （join 对应 child；不是从 queue 行或随机 child 猜）；
   - 产出 `successfulAgentIds` + parent status；`failedAgentIds`/`canceledAgentIds` 只是派生视图，不写 parent。
3. `QueueProcessor`：
   - 在 child terminal 的同一事务里写 TurnExecution terminal + attempt 终态 +
     attempt settlement、调用 collector；
   - 写 parent aggregate；
   - terminalize credential；
   - parent `completed`/`canceled` 时移除 queue entry / 释放 tracker slot；
     `partial_failed`/`failed` 保留 queue entry 作为 retry anchor。

**聚合规则**

| 条件 | parent status |
|---|---|
| 首次 attempt 还没有 child 开始且 retryCount=0 | `queued` |
| 任一最新 attempt 的 child running，或还有 target 没有 child | `running` |
| 所有 target 最新 attempt 的 child completed | `completed` |
| ≥1 completed + ≥1 failed/interrupted/canceled，且无 running | `partial_failed` |
| 0 completed，且所有 target failed/interrupted/canceled，且无 running | `failed` |
| operator 取消整个消息 | `canceled` |

- `interrupted` 归入失败面（可重试）；`canceled` 归入取消面。
- `successfulAgentIds` 单调递增；failed/canceled 由每个 agent 最新 attempt 推导。
- `requestRetry` 受理后 parent 进入 `queued`；retry child 创建并启动后由 `markRunning` 进入 `running`。

**重试与 attempt 台账（Clowder 逻辑，2026-11-10 拍板）**

- 重试单位是 **target attempt**，不是 queue entry：同一个 `invocationRecordId`、同一条
  source message、同一个 queue entry；不重新 admission，不产生第二条用户消息。
- `invocation_attempts` 是 append-only：每个 target 每次执行/重试一行；`attempt` 从 1
  递增；旧行永不改写。唯一键 `(invocation_record_id, target_agent_id, attempt)`。
- 自动重试只覆盖 **pre-handoff / 仍 pending** 的 target（worker spawn、provider 启动前
  失败等）：按进程内 `RetryDeferrals` 的 bounded backoff（base 10s、逐次翻倍、上限 1h）
  重新 drain，并追加新 attempt。进程重启后 startup drain 重新尝试（Clowder 同样把 backoff
  定为 process-local）。
- 已进入终态失败的 target **不自动重跑**；operator 调 `requestRetry` 后，只为
  `targetAgentIds - successfulAgentIds` 追加 `attempt+1`；parent 先 `queued`，新 child
  启动后 `markRunning`。
- 已成功 agent 永不重跑；`successfulAgentIds` 单调递增；每个 target 的聚合取
  `invocation_attempts` 最新 attempt，而不是从 queue 行或 child 集合猜。
- queue entry 保留到所有 target attempt 终态：`targets_json` 为空时仍保留为
  retry/terminal anchor；parent `completed`/`canceled` 后删除；`partial_failed`/`failed`
  保留到显式 retry 或 operator abandon。
- retry 前 queue row 必须是 `queued` + 空 pending；`requestRetry` 用 exact-entry claim
  （不是重新 admission）把失败 target 放回 pending。
- `requestRetry` 是 QueueProcessor 编排，不是单个 store 方法：同一事务里把 parent
  置 `queued`、追加 target 的 attempt+1、把 target 放回 queue entry 的 pending
  targets；随后由正常 drain 启动新 child。
- `requestRetry` 只接受旧 attempt `settled`；若仍是 `response_pending`，先
  `settleResponseFromDraft` 或返回 typed `response_pending`，不并发写同一 R。

**Clowder 的两条 retry 路径（为什么 v1 选 route recovery）**

Clowder 同时存在两条语义不同的 retry；混用会把 ordinary A2A 做成 cloud delivery：

> 以下 Clowder 路径均为参考仓 repo-relative，仅作实现对照，不进入 codeteam runtime。

| 路径 | 入口 | 语义 | codeteam v1 |
|---|---|---|---|
| ordinary route recovery | `packages/api/src/routes/queue-routing-recovery.ts:98` → `QueueProcessor.retryRoutingTarget`（`QueueProcessor.ts:3324`） | 同一个 queue entry、exact target；要求 `entry.status='queued'`、target 仍在 pending、`routingHeldTargetIds`；`claimExactSteerEntryDurable` + `retryDeferrals.forget` 后重新 start | **采用** |
| cloud delivery retry | `packages/api/src/routes/messages.ts:928` | fresh source/attempt；failed History delivery 不可变；Queue 只接收新的 pending work，绝不 reopen terminal row | 不采用（connector/cloud 专用；v1 不做） |

- 自动退避只在 pre-handoff 仍 pending 的 target：`QueueProcessor.deferFailedAttempt`
  （`QueueProcessor.ts:2913`）→ `QueueRetryDeferrals.defer`（`queue-retry-deferrals.ts:29`）；
  默认 base 10s、上限 1h（`:19-20`）。
- immutable attempt 的 Clowder read model 是 `QueueTargetAttempt`
  （`packages/shared/src/types/queue-receipt.ts:271`）；retry 永远 append 新 attempt，
  不重写旧 attempt。codeteam 用 `invocation_attempts` 表承载同一语义。

**route recovery 架构**

```text
source message m1
  └─ invocation_queue q1（route anchor；pending targets + attempt ledger）
       ├─ attempt A=1 completed → TurnExecution iA1 → R_A1 settled
       └─ attempt B=1 failed    → TurnExecution iB1 → R_B1 failed
                                  │
        explicit: POST /routing-targets/B/retry
        auto:     deferFailedAttempt（pre-handoff，target 仍 pending）
                                  │
                                  ▼
        claim exact q1/B + retryDeferrals.forget
                                  │
                                  ├─ append attempt B=2（queued；旧 B=1 不可变）
                                  ├─ 把 B 放回 q1 pending targets
                                  ├─ parent invP: partial_failed → queued
                                  └─ start B：新 TurnExecution iB2 / R_B2 / draft
                                           │
                                           └─ success → parent completed；A 不重跑
```

- **queue entry 是 route anchor**：一个 source/admission 一个 entry；retry 不新建 entry、
  不重新 admission、不产生第二条用户消息。
- **target-level exact claim**：`retryRoutingTarget` 只 claim 失败 target；成功 target
  的 TurnExecution/credential/R 不动。
- **attempt append-only**：每次 retry 追加 `attempt+1`；旧 attempt 的 state/terminalReason/
  R/draft 保留；parent 的 `successfulAgentIds` 只增不减。
- **两条触发**：operator 显式 `retry_target`；pre-handoff pending failure 由
  `RetryDeferrals` 自动重试。已终态失败不自动重跑。
- **与普通 drain 的关系**：普通 drain 从 `listQueued` 选候选；route recovery 是
  “exact entry + exact target” bypass，只恢复该 target，不改变其他 entry 的顺序。

codeteam 的 ordinary A2A 复用 Clowder 的 route/invocation/target，retry 也必须复用
route recovery，而不是 cloud delivery 的“新 source/attempt”。之前“新 queue entry +
新 attempt”既不是 route recovery（没有 same-entry immutability），也不是 cloud delivery
（没有 new source）；它是多余的自造第三种模型，已删除。剩余差异只有存储表示
（SQLite `invocation_attempts` vs Clowder queue/attempt read model）和 v1 scope
（不做 append recovery/steer/continuation/action successor/cloud delivery）。

**`InvocationAttemptStore` v1**

```ts
interface InvocationAttempt {
  attemptId: string;
  invocationRecordId: string;
  queueEntryId: string;
  threadId: string;
  targetAgentId: string;
  attempt: number;          // target attempt, 1-based

  turnExecutionId: string | null;
  state: "queued" | "running" | "completed" | "failed" | "interrupted" | "canceled";
  terminalReason: string | null;

  // execution binding/snapshot
  agentSessionId: string | null;
  workerId: string | null;
  provider: string | null;
  model: string | null;
  modelFamily: string | null;
  usage: TokenUsage | null;

  // response settlement
  settlement: "streaming" | "response_pending" | "settled" | null;
  responseMessageId: string | null;

  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

interface InvocationAttemptStore {
  appendQueued(input: {
    attemptId: string;
    invocationRecordId: string;
    queueEntryId: string;
    threadId: string;
    targetAgentId: string;
    attempt: number;
    now: number;
  }): { outcome: "created" | "replayed" | "conflict"; record: InvocationAttempt };

  bindExecution(attemptId: string, input: {
    turnExecutionId: string;
    agentSessionId: string;
    workerId: string | null;
    provider: string;
    model: string;
    modelFamily: string;
    responseMessageId: string;
    now: number;
  }): InvocationAttempt | null;

  recordUsage(attemptId: string, usage: TokenUsage, now: number): InvocationAttempt | null;

  setSettlement(attemptId: string, input: {
    settlement: "streaming" | "response_pending" | "settled";
    responseMessageId?: string;
    now: number;
  }): InvocationAttempt | null;

  transitionTerminal(attemptId: string, input: {
    state: "completed" | "failed" | "interrupted" | "canceled";
    terminalReason: string | null;
    now: number;
  }): {
    outcome: "transitioned" | "already_terminal" | "not_found";
    record: InvocationAttempt | null;
  };

  getLatest(invocationRecordId: string, targetAgentId: string): InvocationAttempt | null;
  getByTurnExecutionId(turnExecutionId: string): InvocationAttempt | null;
  listByInvocation(invocationRecordId: string): InvocationAttempt[];
  listRunning(): InvocationAttempt[];
  listResponsePending(): InvocationAttempt[];
}
```

- `appendQueued` 以 `(invocationRecordId, targetAgentId, attempt)` 幂等；同 key 不同
  `queueEntryId` 即 conflict。
- `bindExecution` 只接受 `queued → running`，写 `turnExecutionId`/session/worker/
  provider/model、`responseMessageId` 和 `settlement='streaming'`；已 running 幂等。
- `recordUsage` 只写本 attempt 的 usage；parent `usageByAgent` 由 collector 汇总。
- `setSettlement` 只允许 `streaming → response_pending → settled`；R terminal 后清 pending。
- `transitionTerminal` 只接受一次；`completed` 允许 `terminalReason=null`，其他终态必须
  有 reason；terminal 后不再变化。
- `turnExecutionId` 非空时唯一；`responseMessageId` 非空时唯一。

**v1 不做**
- `usage` 由 collector 汇总到 parent `usageByAgent`；不做 action fence 聚合。
- v1 用一个事务保证 child terminal + attempt terminal + parent aggregate + credential
  terminal；R terminal 由 `response_pending` settlement 第二段提交，child 不等待 R。

### 3.10 StartupReconciler / ZombieTerminalRecovery / TrajectoryProjector / LiveInvocations

**9) 和 10) 的关系**：9) 是正常终态路径；10) 是异常/重启/读模型路径；两者共用 `TurnExecution.status` 和 parent aggregate。

1. **TurnExecutionStartupReconciler**
   - daemon 启动时调用 `TurnExecutionStore.interruptRunningBefore(cutoff, {
     endedAt, terminalReason: 'process_restart' })`；
   - 进程启动前遗留的 running TurnExecution 收敛为 `interrupted/process_restart`；
     `protectedInvocationIds`/本进程新建的 child 不收敛；
   - 同步把对应 `invocation_attempts` 从 `running` 收敛为 `interrupted`；不存在对应
     child 的 `running` attempt 也标 `interrupted`；
   - 更新 parent aggregate；terminalize credential。
   - `queued` attempt 没有 live child：target 仍在 pending 时留给 drain（按 backoff）；
     source 已撤回/取消则标 `canceled`，不留下永久 queued attempt。
   - 扫描 `TurnExecution.listResponsePending()`（attempt settlement join 投影）：
     对每个 `response_pending` 调
     `settleResponseFromDraft`；R 已 terminal 则只清 pending，R processing 则按 child
     terminal 状态提交（draft 缺失则空正文 + reason），R 不存在则标
     `response_missing` + `delivery_failure`。
2. **ZombieTerminalRecovery**
   - 定时扫描 running 超过 TTL 且无 owner 的 TurnExecution；
   - 标 `interrupted`，同步 attempt；更新 parent；terminalize credential。
3. **InvocationOwnerReaper**
   - 扫描 running TurnExecution + tracker stale slots；
   - 无 live worker/heartbeat → `interrupted/owner_reaped`，parent aggregate，credential terminalize，释放 slot；
   - 与 Zombie recovery 共用逻辑；v1 可以合并成一个 reaper。
4. **getThreadLiveInvocations**
   - = tracker active slots + durable running TurnExecution；
   - 返回 `{ agentId, turnExecutionId, invocationRecordId, startedAt, status }`；
   - 用于 UI live status / cancel。
5. **InvocationTrajectoryProjector**
   - v1 **不做完整 trajectory**；
   - 先由 `TurnExecution` + response `Message` + events 提供简单 timeline；
   - 等需要 trajectory drilldown 再加 projector。
6. **MessageDispatchSummary**
   - parent + child 的读模型：targets、running/completed/failed/canceled、responses；
   - 用于消息级状态展示。

**v1 不做**
- Clowder 的 exact owner lease、zombie terminal 复杂判定、trajectory projector。
- 用“startup reconcile + TTL reaper + child status”覆盖 v1 的快速 E2E。

## 4. 数据模型

> 建表顺序：`invocation_records` → `invocation_queue` → `queue_admissions` →
> `turn_executions` → `invocation_attempts` → `response_drafts` →
> `invocation_credentials`。
> 下文按逻辑分组展示，实际迁移按上述顺序创建。

### 4.1 `invocation_queue`

```sql
CREATE TABLE invocation_queue (
  version INTEGER NOT NULL CHECK (version = 1),
  queue_entry_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  message_id TEXT,
  origin_record_id TEXT,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  owner_json TEXT NOT NULL CHECK (json_valid(owner_json)),
  kind TEXT NOT NULL CHECK (kind IN ('conversation_input', 'message_wake')),
  from_json TEXT NOT NULL CHECK (json_valid(from_json)),
  targets_json TEXT NOT NULL
    CHECK (json_valid(targets_json) AND json_type(targets_json) = 'array'),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  execution_json TEXT NOT NULL CHECK (json_valid(execution_json) AND json_type(execution_json) = 'object'),
  delivery_json TEXT NOT NULL CHECK (json_valid(delivery_json) AND json_type(delivery_json) = 'object'),
  priority TEXT NOT NULL CHECK (priority IN ('urgent', 'normal')),
  position INTEGER NOT NULL CHECK (position >= 0),
  status TEXT NOT NULL CHECK (status IN ('queued', 'claimed')),
  claim_id TEXT,
  claim_owner TEXT,
  claimed_at INTEGER,
  claim_expires_at INTEGER,
  claimed_target_keys_json TEXT
    CHECK (claimed_target_keys_json IS NULL OR
           (json_valid(claimed_target_keys_json) AND json_type(claimed_target_keys_json) = 'array')),
  enqueued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  CHECK (status = 'queued' OR
         (claim_id IS NOT NULL AND claim_owner IS NOT NULL AND claimed_at IS NOT NULL
          AND claim_expires_at IS NOT NULL AND claimed_target_keys_json IS NOT NULL)),
  CHECK (status <> 'queued' OR
         (claim_id IS NULL AND claim_owner IS NULL AND claimed_at IS NULL
          AND claim_expires_at IS NULL AND claimed_target_keys_json IS NULL)),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX invocation_queue_source_attempt
  ON invocation_queue(thread_id, source_record_id, attempt);
CREATE INDEX invocation_queue_pending
  ON invocation_queue(thread_id, status, priority, position, enqueued_at, queue_entry_id)
  WHERE json_array_length(targets_json) > 0;
CREATE UNIQUE INDEX invocation_queue_claim
  ON invocation_queue(claim_id) WHERE claim_id IS NOT NULL;

CREATE TABLE queue_admissions (
  source_record_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  queue_entry_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  admitted_at INTEGER NOT NULL,
  PRIMARY KEY (source_record_id, attempt)
) STRICT;
```

- `targets_json` 是 **pending `QueueTarget[]`**；`payload_json.requestedTargets` 是 admission
  全量快照。允许空数组：全部 target 已 dispatch、但 attempt 尚未全部终态时，row 作为
  retry/terminal anchor 保留，`listQueued` 按 `json_array_length(targets_json) > 0` 过滤，
  不会把空 pending row 当候选。
- `payload_json` 含 `sourceRecordId/messageId/originRecordId/attempt/content/requestedTargets/requestId`；`content` 是 admission 正文快照。
- `source_record_id` 是队列身份；`message_id` 是消息指针（v1 恒非空，未来 connector 可为 null）；`attempt` 是 1-based 尝试序号。
- `execution_json` 含 `a2aParentTurnExecutionId/a2aTriggerMessageId/a2aDepth`。
- `delivery_json` 含 `operatorNotifiedAt`；operator-only entry 没有 parent/TurnExecution。
- `claim` 在 TS 模型里是子对象；SQL 用 `claim_*` 标量 + `claimed_target_keys_json` 做 CAS，语义是 target-level claim。
- `status` 只持久化 `queued | claimed`；`processing | terminal` 只出现在 transition projection，不落库。
- `queue_admissions` 是 admission receipt：live row 删除后，同一 `(source_record_id, attempt)` 重放仍返回 `replayed`/`conflict`。
- queue entry 保留到所有 agent target attempt 终态：parent `completed`/`canceled` 后删除；
  `partial_failed`/`failed` 保留到显式 retry 或 operator abandon。
  `invocation_attempts.queue_entry_id` 仍是 trace 字符串。
- target-level backoff 是进程内 `RetryDeferrals`（Clowder 同设计）：`listQueued`/`claim`
  跳过仍在 deferral 窗口内的 target；daemon 重启后 startup drain 重新尝试 pending target。

### 4.2 `invocation_records`

```sql
CREATE TABLE invocation_records (
  invocation_record_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL UNIQUE,
  user_message_id TEXT,
  target_agent_ids_json TEXT NOT NULL
    CHECK (json_valid(target_agent_ids_json) AND json_type(target_agent_ids_json) = 'array'
           AND json_array_length(target_agent_ids_json) > 0),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'completed', 'partial_failed', 'failed', 'canceled')
  ),
  successful_agent_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(successful_agent_ids_json) AND json_type(successful_agent_ids_json) = 'array'),
  usage_by_agent_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(usage_by_agent_json) AND json_type(usage_by_agent_json) = 'object'),
  usage_recorded_at INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  terminal_reason TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,

  CHECK (status IN ('queued', 'running') OR ended_at IS NOT NULL),
  CHECK (status IN ('queued', 'failed', 'canceled') OR started_at IS NOT NULL),
  CHECK (status NOT IN ('completed', 'partial_failed')
         OR json_array_length(successful_agent_ids_json) > 0),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_message_id) REFERENCES messages(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX invocation_records_thread_status
  ON invocation_records(thread_id, status);
```

- `source_record_id` unique：一个 source 一个 parent；重试复用同一 parent。
- `user_id` 是 parent ownership snapshot；必须等于 `thread.created_by`（`0011` §11）。
- `user_message_id` 是 parent 的用户消息指针；v1 = `messageId`，未来 connector 可为 null。
- `target_agent_ids_json` 是 admission 快照，不可变。
- `successful_agent_ids_json` 单调递增；failed/canceled 不落库，由 `invocation_attempts`
  每个 target 的最新 attempt 推导。
- `usage_by_agent_json` 是按 agent 的累计 usage；`usage_recorded_at` 首次写入时间，稳定分桶。
- `status`/`ended_at`/`terminal_reason` 由 collector 与 child terminal 同事务更新。

### 4.3 `turn_executions`

```sql
CREATE TABLE turn_executions (
  turn_execution_id TEXT PRIMARY KEY,
  invocation_record_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,          -- scope snapshot；必须等于 parent/thread owner
  agent_id TEXT NOT NULL,
  execution_kind TEXT NOT NULL CHECK (execution_kind IN ('ordinary', 'routing_guard')),
  causal_json TEXT NOT NULL
    CHECK (json_valid(causal_json) AND json_type(causal_json) = 'object'),

  status TEXT NOT NULL CHECK (
    status IN ('running', 'completed', 'failed', 'interrupted', 'canceled')
  ),
  terminal_reason TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,

  CHECK (status = 'running' OR ended_at IS NOT NULL),
  CHECK (status = 'running' OR terminal_reason IS NOT NULL OR status = 'completed'),
  FOREIGN KEY (invocation_record_id) REFERENCES invocation_records(invocation_record_id) ON DELETE RESTRICT,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX turn_executions_invocation
  ON turn_executions(invocation_record_id, agent_id);
CREATE INDEX turn_executions_running
  ON turn_executions(status, started_at);
```

- `causal_json` 对应 Clowder `TurnExecutionCausalRefs`：至少含 `triggerMessageId`；
  可选 `a2aParentTurnExecutionId` / `a2aTriggerMessageId` / `a2aDepth` /
  `routingGuardReason`。应用层校验 required 字段。
- `agent_session_id` / `worker_id` / `provider` / `model` / `model_family` / `usage` /
  `queue_entry_id` / `attempt` / `settlement` / `response_message_id` 全部在
  `invocation_attempts`（§4.3.1）；TurnExecution 不承担 execution binding/response。
- `listResponsePending()` 是 `invocation_attempts.settlement='response_pending'` 的 join
  投影；`clearResponsePending(turnExecutionId)` 更新对应 attempt 的 settlement。
- `interruptRunningBefore` 只改 `turn_executions.status/ended_at/terminal_reason`；
  attempt/credential 由调用方在同一恢复流程收敛。
- `routing_guard` 没有 attempt/R；只有 core TurnExecution，`causal.routingGuardReason`
  记录 guard 原因。
- v2 再加 `causal.coveredMessageIds`、`outputFence`、`queueCompletionPolicy`。

### 4.3.1 `invocation_attempts`

```sql
CREATE TABLE invocation_attempts (
  attempt_id TEXT PRIMARY KEY,
  invocation_record_id TEXT NOT NULL,
  queue_entry_id TEXT NOT NULL,          -- route anchor；queue row 删除后仍是 trace 字符串
  thread_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),

  turn_execution_id TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'running', 'completed', 'failed', 'interrupted', 'canceled'
  )),
  terminal_reason TEXT,

  agent_session_id TEXT,
  worker_id TEXT,
  provider TEXT,
  model TEXT,
  model_family TEXT,
  usage_json TEXT
    CHECK (usage_json IS NULL OR
           (json_valid(usage_json) AND json_type(usage_json) = 'object')),
  settlement TEXT
    CHECK (settlement IS NULL OR settlement IN ('streaming', 'response_pending', 'settled')),
  response_message_id TEXT UNIQUE,

  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,

  CHECK (state NOT IN ('completed', 'failed', 'interrupted', 'canceled')
         OR ended_at IS NOT NULL),
  CHECK (state <> 'running' OR started_at IS NOT NULL),
  CHECK (state NOT IN ('running', 'completed') OR turn_execution_id IS NOT NULL),
  CHECK (state NOT IN ('failed', 'interrupted', 'canceled') OR terminal_reason IS NOT NULL),
  CHECK (turn_execution_id IS NOT NULL OR state IN ('queued', 'failed', 'interrupted', 'canceled')),
  CHECK (settlement IS NULL OR response_message_id IS NOT NULL),
  CHECK (settlement IS NULL OR state <> 'queued'),
  CHECK (settlement <> 'streaming' OR state = 'running'),
  CHECK (settlement <> 'response_pending' OR state NOT IN ('queued', 'running')),
  CHECK (settlement <> 'settled' OR state NOT IN ('queued', 'running')),
  CHECK (response_message_id IS NULL OR state <> 'queued'),
  UNIQUE (invocation_record_id, target_agent_id, attempt),
  FOREIGN KEY (invocation_record_id)
    REFERENCES invocation_records(invocation_record_id) ON DELETE RESTRICT,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT,
  FOREIGN KEY (turn_execution_id)
    REFERENCES turn_executions(turn_execution_id) ON DELETE SET NULL,
  FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE SET NULL,
  FOREIGN KEY (response_message_id) REFERENCES messages(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX invocation_attempts_latest
  ON invocation_attempts(invocation_record_id, target_agent_id, attempt DESC);
CREATE INDEX invocation_attempts_state
  ON invocation_attempts(state, started_at);
CREATE INDEX invocation_attempts_settlement
  ON invocation_attempts(settlement) WHERE settlement = 'response_pending';
CREATE UNIQUE INDEX invocation_attempts_one_running_per_session
  ON invocation_attempts(agent_session_id)
  WHERE state = 'running' AND agent_session_id IS NOT NULL;
```

- **append-only**：每个 agent target 每次执行/重试一行；retry 追加 `attempt+1`，旧行永不改写。
- `queue_entry_id` 不加 FK：queue row 在 parent terminal 后可删除，attempt 仍保留 route 证据。
- `turn_execution_id` 在 `createRunning` 成功后回填，非空时唯一；`queued` attempt 允许为空。
- attempt 不存 `userId`；从 `invocationRecordId`/`threadId` 派生（`0011` §11）。
- `agent_session_id` / `worker_id` / `provider` / `model` / `model_family` / `usage_json`
  是本 attempt 的 execution binding/snapshot；`bindExecution` 写入。
- `settlement` 是 response 状态，不是 execution state：`NULL`（queued，无 R）、
  `streaming`、`response_pending`、`settled`；`response_message_id` 在 R 创建时写入。
- state 只允许 `queued → running → completed|failed|interrupted|canceled`，或
  `queued → canceled`（source 撤回）；terminal state 不再变化。
- settlement 只允许 `NULL → streaming → response_pending → settled`；
  `response_pending` 要求 attempt 已 terminal。
- operator targets 不进入本表：operator 通知由 queue entry 的 `delivery.operatorNotifiedAt` 承担。
- parent 的 `retryCount` 是显式重试波次计数；每个 target 的实际 attempt 以本表为准。

### 4.3.2 `response_drafts`

```sql
CREATE TABLE response_drafts (
  attempt_id TEXT PRIMARY KEY,
  turn_execution_id TEXT NOT NULL UNIQUE,
  invocation_record_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  content_blocks_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(content_blocks_json) AND json_type(content_blocks_json) = 'array'),
  tool_events_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(tool_events_json) AND json_type(tool_events_json) = 'array'),
  thinking TEXT,
  seq INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (attempt_id) REFERENCES invocation_attempts(attempt_id) ON DELETE CASCADE,
  FOREIGN KEY (turn_execution_id) REFERENCES turn_executions(turn_execution_id) ON DELETE CASCADE,
  FOREIGN KEY (invocation_record_id) REFERENCES invocation_records(invocation_record_id) ON DELETE RESTRICT,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX response_drafts_thread
  ON response_drafts(thread_id, updated_at);
```

- 一行对应一个 attempt 的 in-flight response body；`attempt_id` / `turn_execution_id` 1:1。
- `user_id` 是 draft store 的用户作用域；必须等于 attempt/TurnExecution 的 owner。
- `content` 是 streamed text；`content_blocks_json` / `tool_events_json` 是工具/块事件；
  `thinking` 是可选思考流。它不是 message history，不分配 `messages.seq`。
- `seq` 是 draft 更新序号，用于 bounded flush 的幂等/乱序保护；不是消息顺序。
- stream 每 100ms 或 4KB flush 一次；`message_end` 用最终值覆盖；R terminal 后删除。
- daemon 崩溃时 draft 保留；`response_pending` + startup reconciler 用它结算 R。

### 4.4 `invocation_credentials`

```sql
CREATE TABLE invocation_credentials (
  credential_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  token_salt TEXT NOT NULL,
  turn_execution_id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  allowed_tools_json TEXT NOT NULL
    CHECK (json_valid(allowed_tools_json) AND json_type(allowed_tools_json) = 'array'),
  state TEXT NOT NULL CHECK (state IN ('active', 'terminal')),
  disposition TEXT CHECK (
    disposition IS NULL OR disposition IN ('completed', 'failed', 'interrupted', 'canceled', 'revoked')
  ),
  last_refresh_at INTEGER NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  CHECK (state <> 'terminal' OR disposition IS NOT NULL),
  CHECK (state <> 'active' OR disposition IS NULL),
  FOREIGN KEY (turn_execution_id) REFERENCES turn_executions(turn_execution_id) ON DELETE RESTRICT,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE RESTRICT
) STRICT;
```

- 一个 child TurnExecution 一个 credential。
- `user_id` 是 auth scope；必须等于 child TurnExecution/thread owner（`0011` §11）。
- 重试创建新 child + 新 credential；旧 credential terminalize。
- token 只存 hash+salt；token 本体只经 `CODETEAM_TOKEN_FILE` 交给 pi extension。

### 4.5 `agent_read_state`

```sql
CREATE TABLE agent_read_state (
  thread_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  delivery_cursor INTEGER NOT NULL DEFAULT 0 CHECK (delivery_cursor >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, agent_id),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
) STRICT;
```

- 只存 `deliveryCursor`；`seenCursor` / `mentionAck` / unread badge 是 v2。
- 不存 `userId`：thread owner 隐含 user；v1 单 user 用 `(thread_id, agent_id)` 足够，
  详见 `0011-identity-contract.md` §11。
- `ack` 用单调 CAS：`INSERT ... ON CONFLICT DO UPDATE SET delivery_cursor =
  max(delivery_cursor, excluded.delivery_cursor)`；普通 ack 不允许回退。
- 与 `agent_sessions` 分开：session 是执行身份，read state 是投递进度；session fresh/reset
  通过显式 rewind API 改 cursor，不删行。
- 建表顺序排在 `threads` 之后；不依赖 `messages` 的 FK，消息可由 `thread_id + seq` 查询。

### 4.6 `workers` / `worker_bindings`

- 表定义见 §3.5.2；worker 是 ephemeral execution carrier，不是 session 常驻所有者。
- 建表顺序：`agent_sessions` → `workers` → `worker_bindings` → `turn_executions`
  → `invocation_attempts`（`invocation_attempts.worker_id` FK 指向 `workers`）。
- 索引：`workers(state, lease_expires_at)`、`worker_bindings(worker_id)`。
- `invocation_attempts.worker_id` 用 `ON DELETE SET NULL`；worker retire 不删历史 child。
- worker retire → 删 `worker_bindings`；session 保留，下一轮重新 spawn + resume。

## 5. 状态机与聚合

### 5.1 InvocationRecord

```text
queued ──first child running──▶ running
running ──all success──▶ completed
running ──some success + some failed/canceled──▶ partial_failed
running ──no success + all failed/canceled──▶ failed
queued/running ──operator cancel──▶ canceled
partial_failed/failed ──retry admitted──▶ queued
queued ──retry child starts──▶ running
```

### 5.2 TurnExecution

```text
running ──provider success──▶ completed
running ──provider error──▶ failed
running ──daemon/worker interruption──▶ interrupted
running ──operator cancel──▶ canceled
```

- 一个 TurnExecution 只有一次 terminal 转移。
- `replayed` 不授予第二次 provider lease。

### 5.2.1 InvocationAttempt

```text
state:
queued ──bindExecution──▶ running
running ──provider success──▶ completed
running ──provider error──▶ failed
running ──daemon/worker interruption──▶ interrupted
queued/running ──operator cancel──▶ canceled
terminal ──retry appends new attempt──▶ (old row unchanged)

settlement:
NULL ──R created──▶ streaming
state terminal ──▶ response_pending
R terminal + inputs settled ──▶ settled
```

- attempt `state` 是执行状态；`settlement` 是 response 状态；两者独立推进。
- `response_pending` 要求 attempt 已 terminal；`settled` 后不可回退。

### 5.3 InvocationCredential

```text
active ──child terminal──▶ terminal(completed/failed/interrupted/canceled)
active ──auth revoke/orphan repair──▶ terminal(revoked)
```

### 5.4 聚合规则

按每个 agent 的**最新 attempt**：

1. 首次 attempt 还没有 child 开始，或 retry 已受理但 child 未创建 → parent `queued`；
2. 任一最新 child running，或还有 target 没有 child → parent `running`；
3. 所有 target 最新 child completed → parent `completed`；
4. ≥1 completed + ≥1 failed/interrupted/canceled，且无 running → parent `partial_failed`；
5. 0 completed，所有 target failed/interrupted/canceled，且无 running → parent `failed`；
6. operator 取消整个消息 → parent `canceled`。

`interrupted` 归失败面（可重试）；`canceled` 归取消面。
parent 只存 `successfulAgentIds`；failed/canceled 由 `invocation_attempts` 最新 attempt 推导。

## 6. 端到端流程

### 6.1 多 target 普通消息

```text
m1（targets=[agent:A, agent:B]）
  → InvocationQueue.enqueue q1
  → QueueProcessor claim q1
  → InvocationRecord invP 创建（status=queued）
  → InvocationTracker.start(A), start(B)
  → routeAgents("parallel") → runAgentTurn 创建 attempt A/B=1 + core TurnExecution iA/iB
  → invoke-single-agent:
       ensure AgentSession(sA/sB) + worker
       createRunning(iA/iB)
       bind attempt（session/worker/provider/model/R/settlement=streaming）
       InvocationRegistry.create(iA/iB)
       prompt/stream
  → iA completed, iB failed；attempt A/B settlement='response_pending'
  → R settlement → attempt A/B settled
  → collector: successful=[A], failed=[B], status=partial_failed
  → parent 更新；credential terminalize；tracker release
```

### 6.1b operator-only / mixed targets

```text
operator-only:
  post_message targets=[operator:U]
  → message m1 + queue entry q1（targets=[operator:U]）
  → QueueProcessor claim q1
  → 通知/可见性 → delivery.operatorNotifiedAt
  → 无 parent / 无 TurnExecution
  → commit + 删除 q1

mixed:
  post_message targets=[agent:A, operator:U]
  → queue entry targets=[agent:A, operator:U]
  → operator → 通知；agent:A → InvocationRecord + attempt + core TurnExecution + processing R
  → parent 只看 agent:A；operator 通知记录在 queue entry
```

### 6.2 A2A hop

```text
iA 调 post_message 给 C
  → message m2 + InvocationQueue q2
  → QueueProcessor claim q2
  → InvocationRecord invP2（targetAgentIds=[C]）
  → TurnExecution iC：
      invocationRecordId=invP2
      causal = {
        triggerMessageId: m2,
        a2aParentTurnExecutionId: iA.turnExecutionId,
        a2aTriggerMessageId: m2,
        a2aDepth: iA.causal.a2aDepth + 1
      }
  → 超过 15 拒绝
```

### 6.3 部分成功重试

```text
parent partial_failed: successful=[A], failed=[B]
  → requestRetry(B)
  → 同一个 parent / 同一条 source message / 同一个 queue entry
  → invocation_attempts append B attempt=2（旧 B attempt=1 保留 failed）
  → B 重新进入 queue entry 的 pending targets；parent status=queued, retryCount+1
  → attempt B=2 bind TurnExecution iB2
  → iB2 running → parent status=running
  → iB2 completed + attempt B settlement=response_pending → attempt latest=completed
  → R settlement → attempt B settled → successful=[A,B], status=completed
  → A 的 attempt=1 / TurnExecution / credential 不重跑；A 不会因 retry 再产生 attempt
```

### 6.4 取消

- `cancel(parent)`：
  - tracker cancel 所有 active slots；
  - 所有 running TurnExecution → `canceled`（或 `interrupted`，取决于取消语义；v1 用 `canceled`）；
  - 未开始的 target 不写 parent 列表，由“无 child”推导为 canceled 面；
  - parent `canceled`；credential terminalize；
  - queue entry withdraw/delete。

### 6.5 重启/恢复

- `InvocationStartupReconciler`：
  - `interruptRunningBefore` 收敛进程启动前的 running TurnExecution → `interrupted`；
  - parent aggregate；credential terminalize。
- `ZombieTerminalRecovery`：
  - TTL 超时 running 无 owner → `interrupted`；
  - 同上。
- `InvocationOwnerReaper`：
  - running TurnExecution 无 live worker/heartbeat → `interrupted/owner_reaped`；
  - parent aggregate；credential terminalize；释放 tracker slot。
- `getThreadLiveInvocations`：
  - tracker active slots + durable running TurnExecution。
- `InvocationTrajectoryProjector`：
  - v1 不做；用 TurnExecution + response Message + events 的简单 timeline。

## 7. v1 裁剪与 v2 推迟

### 7.1 v1 保留

- `InvocationQueue`/`QueueEntry`：admission、target-level claim、lease、target 移除、operator
  通知、正文快照；row 保留到 target attempt 终态，作为 retry/terminal anchor。
- `InvocationAttemptStore` + `invocation_attempts`：append-only target attempt 台账 +
  execution binding/snapshot（session/worker/provider/model/usage）+ response settlement；
  latest-attempt 聚合；显式 retry 追加 attempt+1；不做跨重启持久化 backoff。
- `ResponseDraftStore` + `response_drafts`：processing R 的 in-flight body；100ms/4KB
  bounded flush；不是 message history。
- `ResponseSettlementService` + `settleResponseFromDraft`：child terminal 后提交 R
  terminal、settle input dispatchRefs、删除 draft、清 `response_pending`。
- `QueueProcessor`：claim、parent 创建、tracker、route、terminal 聚合、retry、startup recovery。
- `InvocationRecord`：消息生命周期、target snapshot、successfulAgentIds、usageByAgent、retryCount、partial_failed。
- `InvocationTracker`：thread×agent 活跃槽、start 抢占、cancel 即释放、executionId fence、live。
- `AgentRouter` + `runAgentTurn` + `routeAgents`：显式 targets、per-child AbortSignal；parallel 默认，serial 保留薄循环。
- `invoke-single-agent`：pi worker/session、child TurnExecution、credential、prompt/stream/terminal。
- `TurnExecutionStore.createRunning/transitionTerminal`：执行幂等 + 单终态。
- `WorkerPool` + `worker_bindings`：ephemeral worker（一 worker 一 session）、spawn/retire、
  heartbeat/stale、binding generation；`warmTtl=0` 默认，空闲不占进程。
- `InvocationRegistry`/`InvocationCredential`：pi extension tools 鉴权、allowed tools、terminalize、canonical repair。
- `a2a/tools`：post/cross/thread_context，typed targets（agent/operator），新 message/queue entry，parent/depth；operator-only 只通知不执行。
- `PerAgentTerminalDispositionCollector`：parent aggregate。
- `TurnExecutionStartupReconciler` / `ZombieTerminalRecovery` / `InvocationOwnerReaper` / `getThreadLiveInvocations` / `MessageDispatchSummary`。

### 7.2 v1 不做

| 能力 | 原因 |
|---|---|
| MCP callback / MCP tools | v1 用 pi extension + local control socket |
| `routeSerial` 单体实现 / intent-derived serial | v1 显式 targets；A2A hop 是新 message；serial 由 `routeAgents(mode)` 的薄循环表达 |
| guide/concierge/memory/SOP/entity nudge 的 route 分支 | v1 不挂；后续作为 `runAgentTurn` feature hooks |
| task/role/run/profile 坐标 | thread-first；credential 绑 child TurnExecution |
| custody / action lease / wait continuation | v2 |
| session sealed / compression / handoff | v1 active-only session（0009） |
| `outputFence` / `coveredMessageIds` / `queueCompletionPolicy` / `appendAcceptance` | v2 的 action/prompt/carrier/phase 审计 |
| `idempotencyKey` / `intent` | v1 用 `sourceRecordId` unique + queue receipt；usage 已保留为 `usageByAgent`/`usageRecordedAt` |
| `InvocationTrajectoryProjector` 完整版 | v1 用简单 timeline；trajectory drilldown 后续 |
| 每 delta 写 messages | v1 用 `response_drafts` bounded flush；不把每个 delta 变成 message 行/`seq` |
| 完整跨 store draft reconciliation | v1 单 SQLite 用 `response_pending` + `response_drafts`；不做 Clowder 的跨 Redis/append acceptance 补偿 |
| 已终态失败 target 的自动重跑 | v1 只对仍 pending 的 pre-handoff 失败做 bounded backoff；终态失败必须 operator `requestRetry` |
| 跨重启持久化 retry 时间表 | v1 用 process-local `RetryDeferrals`（base 10s、上限 1h）；重启后 startup drain 重新尝试 pending target |
| `seenCursor` / `mentionAck` / unread badge | v1 只做 `deliveryCursor`（§3.5.1） |
| managed work / collective grants / compaction carrier | v2 |

## 8. 迁移

1. **新表**：`invocation_queue`、`invocation_records`、`turn_executions`、
   `invocation_attempts`、`response_drafts`、`invocation_credentials`（重建）。
2. **旧 task-first 表**：`queue_entries`、`runs`、`agent_sessions`、旧 `invocation_credentials` 中的 task-first 数据保留在 `legacy_*`，新 runtime 不读。
3. **drain**：有 running task-first invocation 的 session 先 drain/terminal，再迁移；不把旧 run 混进新 TurnExecution。
4. **agent_sessions**：按 0009 只迁 active；sealing/sealed 行 legacy。
5. **preflight**：`agentId`/`userId`/`workingDirectory`/`Task.sourceMessageId`（legacy 领域指针）无法确定的进入 preflight，不静默置空。
6. **不迁移**：`task_id/role/stage_id/handoff_id/approval_id`、custody/action/wait/compaction 字段。
7. **文档同步**：`0005` §2.2/2.4/2.5 指向本文；`docs/reuse/callback-auth.md` 从 per-run token 更新为 per-invocation tool capability。

## 9. 验收标准

### 9.1 Queue / Processor

- 一条消息 enqueue 一个 queue entry；同 source 重放收敛到同一 `id`；重复 `requestId` 返回同一 entry。
- operator conversation 只解析行首 `@`；多个 @ 去重；未知/disabled typed reject。
- 无显式 @ → 隐式路由：上一 human `targetAgentIds` → 最近成功 replier → participant → default agent；都没有才 `no_target`。
- `StoredMessage.targetAgentIds` 与 message + queue entry 同事务写入（仅 user message；agent A2A targets 在 lifecycle.dispatchRefs）。
- A2A tools 只接受显式 `{kind,id}` targets；正文 `@` 不路由。
- operator-only entry：只通知，不创建 parent/TurnExecution；`delivery.operatorNotifiedAt` 写入。
- target-level claim：`InvocationQueue.claim`；`claim.targetKeys` 是 pending 子集；过期/失败走 `releaseClaim` / `restoreExpiredClaims`。
- 重放保护：live row 删除后，同一 `(source_record_id, attempt)` 仍由 `queue_admissions` 返回 `replayed`/`conflict`。
- `processEntry` 只对 agent targets 创建 parent + N attempt + N processing R + N child；
  queue entry 保留到 attempt 终态，parent `completed`/`canceled` 后删除。
- `partial_failed`/`failed` 的 queue row 释放 claim、保持 `queued` + 空 pending；
  `requestRetry` 通过 exact-entry claim 重新加入失败 target，不重新 admission。
- `routeAgents("parallel")` 每个 child 独立 signal；`routeAgents("serial")` 是同一 `runAgentTurn` 的薄循环，v1 不默认启用。

### 9.2 InvocationRecord

- `sourceRecordId` unique；重试复用同一 parent。
- `targetAgentIds` 不可变。
- 全部 child completed → parent completed。
- 部分成功 → parent partial_failed；`successfulAgentIds` 正确。
- 全部失败 → parent failed。
- 取消 → parent canceled。
- 重试只重跑 `targetAgentIds - successfulAgentIds`；successful 不重跑；`retryCount` 递增，parent 先回 `queued`。
- 重试不新建 queue entry、不产生第二条用户消息、不重新 admission；每个被重试 target 追加
  `invocation_attempts` 的 `attempt+1`，旧 attempt 保持原终态。
- 每个 target 的聚合取 `invocation_attempts` 最新 attempt；不能用旧 failed attempt 覆盖新成功。
- queue entry 在 parent `completed`/`canceled` 后删除；`partial_failed`/`failed` 保留到显式
  retry 或 operator abandon。
- `response_pending` 的 child 已经 terminal，参与 parent aggregate；R settlement 不改变
  parent status。
- `usageByAgent` 按 agent 跨 attempt 累计；`usageRecordedAt` 首次写入后不变。

### 9.3 TurnExecution / createRunning

- 同 id/同身份重复 createRunning → `replayed`，不启动第二次 provider。
- 同一业务 identity + 不同 `startedAt` → 仍然 `replayed`（`startedAt` 不进 identity）。
- 同 id/不同身份 → `conflict`。
- 新 id → `created`。
- `turnExecutionId` 可从 `(invocationRecordId, agentId, attempt)` 确定性派生，或已持久化在
  attempt/queue admission 中；crash 后重试必须命中 `replayed`，不能每次生成新 id。
- `TurnExecution.userId` 必须等于 `InvocationRecord.userId` 和 `Thread.created_by`；
  不一致 fail closed。
- 一个 TurnExecution 只能 transitionTerminal 一次；重复 → `already_terminal`。
- ordinary running/terminal attempt 必须有 `responseMessageId`/`settlement`；
  `routing_guard` 没有 attempt/R。
- failed/interrupted/canceled 必须有 terminalReason。
- 一个 agent 可有多 attempt；唯一 `(parent, agent, attempt)`。
- 每个 attempt 必须有 `invocation_attempts` 行；child terminal 与 attempt terminal 同事务；
  attempt 只能走 `queued → running → terminal`，旧 attempt 不可改写。
- attempt `turn_execution_id` 非空时唯一；`response_message_id` 非空时唯一。
- `interruptRunningBefore(cutoff)` 只收敛 `startedAt < cutoff` 的 running TurnExecution；
  attempt/credential 由恢复流程在同一轮收敛。

### 9.3.1 Durable response stream

- dispatch 事务内：attempt + processing R + TurnExecution core + credential 原子创建；
  attempt `response_message_id` 从 attempt start 就非空，`settlement='streaming'`。
- stream delta/tool event 只写 `response_drafts`，不产生 per-delta message，不消耗 `messages.seq`。
- processing R 不推进 `deliveryCursor` 越过它；R terminal 后才允许 ack。
- bounded flush（100ms/4KB）后 draft 可被刷新/重连读取；`message_end` 用最终值覆盖，不重复。
- child terminal 同事务：TurnExecution terminal + attempt terminal +
  attempt `settlement='response_pending'` + parent aggregate + credential terminalize。
- settlement：R `processing → terminal`（content/contentBlocks/toolEvents/thinking 来自 draft）
  + input `dispatchRefs` settle + delete draft + attempt `settlement='settled'` +
  `clearResponsePending`。
- crash 在 child terminal 与 R settlement 之间：重启后 `listResponsePending` 必须把 R 提交为
  child 的终态；R 已 terminal 则只清 pending；不留下 orphan processing R。
- provider 失败/中断/取消：R 以 failed/interrupted/canceled + reason + 已 stream 的正文结束；
  prestart 未创建 R 时才写 `delivery_failure`。
- retry 产生新 attempt/R/draft；旧 attempt 的 R 和 draft 不可改写。

### 9.4 Auth

- credential 只能绑 child TurnExecution；一个 child 一个 active credential。
- `verify` 校验 token hash/salt、state、expiry、child running、parent 未 canceled、tool allowed。
- 不在 allowedTools 的 tool → forbidden。
- child terminal → credential terminalize。
- child 不存在/terminal 但 credential active → canonical repair terminalize/revoke。
- token 不出现在 TurnExecution/InvocationRecord/UI 读取面。

### 9.5 A2A

- operator 行首 @ → agent targets；agent tools → operator target 只通知；两个方向共用 `QueueTarget`。
- 无 @ 的 operator message 按隐式链解析；`targetAgentIds` 持久化在 user message。
- `post_message` 创建新 message + queue entry + parent；child `a2aParentTurnExecutionId`/`a2aDepth` 正确。
- `cross_post_message` 跨 thread 同 user；不同 user 拒绝。
- `thread_context` 只读，不入队。
- depth > 15 拒绝。
- 不存在 `a2a_send`/`handoff_*` 注册。

### 9.6 恢复 / 读模型

- daemon 重启：`interruptRunningBefore` 收敛进程启动前的 running TurnExecution →
  interrupted/process_restart；parent aggregate；credential terminal。
- TTL zombie → interrupted。
- running TurnExecution 无 live worker/heartbeat → `interrupted/owner_reaped`；释放 tracker slot。
- `getThreadLiveInvocations` 返回 tracker + durable running child。
- `response_pending` 在重启后由 startup reconciler 结算；draft 删除、pending 清空。
- `MessageDispatchSummary` 正确显示 targets/running/completed/failed/canceled。
- v1 不测 trajectory projector（未实现）。

### 9.7 真实模型 E2E

- 多 agent @：一个 message、一个 parent、N child、N response；parent completed/partial_failed。
- 一个 target 失败：parent partial_failed；重试只补失败 target；成功后 completed。
- A2A hop：child A post 给 C；C 的 parent/depth 正确；深度限制生效。
- daemon 重启：running child 收敛；live 列表正确。
- 迁移：task-first 数据 legacy；新 runtime 不读。

### 9.8 userId invariants

- Thread owner → Session → InvocationRecord → TurnExecution → Credential → response_draft
  的 owner 链一致；任一不一致 fail closed。
- `InvocationAttempt` / `StoredMessage` / `AgentReadState` 不存 userId；从 parent/thread
  派生；调用方 userId 与派生值冲突时拒绝。
- 跨 user thread access 拒绝；system message/queue entry 不伪造 userId。
- 完整矩阵见 `0011-identity-contract.md` §11。

## 10. Clowder 映射

| Clowder | codeteam v1 | 关系 |
|---|---|---|
| `Message` + `InvocationQueue` + `QueueLedger` | `Message` + `invocation_queue` + `SqliteQueueLedgerStore` + `InvocationQueue` | 复用/改名；v1 轻量 |
| `QueueProcessor` + `QueueEntry` | `QueueProcessor` + `QueueEntry` | 复用；拆分 DispatchService |
| `InvocationRecordStore` + `InvocationRecord` | `InvocationRecordStore` + `InvocationRecord` | 复用；v1 轻量 |
| `InvocationTracker` + `InvocationOwnerReaper` | `InvocationTracker` + `InvocationOwnerReaper` | 复用；start 抢占 + worker heartbeat |
| `AgentRouter` + `routeSerial/routeParallel` | `AgentRouter` + `runAgentTurn` + `routeAgents(mode)` | per-agent pipeline 抽出；serial 薄循环 |
| `invoke-single-cat` + `TurnExecutionStore` + `TurnExecutionRecord` | `invoke-single-agent` + `TurnExecutionStore` + `TurnExecution` | 复用；pi runtime |
| `InvocationRegistry` | `InvocationRegistry` + `InvocationCredential` | 复用；MCP → pi extension |
| `a2a/tools` + MCP | `a2a/tools` (pi extension) + control socket | 复用语义；换 transport |
| `PerCatTerminalDispositionCollector` + `transitionTerminal` + `QueueProcessor` | `PerAgentTerminalDispositionCollector` + `transitionTerminal` + `QueueProcessor` | 复用；v1 单事务 |
| `TurnExecutionStartupReconciler` / `ZombieTerminalRecovery` / `InvocationTrajectoryProjector` / `getThreadLiveInvocations` | `InvocationStartupReconciler` / `InvocationReaper` / 简单 timeline / `ThreadLiveInvocations` | 复用骨架；v1 轻量 |

> 命名：Clowder TurnExecution 的 `succeeded` 在 codeteam 用 `completed`
> （与现有 `runs`/0005 一致）；其余 `failed/interrupted/canceled` 同名。

## 11. 决策记录

1. **直接复用 Clowder A2A runtime 骨架**，不另造 child-only 链路；10 个组件按 Clowder 结构。
2. **`routeSerial` 单体实现删除**：per-agent pipeline 抽成 `runAgentTurn`；`routeAgents(mode)` 保留 parallel/serial 薄循环；静态 worklist 不 push target，A2A hop 是新 queue entry。
3. **Parent 在 QueueProcessor claim 后创建**：queue entry 是 admission/待处理账本；parent 是处理生命周期。
4. **`TurnExecutionStore.createRunning` 是 provider 前幂等入口**：created/replayed/conflict；replayed 不授予第二次 provider lease。
5. **`TurnExecution` 使用 `invocationRecordId`（fan-out parent）+ `causal.a2aParentTurnExecutionId`（A2A 因果父）两个坐标**，不共用一个 parent。
6. **Auth 从 MCP callback 改为 pi extension tool capability**：credential 绑 child TurnExecution，allowedTools 限 A2A tools；MCP/task/role/run 字段删除。
7. **终态同事务**：child terminal + attempt terminal + parent aggregate + credential
   terminalize；另用 responsePending ledger 把 R settlement 作为可恢复的第二段提交。
8. **Session active-only**（0009）：v1 不做 sealed/compression/handoff。
9. **v1 不做 custody/action/wait/compaction/managed/collective**；全部 v2。
10. **QueueEntry 多層次设计**：`owner/from/targets/payload/execution/delivery/claim` 分组；targets 是 `QueueTarget[]`（agent/operator）。
11. **operator 对话只解析行首 `@`**；多个 @ 去重；未知/disabled typed reject；无 @ → 隐式路由链，只有无候选才 `no_target`。
12. **operator-only 允许只通知不执行**：不创建 parent/TurnExecution，只写 `delivery.operatorNotifiedAt` 并删除 queue entry。
13. **claim 复用 Clowder 的 target-level 语义**：`claim` / `retireTargets` / `releaseClaim` / `withdrawTargets`；`claim.targetKeys` 是 pending targets 子集。
14. **QueueEntry 保留 admission 正文快照** `payload.content`；A2A tools 的 targets 用 `{kind:"agent"|"operator", id}` 对象数组，不解析正文 @。
15. **v1 路由/解析错误不走 audit**：pre-admission typed reject；admitted 后失败写
    `delivery_failure` system message；QueueEntry 不存 `routingWarnings`/`lastError`。
16. **Queue durable/projection 状态分层（DP-F018Q-2=B）**：`QueueLedgerStatus` 保留四值 union；`QueueEntry.status` 只取 `queued|claimed`；`processing|terminal` 只出现在 transition projection。
17. **QueueLedgerStore + InvocationQueue 接口（DP-F018Q-1=A）**：store 只做持久化/CAS；InvocationQueue 负责 admission/claim/retire/release/withdraw/recovery；`claimNext` 从服务接口移除，候选选择留在 QueueProcessor。
18. **重放保护（DP-F018Q-3=A）**：新增 `queue_admissions` receipt；live row 删除后按 fingerprint 返回 `replayed`/`conflict`。
19. **删除 `invocation_queue.invocation_record_id`**：parent 通过 `invocation_records.source_record_id` + `invocation_attempts.queue_entry_id` 关联。
20. **QueueProcessor v1 方法面**：`requestDrain` / `processNext` / `drain` / `processEntry` / `recoverStartup` / `onInvocationComplete`；候选选择用 `InvocationQueue.listQueued` + `claim`，`claimNext` 只是内部 helper。
21. **`processEntry` 同事务边界**：parent + attempt + TurnExecution + processing R + credential + `retireTargets` 同事务；provider 启动在事务外。
22. **v1 自动重试边界（2026-11-10 由 #41 细化）**：不对已终态失败的 target 自动重跑；pre-handoff 仍 pending 的失败按 bounded backoff 自动重试。显式 retry 由 `requestRetry` 追加 attempt+1，不新建 queue entry。
23. **QueueProcessor 删除 Clowder 扩展面**：append lifecycle、Steer、continuation、live companion、freshness、auto-resume suppression、prestart processing groups、batching、caller dispatch observations。
24. **全局身份契约（0011）**：`sourceRecordId + admission attempt → queueEntryId`；`invocationRecordId`（parent）；`turnExecutionId`（child）；`attemptId`（target attempt）；`credentialId`（auth）；`causal.a2aParentTurnExecutionId`（因果父）；A2A runtime 禁用 `sourceMessageId` / `sourceId` / 裸 `invocationId` / `parentInvocationId` / `entryId` / parent `idempotencyKey`。
25. **InvocationRecord 状态/字段**：保留 `partial_failed`；只存 `successfulAgentIds`，failed/canceled 由 `invocation_attempts` 每个 target 的最新 attempt 推导；`requestRetry` 把 parent 置 `queued`，retry child 启动后再 `markRunning`。
26. **InvocationRecord usage**：parent 存 `usageByAgent`（跨 attempt 累计）+ `usageRecordedAt`（首次写入）；`invocation_attempts.usage` 存 per-attempt 用量；collector 汇总后由 `applyTerminalAggregate` 写入。
27. **Tracker start 抢占（DP-F018T-1=B）**：同 slot 旧 controller 先发中断信号，旧 TurnExecution 标 `interrupted/preempted`；新 slot 立刻登记。普通消息默认不抢占，只有显式 Steer/停止动作走抢占。
28. **取消即释放 slot（DP-F018T-2=B）**：tracker 不保留 canceled 墓碑；真正的执行互斥由 `TurnExecution` 唯一 running + `RpcConnection.prompting` + worker binding generation 承担；旧 worker 未退出时新 start 返回 `worker_busy`。
29. **僵尸判定用 worker heartbeat（DP-F018T-3=A）**：running TurnExecution 无 live worker/heartbeat 才标 `interrupted/owner_reaped`；被抢占但旧 worker 还活着的 child 保留到旧 worker 结束。
30. **Operator ingress 路由（DP-F018R-1=A）**：行首 @ 是 operator 侧 A2A admission；无 @ → 上一 human `targetAgentIds` → 最近成功 replier → participant → default agent；都没有才 `no_target`。
31. **StoredMessage.targetAgentIds（DP-F018R-2=A）**：仅 user message 持久化本次 admission 的 agent targets；与 message + queue entry 同事务写入；agent-authored A2A targets 走 `lifecycle.dispatchRefs`。
32. **runAgentTurn + routeAgents（DP-F018R-3=A）**：per-agent pipeline 抽成 `runAgentTurn`；v1 默认 parallel，serial 是同一 pipeline 的薄循环；route 只负责顺序/并发。
33. **Session 服务分层（2026-11-09 Q&A；2026-11-10 Worker 定稿）**：
    `AgentSessionStore`（durable identity）+ `WorkerPool`（ephemeral worker）+
    薄 `AgentSessionManager`；`invocation_attempts.agentSessionId` 只是指针。
34. **Message lifecycle 是 durable 投递回执（2026-11-09 Q&A；2026-11-10 更新）**：
    `StoredMessage.lifecycle` 的 input 存 typed `dispatchRefs`（target/queueEntryId/
    attempt/phase/responseMessageId/turnExecutionId）；response 存 parent/child/target/终态；
    queue live row 保留到 target attempt 终态，parent `completed`/`canceled` 后删除；
    `partial_failed`/`failed` 保留为 retry anchor；`queue_admissions` 只做 admission 幂等。
35. **Delivery cursor（2026-11-09 Q&A）**：v1 新增 `agent_read_state.delivery_cursor`，
    按 `(threadId, agentId)` 存 thread-global seq 的已消费位置；fetch-after + filter +
    monotonic ack；不做 per-target cursor / seenCursor。
36. **Response settlement（2026-11-09 Q&A；2026-11-10 由 #42 改为 B）**：v1 采用
    processing R + `response_drafts` + attempt `settlement`；child terminal 与 R terminal
    分开提交；`settleResponseFromDraft` 补提交；startup reconciler 恢复。
37. **Worker v1（2026-11-10 拍板）**：worker 是 ephemeral execution carrier；pi v1
    `capacity=1`、一个 worker 一 session；`warmTtl=0`、`maxLiveWorkers=8`；不建
    per-turn `worker_leases`；session 不持有 worker；spawn 实测约 0.5s，不作为常驻理由。
38. **Message 单层（2026-11-10 拍板）**：v1 不定义 domain `Message`；`StoredMessage` 是
    唯一消息记录（from/content/contentBlocks/toolEvents/lifecycle/replyTo/seq/timestamp/
    updatedAt/thinking/deletedAt/deletedBy/extra{kind,targetAgentIds,rich,crossPost}）；
    `MessageStore` 持久化/返回 `StoredMessage`；无 userId/status/deliveryStatus/mentions。
39. **delivery_failure lifecycle（2026-11-10 拍板；B 修订）**：只有 dispatch 事务未创建
    processing R（createRunning/credential/R 创建失败）时，才追加独立 system message
    （`from.service='message_delivery'`），lifecycle 记 `inputMessageId/requestedTargets/
    reason`；同时 settle source dispatchRefs。R 已创建后的失败走 R terminal settlement。
40. **DP-F018X-1=A（2026-11-10 拍板）**：`startedAt` 不进 `createRunning` identity；
    identity 用 `turnExecutionId + invocationRecordId + threadId + userId + agentId +
    executionKind + causal`；`turnExecutionId` 必须可重放（确定性派生或持久化），
    crash 后同身份必须命中 `replayed`。
41. **retry 采用 Clowder 逻辑（2026-11-10 拍板）**：新增 append-only
    `invocation_attempts`；retry 单位是 target attempt，同 parent/同 source message/
    同 queue entry，不重新 admission；已终态失败只接受显式 `requestRetry` 追加
    attempt+1；pre-handoff pending target 用 process-local bounded backoff（base 10s、
    上限 1h）自动重试；queue entry 保留到 attempt 终态。
42. **DP-F018X-2=B（2026-11-10 拍板）**：v1 采用 durable streaming；attempt start 创建
    processing R，`response_drafts` 承接 stream，child terminal 把 attempt
    `settlement` 标 `response_pending`，settlement 提交 R terminal + settle inputs +
    attempt `settled`；startup reconciler 恢复。
    Clowder 的 `outputFence`/`appendAcceptance` 仍留 v2。
43. **DP-F018TE-1=A（2026-11-10 拍板）**：`TurnExecution` 收敛为 Clowder core +
    `causal`；execution binding/snapshot/retry trace/response settlement 全部移到
    `invocation_attempts`；`TurnExecutionStore` 补 `interruptRunningBefore`，
    `completeResponseSettlement` 改名 `clearResponsePending`。v2 再做
    `coveredMessageIds`/`outputFence`/`listBySource`/`settleOutputFence`。
