---
title: "Clowder MCP 架构与 codeteam W7a 工具面分析"
doc_kind: report
status: draft-for-review
created: 2026-10-29
updated: 2026-10-29
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash), 烁烁 (Kimi K3)]
baseline: "codeteam-work@d33dd17fb2eafefdfd167036e4dc258012c9882d"
reference: "clowder-ai@5f8965e1e04dd3ac194cba53fa484bbc994d2dcd (read-only local reference)"
scope: "read-only analysis; no product code changes"
---

# Clowder MCP 架构与 codeteam W7a 工具面分析

> 本文只做调研与决策建议。没有修改 codeteam 产品代码，也没有把 clowder-ai
> 作为运行依赖；所有 clowder 代码路径均为参考仓的 repo-relative 路径。

## 0. 结论先行

1. **`cat-cafe-collab` 当前有 165 个工具、36 个 resource family。** 加上
   memory/signals/audio/limb/finance 共 218 个。工具数量本身不是可复用资产；
   真正值得复用的是“薄 MCP + 服务端 principal + canonical registry + typed
   failure + 幂等边界”这套结构。
2. **codeteam 不应按 1:1 搬 165 个工具。** W7a P0 只需要 13 个工具：5 个
   A2A/custody 写工具、3 个 wait 工具、5 个 thread/task 读工具。其余按
   P1a（operator/Console 核心）、P1b（W6/W8 依赖）、P2（defer）、Drop 分层。
3. **`post_message` / `cross_post_message` / `multi_mention` 不能直接映射成
   codeteam 的同名工具。** 它们在 Clowder 里是多用途载体：消息 + 唤醒 +
   action custody + coordination + local review verdict。codeteam 应拆成
   `a2a_send`（讨论/通知，无 custody）、`handoff_*`（责任转移）、
   `thread_*`/`message_get`（读取）和独立的 `review_*`（P1）。不默认加
   `cat_cafe_*` 别名。
4. **W7a 推荐 transport：stdio MCP server + 现有 0600 Unix worker control
   socket。** MCP 进程只做 stdio 适配，所有工具调用经 `CODETEAM_CONTROL_SOCKET`
   发到 daemon；不在新 HTTP 端口上暴露 run-token 工具面。daemon 仍是唯一
   control plane / SQLite 单写者。HTTP/WS/SSE 留给 operator Console（operator
   credential），W8 webhook 用 HMAC，三个 auth 域互不替代。
5. **鉴权按 `docs/architecture/reuse-review/callback-auth.md` 执行：** per-run
   token、header-only、principal 从 token 派生、tool args 不接受自报
   `from/role/owner`、typed auth failure、callback allowlist。`approval:decide`
   只接受 operator credential；`merge:execute` 只由 daemon
   `service:merge-owner` 执行；两者都不出现在 MCP 工具面。
6. **W7a 有五个必须先补的缺口：**
   - mint credential 时 `callbackAllowlist` 仍为空，需要按 run 注入 P0 工具名；
   - `resolveInvocationToken` 把 terminal/expired 统一成 `invalid_token`，
     需要 typed reason；
   - `a2a_send` 没有 requestId 幂等账本，需要 transport-level idempotency；
   - 读工具必须强制 thread/task 范围，不能只靠调用方传 threadId；
   - 同一 `(threadId, agentSessionId)` 目前可能有多个 active credential，
     需要 latest/replaced 语义。

## 1. 方法与证据

### 1.1 基线

| 项 | 值 |
|---|---|
| codeteam 基线 | `codeteam-work@d33dd17fb2eafefdfd167036e4dc258012c9882d` |
| codeteam 工作树 | clean（调研开始时） |
| Clowder 参考仓 | 只读本地 checkout，HEAD `5f8965e1e04dd3ac194cba53fa484bbc994d2dcd`；路径按 AGENTS.md 由 `$CLOWDER_AI_SOURCE` 提供，不写入文档 |
| Clowder 工具证书 | `packages/mcp-server/governance/mcp-surface-baseline.json`，schemaVersion 2，protectedBaseSha `265f7b998f7b8cae81d26d88db58351cf02b030d` |
| 当前 registry 校验 | 用 `node --import tsx` 导入 `packages/mcp-server/src/canonical-server-tools.ts`，得到 collab 165 / memory 23 / signals 12 / audio 11 / limb 6 / finance 1，总计 218；与 baseline 名称一致 |

### 1.2 主要来源

| 主题 | 参考路径 |
|---|---|
| MCP server 入口 / stdio | `packages/mcp-server/src/collab.ts` |
| 工具注册 / family 投影 | `packages/mcp-server/src/server-toolsets.ts`、`packages/mcp-server/src/canonical-tool-registry.ts`、`packages/mcp-server/src/canonical-server-tools.ts` |
| 核心 callback 工具 | `packages/mcp-server/src/tools/callback-tools.ts` |
| credential 解析 | `packages/mcp-server/src/tools/invocation-auth.ts`、`packages/mcp-server/src/native-turn-auth.ts` |
| refresh / retry / outbox / response budget | `packages/mcp-server/src/refresh-loop.ts`、`packages/mcp-server/src/tools/callback-retry.ts`、`packages/mcp-server/src/tools/callback-outbox.ts`、`packages/mcp-server/src/tool-response-budget.ts` |
| API auth preHandler | `packages/api/src/routes/callback-auth-prehandler.ts`、`packages/api/src/routes/callback-errors.ts` |
| invocation registry | `packages/api/src/domains/cats/services/agents/invocation/InvocationRegistry.ts` |
| tool execution policy | `packages/api/src/domains/cats/services/agents/invocation/tool-execution-policy.ts` |
| auth telemetry / in-context failure | `packages/api/src/routes/callback-auth-telemetry.ts`、`packages/api/src/routes/callback-auth-system-message.ts` |
| post / cross-post / multi-mention routes | `packages/api/src/routes/callbacks.ts`、`packages/api/src/routes/callback-multi-mention-routes.ts`、`packages/api/src/routes/callback-a2a-trigger.ts` |
| typed reasons | `packages/shared/src/types/callback-auth-reasons.ts` |
| codeteam W5a handler | `packages/codeteam-daemon/src/a2a/tools.ts`、`packages/codeteam-daemon/src/a2a/principal.ts` |
| codeteam auth | `packages/codeteam-daemon/src/auth/{tokens,resolver,headers,principals,mint,revoke,liveness}.ts` |
| codeteam worker control socket | `packages/codeteam-daemon/src/workers/control.ts`、`packages/codeteam-daemon/src/workers/tool-policy.ts` |
| codeteam control store | `packages/codeteam-daemon/src/control/store.ts`、`packages/codeteam-daemon/src/control/stores/*` |
| codeteam W5a 计划 | `docs/plans/0010-w5a-a2a-dispatch-custody.md` |
| codeteam W7 计划 | `docs/plans/0004-w5-w8-scale-product.md` |
| codeteam 架构 | `docs/architecture/0001-codeteam-architecture-v1.md` |
| callback-auth 复用卡 | `docs/architecture/reuse-review/callback-auth.md` |

### 1.3 边界

- 没有在 Clowder 上跑真实多 agent 调用；工具语义来自 registry 证书、schema、
  route 代码和现有测试/文档。
- 没有复制 Clowder 的账号、密钥、个人数据或本地绝对路径。
- 工具数量以 baseline + 当前 registry 交叉校验为准；如果参考仓后续新增
  工具，需要重新生成 companion inventory。
- 本文的 P0/P1 是“W7a 范围内的实现优先级”，不是“Clowder 工具价值排序”。

## 2. Clowder MCP 架构

### 2.1 进程与 transport

```text
agent runtime (cat session)
  │  stdio MCP
  ▼
cat-cafe-collab MCP process
  ├─ McpServer + StdioServerTransport
  ├─ canonical registry → collab family projection
  ├─ credential file (0600) / env fallback / native turn auth
  ├─ callbackPost/callbackGet → HTTP API
  └─ refresh loop (no new token)
        │
        ▼
Clowder API (Fastify)
  ├─ callback-auth preHandler
  ├─ InvocationRegistry (Redis / memory)
  ├─ callback routes
  └─ stores / queue / turn execution
```

- `packages/mcp-server/src/collab.ts` 只创建 `cat-cafe-collab-mcp`，注册
  collab toolset，并通过 `StdioServerTransport` 运行。
- MCP 进程不持有数据库；工具实现基本都是 `callbackPost` / `callbackGet`
  到 API。这是“薄 MCP”的关键：MCP 是 transport adapter，不是第二个控制面。
- `server-toolsets.ts` 从 canonical registry 按 `serverFamily` 投影；运行时
  再按 profile（`full` / `readonly` / `agent-key` / desktop / collective）过滤。
- 每个工具在注册时把 JSON Schema 转成 Zod；`additionalProperties:false`
  在 schema 层关闭未知字段。部分工具（如 `post_message` 的 invocation 形态、
  agent-key 合约、recall metrics）额外 `.strict()`，避免默认 Zod strip 把
  伪造字段吃掉而不报错。

### 2.2 工具注册与治理证书

- `canonical-server-tools.ts` 是唯一可执行目录；`CANONICAL_TOOL_REGISTRY`
  对每个工具校验 governance certificate：resource family、actions、
  annotations（readOnly/destructive/openWorld）、runtime profiles、schema
  delivery、implementation ref、verification ref、auth paths 等。
- `projectServerFamily` 按 family 投影；`derivedProfileSet` 从 registry
  派生 profile 集合，避免“第二份 allowlist”。
- 工具 schema 是 draft-07 JSON Schema；注册时转 Zod。输出统一是 MCP text
  content（JSON 字符串），错误用 `isError:true`，客户端靠 `[reason=...]`
  或 JSON body 判断 auth 失败。
- `tool-response-budget.ts` 对纯文本响应做 24,000 字符预算；超预算的纯读
  工具返回诚实的错误，不伪造 continuation；写工具/非文本内容不受这个替换。
- schema delivery 支持 `always-visible` / `host-default` / `discoverable`；
  这是为了控制工具列表的 token 成本，不是权限。

### 2.3 callback auth：preHandler + registry

`packages/api/src/routes/callback-auth-prehandler.ts` 的顺序：

1. 优先读 `X-Invocation-Id` + `X-Callback-Token` header；两者都缺失时才
   回退 body/query（legacy compat，且记录 `legacyFallbackHit`）。
2. 没有 invocation creds 时检查 `X-Agent-Key-Secret`；agent-key 有独立
   scope 和 failure reason。
3. 缺一个 header → 401 `missing_creds`；token 不匹配 → 401
   `invalid_token`；registry 找不到 → `unknown_invocation`；terminal/stale
   → 对应 typed reason。
4. `InvocationRegistry.verify` 先验 token，再验 active/terminal 生命周期；
   terminal tombstone 有 GC TTL，active 没有短 TTL。
5. 成功后 `derivePrincipal` 得到 `{kind:'invocation'|'agent_key', ...}`；
   `request.callbackPrincipal` 是后续 route 的唯一身份来源。
6. `toolExecutionPolicy` 检查 `callback_allowlist` / `read_only` /
   `collective_*`；不匹配 403，并记录 policy reason。
7. startup recovery 未完成时 503；refresh-token 有独立的 5 分钟 cooldown，
   cooldown 在 preHandler 之前短路，避免无意义 verify。

关键点：**身份不是 tool args 的一部分**。tool args 里的 `from`、`role`、
`owner`、`catId` 都不被当成授权；principal 只从 credential 派生。

### 2.4 invocation 生命周期与 refresh

- `InvocationRegistry.create` 生成 `invocationId + callbackToken`，绑定
  userId/catId/threadId/parentInvocationId/toolExecutionPolicy 等。
- active 无 deadline；terminal 后写 tombstone，30d 后 GC；latest slot 按
  `(threadId, catId)`，旧 invocation 不能 refresh。
- `refresh-token` 是 heartbeat/verify，不换 token：5 分钟 cooldown，
  `verifyLatest` 原子检查；terminal reason 会停止 refresh loop。
- MCP 进程从 `CAT_CAFE_CREDENTIAL_FILE` 每次调用重读 credential，支持
  session resume 后不重启 MCP 进程；文件优先于 env。
- native turn auth（Codex `_meta`）用 turn 绑定的 credential projection file，
  再调 `/api/callbacks/native-turn-admission` 做 canonical 验证；这是为了
  防止长期 MCP 进程拿旧 turn 的 token 跨 turn 使用。

### 2.5 工具调用链、幂等、错误

- `callbackPost` 调 `sendCallbackRequest`；重试 408/429/5xx，默认延迟
  `[1000, 2000, 4000]`，每次 10s fetch timeout。`callbackGet` 类似。
- `callback-outbox` 在显式 `enableOutbox` 时把可重试失败写入 0600 outbox；
  最多 10 次尝试；不是所有工具默认启用。
- 错误是 text + `isError:true`；401 body 是
  `{error:'callback_auth_failed', reason:'...'}`，客户端用
  `[reason=X]` 或 JSON 解析。这个“错误也在文本里”的形态不如 codeteam
  计划的 typed envelope，但 reason enum 是共享的。
- 幂等来源：
  - message：`clientMessageId`；服务端用 `(catId, clientMessageId)` 派生
    idempotency key，重复返回原 message，不同意圖 409；
  - `multi_mention`：`idempotencyKey`；
  - action successor：`clientMessageId` + `idempotencyKey` + `leaseId/generation`；
  - `hold_ball` 命令：`idempotencyKey` + `retryOfJobId`；
  - task/workflow/evolution 等：`expectedRevision` / `expectedSequence` CAS。
- 注意：不是每个写工具都强制幂等键。`post_message` 的普通消息只有可选
  `clientMessageId`；没有它时是 at-least-once。codeteam 不应继承这个缺口。

### 2.6 telemetry、限流、审计

- `callback-auth-telemetry.ts` 记录 OTel counter
  `cat_cafe.callback_auth.failures{tool, cat, reason}`，并有 24h ring buffer
  和 snapshot。
- `callback-auth-system-message.ts` 把可 surface 的 401 写回 thread（5min
  dedup；stale/unknown/missing 和后台 refresh 不 surface）。
- 没有通用 MCP rate limiter；只有特定工具/路由的限流：
  - refresh-token 5 分钟 cooldown；
  - `hold_ball` 每 `(thread, cat)` 1h 最多 3 次，单槽；
  - 部分 provider/protocol 有 429 重试。
- MCP 侧没有统一 audit 表；API route 的日志和 auth telemetry 是主要证据。
  工具调用审计更多依赖各 route 的业务记录（消息、task、queue、turn execution）。

### 2.7 对 codeteam 的启示

**值得复用：**

- 薄 MCP + 服务端 principal + 单一 canonical registry；
- header-only credential + 每次调用重读 token 文件；
- typed auth reason；
- 24k 响应预算、anchor-first 读取、`hasMore`/cursor；
- 写工具的 keyed/CAS 幂等；
- 读工具的 bounded window，不静默截断。

**不要照搬：**

- 165 个工具的多用途 overload（尤其 `post_message` 的 action/coordination/
  localReviewVerdict 混装）；
- 文本 `@` 路由 fallback；
- 用错误字符串判断 auth reason；
- 所有工具共用一个 HTTP callback surface，让 run token 和 operator 面
  共享 listener；
- 没有 transport-level 幂等的普通消息写。

## 3. 工具面 inventory

### 3.1 总量

| Family | 工具数 | resource families | 处置概述 |
|---|---:|---:|---|
| `collab` | 165 | 36 | P0 8 / P1 42 / P2 21 / Drop 94（按 Clowder 工具行计；P0 的 8 行映射为 10 个 codeteam 工具，另加 3 个 handoff 生命周期工具 = 13） |
| `memory` | 23 | 7 | P1 8 / P2 10 / Drop 5 |
| `signals` | 12 | 2 | Drop 12 |
| `audio` | 11 | 1 | Drop 11 |
| `limb` | 6 | 3 | Drop 6 |
| `finance` | 1 | 1 | Drop 1 |
| **合计** | **218** | 50 | — |

> 完整的逐工具清单（含 required/optional inputs、read/write/destructive、
> runtime profiles、幂等/权限语义、disposition、priority、codeteam target）
> 在 [`2026-10-29-clowder-mcp-tool-inventory.tsv`](2026-10-29-clowder-mcp-tool-inventory.tsv)。

### 3.2 collab 的 36 个 resource family

| Resource family | 工具数 | P0 | P1 | P2 | Drop |
|---|---:|---:|---:|---:|---:|
| `active-execution` | 1 | 0 | 1 | 0 | 0 |
| `approval-index` | 1 | 0 | 1 | 0 | 0 |
| `artifact-surface` | 6 | 0 | 2 | 0 | 4 |
| `cat-life` | 4 | 0 | 0 | 0 | 4 |
| `collaboration-orchestration` | 2 | 0 | 0 | 1 | 1 |
| `collaborative-content` | 10 | 0 | 0 | 0 | 10 |
| `collective-participation` | 8 | 0 | 0 | 0 | 8 |
| `community-case` | 4 | 0 | 0 | 0 | 4 |
| `eval-feedback` | 8 | 0 | 3 | 0 | 5 |
| `event-memory` | 2 | 0 | 1 | 0 | 1 |
| `evolution-program` | 13 | 0 | 0 | 0 | 13 |
| `game` | 1 | 0 | 0 | 0 | 1 |
| `guide-bootcamp` | 6 | 0 | 0 | 0 | 6 |
| `harness-history` | 2 | 0 | 2 | 0 | 0 |
| `home-state` | 2 | 0 | 2 | 0 | 0 |
| `hub-action-surface` | 1 | 0 | 0 | 0 | 1 |
| `identity-proposal` | 5 | 0 | 0 | 0 | 5 |
| `label-taxonomy` | 1 | 0 | 1 | 0 | 0 |
| `live-meeting` | 5 | 0 | 0 | 0 | 5 |
| `memory-cue` | 2 | 0 | 0 | 2 | 0 |
| `memory-write` | 5 | 0 | 0 | 0 | 5 |
| `owner-page-action` | 2 | 0 | 0 | 0 | 2 |
| `person-memory` | 10 | 0 | 0 | 0 | 10 |
| `plugin-manager` | 8 | 0 | 0 | 8 | 0 |
| `runtime-control` | 2 | 0 | 0 | 0 | 2 |
| `runtime-interaction` | 2 | 0 | 0 | 0 | 2 |
| `runtime-session` | 1 | 0 | 0 | 1 | 0 |
| `schedule` | 4 | 0 | 4 | 0 | 0 |
| `session-handoff` | 1 | 0 | 0 | 0 | 1 |
| `skill-consumption-receipt` | 7 | 0 | 0 | 7 | 0 |
| `source-custody` | 2 | 0 | 2 | 0 | 0 |
| `task-custody` | 1 | 0 | 1 | 0 | 0 |
| `task-workflow` | 16 | 3 | 11 | 2 | 0 |
| `thread-message` | 12 | 5 | 3 | 0 | 4 |
| `thread-proposal` | 2 | 0 | 2 | 0 | 0 |
| `tracking-review` | 6 | 0 | 6 | 0 | 0 |

### 3.3 输出、幂等、权限的统一口径

TSV 的 `idempotency` / `permission` 列是分类，不是对每个 route 的逐行证明：

| 类 | 含义 |
|---|---|
| `safe retry (read)` | readOnly 工具；无副作用，可安全重试 |
| `keyed: clientMessageId` | 服务端按 principal+key 去重；重复返回原结果，不同意圖冲突 |
| `keyed: idempotencyKey` | 工具/命令级 replay-safe admission |
| `keyed: operationId` | 长操作/内容修改的 exactly-once intent |
| `CAS: expectedRevision` | 乐观并发；版本不匹配 409 |
| `domain CAS/at-least-once; add transport requestId` | 写工具没有统一幂等键；codeteam W7a 必须加 transport 幂等层 |
| `callback principal; thread/task/owner read scope` | 读取必须由服务端按 principal 过滤，不能只信 threadId |
| `invocation-token required for structured action` | `post_message`/`cross_post`/`multi_mention` 的 action custody；agent-key 不可用 |
| `callback principal + owner/operator; destructive explicit` | destructive 需要 owner/operator 明确授权 |

## 4. 映射与取舍

### 4.1 命名：不加 Clowder 别名

**决定：codeteam agent-facing MCP 工具只用 codeteam 名字，不注册
`cat_cafe_*` 别名。**

理由：

- 工具名是授权/审计/测试的稳定坐标；两套名字会制造第二个 allowlist 和
  第二套 telemetry key。
- codeteam 的 `a2a_send`/`handoff_*` 与 Clowder 的 `post_message` 语义
  不同（前者拆分讨论与 custody），同名别名会诱导模型把 action 字段塞进
  `a2a_send`。
- W7b 如果要做 Hub 兼容，应在 **Hub projection adapter** 里做 Clowder
  REST/WS 形状映射，而不是在 MCP 工具面加别名。
- 保留一份 mapping 文档/TSV 即可；运行时不做双写。

### 4.2 `post_message` / `cross_post_message` / `multi_mention`

| Clowder 工具 | codeteam 处置 | 映射 |
|---|---|---|
| `cat_cafe_post_message` | **adapt，拆分** | 讨论/通知 → `a2a_send`；责任转移 → `handoff_create`；operator 聊天 → CLI/Console 的 `thread_post`（不是 run-token MCP） |
| `cat_cafe_cross_post_message` | **adapt，P1** | 显式 `threadId + target` 的 `a2a_send`（跨 thread），需要独立授权；不做正文 `@` fallback |
| `cat_cafe_multi_mention` | **defer，P2** | 多 target fan-out 已由 `a2a_send`/`handoff_create` 的 multi-target 覆盖；`callbackTo` 聚合/request status 另做 read model，不新增 custody 载体 |

具体拆法：

- **`a2a_send`**：只做 `question|answer|proposal|finding|status`，写 message +
  queue entry，**不改 custody**；target 必须是同 task/thread 的 active
  session。`replyTo` 只允许同 thread。
- **`handoff_create`**：责任转移；必须有 `kind/subject/subjectRef/actionFamily/
  successorSlot/expectedArtifact/deadline/idempotencyKey/terminalPredicate`；
  写 handoff + custody event + visible message + queue entry。
- **`handoff_claim/complete/withdraw`**：holder/author 生命周期；claim 非
  holder 返回 `safe_wait`；complete 只写 completion candidate，不自行
  verified commit；withdraw 只允许 author。
- **`thread_post`**：operator/Console 聊天写入，operator credential；agent
  的最终回复由 daemon 在 run terminal 写 response bubble，不需要 MCP 工具。
- **`multi_mention` 的 `searchEvidenceRefs`/`overrideReason`**：不进入
  codeteam tool schema；这是“先搜后问”的 skill/SOP 约束，不是授权字段。
- **`localReviewVerdict`/`reviewedHeadSha`/`acceptedSourceRef`**：不放在
  message 上；P1 用 `review_submit` / review record，带 exact HEAD 和
  findings。
- **`action`/`proposedAction`/`coordination`/`effectClass`**：不复制。
  责任转移用 `handoff_*`；operator-gated 新责任用 `approval_request`（P1）；
  coordination 用 handoff/custody 投影，不用 message 可选字段。

### 4.3 thread / message

| Clowder | codeteam | 处置 | 说明 |
|---|---|---|---|
| `cat_cafe_list_threads` | `thread_list` | reuse/P0 | 按 principal.userId / task 成员过滤；不返回全局 thread |
| `cat_cafe_get_thread_context` | `thread_context` | reuse/P0 | anchor-first、bounded window、`hasMore`/`nextCursor`；默认当前 thread |
| `cat_cafe_get_message` | `message_get` | reuse/P0 | preview/full；contextCount 有上限；必须检查 thread 访问 |
| `cat_cafe_get_thread_cats` | `thread_participants` | adapt/P0 | `routableNow` 只表示当前有 active session；不是在线/配额承诺；dispatch 重新校验 |
| `cat_cafe_get_thread_metadata` | `thread_metadata_get` | reuse/P1 | 低频 metadata anchor |
| `cat_cafe_set_thread_metadata` | `thread_metadata_update` | adapt/P1 | merge 语义；不授予 approval/merge 权限 |
| `cat_cafe_list_labels` | `thread_labels_list` | reuse/P1 | Console 导航 |
| `cat_cafe_propose_thread` | `thread_propose` | adapt/P1 | proposal card，不直接建 thread |
| `cat_cafe_cross_post_message` | `a2a_send` cross-thread | adapt/P1 | 独立授权，见 4.2 |
| `cat_cafe_ack_mentions` / `get_pending_mentions` | — | drop | codeteam 没有文本 @ 路由 inbox |
| `cat_cafe_feat_index` / `teleport` | — | drop | 由 backlog/docs/Hub UI 承担 |

### 4.4 handoff / custody

**Clowder 没有 `handoff_create` / `handoff_claim` / `handoff_complete` /
`handoff_withdraw` 这组工具。** 它的责任转移主要藏在：

- `post_message` / `cross_post_message` 的 `action` / `proposedAction`；
- `hold_ball` / `get_hold_status`；
- `create_task` / `update_task` / entrusted work；
- action successor lease/generation。

codeteam 的 `handoff_*` 是 W5a 已经冻结的 codeteam-native surface，不应为了
“像 Clowder”而改名或加别名。可复用的是**语义**：

- 单一 queue entry + targets；
- holder claim 是短时 cutover；
- completion candidate 与 verified commit 分离；
- blocked 必须声明 `completes` / `bounces_back_to_owner`；
- `(taskId, idempotencyKey)` replay 返回原 handoff/message/queue；
- custody events append-only，projection 只读 + anomaly。

### 4.5 task / workflow / backlog

| 层 | codeteam | 优先级 | 说明 |
|---|---|---|---|
| task read | `task_list` | P0 | 只读投影；按 thread/task 范围过滤 |
| task write | `task_create` / `task_update` | P1 | 需要 backlog/thread binding；不替代 entrusted work close |
| entrusted work | `work_admit` / `work_get` / `work_update` / `work_close` / `work_resolve` | P1 | 来自 `admit_entrusted_work` / `read_entrusted_work` / `update_entrusted_work` / `close_entrusted_work` / `development_work` |
| SOP | `workflow_get` / `workflow_update` | P1 | 告示牌，不是流程控制；resume capsule/checks 复用 |
| source custody | `custody_offer` / `custody_admit_retry` | P1 | source-owned offer；未接受不建 Task |
| deployment wait | `deployment_wait_register` | P1 | W5c；single-fire，revision/new boot |
| child return | `work_return` / `work_return_read` | P2 | codeteam handoff 已覆盖 P0；多 thread 编排再评估 |

`hold_ball` 不属于 task 写面；它映射到 wait，见 4.6。

### 4.6 wait

| Clowder | codeteam | 处置 | 说明 |
|---|---|---|---|
| `cat_cafe_hold_ball` | `wait_arm` / `wait_cancel` | adapt/P0 | 用 W5a typed wait contract；P0 只支持 timer/event；managed command 是 P1/W5c |
| `cat_cafe_get_hold_status` | `wait_status` | reuse/P0 | 读 wait/受管任务状态；不隐式唤醒 |

不要复制 `hold_ball` 的“持球”心智和 3 次/小时单槽限制；codeteam 的 wait
是 typed source + SLA + owner fence，缺证据 fail closed。`wait_cancel` 的
actor 必须从 run principal 派生；`user_cancel` 仍只允许 operator。当前
`WaitContractService.terminate` 只在 `user_cancel` 检查 user owner，其他
reason 没有 owner 检查，W7a wrapper 必须补 exact owner fence 校验。

### 4.7 review / approval

- Clowder 的 approval 读面只有 `cat_cafe_get_pending_decisions`；decide 在
  UI/REST operator 域，不是 MCP 工具。codeteam 保持同样边界：
  - P1 `approval_list` / `approval_get` / `approval_request`；
  - **不提供 `approval_decide` MCP tool**；
  - operator CLI/Console 用 operator credential 调 `approvals.decide`；
  - `assertApprovalDecisionPrincipal` 继续只接受 operator。
- Clowder 的 local review  verdict 挂在 `post_message`/`cross_post_message`
  上；codeteam 不复制这个 overload。P1 用 `review_request` /
  `review_submit` / `review_get` / `review_list`，payload 带 exact
  `reviewedHeadSha`、`reviewSubjectRef`、`acceptedSourceRef`、
  `acceptedRevision`、findings/falsifier。媒体/文档 artifact review 全部 Drop。
- 外部 review（W8）用 `review_external_verdict` / `review_external_recover` /
  `review_transfer`，依赖 GitHub tracking 契约，不在 W7a P0。

### 4.8 artifact / memory

- Clowder artifact surface 是 rich block/image/document/video；codeteam 的
  artifact 是 `spec/plan/diff/test-report/review/verification/merge-receipt`。
  只复用 `ArtifactStore` 的不可变内容 + sha256 + `provenance.sourceMessageId`，
  不复用媒体工具。
- P1：`artifact_put` / `artifact_get` / `artifact_list`；`create_rich_block` /
  `rich_block_rules` 只用于 Console 投影，不是 artifact 真相。
- Drop：`generate_document` / `preview_open` / `publish_image` /
  `workspace_navigate` / 全部 collaborative-content（DOCX/视频/图片 review）。
- memory family 是独立 server；W6 复用 evidence search/graph/recent/file
  slice/session chain/digest/events/invocation detail；personal memory、
  diaries、meeting artifact、distillation 全部 Drop。P1b，不进 W7a P0。

### 4.9 queue / run / admin

- P1 read models：`run_list_active`（来自 `get_running_work`）、
  `handoff_events`（来自 `get_custody_events`）、`run_events_list`（来自
  `list_events`）、`capabilities_snapshot` / `home_state_self`。
- P1 operator/admin：schedule 4 个、thread metadata/labels/proposal、
  work/task/SOP、approval 读面、review、artifact、rich block。
- P2：plugin manager 8 个、skill consumption 7 个、memory cue 2 个、
  external runtime session 1 个、development return 2 个、multi_mention 1 个。
- Drop：所有 IM/语音/会议/社区/collective/game/guide/cat-life/page action/
  personal memory/evolution program/shell/read-mode。

## 5. 鉴权分析

### 5.1 三个 auth 域

| 域 | Credential | Transport | 可做 | 不可做 | 失败 |
|---|---|---|---|---|---|
| Operator | `operator.key` / console session | CLI / Console HTTP/WS | thread chat、approval decide、硬门 merge、配置、不可逆操作 | 不能替代 run token 调 MCP | typed operator failure |
| Run | per-run token | MCP → daemon control socket（推荐） | A2A/custody/read/wait、`approval_request`（P1） | approval decide、merge execute、跨 thread 读、shell | 401 typed reason / 403 policy |
| Forge | webhook HMAC (W8) | HTTP webhook | inbound issue/PR/check/comment 触发 | 不直接改 work state | 403 / dedup |

三域互不替代：run token 打 approval decide/merge 必须 403；webhook HMAC 不能
当 run token；operator credential 不应作为 MCP 的默认凭据。

### 5.2 per-run token 与 principal

W2 已有 `invocation_credentials`：

- token 只存 hash+salt；token 文件 0600，目录 0700；
- 绑定 `runId/taskId/role/agentSessionId/agentProfileId/threadId/userId/
  ownerAuthProvenance/parentRunId/toolPolicy/callbackAllowlist/state/disposition`；
- active 无 TTL；terminal tombstone 30d；`revokeCredentialsForRun` 在 run
  terminal 撤销；
- `resolveInvocationToken` 校验 token hash、state、expiresAt，返回
  `InvocationBinding`；W5a `resolveRunPrincipal` 再校验 run/task/session/
  profile/role/thread 一致，得到 `RunPrincipal`。

W7a 必须：

1. **token 只从 `Authorization: Bearer` 或 control socket request 的 token
   字段读取**，拒绝 query/body token；MCP 进程从 0600 token file 每次调用
   重读，不缓存。
2. **principal 只从 token binding 派生**；tool args 出现 `from`、`role`、
   `ownerUserId`、`profileId`、`agentProfileId`、`userId` 等字段一律
   `invalid_input`；不要用 JSON Schema 的默认 strip 吃掉它们。
3. **mint 时注入 `callbackAllowlist`**：P0 13 个工具名；role-specific
   allowlist 可在 P1 细化。当前 `RpcAgentExecutor` 只传 native
   `toolPolicy`，`callbackAllowlist` 为空，这是 W7a 必须补的第一行。
4. **同一 `(threadId, agentSessionId)` 只能有一个 active credential**：
   mint 新 run 时把旧 active 标 `replaced`；旧 token 返回 typed
   `replaced`。当前 store 允许多个 active，W7a 要加 latest/replaced 语义。
5. **读工具按 principal 过滤**：`thread_context`/`message_get` 只读
   `principal.threadId`；`thread_list`/`task_list` 按 `principal.userId` /
   task 成员过滤；`thread_participants` 同 thread。不能只信 args 的 threadId。
6. **wait_cancel 校验 exact owner fence**；`user_cancel` 只允许 operator。

### 5.3 typed auth failure

当前 codeteam `resolveInvocationToken` 对 terminal/expired 都抛
`ControlError('invalid_token')`，丢失了 callback-auth 卡要求的 terminal
disposition。W7a 应增加 `verifyInvocationToken` 的 discriminated union：

```ts
type CredentialFailureReason =
  | "missing_creds"
  | "invalid_token"
  | "unknown_invocation"
  | "stale_invocation"
  | "completed"
  | "failed"
  | "interrupted"
  | "replaced"
  | "revoked"
  | "canceled";

type CredentialVerifyResult =
  | { ok: true; binding: InvocationBinding }
  | { ok: false; reason: CredentialFailureReason };
```

HTTP/control-socket 401 body：

```json
{
  "error": "callback_auth_failed",
  "reason": "replaced",
  "retryable": false
}
```

客户端只消费 `reason` enum，不匹配文案。`missing_creds` 是 transport 层
（没有 Authorization）；`unknown_invocation` 是 credential id 不存在；
`invalid_token` 是 secret 不匹配；terminal dispositions 直接来自
`disposition`。

### 5.4 approval / merge 边界

- `assertApprovalDecisionPrincipal`：只接受 `kind === 'operator'`。
- `assertMergeExecutionPrincipal`：只接受 `service:merge-owner`。
- `merge:execute` 由 daemon `MergeExecutor` 执行，CLI `codeteam merge
  execute` 需要 operator key 来 mint per-merge service credential；**不暴露
  MCP/REST**。
- `approval:record`/`merge:record` 由 daemon 同事务写；不是 agent 工具。
- MCP 工具面只允许 `approval_request`（P1）创建 proposal，不允许 decide；
  不注册任何 merge 工具。测试必须断言 `tools/list` 不含这些名字，且直接
  调用返回 `unknown_tool`/403。

### 5.5 agent-key

- callback-auth 卡：agent-key 契约 P0、签发 P1；v1 主路径 per-run token。
- W7a 不需要 `X-Agent-Key-Secret`；如果未来 external/IDE direct 需要，
  仍由服务端派生 principal，tool args 不携带 `agentKeyCatId` 作为身份。
- 不把 Clowder 的 `agentKeyCatId` 参数复制到 codeteam P0 schema。

### 5.6 W7a 威胁矩阵

| 威胁 | 防线 | 测试 |
|---|---|---|
| 伪造 `from/role/owner` | strict schema + principal from token | unknown field 400 |
| token 泄漏到 args/query/body | header/socket only；token file 0600；path deny | query/body token 400 |
| 旧 run token 继续用 | terminal revoke + replaced/latest | 旧 token 401 replaced |
| 跨 thread 读 | read scope 检查 | 不同 threadId 403/404 |
| 重放写请求 | requestId ledger + domain idempotency | duplicate -> same result |
| agent 调 approval decide | 不注册工具 + operator principal 检查 | tools/list + call 403 |
| agent 调 merge | 不注册工具 + service principal 检查 | tools/list + call 403 |
| agent 通过 MCP 执行 shell | 不注册 shell_exec；pi bash 受 sandbox/policy | unknown tool |
| agent-key 冒充 invocation action | action carriers 只允许 invocation token | agent-key action 400 |
| MCP 进程直接读 SQLite | MCP 只连 control socket；no DB dependency | package boundary test |

## 6. 服务架构建议

### 6.1 Clowder vs codeteam W7a

| 维度 | Clowder | codeteam W7a 建议 |
|---|---|---|
| MCP 进程 | 每 agent runtime 一个 stdio 子进程 | 每 worker/run 一个 stdio 子进程；由 pi MCP client 启动 |
| MCP 到控制面 | HTTP API + callback headers | **0600 Unix worker control socket + JSON line**；HTTP 只给 Console |
| 工具目录 | 218 个 canonical tools；165 collab | 13 个 P0 工具；codeteam-native 名字 |
| 身份 | invocation header / agent-key | per-run token；control socket token 字段；无 args 身份 |
| Store | Redis | SQLite 单写者（daemon） |
| 错误 | 401 typed reason + text error | typed JSON envelope + MCP `isError` |
| 幂等 | clientMessageId/idempotencyKey/CAS | requestId ledger + domain idempotency/CAS |
| 输出 | 24k 预算 | 24k 预算 + pagination |
| 重试 | 3 次 + outbox | P0 不做 outbox；同 requestId 重试 |
| telemetry | OTel callback auth failures | audit + tool_usage + OTel auth failures |
| 限流 | refresh cooldown / hold 3/h | P0 无通用限流；P1 per-run quota |
| 边界 | MCP 无 DB；API 是控制面 | MCP 无 DB；daemon 是唯一控制面 |

### 6.2 推荐拓扑

```text
pi worker (per run / sticky session)
  ├─ native tools (read/bash/edit/...)
  ├─ codeteam-mcp (stdio MCP server)
  │     ├─ reads token file 0600 (per call)
  │     └─ JSON line over CODETEAM_CONTROL_SOCKET
  ▼
daemon
  ├─ WorkerControlServer (0600 Unix socket)
  │     ├─ type:"mcp_tool_call"
  │     ├─ verify token → InvocationBinding → RunPrincipal
  │     ├─ callbackAllowlist + read scope
  │     └─ A2AToolHandlers / read models / wait service
  ├─ SQLite control store (single writer)
  └─ HTTP /health /ready /metrics
        ▲
        │ operator credential
  Console / CLI (W7a/W7b)
```

为什么不是 P0 新开 HTTP MCP 面：

- run token 面与 operator HTTP 面共享 listener，容易把“MCP 工具”暴露成
  普通 REST；Unix socket 0600 天然只允许本机同 uid，且已有 W5b 的 token
  校验、worker binding、frame limit、audit 拒绝路径。
- control socket 已经在 `packages/codeteam-daemon/src/workers/control.ts`
  落地：`start()` 创建 socket，0600，`MAX_FRAME_BYTES=4MB`，
  `MAX_CONNECTIONS=128`，token 校验 + worker/session binding + tool policy
  deny audit。W7a 只需新增 `type:"mcp_tool_call"`，不另起一套服务器。
- Console 仍需要 HTTP/WS/SSE，但它走 operator credential，和 run-token
  MCP 是两个 listener、两个 auth 域。这样 5.1 的三域矩阵在物理上也分开。

如果 W0a 的 pi MCP bridge 不能把 `CODETEAM_CONTROL_SOCKET` 传给 MCP
子进程，再退回 loopback HTTP；这是 fallback，不是默认。

### 6.3 control socket 协议

请求（一行 JSON）：

```json
{
  "id": "req-...",
  "type": "mcp_tool_call",
  "token": "<run-token>",
  "toolName": "a2a_send",
  "requestId": "client-generated-uuid",
  "input": { "kind": "question", "targets": ["profile:reviewer"], "bodyMd": "..." }
}
```

响应：

```json
{ "id": "req-...", "ok": true, "data": { "...": "..." } }
```

或：

```json
{
  "id": "req-...",
  "ok": false,
  "error": {
    "code": "forbidden",
    "reason": "tool_not_in_allowlist",
    "message": "tool a2a_send is not allowed for this run",
    "retryable": false,
    "details": null
  }
}
```

约束：

- token 只在 socket 请求体/`Authorization` 语义中出现；不接受 tool args
  内的 token。
- `toolName` 必须在 per-run `callbackAllowlist`；否则 403
  `tool_not_in_allowlist`。
- `input` 必须是 object；未知字段拒绝；`requestId` 必填（读工具可省略）。
- 单行 frame ≤ 4MB；响应文本 ≤24k；超限返回 typed error，不截断后假装成功。
- 连接只允许本机；socket 0600；daemon 退出清理；不监听 TCP。

### 6.4 工具 registry

建议 codeteam 自己的小 registry（不复制 Clowder 的 218 项治理证书）：

```ts
type CodeteamToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // additionalProperties:false
  effect: "read" | "write" | "destructive";
  idempotency: "none" | "requestId" | "domainKey";
  requiredAllowlist: true;
  handler: "a2a_send" | "handoff_create" | ...;
  responseBudget: 24_000;
  auditAction: string;
};
```

- 单一 registry 同时供 daemon `mcp_tool_call` 路由和 MCP `tools/list` 使用；
  放在共享 contract package，避免两份 schema 漂移。
- `callbackAllowlist` 从 registry 的 run profile 派生；P0 13 个；不要手工
  写第二份字符串数组。
- `effect` 用于测试/审计；`read` 不写 audit（只 tool_usage），`write`
  写 audit + tool_usage，`destructive` 需 operator/owner（P0 没有）。
- `idempotency`：`a2a_send`/`handoff_*`/`wait_*` 用 `requestId`；
  `handoff_create` 同时保留 domain `idempotencyKey`；`wait_arm` 可用
  `requestId` 生成 waitId。

### 6.5 错误 schema

建议统一 envelope：

```json
{
  "error": {
    "code": "conflict",
    "message": "handoff idempotency key was used by another intent",
    "retryable": false,
    "details": { "handoffId": "..." }
  }
}
```

映射：

| ControlError code | transport | retryable |
|---|---|---:|
| `invalid_token` / `unknown_invocation` / terminal reasons | 401 | false |
| `forbidden` / allowlist / scope | 403 | false |
| `not_found` | 404 | false |
| `invalid_input` / `invalid_state` | 400 | false |
| `conflict` / `version_conflict` / `claim_conflict` | 409 | false |
| `capacity_exhausted` / `budget_paused` | 409/429 | maybe |
| `a2a_depth_exceeded` | 400/429 | false |
| `command_failed` | 500 | maybe |
| daemon starting/recovering | 503 | true |

MCP 层：`content:[{type:'text', text: JSON.stringify(envelope)}]`，
`isError:true`。不要只返回人类可读字符串；否则弱模型会开始猜。

### 6.6 幂等 ledger

建议新增 daemon 表 `mcp_tool_invocations`：

```sql
CREATE TABLE mcp_tool_invocations (
  credential_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (credential_id, request_id)
);
```

规则：

- 同一 `(credential_id, request_id)` + 同 `request_hash` → 返回原
  `response_json`，不重复写 message/queue/handoff。
- 同一 key + 不同 hash → 409 `idempotency_conflict`。
- 只对 mutating tools 强制；read tools 可省略 requestId。
- domain 幂等（`handoff_create.idempotencyKey`、approval idempotencyKey）
  仍是业务真相；transport ledger 是外层重放保护，两者不互相替代。
- 这补上 W5a `a2a_send` 没有 idempotencyKey 的缺口。
- TTL 与 credential tombstone 一致（30d）或按 run terminal 清理；不要在
  active run 上 TTL。

### 6.7 输出、限流、审计

- 24k 响应预算；读工具用 `limit`/`cursor`/`hasMore`，不静默截断。
- P0 不引入通用 rate limiter；用 per-run quota（P1）和已有 wait/handoff
  约束。至少加 `maxTargets`（如 16）和 `maxBodyChars`（如 100k）防 DoS。
- 每个 mutating tool 写 `audit`：`actor=profile:<id>`、`action=mcp:<tool>`、
  `subject`、`args` 只存摘要/长度/hash（消息正文已经在 messages 表，不重复
  存全文）；每个调用写 `tool_usage`（tool/run/profile/duration/status）。
- auth failure 写 OTel counter
  `codeteam.mcp.auth_failures{tool,reason,profile}`；不写 token/secret。
- 审计拒绝（allowlist/scope）也要写 audit；参考 W5b
  `worker_tool_denied`。

### 6.8 daemon 边界

- MCP 进程不得 import `ControlStore`、不得打开 SQLite、不得读 artifact 文件；
  只能通过 control socket。
- MCP 进程不得执行 shell；pi 的 bash 工具仍走 native tool policy/sandbox。
- MCP 工具面不得暴露 approval decide、merge execute、cross-thread admin、
  plugin install、operator config。
- daemon 重启时 MCP 调用返回 503/`daemon_unavailable`；MCP server 不缓存
  写结果，不自己重放。
- Console HTTP/WS/SSE 与 MCP socket 共享 service 层，不共享 auth middleware；
  两边都调用同一 `RunPrincipal`/operator principal 校验。

## 7. 优先级

### 7.1 P0：W7a A2A E2E 最小可用（13 个工具）

| codeteam tool | 来源 | 语义 | 验收 |
|---|---|---|---|
| `a2a_send` | `post_message` 讨论子集 + `multi_mention` 多 target | message + queue，不改 custody | 同 task/thread target；多 target 并行；无 custody 变化 |
| `handoff_create` | Clowder `post_message.action` 语义 + W5a | 责任转移 + message + queue + custody | 自报 from 拒绝；idempotency replay；方向白名单 |
| `handoff_claim` | W5a native | holder 接球 | 非 holder `safe_wait`；同 holder 第二 run `safe_wait` |
| `handoff_complete` | W5a native | completion candidate | 不自行 verified；evidenceRef 必填；candidate 覆盖，transport requestId 去重 |
| `handoff_withdraw` | W5a native | author 撤回 | 非 author 403；terminal 不可撤回 |
| `thread_list` | `list_threads` | principal 可见 thread | 按 user/task 过滤；无全局泄漏 |
| `thread_context` | `get_thread_context` | bounded/anchor read | 当前 thread；`hasMore`/cursor；24k |
| `message_get` | `get_message` | message/reply context | thread 访问检查；contextCount ≤10 |
| `thread_participants` | `get_thread_cats` | routable target discovery | 同 thread；不承诺在线/配额 |
| `task_list` | `list_tasks` | task 投影 | 按 thread/task/user 过滤 |
| `wait_arm` | `hold_ball` timer/event 子集 | typed wait | kind/source/SLA/fence/expectedSignal |
| `wait_status` | `get_hold_status` | wait 读 | 不隐式唤醒 |
| `wait_cancel` | `hold_ball` cancel 子集 | wait 终止 | exact owner；`user_cancel` 只 operator |

P0 不在表内但必须同时交付：

- token auth：`Authorization: Bearer` / control socket token、header-only、
  typed 401、`callbackAllowlist`。
- principal：`resolveRunPrincipal` + no self-reported identity。
- idempotency：`mcp_tool_invocations` + `requestId`。
- audit/tool_usage/OTel。
- MCP `tools/list` 不含 approval decide / merge / shell / cross-thread admin。

### 7.2 P1a：operator / Console / backlog / review / approval（31 个 Clowder P1 工具行）

P1a 覆盖 31 个 Clowder P1 工具行：

- `thread-message` 3（`cross_post_message`、`get_thread_metadata`、
  `set_thread_metadata`）+ `label-taxonomy` 1 + `thread-proposal` 2 = 6
- `task-workflow` 11 + `source-custody` 2 + `task-custody` 1 = 14
- `approval-index` 1（`approval_list`；decide 不在 MCP）
- `active-execution` 1（`run_list_active`）
- `schedule` 4（template/preview/register/remove）
- `artifact-surface` 2（`rich_block_create/rules`）
- `home-state` 2（`capabilities_snapshot`、`home_state_self`）
- `event-memory` 1（`run_events_list`）

= 31 行（42 P1 减去 P1b 的 11 个 W6/W8 项）。

映射后会新增若干 codeteam 目标工具，它们不是 Clowder P1 行，因此不计入
31：`approval_request`、`artifact_put/get/list`、`review_request/submit/
get/list`、`thread_post`（operator only）等。

### 7.3 P1b：W6/W8 依赖（11 collab + 8 memory）

- W6 eval/harness：`eval_repair_propose`、`eval_publish_verdict`、
  `eval_lifecycle_record`、`eval_harness_history_get/publish`（5 collab）
- W8 GitHub：`review_external_verdict/recover/transfer`、
  `forge_tracking_register_pr/issue`、`forge_tracking_unregister`（6 collab）
- W6 memory：`memory_search/graph/recent/file_slice/session_chain/
  session_digest/session_events/invocation_detail`（8 memory）

这些不是 W7a P0；依赖 W6/W8 的 schema/凭据/对账。不能因为 MCP 工具能调
就宣称 W6/W8 完成。

### 7.4 P2：defer（21 collab + 10 memory）

- `multi_mention` 聚合/request status（1）
- `memory_cue_drill/outcome`（2）
- plugin manager 8 个（P1-defer cell）
- external runtime session register（1）
- skill consumption 7 个（W6 eval 测量）
- development return / read（2）
- memory P2：recall metrics、perspective、library 6、external runtime
  read/list（10）

### 7.5 Drop（94 collab + 5 memory + 12 signals + 11 audio + 6 limb + 1 finance）

按原因分组：

- **个人记忆/身份**：person-memory 10、memory-write 5、identity-proposal 5、
  memory 的 distillation/retain 5。
- **Clowder 生活面**：cat-life 4、live-meeting 5、collaborative-content 10、
  guide-bootcamp 6、owner-page-action 2、hub-action 1、game 1、session-handoff 1。
- **Collective/community/evolution**：collective 8、community 4、
  evolution 13；这些是 P1-defer/Drop cell，不进 code-delivery MCP。
- **工具面噪音**：ack/pending mentions、feat index、teleport、start vote、
  request_user_input/manage conversation decision、shell_exec、set_read_mode、
  backfill_events、paw-feel 5。
- **artifact 非代码面**：generate_document、preview_open、publish_image、
  workspace_navigate。
- **独立 server 非目标**：signals 12、audio 11、limb 6、finance 1。

### 7.6 风险与依赖

| 优先级 | 依赖 | 风险 | 处置 |
|---|---|---|---|
| P0 | W5a handler/store；W2 token；W5b control socket | 读工具越权；`a2a_send` 重放 | scope 测试 + requestId ledger |
| P0 | pi MCP env propagation（W0a） | MCP 子进程拿不到 socket/token file | W0a spike；fallback loopback HTTP |
| P1a | W3 review、W4 SOP、W1 artifact、operator Console | 工具面膨胀；approval 越权 | 每项单独 registry/profile；approval decide 不进 MCP |
| P1b | W6 memory/eval；W8 GitHub | 提前宣称完成 | 明确依赖；MCP 只做 transport |
| P2 | plugin/skill/lifecycle | 包管理/权限复杂度 | 保持 defer，不挖坑 |
| Drop | — | 误把 Drop 工具重新引入 | registry 负向测试；`tools/list` snapshot |

## 8. W7a 实现切片建议

> 以下只是建议，不在本 PR 写代码；实现前需要 operator 确认 transport 与
> P0 scope。

### 8.1 切片

| 切片 | 内容 | 可观察结果 | 测试 |
|---|---|---|---|
| S0 | `packages/codeteam-protocol`（或同等共享 contract）：13 个 tool specs、error envelope、idempotency/requestId 类型 | daemon 与 MCP 共用一份 schema | schema snapshot；无重复定义 |
| S1 | daemon `mcp_tool_call` control handler：token → binding → principal → allowlist → dispatch | 从一个 socket 调用 `a2a_send` 成功 | socket 集成测试 |
| S2 | typed credential verify + latest/replaced + callbackAllowlist 注入 | 旧 token 401 replaced；allowlist 外 403 | auth matrix |
| S3 | `packages/codeteam-mcp` stdio server：tools/list、tools/call、token file 每次重读 | MCP client 能 list/call 13 个工具 | stdio transport test |
| S4 | requestId ledger + domain idempotency 对接 | 重放不双写；冲突 409 | concurrent duplicate test |
| S5 | read models：thread/task/message/scoped | 跨 thread 读被拒；分页正确 | scope/pagination test |
| S6 | wait wrapper：exact owner fence + cancel authority | 非 owner cancel 403；缺 SLA 400 | wait matrix |
| S7 | audit/tool_usage/OTel + response budget | 每次调用可审计；无 secret | audit/telemetry test |
| S8 | A2A E2E：两 agent、handoff、one terminal | A→B 讨论/责任转移闭环 | integration |

### 8.2 包布局

```text
packages/codeteam-protocol/        # 新：tool specs + error/idempotency types
packages/codeteam-mcp/             # 新：stdio MCP server + control socket client
packages/codeteam-daemon/src/mcp/  # 新：control handler + registry + idempotency
packages/codeteam-daemon/src/a2a/  # 复用：A2AToolHandlers / A2A_TOOL_SPECS
packages/codeteam-daemon/src/custody/ # 复用：wait/custody projection
```

不建议让 `codeteam-mcp` import `codeteam-daemon`；这会把 SQLite/daemon
依赖拖进 MCP 进程，破坏边界。共享 contract 单独成包，daemon 和 MCP 都
依赖它。

### 8.3 与 W5a handler surface 的复用边界

- **直接复用**：`A2AToolHandlers.send/createHandoff/claimHandoff/
  completeHandoff/withdrawHandoff`；`WaitContractService`；
  `CustodyProjection`；`ControlStore` 事务。
- **只加 adapter**：control socket handler 做 token→principal→allowlist→
  handler；MCP server 做 stdio→socket JSON。不要在 MCP 层重写 target 校验、
  handoff 方向、queue admission、custody 状态机。
- **不要复用**：W5a 的 `A2A_TOOL_SPECS` 名称是 codeteam-native，保留；
  但 schema 可以迁到 protocol 包，避免 daemon/MCP 两处漂移。
- **需要补的 W5a residue**：
  - `a2a_send` requestId；
  - `wait_cancel` owner fence；
  - 读工具 scope（W5a 只做写面）；
  - `callbackAllowlist` 注入（W5b mint 已有字段，但 executor 没传）。

### 8.4 测试矩阵

| 层 | 用例 |
|---|---|
| transport | stdio handshake/list/call；socket 0600；4MB frame；daemon down 503；unknown tool |
| auth | missing/invalid/unknown/terminal/stale/replaced；query/body token 拒绝；token file 0600/0700；path deny |
| principal | run/task/session/profile/role/user 一致；mismatch fail closed；args `from/role/owner` 拒绝 |
| allowlist | P0 13 在列表；approval/merge/shell 不在；allowlist 外 403；role profile 边界 |
| idempotency | 同 requestId 同 payload → 原结果；不同 payload → 409；并发重复 → 一次副作用；handoff domain key replay |
| read scope | 跨 thread message/context 拒绝；thread_list/task_list 只返回 principal 可见；participants 同 thread |
| A2A E2E | 两 agent 同 task/thread；a2a_send 唤醒；handoff claim/complete；non-holder safe_wait；one terminal；no duplicate bubble |
| wait | timer/event 缺 source/SLA/signal/fence fail closed；非 owner cancel 403；user_cancel operator only |
| output | 24k 预算；thread_context hasMore/cursor；list limit；no silent truncation |
| audit/telemetry | mutation audit；tool_usage；auth failure metric；no token/body secret |
| regression | tools/list snapshot；无 `cat_cafe_*` 别名；无 approval decide/merge tools；schema additionalProperties:false |

### 8.5 W7a 验收（建议）

- [ ] MCP client 能 list 13 个 P0 工具，且看不到 approval decide/merge/shell。
- [ ] 两个 agent 在同一 task/thread 完成 `a2a_send → handoff_create →
  claim → complete`，one terminal，无重复 response bubble。
- [ ] 重放同一 requestId 不产生第二条 message/queue/handoff；不同 payload 409。
- [ ] 旧/terminal/stale token 返回 typed 401；allowlist 外 403。
- [ ] 跨 thread 读/写被拒绝；args 自报身份被拒绝。
- [ ] wait 缺证据 fail closed；非 owner cancel 403。
- [ ] 审计/telemetry 有 tool/run/profile/status，无 secret。
- [ ] daemon 重启/不可用时 MCP 返回 503/retryable，不伪造成功。

### 8.6 Out of scope

- approval decide、merge execute、merge record；
- cross-thread A2A、multi_mention 聚合、callbackTo request status；
- W6 memory/eval、W8 GitHub tracking；
- plugin manager、skill consumption、external runtime session；
- rich media/document artifact review；
- Console HTTP/WS/SSE（W7a 另一条线，operator credential）；
- 任何 shell_exec / read_mode 工具。

## 9. 未决问题

1. **pi MCP bridge 是否能传递 `CODETEAM_CONTROL_SOCKET` + token file 路径？**
   需要 W0a spike。若不能，fallback loopback HTTP；但必须单独 listener +
   run-token auth，不复用 operator HTTP。
2. **`a2a_send` 的 requestId 是 transport ledger 还是 message store 字段？**
   推荐 transport ledger（通用、覆盖所有写工具）；message store 保持简单。
3. **读工具的 thread 可见性规则**：v1 只允许 principal 当前 thread；
   `thread_list` 只列 user/task 成员 thread。跨 thread 读需要 P1 明确授权。
4. **latest/replaced credential 语义**：建议 mint 时 terminalize 同
   session 旧 active 为 `replaced`；需要确认是否允许同一 session 多 run。
5. **wait_cancel 的 owner fence**：当前 service 只在 `user_cancel` 检查
   user owner；W7a wrapper 必须补 exact `owner_fence` 校验，否则 holder
   run 可能取消别人的 wait。
6. **handoff_complete 的 evidenceRef 是否必须指向 artifact？** W5a 目前是
   free string；P0 可接受 `artifact:<id>`/`message:<id>`/`commit:<sha>`，
   P1 再强制 artifact 存在。
7. **`callbackAllowlist` 的命名空间**：建议直接存 codeteam tool 名
   （`a2a_send` 等），不是 route path；与 Clowder 的 `GET/POST /api/...`
   allowlist 区分。
8. **是否需要 operator 对 P0 transport 签字**：这是架构选择，不是不可逆
   操作；建议在 W7a plan review 时由 operator 确认，不在本报告阻塞。

## 10. 建议

1. **接受 P0 13 工具 + no-alias 决定**。
2. **W7a 先做 S0–S3**：共享 contract、control socket handler、typed auth、
   stdio MCP server；再补 S4–S8。
3. **不在 W7a 做**：approval decide、merge execute、cross-thread、
   multi_mention 聚合、memory/eval/GitHub、媒体 artifact。
4. **把 `post_message` 的 overload 当成反面教材**：一个工具只承担一种
   权限语义；讨论、custody、review verdict、approval request 分开。
5. **让 Clowder 继续做参考实现，不做运行依赖**：复制契约与失败语义，
   存储/transport/auth 按 codeteam 单写者模型重写。

---

## Appendix A. 复现命令

在 Clowder 参考仓根目录：

```bash
node --import tsx -e "import('./packages/mcp-server/src/canonical-server-tools.ts').then(m => { const by = {}; for (const t of m.CANONICAL_TOOL_REGISTRY) by[t.serverFamily] = (by[t.serverFamily] || 0) + 1; console.log(by, m.CANONICAL_TOOL_REGISTRY.length); })"
```

本次输出：

```text
{ collab: 165, audio: 11, finance: 1, memory: 23, limb: 6, signals: 12 } 218
```

companion inventory 的生成口径：以
`packages/mcp-server/governance/mcp-surface-baseline.json` 的 schema/required/
annotations/runtimeProfiles 为机器字段，叠加本文的 disposition/priority/
target。`input/output` 的输出统一是 MCP text JSON；逐工具 `required_inputs`
和 `optional_inputs` 见 TSV。

## Appendix B. TSV 列字典

| 列 | 含义 |
|---|---|
| `server_family` | collab / memory / signals / audio / limb / finance |
| `resource_family` | Clowder governance 的 resource family |
| `tool` | MCP tool name |
| `actions` | governance action inventory |
| `read_or_write` | read / write（从 readOnlyHint 派生） |
| `destructive` | destructiveHint |
| `open_world` | openWorldHint |
| `required_inputs` | JSON Schema required |
| `optional_inputs` | JSON Schema 其余 properties |
| `runtime_profiles` | full / readonly / agent-key / desktop / collective |
| `idempotency` | 本文归纳的幂等类 |
| `permission` | 本文归纳的权限类 |
| `disposition` | reuse / adapt / defer / drop |
| `priority` | P0 / P1 / P2 / — |
| `codeteam_target` | codeteam 目标工具或 — |
| `note` | 取舍理由 |

