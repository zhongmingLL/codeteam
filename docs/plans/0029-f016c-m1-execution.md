---
title: "F016c-M1 — daemon HTTP API / Hub read-write surface"
doc_kind: plan
status: draft-for-review
created: 2026-11-21
updated: 2026-11-21
owner: "宪宪 (DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
feature: F016
source_plan: "docs/plans/0028-f016-w7a-rescope.md"
source_architecture: "docs/architecture/0005-thread-first-runtime.md"
source_chain: "docs/architecture/0007-a2a-runtime-chain.md"
source_report: "docs/reports/2026-10-31-clowder-hub-api-compat.md"
related_features: [codeteam/F016, codeteam/F018]
---

# F016c-M1 — daemon HTTP API / Hub read-write surface

> 本文是 F016c-M1 的执行计划，不写产品代码；实现按切片 TDD + 非作者 review。
> M1 只做 HTTP API；M2 live events、P3 cancel 授权不在本 plan。F016b wait
> 保持 deferred（0028 D1=A）。

## 0. 结论先行

1. **M1 = 让 operator 在 Hub/headless 客户端完成基础 A2A 操作**：看 thread、
   创建 thread、看/发消息、看 queue、看谁在忙；数据源只允许 `f018.db` +
   `OperatorMessageIngress` + agent catalog。
2. **现有 daemon HTTP 只有 `/health`、`/ready`、`/metrics`**；M1 要在现有
   Node HTTP server 上增加最小 `/api` 路由，不引入第二套服务。
3. **`LiveInvocationView` / `QueueView` / `MessageDispatchSummary` 目前只有
   架构/决策文件定义，代码尚未实现**。S0 必须先冻结并落地 M1 需要的读模型；
   `GET /api/threads/:id/live` 不是“接现成 DTO”，而是 M1 的真实交付。
4. **不实现**：SSE/replay、Socket.IO events（M2）、cancel（P3）、legacy
   backlog/approval/workflow SOP 面板（D2=A 先隐藏）。

## 1. 当前代码事实

| 面 | 当前事实 | M1 影响 |
|---|---|---|
| HTTP server | `daemon.ts` 的 `createServer` 只有 `/health`、`/ready`、`/metrics` | 增加 `/api` 路由；复用现有 server/生命周期 |
| 消息写 | `OperatorMessageIngress.submit`；`thread post` CLI 已走它，支持 `--id` messageId replay | `POST /api/messages` 复用同一 ingress；M1 强制 idempotencyKey |
| Thread/message/queue | `ThreadStore` / `MessageStore` / `QueueLedgerStore` 已在 `f018.db` | 直接投影，不读 `control.db` |
| Live invocation | 架构/决策定义 `LiveInvocationView` / `getThreadLiveInvocations`；代码未实现 | S0 落地读模型；`InvocationAttemptStore.listActive` / `QueueLedgerStore.listActive` 可作输入 |
| Browser session | 目前没有 Hub 浏览器 session/cookie/CSRF 层 | S1 增加 console-link session bridge |
| Auth | operator credential 在 CLI；worker 用 child TurnExecution credential | API 写面使用 operator session + CSRF；不复用 worker token |

## 2. M1 endpoint contract

### 2.1 A2A 读/写面

| Endpoint | 数据源 | 说明 |
|---|---|---|
| `GET /api/session` | console-link session | 返回 `{userId, csrfToken}`；Set-Cookie 独立 session；无效/缺失不落 `default-user` |
| `GET /api/threads?view=sidebar` | threads + messages | 最小 sidebar 投影；可先不做 presence/ETag |
| `GET /api/threads/:id` | threads | 404 表示不存在；owner/access 校验 |
| `POST /api/threads` | threads | 最小创建；M1 admission 即要求/生成 idempotencyKey（client id 或 key），同 message append；重复创建不双开 |
| `GET /api/messages?threadId=&limit=&before=` | messages | cursor 适配 message seq/时间；非法 query 返回空页而不是 400 |
| `POST /api/messages` | `OperatorMessageIngress` | 复用 `thread post` 语义；M1 admission 必须要求/生成 idempotencyKey；targets 0 = message-only，1 = 普通 post，>1 = 422 `use_multi_mention`；202 queued |
| `GET /api/threads/:id/queue` | queue + attempts | 断线 reconcile 必需；返回 `{queue, activeInvocations}`；无数据也要 200 |
| `GET /api/threads/:id/live` | attempts + invocations | 落地 `getThreadLiveInvocations`；字段按 0007 §3.10；按 startedAt 升序；过滤 terminal；tracker/durable 去重 |
| `GET /api/agents` | agent catalog | canonical agent 投影；显示/路由候选；不作授权 |
| `GET /api/cats` | same as `/api/agents` | classic Hub alias：`catId = agentId`；仅显示/provenance；不作授权 |
| `GET /api/config` | safe defaults | 最小 UI 默认配置 |

> 所有 thread 级端点（`/threads/:id`、`/messages`、`/queue`、`/live`）必须走
> 同一 owner/access gate；不能只在 thread detail 做校验。S0 冻结这条规则，
> S1/S2/S4 每个端点都带跨 thread/owner 负例。

### 2.2 Legacy 面（operator 2026-11-21：先隐藏）

读端点（backlog / workflow SOP / approval pending/settled / tasks / artifacts /
labels / workspace）：

- 返回 `200` + 空列表 + `disabled:true`；
- UI 一律隐藏或显式降级，不展示空面板。

写端点（approval decide / task write / queue control / edit/delete/recall 等）：

- 返回 `501`（或 `404`，按 endpoint 语义），不返回伪成功。

不读 `control.db` 作为任何 A2A 面的数据源；legacy 只读若要做，另有授权。

## 3. Auth / 安全

- **console-link session**：operator 通过本地 console-link 换取浏览器 session；
  独立 cookie（建议 `superagentteam_session`），HttpOnly/SameSite/Origin
  allowlist；写操作 CSRF。
- **无匿名 fallback**：无 cookie/无效 session 直接 401；不复制 classic 的
  `default-user` fallback。
- **message append idempotency**：M1 admission 必须要求/生成 idempotencyKey；
  复用 `OperatorMessageIngress` 的 messageId replay 语义；重放不产生双消息/
  双 queue。
- **cancel 不在 M1/M2**：`cancel_invocation` 只在 P3 与授权层同 PR；M1 不注册
  该入口。

### 3.1 Error / status mapping（S0/S3 冻结）

| 情况 | HTTP | code |
|---|---|---|
| 无/无效 session | 401 | `unauthorized` |
| CSRF 缺失/不匹配 | 403 | `csrf_failed` |
| thread 不存在 | 404 | `thread_not_found` |
| thread 不属于 operator / 跨 owner | 403 | `forbidden` |
| 多 target 走单条 post | 422 | `use_multi_mention` |
| target agent disabled / unknown | 422 | `agent_disabled` / `target_invalid` |
| queue 满 | 429 | `queue_full` |
| 幂等 key 相同但 intent 不同 | 409 | `idempotency_conflict` |
| 非法 query/body | 400 | `invalid_input` |
| daemon/依赖不可用 | 503 | `unavailable` |
| legacy 写面 | 501 | `not_implemented` |

## 4. 工作拆分

| 切片 | 交付 | 验收 |
|---|---|---|
| S0 | code map + DTO freeze（Thread/Message/QueueView/LiveInvocationView/MessageDispatchSummary 的 M1 子集）+ session/auth 设计 + owner gate / thread-create idempotency / error-status map；产物 `docs/reports/2026-11-21-f016c-m1-s0-freeze.md` | 文档/接口冻结；砚砚 API/security review |
| S1 | 现有 Node HTTP server 上的 `/api` router + console-link session + CSRF/Origin | session 正负例；无 cookie 401；CSRF 负例 |
| S2 | thread sidebar/detail/create | owner/access、404、空 thread、幂等创建 |
| S3 | message list/append | cursor/hasMore、idempotencyKey replay/conflict、非法 query 空页 |
| S4 | queue read + live read + agents/cats/config | `/queue` 200 空读、`/live` terminal 过滤/去重/排序、agents/cats 不作授权、catId 不能替代 agentId |
| S5 | legacy 读空壳/写 501 + contract tests + real Hub/headless E2E | `disabled:true`、501、无 `control.db`、无 `default-user` |

每个切片先红后绿；S1 后可并行 S2/S4，但 S3 必须等 session/CSRF 冻结。

## 5. 验收

- 端到端：headless 客户端完成 session → thread list/create → message append →
  queue/live 读取；真实 Hub 兼容面按 contract test 通过。
- 安全：无 cookie/无效 session 401；CSRF 负例；跨 thread/owner 负例；
  不落 `default-user`。
- Contract：每个 thread 级端点有 owner/access 负例；thread create 与 message
  append 都在 M1 admission 生效幂等；错误码→HTTP status 按 §3.1 表冻结。
- 数据边界：A2A 面只读 `f018.db`；不读写 `control.db`；不恢复 task/custody。
- 幂等：同一 message idempotencyKey 重放不产生双消息/双 queue；不同 intent
  conflict。
- Live：`/live` 过滤 terminal、tracker/durable 去重、startedAt 排序；
  terminal 后不再出现。
- Legacy：读端点 200 空列表 + `disabled:true`；写端点 501；UI 隐藏。
- 非目标：M1 不注册 Socket.IO events、不实现 cancel、不实现 SSE/replay。

## 6. 风险与开放问题

- **Session bridge 是最大未知**：现有 daemon 没有浏览器 session/cookie；
  console-link 的 token 交换、cookie 生命周期、CSRF 存储需要 S0 冻结。
- **DTO 未实现**：`LiveInvocationView` 等只有架构定义；S0 必须先落地字段、
  排序、去重与 evidence rank，避免 M1 边写边改。
- **HTTP 承载**：优先复用现有 Node `createServer` + 小 router；任何新框架/
  新依赖需要单独说明必要性与回滚。
- **Hub 兼容语义**：空读/501 的 `disabled:true` 规则、错误码、分页 cursor
  要一次冻结，避免 UI 多套分支。
- **M2 边界**：M1 不做 events；但 `/queue`、`/live` 的返回形状要为 M2 的
  live event 合并留出稳定字段。

## 7. 非目标

- Socket.IO events / SSE / replay（M2）；
- cancel_invocation / cancel 授权（P3）；
- legacy backlog/approval/workflow SOP 面板与写面；
- 任何 `control.db` 新读写、task-first/custody 回潮；
- Hub v2、Console M0、MCP ingress。

## References

- `docs/plans/0028-f016-w7a-rescope.md`
- `docs/features/F016-w7a-headless-surface.md`
- `docs/reports/2026-10-31-clowder-hub-api-compat.md`
- `docs/architecture/0007-a2a-runtime-chain.md` §3.10
- `docs/plans/0002-w0-w2-foundation.md`（session/auth 历史）

[宪宪/deepseek-flash🐾]
