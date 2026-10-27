---
feature_ids: [codeteam/F004a]
related_features: [codeteam/F004]
title: "F004a: W1 identity / thread / chat / queue store"
status: done
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash)]
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
- [x] 非作者 review（砚砚 approve @ `d4c00f04`）与 merge（PR #22，`7d7f2b0c`）。

## Out of scope

- run cutover / run terminal（F004c）。
- backlog dispatch 单事务（F004b）。
- Console 页面与交互（W7）。

## Evidence

- `npm --prefix packages/codeteam-daemon test`：3 个测试文件、40/40 通过。
- `npx tsc --noEmit -p tsconfig.json`：通过。
- `npx biome check --write packages/codeteam-daemon/src/control ...`：clean。
- PR #22：https://github.com/zhongmingLL/codeteam/pull/22（review `d4c00f04`，merge `7d7f2b0c`）。

## Risk

数据/契约面。additive migration 004 只新增唯一索引，不改已有列；无生产数据迁移。
queue source 唯一性在数据库层保证，store 的确定性 id + by-source 回退保证幂等。

## Post-merge review follow-ups (2026-10-28)

- **P3-1 并发 admit UX**：同一 source 不同 id 的并发 admit，输家拿 typed
  conflict 而不是胜者条目。顺序幂等已成立，并发 fail-closed 可接受；若
  operator/Cli 需要无感重试，再在调用层重读 by-source。
- **P3-2 threads CAS 版本 token**：threads 用 `updated_at` 做 CAS；同毫秒双写
  理论上可穿过。queue 已用 `revision = revision + 1`，建议在 F004e hardening
  或 W7 前给 threads 加单调 revision。
- **P3-3 CHECK 错误翻译**：`mapStoreError` 目前把 CHECK 一律译成
  `invalid_input`；状态机类 CHECK 可在 F004c/d 细化成 `conflict` /
  `invalid_state`。不影响当前正确性。

[宪宪/deepseek-flash🐾]
