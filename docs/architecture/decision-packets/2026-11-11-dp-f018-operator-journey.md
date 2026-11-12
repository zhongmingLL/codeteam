---
title: "DP-F018JOURNEY: operator journey / operator mention / multi_mention / settlement"
doc_kind: decision-packet
status: decided (A/B/E/C/D)
created: 2026-11-11
updated: 2026-11-11
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
operator_decisions: "2026-11-11: DP-A=A, DP-B=B, DP-E=A; 2026-11-12: DP-C=A, DP-D=A"
related: [0010-a2a-runtime-chain.md, 0014-operator-message-journey.md, 0015-codeteam-operator-journey-audit.md, 0016-turn-terminal-and-settlement-design.md]
---

# DP-F018JOURNEY

## 决策

| 决策 | 结论 | 状态 | 落点 |
|---|---|---|---|
| DP-A operator 通知 | operator 不是 `QueueTarget`；agent 正文行首 `@operator` 只写 message `mentionsUser`；`post_message` targets 可为空但仅限该情形 | decided A | `0010` §3.0/§3.8；`0005` §2.4/§3.3；`0014` Journey B |
| DP-B `multi_mention` | 真正实现 Clowder orchestrator：2-3 targets、status、3-20min timeout、callbackTo、aggregate；不保留假 fan-out | decided B | `0010` §3.8；`0005` §3.3；plan R3/R4 |
| DP-C child 终态 | Clowder 没有 child `InvocationAttempt`；attempt 是 `QueueTargetAttempt`（投递台账），child canonical 是 `TurnExecution`；codeteam 收敛为 `delivery_state` | decided A | `0010` §3.5/§4.3.1/§5.2.1；`0015` §3.3 |
| DP-D settlement owner | Clowder 是 invoke（child terminal）/route（R+draft）/QueueProcessor（parent+queue）/recovery 四层；`settleAgentTurn` god-service 拆回 | decided A | `0010` §3.6/§3.9/§9；`0015` §3.4 |
| DP-E Hub 依赖 | Hub ingress/WS/SSE/replay 归 W7a/F016c 独立验收；F018 只验收 daemon/CLI | decided A | `0010` §7.2；plan 验证段；`0015` §4.2 |

## DP-A 关键边界

- `QueueTarget` 只允许 agent。
- `post_message` targets 为空 = message-only write：只写 message，不创建
  queue/parent/TurnExecution；`@operator` 只是额外写 `mentionsUser`。普通 final
  response 已经是 message，operator decision 不需要再调用 `post_message`。
- `post_message` targets 非空时，operator mention 只作为同一 message 的额外标记，
  不进入 parent aggregate/retry。
- operator 回复是一条新的 user message，重新走 ingress；不是“恢复 agentB 的等待”。

## DP-B 关键边界

- `multi_mention_requests`：request/targets/callbackTo/status/timeout/expires/parent/
  source/aggregate。
- `multi_mention_responses`：per-target received/timeout/failed + turn/response 指针。
- 生命周期：`pending → running → partial → done | timeout | failed`。
- timeout：3-20 分钟，默认 8；不新建独立 janitor，复用单 serialized reaper；
  recovery 扫描未终止 request。
- aggregate：一条 system message，`extra.multiMention` 带 request/status/callbackTo/
  targets/responses；不新建 child。
- status read 由 W7a/CLI 暴露；不新增第五个 model-facing tool。

## DP-C 调查结论

**决定：A（2026-11-12）**。`TurnExecution` 单 canonical；`invocation_attempts` 只保留
`delivery_state`（`queued/starting/appended/handled/failed/interrupted/canceled`）。

> 完整目标设计见 `0016-turn-terminal-and-settlement-design.md`。

- Clowder 的 `QueueTargetAttempt` 在 `packages/shared/src/types/queue-receipt.ts:250-287`：
  `queued|starting|appended|failed|interrupted|cancelled|handled`，retry append 新行。
- child 终态只在 `TurnExecutionRecord.status`；parent `InvocationRecord` 只有
  `executionStartedAt` attempt receipt，没有第二套 child state。
- codeteam `invocation_attempts.state` 复制了 TurnExecution 五态；这是双终态根因。
- 建议：attempt state 收敛为投递状态；child 终态由 TurnExecution 独占；
  `turnExecutionId` 仍是 child 链接。

## DP-D 调查结论

**决定：A（2026-11-12）**。删除 `settleAgentTurn`，拆回 T1/T2/T3/T4 四层 owner。

> 完整目标设计（四层 owner、事务边界、错误/取消/恢复）见
> `0016-turn-terminal-and-settlement-design.md`。

| 阶段 | Clowder owner | 证据 |
|---|---|---|
| child terminal | `invoke-single-cat.ts` finally | `invoke-single-cat.ts:6397` |
| auth projection | `CallbackAuthTurnExecutionLifecycle` | `CallbackAuthTurnExecutionLifecycle.ts:66-83` |
| response R + draft | `route-serial` / `route-parallel` | `route-serial.ts:3488+`、`route-parallel.ts:2015+` |
| parent + queue + recovery | `QueueProcessor` | `QueueProcessor.ts:2865`、`:2669`、`:2717` |

codeteam `settleAgentTurn` 把四层合并成一个 god-service，导致与
route/invokeSingleAgent 重叠。建议拆回四层 owner；`settleResponseFromDraft` 只做
recovery/response_pending 第二段。

回推范围：`a654788e5`/`09bdb678d` 的 `runAgentTurn` ownership 表和步骤 8–12
（`runAgentTurn + routeAgents` 拆分保留）；`0010 §3.5/§3.6`、`0005` 对应段、
plan P0-1。不是整条 operator routing 设计回退。

## 已决与下一步

- DP-C=A、DP-D=A 已于 2026-11-12 拍板；`0010` §3.5/§3.6/§3.9/§4.3.1/§5.2.1/§9、
  `0005`、plan 0020 P0-1、`0015`、`0016` 已同步。
- R2 按 T1/T2/T3/T4 四层 owner 实现；生产代码不得引入 `settleAgentTurn`。

[宪宪/deepseek-flash🐾]
