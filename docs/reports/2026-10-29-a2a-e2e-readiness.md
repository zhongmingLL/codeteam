---
title: "A2A E2E Readiness — handler / daemon / worker 现状与缺口"
doc_kind: report
status: draft
created: 2026-10-29
updated: 2026-10-29
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
baseline: "codeteam-work @ d33dd17fb (W6 closed)"
scope: "read-only investigation; docs-only deliverable; no product code changes"
---

# A2A E2E Readiness — handler / daemon / worker

> **结论先行。** codeteam 的 A2A **handler 语义**已经有较强实现和 in-process
> 测试；`DispatchService` 和 `RpcAgentExecutor` 也分别有实现。但当前版本
> **不能**从 operator / backlog / daemon / worker 任一层跑通一条真实的 A2A
> E2E 链：没有生产 composition root 把 store、dispatch、worker 组装起来；
> 两个真实队列生产者写入的 source message 没有 `taskId`，而 dispatcher 强制
> 要求 `source.taskId`；没有 CLI/API 创建 AgentSession 或分配 worktree；
> worker 的工具面不包含 `a2a_send` / `handoff_*`；worker prompt 也没有 A2A
> 规则和 roster。现有通过的 A2A 测试主要是直接调用 handler、手工
> `cutoverQueueEntry`，或用 fake executor 注入，不构成 E2E 证据。

## 1. 基线与证据

| 项 | 值 |
|---|---|
| 分支 | `codeteam-work` |
| 基线 | `d33dd17fb2eafefdfd167036e4dc258012c9882d`（2026-10-29，W6 closed） |
| 工作区 | clean；本报告在孤立 docs 分支提交 |
| 代码改动 | 无 |
| 交付 | docs-only readiness 报告与测试计划 |

本报告的事实来源：

- 项目契约：`docs/features/F001-architecture-v1.md`、`docs/architecture/0001-codeteam-architecture-v1.md`、`docs/architecture/0002-pi-runtime-integration.md`、`docs/plans/0010-w5a-a2a-dispatch-custody.md`、`docs/plans/0011-w5b-rpc-worker-runtime.md`、`docs/plans/0004-w5-w8-scale-product.md`。
- 复用卡：`docs/reuse/dispatch.md`、`docs/reuse/ball-custody.md`、`docs/reuse/identity-session.md`、`docs/reuse/REUSE-MATRIX.md`。
- codeteam 代码：`packages/codeteam-daemon/src/{a2a,dispatch,workers,cli,control}`、`packages/codeteam-pi-adapter/src`。
- Clowder AI 只读参考：按仓库相对路径阅读，不复制账号、密钥、个人数据或 roster 值；不把本地 checkout 绝对路径写入本文。

### 1.1 Fresh verification commands

```bash
NODE_ENV=development npx vitest --run \
  test/control-a2a-tools.test.ts \
  test/control-dispatch.test.ts \
  test/control-worker-e2e.test.ts
# 3 files passed; 26 tests passed

NODE_ENV=development npm test
# packages/codeteam-daemon: pretest build pass
# 77 files passed | 2 skipped (79)
# 524 tests passed | 2 skipped (526)
```

`2 skipped` 是既有的 env-gated live provider smoke 与 real-repo first-run；
本次没有把 live provider 失败重新归因。W5b 的历史 live smoke 记录仍是
OpenRouter `401 Missing Authentication header`，属于环境项，不是 RPC harness
失败。

### 1.2 状态口径

| 状态 | 含义 |
|---|---|
| `available` | 有生产可达路径，并且有覆盖该路径的 fresh 测试 |
| `partial` | 有实现或 in-process 测试，但生产路径、transport、worker、operator surface 至少缺一层 |
| `missing` | 没有真实路径，或只有契约/计划 |

本报告不把“handler 测试通过”写成 `available`。A2A E2E 的 `available` 要求
真实 source → queue → dispatch → worker → response/terminal 链可重复执行。

## 2. 现有实现边界

### 2.1 Handler-only：A2A typed tool surface（W5a）

`packages/codeteam-daemon/src/a2a/tools.ts` 已实现：

| Tool | 当前行为 | 证据 |
|---|---|---|
| `a2a_send` | 写 discussion `Message` + 一条多 target `queue_entries`；不改 custody；追加 `→ @displayName` 可见标记 | `A2AToolHandlers.send`；`control-a2a-tools.test.ts` |
| `handoff_create` | 写 `handoffs` + `custody_events` + 可见 `Message` + `control_ref` + queue entry；按 `(taskId, idempotencyKey)` replay | `A2AToolHandlers.createHandoff`；同测试 |
| `handoff_claim` | per-holder claim；非 holder / 跨 task 返回 `safe_wait` | `A2AToolHandlers.claimHandoff`；同测试 |
| `handoff_complete` | 只写 completion candidate，不自行 commit | `A2AToolHandlers.completeHandoff`；store `recordCompletionCandidate` |
| `handoff_withdraw` | 仅作者可撤回；跨 task 拒绝 | `A2AToolHandlers.withdrawHandoff`；同测试 |

Handler 层已有明确的安全负例：严格字段白名单、`from`/`control_ref` 伪造拒绝、
disabled/cross-thread target 拒绝、跨 task claim/withdraw 拒绝、
`missing_a2a_tool_call` 只观测一次且不自动路由、handoff idempotency replay。
这些测试是 real code paths，但全部是 **in-process**：调用者直接构造
`RunPrincipal` 并调用 handler，不经过 worker 工具调用或 daemon transport。

### 2.2 Dispatch：in-process 可验证，生产未组装

`packages/codeteam-daemon/src/dispatch/service.ts` 已实现：

- 唯一 `queue_entries` claim/drain；
- 多 target parallel `routeParallel`；
- one terminal、response bubble、`dispatchRefs`；
- guide（写 inbox/event）、stop、interrupt、cancel queued；
- poison target dead-letter、managed-work conflict、budget/deployment defer；
- A2A depth metadata 持久化、missing tool observation。

`control-dispatch.test.ts` 的 12 个测试覆盖上述行为，并使用 fake
`AgentExecutor` 或手工构造的 queue message。它证明的是 **dispatch 语义**，
不是 operator/backlog producer 或真实 worker 的可达性。

生产代码中没有实例化 `DispatchService` 的地方；`rg` 只命中 tests/helpers。
`packages/codeteam-daemon/package.json` 也没有把 dispatch/worker 组装成
一个可执行 runtime 的入口。

### 2.3 Worker：真实 RPC 链路可跑，但不含 A2A 工具

`packages/codeteam-daemon/src/workers/` 已实现：

- `WorkerHarness`：`pi --mode rpc` 参数、per-run token 0600 文件、session
  file 重挂、fresh fallback、graceful drain；
- `RpcAgentExecutor`：sticky session、worker 事件回流、crash/timeout/protocol
  分类、retry/dead-letter 的上游输入；
- `WorkerControlServer`：0600 Unix socket、heartbeat、token → run/session/worker
  绑定、role tool policy；
- `worker-extension.ts`：heartbeat + `tool_call` policy；
- `RpcConnection`：strict LF JSONL、prompt/abort、事件流。

`control-worker-e2e.test.ts` 的 4 个测试是真实 `pi --mode rpc` + mock
provider：coder 写文件、reviewer 读上下文、control plane down 时 write
deny/read allow、真实 session file 重挂。它们证明 RPC harness 与工具链，
但 **没有任何 A2A tool call**。

### 2.4 生产 composition root 缺失

这是当前最大的单点缺口：

- `packages/codeteam-daemon/src/daemon.ts` 的 `startDaemon` 只提供
  `/health`、`/ready`、`/metrics` 和 lifecycle；不打开 `ControlStore`，
  不启动 `WorkerRuntime`，不启动 dispatcher。
- `src/cli/index.ts` 的命令表没有 `run`、`dispatch`、`worker` 或等价命令；
  CLI 每次调用打开 store、执行一个命令、关闭 store。
- 没有长期存活的 drain loop、scheduler 或 event-driven wake 入口；queue
  producer（operator 写 message/queue）不会通知 dispatcher。
- `cli-dogfood.test.ts` 的“agent reply”是测试里直接 `store.sessions.create`
  + `store.cutoverQueueEntry`，不是 daemon/worker 链路。

因此，即使 handler 和 worker 各自测试通过，当前产品进程没有一条路径把它们
接起来。

## 3. A2A E2E 的 P0 阻塞点

### P0-1 真实 queue producer 与 dispatcher 的 task 绑定不一致

`DispatchService.cutoverEntry` 要求 source message 带 `taskId`：

```ts
const source = this.store.messages.get(entry.sourceId);
if (!source.taskId) {
  throw new ControlError("invalid_state", `queue source message ${source.id} has no task`);
}
```

但两个真实 operator/backlog producer 都不写 `taskId`：

- `packages/codeteam-daemon/src/cli/thread.ts` 的 `thread post --to` 只写
  `threadId`，随后 `queue.admit({ sourceKind: "conversation_input" })`。
- `packages/codeteam-daemon/src/control/store.ts` 的 `dispatchBacklog` 只写
  `threadId` 和 `backlogItemId`，随后 `queue.admit({ sourceKind: "backlog_dispatch" })`。

后果：一旦 dispatcher 真正 drain 这两类 entry，`cutoverEntry` 抛出
`invalid_state`；`drainLoop` 把 `invalid_state` 视为 poison，调用
`deadLetterEntry` 并 withdraw 整条 queue entry。也就是说：

> **operator 通过 `thread post --to` 或 `backlog dispatch` 发出的 A2A 工作，
> 当前不会到达 agent；在真实 dispatcher 下会被 dead-letter。**

测试没有覆盖这个错位：`control-dispatch.test.ts` 的 `queueMessage` helper
手工写入了 `taskId`；`cli-dogfood.test.ts` 绕过 `DispatchService` 直接调用
`store.cutoverQueueEntry` 并显式传 `taskId`。这是测试夹具掩盖真实 producer
的典型例子。

### P0-2 没有 AgentSession 生产入口

`DispatchService.resolveRoute` 要求目标 profile 在同一 task/thread 恰有一个
active `AgentSession`：

```ts
const sessions = this.store.sessions.list({ taskId, profileId, status: "active" });
if (sessions.length === 0) throw new ControlError("invalid_state", ...);
if (sessions.length > 1) throw new ControlError("invalid_state", ...);
```

当前 CLI 只有 `profile seed/add/list`，没有 `session create` 或等价命令。
`backlog dispatch` 和 `task create` 都不创建 session。所有 worker E2E fixture
都在测试代码里手工 `store.sessions.create(...)`。因此真实 operator 即使把
message/task 绑定修好，仍会在 route 阶段失败。

### P0-3 没有 worktree 分配入口

`RpcAgentExecutor.execute` 在启动 worker 前硬性要求 `task.worktree`：

```ts
if (!task.worktree) {
  throw new RetryableExecutionError("task_worktree_missing", ...);
}
```

`task create` CLI 不接受 repo/base/worktree/risk/lane 字段；`backlog dispatch`
只接受 repo，不创建 task。`WorktreePoolService` 存在，但没有 CLI/API 调用它，
也没有在 task 创建或 dispatch 前分配 lease。现有 worker E2E fixture 手工创建
worktree 并写入 `task.worktree`。真实路径会在 `RpcAgentExecutor` 处失败。

### P0-4 worker 没有 A2A tool surface

四个独立事实同时成立：

1. `WorkerHarness.workerArgs` 显式 `--no-mcp`，并且 `--tools` 只传
   `allowedToolsForRole(session.role)`；该列表只有 read/grep/find/ls 或
   coder 的 bash/edit/write。
2. `worker-extension.ts` 只注册 heartbeat 和 `tool_call` policy；没有
   `registerTool`，因此模型看不到 `a2a_send` / `handoff_*`。
3. `evaluateWorkerToolCall` 对不在 role allowlist 的 tool 直接返回
   `tool_not_allowed_for_role`；即使 extension 注册了 A2A tool，
   policy hook 也会先 block。
4. `WorkerControlServer.handle` 只接受 `heartbeat` 和 `tool_policy`；没有
   `a2a_call`/`a2a_send`/`handoff_*` 请求类型。它无法把 worker tool call
   转给 `A2AToolHandlers`。

所以当前 worker 只能做 read/write/bash/edit 等文件操作；A2A 工具在模型
工具面上不存在，在 control plane 也没有执行入口。

### P0-5 worker prompt / L0 没有 A2A 规则与 roster

codeteam 有两条 prompt 路径，且没有合流：

- **SDK adapter 路径**：`packages/codeteam-pi-adapter/src/l0/compiler.ts`
  只有 coder/reviewer/verifier 三个模板 + 通用 governance；没有 A2A、队友
  roster、routing、workflow triggers、MCP tool index。`createAgentSessionWithL0`
  只在 adapter README/test 中被调用，daemon 没有 consumer。
- **RPC worker 路径**：`WorkerHarness.workerArgs` 用
  `--append-system-prompt buildWorkerSystemPrompt(session.role)`；该 prompt
  只有 3 段 role guidance，没有 A2A 规则、roster、restrictions、
  `roleDescription`、thread history、memory 或 tool index。`buildWorkerPrompt`
  只注入 task title/why/role/worktree/branch/base、continuity capsule（通常
  为空）、source message。

后果：即使把 A2A tool 接进 worker，模型也不知道有哪些 agent、各自 role /
restrictions、该用 `a2a_send` 还是 `handoff_create`、文本 `@` 不路由。弱模型
在多个 target 和职责边界之间没有可用的认知输入。

### P0-6 handoff 没有生产 terminal resolver

`handoff_complete` 只写 completion candidate：

```ts
return this.store.handoffs.recordCompletionCandidate({ ... });
```

`HandoffStore.commitCompletion` 要求 `verified: true`，但生产代码中没有调用者；
`rg` 只命中 tests。`terminal_predicate` 被持久化，却没有 resolver 读取并裁决。
因此：

- `handoff_complete` 之后 handoff 仍是 `claimed`，不会变成 `consumed`；
- parallel handoff 没有“全部 holder 完成/未完成”的收口；
- `handoff.parallel_unfinished` 事件从未由生产路径产生；
- agent 自述无法被 server-owned evidence 验证。

这使完整 handoff 生命周期在 candidate 处停住，不满足 E2E 的 terminal 断言。

### P1-1 principal role 使用 profile primary role，而非执行 role

架构明确允许 `AgentSession.role` 不同于 `AgentProfile.role`：
`docs/architecture/0001-codeteam-architecture-v1.md` §4.4.2.7 的
`agent_sessions.role` 行写“session role 可不同于 profile primary role”。

但 `packages/codeteam-daemon/src/a2a/principal.ts` 返回：

```ts
role: profile.role
```

`A2AToolHandlers.createHandoff` 又用 `this.principal.role` 做
`assertHandoffDirection` 的 `fromRole`。当 profile primary role 与本次
execution role 不同（例如 architect profile 以 coder session 执行），
handoff 的方向白名单会用错角色：可能错误放行，也可能错误拒绝。
现有 fixture 都让 profile.role == session.role，因此测试没有覆盖。

这是 identity-session P0 卡的直接语义缺口；应在接 transport 前修正为
`run.role` / `session.role`（执行身份），profile.role 只保留稳定 primary
身份语义。

### P1-2 loop guard / idempotency / return-replace 不完整

- `HandoffStore.loopGuardSnapshot()` 只读统计 `(canonical_action_key, attempts, live)`；
  `create()` 没有在创建前拒绝已有 live canonical action，也没有 attempt+1
  重排路径。loop guard 目前是观测，不是门禁。
- `a2a_send` schema 没有 `requestId`；网络/transport 重试会重复写 message
  和 queue entry。`docs/architecture/0001` 的写入策略要求
  `a2a_send`/`handoff_create` 带 requestId、服务端去重；`handoff_create` 有
  `idempotencyKey`，`a2a_send` 没有。
- `releaseClaim` 会写 `handoff.returned`，但没有 `handoff_return` /
  `handoff_replace` tool；`replacement_transitions` 只有投影支持，没有生产
  writer。parallel `handoff_complete` 的“部分完成/未完成”也没有收口。
- `handoff_create` 的 `mode=parallel` 不要求 `parallelIntent`，与“只能用于
  刻意独立 review/ideation”的契约不一致。

### P1-3 guide 只写 inbox，不会 steer 到 live worker

`DispatchService.guideRun` 只创建 inbox 和 run event；没有调用
`RpcConnection.steer` / `follow_up`。`RpcConnection` 也只实现 prompt/abort，
没有 RPC 的 `steer`/`follow_up` 命令。pi RPC 本身支持这两个命令
（`packages/coding-agent/src/modes/rpc/rpc-types.ts`），但 codeteam 没有接线。

因此 guide 测试只证明“inbox 有一条记录”，不证明“运行中的 agent 收到了
指导”。interrupt/stop 在 service + fake executor 上可测，但没有 operator
CLI/API，也没有真实 worker 的 interrupt E2E。

### P1-4 recovery 有实现，但没有生产触发

`recoverControlPlane` 与 `WorkerRuntime.recover` 都有测试：interrupt running
runs、release claims、requeue queue entries、stale worker → `re_attach_pending`。
但 `startDaemon` 不调用它们，CLI 没有 `daemon recover` / `worker sweep`，也没有
周期 sweep。生产重启后没有人执行 recovery；W5b residual 也明确记录了
“稳态周期 sweep 仍未接线”。

### P1-5 安全边界需要 transport 层 review

Handler 层的 forged identity/control_ref、非 holder、跨 task 负例已覆盖；但：

- 没有 A2A transport，无法验证 per-run token → `RunPrincipal` → handler 的
  真实身份链；
- `claimHandoff` 对 non-holder 返回 `safe_wait` **并带回完整 handoff 对象**，
  可能暴露 subject/payload/deadline/holder 列表；需要安全 review 决定是否
  只返回 `{status, reason}`；
- control socket 是 0600 的 local Unix socket，同一 OS uid 信任；W5b residual
  已记录 worker 无独立 secret；
- 没有 per-profile provider account/credential 绑定；worker env 共享，
  live provider 场景下需要额外的 secret 边界；
- `DEFAULT_ACTION_PAIRS` 是静态白名单，dynamic role registry 的 custom role
  没有可配置 action pair；未知 role 在 worker 还会 fallback 到 reviewer
  guidance/read-only tool matrix。

## 4. Clowder L0 / sysprompt 迁移对照

Clowder 的 A2A prompt 不是单段文本，而是多层组合：

| 层 | Clowder 参考（repo-relative） | codeteam 当前 | A2A 缺口 |
|---|---|---|---|
| Native L0 模板 | `assets/system-prompts/system-prompt-l0.md`；`scripts/compile-system-prompt-l0.mjs` | `packages/codeteam-pi-adapter/src/l0/compiler.ts` + 3 个 role template | 缺少 L1 平行自我、S5 roster、L3 routing、S6 workflow triggers、L5 MCP index；没有 A2A 段 |
| Governance L0 | `packages/api/src/domains/cats/services/context/governance-l0.ts` | compiler 的通用 `GOVERNANCE` | 没有 `@` 路由、A2A 状态迁移、球权/收尾规则 |
| Per-turn A2A hooks | `assets/prompt-hooks/d8-a2a-球权检查/`、`d21-决策树/`；`assets/prompt-templates/a2a-ball-check.md`、`handoff-decision-tree.md` | 无 | 没有球权检查、传球决策树、direct-message 提示 |
| Routing / roster | `packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts` 的 `buildTeammateRoster`；`cat-catalog.json` | `agent_profiles` 表存在；没有 prompt 注入 | agent 不知道可调用 peers / role / restrictions / model |
| Workflow triggers | `assets/prompt-templates/workflow-triggers.yaml` | 无 | 没有 per-role 主动 @/review/视觉触发 |
| MCP / tool index | `SystemPromptBuilder.getMcpToolsSection()`；`prompt-template-loader.ts` | worker `--no-mcp`；没有 A2A tool index | 模型看不到 A2A 工具与目标选择规则 |
| Skills | adapter 的 curated skill loader 已实现 | worker `--no-skills`，adapter 无 daemon consumer | A2A 相关 skill/流程不会进入 worker |
| Session bootstrap / context | `SessionBootstrap.ts`、`ContextEpochOwner.ts`、`SessionChainStore.ts` | `AgentSession` 有 continuity/capsule 字段；没有 bootstrap/chain service | 多跳 handoff 只靠 source message + 可能为空的 capsule |
| Agent config / accounts | `packages/api/src/config/cat-config-loader.ts`、`catalog-accounts.ts` | flat `AgentProfile` + session provider/model；无 account binding | 没有 CatConfig 的 mention/teamStrengths/caution/contextWindow/sessionStrategy/accountRef/carrier |

关键判断：

- codeteam **已经迁了** L0 compiler 的一个最小切片（deterministic template +
  governance + native system prompt + compaction/resume 证据），但它是
  **SDK adapter 的孤岛**，不是 RPC worker 的 prompt。
- codeteam **没有迁** A2A 相关的 L0/per-turn/routing/roster 层；这不是单纯
  文本缺失，而是 agent 缺少“向谁发、用什么 tool、文本 @ 不路由”的执行认知。
- `DispatchService.resolveRoute` 目前把 `l0Revision` 固定为 `null`，run
  metadata 也没有可审计的 L0 revision；即使 adapter L0 被接上，也需要补
  revision 传递。

## 5. Agent config / roster / identity-session 对照

### 5.1 字段形状（只比结构，不复制值）

| 概念 | Clowder 形状 | codeteam 形状 | 判断 |
|---|---|---|---|
| 稳定身份 | `catId` + `CatConfig`：name/displayName/nickname/avatar/mentionPatterns/accountRef/clientId/carrier/defaultModel/mcpSupport/roleDescription/personality/teamStrengths/caution/restrictions/contextWindow/sessionChain/sessionStrategy/provider | `agent_profiles`：id/role/displayName/provider/model/modelFamily/toolPolicyProfile/roleDescription/restrictions_json/status/clowderCatId | 核心身份字段够用；roster/mention/account/context/session 策略字段缺或未消费 |
| 执行身份 | `SessionRecord`：catId/threadId/userId/seq/status/cliSessionId/chainKey/contextHealth/capacityPin/compressionCount/continuityCapsule/catHandoffNote/latestResumeSessionId/sealReason/nativeSessionBinding | `agent_sessions`：任务/角色/阶段/session 绑定 + 大部分 continuity 字段 | schema 接近；缺 chain store/bootstrap/context epoch 服务 |
| Role | `type Role = string` 动态 registry | `roles` 表：内置 architect/coder/reviewer/verifier，seed eval/compress；可 create | schema 是动态的；执行面只认真实 3 套 tool matrix，未知 role fallback reviewer |
| Account | `accounts.json` 的 `AccountConfig`（authType/baseUrl/models/modelAliases/envVars 等；凭据另存） | 无；只存 provider/model 字符串 | live 多 provider/per-profile auth 未迁移 |
| Restrictions | `CatConfig.restrictions: string[]`，进入 roster/self prompt | `restrictions_json: object`，没有 consumer | 形状和语义都未对齐；agent 看不到 restrictions |
| Review 独立性 | profile + session + modelFamily | schema 有 modelFamily；review service 使用；A2A handler 不校验 | 需要 review 层在使用时继续 enforcement |

> 只读参考没有复制任何 `cat-catalog.json` / `accounts.json` 的值；这里只记录
> loader/type 的字段形状。Clowder 的 avatar、voice、relationship、personal
> memory 等字段不属于本 readiness 的 A2A 阻塞项。

### 5.2 identity-session P0 卡记分

| P0 要求 | 当前证据 | 判定 |
|---|---|---|
| 稳定身份 AgentProfile | `agent_profiles` + run/queue 外键 | partial：有 schema；没有 roster 注入 |
| 执行身份 AgentSession | `agent_sessions` + worker binding | partial：有 CRUD/绑定；没有 session chain service |
| Role 动态 registry | `roles` store + seed | partial：存储动态；执行/白名单仍近似闭集 |
| 同一 profile 换 session 不算独立 review | review service 有 modelFamily/session 字段 | partial：A2A 层未强制；review 层另行 enforcement |
| Session chain / continuity | `chainKey`、`continuityCapsule`、`catHandoffNote` 字段 | missing：没有 Clowder SessionChainStore 等价服务 |
| L0/context 注入 | adapter L0 + worker prompt | partial：两条路径分裂；worker 无 A2A/roster |
| 不引入 AgentInstance | schema 无 AgentInstance | available |
| callback/credential identity | per-run token + worker control binding | partial：只覆盖 tool_policy，不覆盖 A2A tool call |

结论：identity-session schema **足够承载**任务级 profile/session，但当前实现
**不足以支撑 A2A E2E**；缺的是 chain/bootstrap/roster/L0 注入和 transport
身份桥，而不是表字段数量。

## 6. E2E 矩阵

### 6.1 能力矩阵

| # | 能力 | 当前证据 | 状态 | 主要缺口 / owner |
|---|---|---|---|---|
| 1 | operator→agent `thread post --to` | CLI 写 message+queue；`DispatchService` 要求 `source.taskId` | **missing** | message 无 taskId → dead-letter；无 session/worktree；W7a |
| 2 | operator→agent `backlog dispatch` | `store.dispatchBacklog` 写 thread/message/queue | **missing** | message 无 taskId；task 尚未创建；无 session/worktree；W7a |
| 3 | `a2a_send` 单 target | handler + dispatch + fake executor 测试 | **partial** | worker 无 tool/transport；roster 缺失；W5b/W7a |
| 4 | `a2a_send` 多 target parallel | `control-dispatch` 两 reviewer 并行；`routeParallel` | **partial** | 同上；无真实 worker；W5b/W7a |
| 5 | serial A2A chain | A2A depth 持久化；queue 单 target hop | **partial** | 无生产 drain loop；无 worker tool；terminal 不完整；W7a/W5b |
| 6 | `handoff_create` | handler + custody + queue + idempotency 测试 | **partial** | worker 无 tool；direction 静态；无 terminal；W5b |
| 7 | `handoff_claim` | per-holder claim / safe_wait 测试 | **partial** | 无 transport；non-holder 返回完整 projection；W5b/security |
| 8 | `handoff_complete` | candidate 测试 | **partial** | 无 production resolver/commit；W5a residual |
| 9 | `handoff_withdraw` | author 撤回测试 | **partial** | 无 worker tool / operator CLI；W5b/W7a |
| 10 | parallel handoff | store/custody 投影测试 | **partial** | handler parallel 未覆盖；无 all-holder terminal；W5a/W5b |
| 11 | guide / steer | `guideRun` 写 inbox/event | **missing** | `RpcConnection` 无 steer/follow_up；inbox 无 consumer；W5b |
| 12 | interrupt | service abort + retry queue；fake executor 测试 | **partial** | 无 operator CLI；无真实 worker E2E；W7a/W5b |
| 13 | cancel queued | `cancelQueued` withdraw target | **partial** | 无 operator CLI/API；W7a |
| 14 | 停止运行 | `stopRun` abort + canceled；fake executor 测试 | **partial** | 无 operator CLI/API；W7a |
| 15 | negative: forged identity/control_ref | handler tests | **partial** | 无 transport 层身份测试；W5b/W7a |
| 16 | negative: non-holder | safe_wait tests | **partial** | 无 transport；projection 字段暴露待 review；W5b/security |
| 17 | negative: cross-task / cross-thread | handler tests | **partial** | 无 transport；cross-thread 本身未支持；W5a/W7a |
| 18 | negative: missing_a2a_tool_call | observation test，只一次且不路由 | **partial** | 无 worker tool call 的真实输入；W5b |
| 19 | idempotency: handoff replay | handler replay/conflict tests | **partial** | 无 transport 重试；W5b |
| 20 | idempotency: a2a_send retry | 无 requestId | **missing** | 需要 requestId + dedupe；W5a/W5b |
| 21 | recovery: worker 异常退出 | executor 异常→interrupted→retry→dead-letter tests | **partial** | 无生产 composition/trigger；W7a/ops |
| 22 | recovery: daemon 重启 | recoverControlPlane tests | **partial** | 无 daemon 启动接线/周期 sweep；W7a/ops |
| 23 | re-attach / fresh | 真实 pi RPC session file 重挂测试 | **partial** | 与 A2A 无关；fresh capsule 很薄；W5b |
| 24 | MCP client A2A | 无 | **missing** | W7a MCP server + auth；W7a |
| 25 | cross-thread A2A | 无；handler 明确同 thread | **missing** | 是否 v1 支持需 decision；W7a |
| 26 | run token 不能 approval/merge | 无 A2A transport | **missing** | W7a auth matrix；W7a |

### 6.2 测试证据的边界

| 测试 | 证明了什么 | 不能证明什么 |
|---|---|---|
| `control-a2a-tools.test.ts` | handler 语义、负例、idempotency、custody | worker/daemon/operator 可达性 |
| `control-dispatch.test.ts` | queue/dispatch/parallel/terminal/control-flow 语义 | 真实 producer、真实 session/worktree、真实 worker |
| `control-worker-e2e.test.ts` | 真实 pi RPC + mock provider + write/read + re-attach | A2A tool、handoff、operator/backlog path |
| `cli-dogfood.test.ts` | CLI 数据写入与手工 cutover | 真实 dispatcher；它手工创建 session 并直接 cutover |
| 全量 daemon 524 tests | 现有控制面/worker 回归 | 任何 `available` A2A E2E |

## 7. 命名澄清：Clowder 工具名 vs codeteam 契约

| Clowder 表面 | 语义 | codeteam 对应 | 不要做什么 |
|---|---|---|---|
| `cat_cafe_post_message` | 同 thread 消息；可选 targetCats；可带 action metadata | `a2a_send`（讨论）+ `handoff_create`（责任转移） | 不要把 `post_message` 直接 alias 成 `a2a_send`：后者没有 custody，前者还可带 action |
| `cat_cafe_cross_post_message` | 跨 thread 投递；targetCats；可带 coordination/assign_work | 无 v1 等价物；codeteam handler 强制同 thread | 不要假装 `cross_post_message` 已支持；跨 thread 是单独 decision |
| `cat_cafe_multi_mention` | 多猫 parallel fan-out | `a2a_send` / `handoff_create(mode=parallel)` 的 targets[] | 不要为同一语义再加第三个 tool 名 |
| `cat_cafe_hold_ball` | typed wait / timer / managed command | `WaitContractService` 只有内部类，没有 tool | 不要在没有 wait tool 时宣称 hold_ball 兼容 |
| 文本行首 `@` | Clowder 的可见路由标记 | 正文 `@` 不路由；只记 `missing_a2a_tool_call` | 不要把文本 `@` 接回路由权威 |

**建议：不默认加 Clowder 别名。**

- codeteam 的 canonical tool 名保持 `a2a_send` / `handoff_*`；`thread post`
  是 operator↔agent surface，不是 agent A2A tool。
- 在迁移文档/skill 中提供一张“Clowder 名字 → codeteam 语义”映射表即可。
- 如果 W7a 的 MCP server 需要兼容 Clowder 客户端，兼容 alias 只放在 MCP
  gateway 层，并显式拒绝语义不等价的调用（尤其 `cross_post_message` 与
  `post_message` 的 action metadata）；不要把两套名字同时暴露给同一个模型。
- 不建议把 `post_message` 当 `a2a_send` 的别名：这会让模型误以为
  `post_message` 能承担 handoff/custody，破坏 codeteam 的 tool-call-first
  责任转移契约。

## 8. 最小 wiring 选项

### 8.1 方案 A：A2A handlers 接 RPC worker tool surface（推荐先做）

```text
pi worker (--extension codeteam-worker-extension)
  registerTool(a2a_send / handoff_*)
  tool_call -> policy allow (role matrix)
  execute    -> control socket { type: "a2a_call", workerId, token, toolName, input }
        |
        v
WorkerControlServer (0600 local socket)
  resolveInvocationToken -> run/session/worker/task
  resolveRunPrincipal(store, run.id)
  A2AToolHandlers[method](input)
        |
        v
messages / handoffs / custody_events / queue_entries
```

需要改动/补齐：

1. `worker-extension.ts` 用 `A2A_TOOL_SPECS` 注册工具；`execute` 走 control
   socket，不直接打开 control DB。
2. `WorkerControlServer` 增加受控的 `a2a_call` 请求；复用现有 token →
   run/session/worker 校验；工具名必须属于 `A2A_TOOL_NAMES`，不能接受任意
   handler 名。
3. `allowedToolsForRole` / `evaluateWorkerToolCall` 增加 per-role A2A tool
   matrix（coder: a2a_send + handoff_create; reviewer/verifier: a2a_send +
   handoff_complete; architect: a2a_send），A2A tool 不走 path/command policy，
   由 handler 的 target/session 校验负责。
4. worker prompt 注入 task/thread 的 roster（profile id、displayName、role、
   modelFamily、restrictions）和 tool 使用规则；至少在 `a2a_send` description
   里说明 targets 是 profile id、正文 @ 不路由。
5. `a2a_send` 增加 `requestId` 或 run-scoped idempotency；否则 transport
   重试会重复写 message/queue。
6. 保留 `handoff_complete` 只写 candidate；在报告/测试里明确 terminal
   resolver 仍由独立 server-owned 步骤完成。

优点：复用已有 0600 control socket、per-run token、`WorkerControlServer`
身份校验和 `A2AToolHandlers`；不引入新进程；真实 pi RPC + 真实 extension 可测。

风险：extension API/工具 schema 耦合；`--tools` 与 custom tool 的交互需要
实测；per-run token 文件在 prompt 期间的生命周期；同一 uid 的 local socket
边界；没有跨 provider 复用。

### 8.2 方案 B：先做 W7a 最小 MCP server（不推荐作为第一步）

```text
pi worker --mcp-config codeteam (or extension registerMcpServer)
  -> mcp__codeteam__a2a_send / handoff_*
  -> codeteam daemon API (run token)
  -> shared A2A service -> handlers
```

需要改动/补齐：

1. W7a daemon API（HTTP/WS/SSE）或至少一个 A2A HTTP endpoint；
2. W7a auth matrix：operator credential / run token / webhook HMAC 三域；
3. MCP server 进程、stdio/HTTP 连接、tool exposure=direct、tool 名映射；
4. worker harness 移除 `--no-mcp`，装配 MCP server，per-run token 不能进 env/prompt；
5. MCP server 生命周期、错误映射、重连、离线行为。

优点：跨 provider/跨 CLI 共享；与 Clowder 的 MCP 生态一致；未来外部 agent
可复用；可将 Clowder alias 隔离在 gateway。

风险：范围远大于方案 A；per-worker MCP 配置与 per-run token 的冲突；
tool 名变成 `mcp__codeteam__...`，会改变 prompt/skill 文本；额外进程和
IPC；需要先有 W7a auth/HTTP 契约，否则会变成“为了 E2E 先做半个 W7a”。

### 8.3 推荐顺序

1. **先修契约阻塞**：source task 绑定；session/worktree 生产入口；principal
   execution role；`a2a_send` requestId；handoff terminal resolver owner。
2. **方案 A**：worker extension + local control socket，先在一个 fixture 里
   跑通真实 `pi --mode rpc` 的 coder → `a2a_send` → reviewer → `handoff_claim`
   → candidate。不要先写只调用 handler 的“E2E”。
3. **W7a operator 纵向切片**：`thread post --to` / backlog/task/session/worktree
   /drain loop，让 operator 能触发同一条链。
4. **方案 B**：在方案 A 的 shared `A2AService` 之上做最小 MCP server；只对
   外部/跨 provider 需求开放。
5. **控制面**：guide/steer、中断/停止/取消 CLI、recovery 周期 sweep、
   event replay、Console 投影。

## 9. 可执行 E2E 测试计划

### 9.1 P0：真实 worker A2A 纵向切片

建议新增 `packages/codeteam-daemon/test/control-a2a-worker-e2e.test.ts`：

1. 使用临时 `CODETEAM_DATA_DIR`，创建 thread/task（带 worktree）/backlog，
   coder + reviewer profiles，两个 active sessions；启动 `WorkerRuntime` +
   `DispatchService` + control socket。
2. coder 的 mock provider 在真实 pi RPC 中调用 `a2a_send` tool（targets=
   reviewer），extension 通过 control socket 调 daemon handler；断言 message、
   queue entry、response bubble、`dispatchRefs`。
3. reviewer mock provider 收到 source，调用 `handoff_claim`，再调用
   `handoff_complete`；断言 candidate、custody event、handoff 仍 `claimed`。
4. server-owned test resolver（或直接 store `commitCompletion`）提交 verified
   terminal；断言 `consumed`、one terminal、无重复 queue/message。
5. 断言两个 run 的 `toolCalls` 中包含 A2A tool 名，`missing_a2a_tool_call`
   不产生；A2A depth 递增。

这条测试是“handler + daemon + worker”的最小真实证据；如果只测 handler，
不算 E2E。

### 9.2 P0：真实 producer 纵向切片

1. `thread post --to` 必须先绑定 task（见 §10 的 decision），再经 dispatcher
   启动 session/worker；断言 agent response 回到 thread，且没有
   `dispatch_dead_lettered`。
2. `backlog dispatch` 必须原子创建/绑定 task（或要求显式 task），再走同一
   dispatcher；断言 kickoff → agent response → review handoff。
3. 两者都要覆盖“没有 active session / 没有 worktree”的负例：应返回可理解
   的 typed failure，而不是静默 dead-letter。

### 9.3 Negative / security

| 用例 | 期望 |
|---|---|
| worker tool args 伪造 `fromProfileId` / `controlRef` | control socket 拒绝，audit；不写 message/handoff |
| token 属于另一个 run/worker | `forbidden`；不执行 handler |
| 非 holder `handoff_claim` | `safe_wait`；只返回最小字段（security review 后定） |
| 跨 task/thread claim/withdraw | `safe_wait` / `forbidden`；不写 custody |
| 文本 `@reviewer` 但未调 tool | 一次 `missing_a2a_tool_call`；无 queue/handoff |
| 重复 `handoff_create` 同 key | 原 handoff/message/queue；不追加第二套 |
| 重复 `a2a_send` 同 requestId | 原 message/queue；不重复 |
| 超过 A2A depth | `a2a_depth_exceeded`；无 queue |
| control plane down | A2A tool fail-closed；只读 tool 按 allowlist 继续 |

### 9.4 Recovery / control

1. worker 异常退出 during prompt → `interrupted` → retry queue 或 dead-letter；
   holder claim 释放；无 double terminal。
2. daemon 重启 → `recoverControlPlane` + `WorkerRuntime.recover`；session
   `re_attach_pending`；queue entry 不丢。
3. guide：live run 中 `steer` 能改变 mock provider 的下一轮输出；不能只断言
   inbox 存在。
4. 中断：abort + retry run；停止：canceled；取消排队：withdrawn；三者都要有
   operator surface 测试。

### 9.5 MCP（方案 B 后）

1. 外部 MCP client 用 run token 调 `a2a_send`；成功写 message/queue。
2. run token 调 approval decide / merge execute → 403/拒绝。
3. MCP tool 名与 codeteam canonical 名的映射表有 contract test；不暴露
   `cross_post_message` 的未实现语义。

## 10. 按 owner 的缺口矩阵

### W5b（RPC worker / session / tool surface）

| 优先级 | 缺口 | 依赖 |
|---|---|---|
| P0 | worker extension 注册 A2A tools + control socket `a2a_call` | `A2A_TOOL_SPECS`、`WorkerControlServer` token 校验 |
| P0 | per-role A2A tool matrix；A2A tool 不走 path/command policy | role registry、`A2AToolHandlers` |
| P0 | worker prompt 的 roster/A2A 规则/tool descriptions | profile/session query、task/thread |
| P0 | `handoff_complete` candidate → server resolver 的接线 | W5a terminal resolver |
| P1 | `RpcConnection.steer/follow_up` + guide 注入 | pi RPC（已支持） |
| P1 | continuity capsule 的 producer；fresh fallback 不能只有 task title/why | session chain/W6 |
| P1 | a2a_send requestId / retry idempotency | control-plane contract |

### W7a（headless API / CLI / operator surface / MCP）

| 优先级 | 缺口 | 依赖 |
|---|---|---|
| P0 | production composition root + drain loop + event-driven wake | `DispatchService`、`WorkerRuntime` |
| P0 | `thread post` / `backlog dispatch` 的 task 绑定 | queue/message/task model |
| P0 | session create（或 `task run` 原子创建） | AgentProfile/AgentSession |
| P0 | worktree allocate/lease before worker start | `WorktreePoolService` |
| P0 | operator run control：guide / 中断 / 取消 / 停止 | `DispatchService` + RPC steer/abort |
| P1 | daemon startup recovery / periodic sweep | `recoverControlPlane`、`WorkerRuntime.recover` |
| P1 | event replay / thread projection / Console compatible API | messages/runs/queue |
| P1 | MCP server + auth matrix + Clowder alias gateway | shared A2A service、run token |
| P2 | cross-thread A2A（decision） | access-control/thread model |

### ops（环境 / 账号 / supervisor）

| 优先级 | 缺口 | 依赖 |
|---|---|---|
| P0 | per-profile provider account/credential 路由；不要把账号密钥放进共享 worker env | accounts/provider design |
| P0 | worker supervisor：daemon 异常退出后孤儿 pi 进程回收 | lifecycle/supervisor |
| P1 | sandbox/network 边界与 local socket 硬化 | W2 policy |
| P1 | live provider smoke 环境（当前 401 环境项） | credential 配置 |
| P2 | 运维 runbook：drain、重启、recovery、日志/trace 查询 | W7a/observability |

### W5a contract residual（需要在 W5b/W7a 前定 owner）

| 优先级 | 缺口 | 说明 |
|---|---|---|
| P0 | `handoff_complete` terminal resolver / commit | 当前 candidate 永远不 consumed；不能把 agent 自述当 verified |
| P0 | loop guard 门禁与 attempt+1/re-dispatch | 当前只有 snapshot；没有创建前拒绝/重排 |
| P1 | principal `role` 用 session/run execution role | 影响 `assertHandoffDirection` |
| P1 | `a2a_send` requestId / duplicate delivery | transport 重试前必须补 |
| P1 | parallelIntent 必填与 kind/actionFamily/slot 一致性校验 | 防止弱模型误 fan-out |
| P1 | non-holder 返回字段最小化 | 安全 review |
| P2 | return/replace tool 与 parallel_unfinished | 完整 Clowder parity，不是首个 E2E 必需 |

## 11. Open decisions（建议默认）

| 问题 | 建议默认 | 理由 |
|---|---|---|
| `thread post --to` 如何绑定 task | 显式 `--task <id>`；不猜“第一个未完成 task” | 同 thread 可有多 task；猜错会把工作送到错误 worktree |
| `backlog dispatch` 何时创建 task | 原子创建 worktask，或要求显式 task 后再 queue | 当前 message 无 taskId 是 P0 断点 |
| session 创建归属 | W7a daemon API/CLI 的 `session create` 或 `task run` 原子创建 | profile 不等于执行身份 |
| worktree 分配归属 | W7a/W5c 在 dispatch 前通过 WorktreePoolService lease | worker 需要真实 cwd；不能靠测试夹具 |
| handoff `fromRole` | 用 run/session execution role；profile.role 只做稳定身份 | 符合 identity-session P0 |
| `a2a_send` 幂等 | 增加 requestId（run-scoped） | transport 重试会重复 message/queue |
| 跨 thread A2A | v1 不支持；先文档化，不假装 `cross_post_message` | 当前 handler 强制同 thread |
| Clowder alias | 不做 runtime alias；只做迁移映射/MCP gateway | 语义不等价，双工具面会让弱模型选错 |
| custom role | action pair 数据驱动或 fail closed，不 fallback reviewer | 动态 role 不能只是表行 |
| accounts | per-profile accountRef/carrier；凭据不进 prompt/env-wide | live 多 provider 的身份边界 |

## 12. 结论与最小建议

**现在可以做什么：**

- 用 handler + fake executor 验证 A2A 语义、负例和投影；
- 用 W5b fixture 验证真实 `pi --mode rpc` 的文件工具、session 重挂和
  control-plane tool policy；
- 用 docs/规划继续冻结 terminal resolver、task binding、session/worktree
  provisioning 的契约。

**现在不能做什么：**

- 不能声称 handler/daemon/worker 的 A2A E2E 已可用；
- 不能让 operator 通过 `thread post` / `backlog dispatch` 真实驱动 agent；
- 不能让 worker 调用 `a2a_send` / `handoff_*`；
- 不能完成 handoff 的 verified terminal；
- 不能跑 guide 的真实 steer，也没有 operator 中断/停止/取消 CLI。

**最小建议顺序：**

1. 先修 P0 producer/consumer 契约（task 绑定）和 session/worktree 入口；
2. 再把 A2A tools 接进 RPC worker extension + 现有 local control socket；
3. 补 server-owned terminal resolver 与 requestId/loop guard；
4. 补 worker prompt roster/A2A 规则和 operator run control；
5. 最后做 W7a MCP server、event replay、Console 投影和跨 thread（如需要）。

在完成 1–3 之前，任何“A2A E2E 测试”如果只直接调用 handler 或手工
`cutoverQueueEntry`，都只是 in-process 语义测试，不能作为端到端验收。

## Appendix A：证据索引

| 事实 | 位置 |
|---|---|
| A2A tool specs/handlers | `packages/codeteam-daemon/src/a2a/tools.ts` |
| RunPrincipal / profile role | `packages/codeteam-daemon/src/a2a/principal.ts` |
| dispatch queue/cutover/one terminal | `packages/codeteam-daemon/src/dispatch/service.ts` |
| queue producer `thread post` | `packages/codeteam-daemon/src/cli/thread.ts` |
| queue producer `dispatchBacklog` | `packages/codeteam-daemon/src/control/store.ts` |
| worker args / no L0 / no MCP | `packages/codeteam-daemon/src/workers/harness.ts` |
| worker tool matrix | `packages/codeteam-daemon/src/workers/tool-policy.ts` |
| control socket request types | `packages/codeteam-daemon/src/workers/control.ts` |
| worker extension | `packages/codeteam-daemon/src/workers/worker-extension.ts` |
| worker prompt | `packages/codeteam-daemon/src/workers/prompt.ts` |
| RPC prompt/abort only | `packages/codeteam-daemon/src/workers/rpc-client.ts` |
| handoff terminal/candidate | `packages/codeteam-daemon/src/control/stores/handoffs.ts` |
| wait contract | `packages/codeteam-daemon/src/custody/waits.ts` |
| daemon health only | `packages/codeteam-daemon/src/daemon.ts` |
| CLI command list | `packages/codeteam-daemon/src/cli/index.ts` |
| profile CLI（无 session） | `packages/codeteam-daemon/src/cli/profile.ts` |
| L0 compiler | `packages/codeteam-pi-adapter/src/l0/compiler.ts` |
| adapter L0 session | `packages/codeteam-pi-adapter/src/session/session.ts` |
| A2A handler tests | `packages/codeteam-daemon/test/control-a2a-tools.test.ts` |
| dispatch tests | `packages/codeteam-daemon/test/control-dispatch.test.ts` |
| real RPC worker tests | `packages/codeteam-daemon/test/control-worker-e2e.test.ts` |
| CLI dogfood manual cutover | `packages/codeteam-daemon/test/cli-dogfood.test.ts` |

Clowder 只读参考（repo-relative，不含本地绝对路径）：

- `assets/system-prompts/system-prompt-l0.md`
- `assets/prompt-templates/l3-routing-rules.md`
- `assets/prompt-templates/workflow-triggers.yaml`
- `assets/prompt-templates/a2a-ball-check.md`
- `assets/prompt-templates/handoff-decision-tree.md`
- `assets/prompt-hooks/d8-a2a-球权检查/hook.yaml`
- `assets/prompt-hooks/d21-决策树/hook.yaml`
- `packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts`
- `packages/api/src/domains/cats/services/context/governance-l0.ts`
- `scripts/compile-system-prompt-l0.mjs`
- `packages/api/src/config/cat-config-loader.ts`
- `packages/api/src/config/catalog-accounts.ts`
- `packages/api/src/domains/cats/services/stores/ports/SessionChainStore.ts`
- `packages/api/src/domains/cats/services/session/SessionBootstrap.ts`
- `packages/api/src/domains/cats/services/session/context/ContextEpochOwner.ts`
- `packages/api/src/domains/cats/services/agents/registry/AgentRegistry.ts`
- `packages/mcp-server/src/tools/callback-tools.ts`

## Appendix B：未验证 / unknown

- 没有运行 live provider A2A E2E；当前 live provider smoke 是 env-gated，历史
  记录为凭据 401。
- 没有在真实 Console/Hub 上验证 thread/A2A 投影；W7a 尚未交付。
- 没有验证 `pi` extension `registerTool` 与 `--tools` 的所有组合；方案 A
  需要实现后实测。
- 没有决定 cross-thread A2A、custom role action pair、accounts/provider
  routing 的最终 owner；本报告只给建议，不替 operator 拍板。

[宪宪/deepseek-flash🐾]
