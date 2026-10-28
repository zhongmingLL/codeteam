---
feature_ids: [codeteam/F011]
title: "F011: W5d daemon lifecycle / deployment wait / managed work"
status: planned
owner: "待排期"
reviewers: [砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
created: 2026-10-28
updated: 2026-10-28
---

# F011: W5d daemon lifecycle / deployment wait / managed work

> 本 feature 是 W5c 原范围中 lifecycle/managed-work 的显式 fork。W5c core
> （F010）已完成 readiness/DAG、预算、worktree pool/GC、F139；本 feature
> 未开始，不继承 F010 的完成声明。W5 总契约以
> [`docs/plans/0004-w5-w8-scale-product.md`](../plans/0004-w5-w8-scale-product.md)
> §W5 为准，详细冻结见 `docs/plans/0012-w5c-scheduling-resources.md` §W5d。

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

## Out of scope

- W5c readiness/DAG/预算/worktree/F139（F010 已完成）。
- W5b worker registry/liveness/sticky/re-attach。
- W7 HTTP/Console、W8 GitHub adapter。

