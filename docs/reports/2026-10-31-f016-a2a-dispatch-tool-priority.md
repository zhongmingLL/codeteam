---
title: "F016 A2A Dispatch 全路径/全场景与工具优先级调研"
doc_kind: report
status: draft-for-review
created: 2026-10-31
updated: 2026-10-31
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash), 烁烁 (Kimi K3)]
baseline: "codeteam-work @ d6ec54127"
reference: "clowder-ai @ 5f8965e1e04dd3ac194cba53fa484bbc994d2dcd (read-only local reference)"
feature: "F016 (reserved; scope signoff pending)"
related:
  - "docs/features/F015-a2a-e2e-foundation.md"
  - "docs/plans/0017-a2a-e2e-foundation.md"
  - "docs/reports/2026-10-30-a2a-e2e-foundation.md"
  - "docs/reports/2026-10-30-mcp-vs-extension-tool-necessity.md"
scope: "read-only investigation; docs-only deliverable; no product code changes"
---

# F016 A2A Dispatch 全路径/全场景与工具优先级调研

> operator 要求：A2A foundation 之后不要直接开 13-tool 实现，先把
> **queue 入口 → queue entry → processor dispatch → agent run → A2A tool →
> handoff/custody/wait → terminal/recovery** 的全路径/全场景调研清楚，再据此
> 重排 F016 工具优先级和 E2E 测试计划。
>
> 本文只读；没有改产品代码。结论直接回答：**F016 先实现哪些 tool、哪些
> defer、每条 ingress 需要什么 E2E 证据。**

## 0. 结论先行

1. **codeteam 已有 8 类 queue ingress，但不是每类都有真实 E2E。**
   operator `thread post --to`、backlog dispatch、schedule、deployment wait、
   worker retry、interrupt retry、extension `a2a_send`、extension
   `handoff_create` 都能写出 `queue_entries`；真实 CLI/daemon/worker E2E 目前
   主要覆盖 backlog dispatch 和 extension A2A + cold-boot recovery。
   operator thread post、schedule、deployment wait、interrupt retry 仍停在
   producer/service/queue 测试。
2. **Clowder 真正产生 A2A queue entry 的 MCP tools 只有 3 个：**
   `cat_cafe_post_message`、`cat_cafe_cross_post_message`、
   `cat_cafe_multi_mention`。其余是 read（thread/message/task/custody）、
   wait（`hold_ball` / `get_hold_status` / deployment wait）或 control
   （task/custody offer）。codeteam 已有 `a2a_send` / `handoff_*`，不需要把
   `post_message` / `cross_post` / `multi_mention` 再加成三个新工具。
3. **F016 P0 工具建议：现有 5 个 A2A/custody 工具 + `thread_context`。**
   5 个已经由 F015 交付；`thread_context` 是唯一真正缺的 P0 read tool。
   `message_get`、`handoff_events`、wait 三件套放 P1；`thread_list`、
   `thread_participants`、`task_list` 放 P2/defer。
4. **wait 三件套不是简单 wrapper。** `WaitContractService` 只持久化 wait
   contract；没有 timer/event 的 due 字段、没有 wait wake producer/consumer，
   `WaitStore.consume` 没有生产调用。F016 若要求 wait arm/status/cancel，
   必须同时做一个最小 timer/event wait scheduler，或把 wait 放到 F016b。
   不要把“加三个 tool”当成 wait 完成。
5. **F016 的重点是 ingress × scenario 覆盖，不是重写 custody。**
   P0 E2E 应覆盖：operator thread post、backlog dispatch、schedule、A2A
   multi-target、handoff withdraw/parallel、loop guard、requestId、
   non-holder/execution role、cold-boot retry、cross-thread negative。
   P1 覆盖 deployment wait、interrupt retry、blocked handoff、wait scheduler。
6. **MCP ingress 不进入 F016。** #74 已决定 v1 extension-first；F016 的
   canonical ingress 是 extension tools。未来 MCP 只能作为 sibling adapter
   调用同一 handler/queue，不能另造 queue entry 语义。

## 1. 基线与方法

| 项 | 值 |
|---|---|
| codeteam 基线 | `codeteam-work @ d6ec54127`（F015 close + docs feature index 之后） |
| Clowder 参考 | `clowder-ai @ 5f8965e1e04dd3ac194cba53fa484bbc994d2dcd`；只读，不引入运行依赖 |
| F015 已交付 | 5 个 A2A/custody extension tools、真实 CLI/daemon/worker E2E、cold-boot recovery |
| F016 当前含义 | `BACKLOG.md` 仍把 F016 预留为 W7a headless API；本轮研究是 F016 的 A2A 工具/测试输入，feature doc + plan 0018 仍需按 AGENTS.md 在实现前建立 |
| 调研范围 | dispatch/A2A 路径与 A2A 相关工具；memory/eval/IM/Console 不展开 |
| 交付 | docs report + tool priority table + E2E scenario matrix；无产品代码 |

方法：

- 读 codeteam 的 queue/dispatch/worker/A2A/custody/wait 代码与 F015 测试；
- 读 Clowder 的 MCP tool schema、route、queue ledger、QueueProcessor、
  AgentRouter、action successor、hold_ball/custody event 代码；
- 用现有测试名和真实 E2E 文件区分 `real RPC` / `in-process` / `service/unit`
  / `missing`，不把 handler 测试冒充 E2E。

## 2. codeteam 全路径

### 2.1 一张图

```text
Ingress
  ├─ operator `thread post --to` (CLI)            -> message(taskId) + queue(conversation_input)
  ├─ backlog dispatch (CLI/store)                 -> thread + task + kickoff + queue(backlog_dispatch)
  ├─ schedule tick/materialize                    -> message(taskId) + queue(message_wake, proactive_schedule)
  ├─ deployment wait match                        -> message(taskId) + queue(message_wake, deployment_wait)
  ├─ worker retry / cold-boot recovery            -> message(taskId) + queue(message_wake, worker_retry)
  ├─ interrupt retry                             -> message(taskId) + queue(message_wake, interrupt_retry)
  ├─ extension a2a_send                          -> message(taskId) + queue(message_wake, a2a)
  ├─ extension handoff_create                    -> handoff + message(control_ref) + queue(message_wake, a2a_handoff)
  ├─ MCP tool                                    -> not in v1 (#74); future sibling adapter only
  └─ cross-thread message                        -> not supported; same-thread validation
        │
        ▼
QueueStore (one pending-wake ledger)
  id = queue:<sourceId>; targets[]; authorIntent; priority/order
        │
        ▼
DispatchService.drain
  claim -> cutoverQueueEntry -> resolveRoute -> create Run + response bubble
  routeParallel (multi-target) / per-hop serial (single target)
        │
        ▼
RpcAgentExecutor -> real pi --mode rpc worker
  worker extension -> 0600 control socket `a2a_call`
  -> resolveInvocationToken -> run/session/worker -> resolveRunPrincipal
  -> A2AToolHandlers (a2a_send / handoff_* / future read/wait)
        │
        ▼
Handoff / custody_events / waits
  server-owned resolver: candidate -> verified -> consumed / parallel_unfinished
        │
        ▼
Run terminal -> response bubble final body -> dispatchRefs settled
  retry/crash/restart -> interrupted -> retry queue -> new run
```

### 2.2 Ingress 事实表

| # | Ingress | Producer / code | sourceKind / category | taskId | Current evidence | Gap |
|---:|---|---|---|---|---|---|
| 1 | operator `thread post --to` | `cli/thread.ts:82`; queue at `:136` | `conversation_input` / `operator_chat` | required via `--task`; validates worktree/session | `cli-producer-binding.test.ts` producer binding + typed failure | no real RPC drain from this producer |
| 2 | backlog dispatch | `control/store.ts:158`; queue at `:260` | `backlog_dispatch` / `backlog_dispatch` | atomic task creation | `daemon-a2a-e2e.test.ts` real CLI/daemon/worker | not prepared -> defer covered; multi-target not real |
| 3 | schedule tick/materialize | `scheduling/schedule.ts:170` / `:211`; queue at `:252` | `message_wake` / `proactive_schedule:<factory>` | spec.taskId | `control-schedule.test.ts` queue materialization | no dispatch/worker E2E |
| 4 | deployment wait match | `deployment-wait/service.ts:201` | `message_wake` / `deployment_wait` | task.id | `control-deployment-wait.test.ts` service only | no dispatch/worker E2E |
| 5 | worker retry | `workers/failure-policy.ts:90` | `message_wake` / `worker_retry` | run.taskId | `control-worker-executor.test.ts` fake RPC; `daemon-a2a-e2e` cold boot real | live retry path not real RPC |
| 6 | interrupt retry | `dispatch/service.ts:155`; queue at `:171` | `message_wake` / `interrupt_retry` | run.taskId | `control-dispatch.test.ts` in-process | no real RPC interrupt/retry |
| 7 | extension `a2a_send` | `a2a/tools.ts:213`; queue at `:244` | `message_wake` / `a2a` | principal.taskId | `control-a2a-worker-e2e`, `daemon-a2a-e2e` real | multi-target real RPC gap |
| 8 | extension `handoff_create` | `a2a/tools.ts:297`; queue at `:463` | `message_wake` / `a2a_handoff` | principal.taskId | `daemon-a2a-e2e` real single handoff | parallel/withdraw/blocked real RPC gaps |
| 9 | MCP tool | not implemented | — | — | #74 decision: v1 extension-first | not F016 |
| 10 | cross-thread message | no tool; A2A handlers reject cross-thread | — | — | `control-a2a-tools` negative | v1 unsupported; separate decision |

**关键结论：** ingress 不是只有 extension tool。F016 若只测
`a2a_send`/`handoff_*`，会漏掉 operator thread post、schedule、deployment
wait、retry/interrupt 这些 producer；但它们最终都必须落到同一条
`queue_entries` → `DispatchService` → worker 链。

### 2.3 Queue → dispatch → run 的现有语义

| 阶段 | 代码 | 语义 | 当前风险/缺口 |
|---|---|---|---|
| admission | `control/stores/queue.ts:117` | 一条 source 一条 entry；`id=queue:<sourceId>`；targets 去重；authorIntent 校验 | 重复 source 返回 existing；不新建第二队列 |
| claim | `queue.ts:198` / `claimNext:176` | 短时 claim；TTL 5min；claim 失败 conflict | 跨进程 producer 无事件通知，daemon 用 poll+dirty |
| cutover | `dispatch/service.ts:311` | 每个 target 原子创建 Run + response bubble；空 targets 删除 entry | route failure 逐 target withdraw，不是整条 dead-letter |
| admission gate | `dispatch/service.ts:407` | worktree 必需；backlog 额外校验 active session | schedule/deployment/retry 的 missing session 会走 route failure/withdraw，可能丢唤醒 |
| route | `dispatch/service.ts:272` | multi-target 恒 parallel；serial 由每跳单 target 结构保证 | 没有 `multi_mention` 聚合/callbackTo |
| execute | `dispatch/service.ts:529` | real worker via `RpcAgentExecutor` | worker crash/retry paths need real RPC E2E |
| settle | `dispatch/settle.ts` | one terminal；response bubble final body；dispatchRefs；release claims；revoke token | duplicate terminal idempotent; non-completed releases handoff claims |
| terminal resolver | `a2a/terminal.ts:71/123/131` | candidate → verify run/review → commit | no production handoff deadline sweep |
| wait | `custody/waits.ts:38` | contract store: arm/terminate/renew/consume | no due time/wake producer; `consume` unused; `terminate` only user_cancel owner check |
| recovery | `daemon-runtime.ts:94` / `workers/runtime.ts` | startup recovery + 30s sweep | cold boot real; periodic sweep of waits/handoffs not wired |

### 2.4 当前测试覆盖 vs 缺口

| 面 | 当前证据 | 覆盖级别 |
|---|---|---|
| producer/task binding | `cli-producer-binding.test.ts` | producer/queue only |
| real CLI/daemon/worker backlog A2A | `daemon-a2a-e2e.test.ts` | real RPC |
| extension 5 tools over socket | `control-a2a-control.test.ts` | real socket + handler |
| extension 5 tools in real worker | `control-a2a-worker-e2e.test.ts` | real RPC |
| handoff semantics | `control-a2a-tools.test.ts` | in-process |
| terminal resolver | `control-handoff-terminal.test.ts` | in-process |
| dispatch/parallel/terminal | `control-dispatch.test.ts` | in-process/fake executor |
| schedule materialization | `control-schedule.test.ts` | queue-only |
| deployment wait | `control-deployment-wait.test.ts` | service/unit |
| retry/crash | `control-worker-executor.test.ts` | fake RPC |
| cold-boot recovery | `daemon-a2a-e2e.test.ts` | real RPC |
| wait contract | `control-custody-wait.test.ts` | service/unit |
| operator thread post real drain | none | **missing** |
| schedule/deployment real drain | none | **missing** |
| parallel/withdraw/blocked real RPC | none | **missing** |
| wait arm/status/cancel E2E | none | **missing** |
| cross-thread A2A | negative handler test | unsupported |

## 3. clowder-ai A2A MCP tools

### 3.1 Clowder 的 A2A 执行链

```text
post_message / cross_post_message / multi_mention
  -> callback route
  -> InvocationQueue.send
  -> QueueLedgerAdmission (one source row, pending targets)
  -> QueueLedgerEntry (Redis; single ledger)
  -> QueueProcessor
     targetDispatchMode = recipients.length > 1 ? 'parallel' : 'serial'
  -> AgentRouter.routeExecution
     -> routeSerial / routeParallel
     -> invokeSingleCat
  -> MessageStore.dispatchRefs + TurnExecution response/terminal
```

关键锚点：

| 阶段 | 路径:行 |
|---|---|
| A2A ingress -> queue | `packages/api/src/routes/callback-a2a-trigger.ts:139` |
| InvocationQueue.send | `packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts:711` |
| ledger admission | `.../queue-ledger/QueueLedgerAdmission.ts:40` |
| queue dispatch mode | `.../invocation/QueueProcessor.ts:5105` |
| routeExecution | `.../routing/AgentRouter.ts:1519` / `:1530` |
| serial route | `.../routing/route-serial.ts:481` |
| parallel route | `.../routing/route-parallel.ts:181` |
| single invocation | `.../invocation/invoke-single-cat.ts:1383` |
| post-message route | `packages/api/src/routes/callbacks.ts:1537` |
| multi-mention route | `packages/api/src/routes/callback-multi-mention-routes.ts:638` |
| multi-mention status | `.../callback-multi-mention-routes.ts:896` |
| action successor admission | `packages/api/src/domains/ball-custody/ActionSuccessorAdmissionService.ts:55` |
| custody events route | `packages/api/src/routes/callback-custody-events-routes.ts:33` |

### 3.2 A2A-related MCP tools（逐项）

> 行号是 `packages/mcp-server/src/tools/callback-tools.ts` 的 tool 定义行
> （Clowder 参考仓 `5f8965e1e`）。输入只列 required；输出是语义/side effect，
> 不是完整 DTO。

| Tool | 定义行 | Required input | 输出 / side effect | Auth | A2A 类 | codeteam F016 处置 |
|---|---:|---|---|---|---|---|
| `cat_cafe_post_message` | 3789 | `content` | message + queue targets + optional action lease；route 返回 messageId/routed/actionLease | callback principal；structured action 要 invocation token；agent-key action 拒绝 | **queue entry + control** | 不新增；由 `a2a_send` + `handoff_create` 承担 |
| `cat_cafe_cross_post_message` | 4032 | `threadId,content` | 跨 thread message + target queue；可带 action/proposedAction | 同上；cross-thread 需 invocation token | **queue entry + control** | 不新增；codeteam v1 不支持跨 thread |
| `cat_cafe_multi_mention` | 4526 | `targets,question,callbackTo` | requestId/status；parallel fan-out；action lease；callbackTo 聚合 | full profile；action 要 idempotencyKey + invocation token | **queue entry + control** | 不新增；多 target 已由 `a2a_send`/`handoff_create` 覆盖 |
| `cat_cafe_hold_ball` | 4893 | `reason,nextStep` | `taskId/held/wakeAt` 或 `wakeWhen`；创建 hold task/reminder | callback principal；command output owner/operator | **wait + control** | 不照搬；codeteam wait contract 另做 |
| `cat_cafe_get_hold_status` | 5022 | — | hold status/cancelable/lifecycle/job/owner | callback principal；owner/operator for job output | **wait read** | P1/P2；F016 wait 若做，需对应 status |
| `cat_cafe_get_custody_events` | 5067 | `sourceMessageId` | custody events（read-only；按 invocation thread） | invocation-only；agent-key 403 | **read** | P1 `handoff_events`/custody read |
| `cat_cafe_get_pending_mentions` | 3828 | — | text mention inbox | callback principal | **read** | 不需要；codeteam typed A2A 无文本 @ inbox |
| `cat_cafe_ack_mentions` | 3844 | `upToMessageId` | mention cursor | callback principal | **control** | 不需要 |
| `cat_cafe_get_thread_context` | 3861 | — | bounded thread messages/anchor/cursor | callback principal | **read** | **P0 `thread_context`** |
| `cat_cafe_get_message` | 3918 | `messageId` | message + context preview/full | callback principal | **read** | P1 `message_get` |
| `cat_cafe_get_thread_cats` | 3958 | — | participants/routableNow | callback principal | **read** | P2 `thread_participants`（prompt 已有 roster） |
| `cat_cafe_list_threads` | 3976 | — | thread summaries | callback principal | **read** | P2；无 cross-thread |
| `cat_cafe_get_running_work` | 4074 | — | active execution projection | callback principal | **read** | operator/Console；不进 F016 |
| `cat_cafe_list_tasks` | 4122 | — | task list | callback principal | **read** | P2 `task_list`（prompt 已有 task） |
| `cat_cafe_update_task` | 4146 | `taskId` | task status/why | callback principal/owner | **control** | 不进 F016 |
| `cat_cafe_create_task` | 4289 | `title` | task DTO | callback principal | **control** | 不进 F016；task/backlog 不属于 A2A dispatch |
| `cat_cafe_offer_custody` | 4243 | `sourceMessageId,reasonCode` | offerId | agent-key/full；source-owned | **control** | 不进 F016；source custody 另 slice |
| `cat_cafe_retry_custody_admission` | 4266 | `sourceMessageId,sourceMessageRevision,offerId,title,intendedOutcome,closure` | admission result | agent-key/full；source-owned | **control** | 不进 F016 |
| `cat_cafe_register_deployment_wait` | 4362 | `taskId,deploymentId,when,nextStep` | wait state; on match queue entry | callback principal | **wait/control** | codeteam 已有 W5c service；P1/F016 外 |

### 3.3 关键语义差异

1. **Clowder 只有 3 个 queue-entry MCP tools**，不是 13 个。`post_message`
   和 `cross_post_message` 是把“消息 + wake + action custody”装在一个
   carrier 里；`multi_mention` 是带 callbackTo 的 fan-out 聚合。codeteam 已经
   明确拆成 `a2a_send`（讨论）+ `handoff_*`（custody），不应再加回
   post/cross/multi 三个入口。
2. **Clowder 的 direct action carrier 很窄。** `post_message`/`cross_post_message`
   的 `action` 直接执行只开放 `implement + implementer + task_done`；review 走
   `localReviewVerdict`，external review 走独立 contract，merge 不走 direct
   action。codeteam 的 `handoff_*` action family 更宽（review/merge/
   investigate/implement/verify/vision_guard），不要为了“像 Clowder”把
   action 字段塞回 `a2a_send`；merge 执行仍只归 daemon service。
3. **Clowder 的 wait 是 hold_ball task/reminder，不是 queue entry。**
   `hold_ball` 创建 task + wake/reminder；`get_hold_status` 读；`wakeWhen` 可
   托管命令。codeteam 的 `WaitContractService` 是 typed contract，但没有
   scheduler/due field。F016 不能把“wait tool”当成读/写 wrapper。
4. **Clowder 的 queue 是 single ledger；multi-target 恒 parallel；serial 来自
   每跳单 target。** codeteam 的 `DispatchService` 已经是同样结构；F016 不要
   新增 queue 或 `multi_mention` 聚合器。
5. **Clowder 的 cross-thread 只解决消息投递，不解决 codeteam task/thread
   授权。** codeteam v1 的 A2A handler 明确同 thread；F016 只做 negative，
   不把 `cross_post_message` 当已支持。

### 3.4 Clowder 参考测试（用于场景矩阵）

| 场景 | Clowder 参考测试 |
|---|---|
| one source one ledger / target fan-out / replay | `packages/api/test/callback-a2a-trigger.test.js`、`queue-ledger.test.js` |
| claim / target removal / terminal | `queue-ledger.test.js`、`redis-queue-ledger-reader.test.js` |
| multi-mention queue dispatch / callbackTo | `multi-mention-b6-queue-dispatch.test.js`、`multi-mention-orchestrator.test.js` |
| action successor lease / safe_wait / recovery | `action-successor-admission-service.test.js`、`action-successor-state-machine.test.js`、`action-successor-recovery-*.test.js` |
| parallel custody | `a2a-parallel-fanout-custody.test.js` |
| serial/deferred custody | `route-serial-deferred-queue-custody.test.js` |
| hold_ball / wait status / cancel | `callback-hold-ball-route.test.js`、`hold-ball-cancel-route.test.js`、`callback-hold-ball-wakewhen.test.js` |
| custody events | `callback-custody-events-route.test.js` |

这些测试证明 Clowder 的参考语义；codeteam 只需选取与自身契约一致的场景，
不复制 action successor/多猫聚合的全部复杂度。

## 4. 映射到 codeteam extension

### 4.1 已交付的 5 个

F015 已交付并通过真实 RPC E2E：

- `a2a_send`：message + queue；requestId；不 custody。
- `handoff_create`：handoff + message + queue；idempotencyKey；loop guard；
  parallelIntent。
- `handoff_claim`：holder claim；non-holder `safe_wait` 且不暴露 handoff。
- `handoff_complete`：candidate only；server resolver 决定 verified。
- `handoff_withdraw`：author only；terminal handoff。

**F016 不重写这 5 个；只补测试和缺口。**

### 4.2 之前计划的 8 个 read/wait 工具逐项判断

| Tool | 真缺？ | F016 优先级 | 理由 |
|---|---:|---|---|
| `thread_list` | 否 | **P2/defer** | agent 在单 task/thread 内运行；跨 thread 未支持；operator/Console 才需要 |
| `thread_context` | **是** | **P0** | reviewer/agent 需要读 source 之前的 thread 上下文；bounded/anchor read；必须按 principal.threadId 过滤 |
| `message_get` | 部分 | **P1** | replyTo/引用上下文有用，但 source message 已在 worker prompt；不是首个 E2E 必需 |
| `thread_participants` | 否 | **P2/defer** | worker prompt 已注入 peers roster；target 由 daemon 校验；不需要 agent 自己发现 |
| `task_list` | 否 | **P2/defer** | worker prompt 已注入 assigned task；多 task/self-service 不是 F016 |
| `wait_arm` | **是（能力）** | **P1（或 operator 要求时 P0）** | wait contract 存在，但无 due/wake 生产链路；不是加一个 tool 就完成 |
| `wait_status` | **是（配套）** | **P1** | 依赖 wait_arm；owner-scoped read |
| `wait_cancel` | **是（配套）** | **P1** | 依赖 wait_arm；必须补 exact owner fence；user_cancel operator-only |

**结论：** 8 个里真正需要进 F016 P0 的只有 `thread_context`。
`message_get`/`handoff_events` 是 P1 便利/诊断；`thread_list`/
`thread_participants`/`task_list` 对 F016 不需要；wait 三件套是 P1 的独立
子系统，除非 operator 明确把 wait 作为 F016 的同一交付。

### 4.3 额外候选

| Candidate | Priority | 理由 |
|---|---|---|
| `handoff_events`（from `get_custody_events`） | P1 | stuck custody 诊断；claim/complete/withdraw 返回值已够首个 E2E |
| `handoff_get` | P1/P2 | 当前 5 个工具返回 handoff；单独 get 不是必需 |
| `artifact_put/get` | P1 | evidenceRef 可用 commit/review/message；artifact 不是 A2A P0 |
| `run_events`/`get_running_work` | P1/operator | Console/active execution 读面，不是 agent A2A |
| `approval_request` | P1/operator surface | 不是 A2A dispatch；approval decide 永不在 agent tool |
| `cross_thread_message` | P2/decision | 需要 thread/task 授权模型；v1 不支持 |
| `multi_mention` aggregation | P2/defer | codeteam multi-target a2a_send 已 fan-out；无 callbackTo 聚合 |
| MCP ingress | P2/defer | #74：无 v1 外部 consumer；未来 sibling adapter |

### 4.4 F016 工具优先级表（建议）

| Priority | Tools | Scope |
|---|---|---|
| **P0** | existing `a2a_send`, `handoff_create`, `handoff_claim`, `handoff_complete`, `handoff_withdraw` + new `thread_context` | 真实 RPC E2E 的 A2A/queue 主链与 thread context |
| **P1** | `message_get`, `handoff_events`, `wait_arm`, `wait_status`, `wait_cancel` + minimal timer/event wait scheduler | 上下文便利、custody 诊断、wait 场景；wait scheduler 是本组真实成本 |
| **P2/defer** | `thread_list`, `thread_participants`, `task_list` | 单 thread/单 task prompt 已覆盖；无需 F016 |
| **Not F016** | `create_task/update_task`, `offer_custody/retry_custody_admission`, `register_deployment_wait`, `get_running_work`, `approval_*`, `artifact_*`, cross-thread, multi_mention aggregation, MCP ingress | 其他 owner/slice 或已由 CLI/Console/HTTP 承担 |

## 5. A2A E2E 场景矩阵

> 状态口径：`real RPC` = 真实 pi RPC + mock provider；`in-process` = dispatch/
> handler 测试；`service/unit` = store/service 测试；`missing` = 没有覆盖。
> 负路径必须包含 authz、幂等、crash/restart、parallel、cross-thread。

### 5.1 Ingress / queue

| ID | Setup | Assert | Negative | Current | F016 |
|---|---|---|---|---|---|
| I1 operator thread post | task prepare + 2 sessions; `thread post --to` | source message taskId; one queue; run(s); response bubble | missing `--task`, no worktree, no session -> typed failure; no queue | producer only | **P0** |
| I2 operator multi-target | same thread, 2 targets | one queue entry, 2 runs parallel, 2 response bubbles | one disabled/missing session | in-process | **P0** |
| I3 backlog dispatch | backlog approve + dispatch + prepare | thread/task/kickoff/queue; real worker | not prepared -> defer, no dead-letter | **real RPC** | **P0 keep** |
| I4 schedule timer | schedule spec + tick | tick only queue; drain -> real worker; priority/category; no direct run at tick | paused/unready/unknown factory/duplicate/catch-up | queue-only | **P0** |
| I5 deployment wait | register wait; observer match | match creates queue; drain -> real worker; one delivery | pending/cancel/conflict/re-arm | service only | **P1** |
| I6 worker retry | crash/interrupted run | interrupted -> retry queue -> real worker; attempt+1 | max attempts -> dead-letter; no duplicate retry | fake RPC + cold boot real | **P0** |
| I7 interrupt retry | live run interrupt | canceled + new queue + real retry | duplicate interrupt; stale run | in-process | **P1** |
| I8 missing session on system ingress | schedule/deployment/retry target without session | typed defer/withdraw; no silent loss | no dead-letter without audit | missing | **P1** |
| I9 MCP ingress | no MCP server in v1 | no `mcp__*` tool; extension only | direct MCP call unavailable | missing by design | **not F016** |
| I10 cross-thread | target profile in another thread/task | typed reject; no queue/run | task scope mismatch | negative unit | **P0 negative** |

### 5.2 A2A / handoff

| ID | Setup | Assert | Negative | Current | F016 |
|---|---|---|---|---|---|
| A1 `a2a_send` single | coder -> reviewer | message + queue + run; visible marker | disabled/cross-thread target | **real RPC** | **P0 keep** |
| A2 `a2a_send` multi-target | coder -> 2 reviewers | one queue entry; 2 runs parallel; 2 bubbles | duplicate target; depth limit | in-process | **P0** |
| A3 requestId replay/conflict | same requestId same/different intent | replay returns same message/queue; conflict no second side effect | concurrent replay | unit/socket | **P0** |
| A4 depth limit | chain > 32 | `a2a_depth_exceeded`; no queue | bypass via text @ | unit | **P1** |
| A5 handoff single claim/complete | coder -> reviewer; reviewer claim/complete | candidate -> run terminal -> resolver consumed | non-holder; wrong run; missing evidence | **real RPC** | **P0 keep** |
| A6 withdraw | author withdraws pending/claimed | handoff withdrawn; custody event; no author bypass | non-author; terminal | unit | **P0** (define queue cleanup) |
| A7 parallel handoff | 2 holders; both complete | all verified -> consumed; response/bubbles | one missing -> parallel_unfinished; one failed | unit | **P0** |
| A8 blocked handoff | blocker with completes/bounces | projection owner/onResolve; no self-verify | missing blockedOnResolve | unit | **P1** |
| A9 loop guard | second live canonical action | `loop_guard_live_handoff`; no second handoff | replay same idempotencyKey returns existing | unit | **P0** |
| A10 execution role | profile primary role != session role | direction uses run.role; no profile-role leak | mismatched run/session | unit | **P0** |
| A11 handoff expiry | deadline passes | explicit expire -> terminal; wait not adjudicating | no production sweep | missing | **P1** (scope decision) |

### 5.3 Wait

| ID | Setup | Assert | Negative | Current | F016 |
|---|---|---|---|---|---|
| W1 timer/event arm | arm wait + due/event | wait active; after due/event -> wake queue -> real worker | no source/SLA/signal/fence -> invalid | service/unit | **P1** (needs scheduler) |
| W2 status | arm then read | owner-scoped wait state | cross-owner read | missing tool | **P1** |
| W3 cancel | owner cancel; user_cancel | wait terminated; no run | non-owner cancel; user_cancel by agent | service/unit | **P1** (owner fence fix) |
| W4 managed command | wakeWhen command | bounded command + wake | policy/escape | unit | **P1/P2** |
| W5 wait vs handoff expiry | handoff deadline + wait | wait never adjudicates handoff expiry | wait expiry not handoff terminal | unit | **P1** |

### 5.4 Terminal / recovery / control

| ID | Setup | Assert | Negative | Current | F016 |
|---|---|---|---|---|---|
| T1 one response bubble | one target | exactly one response message; final body in place | duplicate terminal | **real RPC** | **P0 keep** |
| T2 duplicate terminal | settle twice | committed result; no second event/dispatchRef | invalid state | in-process | **P0** |
| T3 poison target | bad target + good target | good target still runs; bad target withdrawn + audit | whole entry dead-letter starvation | in-process | **P0** |
| T4 cold boot | running run at daemon stop | interrupted + retry queue + real worker completes | duplicate retry | **real RPC** | **P0 keep** |
| T5 queue cancel | queued target withdraw | no drain; audit; other targets preserved | claimed cancel without fence | in-process | **P0** |
| T6 stale claim/recovery | expired claim | release/reclaim; no double run | duplicate delivery | partial | **P1** |

### 5.5 场景矩阵到 F016 测试文件

建议拆成三个 real RPC 文件 + 两个 in-process 文件：

- `daemon-a2a-ingress-e2e.test.ts`：I1/I2/I4/I6/I10（operator、schedule、
  retry、cross-thread negative）。
- `daemon-a2a-parallel-e2e.test.ts`：A2/A5/A6/A7/A9（multi-target、parallel、
  withdraw、loop guard）。
- `daemon-a2a-wait-e2e.test.ts`：W1/W2/W3（仅当 wait 进 F016；否则 F016b）。
- `control-a2a-read-tools.test.ts`：`thread_context`/`message_get` scope、
  pagination、cross-thread negative。
- `control-a2a-errors.test.ts`：authz/idempotency/terminal/dead-letter typed
  error matrix；可复用现有 fixture。

## 6. F016 实现切片建议

> F016 feature doc + plan 0018 尚未建立；`BACKLOG.md:31` 仍把 F016 写成
> W7a headless API。按 AGENTS.md，S1 前必须先更新 F016 feature doc、BACKLOG
> 行和 plan 0018；本文只提供输入，不直接改 F016 编号/范围。

### S1：queue ingress 覆盖（P0）

- I1 operator thread post -> real RPC.
- I2 operator multi-target -> one queue/parallel runs.
- I3 backlog dispatch keep.
- I4 schedule tick -> queue -> real RPC.
- I6 worker retry/cold boot keep/expand.
- I10 cross-thread negative.
- I8 missing session on system ingress -> define typed behavior.

### S2：A2A/custody 语义（P0）

- A2 multi-target real RPC.
- A5 claim/complete keep.
- A6 withdraw + queue cleanup decision.
- A7 parallel handoff real RPC.
- A9 loop guard + A3 requestId.
- A10 execution role.
- T1/T2/T3 terminal/dead-letter/poison.

### S3：read tools（P0/P1）

- P0 `thread_context`: bounded/anchor, current thread only, `hasMore`/cursor.
- P1 `message_get`: replyTo/context; thread access check.
- P1 `handoff_events`: custody read; no write.
- P2 `thread_list`/`thread_participants`/`task_list`: defer; prompt roster/task
  and no cross-thread v1.

### S4：wait（P1 unless operator promotes）

- Add `wait_arm/status/cancel` extension specs + `wait_call` control route.
- Add a minimal timer/event wait scheduler with a due field (current contract
  has no `wakeAt`); owner fence derived from principal, not tool args.
- Fix `WaitContractService.terminate` to enforce exact owner for all
  non-operator reasons; `user_cancel` remains operator-only.
- Keep managed command wait P1/P2; don't turn `wait_arm` into shell_exec.

### S5：F016 error/auth matrix

- `thread_context`/`message_get` thread scope.
- `a2a_send`/handoff args no `from/role/owner`.
- `handoff_withdraw` author-only; `handoff_claim` non-holder safe_wait.
- `wait_cancel` non-owner forbidden.
- cross-thread negative.
- `a2a_depth_exceeded`, `loop_guard_live_handoff`, `conflict`,
  `invalid_state`, `forbidden`, daemon down fail-closed.
- audit/tool_usage for every mutating tool.

## 7. 风险与未决问题

| 风险/问题 | 处置 |
|---|---|
| wait 没有 scheduler/due 字段 | F016 若含 wait，需新增最小 timer/event scheduler；否则 wait 归 F016b，不假装三工具即可 |
| handoff withdraw 不清理 queue entry | F016 定义：holder run 仍执行并 claim 得到 terminal_handoff，还是 withdraw 时取消 pending queue；二选一并测试 |
| handoff deadline 无生产 expiry sweep | F016 P1/P2；先显式 expire 测试，不宣称自动过期 |
| system ingress missing session 可能丢唤醒 | F016 I8 定义 typed defer/withdraw + audit；不要静默 dead-letter |
| parallel handoff 全 holder 收口 | 当前 resolver 等所有 verified；失败 holder 写 parallel_unfinished；real RPC 补测 |
| cross-thread 未支持 | F016 只做 negative；支持另开 decision |
| multi_mention 聚合/callbackTo | 不在 F016；codeteam multi-target a2a_send 已覆盖 fan-out |
| MCP ingress | #74 已 defer；F016 不实现 MCP server |
| F016 编号冲突 | `BACKLOG.md` F016 仍是 W7a headless；S1 前按 AGENTS.md 更新 feature/plan/backlog |

### 7.1 需要拍板

| 问题 | 建议默认 | 影响 |
|---|---|---|
| wait 三件套是否进 F016 | **P1/独立 F016b**；若 operator 要求同一交付，则升 P0 | 需要最小 timer/event scheduler + owner fence；不是三工具增量 |
| handoff withdraw 是否取消 pending queue | **取消 pending targets + audit**；已 claimed holder 仍可收到 terminal_handoff | 决定 A6 断言与 queue cleanup 实现 |
| cross-thread A2A 是否 v1 | **不支持**；只做 negative | 需要 thread/task 授权模型，另开 decision |
| F016 feature doc/plan 0018/backlog | **S1 前由 owner 建** | AGENTS.md 要求 feature doc + BACKLOG row before implementation |
| MCP ingress | **不进 F016** | #74 已决定 extension-first；未来 sibling adapter |

## 8. 证据索引

| 主题 | 路径 |
|---|---|
| F015 plan / report / feature | `docs/plans/0017-a2a-e2e-foundation.md`、`docs/reports/2026-10-30-a2a-e2e-foundation.md`、`docs/features/F015-a2a-e2e-foundation.md` |
| MCP v1 extension-first 决策 | `docs/reports/2026-10-30-mcp-vs-extension-tool-necessity.md` |
| queue store | `packages/codeteam-daemon/src/control/stores/queue.ts:117`（admit）、`:198`（claim）、`:246`（withdraw） |
| dispatch | `packages/codeteam-daemon/src/dispatch/service.ts:135`（drain）、`:311`（cutover）、`:407`（admission）、`:529`（execute） |
| A2A handlers | `packages/codeteam-daemon/src/a2a/tools.ts:213`（send）、`:297`（create）、`:503`（claim）、`:530`（complete）、`:540`（withdraw） |
| terminal resolver | `packages/codeteam-daemon/src/a2a/terminal.ts:71/123/131` |
| requestId | `packages/codeteam-daemon/src/a2a/requests.ts:81` |
| worker control | `packages/codeteam-daemon/src/workers/control.ts:199/219/245` |
| extension tools | `packages/codeteam-daemon/src/workers/worker-extension.ts:238`、`:114`（a2aCall） |
| `--no-mcp` | `packages/codeteam-daemon/src/workers/harness.ts:298` |
| daemon composition | `packages/codeteam-daemon/src/daemon-runtime.ts:94/95/181` |
| schedule ingress | `packages/codeteam-daemon/src/scheduling/schedule.ts:170/211/252` |
| deployment wait ingress | `packages/codeteam-daemon/src/deployment-wait/service.ts:201` |
| worker retry ingress | `packages/codeteam-daemon/src/workers/failure-policy.ts:90` |
| operator thread post ingress | `packages/codeteam-daemon/src/cli/thread.ts:82/136` |
| backlog ingress | `packages/codeteam-daemon/src/control/store.ts:158/260` |
| worker prompt | `packages/codeteam-daemon/src/workers/prompt.ts:38/49/64` |
| Clowder A2A tools | `packages/mcp-server/src/tools/callback-tools.ts:3789/4032/4526/4893/5022/5067`（及同文件其它行） |
| Clowder queue chain | `packages/api/src/routes/callback-a2a-trigger.ts:139`、`.../InvocationQueue.ts:711`、`.../QueueProcessor.ts:5105`、`.../AgentRouter.ts:1519/1530`、`.../route-serial.ts:481`、`.../route-parallel.ts:181`、`.../invoke-single-cat.ts:1383` |
| Clowder queue tests | `packages/api/test/callback-a2a-trigger.test.js`、`queue-ledger.test.js`、`multi-mention-b6-queue-dispatch.test.js`、`action-successor-*.test.js` |

## 9. 一句话

**F016 不应再“加 13 个工具”；它应先把 8 类 ingress 接到同一条 queue/dispatch
链上跑真实 RPC E2E，P0 只补 `thread_context`，把 `message_get`/custody read/
wait 放 P1，把 `thread_list`/`thread_participants`/`task_list` 和 cross-thread/
MCP 放 P2。wait 三件套必须连同最小 scheduler 一起评估，不能当成三个薄 wrapper。**
