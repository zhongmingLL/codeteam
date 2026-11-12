---
title: "Turn terminal and settlement design — removing dual state and the god-service"
doc_kind: architecture
status: draft-for-review
created: 2026-11-12
updated: 2026-11-12
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related_features: [codeteam/F018]
related: [0010-a2a-runtime-chain.md, 0015-codeteam-operator-journey-audit.md, 0020-f018-thread-first-runtime.md, decision-packets/2026-11-11-dp-f018-operator-journey.md]
source: "Clowder local reference checkout; codeteam commits 28cfee444/086b4b1f2/a654788e5/09bdb678d"
---

# Turn terminal and settlement design

> 目的：把 Q2 的两个问题一次讲透：
> 1. 为什么 `TurnExecution` 与 `InvocationAttempt` 会出现双终态；
> 2. 为什么 `settleAgentTurn` 会与 route / invokeSingleAgent 职责重叠。
>
> 然后给出修改后的具体设计：attempt 只做投递台账、TurnExecution 独占 child
> 终态、settlement 拆回 Clowder 的四层 owner。
>
> 状态：**draft-for-review**。DP-C/DP-D 的调查结论在此，尚未改 0010 的
> normative schema/事件顺序；operator 确认后按本文件落 0010/plan。

## 0. 结论先行

1. **Clowder 没有 child 执行状态的 `InvocationAttempt`。** 它有：
   - `QueueTargetAttempt`：投递/重试台账，状态是
     `queued|starting|appended|failed|interrupted|cancelled|handled`；
   - `TurnExecutionRecord`：child 执行的唯一 canonical 状态；
   - `InvocationRecord`：parent 聚合；`executionStartedAt` 只是 attempt-scoped receipt。
2. **codeteam 的双终态是两次局部设计叠加的结果**：
   - `28cfee444` 引入 target attempt retry，把 attempt state 写成了 TurnExecution
     五态，而不是 QueueTargetAttempt 投递态；
   - `086b4b1f2` 新增 `settleAgentTurn`，把 Clowder 的四层 settlement 合并成一个
     god-service。
3. **修改后的目标模型**：
   - `TurnExecution.status` 是 child 执行唯一 canonical；
   - `invocation_attempts.delivery_state` 只回答“这次投递走到了哪”；
   - `invoke-single-agent` 拥有 child terminal + credential；
   - route 拥有 response R + draft + A2A successor；
   - QueueProcessor 拥有 parent aggregate + queue/retry + tracker slot；
   - `settleResponseFromDraft` 只做 response_pending recovery。
4. **删除 `settleAgentTurn` 这个入口**。不是给它加参数，而是把四层 owner 重新分开。

## 1. 症状：两个问题分别是什么

### 1.1 双终态

当前 0010 同时定义：

| 对象 | 状态字段 | 当前状态机 |
|---|---|---|
| `turn_executions` | `status` | running / completed / failed / interrupted / canceled |
| `invocation_attempts` | `state` | queued / running / completed / failed / interrupted / canceled |

同一个 child 既有 `turn_execution_id` 指向 `turn_executions`，又有自己的
`invocation_attempts.state`；两者都接受 terminal 写入。结果：

- collector 可能读到 child completed、attempt failed；
- reaper 可能按 attempt 判 terminal，但 TurnExecution 还 running；
- R settlement 不知道应以哪个状态为准；
- retry 后旧 attempt 的 state 与新 child 的 status 可能不一致；
- 迁移/backfill 无法证明“哪一个才是真相”。

### 1.2 settlement 职责重叠

当前 `settleAgentTurn` 同时做：

```text
child TurnExecution terminal
  + attempt terminal
  + parent aggregate
  + credential terminalize
  + response R settlement
```

而 route / invokeSingleAgent / QueueProcessor 也各自持有其中一部分：

| 组件 | 当前文本暗示它可能做 |
|---|---|
| `invoke-single-agent` | provider/stream；可能 child terminal |
| `route-serial` / `route-parallel` | response commit、draft delete、A2A successor；也可能触发 settlement |
| `QueueProcessor` | parent aggregate、queue/retry；可能调用 `settleAgentTurn` |
| `settleAgentTurn` | 以上全部 |

结果：正常路径可能出现双提交；异常路径可能 child terminal 了但 R 未 settle；
recovery 不知道谁该重试；测试无法枚举单一 writer。

## 2. Clowder 的真实模型

### 2.1 child：TurnExecution 独占执行状态

`packages/api/src/domains/cats/services/stores/ports/TurnExecutionStore.ts`：

- `createRunning` 创建 child；
- `transitionTerminal` 是唯一 child terminal 入口；
- status：`running | succeeded | failed | canceled | interrupted`；
- `listResponsePending` 记录 child terminal 但 R 尚未 terminal 的 turn；
- `clearResponsePending` 在 R terminal 后清除。

`RedisTurnExecutionStore.ts`：

- `transitionTerminal` 用 Lua 原子写 record + running index + responsePending；
- terminal first-write-wins；
- `interruptRunningBefore` 只处理 startup cutoff。

### 2.2 attempt：QueueTargetAttempt 是投递台账

`packages/shared/src/types/queue-receipt.ts:250-287`：

```ts
type QueueTargetAttemptState =
  | "queued" | "starting" | "appended"
  | "failed" | "interrupted" | "cancelled" | "handled";

interface QueueTargetAttempt {
  id: string;
  targetCatId: string;
  sequence: number;
  state: QueueTargetAttemptState;
  invocationId?: string;
  seenAt?: number;
  activeAppendAcceptedAt?: number;
  terminalReason?: QueueTargetAttemptTerminalReason;
}
```

它不是 child 执行状态机；它回答“这次投递是否 claim、是否 append、是否 handled”。
retry append 新 attempt，旧 attempt 不可变。

### 2.3 parent：InvocationRecord 只做聚合

`packages/api/src/domains/cats/services/stores/ports/InvocationRecordStore.ts`：

- status：`queued | running | succeeded | failed | canceled`；
- `successfulCatIds` 是成功见证；
- `executionStartedAt` 是 attempt-scoped receipt，不是第二套 terminal state。

### 2.4 settlement 四层 owner

| 层 | owner | 负责 | 证据 |
|---|---|---|---|
| child terminal | `invoke-single-cat.ts` finally | `TurnExecutionStore.transitionTerminal`；注册失败时 credential failed | `invoke-single-cat.ts:6397`、`:2118/2133` |
| auth projection | `CallbackAuthTurnExecutionLifecycle.ts` | canonical TurnExecution first，再 `registry.commitTerminal` | `CallbackAuthTurnExecutionLifecycle.ts:66-83` |
| response R + draft | `route-serial.ts` / `route-parallel.ts` | commit R、delete draft、A2A successor | `route-serial.ts:3488+`、`route-parallel.ts:2015+` |
| parent + queue + recovery | `QueueProcessor.ts` | parent aggregate、queue terminal/retry、`settleResponseFromDraft` recovery | `QueueProcessor.ts:2865`、`:2669`、`:2717` |

`settleResponseFromDraft` 是 recovery/second phase，不是正常路径的唯一 settlement。

## 3. codeteam 为什么会走偏

### 3.1 时间线

| 提交 | 做了什么 | 副作用 |
|---|---|---|
| `a654788e5` | 落 F018 operator routing + per-agent pipeline：`runAgentTurn`，`routeAgents` 保留 parallel/serial | routeSerial/Parallel 变薄 scheduler，terminal/R/draft 归属开始移动 |
| `09bdb678d` | 展开 3.5 AgentRouter / runAgentTurn / routeAgents 的 ownership boundary | 需要一个新的“共享 settlement 出口”来避免 route 两份实现 |
| `28cfee444` | 采纳 target attempt retry：`invocation_attempts` append-only，retry 追加 attempt | attempt state 被写成 TurnExecution 五态；child 出现第二个终态字段 |
| `086b4b1f2` | 收口 Phase A gaps：新增 `settleAgentTurn`（P0-1=A） | 把 invoke/route/QueueProcessor/callback-auth 四层合并成一个 god-service |
| `b398c992f` | DP-F018TERM：terminal first-write-wins、retry、tracker slot | 给双状态补了更多一致性约束，但没有消除双状态本身 |

### 3.2 根因一：把“投递 attempt”当成“child 执行 attempt”

`28cfee444` 的目标是对的：retry 单位是 target attempt，不是 queue entry。
但 codeteam 当时没有把 `QueueTargetAttempt` 的投递状态和 `TurnExecution` 的
执行状态分开，而是让 `invocation_attempts.state` 直接复制了
`running/completed/failed/...`。这样 attempt 看起来像“第二个 child”，于是：

- 需要保证 `TurnExecution.status` 和 `attempt.state` 同步；
- terminal 事务必须同时写两者；
- recovery 必须判断哪个先写、哪个可信；
- 读模型不知道该用哪个判断 successful/failed。

### 3.3 根因二：用 god-service 解决 route 两份实现

`a654788e5` 把 routeSerial/routeParallel 变成薄 scheduler，provider/stream 下沉；
为了避免两个 route 各自写一套 child terminal + parent aggregate + credential + R，
`086b4b1f2` 加了 `settleAgentTurn`。问题是：

- Clowder 本来就不是“一个 settlement 函数”，而是四层 owner；
- 合并后，route 仍然要提交 R，invoke 仍然要 terminal child，QueueProcessor 仍然要
  聚合 parent；`settleAgentTurn` 只是把它们的调用关系藏在同一个名字下；
- 调用者无法从接口判断“我该在正常路径还是异常路径调用它”，于是三处都能触发。

### 3.4 不是 Clowder 不可复用

Clowder 的接口本来就是为这种拆分设计的：`TurnExecutionStore` 只做 child、
`QueueTargetAttempt` 只做投递、`MessageStore` 只做 R、`QueueProcessor` 只做 parent。
codeteam 的偏差来自两次局部收敛用了新抽象（attempt 五态、god-service）替代已有边界，
不是 Clowder 的运行时依赖问题。

## 4. 修改后的 attempt 设计

### 4.1 语义

`invocation_attempts` 保留表名，但语义改为 **target delivery attempt**：

- 一行 = 一个 target 的一次投递/执行尝试；
- 它回答“这次尝试到了 queued / starting / appended / handled / failed…”，
  不回答 child 的 provider 终态；
- child 终态由 `TurnExecution.status` 独占；
- retry append 新行，旧行不可变。

### 4.2 状态机

```text
queued
  ├─ markStarting ──▶ starting
  │                    ├─ bindAppended ──▶ appended ──▶ handled
  │                    ├─ markPrestartFailure ──▶ failed
  │                    └─ markPrestartCanceled ──▶ canceled
  └─ markPrestartCanceled ──▶ canceled

appended
  ├─ child completed ──▶ handled
  ├─ child failed ──▶ failed
  ├─ child interrupted ──▶ interrupted
  └─ child canceled ──▶ canceled
```

- `queued`：attempt row 已创建，尚未 claim。
- `starting`：target 已 claim，prestart binding 进行中。
- `appended`：prompt 已被 provider 接受，child TurnExecution + credential + processing R
  已绑定；`turn_execution_id` 必填。
- `handled`：child completed/R 可能仍在 response_pending；delivery attempt 已成功。
- `failed/interrupted/canceled`：delivery attempt 终态；prestart 失败允许没有 child。
- terminal 后不可改写。

### 4.3 表结构（修订）

```sql
CREATE TABLE invocation_attempts (
  attempt_id TEXT PRIMARY KEY,
  parent_invocation_id TEXT NOT NULL,
  queue_entry_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),

  turn_execution_id TEXT UNIQUE,
  delivery_state TEXT NOT NULL CHECK (delivery_state IN (
    'queued', 'starting', 'appended', 'handled',
    'failed', 'interrupted', 'canceled'
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
  delivery_boundary_seq INTEGER,
  prompt_delivered_at INTEGER,

  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,

  CHECK (delivery_state NOT IN ('appended', 'handled') OR turn_execution_id IS NOT NULL),
  CHECK (delivery_state <> 'handled' OR turn_execution_id IS NOT NULL),
  CHECK (delivery_state NOT IN ('failed', 'interrupted', 'canceled') OR terminal_reason IS NOT NULL),
  CHECK (delivery_state IN ('queued', 'starting') OR turn_execution_id IS NOT NULL
         OR delivery_state IN ('failed', 'canceled')),
  CHECK (settlement IS NULL OR response_message_id IS NOT NULL),
  CHECK (settlement IS NULL OR delivery_state NOT IN ('queued', 'starting')),
  CHECK (response_message_id IS NULL OR delivery_state NOT IN ('queued', 'starting')),
  CHECK (settlement <> 'streaming' OR delivery_state = 'appended'),
  CHECK (settlement <> 'response_pending' OR delivery_state NOT IN ('queued', 'starting', 'appended')),
  CHECK (settlement <> 'settled' OR delivery_state NOT IN ('queued', 'starting', 'appended')),
  CHECK (prompt_delivered_at IS NULL OR delivery_state = 'appended'),
  UNIQUE (parent_invocation_id, target_agent_id, attempt),
  FOREIGN KEY (parent_invocation_id)
    REFERENCES invocation_records(invocation_id) ON DELETE RESTRICT,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT,
  FOREIGN KEY (turn_execution_id)
    REFERENCES turn_executions(turn_execution_id) ON DELETE SET NULL,
  FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE SET NULL,
  FOREIGN KEY (response_message_id) REFERENCES messages(id) ON DELETE RESTRICT
) STRICT;
```

关键差异：

- `state` → `delivery_state`；不再出现 `running/completed`。
- `handled` 必须绑定 child；prestart `failed/canceled` 允许没有 child。
- `settlement` 仍是 response 状态，不是 execution state。
- `response_message_id` 在 appended 时写入，R terminal 后 settlement=settled。

### 4.4 Store 接口

```ts
interface InvocationAttemptStore {
  appendQueued(input: {...}): AttemptResult;
  markStarting(attemptId: string, input: { claimId: string; now: number }): AttemptResult;
  bindAppended(attemptId: string, input: {
    turnExecutionId: string;
    agentSessionId: string;
    workerId: string | null;
    provider: string;
    model: string;
    modelFamily: string;
    responseMessageId: string;
    now: number;
  }): AttemptResult;
  markPromptDelivered(attemptId: string, input: {
    deliveryBoundarySeq: number;
    now: number;
  }): AttemptResult;
  recordUsage(attemptId: string, usage: TokenUsage, now: number): AttemptResult;
  setSettlement(attemptId: string, input: {
    settlement: 'streaming' | 'response_pending' | 'settled';
    responseMessageId?: string;
    now: number;
  }): AttemptResult;
  projectChildTerminal(attemptId: string, input: {
    turnExecutionId: string;
    childStatus: 'completed' | 'failed' | 'interrupted' | 'canceled';
    terminalReason: string | null;
    endedAt: number;
  }): AttemptResult;
  markPrestartTerminal(attemptId: string, input: {
    status: 'failed' | 'canceled';
    terminalReason: string;
    endedAt: number;
  }): AttemptResult;
  getLatest(invocationId: string, targetAgentId: string): InvocationAttempt | null;
  getByTurnExecutionId(turnExecutionId: string): InvocationAttempt | null;
  listByInvocation(invocationId: string): InvocationAttempt[];
  listActive(): InvocationAttempt[];
  listResponsePending(): InvocationAttempt[];
}
```

`projectChildTerminal` 不是任意 terminal 写入：

- 先读 `TurnExecution.get(turnExecutionId)`；
- 校验 `record.status` 与传入 childStatus 一致；
- 只允许 `appended → handled|failed|interrupted|canceled`；
- 同一 child 重复调用幂等；不同 status 返回 `terminal_conflict`；
- 不允许 attempt 反向覆盖 TurnExecution。

## 5. 修改后的 settlement 设计

### 5.1 删除 `settleAgentTurn`

`settleAgentTurn` 这个名字同时暗示“child terminal、attempt、parent、credential、R”
都由它负责，正是重叠的根源。修改后不再有该接口；改为四个明确 owner：

| 阶段 | owner | 唯一职责 | 不做什么 |
|---|---|---|---|
| T1 child terminal | `invoke-single-agent` + `TurnExecutionLifecycle` | `TurnExecution.transitionTerminal`；project credential terminal；project attempt `handled/failed/...`；set settlement `response_pending` | 不提交 response R；不删 draft；不写 parent aggregate |
| T2 response commit | `route-serial` / `route-parallel` | commit response R（content/toolEvents/thinking）；delete draft；A2A successor | 不写 child terminal；不写 credential；不写 parent aggregate |
| T3 parent aggregate | `QueueProcessor` + `PerAgentTerminalDispositionCollector` | parent status/successfulAgentIds/terminalReason；queue entry terminal/retry；tracker slot release | 不写 child；不写 credential；不提交正常 R |
| T4 recovery | `ResponseRecoveryService` | `settleResponseFromDraft` for response_pending/abandoned；`response_missing` recovery | 不改写已完成 child/credential；不重新 terminal parent |

### 5.2 正常路径（成功）

```text
invoke-single-agent:
  [T1a] dispatch tx
    attempt queued→starting→appended
    TurnExecution.createRunning
    credential.create
    response R(processing)
    attempt.response_message_id=R.id; settlement='streaming'
  stream provider events
  [T1b] finally:
    canonical = TurnExecution.transitionTerminal(completed)
    credential.projectTerminal(canonical)
    attempt.projectChildTerminal(completed)
    attempt.settlement='response_pending'
  yield done

route-serial/parallel:
  [T2] commitLifecycleResponseTerminal(R, final body)
       draftStore.delete
       attempt.settlement='settled'
       clearResponsePending
       A2A successor admission

QueueProcessor:
  [T3] collector reads latest attempts + TurnExecutions
       applyTerminalAggregate(parent)
       queue entry terminal/retain
       tracker slot release
```

### 5.3 事务边界

**T1（child terminal transaction）**

同一 SQLite `BEGIN IMMEDIATE`：

1. `TurnExecutionStore.transitionTerminal`（canonical first）；
2. `InvocationCredential` terminalize / auth projection；
3. `InvocationAttemptStore.projectChildTerminal`（只投影 canonical）；
4. `attempt.settlement='response_pending'`；
5. `response_pending` ledger 由 TurnExecution terminal 原子进入。

如果 credential projection 失败：canonical child terminal 不回滚；记录 auth
projection 失败，startup `repairFromCanonical` 修复。这是 Clowder
`CallbackAuthTurnExecutionLifecycle` 的 crash window 语义。

**T2（response commit transaction）**

正常 route 的 R 提交是独立事务：

1. `MessageStore.commitLifecycleResponseTerminal`（R processing → terminal）；
2. `draftStore.delete`（失败保留 pending，下次 settlement 再删）；
3. `attempt.settlement='settled'`；
4. `clearResponsePending`；
5. A2A successor admission（同事务或紧随，按现有 route 实现）。

T2 失败不回滚 T1；R 仍 processing、attempt `response_pending`，由
`ResponseRecoveryService` 从 draft 重试。parent aggregate 可以基于 T1 的 child
terminal 先完成，但 R 未 terminal 时 `response_pending` 必须保留。

**T3（parent aggregate transaction）**

QueueProcessor 单独事务：

1. 读取每个 target 的最新 attempt + canonical TurnExecution；
2. 计算 parent status/successfulAgentIds/terminalReason；
3. 写 parent；
4. queue entry terminal/retain；
5. tracker slot release。

T3 不等待 T2 成功；T2 失败由 T4 补。T3 也不能用 attempt 的 delivery_state 代替
child status 来判断 successful/failed。

**T4（recovery）**

`ResponseRecoveryService` 只在以下场景运行：

- startup `response_pending` 扫描；
- route 抛异常后的 abandoned response；
- reaper 收敛 zombie child 后 R 仍未 terminal；
- R 缺失的 `response_missing`。

它只提交/修复 R、删 draft、set settlement；不重新 terminal child，不重新聚合 parent。

### 5.4 错误 / 取消 / 重试

| 场景 | T1 | T2 | T3 |
|---|---|---|---|
| provider 失败 | child failed；attempt failed；settlement response_pending | R failed（带 draft 正文） | parent partial_failed/failed |
| provider 超时 | child failed（reason=member_timeout）；attempt failed | R failed | parent 按 target 聚合 |
| operator cancel | child canceled；attempt canceled；credential canceled | R canceled（带已 stream 正文） | parent canceled/partial |
| prestart 失败 | 无 child；attempt starting→failed；credential failed | 不执行 | delivery_failure message；parent target failed |
| R commit 失败 | child terminal 已提交；settlement response_pending | 失败，R 仍 processing | parent 可先聚合；T4 重试 R |
| daemon crash before T1 | child running；attempt appended | 无 | startup reaper → T1 interrupted，再 T3/T4 |
| daemon crash between T1/T2 | child terminal；attempt response_pending | 未执行 | startup T4 从 draft 提交 R；T3 重跑 aggregate |
| retry | 新 attempt queued→starting→appended + 新 child | 新 R | parent queued→running→terminal |

### 5.5 父子/attempt 读取规则

- parent aggregate 的 successful 判定：target 最新 attempt 的 `turn_execution_id`
  对应 child `completed`；没有 child 的 prestart 失败按 failed。
- failed/canceled 判定：有 child 用 child status；无 child 用 attempt delivery_state。
- `attempt.delivery_state='handled'` 只表示这次投递成功，不直接等于 parent completed；
  parent 还要看所有 target。
- `attempt.settlement` 不参与 parent status 判定；它只表示 R 是否已 terminal。
- read model 的 execution status 读 TurnExecution；delivery status 读 attempt；
  两者不能互相替代。

## 6. Schema / migration 变更

### 6.1 字段变更

| 现字段 | 目标 | 处理 |
|---|---|---|
| `invocation_attempts.state` | `delivery_state` | rename；不再有 running/completed |
| `invocation_attempts.turn_execution_id` | 保留 | appended/handled 必填；prestart failed/canceled 可空 |
| `invocation_attempts.settlement` | 保留 | response 状态，不是 execution state |
| `invocation_attempts.response_message_id` | 保留 | appended 时写入 |
| `turn_executions.status` | 保留 | child 唯一 canonical |
| `invocation_records.status` | 保留 | parent aggregate |

### 6.2 旧数据映射

| 旧 `state` | 新 `delivery_state` | 条件 |
|---|---|---|
| `queued` | `queued` | 无 |
| `running` | `appended` | `turn_execution_id` 非空 |
| `running` | `starting` | `turn_execution_id` 为空（prestart） |
| `completed` | `handled` | 必须有 child completed |
| `failed` | `failed` | 有/无 child 均可；无 child 视为 prestart |
| `interrupted` | `interrupted` | 必须有 child |
| `canceled` | `canceled` | 有/无 child 均可 |

迁移校验：

- `completed` 行必须有 `turn_execution_id`，且 child 状态为 completed；
- `interrupted` 行必须有 child；
- `failed`/`canceled` 无 child 时标记为 prestart；迁移报告列出数量；
- `settlement` 非空必须有 `response_message_id`；不满足进 preflight，不静默改状态。

### 6.3 兼容窗口

- R1 先加 `delivery_state` 列并双写（旧 `state` 只读），R2 停止写旧列；
- 读模型只读 `delivery_state` + `TurnExecution.status`；
- R5 drop 旧 `state`；
- 旧 `running` 行迁移前先按 startup recovery 收敛（interrupt/terminal），不把 live
  running 直接改成 appended。

## 7. 验收测试

### 7.1 单写者

- grep/guard：生产代码不存在 `settleAgentTurn`；
- 只有 `TurnExecutionLifecycle` 调用 `TurnExecutionStore.transitionTerminal`；
- 只有 route 调用 `commitLifecycleResponseTerminal`（正常路径）；
- 只有 QueueProcessor/collector 调用 `applyTerminalAggregate`；
- 只有 `ResponseRecoveryService` 调用 `settleResponseFromDraft`。

### 7.2 双状态负例

- attempt 直接写 `handled` 但 child 仍 running → 拒绝；
- child completed 但 attempt 写 failed → `terminal_conflict`，保留 child；
- 同 child 重复 `projectChildTerminal` → 幂等；
- 旧 attempt retry 后不被改写；新 child 的 terminal 不影响旧 attempt；
- prestart failed/canceled 没有 child，允许；
- prestart 失败 attempt 不能伪造 `handled`。

### 7.3 崩溃窗口

- crash before T1：startup reaper → child interrupted；attempt interrupted；T4 R
  settlement（如有 R）。
- crash between T1/T2：child terminal；attempt response_pending；R processing；
  startup T4 从 draft 提交 R；T3 重跑 parent aggregate。
- crash between T2/T3：R terminal；attempt settled；T3 从 canonical child 重算 parent。
- T2 失败：child terminal 保留；R processing；T4 重试；parent 不重复 terminal。

### 7.4 E2E

- 单 agent 成功：T1→T2→T3 各一次；attempt handled + settlement settled；parent completed。
- provider 失败：T1 failed；T2 failed R；parent partial_failed/failed。
- cancel 单 target：只有该 target T1 canceled；sibling 继续；parent partial/canceled。
- prestart 失败：无 child；attempt failed；delivery_failure；无 R。
- retry：同一 parent/source/queue；新 attempt+1/新 child/新 R；旧 attempt 不可变。
- multi_mention：per-target attempt 投影 + aggregate message 不重复。

## 8. 与 0010 的具体修改点（待确认后执行）

| 0010 位置 | 修改 |
|---|---|
| §3.9 `settleAgentTurn` 接口 | 删除；替换为 §5 的四层 owner + `TurnExecutionLifecycle` / `RouteResponseCommitter` / `InvocationAggregateService` / `ResponseRecoveryService` |
| §3.9 正常终态路径 | 改为 T1 child → T2 R → T3 parent；不再“一个事务包全部” |
| §4.3.1 `invocation_attempts` | `state`→`delivery_state`；状态机改为 queued/starting/appended/handled/failed/interrupted/canceled |
| §5.2.1 InvocationAttempt | 同上；terminal 投影只由 `projectChildTerminal` 产生 |
| §9.3/§9.3.1 验收 | 增加单写者/双状态负例/崩溃窗口 |
| plan 0020 P0-1 | 从“settleAgentTurn 接口”改为“四层 settlement owner” |

## 9. 决策请求

| 决策 | 推荐 | 备选 | 理由 |
|---|---|---|---|
| DP-C child 终态 | **A：TurnExecution 单 canonical；attempt 只做投递状态** | B：attempt 单 canonical | Clowder 的 child canonical 是 TurnExecution；attempt 是投递台账 |
| DP-D settlement owner | **A：拆回四层 owner，删除 `settleAgentTurn`** | B：保留 god-service 并补单一 writer | Clowder 已经分层；合并会继续制造重叠 |

如果确认 A/A，下一步：

1. 改 0010 §3.9/§4.3.1/§5.2.1/§9；
2. 改 plan 0020 P0-1 和 R2/R4 验收；
3. 加 migration + single-writer/crash-window tests；
4. 在 0015 标记 DP-C/DP-D decided。

## 10. 参考

- Clowder `TurnExecutionStore.ts` / `RedisTurnExecutionStore.ts`
- Clowder `packages/shared/src/types/queue-receipt.ts:250-287`
- Clowder `invoke-single-cat.ts:6397`、`:2118/2133`
- Clowder `CallbackAuthTurnExecutionLifecycle.ts:66-83`
- Clowder `route-serial.ts:3488+`、`route-parallel.ts:2015+`
- Clowder `QueueProcessor.ts:2865/2669/2717`
- codeteam `0010` §3.9/§4.3.1；`0015` §3.3/§3.4/§3.5；plan 0020 P0-1
- codeteam commits `28cfee444`、`086b4b1f2`、`a654788e5`、`09bdb678d`

[宪宪/deepseek-flash🐾]



