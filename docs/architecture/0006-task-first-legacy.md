---
title: "codeteam Task-first legacy inventory"
doc_kind: architecture
status: legacy-inventory
created: 2026-11-04
updated: 2026-11-04
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related_features: [codeteam/F017, codeteam/F018]
---

# codeteam Task-first legacy inventory

> **用途：阻止旧 Task-first 实现误导新开发。** 2026-11-04 operator 选择 C：
> v1 = 纯 A2A runtime。现有 Task-first code delivery/custody 实现不是新架构的
> 参考实现，也不再是 v1 的运行路径。本文给出具体识别、状态标记和后续处置。
>
> 新开发只以 `docs/architecture/0005-thread-first-runtime.md` 和 F018 为准。
> 本文列出的旧模块/表/工具/feature 不得作为“现状应该这样”的依据。

## 状态标记

| 标记 | 含义 | 允许的动作 |
|---|---|---|
| `legacy-frozen` | 旧实现冻结 | 只有阻挡 A2A runtime 的 bug 才修；不扩展、不重构、不新增字段 |
| `legacy-read-only` | 历史数据保留只读 | 迁移/审计可读；v1 runtime 不读不写、不双写 |
| `retired` | 从运行面移除 | 不注册、不保留 alias；代码可在 R5 清理 |
| `future-redesign` | 能力可能以新设计回归 | 必须另立 feature，从 A2A runtime 出发；不得复活 Task-first |

## 1. 运行时模块

| 模块 / 路径 | 旧职责 | 标记 | v1 处置 |
|---|---|---|---|
| `packages/codeteam-daemon/src/dispatch/service.ts`（`resolveRoute` / `cutoverEntry` / `assertDeliveryReady` / `assertBudgetAdmission` / `deploymentWaitGuard` / `managedWork`） | task-first dispatch、admission、cutover | `legacy-frozen` | 新建 thread dispatch path；旧 path 停写 |
| `scheduling/provisioning.ts`、`scheduling/readiness.ts`、`scheduling/worktree-pool.ts`、`scheduling/budget.ts` | task/session/worktree/budget provisioning | `legacy-frozen` | v1 不调用；`ensureThreadSession` 另写 |
| `review/`、`merge/`、`gates/`、`sop/`、`managed-work/`、`deployment-wait/`、`custody/` | code delivery 的 review/merge/SOP/custody | `legacy-frozen` | v1 不运行；后续能力另立 feature |
| `a2a/tools.ts` 的 `a2a_send` / `handoff_*` handlers | 旧 A2A/custody 工具 | `retired` | v1 不注册、不调用、不留 alias |
| `auth/mint.ts` 的 task-scope token 路径 | task/run/session token | `legacy-frozen` | 新 token 绑 invocation/thread |
| `workers/executor.ts`、`workers/prompt.ts`、`workers/tool-policy.ts`、`workers/harness.ts` 的 task-bound 分支 | task worktree + task prompt + task policy | `legacy-frozen` | v1 用 thread session/prompt/policy |
| `cli/task.ts`、task read models、task CLI | task 创建/准备/查询 | `legacy-frozen` | v1 不依赖；保留历史只读 |
| `control/stores/tasks.ts`、`runs.ts`、`handoffs.ts`、`custody.ts`、`budgets.ts`、`reviews.ts`、`merges.ts`、`worktree-leases.ts`、`schedules.ts`、`waits.ts`、`inbox.ts`、`backlog.ts`、`workflow-sops.ts`、`sop-check-evidence.ts` | 旧 control-plane stores | `legacy-read-only` | v1 不读不写；R5 再决定归档/删除 |

## 2. 数据表

以下表标记 `legacy-read-only`；v1 runtime 不读不写、不双写，迁移/审计可读：

- 旧 agent 身份：`agent_profiles`、`roles`；v1 由 `.codeteam/agent-catalog.json`
  的 AgentConfig + AgentRegistry 取代；
- 工作项/SOP：`tasks`、`stages`、`backlog_items`、`workflow_sops`、
  `sop_check_evidence`、`work_admissions`、`work_attempts`、
  `run_managed_work_bindings`、`task_managed_work_bindings`；
- 执行：`runs`、`run_events`；`workers` 本身是 active runtime，不在 legacy 列表；
- custody：`handoffs`、`handoff_holder_claims`、`custody_events`；
- 审批/等待：`approvals`（task-bound）、`waits`、`wait_terminations`；
- review/merge：`reviews`、`findings`、`verifications`、`merges`；
- 资源：`budgets`、`budget_charges`、`worktree_leases`；
- 调度/评测：`schedule_specs`、`schedule_runs`、`evals`、
  `eval_lifecycle_events`、`forge_deliveries`；
- 其他：`inbox`、`artifacts`（task-bound 部分）。

旧列同样标记 `legacy-read-only`，不得新增语义：

- `agent_sessions.task_id`
- `agent_sessions.profile_id`（目标列 `agent_id`）
- `agent_sessions.role`
- `invocation_credentials.task_id`
- `messages.task_id`
- `queue_entries.source_record_id`
- `a2a_requests.task_id`
- `runs.role` / `workers.role`

## 3. 工具面

| 工具 | 标记 | 处置 |
|---|---|---|
| `codeteam_a2a_send` | `retired` | v1 不注册；不保留 alias |
| `codeteam_handoff_create` | `retired` | 同上 |
| `codeteam_handoff_claim` | `retired` | 同上 |
| `codeteam_handoff_complete` | `retired` | 同上 |
| `codeteam_handoff_withdraw` | `retired` | 同上 |
| `codeteam_thread_context` | active | v1 保留；只读 thread context |

## 4. Feature

| Feature | 状态 | 标记 | 说明 |
|---|---|---|---|
| F004 / F004d | done | `legacy-frozen`（task/custody/budget 部分） | core thread/message/queue 仍 active；task/custody/budget store 只读 |
| F005 / F005a-e | done | `legacy-frozen`（task-bound token/policy 部分） | identity/sandbox primitives 可复用；task scope 不沿用 |
| F006 | done | `legacy-frozen` | independent review；v1 不运行 |
| F007 | done | `legacy-frozen` | SOP gates；v1 不运行 |
| F008 | done | `legacy-frozen` | A2A dispatch/custody；旧工具面 retired |
| F010 | done | `legacy-frozen` | scheduling/budget/worktree；v1 不运行 |
| F011 | done | `legacy-frozen` | lifecycle/managed work/deployment wait；v1 不运行 |
| F015 / F016a | done | `legacy-frozen` | A2A/custody E2E 历史证据；不作为 v1 验收门 |
| F016b / F016c | in progress | re-align | wait/API 按 thread/invocation 重新对齐 |
| F017 | phase-a-archive | historical | 只保留 feature 级历史；ADR-0001/0002 与 plan 0019 已移除 |

## 5. 后续处置

| 阶段 | 动作 |
|---|---|
| R0 | 本文入库；F018 feature/plan 链接本文；不再对 legacy 模块加新功能 |
| R1 | 停新 task dispatch；drain/seal 有 running invocation 的 session；旧表只读；不双写 |
| R1 | 建 `.codeteam/agent-catalog.json` + accounts；AgentRegistry 取代 `agent_profiles`；旧 `roles`/profile 表只读 |
| R2 | v1 worker registry 注册 A2A 四工具；旧 `a2a_send`/`handoff_*` 不注册 |
| R5 | 旧 code delivery 代码归档/清理；历史数据保留只读 |
| 未来 | code delivery 是否重设计或弃用另立 feature；必须从 A2A runtime 出发 |

## 6. 不要做

- 不要把旧 Task-first 代码/测试当作 A2A runtime 的参考实现；
- 不要把 `agent_profiles` 或 `roles` 表当成新 agent 身份真相源；
- 不要给 legacy 表加字段、补旧 path 的功能或重构；
- 不要复活 `a2a_send` / `handoff_*`，也不要加兼容 alias；
- 不要为了“旧 E2E 绿”重新打开 task-first dispatch；
- 不要把旧 feature 文档当作当前架构真相源；
- 不要在新 feature 里默认 Task/worktree/review/merge/custody 仍然存在。

[宪宪/deepseek-flash🐾]
