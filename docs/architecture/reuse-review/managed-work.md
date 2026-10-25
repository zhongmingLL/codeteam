---
title: "managed-work 架构复用检视"
doc_kind: architecture-review
status: approved
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
source_cell: managed-work
source_card: ../../reuse/managed-work.md
template: ../0004-reuse-architecture-review-plan.md
---

# managed-work 架构复用检视

## 1. 总结

| 项 | 结论 |
|---|---|
| clowder feature 范围 | F275 Phase A/B（WorkAdmission/WorkAttempt、SOP first-persist、bind-once executor、PR lifecycle 传播、TaskOutcomeEpisode 三分桶）；Phase C 多 attempt/terminal 仍 deferred。 |
| codeteam 复用总结 | **R1 identity 复用，Task/Run 映射**。复用 `WorkAdmission`/`WorkAttempt`/`ManagedWorkBinding` 契约与 ID 派生；Redis 多 key Lua→SQLite 单事务；catId→AgentProfile；TaskStore-private binding→同库私有表。 |
| codeteam W | W1（admission/attempt、first-persist 原子、run bind-once）；W5（`pr_tracking` task private binding、merge/revert/TaskOutcome refs）；A3-3（episode store）。 |
| 一句话 | `WorkAdmission` 是唯一 identity root；SOP first-persist 原子铸 `workId` + unbound attempt 1；执行者只 bind 一次；raw ID 只活在私有表，不进入 Task/Run 公共 DTO。 |
| 明确不含 | Phase C 多 attempt/terminal、用户可见 work 管理面、第二套 Task/Run/Queue、A3-3 episode store、GitHub PR tracking 实现、eval verdict、跨项目 issue/forge inbound。 |

**组件立场**

| 组件 | 立场 | codeteam 处理 |
|---|---|---|
| `WorkAdmission` / `WorkAttempt` / `ManagedWorkBinding` 类型 | `reuse now` | 字段对齐；`executorCatId`→`executorProfileId`；`attemptNumber` Phase B 只产 1 |
| `deriveWorkflowSopAdmissionIds` 派生 | `reuse now` | 同一 SHA-256 算法；从 owner + producer + backlog item 派生，不从 task/thread/run 派生 |
| SOP first-persist admission | `adapt now` | 与 A2-1 `workflow_sops` first insert 同一 SQLite 事务；不改 A2-1 状态机 |
| bind-once executor | `adapt now` | 在 A1-3 run cutover 事务内绑定；executor = `runs.recipient_profile_id`；strict owner auth |
| TaskStore-private binding | `adapt now` | `task_managed_work_bindings` 私有表；同库 FK 取代 Redis TTL/CAS；只允许 `pr_tracking` task |
| run private binding | `codeteam-new` | `run_managed_work_bindings` 私有表；不往 `runs` 加 raw 列 |
| TaskOutcome 三分桶 | `reuse now` | `managed_attributed / managed_unattributed / unmanaged_not_applicable`；episode store 归 A3-3 |
| Redis keys / Lua / TTL | `drop` | `work_admissions`/`work_attempts`/绑定表全部 SQLite；无 TTL |
| Phase C 多 attempt / terminal | `defer→Phase C` | Phase B 只 attempt 1；attempt 2/terminal evidence 归后续 |
| 用户可见 work 管理面 | `out-of-scope` | `TaskItem(kind='work')` 仍是唯一可选投影；workId 不进 UI/API |
| eval / verdict | `out-of-scope` | A3-3 `harness-eval` 消费 attribution；本卡不建 episode/verdict |
| GitHub PR tracking / issue inbound | `out-of-scope` | W8/A3 的 PR/issue 适配；本卡只定义 binding 接缝 |

## 2. clowder 架构

### 2.1 架构图

```text
WorkflowSop first-persist（HTTP PUT / callback POST）
        │  authenticated ownerUserId + backlogItemId
        ▼
WorkflowSopStore.upsert
        │  Lua CAS_UPSERT
        │  if key absent && development && stage != completion:
        │    SET admission + attempt 1（same script）
        ▼
Redis workflow:sop:{backlogItemId}
Redis managed-work:admission:{workId}
Redis managed-work:attempt:{attemptId}

Authenticated invocation
        │  strict owner auth + thread.backlogItemId + executorCatId
        ▼
resolveManagedWorkInvocationBinding
        │  WorkflowSopStore.bindManagedWorkAttempt
        │  no admission → unmanaged
        │  partial/mismatch → fail closed
        │  unbound → bind once; same → idempotent; different → conflict
        ▼
ManagedWorkBinding { workId, attemptId }
        │
        ├─► live TaskItem(kind='pr_tracking') private metadata
        │      keyed by taskId; persist/expire paired with task updatedAt+status
        │
        └─► CiCdRouter merge/revert evidence
               │  missing binding → managed_unattributed
               ▼
        TaskOutcomeEpisode { attribution, workId?, attemptId? }
```

### 2.2 数据流

1. **Admission**：SOP first-persist 时，route 已认证 `ownerUserId` 并解析 backlog item；store 在同一 Redis Lua 中看到 SOP key absent、`sopDefinitionId='development'`、`stage!='completion'`，原子写 `WorkAdmission` + 未绑定 executor 的 attempt 1。既有 SOP、非 development、completion SOP 不 retro-admit。
2. **Invocation bind**：只有 strict owner auth 的 admitted invocation、且 `thread.backlog_item_id = producer_ref` **或** `run.task.backlog_item_id = producer_ref`（覆盖未 dispatch 直接建 task 的路径）、run 是 primary implementer（v1 默认 `role='coder'`、`task.kind='work'`）才解析 admission；第一次绑定 executor，后续同 executor 幂等，换 executor 冲突；review/verify/其他 participant run 不绑 attempt 1，Phase C 再扩；普通聊天/开放探索无 binding。
3. **PR tracking**：`register_pr_tracking` 从 authenticated invocation 解析 `{workId, attemptId}`，把 private binding 存在 keyed by live `TaskItem(kind='pr_tracking').id` 的 TaskStore metadata；shared TaskItem 不含 raw ID。same-binding 幂等，missing 不变，different 冲突。
4. **Lifecycle evidence**：CiCdRouter 按 live PR anchor 读取 private binding；merge/revert 只传播该 binding；缺失进入 `managed_unattributed`，不按 thread recency 猜。
5. **TaskOutcome**：`TaskOutcomeEpisode` 记录三分桶；`managed_attributed` 必须同时有 `workId`+`attemptId`；另外两桶不得带 raw ID；verdict artifact/公开 HTTP 不暴露 raw ID。
6. **No terminal**：merge/test/验收只是 evidence；Phase B 不写 work 状态机、不自动 terminalize work/Episode。

### 2.3 状态机 / 生命周期

**A. Work admission / attempt**

```text
absent ──SOP first-persist──► admitted（workId + attempt 1，executor=null）
                                   │
                                   ├──authenticated invocation──► bound（executorProfileId）
                                   │                                  │
                                   │                                  └──same executor──► idempotent
                                   │                                  └──different──────► conflict 409
                                   │
                                   └──no admission / partial / mismatch──► unmanaged / fail closed
```

- `workId` 在 admission 时铸造；跨 thread/跨猫/跨 invocation 不变。
- attempt 1 在 admission 时不带 executor；只有 authenticated admitted invocation 可绑定一次。
- Phase B 只创建 attempt 1；attempt 2/换 executor 归 Phase C，当前 fail closed。
- admission/attempt TTL=0；SOP 删除不清 admission；重试返回同一身份。

**B. Private bindings**

```text
no binding ──first authenticated binding──► bound
     │                                        │
     │                                        ├──same binding──► idempotent
     │                                        └──different─────► conflict 409
     └──anchor delete──► binding delete（FK cascade）
```

- `task_managed_work_bindings` 只允许 live `pr_tracking` task；`run_managed_work_bindings` 只允许 authenticated admitted run。
- binding 不允许 update；同 binding 幂等，different 冲突；anchor 缺失删除 binding，不留孤儿。

**C. TaskOutcome attribution**

```text
managed_attributed      = workId + attemptId + valid binding
managed_unattributed    = primary implementer admitted-looking but binding missing/partial（coverage defect）
unmanaged_not_applicable = ordinary chat/exploration（no IDs）
unmanaged_not_applicable + reason='participant_phase_b' = review/verify/participant by design（no IDs）
```

- 三态互斥；`managed_attributed` 缺任一 ID 或 binding 不成立 → 拒绝造 episode。
- `managed_unattributed` 只留给 primary implementer 缺 binding；单独入账并暴露 coverage，不混入 task-level 分母。
- participant run 不产生 run-level episode；若需要展示，归 `unmanaged_not_applicable` + `reason='participant_phase_b'`（by design），不进 coverage。
- raw ID 只进 internal episode/evidence，不进 verdict artifact/公开 projection。

### 2.4 关键数据结构

```ts
// packages/shared/src/types/managed-work.ts:3
type WorkAdmissionProducerKind = 'workflow_sop_v1';

// :6
interface WorkAdmission {
  workId: string;
  ownerUserId: string;
  producerKind: 'workflow_sop_v1';
  producerRef: string;          // v1 = backlogItemId
  initialAttemptId: string;
  admittedAt: number;
}

// :16
interface WorkAttempt {
  attemptId: string;
  workId: string;
  attemptNumber: 1;             // Phase B only
  executorCatId: CatId | null;
  createdAt: number;
  executorBoundAt: number | null;
}

// :25 / :31
interface WorkflowSopAdmissionBundle { admission: WorkAdmission; attempt: WorkAttempt; }
interface ManagedWorkBinding { workId: string; attemptId: string; }
```

```ts
// packages/api/src/infrastructure/harness-eval/task-outcome/task-outcome-episode.ts:138
type TaskOutcomeAttribution =
  | 'managed_attributed'
  | 'managed_unattributed'
  | 'unmanaged_not_applicable';
```

### 2.5 Current truth 与代码路径

| # | 事实 | 代码锚点 |
|---|---|---|
| T1 | `WorkAdmission` 是 identity root；`producerRef` v1 = backlogItemId；`initialAttemptId` 预留 attempt 1 | `packages/shared/src/types/managed-work.ts:6` |
| T2 | `WorkAttempt` 在 admission 时 `executorCatId=null`，`attemptNumber=1` | `packages/shared/src/types/managed-work.ts:16`、`RedisWorkflowSopStore.ts:231`、`:242` |
| T3 | `workId`/`attemptId` 从 owner + `workflow_sop_v1` + backlogItemId 派生；attempt 从 workId+attempt+1 派生 | `packages/api/src/domains/cats/services/stores/redis-keys/managed-work-keys.ts:5`、`:9`、`:17`、`:19` |
| T4 | SOP first-create Lua 在 key absent、development、stage!=completion 时写 admission/attempt；completion 首次创建跳过 | `RedisWorkflowSopStore.ts:75`、`:93` |
| T5 | 既有 SOP 或 `incoming.version==1` 返回 existing，不 retro-admit | `RedisWorkflowSopStore.ts:65`、`:196` |
| T6 | `bindManagedWorkAttempt` 只绑定一次；missing admission→null；partial/mismatch fail closed；different executor→`ManagedWorkExecutorConflictError` | `packages/api/src/domains/cats/services/stores/redis/managed-work-attempt-binding.ts:11`、`:15`、`:18`、`:31`、`:44`、`:77`、`:78`、`:81` |
| T7 | invocation binding 只在 `ownerAuthProvenance='strict'` 且 thread 或 run.task 绑定到 backlog item 时解析；普通链路返回 undefined | `packages/api/src/domains/cats/services/agents/invocation/managed-work-invocation-binding.ts:6`、`:14`、`:24`、`:26`、`:39` |
| T8 | `WorkflowSopStore` port 有 `getManagedWorkAdmission` / `bindManagedWorkAttempt` | `packages/api/src/domains/cats/services/stores/ports/WorkflowSopStore.ts:29`、`:30` |
| T9 | live `pr_tracking` task 的 private binding 由 TaskStore-private metadata 持有；same binding 幂等、missing 不变、different 冲突 | `packages/api/src/domains/cats/services/stores/ports/TaskStoreContract.ts:195`、`:199`、`:226`、`RedisTaskStore.ts:339`、`:343`、`:417`、`:439` |
| T10 | TaskOutcomeEpisode 有 `attribution/workId/attemptId`；`managed_attributed` 必须两者齐全，其他桶不得带 ID | `packages/api/src/infrastructure/harness-eval/task-outcome/task-outcome-episode.ts:138`、`:153`、`:154`、`:155`、`:165`、`:167`、`:174` |
| T11 | TaskOutcomeEpisode SQLite 表已有 `attribution/workId/attemptId` 列 | `packages/api/src/infrastructure/harness-eval/task-outcome/task-outcome-store.ts:87`、`:93`、`:94`、`:95` |
| T12 | `normalizeEpisodeAttribution` 把非 `managed_attributed` 的 ID 清空；缺 ID 抛错 | `packages/api/src/infrastructure/harness-eval/task-outcome/task-outcome-attribution-store.ts:41`、`:43`、`:46` |
| T13 | F275 明确 admission 是 SOP first-persist side effect；Phase B 只 attempt 1；bind-once；raw ID 不进 TaskItem/API | `docs/features/F275-managed-work-admission-identity.md:124`、`:126`、`:133`、`:137`、`:139`、`:194`、`:196`、`:198` |
| T14 | 0001 已有 `tasks`/`runs`/`artifacts`/`reviews`/`merges`，没有 managed-work 私有表；`tasks(kind='pr_tracking')` 是 PR anchor | `codeteam/architecture/0001-codeteam-architecture-v1.md` §12.2、`:490` |
| T15 | A2-1 已签，`workflow_sops` first insert 与 `work_admissions`/`work_attempts` 同事务的接缝由 A2-1 §3.4.4 预留 | `codeteam/architecture/reuse-review/sop-bulletin.md` §3.4.4 |

### 2.5.1 上游已知缺口 → 本卡处置

| # | 上游缺口（实证） | 影响 | 本卡处置 |
|---|---|---|---|
| G1 | admission/attempt 用 Redis 多 key Lua；codeteam 无 Redis | 跨 key 原子性依赖 Lua | codeteam 用同一 SQLite 事务写 `workflow_sops` + `work_admissions` + `work_attempts` + audit；无部分提交 |
| G2 | `WorkAttempt.attemptNumber` 类型字面量 `1`；Phase C 多 attempt deferred | 不能换 executor/重试 attempt 2 | Phase B 只产 attempt 1；DB `CHECK (attempt_number >= 1)`，应用层只写 1；Phase C 再放开 |
| G3 | `executorCatId` 是 clowder cat 身份 | codeteam 没有 catId | 映射 `executor_profile_id = AgentProfile.id`；session/model 从 `runs.agent_session_id` join |
| G4 | TaskStore-private binding 在 Redis metadata，带 TTL/CAS 与 anchor 生命周期 | codeteam 同库可用 FK/事务 | `task_managed_work_bindings` 同库表 + `ON DELETE CASCADE`；drop TTL/CAS，binding 与 task 同事务写 |
| G5 | owner auth provenance 只在 strict 时 binding；compat/unknown 不绑定 | 非 strict 可能被误绑 | codeteam 复用 A1-2 `ownerAuthProvenance`；非 strict 返回 unmanaged，不推断 |
| G6 | TaskOutcomeEpisode 在 clowder 自己的 SQLite；codeteam A3-3 才建 episode store | 两处写 episode 会双源 | A2-2 只定义三分桶与 refs；A3-3 拥有 `task_outcome_episodes`，不复制 |
| G7 | raw `workId/attemptId` 若进 `TaskItem`/`Run` DTO 会泄漏 | 用户/API/MCP 看到内部身份 | 只进私有表；Task/Run/Queue/MCP/REST/Web/Community deny；contract tests |
| G8 | SOP delete 只删 SOP，不删 admission | 重新创建可能 mint 第二个身份 | codeteam admission TTL=0；SOP delete 不清 admission；确定性 ID 使重试/重建返回同一身份 |
| G9 | completion SOP first-create 跳过 admission；later stage change 不 retro-admit | 历史 completion 被误算 managed | codeteam 同规则；只 first insert + development + non-completion 触发 |
| G10 | `WorkflowSopStore.upsert` 的 first-create admission 与 CAS 在同一 Lua，但 JS 预读旧值 | 并发可能丢字段 | A2-1 已定为 SQL CAS；A2-2 的 admission 只在 `INSERT ... ON CONFLICT DO NOTHING` changes=1 时触发，事务内完成 |
| G11 | attempt 1 在 admission 时未绑定 executor；只有 authenticated invocation 可绑定 | 用 batonHolder/updatedBy 冒充 executor | codeteam 只接受 `runs.recipient_profile_id`（来自 A1-3 claim） + strict owner auth；body 字段拒绝 |
| G12 | binding 只按 live `pr_tracking` task ID；legacy `PrTrackingEntry` 只 backfill | 用旧 entry/thread 绑定会漂移 | codeteam 只认 `tasks.kind='pr_tracking'`；trigger/服务校验；legacy 不接入 |
| G13 | merge/test 只是 evidence，不是 terminal | 把 merge 当 work 完成 | codeteam Phase B 不建 work terminal；merge receipt 只带 binding refs，不 terminalize |
| G14 | `managed_unattributed` 必须单独入账，不能静默丢 | 归属失败污染分母/静默消失 | A3-3 episode 三分桶；A2-2 提供 binding 缺失事实；metrics/health 单独计 |
| G15 | admission 与 attempt 部分写会留下 partial bundle | bind 时无法判断 | 同一事务写两者；读时 partial/mismatch fail closed；health 检查孤儿 |

## 3. codeteam 架构

### 3.1 架构图

```text
SOP first-persist（A2-1）
  workflow_sops INSERT ... ON CONFLICT DO NOTHING
        │ changes=1 && development && stage != completion
        ▼
  work_admissions + work_attempts + audit  ── 同一 SQLite 事务

Run cutover（A1-3）
  claim Queue Entry → runs INSERT
        │  strict owner auth + thread.backlogItemId + recipient_profile_id
        ▼
  bind-once attempt (UPDATE ... WHERE executor_profile_id IS NULL)
  run_managed_work_bindings INSERT  ── 同一 cutover 事务
        │ conflict/partial → cutover fail closed
        ▼
  run starts

PR tracking（W5）
  register_pr_tracking → tasks(kind='pr_tracking') INSERT
        │  invocation has binding
        ▼
  task_managed_work_bindings INSERT  ── 同一事务；FK cascade on task delete
        │
        └─► merge/revert evidence reads binding
               │ missing → managed_unattributed
               ▼
        A3-3 task_outcome_episodes { attribution, work_id, attempt_id }

Public projections:
  Task / Run / Queue / MCP / REST / Web / Community  ──✗ raw workId/attemptId
```

### 3.2 数据流

1. **First-persist admission**：A2-1 `workflow_sops` first insert 成功后，同一事务计算 `workId`/`attemptId`；`INSERT work_admissions ... ON CONFLICT DO NOTHING` + `INSERT work_attempts ... ON CONFLICT DO NOTHING`；校验已存在行与派生 ID 一致；audit `work_admitted`。失败整体回滚。
2. **Run bind**：A1-3 cutover 事务里，若 `thread.backlog_item_id = producer_ref` **或** `run.task.backlog_item_id = producer_ref`、strict owner auth、且 run 是 primary implementer（v1 默认 `role='coder'`、`task.kind='work'`），读 admission/attempt；`UPDATE work_attempts SET executor_profile_id=?, executor_bound_at=? WHERE attempt_id=? AND executor_profile_id IS NULL`；rowcount=1 → bound；0 → 同 profile 幂等/不同 profile 409/partial fail closed；insert `run_managed_work_bindings`。run 与 binding 同事务提交。review/verify/其他 participant run 不绑，避免不同 profile 撞 attempt 1。
3. **Task/PR binding**：W5 `register_pr_tracking` 创建 live `tasks(kind='pr_tracking')` 时，若 invocation 有 binding，insert `task_managed_work_bindings`；same idempotent/missing no-op/different conflict；task 与 binding 同事务。
4. **Merge/revert evidence**：W5 CiCdRouter 按 live `pr_tracking` task ID 读 binding；命中则 evidence 带 `workId/attemptId`；缺失 → `managed_unattributed`；冲突 → fail closed；不按 thread/recency 推断。
5. **TaskOutcome**：A3-3 创建 episode 时从 run/task binding 取 attribution；`managed_attributed` 必须双 ID + binding 有效；`managed_unattributed` 不带 ID；`unmanaged_not_applicable` 不带 ID。
6. **Public**：Task/Run/Queue/MCP/REST/Web/Community 的 DTO/投影 deny raw IDs；只暴露 `TaskItem(kind='work')` 的业务字段。
7. **No terminal**：merge/test/验收只写 evidence；Phase B 不写 work 状态/terminal；Phase C 另立。

### 3.3 状态机 / 生命周期

**A. Admission / attempt（codeteam）**

```text
no SOP ──first insert（development, stage != completion）──► admitted + attempt 1（unbound）
                                                                  │
                                                                  ├──run cutover binds profile──► bound
                                                                  │        ├──same profile──► idempotent
                                                                  │        └──different────► 409
                                                                  │
                                                                  └──no admission / partial──► unmanaged / fail closed
```

- `workId` 确定性派生；retry/re-create 返回同一 `workId`/`attemptId`，不 mint 第二个。
- `work_admissions`/`work_attempts` TTL=0；SOP delete 不清；backlog item delete `RESTRICT`。
- Phase B 只 attempt 1；只允许 primary implementer run 绑定；attempt 2/换 executor 归 Phase C，当前 409/unsupported。
- **retry = sticky**：调度器重试前读 `work_attempts.executor_profile_id`；已绑定 → 只选该 profile；未绑定 → 正常选择并 bind；不同 profile → 按 §3.3D 消费 target + operator blocker，不自动改绑。
- review/verify/其他 participant run 不绑 attempt 1，也不产生 `managed_attributed` episode；若需要展示，归 `unmanaged_not_applicable` + `reason='participant_phase_b'`（by design），不进 coverage；`managed_unattributed` 只留给 primary implementer 缺 binding。Phase C 再引入 participant/multi-attempt attribution。

**B. Private bindings**

```text
run:  no binding ──cutover with binding──► bound ──run terminal──► kept for evidence
task: no binding ──pr_tracking create with binding──► bound ──task delete──► cascade delete
```

- `run_managed_work_bindings` 与 run 同事务；`task_managed_work_bindings` 与 pr_tracking task 同事务。
- same binding 幂等；different binding 409；missing 不写；orphan 由 FK/health 检查。

**C. TaskOutcome attribution**

```text
run/task binding valid ──► managed_attributed（workId+attemptId）
admitted but binding missing/partial ──► managed_unattributed（no IDs）
ordinary chat/exploration ──► unmanaged_not_applicable（no IDs）
```

- A3-3 写 episode；A2-2 只提供 binding 事实。
- `managed_unattributed` 单独 metrics/health；不进 task-level 成功率分母。

**D. Transaction / crash matrix**

| 操作 | 事务边界 | 崩溃结果 |
|---|---|---|
| SOP first-persist | `workflow_sops` + `work_admissions` + `work_attempts` + audit 同事务 | 回滚：SOP/admission/attempt 都不存在；重试同一派生 ID |
| Run cutover | `runs` + `run_managed_work_bindings` + attempt bind 同事务 | 回滚：run 不存在/queue claim 保持可重试；无半绑定 run |
| PR task create | `tasks(pr_tracking)` + `task_managed_work_bindings` 同事务 | 回滚：无 orphan binding |
| Task delete | FK cascade 删 binding | 无孤儿 |
| A3-3 episode | episode + attribution 同事务 | 回滚：无半 attribution episode |
| **bind 确定性冲突**（409/partial/mismatch） | 不回滚重试；单独事务：从 queue target 移除该 recipient + typed `deliveryFailure` + `work_binding_conflict` audit + blocker 升级 operator | 其余 recipient 继续前进；只有 busy/瞬时失败保留 claim 过期重试 |

> **队列不 livelock**：managed-work bind 的确定性冲突不是 transient queue error；必须消费 target，不能把它留在 `targets_json` 让唯一 drain owner 反复命中。A1-3 §3.4.4 的“pre-dispatch 失败恢复同一 entry”只适用于 transient/busy；确定性 409/partial/mismatch 走上面的消费路径。

### 3.4 关键数据结构（与 clowder 对比）

| clowder | codeteam | 立场 | 关键差异 |
|---|---|---|---|
| `WorkAdmission`（`managed-work.ts:6`） | `work_admissions` | `reuse now` | `ownerUserId`→`owner_user_id`；`producerRef` FK backlog item；TTL=0 |
| `WorkAttempt`（`:16`） | `work_attempts` | `reuse now` | `executorCatId`→`executor_profile_id`；`attemptNumber` Phase B=1；bind-once |
| `WorkflowSopAdmissionBundle`（`:25`） | admission + attempt 两行 | `reuse now` | 同事务读；partial fail closed |
| `ManagedWorkBinding`（`:31`） | `run_managed_work_bindings` / `task_managed_work_bindings` | `adapt now` | 私有表；不写 Task/Run 列 |
| SOP first-persist trigger | A2-1 `workflow_sops` first insert | `adapt now` | same SQLite transaction；only development/non-completion |
| `bindManagedWorkAttempt` | A1-3 run cutover bind | `adapt now` | executor=`recipient_profile_id`；只限 primary implementer（v1 coder/work）；strict auth；conflict 409 |
| TaskStore-private metadata | `task_managed_work_bindings` | `adapt now` | same-DB FK；drop TTL/CAS；pr_tracking only |
| — | `run_managed_work_bindings` | `codeteam-new` | run private binding；A1-3 cutover 同事务 |
| `TaskOutcomeAttribution` tri-state | A3-3 `task_outcome_episodes.attribution` | `reuse now` | A3-3 owns store；A2-2 supplies refs |
| Redis keys / Lua | SQLite PK/FK/事务 | `drop` | 无 `managed-work:*` key；无 Lua |
| Phase C attempt 2/terminal | defer | `defer→Phase C` | 当前不建 work state/terminal |
| `TaskItem(kind='work')` | `tasks(kind='work')` | `reuse now` | 可选用户投影；无 raw IDs |
| `TaskItem(kind='pr_tracking')` | `tasks(kind='pr_tracking')` | `reuse now` | W5 anchor；binding 在私有表 |

#### 3.4.3 §12.2 回写清单

**0. 跨卡列归属（不重复造列）**

- `runs.recipient_profile_id` 已在 0001 §12.2 与 A1-3 §3.4.3（A1-3 拥有）；A2-2 只读，不重复造列。
- `invocation_credentials.owner_auth_provenance` 是 A1-2 增量列（2026-10-25 A2-2 回写）：`strict|compat|unknown`；A2-2 只 strict 可 bind。
- `workflow_sops` / `backlog_items` / `threads` 由 A2-1 拥有；A2-2 只引用，不改 A2-1 状态机。

**1. `work_admissions`（W1 新表）**

```sql
work_admissions(
  work_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  producer_kind TEXT NOT NULL CHECK (producer_kind IN ('workflow_sop_v1')),
  producer_ref TEXT NOT NULL REFERENCES backlog_items(id) ON DELETE RESTRICT,
  initial_attempt_id TEXT NOT NULL,
  admitted_at INTEGER NOT NULL,
  UNIQUE(owner_user_id, producer_kind, producer_ref)
);

CREATE INDEX idx_work_admissions_producer ON work_admissions(producer_kind, producer_ref);
```

- `work_id = 'wrk_' + sha256(JSON([owner_user_id, 'workflow_sop_v1', producer_ref])).slice(0,32)`。
- 只由 A2-1 first-persist 触发；`completion`/既有 SOP 不 retro-admit。
- 不删除；SOP delete 不清；backlog item `RESTRICT` 防误删。
- `initial_attempt_id` 不做 FK（admission/attempt 互相引用）；两行同事务写，读时 bundle 校验，partial fail closed。

**2. `work_attempts`（W1 新表）**

```sql
work_attempts(
  attempt_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES work_admissions(work_id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  executor_profile_id TEXT REFERENCES agent_profiles(id),
  created_at INTEGER NOT NULL,
  executor_bound_at INTEGER,
  UNIQUE(work_id, attempt_number),
  CHECK (
    (executor_profile_id IS NULL AND executor_bound_at IS NULL) OR
    (executor_profile_id IS NOT NULL AND executor_bound_at IS NOT NULL)
  )
);

CREATE INDEX idx_work_attempts_work ON work_attempts(work_id);
CREATE INDEX idx_work_attempts_executor ON work_attempts(executor_profile_id) WHERE executor_profile_id IS NOT NULL;
```

- Phase B 应用层只写 `attempt_number=1`；DB 允许 ≥1 以给 Phase C 留迁移空间。
- `executor_profile_id` 来自 A1-3 `runs.recipient_profile_id`；不接受 body。
- attempt 1 admission 时 `executor_profile_id=null`；bind-once 后写入。

**3. `run_managed_work_bindings`（W1 新表）**

```sql
run_managed_work_bindings(
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  work_id TEXT NOT NULL REFERENCES work_admissions(work_id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL REFERENCES work_attempts(attempt_id) ON DELETE RESTRICT,
  bound_at INTEGER NOT NULL
);

CREATE INDEX idx_run_managed_bindings_work ON run_managed_work_bindings(work_id, attempt_id);
```

- 与 A1-3 run cutover 同事务；不写 `runs` 列，避免 `SELECT *` 泄漏。
- 服务校验 `work_admissions.producer_ref = run.task.backlog_item_id` 或 `thread.backlog_item_id` 且 attempt 属于 work；mismatch fail closed。

**4. `task_managed_work_bindings`（W5 新表）**

```sql
task_managed_work_bindings(
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  work_id TEXT NOT NULL REFERENCES work_admissions(work_id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL REFERENCES work_attempts(attempt_id) ON DELETE RESTRICT,
  bound_at INTEGER NOT NULL
);

CREATE INDEX idx_task_managed_bindings_work ON task_managed_work_bindings(work_id, attempt_id);

CREATE TRIGGER trg_task_managed_binding_kind
BEFORE INSERT ON task_managed_work_bindings
WHEN (SELECT kind FROM tasks WHERE id = NEW.task_id) <> 'pr_tracking'
BEGIN
  SELECT RAISE(ABORT, 'managed work binding requires pr_tracking task');
END;
```

- 只允许 live `pr_tracking` task；same binding 幂等、missing 不写、different 409。
- task 删除 cascade 删 binding；不留孤儿。
- 不写 `tasks` 列；Task REST/socket/web/community 无 raw IDs。
- `tasks.kind` 在 binding 存在期间不可变；加 `BEFORE UPDATE OF kind` trigger 兜底，避免 task 改成其他 kind 后留下孤儿 binding。

```sql
CREATE TRIGGER trg_task_kind_immutable_after_binding
BEFORE UPDATE OF kind ON tasks
WHEN OLD.kind = 'pr_tracking' AND NEW.kind <> 'pr_tracking'
 AND EXISTS (SELECT 1 FROM task_managed_work_bindings WHERE task_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'cannot change kind of bound pr_tracking task');
END;
```

**5. `task_outcome_episodes`（A3-3 拥有，A2-2 只定 refs）**

- A3-3 在 `task_outcome_episodes` 增加/复用 `attribution TEXT NOT NULL DEFAULT 'unmanaged_not_applicable'`、`work_id TEXT NULL`、`attempt_id TEXT NULL`。
- `CHECK`：`attribution='managed_attributed'` ⇔ `work_id IS NOT NULL AND attempt_id IS NOT NULL`；其他两桶两列必须 null。
- A2-2 不建 episode 表、不写 verdict；只提供 binding 事实和三分桶契约。
- episode 的 `work_id`/`attempt_id` 是跨域引用；不加 FK 的理由是 episode 保留与 identity purge 解耦（若 W6 落同库，可升级 optional FK）；identity ledger 仍归 A2-2。

**7. backlog item purge / A2-1 cascade 交互**

- `work_admissions.producer_ref` 的 `RESTRICT` 让已 admission 的 backlog item 平时不可删；A2-1 `workflow_sops.backlog_item_id ON DELETE CASCADE` 只在显式 purge 路径可达。
- operator purge 必须先清 admission/attempt/binding，再删 SOP/backlog item；不能反向依赖 cascade 静默清身份。
- 该约束作为 A2-1 增量注记（2026-10-25 A2-2）：常规运行不存在“SOP 被 cascade、admission 还在”的路径。

**6. `audit` / 事件**

- `audit` 加事件：`work_admitted`、`work_executor_bound`、`work_binding_created`、`work_binding_conflict`、`work_attribution_unattributed`；`subject='work:<workId>'` / `'run:<runId>'` / `'task:<taskId>'`。
- 每次 mutation 同事务写 audit；append-only。
- 不新增 `work_events`/`work_state` 表；Phase B 不做 work 状态机。

### 3.5 变量定义表

#### contract

| 变量 | 类型 | 默认/值域 | owner | clowder 来源 | 决定 | 说明 |
|---|---|---|---|---|---|---|
| `WorkId` | TEXT | `wrk_<32 hex>` | managed-work | `managed-work-keys.ts:9`、`:17` | `reuse` | 确定性派生；不从 task/thread/run 派生 |
| `AttemptId` | TEXT | `wat_<32 hex>` | managed-work | `managed-work-keys.ts:9`、`:19` | `reuse` | 从 workId+attempt+1 派生 |
| `WorkAdmission` | row | work_id/owner/producer/ref/initial attempt/admitted_at | managed-work | `managed-work.ts:6` | `reuse` | TTL=0；唯一锚 |
| `WorkAttempt` | row | attempt_id/work/attempt_number/executor/created/bound | managed-work | `managed-work.ts:16` | `reuse` | Phase B 只 1；bind-once |
| `ManagedWorkBinding` | object | `{workId, attemptId}` | managed-work | `managed-work.ts:31` | `reuse` | 私有；不进公共 DTO |
| `TaskOutcomeAttribution` | enum | `managed_attributed` / `managed_unattributed` / `unmanaged_not_applicable` | harness-eval | `task-outcome-episode.ts:138` | `reuse` | A3-3 写 episode；A2-2 供 refs |
| `ProducerKind` | enum | `workflow_sop_v1` | managed-work | `managed-work.ts:3` | `reuse` | v1 唯一 producer |
| `ProducerRef` | TEXT | backlog_item_id | managed-work | `managed-work.ts:6`、`:9` | `reuse` | FK backlog item；不换成 task/thread |
| `ExecutorProfileId` | TEXT | `AgentProfile.id` | managed-work/identity | `managed-work.ts:16` + A1-1 | `rename` | `executorCatId` → profile；session 从 run join |

#### state

| 变量 | 状态机/约束 | owner | 失败语义 |
|---|---|---|---|
| `work_admissions` | absent → admitted；不 retro-admit；不删除 | managed-work | 重复/冲突返回已有；partial fail closed |
| `work_attempts.attempt_number` | Phase B 只 1；DB ≥1 | managed-work | 写 2+ → 422 `attempt_not_supported`；Phase C 再放开 |
| `work_attempts.executor_profile_id` | null → bound once；same idempotent；different conflict | managed-work | 409 `MANAGED_WORK_EXECUTOR_CONFLICT`；partial fail closed |
| `run_managed_work_bindings` | insert on run cutover；cascade on run delete | managed-work | 同 binding 幂等；mismatch fail closed |
| `task_managed_work_bindings` | insert on pr_tracking task create；cascade on task delete | managed-work | 非 pr_tracking → trigger abort；same idempotent；different 409 |
| `TaskOutcome.attribution` | 三态互斥；managed_attributed 需双 ID+binding | harness-eval | 缺 ID/binding → 拒绝造 episode；其他桶带 ID → 拒绝 |

#### config

| 变量 | 默认 | owner | 决定 | 说明 |
|---|---|---|---|---|
| `CODETEAM_DATA_DIR` | 见 A1-1（唯一权威） | config | `reference` | managed-work 数据在 SQLite，不放文件根 |
| `CODETEAM_SQLITE_BUSY_TIMEOUT_MS` | 见 plans/0002 W1（唯一权威） | 全局 SQLite | `reference` | bind/cutover 事务使用；本卡不重定义 |
| `work_admission_ttl` | 0 | managed-work | `reuse` | TTL=0；admission/attempt 永久保留；不提供 env 开关 |
| `binding_ttl` | 0 | managed-work | `adapt` | SQLite 无 TTL；用 FK/事务；不移植 Redis TTL/CAS |

#### security

| 变量/规则 | 值/来源 | owner | 失败语义 |
|---|---|---|---|
| `ownerAuthProvenance` | A1-2；只有 `strict` 可 bind | auth/managed-work | 非 strict → unmanaged，不推断；不 fail-open |
| `executorProfileId` | A1-3 `runs.recipient_profile_id`；只限 primary implementer run；bind 时 profile 必须 active | managed-work/dispatch | body/`batonHolder`/`updatedBy` 一律拒绝；disabled profile → 409；review/verify run 不绑定 |
| `workId`/`attemptId` 输入 | 只由服务派生 | managed-work | 请求 body 出现 → 422 `derived_identity_only` |
| `taskBindingKind` | 只允许 `pr_tracking` | managed-work | 非 pr_tracking → trigger abort/422 |
| `runBindingMatch` | admission.producer_ref = run.task.backlog_item_id 或 thread.backlog_item_id | managed-work | mismatch → fail closed，不创建 binding |
| `publicProjectionDenylist` | Task/Run/Queue/MCP/REST/Web/Community；audit/内部 health 豁免 | managed-work | 公共投影出现 raw ID → 500/contract test fail；audit 不被 blanket 扫描 |
| `taskOutcomeAttribution` | 三分桶；managed_attributed 需 binding；participant 用 `unmanaged_not_applicable + reason='participant_phase_b'` | harness-eval | primary implementer 缺 binding → `managed_unattributed`；participant 不进 coverage；不得塞进 attributed |
| `phaseCAttemptAllocation` | 未授权 | managed-work | attempt 2/换 executor → 422/409；不静默降级 |
| `managedRetryPolicy` | `sticky` | managed-work/dispatch | 重试先读 `executor_profile_id`；已绑 → 同 profile；不同 → 消费 target + operator blocker；fallback 只对非 managed/Phase C |

#### observability

| 变量/事件 | 值/来源 | owner | 说明 |
|---|---|---|---|
| `work_admitted` | audit；work_id/producer_ref/attempt_id | managed-work | first-persist 同事务写 |
| `work_executor_bound` | audit；work_id/attempt_id/executor_profile_id | managed-work | bind-once 同事务写 |
| `work_binding_created` / `work_binding_conflict` | audit/counter | managed-work | task/run binding 结果 |
| `managed_work_bind_conflict_total` | counter | managed-work | 不同 executor/binding 冲突率 |
| `managed_work_unattributed_total` | counter | managed-work/harness-eval | 缺失/partial binding 的 coverage defect |
| `managed_work_orphan_total` | gauge/health | managed-work | admission 无 attempt、attempt 无 admission、binding 无 anchor |
| `raw_identity_leak_total` | contract test/counter | managed-work | 公共 DTO 出现 raw ID 即失败 |
| log 内容 | work_id 截断/attempt_id 截断/是/否 | managed-work | 不记录完整 raw ID 到公共日志；内部 audit 可全量 |

### 3.6 明确不做

- 不做 Phase C 多 attempt、换 executor、work terminal/reopen。
- 不做 Phase B 的 review/verify/participant attribution；这些 run 不绑 attempt 1，Phase C 再扩。
- 不做 managed work 的自动 fallback/改绑；Phase B retry = sticky（DP-A2-2-1=A）。
- 不建 work 状态机、work UI、第二套 Task/Run/Queue。
- 不把 `workId`/`attemptId` 写进 `tasks`/`runs` 公共列；只进私有表。
- 不建第二个 TaskOutcomeEpisode store；A3-3 拥有 episode。
- 不让 PR merge/test 自动 terminalize work；merge 只是 evidence。
- 不从 thread/task/branch/时间邻近推断身份；只从 SOP admission 派生。
- 不用 `batonHolder`/`updatedBy`/body 当 executor；只认 run recipient profile。
- 不在 v1 建 `work_state`/`work_events`/generic work ledger。
- 不做 GitHub PR tracking / issue/forge inbound 实现；W8/A3 接入 binding。
- 不做 eval verdict/task-level 成功率；A3-3/F267 独立 gate。

## 4. 风险与回滚

| 风险 | 级别 | 处置 |
|---|---|---|
| 用 task/thread/run 当 identity root | P1 | 只从 owner+producer+backlog item 派生；contract tests |
| SOP 与 admission/attempt 部分提交 | P1 | 同一 SQLite 事务；崩溃矩阵；health 检查 partial bundle |
| 用 body/batonHolder 冒充 executor | P1 | executor 只取 `runs.recipient_profile_id`；body 拒绝；bind-once |
| bind 确定性冲突留在 queue target，导致 thread drain livelock | P1 | 冲突消费 target + typed `deliveryFailure` + audit + operator blocker；只有 transient/busy 重试 |
| 不同 profile retry 撞 bind-once（fallback 路径） | P1 | **DP-A2-2-1 = A sticky retry（2026-10-25）**；重试钉回已绑 profile；fallback 只对非 managed/Phase C；不同 profile 按 §3.3D 消费 target + operator blocker |
| review/verify 跨 profile run 误绑 attempt 1 | P2 | 只允许 primary implementer（v1 coder/work）绑定；review/verify 不绑，Phase C 再扩 |
| participant run 塞进 `managed_unattributed`，污染 coverage | P2 | participant → `unmanaged_not_applicable + reason='participant_phase_b'`；`managed_unattributed` 只留 primary 缺 binding |
| raw ID 泄漏到 Task/Run/Queue/API/MCP/Web | P1 | 私有表 + projection denylist + contract tests |
| 既有/completion SOP retro-admit | P1 | first insert + development + non-completion；测试覆盖 |
| Phase B 误开 attempt 2/换 executor | P2 | 应用层只 1；attempt 2 422；Phase C 另立 |
| Task binding 与 anchor 生命周期不一致 | P2 | 同事务 + FK cascade；health orphan |
| TaskOutcome 三分桶混算 | P2 | A3-3 CHECK + normalize；managed_unattributed 单独计 |
| Redis TTL/CAS 直接照搬 | P2 | drop；SQLite FK/事务替代；不复制 TTL |
| admission 永久保留导致无法清理 | P3 | TTL=0 是契约；operator purge 另立 approval/forget，不在本卡 |
| purge backlog item 后重建复用同一 `workId`，复活旧 executor | P2 | purge 必须先作废 admission/attempt/binding，或换 producer_ref 盐；禁止静默 purge |

**回滚**：`work_admissions`/`work_attempts`/`run_managed_work_bindings`/`task_managed_work_bindings` 是新增表；回滚到 W1 基线即可。A2-1 `workflow_sops` 不变；不迁移 clowder Redis 数据；不回滚已写 audit（保留证据）。

## 5. Review 与签字

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | identity 派生、first-persist 原子、run cutover bind、Phase C 边界 | accept；P2 bind 门槛 OR 化 + P3 active profile 已回写 |
| 砚砚 | strict owner auth、executor 来源、raw ID 泄漏、fail-closed | accept-with-modify；P1 retry → DP-A2-2-1=A（sticky retry）；P2-1/P3 已回写 |
| 墨墨 | operator/Task 投影、TaskOutcome 三分桶、W5/W8 接缝 | accept-with-modify；P1-1 字段 owner/P1-2 livelock/P2/P3 已回写 |
| operator | A2-2 架构卡是否可签 | [x] 已签（2026-10-25，DP-A2-2-1=A） |

> Review request `a02b5016-5cb6-463c-9cb3-485eb9ec1379`（2026-10-25，三猫）。Review disposition：Kimi P2 bind 门槛 OR → §2.2#2/§3.2#2；Kimi P3 active profile → §3.5 security；Glm P1-1 retry → **DP-A2-2-1=A sticky retry（operator 2026-10-25）**；Glm P2-1 0001 回写 → 0001 §12.2 已补；Glm P3 participant bucket → §2.3C/§3.3A；Qwen P1-1 字段 owner → 0001/A1-2 增量 + §3.4.3#0；`recipient_profile_id` 已核实存在于 0001/A1-3，非缺口；Qwen P1-2 livelock → §3.3D + plans；Qwen P2-1 participant 语义 → 同上；Qwen P2-2 §12.2 → 已补；Qwen P3 tasks.kind/audit 豁免/cascade/purge → §3.4.3#4/#7、§3.5、§4。

### DP-A2-2-1（决定：A sticky retry，2026-10-25）：managed work 的 retry / fallback 语义

**问题**：bind-once 把 attempt 1 钉在一个 `executor_profile_id`。模型错误后若 fallback 到另一 profile，重试 run 的 `recipient_profile_id` 不同 → 409 → cutover 失败。Phase B 没有 attempt 2，不定义就会让 dogfood 首次 mid-work 模型错误永久卡死。

| 选项 | 语义 | 代价 |
|---|---|---|
| **A（推荐）sticky retry** | managed work 的重试 run 由调度器钉回已绑 profile；fallback 只对非 managed run 生效，managed fallback 等 Phase C attempt 2 | 改动最小；不破坏 bind-once；managed work 在 Phase B 不享受模型 fallback |
| B bounded rebind | 原 run 有 `interrupted` 证据时允许一次改绑，audit `executor_rebound`，原值留痕；bind-once 变为“per uninterrupted attempt” | 归因更诚实；多一条状态规则，且一次改绑后仍可能二次失败 |
| C 不处理 | 不同 profile 重试继续 409 | 不可接受；dogfood 会被单次模型错误卡死 |

**决定**：**A sticky retry**（operator 2026-10-25）。Phase B 的目标是身份/归属正确，不是 fallback 可用性；sticky retry 不改变 bind-once 语义，Phase C 再用 attempt 2 正式支持换 profile。

**实现约束**：调度器重试前必须读 `work_attempts.executor_profile_id`；已绑定 → 只选该 profile；未绑定 → 正常选择并 bind；不同 profile → 按 §3.3D 消费 target + operator blocker，不自动改绑、不自动解绑；fallback 只对非 managed run 生效，managed fallback 等 Phase C attempt 2。

> operator 于 2026-10-25 签字（DP-A2-2-1=A），A2-2 冻结为 W1/W5/A3-3 实现契约。

**Review 重点**

1. `workId`/`attemptId` 派生与 idempotency 是否成立；是否彻底排除 task/thread/run 作为 identity root。
2. A2-1 `workflow_sops` first insert + admission/attempt 同事务；completion/既有 SOP 不 retro-admit 是否覆盖。
3. bind-once 放进 A1-3 run cutover 是否成立；strict owner auth、executor=`recipient_profile_id`、只限 primary implementer、冲突/partial fail-closed 是否足够；review/verify 不绑的 Phase B 取舍是否可接受。
4. `run_managed_work_bindings`/`task_managed_work_bindings` 私有表是否真的挡住 raw ID 泄漏；task binding 只限 `pr_tracking` 是否成立。
5. TaskOutcome 三分桶与 A3-3 episode 的边界是否清楚；是否复制了 episode store/verdict。
6. §12.2 diff 与 plans/0002 W1、plans/0004 W5、A3-3 的挂点是否一致；有没有未排期的新范围。

**交卡前自检**

- [x] 组件图、数据流、状态机、存储/并发、失败恢复五段齐全。
- [x] 每个组件有 `reuse now` / `adapt now` / `codeteam-new` / `drop` / `defer` / `out-of-scope` 立场。
- [x] 变量表覆盖 contract/state/config/security/observability 五层。
- [x] 所有代码锚点 grep 可达（交卡后跑锚点检查）。
- [x] 风险与回滚写清；安全变量写明失败语义。
- [x] §12.2 回写清单完整；W1/W5/A3-3 plan 挂点已核对。

[宪宪/deepseek-flash🐾]
