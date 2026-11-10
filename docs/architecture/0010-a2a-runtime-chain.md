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
5. **`TurnExecutionStore.createRunning` 是执行幂等入口**：`created/replayed/conflict`；provider 启动前必须有 child + credential。
6. **终态路径只有一条**：`transitionTerminal` → `PerAgentTerminalDispositionCollector` → parent aggregate → credential terminalize，同一事务。
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
- **terminal 原子性**：child terminal + parent aggregate + credential terminal 必须同事务；失败则回滚。
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
                  → TurnExecutionStore.createRunning
                  → InvocationRegistry.create（credential）
                  → pi worker / provider
                  → TurnExecution.transitionTerminal
                  → InvocationRegistry.commitTerminal
                  → PerAgentTerminalDispositionCollector
                  → InvocationRecordStore.applyTerminalAggregate
      → QueueProcessor remove target / release tracker
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
- `agent` target → 创建 `TurnExecution`，调用 pi worker。
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
- `userId` 不存 message：thread owner 派生；v1 单 user。
- `status` 不存 StoredMessage：持久消息即 complete；展示/流式状态由读模型投影。
- `deletedAt` / `deletedBy` 保留软删除；`deliveryStatus` 不存（queue/lifecycle 派生）；
  `_tombstone` / `recall` v1 不做。
- `mentions` / `mentionsUser` 不存：A2A targets 是 typed `dispatchRefs`；
  文本 `@` 不路由；UI 从 dispatchRefs 渲染目标。
- `lifecycle` 是 server-owned typed sidecar；**不要**塞进 `extra`。
- `input` 的 `dispatchRefs`：`dispatched` → `settled`；同一
  `(target, queueEntryId, attempt)` 唯一，重放不得二次 dispatch。
- `response` lifecycle 记录 parent/child/target/终态；response 状态用 CAS 推进。
- `delivery_failure` 是 **独立 system message**（`from.kind='system'`,
  `service='message_delivery'`）：记录 `inputMessageId` / `requestedTargets` / `reason`；
  source 的 dispatchRefs 同时 settle；不创建 response/TurnExecution。
- `audit` 是 task-first 遗留的运维日志（actor/action/subject/args/ts），不属于 A2A
  message/lifecycle 契约，也不作为 delivery_failure 的替代；A2A 失败面只看
  `delivery_failure` 消息 + `TurnExecution`。
- queue live row 删除后，读模型仍可从 `StoredMessage.lifecycle` + `turn_executions` 还原
  “发给了谁、谁处理、对应哪条 response”；`queue_admissions` 只负责 admission 幂等。
- v1 不做 Clowder 的 `appendAcceptance` / `inputRead` / `coveredMessageIds`；
  这些属于 durable streaming 与 carrier 审计，v2 再加。

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
  `invocationRecordId/turnExecutionId/target/status/startedAt`。
- `appendIdempotent`：与 `append` 相同，但按 `id`/幂等键返回 `replayed`；不同 payload → conflict。
- `advanceLifecycleInputDispatch`：按 `(targetKey, queueEntryId, attempt)` 精确匹配；
  只允许 `dispatched → settled`；同 phase 同 payload = idempotent no-op。
- `commitLifecycleResponseTerminal`：只允许 response lifecycle；status 只能
  `processing → completed|failed|interrupted|canceled`；terminal 后不可改。
  v1 若 response 在 terminal 才创建，可直接用 `append` + response lifecycle；
  该方法是 Clowder 对齐入口，给未来 streaming/processing response 用。
- `commitLifecyclePreAdmissionFailure`：同事务追加 system message（`from.kind='system'`,
  `service='message_delivery'`）+ settle source 的 `dispatchRefs`；reason 必须是
  `no_target/unknown_agent/agent_disabled/account_missing/thread_deleted/worker_capacity/
  worker_start_failed/credential_mint_failed`。
- `updateExtra`：更新 `extra`（kind/targetAgentIds/rich/crossPost）；CAS 可选。
- `softDelete`：写 `deleted_at/deleted_by`；不改 `seq`/lifecycle；默认读排除删除行。
- `getBy*` 默认 `deleted_at IS NULL`；`includeDeleted` 给 read model 用。
- **不拥有** queue/cursor/session；不做可见性过滤；`seq` 只保证 thread 内顺序。

**事务边界**

| 场景 | 同一事务 |
|---|---|
| admission | `append` + `InvocationQueue.enqueue` + `queue_admissions` |
| dispatch | `advanceLifecycleInputDispatch(dispatched)` + parent/child/credential + `retireTargets` |
| response settlement | `append`（terminal response）或 `commitLifecycleResponseTerminal` + `advanceLifecycleInputDispatch(settled)` + `transitionTerminal` + parent aggregate + credential |
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
- Clowder 的 `appendWithQueueLedgerAdmission` 是 message+queue 的原子便捷方法；
  codeteam 用可重入 `ControlTransaction` 包住 `append` + `InvocationQueue.enqueue`
  达到同一语义，不复制一个依赖 queue store 的复合方法。
- Clowder 的 response 是 streaming 的 processing row → terminal；
  codeteam v1 response 在 terminal 一次 append。`commitLifecycleResponseTerminal`
  保留给未来 processing/streaming response；v1 可用 `append` + response lifecycle。

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
5. 每个 agent target：`TurnExecutionStore.createRunning` + `InvocationRegistry.create`；
6. **同一事务**：parent + children + credentials + `retireTargets(claimId, 已派发/已通知 targetKeys)`；
7. 事务外：启动 provider（pi worker）；
8. child terminal → `PerAgentTerminalDispositionCollector` → parent aggregate → credential terminalize；
9. operator-only：不创建 parent/child；通知后 retire，全部移除则删除 entry；
10. 异常/超时 `releaseClaim(claimId)`；不要把 operator-only 当失败。

**不变量**

- `retireTargets` 与 parent/child/credential 同事务；provider 启动在事务外。
- provider 启动前失败：child `transitionTerminal(failed)` + parent aggregate + credential terminalize；queue target 已 retire，重试走新 queue entry。
- parent `sourceRecordId` unique；child `createRunning` 幂等；重放不会二次执行。
- operator notification 先写 durable `operatorNotifiedAt`，socket emit 在 commit 后；emit 失败不影响消息可见性。

**v1 不做**
- Clowder 的 batching、caller dispatch observations、action successor、wait continuation、cloud bridge、multi-user grouping。
- append lifecycle、Steer、continuation、live companion、freshness、auto-resume suppression、prestart processing groups。
- v1 一个 queue entry 的 targets 直接并行 dispatch；不自动重试失败 target。

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
  requestRetry(invocationRecordId: string, now?: number): InvocationRecord | null;
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

- `successfulAgentIds` 是唯一成功见证；`failedAgentIds`/`canceledAgentIds` 由 `TurnExecution` 最新 attempt 推导，不在 parent 存储。
- `usageByAgent` 按 `agentId` 跨 attempt 累计；`applyTerminalAggregate` 接收的是**累计值**，不是 delta。
- `usageRecordedAt` 只在第一次写入 usage 时设置；之后不覆盖（backfill 显式传入除外）。
- `requestRetry` 保留 `usageByAgent`/`usageRecordedAt`；status `failed|partial_failed → queued`，`retryCount++`，清 `endedAt`/`terminalReason`。
- retry 的 queue entry `attempt = retryCount + 1`；parent 在 retry child 启动后由 `markRunning` 进入 running。

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
- usage 按 child `TurnExecution.usage` 汇总到 `usageByAgent`；不在 parent 存 failed/canceled 列表。

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
- **真正的执行互斥在 `TurnExecution` + worker binding**：`turn_executions` 对同一 `agent_session_id` 只允许一条 `running`；`RpcConnection.prompting` 保证进程单飞；旧 worker 未退出时新 start 返回 `worker_busy`，QueueProcessor 释放 claim 稍后重试。
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
5. operator 可 retry：新 attempt → 新 queue entry → 新 child
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
  3. TurnExecution.createRunning（同 session 唯一 running）
  4. workerPool.ensure（ephemeral；spawn ~0.5s）
  5. InvocationCredential.create
  6. build context + prompt
  7. invoke pi worker
  8. persist response + usage
  9. transitionTerminal + collector + parent aggregate + credential terminalize
 10. retire worker（warmTtl=0）/ release tracker slot
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
3. `TurnExecutionStore.createRunning`（幂等；同 session 唯一 running）；
4. `workerPool.ensure`（ephemeral；spawn ~0.5s；pi v1 一 worker 一 session）；
5. `InvocationRegistry.create`（credential）；
6. build context（thread/participants/recent messages/priorResponses；delivery cursor 见 §3.5.1）+ build prompt（system + history + context）；
7. invoke pi worker（stream events）；
8. persist response message + usage；
9. `transitionTerminal` + collector + parent aggregate + credential terminalize
   （v1 同一事务；未来 response_pending 路径见 §3.6）；
10. retire worker（warmTtl=0）+ release tracker slot。

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

- **cursor 是全局可见序，不是“发给这个 agent 的最后一条”**：A 的 cursor 会越过对 A
  不可见的定向消息；B 仍会在自己的 cursor 位置看到它。不需要 per-target cursor。
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

- `TurnExecution` 唯一 running per session：
  `CREATE UNIQUE INDEX turn_executions_one_running_per_session ON turn_executions(agent_session_id) WHERE status = 'running';`
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

**v1 `TurnExecution`**

```ts
interface TurnExecution {
  turnExecutionId: string;
  invocationRecordId: string;        // parent 消息生命周期
  threadId: string;
  userId: string;
  agentId: string;
  agentSessionId: string;
  workerId: string | null;             // runtime trace；worker 是 ephemeral

  a2aParentTurnExecutionId: string | null; // A2A 因果父（上游 TurnExecution）
  queueEntryId: string | null;
  attempt: number;

  triggerMessageId: string;
  a2aTriggerMessageId: string | null;
  a2aDepth: number;

  executionKind: "ordinary" | "routing_guard";
  provider: string;
  model: string;
  modelFamily: string;

  status: "running" | "completed" | "failed" | "interrupted" | "canceled";
  settlement: "settled" | "response_pending"; // v1 恒 settled；pending 是未来异步 response 的 seam
  responseMessageId: string | null;
  terminalReason: string | null;
  usage: TokenUsage | null;      // provider 返回的本 attempt 用量

  startedAt: number;
  endedAt: number | null;
}
```

**`TurnExecutionStore` v1**

```ts
createRunning(input): { outcome: "created" | "replayed" | "conflict"; record: TurnExecution };
transitionTerminal(turnExecutionId, input): { outcome: "transitioned" | "already_terminal" | "not_found"; record: TurnExecution | null };
listResponsePending(): TurnExecution[];
completeResponseSettlement(turnExecutionId, responseMessageId): {
  outcome: "settled" | "already_settled" | "not_pending" | "not_found";
  record: TurnExecution | null;
};
get(turnExecutionId);
listByInvocationRecord(invocationRecordId);
listRunning();
```

- 唯一约束：`turnExecutionId`、`(invocationRecordId, agentId, attempt)`、`responseMessageId`（非空时）。
- `createRunning` 的 identity = parent + agent + attempt + queueEntryId + trigger；不一致即 conflict。
- `replayed` 时 `invoke-single-agent` 不启动 provider，按 duplicate 处理。
- `transitionTerminal` 只允许一次；`completed + ordinary` 在 `settled` 时必须有
  `responseMessageId`、在 `response_pending` 时必须为 null；`routing_guard + completed`
  必须为 null；`failed/interrupted/canceled` 必须有 `terminalReason`。
- v1 不做 `causal.coveredMessageIds`、`outputFence`、`queueCompletionPolicy`；保留 `triggerMessageId`/`a2aTriggerMessageId`/`a2aDepth`。

**Response settlement seam**

v1 的 response 与 terminal 在同一个 SQLite 事务里完成（`settlement = "settled"`）。
但 provider/append 未来可能跨进程或跨存储，不能假设永远能同事务；schema 预留 pending 路径：

```text
v1（response 已持久化）：
  messages.append(response)
  → transitionTerminal(completed, responseMessageId, settlement="settled")
  → parent aggregate + credential terminalize        // 同一事务

未来（response 不能同事务）：
  → transitionTerminal(completed, responseMessageId=null, settlement="response_pending")
  → response 异步落库 / provider 确认
  → completeResponseSettlement(turnExecutionId, responseMessageId)
  → parent aggregate + credential terminalize
```

- `settled` 的 `completed + ordinary` 必须有 `responseMessageId`；`response_pending` 时必须为 null。
- `listResponsePending()` 是恢复入口；`InvocationStartupReconciler` 重启后扫描 pending 并补结算。
- parent aggregate 和 credential terminalize 只在 `settled` 后发生；`response_pending` 的 child
  不参与“completed 但无 response”的聚合。
- v1 不实现 durable streaming / `appendAcceptance` / 完整 responsePending recovery ledger；
  只保留字段、list/complete API 和恢复入口。

**`invoke-single-agent` 顺序**
1. 从 AgentConfig/AccountConfig 解析 provider/model/modelFamily；
2. ensure `AgentSession`（active-only）+ worker；
3. 生成 `turnExecutionId`；
4. `TurnExecutionStore.createRunning`（durable）；
5. `InvocationRegistry.create`（credential，绑 child id）——codeteam 因 FK 先 child 后 auth；Clowder 是 auth-first，但“两者都在 provider 之前”不变；
6. provider/prompt/stream；
7. persist response + `transitionTerminal` + collector + parent 聚合 + credential terminalize
   （v1 同一事务；未来 response_pending 路径见本节）。

若第 4/5 步失败：不启动 provider；child 若已创建则 `transitionTerminal(failed,
terminalReason='turn_admission_failed'|'credential_mint_failed')`，并更新
parent aggregate；credential 若已创建则 terminalize。

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
5. 若有 agent targets：child `a2aParentTurnExecutionId` = caller `turnExecutionId`，`a2aTriggerMessageId` = 新 message，`a2aDepth` = caller.depth + 1；
6. operator-only：不创建 parent/TurnExecution；只通知并删除 queue entry；
7. 超过 15 拒绝。

**v1 不做**
- `a2a_send`、`handoff_*`、multi_mention 聚合回调、cross-thread custody。
- `multi_mention` 如果保留，按普通多 target post 处理，不做聚合回调。

### 3.9 PerAgentTerminalDispositionCollector + transitionTerminal + QueueProcessor

**正常终态路径**

1. child 执行结束：
   - `TurnExecutionStore.transitionTerminal(turnId, { status, endedAt, responseMessageId?, terminalReason })`；
   - 只允许一次；返回 child 终态。
2. `PerAgentTerminalDispositionCollector`：
   - 输入 parent `targetAgentIds` + 该 parent 下所有 child 的**最新 attempt**；
   - 产出 `successfulAgentIds` + parent status；`failedAgentIds`/`canceledAgentIds` 只是派生视图，不写 parent。
3. `QueueProcessor`：
   - 在 child terminal 的同一事务里调用 collector；
   - 写 parent aggregate；
   - terminalize credential；
   - parent 进入终态时移除 queue entry / 释放 tracker slot。

**聚合规则**

| 条件 | parent status |
|---|---|
| 首次 attempt 还没有 child 开始且 retryCount=0 | `queued` |
| 任一最新 child running，或还有 target 没有 child | `running` |
| 所有 target 最新 child completed | `completed` |
| ≥1 completed + ≥1 failed/interrupted/canceled，且无 running | `partial_failed` |
| 0 completed，且所有 target failed/interrupted/canceled，且无 running | `failed` |
| operator 取消整个消息 | `canceled` |

- `interrupted` 归入失败面（可重试）；`canceled` 归入取消面。
- `successfulAgentIds` 单调递增；failed/canceled 由每个 agent 最新 attempt 推导。
- `requestRetry` 受理后 parent 进入 `queued`；retry child 创建并启动后由 `markRunning` 进入 `running`。

**重试**
- 只允许重试 `targetAgentIds - successfulAgentIds`；
- parent `partial_failed | failed → queued`，`retryCount+1`；
- 为失败 target 创建新 queue entry，`attempt = retryCount + 1`；
- 新 child attempt = 新 queue entry attempt；
- 已成功的 agent 永不重跑。

**v1 不做**
- `usage` 由 collector 汇总到 parent `usageByAgent`；不做 action fence 聚合、response pending ledger。
- v1 用一个事务保证 child terminal + parent aggregate + credential terminal；response 未提交则 child 不能 completed。

### 3.10 StartupReconciler / ZombieTerminalRecovery / TrajectoryProjector / LiveInvocations

**9) 和 10) 的关系**：9) 是正常终态路径；10) 是异常/重启/读模型路径；两者共用 `TurnExecution.status` 和 parent aggregate。

1. **TurnExecutionStartupReconciler**
   - daemon 启动时扫描 `status='running'` 的 TurnExecution；
   - 没有 tracker slot / worker / heartbeat → `transitionTerminal(interrupted, terminalReason='startup_reconcile')`；
   - 更新 parent aggregate；terminalize credential。
2. **ZombieTerminalRecovery**
   - 定时扫描 running 超过 TTL 且无 owner 的 TurnExecution；
   - 标 `interrupted`；更新 parent；terminalize credential。
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
- Clowder 的 exact owner lease、zombie terminal 复杂判定、trajectory projector、response-pending ledger。
- 用“startup reconcile + TTL reaper + child status”覆盖 v1 的快速 E2E。

## 4. 数据模型

> 建表顺序：`invocation_records` → `invocation_queue` → `queue_admissions` → `turn_executions` → `invocation_credentials`。
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
    CHECK (json_valid(targets_json) AND json_type(targets_json) = 'array'
           AND json_array_length(targets_json) > 0),
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
  ON invocation_queue(thread_id, status, priority, position, enqueued_at, queue_entry_id);
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

- `targets_json` 是 **pending `QueueTarget[]`**；`payload_json.requestedTargets` 是 admission 全量快照。
- `payload_json` 含 `sourceRecordId/messageId/originRecordId/attempt/content/requestedTargets/requestId`；`content` 是 admission 正文快照。
- `source_record_id` 是队列身份；`message_id` 是消息指针（v1 恒非空，未来 connector 可为 null）；`attempt` 是 1-based 尝试序号。
- `execution_json` 含 `a2aParentTurnExecutionId/a2aTriggerMessageId/a2aDepth`。
- `delivery_json` 含 `operatorNotifiedAt`；operator-only entry 没有 parent/TurnExecution。
- `claim` 在 TS 模型里是子对象；SQL 用 `claim_*` 标量 + `claimed_target_keys_json` 做 CAS，语义是 target-level claim。
- `status` 只持久化 `queued | claimed`；`processing | terminal` 只出现在 transition projection，不落库。
- `queue_admissions` 是 admission receipt：live row 删除后，同一 `(source_record_id, attempt)` 重放仍返回 `replayed`/`conflict`。
- queue entry 可以在全部 target dispatch 后删除；`turn_executions.queue_entry_id` 仍是 trace 字符串。

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
- `user_message_id` 是 parent 的用户消息指针；v1 = `messageId`，未来 connector 可为 null。
- `target_agent_ids_json` 是 admission 快照，不可变。
- `successful_agent_ids_json` 单调递增；failed/canceled 不落库，由 child 最新 attempt 推导。
- `usage_by_agent_json` 是按 agent 的累计 usage；`usage_recorded_at` 首次写入时间，稳定分桶。
- `status`/`ended_at`/`terminal_reason` 由 collector 与 child terminal 同事务更新。

### 4.3 `turn_executions`

```sql
CREATE TABLE turn_executions (
  turn_execution_id TEXT PRIMARY KEY,
  invocation_record_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  worker_id TEXT,
  a2a_parent_turn_execution_id TEXT,
  queue_entry_id TEXT,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),

  trigger_message_id TEXT NOT NULL,
  a2a_trigger_message_id TEXT,
  a2a_depth INTEGER NOT NULL DEFAULT 0 CHECK (a2a_depth >= 0),
  execution_kind TEXT NOT NULL CHECK (execution_kind IN ('ordinary', 'routing_guard')),

  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  model_family TEXT NOT NULL,

  status TEXT NOT NULL CHECK (
    status IN ('running', 'completed', 'failed', 'interrupted', 'canceled')
  ),
  settlement TEXT NOT NULL DEFAULT 'settled'
    CHECK (settlement IN ('settled', 'response_pending')),
  response_message_id TEXT,
  terminal_reason TEXT,
  usage_json TEXT
    CHECK (usage_json IS NULL OR
           (json_valid(usage_json) AND json_type(usage_json) = 'object')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,

  CHECK (status = 'running' OR ended_at IS NOT NULL),
  CHECK (status = 'running' OR terminal_reason IS NOT NULL OR status = 'completed'),
  CHECK (
    status <> 'completed' OR execution_kind <> 'ordinary' OR
    response_message_id IS NOT NULL OR settlement = 'response_pending'
  ),
  CHECK (status <> 'completed' OR execution_kind <> 'routing_guard' OR response_message_id IS NULL),
  CHECK (settlement = 'settled' OR (status = 'completed' AND execution_kind = 'ordinary')),
  CHECK (a2a_trigger_message_id IS NULL OR a2a_parent_turn_execution_id IS NOT NULL),
  UNIQUE (invocation_record_id, agent_id, attempt),
  FOREIGN KEY (invocation_record_id) REFERENCES invocation_records(invocation_record_id) ON DELETE RESTRICT,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE SET NULL,
  FOREIGN KEY (a2a_parent_turn_execution_id) REFERENCES turn_executions(turn_execution_id) ON DELETE SET NULL,
  FOREIGN KEY (trigger_message_id) REFERENCES messages(id) ON DELETE RESTRICT,
  FOREIGN KEY (a2a_trigger_message_id) REFERENCES messages(id) ON DELETE RESTRICT,
  FOREIGN KEY (response_message_id) REFERENCES messages(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX turn_executions_invocation
  ON turn_executions(invocation_record_id, agent_id, attempt);
CREATE INDEX turn_executions_running
  ON turn_executions(status, started_at);
CREATE UNIQUE INDEX turn_executions_one_running_per_session
  ON turn_executions(agent_session_id) WHERE status = 'running';
CREATE UNIQUE INDEX turn_executions_response
  ON turn_executions(response_message_id) WHERE response_message_id IS NOT NULL;
CREATE INDEX turn_executions_response_pending
  ON turn_executions(settlement) WHERE settlement = 'response_pending';
```

- `queue_entry_id` 不加 FK：queue entry 是调度账本，dispatch 后可删除；字符串仍可 trace。
- `worker_id` 是运行时审计字段；worker retire 后置 NULL，不参与 session identity。
- 同一 `agent_session_id` 最多一条 `running` TurnExecution；这是会话级执行互斥。
- `a2a_parent_turn_execution_id` 是 A2A 因果父，不是 fan-out parent；fan-out parent 是 `invocation_record_id`。
- `usage_json` 是本 attempt 的 provider 用量；collector 汇总所有 attempt 到 parent `usageByAgent`。
- `provider/model/model_family` 是执行快照；Session 不再持有模型。
- `a2a_depth` 用于 loop guard；A2A child = parent.depth + 1。
- `settlement='settled'` 是 v1 常态；`response_pending` 只给未来异步 response 的 seam，
  v1 不产生该值，但 schema/恢复入口现在就固定，避免以后重建表。

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
- `ack` 用单调 CAS：`INSERT ... ON CONFLICT DO UPDATE SET delivery_cursor =
  max(delivery_cursor, excluded.delivery_cursor)`；普通 ack 不允许回退。
- 与 `agent_sessions` 分开：session 是执行身份，read state 是投递进度；session fresh/reset
  通过显式 rewind API 改 cursor，不删行。
- 建表顺序排在 `threads` 之后；不依赖 `messages` 的 FK，消息可由 `thread_id + seq` 查询。

### 4.6 `workers` / `worker_bindings`

- 表定义见 §3.5.2；worker 是 ephemeral execution carrier，不是 session 常驻所有者。
- 建表顺序：`agent_sessions` → `workers` → `worker_bindings` → `turn_executions`
  （`turn_executions.worker_id` FK 指向 `workers`）。
- 索引：`workers(state, lease_expires_at)`、`worker_bindings(worker_id)`。
- `turn_executions.worker_id` 用 `ON DELETE SET NULL`；worker retire 不删历史 child。
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
parent 只存 `successfulAgentIds`；failed/canceled 由 `TurnExecution` 最新 attempt 推导。

## 6. 端到端流程

### 6.1 多 target 普通消息

```text
m1（targets=[agent:A, agent:B]）
  → InvocationQueue.enqueue q1
  → QueueProcessor claim q1
  → InvocationRecord invP 创建（status=queued）
  → InvocationTracker.start(A), start(B)
  → routeAgents("parallel") → runAgentTurn 创建 TurnExecution iA/iB（attempt=1）
  → invoke-single-agent:
       ensure AgentSession(sA/sB) + worker
       createRunning(iA/iB)
       InvocationRegistry.create(iA/iB)
       prompt/stream
  → iA completed, iB failed
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
  → operator → 通知；agent:A → InvocationRecord + TurnExecution
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
       a2aParentTurnExecutionId=iA.turnExecutionId
       a2aTriggerMessageId=m2
       a2aDepth=iA.depth+1
  → 超过 15 拒绝
```

### 6.3 部分成功重试

```text
parent partial_failed: successful=[A], failed=[B]
  → requestRetry(B)
  → 新 queue entry q2（targets=[B]）
  → parent status=running, retryCount+1
  → TurnExecution iB2（attempt=2）
  → iB2 completed → successful=[A,B], status=completed
  → A 的 iA/credential 不重跑
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
  - running TurnExecution 无 tracker/worker → `interrupted`；
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

- `InvocationQueue`/`QueueEntry`：admission、target-level claim、lease、target 移除、operator 通知、正文快照。
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
| `outputFence` / `coveredMessageIds` / `queueCompletionPolicy` | v2 的 action/prompt/carrier 审计 |
| `idempotencyKey` / `intent` | v1 用 `sourceRecordId` unique + queue receipt；usage 已保留为 `usageByAgent`/`usageRecordedAt` |
| `InvocationTrajectoryProjector` 完整版 | v1 用简单 timeline；trajectory drilldown 后续 |
| `responsePending` 复杂 ledger | v1 用同事务提交 response + terminal；schema 预留 `settlement='response_pending'` seam，不做 recovery ledger |
| `seenCursor` / `mentionAck` / unread badge | v1 只做 `deliveryCursor`（§3.5.1） |
| managed work / collective grants / compaction carrier | v2 |

## 8. 迁移

1. **新表**：`invocation_queue`、`invocation_records`、`turn_executions`、`invocation_credentials`（重建）。
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
- `processEntry` 只对 agent targets 创建 parent + N child；全部 target dispatch 后 queue entry 可删除。
- `routeAgents("parallel")` 每个 child 独立 signal；`routeAgents("serial")` 是同一 `runAgentTurn` 的薄循环，v1 不默认启用。

### 9.2 InvocationRecord

- `sourceRecordId` unique；重试复用同一 parent。
- `targetAgentIds` 不可变。
- 全部 child completed → parent completed。
- 部分成功 → parent partial_failed；`successfulAgentIds` 正确。
- 全部失败 → parent failed。
- 取消 → parent canceled。
- 重试只重跑 `targetAgentIds - successfulAgentIds`；successful 不重跑；`retryCount` 递增，parent 先回 `queued`。
- `usageByAgent` 按 agent 跨 attempt 累计；`usageRecordedAt` 首次写入后不变。

### 9.3 TurnExecution / createRunning

- 同 id/同身份重复 createRunning → `replayed`，不启动第二次 provider。
- 同 id/不同身份 → `conflict`。
- 新 id → `created`。
- 一个 TurnExecution 只能 transitionTerminal 一次；重复 → `already_terminal`。
- ordinary completed 必须有 responseMessageId；routing_guard completed 必须没有。
- failed/interrupted/canceled 必须有 terminalReason。
- 一个 agent 可有多 attempt；唯一 `(parent, agent, attempt)`。

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

- daemon 重启：running TurnExecution 无 tracker/worker → interrupted；parent aggregate；credential terminal。
- TTL zombie → interrupted。
- running TurnExecution 无 live worker/heartbeat → `interrupted/owner_reaped`；释放 tracker slot。
- `getThreadLiveInvocations` 返回 tracker + durable running child。
- `MessageDispatchSummary` 正确显示 targets/running/completed/failed/canceled。
- v1 不测 trajectory projector（未实现）。

### 9.7 真实模型 E2E

- 多 agent @：一个 message、一个 parent、N child、N response；parent completed/partial_failed。
- 一个 target 失败：parent partial_failed；重试只补失败 target；成功后 completed。
- A2A hop：child A post 给 C；C 的 parent/depth 正确；深度限制生效。
- daemon 重启：running child 收敛；live 列表正确。
- 迁移：task-first 数据 legacy；新 runtime 不读。

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
5. **`TurnExecution` 使用 `invocationRecordId`（fan-out parent）+ `a2aParentTurnExecutionId`（A2A 因果父）两个字段**，不共用一个 parent。
6. **Auth 从 MCP callback 改为 pi extension tool capability**：credential 绑 child TurnExecution，allowedTools 限 A2A tools；MCP/task/role/run 字段删除。
7. **终态同事务**：child terminal + parent aggregate + credential terminalize；v1 不做 responsePending ledger。
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
19. **删除 `invocation_queue.invocation_record_id`**：parent 通过 `invocation_records.source_record_id` + `turn_executions.queue_entry_id` 关联。
20. **QueueProcessor v1 方法面**：`requestDrain` / `processNext` / `drain` / `processEntry` / `recoverStartup` / `onInvocationComplete`；候选选择用 `InvocationQueue.listQueued` + `claim`，`claimNext` 只是内部 helper。
21. **`processEntry` 同事务边界**：parent + child + credential + `retireTargets` 同事务；provider 启动在事务外。
22. **v1 不自动重试失败 target**：失败由 parent aggregate 记录；重试走 `requestRetry` 新建 queue entry，避免退避/热循环。
23. **QueueProcessor 删除 Clowder 扩展面**：append lifecycle、Steer、continuation、live companion、freshness、auto-resume suppression、prestart processing groups、batching、caller dispatch observations。
24. **全局身份契约（0011）**：`sourceRecordId + attempt → queueEntryId`；`invocationRecordId`（parent）；`turnExecutionId`（child）；`credentialId`（auth）；`a2aParentTurnExecutionId`（因果父）；A2A runtime 禁用 `sourceMessageId` / `sourceId` / 裸 `invocationId` / `parentInvocationId` / `entryId` / parent `idempotencyKey`。
25. **InvocationRecord 状态/字段**：保留 `partial_failed`；只存 `successfulAgentIds`，failed/canceled 由 child 推导；`requestRetry` 把 parent 置 `queued`，retry child 启动后再 `markRunning`。
26. **InvocationRecord usage**：parent 存 `usageByAgent`（跨 attempt 累计）+ `usageRecordedAt`（首次写入）；`TurnExecution` 存 per-attempt `usage`；collector 汇总后由 `applyTerminalAggregate` 写入。
27. **Tracker start 抢占（DP-F018T-1=B）**：同 slot 旧 controller 先发中断信号，旧 TurnExecution 标 `interrupted/preempted`；新 slot 立刻登记。普通消息默认不抢占，只有显式 Steer/停止动作走抢占。
28. **取消即释放 slot（DP-F018T-2=B）**：tracker 不保留 canceled 墓碑；真正的执行互斥由 `TurnExecution` 唯一 running + `RpcConnection.prompting` + worker binding generation 承担；旧 worker 未退出时新 start 返回 `worker_busy`。
29. **僵尸判定用 worker heartbeat（DP-F018T-3=A）**：running TurnExecution 无 live worker/heartbeat 才标 `interrupted/owner_reaped`；被抢占但旧 worker 还活着的 child 保留到旧 worker 结束。
30. **Operator ingress 路由（DP-F018R-1=A）**：行首 @ 是 operator 侧 A2A admission；无 @ → 上一 human `targetAgentIds` → 最近成功 replier → participant → default agent；都没有才 `no_target`。
31. **StoredMessage.targetAgentIds（DP-F018R-2=A）**：仅 user message 持久化本次 admission 的 agent targets；与 message + queue entry 同事务写入；agent-authored A2A targets 走 `lifecycle.dispatchRefs`。
32. **runAgentTurn + routeAgents（DP-F018R-3=A）**：per-agent pipeline 抽成 `runAgentTurn`；v1 默认 parallel，serial 是同一 pipeline 的薄循环；route 只负责顺序/并发。
33. **Session 服务分层（2026-11-09 Q&A；2026-11-10 Worker 定稿）**：
    `AgentSessionStore`（durable identity）+ `WorkerPool`（ephemeral worker）+
    薄 `AgentSessionManager`；`TurnExecution.agentSessionId` 只是指针。
34. **Message lifecycle 是 durable 投递回执（2026-11-09 Q&A）**：`StoredMessage.lifecycle`
    的 input 存 typed `dispatchRefs`（target/queueEntryId/attempt/phase/responseMessageId/
    turnExecutionId）；response 存 parent/child/target/终态；queue live row 派发后删除，
    `queue_admissions` 只做 admission 幂等。
35. **Delivery cursor（2026-11-09 Q&A）**：v1 新增 `agent_read_state.delivery_cursor`，
    按 `(threadId, agentId)` 存 thread-global seq 的已消费位置；fetch-after + filter +
    monotonic ack；不做 per-target cursor / seenCursor。
36. **Response settlement seam（2026-11-09 Q&A）**：v1 同事务 `settled`；schema 预留
    `response_pending` + `listResponsePending`/`completeResponseSettlement`；未来异步 response
    不改 schema。
37. **Worker v1（2026-11-10 拍板）**：worker 是 ephemeral execution carrier；pi v1
    `capacity=1`、一个 worker 一 session；`warmTtl=0`、`maxLiveWorkers=8`；不建
    per-turn `worker_leases`；session 不持有 worker；spawn 实测约 0.5s，不作为常驻理由。
38. **Message 单层（2026-11-10 拍板）**：v1 不定义 domain `Message`；`StoredMessage` 是
    唯一消息记录（from/content/contentBlocks/toolEvents/lifecycle/replyTo/seq/timestamp/
    updatedAt/thinking/deletedAt/deletedBy/extra{kind,targetAgentIds,rich,crossPost}）；
    `MessageStore` 持久化/返回 `StoredMessage`；无 userId/status/deliveryStatus/mentions。
39. **delivery_failure lifecycle（2026-11-10 拍板）**：admitted source 在 prestart 失败时
    追加独立 system message（`from.service='message_delivery'`），lifecycle 记
    `inputMessageId/requestedTargets/reason`；同时 settle source dispatchRefs；不创建
    response/TurnExecution。
