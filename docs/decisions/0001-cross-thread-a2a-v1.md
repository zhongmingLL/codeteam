---
title: "ADR-0001: cross-thread A2A v1 boundary"
doc_kind: decision
status: proposed
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash), 烁烁 (Kimi K3)]
operator_signoff: pending
superseded_by_pending: docs/decisions/0002-a2a-surface-v2.md
created: 2026-10-31
updated: 2026-10-31
related_features: [codeteam/F016]
---

# ADR-0001: cross-thread A2A v1 boundary

> **历史输入（2026-10-31）。** 本文的 message-only v1 结论是 F016 时代的
> 调研与决策建议，不是 F017 的最终边界。F017 的完整 A2A contract 见
> [`ADR-0002`](0002-a2a-surface-v2.md)；operator 确认 ADR-0002 后，本文将
> 标记为 superseded。保留本文是为了 review disposition、风险清单和
> “消息送达 ≠ 责任转移”的原始论证。

> **状态：proposed。** 本文是调研与决策建议，不是已签实现契约。
> 没有修改产品代码、PR、F016a/F016c 文档，也没有把 Clowder AI 作为运行依赖。
> 所有 Clowder 路径均为本地只读参考仓的 repo-relative 路径。

## 0. 结论先行

**v1 推荐只做 message-only cross-thread post，不做跨 task handoff。**

具体边界：

1. 新增 `codeteam_cross_post_message`：把一条讨论消息投递到同一用户可见的
   另一个 thread，并在目标 thread 已有的 non-done task 上唤醒目标 profile。
2. 它**不创建 task、不改 task owner/status、不产生 Handoff、不写
   `custody_events`、不转移责任、不提供 terminal predicate/deadline/return**。
3. 目标 thread 必须已经有一个可解析的 non-done task；没有 task、task 归属
   不明、目标 session 不存在、跨用户、archived thread 都 fail closed。
4. 需要正式责任转移时，继续用同 thread 的 `codeteam_handoff_create`；
   cross-thread `handoff_create` 继续 typed reject，直到另行立项。
5. full cross-task handoff 单独立项。它需要 task↔thread 基数、target task
   绑定、source/target handoff 双 task、target run/session/token、跨 task
   custody、return/recovery 和跨 feature 授权；不是给 message 加一个
   `threadId` 参数。

**为什么不是 full handoff v1：** codeteam 的 `Message`、`QueueEntry`、`Run`、
`AgentSession`、`InvocationCredential` 都把 `taskId` 绑进执行链；当前
`Handoff.taskId` 只有一个 task，`requireRunForHandoff` 要求 run 的 task 和
thread 同时等于 handoff 的 task/thread。跨 task handoff 会同时改
task/thread 模型、handoff schema、queue/dispatch、token 绑定和 recovery，
不适合和 F016 的 ingress E2E 混在一起。

**为什么不是「完全不做」：** message-only cross-post 可以复用现有
message + queue + dispatch 链，价值明确（跨 thread 通知、把证据/问题送到
目标 owner thread），且不需要 custody 语义。它比 full handoff 小一个数量级，
可以先 dogfood，再决定是否值得做 full handoff。

## 0.1 Review disposition（砚砚，2026-10-31）

砚砚的 review verdict 为 **changes requested（方向 approve）**；以下 findings
已折入本文，不改变推荐 A：

| Finding | Severity | 处置 | 落点 |
|---|---|---|---|
| R1 cross-post 无 depth guard，A↔B ping-pong 可绕过同 thread 防护 | P1 | 接受：跨 thread 共享 `a2aDepth` 计数，独立上限，单调递增 | §5.2.8、§5.4、§5.6、§9 |
| R2 显式 `targetTaskId` 未校验 non-done；0 task 错误码矛盾 | P2 | 接受：显式/省略两条路径都要求 non-done；0/multiple/done 分开 typed | §5.2.4、§5.5 |
| R3 `Task.userId` / `AgentSession.userId` nullable，不能靠巧合拒绝 | P3 | 接受：显式拒绝 null，禁止照抄 `session.userId ?? task.userId` fallback | §5.2.1/5/6、§5.5、§5.6 |
| R4 `"unpaired-user"` 哨兵会制造假同 user | P3 | 接受：principal/target task/session 都显式拒绝哨兵 | §5.2.1/5/6、§5.5 |
| R5 `sourceRunId` 不得流入 `credential.parentRunId` | P3 | 接受：只做 provenance，不建伪 parent lineage | §5.4、§5.6 |
| R6 target message author 归因未定义 | P3 | 接受：`authorKind:"agent"` + `authorId: sourceProfileId` | §5.3、§5.6 |
| R7 幂等命名空间二选一未钉死 | P3 | 接受：使用独立薄表 `cross_post_requests`，不与 `a2a_requests` 混用 | §5.3、§7 |

## 0.2 Review disposition（墨墨，2026-10-31）

墨墨的 review verdict 为 **approve（复用/process 无 blocking）**；以下 5 条
non-blocking notes 已折入本文：

| Note | 处置 | 落点 |
|---|---|---|
| N1 F016a D5 negative 测试保持不动 | 接受：cross-post 走自己的测试面，不修改既有 negative 断言 | §7 Phase 1.3 |
| N2 thread owner 来源钉到真实创建点 | 接受：当前生产唯一建 thread 路径是 `dispatchBacklog`，CLI 无 thread create | §7 Phase 1.1 |
| N3 复用卡/有意偏离需记录 | 接受：列 3 条与 Clowder 的有意偏离；Phase 1 同步 `docs/reuse/dispatch.md` + divergence log | §5.7 |
| N4 `targets` 只做显式 profile id | 接受：不做行首 `@` 解析，防实现走捷径 | §5.1 |
| N5 同 thread 17–31 后 cross-post 被拒是有意行为 | 接受：跨 thread 上限独立且更保守，文档/测试钉住，不让实现者“修平” | §5.2.8、§9 |

## 0.3 Review disposition（烁烁，2026-10-31）

烁烁的 review verdict 为 **approve（A2A/dispatch/架构/scope 无 blocking）**；
以下 3 条 P3 钉点已折入本文：

| Finding | Severity | 处置 | 落点 |
|---|---|---|---|
| S1 cross-post queue entry 的 `sourceRecordId` 未钉 | P3 | 接受：固定为 `null`；provenance 只进 `cross_post_json`/`chainMetadata`，不在 target queue 行放 source run 指针 | §5.4、§5.6 |
| S2 post→dispatch 的 TOCTOU 重校验未写 | P3 | 接受：post 校验不保证执行；drain 重校验失败 = 消息已投递 + 该 target withdraw + audit，不补偿删除、不制造重试风暴 | §5.4、§9 |
| S3 预算归属未写 | P3 | 接受：cross-post 唤醒的 target run 计入 target task 预算；这是有意语义，不是 bug | §5.4、§5.6、§9 |

---

## 1. 调研范围与判定口径

本 ADR 回答三个问题：

1. Clowder AI 的 `cross_post_message`、thread access、queue ledger 和 custody
   分别解决什么语义？
2. codeteam 当前有哪些硬不变量使 cross-thread 不能只加参数？
3. codeteam v1 应该选 message-only、full cross-task handoff，还是继续
   typed negative？

本文把「跨 thread」拆成两种**不同**语义：

| 语义 | 行为 | 责任/custody | 典型用途 |
|---|---|---|---|
| message-only cross-post | 目标 thread 写一条消息，并可唤醒目标 session | 不转移；无 handoff/lease/terminal | 通知、提问、送证据、请求目标 thread 自己处理 |
| cross-task handoff | 在目标 task 上建立可 claim/complete/return 的责任 | 转移；有 holder/lease/deadline/terminal | 正式 review/implement/verify/merge 交接 |

把两者混成一个工具，会让「消息送达」被误读成「责任已转移」，这是本 ADR
要避免的主要失败模式。

---

## 2. Clowder AI 参考实现：message 与 custody 是两层

### 2.1 cross-post 本体是 thread-scoped message delivery

Clowder 的 `cat_cafe_cross_post_message` 输入是 `threadId`、`content`、
`targetCats` 等；它复用 `_executePostMessage`，不走第二个 message store：

- `packages/mcp-server/src/tools/callback-tools.ts:774`（schema）
- `packages/mcp-server/src/tools/callback-tools.ts:1587`（handler）
- `packages/mcp-server/src/tools/callback-tools.ts:1690`（复用 post primitive）

服务端在 `/api/callbacks/post-message` 解析目标 thread：

- 目标 thread 与当前 invocation thread 不同才进入 cross-thread 路径：
  `packages/api/src/routes/callbacks.ts:2488`
- `resolveScopedThreadId` 只允许同用户 thread，或用户可见的 indexed system
  thread；否则 403：
  `packages/api/src/routes/callback-scope-helpers.ts:89`
- 跨 thread 写入必须有 `targetCats` 或行首 `@`，否则 400
  `cross_post_no_routing`：
  `packages/api/src/routes/callbacks.ts:2526`
- 目标 thread 被软删除时在持久化前拒绝：
  `packages/api/src/routes/callbacks.ts:2512`
- 消息持久化在**目标 thread**，并带 `extra.crossPost.sourceThreadId` /
  `sourceInvocationId` 作为来源投影：
  `packages/api/src/routes/callbacks.ts:3380`

目标不是 participant 只产生 `target_not_in_thread` warning，不阻断投递：

- `packages/api/src/routes/callbacks.ts:3291`（warning 注入）
- `packages/api/test/callback-f177h-participant-check.test.js:175`（负例）
- `packages/api/test/callback-f177h-participant-check.test.js:206`（正例）

**结论：** message-only cross-post 的语义是「目标 thread 多一条消息 + 目标
cat 被 queue 唤醒」，不是「source 把责任交给 target」。Clowder 的
`crossPost` extra 只是 provenance，测试明确断言它不承载 coordination：
`packages/api/test/cross-thread-coordination-chain.test.js:132`。

### 2.2 thread access 是 user-scoped，不是 task-scoped

Clowder 的 canonical access policy：

- owner、shared default、external runtime anchor、用户 index 可见的 system
  thread 放行；否则 403：
  `packages/api/src/domains/cats/services/session/thread-access-policy.ts:58`
- `resolveScopedThreadId` 只做同用户 thread scope，不做 task 绑定：
  `packages/api/src/routes/callback-scope-helpers.ts:89`
- `isThreadInPrincipalScope` 要求 `createdBy === userId`，或 system thread
  出现在该用户的 thread index：
  `packages/api/src/routes/callback-scope-helpers.ts:175`

访问矩阵测试覆盖 owner / non-owner / shared default / indexed system thread /
unindexed system thread / external anchor：
`packages/api/test/thread-access-policy.test.js:13`。

**结论：** Clowder 的 thread 有 `createdBy`、`participants`；cross-thread
授权主要是「同一用户 + thread 可见」。它没有 codeteam 的 task→thread
强绑定，所以不能直接照搬成 codeteam 的 task 授权。

### 2.3 结构化 action 才是跨 thread custody

`cross_post_message` 可以带可选 `action`；带 action 时服务端不是只写消息，
而是调用 `ActionSuccessorAdmissionService.admit`：

- 输入显式区分 `sourceThreadId` / `targetThreadId`：
  `packages/api/src/domains/ball-custody/ActionSuccessorAdmissionContract.ts:19`
- admission 把 `holderThreadId` 设为 target thread，把
  `predecessorThreadId` 设为 source thread：
  `packages/api/src/domains/ball-custody/ActionSuccessorAdmissionService.ts:133`
- lease 本身持久化 `holderThreadId` / `predecessorThreadId`：
  `packages/api/src/domains/ball-custody/action-successor-state-machine.ts:119`
- cross-thread dispatch id 形如 `cross-post:<clientMessageId>`，同 thread 是
  `post:<clientMessageId>`：
  `packages/api/src/routes/callbacks.ts:3056`
- queue entry 带 `actionSuccessorFence`，目标 thread 的 queue 才是实际执行
  carrier：
  `packages/api/test/cross-thread-action-successor.test.js:288`
- 失败/返回必须从 holder 的 exact thread 发起；同 cat 换 thread 也会
  `holder_mismatch`：
  `packages/api/test/action-successor-state-machine.test.js:784`
- agent-key 不能做 direct action，必须 invocation token；否则 fail closed，
  不写 message/queue：
  `packages/api/test/cross-thread-action-successor.test.js:636`

**结论：** Clowder 把跨 thread custody 建在 **tenant + subject + action
family + slot** 上，不建在 task 上；source/target thread 是 lease 的两个显式
坐标。codeteam 若要做 full handoff，必须补的正是这层「source task ↔ target
task / target run」坐标，而不是复用现有单 task Handoff 字段硬塞。

---

## 3. codeteam 当前硬不变量（逐层证据）

### 3.1 Message / Thread / Task

- `Thread` 只有 id/title/repo/status/phase/backlogItemId/时间，**没有
  owner/user/createdBy/participants**：
  `packages/codeteam-daemon/src/control/stores/types.ts:215`
- `Message` 同时有 `threadId` 和可空 `taskId`；没有跨 thread 来源字段：
  `packages/codeteam-daemon/src/control/stores/types.ts:262`
- `Task` 有 `threadId` / `userId` / `backlogItemId`；work task 必须绑 backlog：
  `packages/codeteam-daemon/src/control/stores/types.ts:666`
- `TaskStore.create` 强制 work task 有 backlog：
  `packages/codeteam-daemon/src/control/stores/tasks.ts:192`
- `dispatchBacklog` 一个 backlog 建一个 thread + 一个 work task；已有 work
  task 时 conflict：
  `packages/codeteam-daemon/src/control/store.ts:158`

**关键缺口：** 当前没有 thread owner 列，也没有持久化 participants。
`docs/architecture/0001-codeteam-architecture-v1.md` 明确说 W1 只建
thread 身份/phase/backlog 链接，participants 从 messages/agent_sessions
派生。跨 thread 写入不能在没有 owner 的 thread 上安全授权。

### 3.2 A2A handler 强制同 task / 同 thread

`A2AToolHandlers.deliverableTargets` 要求：

- 目标 profile 有 active session；
- session 的 `taskId === principal.taskId`；
- session 的 `threadId === principal.threadId`；

见 `packages/codeteam-daemon/src/a2a/tools.ts:570`。

`a2a_send` 写消息和 queue 时都用 principal 的 thread/task：
`packages/codeteam-daemon/src/a2a/tools.ts:235`。

`handoff_create` 的 holder thread / predecessor thread 都固定为 principal
thread，handoff task 固定为 principal task：
`packages/codeteam-daemon/src/a2a/tools.ts:437`。

claim / withdraw 又显式检查 `handoff.taskId === principal.taskId` 且
`handoff.holderThreadId === principal.threadId`：
`packages/codeteam-daemon/src/a2a/tools.ts:507`。

`replyTo` 只允许同 thread：
`packages/codeteam-daemon/src/a2a/tools.ts:594`。

### 3.3 Run / Session / Token 绑定 task + thread

- `resolveRunPrincipal` 要求 `task.threadId === session.threadId`，且
  `session.taskId === task.id`：
  `packages/codeteam-daemon/src/a2a/principal.ts:22`
- `DispatchService.resolveRoute` 用 `taskId` 找 active session，并要求
  session.threadId === task.threadId：
  `packages/codeteam-daemon/src/dispatch/service.ts:102`
- `cutoverEntry` 从 source message 的 `taskId` 推导 task，再用该 task 做
  route/cutover：
  `packages/codeteam-daemon/src/dispatch/service.ts:311`
- `cutoverQueueEntry` 校验 session.taskId / session.threadId / profile 三者
  与 task/thread 一致：
  `packages/codeteam-daemon/src/control/store.ts:306`
- per-run credential mint 从 run join session/task 取得 taskId/threadId/
  userId，并把这些坐标写进 credential：
  `packages/codeteam-daemon/src/auth/mint.ts:38`

**结论：** 一个 target run 的 `taskId` 不可能同时是 source task；target
run 必须是 target thread 上的 task。source run 的 token 只属于 source task，
不能拿来执行 target run。

### 3.4 Handoff 只有一个 task 坐标

- `Handoff` 只有 `taskId`、`holderThreadId`、`predecessorThreadId`，没有
  `targetTaskId`：
  `packages/codeteam-daemon/src/control/stores/types.ts:990`
- `HandoffStore.create` 只写一个 `task_id`：
  `packages/codeteam-daemon/src/control/stores/handoffs.ts:250`
- `claim` / `complete` / `heartbeat` 都调
  `requireRunForHandoff(runId, current.taskId, current.holderThreadId)`：
  `packages/codeteam-daemon/src/control/stores/handoffs.ts:335`
- `requireRunForHandoff` 要求 run.task_id 等于 handoff.task_id，且 run 所属
  task.thread_id 等于 handoff holder thread：
  `packages/codeteam-daemon/src/control/stores/handoffs.ts:775`
- handoff terminal resolver 把状态消息写回 `committed.holderThreadId` 和
  `committed.taskId`：
  `packages/codeteam-daemon/src/a2a/terminal.ts:243`

**结论：** full cross-task handoff 若只把 `holderThreadId` 改成目标 thread，
现有 claim/complete 会直接拒绝，因为 run 的 task 仍是 source task。必须新增
target task / target run 坐标，或重构 handoff 的 task 绑定。

### 3.5 当前测试已经把 cross-thread 钉成 negative

- `rejects disabled and cross-thread targets`：
  `packages/codeteam-daemon/test/control-a2a-tools.test.ts:144`
- F016a D5 明确 cross-thread 只做 typed reject，不写 queue/run：
  `docs/plans/0018-f016a-a2a-ingress-e2e.md:92`
- F016 umbrella 非目标包含 cross-thread A2A：
  `docs/features/F016-w7a-headless-surface.md:94`

F016a 的 negative 不能在本决策里被悄悄放宽；本 ADR 只建议后续独立
feature 实现 message-only，且实现前仍需 operator 签边界。

---

## 4. 选项比较

| 选项 | 价值 | 主要成本/风险 | 与 F016 的关系 | 可逆性 |
|---|---|---|---|---|
| A. message-only cross-post | 跨 thread 通知/送证据/请求目标 thread 自己处理；复用现有 message+queue+dispatch | 需要 thread owner/任务唯一性/消息 provenance；仍可能被误读成 handoff | F016 保持 negative；A 另立项，F016b/F016c 不被阻塞 | 高；新增 nullable 字段 + 新工具，可按 feature flag 关闭 |
| B. full cross-task handoff | 真正的跨 task 责任转移、deadline/terminal/return | 改 task/thread 基数、handoff 双 task、target run/token、custody、recovery、跨 feature 授权 | 与 F016a 的 negative 直接冲突；会拖慢 F016 | 低；schema/语义大改，回滚成本高 |
| C. 继续完全不支持 | 最安全，零新风险 | 跨 thread 协作仍只能人工传话；目标 thread 已有 task 也不能被通知 | 与 F016 现状一致 | 最高 |

**推荐 A。** 理由：

1. A 解决真实协作缺口，但不把「消息」升级成「责任」，语义诚实。
2. A 可以完全复用现有 `queue_entries → DispatchService → pi RPC worker`
   链：target message 的 `taskId` 是 target task，target run 是 target task
   的普通 run；不需要跨 task run/token。
3. A 的 schema 改动是 additive 的：thread owner、message provenance、
   request 幂等字段；没有 handoff/custody 迁移。
4. B 的第一性问题是 target task 从哪里来、谁授权跨 feature、completion
   归哪个 task；这些问题没有回答前，做 B 只会把 F016 变成第二个 task
   系统。

---

## 5. v1 推荐设计：message-only cross-thread post

### 5.1 工具面

新增一个独立工具，不把 `threadId` 塞进 `codeteam_a2a_send`：

```text
codeteam_cross_post_message
  targetThreadId: string          // 目标 thread；必须不同于 principal.threadId
  targetTaskId?: string           // 可选；省略时要求目标 thread 只有一个 non-done task
  kind: discussion kind           // question/answer/proposal/finding/status
  targets: string[]               // 非空；只接受显式目标 profile id，不做行首 @ 解析
  bodyMd: string
  replyTo?: string                // 只能指向目标 thread 的消息
  clientMessageId: string         // 必填，跨 thread 写入的幂等键
```

不接受的字段：`action`、`proposedAction`、`handoff*`、`coordination`、
`effectClass`、`terminalPredicate`、`deadline`、`expectedArtifact`、
`localReviewVerdict`。这些字段属于 custody/approval，不属于 v1 message-only。

`kind` 只允许讨论类型；`handoff`/`verdict`/`approval_request` 等保留给
typed custody/approval，不由 cross-post 创建。

### 5.2 授权与目标解析

一次 cross-post 必须同时满足：

1. **来源 principal 有效**：active run、invocation token、source task/thread/
   user 一致；`principal.userId` 必须非空且不是 `"unpaired-user"` 哨兵。
   现有 `session.userId ?? task.userId` fallback 只用于解析 principal，不得
   复用到 target task/session；target 两条都独立要求非空。
2. **目标 thread 属于同一 user**：`threadOwner(targetThreadId) ===
   principal.userId`。v1 实现应新增 `threads.user_id`（或等价的
   `created_by` + owner 解析）并 backfill；对 legacy ownerless/ambiguous
   thread fail closed，不用「猜一个 task 的 user」放行。
3. **目标 thread 是 active**：archived 拒绝；没有 deletedAt 概念前，
   archived 是 v1 的不可写状态。
4. **目标 task 唯一且可执行**：显式 `targetTaskId` 时必须属于目标 thread
   且 `status !== "done"`；省略时目标 thread 必须恰好有一个非 done task。
   0 个返回 `cross_thread_target_task_missing`，多个返回
   `cross_thread_target_ambiguous`，显式 done 返回
   `cross_thread_target_task_done`；不自动建 task。
5. **目标 task 同 user**：`targetTask.userId` 必须非空且严格等于
   `principal.userId`；null 或 `"unpaired-user"` 返回
   `cross_thread_user_unpaired`。实现不得照抄
   `session.userId ?? task.userId` 的 fallback 语义。
6. **目标 profile/session 可执行**：每个 target profile 在目标 task 上恰好
   有一个 active session，且 `session.threadId === targetThreadId`、
   `session.userId` 非空且严格等于 `principal.userId`。没有 session 返回
   typed `cross_thread_target_session_missing`；null 或哨兵返回
   `cross_thread_user_unpaired`；不落 message/queue。
7. **replyTo 在目标 thread**：否则 `cross_thread_reply_to_invalid`。
8. **跨 thread depth 单调递增**：`depth = nextDepth(principal)`；超过
   `MAX_CROSS_THREAD_DEPTH` 返回 `cross_thread_depth_exceeded`。换 thread
   不得把 depth 重置为 1；默认上限 16，环境变量
   `CODETEAM_CROSS_THREAD_MAX_DEPTH`，与同 thread `MAX_A2A_DEPTH`（默认
   32）共享 `a2aDepth` 计数但使用独立上限。同 thread 链到 17–31 后
   cross-post 立即被拒是有意收紧，不是 bug；若要放宽必须同时调整跨 thread
   上限、风险说明和测试。

v1 不要求 target profile 是持久化 participant。codeteam 没有 participant
表；用「目标 task 上的 active session」作为比 participant 更强的执行授权。
未来若补 participant 投影，可再加 advisory warning，但不改变 v1 的
session-binding 硬门。

### 5.3 持久化与 provenance

**一个 canonical message，不建第二个 message store。**

- 目标 message 写在目标 thread，`taskId = targetTaskId`，
  `authorKind = "agent"`，`authorId = sourceProfileId`，`kind` 为讨论类型；
  这样审计/上下文不会把消息归因成 target profile 自己写的。
- 新增 nullable `messages.cross_post_json`（additive migration）保存：

```json
{
  "sourceThreadId": "...",
  "sourceTaskId": "...",
  "sourceRunId": "...",
  "sourceProfileId": "...",
  "sourceMessageId": null,
  "targetThreadId": "...",
  "targetTaskId": "..."
}
```

- `sourceMessageId` 可选：如果调用方要引用 source thread 的既有消息，必须
  校验该消息属于 source thread/task；v1 可以留空。
- 不写 `controlRef`（没有 handoff）；不写 custody event；不新增
  `handoffs` 行。
- 审计写一条 `audit`：`cross_thread_message_posted`，参数包含
  source/target thread/task、source run/profile、targets、clientMessageId、
  access basis。
- 幂等使用独立薄表 `cross_post_requests`，不与同 thread `a2a_requests`
  共享 key 空间：

```text
cross_post_requests(
  id, source_task_id, source_profile_id, source_run_id,
  client_message_id, intent_hash,
  target_thread_id, target_task_id, target_message_id,
  queue_entry_id, created_at,
  UNIQUE(source_task_id, source_profile_id, client_message_id)
)
```

  `intent_hash` 必须覆盖 target thread/task、kind、targets、bodyMd、replyTo。
  这不是第二套 message/queue/handoff store，只是跨 thread 写入的 dedupe
  index；同一 `clientMessageId` 不同 intent 返回
  `cross_thread_idempotency_conflict`，不会命中 `a2a_send` 的 replay。

### 5.4 Queue / Dispatch 语义

目标 message 产生一条**目标 thread** 的 queue entry：

```text
threadId      = targetThreadId
sourceId      = targetMessage.id
sourceRecordId= null
sourceKind    = message_wake
sourceCategory= cross_thread_message
targets       = target profile ids
authorIntent  = next_work + chainMetadata {
                  a2aDepth: depth,
                  crossThread: true,
                  sourceRunId
                }
```

后续完全走现有链：

`queue claim → cutoverEntry → resolveRoute(targetTaskId) → target run →
pi RPC worker → target response bubble`

关键点：

- `source.taskId` 是 target task，所以 `resolveRoute` / `cutoverQueueEntry` /
  token mint 都不需要跨 task 特殊分支。
- `sourceRecordId` 固定为 `null`；source run 只出现在
  `cross_post_json` / `chainMetadata` provenance，不在 target queue 行制造
  指向 source run 的伪 lineage。
- target run 使用 target task 的 worktree/session；如果 target task 没有
  worktree，沿用现有 `dispatch_not_ready` typed defer，不静默 dead-letter。
- post 时校验不保证执行；drain 时 `resolveRoute` 会重新校验。若 target
  session 在 post 后、drain 前消失，正确行为是消息已投递 + 该 target
  withdraw + audit，不补偿删除消息，也不在 target thread 制造重试风暴。
- `cutoverEntry` 用 target message 的 `taskId` 做 budget admission，因此
  cross-post 唤醒的 target run 计入 **target task** 预算；这是有意语义，
  不记到 source task。
- cross-post 入队前必须执行 depth guard；入队后 target run 的
  `chainMetadata.a2aDepth` 来自该值，下一次 cross-post 必须继续递增。
- `sourceRunId` 只进 `cross_post_json` / `chainMetadata` provenance；
  不得写 `InvocationCredential.parentRunId`、`Run.parentRunId`，也不得作为
  target run 的 `parentRunId`。target run 是 target task 的新根 run，不是
  source run 的伪子 run。
- target run 的 response message 属于 target thread/task；source thread 不会
  自动收到回复。调用方要回复，必须自己再 cross-post 或在 source thread
  发消息。

### 5.5 Typed errors

至少定义：

| code | 触发 |
|---|---|
| `cross_thread_same_thread` | targetThreadId == principal.threadId；提示用 `a2a_send` |
| `cross_thread_forbidden` | 目标 thread 不属于同一 user / 目标 task user 不同 |
| `cross_thread_user_unpaired` | principal/target task/target session 的 userId 为 null 或 `"unpaired-user"` |
| `cross_thread_target_archived` | 目标 thread archived |
| `cross_thread_target_task_missing` | 目标 thread 没有非 done task |
| `cross_thread_target_ambiguous` | 多个非 done task，且未显式给 targetTaskId |
| `cross_thread_target_task_done` | 显式 targetTaskId 指向 done task |
| `cross_thread_target_session_missing` | target profile 在目标 task 上没有 active session |
| `cross_thread_target_session_ambiguous` | 多个 active session |
| `cross_thread_reply_to_invalid` | replyTo 不在目标 thread |
| `cross_thread_depth_exceeded` | `a2aDepth` 超过跨 thread 独立上限 |
| `cross_thread_idempotency_conflict` | 同 clientMessageId 不同 intent |
| `cross_thread_source_scope_invalid` | source run/task/thread/principal 不一致 |

所有拒绝都在写 message/queue 之前完成；不能先写消息再异步发现没权限。
校验、message append、queue admit、`cross_post_requests` reserve 和 audit
必须在同一个 `store.transaction.run` 内；任何一步失败整体回滚。

### 5.6 不变量

v1 实现必须能机械证明：

1. cross-post 后 `handoffs` 行数不变；
2. `custody_events` 行数不变；
3. source task 的 status/owner/disposition 不变；
4. 目标 task 不被创建、不被改 owner/status；
5. 目标 message 的 `taskId === targetTaskId`，`threadId === targetThreadId`；
6. 每个 target run 的 `taskId === targetTaskId`，token 的
   task/thread/session 坐标都指向 target；
7. 目标 message 的 `authorKind === "agent"` 且 `authorId === sourceProfileId`；
8. 每次 cross-post 的 `a2aDepth` 单调递增，且 `<= MAX_CROSS_THREAD_DEPTH`；
9. target run 的 `parentRunId` 为 null；`InvocationCredential.parentRunId`
   不来自 `sourceRunId`；
10. principal/target task/target session 的 userId 非空且不是
    `"unpaired-user"`；
11. `cross_post_requests` 的 `(source_task_id, source_profile_id,
    client_message_id)` 唯一，replay 不会读成 `a2a_send`；
12. cross-post queue entry 的 `sourceRecordId === null`；
13. cross-post target run 的预算 charge 归 `targetTaskId`，不归
    `sourceTaskId`；
14. 拒绝路径没有 message/queue/run 副作用。

### 5.7 与 Clowder 的有意偏离

Phase 1 落地时必须同步 `docs/reuse/dispatch.md` cell 的「代码面」和
divergence log；当前卡片只覆盖 queue/dispatch，没有 cross-post 条目。v1 有
三处比 Clowder 更严，属于有意偏离，不是遗漏：

1. **目标 task/session 绑定**：要求目标 thread 有 non-done task，且 target
   profile 在该 task 有 active session；Clowder 没有 codeteam 的 task 层。
2. **跨 thread depth guard**：共享 `a2aDepth` 计数并使用独立上限；Clowder
   主要靠 loop-streak guard/人盯，codeteam 是 headless 自动化，不能照搬。
3. **单一 `user_id` owner、无 participants 列**：v1 用 thread owner + target
   task/session 同 user 作为硬授权；Clowder 有 `createdBy`/participants 和
   `target_not_in_thread` advisory warning。

---

## 6. full cross-task handoff：为什么必须单独立项

如果未来要做 B，至少要先回答并实现以下契约：

### 6.1 task↔thread 基数

- 当前 `dispatchBacklog` 一个 backlog 一个 thread + 一个 work task；
  `findWorkByBacklog` 只取第一个。
- 目标 thread 若要有自己的 task，需要允许「同一 feature 下多 thread /
  多 task」或明确的 child task 模型。
- 需要决定 target task 是「目标 thread 已有 task」还是「handoff 新建
  child task」；后者必须绑定 parent task/backlog，不能让 handoff 静默
  创建跨 feature 工作。

### 6.2 handoff schema

推荐把当前单 `task_id` 拆成：

```text
source_task_id
target_task_id
holder_thread_id
predecessor_thread_id
```

`task_id` 可作为 source 的兼容列保留或迁移。`handoff_holder_claims` 的
run 必须属于 target task，而不是 source task；`requireRunForHandoff` 要改成
校验 target task/thread，而不是当前 `current.taskId`。

### 6.3 custody 与 canonical key

- `canonical_action_key` 当前按 subjectRef/actionFamily/slot 建；跨 task 时
  要么把 source/target task 纳入 key，要么明确只允许同一 subject 下的
  cross-task 转移。
- `custody_events` 必须能表达 source/target 两侧事件；completion 在 target
  task 上验证，return 回到 source task/thread。
- terminal resolver 当前把状态消息写回 `holderThreadId + taskId`；跨 task
  时必须写 target task/thread 或同时写两侧，不能把 source task 的消息写进
  target thread。

### 6.4 授权

- 同 user 是底线，不是全部；codeteam 的 task 绑 backlog/feature，跨 feature
  handoff 需要 operator 或明确 owner 授权。
- target profile 必须在 target task 有 active session；target run 必须有
  自己的 per-run token。
- source run 不能复用 target run 的 token；token 的 task/thread/session
  坐标必须与 run 一致（见 `auth/mint.ts:38`）。

### 6.5 recovery

- source queue / target queue 双账本：target run crash 在 target task 重试，
  source 保持 waiting/typed wait；不能把 source queue 当 target 执行队列。
- claim/complete 的 owner fence 必须同时覆盖 source issuer 和 target holder。
- 跨 thread loop guard 不能只看 source thread；按 subjectRef/action key 的
  live handoff 仍然要单飞。

**结论：** B 是一次 handoff/task 模型升级，不是 F016 的一个 slice。先 A，
用真实 cross-thread 通知 dogfood 暴露 thread owner/目标 task 解析问题，再
决定 B 是否值得。

---

## 7. 分阶段方案

### Phase 0 — 本 ADR（当前）

- 产出：本决策稿 + 证据索引 + operator Decision Packet。
- 不做：产品代码、schema migration、PR、F016 改动。
- Exit：operator 对 v1 边界给出明确选择；至少砚砚（安全）、墨墨
  （reuse/process）、烁烁（A2A/dispatch/架构）完成非作者 review。

### Phase 1 — message-only v1（建议独立 Fxxx，不塞 F016a）

1. **thread ownership**
   - additive migration：`threads.user_id`（或 `created_by` + owner 解析）；
   - backfill：从 `threads.backlog_item_id -> backlog_items.user_id` 和
     unique task.userId 推导；ownerless/ambiguous 保持 NULL；
   - 当前生产唯一建 thread 路径是 `dispatchBacklog`
     (`packages/codeteam-daemon/src/control/store.ts:230`)；在该调用点写
     `ownerUserId = backlog.userId`（`backlog.user_id` 非空）。CLI
     `thread create` 不存在；`cli/thread.ts:238` 的 `create` 是 `task
     create`，不能当 thread 创建路径。
   - `ThreadStore.create` 增加 owner 参数；测试/迁移 fixture 显式传 owner；
     未传 owner 的 legacy/test thread 由 resolver fail closed，不作为生产
     创建路径。未来新增 CLI/API 建 thread 时必须带 owner。
   - resolver：`resolveThreadAccess` 等价物，覆盖 owner/archived/legacy；
   - 测试：同 user/跨 user/ownerless/ambiguous/archived。
2. **message provenance + request idempotency**
   - `messages.cross_post_json` nullable；
   - 新建薄 `cross_post_requests` 表（独立幂等命名空间，不复用
     `a2a_requests`）；
   - 测试：same clientMessageId replay、different intent conflict、concurrent
     replay 单副作用、同 clientMessageId 不被 `a2a_send` 误 replay。
3. **handler + tool surface**
   - `codeteam_cross_post_message` 注册、prompt/allowlist/control socket 同步；
   - 目标 task/session 解析与 typed errors；
   - 不接 action/handoff 字段；
   - 保持 F016a D5 negative 测试不动（`control-a2a-tools.test.ts:144`）；
     cross-post 使用自己的测试面，不修改既有 cross-thread negative 断言。
4. **queue/dispatch E2E**
   - source coder cross-post 到 target reviewer thread；
   - target reviewer 真实 pi RPC 唤醒、response bubble 在 target thread；
   - target queue 一条；source 不新增 queue entry；source handoff/custody
     行数为 0；
   - restart/replay/cold boot；
   - depth：A→B→A 连续 cross-post 时 `a2aDepth` 单调递增；到达
     `MAX_CROSS_THREAD_DEPTH` 后 typed reject，不写 message/queue；
   - userId：principal/target task/target session 为 null 或
     `"unpaired-user"` 时拒绝；显式 done targetTask 拒绝；
   - author：target message 的 `authorId` 是 sourceProfileId，不是 target
     profile；
   - parent lineage：target run / credential 的 `parentRunId` 不来自
     sourceRunId；
   - negatives：same thread、cross user、ownerless、archived、0/多 task、
     done task、missing session、null/哨兵 userId、depth 超限、replyTo 跨
     thread、unknown fields。
5. **audit/read model**
   - audit action、target message provenance、F016c 投影需要 source thread
     链接；不在 v1 新增 cross-thread custody 视图。

Phase 1 的完成定义是「真实 RPC E2E + 非作者 review + 可回滚」。

### Phase 2 — full cross-task handoff（仅当 A dogfood 证明需要）

1. 先写 design gate：task↔thread 基数、target task 创建策略、跨 feature
   授权、handoff schema、custody/return/recovery。
2. additive migration + 同 thread 兼容 dual-read/write。
3. 真实 E2E：source task → target task handoff、target claim/complete、
   return、crash/re-attach、loop guard、parallel。
4. 回滚：新列/新表 additive；同 thread handoff 走旧路径；feature flag 关闭
   cross-task admission。

---

## 8. 对 F016b / F016c 的影响

- **F016a：** 不改 D5。cross-thread 继续 typed negative；本 ADR 不授权在
  F016a 里放宽 `deliverableTargets` 或 `handoff_*`。
- **F016b（wait scheduler）：** 无直接依赖。cross-post 是 message wake，
  不是 wait；不要把 `wait_arm` 当 cross-post 的 delivery 状态。F016b 的
  `message_get`/`handoff_events` 可帮助后续读 target message，但不是 v1
  前置。
- **F016c（headless API/Hub）：** 需要 thread ownership/visibility 投影；
  上游 Hub 调研已把 `createdBy`/`participants`/`lastActiveAt` 列为 P0 gap
  （`docs/reports/2026-10-31-clowder-hub-api-compat.md` §0.7）。v1 若落地，
  F016c 的 thread/read model 必须能表达 source thread 链接；F016c 不应
  假设 cross-thread 已支持。
- **F016 umbrella：** cross-thread 仍是非目标；实现 v1 需要新 feature doc +
  BACKLOG row，或 operator 明确把它挂到某个后续 feature 下。本文不替
  operator 分配 F 号。

---

## 9. 风险与反例

| 风险 | 反例/后果 | 缓解 |
|---|---|---|
| 把 message 当 handoff | source 以为「已交给 reviewer」，target 只当普通消息；没有 claim/terminal，球掉 | 工具名/描述明确 no custody；返回 `custody: "none"`；不写 handoff；测试断言行数不变 |
| thread owner 缺失 | ownerless thread 被任意 agent 写入，跨用户泄露 | 先补 owner 列/解析；ownerless fail closed；安全 review 覆盖 |
| 目标 thread 多 task | 消息/task 归属错误，SOP/预算/审计串线 | 显式 `targetTaskId` 或唯一 non-done task；0/多都 typed reject |
| target task 无 worktree | 目标 run 无法执行，消息已写但无人处理 | 复用 `dispatch_not_ready` typed defer + audit；post 前尽量预检，post 后失败可见 |
| 目标 session 消失 | 消息落库、queue target withdraw，source 误以为已送达 | 返回 queue/withdraw 状态；审计；F016b read 工具补可见性 |
| post 后 drain 前 session 消失 | 消息已投递但无 run；实现者可能补偿删除或重试风暴 | 明确消息保留 + target withdraw + audit；不删除、不自动重试 |
| 预算记到 source task | target run 消耗被算到 source，source 预算被误伤 | `cutoverEntry` 用 target message.taskId 做 admission；钉 target task 预算 |
| 跨 feature 借 message 绕过 owner | 用 cross-post 把工作丢进别的 feature thread | v1 不创建 task、不改 owner；跨 feature 正式转移必须另走授权 |
| requestId 冲突 | 同 id 不同 target/body 产生重复或错投 | 必填 clientMessageId；intent hash 覆盖 target；冲突 typed |
| `sourceRecordId` 伪 lineage | target queue 行出现指向 source run 的指针，和 R5 同类 | 固定 `sourceRecordId = null`；provenance 只进 cross_post_json/chainMetadata |
| 跨 thread 往返超限 | 每次 cross-post 都重置 depth，唯一护栏是 per-task budget | 共享 `a2aDepth` 计数、跨 thread 独立上限、单调递增；超限前不写副作用 |
| 同 thread 17–31 后 cross-post 被拒 | 实现者误以为跨 thread 上限是 bug，尝试“修平” | 文档/测试明确这是有意收紧；跨 thread 上限独立且更保守 |
| nullable/哨兵 userId 误放行 | `Task.userId` / `AgentSession.userId` 为 null，或 `"unpaired-user"` 让两个无主 task 假同 user | 显式拒绝 null/哨兵；禁止 `session.userId ?? task.userId` fallback |
| 幂等表混用 | cross-post 与 `a2a_send` 共享 requestId，replay 返回错误工具类型 | 独立 `cross_post_requests` 表；不同表不互相命中 |
| token 复用 | source run token 被拿去执行 target run | target run 由 target task cutover 新建，mint 自己的 token；source token 只做 source 写入 |
| 与 Clowder 复杂度对齐 | 把 effectClass/coordination/action 一起搬进来，v1 变成小号 Clowder | v1 只保留 message + target wake；action/custody 字段拒绝 |

**最强反例：** 如果 operator 的真实需求是「source 发起 formal review，
reviewer 的 verdict 必须回写 source task 并满足 merge gate」，message-only
不够；这时应该在同 thread 用 `handoff_create`，或专门做 full cross-task
handoff。不要用 cross-post + 自然语言回复伪装 formal review。

---

## 10. Operator Decision Packet

**需要拍板的不是技术 A/B，而是 v1 产品边界：**

| 选项 | 用户得到什么 | 代价 | 建议 |
|---|---|---|---|
| A. message-only | 跨 thread 通知/送证据/请求目标 thread 处理；无 formal custody | thread owner + target task 解析 + 新工具；仍不是 handoff | **推荐** |
| B. full cross-task handoff | 真正的跨 task 责任转移 | task/thread 模型、handoff schema、target run/token、recovery、跨 feature 授权 | 先不做；A dogfood 后再评估 |
| C. 继续 negative | 零新风险 | 跨 thread 仍靠人工 | 若 A 的价值不足以抵消 owner/task 解析成本，选 C |

**推荐 A 的默认实现约束：**

1. 不自动创建 target task；没有 non-done task 就拒绝。
2. 不跨 user；thread/task owner 必须同一 user。
3. 不跨 feature 转移责任；正式 handoff 仍限同 task/thread，直到 B 立项。
4. 不在 v1 接受 action/handoff/coordination 字段。
5. 实现前先由 operator 确认「message-only 可以叫 cross-thread 支持，
   但不能叫 handoff」的产品语义。

**今天不拍板的后果：** 保持现状（C），F016a 的 negative 不变；不会阻塞
F016b/F016c，但跨 thread 协作继续只能人工传话。

### Review focus

- **砚砚（安全/ACL/custody）：** thread owner 解析是否 fail closed；同 user
  校验是否覆盖 legacy/ownerless/ambiguous；target task/session 绑定是否
  足够；v1 是否真的不产生 custody/action 副作用；token 是否无法跨 run
  复用；拒绝路径是否无 message/queue/run 残留。
- **墨墨（Clowder reuse/process）：** 是否只复用 message/queue/dispatch
  契约而没有把 effectClass/coordination/action successor 复杂度搬进来；
  v1 是否该独立 Fxxx；F016b/F016c 边界是否被尊重；docs 位置和验收是否
  可执行。
- **烁烁（A2A/dispatch/架构/scope）：** target task 解析和 source/target
  queue 语义是否自洽；same-thread `a2a_send` 与 cross-thread post 是否
  语义分离；restart/idempotency/withdraw 是否可恢复；full cross-task
  handoff 的延期理由是否成立；是否越界到 F016a。
- **operator：** §10 的 A/B/C 边界选择；message-only 是否可以被称为
  cross-thread 支持但不得被称为 handoff；是否授权后续独立 Fxxx。

---

## 11. 证据索引

### codeteam

| 主题 | 路径:行 |
|---|---|
| Thread 无 owner/participants | `packages/codeteam-daemon/src/control/stores/types.ts:215` |
| Message threadId+taskId | `packages/codeteam-daemon/src/control/stores/types.ts:262` |
| Task threadId/userId/backlog | `packages/codeteam-daemon/src/control/stores/types.ts:666` |
| work task 必绑 backlog | `packages/codeteam-daemon/src/control/stores/tasks.ts:192` |
| backlog 一 thread 一 task | `packages/codeteam-daemon/src/control/store.ts:158` |
| 生产唯一建 thread 调用点 | `packages/codeteam-daemon/src/control/store.ts:230` |
| CLI thread create 实际是 task create | `packages/codeteam-daemon/src/cli/thread.ts:238` |
| A2A target 同 task/thread | `packages/codeteam-daemon/src/a2a/tools.ts:570` |
| a2a_send 写 principal thread/task | `packages/codeteam-daemon/src/a2a/tools.ts:235` |
| a2a_send queue sourceRecordId | `packages/codeteam-daemon/src/a2a/tools.ts:247` |
| handoff 固定 principal thread/task | `packages/codeteam-daemon/src/a2a/tools.ts:437` |
| handoff queue sourceRecordId | `packages/codeteam-daemon/src/a2a/tools.ts:470` |
| claim/withdraw task/thread scope | `packages/codeteam-daemon/src/a2a/tools.ts:507` |
| replyTo 同 thread | `packages/codeteam-daemon/src/a2a/tools.ts:594` |
| run principal task/session 一致性 | `packages/codeteam-daemon/src/a2a/principal.ts:22` |
| run principal userId fallback | `packages/codeteam-daemon/src/a2a/principal.ts:37` |
| dispatch route task/session 绑定 | `packages/codeteam-daemon/src/dispatch/service.ts:102` |
| cutover 从 source.taskId 推导 | `packages/codeteam-daemon/src/dispatch/service.ts:311` |
| dispatch budget admission | `packages/codeteam-daemon/src/dispatch/service.ts:319` |
| per-target withdraw on route failure | `packages/codeteam-daemon/src/dispatch/service.ts:355` |
| cutover session/task/thread 校验 | `packages/codeteam-daemon/src/control/store.ts:306` |
| token 绑 task/thread/session | `packages/codeteam-daemon/src/auth/mint.ts:38` |
| ownerless token 哨兵 | `packages/codeteam-daemon/src/auth/mint.ts:63` |
| Task.userId nullable | `packages/codeteam-daemon/src/control/stores/types.ts:676` |
| AgentSession.userId nullable | `packages/codeteam-daemon/src/control/stores/types.ts:105` |
| InvocationCredential.parentRunId | `packages/codeteam-daemon/src/control/stores/types.ts:866` |
| a2a_requests 唯一 key | `packages/codeteam-daemon/src/control/migrations/016-a2a-request-dedupe.ts:11` |
| 同 thread depth guard | `packages/codeteam-daemon/src/a2a/tools.ts:168` |
| Handoff 单 task 坐标 | `packages/codeteam-daemon/src/control/stores/types.ts:990` |
| requireRunForHandoff | `packages/codeteam-daemon/src/control/stores/handoffs.ts:775` |
| terminal 写回 holder thread/task | `packages/codeteam-daemon/src/a2a/terminal.ts:243` |
| cross-thread negative 测试 | `packages/codeteam-daemon/test/control-a2a-tools.test.ts:144` |
| F016a D5 negative | `docs/plans/0018-f016a-a2a-ingress-e2e.md:92` |
| F016 umbrella 非目标 | `docs/features/F016-w7a-headless-surface.md:94` |
| dispatch cell 当前代码面 | `docs/reuse/dispatch.md:36` |

### Clowder AI（只读参考）

| 主题 | 路径:行 |
|---|---|
| cross-post schema | `packages/mcp-server/src/tools/callback-tools.ts:774` |
| cross-post handler | `packages/mcp-server/src/tools/callback-tools.ts:1587` |
| 复用 post primitive | `packages/mcp-server/src/tools/callback-tools.ts:1690` |
| cross-thread thread resolution | `packages/api/src/routes/callbacks.ts:2488` |
| cross-post routing credentials | `packages/api/src/routes/callbacks.ts:2526` |
| soft-deleted thread guard | `packages/api/src/routes/callbacks.ts:2512` |
| crossPost provenance | `packages/api/src/routes/callbacks.ts:3380` |
| scoped thread access | `packages/api/src/routes/callback-scope-helpers.ts:89` |
| principal thread scope | `packages/api/src/routes/callback-scope-helpers.ts:175` |
| canonical thread access | `packages/api/src/domains/cats/services/session/thread-access-policy.ts:58` |
| action admission source/target thread | `packages/api/src/domains/ball-custody/ActionSuccessorAdmissionContract.ts:19` |
| lease holder/predecessor thread | `packages/api/src/domains/ball-custody/ActionSuccessorAdmissionService.ts:133` |
| lease fields | `packages/api/src/domains/ball-custody/action-successor-state-machine.ts:119` |
| cross-post dispatch id | `packages/api/src/routes/callbacks.ts:3056` |
| cross-thread action queue fence test | `packages/api/test/cross-thread-action-successor.test.js:288` |
| agent-key action fail closed | `packages/api/test/cross-thread-action-successor.test.js:636` |
| cross-post no routing test | `packages/api/test/callback-cross-post-fail-closed.test.js:160` |
| participant warning test | `packages/api/test/callback-f177h-participant-check.test.js:175` |
| thread access matrix test | `packages/api/test/thread-access-policy.test.js:13` |
| return from another thread rejected | `packages/api/test/action-successor-state-machine.test.js:784` |
| crossPost provenance-only test | `packages/api/test/cross-thread-coordination-chain.test.js:132` |

---

## 12. 一句话

**Cross-thread 不是给 message 加一个 `threadId`；但 v1 也不需要立刻做
cross-task custody。先用 message-only cross-post 把「通知/送证据/请目标
thread 自己处理」跑通，把 formal responsibility transfer 继续留给同 thread
handoff，等 target task 模型和授权问题回答后再做 full cross-task handoff。**

[宪宪/deepseek-flash🐾]
