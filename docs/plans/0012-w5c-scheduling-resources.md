---
title: "W5c 运营调度与资源实施计划"
doc_kind: plan
status: active
created: 2026-10-28
updated: 2026-10-28
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
source: "docs/plans/0004-w5-w8-scale-product.md §W5 Tasks 5–8/12"
---

# W5c 运营调度与资源实施计划

> W5 的契约与总验收仍以 `0004` §W5 为单一真相源。本文件只写 W5c 的落点、
> 冻结接口、实施顺序与验证映射。W5a 的 Queue/Run/Handoff/Wait 契约已经冻结
> （`0010`），W5b 负责 RPC worker runtime / worker registry / sticky / re-attach。

## 0. 范围决定：W5c core 与 W5d

W5c 原始范围含六块：readiness/DAG、预算、worktree pool/GC、F139、daemon
lifecycle、deployment wait、managed-work/PR lifecycle。按 source thread 的
预授权（“若 lifecycle/managed-work 让本 thread 过大，在 thread 内 fork W5d”），
本 thread 拆成两个可独立 review 的切片：

| 切片 | 内容 | 本计划状态 |
|---|---|---|
| **W5c** | task readiness/admission + priority/DAG + budget/quota + worktree pool/disk quota/artifact GC + F139 proactive schedule adapter | **实现中** |
| **W5d** | daemon StopOperationRecord 六态/授权/复验 + deployment wait 消费 + `task_managed_work_bindings`/PR lifecycle/TaskOutcome refs/managed-work sticky retry | 计划冻结，另轮实施 |

拆分理由：W5c core 是调度/资源平面，只依赖 W1 store 和 W5b capacity 投影；
W5d 是 runtime lifecycle 与归因平面，涉及文件型生命周期记录、operator
签名、进程身份和 deployment 观察。两者风险面、测试环境和 reviewer 关注点
不同。W5d 不在本切片冒充完成；`0004` 对应 AC 仍保持未勾选。

## 1. 目标与可见结果

W5c 完成后，codeteam 能在进入唯一 Queue Entry 之前回答：

1. 这条 task 现在能不能开始？依赖是否完成、预算是否 paused、worktree 与
   worker capacity 是否可用、优先级/排队顺序是什么。
2. 一个 run 结束后预算是否被真实扣减；越过限额时是否产生可见 pause，而
   不是静默继续。
3. worktree 租约是否有上限、磁盘水位是否被检查、释放/过期/孤儿目录是否
   能被安全 GC；artifact 是否只清理有明确保留边界的对象。
4. F139 proactive schedule 触发后是否只生成一条 Queue Entry，而不是直接
   起 Run、也不创建第二个 cron/drain。

本切片不新增消息层、不新增执行队列、不新增 worker registry/liveness。

## 2. W5b capacity 接口（已接入）

W5b（F009/`0011`，PR #53）已落地 worker registry/capacity。W5c 直接消费
`WorkerStore.listSnapshots()`，不建第二 registry，也不根据进程存活猜测
capacity。

```ts
export type CapacitySlotStatus = "available" | "busy" | "draining" | "stale" | "offline";

export interface CapacitySlot {
  readonly slotId: string;
  readonly role: string;
  readonly status: CapacitySlotStatus;
  readonly capacity: number;
  readonly activeRuns: number;
}

export interface CapacitySnapshot {
  readonly schemaVersion: 1;
  readonly source: "local" | "w5b-registry";
  readonly observedAt: number;
  readonly staleAfterMs: number;
  readonly slots: readonly CapacitySlot[];
}

export interface CapacityProvider {
  snapshot(now: number): CapacitySnapshot | null;
}
```

语义：

- `source="w5b-registry"` 由 W5b 提供；W5c 只读，不写 registry、不发心跳、
  不做 liveness 判定。
- snapshot `null`、`observedAt` 过期、或没有任何匹配 role 的 slot →
  `capacity_unknown`，fail closed（不把 unknown 当 unlimited）。
- `available` slot 可计入；`busy`/`draining`/`stale`/`offline` 不可计入。
- `WorkerRegistryCapacityProvider` 把 W5b snapshot 映射为：
  `online + availableRunSlots>0 → available`，`online + 0 → busy`，
  `draining → draining`，`stale/lease expired → stale`，`retired → offline`，
  `starting → busy`。registry 空 → `capacity_unknown`，不是 unlimited。
- 只有完全没有 worker registry（例如 CLI/单进程测试）时才使用显式
  `LocalCapacityProvider` 作为本地 fallback；它不创建 registry，只声明
  “本机单进程容量”（默认 4）。一旦存在 W5b worker，readiness 必须走 registry。
- 测试用 fake provider 冻结决策树；W5b 已接，后续只换投影读取，不改
  readiness 语义。

W5c 不新增 `workers` / `worker_heartbeats` / `worker_leases` 表。若 W5b
需要这些表，由 W5b 拥有。

## 3. 冻结的 W5c 契约

### 3.1 Task readiness / admission

- 唯一 pending-wake 账本仍是 `queue_entries`。readiness 只决定“是否允许
  创建/claim 这条 task 的 Queue Entry”，不保存第三个队列。
- `dependencies_json` 的 W5c 形状为 `{ dependsOn: string[] }`；只接受
  backlog item id，数组非空字符串、去重、无自引用、引用必须存在、全图
  无环。依赖满足 = 被依赖 backlog item `status='done'`。
- readiness 输出是纯投影：`ready | blocked` + typed reasons + order key，
  不写状态表。排序优先级：backlog `p0/p1 → urgent`，`p2/p3 → normal`，
  同级按 backlog `created_at,id` FIFO；不按 kind/source 加隐藏优先级。
- 硬门禁放在 `ControlStore.dispatchBacklog`：依赖未满足、DAG 环、预算
  paused/exhausted 时拒绝创建 Queue Entry（typed error），不留下半 dispatch。
- `TaskReadinessService` 额外叠加 W5b capacity 与 worktree capacity；它供
  CLI/scheduler 预检和未来多 task 调度使用。容量 unknown 一律 blocked。
- 已存在的 task 上的 A2A 消息不重新走 task admission；readiness 只管
  “开始一条 task”，不阻断 operator/agent 的正常 thread 通信。

### 3.2 Budget / quota

- `budgets` 仍是唯一预算表；一个 task 最多一个 active budget（服务层
  fail closed，不新增第二预算 store）。
- usage 进入 `budget_charges`（`run_id UNIQUE`），同一 run 重复结算幂等，
  不重复扣减。
- 每次 charge 在同一个 SQLite 事务里：插入 charge → 更新 `tokens_used`/
  `cost_used`/`wall_time_used_ms` → 计算是否越限 → 需要时创建 `budget_pause`
  approval（同 task 已有 open pause 则复用）→ audit。
- 任一边界 `used >= limit` 即 paused。paused 不是“拒绝当前 run 收口”，而是
  阻止新的 task dispatch/run admission；当前 run 的 terminal 不丢。
- operator 通过 `codeteam budget set <taskId> ...` 追加/提高预算，或由
  approval 明确处置；仅“接受 pause”不自动等于放宽预算。
- 无 budget 行的 task 视为未启用预算，不制造虚假 enforcement。

### 3.3 Worktree pool / disk quota / artifact GC

- `worktree_leases` 是租约表，不是第二 worktree gate；真正的 git checkout
  仍由 executor 在 lease 给定的 path 内创建。W5c 拥有 slot/lease/TTL/GC。
- `WorktreePoolService`：`acquire` 检查最大租约数、最小空闲磁盘水位、root
  内路径；`release` 标记 released；`gc` 只删除 root 内、已 released 且超过
  TTL、或孤儿目录（无 DB lease 且超过 TTL）的路径。任何 realpath 越界、
  符号链接、非目录目标一律拒绝删除并记 audit。
- 磁盘水位通过可注入的 `statfs` 读取；不可读 = fail closed（不把 unknown
  当足够空间）。
- `ArtifactGCService` 的 v1 保留边界：
  - 只删除 `kind='log'` 且 task 已 done 且超过 retention 的 artifact；
  - spec/plan/diff/test-report/review/verification/merge-receipt 永不由 v1
    GC 删除；
  - artifact root 内没有被 `artifacts` 引用的孤儿文件，超过 TTL 才删除；
  - 每次删除写 audit，返回 dry-run 可复核的 report。

### 3.4 F139 proactive schedule adapter

- `schedule_specs` 存 `TaskSpec_P1`：`trigger/admission/run/state/outcome`
  五段；`schedule_runs` 是 RunLedger，按 `(spec_id, occurrence_key)` 唯一。
- 触发只做一件事：在 spec 绑定的 thread/task 上写一条来源 message，再创建
  一条 `queue_entries`；不直接调用 `runs.create`，不新建 cron/drain。
- `tick(now)` 是纯调用入口，由唯一的 daemon 调度心跳/CLI 调用；不注册
  `setInterval` 或第二个 poller。单次 tick 有 catch-up 上限，剩余 occurrence
  留给下一次 tick，不风暴式补跑。
- `schedule_runs.status='queued'` 是发生记录，不是完成真相；Queue Entry /
  Run terminal 才是执行终态。W5d 消费者不得把 queued ledger 行当完成或失败。
- factory 走显式白名单；W5c 内置 `task_wake` 通用工厂。CI 轮询 / stale
  清理 / repo scan 的真实 factory 由 W8/对应 owner 注册，不能绕过白名单。
- spec paused、task 不 ready（依赖/预算）、或 target 无效时，RunLedger 记
  `skipped` + typed reason，仍推进 occurrence，不创建 Queue Entry。
- 触发后的 Queue Entry 进入既有 dispatch drain；F139 不拥有第二个消费端。

## 4. 实施切片

### W5c-1 schema + budget

| 单元 | 落点 | 可观察结果 | 验证 |
|---|---|---|---|
| W5c-1.1 migration 013 | `src/control/migrations/013-w5c-scheduling-resources.ts` | `budget_charges`、`worktree_leases`、`schedule_specs`、`schedule_runs` 可建；旧库可升级 | migration matrix |
| W5c-1.2 budget charge | `src/control/stores/budgets.ts` + `src/scheduling/budget.ts` | run 结算幂等扣减；越限产生 pause approval | store/service tests |
| W5c-1.3 dispatch 结算接入 | `src/dispatch/service.ts` | completed/failed/canceled 都按真实 usage 扣减；失败不丢 charge | integration |

### W5c-2 readiness / DAG

| 单元 | 落点 | 可观察结果 | 验证 |
|---|---|---|---|
| W5c-2.1 dependency validation | `src/control/stores/backlog.ts` | 建/改依赖时拒绝自引用、缺失、环 | unit |
| W5c-2.2 readiness projection | `src/scheduling/readiness.ts` | ready/blocked + reasons + order key；p0/p1→urgent | unit |
| W5c-2.3 dispatch hard gate | `src/control/store.ts` | 未满足依赖/预算 paused 时 `dispatchBacklog` 不建 queue | integration |
| W5c-2.4 capacity seam | `src/scheduling/capacity.ts` | W5b projection unknown fail closed；local provider 读 canonical runs | unit |

### W5c-3 worktree + artifact GC

| 单元 | 落点 | 可观察结果 | 验证 |
|---|---|---|---|
| W5c-3.1 lease store | `src/control/stores/worktree-leases.ts` | acquire/release/过期查询 | store tests |
| W5c-3.2 pool service | `src/scheduling/worktree-pool.ts` | max leases、磁盘水位、root 越界拒绝 | unit + fs fixture |
| W5c-3.3 GC | 同上 + `src/scheduling/artifact-gc.ts` | released/孤儿目录清理；log artifact 保留边界 | fs + store tests |

### W5c-4 F139 adapter

| 单元 | 落点 | 可观察结果 | 验证 |
|---|---|---|---|
| W5c-4.1 spec store | `src/control/stores/schedules.ts` | TaskSpec_P1 持久化、版本 CAS、paused | store tests |
| W5c-4.2 adapter | `src/scheduling/schedule.ts` | tick → message + Queue Entry；无 Run | integration |
| W5c-4.3 ledger dedupe | 同上 | 同 occurrence 重放不重复入队 | integration |

### W5c-5 CLI + docs

| 单元 | 落点 | 可观察结果 | 验证 |
|---|---|---|---|
| W5c-5.1 CLI | `src/cli/budget.ts`、`src/cli/schedule.ts`、`backlog create --depends-on` | operator 能设置预算、查看 readiness、注册/触发 schedule | CLI tests |
| W5c-5.2 docs | `docs/features/F010-w5c-scheduling-resources.md`、report | 证据、边界、W5d residual 可见 | doc review |

## 5. AC 映射（`0004` §W5，仅 W5c core 适用项）

| # | Acceptance | W5c 落点 | 验证 / 边界 |
|---|---|---|---|
| 1 | 依赖 task 按 DAG 顺序执行 | W5c-2 | 依赖未完成 dispatch 拒绝；完成后放行；环拒绝 |
| 2 | 预算耗尽会 pause，不静默继续 | W5c-1 | charge 越限 → open `budget_pause` + 新 dispatch 拒绝；charge 幂等 |
| 3 | F139 触发后生成 Queue Entry，不直接起 run | W5c-4 | tick 后 queue 存在、runs=0；重复 tick 不重复 |
| 4 | 只有一个 pending-wake Queue Entry 账本；无第二队列 | W5c-4 | 断言无 schedule-owned queue 表；RunLedger 只记 projection |
| 5 | 队列比较子无隐藏优先级 | W5c-2 | p0/p1→urgent、p2/p3→normal + FIFO；不按 kind/source |
| 6 | worktree pool / disk quota / artifact GC | W5c-3 | lease 上限、磁盘水位、root 安全、log retention |
| 7 | 容量投影消费 W5b，不另建 registry | W5c-2.4 | typed provider；代码中无 workers/heartbeat 表 |

不在 W5c core 的 `0004` 验收：daemon lifecycle 六态/授权/复验、deployment
wait 消费、`task_managed_work_bindings`/PR lifecycle/TaskOutcome/sticky
retry。它们归 W5d，不能由本 slice 的 passing tests 冒充完成。

## 6. 测试清单

新增：

- `test/control-budget.test.ts`：幂等、tokens/cost/wall 三类越限、pause
  approval 单开、budget set 后恢复、无预算不误判。
- `test/control-readiness.test.ts`：DAG 顺序、环、缺失依赖、p0/p1 顺序、
  budget paused、capacity unknown/exhausted、local provider 读 running runs。
- `test/control-worktree-pool.test.ts`：lease 上限、磁盘水位不可读/不足、
  root 内 release+GC、root 越界拒绝、孤儿目录 TTL。
- `test/control-artifact-gc.test.ts`：log artifact 保留边界、孤儿文件、
  受保护 kind、dry-run。
- `test/control-schedule.test.ts`：TaskSpec 注册、tick→message+queue、无
  run、dedupe、paused/skipped、catch-up 上限、未知 factory 拒绝。
- `test/control-dispatch-budget.test.ts`：`settleRun` 真实 usage 扣减、
  重复 terminal 不重复 charge、interrupted recovery 后补 charge。

定向命令：

```bash
NODE_ENV=development npm --prefix packages/codeteam-daemon test -- control-budget control-readiness control-worktree-pool control-artifact-gc control-schedule control-dispatch-budget
NODE_ENV=development npx tsc --noEmit -p tsconfig.json
NODE_ENV=development npx biome check packages/codeteam-daemon
```

包内全量：`NODE_ENV=development npm --prefix packages/codeteam-daemon test`；
合入前再跑 `NODE_ENV=development npm run build:offline`。

## 7. 依赖与顺序

1. migration 013 先落；所有 store/service 测试依赖新表。
2. budget charge 先于 readiness 的 budget gate；readiness 只读预算投影。
3. worktree pool 与 F139 可并行；W5b 已落地，capacity 直接消费其 snapshot。
4. dispatch budget 接入最后做，避免影响 W5a 现有 dispatch 测试。
5. W5d 在 W5c 合入后另开：生命周期文件 owner、operator 签名、deployment
   observation、managed-work task binding/sticky retry。

## 8. 风险与回滚

| 风险 | 级别 | 处置 |
|---|---|---|
| readiness 变成第二调度器 | P1 | 只做纯投影 + dispatch 前硬门；不新增队列/claim 循环 |
| budget charge 重复/漏记 | P1 | `run_id UNIQUE` + 同事务；recovery 可重放 |
| worktree GC 误删用户数据 | P1 | 只删 pool root 内、无 symlink、DB lease 可证的路径；默认 dry-run |
| F139 变成第二 cron | P1 | 只暴露 `tick(now)`；无 timer；Queue Entry 是唯一 wake |
| capacity unknown 被当 unlimited | P1 | typed `capacity_unknown` fail closed；local provider 显式声明 |
| DAG 环/缺失引用 | P2 | 建/改依赖时校验；dispatch 再校验 |
| artifact GC 删证据 | P1 | v1 只删过期 log + 无引用孤儿；protected kinds 不删 |
| W5c 冒充 W5d 完成 | P2 | 计划/F010/report 明确边界；AC 不勾 W5d 项 |

回滚：migration 013 是新增表；代码是新增 `scheduling` 模块与可选 dispatch
注入。回滚到 `c30f9aafb` 即可；已写 audit 保留，不删除证据。

## 9. Review 重点

- 砚砚：预算事务/幂等、worktree 路径安全与磁盘 fail-closed、capacity
  unknown 语义、F139 无第二调度器。
- 墨墨：readiness 是否服务真实 operator 路径、pause/GC 是否可解释、
  W5c/W5d 边界是否诚实、AC 是否 overclaim。

## 10. Current progress（2026-10-28）

W5c core 已实现并进入 review：

- 分支已 rebase 到 W5b 合入后的 `codeteam-work`（base `0827773aa`）；
  W5b 占用 F009/0011/migration 012，本 slice 使用 F010/0012/migration 013。
- migration 013：`budget_charges`、`worktree_leases`、`schedule_specs`、
  `schedule_runs`；无第二 queue/run/worker registry。
- readiness/DAG：`src/scheduling/{dependencies,readiness,capacity,priority}.ts`；
  capacity 默认消费 W5b `WorkerStore.listSnapshots()`，无 worker 时才 local fallback；
  `dispatchBacklog` 硬门；`backlog depend`。
- budget：`BudgetStore` charge ledger + `BudgetService` pause/sweep；
  `DispatchService` terminal 扣减 + paused 时 deferred 不启动 run。
- worktree pool/GC：`WorktreeLeaseStore` + `WorktreePoolService` +
  `ArtifactGCService`。
- F139：`ScheduleStore` + `ProactiveScheduleService` + `task_wake` factory；
  只有 `tick(now)`，无 timer。
- CLI：`budget set/show`、`task readiness`、`schedule add/list/show/pause/
  resume/tick`、`backlog depend`；`task create --budget-*`。
- residual：`a2aDepth` 软上限 `CODETEAM_A2A_MAX_DEPTH=32` 已闭合。

验证：`NODE_ENV=development npm run build:offline` exit 0；daemon 包
47 files passed + 2 skipped，349 tests passed + 2 skipped；包级 `tsc` 与
`biome check` 通过。完整命令与边界见
`docs/reports/2026-10-28-w5c-scheduling-resources.md`。

### 10.1 W5d handoff（未实现）

以下内容拆到 F011 / 下一轮 thread，不在本 slice 冒充完成：

1. **Daemon lifecycle**：文件型 StopOperationRecord 六态 + failed/
   stale_cleared；operator principal + 签名复核；frozen identity；
   executor 不在目标进程树；stop 后 health 复验；boot history/exit 证据。
2. **Deployment wait**：原 Task `deployment_wait_json` 的 F280 await；
   `autoRenew:false`、TTL=0；`revision_included`/`new_ready_boot`；
   bootSequence 基线；单个 recovery sweep；start guard；经 `queue_entries`
   投递；不建第二等待表。
3. **Managed work / PR lifecycle**：`task_managed_work_bindings` 与
   `pr_tracking` task 同事务；same idempotent/missing no-op/different 409；
   FK cascade；merge/revert evidence 读 binding；missing →
   `managed_unattributed`；TaskOutcome 三分桶 refs；sticky retry
   (DP-A2-2-1=A)。

W5d 必须重新读 `0004` §W5、`docs/reuse/managed-work.md`、
`docs/architecture/reuse-review/{runtime-deployment,managed-work}.md` 和
`docs/reuse/runtime-deployment.md`，先写实施计划与 AC 映射，不得直接
复用本 slice 的 evidence 宣布完成。

