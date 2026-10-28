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
- `DispatchService` 可注入 `deploymentWaitGuard`；waiting / outcome pending
  时释放 claim、记 `dispatch_deferred`、不启动 run。
- CLI：`codeteam deployment wait register/status/sweep`。

### 1.3 W5d-C daemon lifecycle

- `StopOperationRecord` 文件 owner：`CODETEAM_DATA_DIR/lifecycle/`，目录
  0700、记录 0600；六态 `requested → stopping → stopped →
  restart_authorized → restarted → reverified` + `failed`/`stale_cleared`。
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
| Daemon package tests | `NODE_ENV=development npm --prefix packages/codeteam-daemon test` | 52 files passed + 2 skipped；370 tests passed + 2 skipped |
| Root typecheck | `node_modules/.bin/tsc --noEmit` | exit 0 |
| Format/lint | `node_modules/.bin/biome check packages/codeteam-daemon` | exit 0 |

新增/覆盖测试：

- `control-managed-work.test.ts`：register 三态、private binding、cascade、
  attribution、merge evidence audit、sticky decision、preflight。
- `control-managed-retry.test.ts`：different profile 消费 recipient + blocker；
  same profile 启动并保留 run binding。
- `control-deployment-wait.test.ts`：register replay、new boot、revision、
  unknown/wrong subject、delivery 幂等、start guard、真实 daemon boot/exit。
- `control-daemon-lifecycle.test.ts`：六态顺序、签名、executor containment、
  frozen identity、relaunch/reverify、stale clear、boot exit evidence。
- `cli-daemon.test.ts`：operator `daemon status` 真实 CLI 子进程。

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
