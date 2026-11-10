---
title: "codeteam AgentSession v1 — active + resume"
doc_kind: architecture
status: accepted
created: 2026-11-06
updated: 2026-11-10
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_signoff: "confirmed 2026-11-06; corrected: sealed lifecycle also deferred to v2"
operator_direction: "2026-11-06: v1 只做 A2A runtime，验收要求快速真实模型 E2E，不要求长 session。v1 session 只有 active；sealing/sealed/restore 全部放 v2。"
operator_decisions: "2026-11-06: agentId rename confirmed; messageCount aligns with Clowder; active-only session; nativeSessionBinding flattened to piSessionId+piSessionFile; workspaceFingerprint not persisted; circuit breaker 3 resets binding without seal; provider/model/modelFamily move to Invocation"
related_features: [codeteam/F018, codeteam/F017]
---

# codeteam AgentSession v1

> v1 的 `AgentSession` 是一个**只有 active 的轻量绑定**：一个 `(thread, agent)` 一行，
> 记录 pi session 文件、工作区、基础计数。没有 `sealing` / `sealed`，没有 restore，
> 没有 session chain。
>
> 原因：v1 只做 A2A runtime，验收要求快速真实模型 E2E；长 session 生命周期
> （seal/restore/chain）不是 v1 的验收对象，全部推迟到 v2。

## 0. 结论先行

1. **v1 只保留 11 个字段**：身份 4、resume 3、计数 2、时间戳 2。
2. **v1 只有 active**：没有 `status` / `sealReason` / `sealedAt` / `seq`；一个
   `(thread_id, agent_id)` 唯一一行。
3. **不再保留通用 `nativeSessionBinding`**：v1 只有 pi 一个 backend，直接存
   `piSessionId + piSessionFile`。
4. **resume 失败走 fresh**：文件缺失、越界、绑定不完整、id 不一致都 fresh；
   连续 3 次失败时强制 fresh 并重置计数，不 seal、不新建 codeteam session。
5. **模型属于 Invocation**：`provider/model/modelFamily` 不在 session；每轮从
   AgentConfig/AccountConfig 解析，写入 Invocation。模型变更不要求换 session。
6. **工作区属于 session**：`workingDirectory` 必填且不可变；thread.projectPath
   变化时 typed reject `session_workspace_changed`，静默换目录不做。

## 1. 目标与非目标

**v1 目标**

- 一个 `(thread_id, agent_id)` 一行 session，首次 invocation 创建，后续复用。
- worker/daemon 重启后 resume 原来的 pi session 文件。
- 不能 resume 时安全 fresh，并写事件；不静默失忆、不用错工作区。
- 连续 resume 失败有上限，避免反复撞同一个坏文件。
- 基础计数可读：`messageCount`、`consecutiveResumeFailures`。
- 旧 task-first `agent_sessions` 有明确迁移处置。

**v1 不做**

- `sealing` / `sealed` / `sealReason` / `sealedAt` / `restore`；
- session chain / `seq` / 跨 session 历史；
- context health / capacity pin / last usage / 自动 seal；
- compression / applied policy / hybrid progress；
- handoff note / continuity capsule；
- external import / scoped invocation；
- bg carrier 的 `latestResumeSessionId` / `chainKey`；
- task-first 的 `taskId` / `role` / `stageId` / `effectiveToolPolicy`。

## 2. 最终接口

```ts
export interface AgentSession {
  // 身份
  id: string;
  threadId: string;
  agentId: string;
  userId: string;

  // resume
  piSessionId: string | null;
  piSessionFile: string | null;
  workingDirectory: string;

  // 基础计数
  messageCount: number;              // Clowder 语义：每个有 user-visible output 的 completed invocation +1
  consecutiveResumeFailures: number; // 连续 resume 失败次数，成功 turn 后归零

  // 时间戳
  createdAt: number;
  updatedAt: number;
}
```

| 字段 | 为什么在 v1 |
|---|---|
| `id/threadId/agentId/userId` | session 的身份坐标；一个 thread×agent 唯一一行；`userId` 必须等于 `thread.created_by`，不是第二 owner（0011 §11）。 |
| `piSessionId` | pi 的 session 身份；resume 后必须和 `get_state().sessionId` 一致。 |
| `piSessionFile` | pi 的 JSONL 文件路径；显式 resume 目标，文件缺失时能安全 fresh。 |
| `workingDirectory` | session 的实际工作区；必须等于创建时的 `thread.projectPath`。 |
| `messageCount` | 对齐 Clowder：每个有 user-visible output 的 completed invocation +1；不是原始 message 行数。 |
| `consecutiveResumeFailures` | 连续 resume 失败计数；3 次后强制 fresh 并重置，避免撞坏文件。 |
| `createdAt/updatedAt` | 基础时间戳。 |

### 2.1 与当前 `AgentSession` 的差异

| 当前字段 | v1 处置 | 原因 |
|---|---|---|
| `task_id` / `role` / `stage_id` | 删除 | task-first legacy；v1 session 不绑 task。 |
| `profile_id` | 改名 `agent_id` | 统一 AgentConfig 的 `agentId`。 |
| `provider` / `model` / `model_family` | 移到 `Invocation` | 模型是每轮执行快照，不是 session 身份；0005 的 `Invocation` 已记录。 |
| `effective_tool_policy` | 删除 | 工具策略归 pi 执行层。 |
| `chain_key` | 删除（v2） | v1 没有 session chain / bg carrier。 |
| `native_session_binding_json` | 拆成 `pi_session_id` + `pi_session_file` | v1 只有一个 native backend。 |
| `status` / `seal_reason` / `sealed_at` | 删除（v2） | v1 只有 active；sealed 生命周期整体 v2。 |
| `seq` | 删除（v2） | 没有 chain；一个 thread×agent 一行。 |
| `context_health_json` / `capacity_pin_json` | 删除（v2） | context 管理是 v2。 |
| `cat_handoff_note_json` / `continuity_capsule_json` | 删除（v2） | handoff/continuity 是 v2。 |
| `compression_count` / `latest_resume_session_id` | 删除（v2） | compression / bg carrier 是 v2。 |
| `last_usage_json` | 删除（v2） | usage 展示是 v2。 |
| `workspace_fingerprint` | 删除 | v1 直接比较规范化后的 `workingDirectory`。 |
| `worker_id` / `worker_binding_state` | 迁到 `worker_bindings` | worker attachment 是运行时状态，不是 session identity；session 行不再持有 worker。 |
| `message_count` / `working_directory` / `user_id` | 保留 | 基础字段。 |

**关于 `nativeSessionBinding`**：Clowder 的 `carrier` 只有
`agy_stream_json` / `agy_acp` 两种，都是 Antigravity native；这个对象是
**AGY 专用 launch identity binding**，不是通用 CLI binding。Claude/Codex/
Gemini/OpenCode 等 CLI 走自己的 `cliSessionId` / `--resume`，不需要它。
codeteam v1 只有 pi 一个 backend，所以不保留通用 binding 对象，直接用
`piSessionId + piSessionFile`；如果 v2 增加第二个 native backend，再引入
按 backend 版本化的 binding。

**关于 `workspaceFingerprint`**：Clowder 会持久化它，作为 resume 时判断
“是不是同一个 workspace”的比较键；但它的当前实现只是规范化路径
（`resolve`，Windows 转小写），不是内容 hash。codeteam v1 的
`workingDirectory` 已经是 required 且不可变，resume 时直接对两侧做
realpath/规范化比较即可，不需要额外持久化一列。

## 3. 不变量

1. 同一 `(thread_id, agent_id)` 只有一行 session；唯一索引保证。
2. `piSessionId` 与 `piSessionFile` 必须同时为空或同时非空。
3. `piSessionId` 非空时全局唯一。
4. `workingDirectory` 非空且不可变；必须等于创建时的 `thread.projectPath`。
5. `provider/model/modelFamily` 由 `Invocation` 记录，不属于 session。
6. v1 没有 session 生命周期状态；行存在即 active。
7. v1 不删除 session 行，也不删除 `piSessionFile`；文件保留用于审计/回忆。

## 4. Resume 契约

### 4.1 首次绑定

worker 首次成功启动后，从 `get_state()` 读取 `sessionId` 和 `sessionFile`，
在同一事务写入：

```ts
piSessionId = state.sessionId
piSessionFile = state.sessionFile
messageCount = 0
consecutiveResumeFailures = 0
```

- 两个值必须同时存在；缺一个视为绑定失败，session 行保留但
  `piSessionId/piSessionFile` 仍为 null，下一轮重试。
- `piSessionFile` 必须位于 codeteam 的 `sessionDir` 下；越界拒绝绑定。

### 4.2 Resume 前置检查

| 检查 | 失败动作 | reason |
|---|---|---|
| `piSessionId` 和 `piSessionFile` 都非空 | fresh | `resume_binding_incomplete` |
| `piSessionFile` 存在 | fresh | `resume_file_missing` |
| 文件路径在 `sessionDir` 内 | fresh | `resume_file_outside_root` |
| `workingDirectory` 存在且可访问 | typed error，不 fresh | `workspace_unavailable` |
| `get_state().sessionId === piSessionId` | fresh | `resume_id_changed` |

- `provider/model/modelFamily` 在 invocation 层从 AgentConfig 解析，写入
  `Invocation`；session 只恢复 pi 历史，不校验/不承诺模型一致。
- `workingDirectory` 不可用是环境问题，不静默 fresh 到别处。
- `get_state()` 的 id 校验是最后一道门：文件存在但 id 不一致也不能继续。
- `workingDirectory` 比较使用 realpath/规范化路径；v1 不持久化
  `workspaceFingerprint`。

### 4.3 Fresh 语义

任何 `resume_*` 失败都走 fresh：

1. `consecutiveResumeFailures += 1`。
2. 生成新的 `piSessionId`（`freshPiSessionId(session)`）。
3. 清空 `piSessionFile`；用 `--session-id <newId>` 启动 worker。
4. worker 返回新的 `sessionId/sessionFile` 后重新绑定。
5. 写 `session_resume_degraded` 事件（reason、旧 id、新 id）。

Fresh 不是“静默成功”；必须留下事件，UI/日志能看出这次没接上旧上下文。

### 4.4 连续失败上限

- `MAX_CONSECUTIVE_RESUME_FAILURES = 3`。
- resume 前置检查前，如果 `consecutiveResumeFailures >= 3`：
  - 不尝试 resume；
  - 清空 `piSessionId/piSessionFile`（强制 fresh）；
  - `consecutiveResumeFailures = 0`；
  - 写 `session_resume_circuit_breaker` 事件（action=binding_reset）；
  - 同一轮启动 fresh pi session，继续当前 invocation。
- **不 seal、不新建 codeteam session**；旧 pi 文件保留。
- 成功 completed turn 后 `consecutiveResumeFailures = 0`。

> v1 没有 `sealed`，所以这里不是 Clowder 的 overflow seal；它只是
> “别再撞这个坏绑定”的 binding reset。

## 5. 持久化 schema

R1 重建目标表：

```sql
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,

  pi_session_id TEXT,
  pi_session_file TEXT,
  working_directory TEXT NOT NULL,

  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  consecutive_resume_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_resume_failures >= 0),

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  CHECK ((pi_session_id IS NULL) = (pi_session_file IS NULL)),
  UNIQUE (thread_id, agent_id),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX agent_sessions_pi_session
  ON agent_sessions(pi_session_id)
  WHERE pi_session_id IS NOT NULL;

CREATE INDEX agent_sessions_thread
  ON agent_sessions(thread_id);
CREATE INDEX agent_sessions_agent
  ON agent_sessions(agent_id);
```

> 如果 R1 暂时没有 `agents` 表，`agent_id` 先用应用层校验，不加 FK。

### 5.1 迁移映射

| 旧列 | 新列 | 处置 |
|---|---|---|
| `status = 'active'` 的行 | 迁移 | v1 只有 active；sealed/sealing 行不迁移。 |
| `id/thread_id/pi_session_id/message_count/working_directory/created_at/updated_at` | 同名列 | 直接迁移。 |
| `profile_id` | `agent_id` | 按 AgentConfig id 映射；映射不上 → preflight。 |
| `user_id` | `user_id` | 空值从 task.user_id / thread.created_by 回填；仍不确定 → preflight。 |
| `native_session_binding_json.sessionFile` | `pi_session_file` | 路径合法则迁移；否则置 null，下一轮 fresh。 |
| 无 | `consecutive_resume_failures` | 默认 0。 |
| `provider/model/model_family` | 不迁移 | 由 `Invocation` 记录；`runs` 表已有执行快照。 |
| `status/seal_reason/sealed_at/seq` | 不迁移 | sealed 生命周期/chain 整体 v2；旧行留在 `legacy_agent_sessions`。 |
| `task_id/role/stage_id/effective_tool_policy` | 不迁移 | task-first legacy；旧数据保留只读。 |
| `chain_key/context_health_json/capacity_pin_json/compression_count/cat_handoff_note_json/continuity_capsule_json/latest_resume_session_id/last_usage_json/workspace_fingerprint` | 不迁移 | v2 能力；不把旧值伪装成新语义。 |

迁移前置：

- 只迁移 `status='active'` 的 session；`sealing/sealed` 行保留在
  `legacy_agent_sessions`，v1 runtime 不读。
- 有 running invocation 的 active session 先 drain，等 terminal 再迁移。
- `agentId/userId/workingDirectory` 无法确定的进入 preflight，不静默置空。

## 6. Store / API 契约

```ts
getOrCreateSession({ threadId, agentId, userId, workingDirectory }): AgentSession
bindPiSession(id, { piSessionId, piSessionFile }): AgentSession
replacePiSession(id, { piSessionId, piSessionFile, reason }): AgentSession
recordCompletedTurn(id): AgentSession
recordResumeFailure(id): number
resetResumeFailures(id): AgentSession
getSession(threadId, agentId): AgentSession | null
```

- `getOrCreateSession`：已有行直接返回；没有则创建。`workingDirectory` 必须
  等于 `thread.projectPath`；不一致 → `invalid_input`。
- `bindPiSession`：首次绑定两个值必须同时提供；已绑定且相同 → no-op；不同 →
  必须走 `replacePiSession`（resume failure 专用）。
- `replacePiSession`：只允许在 resume 失败路径调用；更新两个值并写 degraded 事件。
- `recordCompletedTurn`：`messageCount += 1`，`consecutiveResumeFailures = 0`；
  与 invocation terminal 同一事务。
- `recordResumeFailure`：`consecutiveResumeFailures += 1`，返回新值。
- `resetResumeFailures`：清空 pi 绑定 + 计数归零，用于 3 次上限。
- `getSession`：按 `(thread_id, agent_id)` 返回唯一行。
- **没有 `sealSession` / `restoreSession`**；这些是 v2 API。

**代码接线点**：`control/stores/types.ts`（接口收敛）、
`control/stores/sessions.ts`（列映射与新方法）、`control/migrations/001-core.ts`
+ R1（重建表/旧表归档）、`workers/harness.ts`（resume 前置检查/fresh/上限）、
`workers/executor.ts`（completed turn 计数）、`control/read-models.ts`
（只用 `messageCount`）、测试。

> Clowder 的 `messageCount` 细节：首次 user-visible output 会把 0→1
> （unseal safety），`done` 时同一 invocation 不再重复 +1。v1 等价为
> “每个 completed invocation 最多 +1，且只有有 user-visible output 的才算”。

### 6.1 服务分层：Store / WorkerPool / Manager

`AgentSession` 是 durable row，但“拿到 session”和“拿到执行载体”是两件事。v1 分三层，
不把所有职责塞进一个 `SessionManager`：

| 层 | 职责 | 状态 |
|---|---|---|
| `AgentSessionStore` | durable identity：`getActive` / `get` / `create` / `bind` / `replace` / `recordCompletedTurn` / `recordResumeFailure` / `resetResumeFailures` | SQLite |
| `WorkerPool` | ephemeral worker 生命周期：`ensure` / `retire` / `reap` / `heartbeat`；pi v1 一个 worker 只服务一个 session | SQLite `workers` + `worker_bindings` |
| `AgentSessionManager` | 薄 facade：`ensureActive` / `acquireWorker` / `releaseWorker` / `reset`；组合前两层 | 无自有状态 |

- `TurnExecution.agentSessionId` 只是指针；session 解析在
  `AgentSessionManager.ensureActive(threadId, agentId)`，不在 child 里重复查映射。
- worker 是 **ephemeral execution carrier**，不是 session 的常驻所有者：
  turn 结束默认 retire（`warmTtl=0`），空闲 session 不占进程；`maxLiveWorkers=8`
  只限制同时存在的 worker。
- 执行互斥不靠 per-turn `worker_leases` 表：`TurnExecution` 的唯一 running per session
  + `RpcConnection.prompting` + `worker_bindings.generation` 承担。
- `worker_id` / `worker_binding_state` 迁到 `worker_bindings`（§2.1），不写回
  AgentSession identity。
- 与 Clowder 的差异：Clowder `SessionManager` 只维护
  `(user, cat, thread) → sessionId` 映射；codeteam 的 session row 本身含
  `threadId + agentId`，`getActive` 就是映射，因此不另建映射表；多出来的是
  durable session 状态 + 短命 worker attachment。

## 7. 事件

写现有 `thread_events`，不新增事件表；`audit` 是 task-first legacy，不用于 A2A/session
contract：

| 事件 | 关键字段 |
|---|---|
| `session_created` | sessionId, threadId, agentId |
| `session_pi_bound` | sessionId, piSessionId, piSessionFile |
| `session_resumed` | sessionId, piSessionId |
| `session_resume_degraded` | sessionId, reason, previousPiSessionId, newPiSessionId |
| `session_resume_circuit_breaker` | sessionId, action=binding_reset, failures |
| `session_turn_completed` | sessionId, messageCount |

没有 `session_sealed`；v1 不 seal。

## 8. 验收标准

**Schema / Store**

- 同一 `(thread, agent)` 只有一行；重复 `getOrCreateSession` 返回同一行。
- `piSessionId` 非空时全局唯一。
- `piSessionId/piSessionFile` 同时为空或同时非空。
- `workingDirectory` 必须等于 `thread.projectPath`；不一致 → `invalid_input`。
- `messageCount`：一次 invocation 内多条 message/rich block 只 +1；无
  user-visible output 不 +1；同一 invocation 的 `done` 不重复 +1。
- `bindPiSession` 不能覆盖已绑定值；`replacePiSession` 只能走 resume failure。
- v1 没有 seal/restore API。

**Resume**

- 文件存在、id 一致 → reattached；`piSessionId` 不变。
- 文件缺失 / 越界 / 绑定不完整 / id 不一致 → fresh + 对应事件 + 计数 +1。
- `workingDirectory` 不存在 → typed error `workspace_unavailable`，不 fresh 到别处。
- 连续 3 次失败 → 强制 fresh、清空绑定、计数归零；不 seal、不新建 session。
- 成功 completed turn → 计数归零。
- daemon 重启后能 resume；没有 sealed/restore 路径可测。

**Migration**

- 只迁移 active session；sealing/sealed 行留在 `legacy_agent_sessions`。
- 有 running invocation 的 active session 先 drain。
- `agentId/userId/workingDirectory` 无法确定的进入 preflight。
- v2 列不迁移；不存在“旧值伪装成新语义”。

## 9. 明确推迟到 v2

| v2 能力 | 对应字段/能力 | 为什么不在 v1 |
|---|---|---|
| sealed 生命周期 / restore | `status`、`sealReason`、`sealedAt`、`restoreActiveSession` | v1 只做 A2A runtime，快速真实模型 E2E，不要求长 session。 |
| session chain | `seq` | v1 一个 thread×agent 一行，没有链。 |
| workspace 迁移/重置 | `session_workspace_changed` 的 reset/rebind | v1 的 `workingDirectory` 不可变；换工作区是 v2 显式操作。 |
| context health / 自动 seal | `contextHealth`、`capacityPin` | 需要 provider 容量上报、fillRatio、seal 策略。 |
| usage / 成本展示 | `lastUsage` | 不影响 resume；可以先用 invocation usage 现算。 |
| compression / hybrid | `compressionCount`、`compressionObservation`、`appliedPolicy`、`hybridProgress` | 需要策略引擎和 provider 压缩信号。 |
| handoff / continuity | `catHandoffNote`、`continuityCapsule` | 是跨 session 连续性能力。 |
| external import | `externalImport` | 需要 CLI 导入 UX、project match、冲突处理。 |
| scoped execution | `scopedInvocation` | v1 没有 collective/scoped execution。 |
| bg carrier | `latestResumeSessionId`、`chainKey` | pi session id 稳定，不需要每轮 fork 指针。 |

## 10. 决策记录

1. **`agentId` 改名**：`profile_id -> agent_id`；旧 profileId 只做迁移映射。
2. **`messageCount` 对齐 Clowder**：每个有 user-visible output 的 completed invocation +1；不是原始 message 行数。
3. **v1 只有 active**：`sealing/sealed/sealReason/sealedAt/seq/restore` 全部 v2；原因是 v1 只做 A2A runtime，验收要求快速真实模型 E2E，不要求长 session。
4. **模型快照移到 `Invocation`**：`provider/model/modelFamily` 不在 `AgentSession`；模型变更不要求换 session。
5. **`nativeSessionBinding` 扁平化**：v1 用 `piSessionId + piSessionFile`；Clowder 的 binding 是 AGY 专用，pi 不需要。
6. **`workspaceFingerprint` 不持久化**：v1 的 `workingDirectory` required 且不可变，resume 时直接比较规范化路径。
7. **连续 3 次 resume 失败**：强制 fresh、清空绑定、计数归零；不 seal、不新建 codeteam session。
8. **工作区变化**：`workingDirectory` 不可变；thread.projectPath 变化时 typed reject `session_workspace_changed`；重置/迁移是 v2。
9. **Worker v1 = ephemeral execution carrier（2026-11-10 拍板）**：
   `WorkerPool` 管短命 worker（`warmTtl=0`、`maxLiveWorkers=8`、一个 worker 只服务
   一个 session）；session 不持有 worker；执行互斥由 `TurnExecution` 唯一 running +
   `RpcConnection.prompting` + binding generation 承担。spawn 实测约 0.5s，不作为常驻理由。
