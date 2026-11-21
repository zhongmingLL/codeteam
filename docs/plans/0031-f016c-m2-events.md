---
title: "F016c-M2 — event invalidation + history refetch"
doc_kind: plan
status: accepted
created: 2026-11-21
updated: 2026-11-21
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [墨墨 (Qwen 3.8 Flash), 砚砚 (GLM 5.3 Flash)]
feature: F016
source_decision: "DP-WEB-2=C (2026-11-21)"
source_plans: [0029-f016c-m1-execution.md, 0030-f020-thin-hub-m0.md]
related_features: [superagentteam/F020, superagentteam/F021]
---

# F016c-M2 — event invalidation + history refetch

> F020 M0 已用 2s/10s polling 交付可用 Hub；F021 已收 projectPath/relogin/
> 长 thread/busy-live 证据。M2 只解决“变化发生后尽快通知客户端”，不把
> HTTP 真源改成事件账本。classic Hub 真实 E2E 留在可选 compat task。

## 0. Decision Packet

| ID | 问题 | 选择 | 取舍 |
|---|---|---|---|
| `DP-M2-1` | 第一方 Hub 的实时传输 | **A. SSE invalidation channel**（推荐） | Browser-native EventSource、同源 cookie、自动重连、零新依赖；单向通知足够。Socket.IO 只在 classic compat 确有消费者时做适配层 |
| `DP-M2-2` | 事件语义 | **A. invalidation + HTTP refetch**（推荐） | 事件只带 thread/topics；消息/queue/live 仍以 HTTP 为唯一真源，避免事件 payload 版本、排序、replay 账本 |
| `DP-M2-3` | 断线/过期 | **A. 重连后全量 refetch + polling fallback**（推荐） | 不做 Last-Event-ID/replay log；M0 轮询保留为降级路径 |
| `DP-M2-4` | CORS | **A. 第一方同源不做 CORS**；compat 轨道单独 opt-in（推荐） | 不引入通配 CORS；classic Hub 直连时才需要 credentials + origin allowlist |

`DP-M2-1..4` 是推荐方案；若 review 认为 classic Hub 必须保留 Socket.IO，
只在 compat 轨道加适配层，不改变第一方 SSE 契约。

## 1. 目标与非目标

**目标**

- 活跃 thread 的 message/queue/live/thread 变化在本地 E2E 中 ≤500ms 通知到客户端；
  UI 用现有 store 的 HTTP refetch 收敛。
- SSE 不可用时自动回落到现有 2s/10s polling，不白屏、不谎报实时。
- 事件不成为第二真相源：没有 replay log、没有 delta patch、没有事件版本缓存。
- 收掉 0029 的 deferred P3s：rich replay canonical JSON、CORS/compat 边界、
  Hub projectPath/mentions 事实记录位置。

**非目标**

- Socket.IO 第一方依赖、SSE replay/Last-Event-ID、多客户端 read state。
- 全局多 thread 事件、cancel、rich cards/attachments、approval、未读。
- F016b wait；classic Hub 真实 E2E；CORS 通配。

## 2. 服务端契约

### 2.1 Endpoint

`GET /api/events?threadId=<threadId>`（SSE）

- 仅活跃 thread；使用现有 browser session cookie + origin allowlist。
- 401/403 在建立 stream 前返回 JSON；EventSource 只看到 error，客户端再探测
  `/api/session` 决定是否 relogin。
- 200 headers：`content-type: text/event-stream`、`cache-control: no-cache`、
  `connection: keep-alive`、`x-accel-buffering: no`。
- 连接后先发 `event: ready`，然后每 15s 发注释心跳 `: ping`；断连清理 subscriber。

### 2.2 Event envelope

```text
event: change
data: {"threadId":"thread:...","topics":["messages","queue","live"],"at":1795250000000}
```

- `topics` 只允许 `messages | queue | live | thread`。
- 事件是**失效信号**：客户端收到后调用对应 store 的 `refresh()`/detail refetch；
  事件 payload 不携带消息正文、queue entry 或 live 详情。
- 一次业务提交可以合并 topics；同一 thread 的 burst 可由客户端 50–100ms debounce。

### 2.3 发布点（commit 之后）

- message append/update/terminal（用户消息、响应消息、软删除）；
- queue enqueue/claim/retire/terminal；
- tracker start/terminal（live pill 与“已受理”占位）；
- thread title/participants/lastActive 变化。

实现上引入 daemon-scoped `EventPublisher`（内存 bus），在 domain service
成功提交后 publish；失败事务不 publish。具体 hook 点由 S1 以测试钉住，
不允许在 HTTP route 里用“收到请求”代替业务提交。

## 3. Web 契约

- `domains/events`：EventSource client + `useThreadEvents(threadId)` hook。
- 收到 `change`：
  - `messages` → chat store `refresh()`（保留 latest-window replace/seq 守卫）；
  - `queue`/`live` → a2a store `refresh()`；
  - `thread` → thread detail/thread list refresh。
- SSE 连接建立后，active thread 的 2s 轮询降为 30s 安全刷新；断线/error 恢复 2s。
  threads/agents 的 10s 轮询暂不变（M2 不做全局事件）。
- reconnect/open 时全量 refetch 一次；页面 visibility 恢复时再 refetch 一次。
- 连接状态只做轻量降级提示（例如 “实时更新不可用，使用轮询”），不阻塞发送。

## 4. 切片

| Slice | 范围 | 验收 |
|---|---|---|
| M2-S0 | 契约冻结：endpoint/headers/envelope/topics/hook 点/fallback；canonical JSON 设计 | 本 plan review；类型与测试骨架 |
| M2-S1 | daemon EventPublisher + SSE route + auth/origin/heartbeat/cleanup；message/queue/live hook | SSE integration：401、ready、change、断开清理；HTTP 仍是真源 |
| M2-S2 | web EventSource + refetch 编排 + polling fallback + 401 探测 | mock EventSource 单测；断线 fallback；无重复请求 |
| M2-S3 | busy live / queue / message E2E + 浏览器 smoke；事件延迟 | 本地 ≤500ms；无轮询重叠；401 回 relogin |
| M2-S4 | canonical rich JSON replay identity；compat/CORS 决策记录；F016 close 证据 | rich replay 等价测试；compat 未决项挂账 |

## 5. 验收

- 发送消息后 message/queue 事件到达；worker 运行/结束时 live 事件到达；
  断线后自动 reconnection，fallback polling 仍能收敛。
- 事件不丢失也不重复影响状态：重复 refresh 幂等；旧 thread 事件不落入新 thread
  （existing requestSeq/threadId 守卫）。
- 401/403 不进无限 EventSource reconnect 循环；客户端探测 session 后进 relogin。
- 无新 runtime 依赖、无通配 CORS、无 `control.db` 读写、无 legacy task/custody。
- canonical rich JSON：同语义 rich（key 顺序不同）replay 身份一致；不同内容仍 conflict。
- F016 umbrella：events + history refetch 收敛；classic compat contract 仍未完成时
  显式标为可选轨道并记录，不冒充已交付。

## 6. 风险

- **代理缓冲**：Vite/反向代理可能缓冲 SSE；headers + 本地 smoke 验证，必要时关闭代理缓冲。
- **HTTP/1.1 连接数**：单 active thread 一条 stream，可接受；不做每 thread 一条。
- **事件风暴**：worker 流式输出可能频繁变化；M2 只 publish message/queue/live
  状态级变化，不做 token delta；客户端 debounce。
- **顺序**：事件不排序、不带版本；客户端以 HTTP 最新窗口为准，旧响应由 store 守卫丢弃。
- **classic Hub**：若 compat 需要 Socket.IO，单独适配，不污染第一方契约。

## 7. Plan review 折叠项（S1/S2 验收）

- **S1 hook 覆盖双路**：事件发布点不只挂 browser route；operator ingress 与
  A2A tool-service 的 message append/queue 变化必须同样 publish，且都在业务
  commit 之后。
- **S1 heartbeat 验 session**：15s heartbeat tick 顺带验证 session 仍有效；
  失效即 close stream，客户端走既有 401 探测/relogin 路径，不让过期 session
  继续收事件。
- **S2 事件错误决策树**：ES error → probe `/api/session`；401 → close ES +
  relogin；session 200 → 不 relogin，fallback 2s polling + ES 有限退避重连
  （daemon 不可用时禁止每秒重连风暴）。
- **S2 降级提示双向对应**：SSE 正常时不显示“实时更新不可用”；真实 fallback
  时不静默，提示与实际连接状态一一对应。
- **S2 代理缓冲 smoke**：Vite/反向代理下验证事件不被缓冲；必要时调整响应头
  或代理配置并记录。

## References

- `docs/plans/0029-f016c-m1-execution.md`
- `docs/plans/0030-f020-thin-hub-m0.md`
- `docs/features/F016-w7a-headless-surface.md`
- `docs/features/F020-thin-hub-m0.md`
- `docs/features/F021-thin-hub-m05-hardening.md`
- `docs/architecture/0007-a2a-runtime-chain.md`

[宪宪/deepseek-flash🐾]
