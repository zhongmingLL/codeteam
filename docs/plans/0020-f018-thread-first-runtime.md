---
title: "F018 — A2A runtime v1 实施计划（R0-R5）"
doc_kind: plan
status: draft
created: 2026-11-04
updated: 2026-11-04
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
feature: F018
source_architecture: "docs/architecture/0005-thread-first-runtime.md"
source_decision: "operator 2026-11-04 C: v1 = pure A2A runtime"
---

# F018 — A2A runtime v1 实施计划

> 本计划执行 `docs/architecture/0005-thread-first-runtime.md` 的 R0-R5。
> v1 只做纯 A2A runtime；TaskItem/code delivery/custody 不在本计划。
> 所有阶段共享单 queue/message/session 账本，不造第二套 store。

## R0 — 文档冻结与真相源切换

- F017 Phase A 标记 `phase-a-archive`；F017 plan 0019 归档。
- F018 feature + 本 plan；BACKLOG 加 F018 行。
- 按 operator 2026-11-04 决定移除 F017 的 ADR-0001/0002 与 plan 0019。
- README / plans 索引更新；旧 code delivery feature 标 frozen/legacy。
- 出口：`check:doc-index` 通过；docs-only；不写产品代码。

## R1 — Schema 与迁移

- `threads`：`created_by`、`project_path`、`goal_json`。
- `thread_participants`、`thread_member_effort`。
- `agent_sessions`：thread×profile 单 active；`task_id` legacy。
- `runs` → invocations：`execution_kind` 保持 `ordinary|routing_guard`；无 taskId。
- `invocation_credentials`：无 taskId。
- `a2a_requests`：`thread_id` + `task_id` nullable；unique
  `(thread_id, profile_id, request_id)`；drop 旧 task-level unique。
- 旧 `tasks`/`handoffs`/`custody_events`/`budgets`/`reviews`/`merges` 冻结 legacy，
  不读不写。
- 迁移前 drain/seal 有 running invocation 的 session；跳过 running，等 terminal。
- 出口：旧 code path 停写；新 A2A schema 可写；migration up/down 可回滚。

## R2 — Same-thread A2A

- `ensureThreadSession(threadId, profileId)`：一个 thread×profile 一个 active
  session、`workingDirectory=thread.projectPath`。
- `buildThreadPrompt`：thread/participants/recent；无 `# Task`。
- tool policy：沿用现有 profile/sandbox policy；v1 不新增限制；A2A runtime
  不重新定义权限模型。
- dispatch thread branch：thread-scoped queue、invocation、token；不调用
  budget/deployment/managed-work guard。
- 出口：E1/E2/E7/E9/E12/E13；真实 pi RPC + mock provider。

## R3 — Cross-thread A2A

- `codeteam_cross_post_message`：target threadId、targets、thread access、
  depth/loop guard、typed rejects。
- `codeteam_multi_mention`：2-3 targets fan-out；one message + one queue entry +
  N invocations；不做聚合回调。
- 任意 active profile 可被 target；首次成功后加入 participants。
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

## 回滚

- R1：drop 新列/新表；旧部署 + 旧 schema 快照恢复。
- R2/R3：停 A2A runtime；旧 code delivery 不双写。
- R4/R5：保留 migration down + 数据快照。

[宪宪/deepseek-flash🐾]
