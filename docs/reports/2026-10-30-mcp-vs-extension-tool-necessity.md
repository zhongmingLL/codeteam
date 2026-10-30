---
title: "MCP vs pi extension tool：codeteam v1 必要性与迁移判断"
doc_kind: report
status: draft-for-review
created: 2026-10-30
updated: 2026-10-30
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash), 烁烁 (Kimi K3)]
baseline: "codeteam-work @ 5c30f2200"
related:
  - "docs/reports/2026-10-29-clowder-mcp-architecture-and-w7a-tool-surface.md"
  - "docs/plans/0017-a2a-e2e-foundation.md"
  - "docs/reports/2026-10-30-a2a-e2e-foundation.md"
scope: "read-only investigation; docs-only deliverable; no product code changes"
---

# MCP vs pi extension tool：codeteam v1 必要性与迁移判断

> 本文回答 operator 的补充问题：A2A foundation 已经用 pi extension tool
> 跑通真实 CLI/daemon/worker 链路，为什么还要 MCP？MCP 是否应该转成
> extension tool？v1 是否应直接砍掉 MCP？
>
> 只读调研；没有改产品代码。结论是：**v1 应 extension-first，从 W7a 移除
> MCP；MCP 保留为有明确外部 consumer 时才启用的 sibling adapter，不作为
> 默认路径，也不是永久 Drop。**

## 0. 结论先行

1. **internal pi worker 不需要 codeteam MCP。** F015 已经用 worker extension
   注册 5 个 A2A tool，并通过 0600 control socket 调 daemon handler；真实
   `pi --mode rpc` + mock provider 的 E2E 已跑通。worker harness 现在显式
   `--no-mcp`。
2. **P0 13 工具不需要 MCP。** 5 个 A2A/custody 工具已经是 extension tool；
   其余 5 个 thread/task 读工具 + 3 个 wait 工具可以在同一 extension 里
   增加，差异只是 control socket 的 `read_call`/`wait_call` handler，不是
   transport 能力。没有一项只有 MCP 能做。
3. **MCP 的真实价值只剩外部 consumer。** 标准 MCP client 发现/调用、
   非 pi runtime、远程 worker、第三方工具。v1 的 worker 全部是 pi RPC，
   Console/CLI 走 HTTP/CLI，W8 走 webhook/`gh`，所以 v1 没有真实 MCP
   consumer。
4. **v1 建议砍掉 MCP，保留 seam。** 从 W7a 任务/验收中移除 MCP server；
   P0 13 用 worker extension 交付。MCP adapter 作为条件性 P1/P2，只有出现
   “命名的非 pi 外部 runtime / 远程 worker / 第三方 MCP client”时才做。
5. **如果保留 MCP，最小 slice 仍是 P0 13，不是 P1a 全量。** 必须是 sibling
   adapter，和 extension 共用 `tool-surface` specs、daemon handler、control
   socket 和 principal 模型；不能 MCP→extension 链式调用，也不能在同一个
   pi worker 同时加载两套同名工具。
6. **这不是“MCP 无用”，而是“v1 没有它的消费者”。** MCP 的跨 runtime/
   标准发现能力是真实的；但为它付出的进程、stdio hop、auth、运维、测试
   和双工具面成本，在没有外部 consumer 时不会换来用户可见结果。

## 1. 当前真相（`5c30f2200`）

### 1.1 F015 已经证明 extension 路径

`docs/plans/0017` D4 与 `docs/reports/2026-10-30-a2a-e2e-foundation.md`
记录了真实链路：

```text
真实 codeteam CLI producer
  → startDaemon composition root
  → WorkerRuntime + 0600 control socket + DispatchService
  → 真实 pi --mode rpc worker
  → worker extension registerTool(a2a_send / handoff_*)
  → control socket { type: "a2a_call", workerId, token, toolName, input }
  → resolveInvocationToken → run/session/worker/task
  → resolveRunPrincipal → A2AToolHandlers
  → messages / handoffs / custody_events / queue_entries
  → server-owned terminal resolver → handoff consumed
```

关键事实：

| 事实 | 证据 |
|---|---|
| worker extension 注册 5 个 A2A tool | `packages/codeteam-daemon/src/workers/worker-extension.ts`（`A2A_TOOL_SPECS` 循环 + `pi.registerTool`） |
| tool spec 是纯模块，不依赖 daemon store | `packages/codeteam-daemon/src/a2a/tool-surface.ts`（注释明确“no store, handler, or Node-only imports”） |
| extension 每次调用读 0600 token file | `worker-extension.ts` 的 `readToken` / `a2aCall` |
| control socket 做 token→run/session/worker→principal→handler | `packages/codeteam-daemon/src/workers/control.ts` |
| worker 显式 `--no-mcp` | `packages/codeteam-daemon/src/workers/harness.ts` `workerArgs()` |
| 真实 RPC E2E 已通过 | `docs/reports/2026-10-30-a2a-e2e-foundation.md` §4；`daemon-a2a-e2e.test.ts` / `control-a2a-worker-e2e.test.ts` |
| `a2a_send` requestId 已落 | `a2a/tool-surface.ts`、`a2a/tools.ts`、`a2a/requests.ts`、migration 016 |

### 1.2 pi 的 MCP 工具最终也是 extension tool

`packages/coding-agent/src/extensions/mcp/index.ts` 的 MCP 扩展在连接 server
后，把每个 MCP tool 转成 `pi.registerTool(definition)`，名字是
`mcp__<server>__<tool>`。`packages/coding-agent/src/core/extensions/types.ts`
的 `registerTool` / `ToolDefinition` 是同一个工具注册面。

这意味着：

- “MCP tool”与“extension tool”在模型看来都是 tool definition；两者共享
  pi 的 tool registry、`tool_call` hook、rendering、exposure、loadout。
- MCP 的差异不在“模型能不能调用”，而在**多一个 server 进程、一个传输协议、
  一套发现/配置/生命周期，以及 `mcp__` 命名空间**。
- 对 internal pi worker，MCP 不是“更通用的 extension”；它是 extension 的
  一个远端/外部适配器。没有外部 client 时，它只是多一层。

### 1.3 与 2026-10-29 MCP 报告的关系

`docs/reports/2026-10-29-clowder-mcp-architecture-and-w7a-tool-surface.md`
的工具 inventory、映射、auth 边界仍然有效；但以下结论按本报告更新：

| 旧报告 | 当前判断 |
|---|---|
| W7a 推荐 stdio MCP server + 0600 socket | **transport 本身仍适用，但 MCP server 不再是 v1 默认**；同一个 0600 socket 由 extension 先用 |
| W7a P0 13 由 MCP 暴露 | **P0 13 由 worker extension 暴露**；MCP 只在外部 consumer 出现时做 sibling adapter |
| `callbackAllowlist` 需要注入 | 当前实际 allowlist 是 `toolPolicy.allowedTools`；extension 已用它做 fail-closed。不要新增第二套 allowlist；MCP 若启用，从同一 tool policy 派生 |
| `a2a_send` 无 requestId | F015 已补 `a2a_send requestId` + `a2a_requests`；旧缺口已关闭 |
| `codeteam-protocol` 共享包 | v1 extension-only 可先扩 `a2a/tool-surface.ts`；只有第二个 adapter 真的落地时才抽共享包，避免提前造包 |
| typed auth failure / latest-replaced / wait owner fence | 仍然有效，但优先级按“extension 是否需要”重排：wait owner fence 是 extension P0；typed HTTP 401 是外部 MCP adapter 的前置 |

旧报告中 `§9 未决问题` 的 #1 “pi MCP bridge 是否能传 socket/token” 现在可以
回答：**internal worker 不需要 MCP bridge；extension 已经直接拿到 socket
和 token file。** 只有外部 MCP adapter 才需要新的 env/config 传递。

### 1.4 当前仍未解决、但与 MCP 选择无关的契约缺口

这些缺口 extension 也需要补，不应被“砍 MCP”掩盖：

- `resolveInvocationToken` 仍把 terminal/expired 统一成 `invalid_token`；
  extension 走 `ControlError` code，不会因此绕过，但 typed reason 仍不完整。
- 同一 `(threadId, agentSessionId)` 仍可能多个 active credential；
  extension 每次读 token file，旧 run 的 token 可能仍可用；需要
  latest/replaced 语义。
- `WaitContractService.terminate` 只在 `user_cancel` 检查 owner；extension
  的 `wait_cancel` 必须补 exact owner fence。
- P0 13 的 8 个 read/wait tool 还没有 extension spec/route；这是 extension
  的实现工作，不是 MCP 的必要性证据。

## 2. Consumer matrix：谁真的需要 MCP

| Consumer / scenario | 需要 codeteam MCP？ | 说明 |
|---|---:|---|
| internal pi RPC worker（coder/reviewer/verifier） | **No** | extension tool 已在 F015 跑通；`--no-mcp`；per-run token + 0600 socket |
| in-process SDK pi session | **No** | extension factory / `customTools` 可注册同一工具；不需要 MCP server |
| operator CLI | **No** | CLI 直接调 daemon/store；不是模型工具面 |
| W7a/W7b Console / Web | **No** | HTTP/WS/SSE + operator credential；不是 MCP client |
| W8 GitHub/GitLab connector | **No** | webhook HMAC + `gh` CLI / Forge API；不安装 MCP server |
| 外部 native agent runtime（Claude Code / Codex / Gemini / Kimi 直接作为 worker） | **Maybe** | 如果它不能加载 pi extension，且必须以 MCP 发现/调用 codeteam tools；这是未来集成，不是 v1 |
| remote worker / 跨主机 worker | **Maybe** | 本地 0600 socket 不可达；MCP over HTTP 或远程 daemon API 是候选；v1 单机不做 |
| 第三方 MCP client / 插件 | **Maybe** | 需要标准 MCP 发现；plugin marketplace 是 P1-defer，不是 v1 |
| cross-provider 模型 | **No** | provider 是 pi 后面的模型；pi 已统一 DeepSeek/Kimi/GLM/Qwen；“跨 provider”不等于“跨 runtime” |
| memory/evidence 的外部读取 | **Maybe** | 如果外部 client 需要工具化读取；v1 内部 memory 走 extension/CLI，不需要 MCP |
| operator 聊天 | **No** | thread message/CLI/Console；不是 MCP |
| 多语言第三方工具 | **Maybe** | MCP 是语言无关适配器；没有真实第三方工具前不建 |

**结论：v1 的真实 consumer 是 0。** “Maybe” 项都需要一个命名的外部
runtime、网络边界或第三方 client；没有这些，MCP 只是为未来的假设付出
现在的复杂度。

W7a 计划里的 “MCP client 能调用 team/memory/workitem tools” 是
**transport acceptance**，不是 consumer evidence。它能证明 adapter 能工作，
但不能证明有人需要它；如果没有外部 consumer，这条 acceptance 应该改成
extension E2E，而不是反过来驱动 MCP server 建设。

### 2.1 模型 provider ≠ agent runtime

这是最容易混淆的一点：

- 用 Claude/Codex/Gemini/Kimi 的**模型**，仍然跑在 pi session 里；工具由 pi
  extension/MCP 注册，provider 只负责推理。这里不需要 codeteam MCP。
- 用 Claude Code/Codex/Gemini CLI/Kimi CLI 的**原生 agent runtime**，才可能
  需要 MCP；因为这些 runtime 不加载 pi extension。但 codeteam v1 的 worker
  是 pi RPC，不是这些原生 runtime。

所以“我们有 Claude/Codex/Gemini/Kimi”本身不构成 MCP 需求；要问的是
“我们是否要把一个非 pi 的原生 agent runtime 作为 codeteam worker 接入”。

## 3. P0 13 工具逐项：extension 可行性

P0 13 来自旧 MCP 报告 §7.1。当前状态：

| # | Tool | Extension 状态 | 实现路径 | MCP-only？ |
|---:|---|---|---|---|
| 1 | `a2a_send` | **done** | F015 extension + `a2a_call` + `A2AToolHandlers.send` | No |
| 2 | `handoff_create` | **done** | F015 extension + `A2AToolHandlers.createHandoff` | No |
| 3 | `handoff_claim` | **done** | F015 extension + `A2AToolHandlers.claimHandoff` | No |
| 4 | `handoff_complete` | **done** | F015 extension + candidate + server resolver | No |
| 5 | `handoff_withdraw` | **done** | F015 extension + `A2AToolHandlers.withdrawHandoff` | No |
| 6 | `thread_list` | feasible | 加 read spec + `read_call` + `ControlReadModels.threadSummaries` + principal scope | No |
| 7 | `thread_context` | feasible | 加 read spec + `read_call` + `ControlReadModels.threadTimeline` + bounded window | No |
| 8 | `message_get` | feasible | 加 read spec + `read_call` + `MessageStore` + thread access check | No |
| 9 | `thread_participants` | feasible | 加 read spec + `read_call` + active sessions/profiles，返回 routableNow 不承诺在线 | No |
| 10 | `task_list` | feasible | 加 read spec + `read_call` + `TaskStore.list` + user/thread scope | No |
| 11 | `wait_arm` | feasible | 加 wait spec + `wait_call` + `WaitContractService.arm`；daemon 生成 waitId/generation | No |
| 12 | `wait_status` | feasible | 加 wait spec + `wait_call` + wait read model | No |
| 13 | `wait_cancel` | feasible | 加 wait spec + `wait_call` + exact owner fence；`user_cancel` 仍 operator-only | No |

**5 已实现，8 个是 extension 增量。** 8 个都不需要新进程、新 transport 或
MCP server；只需要：

- 扩展 `a2a/tool-surface.ts` 为 `tool-surface.ts`（或新增同层模块），把
  read/wait spec 和 A2A spec 放在同一纯模块；
- 扩展 `worker-extension.ts` 的注册循环；
- 在 `WorkerControlServer` 增加 `read_call` / `wait_call`（或统一
  `tool_call`，按 allowlist 分发）；
- 在 daemon 侧复用 `ControlReadModels`、`MessageStore`、`TaskStore`、
  `WaitContractService`；
- 把 read/wait tool 加入 per-role `toolPolicy.allowedTools`；
- 测试与现有 `control-a2a-control` / `control-a2a-worker-e2e` 同层扩展。

### 3.1 auth 差异

| 维度 | extension | MCP (hypothetical) |
|---|---|---|
| credential | per-run token file 0600；每次调用重读 | per-run token file/header；MCP server 也要拿 token |
| principal | control socket `resolveWorkerBinding` → `resolveRunPrincipal` | 同一 daemon handler；若 HTTP 则需 preHandler + header-only |
| worker binding | `workerId` + run/session 绑定 | MCP server 需知道 worker/session；共享 server 时需多路 token/worker 上下文 |
| external client | 不可能（pi-specific） | 需要新 principal（agent-key/operator scope）；codeteam 目前只有 per-run token |
| tool args 身份 | 不接受 `from/role/owner`；handler 白名单拒绝 | 同样不接受；没有优势 |
| typed failure | `ControlError.code` / `ControlRequestError` | HTTP 401 需要 typed reason；这是额外工作 |

**关键：extension 的 auth 不是“更弱”；它复用同一个 per-run token 和 daemon
principal 校验，只是没有 HTTP listener。** MCP 若只服务 codeteam run，也必须
复用 per-run token；若服务外部 client，则需要目前尚未实现的 agent-key/
operator-scoped 外部凭据。后者是 MCP 的真正新增 auth 成本。

### 3.2 read scope / wait 差异

- 读 scope 必须由 daemon 按 `RunPrincipal` 过滤；extension 传的 `threadId`/
  `taskId` 只是选择器，不是授权。MCP 也一样；没有 transport 优势。
- wait 的语义在 `WaitContractService`，不在 tool 名。extension 的 `wait_arm`
  可以立即返回 waitId/generation；daemon 的 queue/wake 继续负责唤醒。
  MCP 只是把同一调用包一层，不能提供更强的 wait。
- `wait_cancel` 的 exact owner fence 是 handler 安全要求，不是 MCP 需求；
  先修它，两个 adapter 都受益。

## 4. P1a 关键项：extension 还是 operator surface

P1a 31 个 Clowder 行里，不是所有都属于“agent 工具面”。先按消费者分：

| P1a 组 | 适合 extension？ | 说明 |
|---|---|---|
| `thread metadata/labels` | yes（read/write） | agent 可读；写需要 owner/role；Console 也可用 |
| `thread propose` | **operator/Console** | 新建/审批 thread 是 operator 决策，不是 agent 自动工具 |
| `task_create/update` | **operator/CLI，或受限 extension** | task 创建/分派是 operator/backlog 责任；agent 主要 `task_list`/`task_get`；不是 MCP 特有 |
| `work_admit/get/update/close/resolve` | yes（role/owner-scoped） | entrusted work 是 agent-facing，但 close 需要 evidence；operator 可 CLI |
| `workflow_get/update` | yes（CAS） | SOP 告示牌是 agent-facing；不是流程控制 |
| `custody_offer/admit_retry` | yes（source-owned） | agent/source 可 offer；admission 仍服务端校验 |
| `approval_request/list` | yes（request/list） | **decide 永远 operator-only，不做 extension/MCP** |
| `active execution/handoff events` | yes（read） | operator/agent 诊断 |
| `schedule_*` | **operator/Console** for register/remove；list/preview 可 read | 注册是 approval-gated；list/preview 可由 extension/CLI 读；不是 MCP 特有 |
| `deployment_wait_register` | yes（task-scoped） | agent 可登记等待；不是 operator 配置 |
| `artifact_put/get/list` | yes | 内容可走 artifact store；大对象不是 MCP 优势 |
| `rich_block_create/rules` | yes（Console projection） | 不是 artifact 真相；Console 也可调用 |
| `memory_*` | yes（read；W6） | evidence search/graph/recent/file slice/session；不改 personal memory |
| `review_request/submit/get/list` | yes（agent review） | exact HEAD/finding；vision guard/close 仍 operator |
| `eval/harness` | **operator/Console/service**（W6）；agent-facing 子集可 extension | eval publish/lifecycle 不是普通 agent 工具；不是 MCP 特有 |
| `github tracking` | **operator/CLI 或 extension**（W8） | register/list 入口可以是 CLI/extension；不是 MCP 特有 |
| `cross-thread A2A` | maybe（extension can call same handler） | 需要独立授权；MCP 不解决授权 |

**规则：** 先按“谁有权限”分，再按“用什么 transport”分。Operator-only 工具
不应该因为 MCP 能注册就暴露给 agent；extension 也不应该注册。MCP 不是
operator 授权层。

## 5. 架构选项

### A. Extension-first（推荐 v1）

```text
pi worker (--extension codeteam-worker-extension, --no-mcp)
  registerTool(P0 13 + selected P1a)
  tool_call → control socket 0600 → daemon handler
```

- 一个 extension、一个 0600 socket、一个 per-run token、一个 handler 层。
- 无额外进程、无 stdio JSON-RPC、无 MCP server 生命周期。
- 工具名是 codeteam canonical（`a2a_send`/`handoff_*`/`thread_*`/`wait_*`）。
- external client 不支持；这是明确边界。

### B. MCP-only

- 所有 worker 都需要 MCP server；pi worker 要移除 `--no-mcp`、配置 MCP server、
  注册 `mcp__codeteam__*`。
- 对 internal pi 是纯增成本；只为外部 client 服务时又需要外部 auth。
- 不推荐作为 v1 主路径。

### C. Sibling adapters（未来条件性）

```text
                 ┌─ pi extension (internal pi workers)
tool-surface ────┤
                 └─ MCP adapter (external clients / remote)
        │
        └─ same daemon control socket + same handlers
```

- 两个 adapter 是 sibling，不是链式：MCP server 不调用 extension tool，
  extension 也不调用 MCP server；两者都调用同一 daemon handler。
- 共用 `tool-surface` specs、per-run token/principal 模型、role allowlist、
  audit/telemetry、错误码。
- **同一个 pi worker 不能同时加载两套同名语义工具**：internal worker 保持
  `--no-mcp`；external client 用 MCP；需要时在 profile 上二选一。
- 如果未来两者同时出现在一个 runtime，必须隐藏/命名空间隔离其中一套，
  并做 parity 测试；不要让模型看到 `a2a_send` 和
  `mcp__codeteam__a2a_send` 两个近似工具。

### 5.1 为什么不要 MCP→extension 链式

- 多一层调用、多一个失败点、多一套 auth/日志；
- 语义会在两层之间漂移（schema、错误、idempotency、allowlist）；
- 不能证明“MCP 是薄 adapter”，反而制造第二套业务层；
- 同一 daemon handler 已经足够薄，没必要让 MCP 调 extension 再调 daemon。

## 6. 成本 / 延时 / 安全 / 维护

| 维度 | Extension (v1) | MCP adapter (hypothetical) |
|---|---|---|
| 额外进程 | 0 | 每 worker/session 1 个（或共享 server + 多路 token，复杂度更高） |
| 传输 hop | pi 进程内 → 0600 socket → daemon（1 个本地 IPC） | pi → stdio JSON-RPC → MCP server → socket/HTTP → daemon（至少 2 个） |
| 启动 | worker 启动时同步注册 | server spawn + initialize + `tools/list`；失败/重连状态 |
| tool 名 | `a2a_send` 等 canonical | `mcp__codeteam__a2a_send`，prompt/skill/旧文本需改 |
| 发现 | pi extension 固定工具集 | 标准 MCP `tools/list`；对外部 client 有价值 |
| auth | per-run token file + socket binding | 同 run token + MCP server token 传递；外部 client 需 agent-key/operator |
| 跨 provider | 否（pi-specific） | 是（runtime-agnostic） |
| 外部 client | 否 | 是（这是唯一实质优势） |
| 运维 | 无额外进程 | 进程监督、健康、日志、版本对齐、配置分发 |
| 观测 | 普通 pi tool call；native 分类 | `mcp__` 分类，需要映射回 codeteam tool |
| 测试 | pi RPC + extension E2E | 加 stdio/MCP protocol、server lifecycle、重连 |
| 安全面 | 较小；daemon 仍是 authority | 多一个进程/入口/token 传递；同 uid 时不是强隔离 |
| 维护 | 一个 adapter + 一份 spec | 两个 adapter + parity 测试 + 共享 spec/包 |
| 延时 | 结构上少一个进程和一个协议 hop | 结构上多一个进程和一个协议 hop；具体 ms 未测，不应编造 |

**延时结论：** 不需要精确 benchmark 就能判断方向：MCP 对 internal pi 必然
多一个进程和一个协议 hop；如果未来要保留 MCP，应该先做 benchmark 证明
外部 client 的收益大于成本，而不是先建 server 再找 consumer。

**安全结论：** MCP 不自动更安全。两者都依赖 daemon 的 per-run token 和
handler；同 uid 的 MCP 进程不是强隔离。MCP 还多一个 token 传递和 server
入口。若未来要隔离，应该 sandbox MCP server/worker，而不是假设 MCP 本身
是边界。

**观测结论：** extension tool 以 canonical 名进入 tool usage；MCP tool 以
`mcp__` 名进入，需要额外映射。对 v1 的 13 个工具，extension 更简单。

## 7. 建议

### 7.1 v1：extension-first，砍掉 W7a MCP

- W7a 不再交付 MCP server；P0 13 由 worker extension 交付。
- 先做 8 个 read/wait extension tool + 通用 `read_call`/`wait_call`，复用
  `ControlReadModels`/`MessageStore`/`TaskStore`/`WaitContractService`。
- W7a 的 Console/CLI/HTTP/WS 继续走 operator credential，不经过 MCP。
- `approval:decide`、`merge:execute` 继续不在 agent tool surface；extension
  也不注册。
- 旧 MCP 报告的 inventory/mapping 保留；把 “MCP server” 改为
  “extension tool surface + conditional MCP adapter”。

### 7.2 如果保留 MCP：最小 slice 与触发条件

**触发条件（必须同时成立）：**

1. 有一个**命名的**外部 consumer（不是“未来可能”）：非 pi 原生 agent
   runtime、远程 worker、或第三方 MCP client。
2. 该 consumer **不能加载 pi extension**（否则用 extension）。
3. 它需要标准 MCP 发现/调用，而不是普通 HTTP/CLI。
4. 外部凭据模型已设计：agent-key / operator-scoped token / 受限 service
   principal；不能直接复用 per-run token（外部 client 没有 run）。
5. 同一 `tool-surface` specs 和 daemon handler 已存在；MCP 只是 sibling
   adapter，不复制业务逻辑。
6. 接受额外进程、stdio hop、运维和双 adapter 测试成本。

**最小 slice：**

- 只做 P0 13（read + A2A/custody + wait）；不做 P1a operator 工具；
- 不做 approval decide、merge、shell、cross-thread admin；
- sibling adapter 复用同一 control socket/handler；
- run token（codeteam run）或外部 agent-key（外部 client）二选一；
- tool 名 codeteam canonical，不默认加 `cat_cafe_*` 别名；
- 同一个 pi worker 不同时加载 extension + MCP；用 profile 二选一；
- 先做 stdio MCP，不做 HTTP/WS MCP，除非远程 consumer 明确要求。

**如果只做 external read-only MCP**，可以更窄：只读 thread/task/evidence，
不暴露 A2A/custody；但这不是 v1 需求。

### 7.3 W7a plan delta（建议，operator signoff 前不直接改任务）

当前 `docs/plans/0004` W7a 有：

- Task 3：MCP server tools + token auth；
- Acceptance：MCP client 能调用 team/memory/workitem tools；
- Deliverable：MCP server；
- Auth matrix：operator / run token (MCP) / webhook HMAC。

建议改为：

- Task 3：**worker extension tool surface（P0 13）+ real RPC E2E**；
  MCP adapter 仅在外部 consumer 触发时做；
- Acceptance：**pi extension tool 能在真实 RPC worker 调 P0 13；
  MCP 不是 v1 验收项**；如果未来启用 MCP，同一 surface 通过 sibling
  adapter 验证；
- Deliverable：**extension tool surface**；MCP adapter 条件性；
- Auth matrix：operator credential / run token（extension；MCP adapter 若启用）/
  webhook HMAC；三域仍互不替代；
- 保留“MCP 工具面不暴露 approval decide / merge execution”作为未来
  adapter 的约束。

这是一个 scope 调整；本报告只提出 delta，不在没有 operator 确认的情况下
改 W7a 任务清单。

### 7.4 Operator decision（一个取舍题）

| 项 | 内容 |
|---|---|
| 建议 | v1 extension-first；从 W7a 移除 MCP server；P0 13 由 worker extension 交付 |
| 价值 | 走已验证的 F015 路径；少一个进程/协议 hop；少一套 auth/运维/测试；不会出现双工具面 |
| 代价 | v1 不支持外部 MCP client；未来外部 runtime 需要时再做 conditional sibling adapter |
| 可逆性 | 高：`tool-surface`/handler/control socket 保留；未来加 MCP adapter 是加法，不重写业务 |
| 不接受的替代 | 若 operator 要求保留 MCP：只做 P0 13、sibling adapter、外部 consumer 触发；不扩到 P1a 全量 |
| 需要 operator 确认 | 是否把 W7a task 3 + MCP acceptance 改为 extension tool surface；未确认前 plan 只留 proposed note |

## 8. 风险与未决问题

| 风险/问题 | 处置 |
|---|---|
| 未来外部 runtime 需要 MCP，但没提前做 | 保留 `tool-surface`/handler seam；触发时做 sibling adapter，不重写业务逻辑 |
| extension API 与 pi 版本耦合 | pi 已 pin；extension 是仓库内代码；按 W0a 规则升级 |
| 同一 worker 同时加载 extension + MCP 导致重复工具 | internal worker 保持 `--no-mcp`；profile 二选一；parity/negative test |
| 外部 client 没有 run token | 需要 agent-key/operator-scoped 外部凭据；这是 MCP 前置，不是 extension 问题 |
| read/wait 工具把 scope 写错 | daemon 按 principal 过滤；MCP 也一样；测试矩阵覆盖跨 thread/task |
| wait_cancel owner fence 未修 | extension 先修；两个 adapter 共用 |
| 大 artifact 通过 extension/MCP 传输 | 走 artifact store/path/hash，不走 tool JSON 大 payload；不是 MCP 优势 |
| 工具列表 token 成本 | 13 个 P0 可控；P1a 按 role/profile 注册/隐藏；MCP 的 `mcp__` 前缀反而增加文本 |
| “MCP 更标准”被当成目标 | 标准只有在有外部 consumer 时才是价值；v1 以结果/延迟/运维为准 |

## 9. 证据索引

| 主题 | 位置 |
|---|---|
| F015 plan（D4/D6、residual） | `docs/plans/0017-a2a-e2e-foundation.md` |
| F015 report（真实 E2E） | `docs/reports/2026-10-30-a2a-e2e-foundation.md` |
| 旧 MCP inventory/mapping/auth | `docs/reports/2026-10-29-clowder-mcp-architecture-and-w7a-tool-surface.md` |
| 旧 readiness 的 MCP 方案 B（不推荐第一步） | `docs/reports/2026-10-29-a2a-e2e-readiness.md` §8.2 |
| worker extension 5 tools | `packages/codeteam-daemon/src/workers/worker-extension.ts` |
| 纯 tool specs | `packages/codeteam-daemon/src/a2a/tool-surface.ts` |
| control socket `a2a_call` | `packages/codeteam-daemon/src/workers/control.ts` |
| `--no-mcp` / `--tools` | `packages/codeteam-daemon/src/workers/harness.ts` |
| a2a_send requestId | `packages/codeteam-daemon/src/a2a/requests.ts`、`a2a/tools.ts` |
| pi MCP tools as extension tools | `packages/coding-agent/src/extensions/mcp/index.ts` |
| pi registerTool/ToolDefinition | `packages/coding-agent/src/core/extensions/types.ts` |
| pi integration guidance | `docs/architecture/0002-pi-runtime-integration.md` §5.1/§5.2/§8.2 |
| W7a plan | `docs/plans/0004-w5-w8-scale-product.md` §W7a |

## 10. 一句话

**对 codeteam v1，MCP 不是能力，而是外部适配器；内部 pi worker 已经有
extension tool。先把 P0 13 做成 extension，砍掉 W7a MCP server；等出现
一个命名的、不能加载 pi extension 的外部 consumer，再用同一套 tool spec
和 daemon handler 做 sibling MCP adapter。**
