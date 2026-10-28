---
title: "W5b RPC Worker Runtime 验收报告"
doc_kind: report
status: draft
created: 2026-10-28
updated: 2026-10-28
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
---

# W5b RPC Worker Runtime 验收报告

## 目标与边界

把 W5a 的 fake `AgentExecutor` 换成真实 `pi --mode rpc` worker，并补齐
worker registry/liveness/sticky/re-attach/失败策略。范围以
[`0004`](../plans/0004-w5-w8-scale-product.md) §W5 为单一真相源，
[`0011`](../plans/0011-w5b-rpc-worker-runtime.md) 记录冻结投影与 AC 映射。

不在本 slice：task readiness/DAG、预算、worktree pool/GC、F139、daemon
lifecycle、deployment wait、PR tracking/managed-work（W5c）；HTTP/MCP
transport（W7a）；第二 queue/message store/worker registry。

## 交付

- migration 012：`workers`、`agent_sessions.worker_id/worker_binding_state/
  worker_attached_at`、`runs.worker_id` + 索引。
- `WorkerStore` / `WorkerRegistry`：workerId/role/capacity/state/heartbeat/
  lease；capacity=1（RPC 一进程一 session）；stale 不复活；session
  `re_attach_pending`；容量投影 `activeRuns/activeSessions/boundSessions/
  availableSlots/availableRunSlots`。
- `RpcConnection`：strict LF JSONL（split frame / U+2028 / invalid JSON /
  max frame）、pending request、事件流、abort、优雅关停。
- `WorkerHarness`：`pi --mode rpc` 参数装配、`--extension` 显式装配、
  per-run token 0600 文件、session 文件重挂、fresh + task capsule、0600
  worker token 文件、graceful drain / drain timeout。
- `worker-extension.ts`：heartbeat + `tool_call` policy；控制面不可用时
  mutating deny、read-only allowlist 继续。
- `WorkerControlServer`：`<dataDir>/wc.sock`（0600，长路径回退 `/tmp`）、
  token→run/session/worker 绑定、coder/reviewer 工具矩阵、path/command 复用
  W2 policy、denial audit。
- `RpcAgentExecutor`：sticky/re-attach/fresh、per-run token、有界 event
  reflow、model error、worker crash→interrupted、timeout/protocol→retryable。
- `WorkerFailurePolicy`：可重试失败生成新 Queue Entry（attempt+1），超过
  maxAttempts 后 dead-letter + `inbox(kind='humanGuidance')`；幂等 audit。
- `WorkerRuntime`：startup recovery + stale sweep + drain/drainAll；token 文件
  清理；retired/stale session 标 re_attach_pending。
- 文档：`0011`、F009、docs/plans/docs 索引；F001 RPC 三语义 checkbox。

## 验证证据

### 1. daemon 包全量

```bash
NODE_ENV=development npm --prefix packages/codeteam-daemon test
```

Result（2026-10-28）：`40 passed | 2 skipped` files，`313 passed | 2 skipped`
tests。skip = env-gated live provider smoke + 既有 real-repo first-run。

### 2. W5b 定向

```bash
NODE_ENV=development npm --prefix packages/codeteam-daemon test -- control-worker
```

Result：`5 passed | 1 skipped` files，`22 passed | 1 skipped` tests。

覆盖：

- registry：capacity、heartbeat/lease、stale 不复活、stale run→interrupted、
  session re_attach_pending、retry 幂等、token 文件清理。
- control：0600 socket、heartbeat、token 绑定、write path escape deny、
  bash metachar deny、reviewer read-only matrix、verifier evidence-only write。
- rpc：split frame / U+2028、invalid JSON fail-closed、oversized frame
  fail-closed。
- executor：dispatch 全链路、同 worker 两 run token 隔离、worker crash→
  interrupted→retry→dead-letter、session file 重挂、fresh+capsule、
  graceful drain、drain timeout、retryable code preservation。

### 3. 真实 pi RPC E2E（deterministic mock provider）

```bash
NODE_ENV=development npm --prefix packages/codeteam-daemon test -- control-worker-e2e
```

Result：`4 passed`。真实 `packages/coding-agent/dist/cli.js --mode rpc` +
真实 write/read 工具 + 真实 extension + mock Anthropic provider：

- coder 写 `solution.txt`，reviewer 独立 run 返回 `REVIEW_APPROVED`；
- control plane down：write 被 extension block（文件不存在 + tool result
  isError），read 继续成功；
- 真实 pi session 文件重挂：第二个 run 的 provider 请求携带前一轮
  `SESSION_ONE` assistant 上下文；audit `session_reattached`。

### 4. 静态检查

```bash
NODE_ENV=development npx tsc --ignoreConfig --noEmit --target ES2024 \
  --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck \
  --types node --allowImportingTsExtensions --rewriteRelativeImportExtensions \
  $(rg --files packages/codeteam-daemon/src packages/codeteam-daemon/test -g '*.ts')
NODE_ENV=development npx biome check packages/codeteam-daemon
NODE_ENV=development npm run build:offline
```

Result：daemon scoped TSC OK；Biome `Checked 179 files. No fixes applied`；
build:offline 成功（含 coding-agent bundle 与 codeteam-daemon build）。
根级 `npx tsc --noEmit -p tsconfig.json` 最终复跑被宿主内存终止
（exit 137，swap 已满；与 `docs/features/F005a` 记录同类），不作为本切片
的失败证据；daemon 包 build + scoped tsc 覆盖改动。

### 5. Live provider smoke（未通过环境项）

```bash
CODETEAM_LIVE_PROVIDER=1 NODE_ENV=development \
  npm --prefix packages/codeteam-daemon test -- control-worker-live
```

Result：OpenRouter 返回 `401: {"message":"Missing Authentication header"}`。
这是本机 provider credential/环境问题，不是 RPC harness 失败；该测试默认
skip，CI 不依赖。真实 pi 进程链已由 mock-provider E2E 覆盖。

## 风险与 residual

| 风险 | 处置 / 去向 |
|---|---|
| daemon crash 后孤儿 pi 进程 | stale 检测不复用、token 文件清理；OS 进程强制回收交外部 supervisor/W5c |
| Unix socket 同 uid 信任 | 0600 socket + token 绑定；独立 worker auth 留 W7a+ |
| RPC capacity=1 | 符合 pi 一进程一 session；跨 session 池/预算留 W5c |
| role 启动白名单 + per-run 查询 | 当前双层；动态工具收缩留 W7a transport |
| live provider | 本机 401；默认 skip，环境恢复后手动复跑 |

## Review routing

- 烁烁：A2A/session/worker 语义、sticky/re-attach、worker lifecycle。
- 砚砚：code/security、token/policy/socket、crash/drain 边界。
- Feature close 的愿景守护另找既非作者也非 reviewer 的猫。

