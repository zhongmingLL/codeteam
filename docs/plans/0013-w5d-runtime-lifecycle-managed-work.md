---
title: "W5d runtime lifecycle / deployment wait / managed work 实施计划"
doc_kind: plan
status: closed
created: 2026-10-28
updated: 2026-10-28
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash), 烁烁 (Kimi K3), 墨墨 (Qwen 3.8 Flash)]
source: "docs/plans/0004-w5-w8-scale-product.md §W5 Tasks 14–18"
---

# W5d runtime lifecycle / deployment wait / managed work 实施计划

> W5 总契约与验收仍以 `0004` §W5 为单一真相源。W5c core（F010/`0012`）
> 已 closed；W5d 只承接其中未完成的 runtime lifecycle、deployment wait 与
> managed-work/PR lifecycle，不重做 readiness/DAG/预算/worktree pool/F139。

## 0. 范围与拆分

W5d 拆成三个可独立 review 的切片，仍属于同一 F011 workstream：

| 切片 | 内容 | 关键边界 |
|---|---|---|
| **W5d-A** | `task_managed_work_bindings` 注册、PR lifecycle evidence、TaskOutcome refs、managed-work sticky retry | 私有表；不建 episode store；不写 Task/Run 公共列 |
| **W5d-B** | F280 deployment wait 消费、observation/predicate、start guard、单个 recovery sweep、经 `queue_entries` 投递 | 不建第二等待表；不建 cron；ready ≠ task done |
| **W5d-C** | daemon StopOperationRecord 六态、operator 签名、claim/frozen identity、executor independence、health 复验、boot history/exit | 文件 owner；不建第二 supervisor/process registry |

顺序：A 先落（纯 store/service，风险最低）→ B（依赖 daemon observation 接口）
→ C（文件生命周期与 CLI）→ 统一 close-out。若单切片过大，可分别开 PR；
不得把三个切片的 passing tests 混成一项完成声明。

## 1. 目标与可见结果

1. `pr_tracking` task 创建与 private work binding 同事务；same idempotent /
   missing no-op / different 409；无孤儿 binding。
2. merge/revert evidence 按 live `pr_tracking` task 读 private binding；
   命中带内部 refs，缺失明确 `managed_unattributed`；不新增第二 episode store。
3. managed-work retry 先读 attempt 绑定：已绑只选同 profile；不同 profile
   消费 target + operator blocker，不回退到非 managed fallback。
4. 原 Task 登记 `deployment_wait_json` 后，只有 predicate 命中才经
   `queue_entries` 投递；start guard 在 run 启动前复核；无第二等待表。
5. daemon 停启由 target process set 之外的 operator CLI 执行；六态记录、
   operator 签名、frozen identity、health 复验与 boot exit 可审计。

## 2. W5d-A managed work / PR lifecycle

### 2.1 冻结契约

- `task_managed_work_bindings` 只允许 live `pr_tracking` task；task 与
  binding 同一 SQLite 事务；删除 task 时 FK cascade。
- `register_pr_tracking` 输入带 binding 时写 binding；无 binding 时不写；
  同 task/same binding 幂等；same task/different binding 返回 `conflict`。
- merge/revert evidence 只按 live `pr_tracking` task id 读 binding；
  missing → `managed_unattributed`（无 raw IDs）；命中 →
  `managed_attributed`（workId/attemptId）。证据写内部 audit，不写公共
  Task/Run/Queue 列，不建 `task_outcome_episodes`（W6 拥有）。
- retry = sticky（DP-A2-2-1=A）：`preflightRunBinding` 读取 task/admission/
  attempt；attempt 已绑不同 profile → 返回 typed conflict；dispatcher 消费
  target（不 livelock）+ 写 `work_binding_conflict` audit + operator blocker。
  review/verify/participant run 不绑定 attempt 1；fallback 只对非 managed。

### 2.2 落点

| 单元 | 落点 | 可见结果 | 验证 |
|---|---|---|---|
| A1 task binding | `src/managed-work/service.ts` + `TaskStore.findBySubjectKey` | `registerPrTracking` 同事务；same/missing/different 三态 | store/service tests |
| A2 lifecycle evidence | `ManagedWorkService.attributeTask` / `recordLifecycleEvidence` | pr_tracking 命中/缺失两种结果；audit 仅内部 | unit |
| A3 retry preflight | `WorkAdmissionStore.preflightRunBinding` + `DispatchService` | same profile run；different profile target 被消费 + blocker | dispatch tests |
| A4 sticky failure policy | 复用 W5b `WorkerFailurePolicy.queueRetry`（同 recipient） | managed retry 不换 profile；非 managed 不受影响 | regression |

## 3. W5d-B deployment wait

### 3.1 冻结契约

- 等待状态只存原 Task `deployment_wait_json`；不建 `deployment_waits`。
- 类型：`revision_included{revision,services}` /
  `new_ready_boot{services}`；`autoRenew:false`、TTL=0；baseline 用
  `bootSequence/bootId`，不用 wall clock 判新启动。
- observation 只读 daemon state/boot ledger；unknown 保持 waiting，不误唤醒。
- 命中写 outcome（pending），投递经 `messages` + `queue_entries`；同一
  outcomeId/owner fence 幂等；投递失败保留 pending。
- `sweep(now)` 是唯一恢复入口，由 daemon/CLI 调用；没有每猫 timer。
- start guard 在 run cutover 前复核 waiting/outcome/observation；stale 拒绝。

### 3.2 落点

| 单元 | 落点 | 可见结果 | 验证 |
|---|---|---|---|
| B1 types/observation | `src/deployment-wait/{types,observation}.ts` | state/boot ledger → observation；unknown fail closed | unit |
| B2 register/state | `src/deployment-wait/service.ts` + `TaskStore.setDeploymentWait` | 原 Task await/json；replay idempotent | store/service tests |
| B3 predicate/sweep | 同上 | revision/new boot 命中；unknown 保持 waiting | unit |
| B4 delivery | 同上 | message + queue entry 幂等；不直接起 run | integration |
| B5 start guard | `DeploymentWaitStartGuard` + dispatch option | waiting 拒绝 cutover、release + skip 该 entry 后继续 drain；delivered 放行 | dispatch tests |
| B6 exit path | `DeploymentWaitService.cancel` + CLI | operator cancel → terminal + audit；cancel 后可 `generation+1` 重注册；已投递拒绝重注册 | service/CLI tests |

## 4. W5d-C daemon lifecycle

### 4.1 冻结契约

- `StopOperationRecord` 文件 owner（`CODETEAM_DATA_DIR/lifecycle/`），
  六态 `requested → stopping → stopped → restart_authorized → restarted →
  reverified`，+`failed`/`stale_cleared`；一个 opId 贯穿；failed 需新 op。
- stop/restart 只接受 operator.key 签名；记录 typed principal + key
  fingerprint + signature over `{opId,deploymentId,stoppedBootId,action}`；
  free-text authorizedBy 不具授权力。
- 独占 claim 用 generation + `wx`；executor 必须在 target process set 之外；
  信号前 recheck frozen identity；超时/不可读不伪造 stopped。
- health 复验用 loopback `/health` body + bootId/pid/installationId；
  前后两次观察；不可读 = failed/unknown。
- boot ledger 增 `deploymentId`/exit evidence；不建第二 process registry。
- deployment wait 的 observation 复用同一 boot history；不互相复制状态。

### 4.2 落点

| 单元 | 落点 | 可见结果 | 验证 |
|---|---|---|---|
| C1 record/claim | `src/lifecycle/{types,store,claim}.ts` | 六态/顺序拒绝/failed/stale；0600/0700 | fs tests |
| C2 process identity | `src/lifecycle/process.ts` | pid+startedAt+command；executor 在树内拒绝 | unit |
| C3 authorization | `src/lifecycle/service.ts` + operator auth | 缺/伪造签名 fail closed；typed principal | unit |
| C4 stop/restart/reverify | 同上 + health probe | stop→stopped；restart→restarted→reverified | integration |
| C5 boot evidence | `boot-ledger.ts`/`daemon.ts`/`state.ts` | deploymentId/exit clean/startup_failed | daemon tests |
| C5b descendant re-derive | `lifecycle/service.ts` | execute 时从复验 pid 重算 descendants；不 signal 已回收/复用 pid；`stoppedProcessSet` | lifecycle tests |
| C6 CLI | `src/cli/daemon.ts` | operator status/stop/restart；no agent/MCP surface | CLI tests |

## 5. AC 映射（`0004` §W5 未勾 W5d 项）

| # | Acceptance | 落点 | 验证 |
|---|---|---|---|
| 1 | daemon lifecycle 只由 runtime-deployment owner 写；无第二 supervisor；未授权/未知身份 fail closed | C1–C5 | fs/auth/process tests |
| 2 | deployment wait 复用原 Task F280；autoRenew false/TTL 0；错误 deployment/alpha/端口不匹配拒绝 | B1–B4 | unit/integration |
| 3 | deployment wait 投递幂等、start guard 复核 | B4–B5 | dispatch tests |
| 4 | pr_tracking binding 与 task 同事务；无孤儿；merge/revert missing → managed_unattributed | A1–A2 | store/service tests |
| 5 | raw workId/attemptId 不出现在 Task/Run/Queue/PR 公共投影 | A1–A3 | contract tests |
| 6 | participant review/verify 不绑 attempt 1；unmanaged_not_applicable reason | A3 | controlled-gate tests |
| 7 | managed retry sticky；不同 profile 409/target+blocker；fallback 只非 managed/Phase C | A3–A4 | dispatch tests |

## 6. 测试清单

- `control-managed-work.test.ts`：register 三态、binding 同事务、cascade、attribution、audit raw ID 内部。
- `control-managed-retry.test.ts`：same profile、different profile 消费 target + blocker、review/verify 不绑、非 managed fallback。
- `control-deployment-wait.test.ts`：register replay、revision/new boot、unknown retain、outcome 幂等、wrong deployment/port、start guard。
- 同上（cancel）：operator cancel 放行 start、幂等、非 operator 拒绝、cancel 后 generation+1、已投递拒绝重注册。
- `control-daemon-lifecycle.test.ts`：六态顺序、failed/stale、签名、executor independence、frozen identity、health 复验、boot exit。
- 同上（descendants）：execute 时重算 descendants，已回收/复用 pid 不被 signal，新 child 被纳入。
- `control-dispatch-budget.test.ts`：队头 `budget_paused`/`deployment_wait_pending` 不阻塞后续 entry（`claimNext.excludeIds` skip-set）。
- CLI tests：daemon status/stop/restart（fake process/health）、deployment wait register/status/sweep。

## 7. 依赖与顺序

1. A1/A2 先落；复用 W1 admission/attempt/binding，不新增 identity 表。
2. A3 依赖 DispatchService preflight；不改 W5a 路由语义。
3. B1/B2 依赖 daemon state/boot ledger 可选字段；B4 复用 queue_entries。
4. C 在 B 的 observation 接口上实现；C5 的 boot fields 先于 B1。
5. 每个切片独立测试；最后统一 docs/close，不得用 F010 evidence 冒充 W5d。

## 8. 风险与回滚

| 风险 | 级别 | 处置 |
|---|---|---|
| 第二 identity/store/supervisor | P1 | 只加 private binding、task JSON、文件 lifecycle；无第二 registry |
| 不同 profile retry livelock | P1 | preflight + 消费 target + operator blocker；不留在 queue |
| deployment wait 误唤醒/重复投递 | P1 | bootSequence baseline、outcomeId/owner fence、queue idempotency |
| 未授权 stop/restart | P1 | operator.key 签名、claim、frozen identity、executor outside |
| health 不可读伪造成功 | P1 | fail closed；前后观察；unknown 不等于 ready |
| raw ID 泄漏 | P1 | private tables + projection denylist + audit-only internal refs |
| W5d 冒充完成 | P2 | 每切片独立 evidence；F011 close 前逐条 AC |

回滚：A/B 为新增 service/JSON 字段/可选 dispatch hook；C 为新增文件 owner
与 CLI。回滚到 `7adc30ee4` 即可；已写 audit/stop record 保留，不删除证据。

## 9. Review 重点

- 砚砚：operator 授权、executor independence、binding private/raw ID、
  deployment wait fail-closed、sticky conflict 不 livelock。
- 烁烁：StopOperationRecord/boot ledger、deployment observation、recovery、
  daemon crash/lease 交互。
- 墨墨：operator CLI 可解释性、ready≠task done、W5c/W5d 边界、AC 不 overclaim。

## 10. Current progress（2026-10-28）

- W5d-A/B/C 已实现并 closed：managed work register/attribution/
  lifecycle evidence + sticky preflight；deployment wait observation/
  predicate/sweep/start guard + operator `cancel` 退出路径；daemon
  lifecycle 文件记录、operator 签名、claim、frozen identity、executor
  containment、health 复验、boot exit、execute 时 descendant 重推导。
- CLI：`deployment wait register/status/sweep/cancel`、`daemon status`、
  `daemon stop`（`halt` 是签名 action）。relaunch 的新 daemon 启动仍归
  external executor。
- 验证：`build:offline` exit 0；daemon 包 52 files passed + 2 skipped，
  378 tests passed + 2 skipped；root `tsc` / `biome` 通过。
- 未完成：W7 HTTP/Console、W8 revert connector、W6 episode store；
  `revision_included` v1 用精确 runningRevision；restart CLI 的 external
  start 未接 supervisor。不得用本 slice tests 冒充这些边界。
- Review：砚砚 code/security approved @ `dfb872d9c`（2×P2 + 3×P3 闭合）；
  墨墨 SOP/process/Product approved @ `dfb872d9c`（无 P1/P2）。4 条
  close-out 文档项已在 docs close-out PR 处理，不触发第三轮 code review。
- 烁烁 lane 处置：本 thread 中烁烁为 `routableNotJoined`，W5/session
  interface focus 由砚砚 code/security review 合票覆盖；独立复核如需要
  由 operator 另派，不作为本 slice 的未完成项。

## 11. Close record

- PR #56 squash merged at `168e67dd0`（reviewed HEAD `dfb872d9c`，
  base `7adc30ee4`）；CI 4/4。
- Post-merge acceptance：`build:offline` 后 daemon 包 52 files passed
  + 2 skipped，378 tests passed + 2 skipped。

