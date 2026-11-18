---
feature_ids: [codeteam/F018]
related_features: [codeteam/F017, codeteam/F016]
title: "F018: A2A runtime v1"
status: spec
owner: "砚砚 (GLM 5.3 Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
vision_guard: 墨墨 (Qwen 3.8 Flash)
created: 2026-11-04
updated: 2026-11-18
source_plan: "docs/plans/0020-f018-thread-first-runtime.md"
source_architecture: "docs/architecture/0005-thread-first-runtime.md"
source_decision: "operator 2026-11-04 C: v1 = pure A2A runtime; a2a_send/handoff_* retired; code delivery frozen; 2026-11-14 BBBA: mentionPatterns body match / multi_mention callback child / completed dedupe accepted risk / allFailed derived; 2026-11-18: F018 development ownership handed to 砚砚"
supersedes_phase_a_of: codeteam/F017
---

# F018: A2A runtime v1

> **v1 只做纯 A2A runtime。** Thread 是主体，Invocation 是 thread 里的一轮执行；
> `codeteam_a2a_send` / `codeteam_handoff_*` 彻底弃用；code delivery setup
> 冻结/弃用。后续 agent team 能力在 A2A runtime 上逐步实现，各自单独立项。
>
> 架构基线：`docs/architecture/0005-thread-first-runtime.md`；
> A2A runtime 链路：`docs/architecture/0007-a2a-runtime-chain.md`。

> F019.5 naming cleanup (2026-11-18): runtime tool IDs are `superagentteam_*`;
> the `codeteam_*` aliases and `.codeteam/` dual-read are removed. No F018
> runtime/DDL/state-machine semantics changed.

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
2. Invocation 拆两层：`InvocationRecord`（消息级 parent，invocationId/targetAgentIds/
   status/successful/failed/canceled/retryCount）+ `TurnExecution`（Clowder core：
   parentInvocationId/causal/status/时间）；每个 target 的每次投递/重试另有 append-only
   `invocation_attempts` 台账（QueueTargetAttempt 语义：delivery_state +
   session/worker/provider/model/usage/settlement/R）；
   response 采用 durable streaming（processing R + `response_drafts` + `responsePending`）；
   `executionKind=ordinary|routing_guard`，没有 conversation/code。
3. Session 是 thread×agent 的持久身份；一个 active session；无 taskId。
4. Agent 身份是 config-as-code：`.superagentteam/agent-catalog.json` →
   `AgentConfig`（含 `mentionPatterns`）→ `AgentRegistry`；`AgentState` 是运行时状态。
5. A2A v1 工具面：`superagentteam_post_message` / `superagentteam_cross_post_message`（单 successor）
   / `superagentteam_multi_mention`（唯一多 target fan-out，2-3 agents；terminal 后 callback child）/
   `superagentteam_thread_context`。
6. Queue 单账本：thread + sourceRecordId + attempt + targets；target attempt 台账
   append-only；retry 不新建 queue entry、不重新 admission；无 task 依赖。
   ordinary A2A retry 复用 Clowder route recovery，不是 cloud delivery 的
   fresh source/attempt。
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
| R1 | 新 thread-first schema：AgentCatalog/accounts、Thread owner/participants/projectPath/titleSource/lastActiveAt/deletedAt、thread session、InvocationRecord/TurnExecution、credential（含 `toolCallClaims`）；旧 task/custody 表 legacy | 旧 code path 停写；新 A2A schema 可写；migration up/down；E14/E15 |
| R2 | same-thread post / thread context；observation；真实 provider E2E | E1/E2/E7/E9/E12/E13/E18/E19/E22 |
| R3 | cross-thread post；multi_mention orchestrator（status/timeout/aggregate + callback child）；thread access；participants | E3/E4/E5/E6/E8/E10/E11/E16/E21 |
| R4 | loop guard/idempotency/observation；multi_mention timeout/anti-cascade；多 agent thread；recovery | E17/E20 |
| R5 | cutover CLI/daemon；旧 code delivery 归档；F018 close | A2A runtime 单一真相 |

## 验收方向

以 `docs/architecture/0005-thread-first-runtime.md` §5 的 E1-E22 为准，最低条件：

- [ ] 无 task thread 可以真实 provider 完成 post/response。
- [ ] same-thread post E2E；cross-thread post E3。
- [ ] queue cap 5（user/A2A 分开计数）；urgent/FIFO；queue full 429/`queue_full`
      不写 source。
- [ ] `multi_mention` 2-3 agent fan-out + status/timeout/aggregate + callback child E4；
      `allFailed` 派生；callback depth/anti-cascade；
      post/cross >1 same-thread target → `use_multi_mention`。
- [ ] `.superagentteam/agent-catalog.json` + accounts 加载/校验；AgentRegistry/AgentState；
      disabled agent typed reject；defaultModel 属于 account.models。
- [ ] A2A targets 用 agentId；消息展示用 displayName。
- [ ] operator 不是 QueueTarget；agent 正文行首 `@operator` 只写 message
      `mentionsUser`，operator 回复是新的 user message。
- [ ] 空 thread 可创建；post targets 为空 = message-only write，不建 queue/parent；
      `@operator` 只写 `mentionsUser`；soft-deleted thread post reject；
      projectPath 必填且 legacy preflight 可列出需补路径的 thread。
- [ ] 任意 enabled agent 加入 participants；thread access 同 user。
- [ ] token scope 负例 E7；target thread 负例 E8。
- [ ] agent final response @ / A2A tool body @ 不路由；operator 用户消息的正文 `@`
      正常路由；未命中 pattern 的 `@token` 不拒绝；命中 disabled pattern 必拒；
      observation 识别 4 个新工具 E12。
- [ ] `a2a_send`/`handoff_*` 在 v1 registry 完全不存在 E13。
- [ ] v1 runtime 不读不写 tasks/handoffs/custody/reviews/merges E14。
- [ ] session 迁移跳过 running invocation E15。
- [ ] piExtToolCallId replay/conflict、replyTo、loop guard E10/E11/E17。
- [ ] terminal aggregate/retry：all-canceled、auto-retry pending、terminal idempotency、
  每个 child terminal 释放 tracker、canceled 不 retry、failed entry abandon/TTL。
- [ ] recovery/liveness：startup cutoff/protected、上一进程 ended R、单 reaper、
  zombie child R/queue 收敛、live projection 去重、response_missing、provider-exit grace。
- [ ] queue cap/priority E19；daemon restart/recovery E20；cancel/retry E21 均有 round gate。
- [ ] admission 后 target 永久失效：attempt `queued→failed`（target_invalid）+
      `delivery_failure` + retire；健康 sibling 继续；E22。

## 非目标

- TaskItem / worktree / code delivery / review / merge / SOP gate；
- custody / handoff / return / replace；
- cross-thread multi_mention / cross-thread callback child（v1 callback 只在原 thread）；
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

## Handoff（2026-11-18）

> operator 2026-11-18：`@宪宪 后续F018的开发工作你交接给砚砚`。F018 开发主责（owner）
> 从宪宪转给砚砚。这是责任交接，不自动等于解冻：2026-11-16 的“F019 完成后先别急着
> 开始 F018”仍以 operator 明确解除为准；砚砚启动 R1-0 前确认。

### 接手坐标

- 当前基线：`superagentteam-work` @ `bc1d71512`（F019.5 已 merge，alias 已清理）。
- F018 状态：`spec`；Phase A 设计已 accepted（`86310de24`）。三猫 verdict：烁烁 approve；
  砚砚 5 轮 exact-HEAD approve；墨墨 changes_requested → 对 `61e4790fd` / `86310de24` approve。
- 契约锚点：`86310de24`。F019.5 只做命名 re-anchor，未改 F018 语义；R1 期间若改
  `docs/architecture/` 契约，需重新锚 verdict；只加产品代码不改契约则原 verdict 继续有效。
- Legacy：task-first 冻结，清单见 `0006`；不得把 `dispatch/`、`scheduling/`、`review/`、
  `merge/`、`gates/`、`sop/`、`managed-work/`、`deployment-wait/`、`custody/`、
  task-bound worker/auth 当作 F018 baseline。

### 必读顺序

1. `docs/architecture/0005-thread-first-runtime.md`：方向、范围、E1-E22。
2. `docs/architecture/0007-a2a-runtime-chain.md`：机制、DDL、状态机。
3. 分册 `0008` / `0009` / `0010` / `0011` / `0013` / `0016` / `0017`。
4. `docs/architecture/0018-v1-global-design-review.md` + `decision-packets/2026-11-14-*`。
5. `docs/plans/0021-f018-r1-execution.md`：R1-0 / R1-a–d 执行顺序。
6. `docs/architecture/0006-task-first-legacy.md`：冻结清单。

### R1 执行顺序

- **R1-0**：legacy 物理隔离 + `@superagentteam/shared` 骨架 + daemon `domains` + boundary guard。
- **R1-a**：migration harness + AgentCatalog/thread/message/read state。
- **R1-b**：InvocationRecord/TurnExecution/invocation_attempts + queue/admission。
- **R1-c**：credential/auth + response_drafts + session/worker。
- **R1-d**：greenfield gate + E13/E14 + review/merge。

### 必须守住的不变量

- Thread 是聚合根；InvocationRecord parent + TurnExecution child；attempt append-only；无 taskId。
- Phase A 批量 reservation（QueueProcessor 单事务）→ Phase B per-target dispatch；禁止二次 `ensureActive`。
- T1/T2/T3/T4 owner 分离；生产代码不得引入 `settleAgentTurn`。
- durable stream：processing R + `response_drafts`；delta 不写 messages。
- operator 用户消息正文 `@` 按 `mentionPatterns` 解析；A2A tool body / agent final response 不解析。
- E13：`a2a_send` / `handoff_*` 不注册；F019.5 后 `codeteam_*` alias 也不再注册。
- v1 不读不写 tasks/handoffs/custody/reviews/merges；legacy 表只读至 R5。

### 开放问题 / 风险

- R1-0 启动授权：operator 11-16 pause 是否解除，需明确确认。
- `thread_context` per-agent visibility 语义（0018 R-05），R2 前确认。
- `routing_guard` v1 不创建，只保留 enum/表对齐。
- completed 跨 tool-call 重试去重 accepted risk（DP-F018IDEM-1=B）。
- R-01 `queue_admissions.thread_id` 收紧；R-02 无 attempt 的 ordinary TurnExecution 负例；
  R-03 `response_missing` 无 R 行策略；R-04 `multi_mention` reaper 测试；R-06
  `mentionPatterns` 改名流程。
- 独立 infra todo：Publish Model Catalog / PR Gate workflow，不属 F018。

### 接手后的下一步

1. 向 operator 确认 R1-0 是否解冻。
2. 解冻后从 `superagentteam-work` 开隔离 worktree，按 `0021` 的 R1-0 做 legacy 隔离和 guard；先红后绿。
3. 代码 review 走非作者 fresh-context；Phase A docs verdict 只在契约未改时继续有效。
4. 更新 F018/BACKLOG 状态与 evidence；不改历史 F017/F019 归档。

## 状态

`spec`。R0 文档已落；R1 待开工。实现必须另开隔离 worktree，按 TDD/quality-gate/
review/merge-gate 推进；R0 不写产品代码。

[宪宪/deepseek-flash🐾]
