---
title: "runtime-deployment 架构复用检视"
doc_kind: architecture-review
status: approved
created: 2026-10-24
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
source_cell: runtime-deployment
source_card: ../../reuse/runtime-deployment.md
template: ../0004-reuse-architecture-review-plan.md
---

# runtime-deployment 架构复用检视

## 1. 总结

### 1.1 clowder feature 范围

- cell：`runtime-deployment`
- canonical：F300 / F323
- **P0 范围**：deployment identity、frozen build target、daemon ownership、StopOperationRecord 停启生命周期、per-boot readiness/exit 事实、deployment wait 的 observation 与 predicate 消费边界。
- **不在本卡展开**：F323 Phase B 维护准入冻结（撤回，未获准恢复）、Phase C 页面三态控制面、F300 的完整 Home-State 投影、Alpha/named-preview 坐标、F290 隔离实例生命周期。它们只作为边界引用。

### 1.2 codeteam 复用总结

| 组件 | 立场 | 一句话 |
|---|---|---|
| deployment identity（installation/deployment subject） | `reuse now` | `deployment:<installationId>:<deploymentId>` 与 installation hash 语义复用；路径/ID 来源改为 codeteam config |
| build revision / inclusion proof | `adapt now` | 复用“启动时捕获 build stamp、绝不拿磁盘 HEAD 冒充”的不变量；stamp 从 api/web 改为 codeteam 声明的 shipped services |
| `RuntimeDeploymentLedger` boot history | `adapt now` | 文件型 ledger、单写者、atomic rename、64 代历史复用；服务枚举与 `readyAt` 聚合改为 codeteam 的 declared services |
| `RuntimeDeploymentObservationProvider` | `adapt now` | 只观察当前 boot；readiness 必须先持久化再对外返回；inclusion proof 缺失保持 unknown |
| daemon state / process identity | `adapt now` | 复用 pid+startedAt+command 的 incarnation 身份与 namespace 隔离；路径移到 `CODETEAM_DATA_DIR` |
| `StopOperationRecord` 状态机 | `reuse now` | `requested → stopping → stopped → restart_authorized → restarted → reverified` 与 failed 终态复用；记录仍落文件，不进 SQLite |
| 独占 claim / frozen identity / executor independence | `reuse now` | 世代链 claim、信号前 recheck、执行者不得在目标进程树内，三条都是 load-bearing 不变量 |
| health re-verification | `adapt now` | 复用“端口归属 + health body + 前后各查一次”的证明；W0 用 loopback TCP，平台探测适配 |
| operator authorization | `adapt now` | 不复用 clowder 的自由文本 `authorizedBy` 当授权；接 DP-A2-1 本地 operator credential，stop/restart 都只接受 operator principal |
| deployment wait 类型与判定 | `reuse now` | F280 `UnifiedAwaitStateV1` 第四类实例、`autoRenew:false`、TTL=0、两种 predicate、bootSequence 基线复用 |
| deployment wait 存储/投递 | `adapt now` | 原 Task `deployment_wait_json` + `queue_entries` + 同一 outcome 幂等身份；不建第二等待表 |
| F323 Phase B 维护准入 / 页面三态控制面 | `out-of-scope`（W7 之后另议） | W0/W5 不建常驻 supervisor、不建第二恢复清单；CLI + 操作记录就是最小离线执行面 |
| Alpha / named-preview 坐标、F290 隔离实例 | `out-of-scope` | codeteam v1 只管理自己的本地 daemon deployment，不做多 Alpha 协调 |

### 1.3 关键决定

| # | 决定 |
|---|---|
| RD1 | **deployment 事实只有一个 owner**：boot history/readiness/exit 归 deployment ledger；停启操作归 StopOperationRecord；两者用 installation/deployment/opId 关联，不互相复制状态。 |
| RD2 | **running revision 只认启动时捕获的 build stamp**；checkout HEAD、远端 main、CI 产物名都不能冒充已加载版本。 |
| RD3 | **deployment subject = `deployment:<installationId>:<deploymentId>`**；`installationId = sha256(realpath(installationRoot))`，`deploymentId` 默认 `local`，但同一 installation 只能有一个 serving daemon。`deploymentId` 统一用 `^[a-z][a-z0-9._-]{0,63}$`，避免两套校验分叉。 |
| RD4 | **生命周期操作由 target process set 之外的 external executor 执行**：W0/W5 用 `codeteam` CLI；W7 可用独立 supervisor/controller（launchd/systemd/专用本地服务），Web Console 只发 intent/approval，不自己执行。executor 用 DP-A2-1 的 `operator.key` 验真，记录 operator principal 与对 `{opId,deploymentId,stoppedBootId}` 的签名；签名可由后续读者用 auth.sqlite 公钥复核。 |
| RD5 | **stop operation 记录必须落文件**，不能落 SQLite：记录写入者要能在目标 daemon/API 已下线时继续工作；health probe 是注入的观察，不是记录写入者。 |
| RD6 | **W0 只做 daemon identity + readiness + 最小安全生命周期记录**（`requested→stopping→stopped/failed`）；完整 boot history、生命周期授权/复验、deployment wait 消费归 W5。W7 产品面是 Web Console + API；浏览器发起停启属于 W7+ 的独立控制面任务，必须由 external supervisor 执行，不能由目标 backend self-restart。 |
| RD7 | **deployment wait 不新建表**：沿用 `tasks.deployment_wait_json`；实际投递经 `queue_entries`，response/terminal 在 `runs`/`run_events`。 |
| RD8 | **ready runtime 不等于 Task 完成**；deployment 观察只能驱动等待 predicate，业务收口仍归原 Task。 |
| RD9 | **单写者 fence 先于 boot 记录**：`codeteam daemon start` 必须先取得 daemon state 的独占启动权，再 `beginBoot`；ledger 的进程内串行不替代跨进程互斥。 |
| RD10 | **W0 健康探测走 loopback TCP**（127.0.0.1，非外部监听），以复用已验证的 listener ownership + health body 证明；Unix socket / Windows 适配后置。 |

## 2. clowder 架构

### 2.1 架构图

```text
  launcher (runtime-worktree / start-dev)
        │  runtimeRoot + CAT_CAFE_DEPLOYMENT_ID
        ▼
  beginOwnedRuntimeDeployment
        ├─ realpath(runtimeRoot) === realpath(entrypointRoot) ? else null
        ├─ installationId = sha256(runtimeRoot)
        ├─ runningRevision = api stamp == web stamp ? full sha : null
        └─ RuntimeDeploymentLedger(dataRoot/runtime-deployment/<installationId>.json)
              └─ beginBoot → bootId / bootSequence

  serving process ── markReady(api/web) ──► boot record (startedAt/readyAt/serviceReadyAt)
        │
        ├─ ObservationProvider.observe
        │     ├─ current boot identity / not exited
        │     ├─ currentReadyServices() → markReady first
        │     └─ inclusionProof(targetRevision, runningRevision)
        │
        └─ clean exit / startup failure → exit evidence

  daemon state (file)                 stop operation (file)
  daemon.json                         stop-operation.json
  ├─ pid + process identity           ├─ opId (stop→restart→reverify)
  ├─ installation root                ├─ targetProcessSet
  ├─ ports                            ├─ frozenIdentity
  └─ launch token                     ├─ restart authorization
                                       └─ reverification evidence

  Task.deployment_wait_json ── F280 await (autoRenew:false) ──► DeploymentWaitLifecycleService
        │                                                        ├─ evaluateDeploymentWait
        │                                                        ├─ outcome pending/delivered
        └─ original owner thread ◄── dispatch/message identity ◄─┘
```

### 2.2 数据流

1. **启动**：launcher 设置 `runtimeRoot`/`deploymentId`；bootstrap 校验 root==entrypoint，派生 installationId，读 build stamps，创建/打开 ledger 并写入新 boot（`bootSequence = 上一代 + 1`）。
2. **就绪**：服务实际可用后调用 `markReady`；每个 service 记首次 ready 时间；API+Web 都 ready 才写 composite `readyAt`。观察路径会在返回前把新 ready 服务持久化，避免“先答应、后丢失”。
3. **观察**：`observe(deploymentId,targetRevision)` 只认当前 bootId 且未 exit 的记录；读取当前 ready services；按 `targetRevision` 生成 git ancestry inclusion proof；缺任一证据返回 `null`/unknown，不猜。
4. **退出**：正常收尾完成后写 `clean` exit；ready 前的失败写 `startup_failed`；SIGKILL/崩溃/旧记录缺失没有 exit 记录，读侧保持 unknown，不补写成 crash 或 clean。
5. **停启**：`requestStop` 冻结 launcher + 全部后代 pid 与 incarnation，写 `requested`；`executeStop` 独占 claim、校验身份、发 SIGTERM、等整个集合消失；`authorizeRestart` 记录授权；`recordRestart` 核验新 daemon 是同一 deployment 的新 incarnation；`reverifyStop` 用端口归属 + health body 在前后两次归属检查之间确认恢复。
6. **等待投递**：deployment wait 登记在原 Task；`DeploymentWaitLifecycleService` 在登记时、启动恢复后和等待恢复路径核条件，命中后写 `waitOutcome`（pending），由既有 Queue/Message 身份投递；run 启动边界用 `DeploymentWaitStartGuard` 重新核 Task、outcome、owner fence 和当前 observation，证据 stale 则拒绝启动。
7. **读取**：deployment wait projection 只读 Task + ledger observation，不维护第二份 live 等待表；W7 可从文件/API 读 boot/stop 记录，但不能写。

### 2.3 状态机 / 生命周期

| 对象 | 状态 | 约束 |
|---|---|---|
| `RuntimeDeploymentBootRecord` | `started → ready(per service) → exited(clean)`；`started → exited(startup_failed)` | bootId/bootSequence 由 ledger 分配；exit 只写一次；ready 后不能写 startup_failed；无 exit = unknown |
| `StopOperationRecord` | `requested → stopping → stopped → restart_authorized → restarted → reverified`；任意前置态 → `failed`；stale state → `stale_cleared` | 一个 opId 贯穿 stop/restart/reverify；failed 终态需新 op；顺序外操作拒绝；超时/不可读不伪造成功 |
| `StopOperationClaim` | `absent → generation N held → released` | 只用 `wx` 创建下一代；持有者进程不可证明已死时不得接管；不删除他人 claim |
| `DeploymentAwaitStateV1` | `waiting_for_update → matched(outcome pending) → delivered/suppressed` | `autoRenew:false`，TTL=0；同一 generation CAS；unknown 保持等待，不误唤醒 |
| `Task.deployment_wait_json` | `await → waitOutcome → 保留 receipt` | active await 与 outcome 不同时存在；取消/owner 变更/任务终态写 terminal outcome |

### 2.4 关键数据结构

| 结构 | 关键字段 | 作用 |
|---|---|---|
| `RuntimeDeploymentBootRecord` | `bootId/bootSequence/deploymentId/runningRevision/startedAt/readyAt/readyServices/serviceReadyAt/exit` | 每次启动的身份、版本、就绪与退出证据 |
| `RuntimeDeploymentLedgerState` | `v/installationId/deployments: Record<deploymentId, BootRecord[]>` | 单 installation 的 boot 历史；默认保留 64 代 |
| `DeploymentSubjectRef` | `deployment:<installationId>:<deploymentId>` | 等待与观察的精确 subject |
| `DeploymentObservationV1` | `subjectRef/bootId/bootSequence/runningRevision/readyServices/observedAt/inclusionProof?` | 一次可审计的部署观察 |
| `DeploymentWaitPredicate` | `revision_included{revision,services}` / `new_ready_boot{services}` | 两种有界条件，不做通用 DSL |
| `DeploymentAwaitStateV1` | `v/generation/subjectRef/ownerFence/baseline{bootSequence,bootId,capturedAt}/continuation.when/then/autoRenew` | F280 第四类 await；绑定原 Task owner |
| `DeploymentWaitOutcomeV1` | `outcomeId/generation/subjectRef/ownerFence/reason/at/delivery/deploymentMatch/registeredAt` | 一次性结果与投递 outbox |
| `DaemonState` | `version/deploymentId/projectRoot/pid/process{startedAt,command,launchToken}/ports/logFile/launchedAt` | daemon incarnation 与守护记录 |
| `StopOperationRecord` | `v/opId/deploymentId/projectRoot/state/requestedBy/targetProcessSet/frozenIdentity/restart/reverification/history/failure` | 停启操作的唯一持久真相 |

### 2.5 Current truth 与代码路径

| 事实 | 状态 | 代码路径 |
|---|---|---|
| build revision 解析 | landed | `/home/ming/agent/clowder-ai/packages/api/src/config/runtime-deployment-revision.ts` |
| git ancestry inclusion proof | landed | `/home/ming/agent/clowder-ai/packages/api/src/config/runtime-deployment-inclusion.ts` |
| boot bootstrap / installation hash | landed | `/home/ming/agent/clowder-ai/packages/api/src/domains/runtime-deployment/RuntimeDeploymentBootstrap.ts` |
| boot history / readiness / exit | landed | `/home/ming/agent/clowder-ai/packages/api/src/domains/runtime-deployment/RuntimeDeploymentLedger.ts` |
| current boot observation | landed | `/home/ming/agent/clowder-ai/packages/api/src/domains/runtime-deployment/RuntimeDeploymentObservationProvider.ts` |
| readiness route | landed | `/home/ming/agent/clowder-ai/packages/api/src/routes/runtime-deployment-routes.ts` |
| deployment wait 类型/判定 | landed | `/home/ming/agent/clowder-ai/packages/shared/src/types/deployment-wait.ts`、`/home/ming/agent/clowder-ai/packages/shared/src/types/wait-contract.ts` |
| deployment wait 生命周期/恢复 | landed | `/home/ming/agent/clowder-ai/packages/api/src/domains/runtime-deployment/DeploymentWaitLifecycleService.ts`、`/home/ming/agent/clowder-ai/packages/api/src/domains/runtime-deployment/DeploymentWaitRecoverySweep.ts`、`/home/ming/agent/clowder-ai/packages/api/src/domains/runtime-deployment/DeploymentWaitPublisher.ts` |
| deployment wait start guard | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/domains/runtime-deployment/DeploymentWaitStartGuard.ts` |
| deployment wait callback route | landed | `/home/ming/agent/clowder-ai/packages/api/src/routes/callback-deployment-wait-routes.ts` |
| daemon state / namespace / stop primitive | landed | `/home/ming/agent/clowder-ai/scripts/lib/daemon-state.mjs`、`/home/ming/agent/clowder-ai/scripts/daemon-state.mjs` |
| stop operation lifecycle | landed | `/home/ming/agent/clowder-ai/scripts/lib/daemon-stop-operation.mjs` |
| stop record / pure checks | landed | `/home/ming/agent/clowder-ai/scripts/lib/daemon-stop-record.mjs` |
| stop claim generations | landed | `/home/ming/agent/clowder-ai/scripts/lib/daemon-stop-claim.mjs` |
| health re-verification | landed | `/home/ming/agent/clowder-ai/scripts/lib/daemon-health-probe.mjs` |
| process identity / process tree | landed | `/home/ming/agent/clowder-ai/scripts/lib/process-identity.mjs`、`/home/ming/agent/clowder-ai/scripts/lib/process-tree.mjs` |
| launcher / start-stop wiring | landed | `/home/ming/agent/clowder-ai/scripts/runtime-worktree.sh`、`/home/ming/agent/clowder-ai/scripts/start-dev.sh` |
| cell / feature truth | landed | `/home/ming/agent/clowder-ai/docs/architecture/ownership/cells/runtime-deployment.md`、`/home/ming/agent/clowder-ai/docs/features/F300-self-sensing-home-state-awareness.md`、`/home/ming/agent/clowder-ai/docs/features/F323-runtime-restart-coordination.md` |

**已知边界（必须带进 codeteam）**：

- clowder 现行 restart 的 `authorizedBy` 只是记录输入，不是认证 principal；cell doc 明写 canonical restart 尚未把 authorize→restarted→reverified 绑到可信 actor。codeteam 不复制这个缺口。
- F323 Phase B 已撤回，Phase C 三态页面/离线控制面未实现；codeteam 不把“未来会有”当现成契约。
- `RuntimeDeploymentLedger` 只在单进程内串行；跨进程单写者依赖 serving daemon 唯一性，ledger 本身不提供锁。
- inclusion proof 只有 `git_ancestry` 实现；`build_manifest` 是类型占位，Git-less 安装必须返回 unknown，不能猜版本。

| 上游已知缺口 | 本卡处置 |
|---|---|
| `authorizedBy` 自由文本不是认证 principal | RD4：operator.key 签名 + auth.sqlite 公钥离线复核；缺/伪造 fail closed |
| ledger 只做进程内串行 | RD9：daemon state 独占启动权先于 `beginBoot`；单 serving daemon |
| `build_manifest` 只有类型占位 | 只认真实 manifest；没有则 unknown，不猜 ancestry |
| F323 Phase B 撤回、Phase C 未实现 | W0/W5 不做维护准入/三态页面；W7 最多只读投影 |
| canonical lifecycle 未绑定授权→执行→复验 | W5 完整链补 operator 签名、frozen identity、health 复验；W0 只做最小 lifecycle |

## 3. codeteam 架构

### 3.1 架构图

```text
  codeteam CLI (operator shell)
        │  operator.key 验真
        ├─ daemon start/stop/restart/status
        └─ deployment wait 登记（agent/CLI，走 run token / operator 各自授权域）
                 │
                 ▼
  codeteam daemon (single serving process per installation)
        ├─ DaemonState file (incarnation: pid/startedAt/command/launchToken/ports)
        ├─ RuntimeDeploymentLedger (boot history, readiness, exit)
        ├─ DeploymentObservationProvider (current boot + inclusion proof)
        ├─ Task deployment_wait_json (F280 await)
        └─ local API (loopback TCP, health + status)

  codeteam stop/restart CLI (outside daemon process tree)
        ├─ StopOperationRecord file (requested→stopping→stopped→restart_authorized→restarted→reverified)
        ├─ generation claim (exclusive file create)
        ├─ process identity / process tree checks
        └─ health probe (listener ownership + /health body)

  W7 projection (later, read-only)
        └─ reads daemon state / boot history / stop record / wait projection
           never writes lifecycle state
```

> 读法：图中的 `codeteam CLI` 是 **W0/W5 的 external lifecycle executor**，不是 codeteam 的产品形态。codeteam 的产品面是 **W7 Web Console + API/backend**；Web 只提交 lifecycle intent/approval，由独立 executor 执行。W7 当前范围是只读投影；浏览器发起生命周期操作是 W7+ 的独立控制面任务，需要独立 supervisor/controller，不能由目标 backend 自己执行。

### 3.2 数据流

1. **daemon start**：CLI 校验 installationRoot 与 dataRoot，取得 daemon state 的独占启动权（已有 running 则拒绝；stale 清理是 operator CLI 动作，必须验 operator.key，且只有身份可证时才清理；不可证则拒绝并提示人工处置），再调用 `beginBoot`；daemon 从同一 installationRoot 启动，`installationId` 与 boot 记录不漂移。
2. **readiness**：daemon 只在自身 health/loopback API 真实可用后 `markReady`；`readyAt` 由声明的 service 集（W0=`daemon`，W7 可加 `web`）共同决定，不照抄“api+web 固定两件套”。
3. **build identity**：build 时为每个 shipped service 写 `.build-commit`；启动解析器要求所有声明 service 的 stamp 存在且相同，否则 `runningRevision=null`。CLI/daemon 混装、部分构建、缺失 stamp 都显示 unknown。
4. **observation**：等待检查与 W7 状态读取都走同一个 observation provider；先持久化新 ready，再返回 observation；inclusion proof 只对 git checkout 生成，Git-less 安装返回 null。
5. **stop**：operator CLI 验 `operator.key` → `requestStop` 冻结 target set/incarnation → `executeStop` 独占 claim、身份 recheck、SIGTERM、等全集合消失 → `stopped` 或 `failed`。执行者若在 daemon 子树内，直接拒绝。
6. **restart**：只有 `stopped` 后 operator 可 `authorizeRestart`；授权记录是 operator principal ref + key fingerprint，不是自由文本；`recordRestart` 只认同一 deployment 的新 incarnation；`reverifyStop` 用 loopback health + listener ownership 证明恢复，证据不可读则 failed/unknown。
7. **deployment wait**：代理/操作者在原 Task 登记 `revision_included` 或 `new_ready_boot`（agent 侧具名 callback route = `deployment-wait/register`，必须进 A1-2 per-run allowlist）；登记时立即核一次，daemon 启动恢复后核一次，之后由 W5 的单个 compensation sweep/等待恢复路径核（不是每只猫起 timer）；命中写 outcome，经 `queue_entries` 投递回原 thread；run 启动前 guard 再核一次，stale 拒绝启动并按权限重投。
8. **W7 读取**：Console 只读 daemon state/boot history/stop record/wait projection；目标 daemon 下线时仍可从文件展示“最后已知 + unknown”，但不提供三态写入。

### 3.3 状态机 / 生命周期

| 对象 | 状态 | 约束 |
|---|---|---|
| `CodeteamBootRecord` | `started → ready(daemon[,web]) → exited(clean/startup_failed)` | 单写者；exit 只写一次；无 exit = unknown；启动失败不得在 ready 后补写 |
| `DaemonIncarnation` | `starting → running → stopped/unknown` | 由 daemon state + process identity 证明；PID 复用必须被 startedAt/command 拒绝 |
| `StopOperationRecord` | 同 clowder 六态 + `failed`/`stale_cleared` | 一个 opId；failed 需新 op；超时不自动强杀；顺序外拒绝 |
| `StopClaim` | `absent → held(generation) → released` | 只有已证明死亡的 holder 可被下一代接管；不可读 = 不接管 |
| `DeploymentWait` | `waiting → matched(pending) → delivered/suppressed` | autoRenew=false、TTL=0；unknown retain；取消/owner 变化/任务终态 terminalize |
| `DeploymentWaitDelivery` | `pending → delivered` / `suppressed` / `not_applicable` | 同一 outcomeId + owner fence 幂等；投递失败保留 pending，不换身份 |

### 3.4 关键数据结构（与 clowder 对比）

| 结构 | codeteam 字段 | 与 clowder 差异 | 决定 |
|---|---|---|---|
| `DaemonState` | `version/deploymentId/installationRoot/pid/process{startedAt,command,launchToken}/ports{daemon}/logFile/launchedAt` | `projectRoot`→`installationRoot`；`ports.api`→`ports.daemon` | `rename` |
| `RuntimeDeploymentBootRecord` | 沿用 `bootId/bootSequence/deploymentId/runningRevision/startedAt/readyAt/readyServices/serviceReadyAt/exit` | `readyServices` 枚举从 `api|web` 改为 `daemon|web`；`readyAt` 按 declared services 聚合 | `adapt now` |
| `RuntimeDeploymentLedgerState` | `v/installationId/deployments` | 文件位置改到 `CODETEAM_DATA_DIR/runtime-deployment/` | `adapt now` |
| `DeploymentSubjectRef` | `deployment:<installationId>:<deploymentId>` | 无形状变化；installationId 来源改为 codeteam installationRoot | `reuse now` |
| `DeploymentObservationV1` | 全字段沿用 | `readyServices` 枚举适配；inclusionProof 仍 optional | `reuse now` + enum adapt |
| `DeploymentWaitPredicate` | `revision_included` / `new_ready_boot` | 无变化 | `reuse now` |
| `DeploymentAwaitStateV1` | 全字段沿用，`autoRenew:false` | 无变化 | `reuse now` |
| `DeploymentWaitOutcomeV1` | 全字段沿用 | 无变化 | `reuse now` |
| `DeploymentWaitStateV1` | `await/waitOutcome/currentExecutionClaim/currentExecutionReceipt/recoverySource/transportAttempt` | 无变化 | `reuse now` |
| `StopOperationRecord` | clowder 字段 + `operatorKeyId` + `authorizationSignature`；`authorizedBy`→typed principal ref | `projectRoot`→`installationRoot`；授权从自由文本改为可复核签名 | `extend now` |
| `StopOperationClaim` | `generation/holder{pid,at,token}` | 文件路径改到 codeteam data dir | `reuse now` |
| `DeploymentWaitItemProjection` | 全字段沿用 | 只读投影；W7 消费 | `reuse now` / `defer→W7` |
| `DeploymentInclusionProofV1` | `git_ancestry`；`build_manifest` 保留类型 | Git-less 安装只在有真实 build manifest 时启用，否则 unknown | `adapt now` |

#### §12.2 回写清单

**本卡不新增/修改 SQLite 表列。** 依据：

- boot history、daemon state、stop operation 都是 daemon 生灭周期内必须可读的 file-owned facts，放 SQLite 会在目标服务下线时失去可用性；它们归 `CODETEAM_DATA_DIR` 下的文件 owner。
- deployment wait 已在 `0001 §12.2` 的 `tasks.deployment_wait_json` 中预留，沿用 F280 类型；不建 `deployment_waits` 表。
- 实际投递使用既有 `queue_entries` / `messages` / `runs`，不新增 terminal 表。

若 W5 实现时发现必须新增列（例如 `tasks.deployment_wait_json` 的实际列名/编码需要调整），按模板规则 5 另附 diff，不在本卡默默改。

### 3.5 变量定义表

#### Contract

| 变量 | 类型 | 默认/当前 | owner | clowder 来源 | codeteam 决定 | 备注 |
|---|---|---|---|---|---|---|
| `DeploymentSubjectRef` | template literal | `deployment:<installationId>:<deploymentId>` | runtime-deployment | `deployment-wait.ts` | `reuse` | installation 唯一定位 |
| `DeploymentService` | enum | `daemon`（W0）；`web`（W7） | runtime-deployment | `api|web` | `rename` | `api`→`daemon`；未声明服务不得写 ready |
| `DeploymentWaitPredicate` | union | `revision_included` / `new_ready_boot` | ball-custody/runtime-deployment | `deployment-wait.ts` | `reuse` | 只收两种有界条件；`revision_included.revision` 必须是 **daemon build 来源仓（产品仓）** 的 sha；dogfood 目标仓 sha 不是合法输入，登记时拒绝 |
| `DeploymentObservationV1` | object | current boot observation | runtime-deployment | `deployment-wait.ts` | `reuse` + enum adapt | 缺 proof → unknown |
| `DeploymentInclusionProofV1` | union | `git_ancestry`（W0）；`build_manifest`（仅真实 manifest） | runtime-deployment | `deployment-wait.ts` | `adapt` | 不允许伪造 ancestry |
| `RuntimeDeploymentBootRecord` | object | v1 schema | runtime-deployment | `RuntimeDeploymentLedger.ts` | `reuse` + service enum | history limit 64 |
| `StopOperationRecord` | object | v1 schema | runtime-deployment | `daemon-stop-record.mjs` | `extend` | 加 operator principal；路径 rename |
| `StopOperationState` | enum | 六态 + failed/stale_cleared | runtime-deployment | `daemon-stop-record.mjs` | `reuse` | 顺序外拒绝 |
| `DaemonIncarnation` | object | pid + startedAt + command + launchToken | runtime-deployment | `daemon-state.mjs` | `reuse` | PID 复用必须拒绝 |
| `BuildStamp` | file | `<service>/.build-commit` full sha | build/runtime-deployment | `runtime-deployment-revision.ts` | `adapt` | 所有 declared service 必须一致 |

#### State

| 变量 | 类型 | 默认/当前 | owner | clowder 来源 | codeteam 决定 | 备注 |
|---|---|---|---|---|---|---|
| `bootSequence` | integer | 1..N，单调递增 | runtime-deployment | ledger | `reuse` | 新启动条件只认 sequence，不认 wall clock |
| `bootId` | uuid | 每 boot 新生成 | runtime-deployment | ledger | `reuse` | 同 bootId 不能算新启动 |
| `runningRevision` | full sha \| null | null 表示 unknown | runtime-deployment | revision resolver | `reuse` | 不允许用 checkout HEAD 回填 |
| `readyServices` | array | 空 → 实际 ready | runtime-deployment | ledger | `adapt` | 只允许 declared services |
| `readyAt` | epoch ms \| null | 首个全服务 ready 时刻 | runtime-deployment | ledger | `adapt` | W0 单服务也要能写 |
| `exit.kind` | enum | `clean` / `startup_failed`；缺失=unknown | runtime-deployment | ledger | `reuse` | 不推断 SIGKILL |
| `stopOperation.state` | enum | `requested` | runtime-deployment | stop record | `reuse` | failed 终态需新 op |
| `frozenIdentity` | object | pid/startedAt/command | runtime-deployment | stop record | `reuse` | 信号前 recheck |
| `targetProcessSet` | pid[] | launcher + 全部后代 | runtime-deployment | stop operation | `reuse` | 枚举不完整拒绝 |
| `waitGeneration` | integer | 1..N | ball-custody | Task deployment wait | `reuse` | CAS 唯一依据 |
| `waitOutcome.delivery` | enum | `pending` | ball-custody | wait-contract | `reuse` | 失败保留 pending |
| `waitBaseline.bootSequence` | integer | 登记时当前 boot | ball-custody | deployment-wait | `reuse` | 时钟回拨不造新启动 |

#### Config

| 变量 | 类型 | 默认/当前 | owner | clowder 来源 | codeteam 决定 | 备注 |
|---|---|---|---|---|---|---|
| `CODETEAM_DATA_DIR` | path | 见 A1-1（唯一权威定义） | config | `CAT_CAFE_DATA_DIR` analogue | `new` | 仓外；目录 0700；本卡只引用不重定义 |
| `CODETEAM_INSTALLATION_ROOT` | path | daemon entrypoint realpath | runtime-deployment | `CAT_CAFE_RUNTIME_ROOT` | `rename` | 必须稳定；换路径 = 新 installation |
| `CODETEAM_DEPLOYMENT_ID` | string | `local` | config | `CAT_CAFE_DEPLOYMENT_ID` | `rename` | 统一 regex `^[a-z][a-z0-9._-]{0,63}$`；单 serving daemon；不与 clowder namespace 混用 |
| `CODETEAM_DEPLOYMENT_SERVICES` | enum[] | `[daemon]`（W0）；W7 可加 `web` | config | api+web 固定 | `new` | 决定 readyAt 聚合 |
| `CODETEAM_API_PORT` | integer | 自动/配置的 loopback 端口 | config | `ports.api` | `new` | 只绑 127.0.0.1；不暴露外网 |
| `CODETEAM_BOOT_HISTORY_LIMIT` | integer | 64 | runtime-deployment | ledger historyLimit | `reuse` | 只影响历史长度，不影响 sequence |
| `CODETEAM_STOP_GRACE_MS` | integer | 15000 | runtime-deployment | `stopDaemon` graceMs | `reuse` | 超时不等于已停止 |
| `CODETEAM_HEALTH_TIMEOUT_MS` | integer | 2000 | runtime-deployment | `PROBE_TIMEOUT_MS` | `reuse` | 超时 = failed/unknown，不 pass |
| `CODETEAM_DAEMON_STATE_DIR` | path | `CODETEAM_DATA_DIR/daemons/<deploymentId>-<rootHash>` | runtime-deployment | `~/.cat-cafe/daemons/...` | `rename` | 不能与 clowder 共用 namespace |
| `CODETEAM_DEPLOYMENT_LEDGER` | path | `CODETEAM_DATA_DIR/runtime-deployment/<installationId>.json` | runtime-deployment | ledger file | `reuse` shape | 0600；atomic rename |

#### Security

| 变量 | 类型 | 默认/当前 | owner | clowder 来源 | codeteam 决定 | 备注 |
|---|---|---|---|---|---|---|
| `operatorCredential` | principal | `operator.key` 0600 + auth.sqlite 公钥/哈希 | auth/runtime-deployment | DP-A2-1 | `adapt` | stop/restart 必须验真；缺/伪造 403 |
| `restartAuthorizedBy` | typed ref + signature | operator key fingerprint + actor ref + signature over opId/deploymentId/stoppedBootId | runtime-deployment | free-text `authorizedBy` | `new` | 自由文本不再作为授权证据；签名可离线复核，不只靠调用者自报 |
| `credentialFailureSemantics` | invariant | API=403；CLI=nonzero+audit | auth/runtime-deployment | DP-A2-1 | `new` | API/loopback 面缺/伪造凭据 = 403；CLI 面 = 非零退出 + audit 记录，不混用 HTTP 码 |
| `authRescue` | invariant | auth.sqlite read-only + busy_timeout=0 | auth/runtime-deployment | codeteam new | `new` | 验真只读打开、读失败快速失败；`--degraded-auth` 只允许同 OS uid 的 halt 路径并 audit `degraded_verification`；re-activation authorization 永不接受 degraded |
| `staleStateCleanup` | rule | external executor only | runtime-deployment | daemon state | `new` | stale daemon state 清理由 W0/W5 CLI 或 W7 supervisor 执行，必须验 operator.key；身份不可证的 stale 记录拒绝并提示人工处置 |
| `executorIndependence` | invariant | executor ∉ targetProcessSet 且非后代 | runtime-deployment | `assertExecutorIsOutside` | `reuse` | 不可读 ancestry = 拒绝 |
| `frozenIdentityCheck` | invariant | 信号前 pid/startedAt/command 一致 | runtime-deployment | `identityUnchanged` | `reuse` | 换 incarnation 必须拒绝 |
| `claimExclusivity` | invariant | 世代链 + `wx` 创建 | runtime-deployment | stop claim | `reuse` | 不删除他人 claim |
| `deploymentFileMode` | mode | dir 0700 / file 0600 | runtime-deployment | daemon state/ledger | `reuse` | 不把 secret 写日志 |
| `healthOwnership` | invariant | 每个 listener 都属于目标 incarnation | runtime-deployment | `daemon-health-probe` | `adapt` | 不可读 = unknown；不通过 |
| `readinessWriteScope` | rule | daemon 自身；W7 Web 只读 + lifecycle intent | runtime-deployment | loopback readiness writer | `reuse` | 不允许前端/agent 直接改 ready；W7 Web 只能提交 lifecycle intent/approval |
| `stopToolExposure` | rule | W0/W5 不暴露给 agent/MCP | runtime-deployment | clowder CLI | `new` | external executor only；W0/W5 CLI，W7 supervisor/controller |
| `deploymentDataBoundary` | rule | 数据只写 `CODETEAM_DATA_DIR` | config | 仓外数据边界 | `reuse` | 不写目标仓/安装树 |
| `lifecycleExecutorSurface` | rule | external executor; Web = intent/approval | runtime-deployment | F323 Phase C | `new` | W0/W5 用 CLI；W7 用独立 supervisor/controller；产品 Web/API 永远不 in-process 执行生命周期操作 |
| `loopbackApiAuth` | rule | health 匿名；status 需 operator/session | runtime-deployment | codeteam new | `new` | `/health` 匿名供探测与 wait predicate；status/read 接受 operator credential 或 A1-2 console session token；lifecycle 无 in-process API：W0/W5 CLI，W7 独立 supervisor/controller |
| `launchTokenPurpose` | invariant | launcher↔daemon identity | runtime-deployment | `process.launchToken` | `adapt` | 只证明启动者与 daemon incarnation 的配对，不是 API 认证凭据；不用于请求鉴权 |
| `procfsVisibility` | assumption | hidepid=0 + same operator uid | runtime-deployment | process-tree/lsof | `adapt` | 进程树/lsof 枚举依赖平台可见性；枚举不完整/不可读 = 拒绝，不猜目标集合 |
| `backupScope` | path | `CODETEAM_DATA_DIR` 全目录 | config | §17.4 | `reuse` | auth.sqlite、deployment ledger、daemon state、stop record 同目录；备份/恢复演练按目录级点名 |

#### Observability

| 变量 | 类型 | 默认/当前 | owner | clowder 来源 | codeteam 决定 | 备注 |
|---|---|---|---|---|---|---|
| `bootHistory` | event/log | 每次启动/ready/exit | runtime-deployment | ledger | `reuse` | 包含 bootId/sequence/revision/services |
| `stopHistory` | event/log | 每次状态迁移 + failure | runtime-deployment | stop record history | `reuse` | 含 opId/state/at |
| `healthProbeResult` | evidence | `{ok,ref,reason?}` | runtime-deployment | health probe | `reuse` | 失败原因必须可读 |
| `deploymentRevision` | fact | running build sha | runtime-deployment | F300 self facet | `reuse` | 缺失显示 unknown，不显示 checkout HEAD |
| `inclusionProof` | evidence | git ancestry | runtime-deployment | inclusion resolver | `reuse` | 缺 object/浅克隆 = null |
| `waitProjection` | read model | Task + observation join | ball-custody/runtime-deployment | F323 Phase A | `reuse` | 不维护 live 计数表 |
| `waitDeliveryReceipt` | event | outcomeId/messageId/delivery | dispatch | wait publisher | `reuse` | 投递与消费分开 |
| `audit` | append-only log | operator/executor/opId/target | runtime-deployment | stop audit | `reuse` | 不记录 operator.key 明文 |
| `unknownReasons` | enum | `evidence_unavailable` / `identity_unreadable` / `proof_missing` | runtime-deployment | F300 typed unknown | `adapt` | unknown 不等于失败，也不等于成功；`codeteam daemon status` 原样输出 reason，让 operator 看到“为什么 unknown” |

### 3.6 明确不做

- 不建第二套 process registry；W0/W5 用 CLI，W7 若做浏览器控制再加一个独立 supervisor/controller。它仍是 runtime-deployment 的执行面，不是第二真相。
- 不把 deployment ledger、stop operation、daemon state 放进 SQLite；目标服务下线时这些事实必须仍可读。
- 不把 checkout HEAD、远端 main、CI artifact 名、Alpha ready 当成 serving revision。
- 不接受自由文本 `authorizedBy`、PID、SHA 或调用者自报身份作为重启授权；必须验 operator credential。
- 不在计时到期后自动强杀未收尾进程；等待/取消/显式立即重启是不同动作。
- 不让 restart 直接修改正在服务的安装树；预构建/激活属于单独的 reviewed lifecycle。
- 不把 ready runtime 写成 Task 完成、不直接唤醒猫、不直接关闭业务 Task。
- 不在 W0/W5 做 F323 Phase B 维护准入冻结、三态页面、离线 Web 控制器；W7 最多只读投影。
- 不建第二份 deployment wait 表/计数器；沿用原 Task 的 F280 await + `queue_entries` 投递。
- 不把 external lifecycle executor 当产品面：codeteam 仍有 W7 Web Console + API/backend；Web 只发 intent/approval，生命周期执行由独立 supervisor/controller 承担。
- 不让每只猫起 timer 轮询部署；只允许单个 recovery sweep/等待恢复路径。
- 不用 wall clock 比较判断“新启动”；只认 bootId/bootSequence 基线。
- 不在 Git-less 安装里用版本号大小猜 ancestry；没有 build manifest 就返回 unknown。
- 不把 stop/restart 暴露为 agent/MCP tool；W0/W5 只允许 operator CLI。

## 4. 风险与回滚

| 风险 | 级别 | 处置 |
|---|---|---|
| checkout HEAD 与 serving artifact 混淆，导致“已部署”误报 | P1 | 只认启动时 build stamp；stamp 缺失/不一致 = runningRevision null；W0 测试混装/部分构建负例 |
| 自由文本 `authorizedBy` 被当授权，重演 clowder 未闭环缺口 | P1 | stop/restart 只接受 operator.key 验真；记录 typed principal；缺/伪造 403；W2 威胁测试 |
| 两个 `daemon start` 同时写 boot ledger，bootSequence 竞争 | P1 | 先取得 daemon state 独占启动权再 beginBoot；已有 running/stale 不可证时拒绝；并发启动负例 |
| deployment ready 被误当 Task 完成/直接唤醒 | P1 | 只驱动 wait predicate；业务收口归原 Task；start guard 复核 |
| `installationId` 随安装路径变化，旧等待永远不匹配 | P2 | 文档要求 installation root 稳定；变更视为新 installation，旧等待保持 unknown，不静默换 subject |
| W0 只有 daemon 服务，照抄 api+web `readyAt` 逻辑会永远不 ready | P2 | 引入 `CODETEAM_DEPLOYMENT_SERVICES`，按声明集合聚合；W0 单服务测试 |
| Git-less 安装没有 inclusion proof | P2 | 有真实 build manifest 才支持 `build_manifest`；否则 unknown/unsupported，不猜 |
| health probe 依赖 lsof/进程身份，平台不可读 | P2 | 不可读 = unknown/failed，不 pass；W0 明确 POSIX 平台；Windows adapter 后置 |
| PID 复用/daemon 被替换后 stop 打错进程 | P2 | frozen identity + startedAt/command recheck；executor 在目标树内拒绝 |
| `deploymentId` 两套 regex 分叉（daemon 允许数字开头，wait subject 要求字母开头） | P2 | 统一用更严格的 `^[a-z][a-z0-9._-]{0,63}$`；启动/登记共用同一 validator；负例测试 |
| auth.sqlite 不可读时连 halt 都做不了，救援通道被授权依赖堵死 | P1 | 验真只读 + busy_timeout=0；`--degraded-auth` 仅同 OS uid 的 halt 路径，audit 记 degraded；re-activation 永不接受 degraded |
| `revision_included` 混入目标仓 sha，永远 unknown | P2 | predicate 只接受 daemon build 来源仓 sha；登记时校验并拒绝目标仓 headSha；错误提示明确 |
| 卡片划给 W0/W5 的 daemon 生命周期面在 plans 无条目 | P1 | plans/0002 增补 W0c；plans/0004 W5 增补完整 lifecycle 与 deployment wait 消费；模板加“卡→Wn→plan 条目”硬门 |
| stop record 跨版本升级不可读 | P2 | `v` 版本字段；不兼容记录保留并报错，不自动清理；failed 终态需新 op |
| 时钟回拨伪造“新启动” | P2 | baseline 只用 bootSequence/bootId；wall clock 只展示 |
| deployment wait 投递失败后重复唤醒 | P2 | outcomeId + owner fence + queue 幂等；pending 可重试，不换身份 |
| W7 读文件时把 last-known 当当前 | P2 | 投影显式 unknown/stale + observedAt；不推断 |
| 64 代 boot history 截断 | P3 | sequence 单调，截断不影响新启动判断；保留最近 64 代足够 |
| stop audit 无限增长 | P3 | W5 先 append-only；需要轮转时按数据边界单独设计，不提前加复杂度 |

**回滚**：

- W0 只增加 daemon state + boot ledger + readiness；回滚到单进程 CLI 基线即可，不影响目标仓与 Task。
- W5 的 stop/restart 先以 CLI 影子模式验证；失败时保留操作记录，人工按 record 处置，不删除证据。
- deployment wait 可整体关闭（不登记/不消费），已登记等待保留 unknown；不自动迁移到第二套等待系统。
- 所有文件 owner 的写入都是 atomic rename；回滚不清空 boot/stop 历史，避免把“未知”洗成“干净”。

## 5. Review 与签字

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | W0/W5 daemon、boot ledger 单写者、生命周期状态机、恢复 | accept-with-modify；P2/P3 已回写 |
| 砚砚 | operator 授权、executor 独立性、文件权限、fail-closed、unknown 语义 | accept-with-modify；P2/P3 已回写 |
| 墨墨 | operator 可见的 readiness/版本/生命周期证据、W7 Web/API + external executor 边界、SOP 入口 | accept-with-modify；P2/P3 已回写 |
| 三猫 Round 1 汇总 | 五问 + 跨卡一致性 | accept-with-modify；P2/P3 已回写（DATA_DIR 统一、auth 救援通道、revision 空间、W0c/W5 plan 挂点、loopback auth、备份口径） |
| operator | cell 级决策与 W0/W5 范围 | [x] 已签（2026-10-25，批量签 A1-2/A1-3/A1-4） |

> Review 重点：① RD3/RD4/RD5/RD9 是否成立；② service enum `daemon|web` 与 readyAt 聚合是否漏掉 W7；③ 生命周期操作只允许 external executor（W0/W5 CLI，W7 supervisor）是否与 W0 dogfood 冲突；④ Git-less build manifest 是否应进 W0；⑤ deployment wait 的 W5 挂点与 A1-3 dispatch/A1-2 operator credential 是否一致。

> 说明：RD4 的“CLI”指 external lifecycle executor，不是产品形态。codeteam 的产品面是 W7 Web Console + API/backend；Web 只发 intent/approval，生命周期执行由独立 supervisor/controller 承担。

> operator 于 2026-10-25 批量签字，A1-4 冻结为 W0/W1 实现契约。

[宪宪/deepseek-flash🐾]
