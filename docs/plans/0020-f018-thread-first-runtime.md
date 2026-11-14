---
title: "F018 — A2A runtime v1 实施计划（R0-R5）"
doc_kind: plan
status: draft
created: 2026-11-04
updated: 2026-11-12
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
feature: F018
source_architecture: "docs/architecture/0005-thread-first-runtime.md; docs/architecture/0007-a2a-runtime-chain.md"
source_decision: "operator 2026-11-04 C: v1 = pure A2A runtime; 2026-11-12 DP-C=A, DP-D=A"
---

# F018 — A2A runtime v1 实施计划

> 本计划执行 `docs/architecture/0005-thread-first-runtime.md` 与
> `docs/architecture/0007-a2a-runtime-chain.md` 的 R0-R5。
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
  per-thread cap 5（user/A2A 分开计数）；urgent 先、同 priority FIFO；超限
  `queue_full`/429，不写 source。
- `invocation_attempts`：Clowder `QueueTargetAttempt` 语义的 append-only 投递/重试台账；
  unique `(parent_invocation_id, target_agent_id, attempt)`；retry 追加新 attempt，
  旧行不改；queue entry 保留到所有 target attempt 终态（`targets_json` 可为空）；
  承载 `delivery_state` + session/worker/provider/model/usage +
  `settlement`/`response_message_id`。
- `response_drafts`：processing R 的 in-flight body；`attempt_id`/`turn_execution_id`
  1:1；stream 目标 100ms/4KB bounded flush（R2 benchmark 后定，不写成不可变契约）；
  R terminal 后删除；Store 契约见 `0017-response-draft-store.md`
  （单个 `DraftRecord` + create/upsert 全量 snapshot + get/delete/orphan；单 writer 串行 flush）。
- `invocation_credentials`：child TurnExecution capability；allowedTools/
  toolCallClaims（piExtToolCallId claim map）/state/disposition（含 replaced）；无 taskId/role/run。
- `invocation_attempts.settlement`：`NULL | streaming | response_pending | settled`；
  ordinary attempt 从 start 绑定 processing R；child terminal → `response_pending`；
  settlement → `settled`。
- `invocation_attempts.agent_session_id`：nullable runtime binding；同 session 唯一
  active delivery（`starting|appended`）。
- `workers` + `worker_bindings`：ephemeral worker；pi v1 capacity=1、一 worker 一 session；
  `warmTtl=0`、`maxLiveWorkers=8`；session 不再持有 worker。
- `agent_read_state`：`(thread_id, agent_id) → delivery_cursor`（thread-global seq）；
  v1 只做 delivery cursor，不做 seenCursor/mentionAck。
- `messages`：v1 不定义 domain `Message`，`StoredMessage` 是唯一记录；加
  `content_json`（text/tool_call/tool_result）、`tool_events_json`、
  `lifecycle_json`、`thinking`、`deleted_at`/`deleted_by`、`extra_json`
  （targetAgentIds/rich `{v:1,blocks}`/crossPost/multiMention）；`body_md` 是 plain text body；
  legacy `task_id/control_ref/dispatch_refs_json/rich_blocks_json` 停止写入，R5 drop。
- `a2a_requests`：legacy 只读；v1 不再写入；piExtToolCallId 幂等迁到
  `invocation_credentials.tool_call_claims_json`（DP-F018AUTH-3=B）。
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
- 终态/重试（DP-F018TERM=A×7）：all-canceled → parent canceled；auto-retry pending 保持
  queued/running；每个 child terminal 释放 tracker slot；terminal first-write-wins；
  requestRetry 只 retry failed/interrupted；dispatchRefs 更新 latest attempt；failed entry
  显式 abandon + 30d TTL；parent 持久化 primaryTerminalError。
- recovery/liveness（DP-F018RECOVERY=A×7）：startup 用 `processStartedAt+1` + protected
  只结算上一进程 ended turn；单 serialized reaper；zombie 收敛 child R→queue→parent→
  credential→slot；live projection 去重/evidence rank/过滤 terminal R；`response_missing`
  独立 recovery；provider exit 5min grace + owner fence。
- worker：`WorkerPool.ensure` 按 poolKey 取/建 ephemeral worker；turn 结束默认 retire；
  记录 `worker_spawn_ms` / `worker_busy_ms` / `worker_evicted_count`。
- live stream（DP-F018X-2=B）：attempt start 创建 attempt + processing R；`WorkerEventSink` 处理
  `message_update.text_delta` + tool start/end，写 `response_drafts`，同时发 ephemeral
  `AgentStreamEvent` 给 UI；不按 delta 写 messages。draft 用
  `ResponseDraftStore.upsert` 全量 snapshot，单 writer 串行 flush；T2 删除失败保留
  `response_pending`，T4 重试。
- response settlement（DP-C/DP-D=A/A，2026-11-12）：
  - T1 `invoke-single-agent` + `TurnExecutionLifecycle`：TurnExecution terminal +
    `projectChildTerminal` + attempt `settlement='response_pending'` + credential
    terminalize + `recordTurnTerminal`/ack（同一事务）；不写 parent/R。
  - T2 `RouteResponseCommitter`：R terminal + settle inputs + delete draft + attempt
    `settled` + clear pending + A2A successor。
  - T3 `QueueProcessor` + collector：parent aggregate + queue/retry + tracker slot。
  - T4 `ResponseRecoveryService`：`response_pending` / `response_missing` recovery；
    `settleResponseFromDraft` 只属于 T4。
  - 生产代码不引入 `settleAgentTurn`。
- 出口：E1/E2/E7/E9/E12/E13；真实 pi RPC + mock provider。

## R3 — Cross-thread A2A

- `codeteam_post_message` / `codeteam_cross_post_message`：单 successor（0 或 1 agent
  target）；同 thread 多 target → `use_multi_mention`；cross-thread 多 target 拆多次
  cross-post。
- `codeteam_multi_mention`：完整 Clowder orchestrator；2-3 targets、one message +
  one queue entry + one parent + N children；`multi_mention_requests/responses` 记录
  status/timeout/callback/aggregate；`callbackTo` 不新建 child；它是唯一多 target
  fan-out 入口。
- 任意 enabled agent 可被 target；首次成功后加入 participants。
- `thread post --to` 不再要求 `--task`；CLI/read model 同步。
- 出口：E3/E4/E5/E6/E8/E10/E11。

## R4 — Loop guard / observation / 多 agent

- depth 15（DP-F018SURFACE-2=A：Clowder 实际默认 15；review 链需 >2；
  guard = per-thread queue cap 5 + substantive-aware ping-pong + early-stop）、
  `a2a_duplicate_delivery`、`pi_ext_tool_call_conflict`。
- observation 识别 4 个新工具；text-@ 负例不误报。
- 多 agent thread；`multi_mention` timeout/status/aggregate、anti-cascade、
  target cancellation 收敛。
- 出口：E14/E15/E16/E17。

## R5 — Cutover 与清理

- CLI/daemon 切 A2A runtime；旧 code delivery 停写/归档。
- 删除不再需要的 alias/legacy；保留历史数据只读。
- 出口：A2A runtime 单一真相；F018 close 需 vision guard + operator。

## 验证与 review

- operator journey 的 Hub ingress/WS/SSE/replay 属 W7a/F016c，独立验收；F018
  只验收 daemon/CLI 与内部 service E2E。

- 每阶段按 TDD：先 RED，再 GREEN；真实 provider E2E 不拿 handler 测试冒充。
- 契约/数据/auth 面按 SOP 选一个非作者 reviewer；架构 0005 需 review 覆盖最终
  digest。
- 合并前 `check:doc-index`、受影响测试、`git diff --check`。
- R1/R2 必须有 attempt 台账测试：同身份不同 `startedAt` replay、retry 追加 attempt 不改旧行、
  successful target 不重跑、queue entry 在 terminal 前后保留/删除。
- R1/R2 必须有单写者测试：生产代码不存在 `settleAgentTurn`；attempt 只有
  `delivery_state`；T1 只写 child/credential/projection，T2 只写 R/draft，T3 只写
  parent/queue，T4 只修 R；handled-vs-child-running、child-completed-vs-attempt-failed
  双状态负例；T1/T2、T2/T3 崩溃窗口可恢复。
- R1/R2 必须有 durable stream 测试：processing R 原子创建、delta 只写 draft、T1 把
  attempt `delivery_state` 投影 + settlement 标 pending、T2 提交 R terminal 并清 pending、
  crash 后 reconciler 恢复。
- R1/R2 必须有 recovery 测试：`interruptRunningBefore` 收敛 running TurnExecution，
  attempt/settlement 同步收敛；`clearResponsePending` 是 attempt settlement 投影。
- R1/R2 必须有 userId invariant 测试：Thread/Session/InvocationRecord/TurnExecution/
  Credential 的 owner 链一致；InvocationAttempt/StoredMessage/AgentReadState/
  response_drafts 不存 userId，冲突的调用方 userId fail closed。
- R1/R2 必须有 delivery cursor 测试：`loadHistory` 不 ack；child terminal 事务内
  且 `promptDelivered=true` 才 ack；worker_capacity/spawn 前失败不 ack；prompt 后
  failed/canceled 仍 ack；reset 的 cursor rewind 与 pi binding clear 同事务。

## Phase A 遗留问题（2026-11-10 梳理；2026-11-11 终审）

| # | 问题 | 设计状态 | 剩余动作 |
|---|---|---|---|
| 3 | AgentSessionManager / AgentReadStateStore 接口 | **已收口**：0010 §6.1 完整签名 + history/worker 协作时序 + ack 事务边界；reset 顺序已定 | R1 按接口实现 |
| 4 | interruptRunningBefore / reaper bulk API | **已收口**：store 有 startup-only `interruptRunningBefore`；runtime reaper 用 `listRunning + worker liveness`，不提供通用 bulk | R2 实现 reaper |
| 5 | live stream transport / UI draft | **方向已定**：control socket event channel；100ms/4KB 为 provisional（R2 benchmark 后可能调 250–500ms）；`AgentStreamEvent.seq` 合并；刷新从 processing R + draft 恢复 | R2 实现 transport/UI + benchmark |
| 6 | durable partial response | **已收口**：DP-F018X-2=B；processing R + response_drafts + attempt settlement | R2 实现 |
| 7 | delivery_failure reason taxonomy | **已收口**：pre-admission typed reject 与 admitted prestart `delivery_failure` 分离；E6/E8/E10/E11 映射已写 | R2/R3 实现并补负例 |
| 8 | MessageStore migration unknowns | **契约已收口**：legacy→new mapping/preflight 表已写 | R1 执行 preflight，unknown 进清单 |
| 9 | queue trace 完整 payload audit | **v1 决策**：不建 dispatch_events/queue_retirement_audit；attempt.queueEntryId + queue_admissions + dispatchRefs 足够 | 若未来要 forensic replay/queue 压缩，v2 再加 |
| 10 | WorkerPool reaper/capacity | **契约已收口**：capacity backoff、单 reaper 循环、warmTtl=0 crash/cleanup 顺序已定 | R2 实现 |
| P0-1 | invokeSingleAgent + settleAgentTurn 拆分 | **已拍 A/A（2026-11-12）**：TurnExecution 单 canonical、attempt 只做投递状态；settlement 拆回 invoke/route/QueueProcessor/recovery 四层 owner，删除 `settleAgentTurn` god-service | R2 按四层 owner 实现；0007 §3.5/§3.6/§3.9/§4.3.1/§5.2.1/§9 已同步 |
| P2 | `extra.kind` 是否保留 | **已删**：`kind` 是 task-first legacy；不迁入 A2A `extra`，legacy 列只读至 R5 drop | 实现时不得重新引入 |
| P3 | Phase A final review（0005/0007） | **设计整合已完成（2026-11-11）**：session/history/worker 与 0005/0007 的一致性终审已收口；operator 暂停外部 review 的前置条件已满足；PR #86 的旧 findings 已应用 | 进入最终 Phase A review；非作者 verdict 覆盖 exact HEAD 后再 merge |

## 回滚

- R1：drop 新列/新表；旧部署 + 旧 schema 快照恢复。
- R2/R3：停 A2A runtime；旧 code delivery 不双写。
- R4/R5：保留 migration down + 数据快照。

[宪宪/deepseek-flash🐾]
