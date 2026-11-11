---
title: "DP-F018AUTH: InvocationRegistry + InvocationCredential v1 拍板包"
doc_kind: decision-packet
status: open
created: 2026-11-11
updated: 2026-11-11
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related: ../0010-a2a-runtime-chain.md
related_features: [codeteam/F018]
operator_decision: pending
---

# DP-F018AUTH: InvocationRegistry + InvocationCredential v1 拍板包

> 只给价值取舍、推荐、证据和“不拍的后果”。不需要 operator 选技术实现。
> 已有 task-first `a2a/`、`worker-extension.ts`、`auth/*` 是参考实现，不是 F018 契约。

## 0. 一句话

codeteam 的 A2A tools 走 **pi extension tool → control socket → daemon**，不是
MCP tools callback。v1 要保留这条路径已经证明的安全机制（per-turn token、0600
token file、worker/session binding、requestId receipt），但把坐标从
`run/task/role/profile` 换成 `turnExecutionId/threadId/agentId/agentSessionId`。

## 1. 先看结论

| 决策 | 选项 | 推荐 | 影响面 | 不拍的后果 |
|---|---|---|---|---|
| DP-F018AUTH-1 旧 task-first auth 代码怎么用 | A=机制复用、坐标重写；B=原地适配 task-first schema；C=从零重写 | **A** | 实现速度、F018 纯净度、迁移债 | B 会把 task-first 带进 F018；C 会丢掉已验证的 control socket/token 机制 |
| DP-F018AUTH-2 credential 绑谁 | A=child `TurnExecution`；B=parent `InvocationRecord`；C=`AgentSession` | **A** | 最小权限、retry 语义、credential 行数 | token scope 和 retry/terminalize 语义无法定稿 |
| DP-F018AUTH-3 requestId 幂等放哪 | A=把 `a2a_requests` 迁到 thread-first；B=credential 上的 `clientMessageIds`；C=不做 claim | **A** | 重复投递风险、表结构、replay 语义 | `post_message` 重试仍可能二次派发；烁烁 P1 继续 open |
| DP-F018AUTH-4 active credential 怎么回收 | A=startup sweep + verify repair，active 无 TTL；B=只 verify repair；C=active TTL 自动过期 | **A** | 启动成本、孤儿 token、长 turn 有效性 | B 会永久留下 active token；C 会让长 turn 中途失效 |
| DP-F018AUTH-5 pi extension 工具面 | A=只注册 F018 四工具；B=保留旧 `a2a_send`/`handoff_*` 兼容窗；C=只注册新工具、旧 spec 隐藏 | **A** | 工具面清晰度、迁移窗口、credential allowlist | 旧工具继续暴露，F018 “a2a_send/handoff 彻底弃用”不成立 |

## 2. 背景与 current truth

### 2.1 真实路径是 pi extension tool，不是 MCP callback

```text
pi worker
  → worker-extension.ts 注册 A2A tool
  → ControlClient.a2aCall()
  → Unix control socket:
      { type: "a2a_call", workerId, token, toolName, input }
  → daemon control.ts resolveWorkerBinding()
  → resolveInvocationToken() 验 token hash/state/expiry
  → 校验 run.status、run.workerId、session.workerId
  → resolveRunPrincipal() 派生 thread/profile/role/user
  → A2AToolHandlers
```

所以：

- 没有 MCP server，没有 `X-Invocation-Id` / `X-Callback-Token` HTTP headers。
- token 是 `ct1.<credentialId>.<secret>`；文件 0600；extension 每次调用重读。
- Clowder 的 `InvocationRegistry` / `CallbackAuthTurnExecutionLifecycle` 仍可比，
  但比较的是 **child-bound capability + canonical-first terminal projection**，
  不是 MCP transport。

### 2.2 已有代码里哪些是可复用机制

| 机制 | 当前实现 | F018 处置 |
|---|---|---|
| control socket RPC | `worker-extension.ts` ↔ `workers/control.ts` | 保留；payload 改成 `turnExecutionId` |
| token file | `ct1.<credentialId>.<secret>`，0600，per-run | 保留；改成 per-turn/per-worker |
| token hash | SHA-256(salt:secret) + `timingSafeEqual` | 保留 |
| worker/session binding | 校验 `run.workerId`、`session.workerId` | 保留；改成 `turnExecutionId`/`worker_binding`/`agentSessionId` |
| requestId receipt | `a2a_requests(task_id, profile_id, request_id)` + intent hash + message/queue ref | 保留表，迁到 thread-first 坐标 |
| interrupted-run recovery | `recoverControlPlane` 扫描 running run，terminalize credential | 保留思路，补 orphan sweep |

### 2.3 已有代码里哪些是 task-first，不能直接搬

- `invocation_credentials` 的 `run_id/task_id/role/agent_profile_id/parent_run_id`；
- `a2a_requests` 的 `task_id/profile_id`；
- `tool_policy_json` / `callback_allowlist_json` 的 callback 语义；
- `A2A_TOOL_NAMES` 的 `codeteam_a2a_send` / `codeteam_handoff_*`；
- `recoverControlPlane` 只扫 running run，不扫 orphan credential。

## 3. DP-F018AUTH-1：旧 task-first auth 代码怎么用

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | 机制复用、坐标重写：保留 control socket / token file / hash+salt / timingSafeEqual / worker binding / a2a_requests；把 run/task/role/profile 换成 TurnExecution/thread/agent/session | 保留已验证安全机制；F018 不背 task-first schema；迁移边界清楚 | 需要一次性重写 control/auth 的坐标层 |
| B | 原地适配：保留 `runs/tasks/roles`，在旧表上补 thread-first 字段 | 短期改动少 | task-first 继续是真相源；F018 纯 A2A 目标被破坏；后续还要再迁一次 |
| C | 从零重写 control/auth | 最干净 | 丢掉已验证的 token/worker/requestId 机制；重踩安全坑 |

**推荐理由**：当前代码的 control socket + per-turn token + 0600 file + worker/session
binding 是正确的 pi extension 安全边界；要换的是坐标，不是机制。Clowder
`InvocationRegistry` 的 contract 也支持这种“机制复用、坐标适配”。

**不拍的后果**：实现会悬在“旧 task-first 能用但不符合 F018”与“新表重写但不知道
哪些机制该保留”之间，auth 面无法冻结。

## 4. DP-F018AUTH-2：credential 绑谁

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | 每个 child `TurnExecution` 一个 credential；retry 新 child + 新 credential；旧 credential terminal `replaced`，`terminal_ref` 指向新 child | 最小权限；retry/terminalize 语义清晰；旧 token 立即失效 | credential 行数随 attempt 增长 |
| B | 每个 parent `InvocationRecord` 一个 credential，多个 target/attempt 共享 | 行数少 | 旧 attempt 的 token 可能在新 attempt 期间继续调用工具；terminalize 归属模糊 |
| C | 每个 `AgentSession` 一个长生命周期 credential | 行数最少 | 爆炸半径大；一个 session 的所有 turn 共享 token；不符合 least privilege |

**推荐理由**：Clowder 的 callback auth 也是 child `invocationId` 绑定；codeteam
的 `TurnExecution` 是执行锚，retry 新 child 新 credential 最自然。credential
行数不是瓶颈，token 失效边界才是。

**附带自决**：`disposition` 增加 `replaced`，并增加
`replaced_by_turn_execution_id`（或 `terminal_ref`）；retry/preempt 的旧 credential
不再误标 `revoked`/`canceled`。

**不拍的后果**：retry 时“旧 token 还能不能用、旧 credential 怎么终止”无法定稿。

## 5. DP-F018AUTH-3：requestId 幂等放哪

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | 把现有 `a2a_requests` 迁到 `(thread_id, agent_id, request_id)`（或 `(credential_id, request_id)`），保留 `intent_hash/message_id/queue_entry_id`；`post_message` 创建 message/queue 的同一事务里 claim；重试 replay，不同 intent conflict | 复用已有表；durable、可查询、可关联 message/queue；关闭二次派发 | 需要一次 key 迁移 |
| B | 在 `InvocationCredential` 上加 `client_message_ids` JSON/set（Clowder `InvocationRecord` 形状） | 字段少；和 credential 同生命周期 | 不可查询/join；JSON 更新和容量控制麻烦；与已有 `a2a_requests` 重复 |
| C | 不做 claim，靠 message 唯一键 + queue admission 兜底 | 表最少 | 队列行删除后同一 requestId 重试仍可能二次派发；烁烁 P1 继续 open |

**推荐理由**：当前 `A2ARequestStore` 已经有 `intent_hash/message_id/queue_entry_id`
和同事务 reserve/replay/conflict 语义；F018 只需要换 key，不需要发明新机制。

**不拍的后果**：`post_message` 的 `replayed/conflict` 语义无法定稿；实现可能继续
沿用 task-first `a2a_requests` 或退回“不 claim”，都会留下重复投递窗口。

## 6. DP-F018AUTH-4：active credential 怎么回收

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | startup sweep + verify repair；active credential 无 TTL；terminal tombstone 才 GC | 孤儿 token 可回收；长 turn 不会中途失效；与 Clowder active 语义一致 | 启动多一轮扫描 |
| B | 只 verify repair；不启动 sweep | 启动快 | child/run 已 terminal/missing 且没人再调用时，active token 永久残留 |
| C | active credential 设 TTL 自动过期 | 自动清理 | 长 turn/工具调用可能中途失效；token 生命周期变成 wall clock，不是执行生命周期 |

**推荐理由**：Clowder 的 active principal 没有 deadline，只有 terminal tombstone
有 GC；orphan 由 `listActiveRecords` + startup reconcile 处理。codeteam 应照这个
语义：`listActiveCredentials()` + startup sweep（child/run missing → revoked；
child/run terminal → terminalize；running unowned → interrupt 后 terminalize）。

**不拍的后果**：active token 可能永久残留；或者用 TTL 换来长 turn 随机失败。

## 7. DP-F018AUTH-5：pi extension 工具面

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | 只注册 F018 四工具：`post_message` / `cross_post_message` / `multi_mention` / `thread_context`；`a2a_send` / `handoff_*` 从 `A2A_TOOL_SPECS` 和 control switch 删除 | 与 F018 “a2a_send/handoff 彻底弃用”一致；credential allowlist 面干净 | 需要一次工具面迁移 |
| B | 保留旧 `a2a_send` / `handoff_*` 兼容窗，同时注册新工具 | 旧 worker 可继续跑 | 两套工具面、两套 allowlist、两套语义；F018 不纯 |
| C | 只注册新工具，但旧 spec 保留在代码里不注册 | 运行时干净 | 代码里仍有死工具，后续容易误接 |

**推荐理由**：F018 已明确 `a2a_send`/`handoff_*` 弃用；pi extension 是唯一工具面，
没有外部兼容压力。保留兼容窗只会让 credential allowlist 和 prompt guidelines 继续
混乱。

**不拍的后果**：worker-extension 继续向模型暴露已弃用工具，F018 的“纯 A2A 四工具”
无法宣称成立。

## 8. 不需要拍、已自决的边界

| 事项 | 决定 | 依据 |
|---|---|---|
| token 格式 | `ct1.<credentialId>.<secret>` | 当前 `auth/tokens.ts` 已验证 |
| token 文件 | 0600，per-turn/per-worker，extension 每次调用重读 | 当前 `writeInvocationTokenFile` + `worker-extension.ts` |
| token 校验 | SHA-256(salt:secret) + `timingSafeEqual`；不存 raw token | 当前 `auth/tokens.ts` + `InvocationCredentialStore` |
| control envelope | `{ type:"a2a_call", workerId, token, toolName, input }` | 当前 `worker-extension.ts` / `workers/control.ts` |
| identity 来源 | 从 credential + child/worker/session 派生；payload 不得覆盖 agent/thread/user | 当前 `resolveWorkerBinding` + `resolveRunPrincipal` |
| allowedTools | 服务端铸造，credential 生命周期内不可扩；extension 只能使用 | 当前 `credentialToolDecision` |
| `callbackAllowlist` | F018 删除；pi extension 路径没有 HTTP callback 语义 | 当前字段是 task-first callback 遗留 |
| `task_id/role/agent_profile_id/parent_run_id` | 迁移为 `turn_execution_id/agent_id/invocation_record_id`；不保留 task/role 坐标 | F018 thread-first |
| `lastRefreshAt` | v1 无 refresh 流程则删除；active credential 不设 TTL | Clowder active 无 deadline |

## 9. 拍板方式

回复一行即可，例如：

`DP-F018AUTH-1=A, DP-F018AUTH-2=A, DP-F018AUTH-3=A, DP-F018AUTH-4=A, DP-F018AUTH-5=A`

若某项要改选，只写改选项，例如 `DP-F018AUTH-3=B`。

## 10. 落点

拍板后更新：

- `0010 §3.7`：InvocationRegistry / InvocationCredential 接口与状态；
- `0010 §3.8`：pi extension tool surface + `post_message`/`cross_post_message`/`multi_mention`；
- `0010 §4.4`：`invocation_credentials` 字段（turnExecution/thread/agent/session/allowedTools）；
- `0010 §9.4`：auth 验收与负例；
- `0010 §11`：决策记录；
- 实现侧：`packages/codeteam-daemon/src/auth/*`、`workers/control.ts`、`workers/worker-extension.ts`、`a2a/tool-surface.ts`、`a2a/requests.ts`、`control/recovery.ts`。

[宪宪/deepseek-flash🐾]
