---
feature_ids: [codeteam/F007]
title: "F007: W4 SOP 复用与点状 Gate"
status: in_review
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
created: 2026-10-28
updated: 2026-10-28
---

# F007: W4 SOP 复用与点状 Gate

> 验收以 [`docs/plans/0003-w3-w4-review-sop.md`](../plans/0003-w3-w4-review-sop.md)
> §W4 为单一真相源；实施拆分与 AC 映射见
> [`docs/plans/0009-w4-sop-gates-implementation.md`](../plans/0009-w4-sop-gates-implementation.md)。

## Why

W1 已有 `backlog_items` / `workflow_sops` / threads / messages / approvals /
merges 的 schema 与 store；W3 已有独立 review/falsifier 证据链。W4 要把这些
底座接成 operator 真正能用的 SOP 与点状 gate：告示牌可读、verified 有证据、
高风险有审批、routine merge 由 gate 后的 merge owner 执行，并且不靠 Web
完成一轮 backlog → thread → approval → merge 的 dogfood。

## What

- codeteam 派生 SOP catalog（7 stage，无 clowder 专属参数）。
- `sop_check_evidence` + gate writer + stale 读投影。
- 点状 gate：worktree / design / review / verify / risk-consistency /
  merge / completion。
- `approval` CLI（request/list/show/approve/reject）+ backlog CLI。
- local `MergeExecutor` + `service:merge-owner` receipt 契约。
- 最小 `thread list/show/post/tail` CLI。
- gate telemetry 派生与剪枝候选。

## Acceptance

以 `0003` §W4 为准；逐条映射见 `0009`。本文件只记录 slice-specific 证据。

## 当前进展

- 2026-10-28：W4 kickoff；实施计划与 F007 建立。
- 2026-10-28：W4a/b/c 实现完成；daemon 203 passed / 1 skipped；
  CLI dogfood 真实跑通 backlog→dispatch→thread→agent cutover 回复→approval→
  merge execute→SOP completion；build/tsc/Biome/静态检查通过。
- 证据报告：`docs/reports/2026-10-28-w4-sop-gates.md`。
- 砚砚 code/security/gate review **Approved** @ `5b3eba634`（7 P3 non-blocking）；
  P3-2/3/4/5/6/7 已修，待同风险面 delta 复审；墨墨（SOP/process/Product）待转。

### Residual ledger（W7a）

| # | 项 | 去向 |
|---|---|---|
| 1 | `SopCheckEvidenceStore.record` 本身不解析 evidenceRef；解析仅在 `SopService` | W7a 暴露 HTTP 前下沉 store 或收窄 store 写入面；W4 生产路径全走 service |

## Out of scope

- W5 QueueProcessor / AgentRouter / 多 task 调度。
- W7a HTTP/Console；W8 GitHub adapter。
- 自动 merge（C 类）与第二套 SOP 状态机。

## Risks

| 风险 | 缓解 |
|---|---|
| SOP 做成控制器 | stage 不做迁移校验；只 completion/verified 有写 gate |
| verified 伪造 | evidence 表 + 写权拆分 + evidence_ref 解析 + 422 |
| merge 绕过 gate | merge execute 先跑 gate；receipt 绑定 gate evidence |
| agent runner 被误认为已接 | D2 边界 + dogfood 报告写清 cutover |

