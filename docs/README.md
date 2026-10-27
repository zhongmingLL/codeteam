---
title: "codeteam 文档索引"
doc_kind: index
status: active
created: 2026-10-21
updated: 2026-10-28
---

# codeteam 文档

这里是 codeteam 项目的架构与计划文档入口。2026-10-26 从 `clowder-ai/codeteam/` 迁入本仓 `docs/`。

**本目录是 codeteam 项目的文档真相源。** 讨论历史和评审记录仍可在 clowder-ai thread 中追溯；README/0001 里出现的“已落地/已证明”是讨论时点声明，开工前需要重新对码基线。

**工作区边界：** 本仓是 codeteam 代码与契约真相源；`clowder-ai/codeteam/` 只保留迁移前的讨论历史，不再作为开发依据。

## 文档

| 文档 | 内容 |
|---|---|
| [`SOP.md`](SOP.md) | 通用开发 SOP（Clowder AI 精简基线；项目特定事实见 `AGENTS.md` / `docs/plans/`） |
| [`architecture/0001-codeteam-architecture-v1.md`](architecture/0001-codeteam-architecture-v1.md) | codeteam 总架构：定位、原则、分层、领域模型、状态机、A2A、SOP、角色、存储、安全、eval、部署、路线图 |
| [`architecture/0002-pi-runtime-integration.md`](architecture/0002-pi-runtime-integration.md) | pi 运行时接入：SDK/RPC/extension/MCP/durable、L0 system prompt、context 注入、tool 策略、fork 边界 |
| [`architecture/0003-review-resolutions.md`](architecture/0003-review-resolutions.md) | 三猫评审决议：P1/P2/P3 处置、独立 review、AgentSession、Console M0、W0/W8 |
| [`plans/0001-runtime-hardening.md`](plans/0001-runtime-hardening.md) | 下一阶段硬化计划：artifact/event schema、权限与沙箱、SOP 复用/Design Gate、多 task、memory、eval |
| [`plans/README.md`](plans/README.md) | W0–W8 执行计划索引、顺序、门禁、评审分工 |
| [`plans/0002-w0-w2-foundation.md`](plans/0002-w0-w2-foundation.md) | W0 fork/L0 spike、W1 数据模型、W2 权限/身份/沙箱 |
| [`plans/0003-w3-w4-review-sop.md`](plans/0003-w3-w4-review-sop.md) | W3 独立 review、W4 SOP 复用/Design Gate |
| [`plans/0004-w5-w8-scale-product.md`](plans/0004-w5-w8-scale-product.md) | W5 调度/RPC、W6 memory/observability/eval、W7 Console、W8 GitHub |
| [`features/F001-architecture-v1.md`](features/F001-architecture-v1.md) | 本次架构讨论的交付契约、验收标准和非目标 |
| [`features/F002-w0a-foundation-gate.md`](features/F002-w0a-foundation-gate.md) | W0a 下游基线与运行时能力验证：L0/session、skill surface、沙箱/Hub 预检、CI/供应链与 W1 入场门禁 |
| [`features/F003-w0c-daemon-lifecycle.md`](features/F003-w0c-daemon-lifecycle.md) | W0c daemon 最小生命周期：boot ledger、单写者 fence、readiness、lifecycle |
| [`features/F004-w1-control-plane-data-model.md`](features/F004-w1-control-plane-data-model.md) | W1 umbrella：字段继承矩阵、schema foundation、F004a–e 交付切片 |
| [`features/F004a-identity-thread-chat-queue.md`](features/F004a-identity-thread-chat-queue.md) | F004a：identity / thread / chat / queue store 与 queue source 唯一性 |
| [`features/F004b-work-sop-artifacts.md`](features/F004b-work-sop-artifacts.md) | F004b：backlog / SOP / managed-work admission / artifacts / inbox 与原子 dispatch |
| [`features/F004c-runs-stages-credentials.md`](features/F004c-runs-stages-credentials.md) | F004c：task/stage/run/event/credential stores、managed-work bindings 与 multi-target queue cutover |
| [`reuse/REUSE-MATRIX.md`](reuse/REUSE-MATRIX.md) | clowder 323 篇 feature 的复用矩阵：以 35 个 ownership cell 为主分类、R0/R1/R2/N1/N2、P0/P1-active/P1-defer/Drop |
| [`plans/0006-clowder-reuse-plan.md`](plans/0006-clowder-reuse-plan.md) | feature 复用盘点执行计划：Batch 0 cell 盘点、Batch 1 P0 10 cells + `sop-bulletin` slice、Batch 2 P1-active 10 cells、Batch 3 P1-defer + Drop |
| [`reuse/README.md`](reuse/README.md) | P0 复用决策卡索引（10 张 cell 卡 + `sop-bulletin` slice，2026-10-24 operator 已签） |
| [`lessons/README.md`](lessons/README.md) | 已交付工作的耐久教训：现象/根因/guardrail 索引 |
| [`architecture/0004-reuse-architecture-review-plan.md`](architecture/0004-reuse-architecture-review-plan.md) | 复用架构梳理计划：Wave A 10 项（A1×4 + A2×3 + A3×3）、Wave B 11 项（4 项已提前 approved，余 7 项待 W4 dogfood）、统一模板、变量口径、批次依赖 |
| [`plans/0005-plan-review-resolutions.md`](plans/0005-plan-review-resolutions.md) | 三猫计划评审 P1/P2 处置与已修正项 |
| [`plans/0007-architecture-plan-coverage.md`](plans/0007-architecture-plan-coverage.md) | 架构卡 / Decision Packet → W 任务/验收/风险覆盖矩阵与缺口修复记录；三猫 accept，冻结为 DP→plans 唯一对账索引 |
| [`architecture/decision-packets/README.md`](architecture/decision-packets/README.md) | 10 个 Decision Packet 索引与签字结论 |
| [`architecture/skill-migration.md`](architecture/skill-migration.md) | 61 个 skill 的迁移矩阵、must-survive 与 W0/W4 门禁 |
| [`architecture/memory-schema.md`](architecture/memory-schema.md) | A3-2 memory 的 index/evidence schema |
| [`architecture/merge-authority-drift-audit.md`](architecture/merge-authority-drift-audit.md) | merge authority D 的漂移审计与六契约 |

## 一句话

**codeteam 是 repo-native、headless-first、durable 的 code agent team runtime：复用 clowder 的风险车道 SOP（告示牌 + 点状硬门禁，猫保留推进权），可替换角色 agent 做判断，git worktree + artifact ledger 保证可恢复、可审查、可验证。**

**设计继承：** 直接沿用 clowder 已被实践验证的 `Message`、`RichBlock`、Ball custody、`Approval Hub`、Mission Hub、Memory/Eval、Skill/SOP，以及 thread 模型；只剔除与代码交付无关的能力（voice、IM 网关、社交 feed、日记等）。**SOP 全面复用 clowder**：`sop-definitions/development.yaml`、feature/backlog 级 `WorkflowSop`、`BacklogItem`、`resumeCapsule`/baton、五轴风险、`merge-gate`/`worktree`/Design Gate/`completion`。复用优先级为 **默认复用 > 适配 > 新建**；新建概念必须说明 clowder 版本为什么不适用，并经 operator 确认。

**速度目标：** 先用已验证能力把 W0–W4 dogfood 跑到 merge 完成（`DP-MERGE-1=D` + `DP-MERGE-2=A`：local merge service 执行 + operator 硬门），再补差异；不用“架构完整性”换交付速度。

## 当前基线

- 控制面：单槽 CAS、one terminal per run、deadline、loop guard、crash recovery、非法转移拒绝。
- SOP：尚未接入；W1 建 `backlog_items`/`workflow_sops`，W4 全面复用 clowder SOP。
- 持久化：SQLite control store，重启 hydrate。
- pi 数据面：`createAgentSession` role-scoped session；coder 持久化，reviewer/verifier fresh in-memory。
- 验证：Phase 1 verifier + permission wrapper；Phase 2 clean/seeded review eval；Phase 3 typed handoff 编排；Phase 4 CLI + CI。
- coder smoke：DeepSeek/Kimi/GLM 三家完成同一 fixture（coder 侧）。
- review smoke：Kimi/GLM 能 approve clean diff、block bad diff；Phase 2 eval 的 reviewer 仅 Kimi，GLM 结论待复核。

## 目标态（本版新增）

- **Operator Surface**：Web Console M0 = 看 + 聊 + 批（thread/时间线/diff/review/聊天/审批），M1 = 建 + 配 + 控；REST/WS 接 daemon。
- **生命周期执行者**：Web Console/API 是产品面；daemon 启停/复验由 target process set 之外的 external executor 执行（W0/W5 = CLI；W7 可加独立 supervisor）。
- **Forge Connector**：GitHub/GitLab 作为工作入口 + 证据源 + 交付出口，不归 IM 网关；comment 只接受 maintainer/collaborator + label。
- **Fork 策略**：full fork + read-only kernel + SDK/extension-first；零 kernel patch 是合法状态。
- **身份与 review**：`AgentProfile` 是稳定身份（对应 clowder catId + CatConfig），`AgentSession` 是执行身份；`Role` 是动态 registry（内置 architect/coder/reviewer/verifier，前端可加 writer 等），不是 TS 闭集。同一 profile 换 session 不算独立 review；独立 review 默认跨 model family。
- **A2A 路由**：已拍板 tool-call-first（`a2a_send` 讨论 / `handoff_create` 控制），文本 `@` 只作可见标记、不作路由权威；见 `plans/0005-plan-review-resolutions.md` §10 D5。
- **调度（A2A 灵魂链）**：复用 `A2A ingress → InvocationQueue/QueueLedgerAdmission → QueueProcessor → AgentRouter → routeSerial/routeParallel → invokeSingleCat → AgentMessage/response/terminal`；codeteam 只把 `invokeSingleCat` 换成 `invokeSingleAgent → pi kernel`。queue 多 recipient 恒 parallel，chain serial 由“每跳独立 source + 单 recipient”结构保证；F139 schedule 触发后仍生成 Queue Entry。不建第二执行队列或 cron poller。
- **存储**：v1 用 SQLite 控制面 + 进程内缓存 + `CODETEAM_DATA_DIR` 文件；不引入 Redis 作为第二真相。daemon 数据/凭据/部署 ledger 固定在仓外目录。
- **Task 系统**：复用 clowder `TaskItem` 底座（kind/subjectKey/title/why/owner/status/relatedFeatureId/dispatchGate/probe/entrustedWork）；codeteam 只加 backlog/repo/worktree/risk/lane/budget；`goal`→`why`，`featureId`→`relatedFeatureId`。
- **SOP**：已拍板全面复用 clowder SOP；作用域为 feature/backlog 级 `WorkflowSop`，猫保留推进权，只锁高风险 gate；见 `plans/0005-plan-review-resolutions.md` §11 D6。
- **执行层**：`Task`/`Run`/`Handoff`/`Artifact` 是 clowder 执行原语的代码交付扩展，不是第二套真相；不另造 queue/custody/message/SOP。见 `architecture/0001 §4.4`。
- **Secret**：v1 agent 零 secret；push/publish/部署交 human/CI。

## 下一步

1. W0a：外部仓 fork + bootstrap + 文档迁移 + 基线对码 + L0 compiler/compaction spike + pi session 能力验证 + 供应链；W0b upstream/CI 治理并行，W5 前完成。
2. W1：`backlog_items`/`workflow_sops` + `stage/run_event/artifact/inbox/review/verification/merge/budget` + `threads/agent_sessions/threadId/headSha`。
3. W2：权限 wrapper 下沉 + 低权 user/bwrap（MVP）/ container（目标态）+ per-run token + 零 secret。
4. W3/W4：独立 review（modelFamily + fresh + blind + falsifier）、Design Gate；W4 全面复用 clowder SOP（D6 已拍板）。
5. W7a：headless API/CLI/事件重放；W7b：Console M0（dogfood C 接入现成 Hub → 产品 A 同构 + 复用/fork 组件）。
6. W8：GitHub Forge connector 只读 evidence + comment 权限门禁 + API 对账。

## Reports

- [pi v1.4.0 baseline verification](reports/2026-10-26-pi-v1.4.0-baseline.md)

---

[宪宪/deepseek-flash🐾]
