---
feature_ids: [codeteam/F004]
title: "F004: W1 控制面 umbrella（schema foundation + delivery slices）"
status: in-progress
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash)]
created: 2026-10-28
updated: 2026-10-28
---

# F004: W1 控制面 umbrella（schema foundation + delivery slices）

> 项目作用域 ID 是 `codeteam/F004`。Clowder 的 task / Mission Hub Feature ID
> 只接受 `F\d+`，因此任务标题承载作用域，`relatedFeatureId` 不写裸 `F004`，
> 避免撞 Clowder 全局 feat index。工作项见当前 thread 的
> `codeteam/F004 — W1 控制面数据模型`。

## Why

W0a 已由 F002 关闭，W0c daemon 已由 F003 交付；W1 是把当前
`task/run/handoff` 扩成完整控制面的地基，也是 Console M0 的真实 thread
数据源。W1 的**入场门禁**是 `architecture/0001 §4.4.2` 的字段继承矩阵：
矩阵未完成、五处关键差异未钉死之前，不开始建表。

## 用户可见结果

- 空库可以从零建全控制面 schema；旧库可以 additive migration，且不丢
  task / run / handoff。
- thread / timeline / diff / review 的只读查询有 store 级测试，字段足够
  渲染 Console M0；实际页面验收留在 W7。
- 不存在第二套 queue / custody / message / SOP / approval；clowder 执行
  原语仍是唯一真相。

## W1 交付切片

F004 是单一契约/AC 源；以下 slice 只加自己的验收，不复制 W1 Acceptance。
slice 使用项目作用域 ID `codeteam/F004a`…，避免裸 F005+ 撞 Clowder 全局
feat index。

| Slice | 范围 | 状态 |
|---|---|---|
| F004 | 契约 + schema foundation（migrations / runner / schema tests） | merged（PR #21，`fa995e8d`） |
| [F004a](F004a-identity-thread-chat-queue.md) | roles / profiles / sessions / threads / messages / queue_entries store | merged（PR #22，`7d7f2b0c`） |
| [F004b](F004b-work-sop-artifacts.md) | backlog / workflow_sops / work admissions/attempts / artifacts / inbox / dispatch | merged（PR #23，`889628c7`） |
| [F004c](F004c-runs-stages-credentials.md) | tasks / stages / runs / run_events / invocation_credentials / managed-work bindings / queue cutover | merged（PR #24，`4c4ca4f7`） |
| [F004d](F004d-custody-approval-review.md) | custody/waits + approvals/reviews/merges/budgets/evals/forge/audit | merged（PR #25，`304f7504`） |
| [F004e](F004e-recovery-read-models.md) | startup recovery + migration matrix + Console M0 read models | in progress |

## 验收标准

以 [`docs/plans/0002-w0-w2-foundation.md`](../plans/0002-w0-w2-foundation.md)
W1 Acceptance 为单一清单，本文件不复制第二套。W1 入场门禁单独列为：

- [x] `architecture/0001 §4.4.2` 字段继承矩阵完成：每个 codeteam 字段标
  `reused` 或 `code-delivery-specific`，并写源、差异、理由。
- [x] 五处关键差异已钉死：TaskStatus、Task.ownerCatId、Run vs
  ActiveRun、Handoff vs action lease/custody、Artifact vs ThreadArtifactDTO。
- [x] 明确列出不继承的 clowder 字段/能力与 revisit trigger。
- [x] 矩阵经非作者 review；未过 review 不建表。烁烁 approve @ `e2f98cb`，
  P2/P3 已折；PR #20 已合入 `codeteam-work`（`3d15a3f57`）。

## Scope

**In**

- F004：字段继承矩阵、SQLite schema + additive migration、migration runner、
  schema 约束测试。
- F004a–d：按域拆分的 repository/store、CAS 状态更新与契约测试。
- F004e：startup recovery、迁移矩阵测试、Console M0 只读查询。

**Out**

- W2 权限、身份、沙箱实现。
- W5 多 task scheduler / RPC / worker pool。
- W7 Console 页面与交互验收。

## 当前进展

- 2026-10-28：矩阵 PR #20 合入（`3d15a3f57`）；schema foundation PR #21
  经砚砚 review 后合入（`fa995e8d`），3 个 forward-only migration、34 张
  控制面表 + `schema_migrations`；WAL、foreign keys、5000ms busy timeout、
  append-only trigger 与关键 partial unique index 已落。
- 2026-10-28：F004a 经砚砚 approve 后合入（PR #22，`7d7f2b0c`）；migration
  004 + identity/thread/chat/queue stores 40/40。
- 2026-10-28：F004b 经砚砚 approve 后合入（PR #23，`889628c7`）；backlog /
  SOP / dispatch / artifacts / inbox / audit 50/50。
- 2026-10-28：F004c 经砚砚 approve 后合入（PR #24，`4c4ca4f7`）；tasks /
  stages / runs / run_events / thread_events / credentials / bindings /
  multi-target cutover 60/60；migration 005 已落。
- 2026-10-28：F004d 经砚砚 approve 后合入（PR #25，`304f7504`）；handoff /
  custody、waits、approval、review/finding/verification、merge、
  budget/eval/forge delivery stores 66/66；F004c token-hash P3 已收口。
- 2026-10-28：F004e 进行中。startup recovery 扫掠器（interrupted run /
  stale claim / expired handoff / loop guard / dirty-bit）、迁移矩阵测试、
  Console M0 只读 read models 已实现；包内 82/82。

## Evidence

- 矩阵 review：烁烁 approve @ `e2f98cb`；P2/P3 处置见 PR #20。
- Schema review：砚砚 approve @ `cff2a06d`（29/29 独立复跑）；PR #21 合入
  `fa995e8d`。
- F004a review：砚砚 approve @ `d4c00f04`（40/40 独立复跑）；PR #22 合入
  `7d7f2b0c`。
- F004b review：砚砚 approve @ `9235cbb8`（50/50 独立复跑）；PR #23 合入
  `889628c7`。
- F004c review：砚砚 approve @ `72182f07`（60/60 独立复跑）；PR #24 合入
  `4c4ca4f7`。
- F004d review：砚砚 approve @ `80a6faf4`（66/66 独立复跑）；PR #25 合入
  `304f7504`。
- `npm --prefix packages/codeteam-daemon test`：9 个测试文件、82/82 通过；
  覆盖 schema 迁移/约束 + identity/thread/chat/queue + work/SOP/artifact/
  inbox + task/stage/run/event/credential/cutover + governance stores +
  recovery + 迁移矩阵 + read models。
- W1 尚未 close：F004e 待 review/merge；W1 Acceptance 逐条证据在 close 时
  统一回填。

[宪宪/deepseek-flash🐾]
