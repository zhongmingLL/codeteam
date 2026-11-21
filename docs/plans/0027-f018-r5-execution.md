---
title: "F018 — R5 execution plan (A2A cutover / CLI-daemon / F018 close)"
doc_kind: plan
status: in-progress
created: 2026-11-21
updated: 2026-11-21
owner: "宪宪 (DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash), 烁烁 (Kimi K3, standby)]
feature: F018
source_plan: "docs/plans/0020-f018-thread-first-runtime.md#r5--cutover-与清理"
source_closeout: "docs/reports/2026-11-21-f018-r4-closeout.md"
---

# F018 — R5 execution plan（A2A cutover / CLI-daemon / F018 close）

> 契约源是 `0020 §R5`、`0005 §4/§5`、`0007 §3.7/§3.10` 与
> `docs/reports/2026-11-21-f018-r4-closeout.md` 的 R5 移交表。
> R1–R4 已交付 schema/stores/runtime/service；R5 只做 cutover 与收口，不新增 A2A 能力。

## 0. 结论先行

R5 分四片，按真实依赖顺序：

1. **R5-a v1 tool bridge**：让真实 pi worker 拿到四个 v1 工具，并能通过
   credential-scoped control socket 调 daemon service。
2. **R5-b daemon 主循环**：生产 daemon 组装 `buildA2ARuntime` + control server +
   drain/startup/reaper/multi_mention recovery，替换 legacy control plane。
3. **R5-c CLI cutover**：`thread list/show/post/tail` 走 F018 stores；task-less
   queue entry 走 v1 dispatch；legacy code delivery 命令冻结/标明。
4. **R5-d 归档与 F018 close**：legacy 只读归档、preflight 清单、E1-E22 最终证据、
   愿景守护 + operator 签字。

R5-a 是关键路径：没有它，生产 worker 仍然只会看到 retired send/handoff 工具。

## 1. 切片

### R5-a v1 tool bridge（本片）

- `domains/a2a/tool-surface.ts`：四个 model-facing 工具 spec
  （`superagentteam_post_message` / `cross_post_message` / `multi_mention` /
  `thread_context`），只含 canonical 名称。
- `domains/a2a/control.ts`：本地 JSON-lines control socket server。
  - `heartbeat`：worker lease 续约。
  - `a2a_call`：token → `InvocationCredentialStore.verifyToken` → worker binding
    → running TurnExecution；构造 `A2AToolContext` 后分发四个 service。
  - 认证负例：错误 token、worker/session 不匹配、terminal/canceled turn 拒绝。
- `workers/a2a-extension.ts`：v1 pi extension。只注册四个 canonical 工具；
  `piExtToolCallId` 由 `toolName + toolCallId` 派生；从 env 读取 control socket
  + credential token；heartbeat 保持 worker lease。
- token 传递：QueueProcessor Phase B 的 `credentials.create` 返回值 → `PreparedDispatch`
  → `WorkerPool.ensure` → `PiWorkerSpawnPort` 的 `SUPERAGENTTEAM_CONTROL_TOKEN` env。
  token 只存在内存/子进程 env，不写 TurnExecution/InvocationRecord/UI 读取面。
- 测试：control server 四工具分发 + auth 负例；mock pi extension 执行工具；
  真实 spawn argv/env 契约包含 control socket/token。
- 出口：真实或 mock worker 能调用四工具；retired send/handoff 工具不注册；
  R2–R4 runtime 行为不回归。

### R5-b daemon 主循环

- 新增 A2A daemon control plane：`buildA2ARuntime` + `A2AControlServer` +
  `PiWorkerSpawnPort` + queue drain timer + startup reconciler + single reaper +
  multi_mention recovery + observability 事件接线。
- 本片以 `startDaemon({ a2aControlPlane })` opt-in 交付；默认入口与 CLI 一起在
  R5-c 切换。legacy `DaemonControlPlane` 保留 frozen/legacy。
- 出口：daemon 启动/停止/重启恢复；真实 provider 或确定性 worker E2E；
  不读 legacy task/custody 表。

### R5-c CLI cutover

- `thread list/show/post/tail` 使用 F018 stores（thread/message/read state/queue），
  不再依赖 task/profile session 绑定。
- `thread post --to` 走 `OperatorMessageIngress`（task-less admission）；
  event stream/read model 用 v1 message lifecycle。
- legacy `task/backlog/review/merge/sop/...` 命令冻结：保留只读/历史路径，
  明确标记 code delivery legacy，不进入 A2A runtime。
- 出口：operator 从 CLI 完成 thread post → queue → worker → response 的真实闭环。

### R5-d 归档与 F018 close

- legacy code delivery 只读归档；`messages.kind` / legacy 列的 drop 只在
  operator 明确授权 + 回滚快照下执行（R5 不默认做破坏性 drop）。
- R1 preflight 清单收口：无法回填 projectPath/owner 的 legacy thread 明确列出。
- E1-E22 最终验收证据（按 `0005 §5`）；F018 close 前做独立愿景守护 + operator 签字。
- 出口：A2A runtime 单一真相；legacy 不再写；F018 close 记录。

## 2. 关键决策

- **control channel**：本地 unix socket + JSON-lines；不引入 Redis/网络端口。
  Windows 走 named pipe（与 legacy `defaultSocketPath` 相同的平台分支）。
- **auth**：token 是 child TurnExecution capability；server 侧同时校验
  credential active、worker binding、turn running。A2A tool allowlist 由
  credential `allowedTools` 再校验一次。
- **tool names**：只注册 `superagentteam_*` 四个 canonical 名称；不接受
  `codeteam_*` alias，不注册 retired send/handoff 家族。
- **token 传递**：Phase B mint 后只走内存 → spawn env；不写入任何读取面。
  进程重启后的新 attempt 重新 mint，不复用旧 token。
- **CLI/daemon 双库**：R5-c 明确 F018 `f018.db` 是 A2A runtime 真相源；
  legacy `control.db` 只读归档。不会把两套 store 混写。

## 3. 明确不做

- 不新增 A2A 能力（不改四工具语义、不恢复 custody/code delivery）。
- 不在 R5 做 Hub ingress/WS/SSE/replay（W7a）。
- 不做无授权的 legacy 表/列删除；drop 需 operator 授权 + 回滚快照。
- 不把 `settleAgentTurn`/task-scoped auth 等 legacy 控制面重新引入。

## 4. 每片出口与 review

- `build:offline` 通过；受影响测试先红后绿；全量 daemon 测试在 PR 前跑。
- `check-legacy-boundary` + `check-doc-index` + `check-ts-relative-imports` +
  `git diff --check` 通过。
- 非作者 review 覆盖 exact HEAD：R5-a/R5-b 砚砚；R5-c 视风险加墨墨/烁烁；
  R5-d 愿景守护 + operator。
- R5-a 不改 daemon/CLI 生产入口，只交付 bridge + 测试；R5-b 才切换默认路径。

## 5. R5-a 交付记录（merged）

- PR #119 → merge commit `e34837706`。

- `domains/a2a/tool-surface.ts`：四个 canonical tool spec。
- `domains/a2a/control.ts`：credential-scoped JSON-lines control server；
  `heartbeat` + `a2a_call`；token → credential → worker binding → running turn
  → allowedTools 四层校验。
- `workers/a2a-extension.ts`：v1 pi extension；只注册四工具；`piExtToolCallId`
  由 `toolName + toolCallId` 派生；从 `SUPERAGENTTEAM_CONTROL_SOCKET` /
  `SUPERAGENTTEAM_CONTROL_TOKEN` / `SUPERAGENTTEAM_WORKER_ID` 读取控制面坐标。
- token 传递：QueueProcessor Phase B 的 minted token → `PreparedDispatch` →
  `WorkerPool.ensure` → `PiWorkerSpawnPort` env。WorkerPool 不跨 token 复用
  旧 worker（stale capability 会先 retire 再 spawn）。
- 测试：`f018-r5-a-tool-bridge.test.ts`（四工具分发 + auth 负例 + extension）；
  `f018-r3-real-spawn.test.ts`（control socket/token env 契约）；
  `f018-r2b-worker-stream.test.ts`（token rotation 不复用）。
- 本片不改 `startDaemon` / `DaemonControlPlane`；生产默认路径切换在 R5-b opt-in 之后由 R5-c 落。

## 6. R5-b 交付记录（in-review）

- `daemon-a2a.ts`：`A2ADaemonControlPlane` 组装 `buildA2ARuntime` + control server
  + `PiWorkerSpawnPort`（v1 `a2a-extension`）+ startup recovery + drain/reaper loop；
  `ready()` 暴露 pending/lastDrain/lastSweep/lastError。
- `startDaemon({ a2aControlPlane })` opt-in；legacy `controlPlane` 保持兼容，
  两者互斥。默认入口切换仍属 R5-c。
- global drain：`QueueLedgerStore.listQueuedThreadIds` / `countQueuedAll` +
  `QueueProcessor.drainAll`；每 thread 用 owner `createdBy` 作为 userId。
- shutdown：`WorkerPool.closeAll` finish 全部 live carrier 并 retire；
  控制 socket、定时器、DB 按顺序收口。
- 测试：`f018-r5-b-daemon.test.ts`（跨 thread drain + 两 response、startup
  process_restart 收敛、startDaemon opt-in/clean close）。

[宪宪/deepseek-flash🐾]
