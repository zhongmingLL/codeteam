---
feature_ids: [codeteam/F008]
title: "F008: W5a A2A 投递与球权内核"
status: done
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash)]
created: 2026-10-28
updated: 2026-10-28
---

# F008: W5a A2A 投递与球权内核

> W5 的契约与总验收以
> [`docs/plans/0004-w5-w8-scale-product.md`](../plans/0004-w5-w8-scale-product.md)
> §W5 为单一真相源；W5a 实施拆分、投影契约与 AC 映射见
> [`docs/plans/0010-w5a-a2a-dispatch-custody.md`](../plans/0010-w5a-a2a-dispatch-custody.md)。

## Why

W1 已有 `queue_entries` / `messages` / `runs` / `handoffs` / `custody_events` /
`waits` store；W4 已有 SOP/gate 接线。但还没有一条可执行的 A2A 投递链：
operator/agent 来源如何进入唯一队列、多 recipient 如何并行、response bubble
如何一条收口、责任转移如何只走 typed tool、wait 如何 fail closed。W5a 先冻结
这些契约，并给 W5b RPC worker runtime / W5c 运营调度提供前置。

## What

- Queue Entry ↔ Run ↔ response bubble 的 dispatch adapter；one terminal、
  event-driven drain、guide/interrupt/cancel/stop。
- `a2a_send` / `handoff_create` / `handoff_*` typed tool handler surface；
  principal 绑定、target 校验、`control_ref` 回填、可见 `→ @target`、
  `missing_a2a_tool_call` 一次性观测。
- Ball custody replay projection；blocked 的 `completes` /
  `bounces_back_to_owner` 两态。
- typed wait contract：timer/event/managed_command + `wait_source_ref` +
  `expected_signal` + SLA + owner fence；缺证据 fail closed。
- queue `withdrawn` 的 additive migration 与 cancel queued 语义。

## Acceptance

以 `0004` §W5 的 W5a 适用项为准；逐条映射见 `0010`。本文件只记录
slice-specific 证据。W5b/W5c 项不在本 feature 冒充完成。

## 当前进展

- 2026-10-28：W5a kickoff；`0010` 与 F008 建立。
- 2026-10-28：migration 011 + dispatch queue adapter + A2A tool handlers +
  custody projection + wait contract 实现；定向测试 27/27。
- 包内全量 291 passed / 1 skipped，根级 `tsc` 与 `build:offline` 通过；
  命令与边界见 `docs/reports/2026-10-28-w5a-a2a-dispatch-custody.md`。
- 2026-10-28：PR #50 合入 `codeteam-work`（merge `d9d3d966`，reviewed
  HEAD `4892da95e`）；两路 review、CI 4/4、墨墨独立 vision guard 全部通过。

## Close record（2026-10-28）

- **Merge**：PR #50 squash merged at `d9d3d96639db57579bcd712a8fdec8d1839b2722`；
  reviewed HEAD `4892da95edad883619a314fc243298fc414f84db`，base `aa0840f8c`。
- **Review**：烁烁 A2A/session/custody approve（`0001793189310255-003631-e357e81d`）；
  砚砚 code/security approve（`0001793189468719-003634-eedc426d`）。P1 跨 task
  custody 劫持与 P2 poison/多 target 回归均在最终 HEAD 闭合。
- **Vision guard**：墨墨（非作者非 reviewer）approve
  （`0001793189549681-003638-325cfe68`），确认交付为真实实现、AC 无 overclaim、
  residual ledger 足够支撑 W5b/W5c。
- **Post-merge acceptance**：`codeteam-work` @ `d9d3d966` 复跑 daemon
  35 files passed + 1 skipped，291 tests passed + 1 skipped；CI 4/4 green。
- **Boundary**：W5b/W5c 仍未实现；fake executor / transport-neutral tool surface
  是已声明边界。source thread 可在本契约冻结后提议 W5b/W5c。


## Out of scope

- RPC worker harness、worker registry、sticky/re-attach/liveness（W5b）。
- task readiness/DAG、预算、worktree pool、F139、daemon lifecycle、
  deployment wait、PR tracking/managed-work（W5c）。
- 真实 pi kernel executor；W5a 用 injectable `AgentExecutor` fake 验证投影。
- HTTP/MCP transport（W7a）；W5a 只交付 in-process tool handler surface。
