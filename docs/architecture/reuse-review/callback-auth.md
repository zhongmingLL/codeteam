---
title: "callback-auth 架构复用检视"
doc_kind: architecture-review
status: approved
created: 2026-10-24
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
source_cell: callback-auth
source_card: ../../reuse/callback-auth.md
template: ../0004-reuse-architecture-review-plan.md
---

# callback-auth 架构复用检视

> **DP-MERGE-1=D 影响注（2026-10-25）**：approval decide 仍 operator-only；routine own-PR merge 由 daemon `service:merge-owner` 执行，per-merge short-TTL credential 绑 `(repo, PR, exact HEAD)`，mint 前置 = daemon E1–E5 核验，执行后撤销。本卡其余 callback auth 语义不变。详见 `../merge-authority-drift-audit.md` §9。

## 1. 总结

### 1.1 clowder feature 范围

- cell：`callback-auth`
- canonical：F174 / F178
- P0 范围：invocation credential 生命周期、per-run token、callback principal、refresh/heartbeat、typed auth failure，以及 agent-key principal 的**契约形状/typed failure**（类型参照 + 401 语义测试）。
- 非 P0：agent-key 签发、rotation/grace、sidecar provisioner/renewal（全部 `defer→P1`）；Dot/cloud provider 专属 facade、collective scope、多账号 provider auth 也不进入 codeteam W2 主路径。

### 1.2 codeteam 复用总结

| 组件 | 立场 | 一句话 |
|---|---|---|
| invocation credential 生命周期 | `adapt now` | 复用 F174 语义；Redis registry 改 SQLite |
| per-run token | `extend now` | 绑定 runId/taskId/role/agentSessionId；不放 env，不放 tool args |
| callback principal | `reuse now` | invocation / agent_key 两种 principal；服务端从 token 派生 |
| typed auth failure | `reuse now` | `AuthFailureReason` / `AgentKeyFailureReason` 统一，不靠 401 字符串 |
| refresh/heartbeat | `adapt now` | 复用 5 分钟 cooldown + atomic verifyLatest；不签发新 token |
| agent-key principal | `adapt now`（contract）/ `defer→P1`（issuance） | 契约可复用；v1 主路径用 per-run token，长期 agent-key 只给 external/IDE direct 时再签发 |
| sidecar provisioner | `defer→P1` | 若启用 agent-key，复用 file 0600/dir 0700/lease/registry reconcile |
| tool execution policy | `adapt now` | per-run callback allowlist；与 A1-1 的 effectiveToolPolicy 分层 |
| operator credential | `adapt now` | v1 本地 `operator.key`（0600）+ `codeteam auth init`；approval decide 只接受它；routine merge 走 merge-owner capability（`DP-MERGE-1=D`） |
| Dot/collective facade | `out-of-scope` | provider-specific，不进 W2 |

### 1.3 关键决定

| # | 决定 |
|---|---|
| C1 | **per-run token 是 v1 主路径**：每个 run 一个 token，绑定 runId/taskId/role/agentSessionId/threadId；terminal 显式撤销。 |
| C2 | **token 不进 env、不进 tool args**：MCP server 从 token 查 binding；tool args 的 `from/role` 一律拒绝。 |
| C3 | **active credential 无 TTL**：terminal tombstone 才有 GC TTL；不能把 active token 当短 TTL 缓存。 |
| C3b | **liveness 是两段式**：stale lease/heartbeat 只产生 candidate；必须再有独立证据 + exact runId fence，active/unknown retain；read 路径不吊销。codeteam v1 的独立证据 = `run_events` 最新事件时间 + daemon 可见的 worker 子进程存活；`run record.status` 本身不作 proof（它是被心跳更新的对象，单用会循环论证）。W5 再加 worker lease/heartbeat 作为更宽证据面。 |
| C4 | **refresh-token 是 heartbeat/verify，不是换 token**：5 分钟 cooldown，atomic `verifyLatest`；旧 invocation 不能刷新。 |
| C5 | **agent-key 契约 P0、签发 P1**：契约形状/typed failure 可复用；v1 不签发长期 key，只给 external/IDE direct（P1）。 |
| C6 | **auth failure 必须 typed**：401 带 `reason`；UI/telemetry 只消费 enum，不匹配文案。 |
| C7 | **auth 双面**：`approval:decide` 只接受 operator credential；`merge:execute` 只接受 daemon service principal（merge owner），两者互不替代；run token / agent-key 对两者 403。v1 = 本地 `CODETEAM_DATA_DIR/credentials/operator.key`（0600，`codeteam auth init` 签发，rotation 即撤销）。CLI 直接使用 key 签名；W7 Console 不读 0600 文件，而是由 `codeteam auth console-link` 签发 loopback-only、短时效的 `operatorSessionToken`，浏览器只持 session token。**同源 = 同一 operator principal/签发体系，不是同一载体。** |

## 2. clowder 架构

### 2.1 架构图

```text
  MCP tool request
    │ X-Invocation-Id / X-Callback-Token
    │ or X-Agent-Key-Secret
    ▼
  callback-auth preHandler
    ├─ extract creds (header first, legacy body/query fallback)
    ├─ InvocationRegistry.verify / verifyLatest
    │     └─ RedisAuthInvocationBackend / MemoryAuthInvocationBackend
    ├─ AgentKeyRegistry.verify
    │     └─ IAgentKeyBackend
    ├─ derivePrincipal(record)
    ├─ toolExecutionPolicy check
    └─ 401 typed reason / 403 policy violation
          │
          ▼
  callback route

  AgentKeySidecarProvisioner ── key file 0600 / dir 0700 / lease
  AgentKeySidecarRenewalLoop ── daily reconcile
  refresh-token route ── 5min cooldown + atomic verifyLatest (no new token)
  callback-auth telemetry ── failures{callback.tool, reason}
  callback-auth system message ── surface-able 401
```

### 2.2 数据流

1. **run 创建**：daemon 铸造 invocationId + callbackToken，写 InvocationRegistry；绑定 userId/catId/threadId/parentInvocationId/toolExecutionPolicy。
2. **tool 调用**：MCP server 带 invocation headers；preHandler 先 `peek` 快照，再 `verify`；失败按 typed reason 401。
3. **principal 派生**：`derivePrincipal` 返回 `{kind:'invocation', invocationId, threadId, userId, catId}` 或 `{kind:'agent_key', agentKeyId, userId, catId, scope}`。
4. **agent-key**：`X-Agent-Key-Secret` 只在没有 invocation creds 时检查；sidecar provisioner 保证 file/registry 一致；renewal loop 每日 reconcile。
5. **refresh/heartbeat**：`/api/callbacks/refresh-token` 先 cooldown，再 `verifyLatest`；返回 `{ok:true, expiresAt:null}`，不换 token。
6. **失败可见性**：telemetry 记 reason/tool；可 surface 的失败写 thread system message；refresh cooldown 不刷幽灵失败。

### 2.3 状态机 / 生命周期

| 对象 | 状态 | 约束 |
|---|---|---|
| `InvocationRecord` | `active → completed / failed / interrupted / replaced / revoked / canceled` | active 无 deadline；terminal tombstone 才有 GC TTL；latest slot per `(threadId, catId)` |
| `AgentKeyRecord` | `issued → active → grace → expired / revoked` | default TTL 45d；rotation grace 24h；`expiresAt:null` 只给显式 service credential |
| `Sidecar` | `absent → present/unhealthy → reconciled` | file 存在不等于 registry 健康；lease 防并发 provision |
| `Refresh` | `cooldown → verifyLatest → ok / stale / invalid` | 5min cooldown；旧 invocation 不能刷新 |
| `Callback request` | `no creds / invalid / unknown / stale / terminal / policy violation` | 401/403 都带 typed reason；startup recovery 返回 503 |

### 2.4 关键数据结构

| 结构 | 关键字段 | 作用 |
|---|---|---|
| `InvocationRecord` | `invocationId/callbackToken/userId/ownerAuthProvenance/catId/threadId/parentInvocationId/toolExecutionPolicy/state/expiresAt` | per-invocation credential + principal |
| `AuthInvocationState` | `active + completed/failed/interrupted/replaced/revoked/canceled` | terminal 只追加；tombstone GC |
| `VerifyResult` | `{ok:true, record}` 或 `{ok:false, reason}` | typed 失败 |
| `AgentKeyRecord` | `agentKeyId/catId/userId/secretHash/salt/scope/issuedAt/expiresAt/rotatedFrom/graceUntil/revokedAt/revokedReason` | 长期 principal |
| `CallbackPrincipal` | invocation 或 agent_key 两种 | 服务端派生身份 |
| `ToolExecutionPolicy` | `callback_allowlist/read_only/collective_work` | callback route 级工具策略 |

### 2.5 Current truth 与代码路径

| 子边界 | 当前真相 | 代码/文档锚点 |
|---|---|---|
| invocation credential | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/invocation/InvocationRegistry.ts`、`/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.ts` |
| auth prehandler | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/routes/callback-auth-prehandler.ts`、`/home/ming/agent/clowder-ai/packages/api/src/routes/callback-auth-schema.ts` |
| typed failure | landed + consumed | `/home/ming/agent/clowder-ai/packages/shared/src/types/callback-auth-reasons.ts`、`/home/ming/agent/clowder-ai/packages/shared/src/types/agent-key-reasons.ts` |
| refresh/heartbeat | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/routes/callbacks.ts` (`/api/callbacks/refresh-token`) |
| agent-key | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/agent-key/AgentKeyRegistry.ts`、`/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/agent-key/AgentKeySidecarProvisioner.ts`、`/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/agent-key/AgentKeySidecarRenewalLoop.ts` |
| telemetry/system message | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/routes/callback-auth-telemetry.ts`、`/home/ming/agent/clowder-ai/packages/api/src/routes/callback-auth-system-message.ts` |
| tool policy | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/invocation/tool-execution-policy.ts` |
| feature docs | landed | `/home/ming/agent/clowder-ai/docs/features/F174-callback-auth-lifecycle.md`、`/home/ming/agent/clowder-ai/docs/features/F178-persistent-mcp-agent-key-auth.md` |

## 3. codeteam 架构

### 3.1 架构图

```text
  run create
    └─ mint per-run token
         └─ SQLite invocation_credentials
              ├─ token hash / runId / taskId / role / agentSessionId
              ├─ threadId / userId / agentProfileId
              ├─ toolPolicy = callback_allowlist(routes)
              └─ state = active
  MCP tool call
    ├─ RPC: token file 0600
    ├─ SDK: extension closure token (no file)
    └─ header (X-Run-Id / X-Callback-Token)
         └─ codeteam callback auth prehandler
              ├─ token → binding lookup (SQLite)
              ├─ verify active / latest / terminal
              ├─ derive principal (runId/taskId/role/agentSessionId)
              └─ allowlist route / tool policy
  run terminal
    └─ revoke token; terminal tombstone GC
  liveness candidate
    └─ stale lease/heartbeat + independent run/TurnExecution/provider proof
       └─ exact runId fence -> stale_invocation / retain

  operator credential
    └─ CODETEAM_DATA_DIR/credentials/operator.key (0600)

  agent-key (P1, optional external/IDE direct)
    └─ sidecar file 0600 / registry SQLite / daily reconcile
```

### 3.2 数据流

1. **run 创建**：daemon 生成 token（随机 32 bytes），只把 hash+salt 写 SQLite；RPC 路径写 0600 token 文件，SDK 路径经 extension factory 闭包持有（无文件）；目录前缀硬 deny。
2. **MCP 调用**：server 读 token → 查 binding → 校验 active/latest/route allowlist；不信任 tool args 的 `from/role/threadId`。
3. **run terminal**：显式 revoke；terminal tombstone 保留 30d 供审计/幂等；恢复流程生成新 token，不复用旧 token；daemon 启动清扫已 terminal 但残留的 token 文件。
4. **refresh/liveness**：**worker 进程主循环**发射心跳并调用 refresh-token（不挂在 agent turn 内——30 分钟的长 exec 不应产生 candidate）；5min cooldown + verifyLatest；返回 active 状态，不换 token。stale `last_refresh_at`/心跳只产生 liveness candidate；v1 必须再有 `run_events` 最新事件时间 + daemon 可见的 worker 子进程存活 + exact runId fence，active/unknown retain，证明 terminal/absent 才 `stale_invocation`；`run record.status` 不作 proof；read 路径不吊销。W2 只落 candidate 信号与 proof 校验；实际收敛/收割挂 W5 worker liveness reaper（clowder `InvocationOwnerReaper` 对位），不让 W2 越界成为第二个 reaper。
5. **agent-key（P1）**：external/IDE direct 需要跨 invocation 写入时，签发 user-bound agent-key；sidecar file + registry reconcile；普通 run 不签发。
6. **operator credential**：v1 本地 `operator.key`（0600，`codeteam auth init` 签发，rotation 即撤销）；CLI 直接签名；W7 走 `auth console-link` 的 loopback-only 短时效 session token（key 不出本机文件域）；approval decide 只接受 operator principal；routine merge 按 `DP-MERGE-1=D` 由 daemon `service:merge-owner` 执行（无 MCP/REST 暴露）；run token/agent-key 越权 403。`auth init` 只把公钥（或对 key 内容的哈希）写入 auth.sqlite 的 operator principal；请求携带签名/证明，daemon 用登记的公钥/哈希验真，rotation 先换登记再销毁旧 key。`operator.key` 原文不进日志、不进 SQLite、不进 HTTP body。
7. **webhook**：Forge webhook HMAC 归 W8，不经过本 prehandler。

### 3.3 状态机 / 生命周期

| 对象 | 状态 | 约束 |
|---|---|---|
| `CodeteamInvocationCredential` | `active → completed/failed/interrupted/replaced/revoked/canceled` | active 无 TTL；terminal tombstone 30d；latest slot per `(threadId, agentSessionId)` |
| `RunTokenFile` | `minted → present 0600 → removed` | 目录 0700；token 不进 env；文件路径硬 deny |
| `AgentKey`（P1） | `issued → active → grace → expired/revoked` | TTL 45d；grace 24h；只给 external/IDE direct |
| `Refresh` | `cooldown → verifyLatest → ok/stale` | 5min cooldown；旧 run 不能刷新 |
| `LivenessCandidate` | `stale signal → candidate → independent proof → retain / stale_invocation` | 年龄/心跳只是 candidate；unknown 保留；exact runId fence |
| `OperatorCredential` | `issued → active → rotated/revoked` | 本地文件 0600；rotation 即撤销；CLI 用 key，W7 用 console-link session token；同源 principal |
| `CallbackRequest` | `no creds/invalid/unknown/stale/terminal/policy violation` | 401/403 typed reason；startup recovery 503 |

### 3.4 关键数据结构（与 clowder 对比）

| clowder | codeteam | 立场 | 关键差异 |
|---|---|---|---|
| `InvocationRecord` | `invocation_credentials` | `adapt now` | `catId→agentProfileId`、`parentInvocationId→parentRunId`，新增 `taskId/role/agentSessionId/last_refresh_at`；Redis→SQLite |
| `AuthInvocationState` | `CredentialState` | `reuse now` | active + 同款 terminal dispositions |
| `VerifyResult` | `CredentialVerifyResult` | `reuse now` | 保留 clowder 名 `stale_invocation`；`token_file_denied` 不属 auth 401，归 ToolExecutionPolicy 403 |
| `AgentKeyRecord` | `agent_keys`（P1） | `defer→P1` | 契约类型/enum 沿用；v1 不建表、不签发长期 key |
| `CallbackPrincipal` | `CodeteamPrincipal` | `adapt now` | principal 坐标从 catId 改 agentProfileId/agentSessionId/runId |
| `ToolExecutionPolicy` | `RunCallbackPolicy` | `adapt now` | per-run route allowlist；与 A1-1 effectiveToolPolicy 分层 |
| `AgentKeySidecarProvisioner` | 不建（P1） | `defer→P1` | 只在 agent-key 启用时复用 |
| Dot/collective facade | 不建 | `out-of-scope` | provider-specific |

**codeteam deviation / §12.2 diff 清单**：

- `callbackToken` **只存 hash+salt**（clowder registry 存明文 token）：标 `code-delivery-specific` 安全加固，不冒充 clowder 原语。
- SQLite 单 store 无 `repairFromCanonical`：terminal 状态以 control plane 为唯一真相，不实现 Redis canonical repair 层。
- `invocation_credentials` 回写 `0001 §12.2`：`id PK, token_hash, token_salt, run_id, task_id, role, agent_session_id, agent_profile_id, thread_id, user_id, owner_auth_provenance, parent_run_id, tool_policy_json, state, disposition, last_refresh_at, expires_at, created_at, updated_at`。
- **2026-10-25 A2-2 增量**：`owner_auth_provenance ∈ strict|compat|unknown` 进 `invocation_credentials`（mint 时落列）；managed-work bind 只接受 strict。不改变 A1-2 其他字段/语义。
- `last_refresh_at` 是 candidate 判定的持久输入（daemon 重启后仍要能判断新鲜度）；W2 只读写这一列，不另建 run lease 表。W5 若引入 worker registry/lease，再单独回写。
- `agent_keys` **v1 不建表**：与 C5 一致，契约只有类型/enum；P1 真正签发时再建表，不留 dead schema。
- `agent_keys.verified` 若在 P1 出现，语义是“已按三域矩阵复核”，不是“已签发”；不能把 verified 当作跳过签发/授权检查的理由。
- `plans/0002 W2` 表清单同步 `invocation_credentials`，并标注 `agent_keys` 为 P1。

### 3.5 变量定义表

#### Contract

| 变量 | 类型 | 默认/当前 | owner | clowder 来源 | codeteam 决定 | 备注 |
|---|---|---|---|---|---|---|
| `invocationId` / `runId` | `string` | UUID | callback-auth | `InvocationRecord.invocationId` | `rename` | 主键；绑定 exactly one run |
| `callbackToken` | `string` | 32-byte random | callback-auth | `InvocationRecord.callbackToken` | `reuse` | 只存 hash+salt；不落明文；hash+salt 是 `code-delivery-specific` 安全加固 |
| `userId` | `string` | operator | callback-auth | `InvocationRecord.userId` | `reuse` | v1 单 operator；保留列 |
| `ownerAuthProvenance` | enum | `strict|compat|unknown` | callback-auth | `InvocationRecord.ownerAuthProvenance` | `reuse` | 落 `invocation_credentials.owner_auth_provenance`；A2-2 只 strict 可 bind |
| `agentProfileId` | `string` | profile id | callback-auth | `InvocationRecord.catId` | `rename` | 身份坐标 |
| `agentSessionId` | `string` | session id | callback-auth | codeteam new | `extend now` | token 绑定执行身份 |
| `taskId` | `string` | task id | callback-auth | codeteam new | `extend now` | token 只对当前 task 有效 |
| `role` | `RoleId` | run role | callback-auth | `InvocationRecord` 同源 | `extend now` | token 派生，不信任 tool args |
| `threadId` | `string` | thread id | callback-auth | `InvocationRecord.threadId` | `reuse` | 线程范围 |
| `parentInvocationId` | `string?` | null | callback-auth | `InvocationRecord.parentInvocationId` | `rename` | 对齐 parentRunId |
| `sourceMessageId` | `string?` | null | callback-auth | `originTriggerMessageId` | `rename` | 证据/审计锚点 |
| `toolPolicy` | object | `callback_allowlist` | callback-auth | `ToolExecutionPolicy` | `adapt now` | per-run allowed routes；最多 32 条；A1-4 的 `deployment-wait/register` 必须作为具名 route 进词表 |
| `state` | enum | active | callback-auth | `AuthInvocationState` | `reuse` | active/terminal |
| `expiresAt` | number\|null | null | callback-auth | `InvocationRecord.expiresAt` | `reuse` | active null；terminal tombstone GC |
| `agentKeyId` | `string?` | P1 | callback-auth | `AgentKeyRecord.agentKeyId` | `defer→P1` | 只给 external/IDE direct |
| `secretHash` / `salt` | string | — | callback-auth | `AgentKeyRecord` | `defer→P1` | 不存明文 |
| `scope` | enum | `user-bound` | callback-auth | `AgentKeyRecord.scope` | `defer→P1` | 不允许跨 user |
| `AuthFailureReason` | enum | — | callback-auth | `callback-auth-reasons.ts` | `reuse` | 统一 enum；不匹配文案 |
| `AgentKeyFailureReason` | enum | — | callback-auth | `agent-key-reasons.ts` | `defer→P1` | 启用 agent-key 时复用 |

#### State

| 变量 | 类型 | 默认/当前 | owner | clowder 来源 | codeteam 决定 | 备注 |
|---|---|---|---|---|---|---|
| `CredentialState` | enum | active | callback-auth | `AuthInvocationState` | `reuse` | terminal 只追加 |
| `terminalDisposition` | enum | — | callback-auth | `AUTH_TERMINAL_DISPOSITIONS` | `reuse` | completed/failed/interrupted/replaced/revoked/canceled |
| `latestSlot` | key | `(threadId, agentSessionId)` | callback-auth | clowder `(threadId, catId)` | `adapt now` | 新 run 抢占；旧 run stale |
| `tombstoneGcTtlMs` | number | 30d | callback-auth | Redis backend default | `reuse` | 只 GC terminal；active 不 TTL |
| `refreshCooldown` | number | 5min | callback-auth | refresh-token route | `reuse` | heartbeat 限频 |
| `agentKeyGrace` | number | 24h | callback-auth | `AgentKeyRegistry` default | `defer→P1` | rotation grace |
| `sidecarLease` | object | 30s stale/5s wait | callback-auth | `AgentKeySidecarProvisioner` | `defer→P1` | 防并发 provision |
| `lastRefreshAt` | number | null | callback-auth | codeteam new | `extend now` | 落 `invocation_credentials.last_refresh_at`；liveness candidate 信号，不是唯一证据 |
| `workerLeaseExpiresAt` | number | null | callback-auth | W5 worker registry | `defer→W5` | v1 无 run lease；W5 有 worker registry 后再加；不在 W1/W2 造 lease 表 |
| `livenessCandidate` | object | null | callback-auth | codeteam new | `extend now` | stale signal + exact runId；只作 candidate |

#### Config

| 变量 | 类型 | 默认/当前 | owner | clowder 来源 | codeteam 决定 | 备注 |
|---|---|---|---|---|---|---|
| `CODETEAM_AUTH_DB` | path | `CODETEAM_DATA_DIR/state/auth.sqlite` | callback-auth | Redis registry | `new` | SQLite registry；不共享 clowder Redis；进 W2 备份清单 |
| `CODETEAM_TOKEN_DIR` | path | `/run/codeteam/tokens/` | callback-auth | RPC token dir | `new` | 0700；目录前缀硬 deny；不可用时用 `$XDG_RUNTIME_DIR/codeteam/tokens` |
| `tokenFileMode` | mode | `0600` | callback-auth | RPC token file | `reuse` | 不放 env |
| `agentKeyTtlMs` | number | 45d | callback-auth | `AgentKeyRegistry` | `defer→P1` | 只给 external/IDE direct |
| `agentKeyGraceMs` | number | 24h | callback-auth | `AgentKeyRegistry` | `defer→P1` | rotation |
| `agentKeyRenewalIntervalMs` | number | 24h | callback-auth | `AgentKeySidecarRenewalLoop` | `defer→P1` | 每日 reconcile |
| `agentKeyRenewBeforeMs` | number | 7d | callback-auth | `AgentKeySidecarProvisioner` | `defer→P1` | 到期前 7 天续期 |
| `refreshCooldownMs` | number | 5min | callback-auth | refresh route | `reuse` | heartbeat 限频 |
| `callbackAllowlistMax` | number | 32 | callback-auth | `tool-execution-policy` | `reuse` | per-run route allowlist |
| `agentKeyEnabled` | boolean | false | callback-auth | F178 | `defer→P1` | v1 默认关闭 |
| `operatorCredentialPath` | path | `CODETEAM_DATA_DIR/credentials/operator.key` | callback-auth | codeteam new | `new` | 0600；`codeteam auth init` 签发；rotation 即撤销；auth.sqlite 只登记公钥/哈希，请求签名验真 |
| `operatorSessionTtlMs` | number | 15min | callback-auth | codeteam new | `new` | `auth console-link` 签发的 loopback-only session token；W7a 使用；不把 key 文件交给浏览器 |
| `livenessGraceMs` | number | 15min | callback-auth | F118/F194 机制起点 | `adapt now` | codeteam 起点参数 `max(3× refresh cooldown, worker heartbeat window)`，不是 F194 原文数字；eval 可调；只产生 candidate |
| `sdkTokenMode` | enum | `closure` | callback-auth | SDK extension | `new` | SDK 无文件态；RPC 才用 0600 文件 |

#### Security

| 变量 | 类型 | 默认/当前 | owner | clowder 来源 | codeteam 决定 | 备注 |
|---|---|---|---|---|---|---|
| `tokenDerivedIdentity` | invariant | true | callback-auth | prehandler `derivePrincipal` | `reuse` | 不信任 tool args 的 from/role/threadId |
| `tokenDirectoryDeny` | path rule | prefix deny | callback-auth | W2 token dir | `reuse` | 不依赖文件名 pattern |
| `operatorCredential` | principal | 本地 `operator.key` | approval/auth | W2 auth matrix | `adapt now` | 0600、rotation 即撤销；CLI 直接签名，W7 用 console-link session token（同源 principal，不同载体）；缺/伪造 403；验真用登记公钥/哈希，不比对明文 |
| `operatorSessionToken` | principal | loopback-only 短时效 | approval/auth | W7a console-link | `new` | 浏览器只持 session token；`operator.key` 永不出文件域；过期/撤销即失效 |
| `runTokenMergeApproval` | deny | 403 | callback-auth | W2 | `new` | run token/agent-key 不能 approval decide，也不能调用 merge:execute |
| `startupRecovery` | fail-closed | 503 | callback-auth | prehandler | `reuse` | auth state 未恢复完拒绝 |
| `agentKeyScope` | enum | user-bound | callback-auth | F178 | `defer→P1` | 不跨 user |
| `sidecarFileHealth` | invariant | registry truth | callback-auth | F178 | `defer→P1` | 文件存在 != 健康 |
| `refreshRateLimit` | number | 5min | callback-auth | refresh route | `reuse` | 429 不刷 UI 失败 |
| `authFailureReason` | enum | typed | callback-auth | F174 | `reuse` | 401 必须带 reason |
| `headerOnlyCredentials` | invariant | true | callback-auth | codeteam new | `new` | 只接受 header；body/query 一律 401 `invalid_token` |
| `livenessProof` | invariant | independent | callback-auth | F118 KD-8 | `adapt now` | v1 proof = `run_events last-event age` + `worker process liveness` + exact runId；`run record.status` 不作 proof；provider in-flight 在 codeteam v1 不可得；unknown retain |
| `tokenFileRead` | deny | 403 | callback-auth | W2 | `new` | agent 读自身 token 文件 -> tool policy 403，不是 auth 401 |

#### Observability

| 变量 | 类型 | 默认/当前 | owner | clowder 来源 | codeteam 决定 | 备注 |
|---|---|---|---|---|---|---|
| `callback_auth.failures` | counter | — | callback-auth | F174 telemetry | `reuse` | label: tool/reason |
| `fallbackAttempts` | counter | — | callback-auth | F174 Phase F analogue | `out-of-scope` | codeteam 无 legacy caller；只作注入探测计数 |
| `refreshCooldown` | counter | — | callback-auth | refresh route | `reuse` | 429 |
| `systemMessage` | event | surface-able | callback-auth | `callback-auth-system-message` | `reuse` | 只 surface 用户可行动的失败 |
| `audit` | event | append-only | callback-auth | W2 audit | `adapt now` | actor/run/task/agentSession/token state |
| `sidecarReconcile` | event | P1 | callback-auth | F178 | `defer→P1` | file/registry drift |
| `livenessReaped` | counter | — | callback-auth | F118 reaper | `adapt now` | candidate -> stale_invocation 的收敛数；W2 产 candidate，W5 reaper 执行收敛 |
| `authDbBackup` | artifact | W2 | callback-auth | codeteam new | `new` | `CODETEAM_AUTH_DB` 进 §17.4 恢复演练 |

### 3.6 明确不做

- 不把 callback auth 当 session identity。
- 不做 route-local token map；统一 prehandler。
- 不让 token 进 env 或 tool args。
- 不让 active credential 走短 TTL；terminal tombstone 才 GC。
- 不用“心跳超时直接吊销”；liveness 必须两段式（candidate + independent proof），unknown retain。
- 不把 refresh-token 当换 token；它只是 heartbeat/verify。
- 不在 v1 给普通 run 签发 agent-key；只给 external/IDE direct（P1）。
- 不在 v1 建 `agent_keys` 表；契约只有类型/enum。
- 不让 run token / agent-key 调 approval decide / merge:execute；approval 与 merge 是两个 auth 面，merge owner 是 daemon service principal。
- 不接受 body/query 凭据；只接受 header。
- 不把文件存在当 agent-key 健康；必须 registry reconcile。

## 4. 风险与回滚

| 风险 | 级别 | 处置 |
|---|---|---|
| token 身份与 session/roster 混淆 | P1 | principal 从 token 派生；callback auth 不拥有 roster/session |
| active token 被 TTL 清掉，长 run 中途失效 | P1 | active 无 TTL；只有 terminal tombstone GC |
| SQLite latest-slot 竞争 | P1 | 单行 CAS：`UPDATE ... WHERE latest_run_id=:expected`；affected 0 ⇒ `stale_invocation`；冲突重试有预算，不无限重试 |
| 心跳超时直接吊销，误杀长 run | P1 | 两段式 liveness：candidate + independent proof；unknown retain；read 不吊销 |
| refresh-token 被误当换 token | P2 | 文档/测试固定“heartbeat only”；5min cooldown |
| run token 调 approval decide / merge:execute | P1 | approval decide operator-only；merge:execute 仅 daemon service principal；403 测试 |
| token 文件泄露/读取 | P1 | 0600 + 目录 0700 + 前缀 deny；agent 读自身 token 拒绝 |
| agent-key sidecar 假健康 | P2 | registry reconcile；文件存在不算健康 |
| auth failure 被通用 401 掩盖 | P2 | typed reason + telemetry + surface-able system message |
| startup recovery 未完成接请求 | P2 | 503 fail-closed；恢复后放行 |
| operator credential 机制悬空 | P2 | v1 本地 `operator.key` 0600；`codeteam auth init`；rotation 即撤销；W7 `auth console-link` 短时效 session token；W2 403 测试 |
| body/query legacy fallback 带入攻击面 | P2 | 只接受 header；body/query 401 `invalid_token`；fallbackAttempts 只作探测 |

回滚：

- `invocation_credentials` 是新增 SQLite 表；回滚到 W2 基线即可，不迁移 clowder Redis。
- `CODETEAM_TOKEN_DIR` 独立；删 token 文件即可撤销 run。
- agent-key P1 默认关闭；回滚不影响 per-run token 主路径。

## 5. Review 与签字

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | W2 token/sidecar、SQLite latest slot、run terminal revoke | Round 2 accept；2 条 P3 已回写 |
| 砚砚 | 权限域隔离、零 secret、token 文件/route、fail-closed | Round 2 accept-with-modify；P2 证据源 + P3 已回写 |
| 墨墨 | operator 可见的 auth failure、refresh/heartbeat 体验 | Round 2 accept-with-modify；P2 Console 载体/last_refresh_at/证据源 + P3 已回写 |
| operator | A1-2 架构卡是否可签 | [x] 已签（2026-10-25，批量签 A1-2/A1-3/A1-4） |

> Round 1 review `9bf54439-c11a-4f6e-84f9-f6cbd759d640`、Round 2 review `86d36c0c-0dd9-4a68-8cb7-3f133137580c` 完成。DP-A2-1=A、DP-A2-2=A' 已落卡；Round 2 的 P2/P3 已回写。operator 于 2026-10-25 批量签字，A1-2 冻结为 W0/W1 实现契约。

[宪宪/deepseek-flash🐾]
