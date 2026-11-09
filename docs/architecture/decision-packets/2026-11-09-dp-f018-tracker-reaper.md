---
title: "DP-F018T: InvocationTracker / InvocationOwnerReaper 拍板包"
doc_kind: decision-packet
status: decided
created: 2026-11-09
updated: 2026-11-09
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related: ../../architecture/0010-a2a-runtime-chain.md
related_features: [codeteam/F018]
operator_decision: "DP-F018T-1=B (start 抢占), DP-F018T-2=B, DP-F018T-3=A (2026-11-09)"
---

# DP-F018T: InvocationTracker / InvocationOwnerReaper 拍板包

> 只给价值取舍、推荐、证据和“不拍的后果”。先解释 3 个概念，再给选项。

## 0. 一句话

3 个决定都围绕两件事：**一个 agent 同一时刻只能有一个执行**；**怎么判断一个执行是真的结束了，而不是在慢慢跑**。

## 1. 先看结论

| 决策 | 选项 | 推荐 | 影响面 | 不拍的后果 |
|---|---|---|---|---|
| DP-F018T-1 slot 获取 | A=tryStart 不抢占；B=start 抢占旧执行 | **B（已拍）** | QueueProcessor 行为、用户消息会不会打断在跑的任务 | 已拍：start 抢占；后续 Steer/插队依赖它 |
| DP-F018T-2 取消后的 slot 生命周期 | A=保留墓碑到收尾完成；B=取消即释放 | **B（已拍）** | session/worker 是否会被新旧执行叠写 | 已拍：取消即释放；靠 session/worker lease 做最终互斥 |
| DP-F018T-3 僵尸判定 | A=worker heartbeat；A′=heartbeat + ownership fence；B=status+TTL；C=provider lifecycle | **A（已拍）** | reaper 会不会误判长任务 / 漏掉被抢占的旧执行 | 已拍：只按 live worker 判断；旧 worker 还活着就不清理 |

## 2. DP-F018T-1：slot 获取——tryStart 还是 start 抢占

### 这个概念是什么

QueueProcessor 要让 agent A 执行一条消息，必须先“占住 A 的 slot”。如果 A 现在已经在跑另一条消息：

- **A（tryStart，推荐）**：这次不启动，返回 `null`。QueueProcessor 释放 claim，等 A 空闲再试。正在跑的那条不受影响。
- **B（start 抢占，Clowder）**：直接让正在跑的那条中断，让新消息接管。旧执行变成 `interrupted/preempted`。

### 两种行为的时间线

```text
A：tryStart
  消息 m1 正在跑 agent A
  消息 m2 到达，QueueProcessor 想跑 A
  → tryStart 返回 null
  → m2 留在队列；m1 正常完成；下一轮 drain 再跑 m2

B：start 抢占
  消息 m1 正在跑 agent A
  消息 m2 到达，QueueProcessor 想跑 A
  → m1 被中断
  → m1 标 interrupted/preempted
  → m2 立刻接管 A
```

### 选项

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| A | 忙则拒绝；显式取消才中断 | 不会因为一条新消息静默中断在跑的工作；行为可预测 | 忙时 m2 要等；需要队列的 `held`/defer 逻辑避免热循环 |
| **B（已拍）** | 忙则抢占 | “最新消息优先”；支持 operator 停止当前调用、插队执行 | 用户消息会打断在跑任务；需要 `preempted` 终态、未完成工作清理、UI 解释 |

**已拍理由**：后续要实现 Steer；operator 必须有一个开关，能停止当前调用并插队执行。抢占是 Steer 的底层原语：abort 旧执行、创建新 `TurnExecution`、旧执行标 `interrupted/preempted`。

**已拍后的设计影响**：

- `start` 采用抢占语义：同 slot 旧 controller 先中断，再登记新 slot；旧 `TurnExecution` 标 `interrupted/preempted`。
- v1 先提供原语：`cancel` + `priority:"urgent"` 的 queue entry；完整 Steer 交互（选择当前执行、停止、插队）后续加。
- 抢占必须有审计：旧 child 的 `terminalReason="preempted"`，credential terminalize，parent aggregate 更新。
- 普通消息默认不抢占；只有 operator 显式 Steer/停止动作才走抢占路径，避免“每条新消息都打断”。

## 3. DP-F018T-2：取消后 slot 要不要保留墓碑

### 这个概念是什么

取消不是“瞬间停”。agent 的 provider/worker 收到中断信号后还要做收尾：关闭流、写终态、清理临时文件、释放 session。如果取消时立刻把 slot 删掉，新执行可能在旧 worker 还没收尾时就占住同一 agent/session。

**墓碑（tombstone）** = 取消后先不删 slot，只标 `canceled`；等旧 worker 收尾完成（`complete`）再释放。

### 两种行为的时间线

```text
A：保留墓碑
  取消 agent A
  → slot.state = canceled；teardownComplete = false
  → 新消息到达，isBusy(A) = true（因为收尾未完成）
  → 等旧 worker 收尾，complete() 标 teardownComplete = true
  → slot 释放；新消息才能启动

B：取消即释放
  取消 agent A
  → slot 立刻删除
  → 新消息立刻启动新 worker
  → 旧 worker 可能还在写同一个 session/stream
```

### 选项

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| A | 保留 canceled tombstone 到收尾完成；`isBusy` 把 pending teardown 算忙 | 新旧执行不会叠写同一 session；取消/重启可预测 | 取消后下一次启动要等收尾；需要 `complete` 可靠调用；收尾卡死时由 reaper 清理 |
| **B（已拍）** | 取消即释放 slot | 实现简单；取消后马上能跑新消息；适合 Steer/插队 | 旧 worker 收尾与新 worker 并发；必须由 session/worker lease 做最终互斥 |

**已拍后的设计影响**：

- tracker 不再用墓碑表达“收尾中”；取消即释放 slot。
- 真正的互斥下移到 **AgentSession/worker lease**：新 `TurnExecution` 启动 provider 前，必须拿到该 `(agentId, agentSessionId)` 的 worker lease；旧 worker 未退出时，新启动返回 `worker_busy`，QueueProcessor 释放 claim，稍后重试。
- 旧 child 由抢占路径主动标 `interrupted/preempted`；如果旧 worker 还在跑，由 reaper 按“已被替换的 running child”清理。
- session/worker lease 必须比 tracker slot 更权威；tracker 只负责“当前 active 执行是谁”，不保证旧进程已经退出。

## 4. DP-F018T-3：怎么判断僵尸

### 这个概念是什么

“僵尸”= `TurnExecution` 还是 `running`，但实际已经没有 worker 在跑它（daemon 重启、worker 崩溃、进程丢失）。reaper 要清理僵尸，但不能误判一个只是跑得久的正常任务（长 build、长模型调用）。

### 三种判定

| 选项 | 判定方式 | 价值 | 代价 |
|---|---|---|---|
| **A（已拍）** | 查 worker registry：该 `(agentId, agentSessionId)` 是否有 live worker/heartbeat/未过期 lease | 长任务只要 worker 还活着就不会被误判；不清理仍在工作的旧执行 | 被抢占但旧 worker 还活着的 child 会保留到旧 worker 结束；需要 session/worker lease 防叠跑 |
| A′（未选） | **心跳 + execution ownership fence**：先看该 running child 是否仍是 `(threadId, agentId)` 的当前 owner；已被替换 → 宽限期后标 `interrupted/preempted`；仍是 owner → 再看 worker heartbeat | 能更早清理被抢占但仍在跑的旧 child | 需要 tracker 暴露当前 `turnExecutionId`；需要短宽限期 |
| B | 只看 `status=running` + 超过 TTL | 最简单；不依赖 worker registry | 长任务会被误判；TTL 调大则僵尸清理变慢 |
| C | 查 provider lifecycle snapshot（Clowder） | 最精确，能区分 provider 的 running/terminal | 需要 provider 适配；v1 是 pi worker，接入成本高 |

**已拍后的设计影响（A）**：

- `start` 抢占后，旧 child 标 `interrupted/preempted`；如果旧 worker 还在跑，reaper 看到 live heartbeat 就不动它。
- session/worker lease 是最终互斥：旧 worker 未退出时，新执行拿不到 lease，`start` 返回 `worker_busy`，QueueProcessor 释放 claim。
- 旧 worker 结束后，heartbeat/lease 过期；下一次 reaper 扫描发现没有 live worker，才把旧 child 标 `interrupted/owner_reaped`。
- 如果旧 worker 永久挂住且 heartbeat 一直有效，就不会被清理；这是 A 的接受代价——不误判仍在工作的执行。
- 因此 v1 的 reaper 不需要 ownership fence；只需要 `TurnExecution.listRunning()` + `WorkerStore` heartbeat。

**A 的清理顺序**：

1. `TurnExecution.listRunning()` + tracker stale slots。
2. child 已 terminal / 不存在 → 释放 tracker slot。
3. child running + worker heartbeat/lease 有效 → 保留。
4. child running + 无 live worker → `interrupted/owner_reaped`；credential terminalize；parent aggregate；释放 slot。
5. worker 状态读不到 → defer，不误判。

## 5. 不需要拍、我已自决的边界

| 事项 | 决定 | 依据 |
|---|---|---|
| slot key | `(threadId, agentId)` | 一个 agent 在同一 thread 只有一个执行 |
| controller | 每 slot 独立控制器；`startAll` 额外有 batch gate | 单猫取消不波及兄弟 |
| `tryStartAll` | all-or-nothing；任一 target busy 则全部不占用 | 避免部分 target 启动、部分失败 |
| executionId fence | `complete` / 取消只影响匹配 `turnExecutionId` 的 slot | 防止 late terminal 清掉 replacement |
| session seal/delete guards | v1 不做 | active-only session；无 seal/delete 流程 |
| LifecycleActiveRun 绑定 | v1 不做 | 无 append-to-active-run |

## 6. 拍板方式

回复一行即可，例如：

`DP-F018T-1=B, DP-F018T-2=B, DP-F018T-3=A`

**最终拍板（2026-11-09）**：`DP-F018T-1=B`（start 抢占）、`DP-F018T-2=B`（取消即释放）、`DP-F018T-3=A`（worker heartbeat）。本 packet 已冻结。

[宪宪/deepseek-flash🐾]
