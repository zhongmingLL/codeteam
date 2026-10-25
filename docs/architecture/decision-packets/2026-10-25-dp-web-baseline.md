---
title: "DP-WEB: codeteam W7b 前端复用基线（classic vs v2）"
doc_kind: decision-packet
status: decided
created: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
operator_decision: "DP-WEB-1=B (2026-10-25): W7a C and W7b Console both use classic; v2 deferred"
related: ["plans/0004-w5-w8-scale-product.md#W7", "docs/features/F322-everyday-work-experience.md", "packages/web/src/components/shell/shell-presentation.ts"]
---

# DP-WEB: codeteam W7b 前端复用基线

## 0. 一句话

W7b 的 Console M0 要从 clowder-ai Hub 复用一套 shell；**operator 2026-10-25 已拍 B：W7a C 与 W7b Console 均用 classic，v2 推迟。**

## 1. 事实

- `packages/web` 是 Hub UI（Next.js）；`site/` 是公共官网（landing/docs/community），**不是 Hub，也不参与 W7b 复用**。
- Hub 代码里有两套 presentation：`classic`（默认、frozen）与 `v2`（F322 新壳，`?shell=v2`，in-progress）。见 `packages/web/src/components/shell/shell-presentation.ts`。
- W0a 的 Hub 承载 spike 只验证外部 thread + message + approval 卡能展示；W7a 是 headless API/CLI/事件重放；**W7b 才是产品前端壳**。
- W7b 之前还需要 `thread-chat-surface`/`thread-navigation` 两张 Wave B 架构卡。

## 1.1 版本差异（调研）

| 维度 | `classic` | `v2`（F322 新壳） |
|---|---|---|
| 状态 | 默认、frozen；现有行为保持不变 | in-progress；`main=landed`、`live=dormant`；默认不启用 |
| 入口 | 默认 | `?shell=v2` 或设置/主题菜单；浏览器本地偏好 |
| 布局/导航 | 旧 ActivityBar、sidebar header、chat header 原样 | Café 1.6：窄栏、Café 侧栏、当前 thread 顶栏、新设置导航 |
| Chat | 旧执行栏 + 待处理队列面板；经典消息头部 | 单执行行、新阅读列、名牌/执行/轨迹呈现、typed actions |
| Workspace | `ClassicArtifactsPanel` | `ThreadWorksPanelV2`；Workspace v3 的 tabs/split/diff/git/terminal 方向 |
| 双语 | 不承诺 v2 的中英切换 | 已迁移页面支持中/英；仍有未迁移页 |
| 完整度 | 稳定；现有功能默认可用 | 核账：52 项中 15 真有 / 36 部分 / 1 仍 v1；多项 AC 未签 |
| 已知缺口 | 已冻结，不追加新交互 | Needs Me 动作进待办、日程、能力进化入口、团队首页、插件页 v2；部分设置/Workspace 入口仍在修 |
| 对 codeteam W7b | 风险最低，但 fork 的是冻结壳 | 产品方向一致，但需 readiness gate；未达门槛时 M0 先 classic |

补充事实：

- `ShellPresentation = 'classic' | 'v2'`；默认 classic；切换只影响呈现，不 gate 数据、权限或 store（`packages/web/src/components/shell/shell-presentation.ts:15`、`:25`）。
- F322 2026-10-13 核账明确 15 真有 / 36 部分 / 1 仍 v1；19 行 Alpha 有限 pass，20/52 因样本无效未验（`docs/features/F322-everyday-work-experience.md:25`）。
- v2 已经 landed 但 live dormant；默认仍是 classic（`docs/features/F322-everyday-work-experience.md:641`）。
- v1/classic 保持现状、停止追加改名/改稿；新范围集中在 v2（`docs/features/F322-everyday-work-experience.md:162`、`:166`、`:497`）。
- v2 仍是深分支：Chat/Artifacts/Execution/Composer 等都有 classic/v2 两套呈现；不是单纯换色（如 `ArtifactsPanel.tsx:643`、`ThreadExecutionLayer.tsx:5`、`ChatContainer.tsx:214`）。
- `thread-chat-surface` 明确 shell 只改布局/密度/chrome；socket/history/send/liveness/renderer 仍共享同一 runtime（`docs/architecture/ownership/cells/thread-chat-surface.md` Canonical Owner）。

## 1.2 对 W7b 的含义

- codeteam M0 需要的是 thread/diff/review/chat/approval 的“看+聊+批”，不是 v2 的全部新壳。
- classic 能提供稳定基线，但已 frozen；v2 提供产品方向，但部分面仍未验收。
- 原推荐 A（C=classic / A=v2）；**operator 2026-10-25 拍 B：W7a C 与 W7b Console 都用 classic**。
- 选 B 的理由：优先稳定/冻结基线，v2 仍 in-progress；v1 不把未完成 v2 带进交付。
- v2 仍在演进；后续如需迁移，另开 DP/计划，不在本 v1 范围内。

## 2. 选项

| 选项 | C/dogfood（W7a C 体验） | A/product（W7b Console） | 取舍 |
|---|---|---|---|
| A（原推荐） | `classic` | `v2` | dogfood 用稳定冻结壳；产品 fork 新壳，但需 v2 readiness gate |
| **B（已拍）** | `classic` | `classic` | 风险最低；产品壳冻结，后续迁移 v2 成本另计 |
| C | `v2` | `v2` | 一致性最高；dogfood 被 v2 未完成项拖累 |

## 3. 取舍与最终决定

- A 的原推荐理由：C 用 classic 稳定，A 用 v2 对齐产品方向；但 v2 需要 readiness gate。
- **Operator 2026-10-25 决定 B**：W7a C 与 W7b Console 都复用 classic。理由：classic 默认、frozen、现有功能稳定；v2 仍 in-progress，52 项核账仅 15 真有/36 部分/1 仍 v1，不把未完成 UI 带进 v1 交付。
- v2 不在 v1 范围内；后续迁移另开 DP/计划，不改变 W1 `messages`/`seq`/`DP-BUBBLE-1` 与 W7a API。

## 4. 影响

- W7a C 与 W7b Console 都 fork/reuse classic；v2 不作为 v1 交付。
- W7b 的 shell 证据只验 classic；不再要求 classic/v2 双基线。
- v2 迁移另开计划，不在 W7b 验收内；不改变 W1/W7a server-side。

## 5. 拍板后的后果

- 产品壳沿用 frozen classic；v2 的 UX 改进不进入 v1。
- 后续迁移 v2 需要另开 DP/计划，成本另计。
- 好处：W7a/W7b 单一基线，避免双壳兼容和 v2 未完成项拖累。

## 6. 拍板记录

2026-10-25 operator：`DP-WEB-1=B`。W7a C + W7b Console 均 classic；v2 推迟。

[宪宪/deepseek-flash🐾]
