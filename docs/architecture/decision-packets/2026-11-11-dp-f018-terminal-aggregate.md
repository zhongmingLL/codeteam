---
title: "DP-F018TERM: A2A terminal aggregate / retry / collector 拍板包"
doc_kind: decision-packet
status: decided
created: 2026-11-11
updated: 2026-11-11
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related: ../0010-a2a-runtime-chain.md
related_features: [codeteam/F018]
operator_decision: "DP-F018TERM-1=A, DP-F018TERM-2=A, DP-F018TERM-3=A, DP-F018TERM-4=A, DP-F018TERM-5=A, DP-F018TERM-6=A, DP-F018TERM-7=A (2026-11-11)"
---

# DP-F018TERM: A2A terminal aggregate / retry / collector

> 只给 operator 需要拍的价值取舍；并发 CAS、collector 测试、`no_response` 清理等
> 技术修复已在 §8 自决，不需要 operator 选。

> **2026-11-12 后续决策**：DP-C=A、DP-D=A 已把 child terminal / R / parent
> aggregate 拆成 T1/T2/T3/T4；本 packet 中“child terminal → parent aggregate →
> credential 同事务”的旧表述由 `0010` §3.9 与 `0016` 取代。历史决策本身不变。

## 0. 一句话

3.9 的终态/重试骨架是对的，但有 7 个选择会直接影响 parent 显示状态、tracker 占用、
重试语义和失败原因；其中 6 个是 operator 可感知的产品/契约选择，1 个是失败诊断。

## 1. 先看结论

| 决策 | 选项 | 推荐 | 影响面 | 不拍的后果 |
|---|---|---|---|---|
| DP-F018TERM-1 全部 target canceled 时 parent 状态 | A=`canceled`；B=`failed`；C=`partial_failed` | **A** | UI、retry 资格、operator 认知 | 用户主动取消被显示成“失败”，还可能被 retry |
| DP-F018TERM-2 auto-retry pending target 是否阻止 parent terminal | A=保持 `queued`/`running` 直到重试耗尽；B=立即 `failed`；C=不做 auto-retry | **A** | 失败时机、retry 冲突、UI | parent 先 failed，后台还在重试；operator 困惑/重复 retry |
| DP-F018TERM-3 tracker slot 何时释放 | A=每个 child terminal 就释放；B=parent terminal 才释放；C=retry/abandon 时释放 | **A** | `(threadId, agentId)` 占用、并发/重试 | failed target 永久占槽，后续 turn/retry 被 `isBusy` 挡住 |
| DP-F018TERM-4 终态幂等语义 | A=first-write-wins + `terminal_conflict`；B=last-write-wins；C=重复即抛错 | **A** | reaper vs worker 竞态、messageCount/ack | 重复终态导致双计数、回滚已提交终态或误报错 |
| DP-F018TERM-5 `requestRetry` 归属与资格 | A=store 只改 parent state/retryCount，QueueProcessor 编排 exact entry/attempt/pending target；只 retry failed/interrupted；B=store 做全部；C=service facade + 可 retry canceled | **A** | API 边界、canceled 语义、实现分叉 | 两个 `requestRetry` 实现；canceled target 被错误复活 |
| DP-F018TERM-6 retry 的 dispatchRefs 与 failed entry 保留 | A=每个 target 一个 ref，retry 更新为最新 attempt；failed entry 保留到显式 abandon/TTL；B=每次 attempt 追加 ref + TTL；C=不做 ref + 永久保留 | **A** | 消息 read model、审计、queue 泄漏 | 旧 failed 响应残留；failed entry 永不清理 |
| DP-F018TERM-7 parent 失败原因 | A=持久化首个 terminal error；B=只从 attempts 派生；C=不保存 | **A** | UI/诊断/retry 决策 | 只看到 `failed`，不知道原因 |

## 2. 背景与 current truth

- 3.9 已定义 child terminal → collector → parent aggregate → credential/session 同事务；
  attempt append-only；retry 复用同一 queue entry（`0010 §3.9`）。
- `InvocationRecordStore` 已有 `requestRetry`/`markRunning`/`applyTerminalAggregate`
  （`0010 §3.3`），但 §3.9 又说 `requestRetry` 是 QueueProcessor 编排，不是单个 store
  方法；这是需要拍板的 API 边界。
- §3.9 聚合表把 `failed/interrupted/canceled` 混在一起，且没有 auto-retry pending 行；
  Clowder `PerCatTerminalDispositionCollector` 明确区分 `areAllTargetsCanceled()` 和
  `primaryTerminalError`。
- Clowder `retryRoutingTarget` 只接受 target `status='failed'`
  （`queue-routing-recovery.ts:110`），canceled 不通过该路径重试。

## 3. DP-F018TERM-1：全部 target canceled

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | 0 completed + 全部 canceled（无 failed/interrupted）→ parent `canceled` | 取消不是失败；UI/retry 语义正确 | 需要聚合表新增一行；canceled 不走 retry |
| B | 全部 canceled → `failed` | 实现最简单 | 用户主动停止被显示成失败；可能被 retry |
| C | 全部 canceled → `partial_failed` | 保留“未完成”感 | 语义错误；没有 failed target |

**推荐理由**：Clowder 用 `areAllTargetsCanceled()` 显式判 canceled
（`QueueProcessor.ts:5692-5699`）；codeteam 应保留同一语义。mixed canceled+failed
仍可落 `failed`，但全 canceled 必须是 `canceled`。

**不拍的后果**：operator 取消整条消息后 UI 显示 failed，retry 入口还会出现。

## 4. DP-F018TERM-2：auto-retry pending 与 parent terminal

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | target 仍 pending + 有 `RetryDeferrals` → parent 保持 `queued`/`running`，不落 failed | parent 状态与后台真实状态一致 | 聚合表需要 `retryablePending` 维度 |
| B | 只要有 failed attempt 就 parent `failed`，后台继续 retry | 状态简单 | operator 看到 failed 但系统还在跑；retry 冲突 |
| C | 不做 auto-retry，所有失败都要 operator 手动 retry | 最简单 | 丢失 pre-handoff 自愈能力；与 3.9 现设计冲突 |

**推荐理由**：Clowder `deferFailedAttempt` 把 pre-handoff 失败 target 留在 pending，
由 backoff 重试；parent 不应先 terminal。

**不拍的后果**：parent 先 failed，retry 入口出现，但 RetryDeferrals 又自动启动一次，
形成重复 retry/UI 抖动。

## 5. DP-F018TERM-3：tracker slot 释放

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | 每个 child terminal（completed/failed/interrupted/canceled）立即释放对应 `(threadId, agentId)` slot | 不占槽；retry/new turn 立即可用 | 需要把 slot release 从 parent terminal 拆开 |
| B | parent completed/canceled 才释放 | 实现少一条路径 | failed/partial_failed target 永久占槽；retry 被 `isBusy` 挡住 |
| C | retry/abandon 时释放 | 折中 | 失败但未 retry 的 target 仍占槽 |

**推荐理由**：tracker slot 是 child/target 级占用，不是 parent 生命周期；Clowder 按
per-target terminal 释放。

**不拍的后果**：一个 failed target 会让该 agent 在该 thread 永久 busy，后续消息无法调度。

## 6. DP-F018TERM-4：终态幂等

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | first-write-wins；同 status 重复调用返回已有结果（no-op）；不同 status 返回 `terminal_conflict`；credential 同 disposition no-op | reaper/worker 竞态安全；不双计数/不回滚 | 需要 `settleAgentTurn` 返回 typed outcome |
| B | last-write-wins | 简单 | 终态可被覆盖；messageCount/ack/R 不可逆 |
| C | 重复调用直接抛错 | 暴露 bug | reaper 与正常完成竞态会误报；上层要额外 catch |

**推荐理由**：Clowder `commitTerminal` 是 monotonic first-write-wins，并在 disposition
冲突时发 lifecycle signal。codeteam 应保持一致。

**不拍的后果**：`InvocationOwnerReaper` 与 provider completion 同时 terminal 时，
可能 double `recordTurnTerminal`/ack，或把已提交终态回滚。

## 7. DP-F018TERM-5：requestRetry 归属与资格

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | `InvocationRecordStore.requestRetry` 只改 parent `failed|partial_failed → queued`、`retryCount++`、清 endedAt/reason；QueueProcessor 在同一事务做 exact-entry claim、追加 attempt+1、把 failed/interrupted target 放回 pending、start 后 markRunning | 单一事务边界；store 不做 queue 编排；canceled 不被复活 | 需要明确 QueueProcessor service 入口 |
| B | `requestRetry` store 方法做全部（queue/attempt/pending） | 调用简单 | store 跨域；事务边界混浊；与 §3.9 现描述冲突 |
| C | 独立 service facade；允许 retry canceled | 统一入口 | canceled 语义错误；service/store 分叉更深 |

**推荐理由**：Clowder `retryRoutingTarget` 只接受 failed target，且是 QueueProcessor
编排；store 只应拥有 parent 状态/retryCount。canceled target 要重试应发新消息，不
reopen 旧 attempt。

**不拍的后果**：实现会出现两个 `requestRetry`；canceled target 被 retry 后与“取消即终止”冲突。

## 8. DP-F018TERM-6：retry 的 dispatchRefs 与 failed entry

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | message 每个 target 一个 `DispatchRef`；retry 更新该 ref 的 `attempt`/`turnExecutionId`/清 `responseMessageId`；failed queue entry 保留到显式 abandon 或 TTL | 一个 target 一条最新 ref；attempt 历史在 `invocation_attempts`；queue 可清理 | 需要 update ref + abandon/TTL 实现 |
| B | 每次 attempt 追加一条 ref | 审计完整 | message.dispatchRefs 随 retry 增长；read model 需选 latest |
| C | retry 不写 ref；failed entry 永久保留 | 实现最少 | 旧 failed 响应残留；queue 泄漏 |

**推荐理由**：attempt 台账已经 append-only；message ref 只需要指向最新 attempt。
failed entry 必须有一个 `abandon` 动作或 TTL，否则永远占 queue。

**不拍的后果**：消息 read model 显示旧失败响应；failed entry 永不清理。

## 9. DP-F018TERM-7：parent 失败原因

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | collector 返回 `primaryTerminalError`；parent `terminalReason` 持久化首个 terminal error | UI/retry/诊断可解释 | parent 多一个字段写入 |
| B | 只从 `invocation_attempts` 派生 | 不写 parent | 每条 UI/query 都要 join；首个 error 选择不稳定 |
| C | 不保存 | 最简单 | 只看到 `failed`，无法解释 |

**推荐理由**：Clowder collector 保留 `primaryTerminalError`（`PerCatTerminalDispositionCollector.ts:87-89`）；
codeteam 应把同一信息落到 parent `terminalReason`。

## 10. 已自决（不需要 operator 拍）

| 事项 | 决定 | 依据 |
|---|---|---|
| parent aggregate 并发 | 使用现有 `ControlTransaction`（`BEGIN IMMEDIATE`）串行化；拿到写锁后重读 attempts；`successfulAgentIds` 单调 union，不覆盖 | 多 child 并行 terminal；不需要额外 revision 字段 |
| collector 等价性 | DB latest-attempt collector 必须依赖 `transitionTerminal` first-write-wins；补 late `done` after error/cancel、旧 failed + 新 running、target 不在 parent 的测试 | Clowder event-stream collector 的 disqualify 语义 |
| `settleAgentTurn` `no_response` | R 在 attempt start 创建；删除 `no_response`，或只在无 R 的 prestart failure 使用并让 `responseMessageId` 条件必填 | 现有接口 `responseMessageId` 必填，和 `no_response` 矛盾 |
| `markRunning` 归属 | QueueProcessor 在 child 创建 + tracker start 的同一事务调用 | 避免 parent queued/running 抖动 |
| `successfulAgentIds` 顺序 | 按 `targetAgentIds` 顺序返回 | 稳定 UI/测试 |
| `terminalReason` taxonomy | `provider_failed` / `owner_reaped` / `preempted` / `canceled` / `routing_preflight_rejected` | 统一失败原因 |
| all-targets routing rejected | 保留 queue entry + parent failed/retryable，按 auto-retry 规则处理 | Clowder `routing_preflight_rejected` 保留 queue |
| dispatchRefs settlement | agent ref 在 child terminal/R settlement；operator ref 在通知时 | 3.1/3.8 现有规则 |

## 11. 落点

拍板后更新：

- `0010 §3.9`：聚合表新增 all-canceled/retryablePending；tracker slot release；
  `settleAgentTurn` already_terminal；requestRetry 事务边界；
- `0010 §3.3`：`InvocationRecordStore.requestRetry`/`markRunning`/`applyTerminalAggregate`
  与 service 的分工；
- `0010 §3.1/3.2`：queue entry retention/abandon、DispatchRef retry；
- `F018` feature / plan 0020：并发 terminal、all-canceled、auto-retry、canceled retry 负例；
- 实现侧：`a2a/terminal.ts`、QueueProcessor、InvocationRecordStore、InvocationAttemptStore。

## 12. 拍板方式

回复一行即可，例如：

`DP-F018TERM-1=A, DP-F018TERM-2=A, DP-F018TERM-3=A, DP-F018TERM-4=A, DP-F018TERM-5=A, DP-F018TERM-6=A, DP-F018TERM-7=A`

若某项要改选，只写改选项，例如 `DP-F018TERM-2=B`。

## 13. 拍板结果（2026-11-11）

全部按推荐 A：

| 决策 | 结果 |
|---|---|
| DP-F018TERM-1 | **A**：全部 target canceled → parent `canceled` |
| DP-F018TERM-2 | **A**：auto-retry pending 时 parent 保持 `queued`/`running` |
| DP-F018TERM-3 | **A**：每个 child terminal 释放 tracker slot |
| DP-F018TERM-4 | **A**：first-write-wins + `terminal_conflict` |
| DP-F018TERM-5 | **A**：store 只改 parent state/retryCount；QueueProcessor 编排；只 retry failed/interrupted |
| DP-F018TERM-6 | **A**：每个 target 一个 dispatchRef，retry 更新为最新 attempt；failed entry 显式 abandon + TTL |
| DP-F018TERM-7 | **A**：parent 持久化 `primaryTerminalError` |

[宪宪/deepseek-flash🐾]
