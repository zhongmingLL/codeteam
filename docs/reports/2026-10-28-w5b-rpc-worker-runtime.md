---
title: "W5b RPC Worker Runtime 验收报告"
doc_kind: report
status: closed
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

Result（2026-10-28）：`40 passed | 2 skipped` files，`316 passed | 2 skipped`
tests。skip = env-gated live provider smoke + 既有 real-repo first-run。

### 2. W5b 定向

```bash
NODE_ENV=development npm --prefix packages/codeteam-daemon test -- control-worker
```

Result：`5 passed | 1 skipped` files，`25 passed | 1 skipped` tests。

覆盖：

- registry：capacity、heartbeat/lease、stale 不复活、stale run→interrupted、
  session re_attach_pending、retry 幂等、token 文件清理。
- control：0600 socket、heartbeat、token 绑定、write path escape deny、
  bash metachar deny、reviewer read-only matrix、verifier evidence-only write。
- rpc：split frame / U+2028、invalid JSON fail-closed、oversized frame
  fail-closed、无换行残留帧超限 fail-closed。
- executor：dispatch 全链路、同 worker 两 run token 隔离、worker crash→
  interrupted→retry→dead-letter、session file 重挂、fresh+capsule、
  graceful drain、drain timeout、retryable code preservation、model_error
  有界重试。

### Review follow-up（2026-10-28）

烁烁 A2A/session/worker review：**changes_requested**（2×P2，P3 可选）；其余
维度认可，并独立复跑旧 HEAD `bc702344c` 的 W5b 22+1 / daemon 313+2 /
Biome / 真实 pi E2E。

- P2-1：`resolveSessionWorker` 现在同时检查 `leaseExpiresAt > now`；lease
  过期的 online worker 在进入 executor 前即按 `reattach` 处理，不必等 sweep。
  新增 `treats an expired online lease as re-attach before a sweep runs` 测试。
- P2-2：fresh 降级的 response body 确定性加 `> Continuity degraded: ...`
  前缀；fresh fallback 测试断言该标记。
- P3：interrupted bubble 文案改为 `Execution interrupted: ...`；删除未使用的
  `freshSessionCapsule`；executor 增加 run/session/profile/task 一致性交叉校验。

### Review follow-up #2（2026-10-28，砚砚 code/security）

砚砚 code/security review：**changes_requested**（1×P2，P3 不阻塞）；确认
token/policy/socket/crash/drain/migration/retry 阳性项，并复核本轮烁烁 P2。

- P2-3：`consumeStdout` 的 `index < 0` 分支由 `return` 改为 `break`，使循环后
  的残留帧 max-frame 检查可达；无换行超大 payload 不再让 `stdoutBuffer` 无界
  增长至 OOM。新增 `partial-oversize` fixture 与负例测试；旧行为下该测试 5s
  超时失败（Red），修复后通过（Green）。
- P3-1：删除 `WorkerRegistry.heartbeat` 两个分支完全相同的冗余判断。
- P3-2：把 `model_error` 加入 `RETRYABLE_REASONS`，使
  `RetryableExecutionError("model_error")` 与失败策略一致；仍受 maxAttempts=3
  与 audit 幂等约束，新增有界重试测试。
- P3-3：`read` 缺少 `path` 时 fail-closed（`missing_path`）；`grep`/`find`/`ls`
  的 `path` 在 pi schema 中可省略且默认 worktree cwd，保持允许，并补集成断言。
- P3-4/5/6 仅备注留痕：`/tmp` socket fallback、`start()` 50ms 启动探测、
  16KiB 截断可能切断代理对；均不影响本 PR 的控制面安全边界，见 Residual 表。

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
| 超长 dataDir 的 `/tmp` socket fallback | 0600 socket + fail-closed 已验证；W7a transport 硬化 |
| `start()` 50ms 启动探测 | 更慢启动崩溃由后续 `getState` 捕获；必要时改 readiness handshake |
| event 文本截断按 UTF-16 code unit | 16KiB 边界可能切断代理对；后续硬化，不影响安全边界 |

## Review routing

- 烁烁：A2A/session/worker 语义、sticky/re-attach、worker lifecycle。
- 砚砚：code/security、token/policy/socket、crash/drain 边界。
- Feature close 的愿景守护另找既非作者也非 reviewer 的猫。

## 合并与 close（2026-10-28）

- PR #53 squash merged into `codeteam-work` at
  `aeb1bf834094975963b6f5bc4626f780430a3ac3`; reviewed HEAD
  `028785a137b0a1b9c0603332acbde3051e691641`; base `c30f9aafb`。
  Squashed tree 与 reviewed tree 同为 `8ff2cb656…`，kernel packages 零 diff。
- Reviews: 烁烁 approved `0001793195829430-003692-995023f1`; 砚砚 approved
  `0001793195864326-003694-85321350`; both cover final HEAD, no open P1/P2.
- Vision guard: 墨墨（non-author, non-reviewer）approved
  `0001793196631830-003697-9e8006eb`; independently reverified tree hash,
  daemon 316+2, W5b 25+1, and Biome.
- Post-merge acceptance on the merged tree: 40 files passed + 2 skipped,
  316 tests passed + 2 skipped; W5b targeted 25+1; PR CI 4/4 green
  (run 40700930998).

