---
title: "W5d runtime lifecycle / deployment wait / managed work 实施报告"
doc_kind: report
status: active
created: 2026-10-28
updated: 2026-10-28
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
feature: "codeteam/F011"
source: "docs/plans/0013-w5d-runtime-lifecycle-managed-work.md"
---

# W5d runtime lifecycle / deployment wait / managed work 实施报告

> W5c core（F010）已 closed。本报告只记录 W5d 的 runtime lifecycle、
> deployment wait 与 managed-work/PR lifecycle；W5c 的 readiness/DAG/预算/
> worktree pool/F139 不重做，也不由本报告重新声明完成。

## 1. 已实现

### 1.1 W5d-A managed work / PR lifecycle

- `ManagedWorkService.registerPrTracking`：`tasks(kind='pr_tracking')` 与
  `task_managed_work_bindings` 同一 SQLite 事务；same binding 幂等、
  missing binding no-op、different binding 返回 conflict；task delete FK
  cascade。冲突 audit 在事务回滚后写入，避免证据丢失。
- `attributeTask` / `attributeRun`：只有 private binding 命中才返回
  `managed_attributed`；pr_tracking 缺 binding、primary implementer 缺
  binding 分别为 `managed_unattributed`；review/verify participant 为
  `unmanaged_not_applicable + participant_phase_b`。没有创建第二 episode
  store；episode 仍归 W6。
- `recordLifecycleEvidence`：merge/revert evidence 按 live `pr_tracking`
  task 读 binding；内部 audit 可带 workId/attemptId，公共 Task 对象不带
  raw IDs。`MergeExecutor` 对 `pr_tracking` task 自动记录 merge evidence。
- `stickyRetryDecision` + `WorkAdmissionStore.preflightRunBinding`：
  same profile 放行；不同 profile 返回 typed conflict；DispatchService
  消费 target（不 livelock）+ 写 `work_binding_conflict` audit + operator
  inbox。非 managed / reviewer 不受影响。

### 1.2 W5d-B deployment wait

- 等待状态只写原 Task `deployment_wait_json`；没有 `deployment_waits` 表。
- `DeploymentObservationService` 只读 daemon state + boot ledger；state
  非 ready、boot 未 ready、ledger 损坏均返回 unknown，不误唤醒。
- 支持 `new_ready_boot` 与 `revision_included`。v1 的
  `revision_included` 使用 runningRevision 精确匹配（比 git ancestry 更严格），
  `new_ready_boot` 只比较 bootSequence 基线。
- register / evaluate / deliver / sweep / start guard；outcomeId + owner
  fence + queue entry 幂等；投递经 `messages` + `queue_entries`，不直接
  起 Run。`sweep(now)` 是唯一恢复入口，没有每猫 timer。
- 退出路径：`cancel`（operator `user:`/`operator:` principal、必填
  reason、terminal 状态、audit 记 previousStatus/outcome/queueEntryId）。
  不可匹配的 wait（错 sha、merge-commit runningRevision、部署回滚）不再
  永久阻塞任务。cancel 幂等；terminal 且未投递的 wait 可重注册为
  `generation+1`（修正 predicate 后重新等待），已投递的 wait 拒绝重注册
  以防二次唤醒。CLI：`codeteam deployment wait cancel <taskId> --reason`。
- `DispatchService` 可注入 `deploymentWaitGuard`；waiting / outcome pending
  时释放 claim、记 `dispatch_deferred`、不启动 run。
- 单任务级 admission gate（`budget_paused`、`deployment_wait_pending`、
  `deployment_wait_outcome_pending`）不再
  `break` 整轮 drain：defer 后把 entry 放入本轮 skip-set（`claimNext.excludeIds`），
  继续处理后续 entry。此前队头一个 long-running deployment wait 会饿死整条
  queue（wait 可持续数天），属真实 P2；`budget_paused` 同根因一并修。未知
  错误仍保守 `break`。
- CLI：`codeteam deployment wait register/status/sweep`。

### 1.3 W5d-C daemon lifecycle

- `StopOperationRecord` 文件 owner：`CODETEAM_DATA_DIR/lifecycle/`，目录
  0700、记录 0600；六态 `requested → stopping → stopped →
  restart_authorized → restarted → reverified` + `failed`/`stale_cleared`。
- `targetProcessSet` 是 requestStop 时的快照；`executeStop` 先用
  frozen identity 复验主 daemon pid，再从该 pid 重新推导 descendants
  作为实际信号集，并复验 executor 不在树内。请求与执行之间被回收/复用的
  descendant pid 不会被误杀；`stoppedProcessSet` 记录实际信号集。
- operator 授权：签名 payload 覆盖 action/opId/deploymentId/stoppedBootId；
  校验 operator.key 公钥 fingerprint + signature；自由文本不构成授权。
- StopOperationClaim 世代链 + `wx`；holder 存活不可证明时拒绝接管；corrupt
  claim fail closed。`requestStop` 冻结身份；executor 在生命周期树内拒绝；
  execute 前 recheck frozen identity。
- lifecycle 只发 SIGTERM；超时不自动强杀，写 failed；health probe 用
  loopback /health body（bootId/process identity/installationId）复验
  relaunch；不可读 fail closed。
- `boot-ledger`/`state`/`health` 增 `deploymentId`、bootSequence、process
  identity、startedAt、`exited`+`exitKind`；startup failure 与 clean exit
  都有证据。
- CLI：`codeteam daemon status/stop`。relaunch 的“启动新 daemon”仍是
  external executor 责任；service 已提供 authorizeRestart/recordRestart/
  reverify，避免在 daemon 内造第二 supervisor。

## 2. 命令与结果

工作区：`/home/ming/agent/codeteam-w5c`，分支
`feat/w5d-runtime-lifecycle-managed-work`，base `7adc30ee4`。

| Check | Command | Result |
|---|---|---|
| Build | `NODE_ENV=development npm run build:offline` | exit 0 |
| Daemon package tests | `NODE_ENV=development npm --prefix packages/codeteam-daemon test` | 52 files passed + 2 skipped；378 tests passed + 2 skipped |
| Root typecheck | `node_modules/.bin/tsc --noEmit` | exit 0 |
| Format/lint | `node_modules/.bin/biome check packages/codeteam-daemon` | exit 0 |

新增/覆盖测试：

- `control-managed-work.test.ts`：register 三态、private binding、cascade、
  attribution、merge evidence audit、sticky decision、preflight。
- `control-managed-retry.test.ts`：different profile 消费 recipient + blocker；
  same profile 启动并保留 run binding。
- `control-deployment-wait.test.ts`：register replay、new boot、revision、
  unknown/wrong subject、delivery 幂等、start guard、真实 daemon boot/exit。
  另有 operator cancel/quarantine：cancel 放行 start、幂等、非 operator
  拒绝、cancel 后 `generation+1` 重注册、已投递拒绝重注册。
- `control-daemon-lifecycle.test.ts`：六态顺序、签名、executor containment、
  frozen identity、relaunch/reverify、stale clear、boot exit evidence。
  新增：execute 时从 identity-verified pid 重新推导 descendants——请求时
  冻结的 descendant pid 若已被回收/复用不再被 signal，新 child 会被纳入；
  `stoppedProcessSet` 记录实际信号集。
- `cli-daemon.test.ts`：operator `daemon status` 真实 CLI 子进程。
- `control-dispatch-budget.test.ts`：队头 `budget_paused` / `deployment_wait_pending`
  / `deployment_wait_outcome_pending` 时后续 ready entry 仍被 dispatch，
  deferred entry 保持 `queued`。回归验证：临时关掉 deferrable 分支时三条
  新测试均 RED。

## 3. 边界 / unknown

1. **relaunch CLI**：service 完成 lifecycle 的 authorize/record/reverify；
   启动新 daemon 仍由 external executor 执行，CLI 只提供 status 与 halt。
   这是“不建第二 supervisor”的边界，不是把 relaunch 生命周期能力私有化。
2. **revert pipeline**：`recordLifecycleEvidence` 支持 `evidenceKind:'revert'`，
   但 W5d 没有 revert executor；GitHub/PR 侧的 revert 事件由 W8 消费。
3. **revision_included** 使用精确 runningRevision，不使用 git ancestry；
   这是 fail-closed 的更严格版本。
4. **TaskOutcome episode** 仍归 W6/A3-3；W5d 只提供 binding/refs 与 audit，
   不建 `task_outcome_episodes`。
5. **W5c memo**：worktree `expiredTerminal` 依赖“task done 时无 running run”
   不变量；GC 损坏路径 fail-closed 中途抛错；`schedule_runs.status='queued'`
   只是 occurrence 记录。已写入 W5d task/报告。
6. **platform**：process identity/health 依赖 POSIX `/proc` + loopback；
   Windows adapter 后置；不可读 fail closed。

## 4. 风险与回滚

| 风险 | 处置 |
|---|---|
| 第二 supervisor/registry | 只记录 lifecycle 文件 + external executor；无第二 process registry |
| 未授权 lifecycle | operator 签名 + key fingerprint + claim + executor containment + frozen identity |
| deployment wait 误唤醒 | bootSequence baseline、subject match、unknown retain、outcome/queue 幂等 |
| raw ID 泄漏 | private binding 表；公共 Task/Run/Queue 无 raw IDs；audit-only internal refs |
| managed retry livelock | preflight conflict 消费 recipient + operator inbox，不留在 queue |
| W5d 冒充 W5c/W6 | F011/0013/report 明确边界；不重做 F010，不建 episode store |

回滚到 `7adc30ee4`；新增文件 owner 保留历史，不删除 lifecycle/boot evidence。

## 5. Review 重点

- 砚砚：operator 授权、claim/frozen identity、executor containment、
  private binding/raw ID、deployment wait fail-closed、sticky conflict。
- 烁烁：StopOperationRecord/boot ledger、deployment observation/recovery、
  daemon crash/lease 交互。
- 墨墨：operator CLI 可解释性、ready≠task done、W5c/W5d 边界、AC 不 overclaim。

## 6. Merge record / post-merge review（2026-10-28）

- PR #56 squash merged at `168e67dd0`（reviewed HEAD
  `dfb872d9c36c62e476f2e11fcfd3d2f37575e1f1`，base `7adc30ee4`）。
- Review：砚砚 code/security approved @ `dfb872d9c`（msg
  `0001793202850007-003779`；2×P2 + 3×P3 全闭合，residual 清零）；墨墨
  SOP/process/Product approved @ `dfb872d9c`（msg
  `0001793202985338-003781`；无 P1/P2，4 条 close-out 文档项）。
- Review 轮次修复（已进 squash commit）：dispatch admission gate
  head-of-line 饥饿（三条 gate 统一 defer + skip-set）；deployment wait
  operator `cancel` 退出路径 + `generation+1` 重臂；conflict audit
  try/catch；execute 时 descendant 重推导 + `stoppedProcessSet`。
- Post-merge acceptance（merged `168e67dd0`，主 checkout 先
  `build:offline`）：daemon 包 52 files passed + 2 skipped，378 tests
  passed + 2 skipped。注意：主 checkout 未重建 `dist/cli.js` 时
  `cli-daemon.test.ts` 会因旧 CLI 失败，属构建前置条件而非产品回归。
- 未采纳项：无。`revision_included` 的精确 runningRevision 匹配保留为
  v1 有意 fail-closed 选择，reuse 卡未要求 ancestry。
- 烁烁 W5/session-interface lane（现行）：operator 已把 `cat-u12wt5ln`
  拉入本 thread，其 post-merge 复核（lifecycle / boot ledger /
  observation / recovery）仍在进行，**verdict 未出**。此前“routableNotJoined、
  由砚砚合票覆盖”的处置作废，不能把“已合入”当作“已完成独立复核”。
  结论口径：无 P1/P2 后 F011 才转 done、W5 才 closed；有 P1/P2 则保持
  in_review，并从 `94bf38c1e` 起开 follow-up fix PR 后复审。
- Close-out 文档项（墨墨 4 条）：0013 §10 数字/CLI 列表、`status/halt` →
  `status/stop` 命名统一、烁烁 lane 处置、merge 前 re-pin 要求——本 PR
  一并处理。
