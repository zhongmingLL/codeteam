---
feature_ids: [codeteam/F004e]
related_features: [codeteam/F004]
title: "F004e: W1 startup recovery + migration matrix + Console M0 read models"
status: done
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash)]
created: 2026-10-28
updated: 2026-10-28
---

# F004e: W1 startup recovery + migration matrix + Console M0 read models

> F004 umbrella 的收口切片。F004 是单一 AC/契约源；本文件只加 slice-specific
> AC，不复制 W1 Acceptance。项目作用域 ID 为 `codeteam/F004e`。

## Why

F004a–d 把控制面表与 store 落齐，但 daemon 重启后没有扫掠器把半途状态收敛：
running run 永远停在 running、死进程的 handoff claim 永远占着 holder 位、
过期 handoff 不会被裁决。W1 计划 #16（迁移矩阵）与 #17（恢复测试）也还没有
可执行证据；Console M0 还缺稳定的只读数据形状。

## What

- `recoverControlPlane(store, { activeRunIds?, now? })`：单事务启动扫掠。
  - running run 且不在活跃 worker 集 → `interrupted`；凭据
    `terminalize('interrupted')`；audit `run_interrupted`。
  - explicit deadline 已过的 handoff → `expired`（active claim 一并释放，
    之后不可 late-complete）。
  - 被中断 run 的 active claim → `released(run_interrupted)`，handoff 回
    `pending`（同 generation）。
  - 其他 stale claim（lease 过期且 run 非活跃）→ `released(lease_expired)`。
  - 被中断 run 或已过期 claim 占住的 `queue_entries` → 回 `queued`，恢复
    dirty-bit drain 不因死 run 断流。
  - loop guard 快照：canonical action key 的 attempts / live 计数（从
    `handoffs` 派生，不建表）。
  - dirty-bit：queued 队列条目计数 + `drainRequested`。
- `ControlReadModels`：Console M0 只读查询——thread 摘要（消息/任务/排队
  计数）、thread timeline（消息 + thread events）、task evidence
  （artifact / review+finding / merge / approval）。
- Store 读原语：`handoffs.listActiveClaimsByRun` / `listStaleClaims` /
  `loopGuardSnapshot`、`queue.pendingCount`。
- W1 迁移矩阵测试：空库、v3 旧库、部分迁移、crash 后重跑。

## Acceptance

- [x] running run → interrupted；活跃 worker 集的 run 不受影响；凭据
  terminalize 且 disposition=`interrupted`。
- [x] stale claim + proof → 回 pending（同 generation，不判 expired）。
- [x] explicit deadline → expired；expired handoff 不可 late-complete。
- [x] interrupted run 的 token/claim 不能 complete 任何 handoff。
- [x] parallel 一个 holder 被中断不影响其他 holder。
- [x] 重复 sweep 幂等；loop guard 与 dirty-bit 报告正确。
- [x] 死 run 的 queue claim 回 queued；活跃 run 的 claim（即使 TTL 已过）不动。
- [x] 空库 / v3 旧库 / 部分迁移 / crash 后重跑四条迁移测试通过，旧数据不丢。
- [x] Console M0 只读：thread 摘要、timeline、task evidence 均有 store 级测试。
- [x] `npm --prefix packages/codeteam-daemon test` 82/82、根级 `tsc --noEmit`、
  Biome 通过。
- [x] 非作者 review（砚砚 approve @ `ba044fe5`，84/84 独立复跑；含
  `738579b9→ba044fe5` test-only delta 覆盖）与 merge（PR #26，`c0a9b675`）。

## Out of scope

- 多 task scheduler / worker registry（W5）；`activeRunIds` 由 W5 提供，
  W1 启动默认空集，因此单进程启动会把所有 running run 收敛为 interrupted。
- wait 过期裁决：§12.4 明确 waits 只驱动唤醒，过期裁决只看 handoff
  explicit deadline；stale claim 只触发 run interruption recovery。
- artifact GC sweep（目录对账 DB）与 threads 单调 revision——记为 W1 后续
  hardening，不在本 slice 改 schema。
- backfill：基线对码报告认定 fresh baseline，W1 无旧 pi 数据可迁；
  backfill 记 N/A（`docs/plans/0002` W1 Acceptance 允许）。

## Evidence

- `npm --prefix packages/codeteam-daemon test`：9 个测试文件、84/84 通过
  （新增 18：recovery 11 + migration 4 + read models 3）。
- `npx tsc --noEmit -p tsconfig.json`：通过。
- `npx biome check packages/codeteam-daemon`：clean。
- Review：砚砚 approve @ `ba044fe5`（final head 覆盖；本地独立复跑 84/84）。
- Merge：PR #26 合入 `codeteam-work`（`c0a9b675`），CI 全绿
  （`build-check-test` 1m06s）。

## Risk

数据/契约面，无新 migration、无新表。恢复扫掠在单事务内完成，失败即整体
回滚并阻塞启动（fail closed）；重复启动幂等。`activeRunIds` 缺省为空是
W1 单进程语义，W5 引入 worker registry 后由调用方传入，避免误伤存活 run。

[宪宪/deepseek-flash🐾]
