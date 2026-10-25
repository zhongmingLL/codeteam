---
cell: runtime-deployment
title: "P0 复用卡：Runtime Deployment"
doc_kind: reuse-card
status: approved
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_signoff: "approved 2026-10-24"
created: 2026-10-24
updated: 2026-10-24
---

# P0 复用卡：Runtime Deployment

## 结论

| 项 | 值 |
|---|---|
| decision | **R1 适配复用** |
| priority | **P0** |
| codeteam W | W0 / W5 |
| 一句话 | 复用 deployment identity、frozen build target、daemon ownership 与 per-boot readiness；codeteam 只加自己的 daemon 生命周期，执行者固定在 target process set 之外。 |
| operator 签字 | [x] 已签（2026-10-24） |

## 覆盖

- canonical: F300 / F323
- explicit: F323
- Batch 0 legacy 归属：runtime startup、liveness、carrier、desktop installer 等（见 inventory 中 `architecture_cell=runtime-deployment`）。

## Current truth

- **ADR-039 / F300**：deployment/daemon module 拥有 identity-verified serving process set、frozen source/build target、daemon record、lifecycle operation 与 verification facts；不创建第二套 process registry。
- **F323**：per-start identity/version/ready/exit observations 落在同一 owner；loopback-only Web-readiness writer；authenticated operation provenance 与 offline status adapter 是后续 Phase。
- **F323 Phase B 已撤回、Phase C 三态页面未实现**：codeteam 不把“未来会有”当现成契约；W7 Web Console/API 是产品面，但生命周期执行仍由 external executor 承担。
- **代码面**：`RuntimeDeploymentLedger`、`daemonStatePaths`、`resolveRuntimeDeploymentRevision`、`beginOwnedRuntimeDeployment`、`RuntimeDeploymentObservationProvider`。
- **不采用**：把磁盘 HEAD 当 serving revision、把 PID/SHA/caller label 当授权、把 ready runtime 当 Task 完成。

## codeteam mapping

- W0/W5：codeteam daemon 复用 deployment identity + frozen build target + per-boot readiness；activation/recovery 走 reviewed lifecycle。W0 最小子集 = daemon 身份 + readiness + 最小 lifecycle 记录；完整 boot history/授权/复验是 W5。
- 生命周期执行者：W0/W5 = `codeteam` CLI；W7 = Web Console/API 只发 intent/approval，由独立 supervisor/controller 执行。目标 backend 不 self-restart；不暴露通用 shell。
- deployment wait 复用 F280 typed await，挂在原 work Task 上；readiness 不直接调猫、不直接关闭 Task。
- W7a 的 daemon API/事件重放只消费 deployment facts；不另建 controller/status 数据库。
- 不新增：第二套 process registry、第二套 boot history、用 source ref/SHA/PID 代替 operator 授权。

## 风险与回滚

- **风险 P1**：把 checkout HEAD 与 serving artifact 混为一谈，导致“已部署”误报。
- **风险 P2**：ready/exit observation 未持久化就对外承诺；缺失证据必须显示 unknown。
- **风险 P1**：auth.sqlite 不可读时连 halt 都做不了；必须只读打开 + `--degraded-auth` 仅同 OS uid 的 halt 路径，restart 授权不接受 degraded。
- **风险 P2**：`revision_included` 混入目标仓 sha；predicate 只接受 daemon build 来源仓 sha。
- **回滚**：W0/W5 只消费现有 deployment ledger；回滚到单进程 daemon 基线即可，不影响 clowder 部署记录。

## Review

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | W0/W5 daemon、frozen target、恢复 | accept（本轮已处置） |
| 砚砚 | operator 授权、进程所有权、离线状态面 | accept（本轮已处置） |
| 墨墨 | operator 可见的 readiness/部署证据 | accept（本轮已处置） |
| operator | cell 级决策 | [x] 已签（2026-10-24） |

[宪宪/deepseek-flash🐾]
