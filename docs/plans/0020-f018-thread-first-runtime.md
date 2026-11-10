---
title: "F018 — A2A runtime v1 实施计划（R0-R5）"
doc_kind: plan
status: draft
created: 2026-11-04
updated: 2026-11-10
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
feature: F018
source_architecture: "docs/architecture/0005-thread-first-runtime.md; docs/architecture/0010-a2a-runtime-chain.md"
source_decision: "operator 2026-11-04 C: v1 = pure A2A runtime"
---

# F018 — A2A runtime v1 实施计划

> 本计划执行 `docs/architecture/0005-thread-first-runtime.md` 与
> `docs/architecture/0010-a2a-runtime-chain.md` 的 R0-R5。
> v1 只做纯 A2A runtime；TaskItem/code delivery/custody 不在本计划。
> 所有阶段共享单 queue/message/session 账本，不造第二套 store。

## R0 — 文档冻结与真相源切换

- F017 Phase A 标记 `phase-a-archive`；F017 plan 0019 归档。
- F018 feature + 本 plan；BACKLOG 加 F018 行。
- 按 operator 2026-11-04 决定移除 F017 的 ADR-0001/0002 与 plan 0019。
- README / plans 索引更新；旧 code delivery feature 标 frozen/legacy。
- 出口：`check:doc-index` 通过；docs-only；不写产品代码。

## R1 — Schema 与迁移

- `threads`：`created_by`、`project_path`（必填）、`title_source`、
  `last_active_at`、`deleted_at`。
- `thread_participants`。
- `.codeteam/agent-catalog.json` + `.codeteam/accounts.json`：AgentConfig /
  AccountConfig 加载、校验、AgentRegistry；AgentState 运行时状态。
- `agent_sessions`：thread×agent 单 active；`agent_id` 目标列；`task_id`/
  `profile_id` legacy。
- `runs` → `turn_executions` + `invocation_records`：parent 消息生命周期 +
  child 执行 core（Clowder `TurnExecutionRecord`：identity/causal/status/时间）；无 taskId。
- `queue_entries` → `invocation_queue`：只做调度；`InvocationRecord` 在 claim 后创建。
- `invocation_attempts`：append-only target attempt 台账；unique
  `(invocation_record_id, target_agent_id, attempt)`；retry 追加新 attempt，旧行不改；
  queue entry 保留到所有 target attempt 终态（`targets_json` 可为空）；承载
  session/worker/provider/model/usage + `settlement`/`response_message_id`。
- `response_drafts`：processing R 的 in-flight body；`attempt_id`/`turn_execution_id`
  1:1；stream 按 100ms/4KB bounded flush；R terminal 后删除。
- `invocation_credentials`：child TurnExecution capability；allowedTools/
  state/disposition；无 taskId/role/run。
- `invocation_attempts.settlement`：`NULL | streaming | response_pending | settled`；
  ordinary attempt 从 start 绑定 processing R；child terminal → `response_pending`；
  settlement → `settled`。
- `invocation_attempts.agent_session_id`：nullable runtime binding；同 session 唯一 running。
- `workers` + `worker_bindings`：ephemeral worker；pi v1 capacity=1、一 worker 一 session；
  `warmTtl=0`、`maxLiveWorkers=8`；session 不再持有 worker。
- `agent_read_state`：`(thread_id, agent_id) → delivery_cursor`（thread-global seq）；
  v1 只做 delivery cursor，不做 seenCursor/mentionAck。
- `messages`：v1 不定义 domain `Message`，`StoredMessage` 是唯一记录；加
  `content_json`（text/tool_call/tool_result）、`tool_events_json`、
  `lifecycle_json`、`thinking`、`deleted_at`/`deleted_by`、`extra_json`
  （kind/targetAgentIds/rich `{v:1,blocks}`/crossPost）；`body_md` 是 plain text body；
  legacy `task_id/control_ref/dispatch_refs_json/rich_blocks_json` 停止写入，R5 drop。
- `a2a_requests`：`thread_id` + `task_id` nullable；unique
  `(thread_id, agent_id, request_id)`；drop 旧 task-level unique。
- 旧 `tasks`/`handoffs`/`custody_events`/`budgets`/`reviews`/`merges` 冻结 legacy，
  不读不写。
- 迁移前 drain/terminal 有 running invocation 的 session；跳过 running，等 terminal。
- 出口：旧 code path 停写；新 A2A schema 可写；migration up/down 可回滚。

## R2 — Same-thread A2A

- `ensureThreadSession(threadId, agentId)`：一个 thread×agent 一个 active
  session、`workingDirectory=thread.projectPath`。
- 空 thread 允许创建；post 时 targets 必须非空；`deletedAt != null` 的 thread
  拒绝 post。
- A2A target 从 AgentRegistry 解析；`enabled=false` / 未知 id / account 缺失
  都是 typed reject。
- `buildThreadPrompt`：thread/participants/recent + delivery cursor；无 `# Task`。
- tool policy：pi 工具策略由 pi 执行层负责；A2A pi extension tools 的 allowlist
  在 InvocationCredential；AgentConfig 不定义 tool policy。
- dispatch thread branch：QueueProcessor、InvocationRecord、attempt、core TurnExecution、
  processing R、credential；不调用
  budget/deployment/managed-work guard。
- retry：target-level `requestRetry`；同 parent/同 source message/同 queue entry，不重新
  admission；已终态失败只接受显式 retry 追加 attempt+1；pre-handoff pending target 用
  process-local bounded backoff（base 10s、上限 1h）自动重试。
- retry 采用 Clowder route recovery（`retryRoutingTarget`），不是 cloud delivery 的
  fresh source/attempt；不新建 queue entry、不产生第二条用户消息。
- worker：`WorkerPool.ensure` 按 poolKey 取/建 ephemeral worker；turn 结束默认 retire；
  记录 `worker_spawn_ms` / `worker_busy_ms` / `worker_evicted_count`。
- live stream（DP-F018X-2=B）：attempt start 创建 attempt + processing R；`WorkerEventSink` 处理
  `message_update.text_delta` + tool start/end，写 `response_drafts`，同时发 ephemeral
  `AgentStreamEvent` 给 UI；不按 delta 写 messages。
- response settlement：TurnExecution terminal + attempt terminal + parent aggregate +
  credential 同一事务并把 attempt `settlement` 标 `response_pending`；随后
  `settleResponseFromDraft` 提交 R terminal + settle inputs + delete draft +
  attempt `settled` + clear pending；崩溃后 startup reconciler 重放。
- 出口：E1/E2/E7/E9/E12/E13；真实 pi RPC + mock provider。

## R3 — Cross-thread A2A

- `codeteam_cross_post_message`：target threadId、targets、thread access、
  depth/loop guard、typed rejects。
- `codeteam_multi_mention`：2-3 targets fan-out；one message + one queue entry +
  N invocations；不做聚合回调。
- 任意 enabled agent 可被 target；首次成功后加入 participants。
- `thread post --to` 不再要求 `--task`；CLI/read model 同步。
- 出口：E3/E4/E5/E6/E8/E10/E11。

## R4 — Loop guard / observation / 多 agent

- depth 15、`a2a_duplicate_delivery`、`a2a_request_conflict`。
- observation 识别 4 个新工具；text-@ 负例不误报。
- 多 agent thread；不做 `multi_mention` 聚合回调。
- 出口：E14/E15/E16/E17。

## R5 — Cutover 与清理

- CLI/daemon 切 A2A runtime；旧 code delivery 停写/归档。
- 删除不再需要的 alias/legacy；保留历史数据只读。
- 出口：A2A runtime 单一真相；F018 close 需 vision guard + operator。

## 验证与 review

- 每阶段按 TDD：先 RED，再 GREEN；真实 provider E2E 不拿 handler 测试冒充。
- 契约/数据/auth 面按 SOP 选一个非作者 reviewer；架构 0005 需 review 覆盖最终
  digest。
- 合并前 `check:doc-index`、受影响测试、`git diff --check`。
- R1/R2 必须有 attempt 台账测试：同身份不同 `startedAt` replay、retry 追加 attempt 不改旧行、
  successful target 不重跑、queue entry 在 terminal 前后保留/删除。
- R1/R2 必须有 durable stream 测试：processing R 原子创建、delta 只写 draft、child terminal
  把 attempt settlement 标 pending、settlement 提交 R terminal 并清 pending、crash 后
  reconciler 恢复。
- R1/R2 必须有 recovery 测试：`interruptRunningBefore` 收敛 running TurnExecution，
  attempt/settlement 同步收敛；`clearResponsePending` 是 attempt settlement 投影。

## 回滚

- R1：drop 新列/新表；旧部署 + 旧 schema 快照恢复。
- R2/R3：停 A2A runtime；旧 code delivery 不双写。
- R4/R5：保留 migration down + 数据快照。

[宪宪/deepseek-flash🐾]
