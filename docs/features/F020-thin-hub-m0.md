---
feature_ids: [superagentteam/F020]
related_features: [codeteam/F016]
title: "F020: W7b thin Hub M0"
status: in_progress
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [墨墨 (Qwen 3.8 Flash), 砚砚 (GLM 5.3 Flash), 烁烁 (Kimi K3)]
vision_guard: 墨墨 (Qwen 3.8 Flash)
created: 2026-11-21
updated: 2026-11-21
source_decision: "DP-WEB-2=C (2026-11-21)"
source_plan: "docs/plans/0030-f020-thin-hub-m0.md"
---

# F020: W7b thin Hub M0

> W7b Console M0 独立立项，不属于 F016（F016 是 W7a headless surface）。
> operator 2026-11-21 拍 `DP-WEB-2=C`：自建 thin first-party Hub，参考
> clowder Hub 设计；classic Hub 只保留为可选兼容客户端。

## 进度

- H0 脚手架（Vite/React/tokens/API client/session/relogin）已合入 `46b0cd19`。
- H1 shell/sidebar/threads（AppShell、线程列表/搜索/创建、路由、10s 轮询）已合入 `5ae478aa`。
- H2 chat/composer（消息历史、发送 202、receipt 驱动 pending、2s 最新窗口轮询、
  invalid cursor 重拉、纯文本/代码块安全渲染、draft/retry、thread detail、
  shared polling backoff、dialog focus trap）已合入 `cf653a86`。
- H3 queue/live/agents（queue strip、live pill、agent 弹层与目标选择、
  “已受理未开口”占位、active thread 进行中点）在 review。
- H4 打磨、H5 daemon 承载随后。

## Why

F016c-M1 已把 daemon 侧 A2A 读面做好（session/threads/messages/queue/live/
agents/config），但 operator 还没有一个真正可用的本地面。classic Hub 很成熟，
但 3,005 个组件、86k 行、与 Clowder 状态面深度耦合；实测接到我们的 daemon 上
仍会打 29 个 M1 之外的 endpoint。继续兼容它会让每个 A2A 能力都背上 compat 债。

## 目标

- 一个本地单用户、A2A-first 的 Hub：能看 thread、发消息、看 queue、看谁在忙、
  看 agent 状态。
- 视觉/交互参考 clowder Hub 的成熟设计：暖纸 + 发丝线 + 单一强调色；
  sidebar → 阅读栏 → composer 的安静工作区；状态用文字 + 圆点，不靠颜色 alone。
- 只依赖 F016c-M1 headless API；M0 不引入 Socket.IO/rich cards/approval 等重面。

## 范围（M0）

- App shell：sidebar + 阅读栏 + composer；窄屏 sidebar 抽屉。
- threads：列表、搜索（标题过滤）、创建（必须真实 projectPath）、选择/空态。
- chat：历史消息、发送、queue receipt、processing 占位、idempotent retry。
- queue/live：queue strip、live status pill；M0 用轮询，不造事件。
- agents：目标选择器 + 全局状态（idle/working/offline），per-thread 看 `/live`。
- session：console-link → cookie；401 重连页；无 `default-user` fallback。
- 空/加载/错误态、键盘焦点、深浅色 token（暗色可 M0.5）。

## 非目标

- rich cards、attachments、whisper、approval、memory/mission/signals/workspace/
  artifacts、labels/pinning/grouping、games/bootcamp、multi-shell、Socket.IO
  events、cancel、multi_mention UI。
- 不 import daemon 内部 store/runtime；不读 SQLite；不复制 clowder 的 feature-ID
  目录或 runtime 依赖。

## 验收

- 无 session 打开 → 重连页；console-link → Hub 加载，`/api/session` 200。
- 创建 thread（真实 projectPath）→ 出现在 sidebar；空态/无 projectPath 有明确提示。
- 发送消息 → 202 queue receipt；消息出现在时间线；双击不双发（idempotencyKey）。
- queue strip 显示位置；`/live` 显示 agent/status；agents 状态可见。
- 全程无 `control.db`、无 `default-user`；M1 endpoint 无 404。
- 1440/1024/390 布局可用；键盘可完成发消息；对比度/焦点环达标。

## 依赖与计划

- 计划：`docs/plans/0030-f020-thin-hub-m0.md`
- API：`docs/plans/0029-f016c-m1-execution.md`（M1）
- 目录/边界：`docs/plans/0022-codeteam-web-surface.md`（栈由 F020 计划评审确认）
- 决策：`docs/architecture/decision-packets/2026-11-21-dp-web-2-thin-hub.md`

[宪宪/deepseek-flash🐾]
