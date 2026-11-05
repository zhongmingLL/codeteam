---
title: "codeteam Thread model v1 — minimal A2A thread"
doc_kind: architecture
status: draft-for-review
created: 2026-11-05
updated: 2026-11-05
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_decisions: "2026-11-05: projectPath required; active/deleted only; no ThreadGoal/tokenBudget in v1; empty thread allowed"
related_features: [codeteam/F018, codeteam/F017]
---

# codeteam Thread model v1

> Thread 是 A2A runtime 的主体；v1 只保留最小会话字段。
> 不放 ThreadGoal/tokenBudget，不放 archive/parent 扩展，不做 thread memory/routing policy。

## 1. 最终接口

```ts
interface Thread {
  id: string;
  projectPath: string;       // 必填
  title: string | null;
  titleSource?: "user" | "agent" | "system";
  createdBy: string;         // user id
  participants: AgentId[];   // resolved from thread_participants；可为空

  lastActiveAt: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
}
```

持久化：

- `threads`：`id/project_path/title/title_source/created_by/last_active_at/created_at/updated_at/deleted_at`
- `thread_participants`：`thread_id/agent_id/joined_at`，主键 `(thread_id, agent_id)`
- 不再有 `status` / `archived_at` / `goal_json` / `parent_thread_id` 作为 v1 核心字段。

## 2. 语义

### 2.1 生命周期

- `deletedAt == null`：active。
- `deletedAt != null`：soft-deleted；从普通 thread 列表隐藏；`post_message`/`cross_post_message` typed reject；数据保留，operator 可恢复（清空 `deletedAt`）。
- v1 **没有 archive**；archive 与 delete 不区分。后续若需要“归档但可见”，再加 `archivedAt`，不混用 `deletedAt`。
- 不做硬删除。

### 2.2 Access

- Thread access 由 `createdBy` + same user 决定；跨 user 拒绝。
- `participants` 只做路由/上下文，不是 ACL 替代。
- 允许空 thread：operator/CLI 可以先建 thread，后拉 agent。
- `participants` 可包含 disabled agent；target 它返回 `agent_disabled`，不路由。
- 首次成功 invocation 后 agent 加入 participants；operator/CLI 也可显式加入。

### 2.3 标题与活跃时间

- `title` 可由 operator/CLI 设置；为空时从首条消息自动生成。
- `titleSource`：
  - `user` = operator/CLI 设置
  - `agent` = agent 创建/改名（后续能力）
  - `system` = 自动生成
- `lastActiveAt`：消息创建/agent response 时更新，用于 thread 列表排序。
- `updatedAt`：thread 配置字段变更时更新，不被普通消息刷新。

### 2.4 projectPath

- `projectPath` 必填；新 thread 创建时必须提供。
- 旧 thread 迁移时必须回填；无法从 `repo`/task.worktree/operator 配置解析的 thread 进入 preflight 清单，由 operator 补路径。
- 不允许静默回退到 daemon 目录或某个 task worktree。

## 3. 与 Clowder 的取舍

| Clowder Thread 字段 | v1 | 原因 |
|---|---|---|
| `id/projectPath/title/titleSource/createdBy/participants/lastActiveAt/createdAt/deletedAt` | **复用/适配** | A2A 核心 |
| `parentThreadId` | 不使用 | v1 扁平 thread；subthread 后续 |
| `goal` | 不使用 | codeteam 当前没有 ThreadGoal/tokenBudget；v1 只记录 usage |
| `routingPolicy/preferredCats` | 不使用 | v1 路由只认 typed `targets` |
| `threadMemory/pendingContinuation` | 后续 | 跨 session 连续性后续能力 |
| `memberSessionStrategy/memberEffortOverrides/memberSpeedOverrides` | 后续 | v1 不做 per-member strategy/effort |
| `status/archivedAt` | 不使用 | v1 只区分 active/deleted；archive 后续 |
| `pinned/favorited/labels/bubble*/thinkingMode/voiceMode/preferredWorkspaceMode` | 不使用 | Hub/UI 后续 |
| `bootcampState/firstRunQuestState/votingState` | 不使用 | onboarding/投票，不是 A2A core |
| `systemKind/connectorHubState/externalRuntimeAnchorState` | 后续 | connector/external runtime 能力 |
| `threadMetadata/sessionImport` | 后续 | 元数据/导入独立能力 |
| `createdFromProposalId/sourceThreadId/approvedBy/approvedAt/sourceInvocationId/sourceMessageId/declaredWorkMode/branchAudit` | 后续 | v1 operator/CLI 创建 thread；agent propose 后续 |

## 4. 当前 codeteam threads 迁移

当前 `threads` 表：`id/title/repo/status/phase/backlog_item_id/created_at/updated_at`。

| 旧字段 | 新 Thread | 迁移 |
|---|---|---|
| `id` | `id` | 直接 |
| `title` | `title` | 直接 |
| `repo` | `projectPath` | repo 可解析为本地路径则用；否则从 task.worktree 共同根/operator 配置回填；无法确定 → preflight |
| `status` | `deletedAt` | `active` → null；`archived` → `deletedAt = updated_at`（v1 不保留 archive 状态） |
| `phase` / `backlog_item_id` | 不保留 | legacy 只读 |
| `created_at/updated_at` | `createdAt/updatedAt` | 直接 |
| 无 | `createdBy` | 从最早 task.created_by/user_id → 最早 session.userId → operator；无法确定 → preflight |
| 无 | `participants` | 从 messages.author_id（agent）/agent_sessions.agent_id 回填；可为空 |
| 无 | `lastActiveAt` | max(messages.created_at, agent_sessions.updated_at, threads.updated_at) |
| 无 | `titleSource` | 旧 title 存在 → `system`（迁移默认）；operator 后续编辑 → `user` |

迁移前置：

- 扫描所有旧 thread；列出 `projectPath` 或 `createdBy` 无法确定的 thread，交 operator 补齐。
- 有 `CODETEAM_DATA_DIR/control.db` 的安装必须执行迁移；当前 workspace 没有找到本地 control.db，但不能假设所有安装为空。
- `archived` thread 映射为 soft-deleted；如果用户需要保留可见，必须先在旧系统恢复为 active 再迁移。

## 5. 明确不做

- 不在 v1 做 archive 状态；
- 不在 v1 做 ThreadGoal/tokenBudget/thread_member_effort；
- 不在 v1 做 parentThreadId/subthread；
- 不在 v1 做 threadMemory/routingPolicy/threadMetadata；
- 不在 v1 做 UI 的 pinned/favorited/labels/thinking/voice 字段；
- 不在 v1 做 hard delete。

[宪宪/deepseek-flash🐾]
