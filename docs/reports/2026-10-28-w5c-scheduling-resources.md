---
title: "W5c core 运营调度与资源实施报告"
doc_kind: report
status: closed
created: 2026-10-28
updated: 2026-10-28
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
source: "docs/plans/0012-w5c-scheduling-resources.md"
feature: "codeteam/F010"
---

# W5c core 运营调度与资源实施报告

> 本报告只记录 W5c core（readiness/DAG、预算、worktree pool/GC、F139）的
> 实现证据与边界。daemon lifecycle、deployment wait、managed-work/PR
> binding/sticky retry 归 W5d（F011），不在本报告冒充完成。

## 1. 已实现

### 1.1 Migration 013

新增 `budget_charges`、`worktree_leases`、`schedule_specs`、`schedule_runs`。
没有新增第二 queue、第二 run、worker registry、heartbeat 或 lease 表。

### 1.2 Task readiness / admission

- `src/scheduling/dependencies.ts`：`dependencies_json.dependsOn` 的解析、
  缺失/环/未完成检测；`dependencyState` 只读 `backlog_items`，不受 200 行
  list 截断影响。
- `src/control/stores/backlog.ts`：建依赖时拒绝缺失/自引用/重复；
  `setDependencies` 拒绝会成环的更新；CLI `backlog depend`。
- `src/scheduling/readiness.ts`：ready/blocked + typed reasons + order key；
  `p0/p1 → urgent`、`p2/p3 → normal`；依赖、预算、W5b capacity、worktree
  capacity 都是 blocker。
- `ControlStore.dispatchBacklog`：依赖未完成/缺失/环、预算 paused 时拒绝
  创建 Queue Entry；不留下半 dispatch。
- A2A depth residual 闭合：`CODETEAM_A2A_MAX_DEPTH`（默认 32），超过时
  `a2a_depth_exceeded`，不再无限传球。

### 1.3 Budget / quota

- `budget_charges.run_id UNIQUE`：同一 run 重复结算幂等；不同金额重复结算
  返回 conflict。
- `BudgetService.chargeRun` 从 canonical run usage 扣减 tokens/cost/wall
  time；越限创建 `budget_pause` approval（同 task 已有 open 则复用）。
- `DispatchService.settleRun` 在 terminal commit 后扣减；失败写
  `budget_charge_failed` audit，不覆盖已提交 terminal。
- `DispatchService` 在 cutover 前检查 budget paused；paused 时释放 claim、
  记 `dispatch_deferred`、不启动 run。
- `BudgetService.sweep` 可补齐遗漏的 terminal run charge。
- CLI：`budget set/show`；`task create --budget-*`；`task readiness`。

### 1.4 Worktree pool / disk quota / artifact GC

- `worktree_leases`：leased/released/collected；task/run 关联；过期时间。
- `WorktreePoolService`：max leases、可注入 `statfs`、root 内路径校验、
  released/expired-terminal/expired-inactive/orphan GC；默认 dry-run；拒绝
  symlink、root 自身和越界路径。过期但任务非 done 的 lease 在
  `reclaimGraceMs`（默认 48h）后、且该 task 没有 running run 时才回收；
  活跃 run 保护工作目录。
- 边界：W5c 拥有 slot/lease/TTL/GC；真正的 git checkout 仍由 executor
  在 lease path 内创建（W5b）。
- `ArtifactGCService`：v1 只删 `kind='log'` 且 task done 且过期；spec/plan/
  diff/test-report/review/verification/merge-receipt 永不删；artifact root
  内无引用孤儿文件过 TTL 才删；默认 dry-run + audit。

### 1.5 F139 proactive schedule adapter

- `TaskSpec_P1` 落 `schedule_specs`（trigger/admission/run/state/outcome）；
  `schedule_runs` 是 RunLedger，`(spec_id, occurrence_key)` 唯一。
- `tick(now)` 只由单一 daemon 调度心跳/CLI 调用；没有 `setInterval`、没有
  第二 cron/drain。
- trigger 后只写一条 message + 一条 Queue Entry；不直接创建 Run。
- `schedule_runs.status='queued'` 是 occurrence 发生记录，不是执行终态；
  Queue Entry / Run terminal 才是真相，后续消费者不得把 queued 当完成。
- factory 白名单；内置 `task_wake`。paused/任务不 ready/未知 factory 记
  skipped/failed ledger，不静默投递。
- catch-up 有上限；同 occurrence 重放不重复入队。

### 1.6 W5b capacity 接入

冻结 `CapacitySnapshot` / `CapacityProvider`：

- W5b（F009/PR #53）已落地 `WorkerStore.listSnapshots()`；W5c 只读，不写
  registry，不判 liveness。
- snapshot null/stale/无匹配 role → `capacity_unknown` fail closed。
- `WorkerRegistryCapacityProvider` 映射 online/busy/draining/stale/offline；
  registry 空或 lease 过期都 fail closed。只有完全没有 worker registry 时才
  使用显式 `LocalCapacityProvider` 作为本地 fallback（默认 4，env
  `CODETEAM_LOCAL_MAX_CONCURRENT_RUNS`）。

## 2. 命令与结果

工作区：隔离 worktree `/home/ming/agent/codeteam-w5c`，分支
`feat/w5c-scheduling-resources`，base `0827773aa`（W5b 合入后的
`codeteam-work`）。W5b 占用 F009/0011/migration 012，本 slice 使用
F010/0012/migration 013。

| Check | Command | Result |
|---|---|---|
| Install | `NODE_ENV=development npm install --ignore-scripts` | exit 0 |
| Build | `NODE_ENV=development npm run build:offline` | exit 0 |
| Daemon package tests | `NODE_ENV=development npm --prefix packages/codeteam-daemon test` | 47 files passed + 2 skipped；349 tests passed + 2 skipped |
| Typecheck | `node_modules/.bin/tsc --noEmit -p packages/codeteam-daemon/tsconfig.build.json` | exit 0 |
| Format/lint | `node_modules/.bin/biome check packages/codeteam-daemon` | exit 0 |

新增测试文件：

- `control-budget.test.ts`：幂等、三类限额、pause 单开、raise 后恢复、
  sweep、无预算不误判。
- `control-readiness.test.ts`：DAG 顺序、缺失/环、依赖更新成环、p0/p1
  顺序、budget paused、capacity unknown/exhausted/stale、worktree blocker。
- `control-worktree-pool.test.ts`：lease 上限、磁盘低/不可读、dry-run/real
  GC、orphan TTL、越界拒绝。
- `control-artifact-gc.test.ts`：log 保留边界、受保护 kind、孤儿文件。
- `control-schedule.test.ts`：tick→message+queue、无 run、dedupe、
  paused/unready/unknown factory、manual、catch-up 上限、无第二 queue 表。
- `control-dispatch-budget.test.ts`：settle charge、重复 terminal 幂等、
  sweep、paused task deferred 不启动 run。
- `cli-w5c.test.ts`：budget/readiness/schedule/depend CLI 路径。
- `control-a2a-tools.test.ts` 新增 depth budget 负例。

## 3. 当前边界 / unknown

1. **W5d 未实现**：daemon StopOperationRecord 六态/operator 签名/复验、
   deployment wait 消费、`task_managed_work_bindings`/PR lifecycle/
   TaskOutcome refs/managed-work sticky retry。见 F011 / `0012` §W5d。
2. **W5b 已接**：capacity 默认消费 W5b `WorkerStore.listSnapshots()`；
   registry 为空时才 local fallback。W5c 不建 registry/liveness。
3. **worktree 内容未托管**：pool 只创建/隔离/回收 slot；git worktree
   checkout 由 executor 负责。
4. **budget 初始化时点**：`sweep` 会为同 task 的所有未扣 terminal run
   补账；建议预算在 task 创建时设置。若未来需要“预算生效时间”，另加
   `budgets.created_at` 与 sweep window。
5. **artifact GC 默认 dry-run**；operator/daemon 调用时显式传
   `dryRun:false` 才删除。
6. **没有 HTTP/MCP/Console**（W7）；CLI 是 W5c 的 operator 入口。

## 4. 风险与回滚

| 风险 | 处置 |
|---|---|
| readiness 变成第二调度器 | 只做 projection + dispatch 前硬门；Queue Entry 仍是唯一 wake |
| budget charge 重复/漏记 | `run_id UNIQUE` + sweep + audit；terminal 不因记账失败回滚 |
| worktree GC 误删 | root/realpath/symlink 三重校验；默认 dry-run |
| F139 变第二 cron | 只有 `tick(now)`，无 timer；RunLedger 只记 projection |
| capacity unknown 被当 unlimited | typed `capacity_unknown` fail closed |
| W5c 冒充 W5d | F010/0012/本报告均明确 W5d 未完成 |

回滚到 `0827773aa`；migration 013 是新增表，代码是新增 `scheduling` 模块与
可选 dispatch 注入。已写 audit 保留，不删除证据。

## 5. Review follow-up（2026-10-28）

砚砚 bounded code/security review 对 `9f8de4628` 给出 `changes_requested`
（1×P2，3×P3，无 P1）：

- **P2-1（已修）**：非 done 任务的过期 lease 可能永久占用 pool。新增
  `reclaimGraceMs`（默认 48h，env `CODETEAM_WORKTREE_RECLAIM_GRACE_MS`）；
  过期后仅在 task 无 running run 时回收，active run 的工作目录不会被删。
  新增 active-run 保护测试与 inactive 回收测试。
- **P3-1（已修）**：readiness 遇到多 budget 的 `invalid_state` 降级为
  `budget_invalid` blocker，`listReadyBacklog` 不再整表抛错。
- **P3-2（已修）**：`WorktreeLeaseStore.create` 在事务内检查 `maxActive`，
  关闭 `checkCapacity → acquire` 的 check-then-act 窗口。
- **P3-3（已记录）**：`schedule_runs.status='queued'` 只是 occurrence 记录，
  Queue Entry / Run terminal 才是执行真相；已写入计划/报告边界。

## 6. Close record（2026-10-28）

- PR #52 squash merged into `codeteam-work` at
  `959ef7e760ee5227e0d125b2235bf75e36395d91`; reviewed HEAD
  `15b7009c3c59594f13987e40ab0f9855d4056688`; base `0827773aa`.
- 砚砚 code/security approved（msg `0001793199344123-003737-a8c073df`，
  P2-1 修复后复验）；墨墨 SOP/process/Product approved（msg
  `0001793199744633-003740-f7c64992`）。无 P1/P2 未闭合。
- CI 4/4 green；post-merge daemon acceptance 47 files passed + 2 skipped，
  349 tests passed + 2 skipped。
- 本 close-out docs PR 修正 §1.1 heading（Migration 012 → 013）；W5d 仍为
  F011 / 未实现。

