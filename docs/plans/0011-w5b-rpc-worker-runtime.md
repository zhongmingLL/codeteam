---
title: "W5b RPC Worker Runtime 实施计划"
doc_kind: plan
status: active
created: 2026-10-28
updated: 2026-10-28
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash)]
source: "docs/plans/0004-w5-w8-scale-product.md §W5"
---

# W5b RPC Worker Runtime 实施计划

> 本计划把 `0004` §W5 的 RPC worker、worker registry、sticky routing、
> re-attach、失败重试与测试项落成可实施的 W5b 切片。W5 契约与总验收仍以
> `0004` 为单一真相源；W5a 已冻结的 dispatch 投影以 `0010` 为准。本文件只写
> W5b 的落点、冻结投影、依赖、顺序与验证映射。
>
> **不在本切片**：task readiness/DAG、预算、worktree pool/GC、F139、
> daemon lifecycle、deployment wait、PR tracking/managed-work（W5c）；HTTP/MCP
> transport（W7a）；第二 queue/message store/worker registry。任何实现遇到
> 契约冲突时回 `0004` / `0010` / F001，不在代码里另造语义。

## 目标与可见结果

W5b 完成后，W5a 的 fake `AgentExecutor` 可被真实 pi RPC executor 替换，且
dispatch 投影语义不变：

- 每个 `agentSessionId` 有一个长期 RPC worker（`pi --mode rpc`）；同一
  session 的后续 run 复用同一 worker，不漂移。
- 每次 run 铸造独立 per-run token，落在 0600 文件；worker extension 在每个
  tool call 时按当前 token 向控制面查询策略。控制面不可用时，非只读工具
  fail-closed，只读工具按本地 allowlist 继续。
- worker 心跳/lease 可观测；stale worker 的 running runs → `interrupted`，
  session → `re_attach_pending`，旧 worker 不再接受 sticky 分配。
- daemon/worker 崩溃后，下一次 run 优先用 pi session 文件重挂；文件不可用
  时显式 fresh session + task capsule，并记录 `session_reattach_failed`。
- 可重试 worker 失败生成新的 Queue Entry（不建第二队列）；超过预算
  dead-letter + human escalation；run 本身仍只有一个 terminal 与一个 response
  bubble。
- 真实 pi RPC 进程跑通 implement→review（mock provider 仍走真实 pi kernel、
  tool 执行、extension 策略与 dispatch 链）；另提供 env-gated live provider
  smoke，不把 mock 结果冒充线上模型质量。

## 冻结决定

### D1. RPC worker = 一个 agentSession 的长期 pi 进程

- pi RPC 是一个进程一个 session（`0002` §11），因此 `kind='rpc'` 的
  `capacity` 固定为 1。`capacity` 是 registry 的硬约束，不是 pool 大小。
- `workerId ↔ agentSessionId` 是一对一绑定：同一 session 的多次 run 复用同一
  worker 进程，按 run 串行 prompt；不同 session 必须使用不同 worker。
- “同 worker 多 run”指同一 session 的连续 run；每 run 重新铸造 token、
  重写 worker token 文件、terminal 后撤销/删除。
- W5c 才引入 worktree pool、预算和跨 session 的 worker 池；W5b 不预建。

### D2. 控制面通道是 daemon 内部 Unix socket，不是 W7a transport

- `WorkerControlServer` 监听 `<dataDir>/wc.sock`（目录 0700、socket 0600），
  处理 worker `heartbeat` 与 per-run `tool_policy` 查询。
- worker extension 通过 `CODETEAM_CONTROL_SOCKET`、`CODETEAM_WORKER_ID`、
  `CODETEAM_TOKEN_FILE` 找到控制面；token 内容不入 env、不入 prompt、不入
  stdout。
- 该 socket 只服务本机 worker 控制面；W7a 再把同一 policy service 暴露成
  HTTP/MCP，不改变契约。

### D3. token 注入与生命周期

- 每个 run 用 F005a `mintInvocationCredential` 铸造；per-run token 文件
  `<dataDir>/tokens/<runId>.token` 保持 0600。
- worker extension 读取 `<dataDir>/worker-runs/<workerId>/token`；daemon 在
  prompt 前原子重写该文件，run terminal 后删除。该文件只是当前 run 的 0600
  副本，不是第二 token registry。
- run terminal/interrupted 时撤销 active credential；token 文件删除。任何恢复
  都必须铸造新 token，不复用旧凭据。

### D4. sticky 与 re-attach

- `agent_sessions.worker_id` + `worker_binding_state` 是 sticky 的 durable 投影。
- 正常调度只选择同一 worker；worker 为 `stale/retired` 或绑定状态为
  `re_attach_pending` 时，先走显式 re-attach，不把后续 run 路由到死 worker。
- re-attach 优先使用 `agent_sessions.native_session_binding_json.sessionFile`
  指向的 pi session 文件（本地 export/import 等价物）；文件缺失或启动失败才
  fresh session + task capsule。
- fresh 降级必须写 audit `session_reattach_failed`，并在新 run 的
  `run_events` 留 `session_reattach_failed` 证据；response 正文明确标注
  “continuity degraded”，不静默失忆。

### D5. 失败重试 = 新 Queue Entry，不是同一 run 内重跑

- 一个 Run 只有一个 terminal；可重试失败先收口当前 run，再从 system status
  message 生成新的 Queue Entry（`sourceCategory='worker_retry'`），attempt+1。
- 不建第二队列、不建 retry 表；幂等靠 audit `run_retry_queued` /
  `run_dead_lettered` 的 `run:<id>` subject。
- 默认 `maxAttempts=3`；超过后 dead-letter：audit + 可见 system message +
  `inbox(kind='humanGuidance')`，不自动再排。
- `canceled` 不重试；`completed` 不重试；`interrupted` 只由 worker/liveness
  recovery 产生，按可重试处理。未知 executor 异常默认不重试（fail closed）。

### D6. L0 / prompt 边界

- W5b 的 worker prompt 由 daemon 构造：task 标题/why、source message、role
  delivery contract、可用工具边界、response 要求；fresh re-attach 追加
  continuity capsule。
- 静态 role governance 通过 `--append-system-prompt` 注入；动态 task 内容放
  user prompt，避免把时间/随机数写进 system prompt。
- 不加载项目 `.pi` extension/skill/prompt discovery（`--no-extensions` 显式
  装配、`--no-skills`、`--no-context-files`）；W6/W7 再扩展 curated skills。

## 冻结投影

### 1. Worker registry

`workers`（migration 012）：

| 字段 | 语义 |
|---|---|
| `id` | `workerId`；session 绑定后不复用；retire 后保留审计 |
| `kind` | v1 固定 `rpc` |
| `role` | 创建时固定；必须命中 `roles.id` |
| `capacity` | RPC 恒为 1；`activeRuns <= capacity` |
| `state` | `starting → online → draining → retired`；`starting/online/draining → stale → retired`；`stale` 不可回 `online` |
| `pid` | 当前 pi 子进程 PID，仅用于诊断/安全回收 |
| `heartbeat_at` / `lease_expires_at` | 实际心跳与 lease；默认心跳 10s、lease 30s，注册时写 audit |
| `drain_requested_at` / `retired_at` / `last_error` | lifecycle 审计 |

投影 `WorkerCapacitySnapshot`（派生，不落第二张表）：

```ts
interface WorkerCapacitySnapshot {
  workerId: string;
  role: string;
  state: WorkerState;
  capacity: number;
  activeRuns: number;
  activeSessions: number;
  boundSessions: number;
  availableSlots: number;
  availableRunSlots: number;
  heartbeatAt: number;
  leaseExpiresAt: number;
  activeRunIds: string[];
  activeSessionIds: string[];
}
```

不变量：

- `activeRuns` = `runs.worker_id = workerId AND runs.status='running'`。
- `activeSessions` = 有 active run 的去重 session 数；`boundSessions` = 绑定到
  该 worker 且未 sealed 的 session 数。
- `availableSlots = max(0, capacity - boundSessions)`（session 准入）；
  `availableRunSlots = max(0, capacity - activeRuns)`（run 并发投影）。
  RPC 两者都不超过 1。
- 选择 worker 时先看 liveness/state，再看 capacity；dead worker 永不入选。
- 每次 heartbeat 只延长 lease；`stale/retired` 的 heartbeat 返回
  `invalid_state`，不能“复活”死 worker。

### 2. Session/run 绑定

- `agent_sessions.worker_id`：最近绑定的 worker；`stale` 时保留作审计，但不再
  参与 sticky 选择。
- `agent_sessions.worker_binding_state ∈ unbound|attached|re_attach_pending`。
- `agent_sessions.worker_attached_at`：最近一次成功绑定/重挂时间。
- `runs.worker_id`：run 启动时写入，之后不可变；retry 是新 run，写新 worker。
- `agent_sessions.pi_session_id` + `native_session_binding_json`
  （`{ sessionFile, piSessionId, workerId, degradedReason? }`）是 re-attach 锚。

### 3. RPC executor 契约

`RpcAgentExecutor implements AgentExecutor`，不改变 `DispatchExecutionRequest`
与 `AgentExecutionResult`；只新增：

- 可选 `InterruptedExecutionError`（`code` + `reason`）：已知 worker/liveness
  丢失，由 `DispatchService` 收口为 `interrupted`，不是普通 `failed`。
- 可选 `RetryableExecutionError`（`code`）：worker 启动/协议/超时等瞬时失败，
  由 failure policy 决定是否重排。

执行顺序：

1. 校验 run 仍 running、session/profile/task 一致。
2. `ensureWorkerForSession`：复用 live worker，或 re-attach/fresh，更新绑定。
3. 铸造 per-run token，写 worker token 文件（0600）。
4. 发送 RPC prompt，JSONL 严格分帧；事件回流 `run_events`（有界投影）。
5. 收到 `agent_settled` 后取最终 assistant text/usage/toolCalls。
6. 清 token 文件、撤销 credential；返回 `AgentExecutionResult`。
7. AbortSignal → RPC `abort`；worker 崩溃 → `InterruptedExecutionError`；
   协议/启动失败 → `RetryableExecutionError`；配置/输入错误 → 普通失败。

`run_events` 回流只存有界投影：assistant text 截断 16KiB；tool start/end 存
`toolName/toolCallId/isError/durationMs`；不存 raw tool input/output 与 provider
secret。final body 仍只写 response bubble。

### 4. Retry/dead-letter 投影

- retry：system status message（同 task/thread）+ 新 queue entry
  `sourceCategory='worker_retry'`，`authorIntent.chainMetadata.attempt=attempt+1`。
- `DispatchRoute` 新增 `attempt`，cutover 写入 `runs.attempt`；不改变
  one-terminal/response-bubble。
- dead-letter：audit `run_dead_lettered` + system status message +
  `inbox(kind='humanGuidance', payload={kind:'dead_letter',...})`。
- `run_retry_queued`/`run_dead_lettered` 以 `run:<id>` 幂等；重复 recovery
  不重复排。

## 实施切片

### W5b-1 Worker registry / migration 012

| 单元 | 落点 | 可观察结果 | 验证 |
|---|---|---|---|
| 012 additive schema | `control/migrations/012-worker-runtime.ts` | workers + session/run binding 字段；旧库升级不丢数据 | migration matrix |
| `WorkerStore` | `control/stores/workers.ts` | register/heartbeat/drain/stale/retire、session bind、capacity snapshot | store tests |
| `WorkerRegistry` | `workers/registry.ts` | live-only 选择、capacity 拒绝、stale 不复活、session re_attach_pending | registry tests |
| attempt cutover | `dispatch/types.ts` + `control/store.ts` | retry run 的 `attempt` 持久化 | dispatch regression |

### W5b-2 RPC client / harness / extension

| 单元 | 落点 | 可观察结果 | 验证 |
|---|---|---|---|
| strict JSONL client | `workers/rpc-client.ts` | LF-only 分帧、max frame、backpressure、pending 请求、exit 收敛 | unit/fixture |
| worker spawn | `workers/harness.ts` | `pi --mode rpc` 参数装配、0600 token 文件、session file、优雅关停 | fixture + real pi |
| worker extension | `workers/worker-extension.ts` | heartbeat、tool_call policy、控制面不可用 fail-closed | real pi + socket tests |
| event reflow | `workers/event-sink.ts` | 有界 run_events、tool/message/settled/error 投影 | fixture tests |

### W5b-3 Control plane policy

| 单元 | 落点 | 可观察结果 | 验证 |
|---|---|---|---|
| socket server | `workers/control.ts` | heartbeat/policy 请求认证、0600 socket、断开不影响只读 | socket tests |
| role policy | `workers/tool-policy.ts` | coder/reviewer/verifier 工具矩阵；path/command 复用 W2 policy | policy matrix |
| token binding | 同上 | token→run/session/worker 不一致拒绝；跨 run 冒用拒绝 | negative tests |

### W5b-4 RpcAgentExecutor

| 单元 | 落点 | 可观察结果 | 验证 |
|---|---|---|---|
| placement | `workers/executor.ts` | sticky 复用、re-attach/fresh、capacity/session 串行 | executor tests |
| prompt/token | 同上 | task capsule、per-run token、terminal 撤销/删除 | token isolation |
| terminal mapping | `workers/executor.ts` + `dispatch/service.ts` | worker crash → interrupted；可重试错误 → retry | dispatch tests |
| one terminal regression | 现有 dispatch suite | response bubble/terminal/dispatchRefs 不变 | full dispatch tests |

### W5b-5 Failure policy / recovery

| 单元 | 落点 | 可观察结果 | 验证 |
|---|---|---|---|
| retry/dead-letter | `workers/failure-policy.ts` | 新 Queue Entry、attempt+1、幂等、human escalation | failure tests |
| stale sweep | `workers/runtime.ts` | stale worker runs interrupted、session re_attach_pending、无死 sticky | crash tests |
| daemon restart | 同上 + `control/recovery.ts` | 启动 sweep + retry；旧 worker 不复活 | restart tests |
| graceful drain | `workers/runtime.ts` | 停止接新 run、active run 完成后退役、超 lease 强制退役 | drain tests |

### W5b-6 End-to-end / docs / review

| 单元 | 落点 | 可观察结果 | 验证 |
|---|---|---|---|
| real pi implement→review | `test/control-worker-e2e.test.ts` | 真实 pi RPC + mock provider 写文件、review 读上下文、one-terminal | E2E |
| worker crash/re-attach | 同上 | session file 重挂；文件缺失 fresh+capsule + `session_reattach_failed` | E2E |
| control-plane down | 同上 | write 被 block；read 继续 | E2E |
| live smoke | `test/control-worker-live.e2e.test.ts` | env-gated 真实 provider 回复；不默认跑 | skipped/manual |
| docs/close | `0011` + `F009` + report | AC 证据、边界、residual ledger | review |

## AC 映射（`0004` §W5，仅 W5b 适用项）

| # | Acceptance | W5b 落点 | 验证 / 边界 |
|---|---|---|---|
| 1 | RPC worker harness 跑通真实 task implement→review 全链路 | W5b-2/4/6 | 真实 pi 进程 + mock provider；不冒充 live 模型质量 |
| 2 | daemon crash 与 worker crash 都能恢复/降级，不产生死 sticky | W5b-5/6 | restart/crash E2E + registry 断言 |
| 3 | control plane 不可用时非只读工具 fail-closed，只读按 allowlist 继续 | W5b-2/3/6 | socket down E2E + extension unit |
| 4 | stale worker 的 claimed runs 变 interrupted，session 标 re_attach_pending，不被再次 sticky | W5b-1/5 | stale sweep tests |
| 5 | 同 worker 多 run 拿到各自 token/policy | W5b-2/4 | 连续两 prompt 的 token hash 不同；旧 token 撤销 |
| 6 | 同一 agentSession 常规调度不漂到另一个 worker；显式迁移记录证据 | W5b-1/4 | sticky + migrate tests |
| 7 | crash 后 active task 恢复，含 re-attach 或显式 fresh+capsule | W5b-4/5/6 | session file 重挂与 fresh 降级 |
| 8 | re-attach 失败记录 `session_reattach_failed`，不静默失忆 | W5b-4/6 | audit + run_event + response 标注 |
| 9 | worker 心跳/lease 实际值可审计，优雅 drain 可退役 | W5b-1/5 | audit `worker_registered` / drain tests |
| 10 | 失败重试/dead-letter/human escalation 可用且幂等 | W5b-5 | failure matrix |
| 11 | 只有一个 pending-wake Queue Entry 账本；retry 不建第二队列 | W5b-5 | queue store 计数 + retry tests |
| 12 | W5a one terminal / response bubble / dispatchRefs 语义保留 | W5b-4 | 全量 W5a dispatch regression |

不在 W5b 的 `0004` 验收：task readiness/DAG、预算、worktree pool/GC、F139、
daemon lifecycle、deployment wait、PR tracking/managed-work（W5c）；HTTP/MCP
transport（W7a）。本 slice 的 passing tests 不能冒充这些项。

## 测试清单

新增/扩展：

- `control-worker-registry.test.ts`：register/heartbeat/lease、capacity、
  stale 不复活、session binding、projection、migration 012。
- `control-worker-control.test.ts`：Unix socket 0600、heartbeat、token→run
  binding、tool policy 矩阵、控制面 down。
- `control-worker-rpc.test.ts`：JSONL 分帧/max frame/exit/abort、fixture
  worker 事件回流、token 隔离。
- `control-worker-executor.test.ts`：sticky、re-attach/fresh、crash→interrupted、
  retry/dead-letter、one-terminal。
- `control-worker-e2e.test.ts`：真实 pi RPC + mock provider implement→review、
  write 允许/控制面 down 拒绝、session 重挂。
- `control-worker-live.e2e.test.ts`：env-gated live provider smoke（默认 skip）。

定向命令：

```bash
NODE_ENV=development npm --prefix packages/codeteam-daemon test -- control-worker
NODE_ENV=development npx tsc --noEmit -p tsconfig.json
NODE_ENV=development npx biome check packages/codeteam-daemon
NODE_ENV=development npm run build:offline
```

全量：`NODE_ENV=development npm --prefix packages/codeteam-daemon test`。

## 依赖与顺序

1. W5b-1 先落 migration/store/registry；executor 与 recovery 都依赖绑定投影。
2. W5b-2 先做 strict JSONL client 与 fixture worker，再上真实 pi RPC。
3. W5b-3 控制面与 extension 一起做；否则 policy 只能靠 prompt。
4. W5b-4 替换 executor，并用 W5a dispatch suite 锁 one-terminal 不回归。
5. W5b-5 接 retry/dead-letter/recovery；必须在 executor crash 路径可观测之后。
6. W5b-6 真实 pi E2E 与 live smoke；最后跑全量、build、Biome。
7. 完成后先做非作者 review：烁烁 A2A/session/worker，砚砚 code/security；
   feature close 的愿景守护另找非作者非 reviewer。

## 风险与回滚

| 风险 | 路 | 处置 |
|---|---|---|
| RPC 进程泄漏/孤儿 | P1 |  graceful stop + SIGKILL 超时；daemon 重启只杀可验证 PID；unverified 留 audit |
| token 跨 run 冒用 | P1 | 每 run 重写 token 文件、terminal 撤销、旧 token 负例；token 不入 env/prompt |
| dead sticky 活锁 | P1 | liveness 先于 capacity；stale 不复活；session re_attach_pending 阻断旧 worker |
| re-attach 静默失忆 | P1 | session file 优先；失败 fresh+capsule + audit/run_event/response 标注 |
| retry 风暴/重复 | P1 | maxAttempts 3；audit 幂等；只对白名单错误重试 |
| dispatch one-terminal 回归 | P1 | W5a 全量 dispatch suite；settle 抽取保持行为 |
| 控制面扩展成第二 transport | P2 | 只做本机 Unix socket；W7a 再接 HTTP/MCP |
| mock provider 冒充真实质量 | P2 | 明确 deterministic E2E 边界；live smoke 单独 env-gated |

回滚：migration 012 是 additive（新表 + 可空列）；代码新增 `workers/` 模块与
可选 executor 注入，回滚到 `c30f9aafb` 即可。若已写入 dev DB，回滚需重建 dev
DB（无生产数据）。

## Current progress（2026-10-28）

- W5b kickoff；本计划与 F009 建立；D1–D6、worker registry/capacity 投影与
  RPC executor 契约冻结。
- **W5b-1**：migration 012（workers + session/run binding）、`WorkerStore`、
  `WorkerRegistry`（capacity/liveness/stale 不复活/session re_attach_pending）、
  attempt cutover 落。
- **W5b-2**：strict JSONL `RpcConnection`（split frame / U+2028 / invalid JSON /
  oversized frame）、`WorkerHarness`（pi 参数装配、0600 token、session file、
  优雅关停/强制 drain）、`worker-extension.ts`（heartbeat + tool_call policy）。
- **W5b-3**：Unix socket `WorkerControlServer`（0600 socket、heartbeat、
  token→run/session/worker 绑定、coder/reviewer 工具矩阵、控制面 down）。
- **W5b-4**：`RpcAgentExecutor` 替换 fake executor；sticky、re-attach/fresh、
  per-run token、event reflow、model error、one-terminal 回归均覆盖。
- **W5b-5**：retry/dead-letter/human escalation、stale sweep、daemon recovery、
  graceful drain + drain timeout；retry 仍走唯一 `queue_entries`。
- **W5b-6**：真实 pi RPC + mock provider 跑通 implement→review、
  control-plane down（write deny / read continue）、真实 session 重挂。
- Review follow-up（2026-10-28）：烁烁 P2-1（lease 过期的 online worker 仍被
  sticky 复用）已修为 `resolveSessionWorker` 同时检查 lease 新鲜度；P2-2
  （fresh 降级只在 prompt 内可见）已修为 response 正文确定性前缀
  `> Continuity degraded: ...`。P3 顺手收：interrupted bubble 措辞按真实
  terminal status、删除未使用的 `freshSessionCapsule`、executor 增加
  run/session/profile/task 一致性交叉校验。
- Review follow-up #2（2026-10-28，砚砚）：P2-3 修复 `consumeStdout` 残留帧
  max-frame 检查不可达（`return`→`break`），新增无换行超限负例；P3 收口
  heartbeat 冗余分支、`model_error` 有界重试白名单、`read` 缺 path
  fail-closed（`grep`/`find`/`ls` 可省略 path 并默认 worktree cwd）。
- 验证（2026-10-28）：daemon 包全量 40 files passed + 2 skipped，
  316 tests passed + 2 skipped；daemon scoped `tsc --noEmit`、`build:offline`、
  Biome 通过。W5b 定向 5 files + 1 skipped，25 tests + 1 skipped。
  根级 `tsc --noEmit` 在本机最终复跑被宿主内存终止（exit 137，swap 已满，
  与 F005a 记录同类环境限制）；daemon 包 build 与 scoped tsc 覆盖本切片改动。
- **未通过的环境项**：env-gated live provider smoke 在本机返回
  `401 Missing Authentication header`（OpenRouter key），不是 RPC harness 失败；
  deterministic real-pi mock-provider E2E 已覆盖真实进程/工具/extension 链。
- 证据报告：[`2026-10-28-w5b-rpc-worker-runtime.md`](../reports/2026-10-28-w5b-rpc-worker-runtime.md)。

## Residual ledger

| # | 项 | 去向 |
|---|---|---|
| 1 | daemon crash 后 OS 级孤儿 pi 进程：stale 检测不复用、token 文件清理已做；进程级强制回收交外部 supervisor | W5c daemon lifecycle / 运维 supervisor |
| 1b | 稳态周期 sweep 仍未接线：lease 过期 worker 在 `resolveSessionWorker` 即被视作 reattach，不会死 sticky；hung in-flight run 由 prompt timeout + retry/dead-letter 兜底 | W5c daemon lifecycle |
| 2 | Unix control socket 的同一 OS uid 信任边界；heartbeat 无独立 worker secret | W7a transport + 后续 worker auth |
| 3 | RPC worker capacity 固定 1；跨 session 池/并发预算未做 | W5c scheduling/budget |
| 4 | `--tools` 是 role 级启动白名单，per-run 仍靠 tool_call 查询；工具集动态收缩未做 | W7a per-run policy transport |
| 5 | live provider smoke 受本机 key 401 阻塞；默认 skip，CI 不依赖 | 环境恢复后手动复跑 |
| 6 | 超长 dataDir 时 control socket fallback 到 `/tmp` 可预测名；0600 + fail-closed 已验证 | W7a transport 硬化 |
| 7 | `RpcConnection.start()` 固定 50ms 启动探测；更慢启动崩溃由后续 `getState` 捕获 | 必要时改 readiness handshake |
| 8 | `event-sink` 16KiB 截断按 UTF-16 code unit，边界可能切断代理对 | 后续硬化，不影响控制面安全 |

