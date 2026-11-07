---
feature_ids: [codeteam/F018]
related_features: [codeteam/F017, codeteam/F016]
title: "F018: A2A runtime v1"
status: spec
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
vision_guard: 墨墨 (Qwen 3.8 Flash)
created: 2026-11-04
updated: 2026-11-06
source_plan: "docs/plans/0020-f018-thread-first-runtime.md"
source_architecture: "docs/architecture/0005-thread-first-runtime.md"
source_decision: "operator 2026-11-04 C: v1 = pure A2A runtime; a2a_send/handoff_* retired; code delivery frozen"
supersedes_phase_a_of: codeteam/F017
---

# F018: A2A runtime v1

> **v1 只做纯 A2A runtime。** Thread 是主体，Invocation 是 thread 里的一轮执行；
> `codeteam_a2a_send` / `codeteam_handoff_*` 彻底弃用；code delivery setup
> 冻结/弃用。后续 agent team 能力在 A2A runtime 上逐步实现，各自单独立项。
>
> 架构基线：`docs/architecture/0005-thread-first-runtime.md`；
> A2A runtime 链路：`docs/architecture/0010-a2a-runtime-chain.md`。

## Why

codeteam 当前让 Task 同时承担“代码工作项”和“所有 agent 执行的统一锚”两件事，
导致 A2A chat 也必须先有 Task/worktree/session，和 Clowder 的
Thread/Invocation 模型不一致。operator 2026-11-04 决定：

- v1 先做纯 A2A runtime；
- `a2a_send` / `handoff_*` 彻底弃用；
- 现有 code delivery setup 冻结/弃用，不作为 v1 的一部分；
- 后续能力在 A2A runtime 上逐步实现。

## 目标态

1. Thread 是主聚合根：user-owned、participants、projectPath、active/deleted、
   lastActiveAt。
2. Invocation 拆两层：`InvocationRecord`（消息级 parent，targetAgentIds/
   status/successful/failed/canceled/retryCount）+ `TurnExecution`（单 agent
   child，invocationRecordId/a2aParentTurnExecutionId/agentSessionId/attempt）；
   `executionKind=ordinary|routing_guard`，没有 conversation/code。
3. Session 是 thread×agent 的持久身份；一个 active session；无 taskId。
4. Agent 身份是 config-as-code：`.codeteam/agent-catalog.json` →
   `AgentConfig` → `AgentRegistry`；`AgentState` 是运行时状态。
5. A2A v1 工具面：`codeteam_post_message` / `codeteam_cross_post_message` /
   `codeteam_multi_mention` / `codeteam_thread_context`。
6. Queue 单账本：thread + sourceRecordId + attempt + targets；无 task 依赖。
   身份/命名以 `docs/architecture/0011-identity-contract.md` 为准。
7. Auth 以 child `TurnExecution`/thread/agent/session 为锚；pi extension tools
   allowlist 在 `InvocationCredential`；无 task/role/run 坐标。
8. v1 只记录 invocation usage；不引入 ThreadGoal/tokenBudget/
   thread_member_effort；旧 task budget 是 legacy。
9. v1 不做 TaskItem/worktree/code delivery/review/merge/custody/SOP handoff。

## 分阶段

| 阶段 | 范围 | 出口 |
|---|---|---|
| R0 | 冻结纯 A2A 架构；F017 phase-a-archive；F018 feature/plan；旧 code delivery 标 frozen/legacy | 文档真相源一致；不写产品代码 |
| R1 | 新 thread-first schema：AgentCatalog/accounts、Thread owner/participants/projectPath/titleSource/lastActiveAt/deletedAt、thread session、InvocationRecord/TurnExecution、credential、a2a_requests；旧 task/custody 表 legacy | 旧 code path 停写；新 A2A schema 可写；migration up/down |
| R2 | same-thread post / thread context；真实 provider E2E | E1/E2/E7/E9/E12/E13 |
| R3 | cross-thread post；thread access；participants | E3/E4/E5/E6/E8/E10/E11 |
| R4 | loop guard/idempotency/observation；多 agent thread；不做 multi_mention 聚合回调 | E14/E15/E16/E17 |
| R5 | cutover CLI/daemon；旧 code delivery 归档；F018 close | A2A runtime 单一真相 |

## 验收方向

以 `docs/architecture/0005-thread-first-runtime.md` §5 的 E1-E17 为准，最低条件：

- [ ] 无 task thread 可以真实 provider 完成 post/response。
- [ ] same-thread post E2E；cross-thread post E3。
- [ ] `multi_mention` 2-3 agent fan-out E4。
- [ ] `.codeteam/agent-catalog.json` + accounts 加载/校验；AgentRegistry/AgentState；
      disabled agent typed reject；defaultModel 属于 account.models。
- [ ] A2A targets 用 agentId；消息展示用 displayName。
- [ ] 空 thread 可创建；post 无 targets typed reject；soft-deleted thread post reject；
      projectPath 必填且 legacy preflight 可列出需补路径的 thread。
- [ ] 任意 enabled agent 加入 participants；thread access 同 user。
- [ ] token scope 负例 E7；target thread 负例 E8。
- [ ] text @ / final @ 不路由 E6；observation 识别 4 个新工具 E12。
- [ ] `a2a_send`/`handoff_*` 在 v1 registry 完全不存在 E13。
- [ ] v1 runtime 不读不写 tasks/handoffs/custody/reviews/merges E14。
- [ ] session 迁移跳过 running invocation E15。
- [ ] requestId replay/conflict、replyTo、loop guard E10/E11/E17。

## 非目标

- TaskItem / worktree / code delivery / review / merge / SOP gate；
- custody / handoff / return / replace；
- `multi_mention` 聚合回调（fan-out 已在 v1）；
- agent-created thread propose/approve；
- Console M0 / W7b；
- 引入 Clowder runtime/Redis/transport 依赖；只复用结构与语义。

## 历史输入与 legacy

- F017 Phase A：A2A 调研、风险清单、review disposition；历史输入。
- F015/F016a：A2A/custody E2E 历史证据；custody 部分不作为 v1 验收门。
- F004/F005/F008/F010/F011：task-bound code delivery/custody 冻结为 legacy，
  不在 v1 runtime 中运行。
- F016b/F016c：wait/API 工作按 thread/invocation 重新对齐，不假设 task-first。
- 旧 Task-first 实现清单与处置：
  `docs/architecture/0006-task-first-legacy.md`。

## 风险

- **P1 迁移/cutover**：旧 code delivery 停写、running session drain、旧表 legacy
  只读；必须保留回滚快照。
- **P1 auth**：token 从 task scope 改 child TurnExecution/thread/agent/session；跨 thread/user/agent
  负例必须覆盖。
- **P1 范围失控**：不要在 A2A runtime 里偷偷恢复 Task/worktree/review/merge/
  custody。
- **P2 旧 feature 回归**：F016b/F016c 的 API 不能假设 task-first。

## 状态

`spec`。R0 文档已落；R1 待开工。实现必须另开隔离 worktree，按 TDD/quality-gate/
review/merge-gate 推进；R0 不写产品代码。

[宪宪/deepseek-flash🐾]
