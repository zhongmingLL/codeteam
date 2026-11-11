---
title: "codeteam Idempotency Key Map — A2A v1 and adjacent domains"
doc_kind: architecture
status: proposed
created: 2026-11-11
updated: 2026-11-11
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_signoff: pending
related_features: [codeteam/F018, codeteam/F017]
related: [0010-a2a-runtime-chain.md, 0011-identity-contract.md, decision-packets/2026-11-11-dp-f018-a2a-tools.md]
---

# codeteam Idempotency Key Map

> 目的：把 codeteam 里所有“看起来像幂等 key”的名字按层拆开，说明哪些是真重复、
> 哪些是实体 ID / 内部 receipt / payload fingerprint，再与 Clowder 对照，给出
> A2A v1 的唯一客户端 key 模型。本文是幂等 key 的单一真相源；DP-F018A2A-1 以本文为准。

## 0. 结论先行

1. **A2A 消息工具只需要一个客户端幂等 key。** 字段名首选 **`toolCallKey`**：
   它由 pi extension 从 `toolCallId` + `toolName` 派生并注入，名字直接说明
   “这是某次 tool call 的 key”。通用概念仍是 `idempotencyKey`；
   `requestId`（像传输请求号）和 `clientMessageId`（像消息身份）都不准确。
   `requestId` 删除；`credential.clientMessageIds` 不是第二个 ID，而是保存 claim 的 map，
   建议随名字改为 `toolCallClaims`。
2. **codeteam 的“ID 很多”大部分不是幂等 key**：`messageId` / `queueEntryId` /
   `turnExecutionId` / `invocationId` / `credentialId` 是实体 ID；
   `intentHash` 是 payload fingerprint；`(sourceRecordId, attempt)` 是 queue admission receipt。
3. **codeteam 的 client 是 pi extension，不是 MCP client。** extension 已拿到
   `toolCallId`，应从它派生 `toolCallKey` 并注入 control envelope；不要求模型生成 UUID。
4. **`message.idempotency_key` 在 v1 不需要。** message + queue + credential claim 同事务；
   claim 是 `toolCallKey → messageId` 的桥，`queue_admissions` 是 queue row 删除后的
   receipt。只有跨 credential 生命周期重试才需要 message store 幂等索引（v2）。
5. **`toolCallKey` 只用于 tool-call 维度的 A2A 消息工具**；handoff/approval 继续用
   各自的领域 `idempotencyKey`。不要把一个具体字段名强推到所有域。

## 1. 定义

| 术语 | 定义 | 是幂等 key 吗 |
|---|---|---|
| 客户端幂等 key | 调用方为“同一次逻辑操作”生成、retry 时保持不变的字符串；服务端用它找回原结果 | 是 |
| 实体 ID | 服务端生成的对象身份（message/queue/turn/invocation/credential） | 否 |
| 租约/claim ID | 短时并发控制身份（claimId / leaseId） | 否 |
| payload fingerprint | 对不可变 intent 做 hash，用于判断“同 key 是否同 payload” | 否 |
| admission receipt key | 队列准入的 durable 复合 key，用于 live row 删除后的重放 | 内部是 |
| storage-derived key | message store 内部从客户端 key 派生的索引 key | 否（客户端不可见） |

**判断标准**：客户端是否会在 retry 时重新发送同一个值？只有“会”的才是客户端幂等 key。

## 2. codeteam 全量清单

### 2.1 A2A 消息路径（F018）

| 名字 | 类别 | 位置 | 作用 | 处置 |
|---|---|---|---|---|
| `requestId` | 客户端幂等 key（当前） | `a2a/tools.ts:254-302`、`a2a/requests.ts`、`QueueEnqueueInput.requestId` | `a2a_send` retry 去重 | **删除，统一为 `idempotencyKey`** |
| `toolCallKey`（首选） | tool-call 幂等 key（目标字段名） | control envelope、A2A tool handler | 四工具 retry 去重 | **新增；extension 从 `toolCallId` + `toolName` 派生** |
| `idempotencyKey` | 通用概念名 | 文档/类型注释 | 说明 key 的用途 | 不作为 A2A 字段名；handoff/approval 仍用 |
| `clientMessageIds` | claim map（不是 key） | `invocation_credentials.client_message_ids_json` | 客户端 key → `{intentHash, messageId, queueEntryId}` | 保留语义；建议改名 `idempotencyClaims` |
| `intentHash` | payload fingerprint | `a2a/tools.ts:208-219` | 同 key 不同 intent → conflict | 保留；扩到四工具 |
| `a2a_requests.request_id` | 旧 ledger key | migration 016 | task-first 时代的 replay ledger | legacy 只读；v1 不写 |
| `sourceRecordId` | queue admission 输入 | `InvocationQueue.enqueue` | v1 = `messageId`；queue entry 身份 | 保留；内部 |
| `attempt`（admission） | queue admission 序号 | `queue_admissions` | `queueEntryId = hash(sourceRecordId, attempt)` | 保留；不是 execution attempt |
| `queueEntryId` | 实体 ID | `invocation_queue` | queue row 身份 | 保留；内部/结果可返回 |
| `messageId` | 实体 ID | `messages` | 持久消息身份 | 保留；内部/结果可返回 |
| `toolCallId` | pi tool call 身份 | `worker-extension.ts:32-40` | extension 内稳定；派生 `idempotencyKey` 的来源 | 保留；不是 daemon 幂等 key |
| `wreq-N` | connection-local 请求序号 | `worker-extension.ts:126` | control request/response correlation | **不能当幂等 key**；每次重试会变 |

### 2.2 Queue / execution

| 名字 | 类别 | 位置 | 作用 | 处置 |
|---|---|---|---|---|
| `(sourceRecordId, attempt)` | admission receipt key | `queue_admissions` | live row 删除后仍能 `replayed`/`conflict` | 保留 |
| `queue_admissions.fingerprint` | immutable admission fingerprint | §4.x schema | 判断同 source+attempt 是否同 admission | 保留 |
| `claimId` | 短时租约 | `InvocationQueue.claim` | 防并发派发 | 保留；不是幂等 key |
| `turnExecutionId` | 实体 ID | `turn_executions` | child execution 身份 | 保留 |
| `invocationId` | 实体 ID | `invocation_records` | parent record 身份 | 保留 |
| `attemptId` | 实体 ID | `invocation_attempts` | target attempt 身份 | 保留 |
| `credentialId` | 实体 ID | `invocation_credentials` | auth 记录身份 | 保留 |

### 2.3 非 A2A 域

| 域 | 名字 | 作用域 / 唯一约束 | 处置 |
|---|---|---|---|
| handoff | `idempotencyKey` | `(task_id, idempotency_key)` unique（`003-governance.ts:76`） | 保留给非消息域；F018 v1 删除 handoff 工具后不暴露 |
| approval | `idempotency_key` | 全局 unique（`003-governance.ts:149`） | 保留给 Approval 域 |
| budget | `idempotencyKey` | 内部生成 `budget-pause:<task>:<budget>:<n>` | 保留；不是客户端 key |
| Hub API message/thread | `idempotencyKey` | **codeteam 当前缺失**；Clowder 有 `(userId, threadId, key)` | W7a 独立缺口，见 `2026-10-31-clowder-hub-api-compat.md` G1；不在 F018 A2A 路径 |
| artifact/office/review（codeteam v1 未接） | `operationId` / `clientRequestId`（Clowder 参考模式） | 各自 operation receipt | 不纳入 v1；未来接同类 API 时沿用“客户端 key → operation receipt”模式，不与 A2A 合并 |
| memory/person proposal（codeteam v1 未接） | `clientRequestId`（Clowder/F276 参考模式） | proposal 域 | 同上 |

## 3. Clowder 全量清单

| 层 | 名字 | 作用域 / 存储 | 说明 |
|---|---|---|---|
| MCP message tool | `clientMessageId` | tool input；message store 派生索引 | `post_message` / `cross_post_message` 的客户端幂等 key |
| MCP group/action tool | `idempotencyKey` | `multi_mention`、action successor、command | 与 message key 分开；不是同一个语义 |
| message store | `message.idempotencyKey` | `(userId, threadId, key) → messageId` | 服务端派生键，如 `callback:post:<catId>:<sha256(clientMessageId)>`、`multi-mention-source:<requestId>`、`message-lifecycle-response:<invocationId>` |
| queue | `sourceId` / `queueEntryId` / attempt | InvocationQueue + ledger | admission/claim；不是客户端 key |
| invocation record | `idempotencyKey` | `(threadId, userId, key)` | 部分路径的 parent record 幂等；与 message store 并存 |
| auth registry | `clientMessageIds` | `Set<string>` | 参考仓里**没有 route 调用点**，不是 live 机制 |
| agent key | `clientMessageId` | `(agentKeyId, key)`，10k TTL | 持久 agent 的 retry 幂等 |
| approval/task/handoff | `idempotencyKey` | 各域唯一约束 | 与 codeteam 的领域 key 同构 |

**关键事实**：Clowder 普通消息路径的 live 幂等不是 `InvocationRegistry.clientMessageIds`，
而是 message store 的派生索引。codeteam 把同一层放在 credential claim 上，是
DP-F018AUTH-3=B 的选择。

## 4. codeteam ↔ Clowder 对照

| 能力 | codeteam v1 | Clowder | 关系 / 处置 |
|---|---|---|---|
| 客户端消息幂等 | `toolCallKey`（extension 从 `toolCallId` 派生并注入） | `clientMessageId`（MCP client 传入） | 概念相同，名字有意不同；codeteam 选来源可追溯 |
| 客户端 key → 结果 | credential `toolCallClaims` map | message store 派生索引 | 语义等价；存储位置不同 |
| queue admission 重放 | `(sourceRecordId, attempt)` + `queue_admissions` | `sourceId` / queue ledger + message key | 语义等价 |
| payload 冲突检测 | `intentHash` | message payload match / action fence | codeteam 更严格；保留 |
| handoff/approval | `idempotencyKey` | `idempotencyKey` | 对齐；不属于 A2A v1 |
| dead registry Set | 不 port | `InvocationRegistry.clientMessageIds` 无调用点 | 不复制 |
| message store 幂等索引 | v1 不做 | 有 | v1 用 claim + receipt；v2 视 retention 需求再加 |

## 5. A2A v1 目标模型

```text
pi agent loop
  → tool call (toolCallId)
  → worker-extension.execute(toolCallId, params, signal)
  → toolCallKey = derive(toolCallId, toolName)           // extension 生成，不交给模型
  → ControlClient.a2aCall({ workerId, token, toolCallKey, toolName, input })
  → daemon resolveWorkerBinding()                        // credential 是 scope
  → A2AToolHandlers

transaction:
  insert message
  insert invocation_queue entry
  credential.toolCallClaims[toolCallKey] = { intentHash, messageId, queueEntryId }

retry with same toolCallKey:
  claim exists + same intentHash  → replayed (same message/queue)
  claim exists + different intentHash → tool_call_conflict
  no claim → new message/queue/claim
```

**规则**

1. model-facing tool schema 不暴露 `toolCallKey` / `requestId` / `sourceRecordId` / `attempt`。
2. pi extension 从 `toolCallId` + `toolName` 派生 key；`wreq-N` 只做请求关联，不是幂等 key。
3. `ControlClient.a2aCall` 需要 bounded retry；重试沿用同一个 `toolCallKey`。
4. claim map 建议从 `clientMessageIds` 改为 `toolCallClaims`
   （DDL `tool_call_claims_json`），key 是 `toolCallKey`，避免被读成第二个 ID。
5. 错误 taxonomy：`tool_call_conflict`（同 key 不同 intent）、
   `queue_admission_conflict`（同 source+attempt 不同 fingerprint）、
   `a2a_duplicate_delivery`（同 source+target 已 queued/running）。
6. `a2a_requests` 标 legacy；不迁移旧 `request_id`。
7. terminal credential tombstone retention ≥ 客户端重试窗口（建议 30 天，与 Clowder 默认一致）。

## 6. 为什么不是“一个大 ID”

- 客户端 key 必须 retry-stable 且客户端可见；实体 ID 必须服务端生成且客户端不可指定。
- queue row 会删除；credential 也可能 tombstone；queue receipt 需要独立 durable key。
- `intentHash` 不是 key，是“同 key 是否同 payload”的判据；没有它无法区分 replay/conflict。
- 把所有域合成一个实体 ID 会让 handoff/approval 的领域幂等失去语义，也会让
  message store 的实体身份被客户端控制。

## 7. 开放问题

1. **DP-F018A2A-1**：A+ 待 operator 确认；确认后统一改名并落实现约束。
2. **字段名**：`clientMessageIds` → `idempotencyClaims` 是否接受（纯命名修正）。
3. **retention**：credential tombstone 的 GC deadline 具体值（建议 30 天）。
4. **Hub API 幂等**：`POST /api/messages` / `POST /api/threads` 的 `idempotencyKey` 是 W7a
   独立缺口；不与 F018 A2A 工具混用。
5. **模型层重试**：extension bounded retry 失败后返回 typed outcome unknown；是否需要在
   extension 内维护 `intentHash → idempotencyKey` 短期表，避免模型重试生成新 key。

## 8. 代码 / 文档引用

- `packages/codeteam-daemon/src/workers/worker-extension.ts:31-40`（`execute(toolCallId, ...)`）、
  `:108-119`（a2aCall）、`:126`（`wreq-N`）、`:219`（当前忽略 `_toolCallId`）。
- `packages/codeteam-daemon/src/workers/control.ts:199-240`（a2a_call + worker binding）。
- `packages/codeteam-daemon/src/a2a/tools.ts:244-302`（当前 requestId 路径）。
- `packages/codeteam-daemon/src/a2a/requests.ts:69-110`（legacy ledger）。
- `packages/codeteam-daemon/src/control/migrations/016-a2a-request-dedupe.ts`。
- `packages/codeteam-daemon/src/control/migrations/003-governance.ts:50/76/130/149`（handoff/approval）。
- `packages/codeteam-daemon/src/control/migrations/001-core.ts:96-115`（messages 无 idempotency 列）。
- Clowder：`packages/mcp-server/src/tools/callback-tools.ts:343/774`（post/cross schema）、
  `packages/api/src/routes/callbacks.ts:666-669/1996-2005`（callback key + message store lookup）、
  `packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts:711-790`、
  `packages/api/src/domains/cats/services/stores/ports/MessageStore.ts:2055/2565`、
  `packages/api/src/domains/cats/services/agents/invocation/InvocationRegistry.ts:59/307`。

[宪宪/deepseek-flash🐾]
