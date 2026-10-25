---
cell: plugin
title: "P0 复用卡：Plugin"
doc_kind: reuse-card
status: approved
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_signoff: "approved 2026-10-24"
created: 2026-10-24
updated: 2026-10-24
---

# P0 复用卡：Plugin

## 结论

| 项 | 值 |
|---|---|
| decision | **R1 适配复用** |
| priority | **P0** |
| codeteam W | W0 / W4 |
| 一句话 | 复用 skill surface（manifest schema 参考 + curated 白名单经 pi resourceLoader）；package admission / grants / activation / supervised runtime 随 marketplace 留 P1-defer。 |
| operator 签字 | [x] 已签（2026-10-24） |

## 覆盖

- canonical: F202 / F247 / F285 / F290 / F292
- explicit: F202 / F247 / F265 / F285 / F290 / F292 / F306 / F317 / F326 / F328
- Batch 0 legacy 归属：skills discovery、capability board、MCP normalization、pack/marketplace 等（见 inventory 中 `architecture_cell=plugin`）。

## Current truth

- **F202**：terminal Plugin Manager + Host plugin control plane；manifest validation、package admission、installation inventory、config readiness、authorization projection、activation intent、supervised runtime state 都在一个 `PluginManagerService`。
- **F285**：official-plugin seam 仍归 Host；外部 contribution 只是候选资源，不等于 identity/installation/permission/health/execution authority。
- **代码面**：`PluginRegistry`、`PluginResourceActivator`、`PluginInventoryStore`、`HostBrokerControlPlane`、`plugin.yaml`、`PluginConfigPanel`。
- **不采用**：把 manifest 当权限、把 verified package 当 live runtime、把 community code 加载进 API process。

## codeteam mapping

- W0/W4：只复用 skill surface（`plugin.yaml` manifest schema 参考 + curated 白名单加载路径，经 pi resourceLoader）；package admission / grants / activation intent / supervised runtime 不进入 v1。
- Config/auth/intent/live 四轴保持正交；Console/REST/Agent 都走同一个 application service。
- Marketplace / catalog discovery 留 P1-defer；codeteam v1 不做插件市场。
- 不新增：第二套 plugin registry、route-local 插件管理、外部 executable 进 API process。

## 风险与回滚

- **风险 P1**：把 manifest / enabled flag 当运行时活着，出现假健康。
- **风险 P2**：仓库本地、official、connector 三套 manager 再次分叉。
- **回滚**：回滚到 pi resourceLoader 白名单基线即可，不迁移 plugin 数据。

## Review

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | W0/W4 loading、Broker、resource activation | accept（本轮已处置） |
| 砚砚 | package admission、grants、代码隔离 | accept（本轮已处置） |
| 墨墨 | Console/Agent plugin 管理体验 | accept（本轮已处置） |
| operator | cell 级决策 | [x] 已签（2026-10-24） |

[宪宪/deepseek-flash🐾]
