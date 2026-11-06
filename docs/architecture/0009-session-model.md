---
title: "codeteam AgentSession v1 — basics + resume"
doc_kind: architecture
status: draft-for-review
created: 2026-11-06
updated: 2026-11-06
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_direction: "2026-11-06: v1 session 只做基础和 resume 相关特性；context/compression/handoff/import/scoped 全部放 v2"
operator_decisions: "2026-11-06: agentId rename confirmed; messageCount aligns with Clowder; circuit breaker 3; sealed restore deferred to v2; provider/model/modelFamily move to Invocation"
related_features: [codeteam/F018, codeteam/F017]
---

# codeteam AgentSession v1

> v1 的 `AgentSession` 只回答四个问题：**这是谁、在哪个工作区、对应哪个 pi session、现在是什么生命周期**。
> context 容量、压缩、handoff、导入、scoped execution 等全部推迟到 v2；v1 不预埋字段。

## 0. 结论先行

1. **v1 只保留 15 个字段**：身份 6、resume 3、基础计数 2、生命周期 4。
2. **不再保留通用 `nativeSessionBinding` 对象**。v1 只有 pi 一个 native backend，扁平 `piSessionId + piSessionFile` 就够；版本化 binding 留给 v2。
3. **`sealed` 状态保留为终态**；sealed → active 的 restore 放 v2。resume 只针对 `active` session 在 worker/daemon 重启后的续接。
4. **resume 失败必须可解释**：文件缺失、id 不一致、绑定不完整都走 fresh，并写事件；连续 3 次失败熔断 seal，同一轮新建 session 继续当前 invocation。
5. **session 不持有模型快照**：`provider/model/modelFamily` 属于 `Invocation`，每轮从 AgentConfig 解析；session 只绑定 `workingDirectory` 和 pi 历史。

## 1. 目标与非目标

**v1 目标**

- 一个 `(thread_id, agent_id)` 同时最多一个 live session（`active` 或 `sealing`）。
- worker/daemon 重启后能 resume 原来的 pi session，不丢上下文。
- 不能 resume 时安全 fresh：不静默失忆、不用错工作区、不把旧文件当新 session。
- 连续 resume 失败有熔断，避免死循环。
- 生命周期、seal reason、基础计数可读、可审计。
- 旧 task-first `agent_sessions` 有明确迁移处置，不把 task/custody 字段带进新 runtime。

**v1 不做**

- context health / capacity pin / last usage / 自动 seal；
- compression / applied policy / hybrid progress；
- handoff note / continuity capsule；
- external import / scoped invocation；
- bg carrier 的 `latestResumeSessionId` / `chainKey`；
- sealed session 的 restore；
- task-first 的 `taskId` / `role` / `stageId` / `effectiveToolPolicy`。

## 2. 最终接口

```ts
export type SessionStatus = "active" | "sealing" | "sealed";

export type SessionSealReason =
  | "manual"
  | "resume_circuit_breaker"
  | "error"
  | (string & {}); // legacy / forward-compatible

export interface AgentSession {
  // 身份
  id: string;
  threadId: string;
  agentId: string;
  userId: string;
  seq: number;
  status: SessionStatus;

  // resume
  piSessionId: string | null;
  piSessionFile: string | null;
  workingDirectory: string;

  // 基础计数
  messageCount: number;              // Clowder 语义：每个有 user-visible output 的 completed invocation +1
  consecutiveResumeFailures: number; // 连续 resume 失败次数，成功 turn 后归零

  // 生命周期
  sealReason: SessionSealReason | null;
  createdAt: number;
  updatedAt: number;
  sealedAt: number | null;
}
```

| 字段 | 为什么在 v1 |
|---|---|
| `id/threadId/agentId/userId/seq/status` | session 的身份坐标与生命周期；一个 thread×agent 一个 live session。 |
| `messageCount` | 对齐 Clowder：每个有 user-visible output 的 completed invocation +1；不是原始 message 行数。 |
| `piSessionId` | pi 的 session 身份；resume 后必须和 `get_state().sessionId` 一致。 |
| `piSessionFile` | pi 的 JSONL 文件路径；显式 resume 目标，文件缺失时能安全 fresh。 |
| `workingDirectory` | session 的实际工作区；必须等于创建时的 `thread.projectPath`。 |
| `consecutiveResumeFailures` | resume 熔断；没有它坏 session 会反复重试。 |
| `sealReason/sealedAt` | 生命周期审计；sealed 必须能回答“为什么”。 |
| `createdAt/updatedAt` | 基础时间戳。 |

### 2.1 与当前 `AgentSession` 的差异

| 当前字段 | v1 处置 | 原因 |
|---|---|---|
| `task_id` / `role` / `stage_id` | 删除 | task-first legacy；v1 session 不绑 task。 |
| `profile_id` | 改名 `agent_id` | 统一 AgentConfig 的 `agentId`。 |
| `provider` / `model` / `model_family` | 移到 `Invocation` | 模型是每轮执行快照，不是 session 身份；0005 的 `Invocation` 已记录。 |
| `effective_tool_policy` | 删除 | 工具策略归 pi 执行层。 |
| `chain_key` | 删除 | 没有 bg carrier；pi session id 稳定。 |
| `native_session_binding_json` | 拆成 `pi_session_id` + `pi_session_file` | v1 只有一个 native backend。 |
| `context_health_json` / `capacity_pin_json` | 删除（v2） | context 管理是 v2。 |
| `cat_handoff_note_json` / `continuity_capsule_json` | 删除（v2） | handoff/continuity 是 v2。 |
| `compression_count` / `latest_resume_session_id` | 删除（v2） | compression / bg carrier 是 v2。 |
| `last_usage_json` | 删除（v2） | usage 展示是 v2。 |
| `workspace_fingerprint` | 删除 | v1 直接比较规范化后的 `workingDirectory`。 |
| `worker_id` / `worker_binding_state` | 留在 worker 层 | 是 worker runtime 状态，不是 session identity。 |
| `message_count` / `seal_reason` / `working_directory` / `user_id` | 保留 | 基础字段。 |

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

## 3. 状态机与不变量

```text
active ──seal()──▶ sealing ──finalize──▶ sealed
   │                                      （终态）
   └── worker/daemon 重启 ──▶ 仍为 active，重新 resume pi session
```

1. 同一 `(thread_id, agent_id)` 最多一个 `active` 或 `sealing` session。
2. `sealed` 必须有 `sealedAt` 和 `sealReason`；`active` 时两者都为空；`sealing` 允许有 `sealReason`，但 `sealedAt` 必须为空。
3. `piSessionId` 与 `piSessionFile` 必须同时为空或同时非空。
4. `piSessionId` 非空时全局唯一。
5. `workingDirectory` 非空且在 session 生命周期内不可变；`provider/model/modelFamily` 由 `Invocation` 记录，不属于 session。
6. `sealed` 是终态；v1 没有 `sealed -> active`。
7. `sealing` 是 crash-recovery 中间态；正常 seal 可以在一事务内完成 `active -> sealed`。
8. seal 不删除 `piSessionFile`；文件保留用于审计/回忆，清理是单独的 retention 策略。

## 4. Resume 契约

### 4.1 首次绑定

worker 首次成功启动后，从 `get_state()` 读取 `sessionId` 和 `sessionFile`，在同一事务写入：

```ts
piSessionId = state.sessionId
piSessionFile = state.sessionFile
messageCount = 0
consecutiveResumeFailures = 0
```

- 两个值必须同时存在；缺一个视为绑定失败，session 保持 active 但 `piSessionId/piSessionFile` 仍为 null，下一轮重试。
- `piSessionFile` 必须位于 codeteam 的 `sessionDir` 下；越界拒绝绑定。

### 4.2 Resume 前置检查

| 检查 | 失败动作 | reason |
|---|---|---|
| `status = active` | 拒绝启动 | `session_not_active` |
| `piSessionId` 和 `piSessionFile` 都非空 | fresh | `resume_binding_incomplete` |
| `piSessionFile` 存在 | fresh | `resume_file_missing` |
| 文件路径在 `sessionDir` 内 | fresh | `resume_file_outside_root` |
| `workingDirectory` 存在且可访问 | typed error，不 fresh | `workspace_unavailable` |
| `get_state().sessionId === piSessionId` | fresh | `resume_id_changed` |

- `provider/model/modelFamily` 在 invocation 层从 AgentConfig 解析，写入 `Invocation`；session 只恢复 pi 历史，不校验/不承诺模型一致。
- `workingDirectory` 不可用是环境问题，不静默 fresh 到别处。
- `get_state()` 的 id 校验是最后一道门：文件存在但 id 不一致也不能继续。
- `workingDirectory` 比较使用 realpath/规范化路径；v1 不持久化 `workspaceFingerprint`。

### 4.3 Fresh 语义

任何 `resume_*` 失败都走 fresh：

1. `consecutiveResumeFailures += 1`。
2. 生成新的 `piSessionId`（`freshPiSessionId(session)`）。
3. 清空 `piSessionFile`；用 `--session-id <newId>` 启动 worker。
4. worker 返回新的 `sessionId/sessionFile` 后重新绑定。
5. 写 `session_resume_degraded` 事件（reason、旧 id、新 id）。

Fresh 不是“静默成功”；必须留下事件，UI/日志能看出这次没接上旧上下文。

### 4.4 熔断

- `MAX_CONSECUTIVE_RESUME_FAILURES = 3`。
- resume 前置检查前，如果 `consecutiveResumeFailures >= 3`：
  - 不尝试 resume；
  - seal 当前 session，`sealReason = "resume_circuit_breaker"`；
  - 写 `session_resume_circuit_breaker` 事件；
  - 同一轮由 dispatcher 为该 `(thread, agent)` 新建 session（`seq + 1`）并继续当前 invocation，避免丢消息。
- 成功 completed turn 后 `consecutiveResumeFailures = 0`；新 session 从 0 开始。

> `sealing` 是短事务/恢复态。新 invocation 遇到 `sealing` 时先 finalize 或返回
> `session_sealing` typed reject，不能强行新建第二个 live session。

## 5. 持久化 schema

R1 重建目标表：

```sql
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'sealing', 'sealed')),

  pi_session_id TEXT,
  pi_session_file TEXT,
  working_directory TEXT NOT NULL,

  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  consecutive_resume_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_resume_failures >= 0),

  seal_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sealed_at INTEGER,

  CHECK (status <> 'sealed' OR (sealed_at IS NOT NULL AND seal_reason IS NOT NULL)),
  CHECK (status = 'sealed' OR sealed_at IS NULL),
  CHECK (status <> 'active' OR seal_reason IS NULL),
  CHECK ((pi_session_id IS NULL) = (pi_session_file IS NULL)),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX agent_sessions_one_live
  ON agent_sessions(thread_id, agent_id)
  WHERE status IN ('active', 'sealing');

CREATE UNIQUE INDEX agent_sessions_pi_session
  ON agent_sessions(pi_session_id)
  WHERE pi_session_id IS NOT NULL;

CREATE INDEX agent_sessions_thread_status
  ON agent_sessions(thread_id, status);
CREATE INDEX agent_sessions_agent_status
  ON agent_sessions(agent_id, status);
```

> 如果 R1 暂时没有 `agents` 表，`agent_id` 先用应用层校验，不加 FK。

### 5.1 迁移映射

| 旧列 | 新列 | 处置 |
|---|---|---|
| `id/thread_id/seq/status/pi_session_id/message_count/seal_reason/created_at/updated_at/sealed_at` | 同名列 | 直接迁移。 |
| `profile_id` | `agent_id` | 按 AgentConfig id 映射；映射不上 → preflight。 |
| `provider/model/model_family` | 不迁移 | 由 `Invocation` 记录；`runs` 表已有执行快照。 |
| `user_id` | `user_id` | 空值从 task.user_id / thread.created_by 回填；仍不确定 → preflight。 |
| `native_session_binding_json.sessionFile` | `pi_session_file` | 路径合法则迁移；否则置 null，下一轮 fresh。 |
| `working_directory` | `working_directory` | 空值从 task.worktree / thread.repo 回填；无法确定 → preflight。 |
| 无 | `consecutive_resume_failures` | 默认 0。 |
| `task_id/role/stage_id/effective_tool_policy` | 不迁移 | task-first legacy；旧数据保留 `legacy_agent_sessions` 只读。 |
| `chain_key/context_health_json/capacity_pin_json/compression_count/cat_handoff_note_json/continuity_capsule_json/latest_resume_session_id/last_usage_json/workspace_fingerprint` | 不迁移 | v2 能力；不把旧值伪装成新语义。 |

迁移前置：running invocation 的 session 先 drain/seal；`agentId/userId/workingDirectory` 无法确定的进入 preflight，不静默置空。

## 6. Store / API 契约

```ts
createSession({ threadId, agentId, userId, workingDirectory }): AgentSession
```

- `seq = max(seq) + 1`（同一 thread×agent）；已有 live session → `conflict`。
- `workingDirectory` 必须等于 `thread.projectPath`；不一致 → `invalid_input`。

```ts
bindPiSession(id, { piSessionId, piSessionFile }): AgentSession
replacePiSession(id, { piSessionId, piSessionFile, reason }): AgentSession
recordCompletedTurn(id): AgentSession
recordResumeFailure(id): number
sealSession(id, { reason }): AgentSession
getActiveSession(threadId, agentId): AgentSession | null
```

- `bindPiSession`：只在 active 时允许；首次绑定两个值必须同时提供；已绑定且相同 → no-op；不同 → 必须走 `replacePiSession`（resume failure 专用）。
- `replacePiSession`：只允许在 resume 失败路径调用；更新两个值并写 degraded 事件。
- `recordCompletedTurn`：`messageCount += 1`，`consecutiveResumeFailures = 0`；与 invocation terminal 同一事务。
- `sealSession`：`active/sealing -> sealed`；重复 seal → `invalid_state`。
- `getActiveSession`：只返回 `active`；`sealing` 由 recovery 处理。

**代码接线点**：`control/stores/types.ts`（接口收敛）、`control/stores/sessions.ts`（列映射与新方法）、`control/migrations/001-core.ts` + R1（重建表/旧表归档）、`workers/harness.ts`（resume 前置检查/fresh/熔断）、`workers/executor.ts`（completed turn 计数）、`control/read-models.ts`（只用 `messageCount`）、测试。

> Clowder 的 `messageCount` 细节：首次 user-visible output 会把 0→1
> （unseal safety），`done` 时同一 invocation 不再重复 +1。v1 等价为
> “每个 completed invocation 最多 +1，且只有有 user-visible output 的才算”。

## 7. 事件

写现有 `thread_events`/audit，不新增事件表：

| 事件 | 关键字段 |
|---|---|
| `session_created` | sessionId, threadId, agentId, seq |
| `session_pi_bound` | sessionId, piSessionId, piSessionFile |
| `session_resumed` | sessionId, piSessionId |
| `session_resume_degraded` | sessionId, reason, previousPiSessionId, newPiSessionId |
| `session_resume_circuit_breaker` | sessionId, failures |
| `session_sealed` | sessionId, reason |
| `session_turn_completed` | sessionId, messageCount |

`degradedReason` 这类可变诊断不进入 session 行，用事件表达。

## 8. 验收标准

**Schema / Store**

- 同一 `(thread, agent)` 第二个 live session 被唯一索引拒绝。
- `piSessionId` 非空时全局唯一。
- `sealed` 必须有 `sealedAt + sealReason`；`active` 两者为空；`sealing` 允许有 `sealReason`、`sealedAt` 为空。
- `piSessionId/piSessionFile` 同时为空或同时非空。
- `createSession` 的 `seq` 单调递增；`workingDirectory` 必须等于 `thread.projectPath`。
- `messageCount`：一次 invocation 内多条 message/rich block 只 +1；无 user-visible output 不 +1；同一 invocation 的 `done` 不重复 +1（对齐 Clowder）。
- `bindPiSession` 不能覆盖已绑定值；`replacePiSession` 只能走 resume failure。
- `sealSession` 重复调用返回 `invalid_state`。

**Resume**

- 文件存在、id 一致 → reattached；`piSessionId` 不变。
- 文件缺失 / 越界 / 绑定不完整 / id 不一致 → fresh + 对应事件 + 计数 +1。
- `workingDirectory` 不存在 → typed error `workspace_unavailable`，不 fresh 到别处。
- 连续 3 次失败 → seal `resume_circuit_breaker`；同一轮新建 session `seq+1` 继续当前 invocation。
- 成功 completed turn → 计数归零。
- daemon 重启后 active session 能 resume；sealed session 不会被 restore。

**Migration**

- running invocation 的 session 不被迁移；等 terminal。
- `agentId/userId/workingDirectory` 无法确定的进入 preflight。
- 旧 task-first 行保留在 `legacy_agent_sessions`，新 runtime 不读。
- v2 列不迁移；不存在“旧值伪装成新语义”。

## 9. 明确推迟到 v2

| v2 能力 | 对应 Clowder 字段 | 为什么不在 v1 |
|---|---|---|
| context health / 自动 seal | `contextHealth`、`capacityPin` | 需要 provider 容量上报、fillRatio、seal 策略。 |
| usage / 成本展示 | `lastUsage` | 不影响 resume；可以先用 invocation usage 现算。 |
| compression / hybrid | `compressionCount`、`compressionObservation`、`appliedPolicy`、`hybridProgress` | 需要策略引擎和 provider 压缩信号。 |
| handoff / continuity | `catHandoffNote`、`continuityCapsule` | 是跨 session 连续性能力。 |
| external import | `externalImport` | 需要 CLI 导入 UX、project match、冲突处理。 |
| scoped execution | `scopedInvocation` | v1 没有 collective/scoped execution。 |
| bg carrier | `latestResumeSessionId`、`chainKey` | pi session id 稳定，不需要每轮 fork 指针。 |
| sealed restore | Clowder `restoreActiveSession` | v1 把 sealed 当终态；恢复旧 session 是 v2 显式能力。 |

## 10. 决策状态

### 10.1 本轮已确认

1. **`agentId` 改名**：`profile_id -> agent_id`；旧 profileId 只做迁移映射。
2. **`messageCount` 对齐 Clowder 语义**：每个有 user-visible output 的 completed invocation +1；不是原始 message 行数，也不改名。
3. **熔断阈值 3 次**：熔断后 seal 当前 session、同一轮新建并继续当前 invocation。
4. **模型快照移到 `Invocation`**：`provider/model/modelFamily` 不再进入 `AgentSession`；模型变更不要求 seal，下一轮 invocation 记录新模型并继续 pi 历史。
5. **`sealed` 状态保留为终态，restore 放 v2**：v1 不做 sealed → active。

### 10.2 仍需确认

1. **`nativeSessionBinding` 扁平化**：Clowder 的 binding 是 AGY 专用（`agy_stream_json/agy_acp`），不是通用 CLI binding；建议 v1 用 `piSessionId + piSessionFile`，不再保留通用 binding 对象。
2. **`workspaceFingerprint`**：Clowder 持久化它作为 resume 比较键，但当前实现只是规范化路径；建议 v1 不持久化，resume 时直接比较规范化后的 `workingDirectory`。
3. **`sealed` 的理解**：本文按“sealed 状态保留、sealed→active restore 放 v2”落；如果你的意思是连 `sealed` 状态也整个移到 v2，那 v1 只剩 `active`，需要再砍 `status/sealReason/sealedAt`，请明确。
