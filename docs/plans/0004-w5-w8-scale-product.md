---
title: "W5–W8 扩展与产品计划：调度、记忆、Console、GitHub"
doc_kind: plan
status: reviewed
created: 2026-10-21
updated: 2026-10-31
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 墨墨 (Qwen 3.8 Flash), 砚砚 (GLM 5.3 Flash)]
---

# W5–W8 扩展与产品计划

> 覆盖：W5 多 task/RPC、W6 memory/eval、W7 Console/interface、W8 Forge connector。
> 前提：W0–W4 已通过验收；真实 repo 已具备权限/沙箱边界。

---

## W5. 多 Task 调度与 RPC worker 化

### Goal

从单 task 扩到多 task，同时把 SDK→RPC worker 的运行时语义定清楚；不引入分布式复杂度。调度分三层：ADR-043/F117 dispatch queue、F139 proactive schedule、codeteam task readiness；A2A 投递与球权复用 clowder 已验证语义，codeteam 只加 role/session/worktree 适配。

### 复用 clowder A2A 投递内核（P0）

- 保留 clowder 的三对象：Queue Entry / Chat History Message / Active Run，以及 **A2A 灵魂链**：A2A ingress → QueueProcessor → AgentRouter → routeSerial/routeParallel → invokeSingleCat → AgentMessage/response/terminal。
- 一条输入只产生一个 response bubble；one terminal per run；completed/failed/canceled 都原地收口。
- event-driven drain + dirty-bit；不引入隐藏优先级或第二套调度器。
- 保留显式用户控制：guide / interrupt / cancel / stop。
- codeteam 只把 target 从 cat 换成 AgentProfile/AgentSession，并绑定 task/backlog item/worktree；SOP 用 `WorkflowSop`；不新造消息层。

#### 三对象映射（agent / operator 双 lane）

| clowder | codeteam agent lane | codeteam operator lane |
|---|---|---|
| Queue Entry | ADR-043/F117 Queue Entry（`sourceKind=agent`；`handoff` 是 payload/control） | ADR-043/F117 Queue Entry（`sourceKind=operator`；`inbox` 是 admission view） |
| Chat History Message | `Message`（A2A 讨论 + handoff 外壳；`control_ref` 指向 typed handoff）；terminal artifact + run_events 仍是执行真相 | `Message`（operator 输入 + agent 回复镜像） |
| Active Run | `Run`（durable 超集） | 同一 Run 的只读投影 |
| response bubble | run terminal + thread_events/Message 投影 | 对应 `Message` 气泡 |

控制映射：guide → 存活 run 的 steer/follow_up；interrupt → RPC abort + 新 run；cancel queued → 未 claim Queue Entry target → `withdrawn`；stop → worker stop + run `canceled`。

#### A2A tool surface（tool-call-first，已拍板 A）

- 核心工具固定为 `a2a_send`（讨论）与 `handoff_create`（责任转移）；claim/complete/withdraw 走 `handoff_*`。
- target 只从 tool 参数来；正文 `@` 无路由权威；daemon 不解析自然语言。
- `a2a_send` 成功写 `messages`；`handoff_create` 成功写 `handoffs` + `custody_events` + 可见 `Message` 外壳，并回填 `control_ref`。
- 投递后 daemon 在消息上补 `→ @target` 可见标记。
- 漏调 tool 只记 `missing_a2a_tool_call`，不自动路由；弱模型回一次 schema 纠错提示，provider tool-call 成功率进 eval。
- 同进程 extension 与跨 provider MCP 命中同一 daemon API；`from` 身份从 per-run token 派生。

### Ball custody 与等待契约（P0）

- 已拍板：`DP-A3-1-1/2/3=A/A/A`（parallel 首个 verified success 立即 consumed；`impl` 走普通 handoff、`review` 走 action custody；operator 行首 @ 由 ingress 解析成 typed inbox）。
- `Handoff` 是 A2A 落地实现；概念沿用 Ball custody（holder、接/退/升、hold/wake）。
- `custody_events` append-only；不引入新的“球 ID”，投影从事件和引用推导。
- `custody_events.kind ∈ handoff.created|handoff.dispatched|handoff.claimed|handoff.returned|handoff.replaced|handoff.completion_candidate|handoff.completed|handoff.parallel_unfinished|handoff.withdrawn|handoff.expired|handoff.recovered`；append-only trigger 与 audit 同级；不并存旧 steer/hold/wake 枚举。
- `handoff` claim 是 per-holder：single mode 一个 claim；parallel 每 holder 一条 `handoff_holder_claims`；`claimed_by_run_id` 只做 single summary。
- `blocked` 必须声明 on-resolve 语义：`completes` 或 `bounces-back-to-owner`。
- 等待契约复用 clowder F280：`kind ∈ timer|event|managed_command`；必须带 `wait_source_ref` + `expected_signal` + SLA；缺证据 fail closed。
- `waits` 按 `(wait_id,generation)` 一行；canonical 终止事件在 `wait_terminations`；`waits` 只驱动唤醒；过期裁决只看 handoff explicit deadline，claim lease stale 只触发 run interrupted recovery，避免双计时器冲突。
- P1：乒乓、虚空传球、死球/睡美人检测；P2：值班简报/球权 concierge，不进 MVP。

### 调度层：ADR-043/F117 dispatch queue + A2A 执行链 + F139 schedule + codeteam readiness

三层，不合并：

| 层 | 复用 | codeteam 只做 |
|---|---|---|
| Dispatch queue | ADR-043 / F117 Phase D（F122 历史）：Queue Entry、`targets[]`、`dispatchRefs`、response bubble、Active Run、steer、one terminal | 把 operator/agent/connector 都映射为 Queue Entry；`handoff`/`inbox` 是来源，不是队列 |
| Task readiness / admission | 无直接 clowder 对应 | priority、dependency DAG、budget/quota、worktree pool、worker capacity；决定哪条 task 可以 enqueue/claim |
| Proactive schedule | F139 `TaskSpec_P1` + `RunLedger` | 代码域 TaskSpec adapter（CI 轮询、stale 清理、repo scan）；触发后生成 Queue Entry |

规则：

- 唯一 pending-wake 真相 = Queue Entry；不建第二队列。
- 唯一 drain/comparator = ADR-043/F117 dispatch queue；priority/DAG 只决定 admission 顺序，不另起 poller。
- F139 只用于主动 schedule，不替代即时 task dispatch。
- 现行语义以 ADR-043 + F117 Phase D 的 single-ledger 为准；F122 旧文档的 per-target 拆行 / steer 预留是历史。
- 单 task 单写者：worktree lock + queue claim；worker lease 属 W5 worker registry，不另建平行 lease 表。

### RPC worker 三语义

1. **per-run tool policy**
   - role-per-worker 固定 extension 白名单。
   - `tool_call` hook 用 run token 向 control plane 查询当前 lane/risk policy。
   - 禁止“所有 worker 全量工具、只靠 prompt 约束”。
   - control plane 不可用时 fail-closed：deny 所有非只读工具；只读工具按本地 allowlist 继续。

2. **session 亲和**
   - coder 持久 session 必须 sticky 到同一 worker。
   - scheduler 不能把同一 `agentSessionId` 的后续 run 派到另一个 worker。
   - 必须迁移时，优先用 pi session export/import；若 W0 验证不支持跨进程迁移，则迁移策略固定为 fresh session + task capsule，sticky 作为硬约束。

3. **re-attach**
   - daemon 重启后按 `agentSessionId` 找回 `piSessionId`，向对应 worker 重挂。
   - 失败显式降级为 fresh session + task capsule 重注入。
   - 记录 `session_reattach_failed`，不能静默失忆。

### Worker liveness

- worker 心跳间隔、lease 时长写进 registry 配置并记录实际值；默认心跳 10s、lease 30s。
- stale worker 判定后：其 claimed runs → `interrupted`；sessions 标 `re_attach_pending`；不再接受新的 sticky 分配。
- sticky routing 必须先检查 liveness；死 worker 永远不能被选中，避免活锁。
- 优雅 drain：停止接新 run，完成 active run 后退役；超过 lease 强制退役并记录。

### Tasks

1. **ADR-043/F117 dispatch queue + A2A 灵魂链适配**：Queue Entry / response bubble / Active Run、one terminal、event-driven drain、guide/interrupt/cancel/stop；`AgentRouter`/`routeSerial`/`routeParallel` 复用，`invokeSingleCat` 换 `invokeSingleAgent → pi kernel`；`handoff`/`inbox` 作为 source，不另建队列。
2. **A2A tool surface**：`a2a_send` / `handoff_create` / `handoff_*`，target 校验、`control_ref` 回填、可见路由标记、`missing_a2a_tool_call` 观测。
3. **Ball custody + wait contract**：custody_events、blocked on-resolve 两态、timer/event/command wait + `wait_source_ref` + `expected_signal` + SLA。
4. **RPC worker harness**：`pi --mode rpc` 启动包装、extension 装配、per-run token 0600 注入、stdout JSONL 分帧、事件回流 run_events、优雅关停。
5. Task readiness/admission：priority + dependency DAG + budget/worktree capacity；只决定哪条 task 可 enqueue/claim，不另建执行队列。
6. budget/quota enforcement。
7. worktree pool、disk quota、artifact GC。
8. worker registry：workerId、role、capacity、active sessions、heartbeat/lease。
9. sticky routing：agentSessionId → workerId。
10. re-attach protocol：resume / fresh + capsule。
11. 失败重试、dead-letter、human escalation。
12. F139 proactive schedule adapter：`TaskSpec_P1`（Trigger/Admission/Run/State/Outcome）+ RunLedger；触发后生成 Queue Entry。
13. 测试：single Queue Entry、ADR-043/F117 terminal/控制操作、custody replay、wait fail-closed、F139 trigger→Queue Entry、并发、依赖、预算、crash（daemon/worker）、stale worker、re-attach、同 worker 多 run 身份隔离、managed retry bind-once。
14. **daemon 完整生命周期链**：StopOperationRecord 六态、operator 签名授权、frozen identity/executor independence、health 复验、boot history/exit 证据；不建第二 supervisor。
15. **deployment wait 消费**：原 Task 的 F280 `deployment_wait_json`（`autoRenew:false`，TTL=0）、`revision_included`/`new_ready_boot`、bootSequence 基线、单个 recovery sweep、start guard、经 `queue_entries` 投递；不建第二等待表。
16. **task_managed_work_bindings**：`pr_tracking` task create 同事务写 private binding；same idempotent / missing no-op / different 409；FK cascade；不写 task 公共列。
17. **PR lifecycle / TaskOutcome refs**：merge/revert evidence 按 live `pr_tracking` task 读 binding；missing → `managed_unattributed`；review/verify run 不绑 attempt 1。
18. **managed-work sticky retry（DP-A2-2-1=A）**：重试 run 先读 `run_managed_work_bindings` / attempt 1 已绑 `executor_profile_id`；已绑 → 只选同 profile；未绑 → 正常选择并 bind；managed run 换 profile 重试 → 409 / 消费 target + operator blocker；model fallback 仅对非 managed/Phase C。

### Deliverables

- A2A 投递内核适配（不新造消息层）。
- A2A tool surface（`a2a_send` / `handoff_create` / `handoff_*`）+ 路由审计。
- ball custody event log + wait contract。
- RPC worker harness（启动/装配/token/JSONL/事件/关停）。
- ADR-043/F117 dispatch queue adapter + task readiness/DAG + F139 schedule adapter。
- worker registry + sticky routing + heartbeat/lease。
- re-attach protocol + events。
- 并发/预算/crash（daemon/worker）测试报告。
- daemon 完整生命周期链证据（操作记录、授权签名、复验）。
- deployment wait 登记/恢复/投递/start guard 测试证据。

### Acceptance

- [ ] 两个独立 task 并发不互相污染。
- [ ] 只有一个 pending-wake Queue Entry 账本；`handoff`/`inbox` 是 source，不存在第二队列。
- [ ] F139 scheduled task 触发后生成 Queue Entry，不直接起 run；不存在第二个 cron poller/drain。
- [ ] A2A one terminal / 原地 response bubble / event-driven drain / guide-interrupt-cancel-stop 语义保留。
- [ ] A2A 灵魂链完整：queue 多 recipient 恒 parallel；`ideate` 只作直调兜底；`routeSerial/routeParallel` 的 A2A chain/worklist/乒乓球不复写。
- [ ] `runs.chain_metadata_json` 持久化 A2A 深度；`runs` partial unique index 兜底 `(source_id, recipient_profile_id)` 单 running run。
- [ ] 责任转移只能由 `handoff_create` / `handoff_*` 发起；正文写“请 reviewer 看”不会产生投递，只记 `missing_a2a_tool_call`。
- [ ] `a2a_send` 不会改变 custody；`control_ref` 只由 daemon 回填，agent 手填被拒绝。
- [ ] tool 投递成功后消息带 `→ @target` 可见标记；投递失败返回 typed error，不显示成功。
- [ ] 弱模型 tool-call 失败只触发一次 schema 纠错提示，不触发文本自动路由；provider 成功率进 eval 记录。
- [ ] operator stop 产生 `canceled`（不是 interrupted）；cancel queued 产生 `withdrawn`。
- [ ] custody event 可重放为 holder/blocked/expired；blocked 的 `completes` 与 `bounces-back-to-owner` 都有测试。
- [ ] custody state×event 全枚举、幂等 append、per-subject 串行化有测试。
- [ ] wait 缺 `wait_source_ref` 或 SLA 时 fail closed，不能静默 hold。
- [ ] event 型 wait 缺 `expected_signal` 时 fail closed；waits 不独立裁决 handoff 过期。
- [ ] 依赖 task 按 DAG 顺序执行。
- [ ] 预算耗尽会 pause，不静默继续。
- [ ] crash 后恢复所有 active task，含 re-attach 或显式 fresh+capsule。
- [ ] RPC worker harness 跑通一个真实 task 的 implement→review 全链路。
- [ ] daemon crash 与 worker crash 都能恢复/降级，不产生死 sticky。
- [ ] control plane 不可用时非只读工具 fail-closed，只读工具按 allowlist 继续。
- [ ] stale worker 的 claimed runs 变 interrupted，session 标 `re_attach_pending`，不被再次 sticky。
- [ ] 同 worker 的多 run 拿到各自 token/policy。
- [ ] 同一 agentSession 的常规调度不会漂到另一个 worker；显式迁移必须记录证据。
- [ ] 队列比较子为 手动 > urgent > normal > FIFO，无按 kind/source 的隐藏优先级。
- [ ] daemon 生命周期链只由 runtime-deployment owner 写入；无第二 process registry/supervisor；未授权/未知身份 fail closed。
- [ ] deployment wait 复用原 Task 的 F280 await；`autoRenew:false`、TTL=0；错误 deployment/Alpha/端口可达不匹配；投递幂等、start guard 复核。
- [ ] `pr_tracking` task binding 与 task 同事务；无孤儿；merge/revert 缺失 binding → `managed_unattributed`。
- [ ] raw `workId`/`attemptId` 不出现在 Task/Run/PR API/MCP/Web/Community。
- [ ] participant review/verify run 不产生 run-level episode；需要展示时 `unmanaged_not_applicable + reason='participant_phase_b'`，不进 coverage；`managed_unattributed` 只留 primary 缺 binding。
- [ ] managed-work retry = sticky（DP-A2-2-1=A）：调度先读 attempt 绑定；已绑 → 同 profile；不同 → 消费 target + operator blocker；fallback 只对非 managed/Phase C。
- [ ] managed retry 不撞 bind-once：已绑 attempt 的重试只选同 profile；换 profile 重试被 409 或消费 target 拒绝。

### Risks

| 风险 | 缓解 |
|---|---|
| 调度过度复杂 | 先 SQLite + priority + DAG；不引入分布式队列 |
| 重复造消息/球权层 | 直接复用 clowder A2A 三对象、custody event、wait contract |
| session 漂移导致失忆 | sticky routing + re-attach + 显式降级 |
| worker 全量工具 | per-run policy 查询 + token 绑定 |
| 预算失控 | per-task/provider 配额 + pause + human |

### Review focus

- 烁烁：A2A 内核复用、session 亲和、re-attach、per-run policy、worker 生命周期。
- 砚砚：预算/权限/worker 隔离。

---

## W6. Memory / Observability / Eval

### Goal

让 agent 在正确时刻拿到正确证据，而不是塞历史；让 eval 能驱动模型-角色矩阵；让 operator 能看见“这轮发生了什么”。

> W6 已定：**继承层 + 代码适配**，不另建 memory/eval 系统。P0 = file evidence/recall + task outcome + eval 闭环 + local observability/trajectory + F150/F130 parity；P1 = lessons/decisions + 代码域指标；P2 = cue plane/context presentation。2026-10-25 operator 批准 A3-2 memory A/A/A、A3-3 observability A/A/B。

> 默认复用 clowder 中与代码交付相关的 memory/eval 能力：thread recall、evidence search、session digest、task outcome、lessons、eval harness；diary / dream / personal memory 不搬。

### 6A Memory / Evidence（P0，DP-MEM-1/2/3=A/A/A）

- 直接复用 clowder evidence substrate：原文坐标、provenance、可重建索引。
- v1 **file-evidence subset**：repo docs/ADRs、plan/feature、artifact 文件；thread messages/run_events 需 source connector，defer→W6+；个人/主动/私密记忆不搬。
- 独立 `CODETEAM_MEMORY_DB` + index worker；禁 ATTACH control DB；memory.db 不进 control 备份，删除/rebuild 即恢复。
- pull recall + file drill-down；不新建第二套 truth store；空结果只代表索引范围，带 coverage/degraded/stale。
- FTS5/BM25 起步；hybrid 后置；内容级 secret redaction（path+payload）+ 绝对前缀 deny。

### 6A.1 Retrieval triggers

| 时机 | 注入 |
|---|---|
| kickoff / task start | 项目约定、相关历史 task、已知坑 |
| design / plan | 架构/决策、受影响模块 |
| impl | 当前文件、相关测试、最近 diff、编码约定 |
| review | acceptance criteria、impact surface、历史 finding 模式 |
| review + verify gate | 验收命令、环境约束、回归样本 |
| merge | 风险清单、rollback 方案 |

### 6B Eval / Outcome（P0）

记录：

- task / role / provider / model
- outcome（merged / rejected / blocked / abandoned）
- first-pass review 通过与否
- review findings / 修复轮次
- tokens / cost / latency
- human intervention
- code metrics：review FP/recall/survival、time-to-green、cost per merged change
- 复用 W1 `evals` 表存 outcome/metrics；不新建 outcome store。
- `task_outcome_episodes` 的 `attribution/work_id/attempt_id` 由 A3-3 消费 A2-2 private binding；`managed_attributed` 需双 ID + binding；不建第二 episode store。

### 6C Lessons / Decisions（P1）

- 不自动把聊天摘要写成 truth。
- 写入必须显式：`propose | defer | abstain`。
- 纠错/遗忘默认 human 确认，并传播到派生视图；agent 不得链式“自我纠错”后直接写回 evidence store。
- 外部 claim 走 source-audit。

### 6D Later（P2）

- cue plane、context presentation、graph；不进 MVP。

### 6E Observability / Trajectory（P0，DP-OBS-1/2/3=A/A/B）

- local-first：OTel local trace ring（10k/24h）+ Prometheus snapshot + `/ready`；OTLP 默认关；HMAC salt 走 0600 文件。
- trajectory 只从 canonical `runs`/`run_events`/`messages`/`queue_entries` 投影；`inv:`=`runs.id`；`/request-generations` defer→W7+；ring miss 显示 `trace_unavailable`。
- A-D redaction + metric allowlist + tool span metadata allowlist；raw prompt/diff/file content 不进 trace/log。
- F150 parity：`tool_usage_counters` + `/api/tool-usage`；F130 parity：JSON/Pino 文件 + rotation/retention + `/api/logs/tail`；两者独立 store/redaction，只按 correlation key join。

### 6F Harness Eval（DP-HE-1/2/3=A）

- **范围**：v1 只做 verdict envelope + finding 不可变 + lifecycle append-only；F266/F267/F278 治理 R2 borrow；F313 只借 finding/repair 形状；F311 不进；不做 Eval Hub UI / Paw-Feel inbox / F246 repair。
- **registry**：`codeteam/evals/domains/*.yaml`（domainId/systemThreadId/evalAgent/frequency/triggerPolicy/sourceAdapter/sourceRefsKind/SLA/enabled/dormancy）；`evalAgent` 指向 `role='eval'` 的 `AgentProfile`，不是 clowder catId；缺失/禁用 fail closed。
- **envelope/lifecycle**：`EvalAgentInvocationPacket` → eval agent → `VerdictHandoffPacket`；`LifecycleRootArtifact`（v1/v2/v3）与 `eval-verdict`/`eval-finding`/`eval-snapshot`/`eval-attribution` 作为 immutable artifacts；`eval_lifecycle_events` 是 append-only canonical case log（PK(case_id,seq)、event_id UNIQUE、`BEGIN IMMEDIATE` seq、append-only trigger、读面 transition guard）。
- **metrics**：`evals` 扩展 `domain_id/bundle_id/verdict_id/window_start_ms/window_end_ms/measurement_ref/status/reasons_json`；`task_id` 允许 NULL（domain-level）；`status ok|insufficient|no_data|degraded`，NULL=legacy unknown；`insufficient/no_data/degraded` 必填 reasons；F267 使用显式 v1-minimal result（去 certificateId/certificateRef/decisionProcedureVersionSetHash）。
- **读面**：publish 同事务向 domain system thread 写人读 verdict 消息（ownerAsk/SLA/counterarguments/re-eval plan + artifact digest；消息是投影，不改 case 状态）；CLI `codeteam eval list/open/overdue/show/accept-sunset` 从 events 派生；`escalated` 进 overdue；无 findingKey 的消息标“observation report · no case tracking”。
- **门禁**：`delete_sunset` publish 只校验 `cvoAcceptRequired=true` 声明；执行前必须 operator accept；未 accept 保持 `open(awaiting-sunset-decision)`。`cvo_suppressed` operator-only；lifecycle 11 transition × actor 矩阵；eval agent 生成自由文本过内容级 secret 扫描；eval agent 不能自签 terminal。
- **边界**：code review `reviews/findings/verifications` 与 eval `eval_lifecycle_events` 两本账；不建 `eval_verdicts`/`eval_cases`/`eval_findings`；不把 `insufficient`/`no_data` 当 healthy。

### Tasks

1. 消费 W1 入场门禁产出的继承矩阵；实现代码 adapter，不新建 memory/eval 系统。
2. 代码 evidence adapter：repo docs/ADRs、task/artifact、review/verification、merge receipt。
3. 接 pull recall + source refs + drill-down + session digest。
4. task outcome episodes 落 `evals`；复用 eval 闭环。
5. 注入器：kickoff/design/impl/review+verify-gate/merge/completion（只做代码相关）。
6. lessons/decisions：propose/defer/abstain；纠错/遗忘 human 确认。
7. 多 provider / 多 repo eval corpus + 代码域指标。
8. 模型-角色矩阵报告。
9. memory：独立 memory.db + index worker + FTS/passages + coverage/degraded/stale + 内容级 redaction。
10. observability：local trace + trajectory read model + `/ready` + A-D redaction/metric allowlist。
11. F150/F130 parity：tool_usage_counters + `/api/tool-usage`；日志 rotation/retention + `/api/logs/tail`。
12. W7：trajectory/trace/tool-usage/logs 只读面，operator/console auth；run token 403。
13. harness-eval registry + `evalAgent` role/profile 解析；缺失 profile/role fail closed。
14. verdict/lifecycle artifacts + `eval_lifecycle_events`；caseId/seq/权限矩阵/transition guard/append-only trigger。
15. `evals` 扩展 + v1-minimal measurement result + reasons_json + 三状态词映射。
16. W6 thread verdict 消息 + `codeteam eval list/open/overdue/show/accept-sunset`；`delete_sunset` 两层门。
17. 测试：review/eval 分账、lifecycle 非法 history fail closed、redaction/secret 扫描、insufficient/no_data、无 findingKey 消息、并发 seq、operator-only suppress/accept。

### Deliverables

- 继承矩阵 + 代码 evidence adapter。
- pull recall/session digest 接入 + source refs。
- outcome episodes + eval report（复用 `evals`）。
- 模型-角色矩阵建议 + 代码域指标。
- harness-eval registry + `eval_lifecycle_events` + `evals` 扩展 + CLI/thread 读面 + 测试报告。

### Acceptance

- [ ] 检索返回 source ref；派生索引可重建。
- [ ] 明确复用哪些 clowder primitive、哪些是代码 adapter；没有第二套 truth store。
- [ ] 每个 task 记录 outcome/cost/latency/review findings。
- [ ] 至少 2 个 provider / 2 个 repo 的 eval 数据。
- [ ] 代码域指标（review FP/recall/survival、time-to-green、human intervention、cost per merged change）有报告。
- [ ] 模型-角色矩阵由数据决定，不靠直觉。
- [ ] 没有自动摘要写成 truth 的路径。
- [ ] 纠错/遗忘有 human 确认记录，agent 不能绕过。
- [ ] cue plane / context presentation 明确留到 P2，不阻塞 W6 MVP。
- [ ] memory 只索引 file evidence；thread messages/run_events 未实现时 threads scope 不对外承诺；memory.db 不进 control 备份。
- [ ] memory 空结果带 coverage/degraded/stale；内容级 secret 扫描命中 skip/redact + audit。
- [ ] observability 的 trajectory 只读 canonical 表；trace ring miss 显式 `trace_unavailable`。
- [ ] F150 `tool_usage_counters` 幂等 increment + retention；F130 日志 rotation/retention/redaction + `/api/logs/tail`。
- [ ] telemetry/trajectory/tool-usage/logs 读面 operator/console 限定，run token 403。
- [ ] harness-eval registry 可加载；`evalAgent` 解析到 `role='eval'` active profile；缺 role/profile fail closed。
- [ ] `eval_lifecycle_events` append-only + transition guard；`reviews`/`findings` 不被 eval lifecycle 写入；不建第二套 verdict/case/finding 表。
- [ ] `delete_sunset` 提案可见、未 accept 不执行；无 findingKey 的消息明确无 case 追踪；`insufficient/no_data` reasons 在 `evals` 与消息头可见。
- [ ] eval agent 生成文本 secret 扫描；`cvo_suppressed`/`accept-sunset` operator-only；run token 不能写 lifecycle。

### Risks

| 风险 | 缓解 |
|---|---|
| 记忆变成垃圾场 | propose/defer/abstain + provenance + TTL/GC |
| 检索噪音 | FTS5 起步；hybrid 只在有数据后加 |
| eval 过拟合 | 多 repo + 负对照 + 预注册门槛 |
| 个人偏好污染项目记忆 | 只做项目证据；个人偏好后置 |
| memory 索引拖慢 custody | 独立 memory.db + worker 子进程 + 单写者 |
| observability 泄密/空壳 | A-D + tool span allowlist + canonical-only trajectory |
| tool counter 双计数/日志泄密 | 幂等 increment + 独立 REDACT_PATHS + retention |

### Review focus

- 墨墨：是否真的复用 clowder primitive 而不是另建 evidence store；检索是否服务 operator/agent 的真实路径。
- 砚砚：provenance、纠错/遗忘、eval 可信度。

---

## W7. Interface / Ops 与 Console M0

### Goal

让 codeteam 可被人和外部系统使用；Console M0 成为 operator 真正的“看 + 聊 + 批”入口。

### Interfaces

- daemon HTTP API + WebSocket/SSE events。
- Thread message API：operator chat append/list；agent 回复按 `agentSessionId` 归属。
- Trajectory/observability read API：`/api/invocations/:id/trajectory`、`/api/telemetry/traces`、`/api/tool-usage`、`/api/logs/tail`；operator/console auth，run token 403。
- Worker extension tool surface：A2A/custody + read tools；MCP server 只在命名
  外部 consumer 出现时作为 sibling adapter，不是 v1 默认路径。
- CLI：`codeteam backlog create/dispatch/list`、`codeteam task create/status/run`、`codeteam daemon`、`codeteam approval list/show/approve/reject`、`codeteam merge record`、`codeteam merge run`（operator 手动触发/调试；调用同一 merge service，仍走 E1–E5）、`codeteam eval list/open/overdue/show/accept-sunset`；W4 已提供最小 thread CLI（`thread list/show/post/tail`），W7a 复用同一 daemon API。
- Lifecycle：Web Console/API 只提交 lifecycle intent/approval；实际 daemon 启停/复验由 external executor（W0/W5 CLI；W7 独立 supervisor/controller）执行。不暴露通用 shell；目标 backend 不 self-restart。
- GitHub/GitLab 由 W8 提供。

### Console M0（看 + 聊 + 批）

- Thread 列表 / 详情（Mission Hub 投影）。
- 时间线：handoff / run / artifact / gate；W7a timeline/live-hydration 从 canonical `messages`/`runs`/`queue_entries` 投影，`runs.response_message_id` 是 response bubble 唯一身份；不建第二套 bubble store；断线重连走全量 snapshot（`DP-BUBBLE-1=A`，W7 approved-for-direction，W4 dogfood 后按实测修订文案/恢复入口，不改 W1 identity）。
- Mission Hub board：当前 `WorkflowSop.stage` / 持球 role / 待审批。
- Diff viewer。
- Test / CI / review verdict / findings。
- Thread chat：W0–W4 dogfood 先有最小 CLI `codeteam thread list/show/post/tail`（见 `0003 W4`）；W7a 提供兼容 API/投影，W7b 才是完整 operator surface。operator 在 thread 内用自然语言与当前 role 对话；消息持久化并进入时间线，需要 agent 行动时转成 typed inbox（`steer | followUp | humanGuidance`；`DP-A3-1-3=A`）。
- 单次 invocation trajectory + trace drill-down；trace 不可用时显式 `trace_unavailable`，不静默断链。
- Approval Hub 卡片只承接 hard-gate approval；routine merge 显示 merge owner execution status（read-only），operator 不做每 PR merge 按钮（`DP-MERGE-1=D`）。Approval inbox 是投影。
- GitHub issue/PR/commit/check 只读链接。

### 前端载体（已定：C → A，前提：Hub 承载 spike 通过）

- **dogfood 阶段二：C** — codeteam daemon 实现 clowder Hub 兼容子集（thread/message/rich block/approval/backlog-item/workflow-sop 只读投影/事件流），接入现成 clowder Hub；不共享 clowder 数据库，不把 agent 伪装成猫。
- 兼容适配层在外部 codeteam 仓；clowder-ai 只作为 Hub UI 宿主与 dogfood 目标仓，不在 clowder-ai 内写 codeteam 产品代码。
- **dogfood 两阶段**：阶段一（W0–W4）= CLI 交互（含 thread chat；local merge service + merge record + approval CLI；`DP-MERGE-2=A`）；阶段二（W7a）= C Hub 体验。阶段一不依赖 Hub/Web Console，但不等于无聊天：operator 用 `codeteam thread list/show/post/tail` 与 agent 交流。阶段一不依赖 W8 GitHub adapter。
- **C 的前提**：W0a 的 Hub 承载 spike 必须证明外部 thread + 消息 + 审批卡 + backlog 卡片/board 能在现成 Hub 展示；若需 clowder-ai 侧改动，作为独立 operator 授权项，不在 codeteam 计划内直接改 clowder-ai。
- **产品：A** — 同构契约 + 复用/fork clowder Hub 组件，形成 codeteam 自己的 Console；复用基线为 `DP-WEB-1=B` 的 classic。
- **B 自建** — 只有书面论证 clowder Hub 不适用时才做。
- **前端复用基线（DP-WEB-1=B decided）**：Hub 有两套 shell：`classic`（默认、frozen）与 `v2`（F322 新壳，`?shell=v2`，in-progress）；`site/` 是公共官网，不是 Hub。**W7a C 与 W7b Console 均复用 classic；v2 不进入 v1 交付，后续迁移另开 DP/计划**。详见 `../architecture/decision-packets/2026-10-25-dp-web-baseline.md`。
- W7 拆成 **W7a（headless：API/鉴权/事件重放/CLI/兼容子集）** 和 **W7b（前端壳）**；W7a 可前置，W7b 后置。

### Console M1（后置）

- 创建 thread/task。
- 创建/编辑 role（writer、researcher 等自定义 role）。
- 修改 role/model/budget/sandbox。
- Retry / cancel / rollback。
- GitHub 链接管理。
- Memory / eval dashboard。
- Tool usage / structured log 查看（F150/F130 parity 的只读面）。

### Merge receipt

- W1–W6：`codeteam merge record` CLI 录入 `baseSha/headSha/mergeSha` + `executedBy`/`gateEvidenceRef`/`reviewRef`/`status`/`failureRef`；`DP-MERGE-1=D` 的 Q5 已冻结，`approvals.decidedBy` 不动。
- W7：Console M0 区分 hard-gate approval 与 merge owner execution status。
- W8：GitHub MergeExecutor adapter 通过 PR merge API + reconciliation 执行，生成同一 `merges` receipt；`pr_merged` 只作外部观察事实。

### Tasks

1. **W7a**：daemon API/WS/SSE、事件重放、thread/message/approval/backlog-item/workflow-sop 只读投影兼容子集；trajectory/trace/tool-usage/logs 只读 API。
2. **W7a**：artifact → ThreadArtifactDTO 投影契约（kind 映射、`provenance.sourceMessageId`、账本权威/视图只读）。
3. **W7a**：worker extension tool surface（P0 6：现有 5 个 + `thread_context`）+ real RPC E2E；MCP server 只在命名外部 consumer 出现时做 sibling adapter。
4. **W7a**：CLI commands（含 W4 的 approval list/decide、backlog create/dispatch/list）。
5. **W7a**：鉴权矩阵：operator credential（Console/CLI）/ run token（worker extension）/ webhook HMAC（W8）三个 auth 域互不可替代；`approval:decide` 只接受 operator credential；`merge:execute` 只由 daemon `service:merge-owner` 执行、无 MCP/REST 暴露；`merge:record` 由 daemon 同事务写；thread chat 是普通消息写入，不获得 approval decide / merge:execute 权限；telemetry/trajectory/tool-usage/logs 读面 operator/console 限定，run token 403。
6. **W7a**：对 pinned clowder Hub 版本做兼容 contract tests；不支持的功能显式隐藏/降级；功能清单由 dogfood 摩擦记录驱动。
6b. **W7a**：GitHub tracking status 只读派生投影（observing/stopped(reason)/unarmed + predicates/generation/expires/last outcome/lag）+ CLI `codeteam forge tracking list`（GS-8b）。
7. **W7b**：Console M0 前端壳（C：接入现成 Hub；A：同构 + 复用/fork 组件）；复用基线按 `DP-WEB-1=B`（classic）。
8. merge record CLI + approval receipt 对账。
9. 备份/恢复、schema migration、升级流程。
10. 测试：session 断线重连、事件重放、聊天消息持久化/回放、审批幂等、run token 打 merge 端点 403、artifact 投影；trajectory 404/unknown/trace_unavailable、tool usage/log 读权限。

> **2026-10-30 operator decision: extension-first.** F015 已经交付 worker
> extension tool path 与真实 RPC E2E；internal pi worker 显式 `--no-mcp`。
> operator 明确 v1 由 worker extension 交付；task 3 的 MCP server 与 MCP
> acceptance 项 defer 到“出现命名的外部 consumer”触发。工具优先级以
> [`../reports/2026-10-31-f016-a2a-dispatch-tool-priority.md`](../reports/2026-10-31-f016-a2a-dispatch-tool-priority.md)
> 为准：P0 = 现有 5 个 + `thread_context`，wait 三件套拆到 F016b。

### Deliverables

- daemon API/WS + Hub 兼容子集 + contract tests。
- Worker extension tool surface（P0 + F016a real RPC E2E）；MCP sibling adapter
  仅在命名外部 consumer 出现时做。
- CLI。
- W7a headless surface；W7b Console M0（Mission Hub board + Approval Hub + thread chat）。
- merge record。
- 运维文档。

### Acceptance

- [ ] 外部进程能通过 CLI/JSON 驱动一个 task。
- [ ] 真实 pi RPC worker 能调用 P0 extension tools；P1/P2 按 F016a 计划交付或 defer。
- [ ] W7a C 体验：operator 能在现成 clowder Hub 看到 backlog board、打开 codeteam thread、发消息、看回复、审批、断线重连；不读 clowder DB。
- [ ] W7a 开工前，W0a Hub 承载 spike 已通过，或 clowder 侧改动清单已获 operator 授权。
- [ ] Hub 兼容子集对 pinned 版本有 contract test；未支持功能不伪装可用。
- [ ] Console M0 显示真实 thread/diff/review/聊天/审批。
- [ ] artifact kind → ThreadArtifactDTO 映射有契约测试；evidence artifact 带 `sourceMessageId`。
- [ ] operator 能在 Console M0 的 thread 聊天框发消息；消息持久化、可在时间线回放，agent 回复可见。
- [ ] Console M0 的 operator 写操作只有 hard-gate approval；routine merge 只显示 merge-owner execution status（read-only）；thread chat 是普通消息写入，不改变 task 状态；approval 显示 resolution 与 materialization 两段。
- [ ] W7b 复用基线已确认（`DP-WEB-1=B`，classic）；C/A 均用 classic，不混用 v2；v2 不在 v1 验收内。
- [ ] approval decide 只接受 operator credential；routine merge 走 merge-owner capability；run token 访问 approval decide 返回 403；agent 只能 request，不能 decide。
- [ ] extension/MCP 工具面不暴露 approval decide / merge execution。
- [ ] accepted-but-not-materialized 有 operator abandon 出口（failed `operator_abandon`）；Hub 分开显示 resolution/materialization。
- [ ] `codeteam merge record` 能录入 merge owner merge receipt。
- [ ] 升级不破坏 SQLite；可回滚。
- [ ] 断线重连后事件不丢/可重放。

### Risks

| 风险 | 缓解 |
|---|---|
| Console 变成第二真相源 | UI 只调 daemon API/WS；不读 DB |
| Hub 兼容层漂移 | pin 版本 + 只冻结 dogfood 子集 + contract tests；未支持功能显式隐藏 |
| M0 范围膨胀 | M0 只做看+聊+批；M1 后置 |
| merge receipt 手工易漏 | CLI + schema 校验 + 幂等 |
| 事件重放噪音 | 事件游标 + snapshot + 去重 |

### Review focus

- 墨墨：Console M0 是否真的能支撑 operator 的 thread/diff/review/聊天/审批路径。
- 烁烁：daemon/WS/事件模型、断线重连。
- 砚砚：extension/MCP auth、merge/approval 权限边界。

---

## W8. Forge Connector（GitHub/GitLab）

### Goal

把 GitHub/GitLab 作为工作入口、证据源和交付出口，而不是 IM 网关。

### ForgeAdapter

```ts
interface ForgeEvent {
  id: string;
  deliveryId: string;
  provider: "github" | "gitlab";
  kind: "issue" | "pr" | "review" | "check" | "comment" | "merge";
  action: string;
  repo: string;
  number?: number;
  headSha?: string;
  actor?: string;
  permissionEvidence?: string;
  payload: unknown;
  receivedAt: number;
}
```

### Inbound

- issue opened/updated → `BacklogItem(status=suggested/approved)` → dispatch → thread → task。
- PR opened/updated → review/merge evidence。
- review submitted → verdict/evidence。
- check/CI completed → verification artifact。
- PR comment → review feedback/inbox。
- merge → 外部观察事实（`pr_merged`）；本 cell 不写 `merges` receipt，merge terminal truth 归 merge service（`DP-MERGE-1=D`）。
- **所有进入控制面的事件**（issue/PR/comment/check）统一权限门禁：actor 必须是 maintainer/collaborator；label / `@codeteam` mention 只是叠加的 opt-in 信号，不单独构成放行条件。无权限事件只落只读 evidence。

### Webhook / API reconciliation

- webhook 验签。
- delivery id 幂等，写入 `forge_deliveries`（delivery id / natural key / status / retry_count / processed_at）；daemon 重启后仍能去重。
- **webhook 只做触发；GitHub API 做对账真相源**。
- natural key：`repo + issue/PR number`；收到事件时 task 不存在则 fetch API upsert。
- 处理乱序/丢失：不依赖 webhook 顺序；API 可补建/修正。
- rate limit/backoff。

### 2026-10-25 github-signals review hardening

> Operator 2026-10-25 拍 `DP-GH-1=A` / `DP-GH-2=A`：v1 GitHub-only；observation 复用 `tasks`/`waits`/`audit`/`forge_deliveries`，不建第二账本。以下为冻结护栏。

- **v1 GitHub-only**：`ForgeAdapter` 只留 provider seam；GitLab defer，不写进 v1 承诺。
- **默认 polling，webhook opt-in**：A1-4 daemon 只绑 loopback；`CODETEAM_GITHUB_WEBHOOK_ENABLED=0` 默认关；启用时经 operator 反代/tunnel TLS 到 loopback，反代来源需可信判定。
- **HMAC 防护**：constant-time compare；webhook body 1MB 上限/413；secret 存 config 0600 或 env，不进 agent 面/日志。
- **注册幂等**：`tasks(subject_key)` partial unique（kind ∈ pr_tracking|issue_tracking）；同 subject 同 kind register replay 既有 task/wait，不双 task/双 wait/双唤醒。
- **observation 落点**：collector state 进 `tasks.automation_state_json`；wait 进 `waits.baseline_json/continuation_json/outcome_json`；`audit` 只记 state-changing observation（matched/terminal/rearm_failed/migration/dedup/permission-denied）；`forge_deliveries` 做 webhook dedup。不建 `github_observations` 第二账本。
- **tracking status**：operator 读面从 `tasks` + `waits` 纯派生（observing/stopped(reason)/unarmed），不建第三套 status store。
- **边界**：GitHub review/CI facts 不写 W3 `reviews` 表；外部 review 与内部 ReviewPolicy 分离。
- **merge 边界**：`pr_merged` 只作外部观察事实，不进 GitHub tracking 10 kinds、不作 custody predicate；merge terminal truth 是 `merges` receipt（`DP-MERGE-1=D`）。完整契约见 `architecture/reuse-review/github-signals.md`。

### W8 github-signals implementation slice

> Review request `8290c9ca-3611-495a-8b59-c7b596959916`（2026-10-25，三猫）：烁烁 accept；砚砚 accept-with-modify；墨墨 accept-with-modify；无 reject；P2/P3 已回写，GS-1..GS-10 冻结。
>
> 回写：GS-8→8a（renderer，随 GS-5）/8b（tracking status，随 W7a 6b）；删除旧 W8 Tasks 1–7 双源；GS-10 补 draft/reset、identityUnknown over-deliver、expired/rearm/terminal 自述；GS-4 补 429 backoff + F139 TaskSpec/no private polling；GS-6 补 timingSafeEqual + secret 存储；GS-2 对齐 A2-1 G15（`system:forge:<provider>` + `user_id=operator`）；GS-7 补 `humanGuidance` inbox；GS-9 migration v1 null。

| ID | 实现切片 | 验收 |
|---|---|---|
| GS-1 | `ForgeAdapter` / `ForgeEvent` schema + provider seam；GitLab 只留 seam | 未登记 provider/kind fail closed；不声称 GitLab 支持 |
| GS-2 | `register_pr_tracking` / `register_issue_tracking` + `tasks.kind`/`subject_key` partial unique；register 入口 = extension tool + operator CLI；GitHub issue inbound 按 A2-1 G15：`created_by_kind='system'`、`created_by_id='system:forge:<provider>'`、`user_id=operator`，只准初始 `open|suggested` | 同 subject 同 kind replay 既有 task/wait；换 kind 允许；无双 task/双 wait；不伪造 operator actor |
| GS-3 | baseline reader + 10 typed predicates + pure matcher | 未知 kind/duplicate kind fail closed；baseline 与 cursor 分离 |
| GS-4 | review/issue/CI/conflict collectors；per-source cursors；429 指数退避至 `CODETEAM_GITHUB_RATE_LIMIT_BACKOFF_MAX_MS`；collectors 以 F139 TaskSpec 注册进 W5 schedule registry（factoryId 白名单），禁止 daemon 私有轮询循环 | collection/delivery cursor 分离；cursor 只在 durable observation/outcome 后推进；429 不无限重试 |
| GS-5 | wait lifecycle + renewal + outcomeId 幂等 + `rearm_failed` | 同一 outcome 不双唤醒；rearm_failed 明确“已停止观察”；不直接写 message |
| GS-6 | webhook HMAC/dedup/allowlist；`crypto.timingSafeEqual`；secret 存 config 0600 或 env（不进 agent 面/日志）；opt-in + 反代/tunnel；body cap | 默认 polling；HMAC fail 403；重复 delivery skip；超限 413 |
| GS-7 | permission gate + identity/audience；有权限 comment 进 inbox 用 `humanGuidance`，不新造 kind | label/mention 不单独放行；无权限只读 evidence；identityUnknown 显式告警 |
| GS-8a | renderer 内容契约 + GS-5 delivery 内容内核 | #1392 AC-7 三纪律；delta 带 sourceRef、无 body；`terminalSubjectState` 区分 merged/closed；expired/rearm_failed/terminal 三态自带停止理由；不依赖 W7a |
| GS-8b | tracking status 只读派生投影 + CLI `codeteam forge tracking list` | observing/stopped(reason)/unarmed + predicates/generation/expires/last outcome/lag；依赖 W7a |
| GS-9 | audit 收窄 + no-match metrics | no-match 不写 audit；matched/terminal/rearm_failed/migration/dedup/permission-denied 才写；`migration` 只用于 clowder backfill（v1 恒 null） |
| GS-10 | 回归/安全测试 | 重复/乱序/丢失 webhook、cursor crash、empty rollup、cancelled、billing、dismissal、draft/reset、permission-denied、token redaction、identityUnknown over-deliver、expired/rearm/terminal 自述、pr_merged 外部观察 |

依赖：GS-2/GS-3 依赖 W1 `tasks`/`waits`/`forge_deliveries`；GS-4/GS-5 依赖 W5 F139 schedule seam 与 ball-custody；GS-6 依赖 A1-4 loopback；GS-8a 依赖 GS-3/GS-5（无 W7a）；GS-8b 依赖 W7a tracking status（W7a 6b）。

### Issue / comment permission gate

- 只接受 maintainer/collaborator；`codeteam` label / mention 只能作为叠加信号，不能单独放行。
- 其他 comment 只落只读 evidence，不进 inbox/handoff。
- comment 正文 untrusted，进 prompt 前包装。
- 记录 actor / `permissionEvidence` / delivery id。

### Outbound（后置）

- review verdict/finding/test report → PR comment/check。
- 先只读 evidence；outbound 写操作后置，且需 human/policy gate。
- 模型不持有 GitHub token；token 由 daemon 持有，最小 scope。

### Tasks

本节的实现任务源 = `GS-1..GS-10`（上方表）；不再维护第二份 Tasks 清单。GitHub signals 不写 `handoffs`/`messages`/`merges`，不直接 wake/deliver；只写 `backlog_items`（仅 GitHub issue inbound 的初始 `open|suggested`）、`tasks.automation_state_json`、`waits`、`artifacts`、`audit`、`forge_deliveries`，以及有权限 comment 的 typed `inbox(kind=humanGuidance)`。community-ops / dispatch 消费 facts 后自决 case/delivery/wake。

### Deliverables

- ForgeAdapter + GitHub implementation（GS-1..GS-10）。
- webhook/API reconciliation。
- issue/comment permission gate + permission evidence。
- tracking status 只读投影 + CLI `codeteam forge tracking list`（GS-8b）。
- outbound 设计（可后置实现）。
- 安全/幂等测试报告。

### Acceptance

- [ ] issue 能创建 backlog item；dispatch 后产生 thread/task。
- [ ] PR + CI 能生成 review/verification evidence。
- [ ] 有权限的 issue/comment 进入 task/inbox；无权限只读。
- [ ] 非 maintainer/collaborator 的 issue/comment 不因 label 单独放行。
- [ ] 重复/乱序/丢失 webhook 不导致 task 缺失。
- [ ] 重启后重放 webhook 命中 `forge_deliveries`，不重复派发。
- [ ] token 不出现在 prompt/log/agent env。
- [ ] routine merge 由 merge owner 在 gate 后执行；第三方/不可逆 merge 仍由 human/policy gate 触发。
- [ ] `tasks(kind=pr_tracking|issue_tracking)` + `subject_key` partial unique；同 subject 同 kind replay 既有 task/wait。
- [ ] collection/delivery cursor 分离；cursor 只在 durable observation/outcome 后推进；`rearm_failed` 显式投递。
- [ ] empty rollup 永远 pending；cancelled 非 pass/fail；billing zero-step 归 external_infrastructure；dismissal 走全量 fetch+verdict map。
- [ ] tracking status 从 `tasks`+`waits` 纯派生；audit 只记 state-changing；no-match 不写 audit。
- [ ] `pr_merged` 只作外部观察，不作 custody predicate；merge terminal truth 是 `merges` receipt。
- [ ] GitHub issue → backlog item 按 A2-1 G15：`created_by_kind='system'`、`created_by_id='system:forge:<provider>'`、`user_id=operator`；只准初始 `open|suggested`，不伪造 operator actor。
- [ ] 不开 Console 时，operator 能用 CLI+thread 回答：我在跟踪什么、还在跟踪吗、停了为什么停（GS-5/8a/8b 整体验收）。
- [ ] GS-8a renderer 契约（#1392 三纪律/无 body/terminalSubjectState/expired-rearm-terminal 自述）随 GS-5 验收；GS-8b tracking status + CLI 随 W7a 验收。
- [ ] GS-4 collectors 以 F139 TaskSpec 注册，无 daemon 私有轮询；429 指数退避到上限。
- [ ] GS-6 HMAC constant-time compare；secret 存 config 0600 或 env，不进 agent 面/日志。
- [ ] GS-10 覆盖 draft/reset dismissal、identityUnknown over-deliver、expired/rearm/terminal 自述；有权限 comment → inbox `humanGuidance`，不新造 kind。

### Risks

| 风险 | 缓解 |
|---|---|
| webhook 乱序/丢失 | API 对账 + natural key upsert |
| 任意人 issue/comment 注入 | 统一权限门禁 + label 仅作叠加 + untrusted |
| token 泄露 | daemon 持有；最小 scope；不进 agent |
| outbound 误操作 | 后置 + human/policy gate |

### Review focus

- 砚砚：webhook 验签、issue/comment 权限、token scope、API 对账。
- 墨墨：GitHub 事件如何映射到 thread/task，operator 是否看得懂。
- 烁烁：adapter 生命周期、重试/backoff。

---

## 依赖与顺序

- W5 依赖 W1/W2 的 schema、lease、sandbox、session identity。
- W6 依赖 W1 的 run_events/artifacts、W3 的 review/finding 数据。
- W7/M0 依赖 W1 的 thread schema + W3 的 review data；W6 outcome data 只用于 M1 memory/eval dashboard。
- W8 依赖 W7 的 daemon/API、W2 的 token/secret 边界。

## 总体验收

- 多 task 并发可恢复；RPC session 不漂移。
- memory 可回源；eval 能驱动模型-角色矩阵。
- Console M0 是 operator 真正使用的入口，不是展示屏。
- GitHub 只读 evidence 闭环；comment 权限门禁有效；token 不泄露。
- 报告落到 `docs/reports/`（或本目录 Results 段）。

---

[宪宪/deepseek-flash🐾]
