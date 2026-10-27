---
feature_ids: [codeteam/F004a]
related_features: [codeteam/F004]
title: "F004a: W1 identity / thread / chat / queue store"
status: in-progress
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: []
created: 2026-10-28
updated: 2026-10-28
---

# F004a: W1 identity / thread / chat / queue store

> F004 umbrella 的交付切片。F004 是单一 AC/契约源；本文件只加 slice-specific
> AC，不复制 W1 Acceptance。项目作用域 ID 为 `codeteam/F004a`。

## Why

W1 schema foundation 已合入。下一步必须让控制面真正可写：身份注册、thread/chat
持久化、queue 单账本。没有这些 store，W7 chat/Console 和 W5 dispatch 只能各自
造第二套写入路径。

## What

- `RoleStore` / `AgentProfileStore` / `AgentSessionStore`：动态 role registry、
  多 profile、session seal；`catHandoffNote` 独立落列。
- `ThreadStore` / `MessageStore` / `QueueStore`：thread 状态与 backlog 链接、
  thread-scoped message seq、reply/control/dispatch refs、单 pending-wake 队列。
- `ControlStore` facade + `ControlTransaction`：嵌套事务 join、失败回滚。
- additive migration 004：`queue_entries(source_id)` 唯一，保证一 source 一 entry。

## Acceptance

- [x] 内置 architect/coder/reviewer/verifier + seed eval/compress roles；自定义
  role 可创建；未知/禁用 role fail closed。
- [x] 同一 role 可注册多个 profile；`clowder_cat_id` 仅 provenance、可重复；
  eval/compress profile 的 provider/model 由配置提供，不硬编码模型。
- [x] `AgentSession.profile_id` 与 `role` 分离；seal 保留 `catHandoffNote`，
  不并进 `continuityCapsule`；已 sealed 再 seal fail closed。
- [x] thread create/list/status CAS/backlog link；phase 与 backlog link 同列写入。
- [x] message 在 `BEGIN IMMEDIATE` 内分配 thread-scoped `seq`；reply 不跨
  thread；approval rich block 拒绝；`control_ref` 仅 store 方法可写；
  dispatch refs append 事务化。
- [x] queue 一 source 一 entry（DB unique）、多 target 单行；claim/release/
  complete；claim conflict；urgent 优先。
- [x] `npm --prefix packages/codeteam-daemon test`、根级 `tsc --noEmit`、Biome
  通过。
- [ ] 非作者 review（砚砚）与 merge。

## Out of scope

- run cutover / run terminal（F004c）。
- backlog dispatch 单事务（F004b）。
- Console 页面与交互（W7）。

## Evidence

- `npm --prefix packages/codeteam-daemon test`：3 个测试文件、40/40 通过。
- `npx tsc --noEmit -p tsconfig.json`：通过。
- `npx biome check --write packages/codeteam-daemon/src/control ...`：clean。
- PR：由当前 thread 路由与 PR 记录。

## Risk

数据/契约面。additive migration 004 只新增唯一索引，不改已有列；无生产数据迁移。
queue source 唯一性在数据库层保证，store 的确定性 id + by-source 回退保证幂等。

[宪宪/deepseek-flash🐾]
