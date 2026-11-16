---
title: "codeteam web surface — future directory design (W7b)"
doc_kind: plan
status: draft-for-review
created: 2026-11-16
updated: 2026-11-16
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [墨墨 (Qwen 3.8 Flash), 砚砚 (GLM 5.3 Flash), 烁烁 (Kimi K3)]
feature: F018
related_plans: [0020-f018-thread-first-runtime.md, 0021-f018-r1-execution.md]
---

# codeteam web surface — future directory design

> 这是 W7b Console 的前置目录设计，不是 R1 实现。R1/R2 只交付 daemon/CLI 与
> domain contract；web 通过 headless API/WS 消费 `@codeteam/shared`，不 import
> daemon 内部 store/runtime。

## 0. 参考

Clowder `packages/web` 使用 Next.js App Router + React + Zustand +
socket.io-client；`packages/shared` 提供跨 surface 类型/纯工具；`packages/api`
提供 headless API。codeteam 借同一分层，不复制 Clowder 的 feature-ID 目录。

## 1. 目标目录

```text
packages/codeteam-web/
├── src/
│   ├── app/                         # 只做路由/页面组合
│   │   ├── (chat)/thread/[threadId]/page.tsx
│   │   ├── agents/page.tsx
│   │   ├── settings/page.tsx
│   │   └── layout.tsx
│   ├── domains/                     # 业务域，不用 feature ID
│   │   ├── thread/
│   │   │   ├── components/
│   │   │   ├── hooks/
│   │   │   ├── stores/threadStore.ts
│   │   │   └── api/threadApi.ts
│   │   ├── chat/
│   │   │   ├── components/
│   │   │   ├── hooks/useThreadStream.ts
│   │   │   └── stores/chatStore.ts
│   │   ├── a2a/
│   │   │   ├── components/
│   │   │   ├── hooks/
│   │   │   └── stores/liveInvocationStore.ts
│   │   ├── agent/
│   │   │   ├── components/
│   │   │   └── stores/agentCatalogStore.ts
│   │   └── settings/
│   ├── components/
│   │   ├── ui/                      # 设计系统基础组件
│   │   └── layout/                  # AppShell/Sidebar
│   ├── lib/
│   │   ├── api/                     # typed API client，使用 shared DTO
│   │   ├── ws/                      # 事件流/重连
│   │   └── format/
│   ├── stores/                      # 只放跨域状态：app/theme/toast
│   ├── hooks/
│   ├── types/                       # 只放 web-only 类型
│   ├── utils/
│   ├── styles/
│   └── test-support/
├── test/
│   ├── browser/                     # E2E
│   └── unit/
└── package.json                     # @codeteam/web；depends on @codeteam/shared
```

## 2. 边界

- Web 只 import `@codeteam/shared` 和 headless API/WS；不 import
  `@codeteam/daemon` 内部 store/runtime。
- `domains/*` 拥有各自的 components/hooks/stores/api；全局 `stores/` 只放
  app shell 级状态。
- `app/` 只做路由和组合，不写业务逻辑。
- 富消息/流式/重连使用 `shared` DTO：processing R + draft + terminal R；
  `lib/ws` 负责 baseline/buffer 协议。
- 未来 MCP/CLI/其他 surface 复用 `@codeteam/shared`，不复制 web 类型。
- 如果最终不用 Next.js，`app/` 换成 Vite 路由即可；`domains/`/`lib/`/
  `components/ui` 不变。

## 3. 数据流

```text
@codeteam/shared types/DTO
  → lib/api (HTTP)
  → domain api/client
  → domain store/hook
  → components

daemon event stream
  → lib/ws
  → domain store
  → components
```

## 4. 测试

- Unit：Vitest + Testing Library，domain store/hook 优先。
- E2E：browser tests 覆盖 thread 创建、发送、流式回复、重连、queue/live
  invocation、multi_mention aggregate/callback 状态。
- Contract：web API client 与 `@codeteam/shared` 类型/schema 对齐；不 mock
  daemon 内部 store。

## 5. 阶段

- R1/R2：不建 web；只保留 `@codeteam/shared` 与 headless API DTO。
- W7a：headless API/CLI/事件重放。
- W7b：`packages/codeteam-web` 落地；先 thread/chat，再 agents/settings/live。
- W7b 之后：多 surface（MCP/其他）复用 shared。

## 6. 非目标

- 不在 web 里直接访问 SQLite/daemon 内部 store。
- 不复刻 Clowder 的 feature-ID 页面目录。
- 不把 web-only UI 状态塞进 `@codeteam/shared`。

[宪宪/deepseek-flash🐾]
