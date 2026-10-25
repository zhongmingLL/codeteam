---
cell: identity-session
title: "P0 复用卡：Identity / Session"
doc_kind: reuse-card
status: approved
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_signoff: "approved 2026-10-24"
created: 2026-10-24
updated: 2026-10-24
---

# P0 复用卡：Identity / Session

## 结论

| 项 | 值 |
|---|---|
| decision | **R0/R1 直接复用 + 适配** |
| priority | **P0** |
| codeteam W | W0 / W1 / W7 |
| 一句话 | 稳定身份 = AgentProfile（对应 catId + CatConfig），执行身份 = AgentSession；同一 profile 换 session 不算独立 review。 |
| operator 签字 | [x] 已签（2026-10-24） |

## 覆盖

- canonical: F032 / F088 / F136 / F171 / F183 / F211 / F231 / F262 / F291 / F296 / F299 / F320 / F322
- explicit: F024 / F195 / F208 / F211 / F225 / F231 / F247 / F262 / F291 / F296 / F299 / F306 / F318 / F319 / F320 / F325
- Batch 0 legacy 归属：cat management、session continuity、config hot reload、external agent/provider 接入等（见 inventory 中 `architecture_cell=identity-session`）。

## Current truth

- **稳定身份**：clowder 的猫 = `catId` + `CatConfig`（name/displayName/provider/model/roleDescription/restrictions）；没有 `CatInstance` 实体。
- **执行身份**：session/invocation 承载本次 thread、task、provider/model、piSessionId、context continuity；Session Chain / bootstrap / capsule 负责跨 session 恢复。
- **Role**：`type Role = string` 的动态 registry；内置 architect/coder/reviewer/verifier，前端可加 writer 等；`human` 是 `actorKind`，不是 Role。
- **代码面**：`AgentRegistry`、`SessionChainStore`、`ContextEpochOwner`、`cat-config`、`runtimeSession`、`CAT_CAFE_DATA_DIR`、`cat-cafe-profile`。

## codeteam mapping

- `AgentProfile` 对应 clowder `catId`/`CatConfig`；`AgentSession` 对应 cat session/invocation；`Run` 绑 `agentSessionId`。
- W1 建 `roles` / `agent_profiles` / `agent_sessions`；`AgentProfile.role` 是 primary role，`AgentSession.role` 可不同。
- W7 Console M1 创建/编辑 role 与 profile；L0/启动胶囊复用 clowder 的分层注入，不另造 context store。
- review 独立性看 profile + session + modelFamily，不看 role；同一 profile 换 session 仍不算独立。
- 本卡 P0 范围 = 身份形状（`catId` + `CatConfig`）+ session 连续性 + role 动态 registry；F231/F296/个人记忆 lane 不在本卡范围（见 `memory` 卡与 Drop 表）。
- 不新增：`AgentInstance`、第二套 session/context store、闭集 Role 枚举。

## 风险与回滚

- **风险 P1**：把 profile 与 session 合成一个有生命周期的实例，重演 `AgentInstance` 的状态复杂度。
- **风险 P2**：把 callback auth 当 session identity，或把 role 当身份；两者都会破坏 review 独立性/鉴权边界。
- **回滚**：`roles` / `agent_profiles` / `agent_sessions` 是新增表；回滚到 W1 基线即可；L0 注入可回退到 clowder 现有 capsule。

## Review

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | W0/W1 schema、session chain、迁移 | accept（本轮已处置） |
| 砚砚 | 身份/权限边界、callback auth 分界 | accept（本轮已处置） |
| 墨墨 | W7 Console 创建/编辑 role 与 profile | accept（本轮已处置） |
| operator | cell 级决策 | [x] 已签（2026-10-24） |

[宪宪/deepseek-flash🐾]
