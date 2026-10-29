---
title: "A2A E2E Foundation — composition + worker tools 实施报告"
doc_kind: report
status: reviewed_pending_vision_guard
created: 2026-10-30
updated: 2026-10-30
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
baseline: "codeteam-work @ 956aee1d2"
feature: F015
plan: docs/plans/0017-a2a-e2e-foundation.md
---

# A2A E2E Foundation 实施报告

> **结论先行。** 本 slice 把 readiness report 的 P0-1..P0-6 接成了一条
> 真实可达链：真实 `codeteam` CLI 写入 producer → `startDaemon` 打开同一个
> `ControlStore` 并启动 `WorkerRuntime` + `DispatchService` + drain loop →
> 真实 `pi --mode rpc` worker 通过 0600 control socket 调 `a2a_send` /
> `handoff_create` / `handoff_claim` / `handoff_complete` → server-owned
> resolver 验证 run terminal → handoff `consumed`。另有一条 cold-boot
> recovery E2E：残留 running run 被 startup recovery 收口为 interrupted，
> retry 由真实 worker 完成。

## 1. 交付边界

本报告覆盖：

- production composition root（`startDaemon` 组装 control plane）。
- `thread post --to` / `backlog dispatch` 的 task 绑定。
- `task prepare` 的 AgentSession + worktree 生产入口。
- worker extension 的 5 个 A2A tool + control socket `a2a_call`。
- server-owned handoff terminal resolver。
- `a2a_send` requestId 幂等、handoff loop guard、non-holder 最小化、
  execution role、control socket 目录权限。
- 真实 CLI/daemon/worker + mock provider E2E（含负路径与 cold-boot recovery）。

不在本 slice：MCP/stdio/13 工具、HTTP/WS/SSE、Console/W7b、W8、cross-thread
A2A、return/replace tool、live provider 质量验收。详见 `0017` residual ledger。

## 2. 主要实现

| 面 | 落点 | 结果 |
|---|---|---|
| Composition root | `daemon-runtime.ts`、`daemon.ts` | `startDaemon` 默认打开 store、启动 0600 control socket、startup recovery、drain timer、sweep timer；`stop` 先停 loop 再清理 worker/store；`/ready` 暴露 control plane 状态 |
| Producer/task 绑定 | `cli/thread.ts`、`control/store.ts` | `thread post --to` 要求显式 `--task` 并校验 session/worktree；`backlog dispatch` 原子创建 work task + kickoff message(taskId) + queue；未 prepare 时 `dispatch_not_ready` defer，不 dead-letter |
| Session/worktree 入口 | `scheduling/provisioning.ts`、`task prepare`、`session list/show` | 幂等 lease + active sessions；`--worktree` 可绑定已有目录；session role 默认 profile primary role，可显式覆盖 |
| Worker A2A tools | `a2a/tool-surface.ts`、`workers/worker-extension.ts`、`workers/control.ts`、`workers/tool-policy.ts` | extension 注册 5 个 tool；`a2a_call` 只接受 A2A 工具名，token→credential→run/session/worker→`resolveRunPrincipal`→handler；控制面不可用时 fail-closed |
| Terminal resolver | `a2a/terminal.ts` | `run_completed` / `review_delivered` verifier；unknown predicate 不 commit；single consumed；parallel 全 holder verified 才 commit，失败 holder 写 `handoff.parallel_unfinished` |
| 幂等/loop guard | migration 016 `a2a_requests`、`a2a/requests.ts`、`a2a/tools.ts` | requestId replay/conflict；同 canonical action live handoff 拒绝；parallelIntent 必填；non-holder safe_wait 不带 handoff 对象 |
| Worker prompt | `workers/prompt.ts`、`workers/executor.ts` | worker 看到 peers roster、A2A 规则、assigned handoff id/predicate；cutover 从 source control_ref 绑定 handoffId |

## 3. AC 映射

| AC | 证据 | 判定 |
|---|---|---|
| P0-1 producer/task 绑定 | `cli-producer-binding.test.ts`：backlog message taskId、thread post taskId、未 prepare defer、无 dead-letter | pass |
| P0-2 AgentSession 生产入口 | 同上：`task prepare` 幂等创建/复用 sessions；`daemon-a2a-e2e` 真实 worker 使用这些 sessions | pass |
| P0-3 worktree 入口 | 同上：`task prepare` 产生 lease + worktree；daemon E2E worker cwd 使用该 worktree | pass |
| P0-4 worker A2A tool surface | `control-a2a-control.test.ts` + `control-a2a-worker-e2e.test.ts` + `daemon-a2a-e2e.test.ts` | pass |
| P0-5 worker roster/A2A 认知 | `workers/prompt.ts` 注入 peers/A2A 规则/assigned handoff；真实 worker E2E 能选 tool/claim/complete | pass |
| P0-6 terminal resolver | `control-handoff-terminal.test.ts` + real worker E2E handoff consumed | pass |
| S1 token→principal→handler | `control-a2a-control.test.ts`：wrong worker/foreign run/non-A2A tool/allowlist 拒绝 | pass |
| S2 credential 边界 | `mintInvocationCredential` toolPolicy 在 control socket 再校验；A2A tool 不能借 token 调 merge/approval | pass |
| S4 requestId ledger | `control-a2a-tools.test.ts` + `control-a2a-control.test.ts` replay/conflict；migration 016 | pass |
| P1-1 execution role | `a2a/principal.ts` 使用 `run.role`；测试覆盖 architect profile + coder session | pass |
| P1-2 loop guard/parallelIntent/non-holder | `control-a2a-tools.test.ts` 新增 4 个负例 | pass |

## 4. E2E 证据

### 4.1 真实 CLI/daemon/worker 主链

`packages/codeteam-daemon/test/daemon-a2a-e2e.test.ts`：

1. 真实 `codeteam` CLI：`auth init` → `profile seed/add` → `backlog
   create/approve/dispatch` → `task prepare`。
2. 真实 `startDaemon`：打开同一 `control.db`，启动 `WorkerRuntime`、0600
   control socket、`DispatchService`、drain loop。
3. 真实 `pi --mode rpc` + mock provider：
   coder `a2a_send` → `handoff_create`；reviewer `handoff_claim` →
   `handoff_complete`；server resolver 在 reviewer run terminal 后 commit。
4. 断言：handoff `consumed`、run 全部 completed、A2A tool 出现在
   `run_events`、原 queue entry 无 `dispatch_dead_lettered`。
5. 负路径：缺 `--task` 的 `thread post --to` 返回 typed failure，queue 不变。

### 4.2 Cold-boot recovery

同一测试文件：

1. 在 daemon 未运行时 seed 一条已 cutover 的 `running` run。
2. `startDaemon` startup recovery 把 run 收口为 `interrupted`。
3. failure policy 写 `run_retry_queued` + 新 queue entry。
4. 真实 worker 完成 retry，response 含 `RECOVERED_AFTER_RESTART`。

### 4.3 Worker 负路径

`control-a2a-worker-e2e.test.ts`：

- 文本 `@profile:reviewer` 无 tool → 恰好一次 `missing_a2a_tool_call`，
  无 queue/handoff。
- control socket 不可用 → `a2a_send` fail-closed，不写 message/queue。

## 5. 验证记录

工作区：隔离 worktree `/home/ming/agent/codeteam-f015`，分支
`feat/f015-a2a-e2e-foundation`，基线 `956aee1d2`。

```text
NODE_ENV=development npm run build          # packages/codeteam-daemon, pass
NODE_ENV=development npx vitest --run       # 82 files passed | 2 skipped
                                            # 542 tests passed | 2 skipped
```

定向：

```text
daemon-a2a-e2e.test.ts                 2 passed
control-a2a-worker-e2e.test.ts         3 passed
control-a2a-control.test.ts            2 passed
control-a2a-tools.test.ts             14 passed
control-handoff-terminal.test.ts       5 passed
cli-producer-binding.test.ts           1 passed
```

Biome：仓库官方 gate `npx biome check --error-on-warnings .` 通过；仅剩
base 已存在的 `packages/codeteam-skills/test/catalog.test.ts` useTemplate
info（非本 PR）。

Review follow-up（砚砚 identity/custody/security）：

- P2 allowedTools fail-open 已修：`mintInvocationCredential` 未显式给
  toolPolicy 时按 run.role 填充 allowlist；control socket 对 missing/empty
  allowlist 直接 `forbidden`，非空但缺 tool 时返回 policy denial。新增
  `control-a2a-control.test.ts` 空清单负例，同时覆盖 tool_policy 与
  a2a_call。
- Biome 三文件漂移已机械修复；`terminal.ts` 也在官方 gate 中一并收口。
- 保留为后续 follow-up：completed run + unverified candidate 的 claim 释放、
  handoff deadline 封顶与周期 expiry sweep、installation-wide peers
  收敛。它们不影响本 slice 的约定结果。

未通过/未运行：

- 根级 `npx tsc --noEmit -p tsconfig.json` 仍被本机未 hydrate 的 model data
  与既有 `packages/ai` 类型错误阻断（大量 `ModelGroups` / `never` 错误），
  与本次改动无关；daemon 包 build 通过。
- 未跑 `npm run build:offline` 全仓：本 worktree 的非 daemon `dist` 是指向
  主 checkout 的只读 symlink，全仓 build 会写入主 checkout；kernel 未改动，
  本 slice 只改了 `@codeteam/daemon`，其 build 已通过。
- live provider smoke 未跑；E2E 使用真实 pi kernel + mock provider，不冒充
  线上模型质量。

## 6. Residual ledger

| 项 | 去向 |
|---|---|
| worktree 目前是隔离文件目录 lease，不是 git worktree clone | W7a/ops：接入真实 repo/worktree 创建与分支绑定 |
| drain loop 是 50–250ms poll + dirty flag，跨进程 producer 无事件通知 | W7a transport/event replay |
| MCP/stdio/13 工具、HTTP/WS/SSE | W7a/MCP thread |
| cross-thread A2A | 单独 decision |
| `handoff_return` / `handoff_replace` / attempt+1 重排 | 后续 W5a residual |
| guide 的真实 RPC steer/follow_up | W7a run control |
| per-profile provider account/credential 路由 | ops/accounts design |
| OS 级孤儿 pi 进程 supervisor | ops supervisor |
| parallel 全 holder 未完成时的终端策略 | 当前写 `parallel_unfinished` 并释放失败 holder claim；完整 return/replace 另开 |

## 7. Review 入口

- 烁烁：A2A/session/worker review。
- 砚砚：identity/custody/security review。
- 墨墨：vision guard（非作者非 reviewer）。

Review 请以本报告 §3/§4/§5 与 `0017` 为证据索引；代码 diff 以
`feat/f015-a2a-e2e-foundation` 的最终 HEAD 为准。

[宪宪/deepseek-flash🐾]
