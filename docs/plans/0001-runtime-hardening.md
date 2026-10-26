---
title: "codeteam 运行时硬化计划"
doc_kind: plan
status: reviewed
created: 2026-10-21
updated: 2026-10-24
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
audience: [operator, implementer, reviewer]
---

# codeteam 运行时硬化计划

> 前置：Phase 0–4 已落地并通过 review/CI。本文只列下一阶段真正需要硬化的东西，不重开已完成范围。
> 原则：先把“可恢复、可审查、可验证”做扎实，再扩多 task / 多 repo / UI。
> **Dispatch 现行真相**：ADR-043 + F117 Phase D + A2A 执行链（`architecture/reuse-review/dispatch.md` A1-3 v2）；F122 为历史文档。本文中旧的 F122 标签只作历史计划引用。

---

## 1. 当前基线

> 这是讨论时点基线，可能来自旧 codeteam 项目，而不是 `clowder-ai/codeteam/` 讨论区。外部 codeteam 仓建立后，W0a 必须重新对码；如果新项目是 fresh 基线，“已落地”只作参考，W1 迁移策略要按实际情况重排。

已落地：

- `ControlPlane`：task / run / handoff、per-holder claim CAS、one terminal、deadline、loop guard、crash recovery、非法转移。
- `SqliteControlStore`：task / run / handoff 持久化，重启 hydrate。
- `createCodeteamSession`：role-scoped pi `AgentSession`；coder 持久，reviewer/verifier fresh。
- `Phase3Orchestrator`：typed handoff 串 implement → review → verify；独立 review；falsifier closure；merge gate（`DP-MERGE-1=D`：merge owner 执行 + operator hard gates）。
- verifier：strict/repro 模式、worktree containment、secret path deny、命令 allowlist、timeout、output cap、audit。
- review eval：5 clean + 5 seeded；FP 0/5、recall 5/5、survival 5/5。
- CLI adapter + CI。

已知边界：

- SQLite 只有 task/run/handoff，没有 stage/run_event/artifact/inbox/review/verification/merge/budget。
- 权限 wrapper 在 verifier 较强，coder 的 bash 仍宽；还没有 OS sandbox。
- reviewer/verifier fresh context 已做，但 review request 仍可能带 author 信息；盲评需明确。
- 单 task 编排；没有多 task scheduler / dependency DAG。
- architect/design gate 尚未接入。
- memory 只有代码/文档上下文，没有 evidence store / retrieval。
- eval 样本小，provider 单一（Phase 2 reviewer 为 Kimi）。

---

## 2. 目标与非目标

### 目标

1. **可恢复**：crash 后能从 task → stage → run_events → artifacts 恢复；不产生 zombie run。
2. **可审查**：reviewer 只拿 diff + evidence + constraints；finding 有 falsifier；P1/P2 由证据关闭。
3. **可验证**：verifier 在受限环境执行 exact commands；测试/CI 结果作为 artifact。
4. **可扩展**：多 task、多 repo、多 provider、远程 worker 不推翻核心模型。
5. **可运维**：预算、配额、artifact GC、schema migration、备份恢复。

### 非目标

- TUI / console 的完整产品化
- 插件市场
- C 类自动 merge（v1 不做；D 的 merge owner 执行不属于自动 merge）
- 多租户 / IM / voice / 社交记忆
- 把 pi 的所有 kernel 都重写

---

## 3. 工作流

### W0. Fork 工程与 L0 spike

**目标**：把“full fork + SDK/extension-first”从决策变成可运行的工程基线，并验证 L0 压缩免疫。

分段：W0a（外部仓 fork + bootstrap + 文档迁移 + 基线对码 + L0 + session export + 供应链，先于 W1）；W0b（upstream/CI 治理，与 W1–W4 并行，W5 前完成）。

工作：

- fork 整个 `earendil-works/pi` monorepo，pin `v1.4.0`（`4a080252f06caf63a525d7873c5d94d3c23887e0`）。
- 加 `upstream` remote；建 `UPSTREAM.md` / `KERNEL_GAPS.md` 骨架。
- 跑通上游 `./test.sh` + codeteam vitest + 最小 fixture。
- 记录当前实际形态：npm SDK 还是 monorepo workspace；切换触发条件写清楚。
- L0 compiler v0：role 模板 + 治理段编译，产出 `l0_revision` hash，经 SDK `systemPromptOverride` 注入。
- L0 spike：用 mock provider / recording proxy 抓出站 request body；长 session 压到 compaction 阈值（auto + 手动 `compact` 各一遍），断言 compiled L0 逐字出现在 compaction 后首个 request 的 system 里；验证 section 稳定时 prompt cache 命中。
- pi 能力验证：同周验证 session 能否跨进程 resume/export；不支持则 W5 迁移改为 fresh+capsule。

验收：

- 上游测试与 codeteam 测试都有可复现命令。
- `UPSTREAM.md` 记录 tag/commit/修改文件/同步日期。
- L0 spike 有日志/断言；失败则记入 `KERNEL_GAPS.md` 第一条。
- pi session 跨进程 capability 结论写回 0002/W5；不能验证就按不支持处理。
- 没有未说明的 kernel patch。
- CI 有 lockfile 完整性 + dependency audit；`--ignore-scripts` 理由已记录。

### W1. 数据模型扩展

**目标**：把当前 `task/run/handoff` 扩到完整控制面，并给 Console M0 提供真实数据源。

表：

- `threads`
- `messages`
- `queue_entries`（ADR-043/F117 single pending-wake ledger；F122 历史）
- `backlog_items`（feature/backlog SOP 作用域）
- `workflow_sops`（feature/backlog 级告示牌；stage/baton/resumeCapsule/checks）
- `roles`（动态 role registry：内置 4 + 前端自定义 writer 等）
- `agent_profiles`
- `agent_sessions`
- `stages`（纯快照：lane/status；无 entry/exit/criteria/attempt）
- `run_events`
- `thread_events`
- `artifacts`
- `handoffs`
- `custody_events`
- `waits`
- `inbox`
- `approvals`
- `reviews`
- `findings`
- `verifications`
- `merges`
- `budgets`
- `evals`
- `forge_deliveries`
- `audit`

关键字段：

- `tasks.thread_id`
- `messages.dispatch_refs_json`；`runs.queue_entry_id`；`handoff`/`inbox` 是 Queue Entry 的 source
- `tasks.backlog_item_id` / `tasks.related_feature_id`
- `tasks.status` = clowder `todo/doing/blocked/done` + `disposition(canceled/abandoned)`；`tasks.lane` 是当前车道快照
- `roles` 是动态 registry；`agent_profiles.role` / `agent_sessions.role` / `runs.role`；未知 role fail closed
- `workflow_sops.stage` 是告示牌，不做迁移校验；`stages` 是纯快照，不是控制器
- `messages.thread_id` / `author_kind` / `author_id`；operator↔agent 聊天持久化，需要行动时转 typed inbox
- `agent_sessions.profile_id`；profile 是稳定逻辑身份，session 是执行身份
- `runs.agent_session_id` / `runs.model_family` / `runs.l0_revision`；runs 不直连 pi session，一律 join `agent_sessions`
- `reviews.head_sha` / author/reviewer `model` + `model_family` 四元组
- `verifications.head_sha` / `verifications.producing_review_id`
- `inbox.kind = steer | followUp | humanGuidance`
- `handoffs.claimed_lease_until` / `handoffs.last_heartbeat_at`
- `custody_events.subject_ref` / `kind`；`waits.wait_source_ref` / `sla_until`
- `audit` append-only trigger

验收：

- 每个 run lane 有 entry/exit/required artifacts（执行层，不是 SOP 控制器）。
- `WorkflowSop` 以 `backlogItemId` 为 key；stage 是告示牌，不做强制迁移。
- task done 不等于 feature completion；completion 只挂 feature/backlog 级 gate。
- 每个 run 有 append-only run_events；thread 有 thread_events。
- artifact 内容 hash 可校验；metadata 可查。
- inbox 支持 steer/followUp/human guidance，持久化可重放。
- approval 请求/决定/过期可持久化；Console 的 Approval inbox 是 Approval Hub 投影。
- custody 事件 append-only，可投影 holder / blocked / expired；wait 必须带 source ref + SLA。
- operator chat 消息可持久化、按 thread 回放；需要 agent 行动时生成 typed inbox，不产生 handoff。
- 同一 role 可有多个 profiles；同一 profile 换 session 不算独立 review。
- `headSha` 变化会使旧 review/verification 失效。
- 重启后重放的 forge delivery 命中 `forge_deliveries`，不重复派发。
- 迁移脚本可回滚/向前兼容。

### W2. 权限、身份与沙箱

**目标**：把“策略层”变成“工具实现 + OS 边界”，并让身份粒度到 run。

工作：

- coder/reviewer/verifier 各自 tool policy。
- shell：deny-by-default，allowlist；禁止 shell operators；禁止 `node -e`；timeout；output cap；minimal env。
- 文件：worktree containment、realpath、symlink/hardlink、secret path deny。
- 进程：MVP 低权 user + bwrap；目标态默认 container；microVM 后置（D3=A）。
- 网络：bwrap 不能同时做到“默认关网 + loopback MCP + provider API”；MVP 接受 agent 进程网络开放为已知威胁模型边界，靠零 secret + 路径 policy + audit 兜底；container 目标态再做 allowlist。
- **v1 agent 零 secret**：push/publish/部署交 human/CI；agent 只产出 diff/evidence。
- **per-run token**：daemon 在创建 run/session 时铸 token，绑定 `(runId, taskId, role, agentSessionId)`；经 extension 闭包或 `/run/codeteam/tokens/<runId>.token`（0600）注入，不放 env；terminal/interrupted 立即撤销。
- MCP server 从 token 派生身份；tool args 不携带 `from` / `role`。
- **coder git policy**：`git add/commit/status/diff` 白名单；禁止 push/remote/config/checkout 主仓；commit 由 wrapper 代理并捕获 sha 进 audit。
- handoff 创建校验 `(fromRole,toRole,kind)` 命中 SOP actionPair 白名单。
- audit：full args + truncated output + exit code + duration + cwd + producingReviewId。

验收：

- 危险命令、路径逃逸、symlink 逃逸、secret 路径拒绝。
- reviewer 只读；verifier 不写源码；coder 不能 push/merge。
- 同 worker 内不同 run 不能共享 MCP 身份。
- agent 读取自身 token 文件被拒绝；interrupted run 的旧 token 不能完成 handoff。
- coder 的 commit sha 可从 audit 回溯，并写入 `reviews.head_sha`。
- 真 repo first-run 用低权用户/sandbox；最坏只损失 worktree。
- 审计能还原完整命令，且 audit 不可 UPDATE/DELETE。

### W3. 独立 Review 证据链

**目标**：让 review 成为身份 + 模型 + 上下文 + 证据的独立验证，不是模型互评。

工作：

- `ReviewPolicy`：`requireDifferentAuthor`、代码默认 `requireDifferentModelFamily`、`freshContext`、`blind`、`findingRequiresFalsifier`。
- `reviews`/`findings`/`verifications` 是 code review 唯一真相；F192 `VerdictHandoffPacket` 只提供 evidence/finding 纪律参考，**不新建第二套 review verdict 账本**；`findings` 行不可变，关闭只由 `verifications` 证据决定。
- 用 `modelFamily` 判定跨模型；同一模型换 provider 不算；family 用受控枚举静态文件。
- `reviews` 记录 author/reviewer model + family 四元组，供审计。
- 低风险文档允许同族非作者，标 `reviewMode: "same_family_fresh"`；代码默认跨族。
- 没有可用跨族 reviewer：普通代码 blocked；高风险 human review；不得静默当 cross-model 通过。
- review_request 盲评：不带 author model/identity；只给 diff/test-report/impact surface/constraints。
- finding schema 强制 `evidenceKind` + `falsifier` + `falsifierExpected`。
- finding 创建时用 verifier 同一 policy 预校验 falsifier 可执行性；失败只降级该 finding，不整条 review 拒绝。
- verifier 执行 falsifier；finding 由证据关闭；`blocked` 仅限基础设施故障（启动失败/timeout/output cap/二进制缺失），正常完成 exit≠expected 一律 confirmed/rejected；blocked 到期升级 human。
- review/verification 绑定 `headSha`；base 前进即使无冲突也要 rebase + targeted test + fast re-review。
- clean-diff 负对照；FP/recall/survival 预注册。

验收：

- clean FP ≤ 20%
- seeded recall ≥ 60%
- finding survival ≥ 80%
- review 成本 ≤ coder 成本 50%
- 至少 2 个 reviewer model family 的对照数据
- author 与 reviewer 的 profile/session/modelFamily 不同；同一 profile 换 session 不算独立；低风险文档例外有标记
- 每个 review_request 的 headSha 可回溯到 coder commit audit
- n<20 时 eval 门槛只作 smoke，不作为 model family 结论
- code review verdict 与 eval verdict 分账；`reviews` 不被 `eval_lifecycle_events` 写入，eval bundle 不冒充 review 证据。

### W4. SOP 复用 / Design Gate

**目标**：全面复用 clowder SOP；只在代码交付高风险点加 point gates，不把常规改动卡在 human，也不做第二套 stage controller。

工作：

- 移植 clowder `sop-definitions/development.yaml` + codegen；stage id、suggested skill、hard rule、pitfall、severity、predicate、owner 逐字段对齐。
- feature/backlog 级 `BacklogItem` + `WorkflowSop`；`resumeCapsule` / baton / checks；CAS 写入、无 stage 迁移校验。
- 点状 gate：worktree、design、review、verify、merge、completion。
- design gate 默认机器判定：spec schema + AC + User Journey + risk；human 只在 `risk==critical` 或 `spec_change` 时介入。
- risk 五轴（behavior/data/security/contract/irreversible）+ assuranceLevel/route；两段式复核，**只升不降**。
- fast lane 复用 clowder：co-creation docs lane、docs-lane、small-change-lane、product fast lane；hotfix/共享底座/硬边界不借快车道跳审。
- spec_change / plan_revision：agent 提请，orchestrator 裁定。
- human gate 统一写 `approvals`；`codeteam approval list/show/approve/reject` 是唯一审批读写通路。
- **merge service（`DP-MERGE-2=A`，D-first）**：`service:merge-owner`（daemon service principal，≠ implementer）；`merge:execute` 为 daemon 内部 action，无 MCP/REST 暴露；per-merge short-TTL credential 绑 `(repo, PR/branch, exact HEAD)`；mint 前置 = daemon 服务端核验 E1–E5（exact HEAD、非作者 review、无 open P1/P2、gate evidence、falsifier）；执行后撤销；`merges` 写 `executed_by`/`gate_evidence_ref`/`review_ref`/`status`/`failure_ref`。
- **W0–W4 merge adapter**：dogfood 用 local `MergeExecutor`（本地 git merge + branch/receipt reconciliation），不 push、不依赖 W8 GitHub；W8 再接 GitHub adapter，共用同一 `merges` receipt 与 `service:merge-owner` 契约。
- **operator 硬门**：第三方 PR、不可逆 Git、close feat、圣域/生产数据、runtime 生命周期、凭证/secret、外部发布 → operator；routine own-PR merge 不走 operator。

验收：

- `WorkflowSop` 是 feature/backlog 级告示牌；task 完成不等于 feature completion。
- 一个设计型 task 走 Design Gate；critical 才 human。
- docs / 小改动按 clowder 风险车道走，不被点状 gate 拖慢；time-to-green/human intervention 可对比。
- review/verify/merge gates 有 exact HEAD evidence；P1/P2 closed。
- completion 需要 vision guard + acceptance + merge receipt。
- critical design / spec_change / blocker 都能通过 approval CLI 完成，不直接改 task 状态。
- risk 在 post-diff 只升不降；spec_change 不绕过 review/verify。
- dogfood 的 routine merge 由 merge service 执行；operator 不在 routine merge 路径；`merge:execute` 对 run token/agent-key 返回 403；merge service principal ≠ implementer。
- merge receipt 必含 exact HEAD、executed_by、gate_evidence_ref、status；HEAD 变化 → stale + 重走 gate；local adapter 与 W8 GitHub adapter 共用此契约。

### W5. 多 Task 调度与 RPC worker 化

**目标**：从单 task 到多 task，并定义 SDK→RPC worker 的运行时语义。

复用 clowder ADR-043/F117 dispatch queue + A2A 执行链（Queue Entry / response bubble / Active Run、one terminal、event-driven drain、guide/interrupt/cancel/stop；AgentRouter/routeSerial/routeParallel 复用，invokeSingleCat 换 invokeSingleAgent→pi kernel）、F139 proactive schedule（TaskSpec/RunLedger）和 Ball custody/wait contract；codeteam 只加 role/session/worktree/readiness 适配。

工作：

- **ADR-043/F117 dispatch queue + A2A 执行链适配**：保留三对象与 one terminal；`handoff`/`inbox` 是 Queue Entry source，不新造队列；state 编排复用，单次执行换 invokeSingleAgent。
- **Ball custody + wait**：`custody_events` append-only；blocked 支持 `completes` / `bounces-back-to-owner`；wait 必须带 source ref + SLA。
- **Task readiness/admission**：priority + dependency DAG + budget/worktree capacity；只决定哪条 task 可 enqueue/claim，不另建执行队列。
- **F139 proactive schedule**：`TaskSpec_P1` + RunLedger；cron/interval/event 触发后生成 Queue Entry，不直接起 run。
- 资源配额：per-provider concurrency、per-task token/cost/wall-time。
- worktree pool / disk quota。
- 失败重试、dead-letter、human escalation。
- artifact GC / session retention。
- 事件驱动 + dirty-bit drain，不轮询。
- **RPC worker harness**：`pi --mode rpc` 启动包装、extension 装配、per-run token 0600 注入、stdout JSONL 分帧、事件回流 run_events、优雅关停。
- **RPC worker 三语义**：
  1. per-run tool policy：role-per-worker 固定 extension + `tool_call` hook 按 run token 查询 control plane policy；禁止全量工具 + prompt 约束。
  2. session 亲和：同一 `agentSessionId` 的后续 run sticky 到同一 worker；迁移优先用 pi session export/import，W0 验证不支持则固定 fresh+capsule，sticky 作为硬约束。
  3. re-attach：daemon 重启后按 `agentSessionId` 找回 `piSessionId` 重挂；失败降级 fresh + capsule，并记 `session_reattach_failed`。
- worker liveness：heartbeat/lease；stale worker 的 claimed runs → interrupted、sessions 标 `re_attach_pending`；禁止死 sticky；支持优雅 drain。
- per-run policy 查询失败时 fail-closed：deny 非只读工具，只读工具按 allowlist。

验收：

- 两个独立 task 并发不互相污染。
- A2A one terminal / 原地 response bubble / event-driven drain / 用户控制语义保留。
- custody event 可重放；blocked 两态和 wait fail-closed 有测试。
- 依赖 task 按 DAG 顺序执行。
- 预算耗尽会 pause，不静默继续。
- crash 后恢复所有 active task，含 pi session re-attach 或显式降级。
- control plane 不可用时非只读工具 fail-closed；stale worker 不产生死 sticky。
- 同 worker 的多 run 拿到各自 policy/token。
- RPC worker harness 跑通一个真实 task 的 implement→review 全链路。

### W6. Memory / Eval

**目标**：让 agent 在正确时刻拿到正确证据，而不是塞历史。

W6 是继承层 + 代码适配，不另建 memory/eval 系统。P0 = evidence/recall/session digest + task outcome + eval 闭环；P1 = lessons/decisions + 代码域指标；P2 = cue plane/context presentation。

复用 clowder 中与代码交付相关的 memory/eval 能力：thread recall、evidence search、session digest、task outcome、lessons、eval harness；diary/dream/personal memory 不搬。

工作：

- 代码 evidence adapter：repo docs/ADRs、task/run/artifact、review/verification、merge receipt；不新建第二套 truth store。
- pull recall + source refs + drill-down + session digest/thread recall。
- SQLite FTS5；需要时 hybrid。
- 检索触发：kickoff/design/impl/review+verify-gate/merge/completion。
- 写入策略：propose/defer/abstain；不自动把摘要写成 truth；纠错/遗忘默认 human 确认，禁止 agent 链式“自我纠错”写回。
- task outcome episodes 落 `evals`；per-provider/role 指标 + 代码域指标（review FP/recall/survival、time-to-green、human intervention、cost per merged change）。
- **harness-eval P0（`DP-HE-1/2/3=A` 已拍）**：`codeteam/evals/domains/*.yaml` registry（domainId/systemThreadId/evalAgent/frequency/triggerPolicy/sourceAdapter/sourceRefsKind/SLA/enabled/dormancy）；`VerdictHandoffPacket` + `LifecycleRootArtifact` 作为 immutable `artifacts`（`eval-verdict`/`eval-lifecycle-root`/`eval-finding`/`eval-snapshot`/`eval-attribution`）；`eval_lifecycle_events` append-only canonical case log；`evals` 扩展 `domain_id/bundle_id/verdict_id/window_start_ms/window_end_ms/measurement_ref/status/reasons_json`。
- **动态 role**：`eval`/`compress` 等是 `roles` table 的动态 role，不是代码 enum；`evalAgent` 指向 `role='eval'` 的 `AgentProfile`，registry 校验 role/profile enabled；clowder `evalCat` 只在 adapter 边界映射。
- **W6 只做 P0**：F266/F267/F278 治理按 R2 borrow；v1 不做 approval-gated repair、全量 measurement issuer、Paw-Feel inbox、Eval Hub UI；F313 只借 finding/repair 形状；F311 不进。
- **eval 纪律**：evidence 四类 refs 非空；`delete_sunset` publish 必须声明 `cvoAcceptRequired=true`，执行前必须 operator accept；`insufficient`/`no_data` 显式，不得当 healthy；eval agent 不 direct git、不自动 fix/merge/suppress；`CODETEAM_EVAL_ENABLED` 默认 0。
- **W6 人读面（headless M0）**：publish 同事务向 domain system thread 写 verdict 消息（消息是投影，不改 case 状态）；CLI `codeteam eval list/open/overdue/show/accept-sunset` 从 events 派生；`escalated` 进 overdue；W7 projection 落地后 CLI 保留。
- **eval 权限/redaction**：lifecycle 11 transition × actor 写权限矩阵；run token 只能写绑定 case work 的 `fix_recorded`；`cvo_suppressed` operator-only；eval agent 生成自由文本过内容级 secret 扫描；`evals.reasons_json` 必填于 insufficient/no_data/degraded。
- **delete_sunset 两层门**：publish 只校验 `governance.cvoAcceptRequired=true` 声明；执行前必须 operator accept（`codeteam eval accept-sunset`）；未 accept 保持 `open(awaiting-sunset-decision)` 可见态。
- 多 repo / 多 provider 语料。

验收：

- 每个 task 至少记录 outcome、cost、latency、review findings。
- 检索能返回 source ref；派生索引可重建。
- 模型-角色矩阵由数据决定，不靠直觉。
- eval registry 可加载；缺失/非法 domain fail closed；`eval_lifecycle_events` append-only + transition guard；`reviews`/`findings` 不被 eval lifecycle 写入；`insufficient` 不被投影成 healthy。
- W6 启用后 operator 能从 thread/CLI 看见 open/overdue/escalated verdict；`delete_sunset` 提案可见但未 accept 不执行；无 findingKey 的消息明确标“无 case 追踪”。

### W7. Interface / Ops 与 Console M0

**目标**：让 codeteam 可被人和外部系统使用；Console M0 成为真正的 operator 入口。

工作：

- daemon JSON events / HTTP API。
- MCP server：team/memory/workitem/artifact/review。
- CLI：`codeteam task create/status/run`、`codeteam daemon`、`codeteam approval list/show/approve/reject`、`codeteam merge record`、`codeteam merge run`（operator 手动触发/调试；调用同一 merge service，仍走 E1–E5，不绕过 gate；不代表 routine merge 需要 operator）、`codeteam eval list/open/overdue/show/accept-sunset`（W6 headless 读面/operator accept）。
- **Console M0 = 看 + 聊 + 批**：W7a headless API/CLI/事件重放；W7b 前端壳。dogfood 期 C（接入现成 Hub），产品期 A（同构 + 复用/fork 组件）。
- Console M1 后置：创建 thread/task、settings 写操作、retry/cancel、GitHub 链接管理。
- 备份/恢复、schema migration、升级流程。

验收：

- 外部进程能通过 CLI/JSON 驱动一个 task。
- MCP client 能调用 team/memory/workitem tools。
- Console M0 能显示真实 thread/diff/review/聊天/审批；operator 写操作只有 hard-gate approval，routine merge 显示 merge-owner execution status（read-only）；thread chat 是普通消息写入。
- operator 能在 thread 聊天框发消息，消息持久化、可回放；聊天不获得 approval decide / merge-owner 权限。
- `codeteam merge record` 能录入 merge owner merge receipt。
- 升级不破坏现有 SQLite；可回滚。

### W8. Forge Connector（GitHub/GitLab）

**目标**：把 GitHub/GitLab 作为工作入口、证据源和交付出口，而不是 IM 网关。

工作：

- `ForgeAdapter` 接口 + `ForgeEvent` schema。
- GitHub webhook 验签、delivery id 持久化去重、rate limit。
- **webhook 只做触发，GitHub API 做对账真相源**：natural key（repo + issue/PR number）upsert；delivery id 写入 `forge_deliveries`。
- issue/PR/review/check/merge 事件 → task/handoff/inbox；所有进控制面的事件统一权限门禁（maintainer/collaborator 必要条件，label/mention 仅叠加）。
- PR head SHA / CI / review / merge commit → artifact。
- **PR comment / issue → inbox/task 只接受 maintainer/collaborator**；label/mention 不单独放行；其余只读 evidence；正文 untrusted。
- 可选：review verdict / finding / test report → PR comment/check（后置）。
- 权限：GitHub App/token 最小 scope；模型不持有 token；routine merge 由 merge owner 执行，第三方/不可逆 merge 仍由 human/policy gate。
- **GitHub MergeExecutor adapter**：W8 只替换 merge 执行通道（PR merge API + reconciliation）；`merges` receipt、E1–E5 核验、`service:merge-owner` 与 audit 契约不变；`pr_merged` 只作外部观察事实，不作 custody predicate。

验收：

- issue 能创建 backlog item；dispatch 后产生 thread/task。
- PR + CI 能生成 review/verification evidence。
- 有权限的 PR comment 能进入 inbox；无权限 comment 只读。
- 非 maintainer/collaborator 的 issue/comment 不因 label 单独放行。
- 重复/乱序/丢失 webhook 不导致 task 缺失。
- 重启后重放 webhook 命中 `forge_deliveries`，不重复派发。
- 没有 token 泄露到 prompt/log。
- GitHub adapter 与 local adapter 共用 `merges` receipt；不存在第二套 merge 路径；`pr_merged` 观察不替代 receipt。

---

## 4. 实施顺序

```text
W0a 形态确认 + L0 spike + session export + 供应链
  ↓
W1 数据模型（先过继承矩阵）
  ↓
W2 权限/沙箱 + W3 独立 review（并行）
  ↓
W4 clowder SOP 复用 + point gates
  ↓
【dogfood gate：W0–W4 到 merge owner merge 完成】
  ├── W5 A2A/custody + 多 task + RPC（W0b 先完成）
  ├── W6 memory/eval 继承 + 代码适配
  ├── W7a headless → W7b Console（C → A）
  └── W8 forge connector（依赖 W7a）

W0b upstream/CI 治理：与 W1–W4 并行，W5 前完成
```

理由：

- W0a 先定 fork/形态和 L0 是否成立；W0b upstream/CI 治理可并行，不阻塞 dogfood。
- 没有 W1，W3/W5/W7 的数据会散；Console 也没有 thread 数据源。
- 没有 W2，真实 repo 不能安全用。
- 没有 W3，review 只是模型互评。
- W4 依赖 W1 的 stage/artifact。
- W5 依赖 W1/W2 的 lease/sandbox/session。
- W6 依赖 W1 的 run_events/artifacts。
- W7/W8 最后做，避免过早产品化；W8 先做只读 evidence + 权限门禁，再做 outbound comment/check。

---

## 5. 验收总表

| 工作流 | 必须证明 | 验收 |
|---|---|---|
| W0 | fork 与 L0 可运行 | 上游测试 + L0 compaction spike + UPSTREAM/KERNEL_GAPS |
| W1 | 状态可恢复、证据可追溯 | schema migration + crash recovery + artifact hash + thread 数据源 |
| W2 | 真实 repo 安全 | 危险命令/路径/secret 拒绝；sandbox；per-run token；零 secret |
| W3 | review 不是表演 | 身份+modelFamily+fresh+blind+falsifier；FP/recall/survival 达门槛 |
| W4 | 流程不拖慢小改动，routine merge 不需要 operator | 复用 clowder SOP；点状 gate；fast lane 可走；risk 五轴只升不降；merge service（local `MergeExecutor`）+ E1–E5 核验；operator 不在 routine merge 路径 |
| W5 | 多 task 不互相污染 | ADR-043/F117 dispatch queue + A2A 执行链 + F139 schedule + task readiness/DAG；并发/依赖/预算/crash + RPC 三语义 |
| W6 | 记忆可回源、eval 可决策 | source ref + 多 provider 指标 |
| W7 | 外部可驱动、可运维 | CLI/JSON/MCP + Console M0 + merge receipt + 备份/升级 |
| W8 | GitHub/GitLab 工作流闭环 | issue/PR/CI/comment + 权限门禁 + API 对账 + token 安全 |

## 6. 风险

| 风险 | 缓解 |
|---|---|
| 权限 wrapper 仍有逃逸 | 工具实现层 + OS sandbox；真实 repo 用低权用户 |
| review 样本过拟合 | clean/seeded 负对照 + 多 repo + 预注册门槛 |
| 多 task 调度过度复杂 | 先 SQLite 队列 + DAG；不引入分布式队列 |
| 预算失控 | per-task/provider 配额 + pause + human |
| artifact 膨胀 | 内容寻址 + GC + TTL |
| pi 上游漂移 | pin tag + patch list + 上游测试 |
| L0 内容漂移 | 单一真相源 + hash/revision + eval |
| 过早产品化 | 先单 task 闭环，再 console/remote |

---

## 7. 仍需确认

已在 `architecture/0003-review-resolutions.md` 决议的事项不再列为 open：AgentInstance、Console M0、secret、GitHub comment 门禁、design gate、独立 review、Thread 持久化、merge receipt 路径。

仍需确认：

已定：D3=A（MVP 低权 user + bwrap；agent 网络开放为已知威胁边界；目标态 container）；D5=A（A2A tool-call-first：讨论 `a2a_send`，责任转移 `handoff_create`；文本 @ 不作路由权威）；D6=全面复用 clowder SOP（feature/backlog 级 `WorkflowSop` + 风险车道 + 点状硬门禁，不做强制串行状态机）；`DP-MERGE-2=A`（W0–W4 dogfood D-first；local `MergeExecutor` adapter；W8 GitHub adapter）。

1. **C 类自动 merge**：v1 不做；routine merge 按 `DP-MERGE-1=D` 由 merge owner 执行；C 类阈值与回滚策略后置。
2. **多 task 优先级**：FIFO + 显式 priority，还是先做 dependency DAG。
3. **memory 范围**：只做项目证据，还是也做个人偏好；推荐只做项目证据。
4. **memory 检索技术**：先 FTS5，何时引入 hybrid（BM25 + embedding + RRF）。
5. **pi-durable**：W5 的 task graph/readiness 用 `pi-durable`，还是自建 SQLite readiness 表；dispatch queue 固定 ADR-043/F117（F122 历史），不是这个选择。
6. **开源策略**：core MIT + role packs？发布时间与许可。
7. **真实 repo first-run**：只读 / dry-run / 人类确认，哪一个是默认。

> 本清单是开放问题的单一来源；`architecture/0001 §21` 只引用，不复制。

---

## 8. 下一步（本周可做）

1. W0a：外部仓 fork/bootstrap、文档迁移、基线对码报告；建 `UPSTREAM.md` / `KERNEL_GAPS.md` 骨架，跑通上游测试。
2. W0a：写 L0 compiler v0 + compaction/cache spike；断言 L0 在 compaction 后逐字保留；同周验证 pi session 跨进程能力；做 Hub 承载/bwrap/worktree 预检。
3. W1：写 `threads` / `agent_sessions` / `stages` / `run_events` / `artifacts` schema + migration。
4. W2：per-run token + 零 secret + coder permission wrapper fail-closed 测试。
5. W3：review_request 去掉 author model/identity；加 `modelFamily` 校验和盲评。
6. W3：用 5 个真实小 bug 扩 eval 样本，补第二个 reviewer model family。

---

[宪宪/deepseek-flash🐾]
