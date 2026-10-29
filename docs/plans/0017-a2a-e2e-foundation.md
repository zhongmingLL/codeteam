---
title: "A2A E2E Foundation — production composition + worker tools 实施计划"
doc_kind: plan
status: reviewed_pending_vision_guard
created: 2026-10-30
updated: 2026-10-30
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash)]
vision_guard: 墨墨 (Qwen 3.8 Flash)
source: "docs/reports/2026-10-29-a2a-e2e-readiness.md"
feature: F015
---

# A2A E2E Foundation 实施计划

> 本计划把 readiness report 的 P0-1..P0-6 与 W7a 方案 A 落成一条串行
> slice。目标不是再加一层 handler 测试，而是让 **真实 CLI → daemon
> composition root → RPC worker → A2A tool → dispatch → handoff terminal**
> 可以在隔离数据目录里重复跑通。
>
> 单一真相源：`docs/architecture/0001-codeteam-architecture-v1.md`、
> `docs/architecture/0002-pi-runtime-integration.md`、`docs/plans/0010`、
> `docs/plans/0011`、以及本文件。实现遇到契约冲突时先回写本文件，不在代码里
> 另造第二套 queue / message / handoff store。

## 目标与边界

完成后：

- `startDaemon` 是生产 composition root：打开 `ControlStore`，启动
  `WorkerRuntime`（0600 control socket）、`DispatchService` 和 drain loop；
  startup recovery 在 ready 前执行；`stop` 先停 drain/worker 再释放 fence。
- 真实 producer 写入的 source message 带 `taskId`；`thread post --to` 在没有
  task / session / worktree 时返回可理解的 typed failure，不静默
  dead-letter。
- `task prepare` 是 AgentSession + worktree 的生产入口；`backlog dispatch`
  原子创建 work task，queue entry 在 task 未 prepare 时被 defer 而不是 poison。
- RPC worker 的模型工具面包含 `a2a_send` / `handoff_*`；extension 通过现有
  0600 control socket 调用 daemon handler；身份来自 per-run token →
  `resolveRunPrincipal`，不接受 tool args 自报身份。
- `handoff_complete` 只写 candidate；daemon 的 server-owned resolver 依据
  `terminalPredicate` 验证后调用 `commitCompletion`，handoff 自然
  `consumed`；agent 不能自签 verified。
- `a2a_send` 带 `requestId` 幂等；同 canonical action 的 live handoff 被
  loop guard 拒绝；non-holder 只返回最小 `safe_wait`。

明确不做：

- MCP server / stdio / P0 13 工具（MCP thread 后做）。
- HTTP/WS/SSE、Console/W7b、W8。
- 第二套 queue/message/handoff store；不把 handler 测试冒充 E2E。
- live provider 质量验收；E2E 使用真实 pi RPC + mock provider。
- 完整 cross-thread A2A、return/replace tool、parallel 全量收口策略。

## 冻结决定

### D1. Composition root 只组装现有对象

`startDaemon` 新增可选 `controlPlane` 配置；默认启用。它打开同一个
`ControlStore`，构造 `WorkerRuntime` 与 `DispatchService`，不新建 executor
或 queue。drain loop 以短周期 poll + dirty flag 组合工作；跨进程 CLI
producer 无法通知进程内事件，所以 poll 是 v1 的诚实实现，W7a transport 再
替换为 event-driven。

`daemon.stop()` 的顺序固定为：停止 drain timer → 等待当前 drain → 停止
worker/control socket → 关闭 store → 释放 daemon fence。任一阶段失败不阻断
后续清理，但会写 audit/日志。

### D2. Task 绑定是 producer 的硬前置

`thread post --to` 必须显式 `--task <id>`；message 写入 `taskId`。producer 在
写 message/queue 前验证：

- task 存在且属于该 thread；
- target profile active；
- target 在该 task 有且仅有一个 active session；
- task 有 worktree。

任一不满足返回 `invalid_state`，并给出 `codeteam task prepare <taskId> ...`
指引；不写半条 queue。

`backlog dispatch` 在一个事务里创建 thread + work task + kickoff message +
queue entry；message 写入 `taskId`。task 尚未 prepare 时，dispatcher 返回
`dispatch_not_ready`，释放 claim、写 defer audit，下一轮再试；不
dead-letter。

### D3. Session/worktree 入口是 `task prepare`

`codeteam task prepare <taskId> --profile <profile> [--profile ...]`：

- 已有 worktree 则复用；`--worktree <path>` 可绑定已有目录；
- 否则通过 `WorktreePoolService` lease 一个隔离目录并写回 task；
- 每个 profile 创建（或复用唯一）active `AgentSession`；session role 默认
  profile.role，可用 `--role` 指定；
- session provider/model/modelFamily 从 profile 派生，`workingDirectory` 指向
  worktree，`userId` 来自 task；
- 幂等：重复 prepare 不产生第二个 active session，也不二次 lease。

### D4. Worker A2A tool surface 走现有 control socket

worker extension 注册 5 个 A2A tool；`execute` 发 `a2a_call` 到 0600 socket。
daemon 端只接受 `A2A_TOOL_NAMES`，校验：

1. token → credential active / 未过期；
2. credential.runId 对应 run 仍 running；
3. run.workerId === request.workerId；
4. session.workerId === request.workerId；
5. credential.toolPolicy.allowedTools 包含该 tool；
6. `resolveRunPrincipal` 的 task/session/profile/role 一致；
7. 调用 `A2AToolHandlers`；handler 再做 target/custody/direction 校验。

tool args 中的 `from*` / `controlRef` / `ownerUserId` 等由 handler 白名单拒绝。
控制面不可用时 A2A tool 与 mutating tool 一样 fail-closed。

### D5. Terminal resolver 是 server-owned

新增 `HandoffTerminalResolver`，默认 verifier：

- `run_completed`：candidate 所属 run 已由 dispatch 收口为 `completed`；
- `review_delivered`：task 内存在 `runId`、`reviewerProfileId`、`headSha` 三者
  匹配的 review 记录。

未知 predicate 返回 `unverified`，不 commit。resolver 在 run terminal hook
和 daemon startup 时运行；只调用 `commitCompletion({verified:true})`，不读
agent 自述。single handoff 在验证后 consumed；parallel handoff 必须所有
holder 都有 verified candidate 才 commit，失败 holder 写
`handoff.parallel_unfinished`。

### D6. 幂等与 loop guard

- `a2a_send` 新增可选 `requestId`；`a2a_requests` 记录
  `(taskId, profileId, requestId)` → message/queue + intent hash。重复请求返回
  原 message/queue（queue 已 cutover 时 queue 为 null）；intent 不同返回
  `conflict`。
- `handoff_create` 已有 `(taskId, idempotencyKey)` replay；新增同 task 下
  live `canonicalActionKey` 拒绝（`loop_guard_live_handoff`）。
- `parallel` handoff 必须给 `parallelIntent`。
- non-holder / task scope mismatch 的 `safe_wait` 不返回 handoff 对象。

## 实施切片与 AC 映射

| 切片 | 落点 | 可观察结果 | 验收映射 |
|---|---|---|---|
| F015-1 composition root | `daemon.ts`、`daemon-runtime.ts` | daemon 启动 control store/worker/control socket/drain；startup recovery；stop 清理；ready 暴露 runtime 状态 | P0-2/P0-5（执行可达性）、S1 |
| F015-2 producer/task 绑定 | `cli/thread.ts`、`control/store.ts`、`dispatch/service.ts` | `thread post --to` 写 taskId；`backlog dispatch` 建 task + taskId；未 prepare 时 defer 不 dead-letter | P0-1 |
| F015-3 session/worktree 入口 | `scheduling/provisioning.ts`、`cli/thread.ts`、`cli/session.ts` | `task prepare` 产生 lease + active sessions；重复调用幂等；session list/show 可查 | P0-2/P0-3 |
| F015-4 worker A2A tools | `workers/worker-extension.ts`、`workers/control.ts`、`workers/tool-policy.ts`、`workers/prompt.ts` | 真实 pi worker 可见/可调 5 个 A2A tool；token→principal→handler；控制面 down fail-closed | P0-4/P0-5 |
| F015-5 terminal resolver | `handoffs/terminal.ts`、daemon hook | candidate → verified commit → consumed；unknown predicate 不 commit；parallel unfinished | P0-6 |
| F015-6 idempotency/security | `a2a/tools.ts`、`a2a/requests.ts`、migration 016、`auth` binding | requestId replay/conflict；loop guard；non-holder 最小化；execution role；socket dir 0700 | S1/S2/S4、P1-1/P1-2/P1-5 |
| F015-7 real E2E | `daemon-a2a-e2e.test.ts`、`control-a2a-worker-e2e.test.ts` | CLI/daemon/worker/mock provider：backlog → task prepare → coder handoff_create → reviewer claim/complete → consumed；负路径与 restart recovery | P0-1..P0-6 |

## 测试清单

- `daemon-a2a-e2e.test.ts`：真实 CLI 写 producer，真实 `startDaemon` 起
  control plane，真实 `pi --mode rpc` + mock provider 完成 handoff；
  negative token；daemon restart recovery。
- `control-a2a-worker-e2e.test.ts`：worker extension → control socket →
  `a2a_send` / `handoff_claim` / `handoff_complete`；A2A tool 出现在
  run events；text `@` 无 tool 只观测一次 `missing_a2a_tool_call`。
- `control-worker-control.test.ts`：`a2a_call` 身份链、跨 worker/run 拒绝、
  非 A2A tool 名拒绝、credential allowlist、控制面 down。
- `control-a2a-tools.test.ts`：requestId replay/conflict、loop guard、
  non-holder 最小化、execution role、parallelIntent。
- `control-handoff-terminal.test.ts`：run_completed / review_delivered /
  unknown predicate / parallel unfinished。
- `cli-producer-binding.test.ts`：thread post task 绑定与 typed failure；
  backlog dispatch 建 task；task prepare 幂等。

定向命令：

```bash
NODE_ENV=development npm --prefix packages/codeteam-daemon test -- \
  daemon-a2a-e2e control-a2a-worker-e2e control-worker-control \
  control-a2a-tools control-handoff-terminal cli-producer-binding
NODE_ENV=development npx tsc --noEmit -p tsconfig.json
NODE_ENV=development npx biome check packages/codeteam-daemon
NODE_ENV=development npm run build:offline
```

全量：`NODE_ENV=development npm --prefix packages/codeteam-daemon test`。

## 依赖与顺序

1. F015-1 先落 composition root 与 daemon runtime；后续 E2E 都依赖它。
2. F015-2/3 修 producer 与 provisioning；先有真实 task/session/worktree，
   才能跑真实 worker。
3. F015-4 接 worker tool surface；先做 tool-surface 纯模块与控制面
   `a2a_call`，再接 extension。
4. F015-5 接 terminal resolver；必须在 candidate → commit 边界上先写负例。
5. F015-6 补幂等/loop guard/安全项；最后跑 F015-7 E2E。

## 风险与回滚

| 风险 | 路 | 处置 |
|---|---|---|
| `pi --tools` 不激活 extension 注册的 A2A tool | P1 | 在真实 pi E2E 里直接断言 tool call 成功；失败则退回 `defaultTools`/`setActiveTools` 方案 |
| control socket 成为第二身份源 | P1 | 只复用 per-run token + `resolveRunPrincipal`；不新增 token 类型 |
| drain poll 掩盖跨进程 producer | P2 | 文档明确 v1 poll；W7a 用 event/HTTP 替换 |
| terminal resolver 把 agent 自述当 verified | P1 | 只接受 server-owned run/review 证据；未知 predicate 不 commit |
| backlog dispatch 未 prepare 被 dead-letter | P1 | `dispatch_not_ready` 加入 defer 集合；负例断言无 dead-letter audit |
| task prepare 二次 lease/session | P2 | 幂等测试；重复调用返回原 lease/session |

回滚：新增 migration 016 只加 `a2a_requests` 表；不改现有表。代码按切片
可单独回滚到 `956aee1d2`；隔离 dev DB 可直接重建，无生产数据。

## Residual ledger（本 slice 不做）

| 项 | 去向 |
|---|---|
| HTTP/MCP transport 与 13 工具 | W7a / MCP thread |
| cross-thread A2A | 单独 decision；当前 handler 仍同 thread |
| `handoff_return` / `handoff_replace` / attempt+1 重排 | 后续 W5a residual |
| guide 的真实 RPC steer/follow_up | W7a run control |
| per-profile provider account/credential 路由 | ops/accounts design |
| OS 级孤儿 pi 进程 supervisor | ops supervisor |
| live provider smoke | 环境恢复后手动 |

## Current progress（2026-10-30）

- F015-1..F015-7 已实现；真实 CLI/daemon/worker + mock provider E2E 与
  cold-boot recovery E2E 已跑通。
- daemon 全量：82 files passed | 2 skipped；542 tests passed | 2 skipped。
- 定向：`daemon-a2a-e2e` 2、`control-a2a-worker-e2e` 3、
  `control-a2a-control` 3、`control-a2a-tools` 14、
  `control-handoff-terminal` 5、`cli-producer-binding` 1。
- Review follow-up：P2 allowedTools fail-closed 已修（mint 默认按 run.role
  填充；empty/missing 在 socket 拒绝）+ 负例；biome 三文件漂移已修。
- 证据：[`../reports/2026-10-30-a2a-e2e-foundation.md`](../reports/2026-10-30-a2a-e2e-foundation.md)。
- 待办：烁烁 A2A/session/worker review、砚砚 identity/custody/security
  review、墨墨 vision guard；review 通过后 merge PR 并 final-only 回报主 thread。

