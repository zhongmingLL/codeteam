---
title: "codeteam identity contract v1"
doc_kind: architecture
status: accepted
created: 2026-11-07
updated: 2026-11-07
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
operator_signoff: "confirmed 2026-11-07"
related_features: [codeteam/F018, codeteam/F017]
---

# codeteam identity contract v1

> 唯一命名真相源。`0010`、`0005` 和后续实现只使用本文的规范名；旧名只允许出现在迁移映射表。

## 0. 一句话

ID 按对象分层：**scope → message → admission → queue → lifecycle → execution → auth**。每层一个 ID，引用一律 `<object>Id`；`sourceMessageId` 从 A2A runtime 中彻底移除。

## 1. 问题：三组冲突

| 冲突 | 旧现状 | 后果 |
|---|---|---|
| `sourceMessageId` | codeteam 旧域词（Task/Artifact/Schedule 的触发消息）；`0010` 又拿它当队列身份 + parent unique | 一个词三个语义 |
| `sourceId` / `sourceRecordId` | `0001` 现有队列：`sourceId` = message，`sourceRecordId` = run/backlog 等领域记录；`0010` 的 `sourceRecordId` 又变成队列身份 | 同名反义 |
| `invocationId` / `parentInvocationId` / `invocationRecordId` | auth 的 `invocationId` 指 child；`parentInvocationId` 指 A2A 因果父；`invocationRecordId` 指生命周期 parent | 三个都叫 invocation |

## 2. 规范分层

| 层 | 对象 | 规范 ID | 创建者 | 生命周期 | 说明 |
|---|---|---|---|---|---|
| Scope | 用户 | `userId` | auth | 永久 | 外部身份 |
| Scope | Thread | `threadId` | Thread 创建 | 永久 | 会话容器 |
| Scope | Agent 配置 | `agentId` | AgentConfig | 永久 | 稳定身份 |
| Scope | Agent 会话 | `agentSessionId` | AgentSession 创建 | active-only | 执行快照 |
| Message | 消息 | `messageId` | Message append | 永久 | 唯一消息身份 |
| Admission | 工作来源 | `sourceRecordId` | ingress | 稳定 | 队列身份；v1 = `messageId` |
| Admission | 领域记录（可选） | `originRecordId` | ingress | 永久 | run/backlog/schedule/handoff provenance |
| Admission | 尝试序号 | `attempt` | QueueProcessor/retry | 每次 attempt | 1-based；不是 ID |
| Queue | 队列 entry | `queueEntryId` | 派生 | 到 dispatch 完成 | `queue:<hash(sourceRecordId:attempt)>` |
| Queue | claim 租约 | `claimId` | QueueProcessor | 短时 | 可撤销；不是 durable 身份 |
| Lifecycle | 消息级 parent | `invocationRecordId` | QueueProcessor | 永久 | 一个 source 一个 parent |
| Execution | 单 agent 执行 | `turnExecutionId` | QueueProcessor | 永久 | 一个 agent × attempt 一个 child |
| Auth | 工具能力凭证 | `credentialId` | InvocationRegistry | 到 terminal | 绑定 `turnExecutionId` |
| Pointer | 触发消息 | `triggerMessageId` | ingress | 永久 | child 的来源消息 |
| Pointer | A2A 触发消息 | `a2aTriggerMessageId` | A2A ingress | 永久 | A2A hop 的触发消息 |
| Pointer | 响应消息 | `responseMessageId` | terminal | 永久 | child 产出的消息 |
| Pointer | A2A 因果父 | `a2aParentTurnExecutionId` | A2A ingress | 永久 | 上游 child，不是 lifecycle parent |
| Pointer | parent 的用户消息 | `userMessageId` | QueueProcessor | 永久 | v1 = `messageId`；未来可为 null |
| Key | 消息创建幂等 | `requestId` | client | 短期 | 不是 ID |
| Key | target 定位 | `targetKey` | 派生 | per target | `agent:<agentId>` / `operator:<userId>` |
| Key | 队列准入幂等 | `(sourceRecordId, attempt)` | 派生 | 永久 | 复合 key；不是 ID |

## 3. 关系图

```text
userId
  │
  └── threadId
        │
        ├── messageId ──────────────┐
        │     │                     │
        │     ├── sourceRecordId = messageId (v1)
        │     │        │
        │     │        └── queueEntryId = hash(sourceRecordId, attempt)
        │     │                 ├── claimId (ephemeral)
        │     │                 └── targetKey
        │     │
        │     └── invocationRecordId (parent, one per sourceRecordId)
        │              │
        │              ├── userMessageId = messageId
        │              │
        │              └── turnExecutionId (child, one per agent × attempt)
        │                       ├── agentId
        │                       ├── agentSessionId
        │                       ├── triggerMessageId
        │                       ├── a2aTriggerMessageId
        │                       ├── responseMessageId
        │                       ├── a2aParentTurnExecutionId
        │                       └── credentialId
        │
        └── agentSessionId (per agent)
```

## 4. 命名规则

1. **ID 命名对象，不命名用途**  
   `messageId` 是消息；`queueEntryId` 是队列行；`invocationRecordId` 是 parent；`turnExecutionId` 是 child。
2. **引用一律 `<object>Id`**  
   不允许裸 `id`、裸 `invocationId`、`entryId`。
3. **`sourceRecordId` 与 `messageId` 分开**  
   v1 相等，但队列身份要能承接未来 connector/private source；不要把两者合并。
4. **`userMessageId` 是 parent 的消息指针**  
   v1 = `messageId`；未来 connector 可为 null。
5. **`a2aParentTurnExecutionId` 只指因果父**  
   lifecycle parent 永远是 `invocationRecordId`。
6. **`attempt` 只出现在两个地方**  
   `queueEntryId = hash(sourceRecordId, attempt)`；`turnExecutionId` 唯一键 `(invocationRecordId, agentId, attempt)`。
7. **parent 上没有 `idempotencyKey`**  
   message 创建用 `requestId`；队列准入用 `(sourceRecordId, attempt)`；parent 用 `sourceRecordId UNIQUE`。

**例外**：`QueueTarget` 的 `{ kind, id }` 是 discriminated union 的 target selector，不是通用对象引用；`kind="agent"` 时 `id=agentId`，`kind="operator"` 时 `id=userId`。对外 wire 形状保持 `{kind,id}`，内部用 `targetKey()` 解析。

## 5. 禁用名与替换

| 禁用名 | 替换为 | 原因 |
|---|---|---|
| `sourceMessageId`（A2A runtime） | `messageId` 或 `sourceRecordId` | 旧域词；混淆消息身份和队列身份 |
| `sourceId` | `messageId` 或 `sourceRecordId` | 语义不明确 |
| `invocationId`（单独使用） | `invocationRecordId` 或 `turnExecutionId` | 分不清 parent/child |
| `parentInvocationId` | `invocationRecordId` 或 `a2aParentTurnExecutionId` | 分不清 lifecycle parent 和因果父 |
| `entryId` | `queueEntryId` | 明确对象 |
| `idempotencyKey`（parent） | `requestId` 或 `(sourceRecordId, attempt)` | v1 不需要 parent 级 key |
| `sourceRecordId`（旧义：run/backlog） | `originRecordId` | 给队列身份让路 |

## 6. 与 Clowder / 0001 的映射

| 旧名 | 来源 | 新名 | 动作 |
|---|---|---|---|
| `QueueEntry.sourceId` | 0001 现有队列 | `messageId` | rename |
| `QueueEntry.sourceRecordId`（run/backlog） | 0001 现有队列 | `originRecordId` | rename |
| `QueueEntry.sourceMessageId` | 0010 | 删除 | 拆到 `sourceRecordId` + `messageId` |
| `InvocationRecord.sourceMessageId` | 0010 | `sourceRecordId` | rename + unique |
| `InvocationRecord.userMessageId` | Clowder | 保留 | v1 = `messageId` |
| `InvocationRecord.idempotencyKey` | Clowder | 删除 | v1 用 `sourceRecordId UNIQUE` + queue receipt |
| auth `invocationId` | Clowder | `turnExecutionId` | rename；它本来就是 child |
| `TurnExecution.parentInvocationId` | 0010 | `a2aParentTurnExecutionId` | rename；因果父，不是 lifecycle parent |
| `TurnExecution.invocationRecordId` | 0010 | 保留 | lifecycle parent |
| `QueueEntry.id` | 双方 | `queueEntryId` | 明确对象；派生 |
| `QueueLedgerPayload.sourceRecordId` | Clowder | 保留 | 队列身份 |
| `QueueLedgerPayload.messageId` | Clowder | 保留 | 消息指针 |

`0001` 的 task-first `QueueEntry` / `Run` 是 legacy 实现；新 runtime 以本文为准。`Task.sourceMessageId`、artifact `provenance_json.sourceMessageId` 是领域指针，可保留旧名，但不得作为队列/parent 身份。

## 7. 派生规则

```text
targetKey(target)   = "agent:" + target.id      // kind=agent
                    | "operator:" + target.id   // kind=operator

queueEntryId        = "queue:" + sha256(sourceRecordId + ":" + attempt).slice(0, 32)

invocationRecordId  = UUID   // unique(sourceRecordId)
turnExecutionId     = UUID   // unique(invocationRecordId, agentId, attempt)
credentialId        = UUID   // unique(turnExecutionId)
```

## 8. 每个 work item 生成的 ID

```text
queueEntryId（派生）
invocationRecordId（parent）
turnExecutionId（child）
credentialId（auth）
```

其余都是 scope、指针或 key。

## 9. 验收检查

`0010` / `0005` / 新实现中不允许出现：

- `sourceMessageId`（A2A runtime）
- `sourceId`（队列/执行）
- `invocationId`（单独使用）
- `parentInvocationId`
- `entryId`
- `idempotencyKey`（parent）

允许的旧名只有：`Task.sourceMessageId`、artifact `provenance_json.sourceMessageId`（领域指针，带注释）。

## 10. 落点

- `0010-a2a-runtime-chain.md`：QueueEntry / InvocationRecord / TurnExecution / Credential 全部改用本文名。
- `0005-thread-first-runtime.md`：runtime chain 与字段同步。
- `0001-codeteam-architecture-v1.md`：legacy `QueueEntry` / `Run` 保留实现原貌，新增注释指向本文。

[宪宪/deepseek-flash🐾]
