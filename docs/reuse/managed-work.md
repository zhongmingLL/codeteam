---
cell: managed-work
title: "P0 复用卡：Managed Work"
doc_kind: reuse-card
status: approved
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_signoff: "approved 2026-10-24"
created: 2026-10-24
updated: 2026-10-24
---

# P0 复用卡：Managed Work

## 结论

| 项 | 值 |
|---|---|
| decision | **R1 适配复用** |
| priority | **P0** |
| codeteam W | W1 / W5 |
| 一句话 | 复用 WorkAdmission / WorkAttempt 身份，codeteam 只把它映射到 Task / Run，不造用户可见的工作管理系统。 |
| operator 签字 | [x] 已签（2026-10-24） |

## 覆盖

- canonical: F275
- explicit: F275 / F313
- Batch 0 legacy 归属：backlog/SOP 邻近的 admission/attempt 旧 feature（见 inventory 中 `architecture_cell=managed-work`）。

## Current truth

- **F275**：TTL-0 `WorkAdmission`、unbound attempt 1、authenticated bind-once executor attribution，以及向 invocation/PR/TaskOutcome evidence 的显式传播。
- **admission 是 side effect**：只由既有 eligible development `WorkflowSop` first-persist 触发；普通聊天、问题、探索是 `unmanaged_not_applicable`，不获得 identity。
- **代码面**：`WorkflowSopStore.ts`、`RedisWorkflowSopStore.ts`、`WorkAdmission`、`WorkAttempt`、`workflow_sop_v1`。
- **不采用**：用 thread / latest Episode / branch / timestamp / TaskItem ID / action lease 当 work identity root。

## codeteam mapping

- W1/W5：`Task`/`Run` 持业务身份；`work_admission` / `work_attempt` 只作 server-private 关联，不进入公共 DTO。
- attempt 身份是 W3 falsifier 审计链的承重段；retry 不得复用 run id。
- admission 仍是 `WorkflowSop` first-persist 的 side effect；codeteam 不新增额外表单/审批/猫步骤。
- operator/CLI 创建 task 时先持久化 `BacklogItem` + `WorkflowSop`（first-persist 即 admission 触发），CLI 不绕过 admission 链。
- 只加代码交付需要的 attempt/PR/TaskOutcome 传播；不扩展成通用 workflow engine。
- 不新增：第二套 work identity、用户可见的 work management surface、raw bindings in `TaskItem.automationState`。

## 风险与回滚

- **风险 P1**：把 TaskItem ID 或 thread 当 work identity root，导致重试/换 thread 后身份漂移。
- **风险 P2**：把 managed-work 扩成 workflow engine，和 SOP 告示牌职责重叠。
- **回滚**：W1 只加内部 identity 表/列；回滚到 W1 基线即可，不影响 WorkflowSop 本体。

## Review

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | W1/W5 identity、attempt/recovery | accept（本轮已处置） |
| 砚砚 | server-private attribution、权限边界 | accept（本轮已处置） |
| 墨墨 | 是否产生额外 operator/cat 步骤 | accept（本轮已处置） |
| operator | cell 级决策 | [x] 已签（2026-10-24） |

[宪宪/deepseek-flash🐾]
