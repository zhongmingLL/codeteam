---
title: "codeteam A2A runtime chain v1 — Clowder-aligned"
doc_kind: architecture
status: accepted
created: 2026-11-06
updated: 2026-11-06
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
7. **v1 不做**：MCP、task/role/run 字段、custody/action/wait、compaction、session sealed、outputFence/coveredMessageIds、trajectory projector、usageByCat/idempotencyKey/intent。

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
  → QueueProcessor.claimNext/drain
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
      parentInvocationId=A.id（A2A 因果父）
      a2aTriggerMessageId=m2
      a2aDepth=A.depth+1
  → 超过 15 拒绝
```

## 3. 组件设计

### 3.1 Message + InvocationQueue / QueueLedger

**命名**
- `queue_entries` → `invocation_queue`
- `QueueStore` → `InvocationQueueStore`
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
type QueueEntryStatus = "queued" | "claimed" | "processing";

interface QueueEntry {
  version: 1;
  id: string;                    // queue:<sha256(sourceMessageId)>
  threadId: string;
  owner: QueueOwner;
  kind: QueueEntryKind;
  from: MessageFrom;             // user | agent | system
  targets: QueueTarget[];        // pending targets；派发后收缩
  payload: QueuePayload;
  execution: QueueExecution;
  delivery: QueueDelivery;
  claim: QueueClaim | null;
  status: QueueEntryStatus;
  priority: "urgent" | "normal";
  position: number;
  enqueuedAt: number;
  updatedAt: number;
}

interface QueuePayload {
  sourceMessageId: string;
  content: string;               // admission 时正文快照
  requestedTargets: QueueTarget[]; // admission 全量快照
  requestId?: string;            // A2A requestId 幂等
}

interface QueueExecution {
  a2aParentInvocationId: string | null;
  a2aTriggerMessageId: string | null;
  a2aDepth: number;
}

interface QueueDelivery {
  operatorNotifiedAt: number | null;
}

interface QueueClaim {
  id: string;
  owner: string;                 // QueueProcessor claim identity
  claimedAt: number;
  expiresAt: number;
  targetKeys: string[];          // 本次 claim 保护的精确 pending targets
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

**`claim`**

- 复用 Clowder 的 target-level claim：`claim` / `claimPrefix` / `commit` / `restore`。
- 一条 entry 同时只有一个 active claim；`claim.targetKeys` 是本次受保护的 pending targets 子集。
- `claim` 是短时、可撤销租约，不是执行状态，不创建 TurnExecution。
- `commit` 把 claim 转 `processing` / 移除已 dispatch targets；失败/超时 `restore` 回 `queued`。
- 全部 targets 移除后删除 queue entry；QueueEntry 没有 terminal。

**职责**
- 入队/去重（`id` 稳定 + `payload.requestId` / source 幂等）；
- claim/lease（target-level）；commit/restore；
- operator target 通知；agent target 派发；
- 按 target 移除；全部 target 移除后删除。

**v1 不做**
- `author_intent_json`、message disposition、action/wait carrier、fence refs、cloud provenance、steer。
- 路由/解析错误走 audit/observation；QueueEntry 不存 `routingWarnings`/`lastError`。

### 3.2 QueueProcessor + QueueEntry

**拆分**
- `DispatchService.drainLoop/claimNext` → `QueueProcessor`；
- `DispatchService` 只保留组合根/兼容 facade，内部委托 `QueueProcessor`。

**v1 方法**

```ts
class QueueProcessor {
  processNext(threadId, userId): Promise<{ started: boolean; entry?: QueueEntry }>;
  drain(options): Promise<DrainResult>;
  claimNext(options): QueueEntry | null;
  processEntry(entry, claimId): Promise<ProcessResult>;
  recoverStartup(): Promise<RecoveryResult>;
}
```

**`processEntry` 顺序**
1. 校验 claim（`claim.targetKeys` ⊆ entry pending targets）；
2. 拆分 targets：
   - `operator` targets → 发通知/可见性，写 `delivery.operatorNotifiedAt`，从 pending 移除；
   - `agent` targets → 创建/复用 parent `InvocationRecord`，`InvocationTracker.start`，`AgentRouter.route`/`routeParallel`；
3. 若无 agent targets（operator-only）：**不创建 parent / TurnExecution**；通知完成、commit、删除 entry；
4. 逐 agent target 创建 `TurnExecution`；
5. 收集 terminal；
6. 更新 parent aggregate；
7. 按 `claim.targetKeys` 移除已处理 targets；全部移除后删除 entry；
8. 异常/超时 `restore(claimId)`；不要把 operator-only 当失败。

**v1 不做**
- Clowder 的 batching、caller dispatch observations、action successor、wait continuation、cloud bridge、multi-user grouping。
- v1 一个 queue entry 的 targets 直接并行 dispatch。

### 3.3 InvocationRecordStore + InvocationRecord

**定位**：消息级生命周期 parent；由 `QueueProcessor` 在 claim 后创建。

**v1 字段**

```ts
type InvocationRecordStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial_failed"
  | "failed"
  | "canceled";

interface InvocationRecord {
  id: string;
  threadId: string;
  userId: string;
  sourceMessageId: string;        // unique
  targetAgentIds: string[];       // admission snapshot，不可变
  status: InvocationRecordStatus;
  successfulAgentIds: string[];
  failedAgentIds: string[];
  canceledAgentIds: string[];
  retryCount: number;
  terminalReason: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}
```

**v1 方法**
- `createQueued`
- `markRunning`
- `applyTerminalAggregate`
- `get` / `listByThread` / `listRunning`
- `requestRetry`（只允许 failed/canceled targets）

**operator target 边界**
- `InvocationRecord` 只在 queue entry 存在至少一个 `agent` target 时创建。
- `targetAgentIds` 只含 agent targets；operator targets 不进入 parent。
- operator-only entry 没有 parent/TurnExecution；只写 queue entry 的
  `delivery.operatorNotifiedAt`。
- mixed targets：parent 只聚合 agent targets；operator 通知记录在 queue entry。

**v1 不做**
- `intent (execute/ideate)`、`idempotencyKey`、`usageByCat`、`actionLeaseCarrier`、`waitContinuationCarrier`。
- `sourceMessageId` unique 已足够做消息级幂等；usage 按 child TurnExecution 聚合，后续再加。

### 3.4 InvocationTracker + InvocationOwnerReaper

**InvocationTracker（进程内）**

```ts
class InvocationTracker {
  start(threadId, agentId, turnExecutionId): AbortController;
  tryStartThread(threadId, agentId, turnExecutionId): AbortController | null;
  release(threadId, agentId): void;
  cancel(threadId, agentId, reason): void;
  has(threadId, agentId?): boolean;
  getActiveSlots(threadId): Array<{ agentId; turnExecutionId; startedAt }>;
}
```

- 同一 `(threadId, agentId)` 一个 active slot；
- `start` 对同 slot 先 abort 旧执行（v1 采用 preempt；如果后续要拒绝并发，改为 `tryStartThread`）；
- preempt 后旧 `TurnExecution` 必须 `transitionTerminal(interrupted, 'preempted')`，并更新 parent aggregate、terminalize 旧 credential；
- 进程内，不持久化；durable truth 是 `TurnExecution.status`；
- 重启后 tracker 为空，由 `TurnExecutionStartupReconciler` 收敛。

**InvocationOwnerReaper（v1 轻量）**
- 扫描 tracker slot 超过 TTL 且无 worker/heartbeat；
- release slot；对应 `TurnExecution` 标 `interrupted`；
- 更新 parent aggregate；terminalize credential。
- v1 不做 Clowder 的 exact owner lease/replacement；TTL + startup reconcile 足够。

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
  id: string;
  invocationRecordId: string;        // parent 消息生命周期
  threadId: string;
  userId: string;
  agentId: string;
  agentSessionId: string;

  parentInvocationId: string | null;  // A2A 因果父（上游 TurnExecution）
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

  startedAt: number;
  endedAt: number | null;
}
```

**`TurnExecutionStore` v1**

```ts
createRunning(input): { outcome: "created" | "replayed" | "conflict"; record: TurnExecution };
transitionTerminal(id, input): { outcome: "transitioned" | "already_terminal" | "not_found"; record: TurnExecution | null };
get(id);
listByParent(invocationRecordId);
listRunning();
```

- 唯一约束：`id`、`(invocationRecordId, agentId, attempt)`、`responseMessageId`（非空时）。
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
  id: string;
  invocationId: string;          // child TurnExecution.id
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
3. `InvocationQueue.enqueue`（sourceMessageId、content、targets、requestedTargets、requestId、priority）；
4. QueueProcessor claim 后拆分 targets：
   - operator → 通知/可见性，写 `delivery.operatorNotifiedAt`；
   - agent → 创建 parent `InvocationRecord` + child `TurnExecution`；
5. 若有 agent targets：child `parentInvocationId` = caller TurnExecution.id，`a2aTriggerMessageId` = 新 message，`a2aDepth` = caller.depth + 1；
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
   - 产出 `successfulAgentIds` / `failedAgentIds` / `canceledAgentIds` / parent status。
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

- `interrupted` 归入 `failedAgentIds`（可重试）；`canceled` 归入 `canceledAgentIds`。
- `successfulAgentIds` 单调递增；`failedAgentIds`/`canceledAgentIds` 反映每个 agent 最新 attempt。
- `requestRetry` 受理后 parent 保持 `running`（即使重试 child 尚未创建），不要降回 `queued`。

**重试**
- 只允许重试 `failedAgentIds`/`canceledAgentIds`；
- parent `partial_failed | failed → running`，`retryCount+1`；
- 为失败 target 创建新 queue entry；
- 新 child attempt = 旧 attempt + 1；
- 已成功的 agent 永不重跑。

**v1 不做**
- `usageByCat`、action fence 聚合、response pending ledger。
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
   - tracker slot 超 TTL 无 heartbeat → release/cancel；
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

> 建表顺序：`invocation_records` → `invocation_queue` → `turn_executions` → `invocation_credentials`。
> 下文按逻辑分组展示，实际迁移按上述顺序创建。

### 4.1 `invocation_queue`

```sql
CREATE TABLE invocation_queue (
  version INTEGER NOT NULL CHECK (version = 1),
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
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
  status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'processing')),
  claim_id TEXT,
  claim_owner TEXT,
  claimed_at INTEGER,
  claim_expires_at INTEGER,
  claimed_target_keys_json TEXT
    CHECK (claimed_target_keys_json IS NULL OR
           (json_valid(claimed_target_keys_json) AND json_type(claimed_target_keys_json) = 'array')),
  invocation_record_id TEXT,
  enqueued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  CHECK (status = 'queued' OR
         (claim_id IS NOT NULL AND claim_owner IS NOT NULL AND claimed_at IS NOT NULL
          AND claim_expires_at IS NOT NULL AND claimed_target_keys_json IS NOT NULL)),
  CHECK (status <> 'queued' OR
         (claim_id IS NULL AND claim_owner IS NULL AND claimed_at IS NULL
          AND claim_expires_at IS NULL AND claimed_target_keys_json IS NULL)),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE RESTRICT,
  FOREIGN KEY (invocation_record_id) REFERENCES invocation_records(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX invocation_queue_pending
  ON invocation_queue(status, priority, position, enqueued_at);
CREATE UNIQUE INDEX invocation_queue_claim
  ON invocation_queue(claim_id) WHERE claim_id IS NOT NULL;
```

- `targets_json` 是 **pending `QueueTarget[]`**；`payload_json.requestedTargets` 是 admission 全量快照。
- `payload_json` 含 `sourceMessageId/content/requestedTargets/requestId`；`content` 是 admission 正文快照。标量 `source_message_id` 用于 FK/index，必须与 `payload_json.sourceMessageId` 一致。
- `execution_json` 含 `a2aParentInvocationId/a2aTriggerMessageId/a2aDepth`。
- `delivery_json` 含 `operatorNotifiedAt`；operator-only entry 没有 parent/TurnExecution。
- `claim` 在 TS 模型里是子对象；SQL 用 `claim_*` 标量 + `claimed_target_keys_json` 做 CAS，语义是 target-level claim。
- `invocation_record_id` 只在存在 agent targets 时回写；operator-only 为 null。
- queue entry 可以在全部 target dispatch 后删除；`turn_executions.queue_entry_id` 仍是 trace 字符串。

### 4.2 `invocation_records`

```sql
CREATE TABLE invocation_records (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL UNIQUE,
  target_agent_ids_json TEXT NOT NULL
    CHECK (json_valid(target_agent_ids_json) AND json_type(target_agent_ids_json) = 'array'
           AND json_array_length(target_agent_ids_json) > 0),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'completed', 'partial_failed', 'failed', 'canceled')
  ),
  successful_agent_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(successful_agent_ids_json) AND json_type(successful_agent_ids_json) = 'array'),
  failed_agent_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(failed_agent_ids_json) AND json_type(failed_agent_ids_json) = 'array'),
  canceled_agent_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(canceled_agent_ids_json) AND json_type(canceled_agent_ids_json) = 'array'),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  terminal_reason TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,

  CHECK (status IN ('queued', 'running') OR ended_at IS NOT NULL),
  CHECK (status IN ('queued', 'failed', 'canceled') OR started_at IS NOT NULL),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX invocation_records_thread_status
  ON invocation_records(thread_id, status);
```

- `source_message_id` unique：一条消息一个 parent；重试复用同一 parent。
- `target_agent_ids_json` 是 admission 快照，不可变。
- `successful_agent_ids_json` 单调递增；failed/canceled 反映最新 attempt。
- `status`/`ended_at`/`terminal_reason` 由 collector 与 child terminal 同事务更新。

### 4.3 `turn_executions`

```sql
CREATE TABLE turn_executions (
  id TEXT PRIMARY KEY,
  invocation_record_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  parent_invocation_id TEXT,
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
  started_at INTEGER NOT NULL,
  ended_at INTEGER,

  CHECK (status = 'running' OR ended_at IS NOT NULL),
  CHECK (status = 'running' OR terminal_reason IS NOT NULL OR status = 'completed'),
  CHECK (status <> 'completed' OR execution_kind <> 'ordinary' OR response_message_id IS NOT NULL),
  CHECK (status <> 'completed' OR execution_kind <> 'routing_guard' OR response_message_id IS NULL),
  CHECK (a2a_trigger_message_id IS NULL OR parent_invocation_id IS NOT NULL),
  UNIQUE (invocation_record_id, agent_id, attempt),
  FOREIGN KEY (invocation_record_id) REFERENCES invocation_records(id) ON DELETE RESTRICT,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_invocation_id) REFERENCES turn_executions(id) ON DELETE SET NULL,
  FOREIGN KEY (trigger_message_id) REFERENCES messages(id) ON DELETE RESTRICT,
  FOREIGN KEY (a2a_trigger_message_id) REFERENCES messages(id) ON DELETE RESTRICT,
  FOREIGN KEY (response_message_id) REFERENCES messages(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX turn_executions_parent
  ON turn_executions(invocation_record_id, agent_id, attempt);
CREATE INDEX turn_executions_running
  ON turn_executions(status, started_at);
CREATE UNIQUE INDEX turn_executions_response
  ON turn_executions(response_message_id) WHERE response_message_id IS NOT NULL;
```

- `queue_entry_id` 不加 FK：queue entry 是调度账本，dispatch 后可删除；字符串仍可 trace。
- `parent_invocation_id` 是 A2A 因果父，不是 fan-out parent；fan-out parent 是 `invocation_record_id`。
- `provider/model/model_family` 是执行快照；Session 不再持有模型。
- `a2a_depth` 用于 loop guard；A2A child = parent.depth + 1。

### 4.4 `invocation_credentials`

```sql
CREATE TABLE invocation_credentials (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  token_salt TEXT NOT NULL,
  invocation_id TEXT NOT NULL UNIQUE,
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
  FOREIGN KEY (invocation_id) REFERENCES turn_executions(id) ON DELETE RESTRICT,
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
partial_failed/failed ──retry admitted──▶ running
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

1. 首次 attempt 还没有 child 开始且 retryCount=0 → parent `queued`；retry 已受理但 child 未创建 → `running`；
2. 任一最新 child running，或还有 target 没有 child → parent `running`；
3. 所有 target 最新 child completed → parent `completed`；
4. ≥1 completed + ≥1 failed/interrupted/canceled，且无 running → parent `partial_failed`；
5. 0 completed，所有 target failed/interrupted/canceled，且无 running → parent `failed`；
6. operator 取消整个消息 → parent `canceled`。

`interrupted` 归 `failedAgentIds`（可重试）；`canceled` 归 `canceledAgentIds`。
`successfulAgentIds` 单调递增；`failedAgentIds`/`canceledAgentIds` 反映最新 attempt。

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
       parentInvocationId=iA.id
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
  - 未开始的 target 标 `canceledAgentIds`；
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
  - tracker slot 超时 → release/cancel。
- `getThreadLiveInvocations`：
  - tracker active slots + durable running TurnExecution。
- `InvocationTrajectoryProjector`：
  - v1 不做；用 TurnExecution + response Message + events 的简单 timeline。

## 7. v1 裁剪与 v2 推迟

### 7.1 v1 保留

- `InvocationQueue`/`QueueEntry`：admission、target-level claim、lease、target 移除、operator 通知、正文快照。
- `QueueProcessor`：claim、parent 创建、tracker、route、terminal 聚合、retry、startup recovery。
- `InvocationRecord`：消息生命周期、target snapshot、successful/failed/canceled、retryCount、partial_failed。
- `InvocationTracker`：thread×agent 活跃槽、cancel、live。
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
| `usageByCat` / `idempotencyKey` / `intent` | v1 用 sourceMessageId unique + child usage；后续再加 |
| `InvocationTrajectoryProjector` 完整版 | v1 用简单 timeline；trajectory drilldown 后续 |
| `responsePending` 复杂 ledger | v1 用同事务提交 response + terminal |
| managed work / collective grants / compaction carrier | v2 |

## 8. 迁移

1. **新表**：`invocation_queue`、`invocation_records`、`turn_executions`、`invocation_credentials`（重建）。
2. **旧 task-first 表**：`queue_entries`、`runs`、`agent_sessions`、旧 `invocation_credentials` 中的 task-first 数据保留在 `legacy_*`，新 runtime 不读。
3. **drain**：有 running task-first invocation 的 session 先 drain/terminal，再迁移；不把旧 run 混进新 TurnExecution。
4. **agent_sessions**：按 0009 只迁 active；sealing/sealed 行 legacy。
5. **preflight**：`agentId`/`userId`/`workingDirectory`/`sourceMessageId` 无法确定的进入 preflight，不静默置空。
6. **不迁移**：`task_id/role/stage_id/handoff_id/approval_id`、custody/action/wait/compaction 字段。
7. **文档同步**：`0005` §2.2/2.4/2.5 指向本文；`docs/reuse/callback-auth.md` 从 per-run token 更新为 per-invocation tool capability。

## 9. 验收标准

### 9.1 Queue / Processor

- 一条消息 enqueue 一个 queue entry；同 source 重放收敛到同一 `id`；重复 `requestId` 返回同一 entry。
- operator conversation 只解析行首 `@`；多个 @ 去重；未知/disabled typed reject；无 @ → `no_target`。
- A2A tools 只接受显式 `{kind,id}` targets；正文 `@` 不路由。
- operator-only entry：只通知，不创建 parent/TurnExecution；`delivery.operatorNotifiedAt` 写入。
- target-level claim：`claim`/`claimPrefix`；`claim.targetKeys` 是 pending 子集；过期/失败可 restore。
- `processEntry` 只对 agent targets 创建 parent + N child；全部 target dispatch 后 queue entry 可删除。
- `routeSerial` 不在 v1 registry / 代码路径；`routeParallel` 每个 child 独立 signal。

### 9.2 InvocationRecord

- `sourceMessageId` unique；重试复用同一 parent。
- `targetAgentIds` 不可变。
- 全部 child completed → parent completed。
- 部分成功 → parent partial_failed；`successfulAgentIds` 正确。
- 全部失败 → parent failed。
- 取消 → parent canceled。
- 重试只重跑 failed/canceled；successful 不重跑；retryCount 递增。

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

- `post_message` 创建新 message + queue entry + parent；child `parentInvocationId`/`a2aDepth` 正确。
- `cross_post_message` 跨 thread 同 user；不同 user 拒绝。
- `thread_context` 只读，不入队。
- depth > 15 拒绝。
- 不存在 `a2a_send`/`handoff_*` 注册。

### 9.6 恢复 / 读模型

- daemon 重启：running TurnExecution 无 tracker/worker → interrupted；parent aggregate；credential terminal。
- TTL zombie → interrupted。
- tracker slot 超时 → release。
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
| `Message` + `InvocationQueue` + `QueueLedger` | `Message` + `invocation_queue` + `InvocationQueueStore` | 复用/改名；v1 轻量 |
| `QueueProcessor` + `QueueEntry` | `QueueProcessor` + `QueueEntry` | 复用；拆分 DispatchService |
| `InvocationRecordStore` + `InvocationRecord` | `InvocationRecordStore` + `InvocationRecord` | 复用；v1 轻量 |
| `InvocationTracker` + `InvocationOwnerReaper` | `InvocationTracker` + `InvocationOwnerReaper` | 复用；v1 TTL |
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
5. **`TurnExecution` 使用 `invocationRecordId`（fan-out parent）+ `parentInvocationId`（A2A 因果父）两个字段**，不共用一个 parent。
6. **Auth 从 MCP callback 改为 pi extension tool capability**：credential 绑 child TurnExecution，allowedTools 限 A2A tools；MCP/task/role/run 字段删除。
7. **终态同事务**：child terminal + parent aggregate + credential terminalize；v1 不做 responsePending ledger。
8. **Session active-only**（0009）：v1 不做 sealed/compression/handoff。
9. **v1 不做 custody/action/wait/compaction/managed/collective**；全部 v2。
10. **QueueEntry 多層次设计**：`owner/from/targets/payload/execution/delivery/claim` 分组；targets 是 `QueueTarget[]`（agent/operator）。
11. **operator 对话只解析行首 `@`**；多个 @ 去重；未知/disabled typed reject；无 @ → `no_target`。
12. **operator-only 允许只通知不执行**：不创建 parent/TurnExecution，只写 `delivery.operatorNotifiedAt` 并删除 queue entry。
13. **claim 复用 Clowder 的 target-level 语义**：`claim`/`claimPrefix`/`commit`/`restore`；`claim.targetKeys` 是 pending targets 子集。
14. **QueueEntry 保留 admission 正文快照** `payload.content`；A2A tools 的 targets 用 `{kind:"agent"|"operator", id}` 对象数组，不解析正文 @。
15. **v1 路由/解析错误走 audit/observation**，QueueEntry 不存 `routingWarnings`/`lastError`。
