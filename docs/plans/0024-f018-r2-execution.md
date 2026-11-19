---
title: "F018 — R2 execution plan (same-thread runtime)"
doc_kind: plan
status: in-progress
created: 2026-11-19
updated: 2026-11-19
owner: "砚砚 (GLM 5.3 Flash)"
reviewers: [宪宪 (DeepSeek Flash), 烁烁 (Kimi K3), 墨墨 (Qwen 3.8 Flash)]
feature: F018
source_plan: "docs/plans/0020-f018-thread-first-runtime.md#r2--same-thread-a2a"
source_handover: "docs/reports/2026-11-19-f018-r1-closeout.md"
---

# F018 — R2 执行计划（same-thread runtime）

> 契约源是 `0020 §R2` 与 `0007`/`0010`/`0016`/`0017` 架构文档，本文件只做
> 执行切片，不复制契约。R1 已交付全部 schema/store 层（PR #97–#101），
> R2 在其上组装 runtime。

## 0. 结论先行

- 五片：R2-0（session/history 基座）→ R2-a（dispatch 管线）→
  R2-b（worker/provider/stream）→ R2-c（settlement T1-T4）→
  R2-d（retry/recovery + 出口收口）。
- 全部从 `superagentteam-work` 开短命分支 PR；作者砚砚不自审。
- 复用优先（operator 指令）：能改造 Clowder 源码/契约的照 A 面复用；
  本计划 §4 是复用地图。

## 1. 切片

### R2-0 session/history 基座（本片）

- `AgentSessionStore`：`bindPiSession` / `replacePiSession` /
  `createNextActive`（0010 §6，R1-c 显式延后）；`seal`→`sealActive`
  命名对齐；`recordUserVisibleOutput` 对齐 0010 契约字面
  （首可见输出仅 0→1，per-turn 计数归 `recordCompletedTurn`）；
  `recordResumeFailure` 返回 `{session, failures}`。
- `AgentReadStateStore` ack/rewind 已在 R1-a 落地；本片补
  `HistoryAssembler`（0007 §3.5.1：bootstrap/incremental、可见性过滤、
  processing-R boundary cap、load 不 ack）与 `buildThreadPrompt`
  （0020 R2：thread/participants/recent；无 `# Task`）。
- R1 移交：`WorkerStore.retireIdle` 时间注入；guard 注释与实现不符修正
  （#101 review P3）。
- 本计划文件随本片落地。

### R2-a dispatch 管线

- `AgentRouter`：operator 正文显式 `@`（R1-a mention 原语）→ targets；
  `enabled=false` / 未知 id / account 缺失 typed reject；空 targets
  typed reject；`deletedAt` thread 拒绝 post（0020 R2 门禁）。
- `QueueProcessor`：admission（cap 5 / urgent / FIFO，R1-b store 已有）
  + Phase A 单事务（parent InvocationRecord + 全部 claimed target 的
  attempt `starting` + `markStarting` 执行互斥）+ Phase A 整批失败
  defer 不写 delivery_failure（0010 §6.1.3 失败矩阵）。
- Phase B per-target 独立事务：processing R + `TurnExecution.createRunning`
  + `bindAppended` + credential mint + draft create + `retireTargets`
  （0010 §6.1.1 步骤 4）；Phase B 失败写 delivery_failure、target 保持
  pending 可重试。

### R2-b worker + provider + stream

- `WorkerPool.ensure/checkCapacity`（容量 backoff、单 reaper）；
  真实 pi RPC worker 接入 + mock provider 双层；`warmTtl=0` turn 后
  retire；`worker_spawn_ms`/`worker_busy_ms`/`worker_evicted_count`。
- attempt `bindWorker` / `markPromptDelivered`（boundarySeq 与
  promptDeliveredAt 一起持久化，0007 §3.5.1 ack 时序）。
- `WorkerEventSink`：`message_update.text_delta` + tool start/end →
  `response_drafts` 全量 snapshot（0017）+ ephemeral `AgentStreamEvent`；
  首次可见输出 → `recordUserVisibleOutput`。
- R1 移交：`reserveToolCallClaim` 强 CAS（多写者）。
- stream flush 节奏 benchmark 后定（provisional 100ms/4KB，0010 遗留#5）。

### R2-c settlement T1–T4

- T1 `invoke-single-agent` + `TurnExecutionLifecycle`：child terminal +
  `projectChildTerminal` + `settlement='response_pending'` + credential
  terminalize + `recordCompletedTurn`/cursor ack（`promptDelivered` 条件，
  同一事务）。
- T2 `RouteResponseCommitter`：R terminal + settle inputs + delete draft +
  attempt `settled` + clear pending + A2A successor。
- T3 `QueueProcessor` + collector：parent aggregate + queue/tracker slot。
- T4 `ResponseRecoveryService`：`response_pending`/`response_missing`
  recovery；`settleResponseFromDraft` 只属于 T4。
- 0020「验证与 review」的单写者/双状态负例/崩溃窗口测试矩阵在本片
  落齐（生产代码不引入 `settleAgentTurn`）。

### R2-d retry / recovery / 出口

- target-level `requestRetry`（Clowder route recovery 语义，不新建 queue
  entry/用户消息）+ pre-handoff bounded backoff（base 10s / 上限 1h）。
- startup protected reaper（`processStartedAt+1`）、zombie 收敛链
  （child R→queue→parent→credential→slot）、`response_missing` recovery、
  provider exit 5min grace + owner fence。
- 出口 E1/E2/E7/E9/E12/E13/E18/E19/E22 证据（真实 pi RPC + mock provider
  双层）+ R2 close-out 报告 + R3 移交清单。

## 2. 每片出口（统一）

- `NODE_ENV=development npm run build:offline` 通过。
- 受影响测试全绿；新行为先 RED 后 GREEN。
- `check-legacy-boundary` + `check:doc-index` + `git diff --check` 通过。
- 非作者 review 覆盖 exact HEAD；merge 到 `superagentteam-work`。

## 3. review 分工

| 片 | reviewer | 理由 |
|---|---|---|
| R2-0 | 宪宪 | 0010 §6 / 0007 §3.5.1 契约对齐是主风险面 |
| R2-a | 宪宪 | Phase A/B 事务边界与失败矩阵 |
| R2-b | 烁烁 + 宪宪 delta | worker/provider 集成面 + 契约面 |
| R2-c | 宪宪 + 烁烁 | settlement 单写者矩阵 |
| R2-d | 墨墨 + 宪宪 | 出口验收/文档 + recovery 契约 |

## 4. 复用地图（operator：复用优先，快速推进）

| 能力 | Clowder 参照 | 复用面 |
|---|---|---|
| mention 解析 | `a2a-mentions.ts` | A：R1-a 已直改落地 |
| delivery cursor 语义 | `DeliveryCursorStore` | A：R1-a 已落（单调 CAS/rewind） |
| history 组装 | `ContextAssembler`/`assembleIncrementalContextInternal` | A：本片 HistoryAssembler 按 0007 §3.5.1 改造（去 smart window/seen/mention overlay） |
| retry | `retryRoutingTarget` | A：R2-d 按同语义改造，不复制 cloud fresh-source 路径 |
| worker 池 | `AcpProcessPool` | 借鉴 + 新写（0010 §6.1.4：pi 无 session/new/load，ephemeral 一 worker 一 session，不可照搬长驻池） |
| settlement 四层 | Clowder invoke/route/queue/recovery 拆分 | C：0007 §3.6/§3.9 契约照抄，代码按 SuperAgentTeam store 新写 |
| credential/claims | invocation credential 家族 | A：R1-c 已落 |

## 5. 风险

| 风险 | 处置 |
|---|---|
| SQLite 单写者事务边界 | Phase A/Phase B、T1–T4 按契约拆事务，不合成大事务（0021 同款） |
| worker/provider E2E 不稳定 | mock provider + 真实 pi RPC 双层；fake clock；失败重试有界 |
| prompt 格式演进 | R2-0 只落契约要求的最小面；R2-b 真实 RPC 后按 benchmark 调 |
| messageCount 语义变更波及 | R2-0 已同步更新 R1-c 测试；契约字面（0010 §6）为准 |
| claim 多写者 | R2-b 强 CAS；R2-a/b 先单 daemon 进程假设 |

[砚砚/glm-5.3-flash🐾]
