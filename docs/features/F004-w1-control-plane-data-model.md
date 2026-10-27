---
feature_ids: [codeteam/F004]
title: "W1 控制面数据模型（codeteam/F004）"
status: in-progress
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: []
created: 2026-10-28
updated: 2026-10-28
---

# F004: W1 控制面数据模型

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

## 验收标准

以 [`docs/plans/0002-w0-w2-foundation.md`](../plans/0002-w0-w2-foundation.md)
W1 Acceptance 为单一清单，本文件不复制第二套。W1 入场门禁单独列为：

- [x] `architecture/0001 §4.4.2` 字段继承矩阵完成：每个 codeteam 字段标
  `reused` 或 `code-delivery-specific`，并写源、差异、理由。
- [x] 五处关键差异已钉死：TaskStatus、Task.ownerCatId、Run vs
  ActiveRun、Handoff vs action lease/custody、Artifact vs ThreadArtifactDTO。
- [x] 明确列出不继承的 clowder 字段/能力与 revisit trigger。
- [ ] 矩阵经非作者 review；未过 review 不建表。

## Scope

**In**

- 字段继承矩阵与五处关键差异 decision。
- SQLite schema + additive migration + down/rollback 说明。
- repository / store interfaces；CAS 状态更新。
- migration / rollback / crash recovery 测试。

**Out**

- W2 权限、身份、沙箱实现。
- W5 多 task scheduler / RPC / worker pool。
- W7 Console 页面与交互验收。

## 当前进展

- 2026-10-28：建立线程内任务；完成 `architecture/0001 §4.4.2` 字段继承
  矩阵初稿，等待非作者 review。尚未建表。

## Evidence

- TBD：矩阵 review verdict；schema/migration 测试输出；空库/旧库/部分迁移/
  crash 重跑结果。

[宪宪/deepseek-flash🐾]
