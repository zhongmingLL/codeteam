---
cell: callback-auth
title: "P0 复用卡：Callback Auth"
doc_kind: reuse-card
status: approved
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_signoff: "approved 2026-10-24"
created: 2026-10-24
updated: 2026-10-24
---

# P0 复用卡：Callback Auth

> **DP-MERGE-1=D 影响注（2026-10-25）**：approval decide 仍 operator-only；routine own-PR merge 由 daemon `service:merge-owner` 执行，per-merge short-TTL credential 绑 `(repo, PR, exact HEAD)`，mint 前置 = daemon E1–E5 核验，执行后撤销。详见 `../architecture/merge-authority-drift-audit.md` §9。

## 结论

| 项 | 值 |
|---|---|
| decision | **R1 适配复用** |
| priority | **P0** |
| codeteam W | W2 |
| 一句话 | invocation credential 与 agent-key principal 复用 clowder 生命周期；codeteam 只做 per-run token 适配。 |
| operator 签字 | [x] 已签（2026-10-24） |

## 覆盖

- canonical: F174 / F178
- explicit: F178 / F247 / F265 / F298 / F325
- Batch 0 legacy 归属：security hardening、trust boundary、callback/agent-key 相关旧 feature（见 inventory 中 `architecture_cell=callback-auth`）。

## Current truth

- **F174**：invocation ID、callback token、验证失败原因、Redis registry、refresh endpoint、telemetry 与用户可见 auth failure surface。
- **F174 现行细节**：per-run token 只存 hash+salt；active 无短 TTL；latest slot；refresh 是 heartbeat/verify，不换 token；liveness 两段式（candidate + independent proof + exact runId fence，unknown retain）。
- **F178**：persistent `agent_key` principal，独立于 invocation credential；registry TTL/rotation/revocation 与 sidecar reconciliation 由它拥有。
- **代码面**：`InvocationRegistry`、`AgentKeyRegistry`、`AgentKeySidecarProvisioner`、`callbackToken`、`callback-auth`、`AuthFailureReason`。
- **不采用**：把 callback auth 当 session identity、route-local token map、文件存在即视为 credential health。

## codeteam mapping

- W2：per-run token 复用 F174；agent 运行时零 secret，密钥由 Host/sidecar 管理。
- token registry 用 SQLite 实现 F174 语义：`invocation_credentials` 含 `token_hash`/`token_salt`/`last_refresh_at`/state；active 无短 TTL；terminal tombstone 30d；latest-slot CAS。
- liveness v1 证据 = `run_events` 最新事件时间 + daemon 可见 worker 子进程存活 + exact runId；`runs.status` 不作 proof；W5 再加 worker lease。
- MCP/callback 工具复用 typed `AuthFailureReason` 与 refresh/fallback 路径；不把 401 字符串匹配散落在各 route。
- MCP 工具面的 identity/exposure 派生语义由本卡 P0 覆盖；F286 的 resource lifecycle/marketplace 治理留 P1-active。
- operator credential 是独立鉴权域；approval decide 只接受 operator credential；routine merge 按 `DP-MERGE-1=D` 由 daemon `service:merge-owner` 执行（无 MCP/REST 暴露），run token 访问 approval decide 返回 403。v1 = `operator.key` 0600 + auth.sqlite 公钥/哈希；W7 用 `auth console-link` loopback-only 短时效 session token（同源 principal，不同载体）。
- `deployment-wait/register` 等 agent 侧具名 route 必须进 per-run allowlist；agent-key 契约 P0、签发 P1，v1 不建 `agent_keys` 表。
- 不新增：第二套 token registry、agent-key 文件直写、retry 替代 auth design。

## 风险与回滚

- **风险 P1**：把 callback auth 与 roster/session identity 混在一起，破坏 review 独立性与权限边界。
- **风险 P2**：agent-key sidecar 文件存在但 registry 已失效，产生假健康。
- **回滚**：W2 只消费 clowder auth 契约；回滚到 per-run token 基线即可，不触碰 clowder registry。

## Review

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | W2 token/sidecar、callback route | accept（本轮已处置） |
| 砚砚 | 权限域隔离、零 secret、失败可见性 | accept（本轮已处置） |
| 墨墨 | operator 可见的 auth failure 体验 | accept（本轮已处置） |
| operator | cell 级决策 | [x] 已签（2026-10-24） |

[宪宪/deepseek-flash🐾]
