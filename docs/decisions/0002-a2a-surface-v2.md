---
title: "ADR-0002: A2A surface v2 — codeteam_post_message / codeteam_cross_post_message"
doc_kind: decision
status: proposed
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_signoff: pending
created: 2026-10-31
updated: 2026-11-04
related_features: [codeteam/F017]
supersedes_for_f017: docs/decisions/0001-cross-thread-a2a-v1.md
superseded_for_execution_anchor: docs/architecture/0005-thread-first-runtime.md
clowder_reference_revision: 5f8965e1e04dd3ac194cba53fa484bbc994d2dcd
codeteam_base_revision: e9be3c5aa028095ad70139fcc2ca579fd076b0b9
---

# ADR-0002: A2A surface v2

> **2026-11-04：execution anchor 已被 0005 取代。** F017 Phase A 归档；
> A2A runtime v1 由 F018 拥有。本文的 full custody / action lease /
> return-recovery 仍作为 **v2 custody 历史输入**，不再作为当前 v1 实现契约。

> **状态：proposed，operator signoff pending。** 本文是 Phase A 的 contract
> 草案，不是已签实现契约。Phase A 只读 Clowder AI 参考实现与本仓现状，没有
> 修改产品代码、F016a/b/c 文档或任何运行数据。
>
> 本文替代 ADR-0001 的 **message-only 结论对 F017 的适用范围**。ADR-0001
> 仍是 cross-thread message-only 的历史输入与风险清单；F017 的边界由本文
> 冻结。ADR-0001/0002 当前都还未 commit；Phase A freeze（B0）时必须一并
> 入 git，并在 operator 确认本文后标记 ADR-0001 superseded。Clowder 路径
> 均为 repo-relative 参考路径，Clowder 不是运行依赖。

## 0. 结论先行

F017 的目标态是 **两个模型入口 + 一个共享 custody 状态机**：

| 入口 | 无 custody | 有 custody |
|---|---|---|
| `codeteam_post_message` | 当前 thread 的讨论消息 | 当前 thread 的 custody 操作 |
| `codeteam_cross_post_message` | 目标 thread 的讨论消息 | 目标 thread 的 custody 操作 / return carrier |

**七个必须一起成立的结论：**

1. **Custody 是 union，不是 message 的可选备注。** `custody.action` 明确区分
   `create` / `claim` / `complete` / `return` / `replace` / `withdraw`；缺字段
   typed reject，绝不降级成 discussion。
2. **Cross-thread custody 用双 task 坐标。** source task 保留责任来源；
   target/holder task 承载执行与 custody。`Handoff.taskId` 继续表示 source
   task，新增 `holderTaskId` / `predecessorTaskId`；`holderThreadId` 必须等于
   holder task 的 thread。
3. **target session / run / token 是服务端解析结果，不是工具入参。** 模型只
   给 target task/thread 与 target profile ids；session、run、token 由目标
   task/thread 的现有 route/cutover/token mint 派生。source token 永不复用。
4. **ACL 锚在 task.userId + session.userId，不虚构 thread owner。** source
   principal、target task、target session 的 userId 都必须非空、非
   `"unpaired-user"` 且严格相等；target 不允许 `session.userId ?? task.userId`
   fallback。
5. **Loop guard 的 scope 是 operator 选择，不是既定事实；idempotency 按
   source task + profile + clientMessageId。** 现状是全局 DB partial unique
   index（003-governance.ts:87），不是 task-scoped；§10.5 二选一：
   (a) 保持全局唯一（零迁移），或 (b) 放宽为 owner-scoped（同 owner 跨 task
   仍一条 live；跨 owner 同 key 从禁止→允许，需 index 迁移 + 并发
   UNIQUE→`loop_guard_live_handoff` 映射）。无论哪种，换 thread 不能绕过同
   owner 的 live guard。
6. **方向由 SOP policy 定义，harness 只校验授权。** 删除 TS 里的
   `DEFAULT_ACTION_PAIRS` / role→tool 方向矩阵作为真相；`sop-definitions/
   development.yaml` 新增版本化 `handoff_policy`，handoff 记录 policy
   identity/digest。没有 policy 的 custody fail closed。
7. **Peer @ 保持 tool-call-first。** `targets` 是唯一路由权威；正文行首
   `@handle` 是可验证的可见标记，不是第二路由源。任何 agent 都可以成为
   target；SOP/skill 决定“这次交接是否合理”，harness 校验 target/scope/
   custody/authorization。

## 1. 范围与不可变边界

### 1.1 F017 范围

- 同 thread 与跨 thread 的 discussion、custody/handoff、return/recovery。
- 两个模型入口：`codeteam_post_message` / `codeteam_cross_post_message`。
- 旧 `codeteam_a2a_send` / `codeteam_handoff_*` 模型面删除；底层 handler /
  state machine 在迁移期保留为 internal primitive。
- `codeteam_thread_context` 保留为新 surface 的只读 companion，不进入删除
  清单；两个新入口必须加入 `A2A_TOOL_NAMES`，否则
  `evaluateWorkerToolCall` 不会对它们做 role 门禁。
- F017 自己拥有 full cross-thread custody / return / recovery，不另立第二个
  cross-thread feature。

### 1.2 明确不做

- 不回改 F016a/b/c；不改 F016a 已 closed 的 feature/plan 结论。
- MCP ingress、`multi_mention` 聚合、Console/W7b、`effectClass`/Approval Hub
  新责任审批。
- 第二套 queue/message/handoff/custody store。
- 文本 `@` 独立路由（见 §7.4）；没有 operator 新决定前不推翻
  `docs/README.md` 的 tool-call-first 已拍板结论。
- F016a D5 的 cross-thread negative 继续成立：旧的 `codeteam_a2a_send`
  仍是 same-thread-only，直到它被删除。新的跨 thread 能力只从
  `codeteam_cross_post_message` 进入。

### 1.3 参考实现

Clowder AI 参考仓只读 revision：
`5f8965e1e04dd3ac194cba53fa484bbc994d2dcd`。本文只复制契约与语义，不复制
Redis、transport、auth 或部署假设。codeteam 的 SQLite store、queue、
run/token 绑定和 task/thread 模型继续作为运行时真相。

## 2. 术语

| 术语 | 定义 |
|---|---|
| discussion | 只写 message + queue wake；不创建 handoff、不写 custody event、不改责任。 |
| custody | 一次 typed responsibility transfer，包含 create/claim/complete/return/replace/withdraw。 |
| source task/thread | 发起 custody 的 run 的 task/thread；`Handoff.taskId` 继续指它。 |
| holder task/thread | 实际持有责任、执行 holder run 的 task/thread；新增 `Handoff.holderTaskId`。 |
| predecessor task/thread | 责任被退回时的目标；通常是 source task/thread，但 return 链可以逐跳后退。 |
| target task/thread | 本次 cross-post 写入的 task/thread；create 时通常等于 holder task/thread，return 时等于 predecessor task/thread。 |
| target profile | 模型显式给的 AgentProfile id；不是 display name，也不是正文解析出的 handle。 |
| target session/run/token | 服务端在 holder task/thread 上解析或创建的坐标；不是模型入参。 |
| return | holder 拒绝 ownership，lease generation+1，责任回到 predecessor，并由 return carrier 唤醒 predecessor。 |
| recovery | daemon 重启 / run interrupted / return carrier 未送达时的恢复；只能重放已存在的 custody 事实，不能自签新事实。 |

## 3. Clowder 参考 audit

### 3.1 `post_message` 与 `cross_post_message` 是同一投递 primitive

- 两个工具共享 `_executePostMessage`；`cross_post_message` 只多了 target
  thread 解析与 routing 凭证，不是第二 message store：
  `packages/mcp-server/src/tools/callback-tools.ts:1105`（`handlePostMessage`）、
  `packages/mcp-server/src/tools/callback-tools.ts:1587`
  （`handleCrossPostMessage`）、`packages/mcp-server/src/tools/callback-tools.ts:1690`
  （复用 post primitive）。
- `cross_post_message` schema 含 `threadId`、`targetCats`、`replyTo`、
  `clientMessageId`、`coordination`、`action`、`proposedAction`：
  `packages/mcp-server/src/tools/callback-tools.ts:774`。
- `post_message` schema 含 `content`、`targetCats`、`replyTo`、
  `clientMessageId`、`coordination`、`action`；invocation-token caller 必须
  省略 `threadId`：
  `packages/mcp-server/src/tools/callback-tools.ts:343`、
  `packages/mcp-server/src/tools/callback-tools.ts:1105`。
- 跨 thread 写入要求 `targetCats` 或行首 `@`，否则 400
  `cross_post_no_routing`：
  `packages/api/src/routes/callbacks.ts:2533`。
- 目标 thread 被删除时在持久化前拒绝：
  `packages/api/src/routes/callbacks.ts:2512`。
- 目标 message 持久化在目标 thread，`extra.crossPost` 只保存
  sourceThreadId / sourceInvocationId / effectClass 等 provenance：
  `packages/api/src/routes/callbacks.ts:3380`。
- target 不是 participant 只产生 `target_not_in_thread` warning，不阻断：
  `packages/api/src/routes/callbacks.ts:3291`、
  `packages/api/test/callback-f177h-participant-check.test.js:175`。
- 测试明确断言 `crossPost` 不承载 coordination：
  `packages/api/test/cross-thread-coordination-chain.test.js:132`。

**codeteam 适配：** codeteam 没有 thread owner/participants；不能照搬
Clowder 的 `thread.createdBy` 授权。codeteam 用 target task + target
session 作为更强的执行授权锚（§5）。

### 3.2 结构化 action 才是 custody

- `ActionSuccessorAdmissionInput` 显式带 `sourceThreadId` / `targetThreadId`：
  `packages/api/src/domains/ball-custody/ActionSuccessorAdmissionContract.ts:19`。
- admission 把 `holderThreadId` 设为 target、`predecessorThreadId` 设为
  source：
  `packages/api/src/domains/ball-custody/ActionSuccessorAdmissionService.ts:141`、
  `packages/api/src/domains/ball-custody/ActionSuccessorAdmissionService.ts:143`。
- lease 持久化 `holderThreadId` / `predecessorThreadId` / generation /
  holder outcomes / completion candidates：
  `packages/api/src/domains/ball-custody/action-successor-state-machine.ts:119`。
- dispatch id 形如 `cross-post:<clientMessageId>`，同 thread 是
  `post:<clientMessageId>`：
  `packages/api/src/routes/callbacks.ts:3056`。
- queue carrier 带 `actionSuccessorFence`；目标 thread 的 queue 才是执行
  carrier：
  `packages/api/src/routes/callbacks.ts:3630`、
  `packages/api/test/cross-thread-action-successor.test.js:288`。
- agent-key 不能做 direct action；必须 invocation token，否则 fail closed，
  不写 message/queue：
  `packages/api/test/cross-thread-action-successor.test.js:636`。

**codeteam 适配：** codeteam 的 action 键不建在 tenant+subject 上，而建在
`Task` + `Handoff` 上。F017 保留 `Handoff` 作为状态真相，新增 holder task
坐标；group key 用 ownerUserId + canonicalActionKey 做跨 task loop guard。

### 3.3 Return / replace / recovery

- `returnActionSuccessorToPredecessor` 校验 exact generation + holder
  cat/thread；single lease 回到 predecessor，generation+1，
  `returnDeliveryState='pending'`：
  `packages/api/src/domains/ball-custody/action-successor-return-state-machine.ts:63`。
- parallel lease 不支持 whole-lease return，只记录 rejecting holder 的
  `rejected_ownership` outcome：
  `packages/api/src/domains/ball-custody/action-successor-return-state-machine.ts:84`、
  `packages/api/test/action-successor-state-machine.test.js:865`。
- return delivery 的 pending → overdue → delivered 是 transport 事实；只有
  queue enqueue 后才能 `markReturnDelivered`：
  `packages/api/src/domains/ball-custody/action-successor-return-state-machine.ts:170`、
  `packages/api/test/cross-thread-action-successor.test.js:320`。
- 同 cat 换 thread 也会 `holder_mismatch`：
  `packages/api/test/action-successor-state-machine.test.js:784`。
- returned-holder reattach 需要 exact return proof、generation、predicate
  identity；stale/缺 proof fail closed：
  `packages/api/src/domains/ball-custody/action-successor-return-state-machine.ts:125`、
  `packages/api/test/action-successor-state-machine.test.js:646`。
- `safe_wait` 没有 durable carrier 时 fail closed，不创建 work：
  `packages/api/test/cross-thread-action-successor.test.js:510`。

**codeteam 适配：** codeteam 的 `handoffs` 表已经有
`return_transitions_json`、`replacement_transitions_json` 和
`return_delivery_*` 列：
`packages/codeteam-daemon/src/control/migrations/003-governance.ts:30`。
但 `Handoff` type / store 尚未暴露 return delivery 状态：
`packages/codeteam-daemon/src/control/stores/types.ts:990`。Phase B 需要
把这些列映射进 runtime，并实现 return/replace 状态机，而不是新增第二套
return 表。

### 3.4 Thread access 是 user-scoped，不是 task-scoped

- `resolveThreadAccess` 按 owner / shared default / external anchor /
  indexed system thread 放行，否则 403：
  `packages/api/src/domains/cats/services/session/thread-access-policy.ts:58`。
- `resolveScopedThreadId` 只允许同 user thread 或用户可见 system thread：
  `packages/api/src/routes/callback-scope-helpers.ts:89`。
- access matrix 覆盖 owner / non-owner / shared default / indexed system /
  unindexed system / external anchor：
  `packages/api/test/thread-access-policy.test.js:13`。

**codeteam 适配：** `Thread` 没有 userId/createdBy/participants：
`packages/codeteam-daemon/src/control/stores/types.ts:215`。因此不能用
thread 做 ACL。F017 用 target task 的 `userId` + target session 的
`userId` 做双锚；不新增 thread owner 表，不猜 owner。

### 3.5 codeteam 现状硬约束

| 约束 | 现状 | F017 处理 |
|---|---|---|
| Message/queue | message 有 threadId + nullable taskId；queue 一条 source 一条 entry | 复用；cross-post message 写 target thread/task，queue 也写 target thread |
| Run/session/token | run/session 必须同 task/thread；token 从 run→session→task 派生 | 不复用 source token；target run 在 target task/thread 上正常 mint |
| Handoff | 只有 `taskId` + `holderThreadId` + `predecessorThreadId` | 新增 `holderTaskId` / `predecessorTaskId`；`taskId` 保持 source task |
| Claim/complete | `requireRunForHandoff` 要求 run.taskId == handoff.taskId 且 task.threadId == holderThreadId | 改为 run.taskId == handoff.holderTaskId；legacy 同 thread 时两者相等 |
| A2A target | target session 必须同 task/thread；正文 @ 不路由 | cross-post 解析 target task/thread；`targets` 仍是唯一路由 |
| Loop guard | 全局 DB partial unique index `handoffs_live_action` on `canonical_action_key`（003-governance.ts:87）；`findLiveByCanonicalActionKey(taskId, key)` 只是 typed 预查 | Phase A 二选一：保持全局（零迁移），或 owner-scoped（drop/rebuild index；跨 owner 同 key 从禁止→允许；并发 UNIQUE→typed） |
| Direction | `DEFAULT_ACTION_PAIRS` + `A2A_ROLE_TOOLS` 硬编码 | 移到 SOP `handoff_policy`；旧矩阵删除或降为默认 policy 数据 |

代码证据：

- `Thread` 无 owner：`packages/codeteam-daemon/src/control/stores/types.ts:215`。
- `Task.threadId` / `userId`：`packages/codeteam-daemon/src/control/stores/types.ts:666`。
- `Handoff` 单 task：`packages/codeteam-daemon/src/control/stores/types.ts:990`。
- `resolveRunPrincipal` task/session 一致性 + userId fallback：
  `packages/codeteam-daemon/src/a2a/principal.ts:31`、
  `packages/codeteam-daemon/src/a2a/principal.ts:37`。
- `deliverableTargets` 同 task/thread：
  `packages/codeteam-daemon/src/a2a/tools.ts:570`、
  `packages/codeteam-daemon/src/a2a/tools.ts:587`。
- handoff create 固定 principal task/thread：
  `packages/codeteam-daemon/src/a2a/tools.ts:453`。
- claim/withdraw task/thread scope：
  `packages/codeteam-daemon/src/a2a/tools.ts:510`、
  `packages/codeteam-daemon/src/a2a/tools.ts:547`。
- `requireRunForHandoff` 单 task/thread：
  `packages/codeteam-daemon/src/control/stores/handoffs.ts:775`。
- dispatch route/cutover 用 source message 的 taskId：
  `packages/codeteam-daemon/src/dispatch/service.ts:311`、
  `packages/codeteam-daemon/src/dispatch/service.ts:343`。
- token coords 从 run/session/task 派生：
  `packages/codeteam-daemon/src/auth/mint.ts:38`。
- 硬编码 direction / role tools：
  `packages/codeteam-daemon/src/policy/handoffs.ts:23`、
  `packages/codeteam-daemon/src/workers/tool-policy.ts:15`。

**Cross-thread 绑定改造点（必须一并改，不能只加字段）：**

| 位置 | 现状 | cross-thread 要求 |
|---|---|---|
| `DispatchService.cutoverEntry` 的 `boundHandoff` | `handoff.taskId === source.taskId && handoff.holderThreadId === source.threadId` | `handoff.holderTaskId === source.taskId && handoff.holderThreadId === source.threadId`；否则 target run 不会绑定 handoff，holder 看不到 assigned handoff |
| `A2AToolHandlers.claimHandoff` scope | `handoff.taskId === principal.taskId && handoff.holderThreadId === principal.threadId` | `handoff.holderTaskId === principal.taskId && handoff.holderThreadId === principal.threadId` |
| `A2AToolHandlers.withdrawHandoff` scope | `handoff.taskId === principal.taskId && handoff.holderThreadId === principal.threadId`；作者靠 `predecessorProfileId` 推断 | author scope 用 `handoff.taskId === principal.taskId && handoff.authorProfileId === principal.profileId`；不能拿 holder thread 拒绝 source author，也不能用会随 return 漂移的 predecessor 字段当作者 |
| `HandoffTerminalResolver` review evidence | `store.reviews.listByTask(handoff.taskId)` | `listByTask(handoff.holderTaskId)` |
| `HandoffTerminalResolver` status message | `holderThreadId + taskId` | holder: `holderThreadId + holderTaskId`；predecessor: `predecessorThreadId + predecessorTaskId`；不能混用 target thread + source task |
| `HandoffStore.requireRunForHandoff` | run.taskId === `handoff.taskId`；task.threadId === `holderThreadId` | run.taskId === `handoff.holderTaskId`；task.threadId === `holderThreadId` |

这些点是 F017 最容易“字段加了但链路没接上”的地方；Phase B 的第一组
负例应直接钉住 target run 的 `handoffId`、claim scope、withdraw author scope
和 terminal message 的 thread/task 一致性。

### 3.6 Reuse decision

| 项 | 决定 | 理由 |
|---|---|---|
| 一条 queue ledger | R0 复用 | codeteam 已有 `queue_entries` + `DispatchService`；不新增第二队列 |
| message 本体 | R0 复用 | cross-post 复用 `messages`，provenance 用新增 `cross_post_json` |
| action lease 语义 | R1 适配 | 复制 create/claim/complete/return/replace 的状态语义；键改为 Task/Handoff + owner loop guard |
| thread access | N1 不直接复用 | codeteam thread 无 owner/participants；用 task.userId + session.userId |
| Redis action store | Drop | codeteam 用 SQLite store；不引入 Redis |
| `effectClass` / Approval Hub | Drop（本 feature） | F017 不做新责任审批；custody 授权由 SOP policy + operator 既有边界 |
| MCP transport | Drop（本 feature） | F017 只做 extension tool surface；MCP ingress 不在范围 |

## 4. 模型面 schema

### 4.1 `codeteam_post_message`

同一个工具，两个互斥分支。discussion 分支保留现有 `a2a_send` 的 message
语义；custody 分支承载全部同 thread custody action。

```ts
type PostMessageInput =
  | {
      // discussion
      kind: "question" | "answer" | "proposal" | "finding" | "status";
      targets: ProfileId[];                 // 1..32, unique, active, same task/thread
      bodyMd: string;
      replyTo?: string | null;              // same thread only
      clientMessageId?: string | null;      // optional for discussion
      custody?: never;
    }
  | {
      // custody
      targets?: ProfileId[];                // 1..32; required for create/replace; forbidden for claim/complete/return/withdraw
      bodyMd?: string;                      // optional visible message
      replyTo?: string | null;              // same thread only
      clientMessageId: string;              // required for every custody action
      custody: CustodyRequest;
    };
```

规则：

- 两个分支互斥；同时出现 discussion 的 `kind` 和 `custody`，或两者都没有，
  返回 `a2a_branch_invalid`。
- `custody` 存在时，message kind 固定为 `"handoff"`（可见 shell）；不得用
  `kind` 再指定 discussion kind。
- `targets` 是 AgentProfile id；display name / 行首 `@` 不产生路由。
- `replyTo` 只能指向当前 thread，且 message.taskId 必须为 null 或等于当前
  task；跨 thread reply 用 `codeteam_cross_post_message.targetThreadId`
  解析，不做隐式跨 thread reply。
- `from*` / `ownerUserId` / `controlRef` / `canonicalActionKey` /
  `targetSessionId` / `targetRunId` / `targetToken` / `verified` 都是 forbidden
  fields；出现即 `invalid_input`，不静默忽略。

### 4.2 `codeteam_cross_post_message`

```ts
type CrossPostMessageInput =
  | {
      // discussion
      targetThreadId?: string;
      targetTaskId?: string;                // at least one of targetThreadId/targetTaskId
      kind: "question" | "answer" | "proposal" | "finding" | "status";
      targets: ProfileId[];                 // 1..32, unique; required; target task/thread scope
      bodyMd: string;
      replyTo?: string | null;              // target thread, same target task when task-bound
      clientMessageId: string;              // required for cross-thread writes
      custody?: never;
    }
  | {
      // custody
      targetThreadId?: string;
      targetTaskId?: string;                // required for create/replace; derived for return/withdraw
      targets?: ProfileId[];                // 1..32; required for create/replace; forbidden for claim/complete/return/withdraw
      bodyMd?: string;
      replyTo?: string | null;              // target thread, same target task when task-bound
      clientMessageId: string;
      custody: CustodyRequest;
    };
```

工具/action 边界：

| custody.action | `codeteam_post_message` | `codeteam_cross_post_message` |
|---|---|---|
| `create` | 允许（holder = 当前 task/thread） | 允许（holder = target task/thread） |
| `claim` | 允许（holder 在当前 thread） | 拒绝：`custody_action_wrong_tool` |
| `complete` | 允许（holder 在当前 thread） | 拒绝：`custody_action_wrong_tool` |
| `return` | 允许（predecessor = 当前 thread） | 允许（predecessor = target thread） |
| `replace` | 允许（new holder = 当前 thread） | 允许（new holder = target thread） |
| `withdraw` | 允许（holder = 当前 thread） | 允许（holder = target thread） |

claim/complete 是 holder 在自己 thread 上的状态迁移，不产生跨 thread 投递；
强制走 `codeteam_post_message`，避免“把 claim 当消息发到别处”的歧义。

目标解析规则：

| custody.action | targetTaskId | targetThreadId | targets |
|---|---|---|---|
| `create` | **required**; 不允许从 thread 推断多个 task | optional; 若给必须等于 task.threadId | required; target profiles |
| `claim` | 拒绝：`custody_action_wrong_tool` | 拒绝：`custody_action_wrong_tool` | 拒绝 |
| `complete` | 拒绝：`custody_action_wrong_tool` | 拒绝：`custody_action_wrong_tool` | 拒绝 |
| `return` | optional; 若给必须等于 predecessor task | optional; 若给必须等于 predecessor thread | forbidden; server derives predecessor profile |
| `replace` | required (new holder task) | optional; must match | required (new holder profiles) |
| `withdraw` | optional; 若给必须等于 holder task | optional; 若给必须等于 holder thread | forbidden |

discussion 分支：至少给 `targetThreadId` 或 `targetTaskId`。

- 只给 `targetThreadId`：目标 thread 必须恰好有一个 non-done task；0 个
  `cross_thread_target_task_missing`，多个 `cross_thread_target_ambiguous`。
- 只给 `targetTaskId`：thread 从 task.threadId 派生。
- 两个都给：必须一致，否则 `cross_thread_target_mismatch`。
- custody `create` / `replace` 必须显式 `targetTaskId`，不允许“目标 thread 只有
  一个 task”这种推断；责任转移不能靠歧义解析。

message-only 的 `targets` 必填，不存在“no-wake FYI”分支：跨 thread 投递
一定产生 target queue entry；若不想唤醒任何人，用普通 message/CLI，而不是
cross-post。`return` / `withdraw` 若显式给 target 坐标但与服务端派生的
predecessor/holder 不一致，分别返回 `handoff_return_target_mismatch` /
`handoff_withdraw_target_mismatch`，不写 message/queue。

### 4.3 共享 `CustodyRequest`

```ts
type CustodyRequest =
  | {
      action: "create";
      handoffKind: "handoff" | "review_request" | "verdict" | "blocker"
                 | "spec_change" | "plan_revision" | "question";
      subject: string;
      subjectRef: string;
      actionFamily: "review" | "merge" | "investigate" | "implement"
                  | "verify" | "vision_guard";
      successorSlot: "reviewer" | "merge_owner" | "vision_guardian"
                   | "investigator" | "implementer" | "verifier";
      expectedArtifact: string;
      deadline: number;                      // epoch ms, > now
      terminalPredicate: TerminalPredicate;  // server catalog, validated at create
      mode?: "single" | "parallel";          // default: 1 target single, >1 parallel
      parallelIntent?: string;               // required iff parallel
      payload?: Record<string, unknown>;
      resolveMode?: "completes" | "bounces_back_to_owner"; // required iff blocker
      stageId?: string | null;
    }
  | { action: "claim"; handoffId: string }
  | { action: "complete"; handoffId: string; evidenceRef: string; result: Record<string, unknown> }
  | {
      action: "return";
      handoffId: string;
      leaseId: string;
      expectedGeneration: number;
      groundingEvidenceRef: string;
      reason?: string;
    }
  | {
      action: "replace";
      handoffId: string;
      leaseId: string;
      expectedGeneration: number;
      groundingEvidenceRef: string;
      terminalPredicate?: TerminalPredicate;
      mode?: "single" | "parallel";
      parallelIntent?: string;
    }
  | { action: "withdraw"; handoffId: string; reason: string };
```

`replace` 的新 holder 目标复用顶层 `targets`，custody 内不重复 `targets`。
`return` / `replace` 的 `groundingEvidenceRef` 必须引用该 handoff 的
`handoff.returned` custody event，格式固定为
`custody:<handoffId>:<generation>:<seq>`；校验是精确 event 查找 +
generation 匹配，不是任意非空字符串。格式正确但指向别人的 return 事件
返回 `handoff_return_proof_mismatch`。
**每个 custody action 都 append 恰好一条 durable anchor message**（create /
return / replace 是 `handoff` message；claim / complete / withdraw 是 `status`
message，`controlRef` 指 handoff）。这条 message 是
`a2a_requests.message_id` 的非空锚点，也是 thread 历史里的可审计记录；它不
产生新 queue/wake（create/replace 的 queue 是责任投递，不是 anchor 的额外
wake）。`bodyMd` 只覆盖 anchor message 的正文，不改变 idempotency/route。

create/replace 的 `targets` 必须共享同一个 target execution role（parallel
holders 同 role）；不同 role 的 target 不能混在同一条 handoff 里。
`terminalPredicate.kind='review_delivered'` 的 `headSha` 必须是小写 40 或 64
位 Git OID。`payload.authorization` / `payload.crossThread` / `payload.policy*`
是 server-owned key；调用方 payload 不得设置，server 可覆盖/合并。

`TerminalPredicate` 在 Phase A 固定为现有 resolver 支持的两类：

```ts
type TerminalPredicate =
  | { kind: "run_completed" }
  | { kind: "review_delivered"; headSha: string };
```

未知 predicate 在 `create` 时返回 `terminal_predicate_unsupported`，不等到
completion 才失败。扩展 predicate 必须同 PR 加 resolver 证据和负例。

### 4.4 结果形状

```ts
type A2AResult =
  | { mode: "discussion"; message: Message; queueEntry: QueueEntry | null }
  | { mode: "custody"; action: "create"; handoff: Handoff; message: Message; queueEntry: QueueEntry | null }
  | { mode: "custody"; action: "claim"; status: "claimed" | "safe_wait" | "terminal_handoff"; handoff?: Handoff; reason?: string; message: Message }
  | { mode: "custody"; action: "complete"; status: "candidate_recorded"; handoff: Handoff; message: Message }
  | { mode: "custody"; action: "return"; status: "returned" | "parallel_rejection_recorded"; handoff: Handoff; message: Message; queueEntry?: QueueEntry | null }
  | { mode: "custody"; action: "replace"; status: "replaced"; handoff: Handoff; message: Message; queueEntry?: QueueEntry | null }
  | { mode: "custody"; action: "withdraw"; status: "withdrawn"; handoff: Handoff; message: Message };
```

`claim` 的 `safe_wait` 不是错误：非 holder / scope mismatch 只返回最小
`reason`，不返回 handoff body。`complete` 永远只返回 candidate；`verified`
只能由 server-owned resolver 写。

### 4.5 Typed errors

所有拒绝都在写 message/queue/custody 之前完成。错误码是稳定契约，不允许
“先写后异步发现没权限”。

| code | 触发 |
|---|---|
| `a2a_branch_invalid` | discussion/custody 同时出现或都缺失 |
| `custody_action_unknown` | 未知 custody.action |
| `custody_action_wrong_tool` | claim/complete 被发到 `codeteam_cross_post_message` |
| `custody_action_unavailable` | `replace` 在 Phase B 尚未实现；typed 拒绝，不降级 |
| `custody_field_missing` | 当前 action 缺少必填字段（message 带字段名） |
| `custody_field_forbidden` | 当前 action 不接受该字段 |
| `custody_targets_required` | create/replace 缺 targets |
| `custody_targets_not_allowed` | claim/complete/return/withdraw 带 targets |
| `targets_too_many` | targets 超过 32 个 |
| `idempotency_key_required` | 需要 clientMessageId 的 action 缺失 |
| `idempotency_conflict` | 同 clientMessageId 不同 intent |
| `loop_guard_live_handoff` | 同 owner + canonical action 已有 live handoff |
| `target_profile_not_found` | target profile 不存在 |
| `target_disabled` | target profile 非 active |
| `target_session_missing` | target profile 在 target task 上没有 active session |
| `target_session_ambiguous` | target profile 有多个 active session |
| `target_task_not_found` | target task 不存在 |
| `target_task_done` | target task 已 done |
| `target_task_disposed` | target task disposition 为 canceled/abandoned |
| `target_task_ambiguous` | 只给 thread 且有多个 non-done task |
| `target_thread_not_found` | target thread 不存在 |
| `target_thread_archived` | target thread archived |
| `cross_thread_target_mismatch` | targetThreadId 与 targetTask.threadId 不一致 |
| `cross_thread_same_thread` | 用 cross_post 指向当前 thread；提示用 post_message |
| `cross_thread_forbidden` | source/target user 不一致 |
| `cross_thread_user_unpaired` | source/target task/session 的 userId 为 null 或 `"unpaired-user"` |
| `cross_thread_reply_to_invalid` | replyTo 不在 target thread/task |
| `reply_to_task_mismatch` | replyTo 与当前/目标 task 不一致 |
| `target_self` | targets 包含 source principal profile |
| `cross_thread_depth_exceeded` | cross-thread depth 超过独立上限 |
| `cross_thread_target_not_ready` | custody create/replace 时 target task 没有 worktree（message-only 允许 durable message + drain defer） |
| `mention_target_mismatch` | 正文行首 @handle 解析到的 profile 不在 targets 中 |
| `handoff_not_found` | handoffId 不存在 |
| `handoff_scope_mismatch` | 调用 principal 不在 handoff 的 holder/source scope |
| `handoff_terminal` | handoff 已 consumed/withdrawn/expired |
| `handoff_claim_conflict` | 同 holder 第二 run / single 已被占用；claim 返回 safe_wait |
| `handoff_completion_without_claim` | complete 时没有 active holder claim |
| `handoff_return_holder_mismatch` | return 的 cat/thread 不是当前 single holder |
| `handoff_return_target_mismatch` | return 显式给的 targetTaskId/targetThreadId 与服务端派生的 predecessor 不一致 |
| `handoff_return_predecessor_missing` | 没有 predecessor 坐标 |
| `handoff_return_predecessor_invalid` | predecessor task done / thread archived / 没有可执行 session |
| `handoff_return_parallel_unsupported` | parallel lease 请求 whole-lease return；只记录 rejecting holder outcome |
| `handoff_return_stale_generation` | leaseId/generation 不是当前 generation |
| `handoff_return_proof_required` | replace/reattach 缺 exact return proof |
| `handoff_return_proof_mismatch` | proof 格式正确但指向别的 handoff/generation/return 事件 |
| `handoff_replace_forbidden` | replace issuer 不是 author/holder task owner 或 policy 不允许 |
| `handoff_withdraw_forbidden` | 非 author 执行 withdraw |
| `handoff_withdraw_target_mismatch` | withdraw 显式给的 targetTaskId/targetThreadId 与服务端派生的 holder 不一致 |
| `terminal_predicate_unsupported` | create 时 predicate 不在 catalog |
| `a2a_depth_exceeded` | same-thread depth 超过上限（保留现有语义） |
| `sop_policy_missing` | task/backlog/SOP 没有可用的 handoff policy |
| `sop_policy_denied` | policy 没有匹配的 transition |
| `sop_policy_ambiguous` | 多个 transition 匹配且约束冲突 |
| `control_plane_unavailable` | worker 控制面不可用；A2A 与 mutating tool 一起 fail closed |

## 5. Target / ACL / queue 解析

### 5.1 Source principal

`resolveRunPrincipal` 继续从 per-run token → run → task/session/profile
派生；不接受 tool args 自报身份。Source 额外断言：

- `principal.userId` 非空、非 `"unpaired-user"`；
- `principal.taskId` / `principal.threadId` / `principal.profileId` 与
  run/session 一致（现有检查保留）；
- `principal.role` 是 execution role，不是 profile primary role。

Source 侧保留现有 `session.userId ?? task.userId` fallback 是**有意的不对称**：
它锚定 principal 自己的 task 域，兼容 session.userId 为 null 的存量任务；
target 侧必须由 session 独立证明，禁止 fallback。Phase B 不要向任一方向
“修正”这个不对称，否则要么打断存量任务，要么削弱 target ACL。

### 5.2 Target task/thread

1. 解析 target task（规则见 §4.2）；task 必须存在、未 done，且
   `disposition === null`（canceled/abandoned 不可执行）。
2. target thread 必须是 active；archived 拒绝。
3. target task 必须属于 target thread（`task.threadId === targetThreadId`）。
4. target task 必须与 source 同 user（§5.4）。
5. custody create/replace：`targetTask.worktree` 必须存在；否则
   `cross_thread_target_not_ready`。message-only 不要求 worktree：message 与
   queue 可以先 durable，drain 时按现有 `dispatch_not_ready` defer + audit。
   Budget / deployment wait / managed-work conflict 仍是 drain-time gates；
   cross-thread custody 不绕过它们；create 成功后按现有 dispatch 语义
   defer/withdraw。

### 5.3 Target profile/session

`targets` 每个 profile：

- profile 存在且 `status === "active"`；
- profile 不能是 source principal profile（`target_self`）；custody 需要
  self-handoff 时必须另立 `claimOrigin=existing_standing` 语义，F017 不做。
- 在 target task 上恰好一个 `status === "active"` 的 AgentSession；
- session.threadId === targetThreadId；
- session.profileId === target profile；
- session.userId 非空、非 `"unpaired-user"`、等于 source principal userId。

不做 “target 不是 participant 也 warning 放行”：codeteam 没有 participants
持久化，且 message wake 需要可执行 session。没有 session 就 typed reject，
不写 message/queue。

### 5.4 User / ACL 矩阵

| 坐标 | 要求 |
|---|---|
| source principal.userId | 非空、非 `"unpaired-user"` |
| target task.userId | 非空、非 `"unpaired-user"`、=== source |
| target session.userId | 非空、非 `"unpaired-user"`、=== source（独立检查，不 fallback） |
| target thread | active；不做 owner 检查（thread 无 owner） |
| holder task | 必须属于 target/current thread；cross-thread 时 holder task === target task |
| predecessor task | return 时必须存在；predecessor thread 与 predecessor task.threadId 一致 |
| source task（create）/ replace issuer | create 的 source task non-done、disposition null；replace issuer 是 author 或 holder task owner，具体由 policy + `handoff_replace_forbidden` 校验 |
| holder task（claim/complete/return） | non-done、disposition null |

**有意偏离 Clowder：** Clowder 的 thread access 是 user-scoped；codeteam 的
thread 没有 user 列。F017 不新增 thread owner 表，也不从 task 猜 thread
owner；task/session 双锚是 codeteam 的真实授权边界。

`replace` 的 issuer 语义固定为：handoff author（source task）或 holder task
owner；不是任意同 profile run。issuer 必须由 policy 授权，否则
`handoff_replace_forbidden`；return 链不能让原作者失去 replace/withdraw 的
authority。

### 5.5 Target run / token

- 模型不能给 `targetSessionId` / `targetRunId` / `targetToken`。
- Cross-post 只写 target message + target queue entry；`DispatchService.cutoverEntry`
  在 target task 上调用 `resolveRoute(targetTaskId, targetProfileId)`，创建
  target run，再由 `mintInvocationCredential` 从 target run/session/task mint
  per-run token。
- Source run/token 只出现在 provenance；不得作为 target credential 的
  `parentRunId`，也不得作为 target run 的 `parentRunId`。target run 是
  target task 的新根 run。
- 目标 run 的预算计入 target task；不记 source task。

### 5.6 Depth / loop guard / idempotency

**Depth：** `nextDepth(principal) = principal.chainMetadata.a2aDepth + 1`，
换 thread 不重置。Same-thread 上限保留 `CODETEAM_A2A_MAX_DEPTH`（默认 32）；
cross-thread 使用独立 `CODETEAM_CROSS_THREAD_MAX_DEPTH`（默认 16）。超过
分别返回 `a2a_depth_exceeded` / `cross_thread_depth_exceeded`。

**Loop guard：** canonical action key 继续使用
`${subjectRef}:${actionFamily}:${successorSlot}`。现状 enforcement 是全局
DB partial unique index `handoffs_live_action ON
handoffs(canonical_action_key) WHERE status IN ('pending','claimed')`
（003-governance.ts:87）；`findLiveByCanonicalActionKey` 的 task scope 只是
typed 预查，不是 enforcement。§10.5 二选一：

- (a) 保持全局：零迁移；跨 owner 同 key 继续禁止；`owner_user_id` 只用于
  snapshot 分组。
- (b) owner-scoped：同一 owner 跨 task 仍只能一条 live；跨 owner 同 key 从
  禁止→允许（有意放宽）。必须 drop 旧 index、建
  `(owner_user_id, canonical_action_key)` partial unique index，并把并发
  SQLite UNIQUE 冲突映射为 `loop_guard_live_handoff`。

**Idempotency：** `a2a_requests` 继续作为唯一 operation receipt ledger；
unique key 保持现有 `(task_id, profile_id, request_id)`（`task_id` 是 **caller
principal task**，`request_id` 即 `clientMessageId`；create/withdraw 的 caller
通常是 source task，claim/complete/return 的 caller 是 holder task）。
`message_id` 保持非空：每个 action 都写 §4.3 的 anchor message。
Phase B 扩展列：

| 列 | 用途 |
|---|---|
| `scope` | `same_thread` / `cross_thread` |
| `target_task_id` / `target_thread_id` | anchor message 的 target task/thread（create 是 holder；return 是 predecessor；claim/complete 是 holder） |
| `handoff_id` | custody operation 关联 |
| `result_json` | 已提交 operation 的 typed result，用于 replay |

`intent_hash` 覆盖：工具（post/cross_post）、branch（discussion/custody）、
custody.action、source task/thread、target task/thread、targets、bodyMd、
replyTo、全部 custody 字段。同 key 同 hash → replay 原 result，不再执行；
同 key 不同 hash → `idempotency_conflict`。Custody transition 的 replay 返回
首次提交 receipt（`replayed:true`），不因 handoff 已推进而重跑。

**Return 是例外：** return 的 custody transition + returnDeliveryState=pending
+ return carrier message 先原子提交；queue admission 是单独的 delivery 步骤。
enqueue 失败不回滚 return（否则 holder 会“退不回去”），returnDelivery 保持
pending/overdue；recovery / 同一 clientMessageId retry 只重试 carrier
enqueue，不重跑 return transition、不创建第二个 generation。

`clientMessageId` 映射到现有 `a2a_requests.request_id`；`task_id` 是 caller
principal task，`target_task_id`/`target_thread_id` 是 anchor message 的
坐标。create/claim/complete/withdraw/replace 的 message + custody state +
queue change + `a2a_requests` receipt + audit 必须在同一个
`store.transaction.run` 内提交；任何一步失败整体回滚。return 按上面的例外
处理。claim/complete 即使返回 `safe_wait`/`terminal_handoff` 也写一条 status
anchor message 记录本次 attempt；它不改变 custody。

### 5.7 Queue / dispatch 映射

Cross-post discussion：

```text
message: threadId=targetThreadId, taskId=targetTaskId,
         authorKind="agent", authorId=sourceProfileId,
         kind=discussion kind, bodyMd, replyTo (target thread),
         crossPost={sourceThreadId, sourceTaskId, sourceProfileId, sourceRunId,
                    sourceMessageId, targetThreadId, targetTaskId}
queue:   threadId=targetThreadId, sourceId=message.id,
         sourceRecordId=null, sourceKind="message_wake",
         targets=targetProfileIds, sourceCategory="cross_thread_message",
         authorIntent[target]={intent:"next_work",
           chainMetadata:{a2aDepth, crossThread:true, sourceRunId,
                          sourceTaskId, sourceThreadId}}
```

Cross-post custody create：

```text
handoff: taskId=sourceTaskId, holderTaskId=targetTaskId,
         holderThreadId=targetThreadId,
         predecessorTaskId=sourceTaskId, predecessorThreadId=sourceThreadId,
         holderProfileIds=targetProfileIds, ...
message: threadId=targetThreadId, taskId=targetTaskId,
         kind="handoff", controlRef=handoff.id,
         crossPost={...source coordinates, sourceMessageId, custodyId=handoff.id}
queue:   threadId=targetThreadId, sourceId=message.id,
         sourceRecordId=handoff.id, sourceKind="message_wake",
         targets=targetProfileIds, sourceCategory="cross_thread_custody",
         authorIntent[target]={intent:"handoff", actionFamily,
           chainMetadata:{a2aDepth, crossThread:true, sourceRunId,
                          sourceTaskId, sourceThreadId, custodyId}}
```

Create 时 source thread 不自动复制一条 message；source 侧的 durable 记录是
handoff row + tool receipt。Normal completion 才在 predecessor thread 写
status（§5.8）。

这是有意的可见性决策：source thread 对 cross-thread custody create 全程
静默，直到 completion / return / expiry 的 status anchor。若 operator 要求
source 侧立即有 status anchor，作为 §10.11 的选择显式打开；不要在 Phase B
自行加广播。

后续完全复用现有链：`queue claim → cutoverEntry → resolveRoute(targetTaskId)
→ target run → token → worker → response bubble`。`cutoverEntry` 从 target
message 的 `taskId` 得到 target task，因此不需要跨 task 特殊分支；target
run 的 `parentRunId` 保持 null。`cutoverEntry` 的 `boundHandoff` 必须按
`holderTaskId/holderThreadId` 绑定（§3.5）；否则 holder worker 不会收到
assigned handoff。Cross-thread `chainMetadata` 用 `sourceRunId` 表示来源，
不使用会制造伪 lineage 的 `parentRunId`；同 thread legacy 的
`parentRunId` 在迁移期保留。

Return carrier：

```text
message: threadId=predecessorThreadId, taskId=predecessorTaskId,
         authorKind="agent", authorId=holderProfileId,
         kind="handoff", controlRef=handoff.id,
         crossPost={sourceThreadId=holderThreadId,
                    sourceTaskId=holderTaskId,
                    targetThreadId=predecessorThreadId,
                    targetTaskId=predecessorTaskId,
                    returnOf=handoff.id, generation}
queue:   threadId=predecessorThreadId, sourceId=message.id,
         sourceRecordId=handoff.id, sourceKind="message_wake",
         targets=[predecessorProfileId],
         sourceCategory="cross_thread_return",
         authorIntent[predecessor]={intent:"handoff", actionFamily,
           chainMetadata:{a2aDepth, crossThread:true, returnOf:handoff.id,
                          generation}}
```

return delivery 只有 queue admission 成功后写
`returnDeliveryState='delivered'` + evidence
`queue:<messageId>:return_enqueued`；queue admission 失败保持 pending/overdue，
不写 delivered，不补偿删除 message。
Return carrier 的 `kind` 固定为 `handoff`；`findHandoffMessage` 仍按最早
handoff message 取 create carrier，return 后的 live carrier 一律走
`dispatchDeliveredMessageId`，`controlRef` 只用于 create replay。

**ControlRef 查找陷阱：** create message 和所有 status anchor 都可以带
`controlRef=handoff.id`，因此 `messages.findByControlRef` 不再能假设
“一个 handoff 只有一条 message”。Phase B 必须新增
`findHandoffMessage(handoffId)`（过滤 `kind='handoff'`，按 seq 升序取第一条）
用于 create replay / withdraw queue lookup；不能把 claim/complete 的 status
message 误当成 handoff shell。`handoff.dispatchDeliveredMessageId` 仍优先用于
定位 holder queue entry。

### 5.8 Terminal / return / recovery

- `complete` 只写 completion candidate；`HandoffTerminalResolver` 按
  `terminalPredicate` 验证 holder run / review evidence，再
  `commitCompletion({verified:true})`。agent 不能自签 verified。Terminal
  commit 与 holder/predecessor status messages 必须在同一 transaction；
  status message 以 `(handoffId, generation, audience)` 去重。
- Cross-thread resolver 的 review evidence 必须查 **holder task**，不是 source
  task；`run_completed` 查 holder run。未知 predicate 在 create 时就拒绝。
- Normal completion：server 在 holder thread/task append holder status，在
  predecessor thread/task append source status（带 evidenceRef + target
  coordinates）；两者 `controlRef=handoff.id`。source status 不自动 enqueue
  新 run；避免 completion 产生 A2A ping-pong。source 需要行动时可显式
  post/return。两条 status message 以 `(handoffId, generation, audience)` 去重，
  resolver 重试不重复 append；same-thread 时 holder 与 predecessor 是同一
  audience，只写一条。
- `return`：single lease 回 predecessor，generation+1，holderProfileIds /
  holderTaskId / holderThreadId 改成 predecessor；predecessorProfileId /
  predecessorTaskId / predecessorThreadId 改成 rejecting holder；
  fromRole/toRole 切成 rejecting holder / predecessor 的 execution role；
  completionCandidates / holderOutcomes 清空；append `returnTransitions`；
  status 回到 `pending`；claimedByRunId/claimedAt/claimedLeaseUntil/
  lastHeartbeatAt 清空；释放旧 holder claims；`attempt+1`；
  `returnDeliveryState='pending'`；return carrier 唤醒 predecessor。Return 前
  必须重新校验 predecessor task 非 done、disposition null、thread active、
  worktree 非空、predecessor task.userId === handoff.ownerUserId、
  predecessor profile 有 active session 且 session.userId ===
  handoff.ownerUserId；否则 `handoff_return_predecessor_invalid`。
  Return 还要求调用 run 是该 holder 的 active claim run
  （`claim.runId === principal.runId`）；同 profile 的另一个 run 不能代替
  holder 退球。
  parallel lease 不支持 whole-lease return，只记录 rejecting holder 的
  `rejected_ownership` outcome；其他 holder 继续。全部 holder 都 reject 时
  不自动回退；由 operator/SOP 决定 withdraw 或 replace。
  Return 的同一 `clientMessageId` 重试只重试 carrier enqueue（若
  returnDeliveryState 仍 pending/overdue），不重跑 return transition；recovery
  sweep 也走同一路径。Append `handoff.returned` custody event，payload 带
  source/holder 双 task/thread 坐标和 generation。Return carrier enqueue 成功
  后把 `dispatchDeliveredMessageId` 指向 return carrier message，使后续
  withdraw/queue lookup 使用当前 holder thread，而不是旧 holder thread。
  该字段从此表示“当前 live holder carrier”，create 时指向 holder 投递、
  return/replace 后指向新 carrier；原始 create carrier 通过
  `returnTransitions` + `messages.controlRef` 追溯。
- `withdraw`：pending queue targets 在 holder thread 置 `withdrawn`（保留行 +
  audit）；已 claimed holder 的 run 继续执行；claim-after-withdraw 返回
  `terminal_handoff`；complete-after-withdraw typed reject。非 author
  `handoff_withdraw_forbidden`。author 是 durable `authorProfileId`（create
  时的 source profile），不是当前 `predecessorProfileId`；return 链不能让
  原作者失去撤回权。handler 通过
  `handoff.dispatchDeliveredMessageId` 或 `messages.findByControlRef(handoff.id)`
  找到 holder anchor message，再按 `queue:<messageId>` 定位 queue entry；
  按 F016a D4 逐 target 清理 pending，claimed holder 不动。withdraw 同时清空
  returnDeliveryState/SLA，使尚未 enqueue 的 return carrier 变成 no-op；已
  enqueue 的 return queue target 按 D4 撤回。
- `replace` / reattach：只允许 exact leaseId + generation + return proof；
  stale/缺 proof fail closed；成功后 generation+1、新 holder 坐标、清空
  completionCandidates/holderOutcomes、status 回 `pending`、清空 claim 字段、
  释放旧 holder claims、`attempt+1`、append `replacementTransitions`、清除
  return delivery 状态；append `handoff.replaced` custody event。Phase C
  验收；Phase B 可先以
  `custody_action_unavailable` typed reject，但不得静默降级。replace 不是
  抢 active lease 的工具：只能用于 server-observed terminal/interrupted 后的
  generation replacement，或 returned-holder reattach。replace issuer 必须是
  handoff author 或 holder task owner，并由 SOP policy 授权；非 issuer
  `handoff_replace_forbidden`。Replace carrier enqueue 成功后同样更新
  `dispatchDeliveredMessageId` 到新 holder carrier。
  exact return proof 固定为 `custody:<handoffId>:<generation>:<seq>`，指向
  该 handoff 的 `handoff.returned` event；格式正确但指向别的 handoff/
  generation 返回 `handoff_return_proof_mismatch`。
- `expiry`：当前 recovery 按 `deadline_passed` 直接 expire，没有 thread
  可见 status anchor。Phase B 默认补 dual-side status anchor（holder +
  predecessor，`kind=status`，`audience` 双方）并加 E2E；若 operator 选择
  静默终态，必须在 §10.14 显式记录，不能默默保持无 anchor。
- Recovery：daemon startup / run interrupted 时，return delivery pending/
  overdue 重新 enqueue 同一 carrier（queue idempotency 防重复）；claimed run
  interrupted 释放 claim 并写 `handoff.recovered`；不能自签 completion，不能
  把 transport 状态写成 custody 终态。

**Holder claim scope：** claim 以 profile + holder task/thread 为界；同一
profile 在该 task/thread 的第一个 eligible run claim 成功后，第二个 run 得到
`safe_wait`。不把 handoff 绑定到某个特定 target run；target run 身份由
queue cutover 产生，claim 只验证它属于 holder task/thread。

## 6. Harness invariants

每条都必须有对应负例；Phase B/C 的 E2E 不能只测 happy path。

1. **Principal 只从 token 派生。** Tool args 的 `from*` / `ownerUserId` /
   `controlRef` / `verified` / target session/run/token 一律 unknown-field
   reject。
2. **Branch 互斥。** discussion 与 custody 不能同时出现；custody 缺字段
   typed reject，不降级成 message。
3. **Custody action 完整。** create 必须有 handoffKind/subject/subjectRef/
   actionFamily/successorSlot/expectedArtifact/deadline/terminalPredicate；
   blocker 必须有 resolveMode；parallel 必须有 parallelIntent。
4. **Target scope 可执行。** target task 非 done 且 disposition null、thread
   active、profile active、恰好一个 active session 且
   session.task/thread/profile 全匹配。
5. **User 三锚一致。** source principal / target task / target session 的
   userId 非空、非 sentinel、严格相等；target 不 fallback。
6. **Cross-thread custody 双 task 坐标。** holderTaskId 存在且等于 target
   task；holderThreadId === holderTask.threadId；predecessorTaskId/thread
   一致；缺任一坐标 typed reject。
7. **Session/token 不复用。** target run 在 target task/thread mint token；
   source run 只进 provenance；target run.parentRunId 为 null。
8. **一条 queue ledger。** Message + Queue Entry 是唯一 wake 账本；
   handoff/custody 不建第二队列；sourceRecordId 只放 target-local handoff id
   或 null（discussion）。
9. **Idempotency 单真相。** `(caller_task, caller_profile, clientMessageId)`
   唯一；同 key 同 intent replay；不同 intent conflict；transition replay 不
   重跑状态机。每个 action 有一条 durable anchor message，`message_id` 非空。
10. **Loop guard scope 由 operator 在 §10.5 选择。** (a) 全局唯一或
    (b) owner-scoped；两种都保证换 thread 不能绕过同 owner 的 live guard。
    若选 (b)，DB `(owner_user_id, canonical_action_key)` partial unique
    冲突必须映射为 `loop_guard_live_handoff`。
11. **Server-owned terminal。** complete 只写 candidate；resolver 验证后
    commit；agent 不能写 verified。
12. **Return 只由 explicit proof 驱动。** return/reattach 校验 leaseId/
    generation/holder thread/proof；parallel whole-lease return 返回
    typed unsupported；return delivery 只有 enqueue 后才能 delivered。
13. **失败不静默。** 所有 typed reject 在写 message/queue/custody 前完成；
    control plane 不可用时 A2A 与 mutating tool 一起 fail closed；drain 的
    poison/defer 保留现有 audit 语义。
14. **SOP 授权可复现。** Handoff 记录 policy id/version/digest/transition；
    同一输入在 policy 不变时可重放判断；没有可解析 policy 且没有 built-in
    default 时 custody fail closed。
15. **F016a 不回改。** 旧 `codeteam_a2a_send` 继续 same-thread-only；F016a
    D5 negative 继续有效，直到旧工具在 B3 被删除。
16. **事务原子（return 例外）。** create/claim/complete/withdraw/replace 的
    message + custody state + queue change + `a2a_requests` receipt + audit 在
    同一 transaction；失败整体回滚，不允许半条 custody。return 先原子提交
    custody + pending delivery + carrier message，再单独 enqueue；enqueue 失败
    保持 pending/overdue，可重试，不回滚 custody。
17. **replyTo 同 task。** replyTo 必须在目标 thread；message.taskId 为 null
    或等于目标 task，否则 `reply_to_task_mismatch`。
18. **Server-owned payload keys。** `payload.authorization` / `payload.crossThread`
    / `payload.policy*` 不能由调用方设置；handoff 记录由 server 写入的
    policy identity/digest。
19. **Wait 不裁决 custody。** wait 只驱动唤醒；return delivery / handoff
    expiry / completion 仍由 custody 状态机和 explicit deadline/operator/
    recovery 决定，wait service 不调用 handoff expire。
20. **Tool registry 与 role 门禁同步。** `A2A_TOOL_NAMES` 必须包含
    `codeteam_thread_context` 与两个新入口；旧 5 个名字仅在 B3 移除，
    移除后模块加载、各 role allowlist 和 unknown-tool 负例都要有回归。

## 7. SOP / skill 方向模型与 peer @

### 7.1 删除硬编码方向矩阵

现状：

- `DEFAULT_ACTION_PAIRS` 是 TS 常量：
  `packages/codeteam-daemon/src/policy/handoffs.ts:23`。
- `A2A_ROLE_TOOLS` 把 architect/coder/reviewer/verifier 固定成 tool 子集：
  `packages/codeteam-daemon/src/workers/tool-policy.ts:15`（:12-13 是
  `THREAD_CONTEXT_TOOL` 的 find/throw，不要混用行号）。
- `assertHandoffDirection` 用 role pair + kind 白名单：
  `packages/codeteam-daemon/src/policy/handoffs.ts:53`。

这三处不能继续作为方向真相。Phase B 改成：

1. `sop-definitions/development.yaml` 新增顶层 `handoff_policy`；
2. codegen 校验并生成 typed policy；
3. handoff create 读取 task → backlog item → `workflow_sops.sop_definition_id`
   → policy，校验 transition；
4. handoff payload 记录 `authorization: {policyId, policyVersion,
   policyDigest, transitionId}`；
5. 旧 `DEFAULT_ACTION_PAIRS` 只作为 **内置 development policy 的数据来源**
   一次性迁移，不再在代码路径里直接判断。

### 7.2 `handoff_policy` 形状

```yaml
handoff_policy:
  version: 1
  allow_unknown: false          # 没有匹配 = fail closed
  transitions:
    - id: coder-to-reviewer
      from_role: coder
      to_role: reviewer
      handoff_kind: review_request
      action_family: review
      successor_slot: reviewer
      require_independent: true
    - id: reviewer-to-coder
      from_role: reviewer
      to_role: coder
      handoff_kind: verdict
      action_family: implement
      successor_slot: implementer
    - id: coder-to-verifier
      from_role: coder
      to_role: verifier
      handoff_kind: handoff
      action_family: verify
      successor_slot: verifier
    - id: verifier-to-coder
      from_role: verifier
      to_role: coder
      handoff_kind: verdict
      action_family: implement
      successor_slot: implementer
    - id: peer-review-any
      from_role: "*"
      to_role: "*"
      handoff_kind: review_request
      action_family: review
      successor_slot: reviewer
      require_independent: true
    - id: any-to-human-blocker
      from_role: "*"
      to_role: human
      handoff_kind: blocker
      action_family: investigate
      successor_slot: investigator
      require_independent: false
    - id: reviewer-to-human-verdict
      from_role: reviewer
      to_role: human
      handoff_kind: verdict
      action_family: review
      successor_slot: reviewer
      require_independent: false
    - id: any-to-human-spec-change
      from_role: "*"
      to_role: human
      handoff_kind: spec_change
      action_family: investigate
      successor_slot: investigator
      require_independent: false
    - id: any-to-human-plan-revision
      from_role: "*"
      to_role: human
      handoff_kind: plan_revision
      action_family: investigate
      successor_slot: investigator
      require_independent: false
    - id: any-to-human-question
      from_role: "*"
      to_role: human
      handoff_kind: question
      action_family: investigate
      successor_slot: investigator
      require_independent: false
```

以上 10 条是 built-in development policy 的**规范性迁移全集**：9 条来自
现有 `DEFAULT_ACTION_PAIRS`，另加 F017 的 `peer-review-any`。Phase B 必须
有回归断言 built-in policy 保持现有 9 条 pair 全部可达，尤其
`reviewer->human:verdict`、`*->human:spec_change`、`*->human:plan_revision`、
`*->human:question` 四条升级边；示例 yaml 不是裁剪后的子集。

| 旧 pair | 新 transition |
|---|---|
| `coder->reviewer:review` | `coder-to-reviewer` |
| `reviewer->coder:verdict` | `reviewer-to-coder` |
| `reviewer->human:verdict` | `reviewer-to-human-verdict` |
| `coder->verifier:handoff` | `coder-to-verifier` |
| `verifier->coder:verdict` | `verifier-to-coder` |
| `*->human:blocker` | `any-to-human-blocker` |
| `*->human:spec_change` | `any-to-human-spec-change` |
| `*->human:plan_revision` | `any-to-human-plan-revision` |
| `*->human:question` | `any-to-human-question` |
| （F017 新增）peer review | `peer-review-any` |

`require_independent` 由 harness 校验：target profile / run 不能是当前
author 的同一 profile；是否要求跨 model family 由 policy 显式声明
`require_cross_family: true`，默认 false（避免把所有 review 都锁死）。

### 7.3 授权算法

```text
resolve task -> backlog item -> workflow_sops.sop_definition_id
load handoff_policy(version) -> digest
match transition:
  from_role = principal.role            # execution role
  to_role   = target session.role
  handoff_kind / action_family / successor_slot = custody fields
  require_independent / require_cross_family = policy
if no transition -> sop_policy_denied
if multiple transitions match with conflicting requirements -> sop_policy_ambiguous
write handoff.payload.authorization = {policyId, version, digest, transitionId}
```

不再用“role 表里有没有这个工具”来决定 custody；tool allowlist 只决定模型
能否调用入口，custody 方向由 policy 决定。所有 agent 默认都有两个入口；
是否允许某次交接由 policy + target scope + custody 完整性决定。

- Tool allowlist 是 **capability**，不是 direction：`A2A_ROLE_TOOLS` 的方向
  语义移到 policy；所有 role 的 allowlist 至少包含两个入口，是否允许 custody
  由 policy 判断。
- Policy lookup 不要求 `WorkflowSop.stage` 迁移；stage 仍是告示牌。默认
  `development` definition 的 `handoff_policy` 在没有 backlog/SOP 的任务上
  作为 built-in default；只有连 built-in default 都不可用时才
  `sop_policy_missing`。
- 多个 transition 匹配时按 specificity（exact role > wildcard，exact
  handoff_kind > wildcard）选最具体的一条；requirements 冲突且无法分胜负才
  `sop_policy_ambiguous`。

### 7.4 Peer @ 路由

**推荐结论：`targets` 是唯一路由权威；行首 `@handle` 是可见标记 + 一致性
校验，不是独立路由源。**

理由：

- codeteam 已拍板 tool-call-first，正文 `@` 不作路由权威：
  `docs/README.md` 目标态 A2A 路由段；`docs/plans/0005-plan-review-resolutions.md`
  §10 D5。
- 文本路由会把“谁被唤醒”变成不可审计的字符串解析；cross-thread 还会叠加
  target task/thread 解析，风险高于收益。
- “所有 agent 都能 @ 另一个 agent”的愿景由 `targets` + 可见 `→ @displayName`
  满足；peer 的 profile id 是显式、可校验的。

校验规则：

1. `targets` 非空、unique；每个 target 必须解析到当前操作 scope 内的
   active profile。
2. 只有 **discussion / create / replace**（有 `targets` 的 routing action）
   才校验 `bodyMd` 行首 `@handle`（strip code fence，允许 markdown 前缀，
   支持非 ASCII）。仅当 handle **唯一**解析到一个 active profile 且该
   profile 不在 `targets` 中时，返回 `mention_target_mismatch`，不写
   message/queue；handle 多解（displayName 非唯一）时宽松跳过校验，不误杀
   合法消息。
3. `targets` 中未被正文提到的 profile，继续追加 `→ @displayName` 可见
   marker（现有行为）。
4. claim/complete/return/withdraw 不解析正文 `bodyMd`，也不做 mention 一致性
   校验；`bodyMd` 只作可见 reason/status。这样 return 理由里写“@某人 这块
   退给你”不会被误判为 target。
5. 如果未来 operator 要文本-only @ 路由，必须单独决策并加 exact-handle →
   profile 的歧义/disabled/scope 负例；F017 不默认开启。

Phase B 只新增一个 line-start mention parser 做 **display/一致性** 校验；
它不产生 target，也不替代 `targets`。parser 规则可参考
`packages/api/src/domains/cats/services/agents/routing/a2a-mentions.ts:107 附近`（Clowder
的 authoritative parser），但 codeteam 不复用其路由执行路径。

### 7.5 标准链路示例

```text
coder --create(review_request, actionFamily=review, successorSlot=reviewer)--> reviewer
reviewer --claim--> reviewer --complete(candidate)--> server verifies
reviewer --create(verdict, actionFamily=implement, successorSlot=implementer)--> coder
coder --claim--> coder --complete(candidate)--> server verifies
coder --create(handoff, actionFamily=verify, successorSlot=verifier)--> verifier
verifier --claim--> verifier --complete(candidate)--> server verifies
```

每一步都是显式 custody；没有隐式“complete 后自动下一跳”。SOP policy 决定
这些 transition 是否允许；skill 负责告诉模型“开发场景推荐这个顺序”，
harness 不读自然语言。

## 8. 持久化与迁移

### 8.1 Additive schema

| 表 | 变更 | 兼容/回填 |
|---|---|---|
| `messages` | 新增 nullable `cross_post_json` | 旧 message 为 null；cross-post message 写 provenance |
| `handoffs` | 新增 nullable `holder_task_id`、`predecessor_task_id` | 旧行回填 `holder_task_id=task_id`、`predecessor_task_id=task_id`；代码对 null 也按 task_id 兼容 |
| `handoffs` | 新增 nullable `author_profile_id` | 旧行回填 `author_profile_id=predecessor_profile_id`；新 handoff 写 create principal profile；withdraw/replace 用它做 author authority |
| `handoffs` index | 现状全局 `handoffs_live_action` partial unique on `canonical_action_key` | (a) 保持；(b) drop + create `(owner_user_id, canonical_action_key)` partial unique；并发 UNIQUE → `loop_guard_live_handoff` |
| `handoffs` | 复用已有 `return_transitions_json` / `replacement_transitions_json` / `return_delivery_*` | Phase B 在 `Handoff` type/store 暴露并实现状态机；旧行默认 null/[] |
| `a2a_requests` | 新增 `scope`、`target_task_id`、`target_thread_id`、`handoff_id`、`result_json` | 旧行 `scope='same_thread'`；unique key 不变 |
| `queue_entries` | 无 schema 变更 | cross-thread 仍用同一 ledger；target message 的 taskId 驱动 route |
| `runs` / `invocation_credentials` | 无 schema 变更 | target run 正常 mint；source token 不复用 |

迁移必须 additive；不重建 `messages`/`handoffs` 主表，不删除旧列。SQLite
`ALTER TABLE ADD COLUMN` 足够。旧 handoff 的 holder task 回填是数据迁移，
不是语义推断：same-thread handoff 的 holder task 就是 source task。
例外：若 §10.5 选 (b)，drop/rebuild `handoffs_live_action` index 是本次唯一
非 additive schema 操作；必须放在同一 migration 中，并提供重建旧 index 的
回滚路径。

### 8.2 迁移/删除顺序

| 阶段 | 动作 | 出口 |
|---|---|---|
| B0 | operator 签本文；把 ADR-0001/ADR-0002 与 docs README 索引一并 commit；F017 plan 标记 Phase A contract frozen | 无产品代码；contract 入库 |
| B1 | 加 migration + store/type 扩展 + internal `A2AOperationService` + SOP policy codegen；不注册新工具 | 新服务 handler 测试；旧工具不变 |
| B2 | 注册 `codeteam_post_message` / `codeteam_cross_post_message`；把两个新名加入 `A2A_TOOL_NAMES`；保留 `codeteam_thread_context`；旧 5 工具仍注册但 deprecated；prompt/description/correction 优先新入口 | 新旧工具共同回归；新入口真实 RPC E2E；新名 allowlist 生效 |
| B3 | 从 `registerTool` / `A2A_TOOL_NAMES` / prompt / allowlist 移除旧 5 个名字；**保留** `codeteam_thread_context`；**保留**两个新名；保留 internal handlers | 旧工具名 unknown；thread_context 与两个新入口都在 `A2A_TOOL_NAMES` 且 role 门禁生效；模块加载回归 |
| C | 删除旧 alias/primitive、旧测试、`DEFAULT_ACTION_PAIRS`/`A2A_ROLE_TOOLS`；docs/BACKLOG 收口 | F017 目标态验收；无两套模型面 |

**B2 窗口必须短：** 最多一个 PR / 一个 release。旧工具 deprecation 只是
回滚窗口，不是长期兼容层。B3 后不再接受旧工具名。

B1 同时迁移现有测试/fixture 里不在 catalog 的 terminal predicate（例如
`review_verdict`）到 `run_completed` / `review_delivered`；旧的
resolver-time unknown-predicate 负例改成 create-time
`terminal_predicate_unsupported`。

### 8.3 Internal handler 保留范围

迁移期保留：

- `A2AToolHandlers.send/createHandoff/claimHandoff/completeHandoff/withdrawHandoff`
  作为 internal primitive；
- `HandoffStore`、`HandoffTerminalResolver`、`QueueStore`、
  `DispatchService`、token mint；
- 旧 audit action / eval metric label（历史口径）。
- `observation.ts` 的 missing-A2A-tool 检测：B2 必须同时识别新旧入口；
  B3 后只识别新入口，避免模型正确调用新工具却被误报 `missing_a2a_tool_call`。
- `A2A_SCHEMA_CORRECTION` 与 `hasA2AToolCall` 必须在 B2 同一 PR 更新；
  双注册窗口内不能给模型旧工具名指引。
- `codeteam_thread_context` 保留为只读 companion；`A2A_TOOL_NAMES` 在 B3
  后精确包含 `thread_context` + 两个新入口，不含旧 5 个名字。
- `prompt.ts` 重写（含 `return` / `replace` 语义）+ 两个新工具的
  description 契约：必须说明“discussion vs custody”“消息送达 ≠ 责任转移”
  “return 如何退球”。这是 Phase B 的交付物，不是解释性附注。

新增：

- `returnHandoff` / `replaceHandoff`（或等价 state machine method）；
- `Handoff.authorProfileId`（durable create author；不以 predecessorProfileId
  代替）；
- loop guard lookup：按 §10.5 的 (a) 全局或 (b) owner-scoped；若 (b)，
  snapshot 也按 owner+key 分组；
- return delivery state / replacement transitions；
- `A2AOperationService`（union 解析、typed errors、idempotency receipt）。

若 §10.5 选 (b)，`loopGuardSnapshot` 也要按
`owner_user_id + canonical_action_key` 分组；否则两个 owner 的同名
canonical action 会互相污染统计。`HandoffStore.list` 增加 `holderTaskId`
filter，供 holder-side read model 使用。

删除条件：

- 新入口 E2E 覆盖 §9 全部行；
- prompt/allowlist/registry 无旧工具名；
- 一个 dogfood/回滚窗口无需要；
- operator 确认 B3/C。

### 8.4 回滚

- B1/B2：旧工具仍注册，回滚只需把 prompt/allowlist 指回旧工具；DB
  additive 列保留，不影响旧路径。
- B3：revert 提交可恢复旧 `registerTool`；数据不回滚。
- C：删除旧 primitive 是不可逆清理，必须在 B3 绿 + operator signoff 后做。

### 8.5 Reuse / divergence record

Phase B 同步更新：

- `docs/reuse/dispatch.md`：cross-thread message/custody 仍走一条 queue
  ledger；target run 计入 target task 预算；sourceRecordId 的 discussion/
  custody 差异。
- `docs/reuse/ball-custody.md`：holder task 双坐标、loop guard scope per
  §10.5、return delivery/replace 语义。
- `docs/reuse/REUSE-MATRIX.md`：如果 F017 不改变 `ball-custody` 的复用
  等级，显式记录“复用契约不变，仅 codeteam 坐标适配”；若改变等级，另写
  cell 卡更新理由。
- `docs/README.md:101` 的 tool-call-first 已拍板结论仍引用
  `a2a_send`/`handoff_create` 旧名；B3 删名后必须同步改写为两个新入口，
  不能留下失效引用。

这是 AGENTS.md 的 reuse-card 同步要求；不能只改代码不记录 divergence。

## 9. E2E 矩阵

所有 P0 场景必须至少有一条真实 pi RPC + mock provider 路径；handler 测试
只能补充，不能冒充 E2E。

| ID | 场景 | 必须观察 | 负例/边界 |
|---|---|---|---|
| A2A-S1 | same-thread discussion | message + one queue entry + parallel runs + one response bubble per run；无 handoff/custody event | depth 超限；disabled target；replyTo 跨 thread |
| A2A-S2 | same-thread custody create→claim→complete | handoff pending→claimed→consumed；message controlRef；custody events created/dispatched/claimed/completion_candidate/completed；server evidence | 非 holder safe_wait；claim 第二 run；complete 无 claim；agent 自签 verified 拒绝 |
| A2A-S3 | same-thread withdraw | pending queue targets withdrawn；claimed holder 继续；claim-after-withdraw terminal_handoff；complete-after-withdraw typed reject | 非 author forbidden；已 terminal 拒绝 |
| A2A-S4 | same-thread blocker | resolveMode completes / bounces_back_to_owner 两态；bounces 时 owner 被唤醒 | 缺 resolveMode；错误 resolveMode |
| A2A-S5 | same-thread loop/idempotency/depth | 同 requestId replay；不同 intent conflict；同 owner + canonical live 第二条拒绝 | 超深；同 owner 跨 task 同 canonical 拒绝；跨 owner 按 §10.5 模式 |
| A2A-X1 | cross-thread message-only | target message + target queue；source task 不变；无 handoff/custody；target bubble 在 target thread；target budget；source create 静默（除非 §10.11 加 anchor） | 0/多 non-done task；archived；无 session；不同 user；same-thread via cross-post；targets 缺失/no-wake |
| A2A-X2 | cross-thread custody create→claim→complete | source/holder task 双坐标；target run/token；target run parentRunId null；completion 后 source status message；custody events target coordinates；source create 静默 | targetTaskId 缺失；target not ready；source token 复用尝试拒绝；loop guard 按 §10.5 模式；return/withdraw target mismatch |
| A2A-X3 | cross-thread return | single lease generation+1；holder 回 predecessor；return carrier queue；returnDelivery pending→delivered only after enqueue；predecessor claim/complete | 非 holder；same cat wrong thread；stale generation；parallel whole-lease return unsupported；return/withdraw target mismatch |
| A2A-X4 | cross-thread recovery | daemon restart 后 pending return 重新 enqueue；interrupted run 释放 claim + recovered event；无重复 completion；expiry 双 status anchor（或 §10.14 静默签字） | 伪造 return proof；过期 generation；queue enqueue 失败保持 pending |
| A2A-X5 | cross-thread replace/reattach (Phase C) | new generation；new holder task/thread；exact return proof；old holder outcome | stale generation；wrong thread；candidate present；predicate mismatch；proof 指向别人的 return event |
| A2A-P1 | peer @ | 所有 role 都能显式 target peer；@handle 与 targets 一致；visible marker | mention 指向非 target → mismatch；text-only 不路由 |
| A2A-P2 | SOP coder→reviewer→coder→verifier | policy transition 记录 id/version/digest；四跳全部 claim/complete；无硬编码 role matrix；built-in policy == 现状 9 条 pair（含 4 条 human 升级边） | policy 缺失/不允许/ambiguous；require_independent 失败；human 升级边丢失 |
| A2A-N1 | typed/negative matrix | §4.5 每个 code 至少一个测试；拒绝前无 message/queue/custody 写入；return/withdraw target mismatch、proof mismatch | 不允许 fallback message-only；不允许 silent dead-letter |
| A2A-R1 | F016a regression | 旧 5 工具在 B2 前行为不变；F016a D5 cross-thread negative 继续有效；B3 后模块加载 + thread_context/两个新名 allowlist + 旧名 unknown；withdraw queue lookup 回归 | B3 后旧工具 unknown；F016a 文档不回改 |
| A2A-M1 | model guidance contract | worker prompt/tool descriptions 含两个新名、无旧名、含六 action 语义（尤其 return/replace）；`A2A_SCHEMA_CORRECTION` 不含旧指引 | 任一旧名残留；return 语义缺失 |
| A2A-L1 | loop guard scope | 按 §10.5 选择 (a) 全局或 (b) owner-scoped；同 owner 换 thread 不能开第二条 live；并发 UNIQUE → `loop_guard_live_handoff` | 跨 owner 行为与签字模式不符；generic error |
| A2A-E1 | control plane down | A2A + mutating tool fail closed；无 message/queue | read-only 仍可继续（现有语义） |

### 9.1 测试落点（Phase B/C）

- `daemon-a2a-ingress-e2e.test.ts`：A2A-X1 / X2 / X3 / X4 的真实 RPC 入口。
- `daemon-a2a-parallel-e2e.test.ts`：S1/S2/S3/S4/S5、X2/X3 的并行/terminal。
- `control-a2a-tools.test.ts`：§4.5 typed error matrix、idempotency、loop guard。
- `control-a2a-worker-e2e.test.ts`：新工具注册名、旧工具 deprecated、control
  plane down。
- `control-handoff-terminal.test.ts`：holder task resolver、return/replace 状态机。
- `control-custody-wait.test.ts`：return delivery / recovery 与 wait 分离。
- `cli-producer-binding.test.ts`：F016a 旧入口回归。

### 9.2 验收命令

```bash
NODE_ENV=development npm --prefix packages/codeteam-daemon test -- \
  daemon-a2a-ingress-e2e daemon-a2a-parallel-e2e control-a2a-tools \
  control-a2a-worker-e2e control-handoff-terminal control-custody-wait \
  cli-producer-binding
NODE_ENV=development npx tsc --noEmit -p tsconfig.json
NODE_ENV=development npm run build:offline
```

Phase C 再跑 daemon 全量 + `npm run check`；纯文档 Phase A 只跑
`npm run check:doc-index` 与 `git diff --check`。

## 10. Phase A operator 必须确认的点

以下每项都影响 Phase B 实现；operator 确认前不进入 B。

1. **Custody union 范围。** 是否接受
   `create/claim/complete/return/replace/withdraw` 六 action；`replace` 放
   Phase C，其余 Phase B。
2. **Cross-thread custody 目标。** 是否接受 `targetTaskId` 必填、
   `targetThreadId` 派生/可选、target session/run/token 由服务端解析。
3. **ACL 锚。** 是否接受用 source principal + target task + target session
   三锚 userId 相等，不新增 thread owner；null/sentinel 全部拒绝。
4. **Message-only 目标解析。** 是否接受 `targetThreadId` 只给时要求目标
   thread 恰好一个 non-done task；custody 必须显式 `targetTaskId`。
5. **Loop guard scope（二选一）。** 现状是全局 DB unique，不是 task-scoped。
   - **(a) 保持全局唯一（零迁移）**：跨 owner 同 canonical key 继续禁止；
     `owner_user_id` 只用于 snapshot 分组。
   - **(b) 放宽为 owner-scoped**：同一 owner 跨 task 仍只能一条 live；跨
     owner 同 key 从禁止→允许。这是**有意放宽**，不是更严格；需要 drop 旧
     index、建 `(owner_user_id, canonical_action_key)` partial unique，并把
     并发 UNIQUE 映射为 `loop_guard_live_handoff`。
6. **SOP 授权源。** 是否接受 `sop-definitions/development.yaml` 的
   `handoff_policy` 作为机器授权真相，skill 只做方向说明；没有可解析 policy
   且没有 built-in default 时 custody fail closed。
7. **Peer @。** 是否接受 `targets` 唯一路由权威、行首 `@handle` 只做一致
   性校验；不开启 text-only 路由。
8. **迁移窗口。** 是否接受 B1 internal → B2 新旧工具短窗口 → B3 删除旧
   工具 → C 清理 primitive；B2 最多一个 PR/release。
9. **Return/parallel。** 是否接受 single return to predecessor；parallel
   whole-lease return unsupported，只记录 rejecting holder outcome。
10. **Completion 通知。** 是否接受 normal completion 只在 source thread
    写 status message、不自动 wake；return/blocker bounces 才显式唤醒。
11. **Cross-thread custody create 的 source 可见性。** 当前设计 source
    thread 全程静默，直到 completion / return / expiry 的 status anchor。
    是否接受？若要 source 侧立即有 status anchor，请明确选择“加 anchor”，
    不要让 Phase B 自行广播。
12. **Cross-thread depth 默认值。** 是否接受
    `CODETEAM_CROSS_THREAD_MAX_DEPTH` 默认 16（same-thread 仍 32）。
13. **Message-only targets 必填。** 是否接受 cross-post discussion 也必须
    给 `targets`，不存在 no-wake FYI 分支；若要 FYI，用普通 message/CLI。
14. **Expiry 静默终态 vs 双锚。** 当前 recovery 在 `deadline_passed` 时直接
    expire，无 thread anchor、无 E2E 行。是否接受 Phase B 默认补 holder +
    predecessor 双 status anchor？若坚持静默终态，请明确签字。

## 11. Open unknowns / non-goals

| 项 | 当前建议 | 状态 |
|---|---|---|
| target task kind 是否必须 work | 不强制 kind；强制 non-done + worktree（custody） | 待 operator 确认 |
| message-only target 无 worktree | 允许 message + queue，drain `dispatch_not_ready` defer + audit | 待确认 |
| text-only @ 路由 | 不做；保持 tool-call-first | 推荐 |
| normal completion 自动 wake | 不做；只写 status message | 推荐 |
| cross-thread custody create source 可见性 | 默认静默到 completion/return/expiry anchor；可加 source anchor | 待 operator 确认 |
| cross-thread depth 默认 16 | 保留独立上限；same-thread 32 | 待 operator 确认 |
| message-only targets 必填 | 必填；无 no-wake FYI | 待 operator 确认 |
| expiry 静默终态 | 默认补双 status anchor；静默需 operator 签字 | 待 operator 确认 |
| `replace` 是否 Phase B | Phase C；B 先 typed `custody_action_unavailable` | 待确认 |
| `effectClass` / assign_work 审批 | 不做；本 feature 不引入 Approval Hub 新责任 | 非目标 |
| MCP ingress / `multi_mention` | 不做 | 非目标 |
| THREAD owner/participants 表 | 不做；task/session 双锚足够 | 非目标 |

## 12. Review focus

- **烁烁：** A2A/dispatch/queue/peer @、跨 thread queue/terminal/recovery、
  loop guard scope（global vs owner）、B2/B3 迁移顺序。
- **砚砚：** custody/auth/security/typed reject、target session/token 不复用、
  user 三锚、return/replace proof、control plane fail closed。
- **墨墨：** SOP/skill 方向模型、reuse/process、operator 体验、peer @ 与
  “消息送达 ≠ 责任转移”的可理解性。
- **宪宪：** feature ownership、contract 与 F016a/b/c 边界、Phase B/C 验收。

## 13. Phase A 退出条件

- 本文经三位 reviewer 给出明确 verdict（approve / changes requested + P1/P2/P3）。
- 所有 P1/P2 折入本文；P3 有 disposition。
- operator 对 §10 的 14 项给出书面确认或修改意见。
- 确认后 F017 plan 标记 Phase A contract frozen，才进入 Phase B。

[宪宪/deepseek-flash🐾]
