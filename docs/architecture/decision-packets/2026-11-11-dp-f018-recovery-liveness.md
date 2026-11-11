---
title: "DP-F018RECOVERY: startup reconciler / reaper / live projection 拍板包"
doc_kind: decision-packet
status: decided
created: 2026-11-11
updated: 2026-11-11
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related: ../0010-a2a-runtime-chain.md
related_features: [codeteam/F018]
operator_decision: "DP-F018RECOVERY-1=A, DP-F018RECOVERY-2=A, DP-F018RECOVERY-3=A, DP-F018RECOVERY-4=A, DP-F018RECOVERY-5=A, DP-F018RECOVERY-6=A, DP-F018RECOVERY-7=A (2026-11-11)"
---

# DP-F018RECOVERY: startup reconciler / reaper / live projection

> 只给 operator 需要拍的价值取舍；cutoff 算法、interval、去重、taxonomy 等技术修复已在 §10 自决。

## 0. 一句话

3.10 的 startup / reaper / live read model 方向对，但“TTL 到了就杀”“所有 response_pending 都结算”
会误伤当前进程的长 turn；需要 7 个选择来定恢复边界、liveness evidence 和 live projection。

## 1. 先看结论

| 决策 | 选项 | 推荐 | 影响面 | 不拍的后果 |
|---|---|---|---|---|
| DP-F018RECOVERY-1 startup response-pending 范围 | A=只处理上一进程已结束 turn（cutoff+protected）；B=全部 pending；C=startup 不结算 | **A** | 当前进程 live R、启动耗时 | 把还在 stream 的 R 提前 terminal |
| DP-F018RECOVERY-2 zombie liveness 证据 | A=stale lease + 独立 owner absence；B=TTL only；C=只在 startup 收敛 | **A** | 长 turn 误杀、僵尸残留 | 5min 长任务被周期 reaper 杀掉 |
| DP-F018RECOVERY-3 reaper 拓扑 | A=单个 serialized reaper；B=Zombie + OwnerReaper 两个；C=startup only | **A** | 双杀、凭证重复 terminal、slot 释放 | 两个 janitor 同时处理同一 child |
| DP-F018RECOVERY-4 zombie 收敛顺序/范围 | A=child R → queue entry → parent → credential → slot；B=只 parent/credential；C=只 child | **A** | R 卡 processing、queue 卡死、retry 状态 | UI 永远 processing；queue 被死 entry 挡住 |
| DP-F018RECOVERY-5 live projection | A=去重 + evidence rank + 过滤 terminal R；B=tracker+running 简单相加；C=只看 tracker | **A** | UI 幽灵执行、重复 cancel | 同一 turn 显示两次；已 terminal R 仍显示 running |
| DP-F018RECOVERY-6 response_missing 语义 | A=独立 `response_missing` recovery reason；B=复用 `delivery_failure`；C=忽略 | **A** | 失败原因、UI、恢复路径 | 与“delivery_failure 只用于 prestart”冲突 |
| DP-F018RECOVERY-7 provider exit 恢复 | A=5min finalization grace + exact owner fence；B=reaper 立即 interrupt；C=不做 provider-exit 路径 | **A** | provider 退出后的恢复延迟/误杀 | 正常 finalize 被误判为 zombie，或永远不收敛 |

## 2. 背景与 current truth

- 3.10 已有 `TurnExecutionStartupReconciler`、`ZombieTerminalRecovery`、
  `InvocationOwnerReaper`、`getThreadLiveInvocations`、`MessageDispatchSummary` 的概念。
- 3.10 目前只写 `interruptRunningBefore(cutoff)`，没有 `processStartedAt + 1`、protected IDs、
  response-pending 的 startedAt 过滤；也没有定义 zombie 的“owner”是什么。
- Clowder `TurnExecutionStartupReconciler` 用 exclusive cutoff + `excludedInvocationIds`，
  只结算 `startedAt < cutoff` 的 pending R，settlement 失败保留 pending，不 fail startup。
- Clowder `reconcileZombies` 用 stale lease + independent owner absence；zombie 收敛会先
  settle child responses、清 task progress、收敛 stale queue entry，再走 queue recovery。
- Clowder `InvocationOwnerReaperInterval` 用 inFlight 串行化；`RetireExitedChildExecutions`
  要求 process exit + 5min grace + exact owner fence。
- Clowder `live-invocation-projection` 有 evidence rank、过滤 terminal R、按 thread/user scope。

## 3. DP-F018RECOVERY-1：startup response-pending 范围

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | 只处理 `startedAt < processStartedAt + 1` 且非 protected 的 ended turn；settlement 失败保留 pending | 不碰当前进程 live R；下次 startup 可重试 | 需要 cutoff/protected 过滤 |
| B | 扫描全部 `listResponsePending()` 并结算 | 实现简单 | 当前进程正在 stream 的 R 可能被提前 terminal |
| C | startup 不结算，只靠运行期 reconciler | 启动快 | 重启后 processing R 可能长期悬挂 |

**推荐理由**：Clowder 明确只处理上一进程的 ended turn；当前进程 live turn 的 R 由正常
settlement 负责。settlement 失败不能 fail startup，保留 pending 下次再试。

**不拍的后果**：daemon 重启后可能把还在生成的 R 提前结束，用户看到半截响应。

## 4. DP-F018RECOVERY-2：zombie liveness 证据

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | stale worker lease + 独立 owner absence（heartbeat/lease、`RpcConnection.prompting`、provider 进程）；只有证据齐全才 interrupt | 不误杀长 turn | 需要 worker/provider liveness 查询 |
| B | running 超过 TTL 就 interrupt | 实现最简单 | 长 turn 被周期 reaper 误杀 |
| C | 只在 startup 收敛 | 运行期不做 | 运行期永久僵尸占 slot/queue |

**推荐理由**：TTL 只能做候选筛选，不能做终止证据；Clowder 要求 owner absence 才收敛。

**不拍的后果**：一个正常跑 5min 的 turn 被 2min TTL reaper 杀掉，或僵尸永远不收敛。

## 5. DP-F018RECOVERY-3：reaper 拓扑

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | 一个 `InvocationOwnerReaper`，内部串行 `runOnce` + interval inFlight guard；startup reconciler 只做启动一次性 | 单写者；不双杀 | 需要合并 Zombie/OwnerReaper |
| B | `ZombieTerminalRecovery` + `InvocationOwnerReaper` 各自跑 | 职责分开 | 两个 sweep 可能同时处理同一 child |
| C | 只在 startup 收敛，不做运行期 reaper | 最简单 | 运行期僵尸占 slot/queue |

**推荐理由**：Clowder 用 serialized interval；codeteam 3.10 自己写“v1 可以合并”，应直接定为
一个 reaper，避免两个 janitor 竞争。

**不拍的后果**：同一 child 被两个 reaper interrupt，parent/credential 重复 terminal，slot 释放两次。

## 6. DP-F018RECOVERY-4：zombie 收敛顺序与范围

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | child R settlement → stale queue entry 收敛 → parent aggregate → credential terminalize → slot release | R 不悬挂、queue 不卡死、retry 状态正确 | 需要跨 store 顺序 |
| B | 只 parent aggregate + credential | 实现少 | child R 卡 processing；queue entry 挡住后续消息 |
| C | 只 child terminal | 最小 | parent/queue/credential 不一致 |

**推荐理由**：Clowder `ZombieTerminalRecovery` 先 settle child responses，再走 queue recovery；
codeteam 必须把 queue entry 收敛（restore 到 queued 或 remove）与 retry anchor 规则对齐。

**不拍的后果**：UI 永远显示 processing；queue 被死 entry 挡住，retry 也无法进行。

## 7. DP-F018RECOVERY-5：live projection

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | tracker + durable running 去重；evidence rank（record+tracker > tracker-only > record-only）；过滤 terminal R；thread/user scoped | UI 不显示幽灵/重复执行 | 需要 merge 逻辑 |
| B | tracker slots + durable running 简单相加 | 实现简单 | 同一 turn 重复显示；terminal R 仍显示 running |
| C | 只看 tracker | 最轻 | daemon 重启后 live 丢失；durable running 不可见 |

**推荐理由**：Clowder `live-invocation-projection` 有 evidence rank 和 terminal R 过滤；
codeteam 读模型应复用同一语义。

**不拍的后果**：UI 出现幽灵执行/重复 cancel 按钮；用户无法判断哪个是真实 running。

## 8. DP-F018RECOVERY-6：response_missing 语义

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | 独立 `response_missing` recovery reason；写 R/system message + audit，不伪装成 prestart `delivery_failure` | 失败原因正确；不破坏 3.5 边界 | 多一个 typed reason |
| B | 复用 `delivery_failure` | 少一个 reason | 与“delivery_failure 只用于 prestart 未创建 R”冲突 |
| C | 忽略 missing R，只清 pending | 最简单 | 用户看到空响应；无可解释原因 |

**推荐理由**：`response_pending` 说明 R 曾存在；缺失是 recovery 异常，不是 prestart 失败。

## 9. DP-F018RECOVERY-7：provider exit 恢复

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | provider 进程退出后等 5min finalization grace + exact owner fence，再 `interrupted/provider_exited_without_terminal` | 不错误终止正常 finalize | 恢复延迟 5min |
| B | reaper 发现进程退出立即 interrupt | 恢复快 | 可能和正常 terminal 竞态，错误终止 |
| C | 不做 provider-exit 路径，只靠 heartbeat/TTL | 最简单 | provider 退出但 heartbeat 未过期时长期僵尸 |

**推荐理由**：Clowder `RetireExitedChildExecutions` 已经验证 grace + owner fence；codeteam
应复用语义，不重新发明 TTL。

## 10. 已自决（不需要 operator 拍）

| 事项 | 决定 | 依据 |
|---|---|---|
| startup cutoff | `processStartedAt + 1` exclusive；`protectedInvocationIds` 排除本进程/测试注入 child | Clowder `TurnExecutionStartupReconciler` |
| startup 顺序 | listen 成功后 recover；recovery 失败 best-effort，不拖垮 API；`startupRecoveryComplete` 标记 | Clowder `listenBeforeTurnExecutionRecovery` |
| reaper interval | 单个 serialized interval + inFlight guard；错误记录但不停止 interval | Clowder `InvocationOwnerReaperInterval` |
| live dedupe | 按 `turnExecutionId` 去重；thread/user scoped；返回顺序按 startedAt | 读模型稳定性 |
| status taxonomy | child `interrupted` + parent aggregate `failed`；reason `process_restart` / `owner_reaped` / `provider_exited_without_terminal` | 3.9 aggregate |
| queue entry 收敛 | zombie 的 stale processing entry restore 到 `queued`（保留 retry anchor）；source 已 withdrawn/canceled 才 remove | 3.2/3.9 retry rules |
| MessageDispatchSummary | v1 只做简单 read model；完整 schema/分页/排序放 v2 | 低风险展示 |
| trajectory | v1 不做 projector；只由 child + response + events 提供简单 timeline | 3.10 现 scope |

## 11. 落点

拍板后更新：

- `0010 §3.10`：startup cutoff/protected、response-pending scope、单 reaper、zombie 收敛顺序、
  live projection evidence rank；
- `0010 §3.9`：recovery 调用同一 collector/aggregate；`response_missing` typed reason；
- `0010 §3.2`：zombie queue entry restore/remove 规则；
- `F018` feature / plan 0020：restart/long-turn/zombie/live 负例；
- 实现侧：`TurnExecutionStartupReconciler`、`InvocationOwnerReaper`、`getThreadLiveInvocations`、
  QueueProcessor recovery。

## 12. 拍板方式

回复一行即可，例如：

`DP-F018RECOVERY-1=A, DP-F018RECOVERY-2=A, DP-F018RECOVERY-3=A, DP-F018RECOVERY-4=A, DP-F018RECOVERY-5=A, DP-F018RECOVERY-6=A, DP-F018RECOVERY-7=A`

若某项要改选，只写改选项，例如 `DP-F018RECOVERY-2=B`。

## 13. 拍板结果（2026-11-11）

全部按推荐 A：startup 只结算上一进程 ended turn；zombie 用 stale lease + owner absence；
单 serialized reaper；zombie 收敛 child R → queue → parent → credential → slot；
live projection 去重/evidence rank/过滤 terminal R；`response_missing` 独立 recovery；
provider exit 5min grace + owner fence。

[宪宪/deepseek-flash🐾]
