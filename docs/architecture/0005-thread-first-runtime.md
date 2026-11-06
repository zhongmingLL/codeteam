---
title: "codeteam A2A runtime v1 — thread-first architecture"
doc_kind: architecture
status: draft-for-review
created: 2026-11-03
updated: 2026-11-05
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_direction: "2026-11-04 C: v1 = pure A2A runtime; a2a_send/handoff_* retired; code delivery setup frozen/deprecated"
review_verdict: "2026-11-03 base APPROVE; 2026-11-04 deltas APPROVE; superseded by operator C scope change"
delta_review: "2026-11-04 C: pure A2A runtime rewrite; review pending"
supersedes_phase_a_of: codeteam/F017
related_features: [codeteam/F018, codeteam/F017]
---

# codeteam A2A runtime v1

> **状态：draft-for-review。** operator 2026-11-04 选择 **C：v1 只做纯 A2A
> runtime**。`codeteam_a2a_send` / `codeteam_handoff_*` 彻底弃用；
> code delivery setup 冻结/弃用，不作为 v1 的一部分。后续 agent team 能力
> 在 A2A runtime 上逐步实现，各自单独立项。
>
> 本文不写产品代码。Phase A 只冻结目标架构、数据边界、迁移/回滚和验收；
> 实现另开隔离 worktree，按 TDD + review + E2E 推进。

## 0. 结论先行

1. **Thread 是主体**：user-owned，`projectPath` / `createdBy` / participants；
   A2A 聊天不要求 Task。
2. **Invocation 是 thread 里的一轮执行**：`threadId + agentId + userId +
   invocationId`；`executionKind` 只保留 Clowder 的 `ordinary | routing_guard`，
   **没有 conversation/code 两种 invocation**。
3. **Session 是 thread × agent 的持久执行身份**：一个 active session；
   `taskId` 不进入 session identity。
4. **A2A v1 模型面有四个工具**：`codeteam_post_message` /
   `codeteam_cross_post_message` / `codeteam_multi_mention` /
   `codeteam_thread_context`。
5. **Queue 单账本**：thread + source message + targets；不造第二队列。
6. **Auth 以 thread/invocation 为锚**：token 绑 invocation；没有 Task 坐标。
7. **v1 只记录 invocation usage**：不引入 ThreadGoal/tokenBudget/
   thread_member_effort；旧 task budget 是 legacy，后续 thread budget 另立 feature。
8. **v1 不做**：TaskItem、worktree、code delivery、review/merge/gate、custody、
   SOP handoff；`multi_mention` 只做 fan-out，不做聚合回调。

## 1. 与 Clowder 对齐的边界

### 1.1 Clowder 的真实形状（reference `5f8965e1`）

- `TurnExecutionKind = 'ordinary' | 'routing_guard'`；没有 conversation/code。
- `SessionRecord` 是 **thread × agent**；task-scoped work 只是可选
  `scopedInvocation`（v1 不使用）。
- `Thread` 有 `projectPath` / `createdBy` / `participants`；participants 做路由，
  不是 ACL 替代。
- A2A 消息面是 `post_message` / `cross_post_message` / `thread_context`；
  action lease / custody 是更高层能力，不在纯消息 runtime 里。

### 1.2 codeteam 现状与 v1 差异

| 维度 | 当前 codeteam | A2A runtime v1 |
|---|---|---|
| 主聚合根 | Task | **Thread** |
| Thread owner/participants | 无 | `created_by` + participants |
| 执行锚 | `Run.taskId` | **Invocation.threadId + agentId + userId** |
| Task 角色 | 所有执行的必需锚 | **v1 不引入 TaskItem** |
| Queue dispatch | 从 source message.taskId 找 task | 从 thread + target 解析 invocation |
| Per-run token | 绑 task/thread/user | 绑 invocation/thread/user |
| Worker workspace | task.worktree 必需 | `thread.projectPath` |
| Handoff/custody | task-bound | **v1 不做** |
| Review/merge/gates | task-scoped | **v1 不做** |

### 1.3 当前 Task 耦合点（baseline `e9be3c5aa`，仅作迁移证据）

| 层 | 现状 | 证据 | v1 处理 |
|---|---|---|---|
| Dispatch cutover | source message 没有 taskId 直接 `invalid_state` | `dispatch/service.ts:316` | thread invocation 只要求 threadId + targets |
| Budget admission | `assertBudgetAdmission(source.taskId)` | `dispatch/service.ts:319` | v1 不调用；usage 记 invocation/thread |
| Deployment wait | `deploymentWaitGuard.assertCanStart(source.taskId)` | `dispatch/service.ts:320` | v1 不调用 |
| Managed work | `preflightRun({taskId...})` | `dispatch/service.ts:363-381` | v1 不调用 |
| Route | `resolveRoute(taskId, profileId)` | `dispatch/service.ts:102` | 改为 `resolveRoute(threadId, agentId)` |
| Delivery readiness | `assertDeliveryReady(taskId, targets)` | `dispatch/service.ts:407` | 用 `threadId + agentId` 找 session |
| Token | `invocation_credentials.task_id NOT NULL` | `control/migrations/001-core.ts:288`；`auth/mint.ts:44` | 新 token 不带 task；旧表 legacy |
| Run | `runs.task_id NOT NULL` | `control/migrations/001-core.ts:221` | 新建 invocation 读模型；旧 runs legacy |
| Session provisioning | `prepareSession(task)`，cwd=task.worktree | `scheduling/provisioning.ts:93,131` | `ensureThreadSession(threadId, agentId)` |
| Worker prompt | `# Task` 骨架，task 必填 | `workers/prompt.ts:39-41` | `buildThreadPrompt`，无 Task |
| Tool policy | `policyForWorker` 要求 task.worktree | `workers/tool-policy.ts:144-146` | thread policy，cwd=thread.projectPath |
| CLI post | `thread post --to` 强制 `--task` | `cli/thread.ts:97` | `--to` 只要求 thread + enabled agent |
| A2A 工具面 | `a2a_send` + 4 `handoff_*` + `thread_context` | `a2a/tool-surface.ts` | v1 只注册 4 个新工具 |
| 已 thread-scoped | `messages/queue/agent_sessions` 都有 `thread_id` | `001-core.ts` | 复用；旧 task 字段变 legacy |

## 2. 目标数据模型

### 2.0 AgentConfig

Agent 身份是 config-as-code，完整模型见
`docs/architecture/0007-agent-config.md`：

- `.codeteam/agent-catalog.json` → `AgentConfig` → `AgentRegistry` 内存注册表；
- `AgentConfig.id` 用于 A2A `targets` 和 Thread participants；
  `displayName` 用于消息展示；
- `roleId` 是 workflow 触发段 key，不是旧 codeteam role；
- `enabled: false` 的 agent 注册但不路由；
- `accountRef` + `defaultModel` 从 `AccountConfig` 解析 provider/model；
- `AgentState.status` 是运行时状态，不写进 catalog。

### 2.1 Thread

```ts
interface Thread {
  id: string;
  projectPath: string;         // 必填
  title: string | null;
  titleSource?: "user" | "agent" | "system";
  createdBy: string;           // user id
  participants: string[];      // AgentConfig ids；可为空
  lastActiveAt: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
}
```

- Thread 必须 user-owned；participants 只做路由/上下文，不作 ACL 替代。
- Thread access 由 `created_by` + system-visible thread 决定。
- `participants` 可为空：operator/CLI 可先建 thread，后拉 agent；post 时
  targets 必须非空。
- `deletedAt != null` = soft-deleted；从普通列表隐藏，post typed reject；
  v1 没有 archive 状态，也不做硬删除。
- `lastActiveAt` 由消息/response 更新；`updatedAt` 只表示配置变更。
- `titleSource`：`user` = operator/CLI；`agent` = agent 创建/改名（后续）；
  `system` = 首条消息自动生成。
- v1 thread 由 operator/CLI 创建；agent propose/approve 是后续能力。
- 现有 `repo` / `phase` / `backlog_item_id` / `status` 保留为 legacy 字段，
  v1 runtime 不依赖；目标用 `project_path/title_source/last_active_at/deleted_at`。
  `projectPath` 迁移无法回填时进入 preflight 清单，不静默回退。

### 2.2 Invocation

A2A runtime 的调用链拆成两层，详细字段/状态机/链路见
`docs/architecture/0010-a2a-runtime-chain.md`：

- `InvocationRecord`（parent）：一条消息的消息级生命周期；
  `sourceMessageId` unique、`targetAgentIds[]`、`status`、
  `successfulAgentIds`/`failedAgentIds`/`canceledAgentIds`、`retryCount`。
- `TurnExecution`（child）：单 agent 一次执行；`invocationRecordId`（fan-out
  parent）、`parentInvocationId`（A2A 因果父）、`agentSessionId`、`attempt`、
  `status`/`responseMessageId`/`terminalReason`。
- 一个 parent 下 N 个 child；一个 child 一次 terminal。
- `provider/model/modelFamily` 在 `TurnExecution`；不是 AgentConfig 字段。
- `executionKind` 只有 `ordinary | routing_guard`；routing_guard 是内部路由
  守卫，不是用户可见的第二种 agent 工作。
- Queue entry 只做调度；parent 在 QueueProcessor claim 后创建。

### 2.3 Session

```ts
interface AgentSession {
  id: string;
  threadId: string;
  agentId: string;
  userId: string;
  piSessionId: string | null;
  piSessionFile: string | null;
  workingDirectory: string;
  messageCount: number;
  consecutiveResumeFailures: number;
  createdAt: number;
  updatedAt: number;
}
```

- 详细字段、resume 前置检查、fresh/熔断、schema 与迁移见
  `docs/architecture/0009-session-model.md`；本节只保留架构摘要。
- v1 只有 active session：一个 `(thread_id, agent_id)` 一行；没有
  `sealing/sealed/restore/seq`，这些整体放 v2。原因是 v1 只做 A2A runtime，
  验收要求快速真实模型 E2E，不要求长 session。
- `workingDirectory = thread.projectPath` 必填；`projectPath` 为空时
  `thread_project_path_required` typed reject。
- `provider/model/modelFamily` 不在 session；它们属于 `TurnExecution`，每轮从
  AgentConfig/AccountConfig 解析。
- `messageCount` 对齐 Clowder 语义：每个有 user-visible output 的 completed
  invocation +1，不是原始 message 行数。
- `consecutiveResumeFailures` 连续 3 次 resume 失败时强制 fresh、清空 pi
  绑定、计数归零；不 seal、不新建 codeteam session。
- `taskId` 不进入 session identity；旧 `agent_sessions.task_id` 只作为 legacy
  列保留到迁移完成，不读不写。
- Session 不再有 `role`；workflow 分组只用 `AgentConfig.roleId`。

### 2.4 Message / Queue

- `messages.threadId` 必填；`taskId` 是 legacy 可空列，v1 不写。
- `queue_entries` 重命名为 `invocation_queue`；`QueueStore` →
  `InvocationQueueStore`。它只做 admission/claim/lease/target 移除，是唯一
  pending-wake 账本。
- `QueueProcessor` 在 claim 后创建 parent `InvocationRecord`；queue entry 不持有
  消息终态。
- 详细链路见 `0010-a2a-runtime-chain.md`。

### 2.5 Credential

```ts
interface InvocationCredential {
  id: string;
  invocationId: string;
  threadId: string;
  userId: string;
  agentId: string;
  agentSessionId: string;
  allowedTools: string[];
  state: "active" | "terminal";
  disposition: "completed" | "failed" | "interrupted" | "canceled" | "revoked" | null;
}
```

token 由 daemon mint，绑定 child `TurnExecution`/thread/agent/session/user；
没有 task/role/run 字段。`allowedTools` 是 A2A pi extension tools 白名单
（post/cross/thread_context），不是 AgentConfig 工具策略。

- `InvocationRegistry` 是 service：`create/verify/commitTerminal`；
- 存储仍是 `invocation_credentials`；
- 鉴权面从 MCP callback 改为 pi extension tools；
- 详细字段/schema/校验见 `0010-a2a-runtime-chain.md`。

### 2.6 Usage / budget（v1 不做）

- v1 只记录 invocation usage；没有 ThreadGoal/tokenBudget/
  thread_member_effort。
- 现有 `budgets.task_id` / `tasks.budget_json` 是 Task-first legacy；v1 不读不写。
- Thread budget / member effort 是后续能力；另立 feature/表，不预埋进 v1。

### 2.7 后续能力（不在 v1）

以下能力在 A2A runtime 上逐步实现，各自单独立项，不预埋进 v1 schema：

- TaskItem / worktree / review / merge / SOP gate；
- custody / action lease / handoff / return-recovery；
- `multi_mention` 聚合回调（fan-out 已在 v1）；
- agent-created thread propose/approve；
- code delivery 的重新设计或弃用结论。

## 3. A2A v1 执行链

### 3.1 Thread invocation

```text
thread message / A2A tool
  → invocation_queue(threadId, sourceMessageId, targets)
  → QueueProcessor claim
  → InvocationRecord(parent, claim 后创建)
  → InvocationTracker.start(thread, agent)
  → AgentRouter.routeParallel
  → TurnExecution(child, invocationRecordId, agentSessionId, attempt)
  → InvocationRegistry.create(child credential)
  → pi RPC worker（cwd=thread.projectPath）
  → response bubble + TurnExecution terminal
  → PerAgentTerminalDispositionCollector + parent aggregate
```

没有 Task/worktree/review/merge/custody 分支。

### 3.2 Worker contract

- **Session**：`ensureThreadSession(threadId, agentId)`；一个 thread×agent
  一个 active session；`workingDirectory=thread.projectPath`。
- **Prompt**：`buildThreadPrompt({ thread, session, sourceMessage, participants,
  recentMessages })`；不渲染 `# Task`，不注入 worktree/branch/base。
- **Tool policy**：pi 自己的工具策略仍由 pi 执行层负责；AgentConfig 不定义
  pi tool policy。A2A pi extension tools 的 allowlist 在
  `InvocationCredential.allowedTools`；Thread 是主体；A2A runtime 验证
  thread/agent/session/tool，不在这里重新定义 pi 工具权限模型。
- **Workspace**：cwd = `thread.projectPath`；`projectPath` 为空时
  `thread_project_path_required` typed reject，不回退到 daemon 目录。
- **Budget**：只记录 usage；不调用 budget admission / deployment-wait /
  managed-work guard。
- **Terminal**：一个 invocation 一条 response bubble；v1 不产生 review/merge/
  stage 记录。

### 3.3 A2A v1 工具面

| 工具 | 作用 | 必填 | 不变量 |
|---|---|---|---|
| `codeteam_post_message` | 同 thread 发言并唤醒 targets | `targets`, `kind`, `bodyMd` | targets 是 AgentConfig id；text @ 不路由 |
| `codeteam_cross_post_message` | 跨 thread 发言并唤醒 targets | `threadId`, `targets`, `kind`, `bodyMd` | source/target thread 必须同 user 可见；depth/loop guard |
| `codeteam_multi_mention` | 同一问题 fan-out 给 2-3 个 agent | `targets` (2-3), `question`, `context?`, `requestId?` | one message + one queue entry + one InvocationRecord + N TurnExecutions；响应是独立消息；无聚合回调 |
| `codeteam_thread_context` | 读当前/指定 thread 的有界上下文 | 无 / `threadId` | 只读；不能跨 user |

约束：

- **彻底弃用** `codeteam_a2a_send` 与 `codeteam_handoff_*`：v1 不注册、不保留
  legacy alias、不提供 custody 工具窗口。
- 正文是自然语言；路由只由 typed `targets` 决定。final response 的行首 `@`
  不是路由，不解析、不唤醒。
- `post_message` / `cross_post_message` 带 optional `replyTo` 与 `requestId`；
  `multi_mention` 带 optional `requestId`。`requestId` 幂等键 scope 为
  `(threadId, agentId, requestId)`。
- `multi_mention` 是 fan-out：一条 message + 一个 queue entry + 一个
  `InvocationRecord`(parent) + N 个 `TurnExecution`(child)；响应是独立消息；
  parent 聚合 completed/partial_failed/failed 与成功/失败集合。v1 不做聚合
  回调，调用方用 `thread_context` 读响应；单 target 失败不影响其他 target。
- 消息送达不等于责任转移；v1 没有 handoff/claim/complete/return。
- targets 可以是任意 enabled agent；首次成功 invocation 后加入 thread
  participants。participants 是路由/上下文，不是 ACL。
- 跨 thread depth 上限 15；同一 source + target 已有 queued/running 返回
  `a2a_duplicate_delivery`；同一 requestId 不同 intent 返回
  `a2a_request_conflict`。
- 目标 thread 不存在、soft-deleted、跨 user、target agent disabled 都是 typed
  reject，不静默降级。
- `multi_mention` 的聚合回调不在 v1；fan-out 本身是 v1 能力。

## 4. 迁移与 cutover

### 4.1 阶段

| 阶段 | 内容 | 出口 |
|---|---|---|
| R0 | 冻结纯 A2A 架构；F017 phase-a-archive；F018 feature/plan；旧 code delivery 标 frozen/legacy | 文档真相源一致；不写产品代码 |
| R1 | 新 thread-first schema：AgentCatalog/accounts、Thread owner/participants/projectPath/titleSource/lastActiveAt/deletedAt、thread session、InvocationRecord/TurnExecution、credential、a2a_requests；旧 task/custody 表 legacy | 旧 code path 停写；新 A2A schema 可写；migration up/down；E14/E15 |
| R2 | same-thread post / thread context；observation；真实 provider E2E | E1/E2/E7/E9/E12/E13/E18 |
| R3 | cross-thread post；multi_mention fan-out；thread access；participants | E3/E4/E5/E6/E8/E10/E11/E16 |
| R4 | loop guard/idempotency；多 agent thread；不做 multi_mention 聚合回调 | E17 |
| R5 | cutover CLI/daemon；旧 code delivery 归档；F018 close | A2A runtime 单一真相 |

### 4.2 Schema delta

| 表 | 变更 | 迁移 |
|---|---|---|
| `threads` | 新增 `created_by`, `project_path`（必填）, `title_source`, `last_active_at`, `deleted_at`；`thread_participants` 新表 | owner 从 operator/最早 message/session 回填；projectPath 从 repo/task.worktree 共同根或 operator 配置回填；无法回填的 thread 进入 preflight 清单，不静默置空；archived → deleted_at |
| `agent_sessions` | 只保留 thread×agent 单 active；`task_id`/`profile_id` legacy | 先 drain/terminal 有 running invocation 的 session；sealing/sealed 行不迁移，留 legacy；旧 task session 不合并进新 runtime；目标列 `agent_id` |
| `runs` → `turn_executions` | 新 child 表：`invocationRecordId`、`parentInvocationId`、`agentSessionId`、`attempt`、provider/model、status/response/terminal；无 taskId | 旧 runs/task 数据保留只读 legacy，不双写 |
| 新 `invocation_records` | 消息级 parent：sourceMessageId unique、targetAgentIds、status、successful/failed/canceled、retryCount | 由 QueueProcessor 在 claim 后创建；无 task-first 字段 |
| `queue_entries` → `invocation_queue` | 只做调度：targets、priority、position、claim/lease | 旧 task-first queue 数据 legacy；新 runtime 不读 |
| `invocation_credentials` | 重建为 child TurnExecution capability：allowedTools、state/disposition、token hash/salt | 旧 task/role/run credential legacy |
| `a2a_requests` | `thread_id` + `task_id` nullable；unique `(thread_id, agent_id, request_id)`；drop 旧 task-level unique | 旧行按 task.thread 回填；同一 `(thread, agent, requestId)` 多行时按 `created_at` 保留最新为 canonical，其余标 legacy；无 task 的旧行标 legacy；不删除历史 |
| `messages` | 不改表；task 字段 legacy 可空 | 新消息不写 taskId |
| `tasks` / `handoffs` / `custody_events` / `budgets` / `reviews` / `merges` | 冻结 legacy，不读不写 | 保留历史只读；后续能力另立 feature |

**关键 cutover 约束**：v1 不跑旧 code delivery path。R1 前先停止新 task dispatch，
drain 或 terminal 有 running invocation 的 session；旧 task/custody 数据只读保留。
这样不需要“R1 加 session 唯一索引但旧 code path 继续跑”的双路径，也不会撞
reviewer 指出的 `(thread_id, agent_id)` 索引时序冲突。

### 4.3 回滚

- R1 前备份 dev/prod 数据；新 schema 用 migration up/down。
- v1 A2A runtime 与旧 code delivery 不双写；回滚 = 停新 runtime，恢复旧部署和
  旧 schema 快照。
- 旧 code delivery 的冻结/弃用是产品决策；回滚只恢复运行，不恢复其 v1 目标地位。

## 5. v1 验收矩阵

| # | 场景 | 期望 | 证据 |
|---|---|---|---|
| E1 | operator 在 thread 向 1 个 agent 发消息 | 创建 thread session + InvocationRecord + TurnExecution + response bubble；无 task | CLI/daemon E2E，DB 断言无 task 写 |
| E2 | 同 thread 两个 agent 互发 `post_message` | 两条 invocation 按 queue 唤醒 | 真实 pi RPC + mock provider |
| E3 | `cross_post_message` 到另一个 thread | 目标 thread 收到消息并唤醒 target；source/target 不变 | 双 thread E2E |
| E4 | `multi_mention` 给 2-3 个 agent | one message + one queue entry + one InvocationRecord + N TurnExecutions；响应独立；parent 聚合 partial_failed；无聚合回调 | E2E |
| E5 | 任意 enabled agent 被拉入 thread | 首次成功后成为 participant | participant 表断言 |
| E6 | text @ / final response @ | 不产生额外 queue/wake；只有 typed targets 路由 | 负例 E2E |
| E7 | token scope 负例 | 跨 thread / 错 user / 错 agent 的 token 被拒 | auth 单测 + E2E |
| E8 | 目标 thread soft-deleted / 跨 user / target disabled | typed reject，不静默降级 | 负例 E2E |
| E9 | 并发首条消息 | 同一 thread×agent session 不双开；queue 不重复消费 | 并发测试 |
| E10 | `requestId` replay/conflict | 同 intent replay；不同 intent `a2a_request_conflict` | 负例 E2E |
| E11 | `replyTo` 跨 thread / 不存在 | typed reject，不静默丢弃 | 负例 E2E |
| E12 | observation 工具名 | 识别 4 个新工具；text-@ 负例不误报 `missing_a2a_tool_call` | observation 单测 |
| E13 | 旧 A2A 工具 | `a2a_send`/`handoff_*` 在 v1 registry 完全不存在 | registry 断言 |
| E14 | 旧 code delivery 表 | v1 runtime 不读不写 tasks/handoffs/custody/reviews/merges | DB 访问断言 |
| E15 | session 迁移 | 有 running invocation 的 session 不迁移；等 terminal 后处理；sealing/sealed 留 legacy | migration 测试 |
| E16 | thread access | 同 user 可见；participants 只做路由；跨 user 拒绝 | auth/ACL 测试 |
| E17 | loop guard | depth 15、`a2a_duplicate_delivery`、`a2a_request_conflict` | 负例 E2E |
| E18 | legacy thread 的 `projectPath` 为空 | `post_message`/`cross_post_message` 触发 `thread_project_path_required`；补 `projectPath` 后正常 | 负例 E2E |

## 6. 影响面与风险

### 6.1 必须改的核心模块

- `control/migrations`：threads、thread_participants、agent_sessions、
  invocation_queue、invocation_records、turn_executions、invocation_credentials、
  a2a_requests；
- `auth`：InvocationRegistry + InvocationCredential；token 从 task scope 改为
  child TurnExecution / thread / agent / session；鉴权面为 pi extension tools；
- `dispatch`：QueueProcessor（claim/drain）、AgentRouter/routeParallel、
  parent/child terminal aggregation；DispatchService 拆分；
- `workers`：executor/harness/tool-policy/prompt；pi worker + A2A extension；
- `a2a`：pi extension tools、principal、tool-surface、terminal/observation；
- `cli/read-models`：thread create/owner/participants、MessageDispatchSummary、
  ThreadLiveInvocations；无 task 依赖；
- tests：现有 88 个 daemon 测试中的 task/custody 部分改为 legacy 或新 A2A 面。

### 6.2 已有 feature 的影响

- F004/F005/F008/F010/F011/F015/F016a 的 code delivery/custody 部分冻结为
  legacy；不作为 F018 v1 验收门，也不在 v1 runtime 中运行。
- 具体旧模块/表/工具/feature 清单与处置：
  `docs/architecture/0006-task-first-legacy.md`。
- F016b/F016c 的 wait/API 工作与 A2A runtime 的 thread/invocation 重新对齐。
- F017 Phase A 归档为历史输入；其 ADR/plan 已按 operator 决定移除。
- 后续 code delivery 是否重新设计或弃用，另立 feature 讨论；F018 不预设。

### 6.3 风险

- **P1 迁移/cutover 风险**：旧 code delivery 停写、running session drain、
  旧表 legacy 只读；必须保留回滚快照。
- **P1 auth 风险**：token 从 task scope 改成 invocation/thread；跨 thread/
  user/agent 负例必须覆盖。
- **P1 范围失控**：不要在 A2A runtime 里偷偷恢复 Task/worktree/review/merge/
  custody；这些都是后续能力。
- **P2 旧 feature 回归**：F016b/F016c 的 API 不能假设 task-first。
- **P2 迁移工具行为**：session 迁移必须跳过 running invocation，等
  terminal 再处理。

## 7. 明确不做

- 不在 v1 做 TaskItem / worktree / code delivery / review / merge / SOP gate；
- 不在 v1 做 custody / handoff / return / replace；
- 不在 v1 注册 `a2a_send` / `handoff_*`，不留 legacy alias 窗口；
- v1 做 `multi_mention` fan-out，不做聚合回调；
- 不在 v1 做 agent-created thread propose/approve；
- 不引入第二套 queue/message/session store；
- 直接复用 Clowder 的 runtime 结构与语义；不引入 Clowder runtime/Redis/transport
  依赖，存储与 transport 按 codeteam（SQLite、pi RPC、local socket）适配。

## 8. 决策记录

| # | 决策 | 结论 | 归属 |
|---|---|---|---|
| D1 | feature 归属 | **F018 A2A runtime v1**；F017 Phase A 归档 | operator 2026-11-04 |
| D2 | budget 归属 | codeteam 当前没有 ThreadGoal/tokenBudget；v1 只记录 usage，不引入 ThreadGoal/thread_member_effort；thread budget 后续另立 feature | operator 2026-11-05 修订 |
| D3 | v1 范围 | **纯 A2A runtime**；`a2a_send`/`handoff_*` 彻底弃用；code delivery setup 冻结/弃用 | operator 2026-11-04 |
| D4 | 数据迁移 | 新 thread-first schema + up/down；旧 code delivery 表 legacy 只读；running session 先 drain | 工程默认 |
| D5 | thread 创建 | v1 operator/CLI create；agent propose/approve 后续 | 工程默认 |
| D6 | v1 工具权限 | pi 工具策略由 pi 执行层负责；A2A pi extension tools 的 allowlist 在 InvocationCredential；AgentConfig 不定义 tool policy | operator 2026-11-04，2026-11-06 修订 |
| D7 | A2A runtime 链路 | 直接复用 Clowder 10 组件骨架：InvocationQueue/QueueProcessor/InvocationRecord/InvocationTracker/AgentRouter/routeParallel/invoke-single-agent/TurnExecution/InvocationRegistry/terminal+recovery；v1 轻量化；routeSerial 删除 | operator 2026-11-06 |

**术语**：Thread 是主体；`InvocationRecord` 是消息级 parent；
`TurnExecution` 是单 agent 一次执行；Session 是 thread×agent 的持久身份；
TaskItem 不在 v1。`executionKind` 只有 `ordinary | routing_guard`。没有
conversation/code 两种 execution，也没有 conversation 权限域。

## 9. 与 F017 的关系

- F017 Phase A 的 ADR-0001/0002 与 plan 0019 已按 operator 2026-11-04 决定移除；
  不再保留为当前或历史实现依据。
- F017 feature 已标 `phase-a-archive`，只保留 feature 级历史输入与风险清单；
  task-first facade / 跨 thread custody 坐标作废。
- F018 拥有 A2A runtime v1 的 feature/plan 和 R0-R5。

[宪宪/deepseek-flash🐾]
