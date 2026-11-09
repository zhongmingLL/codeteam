---
title: "codeteam A2A runtime chain v1 — Clowder-aligned"
doc_kind: architecture
status: accepted
created: 2026-11-06
updated: 2026-11-07
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

1. **10 个组件按 Clowder 结构复用**，只做 v1 轻量化；`routeSerial` 在 v1 去掉，只保留 `routeParallel`。
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
      → AgentRouter.route
          → routeParallel
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
- 没有行首 `@` → typed reject `no_target`（v1 不做“默认最近活跃 agent”隐式路由）。
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

**v1 不做**
- `author_intent_json`、message disposition、action/wait carrier、fence refs、cloud provenance、steer。
- 路由/解析错误走 audit/observation；QueueEntry 不存 `routingWarnings`/`lastError`。

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
- **真正的执行互斥在 AgentSession/worker lease**：新 `TurnExecution` 启动 provider 前必须拿到该 `(agentId, agentSessionId)` 的 worker lease；旧 worker 未退出时返回 `worker_busy`，QueueProcessor 释放 claim 稍后重试。
- `startAll` all-or-nothing：任一 target 的 slot 或 worker lease 不可用则全部不启动。
- `complete` / `completeAll` 只释放匹配 `turnExecutionId` 的 slot（ownership fence），防止 late terminal 清掉 replacement。
- `isBusy` = slot active；取消即释放后不再有 pending teardown 状态；旧 worker 的忙由 session/worker lease 表达。
- 进程内，不持久化；durable truth 是 `TurnExecution.status`。

**Steer / 插队原语**

- v1 提供：`cancel` + `priority:"urgent"` queue entry + `start` 抢占。
- 后续 Steer：operator 选中当前执行 → 停止 → urgent entry 插队；旧 child 标 `interrupted/preempted`。
- 普通消息默认不抢占；只有显式 Steer/停止动作走抢占路径。

**InvocationOwnerReaper（v1，DP-F018T-3=A）**

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

- 被抢占但旧 worker 还活着的 child：保留，等旧 worker 结束；session/worker lease 防止新旧叠跑。
- 旧 worker 结束后 heartbeat/lease 过期；下一轮 reaper 再标 `interrupted/owner_reaped`。
- 如果旧 worker 永久挂住且 heartbeat 一直有效，不清理；这是 DP-F018T-3=A 的接受代价。
- `recoverStartup()` 做一次性扫描：tracker 为空时按同一 worker heartbeat 规则收敛。

### 3.5 AgentRouter + routeParallel

**结论：v1 只保留 `routeParallel`；`routeSerial` 去掉。**

原因：
- `routeSerial` 的 worklist 是静态 target 列表，内循环不会把新 target push 回 worklist；
- codeteam v1 的 A2A hop 是**新 message + 新 queue entry + 新 parent**，不是同一 route 内继续 push target；
- 没有 `intent` 解析时，serial/parallel 没有选择依据；
- 多 target @ 需要的是并行 fan-out，不是串行 worklist。

**v1 路由**

```ts
class AgentRouter {
  route(targets, options): AsyncIterable<AgentMessage>; // 内部 routeParallel
}
```

- 显式 targets，不做 @ 解析；
- 每个 target 一个 child `TurnExecution`；
- 每个 child 独立 AbortSignal；一个失败不 abort 兄弟；
- A2A 链由 `post_message` 新建 message/queue entry 实现，不在 route 内递归。

**v1 不做**
- `routeSerial`、batching、intent-derived serial/parallel、per-cat prompt prep 的复杂分支。
- 如果未来出现“同一 queue entry 内必须顺序执行”的需求，再加 `targetDispatchMode: "serial"`。

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
get(turnExecutionId);
listByInvocationRecord(invocationRecordId);
listRunning();
```

- 唯一约束：`turnExecutionId`、`(invocationRecordId, agentId, attempt)`、`responseMessageId`（非空时）。
- `createRunning` 的 identity = parent + agent + attempt + queueEntryId + trigger；不一致即 conflict。
- `replayed` 时 `invoke-single-agent` 不启动 provider，按 duplicate 处理。
- `transitionTerminal` 只允许一次；`completed + ordinary` 必须有 `responseMessageId`；`routing_guard + completed` 必须为 null；`failed/interrupted/canceled` 必须有 `terminalReason`。
- v1 不做 `causal.coveredMessageIds`、`outputFence`、`queueCompletionPolicy`；保留 `triggerMessageId`/`a2aTriggerMessageId`/`a2aDepth`。

**`invoke-single-agent` 顺序**
1. 从 AgentConfig/AccountConfig 解析 provider/model/modelFamily；
2. ensure `AgentSession`（active-only）+ worker；
3. 生成 `turnExecutionId`；
4. `TurnExecutionStore.createRunning`（durable）；
5. `InvocationRegistry.create`（credential，绑 child id）——codeteam 因 FK 先 child 后 auth；Clowder 是 auth-first，但“两者都在 provider 之前”不变；
6. provider/prompt/stream；
7. `transitionTerminal` + collector + parent 聚合 + credential terminalize（同一事务）。

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
  response_message_id TEXT,
  terminal_reason TEXT,
  usage_json TEXT
    CHECK (usage_json IS NULL OR
           (json_valid(usage_json) AND json_type(usage_json) = 'object')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,

  CHECK (status = 'running' OR ended_at IS NOT NULL),
  CHECK (status = 'running' OR terminal_reason IS NOT NULL OR status = 'completed'),
  CHECK (status <> 'completed' OR execution_kind <> 'ordinary' OR response_message_id IS NOT NULL),
  CHECK (status <> 'completed' OR execution_kind <> 'routing_guard' OR response_message_id IS NULL),
  CHECK (a2a_trigger_message_id IS NULL OR a2a_parent_turn_execution_id IS NOT NULL),
  UNIQUE (invocation_record_id, agent_id, attempt),
  FOREIGN KEY (invocation_record_id) REFERENCES invocation_records(invocation_record_id) ON DELETE RESTRICT,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (a2a_parent_turn_execution_id) REFERENCES turn_executions(turn_execution_id) ON DELETE SET NULL,
  FOREIGN KEY (trigger_message_id) REFERENCES messages(id) ON DELETE RESTRICT,
  FOREIGN KEY (a2a_trigger_message_id) REFERENCES messages(id) ON DELETE RESTRICT,
  FOREIGN KEY (response_message_id) REFERENCES messages(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX turn_executions_invocation
  ON turn_executions(invocation_record_id, agent_id, attempt);
CREATE INDEX turn_executions_running
  ON turn_executions(status, started_at);
CREATE UNIQUE INDEX turn_executions_response
  ON turn_executions(response_message_id) WHERE response_message_id IS NOT NULL;
```

- `queue_entry_id` 不加 FK：queue entry 是调度账本，dispatch 后可删除；字符串仍可 trace。
- `a2a_parent_turn_execution_id` 是 A2A 因果父，不是 fan-out parent；fan-out parent 是 `invocation_record_id`。
- `usage_json` 是本 attempt 的 provider 用量；collector 汇总所有 attempt 到 parent `usageByAgent`。
- `provider/model/model_family` 是执行快照；Session 不再持有模型。
- `a2a_depth` 用于 loop guard；A2A child = parent.depth + 1。

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
  → routeParallel 创建 TurnExecution iA/iB（attempt=1）
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
- `AgentRouter` + `routeParallel`：显式 targets、per-child AbortSignal。
- `invoke-single-agent`：pi worker/session、child TurnExecution、credential、prompt/stream/terminal。
- `TurnExecutionStore.createRunning/transitionTerminal`：执行幂等 + 单终态。
- `InvocationRegistry`/`InvocationCredential`：pi extension tools 鉴权、allowed tools、terminalize、canonical repair。
- `a2a/tools`：post/cross/thread_context，typed targets（agent/operator），新 message/queue entry，parent/depth；operator-only 只通知不执行。
- `PerAgentTerminalDispositionCollector`：parent aggregate。
- `TurnExecutionStartupReconciler` / `ZombieTerminalRecovery` / `InvocationOwnerReaper` / `getThreadLiveInvocations` / `MessageDispatchSummary`。

### 7.2 v1 不做

| 能力 | 原因 |
|---|---|
| MCP callback / MCP tools | v1 用 pi extension + local control socket |
| `routeSerial` / intent-derived serial | v1 显式 targets；A2A hop 是新 message，不需要静态 worklist |
| task/role/run/profile 坐标 | thread-first；credential 绑 child TurnExecution |
| custody / action lease / wait continuation | v2 |
| session sealed / compression / handoff | v1 active-only session（0009） |
| `outputFence` / `coveredMessageIds` / `queueCompletionPolicy` | v2 的 action/prompt/carrier 审计 |
| `idempotencyKey` / `intent` | v1 用 `sourceRecordId` unique + queue receipt；usage 已保留为 `usageByAgent`/`usageRecordedAt` |
| `InvocationTrajectoryProjector` 完整版 | v1 用简单 timeline；trajectory drilldown 后续 |
| `responsePending` 复杂 ledger | v1 用同事务提交 response + terminal |
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
- operator conversation 只解析行首 `@`；多个 @ 去重；未知/disabled typed reject；无 @ → `no_target`。
- A2A tools 只接受显式 `{kind,id}` targets；正文 `@` 不路由。
- operator-only entry：只通知，不创建 parent/TurnExecution；`delivery.operatorNotifiedAt` 写入。
- target-level claim：`InvocationQueue.claim`；`claim.targetKeys` 是 pending 子集；过期/失败走 `releaseClaim` / `restoreExpiredClaims`。
- 重放保护：live row 删除后，同一 `(source_record_id, attempt)` 仍由 `queue_admissions` 返回 `replayed`/`conflict`。
- `processEntry` 只对 agent targets 创建 parent + N child；全部 target dispatch 后 queue entry 可删除。
- `routeSerial` 不在 v1 registry / 代码路径；`routeParallel` 每个 child 独立 signal。

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
| `AgentRouter` + `routeSerial/routeParallel` | `AgentRouter` + `routeParallel` | routeSerial v1 删除 |
| `invoke-single-cat` + `TurnExecutionStore` + `TurnExecutionRecord` | `invoke-single-agent` + `TurnExecutionStore` + `TurnExecution` | 复用；pi runtime |
| `InvocationRegistry` | `InvocationRegistry` + `InvocationCredential` | 复用；MCP → pi extension |
| `a2a/tools` + MCP | `a2a/tools` (pi extension) + control socket | 复用语义；换 transport |
| `PerCatTerminalDispositionCollector` + `transitionTerminal` + `QueueProcessor` | `PerAgentTerminalDispositionCollector` + `transitionTerminal` + `QueueProcessor` | 复用；v1 单事务 |
| `TurnExecutionStartupReconciler` / `ZombieTerminalRecovery` / `InvocationTrajectoryProjector` / `getThreadLiveInvocations` | `InvocationStartupReconciler` / `InvocationReaper` / 简单 timeline / `ThreadLiveInvocations` | 复用骨架；v1 轻量 |

> 命名：Clowder TurnExecution 的 `succeeded` 在 codeteam 用 `completed`
> （与现有 `runs`/0005 一致）；其余 `failed/interrupted/canceled` 同名。

## 11. 决策记录

1. **直接复用 Clowder A2A runtime 骨架**，不另造 child-only 链路；10 个组件按 Clowder 结构。
2. **`routeSerial` v1 删除**：静态 worklist 不 push target；A2A hop 是新 message/queue entry；没有 intent 选择依据。
3. **Parent 在 QueueProcessor claim 后创建**：queue entry 是 admission/待处理账本；parent 是处理生命周期。
4. **`TurnExecutionStore.createRunning` 是 provider 前幂等入口**：created/replayed/conflict；replayed 不授予第二次 provider lease。
5. **`TurnExecution` 使用 `invocationRecordId`（fan-out parent）+ `a2aParentTurnExecutionId`（A2A 因果父）两个字段**，不共用一个 parent。
6. **Auth 从 MCP callback 改为 pi extension tool capability**：credential 绑 child TurnExecution，allowedTools 限 A2A tools；MCP/task/role/run 字段删除。
7. **终态同事务**：child terminal + parent aggregate + credential terminalize；v1 不做 responsePending ledger。
8. **Session active-only**（0009）：v1 不做 sealed/compression/handoff。
9. **v1 不做 custody/action/wait/compaction/managed/collective**；全部 v2。
10. **QueueEntry 多層次设计**：`owner/from/targets/payload/execution/delivery/claim` 分组；targets 是 `QueueTarget[]`（agent/operator）。
11. **operator 对话只解析行首 `@`**；多个 @ 去重；未知/disabled typed reject；无 @ → `no_target`。
12. **operator-only 允许只通知不执行**：不创建 parent/TurnExecution，只写 `delivery.operatorNotifiedAt` 并删除 queue entry。
13. **claim 复用 Clowder 的 target-level 语义**：`claim` / `retireTargets` / `releaseClaim` / `withdrawTargets`；`claim.targetKeys` 是 pending targets 子集。
14. **QueueEntry 保留 admission 正文快照** `payload.content`；A2A tools 的 targets 用 `{kind:"agent"|"operator", id}` 对象数组，不解析正文 @。
15. **v1 路由/解析错误走 audit/observation**，QueueEntry 不存 `routingWarnings`/`lastError`。
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
28. **取消即释放 slot（DP-F018T-2=B）**：tracker 不保留 canceled 墓碑；真正的执行互斥由 AgentSession/worker lease 承担，旧 worker 未退出时新 start 返回 `worker_busy`。
29. **僵尸判定用 worker heartbeat（DP-F018T-3=A）**：running TurnExecution 无 live worker/heartbeat 才标 `interrupted/owner_reaped`；被抢占但旧 worker 还活着的 child 保留到旧 worker 结束。
