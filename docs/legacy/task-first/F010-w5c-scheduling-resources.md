---
feature_ids: [codeteam/F010]
title: "F010: W5c 运营调度与资源"
status: done
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
created: 2026-10-28
updated: 2026-10-28
---

# F010: W5c 运营调度与资源

> W5 契约与总验收以
> [`docs/plans/0004-w5-w8-scale-product.md`](../plans/0004-w5-w8-scale-product.md)
> §W5 为单一真相源；W5c 拆分、冻结接口与 AC 映射见
> [`docs/plans/0012-w5c-scheduling-resources.md`](../plans/0012-w5c-scheduling-resources.md)。

## Why

W5a 已冻结唯一 Queue Entry 与 A2A 投递内核，但“哪条 task 可以先开始”仍
没有答案：依赖、预算、worktree 容量和 worker capacity 都没有在入队前被
检查；预算表只有 create/read，没有真实扣减与 pause；proactive schedule 也
没有 TaskSpec→Queue Entry 的 adapter。W5c 补齐这层运营调度，并消费 W5b
未来的 worker capacity 投影。

## What

- task readiness/admission：priority + dependency DAG + budget + capacity；
  只决定入队/claim，不新建队列。
- budget/quota enforcement：run usage 幂等扣减、越限 pause、operator 可见
  approval；不静默继续。
- worktree pool、lease/TTL、disk quota、artifact GC（保留边界明确）。
- F139 `TaskSpec_P1` + RunLedger → Queue Entry；无第二 cron/drain。
- W5d 另轮：daemon lifecycle、deployment wait、managed-work/PR binding、
  sticky retry。本 feature 不冒充完成。

## Acceptance

以 `0012` §5 的 W5c core 行为准；DAG、预算 pause、F139→Queue Entry、
worktree pool/GC、capacity 投影消费五项必须有测试与真实命令证据。daemon
lifecycle、deployment wait、managed-work 不在本 slice 勾选。

## 当前进展

- 2026-10-28：W5c kickoff；`0012` 与 F010 建立；W5c/W5d 拆分记录。
- 2026-10-28：W5b（F009/PR #53）合入后，本 slice rebase 到 `0827773aa`，
  重编号为 F010/0012/migration 013；capacity 直接消费 W5b
  `WorkerStore.listSnapshots()`。
- 2026-10-28：W5c core 实现完成，进入 review。migration 013 + readiness/
  DAG + budget charge/pause + worktree pool/GC + F139 adapter + CLI 已落。
- 证据：`build:offline` exit 0；daemon 包 47 files passed + 2 skipped，
  349 tests passed + 2 skipped；`tsc` 与 `biome` 通过。命令与边界见
  `docs/reports/2026-10-28-w5c-scheduling-resources.md`。
- residual 关闭：W5a ledger 的 `a2aDepth` 无软上限已由
  `CODETEAM_A2A_MAX_DEPTH=32` 关闭。
- 明确未做：W5d 的 daemon lifecycle、deployment wait、managed-work/PR
  binding/sticky retry；见 F011。

## Close record（2026-10-28）

- PR #52 squash merged at `959ef7e760ee5227e0d125b2235bf75e36395d91`；
  reviewed HEAD `15b7009c3c59594f13987e40ab0f9855d4056688`；base
  `0827773aa`。
- 砚砚 code/security approved（msg `0001793199344123-003737-a8c073df`）；
  墨墨 SOP/process/Product approved（msg `0001793199744633-003740-f7c64992`）。
- CI 4/4；post-merge daemon acceptance 47 files passed + 2 skipped，
  349 tests passed + 2 skipped。
- W5d（daemon lifecycle/deployment wait/managed work）仍为 F011 / planned，
  本 feature 不包含。

## Out of scope

- daemon StopOperationRecord/授权/复验、deployment wait 消费（W5d）。
- `task_managed_work_bindings`/PR lifecycle/TaskOutcome/sticky retry（W5d）。
- worker registry/liveness/heartbeat/sticky/re-attach（W5b）。
- HTTP/MCP/Console（W7）、GitHub adapter（W8）。

