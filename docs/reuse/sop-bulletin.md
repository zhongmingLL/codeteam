---
cell: sop-bulletin
title: "P0 复用卡：SOP Bulletin（P0 slice）"
doc_kind: reuse-card
status: approved
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_signoff: "approved 2026-10-24"
created: 2026-10-24
updated: 2026-10-24
---

# P0 复用卡：SOP Bulletin（P0 slice）

> 这不是第 36 个 ownership cell，而是跨 `hub-action-surface` + `managed-work` 的 P0 切片。cell 级分档仍以 35 行为准；本卡只锁定 W0–W4 首闭环需要的 SOP 数据契约。

## 结论

| 项 | 值 |
|---|---|
| decision | **R0 直接复用契约** |
| priority | **P0 slice** |
| codeteam W | W1 / W4 |
| 一句话 | `WorkflowSop` + `BacklogItem` 是 SOP 告示牌的真相源；codeteam 复用契约和 CAS，board/rich-block UI 不做。 |
| operator 签字 | [x] 已签（2026-10-24） |

## 覆盖

- 相关 features：F073（SOP Auto-Guardian）、F015（Backlog 管理）、F040（Backlog/Feature 聚合）、F049/F058/F076（Mission Hub，仅 SOP 数据面）。
- 契约：`WorkflowSop`（`workflow-sop.ts:23`）、`BacklogItem`（`backlog.ts:59`）、`sop-definitions/development.yaml`、`codeteam_update_workflow` / `get_workflow_sop`。
- 明确不含：Mission Hub board、rich-block 组件、Console 时间线（归 `hub-action-surface` P1-active）。

## Current truth

- **WorkflowSop 是告示牌，不是控制器**：`backlog_item_id` 为 key；stage ∈ `kickoff/impl/quality_gate/fresh_context/review/merge/completion`；有 baton / nextSkill / resumeCapsule / checks / version（CAS）。它不做 stage 迁移校验。
- **BacklogItem 是 feature/backlog 级作用域**：完整枚举 `open → suggested → approved → dispatched → done`；`suggested` 是猫/agent 申领入口。dogfood 期 operator create 允许直落 `dispatched`（复用 clowder import 语义，audit 记 actor），不另发明状态。`tasks.backlog_item_id` 必须存在，`codeteam task create` 缺 item 时 fail closed。
- **completion 在 feature/backlog 级**：task 完成只产生 merge receipt，不自动把 `workflow_sops.stage` 推到 `completion`；`stage=completion` 只能由 completion gate 证据 + operator 确认写入。
- **代码面**：`packages/api/src/domains/cats/services/stores/ports/WorkflowSopStore.ts`、`RedisWorkflowSopStore.ts`、`backlog.ts`、`sop-definitions/development.yaml`。

## codeteam mapping

- W1：`backlog_items` + `workflow_sops` 两表；`backlog_items` 全字段复用（含 `lease` / `audit` / `dependencies`；lease 守卫 dogfood 期单 writer 可空转，W5 起启用）；`tasks.backlog_item_id` 必填；`thread_events.kind` 含 `backlog_item_open/suggested/approved/dispatched/done` 与 `workflow_sop_updated`；W1 task 3 的 thread event kind 枚举以本卡为准。
- W4：`codeteam backlog create/dispatch/list`、`codeteam_update_workflow`、`get_workflow_sop`；`update_workflow` 走 CAS version，不接受 stage 控制器语义。
- 权限：backlog 的 `create/approve/dispatch/reclaim` 只接受 operator credential（或经 `approvals`）；agent 侧只能经 `a2a_send(proposal)` 提交申领（→ `suggested`），无 dispatch 权；`codeteam task create` 由 operator/CLI 调用。与 W2 三 auth 域矩阵一致。
- checks 写边界：agent 经 `update_workflow` 只能写 `attested` + stage/resumeCapsule/nextSkill/baton；`checks.*=verified` 只能由对应 gate 的机器证据在 daemon 侧回写。
- W5 DAG 直接消费 `backlog_items.dependencies`；`tasks` 不再另造 `dependsOn` 列。
- F073 的主题归属仍是 `managed-work`（inventory 不改 cell），但 SOP 契约本体由本卡负责；`managed-work` 只保留 admission/attempt identity。
- 不新增：第二套 SOP 状态机、第二套 backlog、board UI 反向成为流程真相源。

## 风险与回滚

- **风险 P1**：把 `WorkflowSop` 写成串行状态机，重演 D6 否决的 workflow node 模型。
- **风险 P2**：`tasks.stage` 与 `workflow_sops.stage` 同名混用；`tasks` 只保留 lane 快照，gate 不以 stage 迁移触发。
- **回滚**：`backlog_items` / `workflow_sops` 是新增表；回滚到 W1 基线即可；board/UI 不随本卡进入 P0。

## Review

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | W0/W1 schema、F073 归属、CAS | accept（补审 P2-1/P3 已修） |
| 砚砚 | 权限、completion gate、fail-closed | accept（补审 P2-1/P2-2/P3 已修） |
| 墨墨 | SOP 告示牌语义、operator 体验 | 提案人；accept proposal |
| operator | cell/slice 级决策 | [x] 已签（2026-10-24） |

[宪宪/deepseek-flash🐾]
