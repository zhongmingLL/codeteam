---
feature_ids: [codeteam/F004b]
related_features: [codeteam/F004]
title: "F004b: W1 work / SOP / managed-work / artifacts / inbox"
status: done
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash)]
created: 2026-10-28
updated: 2026-10-28
---

# F004b: W1 work / SOP / managed-work / artifacts / inbox

> F004 umbrella 的交付切片。F004 是单一 AC/契约源；本文件只加 slice-specific
> AC，不复制 W1 Acceptance。项目作用域 ID 为 `codeteam/F004b`。

## Why

F004a 已让 identity/thread/chat/queue 可写。F004b 补齐代码交付的 work 面：
backlog 状态机、SOP 告示牌与 first-persist admission、artifact 证据账本、
typed inbox，以及把“approved backlog → thread + kickoff + queue”做成一个
SQLite 事务。没有这一层，W4 CLI 和 W5 dispatch 只能各自拼写状态机。

## What

- `BacklogStore`：create/list、suggest/decide、operator direct approve、
  dispatch state、done/override done、operator-only tags、feature anchor lock；
  状态变更写 `audit`。
- `WorkflowSopStore`：`workflow_sops` first insert 与 `work_admissions` /
  `work_attempts` 同事务；version CAS；W1 `checks` 只允许 `attested|unknown`；
  `completion` 要求 backlog done；SOP 存在时 anchor tag 必须保留。
- `WorkAdmissionStore`：deterministic work identity、attempt 读取、sticky
  executor bind；同一 attempt 绑定同一 profile 幂等，不同 profile conflict。
- `ControlStore.dispatchBacklog`：approved backlog 的 thread、kickoff message、
  queue entry、backlog dispatched 更新、audit 在同一事务；`dispatchAttemptId`
  幂等，replay targets 必须一致。
- `ArtifactStore`：content-addressed（sha256）、临时文件 + fsync + rename、
  文件 0600、`provenance.sourceMessageId` 必填；重复 id fail closed。
- `InboxStore`：`steer | followUp | humanGuidance` typed items，pending →
  consumed/expired。
- `AuditStore`：append-only 读写；subject 投影。

## Acceptance

- [x] backlog 状态机：open→suggested→approved→dispatched→done；operator
  direct open→approved；override done 必须带 reason；同 cat 重复 suggest
  幂等、换 cat conflict。
- [x] tags 仅 operator 可改；SOP 存在时 `feature:<id>` anchor 不能移除。
- [x] SOP first insert + admission/attempt 同事务；既有 SOP 不 retro-admit；
  更新必须带 expectedVersion；W1 写 `verified` fail closed。
- [x] SOP `completion` 只接受 done backlog；resume capsule 必须有
  currentFocus。
- [x] attempt bind sticky；同 profile 幂等、不同 profile conflict。
- [x] backlog dispatch 单事务；thread phase 与 backlog dispatched phase 一致；
  kickoff message kind=`backlog_kickoff`；queue source=`backlog_dispatch`；
  replay 同 attemptId 返回原资源，不同 attemptId conflict。
- [x] artifact 内容 hash、文件 0600、fsync+rename、provenance 来源；
  artifact kind 含 `log`。
- [x] inbox pending→consumed/expired；重复 consume fail closed。
- [x] `npm --prefix packages/codeteam-daemon test`、根级 `tsc --noEmit`、
  Biome 通过。
- [x] 非作者 review（砚砚 approve @ `9235cbb8`）与 merge（PR #23，`889628c7`）。

## Out of scope

- `run_managed_work_bindings` / `task_managed_work_bindings`（F004c：runs/tasks
  store 落地后绑定）。
- backlog lease acquire/heartbeat/reclaim（W5；W1 只保留列，dogfood 单写者
  `lease=null`）。
- feature tag 多匹配 422 解析（F004e；W4 CLI 前）。
- Console UI（W7）。

## Evidence

- `npm --prefix packages/codeteam-daemon test`：4 个测试文件、50/50 通过。
- `npx tsc --noEmit -p tsconfig.json`：通过。
- `npx biome check --write packages/codeteam-daemon/src/control ...`：clean。
- PR #23：https://github.com/zhongmingLL/codeteam/pull/23（review `9235cbb8`，merge `889628c7`）。

## Risk

数据/契约面。dispatch 事务确保 backlog/thread/message/queue/audit 原子；
artifact 文件先落盘再写 metadata，metadata 失败可能留下 hash-addressed
orphan 文件（可复用，不损坏账本）。无生产数据迁移。

## Post-merge review follow-ups (2026-10-28)

- **Artifact GC sweep**：content-addressed orphan 文件可接受；后续 hardening
  加一个目录对账 DB 的 sweep（删除无 metadata 引用的 hash 文件），不在写入
  路径做“败者删除”，避免并发竞态。
- backlog/SOP 状态迁移合法性仍在 store 层；与 schema/F004a review 同口径
  non-blocking，随状态机 slice 继续收敛。

[宪宪/deepseek-flash🐾]
