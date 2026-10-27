---
feature_ids: [codeteam/F004c]
related_features: [codeteam/F004]
title: "F004c: W1 tasks / stages / runs / credentials / cutover"
status: in-progress
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: []
created: 2026-10-28
updated: 2026-10-28
---

# F004c: W1 tasks / stages / runs / credentials / cutover

> F004 umbrella 的交付切片。F004 是单一 AC/契约源；本文件只加 slice-specific
> AC，不复制 W1 Acceptance。项目作用域 ID 为 `codeteam/F004c`。

## Why

F004a 让 thread/chat/queue 可写，F004b 让 work/SOP/dispatch 可写。F004c 补齐
执行面：task/stage 快照、run 生命周期与事件、per-run callback credential、
run/task managed-work bindings，以及把 queue target 切成 run 的原子 cutover。
没有这一层，W5 scheduler 只能自己拼 run/queue/credential 事务。

## What

- `TaskStore`：work/pr_tracking/issue_tracking、work 必绑 backlog、tracking
  subjectKey、status CAS、cancel/abandon disposition。
- `StageStore`：run lane 纯快照（active → passed），不做 gate 控制器。
- `RunStore`：run create/terminal、one running per source×recipient、one
  response per message、`run_events` seq。
- `ThreadEventStore`：thread 级 `backlog_item_dispatched` /
  `backlog_item_done` / `workflow_sop_updated` 事件。
- `InvocationCredentialStore`：per-run hash+salt、active/terminal、disposition、
  tool policy、run/task/session/profile/thread 坐标；不返回 token 明文。
- `WorkAdmissionStore.bindRun` / `bindTask`：coder run ↔ work/backlog
  bind-once；pr_tracking task binding；重复同 binding 幂等，不同 binding conflict。
- `QueueStore.cutoverTarget` + `ControlStore.cutoverQueueEntry`：多 target queue
  一次只消费一个 target，原子写 response message + run + first run_event +
  source dispatchRef + queue target 移除；空 targets 删除 queue 行，run 的
  `queue_entry_id` 置空。
- migration 005：`runs.queue_entry_id` 可空 + `ON DELETE SET NULL`；migration
  runner 支持安全的 FK-off 重建 + `foreign_key_check`。

## Acceptance

- [x] work task 缺 backlog fail closed；tracking task 缺 subjectKey fail
  closed；task status CAS / disposition 有 typed conflict。
- [x] stage create/pass/list；passed 不重复终结。
- [x] run create 校验 task/session/profile/role 一致；one running per
  source×recipient；one response per message；terminal 幂等、不同 terminal
  conflict。
- [x] run_events / thread_events 按 parent 分配 seq。
- [x] credential run 唯一；terminalize 幂等、不同 disposition conflict；不暴露
  token material。
- [x] coder run 只能绑 work task 且 task.backlog 必须等于 admission producer；
  pr_tracking task 才能 task binding。
- [x] multi-target cutover 两次 claim 各自生成 run/response/event；第一次
  queue 保留剩余 target，第二次删行并把 run.queue_entry_id 置空。
- [x] cutover 校验失败不写 run/message/dispatchRef/queue 变更；事务回滚。
- [x] coder cutover 自动 bind attempt + run binding；reviewer run 不绑。
- [x] `npm --prefix packages/codeteam-daemon test`、根级 `tsc --noEmit`、
  Biome 通过。
- [ ] 非作者 review（砚砚）与 merge。

## Out of scope

- startup recovery / interrupted run sweep / old-DB backfill（F004e）。
- handoff/waits/approval/review/merge 表与状态机（F004d）。
- Console UI（W7）。

## Evidence

- `npm --prefix packages/codeteam-daemon test`：5 个测试文件、60/60 通过。
- `npx tsc --noEmit -p tsconfig.json`：通过。
- `npx biome check --write packages/codeteam-daemon/src/control ...`：clean。
- PR：当前 thread 路由与 review 记录；合入后回写。

## Risk

数据/契约面。migration 005 是 FK-off 表重建，runner 在提交前做
`PRAGMA foreign_key_check`，失败整迁移回滚；已有 run 的 queue ref 会保留，
queue 行删除时置空。无生产数据迁移。

[宪宪/deepseek-flash🐾]
