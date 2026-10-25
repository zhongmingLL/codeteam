---
cell: approval-index
title: "P0 复用卡：Approval Index"
doc_kind: reuse-card
status: approved
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_signoff: "approved 2026-10-24"
created: 2026-10-24
updated: 2026-10-24
---

# P0 复用卡：Approval Index

> **DP-MERGE-1=D 影响注（2026-10-25）**：Q3 已冻结——approval decide（operator-only）与 merge:execute（daemon service principal，无 MCP/REST 暴露）是两个 auth 面。详见 `../architecture/merge-authority-drift-audit.md` §9。

## 结论

| 项 | 值 |
|---|---|
| decision | **R0/R1 直接复用 + 适配** |
| priority | **P0** |
| codeteam W | W4 / W7 |
| 一句话 | 所有 human gate 只写同一张 approvals 表；operator 是唯一 decide 身份，agent 只能请求。 |
| operator 签字 | [x] 已签（2026-10-24） |

## 覆盖

- canonical: F246
- explicit: F139 / F246 / F260 / F292 / F306
- Batch 0 legacy 归属：授权请求跨渠道通知、Design Gate、Magic Words/愿景 gate 等（见 inventory 中 `architecture_cell=approval-index`）。

## Current truth

- **单一聚合层**：F246 拥有 one shared producer catalog + exhaustive runtime registry；各 producer 把 canonical store 投影成统一 approval item，不能各自造审批中心。
- **双锚与两段状态**：`origin_ref` + `card_ref` 双锚；`resolution(open|accepted|rejected|closed_without_decision)` 与 `materialization(not_started|in_progress|succeeded|failed)` 分离；过期变 stale，不自动 reject。
- **代码面**：`ApprovalPanel`、`ApprovalItemCard`、`ApprovalProvenanceLinks`、`F306ApprovalAdapter`、`DispatchProposalStore`、`F139ApprovalAdapter`。
- **不采用**：聊天里的 approval rich block、agent 通过正文伪造审批、approved 但无 effect proof。

## codeteam mapping

- W1/W4 建 `approvals`；覆盖 critical design / spec_change / merge / blocker / budget-pause；approval decide 只接受 operator credential；routine merge 按 `DP-MERGE-1=D` 由 daemon `service:merge-owner` 执行（无 MCP/REST 暴露）。
- W1 `approvals` 先加 `decided_note` 自由文本；dogfood 期 reject/changes_requested 必须带 note；结构化 F281 why 在 W4+ 接入。
- W7 Hub Approval 面板只读投影 `approvals`；agent 侧只写 request，不写 decision。
- `messages.rich_blocks_json` 的 kind 不含 approval；审批项只能来自 `approvals`。
- 不新增：第二套审批表、agent 可调用的 approve/reject 工具面、自动 merge 路径。

## 风险与回滚

- **风险 P1**：审批请求与决策混在一个 resolution 字段，出现 approved 但未 materialize 的假完成。
- **风险 P2**：过期自动 reject 或聊天卡伪造审批项。
- **回滚**：`approvals` 是新增表；回滚到 W1 基线即可；CLI/Hub 只是投影，不影响其他真相源。

## Review

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | W4/W7 approval adapter、producer registry | accept（本轮已处置） |
| 砚砚 | operator-only 权限、双锚、materialization | accept（本轮已处置） |
| 墨墨 | 审批卡/CLI 体验、过期与提醒 | accept（本轮已处置） |
| operator | cell 级决策 | [x] 已签（2026-10-24） |

[宪宪/deepseek-flash🐾]
