---
title: "DP-WEB-2: W7b 前端载体 —— 自建 thin Hub vs 继续 classic Hub 兼容"
doc_kind: decision-packet
status: decided
created: 2026-11-21
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
operator_decision: "DP-WEB-2=C (2026-11-21): W7b 自建 thin first-party Hub，参考 clowder Hub 设计；classic Hub 只保留为可选兼容客户端"
related: ["plans/0022-codeteam-web-surface.md", "plans/0029-f016c-m1-execution.md", "docs/architecture/decision-packets/2026-10-25-dp-web-baseline.md"]
---

# DP-WEB-2: W7b 前端载体

## 0. 一句话

W7b 不再把 classic Hub 当主 UI；我们基于 F016c-M1 的 headless API 自建一个**薄的
first-party Hub**，信息架构/密度/交互参考 clowder Hub，classic Hub 保留为可选的
兼容客户端。operator 2026-11-21 已拍 **C**。

## 1. 事实

- classic Hub 是成熟但很重的 Next.js 应用：`packages/web/src/components` 约
  **3,005 个组件文件 / 86k 行**；chat 相关（含 hooks/stores）约 100k 行。
- 把 classic Hub 接到 F016c-M1 daemon 上实测：shell 能起（sidebar/composer），
  但一加载就打了 29 个 M1 之外的 endpoint（`threads/default`、health/ready、
  concierge、game、draft、vote、read receipts…），核心 A2A 聊天不是“截几个
  组件”就能用。
- F016c-M1 headless API 已交付：session、threads、messages、queue/live、
  agents/cats/config、legacy 空壳；850 tests 全绿。API 与 UI 解耦。
- clowder Hub 值得学的是**设计**：暖编辑感 + Linear 精密结构；4px 节奏、
  发丝线、四级表面、单一赭红强调；sidebar/阅读栏/queue/live 的信息层级；
  空态与名片牌等交互细节（见 clowder `DESIGN.md`）。
- 旧 `DP-WEB-1=B` 只决定“classic vs v2”，前提仍是复用 clowder 壳；本 DP
  改变的是更高一层的载体选择。

## 2. 选项

| 选项 | 内容 | 取舍 |
|---|---|---|
| A | 继续 classic Hub 兼容，把 classic 当主 UI | 最快看到成熟 UI；但每个 A2A 能力都要补 compat，UI 不是 A2A-first，real-Hub E2E 一直是门禁 |
| B | 从 clowder-ai 截取所需组件，拼一个 Hub | 看似省；实际会拖入 chatStore/useSocket/api-client/rich 渲染，是大 fork + 上游漂移维护 |
| **C（已拍）** | **自建 thin first-party Hub，参考 clowder 设计；classic Hub 降为可选兼容客户端** | **最小、A2A-first、完全可控；需要自己实现 chat UI；M1 API 全部复用** |
| D | C 为主 + A 的兼容层保留 | C 已包含；classic 兼容作为独立可选项，不进主路径 |

## 3. 决定与后果

- **C**：W7b M0 是 `packages/superagentteam-web` 的 thin Hub；classic Hub 兼容
  作为独立可选轨道，不再是 M2 的前置 gate。
- 新技术栈与承载方式（Vite SPA / daemon 同源静态服务）由 F020 计划评审确认；
  不再默认 Next.js。
- F016c-M2（events）可以按我们自己的 Hub/API 设计；classic Hub 的真实 E2E
  只影响“兼容客户端”这条可选轨道。
- `DP-WEB-1=B` 对 classic/v2 的选择保留为历史；本 DP 覆盖产品 UI 的载体选择。

## 4. 证据

- `docs/plans/0029-f016c-m1-execution.md`（M1 API）
- `docs/reports/2026-11-21-f016c-m1-s5-closeout.md`（M1 交付与 real-Hub 状态）
- clowder `DESIGN.md`、`packages/web/src/components/AppShell.tsx`、
  `ThreadSidebar/ThreadItem.tsx`、`ChatContainer.tsx`、`MessageBubble.tsx`
- W7b thin Hub 调研与计划：`docs/plans/0030-f020-thin-hub-m0.md`

[宪宪/deepseek-flash🐾]
