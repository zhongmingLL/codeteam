---
title: "ball-custody 架构复用检视"
doc_kind: architecture-review
status: approved
operator_signoff: "DP-A3-1-1=A, DP-A3-1-2=A, DP-A3-1-3=A (2026-10-25)"
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
source_cell: ball-custody
source_card: ../../reuse/ball-custody.md
template: ../0004-reuse-architecture-review-plan.md
---

# ball-custody 架构复用检视

> **DP-MERGE-1=D 影响注（2026-10-25）**：Q4 已收敛——merge 不采用 agent handoff/lease；由 daemon merge service 执行，terminal truth = `merges` receipt；`pr_merged` 是外部观察事实，不进 10 kinds。本卡 `merge` custody 行按此解释；`task_done` 仍等 merge 完成，不等 operator。详见 `../merge-authority-drift-audit.md` §9。

## 1. 总结

| 项 | 结论 |
|---|---|
| clowder feature 范围 | F167（action successor lease、typed terminal predicate、completion candidate/verdict、replace/return/fresh revision）；F233（append-only ball custody event log、rebuildable projection、8 态 projection）；F280（typed AwaitState、owner fence、generation、expiry、one-shot consume、canonical wait termination）；F254（runtime attention/closure/supplement 已退役，只保留历史证据语义）。 |
| codeteam 复用总结 | **R1 责任对象复用 + SQLite 单事务适配**。复用 F167 的 identity/generation/predicate/candidate/verdict 契约，复用 F280 的 await/fence/outcome 契约；`handoffs` 是责任真相，`custody_events` 是 append-only 审计；`waits` 按 generation 一行，`wait_terminations` 是 canonical 终止事件。 |
| codeteam W | W1（`handoffs` 扩展、`handoff_holder_claims`、`custody_events`、`waits`、`wait_terminations`、CAS/事务、恢复扫描）；W5（run/queue 的 handoff/wait fence 消费、managed-command 恢复）；W7（只读 custody/等待投影）。 |
| 一句话 | 一个 action identity 同时最多一个 live handoff；single/parallel 的 holder claim 各自独立（parallel 每 holder 一条 claim），完成必须先 candidate、再由 server-owned typed resolver 产出 verified verdict，`handoff_complete` 才能落 `consumed`；wait 只按 generation 消费一次，owner fence 不可从可变字段重建。 |
| 明确不含 | F254 attention/closure/supplement/seenCursor、F233 值班简报 UI/轨迹下钻、文本 `@` 路由与 `void_pass`、第二套 queue/custody store、新的“球 ID”、F281 结构化 why、human approval 本体（归 A2-3）、F295 execution projection 本体（归 A1-3/A3-2）。 |

**组件立场**

| 组件 | 立场 | codeteam 处理 |
|---|---|---|
| `ActionSuccessorIdentity` / `CanonicalActionKey` | `reuse now` | 沿用 tenant + subjectRef + actionFamily + successorSlot；identity 不允许空值/控制字符 |
| `ActionSuccessorLease` / generation / holder outcomes | `adapt now` | 映射为 `handoffs` 行 + `generation` + `holder_outcomes_json`；parallel holder claim 用 `handoff_holder_claims` 子账本；`claimed_by_run_id` 只做 single-mode summary |
| claim / return / replace / fresh revision | `reuse now` | 同一 CAS 语义；return/replace 复用 generation+1；fresh revision 新建 handoff 行并保留旧 terminal 行 |
| completion candidate → resolver → verdict | `reuse now` | candidate 不终结；只有 typed resolver verified 才 commit；`queue:`/`invocation:`/`response:` 不是 completion evidence |
| `ActionSuccessorLeaseStore` port | `adapt now` | Redis→SQLite；`BEGIN IMMEDIATE` + status/generation/revision CAS；active 扫描不依赖 TTL |
| Redis keys / Lua / TTL | `drop` | action custody TTL=0；SQLite 事务取代跨 key Lua；handoff claim lease 与 action custody 分离 |
| `BallCustodyEvent` / event log / projector | `adapt now` | 保留 append-only、sourceEventId 幂等、per-subject 顺序；只为 handoff custody 审计，不承载状态真相 |
| `BallCustodyProjection` 持久化 store | `drop` | 不建 canonical projection 表；W7/诊断从 `handoffs` + `custody_events` 派生只读投影，rebuild 只做对账 |
| F233 7+1 态 ball 生命周期 | `adapt now` | 映射为 handoff/wait/task 的派生 custody projection；`parked/dead/zombie` 只作观察态，不是第二状态机 |
| F233 Phase C 安乐死 | `adapt now` | `abandoned`→`withdrawn(reason)`；`frozen/degraded` 不建独立状态，避免观察语义词变成控制面 |
| `UnifiedAwaitStateV1` / `WaitOwnerFence` / `WaitOutcomeV1` | `reuse now` | 按 generation 一行；`when[]`/`then`/`baseline`/`expiresAt`/`autoRenew` 对齐 |
| `WaitContinuationCarrierV1` | `reuse now` | Queue/Message 只运输 `waitId/outcomeId/ownerFence` refs；不复制 fence 正文 |
| `WaitTerminationEventV1` / `WaitTerminationStore` | `adapt now` | `wait_terminations` append-only 表；user_cancel 严格 actor=owner；conflict/replay 走唯一键 |
| managed-command wake lifecycle | `adapt now` | wait 只认 source adapter 的 durable terminal evidence；execution projection 仍归 A1-3/F295，不建第二执行账本 |
| hold/cancel access roles | `reuse now` | `trigger_principal` / `thread_collaborator` / `operator`；协作者只读摘要，`default` thread 加 exact user fence |
| F254 attention/closure/supplement | `drop` | clowder 已退役，codeteam greenfield 不建 freshness 表、不恢复 notice/re-invoke/closure |
| 文本 `@` 路由 / `ball.void_pass` | `out-of-scope` | codeteam 只认 typed tool call；正文 `@` 不产生 custody，只记 `missing_a2a_tool_call` 观测 |
| human approval / approval rich block | `out-of-scope` | 归 A2-3 `approvals`；handoff payload 不内嵌审批，wait 只通过 `approval_id` 做 effect receipt |
| F233 简报/轨迹 UI | `out-of-scope` | W7 只读投影；不建值班简报、探针、唤醒副作用 |
| F281 结构化 why / 反馈闭环 | `defer→W4+` | v1 只保留 `disposition_ref` 接缝；termination event 不存 why 正文 |

## 2. clowder 架构

### 2.1 架构图

```text
Structured transfer / dispatch proposal
        │  authenticated actor + subject/action/slot + terminal predicate
        ▼
ActionSuccessorAdmissionService
  ├─ resolve subject terminal truth
  ├─ verify freshness + standing
  ├─ canonicalize identity (tenant + subject + family + slot)
  └─ claim / replace / return / continue fresh revision
        │  Redis Lua CAS: detail + identity index + subject-terminal + all-set
        ▼
ActionSuccessorLease
  ├─ generation / status(active|replaceable|completed)
  ├─ holderCatIds / holderThreadId / predecessor route
  ├─ terminalPredicate (frozen digest/freshness key)
  ├─ completionCandidates / holderOutcomes
  ├─ returnDeliveryState / replacementTransitions
  └─ dispatchDeliveryState / reservation
        │
        ├─► completion candidate ──► ActionSubjectTruthResolver ──► verified verdict
        │        (machine evidence)          (task/community truth)          │
        │                                                                  ▼
        │                                                        commitCompletionVerdict
        │
        ├─► return / replace / fresh revision ──► new generation
        └─► recovery sweep ──► re-deliver same fence / mark unavailable

BallCustodyEventLog (F233)
  ├─ append-only per-subject list + global seen set
  ├─ sourceEventId idempotency
  ├─ BallCustodyProjector: transition + field effects
  └─ rebuild = replay; projector has zero external side effects

Typed wait (F280)
  ├─ UnifiedAwaitStateV1: generation + ownerFence + baseline + when[]/then + expiresAt
  ├─ transitionWaitState: matched / expired / subject_terminal / owner_changed / superseded / user_cancel
  ├─ WaitOutcomeV1: outcomeId + exact ownerFence + delivery
  └─ WaitContinuationCarrierV1: waitId + outcomeId + ownerFence (transport projection)
```

### 2.2 数据流

1. **Admission**：structured transfer 先验证 actor standing/freshness；`ActionSuccessorAdmissionService` 解析 subject terminal truth，canonicalize identity，然后 claim。identity 已经存在且 dispatch 不同 → `safe_wait`；lease 已 completed 且 freshness key 变化 → `continueFreshRevision`；holder 全终态且无成功 → `replaceable`，只允许 verified replace。
2. **Carrier**：lease 在 carrier 投递前就存在；`dispatchDeliveryState='pending'` 表示 custody 已建立、运输未确认。Queue 只携带 `leaseId + generation + dispatchId + predicate digest`，不复制 lease 正文。
3. **Completion**：producer 先 `recordCompletionCandidate` 写机器证据；`ActionSubjectTruthResolver` 从 task/community 真值解析；只有 `verified` verdict 能 `commitCompletionVerdict` 将 holder 置为 `succeeded`。`queue:`/`invocation:`/`response:` 不是合法 completion evidence。
4. **Return / replace**：single return 由 exact holder 发起，generation+1，custody 原子移回 predecessor；parallel rejection 只写 rejecting holder 的 `rejected_ownership`，不增 generation。replace 只在 `replaceable` 上允许，generation+1，并持久化 from/to edge。
5. **Recovery**：boot/periodic sweep 枚举 active task lease、pending return、pending dispatch；return 重投同一 fence，dispatch 重试同一 idempotency key，completion 重放 idempotent CAS。recovery 不新建 lease、不伪造成功。
6. **Wait**：注册时 caller 给 typed any-of + continuation，containing task/action lease 提供 owner fence；source adapter 只在自身域判断事实。matched/expired/subject_terminal/owner_changed/superseded/user_cancel 进入 terminal outcome；auto-renew 在同一 transition 安装 generation+1。
7. **Wait consume**：只有 matched predicate 能按 generation CAS consume；consume 后 Queue 只运输 immutable carrier；Queue/Invocation 在 provider start 前复验 task/outcome/generation/expiry/owner fence。

### 2.3 状态机 / 生命周期

**A. ActionSuccessorLease（canonical）**

```text
active ──holder terminal outcomes──► replaceable（all terminal, none succeeded）
  │
  ├──verified completion──► completed
  ├──single return─────────► active (generation+1, holder=predecessor)
  ├──verified replace──────► active (generation+1, new holders)
  └──subject terminal──────► terminal truth (claim rejected thereafter)

completed ──fresh subject revision (same identity, new freshnessKey)──► new lease active
```

- status 只有 `active|replaceable|completed`；`generation` 是 custody 代际，`revision` 是本次 CAS 修订号。
- `recordActionSuccessorOutcome` 首个 terminal outcome 生效；parallel 中一个 holder 的终态不覆盖其他 holder。
- completion candidate 不是终态；candidate 变更会让旧 verdict 失效。
- action custody 没有 TTL；`returnDeliveryState`/`dispatchDeliveryState` 只是运输状态，不是第二账本。

**B. F233 ball projection（clowder 视角）**

```text
new ──first event──► active ──hold──► active(heldUntil)
  │                    │
  │                    ├──task.blocked──► blocked ──task.unblocked──► active
  │                    ├──invocation.died──► dead ──late heartbeat(grace)──► active
  │                    ├──handoff to operator──► parked
  │                    ├──void pass──► void
  │                    ├──idle long──► zombie
  │                    └──task.done / euthanasia──► resolved
  └──task.done──► resolved
```

- 8 态是 F233 的观察投影；事件 append-only，projection 可 rebuild。
- projector 零外部副作用；唤醒/投递在 ProbeScheduler/WakeSender 实时路径。
- `resolved` 不因后续普通事件复活；新 custody 通过新的 typed action/handoff 建立。

**C. F280 typed wait（clowder 视角）**

```text
(no await) ──registration──► active(gN)
  │                             ├──predicates_matched──► outcome(matched, gN) + await(gN+1)  [autoRenew]
  │                             ├──subject_terminal────► outcome(subject_terminal, gN)
  │                             ├──expired─────────────► outcome(expired, gN)
  │                             ├──owner_changed───────► outcome(owner_changed, gN)
  │                             ├──superseded──────────► outcome(superseded, gN)
  │                             └──user_cancel─────────► outcome(user_cancel, gN) + termination event
  │
  └──one-shot consume (CAS)──► outcome delivered / suppressed / conflict
```

- `expiresAt` 可选；缺省表示无时间终止，`expiresAt` 到点只影响当前 generation。
- `matched` 必须非空；empty match 不 consume、不唤醒。
- match 先于 expiry 的 terminal-fact 例外只限 `subject_terminal` / `user_cancel`；迟到 matched 仍按 expiry 处理。
- `owner_changed`/`superseded`/`user_cancel` 的 delivery=`not_applicable`；其余 pending。

### 2.4 关键数据结构

```ts
// packages/shared/src/types/action-successor.ts:4,13,27
type ActionSuccessorActionFamily = 'review' | 'merge' | 'investigate' | 'implement' | 'verify' | 'vision_guard';
type ActionSuccessorSlot = 'reviewer' | 'merge_owner' | 'investigator' | 'implementer' | 'verifier' | 'vision_guardian';
type ActionTerminalPredicateKind = 'pr_merged' | 'review_delivered' | 'ci_passed' | 'test_passed' | 'durable_verdict' | 'task_done';

// packages/api/src/domains/ball-custody/action-successor-state-machine.ts:119,161
interface ActionSuccessorLeaseBase extends ActionSuccessorIdentity {
  leaseId: string;
  mode: 'single' | 'parallel';
  holderCatIds: string[];
  dispatchId: string;
  claimOrigin: 'structured_transfer' | 'existing_standing';
  holderThreadId: string;
  predecessorCatId?: string;
  predecessorThreadId?: string;
  generation: number;
  status: 'active' | 'replaceable' | 'completed';
  holderOutcomes: Record<string, { outcome: 'succeeded' | 'failed' | 'canceled' | 'unavailable' | 'rejected_ownership'; evidenceRef: string; at: number }>;
  completionCandidates: Record<string, ActionCompletionCandidateSnapshot>;
  terminalPredicate: CanonicalActionTerminalPredicate;
  returnDeliveryState?: 'pending' | 'overdue' | 'delivered';
  replacementTransitions: ActionSuccessorReplacementTransition[];
  revision: number;
}
```

```ts
// packages/shared/src/types/wait-contract.ts:3,18,25,52,60
type WaitOwnerFence =
  | { kind: 'containing_task'; generation: number }
  | { kind: 'action_successor'; leaseId: string; generation: number };

interface WaitContinuationCarrierV1 {
  v: 1;
  waitId: string;
  outcomeId: string;
  ownerFence: WaitOwnerFence;
}

interface UnifiedAwaitStateV1<SubjectRef extends string, Baseline, Predicate> {
  v: 1;
  generation: number;
  subjectRef: SubjectRef;
  ownerFence: WaitOwnerFence;
  baseline: Baseline;
  continuation: { when: readonly Predicate[]; then: string };
  expiresAt?: number;
  autoRenew?: boolean;
  createdAt: number;
}

type WaitOutcomeDelivery = 'pending' | 'delivered' | 'suppressed' | 'not_applicable' | 'legacy_unfenced' | 'queue_conflict';
```

```ts
// packages/shared/src/types/ball-custody.ts:20,49,82,109
type BallEventKind = 'ball.handed' | 'ball.held' | 'ball.hold_expired' | 'invocation.started' | 'invocation.heartbeat' | 'invocation.died' | 'task.blocked' | 'task.unblocked' | 'task.idle_long' | 'task.done' | 'ball.wake_sent' | 'ball.wake_condition_met' | 'ball.hold_dispositioned' | 'ball.dispatch_dispositioned' | 'ball.wait_dispositioned' | 'ball.frozen' | 'ball.degraded' | 'ball.abandoned' | 'ball.handed_cvo' | 'ball.void_pass';
interface BallCustodyEvent { sourceEventId: string; subjectKey: string; kind: BallEventKind; classification: 'state-changing' | 'informational'; payload: Record<string, unknown>; at: number; }
type BallState = 'new' | 'active' | 'blocked' | 'parked' | 'dead' | 'void' | 'zombie' | 'resolved';
interface BallCustodyProjection { subjectKey: string; state: BallState; holder: string | null; heldUntil: number | null; blockedSinceAt: number | null; lastWakeAt: number | null; appliedEventCount: number; lastRejectedEvent: BallCustodyEvent | null; }
```

### 2.5 Current truth 与代码路径

| # | 事实 | 代码锚点 |
|---|---|---|
| T1 | action identity = tenant + subjectRef + actionFamily + successorSlot；slot 受 family 白名单约束 | `packages/api/src/domains/ball-custody/action-successor-identity.ts:29`、`:36`、`:68`；`packages/shared/src/types/action-successor.ts:4`、`:13`、`:27` |
| T2 | lease 有 active/replaceable/completed 三态、generation、holder outcomes、completion candidates、return/replacement edges、dispatch delivery state | `packages/api/src/domains/ball-custody/action-successor-state-machine.ts:88`、`:119`、`:161` |
| T3 | claim 在 same identity + same dispatchId 时 replay；不同 dispatchId 时 safe_wait；subject terminal 直接拒绝 | `packages/api/src/domains/ball-custody/action-successor-state-machine.ts:200`、`:273`；`packages/api/src/domains/ball-custody/RedisActionSuccessorLeaseStore.ts:214`；`packages/api/src/domains/ball-custody/action-successor-redis-scripts.ts:1` CLAIM Lua |
| T4 | completion candidate 是机器证据快照；verified verdict 才能 commit succeeded；candidate 变更使旧 verdict 失效 | `packages/api/src/domains/ball-custody/action-successor-completion-state-machine.ts:73`、`:107`；`packages/api/src/domains/ball-custody/ActionSuccessorCompletionService.ts:40` |
| T5 | typed predicate catalog 只开放 review_delivered / task_done；missing producer/port fail closed；completion evidence 前缀白名单 | `packages/api/src/domains/ball-custody/ActionTerminalPredicateCatalog.ts:44`、`:187`、`:223`、`:291` |
| T6 | subject truth 由 task store / community projection / terminal marker 解析；task_done 必须 exact task done evidence | `packages/api/src/domains/ball-custody/ActionSubjectTruthResolver.ts:109`、`:122`、`:191`、`:223` |
| T7 | single return generation+1 回到 predecessor；parallel rejection 只写 rejecting holder；replace 只在 replaceable 上 generation+1 | `packages/api/src/domains/ball-custody/action-successor-return-state-machine.ts:81`；`packages/api/src/domains/ball-custody/action-successor-replacement-state-machine.ts:143`；`packages/api/src/domains/ball-custody/ActionSuccessorAdmissionService.ts:188`、`:230`、`:292` |
| T8 | return delivery 有 pending/overdue/delivered + 60s SLA；recovery sweep 重投同一 fence | `packages/api/src/domains/ball-custody/action-successor-return-state-machine.ts:5`、`:7`；`packages/api/src/domains/ball-custody/ActionSuccessorRecoverySweep.ts:105`、`:140` |
| T9 | F233 event log append-only、sourceEventId 幂等、per-subject list；projector 零外部副作用、可 rebuild | `packages/api/src/domains/ball-custody/BallCustodyEventLog.ts:83`、`:101`；`packages/api/src/domains/ball-custody/BallCustodyProjector.ts:32`、`:42`；`packages/api/src/domains/ball-custody/BallCustodyIngest.ts:58`、`:78` |
| T10 | F233 8 态/20 事件由纯函数 transition 表驱动；reject 不改 state | `packages/shared/src/types/ball-custody.ts:20`、`:82`；`packages/api/src/domains/ball-custody/ball-custody-state-machine.ts:1` `STATIC_TABLE`/`DYNAMIC_TABLE` |
| T11 | F280 await 有 generation/ownerFence/baseline/continuation/expiresAt/autoRenew；outcome 保留 exact ownerFence | `packages/shared/src/types/wait-contract.ts:3`、`:25`、`:52`、`:60`；`packages/api/src/domains/ball-custody/wait-state-machine.ts:110`、`:160`、`:214` |
| T12 | wait termination 六种 reason；user_cancel 严格 actor=user 且 userId=owner | `packages/shared/src/types/wait-termination.ts:7`、`:16`、`:38`；`packages/api/src/domains/ball-custody/WaitTerminationService.ts:65`、`:91`、`:114` |
| T13 | wait cancel 先 reserve timer + managed-command delivery，再 commit termination；entered wake 是冲突，不是 false cancel | `packages/api/src/domains/ball-custody/WaitTerminationService.ts:91`、`:114`；`packages/api/src/domains/ball-custody/RedisWaitTerminationStore.ts:1` COMMIT Lua |
| T14 | managed-command wake 有 command_running/lost/condition_met/message_written/dispatch_pending/dispatched/enqueued/cancelled/consumed；recovery 只从 durable evidence 收敛 | `packages/api/src/domains/ball-custody/managed-command-wake-task-projection.ts:20`；`packages/api/src/domains/ball-custody/ManagedCommandWakeRecoveryEngine.ts:69`、`:95`、`:122`、`:205`、`:214`；`packages/api/src/domains/ball-custody/ManagedCommandWakeRecoverySweep.ts:68`、`:91`、`:382` |
| T15 | hold/cancel 角色 = trigger principal / thread collaborator / operator；collaborator 只读 summary；default thread 加 exact user fence | `packages/api/src/domains/ball-custody/hold-ball-access-policy.ts:5`、`:78`、`:101` |
| T16 | F233 Phase C 已 failed-close；F254 runtime attention 已退役，历史事件只作证据 | `docs/features/F233-ball-custody-observability.md:14`；`docs/architecture/ownership/cells/ball-custody.md` Canonical Owner；`docs/features/F254-side-effect-freshness-gate.md` Current State |
| T17 | 0001 目标态已有 `handoffs` custody 列、`handoff_holder_claims`、`custody_events`、per-generation `waits`、`wait_terminations`；custody events 固定枚举、append-only；waits 只驱动唤醒 | `codeteam/architecture/0001-codeteam-architecture-v1.md:1416`、`:1417`、`:1418`、`:1419`、`:1420`、`:1464`、`:1465`、`:1467` |
| T18 | A1-3 已定 Queue 只运输 fence refs（`WaitContinuationCarrierV1`），不拥有 fence 正文 | `codeteam/architecture/reuse-review/dispatch.md:95`、`:193`、`:351` |
| T19 | A2-3 已定 `waits.approval_id` UNIQUE 作为 blocker/budget effect receipt；effect owner 仍是 waits | `codeteam/architecture/reuse-review/approval-index.md` §3.4.3#4 |

### 2.5.1 上游已知缺口 → 本卡处置

| # | 上游缺口（实证） | 影响 | 本卡处置 |
|---|---|---|---|
| G1 | F167 用 Redis detail + identity index + subject-terminal + all-set 多 key Lua CAS | 照搬会把多 key 原子性带进 SQLite | codeteam 用 `handoffs` 单表 + `BEGIN IMMEDIATE` + status/generation/revision CAS；identity 用 partial unique index |
| G2 | F233 的 event log 是唯一真相，projection 可 rebuild | 直接把 event log 当 codeteam 真相会与 `handoffs` 双写双真相 | codeteam `handoffs` 是真相；`custody_events` 是同事务 append-only 审计；replay 只对账告警，不反向裁决 |
| G3 | F233 有独立 projection store | codeteam 再存一份会制造第三状态 | 不建 canonical projection 表；W7/诊断从 handoffs + events 派生；rebuild 不写回 |
| G4 | clowder lease status 是 active/replaceable/completed；handoff status 是 pending/claimed/consumed/withdrawn/expired | 两套状态并列会漂移 | `handoffs.status` 是唯一状态；replaceable 由 holder outcomes 派生；不新增 lease status 列 |
| G5 | clowder completion 要所有 holder terminal 才 completed（parallel） | 一个已成功 + 一个沉默 holder 会把 action 挂住 | DP-A3-1-1：推荐 first verified success 终结；reviewer 决定 parity 或 adaptation |
| G6 | clowder action lease 无 TTL；Redis key 永不过期 | 容易把 action custody 和 handoff claim lease 混成 TTL | action custody TTL=0；`handoffs.claimed_lease_until`/`last_heartbeat_at` 只服务 claim slot；recovery 扫 status，不靠 TTL |
| G7 | clowder 用 catId；codeteam 身份是 AgentProfile | 直接复用字段会跨 profile/role 混乱 | `holder_profile_ids_json` 存 profile；`from_role/to_role` 只做 SOP actionPair 白名单 |
| G8 | F280 await 嵌在 Task automationState；outcome 也在 Task | codeteam 没有 Task JSON 作为 wait store | `waits` 按 generation 一行；owner fence/outcome 独立；Task 不复制 wait 正文 |
| G9 | clowder managed-command 状态在 DynamicTask params | codeteam 无 DynamicTask；命令执行真相在 A1-3/F295 | wait 只认 `wait_source_ref` 的 durable terminal evidence；execution projection 归 A1-3/A3-2；lost 不伪造成功 |
| G10 | F254 attention/closure/supplement 运行时已退役 | 照搬会恢复已 sunset 的通知/补读机制 | 明确 `drop`；不建 freshness/attention/closure/supplement 表；普通投递归 A1-3 |
| G11 | F233 20 种 ball event 包含文本路由/安乐死/attention 语义 | 全量照搬会引入 codeteam 不需要的观察词 | codeteam 只保留 handoff custody 事件；text `@`/void/frozen/degraded 不进入事件枚举 |
| G12 | F280 `WaitTerminationStore` 绑定 F281 disposition entry | codeteam v1 没有 F281 | `wait_terminations.disposition_ref` 可选；termination event 不存 why 正文 |

## 3. codeteam 架构

### 3.1 架构图

```text
handoff_create (MCP / HTTP; authenticated agent or operator)
  ├─ validate task/thread/role/actionPair/expectedArtifact/subject/terminal predicate
  ├─ CAS live canonical action identity
  ├─ INSERT handoffs(status=pending, generation=1, revision=1)
  ├─ INSERT custody_events(handoff.created)
  ├─ INSERT messages(control_ref='handoff:<id>')  // visible shell, no rich-block truth
  ├─ INSERT queue_entries(source_kind='handoff', fence_refs={handoff:{id,generation}})
  └─ INSERT audit(handoff_created)
        │ one SQLite transaction
        ▼
QueueProcessor → holder run claim → handoff_claim
  ├─ upsert handoff_holder_claims(handoff, profile, run, generation, lease)
  ├─ single: claimed_by_run_id summary; parallel: each holder has its own active claim
  ├─ handoffs.status = claimed if any active claim else pending
  ├─ custody_events(handoff.claimed)
  └─ audit(handoff_claimed)
        │
        ├─ handoff_complete
        │    ├─ exact holder claim/run; record completion candidate (JSON; not terminal)
        │    ├─ typed resolver: task_done / review_delivered / ...
        │    └─ verified verdict → release holder claim + CAS consumed + result_json/terminal_at
        │         (A: sibling claims released, sibling runs canceled by control plane)
        │         ├─ custody_events(handoff.completed)
        │         └─ audit(handoff_completed)
        │
        ├─ handoff_return
        │    ├─ single only; release claim; CAS generation+1; holder=predecessor; status=pending
        │    ├─ return_delivery_state=pending; return carrier via queue
        │    └─ custody_events(handoff.returned)
        │
        ├─ handoff_replace
        │    ├─ only if no active claims & all holders terminal & none succeeded
        │    ├─ CAS generation+1; new holders/predicate; status=pending; clear claims/outcomes
        │    └─ custody_events(handoff.replaced)
        │
        └─ handoff_withdraw / expire
             ├─ release active claims + CAS terminal + cancel queue targets/runs
             └─ custody_events(handoff.withdrawn|handoff.expired)

wait_arm (timer / event / managed_command)
  ├─ validate wait_source_ref + expected_signal + SLA + owner fence
  ├─ INSERT waits(active, generation=N, baseline/continuation/owner_fence)
  └─ audit(wait_armed)
        │
        ▼
source adapter (github-signals / deployment / managed-command)
  ├─ matched/expired/subject_terminal/owner_changed/superseded/user_cancel
  ├─ INSERT wait_terminations(canonical event) + waits.outcome_json
  └─ auto_renew: INSERT waits(active, generation=N+1) same transaction
        │
        ▼
wait consume (server-only, one-shot CAS)
  ├─ terminalized + outcome_delivery=pending + consumed_at IS NULL
  ├─ INSERT queue_entries(fence_refs={wait:{waitId,generation,outcomeId,ownerFence}})
  ├─ INSERT message carrier (immutable WaitContinuationCarrierV1)
  └─ consumed_at=now; delivery=pending→delivered/queue_conflict
```

### 3.2 数据流

1. **Handoff create**：`handoff_create` 必须声明 `subject_ref`、`action_family`、`successor_slot`、`mode`、holders、`expected_artifact`、`terminal_predicate`、`dispatch_id`/idempotency key。同一 canonical action identity 已有 live handoff 时：同 dispatch → replay，不同 dispatch → `safe_wait`。既有 terminal handoff 且 predicate freshness key 未变 → 返回既有结果；freshness key 变化 → 新 handoff 行（fresh revision，新 idempotency key）。v1 predicate catalog 只开放 `review_delivered` / `task_done`；其他 family 在 producer/port 接通前 fail closed。
2. **Dispatch**：`handoffs` + `queue_entries` + 可见 message shell 同事务；`dispatch_delivery_state=pending`。Queue 只运输 `{handoffId,generation,dispatchId,predicateDigest}` refs；不复制 lease 正文。Queue admission 失败整体回滚，不留 orphan handoff。
3. **Claim**：claim 是 **per-holder** 的。`handoff_claim` 只允许本次 dispatch 的 holder profile 为自己建立 claim；写入 `handoff_holder_claims(handoff_id, profile_id, generation, run_id, lease_until, heartbeat)`。single mode 只有一个 holder claim，并同步 `claimed_by_run_id` summary；parallel mode 每个 holder 各自 claim，互不挤占。同一 profile 同 run 重试幂等；不同 run → `safe_wait`；非 holder → 403；terminal/已有 terminal outcome → 409。`handoffs.status` 只要有 active claim 就是 `claimed`，全部 claim 释放/中断后回 `pending`（terminal 状态优先）。action custody 本身无 TTL；claim lease 只服务 holder run 的 liveness。
4. **Completion**：`handoff_complete` 先写 candidate（canonical evidence refs + digest），不落 terminal；server-owned resolver 解析 typed predicate；只有 verified verdict 能 commit `consumed`。`result_json` 保存 terminal result/evidence ref；`terminal_predicate_json` 保持 frozen。
5. **Return**：single return 由 exact holder + holder thread 发起，release 该 holder claim，generation+1，holder 切回 predecessor，status=`pending`，并清空 single summary 的 `claimed_by_run_id/claimed_at/claimed_lease_until/last_heartbeat_at`；return carrier 通过 queue 重投同一 fence，`return_delivery_state` 从 pending→overdue→delivered。parallel rejection 只写 rejecting holder 的 `rejected_ownership` 并 release 该 holder claim，generation 不变，其他 holder 继续。
6. **Replace**：只有 `replaceable`（无 active holder claim、所有 holders 终态且无 success）允许；issuer 必须是认证 actor/operator，且 subject freshness 仍 verified；generation+1，新 holders/predicate，status=`pending`，清空 old claims/outcomes，持久化 from/to edge。普通 `handoff_claim` 在 replaceable 上拒绝。
7. **Withdraw / expiry**：withdraw 只允许 author/operator；expiry 只由 system 按 explicit deadline/operator expire 触发，claim lease stale 只触发 per-holder run interrupted recovery（回 pending），不单独判 expired；两者都 release 所有 active holder claims、取消未投递 queue targets 和 sibling runs，写 terminal actor/reason，late complete 一律拒绝。
8. **Wait arm**：`waits` 按 generation 一行；`owner_fence_json` 只能来自 canonical task/action lease，不能从 mutable task fields 重建；event 型必须有 `expected_signal`；所有 kind 必须有 `wait_source_ref` 与 `sla_until`，缺证据 422/fail closed。
9. **Wait terminalize**：source adapter 只在自身域判断；matched/expired/subject_terminal/owner_changed/superseded/user_cancel 写 `wait_terminations` + `waits.outcome_json`，同事务；auto-renew 同事务插入 generation+1 active。`user_cancel` 先 reserve timer/managed delivery，commit 后清理 execution projection；entered wake → 409，不是 false cancel。
10. **Wait consume**：只有 server-side one-shot CAS 能把 `terminalized` + pending 的 outcome 转成 `consumed_at`；Queue admission 在 provider start 前复验 exact wait/generation/outcomeId/owner fence/expiry。重复 consume 同 outcomeId → replay；不同 outcomeId → 409 `wait_consumption_conflict`。
11. **Recovery**：boot/periodic sweep 扫描 `handoff_holder_claims(status='active', lease_until < now)`、`handoffs` 的 pending return/dispatch，和 `waits(terminalized, outcome_delivery=pending)`；只重放同一 fence/idempotency key/outcomeId。stale holder claim 只产生 liveness candidate，需 run_events + worker live proof 才把**该 holder claim** 置 `interrupted`；其他 holder 不受影响。全部 claim 释放/中断后 handoff 回 `pending`（同一 generation）；reattach 用新 dispatch_id + attempt+1，不新建 identity/generation。不自动 complete、不因 claim lease 单独 expired。
12. **Observability**：所有 mutation 同事务写 `audit`；handoff custody 写 `custody_events`；wait 终止写 `wait_terminations`。W7 只读投影从这些表派生；不建 push/IM 通道，提醒走 queue/wait。

### 3.2.1 v1 SOP stage → custody 映射（GLM P2-1）

| SOP stage / handoff kind | v1 custody 形式 | 完成方式 |
|---|---|---|
| `impl` / implement handoff | **普通 handoff**（`action_family=null`，`expected_artifact=diff+testReport`） | artifact 交付 + 调用方/verifier 确认 → `consumed`；不挂 typed predicate |
| `review` / review_request | **action custody**（review/reviewer） | `review_delivered` predicate + verified verdict |
| `merge` | daemon merge service + merge receipt（D 收敛；routine merge 无 approval；hard-gate 走 A2-3 approval） | merge service 执行 + merge receipt；无 agent handoff/lease；不走 handoff predicate |
| `verify` | 普通 handoff（verification artifact） | verification artifact 交付；action custody 留 Phase C |
| `completion` | operator-direct SOP gate | 不进 handoff/approval catalog |

- `task_done` predicate 保留在 catalog 供未来 task-backed custody；**v1 不自动配给 implement**：codeteam 的 impl custody 在 diff/test report 交付时 discharge，而 `task_done` 要等 merge 完成（D 下不等 operator），可能跨天，不能作为 impl handoff 的完成条件。
- `action_family` 的 CHECK 是语法合法集；catalog 是运行时开放集。v1 只开放 `review_delivered`/`task_done`，merge/investigate/verify 在 producer/port 接通前 fail closed，不假装支持。

### 3.3 状态机 / 生命周期

**A. codeteam handoff（唯一状态机）**

```text
(no live handoff)
        │ handoff_create
        ▼
      pending ──claim──► claimed ──verified completion──► consumed
        │                   │
        │                   ├──return (single)──────────► pending (generation+1)
        │                   ├──replace (replaceable)─────► pending (generation+1)
        │                   └──all holders terminal,
        │                      none succeeded────────────► pending (derived replaceable)
        │
        ├──withdraw (author/operator)────────────────────► withdrawn
        └──explicit deadline─────────────────────────────► expired

claimed ──withdraw (author/operator)─────────────────────► withdrawn
claimed ──explicit deadline─────────────────────────────► expired
claimed ──one holder interrupted + proof───────────────► claimed / pending
          （该 holder claim 置 interrupted；无 active claim 才回 pending）
```

- `consumed/withdrawn/expired` terminal；terminal row 不重置。fresh revision 新建 handoff 行（clowder parity：新行 `generation=1`），沿用 `canonical_action_key`，但不复用 id；同一行的 replace/return 才 `generation+1`。
- `pending` 只表示责任未 claim，不是第二队列；`queue_entries` 仍是唯一 pending-wake 账本。
- `claimed` 表示**至少一个** holder claim 是 active：single mode 一个，parallel mode 每个 holder 各自一条。parallel 的 holders 共享同一 custody generation，但 claim/outcome 独立。
- claim lease/heartbeat stale 只产生 liveness candidate；独立 proof 确认某 holder run interrupted 后，只把**该 holder claim** 置 `interrupted`，不因 worker 崩溃把 action custody 判死；全部 claim 释放/中断后才回 `pending`（同一 generation）。`expired` 只由 explicit deadline/operator expire 触发。
- run interrupted 后的 reattach 复用同一 pending handoff（新 dispatch/attempt），不新建 identity 行；`unavailable` 是该 holder 的 terminal outcome，后续成功必须走 replace，不能覆盖。
- `replaceable` 是派生态（无 active claim + all holders terminal + none succeeded）；普通 claim 拒绝，只有 verified replace 能把 generation+1 并回到 pending。parallel 的沉默 holder 由 per-holder claim lease/heartbeat recovery 写 `unavailable`，之后才满足 all-terminal。
- `consumed` 的 idempotent replay 返回原 result；late complete / late return / late replace 一律 `terminal_handoff`/409。

> 0001 §5.2 的 `claimed --lease--> expired` 在本卡按 F167 TTL=0 与 plan W1「claimed handoff → pending」解释：claim lease stale 只触发 run interrupted recovery，handoff 回 pending；expired 只由 explicit deadline/operator expire 触发。否则 worker 崩溃会误杀仍有效的 action custody。

**B. holder outcome / generation**

```text
generation N, status=claimed
  ├─ holder A claim active ──succeeded (candidate+verified)──► A=succeeded; claim released
  ├─ holder B claim active ──rejected_ownership─────────────► B=rejected_ownership; claim released
  ├─ holder C claim active ──unavailable────────────────────► C=unavailable; claim interrupted/released
  │
  ├─ DP-A3-1-1=A: first succeeded ─────────────► consumed; sibling claims released,
  │                                              sibling runs canceled by control plane
  └─ DP-A3-1-1=B: all terminal + any succeeded ► consumed; else replaceable
```

- 同一 holder 的第一个 terminal outcome 生效；重复/迟到 outcome 不覆盖。
- 每个 holder 的 active claim 记录 run/lease/heartbeat；完成/拒绝/不可用时先 release/interrupt 该 claim，再写 outcome。
- DP-A3-1-1=A 下，first success 后 sibling claims 由 control plane release，sibling runs 以 `run.status=canceled` 结束；这是 run 生命周期，不是 handoff 状态迁移。DP-B 下等待 all-terminal，沉默 holder 由 recovery 收敛为 `unavailable`。
- completion candidate 与 holder outcome 分开：candidate 可多轮累积 evidence；verified commit 才写 succeeded。
- replace/return 必须持久化 from/to generation edge；下游不能只凭 generation 变大推断合法 supersession。

**C. codeteam wait（per-generation）**

```text
active(gN) ──matched────────────► terminalized(gN, matched, delivery=pending)
     │                               └──auto_renew──► active(gN+1) same tx
     ├──expired──────────────────► terminalized(gN, expired, delivery=pending)
     ├──subject_terminal─────────► terminalized(gN, subject_terminal, delivery=pending)
     ├──owner_changed────────────► terminalized(gN, owner_changed, delivery=not_applicable)
     ├──superseded───────────────► terminalized(gN, superseded, delivery=not_applicable)
     └──user_cancel──────────────► terminalized(gN, user_cancel, delivery=not_applicable)

terminalized(gN, pending) ──consume CAS──► consumed(gN)
  ├─ queue accepted ──► delivered
  ├─ suppressed ──────► suppressed
  └─ immutable conflict ──► queue_conflict
```

- `wait_id` 是 series；`(wait_id,generation)` 唯一；同 series 至多一个 `active`。
- `expires_at` 是绝对 deadline；renewal 不延长它。`auto_renew=true` 时 match 后同事务安装 gN+1，不出现“gN 已消费、gN+1 未 armed”的缝隙。
- `active` 行没有 outcome；`terminalized` 行必须有 outcome + delivery。`consumed_at` 只表示 one-shot 消费完成，不改变 outcome。
- `event` 型缺 `expected_signal`、任何 kind 缺 `wait_source_ref`/`sla_until`/`owner_fence_json` 都 fail closed。

**D. F233 projection 映射（只读派生）**

| F233 观察态 | codeteam 派生条件 | 用途 |
|---|---|---|
| `new` | 刚创建、无 claim、无 wait | 时间线 |
| `active` | handoff claimed 且无 active wait / 无 blocked task | 当前责任 |
| `blocked` | task.status=blocked 或 wait terminalized 但 outcome 未 delivered | 等 external/source |
| `parked` | handoff 人审/approval 等待（由 A2-3 投影，不写 handoff 状态） | operator 视角 |
| `dead` | handoff status=expired，或 dispatch failed 且无 replacement | 恢复候选/终态观察 |
| `void` | codeteam 不产生（typed tool only）；文本 `@` 只记 `missing_a2a_tool_call` | 不实现 |
| `zombie` | pending/claimed 超过观察阈值且无 heartbeat/事件 | 观察告警 |
| `resolved` | handoff consumed/withdrawn/expired | 终态 |

- projection 是 W7/CLI 的只读派生，不是 stored truth；rebuild 只从 `handoffs`/`waits`/`custody_events` 重算。
- 与 F233 的 8 态不是一一映射；`parked/dead/zombie` 只是观察态，不能作为 claim/complete 的授权依据。

**E. managed-command recovery 映射**

| clowder 状态 | codeteam 投影 | 语义 |
|---|---|---|
| `command_running` | `waits.status=active` + `wait_source_ref=managed_command:<executionId>` | source adapter 只读 A1-3 execution projection；wait 不拥有进程 |
| `condition_met` | terminalize gN with `matched`（命令成功）或 `expired`（超时） | outcome delivery=pending；不直接发消息 |
| `message_written` / `dispatch_pending` / `dispatched` / `enqueued` | `outcome_delivery` 的中间恢复态；Queue 运输 exact carrier | 同一 outcomeId 幂等；不新建 queue admission |
| `lost` | terminalize gN with `expired` + payload `failureKind='command_lost'`；写 status message | 不伪造成功；no wake |
| `cancelled` | `user_cancel`（用户）或 `superseded`（系统）termination | delivery=not_applicable；不唤醒 |
| `consumed` | `waits.consumed_at` 已写；不再 re-arm | recovery 只看未消费 outcome |

### 3.4 关键数据结构（与 clowder 对比）

| clowder | codeteam | 立场 | 关键差异 |
|---|---|---|---|
| `ActionSuccessorIdentity`（tenant+subject+family+slot） | `canonical_action_key` + 四列 | `reuse now` | canonical key 用 U+001F 分隔；partial unique live index |
| `ActionSuccessorLease`（leaseId/generation/status/holders） | `handoffs` row + `handoff_holder_claims` | `adapt now` | leaseId→handoff id；status→既有 5 态；single/parallel 都是 per-holder claim |
| `ActionSuccessorTerminalPredicate`（frozen digest/freshness） | `terminal_predicate_json` | `reuse now` | 每 generation frozen；freshness 变化→新 handoff 行 |
| `ActionCompletionCandidateSnapshot` | `completion_candidates_json[profileId]` | `reuse now` | candidate revision/digest；不落 terminal |
| `ActionCompletionVerdict` | `result_json.verdict` | `reuse now` | 只有 verified 能 commit；candidate digest 必须匹配 |
| `ActionSuccessorReturnTransition` / `ReplacementTransition` | `return_transitions_json` / `replacement_transitions_json` | `reuse now` | 持久化 from/to generation edge |
| `returnDeliveryState` / `dispatchDeliveryState` | 独立列 + attempt/SLA/failure refs | `adapt now` | 只做 transport recovery；不参与 claim/complete 授权 |
| `BallCustodyEvent`/`sourceEventId` | `custody_events` | `adapt now` | `id`=sourceEventId；`subject_ref=handoff:<id>`；同事务 append |
| `BallCustodyProjection` | W7 派生投影 | `drop store` | 不建 canonical projection 表；rebuild 只对账 |
| `UnifiedAwaitStateV1` | `waits` row per generation | `adapt now` | generation 一行；owner fence 独立列 |
| `WaitOutcomeV1` | `waits.outcome_json` + delivery 列 | `reuse now` | outcomeId 含 reason；delivery 独立 |
| `WaitTerminationEventV1` | `wait_terminations` | `adapt now` | append-only；user_cancel 严格 actor；disposition_ref 可选 |
| `WaitContinuationCarrierV1` | Queue/Message refs | `reuse now` | 只运输 waitId/outcomeId/ownerFence |
| managed-command DynamicTask state | `waits` + A1-3 execution projection | `adapt now` | lost→status message；condition_met→matched outcome；consumed→no re-wake |

**`handoff_holder_claims`（per-holder claim 子账本）**

| 列 | 说明 |
|---|---|
| `handoff_id` / `profile_id` | 复合主键；一个 handoff 的一个 holder 一行 |
| `generation` | 必须等于 `handoffs.generation`；旧 generation claim 不得复活 |
| `run_id` | 当前 claim 的 run；一个 active run 至多 claim 一个 handoff |
| `status` | `active` / `released` / `interrupted`；terminal handoff 不得新增 active |
| `claimed_at` / `lease_until` / `last_heartbeat_at` | claim slot 租约；不是 action custody TTL |
| `released_at` / `release_reason` | release/interrupt 的审计摘要；详细证据在 custody_events |

- claim 是 per-holder：single 只有一个 active row；parallel 每个 holder 各自一行。`handoffs.claimed_by_run_id` 只是 single-mode summary，不是 parallel 的 claim 真相。
- active claim 的 run 结束/崩溃时，先 release/interrupt 该 row，再写 holder outcome；其他 holder claim 不受影响。
- `handoff_complete` 必须找到 claimant profile + run 的 active claim；`handoff_return`（single）release 唯一 claim；`handoff_replace` 要求无 active claim。

**Handoff 行的关键新列**

| 列 | 说明 |
|---|---|
| `owner_user_id` | F167 tenant scope；从 `tasks.user_id` 派生/校验 |
| `subject_ref` | `pr:owner/repo#N` 或 `subject:<ns>:<id>`；`subject` 仍存人读文本 |
| `action_family` / `successor_slot` / `mode` / `parallel_intent` | action custody 形状；非 action handoff 可空 |
| `canonical_action_key` | tenant+subject+family+slot；live partial unique |
| `holder_profile_ids_json` / `holder_thread_id` | exact holders；catId→AgentProfile |
| `predecessor_profile_id` / `predecessor_thread_id` | return/fresh revision 路由 |
| `claim_origin` / `issuer_standing_evidence_ref` | structured_transfer / existing_standing |
| `generation` / `revision` | custody 代际 / CAS 修订号 |
| `claimed_by_run_id` / `claimed_at` / `claimed_lease_until` / `last_heartbeat_at` | single-mode claim summary；parallel 以 `handoff_holder_claims` 为准 |
| `dispatch_id` / `dispatch_delivery_*` | carrier admission/recovery；不重复 Queue 正文 |
| `terminal_predicate_json` | frozen typed predicate |
| `completion_candidates_json` / `holder_outcomes_json` | per-profile candidate/terminal outcome |
| `return_transitions_json` / `replacement_transitions_json` | 合法 supersession 证据 |
| `return_delivery_*` | pending/overdue/delivered + attempt/SLA |
| `terminal_actor_ref` / `terminal_reason` / `terminal_evidence_ref` | consumed/withdrawn/expired 的 actor 与 proof |

#### 3.4.3 §12.2 回写清单

**1. `handoffs`：补 F167 custody 列 + live identity 约束**

```sql
handoffs(
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  stage_id TEXT REFERENCES stages(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  from_role TEXT NOT NULL REFERENCES roles(id),
  to_role TEXT NOT NULL REFERENCES roles(id),
  status TEXT NOT NULL CHECK (status IN ('pending','claimed','consumed','withdrawn','expired')),
  subject TEXT NOT NULL,
  subject_ref TEXT CHECK (subject_ref IS NULL OR subject_ref LIKE 'pr:%' OR subject_ref LIKE 'subject:%'),
  action_family TEXT CHECK (action_family IS NULL OR action_family IN ('review','merge','investigate','implement','verify','vision_guard')),
  successor_slot TEXT CHECK (successor_slot IS NULL OR successor_slot IN ('reviewer','merge_owner','investigator','implementer','verifier','vision_guardian')),
  mode TEXT CHECK (mode IS NULL OR mode IN ('single','parallel')),
  parallel_intent TEXT,
  owner_user_id TEXT NOT NULL,
  canonical_action_key TEXT,
  holder_profile_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(holder_profile_ids_json)),
  holder_thread_id TEXT,
  predecessor_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL,
  predecessor_thread_id TEXT,
  claim_origin TEXT CHECK (claim_origin IS NULL OR claim_origin IN ('structured_transfer','existing_standing')),
  issuer_standing_evidence_ref TEXT,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  dispatch_id TEXT,
  terminal_predicate_json TEXT CHECK (terminal_predicate_json IS NULL OR json_valid(terminal_predicate_json)),
  completion_candidates_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(completion_candidates_json)),
  holder_outcomes_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(holder_outcomes_json)),
  return_transitions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(return_transitions_json)),
  replacement_transitions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(replacement_transitions_json)),
  return_delivery_state TEXT CHECK (return_delivery_state IS NULL OR return_delivery_state IN ('pending','overdue','delivered')),
  return_delivery_evidence_ref TEXT,
  return_delivery_attempt_count INTEGER NOT NULL DEFAULT 0,
  return_delivery_sla_until INTEGER,
  return_delivery_last_attempt_at INTEGER,
  return_delivery_overdue_observed_at INTEGER,
  dispatch_delivery_state TEXT CHECK (dispatch_delivery_state IS NULL OR dispatch_delivery_state IN ('pending','delivered','failed')),
  dispatch_delivery_attempt_count INTEGER NOT NULL DEFAULT 0,
  dispatch_delivery_last_attempt_at INTEGER,
  dispatch_delivery_reservation_json TEXT CHECK (dispatch_delivery_reservation_json IS NULL OR json_valid(dispatch_delivery_reservation_json)),
  dispatch_delivered_message_id TEXT,
  dispatch_failure_reason TEXT,
  dispatch_failure_evidence_ref TEXT,
  terminal_actor_ref TEXT,
  terminal_reason TEXT,
  terminal_evidence_ref TEXT,
  expected_artifact TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  idempotency_key TEXT,
  reply_to TEXT,
  deadline INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  claimed_by_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  claimed_at INTEGER,
  claimed_lease_until INTEGER,
  last_heartbeat_at INTEGER,
  terminal_at INTEGER,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at INTEGER NOT NULL,
  CHECK (action_family IS NULL OR (subject_ref IS NOT NULL AND successor_slot IS NOT NULL AND mode IS NOT NULL AND canonical_action_key IS NOT NULL AND holder_thread_id IS NOT NULL AND claim_origin IS NOT NULL AND issuer_standing_evidence_ref IS NOT NULL AND terminal_predicate_json IS NOT NULL AND dispatch_id IS NOT NULL)),
  CHECK (mode <> 'parallel' OR (parallel_intent IS NOT NULL AND length(trim(parallel_intent)) > 0)),
  CHECK (action_family IS NULL OR json_array_length(holder_profile_ids_json) >= 1),
  CHECK (mode <> 'single' OR json_array_length(holder_profile_ids_json) = 1),
  CHECK (mode <> 'parallel' OR json_array_length(holder_profile_ids_json) >= 2),
  CHECK (mode <> 'single' OR status <> 'claimed' OR (claimed_by_run_id IS NOT NULL AND claimed_at IS NOT NULL AND claimed_lease_until IS NOT NULL)),
  CHECK (status <> 'consumed' OR (terminal_at IS NOT NULL AND result_json IS NOT NULL AND (action_family IS NULL OR terminal_evidence_ref IS NOT NULL))),
  CHECK (status <> 'withdrawn' OR (terminal_at IS NOT NULL AND terminal_reason IS NOT NULL)),
  CHECK (status <> 'expired' OR (terminal_at IS NOT NULL AND terminal_reason IS NOT NULL))
);

CREATE UNIQUE INDEX idx_handoffs_live_identity ON handoffs(canonical_action_key)
  WHERE canonical_action_key IS NOT NULL AND status IN ('pending','claimed');
CREATE UNIQUE INDEX idx_handoffs_idempotency ON handoffs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_handoffs_task_status ON handoffs(task_id, status, created_at);
CREATE INDEX idx_handoffs_recovery ON handoffs(status, dispatch_delivery_state, return_delivery_state, last_heartbeat_at);

-- per-holder claim 子账本；handoffs.status=claimed 由至少一条 active claim 派生
handoff_holder_claims(
  handoff_id TEXT NOT NULL REFERENCES handoffs(id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active','released','interrupted')),
  claimed_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL CHECK (lease_until > claimed_at),
  last_heartbeat_at INTEGER,
  released_at INTEGER,
  release_reason TEXT,
  PRIMARY KEY (handoff_id, profile_id),
  CHECK (status = 'active' OR released_at IS NOT NULL),
  CHECK (status <> 'active' OR released_at IS NULL)
);

CREATE UNIQUE INDEX idx_holder_claims_one_active_run ON handoff_holder_claims(run_id)
  WHERE status='active';
CREATE INDEX idx_holder_claims_recovery ON handoff_holder_claims(status, lease_until);
```

- `canonical_action_key = owner_user_id + U+001F + subject_ref + U+001F + action_family + U+001F + successor_slot`；四个分量都拒绝 U+001F。
- `owner_user_id` 由 `tasks.user_id` 校验/回填；`terminal_predicate_json` 的形状（kind/digest/freshnessKey）由应用层 + contract test 校验，SQL 只校验 JSON 合法。
- `action_family IS NULL` 的行是既有非 action handoff（如普通 question）；它们不参与 live identity，不升级成 action custody。
- `from_role/to_role` 仍是 SOP actionPair 白名单；`holder_profile_ids_json` 是 exact custody holders。parallel 的 `to_role` 是共享角色，不是单 holder。
- `claimed_lease_until`/`last_heartbeat_at` 只服务 claim slot；action custody 本身 TTL=0，不因时间自动过期。
- `handoff_holder_claims` 是 per-holder claim 真相；`handoffs.status='claimed'` 只在存在 active claim 时成立。SQL 无法跨表 CHECK，`status` 由应用在同一 `BEGIN IMMEDIATE` 事务维护，contract test 校验 `status='claimed' ⇔ EXISTS(active claim)`；single mode 额外要求 `claimed_by_run_id` summary。
- `terminal_predicate_json` 每 generation frozen；freshness key 变化必须新建 handoff 行，不能原地改 predicate。
- `replacement_transitions_json` 的每条 edge 必须带 from/to generation、holders、from holder outcomes、evidence，以及 from/to predicate digest/freshness key；否则无法证明跨 generation 的 predicate/holder 变化合法。
- `predecessor_profile_id` 只接受 AgentProfile；return 目标如果是 operator/human（无 profile），不得伪造 profile，直接 409，正确路径是 withdraw + `approval_request`。
- `result_json` 只存 terminal result/evidence 摘要，不复制 artifact 正文。

**2. `custody_events`：handoff custody 审计**

```sql
custody_events(
  id TEXT PRIMARY KEY,
  subject_ref TEXT NOT NULL CHECK (subject_ref LIKE 'handoff:%'),
  handoff_id TEXT NOT NULL REFERENCES handoffs(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  seq INTEGER NOT NULL CHECK (seq > 0),
  classification TEXT NOT NULL CHECK (classification IN ('state-changing','informational')),
  kind TEXT NOT NULL CHECK (kind IN (
    'handoff.created','handoff.dispatched','handoff.claimed','handoff.returned','handoff.replaced',
    'handoff.completion_candidate','handoff.completed','handoff.parallel_unfinished',
    'handoff.withdrawn','handoff.expired','handoff.recovered'
  )),
  actor_ref TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  ts INTEGER NOT NULL,
  UNIQUE (subject_ref, seq)
);

CREATE TRIGGER custody_events_no_update BEFORE UPDATE ON custody_events
BEGIN SELECT RAISE(ABORT, 'custody_events is append-only'); END;
CREATE TRIGGER custody_events_no_delete BEFORE DELETE ON custody_events
BEGIN SELECT RAISE(ABORT, 'custody_events is append-only'); END;
```

- `subject_ref = 'handoff:<id>'`；`seq` 在同一 `BEGIN IMMEDIATE` 事务内 `MAX(seq)+1`，保证 per-handoff 顺序。
- `generation` 是该事件所属 custody 代际；recovery/对账必须用 `(handoff_id,generation)` 精确匹配，不能只看 handoff 当前 generation。
- `classification` 复用 F233 语义：`handoff.parallel_unfinished`/delivery 观察是 informational，其余 custody 迁移是 state-changing；informational 事件不改 handoff 状态。
- `id` 是 sourceEventId；exact retry 命中同 id/payload → replay；同 id 不同 payload → 409。
- `custody_events` 不承载 wait 事件；wait 的 canonical 事件在 `wait_terminations`。两个 append-only 日志各归一个责任对象，不合并成新球 ID。
- `handoff.parallel_unfinished` 只在 DP-A3-1-1=A 时写，记录“first success 后仍有 holder 未终态”的观察事实，不改变授权。
- 若 DP-A3-1-1 最终选 B，`handoff.parallel_unfinished` 是死枚举，必须从 CHECK 删除或改名 `handoff.holder_lagging` 观察；不得保留 A-only 语义。

**3. `waits`：per-generation F280 wait**

```sql
waits(
  id TEXT PRIMARY KEY,
  wait_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  subject_ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('timer','event','managed_command')),
  wait_source_ref TEXT NOT NULL,
  expected_signal TEXT,
  baseline_json TEXT NOT NULL CHECK (json_valid(baseline_json)),
  continuation_json TEXT NOT NULL CHECK (json_valid(continuation_json)),
  owner_fence_json TEXT NOT NULL CHECK (json_valid(owner_fence_json)),
  status TEXT NOT NULL CHECK (status IN ('active','terminalized')),
  expires_at INTEGER,
  auto_renew INTEGER NOT NULL DEFAULT 1 CHECK (auto_renew IN (0,1)),
  sla_until INTEGER NOT NULL,
  outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
  outcome_delivery TEXT CHECK (outcome_delivery IN ('pending','delivered','suppressed','not_applicable','legacy_unfenced','queue_conflict')),
  publish_claimed_at INTEGER,
  consumed_at INTEGER,
  approval_id TEXT UNIQUE REFERENCES approvals(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  terminalized_at INTEGER,
  CHECK (length(trim(wait_source_ref)) > 0),
  CHECK (id = 'wait:' || wait_id || ':g' || generation),
  CHECK (kind <> 'timer' OR expires_at IS NOT NULL),
  CHECK (kind <> 'event' OR (expected_signal IS NOT NULL AND length(trim(expected_signal)) > 0)),
  CHECK (status <> 'terminalized' OR (outcome_json IS NOT NULL AND outcome_delivery IS NOT NULL AND terminalized_at IS NOT NULL)),
  CHECK (status <> 'active' OR (outcome_json IS NULL AND outcome_delivery IS NULL AND terminalized_at IS NULL)),
  CHECK (approval_id IS NULL OR auto_renew = 0),
  UNIQUE (wait_id, generation)
);

CREATE UNIQUE INDEX idx_waits_one_active ON waits(wait_id) WHERE status='active';
CREATE INDEX idx_waits_delivery ON waits(status, outcome_delivery, created_at);
CREATE INDEX idx_waits_owner ON waits(subject_ref, status);
```

- `id = 'wait:' || wait_id || ':g' || generation`；`wait_id` 是 series。`owner_fence_json` 必须精确是 `containing_task` 或 `action_successor`，不能从 task 当前字段重建。
- `expected_signal` 是 typed predicate 的稳定摘要（kind/digest）；完整 bounded any-of 在 `continuation_json.when[]`，两者必须匹配。
- `auto_renew=1`：matched 时同事务 terminalize gN + insert gN+1 active；`auto_renew=0` 是显式 single-fire（如 deployment wait）。
- `expires_at` 缺省 = 无时间终止；`sla_until` 仍是必填的观察/诊断预算，不是 action custody deadline。
- `outcome_delivery=legacy_unfenced` 只用于迁移时缺 owner fence 的旧 wait：no message、no queue、no wake；不猜测 authority。
- `publish_claimed_at` 是 outcome publish 的独占 claim：写后 delivery 仍为 `pending`，旧读者仍视为可投递；进程在 claim 后崩溃可重新 claim，同 outcomeId 收敛到同一 Queue 行，不产生第二唤醒。
- `approval_id` 1:1 绑定 A2-3 effect receipt：`effect_reservation_ref` 在 claim 时预分配为这个 wait row id；`created_at > decided_at`；同一 wait 只能回指一个 approval。一个 approval 至多一个 wait row；materialization retry 复用同一 wait，不铸造第二个 receipt。

**4. `wait_terminations`：canonical wait 终止事件**

```sql
wait_terminations(
  event_id TEXT PRIMARY KEY,
  wait_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  wait_kind TEXT NOT NULL CHECK (wait_kind IN ('timer','event','managed_command')),
  reason TEXT NOT NULL CHECK (reason IN ('matched','subject_terminal','expired','owner_changed','superseded','user_cancel')),
  actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
  subject_ref TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  owner_profile_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  disposition_ref TEXT,
  UNIQUE (wait_id, generation),
  FOREIGN KEY (wait_id, generation) REFERENCES waits(wait_id, generation) ON DELETE RESTRICT,
  CHECK (reason <> 'user_cancel' OR (json_extract(actor_json,'$.kind') = 'user' AND json_extract(actor_json,'$.userId') = owner_user_id))
);

CREATE TRIGGER wait_terminations_no_update BEFORE UPDATE ON wait_terminations
BEGIN SELECT RAISE(ABORT, 'wait_terminations is append-only'); END;
CREATE TRIGGER wait_terminations_no_delete BEFORE DELETE ON wait_terminations
BEGIN SELECT RAISE(ABORT, 'wait_terminations is append-only'); END;
```

- `event_id` 是 canonical `wait.terminated` 幂等键；同 `(wait_id,generation)` 只能有一个终止事件。
- `wait_kind` 是终止事件自带的 domain 形状（timer/event/managed_command），必须与 `waits.kind` 一致；event 行不依赖 join 才能解释自己。
- `wait_terminations` 是 terminal fact 的 canonical 事件；`waits.outcome_json` 是它在该 generation 上的可重建投影。active generation 的真相仍在 `waits`；terminal 后不要只凭 row 猜 event。
- user_cancel 必须 `actor.kind='user'` 且 `actor.userId=owner_user_id`；应用层再校验 thread/owner。
- `disposition_ref` 是 F281 可选接缝；v1 可以为 null，termination event 不存 why 正文。
- wait outcome 与该 event 同事务写；不要把 event 当第二状态，`waits.outcome_json` 是当前 generation 的投影。

**5. Queue / Message 接缝**

- `queue_entries.fence_refs_json` 只存 `{handoff:{id,generation,dispatchId}}` 或 `{wait:{waitId,generation,outcomeId,ownerFence}}`；A1-3 已定义，本卡不复制 fence 正文。
- `messages.control_ref` 可指 `handoff:<id>`；wait wake 的 immutable carrier 由 `source.meta.waitContinuationCarrier` 携带 `WaitContinuationCarrierV1`，Queue/Invocation 只复制/核对，不拥有。
- `messages.rich_blocks_json` 不含 handoff/wait 的授权真相；聊天卡只做导航，不能替代 custody。

**6. 迁移/回滚顺序**

1. additive 加 `handoffs`/`waits` 列与三张新表（`handoff_holder_claims`/`custody_events`/`wait_terminations`）；旧行 `action_family=null`、`canonical_action_key=null`，不伪造 action custody。
2. 旧 `waits` 回填 `wait_id=旧 id`、`generation=1`、`id='wait:<wait_id>:g1'`；有 exact owner fence 的才保持 `active`，否则迁移为合成的 `terminalized` outcome（`reason='owner_changed'`、`delivery='legacy_unfenced'`、`nextStep='legacy_unfenced'`），不投递、不唤醒。
3. 旧 single-mode `status='claimed'` handoff 若 `claimed_by_run_id` 的 recipient profile 可唯一解析，回填一条 active `handoff_holder_claims`（generation/lease/heartbeat 从 handoff 取）；profile 缺失/歧义则迁移失败并报 operator，不猜。旧 parallel handoff 不存在 pre-A3 数据。
4. 建 live partial unique index 前做重复检查；冲突不自动合并，报 operator。
5. 回滚到 W1 基线：删除新表/新列/新索引；`handoff_holder_claims`/`custody_events`/`wait_terminations` 不迁移回 clowder；`queue_entries.fence_refs_json` 可保留为 transport-only。

### 3.5 变量定义表

#### contract

| 变量 | 类型 | 默认/值域 | owner | clowder 来源 | 决定 | 说明 |
|---|---|---|---|---|---|---|
| `HandoffId` | TEXT | opaque | ball-custody | `ActionSuccessorLease.leaseId` | `rename` | F167 leaseId 映射为 handoff id |
| `CanonicalActionKey` | TEXT | tenant+subject+family+slot | ball-custody | `ActionSuccessorIdentity.key` | `reuse` | U+001F 分隔；live partial unique |
| `SubjectRef` | TEXT | `pr:owner/repo#N` / `subject:ns:id` | ball-custody | `action-subject-ref.ts` | `reuse` | 不接受 GitHub URL/SHA 后缀 |
| `ActionFamily` | enum | review/merge/investigate/implement/verify/vision_guard | ball-custody | `packages/shared/src/types/action-successor.ts:4` | `reuse` | slot 白名单由 catalog 校验 |
| `SuccessorSlot` | enum | reviewer/merge_owner/investigator/implementer/verifier/vision_guardian | ball-custody | `packages/shared/src/types/action-successor.ts:13` | `reuse` | 与 family 配对 |
| `Generation` | INTEGER | >0 | ball-custody | `ActionSuccessorLease.generation` | `reuse` | replace/return/fresh revision 递增 |
| `TerminalPredicate` | JSON | kind+identityKey+freshnessKey+digest | ball-custody | `packages/api/src/domains/ball-custody/ActionTerminalPredicateCatalog.ts:46` | `reuse` | 每 generation frozen |
| `CompletionCandidate` | JSON | evidenceRefs+revision+digest | ball-custody | `packages/api/src/domains/ball-custody/action-successor-completion-state-machine.ts:73` | `reuse` | 不落 terminal |
| `HolderOutcome` | JSON | succeeded/failed/canceled/unavailable/rejected_ownership | ball-custody | `packages/api/src/domains/ball-custody/action-successor-state-machine.ts:88` | `reuse` | 首个 terminal outcome 生效 |
| `WaitOwnerFence` | JSON | containing_task/action_successor + generation | ball-custody | `packages/shared/src/types/wait-contract.ts:3` | `reuse` | 不可从 mutable task 重建 |
| `AwaitContinuation` | JSON | `{when[],then}` + baseline | ball-custody | `packages/shared/src/types/wait-contract.ts:25` | `reuse` | `when` bounded any-of |
| `WaitOutcome` | JSON | outcomeId+reason+delivery+ownerFence | ball-custody | `packages/shared/src/types/wait-contract.ts:60` | `reuse` | outcomeId 含 generation/reason |
| `WaitContinuationCarrier` | JSON | waitId+outcomeId+ownerFence | ball-custody/dispatch | `packages/shared/src/types/wait-contract.ts:18` | `reuse` | Queue/Message 只运输 |
| `CustodyEvent` | row | id+subject+seq+kind+actor+payload | ball-custody | `packages/shared/src/types/ball-custody.ts:49` | `adapt` | 只审计 handoff custody |
| `HandoffStatus` | enum | pending/claimed/consumed/withdrawn/expired | ball-custody | 0001 §5.2 | `reuse` | 唯一状态机；replaceable 派生 |

#### state

| 变量 | 状态机/约束 | owner | 失败语义 |
|---|---|---|---|
| `handoffs.status` | terminal 优先；否则有 active holder claim→claimed，无 active claim→pending；terminal 不重置 | ball-custody | 非法迁移 409；late complete 拒绝；cache 与 claim 表由 contract test 对账 |
| `handoff_holder_claims.status` | active→released/interrupted；同 holder 一行，run_id 可换代 | ball-custody | 同 profile 不同 run → safe_wait；terminal handoff 新增 active → 409 |
| `handoffs.canonical_action_key` | 同 key 至多一个 pending/claimed | ball-custody | 冲突 → safe_wait/409；不双写 |
| `handoffs.generation` | replace/return/fresh revision 递增；同 generation 不可跨 holder 猜 | ball-custody | stale generation → 409；旧 fence 不执行 |
| `handoffs.revision` | 每次 CAS +1；claim/complete/return/replace 用 expected revision | ball-custody | revision mismatch → 409/retry |
| `handoffs.terminal_predicate_json` | 每 generation frozen；freshness 变化→新行 | ball-custody | predicate mismatch → 422/409；不原地改 |
| `handoffs.completion_candidates_json` | per holder；candidate 变更使旧 verdict 失效 | ball-custody | digest/revision mismatch → insufficient |
| `handoffs.holder_outcomes_json` | 首个 terminal outcome 生效；parallel 独立 | ball-custody | 重复 outcome → idempotent/reject；不覆盖 |
| `handoffs.dispatch_delivery_state` | pending→delivered/failed；reservation 防双投递 | ball-custody | 失败保持 pending；不伪造 delivered |
| `handoffs.return_delivery_state` | pending→overdue→delivered | ball-custody | 不 delivered 不丢 custody；sweep 重投 |
| `waits.status` | active→terminalized；同 series 至多一个 active | ball-custody | 双 active → 409；owner change 先 terminalize |
| `waits.generation` | match/expiry 只影响 exact generation；auto-renew 同事务 +1 | ball-custody | stale generation → inactive；不消费旧 outcome |
| `waits.owner_fence_json` | exact containing_task/action_successor；change 即 terminalize | ball-custody | missing/legacy → `legacy_unfenced`，no wake |
| `waits.outcome_delivery` | pending→delivered/suppressed/not_applicable/queue_conflict | ball-custody | 非 pending 不重复投递；同 outcomeId replay |
| `waits.consumed_at` | 只由 one-shot CAS 写；写后不再 consume | ball-custody | 二次 consume → replay/409 |
| `wait_terminations` | 每个 `(wait_id,generation)` 唯一；append-only | ball-custody | 冲突 → 409；不覆盖真相 |
| `custody_events` | 每 handoff seq 单调；append-only | ball-custody | 重复 id 幂等；同 id 异 payload 409 |

#### config

| 变量 | 默认 | owner | 决定 | 说明 |
|---|---|---|---|---|
| `CODETEAM_HANDOFF_CLAIM_LEASE_MS` | 60000 | ball-custody | `new` | claim slot 租约，不是 action custody TTL |
| `CODETEAM_HANDOFF_HEARTBEAT_MS` | 10000 | ball-custody | `new` | claim 心跳；stale 只产 candidate。与 W5 worker lease 由同一 worker 主循环一次发射两类续期，不接进 agent turn |
| `CODETEAM_RETURN_DELIVERY_SLA_MS` | 60000 | ball-custody | `reuse` | 对齐 F167 S.1-c；overdue 只告警，不丢 custody |
| `CODETEAM_WAIT_WAKE_SLA_MS` | 60000 | ball-custody | `reuse` | managed-command completion→wake 的观察预算 |
| `CODETEAM_CUSTODY_SWEEP_LIMIT` | 100 | ball-custody | `new` | boot/periodic recovery 批量上限 |
| `CODETEAM_CUSTODY_OBSERVE_ONLY_MS` | 900000 | ball-custody | `new` | pending/claimed 无事件的 zombie 观察阈值；不自动 fail |
| `CODETEAM_SQLITE_BUSY_TIMEOUT_MS` | 见 plans/0002 W1（唯一权威） | 全局 SQLite | `reference` | handoff/wait 事务使用；busy 重试一次后 503 |
| `CODETEAM_DATA_DIR` | 见 A1-1（唯一权威） | config | `reference` | 不在本卡重定义 |

#### security

| 变量/规则 | 值/来源 | owner | 失败语义 |
|---|---|---|---|
| `handoffCreatePrincipal` | authenticated run token / operator credential；actor 从 auth 派生 | ball-custody | body actor/role → 422；未认证 → 401 |
| `handoffClaimPrincipal` | 本次 dispatch target 的 holder profile + exact handoff/thread；claim run 的 recipient profile 必须是该 holder | ball-custody | 非 target/holder → 403；同 profile 不同 run → safe_wait；terminal/已 outcome → 409 |
| `handoffCompletePrincipal` | exact active holder claim 的 profile + run + generation；candidate evidence 由 server 校验 | ball-custody | 非 active claimant → 403；文本/queue/invocation ref 不作 completion evidence |
| `handoffReturnPrincipal` | single mode exact holder + holder thread；grounding evidence 必填 | ball-custody | holder mismatch → 409；parallel 只写 rejecting holder 的 `rejected_ownership`，不 return |
| `handoffReplacePrincipal` | operator 或 structured-transfer issuer；subject freshness 必须 verified | ball-custody | 非 replaceable/缺 proof → 409；普通 claim 拒绝 |
| `handoffWithdrawPrincipal` | author/operator；holder 不能自行 withdraw | ball-custody | 非 author/operator → 403；withdraw 先 release 所有 active claims；terminal 后不可复活 |
| `waitArmPrincipal` | exact task owner / action holder；owner fence 由 server 签发 | ball-custody | 缺 fence/跨 owner → 422/403 |
| `waitConsumePrincipal` | server-only；Queue admission 复验 owner/fence/expiry | dispatch/ball-custody | client 直接 consume → 403；stale → 409 |
| `waitCancelPrincipal` | trigger principal / thread collaborator / operator | ball-custody | collaborator 只读 summary；default thread exact userId；其他 → 403 |
| `managedCommandEvidence` | 只认 A1-3 execution projection 的 durable terminal evidence | dispatch/ball-custody | lost/ambiguous → status message + no success；不猜 |
| `legacyUnfencedWait` | 缺 exact owner fence 的历史 wait | ball-custody | `legacy_unfenced`；no message/queue/wake；不重建 authority |
| `lateTerminal` | consumed/withdrawn/expired 后迟到 complete/return/replace | ball-custody | 409/terminal_handoff；不重开 generation |
| `approvalEffectBinding` | blocker/budget wait 的 `approval_id` UNIQUE；created_at > decided_at | approval-index/ball-custody | 1:1 冲突/早于 decision → 拒绝 materialization |

#### observability

| 变量/事件 | 值/来源 | owner | 说明 |
|---|---|---|---|
| `handoff_created` | audit；id/task/subject/action/holders/generation | ball-custody | handoff_create 同事务 |
| `handoff_claimed` | audit；id/run/generation | ball-custody | claim 同事务 |
| `holder_claim_released` / `holder_claim_interrupted` | custody_events；handoff/profile/run/generation/reason | ball-custody | 单 holder claim 生命周期 |
| `handoff_sibling_runs_canceled_total` | counter | ball-custody | DP-A=A first success 后取消 sibling runs |
| `handoff_silent_holder_converged_total` | counter | ball-custody | DP-B 下沉默 holder 收敛为 unavailable |
| `handoff_completion_candidate` | custody_events；id/generation/holder/evidence digest | ball-custody | candidate 不 terminal |
| `handoff_completed` | custody_events + audit；id/generation/evidence ref | ball-custody | verified verdict 后 |
| `handoff_returned` / `handoff_replaced` | custody_events；from/to generation/edge | ball-custody | 合法 supersession 证据 |
| `handoff_withdrawn` / `handoff_expired` | custody_events；actor/reason | ball-custody | terminal |
| `return_delivery_overdue_total` | counter | ball-custody | pending→overdue |
| `dispatch_delivery_failed_total` | counter/reason | ball-custody | 不伪造 delivered |
| `wait_armed` / `wait_matched` / `wait_expired` / `wait_cancelled` / `wait_consumed` | audit + wait_terminations | ball-custody | 同事务 |
| `wait_outcome_pending_total` | gauge | ball-custody | terminalized+pending |
| `wait_outcome_suppressed_total` / `queue_conflict_total` | counter | ball-custody | 结算不是成功 |
| `managed_command_wake_sla_breach_total` | counter | ball-custody | 对齐 F280 |
| `custody_replay_mismatch_total` | counter | ball-custody | events vs handoffs/waits 对账偏差 |
| `late_terminal_rejected_total` | counter | ball-custody | late complete/return/replace |
| `custody_active_handoffs` / `custody_active_waits` | gauge | ball-custody | W7 只读 |

### 3.6 明确不做

- 不建第二套 custody store；`handoffs`/`waits` 是唯一责任真相，`custody_events`/`wait_terminations` 是 append-only 审计。
- `handoff_holder_claims` 是 `handoffs` 的 per-holder claim 子账本，不是第二 custody store；claim 与 `handoffs.status` 在同一事务维护。
- 不建 canonical `BallCustodyProjection` 表；W7/诊断派生只读投影，rebuild 只对账。
- 不恢复 F254 attention/closure/supplement/seenCursor/re-invoke/notice。
- 不实现文本 `@` 路由、`void_pass`、`ball.handed_cvo`、`frozen/degraded` 安乐死状态。
- 不把 human approval 塞进 handoff/wait；A2-3 `approvals` 是唯一 human gate。
- 不建第二 queue；`handoff`/`inbox` 是 `queue_entries` 的 typed source。
- 不在 wait 里存 command/cwd/output/secret；managed-command 正文归 A1-3 execution projection。
- 不让 agent 直接 consume wait 或 commit completion；server-owned resolver/CAS only。
- 不让 accepted approval 自动等于 wait 已消费；`waits.approval_id` 只证明 effect receipt。
- 不做跨项目/跨 tenant custody；`owner_user_id` 是硬隔离边界。
- 不做 F281 结构化 why；v1 `disposition_ref` 仅接缝。

### 3.7 DP-A3-1-1：parallel 首个 verified success 是否立即终结

| 选项 | 行为 | 取舍 |
|---|---|---|
| **A（推荐）** | 任一 holder verified success 立即 `consumed`；sibling claims release、sibling runs 由 control plane cancel；写 `handoff.parallel_unfinished` 观察事件 | 防止沉默 holder 挂住已完成 action；剩余 review 仍有事件证据，但不再授权 |
| B | clowder parity：所有 holder terminal 且任 success 才 `consumed`；否则 `replaceable`；沉默 holder 由 recovery 收敛 `unavailable` | 保留完整 parallel 聚合；一个无响应 holder 会延迟终结 |
| C | A + operator 可配置等待窗口 | 增加配置/时钟复杂度，v1 不建议 |

- 三猫表态：烁烁 A、砚砚 A、墨墨 B（2:1）；最终由 operator 拍板。
- 推荐 A：action success 是“责任已完成”，不是“所有并行意见到齐”；未到齐的事实应可见，但不能成为完成 gate。
- 若 operator 选 B：删除/改名 A-only 的 `handoff.parallel_unfinished`；W1 验收补“沉默 holder 回收 → all-terminal”测试；`handoff_silent_holder_converged_total` 必须可观测；§3.3A/§3.3B/风险表同步改写。
- 本卡其余部分按 A 写；B 只需替换终态条件与事件枚举。

### 3.7.1 DP-A3-1-2：v1 SOP stage → custody 映射

| 选项 | 映射 | 取舍 |
|---|---|---|
| **A（推荐，砚砚 P2-1）** | `impl`=普通 handoff（artifact 交付即 consumed）；`review`=action custody `review_delivered`；`merge`=A2-3 approval（A3-1 时点；`DP-MERGE-1=D` 后改为 daemon merge service，无 approval/handoff）；`verify`=普通 handoff/Phase C；`task_done` 保留但不自动配给 implement | 不让 impl custody 等 merge 完成；W1 可立即实现；代价是 impl 没有 typed predicate |
| B | `impl`=action custody `task_done` | 与 F167 task-backed custody 更一致；但 task_done 要等 merge，holder run 结束后 custody 会悬置到 merge，需 reattach/新 run 收口 |

- 推荐 A：codeteam 的 impl 交付是 diff + test report，不是 merge；task_done 的语义是 task 生命周期，不是 impl handoff。
- 若 operator 选 B，W1 必须补“impl handoff 在 merge 后由谁 reattach/complete”的责任路径；否则第一个 implement handoff 就会悬空。

### 3.7.2 DP-A3-1-3：operator 行首 @ 的 typed inbox 落点

| 选项 | 行为 | 取舍 |
|---|---|---|
| **A（推荐，墨墨 P2-2）** | daemon ingress 把 operator thread 行首 @（或 Console recipient picker）解析成 typed `inbox(humanGuidance|followUp)`；消息本体不改写 | operator 聊天习惯有真实落点；解析在 ingress，不伪造 custody |
| B | 只支持 Console recipient picker；line-start @ 不解析 | 实现更窄；operator 在 CLI/聊天框 @ 仍无入口 |

- 推荐 A，且不阻塞 A3-1 freeze：落点归 A2-1 inbox / A1-3 dispatch，W7a 功能清单补一行；A3-1 只声明“agent 正文 @ 不产生 custody”。

### 3.8 与 A2-3 effect owner 的边界

- `blocker`/`budget_pause` approval materialization 创建 exactly one `waits` row；`waits.approval_id` UNIQUE，`effect_reservation_ref` 等于该 wait row id，`created_at > decided_at`。
- `waits` 的 active/terminalized/consumed 是 effect 后续生命周期；`approvals.effect_ref` 只指向 wait row，不复制 wait outcome。
- wait 过期/取消不会自动 reopen approval；A2-3 的 resolution/materialization 仍由 operator/control plane 决定。
- `handoff` 不创建 approval；需要人审时，调用方另发 `approval_request`，`origin_ref` 指向 handoff message。
- `blocker` wait 的 predicate 是 blocker 解除事件（`expected_signal='blocker_resolved'` 或 exact external signal）；`budget_pause` wait 的 predicate 是 control-plane `budget_resumed` 事件（`auto_renew=0`）。没有对应 producer 时 W5 不得创建空转 wait，返回 422。

### 3.9 与 A1-3 / A3-2 的边界

- A1-3 拥有 `queue_entries`、claim、delivery、`fence_refs_json` 的运输；A3-1 只拥有 fence 正文和消费授权。
- Queue admission 在 provider start 前复验 handoff/wait 的 exact generation/owner fence；不把 Queue receipt 当 custody truth。
- A3-2 `bubble-pipeline` 只读投影 message/response bubble；不裁决 handoff/wait 状态。
- managed-command execution projection 归 A1-3/F295；A3-1 只消费它的 durable terminal evidence，不建第二执行账本。

### 3.10 operator 行首 @ 的 typed inbox 边界（墨墨 P2-2）

- **agent 正文 @ 不路由**：仍只记 `missing_a2a_tool_call` 观测，不产生 handoff/wait。
- **operator thread 行首 @（或 Console recipient picker）由 daemon ingress 解析成 typed `inbox(humanGuidance|followUp)`**；消息本体不改写，解析结果决定注入 active run 还是入队。该职责归 A2-1 inbox / A1-3 dispatch，A3-1 不接管。
- 这样 operator 的聊天 @ 习惯有真实落点，同时不会把文本 @ 伪造成 custody；`inbox` 的目标来源由 ingress 的 authenticated principal + recipient 决定，不由正文猜。

## 4. 风险与回滚

| 风险 | 级别 | 处置 |
|---|---|---|
| `handoffs` 与 `custody_events` 双真相 | P1 | handoffs/waits 是唯一 truth；events 同事务 append；replay 只对账告警，不反向写 |
| 同一 action identity 双 live handoff | P1 | `canonical_action_key` partial unique + claim CAS；冲突 safe_wait/409 |
| late complete 在 terminal 后重开 | P1 | terminal 行不重置；generation/revision fence；409 `terminal_handoff` |
| completion candidate 被当成功 | P1 | candidate 不 terminal；verified resolver + frozen digest；queue/invocation/response 不是 evidence |
| parallel 沉默 holder 挂住 action | P1 | DP-A3-1-1=A 推荐；`handoff.parallel_unfinished` 可见 |
| return carrier 丢失导致 custody 消失 | P1 | return_delivery pending/overdue + sweep 重投同一 fence；不新 generation |
| wait owner fence 从 mutable task 重建 | P1 | `owner_fence_json` 只从 canonical owner 签发；缺失 `legacy_unfenced` no wake |
| auto-renew 出现空档 | P1 | terminalize gN + insert gN+1 同事务；partial unique active |
| user cancel 与 wake 竞态产生 false cancel/after-cancel wake | P1 | reserve timer+managed delivery；先 commit termination；entered wake 409；commit 失败 release/re-arm |
| managed command lost 被报告成 success | P1 | lost → status message + expired outcome；no wake；execution evidence 归 A1-3 |
| duplicate wake/consume | P1 | outcomeId idempotent admission；one-shot `consumed_at` CAS；immutable conflict 409 |
| approval effect 与 wait 双计数 | P2 | `waits.approval_id` UNIQUE + `created_at > decided_at` + 1:1 reservation |
| F254 范围回流 | P2 | 明确 drop；不建 freshness/attention/closure 表；review 拒绝新增 |
| 文本 `@` 冒充 custody | P2 | typed tool only；`missing_a2a_tool_call` 只做观测；不产生 handoff/wait |
| 大 JSON/日志泄密 | P2 | payload bound；不存 command/cwd/output/secret；rich block 不做授权真相 |
| zombie/observability 被当控制态 | P3 | `parked/dead/zombie` 只读派生；claim/complete 只认 handoffs/waits |
| 高基数 metrics | P3 | 只按 kind/status/reason 聚合，不按 subject/handoff id 打标签 |

**回滚**：`handoffs` 新列、`waits` 新列、`custody_events`/`wait_terminations` 均为 additive；回滚到 W1 基线只需删除新表/新列/新索引。`queue_entries.fence_refs_json` 可保留为 transport-only；不迁移 clowder 历史 custody/attention。旧 wait 无 exact owner fence 时保持 `legacy_unfenced`，不猜测、不投递。

## 5. Review 与签字

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | handoff 状态机/CAS、generation/replace/return、W1 事务、Queue fence | accept；P3×3 已回写（sibling run cancel、reattach dispatch、W1 验收措辞） |
| 砚砚 | completion evidence、wait owner fence/cancel authority、fail-closed、late terminal | accept-with-modify；P2 SOP→custody 映射已加 §3.2.1/DP-A3-1-2；P3×3 已回写 |
| 墨墨 | operator 可见状态、W7 投影、wait outcome/recovery、DP-A3-1-1 取舍 | accept-with-modify；P1-1 per-holder claim 已改为 `handoff_holder_claims`；P2 枚举/挂点已回写；P2 operator @ 已登记 §3.10/DP-A3-1-3 |
| operator | A3-1 架构卡、DP-A3-1-1/2/3 | 已签：A/A/A（2026-10-25） |

> Review request `d9b81c9e-fe57-4e23-a77d-d6130308fd03`（2026-10-25，三猫）。Review 结论：2 accept / 1 accept-with-modify（烁烁/砚砚/墨墨），无 reject。P1-1 已修；P2/P3 已回写；DP-A3-1-1 2:1（A:A:B）。Operator 2026-10-25 拍 A/A/A。

> Operator 2026-10-25 拍：`DP-A3-1-1=A`、`DP-A3-1-2=A`、`DP-A3-1-3=A`。A3-1 冻结为 W1/W5/W7 契约。

**Findings disposition**

| # | 来源 | Finding | 处置 |
|---|---|---|---|
| P1-1 | 墨墨 | parallel 单槽 claim 与 ≥2 holders 互斥；第二个 holder 无法 claim；interrupted 会误弹整个 handoff | **已修**：新增 `handoff_holder_claims` per-holder 子账本；`handoffs.status` 派生；claim/complete/return/replace/recovery/security/observability/SQL 全部改写；§3.3A/§3.3B 同步 |
| P2-1 | 墨墨 | 0001/plans 旧 `custody_events.kind` 并存；`wait_terminations`/waits 重构无 plans 挂点 | **已回写**：0001 §4.3/§5.2/§12.2、plans/0002 W1、plans/0004 已更新；旧枚举删除 |
| P2-2 | 墨墨 | operator 行首 @ 在 thread chat 是 UX 死路；typed inbox 无落点 | **已登记**：§3.10 + DP-A3-1-3；归 A2-1/A1-3，W7a 补落点；不阻塞冻结 |
| P2-1 | 砚砚 | v1 缺 SOP stage → handoff kind/predicate 映射；implement 配 task_done 会悬置到 merge | **已加**：§3.2.1 + DP-A3-1-2；推荐 implement=普通 handoff、review=action custody |
| P3 | 烁烁 | consumed 时 sibling claimed runs 谁取消未写 | **已写**：§3.3B A 分支 control plane cancel sibling runs |
| P3 | 烁烁 | reattach 用同 dispatchId 还是新 attempt 未定 | **已定**：新 dispatch_id + attempt+1，generation 不变；§3.2#11 |
| P3 | 烁烁 | plans/0002 W1 task 17 旧措辞会把 lease-stale 判 expired | **已改**：claim stale+proof → pending；explicit deadline → expired |
| P3 | 砚砚 | collaborator cancel reason 映射未定义 | **已登记**：v1 单 operator 不可达；Phase C 多用户前补；§3.10/security |
| P3 | 砚砚 | budget_pause wait 在等什么未写 | **已登记**：DP packet 中列为 W5 语义待定；v1 不造空转 wait |
| P3 | 砚砚 | handoff heartbeat 与 worker heartbeat 发射统一 | **已写**：config 行注明同一 worker 主循环一次发射两类续期 |
| P3 | 墨墨 | predecessor_profile FK 让 operator issuer 无法 return | **已写**：非 profile return 目标 409，走 withdraw+approval_request |
| P3 | 墨墨 | B 下 `parallel_unfinished` 死枚举 | **已写**：DP-A3-1-1 条件处置；B 时删除/改名 |
| P3 | 墨墨 | `publish_claimed_at` 无解释 | **已写**：§3.4.3 waits 注 |
| P3 | 墨墨 | action_family CHECK vs catalog 开放集 | **已写**：§3.2.1 注 |
| P3 | 墨墨 | observability “值班”措辞 | **已改**：W7 只读 |

**Review 重点**

1. `handoffs` 作为唯一责任真相、`custody_events` 只做审计，是否真正避免双真相；replay 对账是否有足够证据。
2. 一个 action identity 同时最多一个 live handoff 的 partial unique + per-holder claim + CAS 是否覆盖 single/parallel claim/return/replace/fresh revision 的并发。
3. completion candidate→resolver→verified verdict 的边界是否足够；`task_done`/`review_delivered` 之外是否还有必须开放的 predicate。
4. wait 按 generation 一行、auto-renew 同事务、one-shot consume、owner fence 不可重建，是否完整覆盖 F280 的 expiry/owner change/user cancel。
5. managed-command recovery 只认 A1-3 execution evidence、lost 不伪造成功，是否与 A1-3/F295 边界一致。
6. DP-A3-1-1 选 A 还是 B；若选 B，W1 验收需补沉默 holder 回收测试。
7. DP-A3-1-2 的 SOP→custody 映射是否按推荐 A 定稿；DP-A3-1-3 的 operator @→inbox 是否进 W7a。
8. §12.2 diff 与 plans/0002 W1、plans/0004 W5/W7 挂点是否一致；有没有未排期的新范围。

**交卡前自检**

- [x] 组件图、数据流、状态机、存储/并发、失败恢复五段齐全。
- [x] 每个组件有 `reuse now` / `adapt now` / `drop` / `out-of-scope` / `defer` 立场。
- [x] 变量表覆盖 contract/state/config/security/observability 五层。
- [x] 代码锚点已 grep 核对；无代码的 F254 退役事实引用 feature/cell 文档。
- [x] 风险与回滚写清；安全变量写明失败语义。
- [x] §12.2 回写清单完整；W1/W5/W7 plan 挂点已核对。
- [x] 三猫 review（烁烁 accept / 砚砚 accept-with-modify / 墨墨 accept-with-modify；P1-1 已修，P2/P3 已回写）。
- [ ] operator 签字（待 DP-A3-1-1/2/3）。

[宪宪/deepseek-flash🐾]
