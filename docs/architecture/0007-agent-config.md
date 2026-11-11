---
title: "codeteam AgentConfig v1 — config-as-code identity"
doc_kind: architecture
status: draft-for-review
created: 2026-11-04
updated: 2026-11-04
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_decisions: "2026-11-04: installation-level .codeteam/agent-catalog.json; flat AgentConfig; enabled/defaultModel/AccountConfig; role removed"
related_features: [codeteam/F018, codeteam/F017]
---

# codeteam AgentConfig v1

> **config-as-code，不是 DB profile。** AgentCatalog 是安装级根文件；
> AgentConfig 是解析后的 agent 视图；AgentRegistry 是内存注册表；
> AgentState 是运行时状态。`AgentProfile` 不再作为 source-of-truth 类型。

## 0. 决策

- **installation-level**：`.codeteam/agent-catalog.json`；agent 是团队成员，跨 project 复用。
- **v1 扁平 AgentConfig**：每个 agent 一个独立身份/模型；不引入 Breed/Variant 两层。
- `role` 不进入 AgentConfig；旧 `roles` 表是 legacy。
- `clowderCatId` / `toolPolicyProfile` v1 不保留。
- 只保留 `displayName`；A2A tool call 传 `id`，消息展示用 `displayName`。
- `avatar` / `color` 保留，Hub 后续用。
- `mentionPatterns` v1 不需要（路由只认 typed `targets`）。
- `clientId` / `carrier` v1 不需要；统一走 pi。
- `provider` 不进入 AgentConfig，由 AccountConfig 提供；`defaultModel` 进入 AgentConfig。
- `contextWindow` 保留。
- `roleDescription` 保留；`personality` 不保留。
- `restrictions: string[]` 保留。
- `strengths` 保留；`caution` / `teamStrengths` 不保留。
- `breedId` 适配为 **`roleId`**：用于后续共享 workflow 触发段，不是旧 codeteam role。
- `relationshipKey` / `variantLabel` / `breedDisplayName` 不保留。
- `voiceConfig` / `cli` / `commandArgs` / `cliConfigArgs` / `agyProfile` / `mcpSupport` 不保留；MCP 统一由 pi 负责。
- `accountRef` 保留；`accountBindingMode` 不保留。
- `sessionChain` 保留。
- `AgentConfig.enabled: boolean`；`CatState.status` → `AgentState.status`。

## 1. 类型

```ts
interface AgentCatalog {
  version: 1;
  agents: AgentConfig[];
}

interface AgentConfig {
  id: string;                 // A2A target id；稳定身份
  displayName: string;        // 消息展示
  avatar?: string;            // Hub 后续用
  color?: { primary: string; secondary: string };

  contextWindow: number;      // 上下文大小
  roleId: string;             // workflow 触发段 key，不是旧 role
  roleDescription: string;    // 角色描述
  restrictions: string[];     // agent 限制
  strengths: string[];        // 能力标签

  accountRef: string;         // 指向 AccountConfig
  defaultModel: string;       // 必须是 account.models 里的一个
  sessionChain: boolean;      // 后续 sessionChain
  enabled: boolean;           // false = 不路由/不唤醒
}

interface AccountConfig {
  ref: string;                // AgentConfig.accountRef
  provider: string;
  apiUrl?: string;
  apiKeyRef: string;          // env/secret ref，不存 raw key
  models: string[];           // 至少一个模型名
}

interface AgentState {
  agentId: string;
  status: "idle" | "thinking" | "working" | "error" | "offline";
  currentInvocationId?: string;
  sessionId?: string;
  lastActiveAt: number;
}

interface ThreadAgentState {
  threadId: string;
  agentId: string;
  status: "idle" | "thinking" | "working" | "error" | "offline";
  currentTurnExecutionId?: string;
  currentInvocationId?: string;
  lastActiveAt: number;
}
```

`AgentRegistry`：`Map<agentId, AgentConfig>` + revision；启动时加载 catalog，config 变化后 reconcile。`AgentState` 运行时状态，不写进 catalog。

**状态归属（2026-11-11 拍板）**：Clowder 的 cat 状态不是 server-side store，而是
`InvocationTracker` + queue/active-invocation + WebSocket 事件的读模型；`SessionStore`
里的 `getCatState/setCatState` 在当前参考仓 0 个调用点，是遗留接口。codeteam 同样
不建 AgentState 表：

- `(threadId, agentId)` 维度的 `ThreadAgentState` 由 `InvocationTracker` 投影：
  claim 时 `thinking`，prompt 送达后 `working`，terminal 后 `idle`/`error`；
  `WorkerPool.reapExpired` 标记 `offline`/`error`。
- `AgentState` 只是 per-agent 汇总视图，用于目录/状态展示；多 thread 并行时不能用它
  互相覆盖，展示层优先读 `ThreadAgentState`。
- `InvocationCredential` / `AgentSession` 都不写 AgentState。

## 2. 文件与加载

- `.codeteam/agent-catalog.json`：安装级 AgentCatalog，source of truth。
- `.codeteam/accounts.json`：安装级 AccountConfig 列表；`apiKeyRef` 只存 env/secret ref。
- 加载：读取 JSON → schema 校验 → 解析 `AgentConfig[]` → 注入 `AgentRegistry`。
- 写入：临时文件 + 校验 + 原子 rename（与 Clowder catalog 写入一致）。
- 不在 AgentCatalog 里放 `api_key` / token / 任何 secret。

## 3. A2A 语义

- `targets` 是 `AgentConfig.id`；不是 displayName，不是 mentionPatterns。
- 消息展示用 `displayName`；A2A tool call 用 `id`。
- `enabled: false` 的 agent：注册但不可路由；target 它返回 `agent_disabled` typed error。
- 未知 id：`agent_not_found`。
- `accountRef` 解析失败：`account_not_found`。
- `defaultModel` 不在 account.models：`model_not_in_account`。
- 权限/工具/MCP 由 pi 执行层负责；AgentConfig 不定义 tool policy。

## 4. roleId 与 workflow 触发段

`roleId` 是 **workflow 分组 key**，不是旧 codeteam role：

- 同一 `roleId` 的 agent 共享同一段 workflow 触发内容。
- 未来 `workflow-triggers.yaml` 按 `roleId` 取值；没有匹配条目不注入。
- v1 只存 `roleId`，不引入 workflow-triggers 加载器（codeteam 目前没有这个文件）。
- 旧 `agent_profiles.role` 不迁移为 roleId；默认 `roleId = agent.id`，需要共享 workflow 时显式设同一 roleId。

## 5. 从旧 agent_profiles 迁移

| 旧字段 | 新 AgentConfig | 处理 |
|---|---|---|
| `id` | `id` | 直接 |
| `displayName` | `displayName` | 直接 |
| `roleDescription` | `roleDescription` | 直接 |
| `restrictions` JSON object | `restrictions: string[]` | 转自然语言禁令数组；无法映射的保留原文 |
| `role` | 不保留 | 旧 execution role 作废；`roleId` 默认 `agent.id` |
| `provider/model/modelFamily` | `accountRef` + `defaultModel` | 建 AccountConfig；`provider` 进 account，`defaultModel` 进 AgentConfig |
| `toolPolicyProfile` | 不保留 | v1 不需要；pi 负责工具 |
| `clowderCatId` | 不保留 | legacy provenance |
| `agent_sessions.profile_id` | `agentId` | 目标模型用 `agentId`；旧列 legacy |
| `agent_sessions.role` / `runs.role` / `workers.role` | 不保留 | legacy |
| `roles` 表 | 不保留 | legacy |

需要补默认值的：`avatar`（optional）、`color`（optional）、`contextWindow`（从旧 session capacity/account 补）、`accountRef`（按 provider/account 建）、`sessionChain`（true）、`strengths`（[]）、`enabled`（true）。

## 6. 校验规则

- `id` 非空且全局唯一。
- `displayName` 非空。
- `contextWindow` 正整数。
- `roleId` 非空。
- `accountRef` 必须能解析到 AccountConfig。
- `defaultModel` 必须属于对应 AccountConfig.models。
- `AccountConfig.models` 至少一个非空模型名。
- `enabled` / `sessionChain` 布尔。
- `restrictions` / `strengths` 字符串数组。
- `avatar` / `color` optional；Hub 后续使用。

## 7. 与 0005/F018 的关系

- 0005 的 Thread/Invocation/Session 统一使用 `agentId` 引用本模型；不再使用 `profileId`。
- Invocation/Session 不再有 `role`；workflow 分组只用 `roleId`。
- F018 R1 负责 `.codeteam/agent-catalog.json` + accounts 的加载/校验/Registry；R2 起 A2A runtime 只从 AgentRegistry 取 agent。

[宪宪/deepseek-flash🐾]
