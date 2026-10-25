---
title: "dispatch 架构复用检视（A2A 执行链重写版）"
doc_kind: architecture-review
status: approved
created: 2026-10-24
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
source_cell: dispatch
source_card: ../../reuse/dispatch.md
template: ../0004-reuse-architecture-review-plan.md
---

# dispatch 架构复用检视（A2A 执行链重写版）

> 本轮按 operator 2026-10-24 的纠正重写：dispatch 的核心不是 `QueueLedgerEntry` 一张表，而是真实 A2A 执行链：
> **A2A ingress → InvocationQueue/QueueLedgerAdmission → QueueProcessor → AgentRouter → routeSerial/routeParallel → invokeSingleCat → AgentMessage/response/terminal**。
> codeteam 复用这条链的编排语义，唯一执行内核替换点是 `invokeSingleCat → invokeSingleAgent → pi kernel`。
>
> 术语：本文用 **halt/cancel** 指 clowder 的 Stop/cancel 语义；`stopAuthority` 保留代码名。

## 1. 总结

### 1.1 clowder feature 范围

- cell：`dispatch`
- canonical：F047 / F117 / F167 / F175 / F177 / F185 / F247 / F254 / F264 / F280 / F295
- **F122 已退役为历史文档**：现行语义以 ADR-043 + F117 Phase D 为准；本卡不把 F122 的 per-target 拆行/steer 预留当契约。
- **P0 范围**：A2A 入队、single-ledger Queue、claim/drain、serial/parallel 路由、单次 invoke、response/terminal、startup recovery、active execution projection。
- **非 P0**：F254 历史 freshness closure/supplement、F167 action lease 细节、F280 wait carrier 细节、F247 cloud-only child 细节只作为 typed fence refs 的输入；不在本卡展开。

### 1.2 灵魂链：一张图看清复用点和替换点

```text
  A2A ingress
  post_message / cross_post_message / multi_mention
  callback-a2a-trigger / messages / callbacks
        │
        ▼
  InvocationQueue.send
  QueueLedgerAdmission
        │  一条 source 一条 entry；targets/recipients 是 pending set
        ▼
  queue_entries（唯一 pending-wake）
        │
        ▼
  QueueProcessor
  drain / claim / comparator / busy gate
        │
        ▼
  AgentRouter.routeExecution
  ┌──────────────┴──────────────┐
  │ queue 多 recipient → parallel│ 其它
  ▼                             ▼
  routeParallel                 routeSerial
  （独立 fan-out）              （A2A 链 / worklist / handoff）
  └──────────────┬──────────────┘
                 ▼
          invokeSingleCat
          credential/session/cwd/CLI/prompt/tools
                 │
                 ▼
          AgentMessage stream
                 │
                 ▼
  MessageStore.dispatchRefs + TurnExecution + response/terminal
```

| 链段 | clowder 角色 | codeteam 处置 |
|---|---|---|
| A2A ingress | `post_message` / `cross_post_message` / `multi_mention` → `InvocationQueue.send` | **复用语义 + 适配工具/recipient 形状** |
| Queue admission | `QueueLedgerEntry` / `QueueLedgerAdmission` | **适配** Redis → SQLite `queue_entries` |
| Drain / claim | `InvocationQueue` / `QueueProcessor` | **适配** in-process adapter + SQLite claim/CAS |
| Route strategy | `AgentRouter.routeExecution` | **复用** serial/parallel 判定 |
| Serial route | `routeSerial` + `WorklistRegistry` | **复用编排**；只替换单次执行 |
| Parallel route | `routeParallel` | **复用编排**；只替换单次执行 |
| Single execution | `invokeSingleCat` | **替换** 为 `invokeSingleAgent → pi kernel` |
| Child lifecycle | `TurnExecutionRecord` + parent `InvocationRecord` | **适配** `runs`/`run_events` + `parent_run_id` |
| Delivery | `MessageStore.dispatchRefs[]` + response/terminal | **适配** `messages.dispatch_refs_json` |
| Recovery / control | `StartupReconciler`、`InvocationOwnerReaper`、Steer/halt | **适配** SQLite recovery + liveness |

### 1.3 关键决定

| # | 决定 |
|---|---|
| Q1 | **唯一 pending-wake = queue_entries**；`handoff`/`inbox` 只是 source/admission，不建第二队列。 |
| Q2 | **一条 source 一条 Queue Entry**；多 recipient 只放 `targets_json`，不拆 per-recipient 行。 |
| Q3 | **Queue 不拥有 durable 终态**：clowder 确有 `queued/claimed/processing/terminal` 四态，`processing`/`terminal` 是 transition snapshot；codeteam 保留同名字段语义，但用单 SQLite 事务把 terminal 折进 cutover，不保留 durable tombstone。 |
| Q4 | **claim 是短时可逆 cutover**：pre-dispatch 失败恢复同一 entry；实际投递只移除该 recipient；空 targets 删除 entry。 |
| Q5 | **`(source_id, recipient)` 至多一个 active run**：claim → 创建 run → 从 targets 移除该 recipient 同一 SQLite 事务；claim 过期时先查 run，已创建则不得重投。 |
| Q6 | **halt/cancel 只认 durable running truth + liveness witness**；in-memory slot/tracker tombstone/session lock 不能独自把 thread 钉 busy。 |
| Q7 | **recipient 从 cat 换成 AgentProfile/AgentSession**；Queue 不赋予 role/权限，recipient 授权在看板/调度前完成。 |
| Q8 | **codeteam task readiness/DAG/budget/worktree 只决定 admission 顺序**，不另造 drain/comparator。 |
| Q9 | **routeSerial/routeParallel 复用，invokeSingleCat 是唯一替换点**；不要只保留 Queue 而自己重写路由层。 |
| Q10 | **F254/F167/F280 fence 只运输 owner refs**（`fence_refs_json`），不复制/拥有 fence 正文。 |

### 1.4 一句话结论

**dispatch 的复用对象是整条 A2A 执行链，不是一张 Queue 表。**
codeteam 复用的段落是：A2A 入队 → single-ledger Queue → drain/claim → serial/parallel 路由 → A2A 链/worklist → response/terminal/recovery。
codeteam 替换的段落只有：`invokeSingleCat → invokeSingleAgent → pi kernel`。
codeteam 适配的段落是：存储（Redis→SQLite）、recipient 身份（cat→profile/session）、child lifecycle（TurnExecution→runs/run_events）、delivery（MessageStore→SQLite messages）。

## 2. clowder 架构

### 2.1 架构图

```text
  A2A ingress
  ├─ cat_cafe_post_message / cat_cafe_cross_post_message
  ├─ cat_cafe_multi_mention
  └─ callback-a2a-trigger / messages / callbacks
        │
        ▼
  InvocationQueue.send(messageStore, message, options)
        │  QueueLedgerAdmission: source identity + pending recipients
        ▼
  QueueLedgerEntry (Redis)
  ├─ id / threadId / from / kind
  ├─ targets[]（仍待投递）
  ├─ authorIntentByTarget / priority / sourceCategory / order
  ├─ claimId / claimedAt / claimedTargetIds
  └─ status: queued | claimed | processing | terminal(transient)
        │
        ▼
  InvocationQueue / QueueProcessor
  ├─ event-driven drain + dirty bit（单 drain owner）
  ├─ comparator（manual > urgent > normal > FIFO）
  ├─ claim exact recipient / busy gate
  ├─ create TurnExecution child before provider start
  └─ execute → router.routeExecution
        │
        ▼
  AgentRouter.routeExecution
  ├─ resolve target agents
  ├─ queue: recipients>1 ? parallel : serial（不看 intent）
  ├─ direct path 兜底: ideate && recipients>1 ? parallel : serial
  ├─ routeSerial: A2A chain / worklist / handoff / sequential
  └─ routeParallel: independent ideate fan-out
        │
        ▼
  invokeSingleCat(deps, params)
  ├─ credential / account / provider launch
  ├─ session chain / L0 / context
  ├─ cwd / prompt / tools / callbacks
  └─ yield AgentMessage stream
        │
        ▼
  MessageStore / TurnExecution
  ├─ dispatchRefs[]: recipient → responseMessageId → settled outcome
  ├─ response bubble / processing / terminal
  └─ TurnExecution: running → completed/failed/interrupted/canceled
        │
        ▼
  StartupReconciler / InvocationOwnerReaper / ActiveExecutionProjection
```

### 2.2 数据流（逐段）

1. **A2A ingress**：`post_message` / `cross_post_message` / `multi_mention` 先形成真实 source message；`callback-a2a-trigger.ts:139`、`messages.ts:996` 调 `invocationQueue.send`。`InvocationQueue.send` 不接受“正文 @ 文本”作为路由权威；target 来自 typed tool args。注意：clowder 的用户 at-mention 在 ingress 上游解析；codeteam 将 user 通道的 line-@ 收窄为 typed/显式输入（D23），不把“正文可路由”当契约。
2. **Admission**：`QueueLedgerAdmission` 把 source identity、pending recipients、authorIntent、priority、sourceCategory、order 写入同一条 `QueueLedgerEntry`；`enqueue` 是单行原子写入。一条 source 只有一条 entry，recipient 差异只存在于 `targets[]`。
3. **Drain / claim**：`QueueProcessor` 是唯一 drain owner；按 comparator 找第一条可 admission 的 entry；`InvocationQueue.claimLedgerEntry` 生成 `claimId`，只 claim 目标 recipient 集；pre-dispatch 失败按同一 entry 恢复。
4. **Route strategy**：queue 路径由 `QueueProcessor` 固定 `targetDispatchMode = recipients.length > 1 ? 'parallel' : 'serial'`（`QueueProcessor.ts:5105`，**不看 intent**）；`AgentRouter.routeExecution` 只在没有 `targetDispatchMode` 的直调路径才用 `ideate && recipients>1 ? parallel : serial` 兜底。operator 显式 `#ideate` + 多 preferred 是 ingress 快捷路径，仍落到同一 dispatch；codeteam 由 typed `routeIntent` 表达，不解析正文。链式 serial 来自“每一跳是独立 source entry、单 recipient”的结构，不是策略选出来的。
5. **Serial route**：`routeSerial` 处理 A2A 链、`WorklistRegistry` 的 `a2aCount/maxDepth/streakPair`、handoff、顺序执行；每个单次执行仍调用 `invokeSingleCat`。
6. **Parallel route**：`routeParallel` 对独立 ideate targets 并发 fan-out；每个 target 调用 `invokeSingleCat`，共享/独立 signal 由 `signalForCat` 决定。
7. **Single execution**：`invokeSingleCat` 负责 credential、account、session chain、L0/context、cwd、prompt、tools、callback；产出 `AgentMessage` 流。
8. **Child lifecycle**：provider start 前创建 `TurnExecutionRecord`；parent `InvocationRecord` 与 child 分开；response/terminal 单调收口。Queue 行短暂进入 `processing`，terminal 是 transition snapshot，随后从 active ledger 移除。
9. **Delivery**：`MessageStore.dispatchRefs[]` 记录真实 source×recipient、`dispatchedAt`、`responseMessageId`、`settledOutcome`、`inputRead`；首次投递物化 source bubble，后续 recipient 扩展同一 message。
10. **Recovery / control**：`StartupReconciler` 恢复 abandoned short claims；`InvocationOwnerReaper` 用 candidate + independent proof 处理 stale owner；Steer/halt 先重读 live truth，再按 exact target reconcile。

### 2.3 状态机 / 生命周期

| 对象 | 状态 | 约束 |
|---|---|---|
| `QueueLedgerEntry` | `queued → claimed → queued / processing → terminal(transient)` | claimed 是短时 cutover；pre-dispatch 失败回 queued；空 targets 删除；`processing`/`terminal` 只做 transition snapshot，不保留 durable tombstone |
| `TurnExecutionRecord` | `running → completed / failed / interrupted / canceled` | one terminal；child 在 provider start 前创建；Queue 不存 durable terminal tombstone |
| `InvocationRecord`（parent/aggregate） | active/terminal | 与 child 分开；Queue 只运输 fence refs |
| `AgentRouter` route | `resolve targets → serial/parallel → per-target invoke → aggregate` | strategy 由 intent/target count 决定；不把 route 变成第二队列 |
| `WorklistEntry` | `a2aCount/maxDepth/streakPair` | serial A2A 深度与乒乓球检测；不替代 Queue |
| `Steer` | `queued → claim → guide/interrupt → delivered` | 确认重读 live truth；不把 Steer 变成 promote/reorder |
| `halt/cancel` | `cancel candidate → reconcile exact target → terminal` | in-memory slot 不能单独 pin busy；503 只给 persistence failure |
| `Liveness` | `candidate → independent proof → retain/stale_invocation` | age/stale lease 只是 candidate；unknown retain |

### 2.4 关键数据结构

#### 2.4.1 Queue / admission

| 结构 | 关键字段 | 作用 |
|---|---|---|
| `QueueLedgerEntry` | `id/threadId/from/kind/targets[]/delivery.authorIntentByTarget/priority/sourceCategory/position/version/claimId/claimedAt/claimedTargetIds/status` | 唯一 pending-wake 真相 |
| `QueueLedgerAdmission` | source identity + pending recipients + admission metadata | 原子 admission |
| `QueueLedgerClaimResult` | `outcome/entries/claimId` | 短 claim 结果 |
| `WaitContinuationCarrierV1` | `wait/outcome/ownerFence` | Queue 运输的 typed metadata |
| `QueueFenceRef` | `kind + ownerRef` | codeteam-new：只存 wait/lease/deployment 的 refs |

#### 2.4.2 Route / invoke

| 结构 | 关键字段 | 作用 |
|---|---|---|
| `AgentMessage` | `type/semanticEvent/catId/content/contentBlocks/targetCatId/routing` | 单次 invocation 输出流；route/QueueProcessor 消费并持久化 |
| `RouteOptions` | `targetDispatchMode/routeIntent/parentInvocationId/contentBlocks/signalForCat/maxA2ADepth` | serial/parallel 路由输入；QueueProcessor 传入 |
| `InvocationParams` / `InvocationDeps` | `catId/service/prompt/sessionPolicySnapshot/ownerAuthProvenance/...` | 单次执行内核输入；codeteam 换 profile/session + pi 参数 |
| `WorklistEntry` | `a2aCount/maxDepth/streakPair` | serial A2A 链深度与乒乓球检测 |

#### 2.4.3 Delivery / lifecycle

| 结构 | 关键字段 | 作用 |
|---|---|---|
| `Message.dispatchRefs[]` | `targetId/dispatchedAt/responseMessageId/deliveryStatus/settledOutcome/inputRead` | 实际投递与终态投影 |
| `TurnExecutionRecord` | `id/parentInvocationId/threadId/catId/status/startedAt/terminalAt` | child 执行生命周期 |
| `InvocationRecord` | `invocationId/parentInvocationId/threadId/catId/status` | parent/aggregate 真相 |
| `ActiveExecutionProjection` | `threadId/executionKind/exact identity/cancel target` | live truth + managed-command receipt |

### 2.5 Current truth 与代码路径

| 子边界 | 当前真相 | 代码/文档锚点 |
|---|---|---|
| A2A ingress | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/routes/callback-a2a-trigger.ts`、`/home/ming/agent/clowder-ai/packages/api/src/routes/callback-multi-mention-routes.ts`、`/home/ming/agent/clowder-ai/packages/api/src/routes/messages.ts`、`/home/ming/agent/clowder-ai/packages/api/src/routes/callbacks.ts` |
| Queue ledger/admission | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.ts`、`/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/invocation/queue-ledger/QueueLedgerAdmission.ts` |
| Redis store/Lua | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.ts`、`/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/invocation/queue-ledger/queue-ledger-redis-scripts.ts` |
| in-process adapter | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts`、`/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/invocation/QueueProcessor.ts` |
| queue dispatch mode | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/invocation/QueueProcessor.ts`（`:5105`：`targetDispatchMode = recipients>1 ? parallel : serial`） |
| AgentMessage type | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/types.ts`（`:294`） |
| route strategy | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/routing/AgentRouter.ts`、`/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/routing/route-helpers.ts` |
| serial / parallel route | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/routing/route-serial.ts`、`/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/routing/route-parallel.ts` |
| A2A chain / worklist | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/routing/WorklistRegistry.ts` |
| single invocation | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts` |
| claim / empty-target transition | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerCommit.ts`、`/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/invocation/queue-ledger/queue-ledger-redis-transition-scripts.ts` |
| child execution | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/stores/ports/TurnExecutionStore.ts`、`/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/stores/redis/RedisTurnExecutionStore.ts` |
| delivery projection | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/stores/ports/MessageStore.ts`、`/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/stores/redis/RedisMessageStore.ts` |
| startup/recovery | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/invocation/StartupReconciler.ts`、`/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.ts` |
| owner reaper/liveness | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/invocation/InvocationOwnerReaper.ts`、`/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/invocation/InvocationOwnerLeaseCandidates.ts` |
| owner lease TTL | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/invocation/InvocationTracker.ts` |
| ADR single-ledger | landed | `/home/ming/agent/clowder-ai/docs/decisions/043-queue-durable-single-ledger.md`、`/home/ming/agent/clowder-ai/docs/features/F117-message-delivery-lifecycle.md` |

### 2.6 上游已知缺口

| 缺口 | 本卡处置 |
|---|---|
| F122 旧文档语义与 ADR-043/F117 冲突 | 本卡只认 ADR-043 + F117 Phase D；F122 标历史 |
| Redis Queue 跨 key 原子性不足，依赖 transient terminal 对账 | codeteam 用 SQLite 单事务 cutover；标 codeteam deviation |
| in-memory tracker/slot 可能被误当持久真相 | Queue/run 只认 durable row；in-memory 只作 liveness witness |
| canonical restart 的 `authorizedBy` 不是可信 principal | A1-4 用 operator.key 签名；本卡不复用该缺口 |
| `WorklistRegistry` 是进程内 Map，重启不保留 A2A 深度 | codeteam 复用计数语义，**W1 默认持久化到 `runs.chain_metadata_json`**；重启清零会形成 loop guard 双跑洞 |

## 3. codeteam 架构

### 3.1 架构图

```text
  operator chat / steer
  ├─ humanGuidance + active run → inject into active run（不入队）
  └─ followUp 且无 active run → 作为 source 入队
        │
  A2A tools
  a2a_send / handoff_create / multi_mention
        │  typed targets；不解析正文 @
        ▼
  QueueService.admit
        │  一条 source 一条 entry；recipients 是 pending set
        ▼
  queue_entries（SQLite）
  ├─ source_id / source_record_id / source_kind
  ├─ targets_json / author_intent_json / priority / source_category / order_key
  ├─ revision / fence_refs_json
  ├─ claim_id / claim_expires_at / status
  └─ enqueued_at / updated_at
        │
        ▼
  QueueWorker / Dispatcher
  ├─ event-driven drain + dirty bit（单 drain owner）
  ├─ comparator + SQLite claim/CAS
  ├─ cutover transaction: run + first run_event + dispatchRef + remove recipient
  └─ RoutingService
        │
        ▼
  RoutingService
  ├─ queue 路径: recipients>1 ? parallel : serial（不看 intent）
  ├─ direct path 兜底: ideate && recipients>1 ? parallel : serial
  ├─ runSerial: A2A chain / worklist / handoff
  └─ runParallel: independent ideate fan-out
        │
        ▼
  invokeSingleAgent
  ├─ per-run token / AgentSession / profile
  ├─ L0 / context / skills / tool policy
  └─ pi kernel → AgentMessage stream
        │
        ▼
  messages.dispatch_refs_json + runs/run_events + response/terminal
        │
        ▼
  RecoveryService + Liveness + active execution projection
```

### 3.2 数据流（逐段，复用/适配/替换）

1. **A2A ingress**：`a2a_send` / `handoff_create` / `multi_mention` 产出 typed source + targets；`QueueService.admit` 写 source + `queue_entries`。**复用语义，适配工具名和 recipient 身份。** 另两条 operator 路径：`humanGuidance` 有 active run 时直接注入 active run（不入队）；`followUp` 无 active run 时才作为 source 入队。
2. **Admission**：一条 source 一条 `queue_entries`；多 recipient 只放 `targets_json`；`sourceCategory` 保留 a2a/review/continuation 等。**适配 Redis→SQLite。**
3. **Drain / claim**：`QueueWorker` 是唯一 drain owner；SQLite `UPDATE ... WHERE claim_id IS NULL` 或单行 CAS；claim 过期先查 run，已创建不得重投。**适配。**
4. **Route strategy**：queue 路径固定 `recipients>1 ? parallel : serial`（等价 `QueueProcessor.ts:5105`）；`RoutingService` 只在无 `targetDispatchMode` 的直调路径复用 `ideate && recipients>1 ? parallel : serial` 兜底。**复用判定，但不把 queue 多 recipient 串行化。**
5. **Serial route**：`runSerial` 复用 A2A 链、`WorklistRegistry` 的 `a2aCount/maxDepth/streakPair`、handoff、顺序执行；每步调 `invokeSingleAgent`。**复用编排，替换单次执行。**
6. **Parallel route**：`runParallel` 复用独立 ideate fan-out；每 recipient 调 `invokeSingleAgent`。**复用编排，替换单次执行。**
7. **Single execution**：`invokeSingleAgent` 负责 per-run token、AgentSession、profile、L0、context、skills、tool policy、pi kernel。**唯一替换点。**
8. **Cutover / child lifecycle**：claim → `runs` + 首条 `run_event` + `messages.dispatch_refs_json` + 移除 recipient 同一 SQLite 事务；`runs.parent_run_id` 保留 parent/child。**适配。**
9. **Delivery / terminal**：response bubble、settled outcome、`run_events` terminal；Queue 行不保留 durable tombstone。**适配。**
10. **Recovery / control**：启动恢复 claims/runs/tokens/sessions/wait；liveness 两段式；Steer/halt 认 durable running truth。**适配。**

### 3.3 状态机 / 生命周期

| 对象 | 状态 | 约束 |
|---|---|---|
| `QueueEntry` | `queued → claimed → processing → terminal(deleted in same tx)` | claim_id/claim_expires_at；`(source_id,recipient)` 至多一个 active run；cutover 同事务；空 recipients 删除；不落 durable tombstone |
| `Run` | `running → completed / failed / interrupted / canceled` | one terminal；`runs.queue_entry_id` 唯一；`run_events` 是 child event stream |
| `DispatchRef` | `pending → delivered → settled` | per-recipient；response id；`inputRead` 只作阅读证据 |
| `A2A chain` | `a2aCount/maxDepth/streakPair` | serial route 的链深度与乒乓球检测；不替代 Queue |
| `halt/cancel` | `cancel candidate → reconcile run → terminal` | 503 只给 persistence failure；in-memory 不能单独 pin busy |
| `Liveness` | `candidate → independent proof → retain/stale_invocation` | age/lease 只是 candidate；unknown retain |

### 3.4 关键数据结构（与 clowder 对比）

#### 3.4.1 组件级对账（灵魂链）

| # | clowder 段 | 关键结构 / 行为 | codeteam 对应 | 处置 |
|---|---|---|---|---|
| 1 | A2A ingress：`post_message` / `cross_post_message` / `multi_mention` | `InvocationQueue.send` + `QueueLedgerAdmission` 先落 source 再入队 | `a2a_send` / `handoff_create` / 多 recipient → `QueueService.admit` | 语义复用；工具/recipient 形状适配 |
| 2 | Queue admission | `QueueLedgerEntry`：source identity、pending recipients、authorIntent、priority、claim | `queue_entries` | Redis→SQLite；单行多 recipient 不拆行 |
| 3 | Drain / claim | `InvocationQueue` / `QueueProcessor`：comparator、短 claim、busy gate、空 recipients 删除 | `QueueWorker` / `Dispatcher`：SQLite claim/CAS | 语义复用；Redis Lua→SQLite 事务 |
| 4 | Route strategy | queue 路径：`QueueProcessor` 按 `recipients>1` 固定 parallel；`AgentRouter` 的 `ideate` 判定只作直调兜底 | `RoutingService`：queue 多 recipient 恒 parallel；直调才看 `routeIntent` | `reuse now`（判定语义），**不得把 queue 多 recipient 串行化** |
| 5 | Serial route | `routeSerial`：A2A 链、worklist、handoff、顺序执行；调用 `invokeSingleCat` | `runSerial` | 编排语义复用；W1 把 `a2aCount/maxDepth/streakPair` 持久化到 `runs.chain_metadata_json` |
| 6 | Parallel route | `routeParallel`：独立 ideate fan-out；每个 recipient 调 `invokeSingleCat` | `runParallel` | 编排语义复用；只替换单次执行 |
| 7 | Single execution | `invokeSingleCat`：credential/session/cwd/CLI/prompt/tools | `invokeSingleAgent` → pi kernel | **唯一执行内核替换点** |
| 8 | Child lifecycle | `TurnExecutionRecord` + parent `InvocationRecord` | `runs` / `run_events` + `parent_run_id` + `invocation_credentials` | `adapt now` |
| 9 | Delivery | `MessageStore.dispatchRefs[]` + response bubble + terminal | `messages.dispatch_refs_json` + `runs` / `run_events` | `adapt now` |
| 10 | Recovery / control | `StartupReconciler`、`InvocationOwnerReaper`、Steer/halt | SQLite recovery + liveness + halt 两段式 | `adapt now` |

**复用边界**：第 1–6 段和第 8–10 段是 dispatch 编排语义，codeteam 复用；第 7 段 `invokeSingleCat → invokeSingleAgent` 是唯一执行内核替换点。`WorklistRegistry`/A2A chain depth 属于第 5 段，复用计数语义；W1 默认持久化到 `runs.chain_metadata_json`，不单独建表。

#### 3.4.2 对象级对账

| clowder | codeteam | 立场 | 关键差异 |
|---|---|---|---|
| `QueueLedgerEntry` | `queue_entries` | `adapt now` | Redis→SQLite；catId→profile/session；新增 `order_key/revision/fence_refs`；保留 targets/priority/claim |
| `AgentMessage` | `AgentMessage`（同构） | `adapt now` | 输出流语义不变；`catId→agentProfileId`，provider 事件名由 pi adapter 归一 |
| `RouteOptions` | `RouteOptions` | `adapt now` | `targetDispatchMode/routeIntent/signalForCat/maxA2ADepth` 保留；catId→profile/session |
| `InvocationParams` / `InvocationDeps` | `InvocationParams` / `AgentDeps` | `replace now` | credential/session/cwd/CLI 换成 per-run token + AgentSession + pi 参数 |
| `WorklistEntry` | `A2AChainState` | `adapt now` | 计数语义复用；持久化到 `runs.chain_metadata_json` |
| `Message.dispatchRefs[]` | `messages.dispatch_refs_json` | `adapt now` | 字段同构；response id 指向 codeteam message/run |
| `TurnExecutionRecord` | `runs` + `run_events` | `adapt now` | Run 是 durable 执行终态；不建第二 active-run 表 |
| `InvocationRecord` | `runs` parent/child 关系 | `adapt now` | parent_run_id；Queue 只运输 fence refs |
| F254/F167/F280 fences | `fence_refs_json` | `borrow` | 只运输 owner refs；不复制/拥有 fence 正文 |
| F247 cloud child | 不建 | `out-of-scope` | W8 |

#### 3.4.3 §12.2 回写清单

- `queue_entries`：`id, thread_id, source_id, source_record_id, source_kind, targets_json, author_intent_json, priority, source_category, order_key, revision, fence_refs_json, status, claim_id, claim_owner_run_id, claim_expires_at, enqueued_at, updated_at`。
- `messages` 已有 `dispatch_refs_json`；补 `delivery_status`/`settled_outcome`/`input_read` 的 JSON 形状说明。
- `runs` 已有 `queue_entry_id`；补 `parent_run_id`、`source_id`、`recipient_profile_id`、`chain_metadata_json`，并明确 `run_events` 是 child event stream；partial unique index `(source_id, recipient_profile_id) WHERE status='running'` 兜底 `(source_id,recipient)` 单 active run。
- 不新增 `queue_receipts`/`active_runs`/per-target queue 表。

#### 3.4.4 codeteam deviation：durable terminal tombstone

clowder 的 Redis Queue 跨 hash/list/message-index 多个 key，`processing`/`terminal` 行是跨键原子性不足时的对账锚；因此它有四态枚举和 transient terminal 记录。codeteam 的 `queue_entries`、`messages`、`runs`、`run_events` 在同一个 SQLite 库，**cutover 可以是一个事务**，所以不需要 durable tombstone：

- 同一事务写：`queue_entries` recipient 移除/空行删除 + `messages.dispatch_refs_json` append + `runs` insert + 首条 `run_event` insert。
- **可达点 1**：claim 已提交但 cutover 未开始 → 只有 claim，没有 run；恢复检查 `(source_id,recipient)` 无 active run，可安全重投。
- **可达点 2**：cutover 事务中崩溃 → SQLite 回滚，等价于可达点 1；不存在“run 已建但 dispatchRef 未写”的半事务态。
- **可达点 3**：cutover 事务提交后 → run + dispatchRef 已存在，Queue 行已移除；恢复只读 `runs`/`run_events`，不重投。
- **launch 边界**：事务提交后、provider 尚未 launch → run 是 `running` 但没有 worker；恢复把它收敛为 `interrupted`，不当作成功。
- `terminal` 状态只作为事务内 transition snapshot；不保留可按时间查询的 Queue tombstone。
- W1 在 `runs` 增加 `source_id`/`recipient_profile_id`，并建 partial unique index `(source_id, recipient_profile_id) WHERE status='running'` 作为数据库级兜底；违例即 bug 警报。事务是安全带，索引是安全气囊。
- W1 验收覆盖“三可达点 + launch 边界”，不是不可达的中间写点。

> **2026-10-25 A2-2 增量**：managed-work bind 的确定性冲突（409/partial/mismatch）不是 transient queue error。它必须消费 target（移除该 recipient + typed `deliveryFailure` + `work_binding_conflict` audit + operator blocker），不能按“pre-dispatch 失败恢复同一 entry”反复重试；只有 busy/瞬时失败保留 claim 过期重投。该约束与 A2-2 `managed-work.md` §3.3D 同步。
>
> **2026-10-25 A2-2 DP-A2-2-1=A**：managed-work retry = sticky。调度器重试前先读 `work_attempts.executor_profile_id`；已绑定则只选该 profile；未绑定才正常选择并 bind；不同 profile 按上面的消费路径处理。managed model fallback 等 Phase C attempt 2，不自动改绑。

### 3.5 变量定义表

#### Contract

| 变量 | 类型 | 默认/当前 | owner | clowder 来源 | codeteam 决定 | 备注 |
|---|---|---|---|---|---|---|
| `queueEntryId` | `string` | UUID | dispatch | `QueueLedgerEntry.id` | `reuse` | 一条 source 一个 id |
| `sourceId` / `sourceRecordId` | `string` | — | dispatch | `QueueLedgerEntry` | `reuse` | 稳定 source identity |
| `recipients[]` / `targets_json` | `TargetId[]` | pending set | dispatch | `QueueLedgerEntry.targets` | `adapt now` | profile/session id；不拆 per-recipient 行 |
| `authorIntentByTarget` | map | — | dispatch | `QueueLedgerEntry.delivery.authorIntentByTarget` | `reuse` | guide/interrupt/next_work |
| `priority` / `sourceCategory` | number/enum | — | dispatch | F175/F185 | `reuse` | 只影响 order/admission |
| `orderKey` | string | — | dispatch | `QueueLedgerEntry.position` + order list | `new` | SQLite 显式排序键 |
| `revision` | number | 0 | dispatch | `QueueLedgerEntry.version`（schema version） | `new` | 行级 CAS/replay 版本 |
| `fenceRefs` | object[] | [] | dispatch | F254/F167/F280 | `new`（引用语义 borrow） | `{kind,ownerRef}`；正文不进 Queue |
| `claimId` | string | null | dispatch | `QueueLedgerEntry.claimId` | `reuse` | 短时 cutover |
| `claimExpiresAt` | number | null | dispatch | `claimedAt` + recovery threshold | `new` | SQLite 短 claim 自到期列 |
| `a2aCount` / `maxDepth` / `streakPair` | object | 0/2/— | dispatch | `WorklistEntry` | `adapt now` | serial A2A 链深度；W1 持久化到 `runs.chain_metadata_json`；`streakPair` 只在 operator Message 写入时清零，agent 互发不清零 |
| `dispatchRefs` | array | [] | dispatch | `Message.dispatchRefs` | `adapt now` | recipient/dispatchedAt/responseId/status/outcome/inputRead |
| `routeIntent` | enum | typed | dispatch | `AgentRouter` 的 `intent.intent` | `adapt now` | clowder 来自正文 `#ideate`/意图分类；codeteam 只接受 `a2a_send`/`multi_mention` typed 字段（D23），不解析正文 |
| `agentMessage` | object | — | dispatch | `AgentMessage` | `reuse` | route/QueueProcessor 消费的输出流 |

#### State

| 变量 | 类型 | 默认/当前 | owner | clowder 来源 | codeteam 决定 | 备注 |
|---|---|---|---|---|---|---|
| `queue.status` | enum | queued | dispatch | `QueueLedgerStatus` | `reuse` | queued/claimed/processing/terminal(transient)；不落 durable tombstone |
| `run.status` | enum | running | dispatch | `TurnExecutionRecord` | `reuse` | running/completed/failed/interrupted/canceled |
| `dispatch.status` | enum | pending | dispatch | `dispatchRef` | `reuse` | pending/delivered/settled |
| `claim` | object | null | dispatch | Queue claim | `reuse` | claimId/claimedAt/claimExpiresAt/ownerRunId |
| `route.strategy` | enum | serial | dispatch | `QueueProcessor` + `AgentRouter` | `reuse` | queue 路径：recipients>1→parallel，不看 intent；直调路径才用 ideate+multi 兜底 |
| `a2aChain` | object | 0/2/— | dispatch | `WorklistEntry` | `adapt now` | count/maxDepth/streakPair；W1 持久化到 `runs.chain_metadata_json` |
| `liveness` | enum | unknown | dispatch | F118/F194 | `adapt now` | active/unknown/terminal/absent |

#### Config

| 变量 | 类型 | 默认/当前 | owner | clowder 来源 | codeteam 决定 | 备注 |
|---|---|---|---|---|---|---|
| `claimTtlMs` | number | 5min | dispatch | `StartupReconciler.STALE_QUEUED_THRESHOLD_MS` | `adapt now` | SQLite 短 claim；queued stale 5min 有锚点 |
| `processingStaleMs` | number | 10min | dispatch | codeteam new | `new` | clowder 无同义锚点；起点值，eval 可调；不能当 clowder 契约 |
| `maxRecipients` | number | 按实现 | dispatch | Queue target set | `reuse` | 多 recipient 不拆行 |
| `orderPolicy` | enum | priority/order | dispatch | F175 | `reuse` | operator 重排入口 = W7 Console；v1 CLI 不提供 |
| `busyGate` | enum | F185/ADR-034 | dispatch | F185 | `adapt now` | codeteam worker slots |
| `startupRestore` | boolean | true | dispatch | `StartupReconciler` | `reuse` | 恢复 abandoned claims |
| `ownerLeaseTtlMs` | number | 75min candidate | dispatch | F118 / `InvocationTracker.ts` | `adapt now` | owner 级 reaper candidate（W5）；与 A1-2 15min invocation 级不同 |
| `taskAdmission` | object | W1/W5 | dispatch | codeteam new | `new` | DAG/budget/worktree 只决定 admission |

#### Security

| 变量 | 类型 | 默认/当前 | owner | clowder 来源 | codeteam 决定 | 备注 |
|---|---|---|---|---|---|---|
| `targetAuthorization` | invariant | pre-admission | dispatch | F117/F295 | `adapt now` | recipient 授权在看板/调度前完成；Queue 不赋权 |
| `admissionAuthorization` | invariant | token principal + actionPair + recipient enabled | dispatch | F117/F295 + A1-2 | `adapt now` | `QueueService.admit` 只做三件事：per-run token 派生 principal（A1-2）、`(fromRole,toRole,kind)` actionPair 白名单、recipient profile 存在且 enabled；不在 Queue 里重新发明授权 |
| `operatorSource` | actorKind | operator/agent | dispatch | F117 | `reuse` | queue_entries/message 记 actorKind；halt/cancel 之外的审计与未来策略都依赖它 |
| `threadAccess` | decision | owner/user | dispatch | F299 | `defer→W7` | read/cancel 复用 policy |
| `stopAuthority` | principal | exact target + operator credential | dispatch | F295 / 0001:808 | `adapt now` | halt/cancel 只接受 operator credential；run token 无权；agent 侧终止走 blocker/task_done。层级：A1-4 daemon halt 是进程树级，A1-3 halt 是 run 级；daemon halt 后 run 由 recovery 收敛 interrupted，两个 halt 不互调 |
| `actionFence` | object | null | dispatch | F167 | `borrow` | 只运输；不 mint/retry |
| `waitFence` | object | null | dispatch | F280 | `borrow` | 只运输；不解释 |
| `callbackAuth` | separate | — | callback-auth | F174 | `reuse` | Queue 不裁决 callback auth |

#### Observability

| 变量 | 类型 | 默认/当前 | owner | clowder 来源 | codeteam 决定 | 备注 |
|---|---|---|---|---|---|---|
| `dispatchRefs` | event/array | — | dispatch | Message.dispatchRefs | `reuse` | delivery evidence |
| `queue_updated` | event | — | dispatch | Queue projection | `reuse` | ordered snapshot + receipt delta |
| `run_events` | event stream | — | dispatch | TurnExecution | `reuse` | child events |
| `activeExecution` | projection | — | dispatch | F295 | `adapt now` | thread/kind/exact id/cancel target |
| `ownerReaper` | counter | — | dispatch | F118 | `adapt now` | candidate/proof/reaped |
| `deliveryFailure` | event | — | dispatch | F264 | `reuse` | pre-start failure |

### 3.6 明确不做

- 不建第二 queue/drain/comparator；task DAG 只做 admission。
- 不做 per-recipient queue rows；多 recipient 只在 `targets_json`。
- 不把 Queue 当 durable terminal/receipt 账本；`processing`/`terminal` 只作 transaction 内 transition。
- 不从 MessageStore 扫描重建 Queue；source identity 固定。
- 不让 in-memory slot/tracker tombstone/session lock 单独 pin thread busy。
- 不让 Queue 裁决 callback auth、action uniqueness、wait ownership、freshness closure。
- 不把 fail-open routing warning 渲染成 chat message。
- 不在 v1 接 F247 cloud-only child。
- 不只复用 Queue 而重写 routeSerial/routeParallel；那会丢掉 A2A chain/worklist/parallel ideate/response 聚合。

**W5 revisit**：v1 队列驻留是秒级，“fence refs 只运输 + 准入前授权”足够；W5 引入 DAG 驻留后，fence 可能在队列里等待数分钟而 handoff 已 withdrawn。W5 必须在 run 启动前 cheap read 复核 fence 未撤销；撤销则 `dispatchFailure` 并回收 recipient。

### 3.7 W1 验收 / 测试矩阵

- A2A ingress：`a2a_send` / `handoff_create` / `multi_mention` 都只产生一条 source entry；正文 @（含 `#ideate`）不决定路由/策略，策略只读 `RouteOptions`。
- 一条 source 一条 `queue_entries`；多 recipient 不拆行；空 recipients 删除。
- drain 单 owner；comparator 顺序为 manual > urgent > normal > FIFO；无第二 scheduler。
- queue 路径：`recipients>1` 恒 `runParallel`（不看 intent）；`ideate && recipients>1` 只在直调路径作 `runSerial`/`runParallel` 兜底。链式 serial 由“每跳独立 source + 单 recipient”结构保证。
- serial route 的 A2A chain/worklist/乒乓球检测与 clowder 语义一致。
- `(source_id,recipient)` 至多一个 active run；claim 过期 × dispatch 并行不双跑。
- cutover 恢复矩阵：claim 后未 cutover / cutover 事务回滚 / cutover 提交后 / 提交后 provider 未 launch，四种可达状态各恢复一次且不重复。
- `invokeSingleAgent` 失败只影响该 recipient；sibling 不受连带；response/terminal 单调。
- halt/cancel 只认 durable running truth；in-memory 不能单独 pin busy。
- 启动恢复：abandoned claim、running run、旧 token、sealing session、pending wait 都能收敛。

## 4. 风险与回滚

| 风险 | 级别 | 处置 |
|---|---|---|
| 只复用 Queue、重写 routeSerial/routeParallel，丢掉 A2A chain/worklist/response 聚合 | P1 | 灵魂链逐段对账；routeSerial/routeParallel 复用，只有 invokeSingleCat 替换 |
| 第二 queue/per-recipient rows | P1 | `queue_entries` 单行 + `targets_json`；测试“多 recipient 不拆行” |
| Queue 存 durable terminal tombstone | P1 | `terminal` 只作 transition；同事务删除行；durable terminal 只在 runs/response |
| claim/cutover 竞争导致双 run | P1 | `(source_id,recipient)` 唯一 active run；claim→run→dispatchRef→remove 同一事务 |
| 从 MessageStore 重建 Queue | P1 | 不扫描；startup 只校验 queue_entries |
| halt 用 in-memory candidate 误判 | P1 | durable running + liveness witness；exact reconcile |
| recipient 授权被 Queue 代替 | P1 | pre-admission authorization；Queue 只运输 recipient |
| task DAG 变成第二 scheduler | P1 | admission only；唯一 drain/comparator |
| Liveness 超时误杀长 run | P1 | candidate + independent proof；unknown retain |
| A2A chain depth 重启丢失 | P2 | 复用 Worklist 计数语义；W1 决定是否持久化到 run metadata |
| routeParallel 的取消误伤 sibling | P2 | `signalForCat`/per-target signal；测试 cancel one not all |
| invokeSingleAgent 与 clowder AgentMessage 语义漂移 | P2 | 复用 AgentMessage schema；provider adapter 归一；contract tests |

**回滚**：

- `queue_entries` 与 `runs.queue_entry_id` 是新增表/列；回滚到 W1 基线即可，不迁移 clowder Redis。
- `messages.dispatch_refs_json` 是 JSON 扩展；回滚只影响投影，不影响 source message。
- `fence_refs_json` 仅 v1（无 fence 消费者时）可清空；W5 有 wait/action-lease 消费者后清空不是 no-op。

## 5. Review 与签字

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | A2A 链、Queue/claim、routeSerial/routeParallel、Run 映射 | accept；3 条 P3 已回写 |
| 砚砚 | recipient 授权、halt/cancel、fence、fail-closed | accept；6 条 P3 已回写 |
| 墨墨 | operator 可见的 queue/steer/halt 体验、文档一致性 | accept-with-modify；P1×1 + P2×3 + P3×4 已回写 |
| operator | A1-3 架构卡是否可签 | [x] 已签（2026-10-25，批量签 A1-2/A1-3/A1-4） |

> Review 重点：① 这条 A2A 灵魂链是否完整、是否有遗漏段；② 第 1–6/8–10 段复用、第 7 段替换的边界是否成立；③ `AgentMessage`/`RouteOptions`/`InvocationParams`/`WorklistEntry` 数据结构的对账是否准确；④ `(source_id,recipient)` 单事务 cutover 与崩溃矩阵是否覆盖双跑/丢投递；⑤ routeSerial/routeParallel 的 A2A chain/worklist/parallel ideate 是否应原样复用；⑥ halt/cancel 与 A1-4 external executor 的边界是否一致。

> Re-review request：`aa667fe9-56ce-422c-bc8f-3fc881a614d4`（2026-10-24，整卡重写版；上一轮 `18da675d-75e3-4ce6-9366-0b03930206fd` 的 findings 已保留）。

> Round 2 结论：三人均放行。关键修正：queue 多 recipient **恒 parallel**（`QueueProcessor.ts:5105`，不看 intent），`ideate` 只作直调兜底；`routeIntent` 只接受 typed 字段（D23）；崩溃矩阵改为“三可达点 + launch 边界”；`runs.chain_metadata_json` 持久化 A2A 深度；`runs` partial unique index 兜底单 active run；补 steer 入口、operatorSource/admissionAuthorization、daemon halt vs run halt 层级。

> operator 于 2026-10-25 批量签字，A1-3 冻结为 W0/W1 实现契约。

[宪宪/deepseek-flash🐾]
