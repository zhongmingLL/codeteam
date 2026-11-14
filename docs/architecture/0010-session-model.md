---
title: "codeteam AgentSession v1 — active + lightweight seal"
doc_kind: architecture
status: accepted
created: 2026-11-06
updated: 2026-11-11
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_signoff: "confirmed 2026-11-06; 2026-11-11: lightweight seal + Clowder messageCount confirmed"
operator_direction: "2026-11-06: v1 只做 A2A runtime，验收要求快速真实模型 E2E，不要求长 session。2026-11-11: v1 做 lightweight seal；full seal/transcript/digest/restore/chain navigation 仍放 v2。"
operator_decisions: "2026-11-06: agentId rename confirmed; nativeSessionBinding flattened to piSessionId+piSessionFile; workspaceFingerprint not persisted; provider/model/modelFamily move to Invocation. 2026-11-11: lightweight seal confirmed; messageCount counts no-output completed turns too; AgentState is a per-thread projection, not session-owned."
related_features: [codeteam/F018, codeteam/F017]
---

# codeteam AgentSession v1

> v1 的 `AgentSession` 是 **active + lightweight seal** 的轻量绑定：一个
> `(thread, agent)` 同时只有一行 active，记录 pi session 文件、工作区、基础计数，
> 以及 `seq/status/sealReason/sealedAt`。v1 支持 `active → sealed` 和“旧行封存 +
> 新行 seq+1”，但不做 transcript/digest、restore UI、session chain 导航。
>
> 原因：v1 只做 A2A runtime，验收要求快速真实模型 E2E；完整 seal/restore/chain
> 生命周期不是 v1 的验收对象。lightweight seal 只保留“旧行封存 + 新行接续”的形状，
> 避免 v2 重建表；它不等于 Clowder 的 full seal。

## 0. 结论先行

1. **v1 字段按身份 / resume / 计数 / 轻量生命周期 / 时间戳分组**；不引入
   compression、handoff、context health 等 v2 字段。
2. **v1 是 active + lightweight sealed**：保留 `status` / `seq` / `sealReason` /
   `sealedAt`；一个 `(thread_id, agent_id)` 同时只有一行 active，sealed 行保留并
   通过 `seq+1` 接续。
3. **不再保留通用 `nativeSessionBinding`**：v1 只有 pi 一个 backend，直接存
   `piSessionId + piSessionFile`。
4. **resume 失败走 fresh**：文件缺失、越界、绑定不完整、id 不一致都 fresh；
   连续 3 次失败或显式 `fresh` 时 lightweight seal 旧行并新建 `seq+1` active 行；
   单次 resume 失败只在同一 session 行内重建 pi 绑定。
5. **模型属于 Invocation**：`provider/model/modelFamily` 不在 session；每轮从
   AgentConfig/AccountConfig 解析，写入 Invocation。模型变更不要求换 session。
6. **工作区属于 session**：`workingDirectory` 必填且不可变；thread.projectPath
   变化时 typed reject `session_workspace_changed`，静默换目录不做。

## 1. 目标与非目标

**v1 目标**

- 一个 `(thread_id, agent_id)` 同时一行 active session，首次 invocation 创建，后续复用；
  lightweight seal 后新行 `seq+1` 接续。
- worker/daemon 重启后 resume 原来的 pi session 文件。
- 不能 resume 时安全 fresh，并写事件；不静默失忆、不用错工作区。
- 连续 resume 失败有上限，避免反复撞同一个坏文件。
- 基础计数可读：`messageCount`、`consecutiveResumeFailures`。
- 连续 resume 失败或显式 fresh 时 lightweight seal：旧行 `sealed`、新行 `seq+1`，
  旧 pi 文件保留用于审计/回忆。
- 旧 task-first `agent_sessions` 有明确迁移处置。

**v1 不做**

- `sealing` 中间态（枚举保留，v1 直接 `active → sealed`）；
- transcript/digest、restore UI、session chain 导航 / 跨 session 历史恢复；
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

  // 轻量生命周期
  seq: number;                       // 同一 (thread, agent) 内的链序号；首次 0
  status: "active" | "sealing" | "sealed";
  sealReason: string | null;
  sealedAt: number | null;

  // resume
  piSessionId: string | null;
  piSessionFile: string | null;
  workingDirectory: string;

  // 基础计数
  messageCount: number;              // Clowder 语义：首次可见输出 0→1；done 时本 turn 未计数则 +1（无输出也 +1）
  consecutiveResumeFailures: number; // 连续 resume 失败次数，成功 turn 后归零
  lastCountedTurnExecutionId: string | null; // durable 去重：本 turn 是否已计数

  // 时间戳
  createdAt: number;
  updatedAt: number;
}
```

| 字段 | 为什么在 v1 |
|---|---|
| `id/threadId/agentId/userId` | session 的身份坐标；一个 thread×agent 同时只有一行 active；`userId` 必须等于 `thread.created_by`，不是第二 owner（0011 §11）。 |
| `seq/status/sealReason/sealedAt` | lightweight seal 的最小形状：`active → sealed`，旧行保留，新行 `seq+1`；v1 不写 `sealing`，也不做 transcript/digest/restore。 |
| `piSessionId` | pi 的 session 身份；resume 后必须和 `get_state().sessionId` 一致。 |
| `piSessionFile` | pi 的 JSONL 文件路径；显式 resume 目标，文件缺失时能安全 fresh。 |
| `workingDirectory` | session 的实际工作区；必须等于创建时的 `thread.projectPath`。 |
| `messageCount` | 对齐 Clowder：首次可见输出 0→1；`done` 时本 turn 未计数则 +1；无可见输出的 completed turn 也 +1；不是原始 message 行数。 |
| `consecutiveResumeFailures` | 连续 resume 失败计数；3 次后强制 fresh 并重置，避免撞坏文件。 |
| `lastCountedTurnExecutionId` | durable 去重键；防止“首次输出已 0→1，done 又 +1”，以及 crash 后 double count。 |
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
| `status` / `seal_reason` / `sealed_at` | 保留 | v1 做 lightweight seal；只封存状态与 lineage，不做 transcript/digest/restore。 |
| `seq` | 保留 | `(thread_id, agent_id, seq)` 唯一；v1 只用于 lightweight seal 接续，不做 chain 导航。 |
| `context_health_json` / `capacity_pin_json` | 删除（v2） | context 管理是 v2。 |
| `cat_handoff_note_json` / `continuity_capsule_json` | 删除（v2） | handoff/continuity 是 v2。 |
| `compression_count` / `latest_resume_session_id` | 删除（v2） | compression / bg carrier 是 v2。 |
| `last_usage_json` | 删除（v2） | usage 展示是 v2。 |
| `workspace_fingerprint` | 删除 | v1 直接比较规范化后的 `workingDirectory`。 |
| `worker_id` / `worker_binding_state` | 迁到 `worker_bindings` | worker attachment 是运行时状态，不是 session identity；session 行不再持有 worker。 |
| `message_count` / `working_directory` / `user_id` | 保留 | 基础字段。 |
| 无 | `last_counted_turn_execution_id` | 新增；Clowder 用 turn 内标记去重，codeteam 落成 durable 列。 |

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

1. 同一 `(thread_id, agent_id)` 同时只有一行 `status='active'`；partial unique index 保证；
   `UNIQUE(thread_id, agent_id, seq)` 保留 sealed 链。
2. `piSessionId` 与 `piSessionFile` 必须同时为空或同时非空。
3. `piSessionId` 非空时全局唯一。
4. `workingDirectory` 非空且不可变；必须等于创建时的 `thread.projectPath`。
5. `provider/model/modelFamily` 由 `Invocation` 记录，不属于 session。
6. v1 生命周期只有 `active → sealed`（lightweight）；`sealing` 枚举保留但 v1 不写。
7. v1 不删除 session 行，也不删除 `piSessionFile`；sealed 行和文件保留用于审计/回忆。

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

单次 `resume_*` 失败走同一 session 行内的 fresh；连续 3 次或显式
`reset(reason='fresh')` 才 lightweight seal 旧行 + 新行 `seq+1`：

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
  - 通过 `AgentSessionManager.reset(reason='resume_failures')`：
    lightweight seal 旧行（`status='sealed'`、`seal_reason='resume_circuit_breaker'`、
    `sealed_at=now`），新建 `seq+1` active 行，并把该 agent 的 `deliveryCursor`
    rewind 到 `max(0, tailSeq - BOOTSTRAP_WINDOW)`；
  - 写 `session_sealed` + `session_resume_circuit_breaker` 事件；
  - 同一轮在新 active session 上 fresh 启动 pi session，继续当前 invocation。
- **不删除旧行/旧 pi 文件**；lightweight seal 只封存状态和 lineage。
- 成功 completed turn 后 `consecutiveResumeFailures = 0`。

> 这不是 Clowder 的 full seal：v1 不生成 transcript/digest，不做 restore，
> 也不做 chain UI；只保证“旧行 sealed + 新行 seq+1”的 durable 形状。

## 5. 持久化 schema

R1 重建目标表：

```sql
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,

  seq INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'sealing', 'sealed')),
  seal_reason TEXT,
  sealed_at INTEGER,

  pi_session_id TEXT,
  pi_session_file TEXT,
  working_directory TEXT NOT NULL,

  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  last_counted_turn_execution_id TEXT,
  consecutive_resume_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_resume_failures >= 0),

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  CHECK ((pi_session_id IS NULL) = (pi_session_file IS NULL)),
  CHECK (status <> 'sealed' OR sealed_at IS NOT NULL),
  CHECK (status = 'active' OR seal_reason IS NOT NULL),
  CHECK (status <> 'active' OR sealed_at IS NULL),
  UNIQUE (thread_id, agent_id, seq),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX agent_sessions_one_active
  ON agent_sessions(thread_id, agent_id)
  WHERE status = 'active';

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
| `status = 'active'` 的行 | 迁移 | `seq=0`、`status='active'`；旧的 sealed/sealing 行留在 legacy，不伪造 chain。 |
| `id/thread_id/pi_session_id/message_count/working_directory/created_at/updated_at` | 同名列 | 直接迁移。 |
| `status/seal_reason/sealed_at` | `status/seal_reason/sealed_at` | active 行写 `status='active'`、其余 NULL；旧 sealed 行不迁移。 |
| `seq` | `seq` | active 行统一写 0；没有可靠旧链时从 0 重新开始。 |
| `profile_id` | `agent_id` | 按 AgentConfig id 映射；映射不上 → preflight。 |
| `user_id` | `user_id` | 空值从 task.user_id / thread.created_by 回填；仍不确定 → preflight。 |
| `native_session_binding_json.sessionFile` | `pi_session_file` | 路径合法则迁移；否则置 null，下一轮 fresh。 |
| 无 | `consecutive_resume_failures` | 默认 0。 |
| 无 | `last_counted_turn_execution_id` | 默认 NULL；首个 completed turn 重新计数。 |
| `provider/model/model_family` | 不迁移 | 由 `Invocation` 记录；`runs` 表已有执行快照。 |
| `status/seal_reason/sealed_at/seq`（sealed/sealing 行） | 不迁移 | v1 不读旧 sealed 行；旧数据留在 `legacy_agent_sessions`，不伪造新 chain。 |
| `task_id/role/stage_id/effective_tool_policy` | 不迁移 | task-first legacy；旧数据保留只读。 |
| `chain_key/context_health_json/capacity_pin_json/compression_count/cat_handoff_note_json/continuity_capsule_json/latest_resume_session_id/last_usage_json/workspace_fingerprint` | 不迁移 | v2 能力；不把旧值伪装成新语义。 |

迁移前置：

- 只迁移 `status='active'` 的 session；`sealing/sealed` 行保留在
  `legacy_agent_sessions`，v1 runtime 不读。
- 有 running invocation 的 active session 先 drain，等 terminal 再迁移。
- `agentId/userId/workingDirectory` 无法确定的进入 preflight，不静默置空。

## 6. Store / API 契约

`AgentSessionStore` 是 session 的唯一持久化入口；方法按 turn 生命周期分组，不把
history、worker、credential 塞进同一个接口。

```ts
interface AgentSessionStore {
  getActive(threadId: string, agentId: string): AgentSession | null;
  get(id: string): AgentSession | null;

  create(input: {
    threadId: string;
    agentId: string;
    userId: string;
    workingDirectory: string;
    now: number;
  }): AgentSession;

  bindPiSession(id: string, input: {
    piSessionId: string;
    piSessionFile: string;
    now: number;
  }): AgentSession;

  replacePiSession(id: string, input: {
    piSessionId: string | null;
    piSessionFile: string | null;
    now: number;
  }): AgentSession;

  recordUserVisibleOutput(id: string, turnExecutionId: string, now: number): AgentSession;
  recordCompletedTurn(id: string, input: {
    turnExecutionId: string;
    userVisibleOutput: boolean;
    now: number;
  }): AgentSession;
  recordResumeFailure(id: string, now: number): { session: AgentSession; failures: number };
  resetResumeFailures(id: string, now: number): AgentSession;

  sealActive(id: string, reason: string, now: number): AgentSession;
  createNextActive(input: {
    threadId: string;
    agentId: string;
    userId: string;
    workingDirectory: string;
    now: number;
  }): AgentSession;
}
```

- `getActive`：只返回 `status='active'` 的行；partial unique index 保证一个
  `(thread_id, agent_id)` 同时最多一行 active。
- `create`：`userId = thread.created_by`，`workingDirectory = canonical(thread.projectPath)`；
  `seq = COALESCE(MAX(seq), -1) + 1`；初始 pi 绑定为 null、`status='active'`。
  并发 create 由 partial unique index 收敛为同一行（事务内 select-or-create）。
- `bindPiSession`：首次绑定；两个值必须同时非空；与已有值相同 → no-op；不同 →
  `invalid_input`，必须走 `replacePiSession`。
- `replacePiSession`：只允许 resume failure / reset 路径；两个值同时为空（fresh 前）
  或同时非空（fresh 后重新绑定）；事件由 `AgentSessionManager` 写。
- `recordUserVisibleOutput`：首次 user-visible output 时，如果
  `message_count === 0 && last_counted_turn_execution_id <> turnExecutionId`，
  置 `message_count = 1` 并写 `last_counted_turn_execution_id = turnExecutionId`；
  同 turn 后续输出 no-op。
- `recordCompletedTurn`：`consecutive_resume_failures = 0`；如果
  `last_counted_turn_execution_id <> turnExecutionId`，`message_count += 1` 并写
  `last_counted_turn_execution_id = turnExecutionId`；因此无可见输出的 completed turn
  也 +1，有输出的 turn 不会 double count。
- `recordResumeFailure`：`consecutive_resume_failures += 1`；返回新值；不在这里清绑定。
- `resetResumeFailures`：只用于单次 resume failure 的同 session fresh（清 pi 绑定 +
  计数归零）；circuit breaker / 显式 fresh 走 `sealActive + createNextActive`，
  不调用它。
- `sealActive`：只允许 `active → sealed`，写 `seal_reason`/`sealed_at`；不生成
  transcript/digest。`createNextActive` 读取 `MAX(seq)+1` 建新 active 行；两步由
  `AgentSessionManager.reset` 放在同一事务。
- 没有 full `sealSession` / `restoreSession`；这些是 v2 API。
- **事务边界**：`recordUserVisibleOutput` / `recordCompletedTurn` / `recordResumeFailure` /
  `resetResumeFailures` / `sealActive` / `createNextActive` 必须与调用方的事务一起提交；
  store 接受 tx handle，不自己开事务。

**代码接线点**：`control/stores/types.ts`（接口收敛）、
`control/stores/sessions.ts`（列映射与新方法）、`control/migrations/001-core.ts`
+ R1（重建表/旧表归档）、`workers/harness.ts`（resume 前置检查/fresh/上限）、
`workers/executor.ts`（completed turn 计数）、`control/read-models.ts`
（只用 `messageCount`）、测试。

> Clowder 的 `messageCount` 细节（`invoke-single-cat.ts:5017-5060`）：首次
> user-visible output 会把 0→1（unseal safety）；`done` 时如果本 turn 没被计数，
> 就 +1——**无可见输出的 completed turn 也 +1**。v1 用
> `last_counted_turn_execution_id` 做同样的 durable 去重。

### 6.1 服务分层与一个 turn 的协作

`AgentSession` 是 durable row，但“拿到 session”“拿到历史”“拿到执行载体”是三件事。
v1 分四层，`AgentSessionManager` 只做组合，不持有状态：

| 层 | 职责 | 状态 |
|---|---|---|
| `AgentSessionStore` | durable identity + resume + lightweight seal：`getActive` / `get` / `create` / `bindPiSession` / `replacePiSession` / `recordUserVisibleOutput` / `recordCompletedTurn` / `recordResumeFailure` / `resetResumeFailures` / `sealActive` / `createNextActive` | SQLite `agent_sessions` |
| `AgentReadStateStore` | per-`(thread, agent)` 投递进度：`get` / `ack` / `rewind` | SQLite `agent_read_state` |
| `WorkerPool` | ephemeral execution carrier：`ensure` / `release` / `revokeSession` / `heartbeat` / `reapExpired` | SQLite `workers` + `worker_bindings` |
| `AgentSessionManager` | 薄 facade：`ensureActive` / `loadHistory` / `acquireWorker` / `releaseWorker` / `recordTurnTerminal` / `reset` | 无自有状态 |

```ts
interface AgentReadStateStore {
  get(threadId: string, agentId: string): AgentReadState | null;
  ack(threadId: string, agentId: string, seq: number, now?: number): AgentReadState;
  rewind(threadId: string, agentId: string, seq: number, now?: number): AgentReadState;
}

interface HistoryWindow {
  mode: "bootstrap" | "incremental";
  rows: StoredMessage[];        // StoredMessage 定义见 0007 §3.1
  boundarySeq: number;
  degraded?: string;
}

interface AgentSessionManager {
  ensureActive(threadId: string, agentId: string): AgentSession;
  loadHistory(input: { threadId: string; agentId: string }): Promise<HistoryWindow>;

  /** stream 首次可见输出时调用；与 turn 计数同事务。 */
  recordUserVisibleOutput(session: AgentSession, turnExecutionId: string): void;

  acquireWorker(input: {
    threadId: string;
    agentId: string;
    turnExecutionId: string;
    session: AgentSession;
  }): Promise<WorkerHandle>;    // WorkerHandle 定义见 0007 §3.5.2

  releaseWorker(handle: WorkerHandle, reason: string): Promise<void>;

  /** 必须在 T1 child terminal 事务（invoke-single-agent + TurnExecutionLifecycle）内调用。 */
  recordTurnTerminal(input: {
    session: AgentSession;
    turnExecutionId: string;
    deliveryBoundarySeq: number | null;
    promptDelivered: boolean;
    outcome: "completed" | "failed" | "interrupted" | "canceled";
    userVisibleOutput: boolean;
    now: number;
  }): void;

  reset(
    threadId: string,
    agentId: string,
    reason: "fresh" | "resume_failures",
  ): Promise<AgentSession>;
}
```

- `ensureActive`：
  - `getActive`；缺失则 `create`，`userId = thread.created_by`、
    `workingDirectory = canonical(thread.projectPath)`；不 spawn worker。
  - 已有行的 `workingDirectory` 与 `thread.projectPath` 规范化后不一致 →
    typed `session_workspace_changed`，不静默换目录。v1 的换工作区是 v2 显式操作。
  - `consecutiveResumeFailures >= 3` → 走 `reset(reason='resume_failures')`：
    lightweight seal 旧行、新建 `seq+1` active 行、cursor rewind，然后本轮在新行 fresh。
  - 该 reset 若遇到同 session 的 running attempt（另一个并发 turn），返回 typed
    `session_busy`；调用方 defer，不强行 reset。
- `loadHistory`：委托 `HistoryAssembler`（0007 §3.5.1 的只读加载器），只读 `AgentReadStateStore` 与
  `MessageStore`；返回 `rows + boundarySeq + mode`。**这里不 ack**。完整规则见
  `0007 §3.5.1`。
- `acquireWorker`：`WorkerPool.ensure`。容量应在 dispatch 前用
  `WorkerPool.checkCapacity` 预检；Phase B 后 ensure 仍因竞态返回
  `worker_capacity` 时，按 post-dispatch 失败处理：attempt appended→failed + R failed，
  不 releaseClaim/defer（target 已 retired）。
- `releaseWorker(handle)`：turn 结束/取消后 retire（`warmTtl=0`）；按
  `handle.generation` 幂等，不误 retire replacement。
- `recordTurnTerminal`：在 child terminal 事务内完成三件事：
  1. `outcome === 'completed'` → `recordCompletedTurn({ turnExecutionId, userVisibleOutput })`；
     失败计数归零；首次可见输出已 0→1 则不再 +1，无输出 completed turn 也 +1；
  2. `outcome !== 'completed'` → 不碰 messageCount / 失败计数；
  3. `promptDelivered && deliveryBoundarySeq != null` →
     `AgentReadStateStore.ack(threadId, agentId, deliveryBoundarySeq)`。
  这三步与 TurnExecution terminal + `projectChildTerminal` 同事务；要么全成，要么全回滚。
- `reset`：见 §6.1.2。
- `TurnExecution.agentSessionId` 只是指针；session 解析只在
  `ensureActive(threadId, agentId)`，不在 child 里重复查映射。
- worker 是 **ephemeral execution carrier**，不是 session 的常驻所有者；
  turn 结束默认 retire（`warmTtl=0`），空闲 session 不占进程；`maxLiveWorkers=8`
  只限制同时存在的 worker。
- 执行互斥不靠 per-turn `worker_leases` 表：`TurnExecution` 的唯一 running per
  session + `RpcConnection.prompting` + `worker_bindings.generation` 承担。

#### 6.1.1 一个 turn 的协作时序

```text
runAgentTurn
  1. ensureActive(threadId, agentId)
       → active session 行；可能先做 resume 前置检查 / lightweight seal + seq+1 reset
  2. WorkerPool.checkCapacity
       → 容量不足：target 保持 pending，releaseClaim + defer；不创建 attempt/R/child
  3. Phase A（parent/claim 事务）：attempt(queued) + markStarting(agentSessionId)
       → 先拿唯一 active delivery（starting）并持久化；执行互斥在这里，不在 TurnExecution
  4. Phase B（独立 dispatch 事务）：processing R + TurnExecution.createRunning + bindAppended
       （turnExecutionId/R/settlement=streaming；workerId = null）
       + InvocationCredential.create + ResponseDraftStore.create + retireTargets
  5. loadHistory(threadId, agentId)
       → rows + boundarySeq；只读 cursor，不 ack
  6. acquireWorker(session)
       → WorkerHandle；attempt.bindWorker(handle.workerId)
  7. build prompt + provider prompt
       → RPC send 成功后 attempt.markPromptDelivered({ deliveryBoundarySeq, now })
  8. stream → response_drafts；首次可见输出 → sessionManager.recordUserVisibleOutput；
     usage → attempt
  9. T1 child terminal（invoke-single-agent + TurnExecutionLifecycle）：
       TurnExecution terminal + attempt projectChildTerminal
       + settlement='response_pending'
       + credential terminalize
       + sessionManager.recordTurnTerminal(...)
         (messageCount + cursor ack，条件见 §6.1)
 10. T2 R settlement（route/RouteResponseCommitter）+ T3 parent aggregate；
     worker.release(handle)
```

顺序理由：

- **互斥先于 TurnExecution/history/worker**：`markStarting` 先拿唯一 active delivery
  （`starting`），随后 `createRunning`/`bindAppended`；避免两个并发 turn 都创建
  TurnExecution、都构建 history、都 spawn worker。
- **history 先于 worker**：prompt 构建失败/上下文不可读时，不浪费一次
  ~0.5s 的 worker spawn；history 只读 cursor，不改变投递状态。
- **ack 在 T1 child terminal 事务内**：cursor 只在本轮有 durable terminal 时前进；
  崩溃在 T1 之前 → 不 ack，下一轮重放；T1 提交后 → ack 已持久化，
  R settlement 独立可恢复。不会出现“prompt 已构建但响应未落库，消息却被吞掉”。
- **worker release 在 T2 之后**：R settlement 还要用 worker 的连接/会话上下文；
  release 失败由 reaper 兜底，按 generation 幂等。

#### 6.1.2 Reset 语义

```text
reset(threadId, agentId, reason):
  precondition: 该 session 没有 running attempt；有 → typed session_busy
  tail = messages.tailSeq(threadId)
  tx:
    AgentReadStateStore.rewind(threadId, agentId,
      max(0, tail - BOOTSTRAP_WINDOW))
    old = AgentSessionStore.sealActive(active.id, reason, now)
    next = AgentSessionStore.createNextActive({
      threadId, agentId, userId, workingDirectory, now
    })                                      // seq = old.seq + 1
    emit session_sealed + session_reset (same tx or outbox)
  after commit:
    WorkerPool.revokeSession(session.id, reason)
```

- `reason='fresh'`：显式换新 session；`reason='resume_failures'`：3 次上限的
  circuit breaker。两者都走 lightweight seal + `seq+1`，不做 transcript/digest。
- v1 不把 `workspace_changed` 作为 reset reason：`ensureActive` 先 typed reject
  `session_workspace_changed`；换工作区是 v2 显式操作。
- reset 不删除旧 `AgentSession` 行，也不删除旧 `piSessionFile`；旧行 sealed，
  新行从 null pi binding 开始。
- reset 后本轮按 `loadHistory` 从 rewound cursor 取最近 `BOOTSTRAP_WINDOW` 条；
  `mode` 可能仍是 `incremental`，但窗口内容等价于 bootstrap。
- reset 必须幂等：重复调用不清两次 cursor、不重复写事件。

#### 6.1.3 失败矩阵

| 失败点 | 持久状态 | cursor | 下一轮行为 |
|---|---|---|---|
| worker_capacity 预检失败（dispatch 前） | 无 attempt/R/child；target 保持 pending | 不 ack | QueueProcessor defer；不写 delivery_failure |
| Phase A 失败（parent/attempt starting） | 事务回滚，无 attempt/R/child | 不 ack | releaseClaim + defer；不写 delivery_failure |
| Phase B 失败（R/child/credential/draft/retire） | attempt starting → failed，无 R | 不 ack | 写 delivery_failure；target 保持 pending，可重试 |
| Phase B 后 loadHistory / spawn / prompt 构建失败 | attempt appended → failed，R failed（无 promptDelivered） | 不 ack | 重放同一批消息；不写 delivery_failure |
| provider prompt 已接收后失败 | attempt failed/interrupted + R failed | tx A ack（promptDelivered=true） | 不重放；下一轮看到 failed R |
| 取消在 prompt 前 | attempt canceled | 不 ack | 重放 |
| 取消在 prompt 后 | attempt canceled + R canceled | tx A ack | 不重放 |
| 崩溃在 tx A 前 | attempt starting/appended（不是 running） | 不 ack | startup reconciler terminalize；按 promptDelivered 决定是否 ack |
| 崩溃在 tx A 后、R settlement 前 | settlement=response_pending | 已 ack | response reconciler 收敛 R；不重放 |
| 崩溃在 R settlement 后、worker release 前 | worker stale | 已 ack | reaper retire；不重放 |

#### 6.1.4 与 Clowder 对照

**命名先澄清**：Clowder 没有 `AgentSessionStore` 这个类/接口。`SessionStore`
（`packages/shared/src/utils/redis.ts:209`）是 **Redis 存储适配器**：同一个类里放了
sessionId 映射、delivery/mention/seen cursor、cat state 等多组 key。Clowder 的 domain
接口是 `SessionManager`（映射）、`SessionChainStore`（session record）、
`DeliveryCursorStore`（cursor 语义）、`RuntimeSessionStore`（runtime metadata）。
codeteam 的 `AgentSessionStore` 对应的是 **SessionManager + SessionChainStore 的
domain 子集**，不是 Clowder 的 Redis adapter。不能按类名 1:1 对表。

**Clowder `SessionStore` 方法 → codeteam 落点**

| Clowder `SessionStore` 方法 | codeteam |
|---|---|
| `getSessionId` / `setSessionId` / `deleteSession` | `AgentSessionStore.getActive/create` + `AgentSessionManager.ensureActive/reset` |
| `getDeliveryCursor` / `setDeliveryCursor` / `deleteDeliveryCursor` | `AgentReadStateStore.get/ack/rewind` |
| `getMentionAckCursor` / `setMentionAckCursor` / `deleteMentionAckCursor` | v2；v1 不做 mention ack |
| `getSeenCursor` / `setSeenCursor` / `deleteSeenCursor` | v2；v1 不做 seen cursor |
| `reconcile*CursorFormat` / `replace*CursorIfEqual` | v1 不需要：SQLite 单一 schema，没有 v1/v2 cursor 格式迁移 |
| `getCatState` / `setCatState` | `AgentState`（0008），runtime state，不是 session |

**为什么 DeliveryCursor 不放进 `AgentSessionStore`**：

- session identity 和 delivery progress 生命周期不同：session 行可以跨 turn 长期存在，
  cursor 在 reset 时要 rewind；混在一起会让 reset/ack 的事务边界变模糊。
- Clowder 自己也是 `DeliveryCursorStore` 管语义、`SessionStore` 只是共用 Redis 适配器；
  adapter 的 key 放在同一个类里是存储便利，不是 domain 边界。
- codeteam 单 SQLite 可以共库，但 `AgentReadStateStore` 独立后，单调 ack / rewind /
  promptDelivered 条件可以单独测试，不必把 session 的 resume 语义卷进来。

| Clowder | codeteam v1 | 关系/差异 |
|---|---|---|
| `SessionManager.store/get/delete`（`packages/api/src/domains/cats/services/session/SessionManager.ts`） | `AgentSessionStore.getActive/create` + `AgentSessionManager.ensureActive` | Clowder 只维护映射；codeteam 的 session row 本身就是映射，不另建 map |
| `SessionStore`（`packages/shared/src/utils/redis.ts:209`，Redis KV，`(userId,catId,threadId) → sessionId`，TTL 24h） | `AgentSessionStore` 的映射面 | Clowder 不存 session 行；codeteam 把映射 + resume 状态放进同一 relational row，持久化、无 TTL/内存 fallback |
| `SessionChainStore` / `SessionRecord`（cliSessionId/status/seq/messageCount/consecutiveRestoreFailures/seal/compression/handoff） | `AgentSession`（piSessionId/file、workingDirectory、messageCount、consecutiveResumeFailures、seq/status/sealReason/sealedAt） | v1 保留 lightweight seal 的 seq/status；transcript/digest/restore/compression/handoff 是 v2 |
| `RuntimeSessionStore`（runtime/runtimeSessionId/thread/cat/user/identityHistory/lifecycle） | `AgentSession.piSessionId/piSessionFile` + `WorkerBinding` | codeteam 不建独立 runtime metadata store；pi 是唯一 backend，runtime 绑定落在 session row + worker binding |
| `DeliveryCursorStore.getCursor/ackCursor`（`stores/ports/DeliveryCursorStore.ts`） | `AgentReadStateStore.get/ack/rewind` | 同为 monotonic cursor；Clowder 是 visibility cursor `v2:<seq>:<messageId>` + delivery/mention/seen 三 namespace；codeteam v1 只有 delivery + numeric `messages.seq` |
| `ContextAssembler` + incremental context（`route-helpers.ts` `assembleIncrementalContextInternal`） | `HistoryAssembler`（0007 §3.5.1） | 同样是 fetch-after-cursor → visibility filter → boundary；codeteam 去掉 smart window/seen/mention/overlay，v1 只做 delivery |
| `AcpProcessPool`（`providers/acp/AcpProcessPool.ts:114`） | `WorkerPool`（0007 §3.5.2） | Clowder 长驻、可 multiplexing、内存 pool；codeteam ephemeral、一 worker 一 session、SQLite registry（pi RPC 无 session/new/load） |
| `SessionManager.delete` + `SessionChainStore` seal | `AgentSessionManager.reset` + `AgentReadStateStore.rewind` | codeteam 把“lightweight seal 旧行 + 新建 seq+1 + cursor 回退”收成一个显式 reset；不生成 transcript/digest |
| `messageCount` / `consecutiveRestoreFailures` | `messageCount` / `consecutiveResumeFailures` | 语义对齐：首次可见输出 0→1，done 时本 turn 未计数则 +1（无输出也 +1）；连续失败 3 次 lightweight seal + fresh |
| transcript/digest/restore/chain 导航 | v2 | v1 只做 lightweight seal；A2A runtime 验收不要求长 session 恢复 |

**为什么 `AgentSessionStore` 比 Clowder `SessionStore` 重**：

1. **daemon 重启后 resume**：Clowder 的 `SessionStore` 只是 sessionId 映射，真正的
   provider/session 内容在 runtime session/provider 侧；codeteam 的 pi RPC resume 需要
   `piSessionId` + `piSessionFile` + `workingDirectory` 作为 durable row。
2. **worker lease/reaper 直接查**：codeteam 的 reaper 要在 SQLite 里按
   `agent_session_id` 查 active session / worker binding，不能反过来问 provider。
3. **active + lightweight seal + circuit breaker**：`(threadId,agentId)` 唯一 active、
   3 次 resume 失败 seal + `seq+1`，是 codeteam 的 durable 语义，Clowder `SessionManager`
   不承担。
4. 这是**有意加重**，不是误抄；如果未来 pi 支持 provider-side session registry，可再薄化。

**为什么 `WorkerPool` 不是 `AcpProcessPool`**：

- Clowder ACP 池可以 multiplexing，多个 lease 共享一个进程；pi v1 的 RPC 进程启动时
  session 固定，没有 `session/new` / `session/load`，一进程只能服务一个 session。
- 若照搬长驻池，100 个 thread×agent 会留下 100 个空闲进程；codeteam 用
  ephemeral worker + 0.5s spawn 换资源利用率。
- worker 仍需 durable `workers` + `worker_bindings`：reaper 要看 heartbeat/lease，
  crash 后要清理；Clowder 的 `sessionOwners` 是内存映射，重启即丢，不满足 daemon
  crash recovery。

#### 6.1.5 关键不变量

1. `(thread_id, agent_id)` 同时只有一行 active；`UNIQUE(thread_id, agent_id, seq)` 保留 sealed 链。
2. `piSessionId` 与 `piSessionFile` 同时为空或同时非空；`piSessionId` 非空时全局唯一。
3. `workingDirectory` 非空；只允许在创建时写入；v1 换工作区 → typed reject。
4. `messageCount` 单调不减；每个 completed turnExecution 恰好 +1；首次可见输出提前 0→1，
   done 通过 `lastCountedTurnExecutionId` 去重；无可见输出的 completed turn 也 +1。
5. `consecutiveResumeFailures`：resume 失败 +1，成功 completed turn 归零，3 次触发 reset。
6. `deliveryCursor` 单调前进；只有 `promptDelivered && terminal` 才 ack；只有 reset 能 rewind。
7. 同一 session 同时最多一个 active delivery（`starting|appended`）；running
   TurnExecution 由该 delivery 派生；同一 worker 同时只服务一个 session。
8. worker release 按 `handle.generation` 幂等；stale release 不能 retire replacement。
9. child terminal 事务 A 要么同时提交 terminal + messageCount + cursor ack，要么全回滚。
10. v1 有 lightweight seal（active → sealed + 新行 seq+1），没有 transcript/digest/
    restore/chain 导航；旧行/旧 pi 文件保留，不删除。
11. `WorkerBinding` 是 durable row；`WorkerHandle` 是 runtime handle，定义见 `0007 §3.5.2`；`worker_id` / `worker_binding_state` 不写回 AgentSession identity。

## 7. 事件

写现有 `thread_events`，不新增事件表；`audit` 是 task-first legacy，不用于 A2A/session
contract：

| 事件 | 关键字段 |
|---|---|
| `session_created` | sessionId, threadId, agentId |
| `session_pi_bound` | sessionId, piSessionId, piSessionFile |
| `session_resumed` | sessionId, piSessionId |
| `session_resume_degraded` | sessionId, reason, previousPiSessionId, newPiSessionId |
| `session_sealed` | sessionId, seq, reason, sealedAt |
| `session_resume_circuit_breaker` | sessionId, action=lightweight_seal, failures, nextSessionId |
| `session_turn_completed` | sessionId, messageCount |

`session_sealed` 只表示 lightweight seal；没有 transcript/digest 事件。

## 8. 验收标准

**Schema / Store**

- 同一 `(thread, agent)` 同时只有一行 active；重复 `ensureActive` / 并发 `create`
  返回同一 active 行；sealed 行保留，`seq` 连续。
- `piSessionId` 非空时全局唯一。
- `piSessionId/piSessionFile` 同时为空或同时非空。
- `workingDirectory` 必须等于 `thread.projectPath`；不一致 → typed
  `session_workspace_changed`，不静默换目录。
- `messageCount`：一次 completed invocation 恰好 +1；首次可见输出提前 0→1；
  同一 invocation 的 `done` 不重复 +1；无可见输出的 completed turn 也 +1。
- `bindPiSession` 不能覆盖已绑定值；`replacePiSession` 只能走 resume failure。
- v1 有 lightweight seal；没有 transcript/digest/restore API。

**Resume**

- 文件存在、id 一致 → reattached；`piSessionId` 不变。
- 文件缺失 / 越界 / 绑定不完整 / id 不一致 → fresh + 对应事件 + 计数 +1。
- `workingDirectory` 不存在 → typed error `workspace_unavailable`，不 fresh 到别处。
- 连续 3 次失败 → lightweight seal 旧行 + 新建 `seq+1` active 行 + cursor rewind；
  旧行/旧 pi 文件保留。
- 成功 completed turn → 计数归零。
- daemon 重启后能 resume active 行；sealed 行不参与 resume，没有 restore 路径。

**Session × history × worker**

- `loadHistory` 不 ack；ack 只在 child terminal 事务内且 `promptDelivered=true`。
- worker_capacity 预检失败 → 不 ack；下一轮重放同一批消息。Phase B 后 spawn 失败 →
  attempt appended→failed + R failed，不 ack（prompt 未送达）；该 target 不自动 retry，
  但同一 agent 下一轮 history 仍会看到该 source。
- prompt 已送达后 provider failed/canceled → tx A 照常 ack；不重放。
- 崩溃在 tx A 前 → 不 ack；崩溃在 tx A 后 → ack 已随 terminal 持久化。
- child terminal 事务回滚时，messageCount / cursor ack 一起回滚。
- reset：cursor rewind + pi binding clear 同事务；worker revoke 在 commit 后。
- 同一 session 同时最多一个 running attempt；`worker_bindings` 一 session 一 worker。
- `session_workspace_changed` 是 typed reject，不自动 reset。

**Migration**

- 只迁移 active session（`seq=0`）；sealing/sealed 行留在 `legacy_agent_sessions`。
- 有 running invocation 的 active session 先 drain。
- `agentId/userId/workingDirectory` 无法确定的进入 preflight。
- v2 列不迁移；不存在“旧值伪装成新语义”。

## 9. 明确推迟到 v2

| v2 能力 | 对应字段/能力 | 为什么不在 v1 |
|---|---|---|
| full seal / transcript / digest / restore | `restoreActiveSession`、transcript/digest 生成 | v1 只做 lightweight seal；A2A runtime 验收不要求长 session 恢复。 |
| session chain 导航 | chain read model / UI | v1 有 `seq` lineage，但不提供跨 session 历史导航。 |
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
2. **`messageCount` 对齐 Clowder**：首次可见输出 0→1；done 时本 turn 未计数则 +1；
   无可见输出的 completed turn 也 +1；不是原始 message 行数。
3. **v1 是 active + lightweight seal**：保留 `status/seq/sealReason/sealedAt`；
   `sealing` 中间态、transcript/digest/restore/chain 导航放 v2。
4. **模型快照移到 `Invocation`**：`provider/model/modelFamily` 不在 `AgentSession`；模型变更不要求换 session。
5. **`nativeSessionBinding` 扁平化**：v1 用 `piSessionId + piSessionFile`；Clowder 的 binding 是 AGY 专用，pi 不需要。
6. **`workspaceFingerprint` 不持久化**：v1 的 `workingDirectory` required 且不可变，resume 时直接比较规范化路径。
7. **连续 3 次 resume 失败**：lightweight seal 旧行 + 新建 `seq+1` active 行 +
   cursor rewind；旧行/旧 pi 文件保留。
8. **工作区变化**：`workingDirectory` 不可变；thread.projectPath 变化时 typed reject `session_workspace_changed`；重置/迁移是 v2。
9. **Worker v1 = ephemeral execution carrier（2026-11-10 拍板）**：
   `WorkerPool` 管短命 worker（`warmTtl=0`、`maxLiveWorkers=8`、一个 worker 只服务
   一个 session）；session 不持有 worker；执行互斥由 `TurnExecution` 唯一 running +
   `RpcConnection.prompting` + binding generation 承担。spawn 实测约 0.5s，不作为常驻理由。
10. **History cursor ack 在 child terminal 事务内（2026-11-11）**：
    `loadHistory` 只返回 `boundarySeq`，不 ack；ack 与 `recordCompletedTurn` 一起在
    child terminal 事务内提交，条件是 `promptDelivered=true`。崩溃在 terminal 前 →
    重放；terminal 后 → ack 已持久化。Clowder 也是“prompt 已组装后 ack”，但
    codeteam 用单 SQLite 事务把 terminal + cursor 变成原子操作。
11. **`AgentSessionManager` 是薄组合层**：不持有状态；组合 `AgentSessionStore` +
    `AgentReadStateStore` + `WorkerPool`；`recordTurnTerminal` 是唯一跨 store 写入口。
12. **Lightweight seal（2026-11-11 拍板）**：`active → sealed`，旧行保留，
    新行 `seq+1`；用于 circuit breaker 和显式 fresh。不生成 transcript/digest，
    不做 restore/chain UI。
13. **AgentState 归属（2026-11-11 拍板）**：AgentState 是 invocation/queue 事件的
    运行时投影，不属于 session store；多 thread 并行时用 `(threadId, agentId)` 投影，
    `AgentState` 只做 per-agent 汇总，不建 DB 表。
