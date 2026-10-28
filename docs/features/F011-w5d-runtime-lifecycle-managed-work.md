---
feature_ids: [codeteam/F011]
title: "F011: W5d daemon lifecycle / deployment wait / managed work"
status: in_review
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash), 烁烁 (Kimi K3), 墨墨 (Qwen 3.8 Flash)]
created: 2026-10-28
updated: 2026-10-28
---

# F011: W5d daemon lifecycle / deployment wait / managed work

> 本 feature 是 W5c 原范围中 lifecycle/managed-work 的显式 fork。W5c core
> （F010）已完成 readiness/DAG、预算、worktree pool/GC、F139；本 feature
> 未开始，不继承 F010 的完成声明。W5 总契约以
> [`docs/plans/0004-w5-w8-scale-product.md`](../plans/0004-w5-w8-scale-product.md)
> §W5 为准，详细冻结见 `docs/plans/0013-w5d-runtime-lifecycle-managed-work.md`。

## Why

W5c core 已能决定“哪条 task 可以开始”和“资源是否足够”，但 runtime 侧仍有
三块未闭环：

- daemon StopOperationRecord 六态、operator 签名授权、frozen identity/
  executor independence、health 复验、boot history/exit 证据；
- F280 `deployment_wait_json` 的 observation/predicate/queue 投递/start guard；
- `task_managed_work_bindings`、PR lifecycle/TaskOutcome refs、managed-work
  sticky retry。

## What

- 文件型 lifecycle ledger（不进 SQLite）：StopOperationRecord 六态 + failed；
  operator principal/签名；executor 不在目标进程树；health 前后复验。
- 原 Task 的 F280 await：`autoRenew:false`、TTL=0、
  `revision_included`/`new_ready_boot`、bootSequence 基线、单个 recovery
  sweep、start guard、经 `queue_entries` 投递。
- `task_managed_work_bindings` 与 `pr_tracking` task 同事务；same idempotent/
  missing no-op/different 409；FK cascade；merge/revert evidence 按 binding；
  缺失 `managed_unattributed`；TaskOutcome 三分桶 refs。
- managed-work sticky retry：先读 attempt 已绑 profile；已绑只选同 profile；
  未绑正常选择并 bind；不同 profile 消费 target + operator blocker；fallback
  只对非 managed/Phase C。

## Acceptance

待下一轮实施计划冻结。必须逐条映射 `0004` §W5 中 W5c 未勾选的 daemon
lifecycle、deployment wait、PR tracking/managed-work AC；不得用 F010 的
passing tests 冒充。

## 当前进展（2026-10-28）

- W5d-A managed work：`ManagedWorkService` register/attribution/lifecycle
  evidence、preflight sticky retry、DispatchService conflict 消费 +
  operator inbox；merge evidence 已接 `MergeExecutor`。
- W5d-B deployment wait：原 Task JSON、observation/predicate/sweep、
  start guard、queue 投递、CLI register/status/sweep/cancel；无第二等待表。
  operator cancel 提供不可匹配 wait 的退出路径（terminal + audit），
  cancel 后可 `generation+1` 重注册，已投递的 wait 拒绝重注册。
- W5d-C daemon lifecycle：文件型 `StopOperationRecord` 六态、operator
  签名、claim、frozen identity、executor containment、health 复验、
  boot exit evidence；CLI `daemon status` / `daemon stop`（`halt` 是签名
  action，不是子命令）。execute 时从 identity-verified
  pid 重新推导 descendants，避免 signal 已回收/复用的 pid。relaunch 的
  新 daemon 启动仍归 external executor。
- 验证：`build:offline` exit 0；daemon 包 52 files passed + 2 skipped，
  378 tests passed + 2 skipped；`tsc` / `biome` 通过。证据见
  `docs/reports/2026-10-28-w5d-runtime-lifecycle-managed-work.md`。
- 未完成：W7 HTTP/Console、W8 revert connector；relaunch CLI 的 external
  start；W6 episode store。不得用本 slice 的 tests 冒充。

## Merge record / post-merge review（2026-10-28）

- PR #56 squash merged at `168e67dd0`（reviewed HEAD
  `dfb872d9c36c62e476f2e11fcfd3d2f37575e1f1`，base `7adc30ee4`）。
- 砚砚 code/security approved @ `dfb872d9c`（msg
  `0001793202850007-003779`，2×P2 + 3×P3 全闭合）；墨墨
  SOP/process/Product approved @ `dfb872d9c`（msg
  `0001793202985338-003781`，无 P1/P2）。CI 4/4。
- **post-merge review pending**：operator 已把烁烁拉入工作 thread，其
  W5/session-interface lane（lifecycle / boot ledger / observation /
  recovery）正在对已合入代码复核，verdict 未出。此前“routableNotJoined、
  由砚砚合票覆盖”的表述已作废。
- 状态口径：**代码已合入 ≠ W5d 已完成独立复核**。烁烁无 P1/P2 后本
  feature 才转 `done`；若报 P1/P2，保持 `in_review` 并开 follow-up fix
  PR；P3/备忘进 residual。
- **烁烁 verdict（已出）**：1×P2（observation 缺 pid 活性，真实 SIGTERM
  后 state 仍 `ready`，精确 `revision_included` 可在 dead window 误唤醒）
  + 2×备忘（restart↔`WorkerRuntime.recover()` 契约未接线，归 W6；
  descendants SIGTERM 与 recover 语义自洽）。P2 修复走
  `fix/w5d-observation-liveness` follow-up PR；合入后由烁烁按 exact 新
  HEAD 复审增量，通过后本 feature 才转 `done`。

## Residual ledger（W5d）

| ID | 内容 | owner |
|---|---|---|
| W5d-M1 | 外部 executor 重启后必须在 `markReady` 前跑 `WorkerRuntime.recover()`；否则 SIGTERM 遗留的 `running` runs / `attached` sessions 要等 lease 过期才被惰性收拾，而 lifecycle 已显示 `reverified` | W6 接线 checklist |
| W5d-M2 | 未来接线后 `executeStop` 重推导 descendants 会一并 SIGTERM worker 子进程，与 `interrupted/"daemon_restarted"` 语义自洽；这正是 M1 必须成立的原因 | W6，与 M1 同段 |
| W5d-R1 | 精确 `revision_included` 需配合 observation 的 pid 活性 fail-closed | 已修（follow-up PR，待烁烁复审） |
- Post-merge acceptance：`build:offline` 后 daemon 包 52 files passed
  + 2 skipped，378 tests passed + 2 skipped。

## Out of scope

- W5c readiness/DAG/预算/worktree/F139（F010 已完成）。
- W5b worker registry/liveness/sticky/re-attach。
- W7 HTTP/Console、W8 GitHub adapter。

