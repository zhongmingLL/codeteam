---
title: "P0 cell 复用决策卡索引"
doc_kind: index
status: approved
created: 2026-10-24
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
---

# P0 cell 复用决策卡索引

> 上游：`REUSE-MATRIX.md`、`ownership-cell-reuse.tsv`、`reuse-inventory.tsv`、`../plans/0006-clowder-reuse-plan.md`。
> 本目录覆盖 Batch 1 的 10 个 P0 cell + 1 个跨 cell 的 `sop-bulletin` P0 slice；每张卡是 operator 签字用的决策包，不是代码移植实现。
> 下一层架构梳理入口：`../architecture/0004-reuse-architecture-review-plan.md`（Wave A 10 项 + Wave B 11 项；Wave B 已有 4 项提前 approved，余 7 项待 W4 dogfood；统一模板、批次依赖）。
> A1-1 已 approved：`../architecture/reuse-review/identity-session.md`（2026-10-24，D2=A）。
> A1-2 已签：`../architecture/reuse-review/callback-auth.md`（Round 1 `9bf54439-c11a-4f6e-84f9-f6cbd759d640`；Round 2 `86d36c0c-0dd9-4a68-8cb7-3f133137580c`；operator 2026-10-25）。
> A1-3 已签：`../architecture/reuse-review/dispatch.md`（`aa667fe9-56ce-422c-bc8f-3fc881a614d4`；operator 2026-10-25）。
> A1-4 已签：`../architecture/reuse-review/runtime-deployment.md`（`457b0226-a235-4226-b4b4-279204545bf0`；operator 2026-10-25）。
> A2-1 已签：`../architecture/reuse-review/sop-bulletin.md`（`c934705b-ad43-449c-87e0-963cef37b64b`；三猫无 P1，P2/P3 已回写；0001 §12.2/§7.3 已同步；operator 2026-10-25）。
> A2-2 已签：`../architecture/reuse-review/managed-work.md`（`a02b5016-5cb6-463c-9cb3-485eb9ec1379`；P1 retry DP-A2-2-1=A sticky retry；operator 2026-10-25）。
> A2-3 已签：`../architecture/reuse-review/approval-index.md`（`c7e62ae7-2b1f-47cb-b6e7-8ad3c6427d48`；P1-1/P2/P3 已回写；operator 2026-10-25）。

## 分档口径（2026-10-24 operator）

- **P0**：SOP 相关 + 核心基础设施，且阻塞 W0–W4 代码 agent 首个闭环。本目录 10 张 cell 卡 + 1 张 `sop-bulletin` slice。
- **P1-active**：与 code agent 相关，但不是 W0–W4 首个闭环的阻塞项；后续会接入。
- **P1-defer**：与 code agent 相关或可服务代码 agent，但当前不复用；保留 revisit trigger。
- **Drop**：与 code agent 无关；不进入路线图。

| # | Cell | decision | priority | W | 卡片 | operator |
|---|---|---|---|---|---|---|
| 1 | `dispatch` | R0 | P0 | W1/W5 | [`dispatch.md`](dispatch.md) | [x] 已签 |
| 2 | `ball-custody` | R1 | P0 | W1/W5 | [`ball-custody.md`](ball-custody.md) | [x] 已签 |
| 3 | `bubble-pipeline` | R1 | P0 | W1/W7 | [`bubble-pipeline.md`](bubble-pipeline.md) | [x] 已签 |
| 4 | `identity-session` | R0/R1 | P0 | W0/W1/W7 | [`identity-session.md`](identity-session.md) | [x] 已签 |
| 5 | `approval-index` | R0/R1 | P0 | W4/W7 | [`approval-index.md`](approval-index.md) | [x] 已签 |
| 6 | `harness-eval` | R1 | P0 | W3/W6 | [`harness-eval.md`](harness-eval.md) | [x] 已签 |
| 7 | `callback-auth` | R1 | P0 | W2 | [`callback-auth.md`](callback-auth.md) | [x] 已签 |
| 8 | `managed-work` | R1 | P0 | W1/W5 | [`managed-work.md`](managed-work.md) | [x] 已签 |
| 9 | `plugin` | R1 | P0 | W0/W4 | [`plugin.md`](plugin.md) | [x] 已签 |
| 10 | `runtime-deployment` | R1 | P0 | W0/W5 | [`runtime-deployment.md`](runtime-deployment.md) | [x] 已签 |
| 11 | `sop-bulletin`（P0 slice） | R0 | P0 | W1/W4 | [`sop-bulletin.md`](sop-bulletin.md) | [x] 已签 |

## 三猫 review 结论（2026-10-24）

- **烁烁**：P0 10 可签；dispatch 的 `queue_entries` 同步、ball-custody complete 三段式、callback-auth SQLite 适配、bubble P0 范围已修。transport / signal-intake / local-host-recovery 建议 Drop；补审 `sop-bulletin` accept。
- **砚砚**：P0 10 可签；plugin scope 收窄、managed-work attempt 绑定、mcp/human hook、portable-governance W 列已修。首轮主张 transport / action-plane / signal-intake 留 P1-defer；补审对三项 Drop 全部 accept，`action-plane` 保留 P1-defer；`sop-bulletin` accept。
- **墨墨**：P0 10 方向对，但缺 SOP 契约本体；已补 `sop-bulletin` slice。identity-session / harness-eval carve-out、四表归一、local-host-recovery / transport / signal-intake 移 Drop 已处理。
- **`sop-bulletin` 补审**：烁烁 accept（P2-1 open 枚举 + P3 字段/authz 已修）；砚砚 accept（P2-1 backlog 权限域、P2-2 checks.verified 写边界、P3 dogfood 捷径已修）。
- **签字**：2026-10-24 operator 已签 11 张卡（10 cells + `sop-bulletin` slice）。

## 签字规则

- 每张卡先由三猫分面 review：烁烁负责 code/status/current truth 与 W0/W5；砚砚负责安全/治理/W2/W3；墨墨负责 operator UX/W4/W7 与文档一致性。
- operator 逐卡签字；签字后才把该 cell/slice 的 `decision` 从 draft 转成已拍板。
- 任何 cell 的 decision 变化，必须同时回写 `ownership-cell-reuse.tsv`、`REUSE-MATRIX.md` 和对应 W 计划。
- `current_truth` 以 ADR / 代码 / 当前 owner 为准；feature 文档只作历史证据。

[宪宪/deepseek-flash🐾]
