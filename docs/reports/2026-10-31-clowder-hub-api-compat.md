---
title: "clowder-ai Hub / API 兼容面调研 — W7a S1/S2"
doc_kind: report
status: reviewed
created: 2026-10-31
updated: 2026-10-31
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash)]
baseline: "codeteam-work @ 901f49f98"
reference: "clowder-ai @ 5f8965e1e04dd3ac194cba53fa484bbc994d2dcd (read-only local reference)"
feature: "F016 umbrella / F016c (discovery; scope signoff pending)"
related:
  - "docs/features/F016-w7a-headless-surface.md"
  - "docs/plans/0018-f016a-a2a-ingress-e2e.md"
  - "docs/reports/2026-10-31-f016-a2a-dispatch-tool-priority.md"
  - "docs/reports/2026-10-27-f002-w0a-preflight.md"
  - "docs/plans/0004-w5-w8-scale-product.md#W7"
  - "docs/architecture/decision-packets/2026-10-25-dp-web-baseline.md"
scope: "read-only investigation; docs-only deliverable; no product code changes"
review_disposition: "烁烁 F1-F9 与砚砚 S1-S8 已折入；砚砚授权折完直接 cross-post 主 thread"
---

# clowder-ai Hub / API 兼容面调研 — W7a S1/S2

> 本文只做调研与决策建议。没有修改 clowder-ai，也没有写 codeteam 产品代码。
> 所有 clowder 路径均为参考仓的 repo-relative 路径，不引入运行依赖，不读
> clowder 数据库。结论直接回答：**F016c S1/S2 先实现哪些 endpoint/event、
> 哪些 defer；W7b 复用 classic 的哪一层。**

## 0. 结论先行

1. **classic Hub 的传输是“同源 `/api` + Socket.IO”，不是 REST + SSE。**
   Next.js 把 `/api`、`/socket.io`、`/uploads` 反代到 API；浏览器侧用
   HttpOnly session cookie，Socket.IO 握手只认这个 cookie，不认
   `handshake.auth.userId`。Hub 里唯一与 `text/event-stream` 相关的现有代码是
   audio proxy，不是 thread/event 总线。
2. **clowder 的“事件重放”实际是 snapshot/history 追平，不是 WS replay log。**
   服务端只给 `agent_message` 注入 thread-scoped `seq` + 实例 `seqEpoch`；
   客户端发现 gap/epoch change 后调用 `GET /api/messages?threadId=...` 全量重取，
   按 message id 合并。代码里明确写了“没有 fromSeq ranged replay”。因此
   W7a S2 不应先造事件日志/replay endpoint；应造 **durable history + live
   events + seq watermark + refetch**。
3. **F016c W7a S1 的最小 Hub 兼容面是 7 组 endpoint，外加一个必须的 queue 诚实空读：**
   session、thread list/detail、message list/append、cat/config 壳数据、
   backlog list、workflow-sop 读投影、approval pending/settled + decide，
   以及 `GET /api/threads/:id/queue`。后者不是 Queue 面板功能，而是断线
   reconcile 的必需读面。其余 endpoint 先返回诚实的空读或显式 501/404，
   不从 UI 假装支持。
4. **F016c W7a S2 的最小事件面是：** `join_room`/`leave_room`、
   `cancel_invocation`（client→server）、`agent_message`、`intent_mode`、
   `spawn_started`、`thread_updated`、`proposal_created`/`proposal_updated`。
   `queue_updated` 与其余 execution/控制类事件 defer；SSE defer。
5. **W7b 应直接复用 classic 的 chat runtime + 渲染层：** `useSocket`、
   `useChatHistory`、`useAgentMessages`、`chatStore`、`ChatMessage`、
   `RichBlocks`、`ThreadSidebar`、`MissionControlPage`/`WorkflowSopPanel`。
   `AppShell`/ActivityBar、cat/config 设置面、Approval producer 分发、
   queue/execution 控制面需要 fork/适配；`v2` 不进 v1。
6. **Approval Hub 是当前最大的兼容缺口。** classic 的
   `ApprovalFeatureBadge` 直接查封闭的 `APPROVAL_FEATURE_IDS`；未知
   `sourceFeatureId` 会得到 `undefined` metadata 并在渲染时崩。F002 的
   thread/message/rich-card 结论仍成立，但“Approval Hub 不需要 clowder 改动”
   只适用于 thread 内 rich card；要让 codeteam approval 进入 classic
   Approval Hub 面板，需要 clowder 侧最小容错/注册改动，或 W7b fork。
   零 clowder 改动的替代是 B'：thread interactive 选择以普通 message 发回，
   由 codeteam 解释为 decide；Approval Hub 面板保持为空，必须显式标注降级。
7. **P0 实现缺口：** message 幂等键、thread 的 `createdBy`/`participants`/
   `lastActiveAt` 投影、`WorkflowSopView` → 扁平 `WorkflowSop`、console-link
   session → 独立 cookie/CSRF、socket 无 cookie 隔离、`cancel_invocation`
   映射、以及 composition-root 事件总线；不是“再加几个 route”就能完成。
8. **不伪造兼容：** 不把 codeteam approval 标成 `F193` 等现有 producer，
   不把 profile 伪装成 clowder cat，不读 clowder DB，不把 SSE/replay 写进
   W7a 的承诺。

## 1. 基线与方法

### 1.1 基线

| 项 | 值 |
|---|---|
| codeteam 基线 | `codeteam-work @ aba19b7e7` |
| clowder 参考仓 | `clowder-ai @ 5f8965e1e04dd3ac194cba53fa484bbc994d2dcd`，只读 |
| Hub shell | `classic`（默认、frozen）；`DP-WEB-1=B` 已拍 W7a C 与 W7b 都用 classic |
| Socket.IO | server/client 均 `4.8.3`（`socket.io` / `socket.io-client`） |
| Fastify | `4.29.1` |
| Next.js | `14.x` |
| 调研边界 | Hub/API/事件/Console 承载；A2A/MCP dispatch 另见 `docs/reports/2026-10-31-f016-a2a-dispatch-tool-priority.md` |
| 交付 | docs report + endpoint/event/DTO 矩阵 + gap/授权清单 + contract test 计划；无产品代码 |

### 1.2 方法

- 读 clowder classic 的 API client、Socket.IO 客户端、`useChatHistory`、
  `useAgentMessages`、`chatStore`、Approval 组件与 Fastify route；
- 读 codeteam 的 schema、store、CLI、daemon composition root 与 W7 计划；
- 用现有 F002 Hub spike 报告校准“已经证明什么、还缺什么”；
- 本文没有运行真实 Hub E2E，也没有启动 clowder 服务；contract test 是计划，
  不是已执行证据。静态代码结论都带路径/行号，便于 reviewer 复核。

### 1.3 F016 / F016c 边界

`docs/features/F016-w7a-headless-surface.md` 已定义 F016 umbrella：F016a
（A2A ingress/tool E2E）、F016b（wait scheduler）、F016c（daemon HTTP API、
WS/SSE、事件 cursor/snapshot/replay、Hub 兼容子集）。F016c 当前是
**discovery**，scope signoff 仍归主 thread/operator。本文是 F016c 的提案
输入，不把 endpoint/event 清单写成已签字 scope；A2A/MCP dispatch 的调研与
实现边界见 `docs/reports/2026-10-31-f016-a2a-dispatch-tool-priority.md` 和
`docs/plans/0018-f016a-a2a-ingress-e2e.md`，不进本文。

### 1.4 本轮 review disposition（2026-10-31）

| Finding | 处置 | 落点 |
|---|---|---|
| F1 interactive callback allowlist | B→B'：selection 走普通 message，decide 由 codeteam 解释；不伪装 callback | §0.6、§7.3、§10.1 |
| F2 `POST /api/messages` 无身份 | 改为 clowder 实际 `default-user` 回落；标注 codeteam strict 401 是有意分歧 | §3.4 |
| F3 `leave_room` ack | 改为无 ack；补 join ack 形状/超时/重试和 global room userId 检查 | §2.2、§4.1、§6.5、§9 |
| F4 重连机制 | 补 `autoConnect:false`、5s watchdog/visibility、同实例 `connect()`、仅重连 catch-up | §2.2 |
| F5 queue 端点 | 升为 S1 必做诚实空读；补 reconnect reconcile 依赖 | §0.3、§3.1、§3.2、§4.3、§9 |
| F6 事件 payload | 精确化 thread_created/messages_delivered/heartbeat/proposal_updated | §4.2、§4.4 |
| F7 CSRF 范围 | 说明 clowder 只在 owner-memory 族校验；codeteam 全写校验是更严设计 | §6.1、§6.2 |
| F8 sidebar ETag | 说明裸 `?view=sidebar` canonical 快照才享受 ETag/304 | §3.1 |
| F9 producer registry | 补服务端缺 binding 直接 throw，badge 崩是第二道防线 | §7.1 |
| S1 无 cookie socket | 明确 codeteam 必须 disconnect/隔离，不能落 `default-user`；补测试 | §2.2、§6.2、§6.3、§6.5、§7.1 G8 |
| S2 身份 header | compat 路由显式拒绝 `x-cat-cafe-user` 等 header；补非浏览器负例 | §6.2、§6.5 |
| S3 cookie 名串扰 | 改用独立 `codeteam_session`，不复用 `cat_cafe_session` | §6.2、§6.4 |
| S4 `/api/session` 401 | 写明 console-link 之前 Hub 报会话失败是预期 | §6.2、§6.5 |
| S5 `cancel_invocation` | 加入 S2 客户端→服务端事件；映射 operator cancel | §4.2、§6.3、§9 |
| S6 B' decide-once | 补 CAS/幂等；block-state no-op 仍过 session+CSRF | §6.5、§7.3 |
| S7 安全负例 | 恶意 Origin/身份 header/无 cookie socket/console token 日志红线 | §6.5 |
| S8 读写作用域 | 记清 clowder 读按 user、bundle 写有归属检查、主 append 没有 | §5.8、§6.1 |

> 这是 conditional review closure：烁烁/砚砚的 changes_requested 已按上表折入，
> 砚砚明确“折完即可按约定做最终总结 cross-post”，没有对最终文本再做一轮
> 独立复审。F016c scope 签字仍归主 thread/operator。

## 2. Hub 承载与传输

### 2.1 同源 API 与 Next.js 反代

classic Hub 是 `packages/web` 的 Next.js 应用。浏览器 API 地址的解析规则：

- 有 `NEXT_PUBLIC_API_URL` 且与访问方式不冲突时用它；
- 浏览器在默认端口（80/443）时假定 API 同源，由 Next 反代 `/api` 与
  `/socket.io`；
- 直接访问带显式端口时，默认约定 `frontendPort + 1 = apiPort`。

关键代码：`packages/web/src/utils/api-client.ts:32-61`。

Next.js 反代目标由 `API_SERVER_PORT` 优先，其次 `FRONTEND_PORT + 1`，再次
`NEXT_PUBLIC_API_URL`：

- `packages/web/next.config.js:26-45`；
- `packages/web/next.config.js:95-108`。

**对 W7a C 的约束：** `SameSite=Strict` 的关键是 **same-site**（scheme +
host；端口不参与 site 判定），不是“同 origin”。Hub 跑 3000、daemon 跑 3001
时，浏览器请求是跨 origin 但同 site；只要 daemon 的 CORS 精确允许 Hub
origin 且 `credentials` 打开，Strict cookie 仍可发送。真正的坑是
`localhost` 与 `127.0.0.1` 混用、或 Hub/API 不同 host，那会变成 cross-site，
Strict cookie 不发。最低风险配方仍是同源反代：把 `/api`、`/socket.io`
放在 Hub 的 origin 下，避免 CORS/第三方 cookie 边缘情况；直连 3001 只能
作为显式配置的备选，并要 contract test 覆盖 CORS + credentials。

### 2.2 Socket.IO 连接与房间

classic 客户端：

- `io(API_URL, { transports: ['websocket','polling'], autoConnect: false,
  reconnection: false, withCredentials: true, auth: { userId } })`
  （`packages/web/src/hooks/useSocket.ts:380-386`）。
- `reconnection: false` 不等于不重连；它关掉 Socket.IO 自带重连，改由客户端
  5s watchdog + `visibilitychange` 调 `resumeActiveConnection()`
  （`useSocket.ts:1237-1276`）→ `refreshApiSession()`
  （`packages/web/src/utils/api-client.ts:162`）→ **同一 socket 实例**
  `socket.connect()`，不是重建实例。
- connect 后 ack-gated 重 join 全部 desired rooms；**仅重连（非首连）**时
  invalidate sidebar，并对 active thread 和所有已 join thread 触发 catch-up
  （`useSocket.ts:410-484`）。报告旧稿引的 `:487-625` 是 `agent_message`
  handler，不是 connect 收敛逻辑。
- 连接后自动加入 `user:<userId>`；thread 房间通过 `join_room` 显式加入。
  join 的 ack 超时 1s，指数退避最多 5 次
  （`packages/web/src/hooks/useSocket-room-membership.ts:62-125`）。

服务端边界：

- 握手身份来自 `socket.handshake.headers.cookie` 的 session，缺失时回落
  `default-user`，不使用 `handshake.auth.userId`（`SocketManager.ts:170-174`）。
- 自动 `socket.join('user:' + userId)`（`SocketManager.ts:184-186`）。
- `join_room` 只允许 `thread:` / `worktree:` / `preview:global` /
  `workspace:global` / `workspace:navigate:ack` / `user:`；
  `user:` 只能加入自己；三个 global room 还要求非空 userId
  （`SocketManager.ts:36-49`）。
- `join_room` 必须回 ack `{ok:true, room}` 或
  `{ok:false, room, error}`（`packages/shared/src/types/socket-room.ts:2-8`）；
  客户端把“收到 ack”当作成员资格已确认，而不是把 emit 当成功
  （`SocketManager.ts:191-208`）。`leave_room` 是裸 `socket.leave(room)`，
  **没有 ack**（`SocketManager.ts:211-214`），客户端也不等待。
- WebSocket upgrade 用 `allowRequest` 校验 Origin；`cors` 只保护 polling，
  不是 WebSocket 的安全边界（`SocketManager.ts:136-166`、
  `packages/api/src/config/frontend-origin.ts:129-145`）。

**对 codeteam 的含义：** 必须实现 Socket.IO 4.x 的默认 namespace、
`/socket.io` 路径、`join_room` ack、`leave_room` 处理、`user:`/`thread:` 房间、
cookie 鉴权和 Origin allowlist；不能只实现一个“裸 WebSocket”。**无 cookie
或无效 session 的握手必须 disconnect（或进入没有事件发射源的隔离房间），
不能复制 clowder 的 `?? 'default-user'` 回落；`thread:` 房间也只允许该
operator session 可访问的 thread。** W7b 复用 chat runtime 时必须连同
watchdog/reconcile 一起抄；只抄 `reconnection:false` 等于没有断线恢复。

### 2.3 没有 SSE 事件总线

clowder Hub 的 thread/message/approval/backlog 更新都走 Socket.IO。
`text/event-stream` 只出现在 audio proxy（`packages/api/src/routes/audio-event-proxy.ts:37`）
等非 Hub 事件面。W7a 若为 headless clients 加 SSE，是 codeteam 自己的
新增 API，不是 classic Hub 兼容所需；v1 先不做，避免两套事件语义漂移。

## 3. Endpoint 兼容矩阵（W7a S1）

优先级：

- **P0**：classic Hub 打开 thread/board/approval 并完成“看 + 聊 + 批”的最小路径；
- **P1**：UI 会调用，但失败可以显式降级，不阻塞 C 体验；
- **Defer**：W7a 不承诺，UI 隐藏或返回诚实的“未支持”。

### 3.1 P0 endpoint

| # | clowder endpoint | 语义 / 关键响应 | codeteam 数据来源 | W7a 决策 |
|---:|---|---|---|---|
| 1 | `GET /api/session` | 建立/读取浏览器 session；返回 `{userId, csrfToken?}`，Set-Cookie `cat_cafe_session`（HttpOnly/SameSite=Strict） | 新增 console-link session bridge | **实现**；codeteam 用独立 `codeteam_session`，见 §6 |
| 2 | `GET /api/threads?view=sidebar` | `{threads:[sanitized Thread + presence]}`；web 侧把它收窄成 `SidebarSnapshotRow`；ETag/304 只对裸 `?view=sidebar` canonical 快照生效，带过滤参数不享受 | `threads` + `messages` + `tasks` + `agent_profiles` 投影 | **实现**；可先不做 presence |
| 3 | `GET /api/threads/:id` | thread 详情；404 表示不存在 | `threads.get` + 投影 | **实现** |
| 4 | `POST /api/threads` | 创建 thread；Hub 新建对话时用 | `threads.create`（可选 `idempotencyKey`） | **实现最小版**；idempotency 先可空 |
| 5 | `GET /api/messages?threadId=&limit=&before=` | `{messages, hasMore}`；`before` 是 `timestamp:id` 复合 cursor；非法 query 返回空页而不是 400 | `messages.listThread`（beforeSeq）+ DTO 投影 | **实现**；cursor 需适配 |
| 6 | `POST /api/messages` | 202 `{status:'queued', userMessageId, entryId?, entries?, queuePosition?, merged:false}`；支持 `idempotencyKey` | `messages.append` + `queue.admit` 事务（复用 CLI `thread post` 逻辑） | **实现**；先补幂等键 |
| 6b | `GET /api/threads/:id/queue` | `{queue, activeInvocations?, queueRevision?}`；断线 reconcile 每次 active invocation 都会拉 | codeteam `queue_entries` + `runs.status='running'` 投影 | **S1 必做**；先返回诚实空读 `{queue:[],activeInvocations:[]}`，再逐步补投影 |
| 7 | `GET /api/cats` | `{cats:[...]}`；Hub 用于名字、头像、参与者、连接状态 | `agent_profiles` 投影 | **实现**；只作显示，不作授权 |
| 8 | `GET /api/config` | `{config:{ui:{bubbleDefaults...}}}`；Hub 可缺省 | 返回安全的默认配置 | **实现最小空壳** |
| 9 | `GET /api/backlog/items` | `{items:[BacklogItem]}`；只读 board | `backlog.listByUser`（单 operator） | **实现**；映射字段 |
| 10 | `GET /api/backlog/:itemId/workflow-sop` | 直接返回扁平 `WorkflowSop`；404 表示无 SOP | `SopService.view` → 只取 `sop` 扁平化 | **实现**；不能直接返回 `WorkflowSopView` |
| 11 | `GET /api/approval-hub/pending` | `{items:[ApprovalHubItem], count, manifest, coverage}`；canonical lifecycle 字段 | `approvals.list({resolution:'open'})` + 投影 | **实现（路径见 §7.1）** |
| 12 | `GET /api/approval-hub/settled?limit=` | `{items:[SettledApprovalHubItem], count, manifest}`；历史 | `approvals.list` 非 open + 投影 | **实现（路径见 §7.1）** |
| 13 | `POST <producer>/:id/approve` / `/reject` | Approval Hub 单条 decide；`res.ok` 即成功，body 可返回 canonical approval | `approvals.decide`（operator principal + CSRF + CAS） | **实现**；endpoint base 由 producer 决定 |

### 3.2 P1（可降级）

| endpoint | UI 用途 | 建议 |
|---|---|---|
| `GET /api/tasks?threadId=&kind=work` | Plan/任务面板 | 可返回 `{tasks:[]}`；W7a 不承诺 task 写 |
| `GET /api/threads/:id/task-progress` | Plan Checklist | 返回 `{taskProgress:{}}` |
| `GET /api/threads/:id/artifacts` | Artifacts 面板 | 可返回空 artifacts；W7a 不做 artifact 投影 |
| `GET /api/threads/:id/active-pane` | 终端/活动窗 | 404/空读；UI 隐藏 |
| `GET /api/config/cat-order` | 成员排序 | 返回 `{catOrder:[]}` |
| `GET /api/config/thread-attention` | 注意力分组 | 返回空分组 |
| `GET /api/governance/health` | sidebar 健康提示 | 可返回 `{status:'ok'}` 或 404 |
| `GET /api/bootcamp/threads` | 训练营 | 404/空读 |
| `GET /api/labels` | 标签 | 返回 `{labels:[]}`；codeteam 暂无 label 持久化 |
| `GET /api/threads?deleted=true` | 回收站 | 返回 `{threads:[]}` |
| read receipts / mark-all / reveal | 未读与展开状态 | 可 no-op 或空读；不伪造未读 |
| `/api/workspace/*`、`/api/projects/*` | Workspace 面板 | 404/空读；W7a 不接 |
| message edit/delete/recall、attachments、whispers、message bundles、search、votes、guides | 富聊天操作 | Defer；UI 需要隐藏 |
| trajectory/tool-usage/logs | W7a 另一个 headless read 面 | 不走 Hub classic 兼容层；单独 API |

### 3.3 Defer（W7a 不承诺）

- SSE 事件流（classic 不需要，见 §2.3）；
- Approval 批量 decide（先做单条；批量可后续复用同一 producer endpoint）；
- merge 执行入口（`merge:execute` 永不进 REST/MCP，见 W7 鉴权矩阵）；
- queue steer/followUp/continue/append/reorder 等控制面；
- session chain、compact、trajectory drill-down、artifact review、memory/eval/concierge；
- classic 的 workspace/terminal/plugin/settings 页面；
- Hub `v2` shell。

### 3.4 错误与降级语义

| 场景 | clowder 行为 | codeteam 应复制/更严格 |
|---|---|---|
| `GET /api/messages` 非法 query/无身份 | 200 `{messages:[],hasMore:false}` | 复制空页，避免 UI 卡死 |
| `GET /api/threads` 非法 query | 200 `{threads:[]}` | 复制 |
| `GET /api/threads/:id` 不存在 | 404 `{error:'Thread not found'}` | 复制 |
| `POST /api/messages` 无身份 | trusted browser origin 无 session 时 `resolveUserId(defaultUserId:'default-user')` 会以 `default-user` 发帖成功（`messages.ts:395-404`，provenance=`compatibility_fallback`）；只有 untrusted origin 才 401 | **codeteam 有意分歧**：无匿名模式，strict session 否则 401；classic 正常流程会先 `ensureSession()` 打 `/api/session`，不会走到该行 |
| `POST /api/messages` thread 不存在 | 400 `{code:'THREAD_NOT_FOUND'}` | 复制 |
| `POST /api/messages` 队列满 | 429 `{code:'QUEUE_FULL'}` | 复制或明确 503 |
| `POST /api/messages` 投递不可用 | 503 `{code:'MESSAGE_DELIVERY_UNAVAILABLE'}` | 复制 |
| queue 条目 processing 撤回 | 409 `ENTRY_PROCESSING` | 若实现 queue 控制再复制 |
| approval pending fan-out 失败 | 500（fail closed） | codeteam 单 producer，不 fan-out；失败返回 500/503，不返回空成功 |
| 未知 endpoint | 404 | 可选读面返回诚实空页；写面/关键面 501/404，不伪成功 |

## 4. Event 兼容矩阵（W7a S2）

### 4.1 事件通道与房间

| 项 | clowder 事实 | codeteam 目标 |
|---|---|---|
| transport | Socket.IO 4.x，`/socket.io`，websocket + polling | 同 |
| 认证 | HttpOnly session cookie；Origin allowlist；`auth.userId` 不采信；无 cookie 时 clowder 落 `default-user` | **codeteam 分歧**：无 cookie/无效 session 直接 disconnect，不落 `default-user` |
| 用户房间 | 自动 `user:<userId>` | 同 |
| thread 房间 | `join_room('thread:<id>')` + ack；`leave_room` 无 ack | 同；codeteam 先只实现 thread/user |
| 房间校验 | 只允许 thread/worktree/preview/workspace/user；user 只能自己；global room 要求非空 userId | 同；codeteam 先只实现 thread/user，并保留 global 的 userId 检查 |
| 发送范围 | `agent_message` 只发 thread room；控制/审批类多走 user room | 同 |

### 4.2 事件表

| event | room | payload | 触发 | W7a 决策 |
|---|---|---|---|---|
| `agent_message` | `thread:<id>` | `AgentMessage` + `threadId` + `seq` + `seqEpoch` | 流式文本/tool/error/done | **P0** |
| `cancel_invocation`（client→server） | 无（发送方已在 thread room） | `{threadId, catId?, origin:'explicit_stop', actionId, clientInstanceId, sourceControl, gesture, trustedGesture}` | Hub stop 控件 | **P0**；映射 operator cancel；见 §9 S2 |
| `intent_mode` | `thread:<id>` | `{threadId, mode, targetCats, invocationId?}` | run 开始/路由意图 | **P0**；用于 active slot |
| `spawn_started` | `thread:<id>` | `{threadId, targetCats, invocationId}` | worker 启动前 | **P0**；可选但很便宜 |
| `thread_updated` | `user:<id>` 或 thread room | `{threadId, title?, participants?, bootcampState?}` | 标题/参与者变化 | **P0** |
| `thread_created` | `user:<id>` | 线上 payload 是完整 Thread 对象；客户端忽略 payload，只 invalidate sidebar（`proposal-routes.ts:87,203`、`useSocket.ts:593-595`） | 新 thread | **P0**；codeteam 发空或完整 thread 都安全，客户端只当 invalidation hint |
| `proposal_created` | `user:<id>` | `{proposalId, status}` | approval 创建 | **P0**；Approval Hub refetch |
| `proposal_updated` | `user:<id>` | payload 按 emit 点不同：全量 record 或 `{proposalId,status,...}` 子集；客户端只用来 refetch（`useApprovalHub.ts:20-35`） | approval decide/materialize | **P0**；codeteam 发最小 `{proposalId,status}` 安全 |
| `queue_updated` | `user:<id>` | `{threadId, queue, action}` | queue 入队/处理 | P1；S1 的 `/queue` 只做诚实空读，事件与 queue 控制面 defer |
| `messages_delivered` | `user:<id>` | `{threadId, messageIds, deliveredAt, messages}` | 恢复空 timeline | P1；可用 `agent_message`/history 替代 |
| `message_deleted` / `message_restored` / `message_recalled` / `message_receipt_updated` | user/thread | 消息 id + thread | 消息操作 | Defer |
| `task_created` / `task_updated` | user room | task DTO | task 面板 | P1；W7a 不承诺 task 写 |
| `heartbeat` | thread room | `{threadId, timestamp}` | 服务端 30s stream keepalive（`QueueProcessor.ts:4970-4976`） | **无需实现**；客户端当前没有消费者（`useSocket.ts:792-794` 只转发可选 callback），可选作 proxy keepalive |
| `runtime_interaction_updated` / `entrusted_work_projection_invalidated` | user room | 各 projection | mailbox/needs-me | Defer |
| `artifact_review_changed` | user room | `{reviewId}` | artifact review | Defer |
| `thread_branched` | thread/user | `{sourceThreadId,newThreadId,fromMessageId}` | branch | Defer |
| guide/game/voice/preview/workspace/index/connector | 各房间 | 各自 payload | 非 W7a | Defer |

### 4.3 seq / epoch / 断线追平

服务端：

- `broadcastAgentMessage` 为每个 thread 分配 `seq`，注入 `seqEpoch`，再
  发到 `thread:<id>`（`SocketManager.ts:437-454`）。
- `seq` 是 in-memory、单实例假设；API 重启重置，`seqEpoch` 是 boot UUID
  （`packages/api/src/infrastructure/websocket/ThreadSequencer.ts:1-40`）。
- 历史消息读取不返回 `seq`；seq 只是 live transport watermark。

客户端：

- `processThreadSeq` 处理 `seed/advance/late/gap/epoch-change`；gap 或
  epoch change 会 `requestStreamCatchUp(threadId)`
  （`packages/web/src/hooks/agent-messages/thread-seq.ts:1-95`）。
- catch-up 是 `GET /api/messages?limit=...&threadId=...` 的 **replace** 读取，
  按 message id 合并，然后 `acknowledgeCatchUp` 推进 lastSeq
  （`packages/web/src/hooks/useChatHistory.ts:1265-1290`、
  `:1410-1435`、`:1938-2020`）。
- `chatStore.ts:878-884` 明确说明：故意没有 `fromSeq` ranged replay；
  consumer 是 HTTP fetch + reducer dedup。
- 重连后客户端重新 join 房间，并对所有已加入 thread 触发 catch-up
  （`useSocket.ts:410-480`）。
- 同一重连路径还会对有 active invocation 的 thread 调
  `reconcileThreadWithServer` → `GET /api/threads/:id/queue`
  （`packages/web/src/hooks/queue-reconciliation.ts:41-70`）。所以 `/queue`
  即使只返回空读也必须是 200；404 会让重连 reconcile 静默失败。

**结论：** W7a S2 的验收应该是“断线后最终收敛到 canonical history”，而不是
“服务端保存并重放每个 WS 事件”。codeteam 已有 `messages.seq`（持久、per-thread、
unique），比 clowder 更强的 durable watermark；但 live event 的 seq 应独立于
message seq 分配，避免同一 response 的多次 stream update 复用同一 seq。
`seqEpoch` 可用 daemon `bootId`；重启后 client 会重置并全量追平。

### 4.4 codeteam 事件桥的建议位置

不要在每条 route 里散落 `socket.emit`。在 composition root 加一个薄事件总线：

- **run 开始**（`cutoverQueueEntry` 成功后）：发 `intent_mode` / `spawn_started`，
  `invocationId=run.id`，`targetCats=[profile 的显示 catId]`。
- **worker 事件**：把 `WorkerEventSink` 的 `message_end`/`tool_execution_*`
  映射成 `agent_message`，`messageId=run.responseMessageId`。clowder 的
  `useAgentMessages` 明确要求 body event 带 `messageId`，否则只当 status，
  不写 bubble（`packages/web/src/hooks/agent-messages/types.ts:42-44`）。
- **文本**：用 `type:'text'` + `textMode:'replace'` 发累计文本；不要发空
  `done.content` 覆盖已提交 body。`done` 只结束 streaming、清 slot。
- **终态**：`settleRunTerminal` 后发 `agent_message` `type:'done'` 或
  `type:'error'`，`isFinal:true`，`messageId` 仍是同一 response message。
- **审批**：approval create/decide 后发 `proposal_created`/`proposal_updated`，
  payload 只需 `{proposalId,status}`；UI 会 refetch pending。
- **thread**：标题/参与者变化发 `thread_updated`；新 thread 发
  `thread_created`。线上 payload 可以是完整 Thread，但客户端忽略它；
  codeteam 发空或完整 thread 都不会改变客户端行为。
- **cancel_invocation（client→server）**：socket handler 校验 operator
  session、目标 thread room、`actionId` 幂等；有 `catId` 时映射该 active
  run，无 `catId` 时映射 thread cancel-all。成功后用 `agent_message`
  `done`/terminal 广播收敛；不要依赖 ack（classic 用 volatile emit）。
- **seq**：每个 thread 一个 live event counter；`seqEpoch=daemon bootId`。
  不把 message seq 直接当 event seq。

## 5. DTO / 数据契约

### 5.1 Thread

clowder `Thread` 字段见 `packages/api/src/domains/cats/services/stores/ports/ThreadStore.ts:201`；
codeteam `Thread` 见 `packages/codeteam-daemon/src/control/stores/types.ts:215`。

| clowder 字段 | codeteam 来源 | 投影规则 | 缺口/处置 |
|---|---|---|---|
| `id` | `threads.id` | 原样 | — |
| `title` | `threads.title` | 原样；可为 null | — |
| `projectPath` | `threads.repo` | `repo ?? 'default'` | Hub 用它分组；repo 不是绝对路径时要显式标 `default` 或原值 |
| `createdBy` | 无 | 单 operator 模式下填 operator id | **投影字段，不是授权依据** |
| `participants` | `messages.author_kind='agent'` / `tasks.owner_profile_id` / `agent_sessions.profile_id` | 去重后映射到显示 catId | 空数组 UI 可容忍；不要伪造 |
| `lastActiveAt` | `max(thread.updatedAt, lastMessage.createdAt)` | 原样 | Hub 侧栏排序/时间 |
| `createdAt` / `updatedAt` | 同名列 | 原样 | — |
| `backlogItemId` | `threads.backlog_item_id` | 原样 | board 关联 |
| `phase` | `threads.phase` | 原样（`coding/research/brainstorm` 与 clowder 同值） | — |
| `pinned` / `favorited` / `labels` / `preferredCats` | codeteam 无 | 默认 false/[] | W7a 明确降级；UI 控件隐藏或只读 |
| `systemKind` / `threadKind` | codeteam 无 | 省略/null | 不伪造系统 thread |
| `presence` | `runs.status='running'` / queue | `idle` 或 `working`；没有证据就 `idle` | **证据不全显示 idle，不显示 working** |

Sidebar 的解析器对缺失字段容错（`packages/web/src/stores/sidebarProjectionStore.ts:263-300`），
但 `ThreadItem` 需要 `participants`/`lastActiveAt` 才能正常渲染
（`packages/web/src/components/ThreadSidebar/ThreadItem.tsx:24-45`）。

### 5.2 Message

clowder GET 的消息 DTO 见 `packages/api/src/routes/messages.ts:1130-1326`；
codeteam `Message` 见 `packages/codeteam-daemon/src/control/stores/types.ts:262`。

| clowder 字段 | codeteam 来源 | 投影规则 |
|---|---|---|
| `id` | `messages.id` | 原样；与 live `agent_message.messageId` 必须是同一 id |
| `type` | `author_kind` + `kind` | user→`user`；agent→`assistant`；system/status→`system`；external/plugin→`connector` 或 `system`（v1 只读） |
| `from` | `author_kind` + `author_id` | user→`{kind:'user',userId}`；agent→`{kind:'cat',catId}`；system→`{kind:'system',...}`（按 Hub 允许的形状） |
| `catId` | agent profile → 显示 catId | `profile.clowderCatId ?? profile.id`；**仅显示/provenance** |
| `content` | `body_md` | 原样；rich block-only 消息可为空 |
| `extra.rich` | `rich_blocks_json` | `{v:1, blocks:[...]}`；空数组省略 |
| `contentBlocks` / `toolEvents` / `metadata` | codeteam 暂无对应 | 省略；不要伪造 |
| `replyTo` | `reply_to` | 原样 |
| `timestamp` | `created_at` | 原样（ms） |
| `lifecycle` | 可由 `runs` 关联 | v1 可省略；live streaming 用 `messageId` 收敛 |
| `visibility` / `whisperTo` | codeteam 无 | 省略 |

`GET /api/messages` 不返回 `seq`；codeteam 也不要依赖它在 history 里做 gap
检测。历史排序用 `created_at`/`seq`，live gap 用 event seq。

### 5.3 RichBlock

clowder 的 kind 集合是
`card | diff | checklist | media_gallery | audio | interactive | html_widget | file`
（`packages/shared/src/types/rich.ts:10-19`），容器是 `{v:1, blocks:[...]}`
（`:192-195`）。classic 的渲染分发见
`packages/web/src/components/rich/RichBlocks.tsx:159-196`。

codeteam 的 `messages.rich_blocks_json` 已经是 JSON array
（`packages/codeteam-daemon/src/control/migrations/001-core.ts:104`），
且 DB trigger 禁止 `kind='approval'`（`:132-150`）。W7a 兼容层：

- 逐 block 校验 `id/kind/v`；不合法 block 返回 422 或从投影中剔除并记录 audit，
  不能把坏 JSON 直接塞给 Hub；
- 把 array 包成 `extra.rich = {v:1, blocks}`；
- 支持 clowder 的 8 个 kind 原样投影；codeteam 新增的代码交付 kind 若不在
  clowder 渲染器内，应显式降级成 `card` 或不在 W7a 投影；
- `interactive` 的 `action.endpoint` 只能命中 classic 的 callback allowlist
  （guide 三条 + auto-dream 一条，`guideClientActions.ts:23-29`）；codeteam
  的 approval decide **不能**走 `action.endpoint`，必须走 B' 的普通 message
  管线。其他 codeteam route 不能塞进 action；不支持的选项只读展示。

### 5.4 BacklogItem

clowder `BacklogItem` 见 `packages/shared/src/types/backlog.ts:59`；
codeteam `BacklogItem` 见 `packages/codeteam-daemon/src/control/stores/types.ts:367`。

| clowder 字段 | codeteam 来源 | 规则 |
|---|---|---|
| `id` / `title` / `summary` / `priority` / `tags` / `status` | 同名列 | 原样 |
| `userId` | operator id | 单 operator |
| `projectId` | `project_id` | 原样/省略 |
| `createdBy` | `created_by_kind` + `created_by_id` | `cat` → 显示 catId；`user` → operator id；`system` → 显式 system 标记 |
| `suggestion` / `lease` / `dependencies` | 同名 JSON | 原样 |
| `dispatchedThreadId` / `dispatchedThreadPhase` / `dispatchAttemptId` / `pendingThreadId` / `kickoffMessageId` | 同名 | 原样 |
| `createdAt` / `updatedAt` / `approvedAt` / `dispatchedAt` / `doneAt` | 同名 | 原样 |
| `audit` | codeteam `BacklogItemView.audit` | board 列表可不带；detail 可带 |

classic board 只依赖 `items`（`MissionControlPage.tsx:18-20`、`:95-100`），
不会因为缺 `audit` 崩；但不要把 `suggested/dispatched` 写成 `open/approved`。

### 5.5 WorkflowSop

clowder `WorkflowSop` 是扁平 DTO
（`packages/shared/src/types/workflow-sop.ts:23`）：

```ts
{ featureId, backlogItemId, sopDefinitionId, stage, batonHolder,
  nextSkill, resumeCapsule, checks, version, updatedAt, updatedBy }
```

codeteam 的读模型是 `WorkflowSopView`
（`packages/codeteam-daemon/src/control/stores/types.ts:512`）：

```ts
{ sop: WorkflowSop, effectiveChecks, evidence, staleEvidence, currentRevisions }
```

classic `WorkflowSopPanel` 直接 `as WorkflowSop` 消费
（`packages/web/src/components/mission-control/WorkflowSopPanel.tsx:92-110`）。
因此 **兼容 endpoint 必须返回 `view.sop` 扁平对象**，不能返回 `view` 整体。
额外 evidence 可另开 codeteam read API，不塞进 Hub DTO。

`GET` 在 backlog item 不存在时 404，在没有 SOP 时 404；classic 把 404 当成
“没有 SOP”显示空态（`WorkflowSopPanel.tsx:97-105`）。

### 5.6 Approval

clowder canonical DTO 见 `packages/shared/src/types/approval-hub.ts:85-130`；
codeteam `Approval` 见 `packages/codeteam-daemon/src/control/stores/types.ts:1214`。

| clowder 字段 | codeteam 来源 | 规则 |
|---|---|---|
| `proposalId` | `approvals.id` | 原样 |
| `sourceFeatureId` | **新增 producer 标识** | 不能借用现有 F-id；见 §7.1 |
| `requesterCatId` | `requested_by` | 若是 profile，投到显示 catId；若是 operator，用 operator 的显示 id（不伪造猫） |
| `ownerUserId` | operator id | 与 session principal 一致 |
| `resolution` / `materialization` | `resolution` + `materialization_json` | `open→open`；`accepted/rejected/closed_without_decision` 原样；materialization state 原样 |
| `summary` | `payload.title/summary` 派生 | 不空；无标题时用 `<kind> approval <id>` |
| `detail` | `payload` + `kind` + `taskId` + `materialization` | JSON object；不要把 secret 放进 detail |
| `navigation` | `origin_ref_json` + `card_ref_json` | 有 `threadId/messageId` 才 `anchored`；否则 `legacy_unanchored`，UI 显示警告 |
| `inlineApprovable` | `resolution==='open'` | true 才显示 Approve；codeteam 只支持单条 decide |
| `decisionMode` | 固定 `approve-reject` | — |
| `expiresAt` | `expires_at` | 原样；过期由 UI 标 stale，不自动 reject |
| `createdAt` | `created_at` | 原样 |
| `entrustedWorkTaskRef` / `needsMeDecisionRefs` | 无 | 省略 |
| `decidedAt` / `decidedBy` | 同名列 | settled DTO 用 |

**关键：** Approval Hub 的 approve button 受 `item.inlineApprovable` 控制；
如果 codeteam 设为 false，operator 只能 reject，不能 approve。W7a 的
hard-gate approval 必须设 true，并且 decide route 必须存在。

### 5.7 身份映射规则

codeteam 的 `agent_profiles.clowder_cat_id` 是 **provenance/显示别名**，不是
唯一键、不是授权键（`docs/architecture/0001-codeteam-architecture-v1.md:832-835`、
`:1134`）。兼容层规则：

1. 显示 catId = `profile.clowderCatId ?? profile.id`；
2. 若多个 profile 共享同一个 `clowderCatId`，只用于显示，路由/授权仍用
   profile id；
3. Hub 传入的 `mentions`/`preferredCats`/`targetCats` 先按 `clowderCatId`
   解析到唯一 active profile；不唯一则 409/400，不能猜；
4. operator 是独立 principal，不伪装成 cat；agent 也不伪装成 clowder cat
   的授权身份；
5. 单 operator 模式下 `ownerUserId`/`createdBy` 统一为 operator id；未来多用户
   必须先加 owner 列，不能靠 repo/thread id 推断。

### 5.8 可见性与权限

- clowder 的 thread/message 读按 user 作用域；codeteam v1 是单 operator，
  兼容层把所有可见数据限定给 operator。
- 但不要把 clowder 读成“完全无权限模型”：`GET /api/messages` 的
  `getByThread(..., userId)` 确实带 user 过滤；部分写路由有 thread 归属检查
  （例如 bundle 转发在 `messages.ts:447-452` 返回 403），但主
  `POST /api/messages` 没有同等归属检查。codeteam 的 compat 写必须自己补
  operator session + thread 归属，不能照抄主 append 的宽松边界。
- `messages.rich_blocks_json` 不能生成 approval；approval 只能来自
  `approvals` 表（codeteam DB trigger 已强制）。Hub 也不应把 rich card
  当成 approval decide 的可信来源。
- 未支持的可写操作（edit/delete/recall/attachment/whisper/vote/queue control）
  不返回伪成功；要么 501/404，要么 UI 显式隐藏。

## 6. Auth / 权限 / Hub 承载

### 6.1 clowder 当前边界

- `/api/session` 用 HttpOnly `cat_cafe_session` cookie；SameSite=Strict；
  https 时 secure；直接 loopback owner，否则可能是 `unpaired-user`
  （`packages/api/src/infrastructure/session-auth.ts:7-10`、`:108-137`）。
- 更具体地说，直接 loopback 请求（无代理头）会直接创建 `ownerUserId` 的
  session 并返回 csrfToken，而不是只给登录页（`session-auth.ts:116-134`）。
  codeteam 不应复制这个“loopback 即 owner”的隐式 bootstrap；console-link
  必须有一次 operator 签名 proof。
- `LOOPBACK_ORIGIN` 正则无条件允许所有 `127.x.x.x` 任意端口；`localhost`
  只有默认 3000/3003/`FRONTEND_PORT` 等显式项
  （`packages/api/src/config/frontend-origin.ts:10-19`、`:96-126`）。codeteam
  应精确 allowlist 自己的 Hub origin，不照抄“任意 127.x”信任。
- `resolveUserId` 对 trusted browser origin 在无 session 时可回落
  `default-user`（`packages/api/src/utils/request-identity.ts:83-113`）。
- 严格写入口用 `resolveStrictUserId`，浏览器无 session 一律 null
  （`:122-131`）。
- 读路径确实按 user 过滤（`GET /api/messages` 的
  `getByThread(..., userId)`，`messages.ts:1045-1060`）；bundle 转发有 thread
  归属检查并返回 403（`:447-452`），但主 `POST /api/messages` 没有同等检查。
  codeteam 不能把 clowder 当完整权限模型；compat 写要自己补 operator session +
  thread 归属。
- `POST /api/dispatch-proposals/:id/approve` 用 `resolveUserId` + ownerUserId
  匹配，记录 `ownerAuthProvenance`（strict vs compatibility_fallback）
  （`packages/api/src/routes/dispatch-proposal-routes.ts:163-185`）。这不是
  codeteam 的 operator-signature 边界，不能直接视为“operator-only”。
- Socket 只认 cookie；`auth.userId` 不采信（`SocketManager.ts:170-174`）。
- 但 Socket 在无 cookie 时会落 `default-user` 并自动 join
  `user:default-user`（`SocketManager.ts:146-161`、`:171-185`），且
  `thread:` 房间没有 ownership 检查（`:36-49`）。codeteam 不能复制这条
  回落；无 session 必须 disconnect/隔离。

### 6.2 codeteam 目标：console-link → 浏览器 session

W7a 需要把 F005c 的 operator key 变成浏览器可用、但仍是 operator principal 的
短时效 session。建议：

1. `codeteam auth console-link`（CLI，loopback only）用 operator 私钥签一个
   短时效 payload（nonce/exp/fingerprint），打印一次性 URL；token 兑换后立即
   失效，且不写入 daemon access log/应用日志/错误 body（URL query 是泄漏面）。
2. daemon 的 `GET /auth/console?token=...` 验签、消费 nonce，创建 server-side
   browser session，Set-Cookie **`codeteam_session`**（HttpOnly/SameSite=Strict）。
   classic web 没有硬编码 `cat_cafe_session`，改独立 cookie 名零成本；同 host
   双栈并行时不会和 clowder 的 cookie jar 互相覆盖。
3. `GET /api/session` 有 session 时返回
   `{userId:'operator:<fingerprint>', csrfToken}`；无 session 返回 401；
4. 所有写请求校验 `x-csrf-token`（Hub 的 `apiFetch` 已自动带上，
   `packages/web/src/utils/api-client.ts:224-232`、`:135-160`）。注意 clowder
   自身只在 owner-memory 族校验 CSRF（`owner-memory-browser-auth.ts:19-28`），
   thread/message/approval 写主要靠 SameSite；codeteam 的“全写校验”是更严的
   设计，不是 clowder parity。compat 路由还要像
   `owner-memory-browser-auth.ts:6-12` 一样显式拒绝身份 header
   （`x-invocation-id`、`x-callback-token`、`x-agent-key-secret`、
   `x-cat-cafe-user`、`authorization`）；身份只能来自 session cookie。
5. approval decide 额外校验 session 派生 principal 的 `kind==='operator'`；
   run token / agent-key 永远 403。B' 的 decide-once 用 approval CAS：
   重复选择/双 tab 只能成功一次，过期或已决返回 409/幂等原结果；
   `PATCH /api/messages/:id/block-state` 的兼容 no-op 也必须过 session+CSRF，
   不能裸开 200。
6. Socket 握手用同一 cookie；无 cookie/无效 session 直接 disconnect，不能落
   `default-user`；`thread:` 房间只允许该 operator 可访问的 thread。
7. operator 私钥只在 CLI 侧，daemon 只持公钥；agent 零 secret 不破。

Hub 的 `ensureSession()` 会先打 `/api/session`；没有 console-link cookie 时
返回 401 是预期，不要回落到 `default-user`。此时 classic Hub 会弹“会话恢复
失败”并进入错误态；这是 console-link 之前的预期行为，不是 bug。打开
console-link URL 设好 cookie 后，下一次 `/api/session` 恢复 200。这样既不复制
clowder 的 `default-user` 回落，也不要求 Hub 改 auth。

### 6.3 Auth 矩阵

| 面 | operator console session | run token | agent-key | anonymous |
|---|---|---|---|---|
| `GET /api/session` | 200 | 401/403 | 401/403 | 401（不复制 clowder 的 loopback 隐式 owner bootstrap） |
| `GET /auth/console?token=` | 一次性建立 session | 403 | 403 | 无效/过期 token 401；成功 Set-Cookie 后进入 session |
| Socket handshake | connect | disconnect | disconnect | disconnect（无 cookie/无效 session 不落 `default-user`） |
| thread/message 读 | 200 | 403 | 403 | 401 |
| thread chat append | 202 | 403 | 403 | 401 |
| `cancel_invocation` | 200/event（operator session + thread room） | 403/disconnect | 403/disconnect | disconnect |
| `PATCH /api/messages/:id/block-state` | 200（session+CSRF；no-op 也校验） | 403 | 403 | 401 |
| backlog/workflow-sop 读 | 200 | 403 | 403 | 401 |
| backlog 写/dispatch | 403（W7a 不做） | 403 | 403 | 401 |
| approval pending/settled 读 | 200 | 403 | 403 | 401 |
| approval decide | 200（operator principal） | 403 | 403 | 401 |
| merge:execute | 永不暴露 | 403 | 403 | 403 |
| telemetry/trajectory/tool-usage/logs | 200（operator） | 403 | 403 | 401 |

### 6.4 Hub 承载配方（C 模式）

目标：classic Hub 页面 origin = codeteam API 的浏览器 origin。

推荐本地开发/dogfood：

```text
Hub web:        http://localhost:3000
daemon:         127.0.0.1:3001（只绑 loopback）
Hub env:
  API_SERVER_PORT=3001
  NEXT_PUBLIC_API_URL=http://localhost:3000   # 浏览器同源，让 Next 反代
```

或者用同源反向代理把 `/api`、`/socket.io` 转发到 daemon，浏览器不直连
3001。直连 `http://localhost:3001` 也可以工作：它是 cross-origin 但
same-site，`SameSite=Strict` cookie 仍会发送，前提是 daemon CORS 精确允许
`http://localhost:3000` 且 `credentials=true`。不要混用 `localhost` 与
`127.0.0.1`，也不要让 Hub/API 落在不同 host；那会 cross-site，Strict
cookie 不发。推荐仍用同源反代，减少 CORS/第三方 cookie 的边缘配置。

daemon 侧：

- 只绑 `127.0.0.1`；
- CORS/allowRequest 允许 Hub 的 loopback origin，拒绝其他 Origin；
- `Set-Cookie` 使用独立 `codeteam_session`，经 Hub 反代透传；classic 不按名读
  cookie，因此不需要改 Hub；
- 不信任 `X-Forwarded-*` 作为 loopback 证据（`loopback-request.ts` 已按
  代理头判定非 direct loopback）。

### 6.5 Contract test 计划

**固定基线：**

- clowder `5f8965e1e04dd3ac194cba53fa484bbc994d2dcd`；
- Socket.IO server/client `4.8.3`；
- classic shell（`useShellPresentation` 默认 classic）；
- codeteam `codeteam-work @ aba19b7e7` 或实现时的 exact HEAD。

**测试分层：**

1. **DTO fixture tests（CI 必跑）**：用 checked-in JSON fixtures 断言
   thread/message/rich/backlog/SOP/approval 的字段、类型、必填项和错误形状。
   至少覆盖 `GET /api/threads/:id/queue` 的 `{queue:[],activeInvocations:[]}`
   空读形状。fixture provenance 写 clowder pin SHA；不 import clowder 包，
   不读 clowder DB。
2. **Socket contract tests（CI 必跑）**：用 `socket.io-client` 连 codeteam daemon：
   - cookie 鉴权成功/失败；**无 cookie/无效 session 的握手被 disconnect**；
   - `join_room` ack `{ok:true,room}`；leave_room 无 ack 且不报错；
     非法房间/越权 user room 被拒；
   - `agent_message` 带 `messageId/threadId/seq/seqEpoch`；
   - gap/epoch -> 客户端触发 `GET /api/messages` 全量重取，按 id 收敛；
   - 重连后重新 join，消息不丢不重；
   - 恶意 Origin（含 `127.x` 任意非 Hub 端口）的 WebSocket upgrade 被拒；
   - `cancel_invocation` 只从 operator session + 目标 thread room 接受，
     无 provenance/重复 actionId 被忽略或 409；不实现时必须隐藏 stop 控件。
3. **Auth/CSRF tests（CI 必跑）**：console-link 验签/一次性/TTL；无 CSRF 的写
   被拒；run token 打 approval decide 403；浏览器 **和非浏览器**
   `X-Cat-Cafe-User` 都不生效；console-link token 不写入 daemon 日志/Access
   log/错误 body；B' 的重复选择只成功一次（CAS），过期/已决返回 409。
4. **C-mode smoke（本地/授权环境，非 CI 依赖）**：用 pinned clowder classic
   Hub 指向 codeteam daemon（同源反代），走真实页面：
   `/mission-hub` 看 backlog/SOP；打开 thread；发消息；看回复；审批；断网/重启
   socket 后恢复。审批按 A 或 B' 的实际路径验证；B' 要验证 interactive
   选择确实走普通 message 管线并产生 decide，且不生成 cat queue entry /
   不唤醒 cat。另验证无 cookie 的 `/api/session` 401 会让 Hub 显示“会话恢复
   失败”——这是 console-link 之前的预期；console-link 后恢复。记录 URL、操作、
   截图/日志和 exact HEAD。
5. **授权后的 clowder 侧改动测试**：如果走 Approval producer 注册，另在
   clowder-ai 的测试里覆盖 catalog/badge/filter；本文不把 clowder 改动混进
   codeteam 产品代码。

**不做的测试：** 不把 clowder 运行时作为 codeteam package dependency；不在 CI
里指向生产 clowder；不读 clowder DB。

## 7. Gap 与授权清单

### 7.1 P0 blockers

| # | Gap | 证据 | 处置/建议 |
|---:|---|---|---|
| G1 | `POST /api/messages` 幂等键缺失 | clowder 用 `idempotencyKey` 去重（`messages.schema.ts:111-130`）；codeteam `messages` 表没有该列（`001-core.ts:96-120`） | 加 `messages.idempotency_key` + unique `(thread_id,idempotency_key)`，或 `message_admissions` 表；同 key 同内容返回同 message/entry，不同内容 409 |
| G2 | Approval producer 未注册 | `ApprovalProducerId` 是封闭 union（`types/approval-hub.ts:13-24`）；服务端 `ApprovalProducerRegistry` 缺 binding 直接 throw（`ApprovalProducerRegistry.ts:37-41`），所以未知 id 在服务层就进不了 Hub；即使绕过 service，classic badge 直接查 catalog（`ApprovalFeatureBadge.tsx:7-16`）也会 `featureMeta.color` 崩 | 三选一：A 最小 clowder 容错/注册（需 operator 授权）；B' thread interactive 选择以普通 message 发回，由 codeteam 解释为 decide（无 clowder 改动，但 Approval Hub 为空）；C W7b fork Approval 组件 |
| G3 | `WorkflowSopView` 与 `WorkflowSop` 形状不同 | codeteam `WorkflowSopView.sop`（`types.ts:512`）；classic 直接消费扁平对象（`WorkflowSopPanel.tsx:92-110`） | 兼容 endpoint 返回 `view.sop` 扁平化；不要把 evidence 塞进去 |
| G4 | 事件桥/response identity 未实现 | codeteam 只有 `run_events` store，没有 Socket.IO/event bus；clowder body event 必须带 `messageId`（`agent-messages/types.ts:42-44`） | composition root 加事件总线；live `messageId = run.responseMessageId`；终态与 history 同一 id |
| G5 | Hub 承载 cookie 配方未定 | clowder cookie SameSite=Strict（`session-auth.ts:128-135`）；不同 host 会 cross-site，不同端口是 cross-origin 但 same-site | 固定同源反代配方；若直连不同端口，必须显式 CORS allowlist + credentials；contract test 覆盖两种拓扑 |
| G6 | thread 投影字段不完整 | codeteam `Thread` 无 `createdBy/participants/lastActiveAt/projectPath`（`types.ts:215`）；Hub sidebar 需要这些显示字段（`ThreadItem.tsx:24-45`） | 兼容层派生；缺证据不伪造 presence/participants |
| G7 | 未支持 endpoint 的降级策略未冻结 | classic 会调用大量辅助 endpoint（`/api/tasks`、task-progress、queue、artifacts、governance 等） | 定义“诚实空读 / 404 / 501”白名单；写面不伪成功；UI 隐藏 |
| G8 | Socket 无 cookie 回落 | clowder 无 Origin 放行（`SocketManager.ts:146-161`）、身份 `?? 'default-user'`（`:171-172`）、自动 join `user:default-user`（`:185`）；thread room 无 ownership 检查（`:36-49`） | codeteam 无 session 直接 disconnect/隔离；thread room 只允许 operator 可访问 thread；补负例测试 |
| G9 | `cancel_invocation` 未进 S2 | classic stop 用 `socket.volatile.emit('cancel_invocation', ...)`（`useSocket-cancel-provenance.ts:54-70`），无 ack；不实现则 C 模式 stop 静默失效 | 推荐 S2 实现：operator session + thread room + 目标 run/cat，映射 `stopRun`；否则隐藏/禁用 stop 控件并列入 G7 |

### 7.2 P1 / defer

| 项 | 处置 |
|---|---|
| `queue_updated` 事件与 queue 控制面 | S1 的 `GET /queue` 只做诚实空读；`queue_updated`、steer/append/reorder 等控制面 defer 到 S2 后 |
| `messages_delivered` / message lifecycle | 用 `agent_message` + history 收敛；不先造第二套 bubble |
| task/task-progress 面板 | 空读；W7a 不承诺 task 写 |
| artifacts/ThreadArtifactDTO | defer；W7a 另有 artifact 投影契约 |
| labels/pins/favorites/preferredCats | codeteam 无持久化；UI 隐藏或只读 |
| 附件/图片/whisper/message bundle | defer；Hub 上传路径与 codeteam worktree/安全边界未定 |
| search/votes/guides/bootcamp/concierge | defer；不属于 W7a C 最小路径 |
| approval 批量 decide | 先单条；批量后续复用同一 producer endpoint |
| approval origin/card ref | W4 approval CLI 允许空 `card-json`；Hub 会显示 `legacy_unanchored` 警告。W7a 新建 approval 若要在 Hub 里可跳转，必须携带 exact card message；否则接受警告与不可跳转 |
| thread create 幂等 | Hub 的 `POST /api/threads` 可选 `idempotencyKey`；codeteam `threads` 无该列。W7a 先接受重复创建风险，或同 G1 方式补唯一键 |
| SSE | defer；classic 不需要 |
| Hub v2 | 不进 v1 |

### 7.3 需要 clowder 侧改动的清单（须 operator 单独授权）

**Approval producer 最小改动（路径 A1，推荐优先评估）：**

1. `packages/shared/src/types/approval-hub.ts`：允许一个非 F-number 的
   codeteam producer id（例如 `codeteam`，最终名字与 clowder owner 定），
   或把 UI 的 `ApprovalFeatureId` 降为 `string` 并在边界做 fallback。
2. `packages/shared/src/approval-producer-catalog.ts`：增加 catalog entry：
   label/badge/color、`decisionEndpointBase: '/api/codeteam-approvals'`、
   `decisionSurface:'approval_hub'`、`sourcePolicy:'message-required'`、
   `systemOriginExemption:'forbidden'`、`history:true`。
3. `packages/web/src/lib/approval-features.ts` + `ApprovalFeatureBadge`：
   对未知/新 id 返回稳定 fallback metadata，避免 `undefined.color` 崩。
4. 如果改 shared union，clowder API 的 `ApprovalProducerRegistry` 需要补一个
   **空 adapter binding** 才能编译；或者只做前端容错、不扩 API union（更小）。
5. clowder-ai 测试：catalog 完整性、badge/filter、未知 id fallback。

**不授权时的路径 B'：** codeteam 在 thread 里发 `interactive` rich card，
但 options **不带** `action`（不能把 `action.endpoint` 指向 codeteam decide：
classic 的 callback 有硬 allowlist，只有 guide 三条 + auto-dream 一条，
`packages/web/src/components/rich/guideClientActions.ts:23-29`；不在 allowlist
时 `InteractiveBlock.tsx:588-592` 只打 console.error，什么都不发）。默认分支
会把选择拼成普通 chat message 发回 thread（`InteractiveBlock.tsx:631-641`），
codeteam 用正常 `POST /api/messages` 管线把这条消息解释为 decide。代价是
decide 延迟 = 一轮 queue admission，且 block 选择后 disabled（一次性）；
选择还会 fire-and-forget `PATCH /api/messages/:id/block-state`
（`InteractiveBlock.tsx:59-66`），codeteam 可以诚实 no-op/404，客户端有
`.catch` 兜住。Approval Hub 面板仍不显示 codeteam approval；这是显式降级，
不是 Approval Hub 兼容。安全上，这条 message 必须来自 operator session，
并带结构化 approval/block ref；不能从自由文本推断 decide，run token 或
agent 写消息也不能触发 approval decide。B' 应把 `messageTemplate` 固定成
可校验的 `codeteam-approval:<approvalId> {selection}` 形状，选项 label 只用
`approve`/`reject`；codeteam 在 admission 前只接受 exact prefix + exact
approval id，匹配失败就按普通聊天处理。匹配成功时应在同一事务里写 decision
与审计 message，**不**给 cat 生成 queue entry；否则 B' 会把审批选择变成一次
cat 唤醒。同一 approval 的双击/双 tab 选择必须由 CAS 保证只成功一次，过期/
已决返回 409 或幂等原结果；`PATCH /api/messages/:id/block-state` 的 no-op
仍要过 session+CSRF，不能为了兼容裸开 200。

**F002 结论修正：** F002 的 “thread/message/rich card 不需要 clowder 改动”
成立（`docs/reports/2026-10-27-f002-w0a-preflight.md:87-94`）；但
“Approval Hub 显示不需要 clowder 改动” 只在 thread rich card 场景成立。
classic Approval Hub 的 producer 是封闭 catalog，必须补容错/注册或 fork。

### 7.4 明确 non-goals

- 不把 codeteam approval 借用 `F193`/`F306` 等现有 producer id 冒充；
- 不把 codeteam profile 伪装成 clowder cat 的授权身份；
- 不读 clowder DB、不共享 clowder Redis、不把 clowder 包加进 codeteam 依赖；
- 不把 SSE/replay log 作为 W7a 承诺；
- 不把 merge:execute 暴露到 REST/MCP；
- 不把 `v2` shell 带进 v1。

## 8. W7b 复用地图（classic）

| 层 / 组件 | clowder 路径 | 决策 | 说明 |
|---|---|---|---|
| shell / ActivityBar / WorldRail | `packages/web/src/components/AppShell.tsx`、`ActivityBar.tsx`、`shell/WorldRail.tsx` | **fork** | 去掉 clowder 的 memory/signals/marketplace/concierge 等入口；保留 thread/workspace/approval 目标 |
| thread sidebar | `components/ThreadSidebar/*`、`stores/sidebarProjectionStore.ts` | **source reuse + contract adapt** | 复用 snapshot/ETag/行渲染；labels/pins/favorites 控件先隐藏或接 codeteam 字段 |
| chat runtime | `hooks/useSocket.ts`、`useChatHistory.ts`、`useAgentMessages.ts`、`stores/chatStore.ts` | **source reuse** | 复制到 codeteam web package，替换 `@cat-cafe/shared` import 与 API base；保留 seq/epoch/catch-up 语义 |
| message renderer | `components/ChatMessage.tsx`、`components/rich/RichBlocks.tsx`、`rich/*` | **source reuse** | 8 个 rich kind 原样；codeteam 新 kind 先映射/降级 |
| Mission Hub read | `app/mission-hub/page.tsx`、`components/mission-control/MissionControlPage.tsx`、`WorkflowSopPanel.tsx` | **source reuse + read-only** | W7a 只读；self-claim/lease/create 等写控件隐藏或走 codeteam API |
| Approval Hub | `ApprovalHubDrawer.tsx`、`ApprovalPendingPane.tsx`、`ApprovalItemCard.tsx`、`lib/approval-features.ts` | **fork/adapt** | producer catalog/badge/dispatch 必须换成 codeteam id；或 fork 成 codeteam approval panel |
| cats / config / settings | `useCatData.ts`、`CatAvatar`、`config*`、`settings/*` | **fork/adapt** | profile 显示映射；不把 clowder CatConfig 当 codeteam 配置真相 |
| queue / execution controls | `QueuePanel.tsx`、`execution-row/*`、`useActiveExecutionProjection` | **defer/fork** | codeteam queue 语义不同；M0 先只读或不显示 |
| artifacts / session chain / trajectory | `ArtifactsPanel`、`SessionChainPanel`、`story-player` | **defer** | W7a artifact/trajectory 另做 read API，W7b 再选 |
| workspace/terminal/plugin/marketplace | `workspace/*`、`terminal`、`plugin-*` | **fork/defer** | 不是 M0 看+聊+批最小面 |
| v2 shell | `?shell=v2`、`WorldRail` v2 | **excluded** | `DP-WEB-1=B`；v1 不混用 |

**复用方式：** 只做源码级 fork/adapt，不把 clowder-ai 作为运行时 package
依赖；替换 import、API base、auth adapter、DTO adapter。classic 已 frozen，
复制后由 codeteam 自己负责演进。

## 9. F016c S1/S2 提案（scope signoff pending）

> 本节是提案输入，不是已签字 scope；F016c 的 AC/plan 由主 thread/operator
> 在 scope signoff 后另立。endpoint/event 清单可被调整，不能据此直接实现。

### S1 — daemon HTTP 兼容面（先做）

按顺序：

1. **session/auth bridge**：`/api/session`、console-link、cookie/CSRF、
   Origin allowlist；operator principal 只从 session 派生。
2. **thread 读投影**：`GET /api/threads?view=sidebar`（ETag/304）+
   `GET /api/threads/:id`；`projectPath/createdBy/participants/lastActiveAt`
   显式派生。
3. **message history**：`GET /api/messages`（`timestamp:id` cursor、
   `{messages,hasMore}`、rich block 包装）。
4. **message append**：`POST /api/messages`（202、queue 事务、幂等键、错误码）。
5. **queue 诚实空读**：`GET /api/threads/:id/queue` 返回
   `{queue:[],activeInvocations:[]}`；断线 reconcile 必须不 404。
6. **壳数据**：`GET /api/cats`、`GET /api/config`、`GET /api/config/cat-order`
   最小安全返回。
7. **board**：`GET /api/backlog/items` + `GET /api/backlog/:itemId/workflow-sop`
   扁平 DTO。
8. **approval**：pending/settled 读 + 单条 decide（producer 路径先拍板）。
9. **unsupported endpoint 白名单**：空读/404/501，禁止伪成功。

### S2 — events（紧跟 S1）

1. Socket.IO server + `/socket.io` + cookie auth + Origin allowlist。
2. `join_room` ack；`leave_room` 无 ack（服务端 `socket.leave` 即可）；
   `user:`/`thread:` 房间；global room 保留非空 userId 检查。
3. client→server `cancel_invocation`：只接受 operator session + 目标 thread
   room，映射到 codeteam `stopRun`/cancel-all；无 provenance/重复 actionId
   忽略或 409。若不实现，必须隐藏/禁用 classic stop 控件。
4. composition-root event bus；run start/worker event/terminal → `intent_mode`、
   `spawn_started`、`agent_message`（text/tool/error/done）。
5. `thread_updated`/`thread_created`、`proposal_created`/`proposal_updated`。
6. live event seq + `seqEpoch=daemon bootId`；reconnect 全量 history 追平；
   contract tests 覆盖 gap/epoch/duplicate/room/origin。

### Defer（S1/S2 不承诺）

SSE、queue 控制面、message edit/delete/recall、附件/图片/whisper/bundle、
labels/pins/favorites、artifacts/session chain/trajectory、search/votes/guides、
approval 批量、merge 执行、W7a 6b 之外的 GitHub tracking UI、Hub v2。

### S1/S2 完成定义

- P0 endpoint 的 DTO fixture 通过；
- Socket contract tests 通过（含断线/重启追平）；
- auth/CSRF/run-token 403 测试通过；
- 真实 classic Hub C-mode smoke 通过（本地/授权环境）；
- unsupported endpoint 有显式清单，UI 不显示假数据；
- 不读 clowder DB，不把 clowder 包加入依赖；
- 所有 unsupported/降级在 dogfood 摩擦记录里有 owner/触发条件。

## 10. 待拍板

1. **Approval 走 A/B'/C 哪条？** 推荐先向 operator 申请 A1（最小 clowder
   producer 容错/注册）；不授权则 W7a C 用 B'（interactive 选择走普通
   message，codeteam 解释为 decide），并把 Approval Hub 面板标为 W7b fork，
   不把 B' 说成完整 Approval Hub。
2. **thread 元数据**（pinned/favorited/labels/preferredCats）是否在 W7a 加
   codeteam 持久化？建议先不加，UI 隐藏；W7b 再决定。
3. **participants 派生**用“message 作者 + task owner”是否足够？建议是；
   空数组可见，不伪造。
4. **message 幂等键**用列还是独立 admission 表？建议列 + unique partial
   index，最小迁移；同 key 不同内容 409。
5. **F016 “事件重放”措辞**是否改成“snapshot/history catch-up + live
   events”？建议改，避免实现一个无人消费的 replay log。
6. **console-link 的 TTL/一次性**：建议 ≤5min、nonce 一次性、loopback only；
   具体值在 F016c 的 scope/plan 冻结。

## Appendix A: 关键 clowder 源码索引

| 主题 | clowder 路径 |
|---|---|
| Next 反代 / API base | `packages/web/next.config.js:26-45`、`:95-108`；`packages/web/src/utils/api-client.ts:32-61` |
| session / cookie / CSRF | `packages/api/src/infrastructure/session-auth.ts:7-10`、`:108-137`（loopback owner bootstrap 在 `:116-134`）；`packages/api/src/routes/owner-memory-browser-auth.ts:19-28`；`packages/web/src/utils/api-client.ts:135-160`、`:224-232` |
| identity resolver | `packages/api/src/utils/request-identity.ts:83-131` |
| Socket.IO 服务端 | `packages/api/src/infrastructure/websocket/SocketManager.ts:36-49`、`:136-208`、`:437-478` |
| Socket.IO 客户端 | `packages/web/src/hooks/useSocket.ts:380-386`、`:410-480`、`:487-625` |
| 重连 / 房间 ack | `packages/web/src/hooks/useSocket.ts:1237-1276`；`packages/web/src/hooks/useSocket-room-membership.ts:62-125`；`packages/web/src/hooks/queue-reconciliation.ts:41-70` |
| seq / epoch | `packages/api/src/infrastructure/websocket/ThreadSequencer.ts:1-40`；`packages/web/src/hooks/agent-messages/thread-seq.ts:1-95`；`packages/web/src/stores/chatStore.ts:878-884` |
| history / catch-up | `packages/web/src/hooks/useChatHistory.ts:1265-1290`、`:1410-1435`、`:1938-2020` |
| threads routes | `packages/api/src/routes/threads.ts:906`、`:997`、`:1202`；DTO `packages/api/src/domains/cats/services/stores/ports/ThreadStore.ts:201` |
| messages routes | `packages/api/src/routes/messages.ts:254-259`、`:328`、`:1045-1326`；schema `packages/api/src/routes/messages.schema.ts:111-190` |
| rich blocks | `packages/shared/src/types/rich.ts:10-19`、`:180-195`；renderer `packages/web/src/components/rich/RichBlocks.tsx:159-196` |
| backlog / SOP | `packages/api/src/routes/backlog.ts:483`；`packages/api/src/routes/workflow-sop.ts:42-61`；shared types `packages/shared/src/types/backlog.ts:59`、`workflow-sop.ts:23` |
| approval hub | `packages/api/src/routes/approval-hub-routes.ts:106-156`；DTO `packages/shared/src/types/approval-hub.ts:85-130`；catalog `packages/shared/src/approval-producer-catalog.ts:70-265` |
| approval UI | `packages/web/src/lib/approval-features.ts:14-24`；`packages/web/src/components/ApprovalFeatureBadge.tsx:7-16`；`ApprovalItemCard.tsx:18-26`；`ApprovalPendingPane.tsx` |
| interactive callback allowlist | `packages/web/src/components/rich/guideClientActions.ts:23-29`；`packages/web/src/components/rich/InteractiveBlock.tsx:59-66`、`:588-592`、`:631-641` |
| approval producer registry | `packages/api/src/domains/approval-hub/ApprovalProducerRegistry.ts:37-41` |
| cancel_invocation | `packages/api/src/infrastructure/websocket/SocketManager.ts:217-300`；`packages/web/src/hooks/useSocket-cancel-provenance.ts:54-70` |
| 身份 header 黑名单 / CSRF | `packages/api/src/routes/owner-memory-browser-auth.ts:6-28` |
| 读作用域 / 写归属 | `packages/api/src/routes/messages.ts:1045-1060`（读 user 过滤）、`:447-452`（bundle 写 403） |
| Mission Hub / SOP UI | `packages/web/src/components/mission-control/MissionControlPage.tsx:18-20`、`:95-100`；`WorkflowSopPanel.tsx:92-110` |
| origin / CORS | `packages/api/src/config/frontend-origin.ts:10`、`:96-126`、`:129-145` |

## Appendix B: codeteam 源码索引

| 主题 | codeteam 路径 |
|---|---|
| schema | `packages/codeteam-daemon/src/control/migrations/001-core.ts:28-150`、`002-work.ts:2-52`、`003-governance.ts:125-149` |
| thread/message types | `packages/codeteam-daemon/src/control/stores/types.ts:215-330` |
| backlog/SOP types | `packages/codeteam-daemon/src/control/stores/types.ts:367-540` |
| approval type | `packages/codeteam-daemon/src/control/stores/types.ts:1214-1262` |
| profile/cat provenance | `packages/codeteam-daemon/src/control/stores/types.ts:25-36`；`docs/architecture/0001-codeteam-architecture-v1.md:832-835`、`:1134` |
| message append | `packages/codeteam-daemon/src/control/stores/messages.ts:105-190` |
| cutover/response message | `packages/codeteam-daemon/src/control/store.ts:293-355` |
| worker events | `packages/codeteam-daemon/src/workers/event-sink.ts:1-225` |
| settle | `packages/codeteam-daemon/src/dispatch/settle.ts:1-60` |
| CLI thread post | `packages/codeteam-daemon/src/cli/thread.ts:82-145` |
| operator credential | `packages/codeteam-daemon/src/auth/operator.ts:29-90`；`docs/features/F005c-operator-credentials.md` |
| daemon HTTP | `packages/codeteam-daemon/src/daemon.ts:176-212`（目前只有 health/ready/metrics） |

[宪宪/deepseek-flash🐾]
