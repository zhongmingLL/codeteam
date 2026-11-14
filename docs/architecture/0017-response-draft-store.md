---
title: "ResponseDraftStore contract — durable streaming drafts"
doc_kind: architecture
status: draft-for-review
created: 2026-11-13
updated: 2026-11-13
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related: [0007-a2a-runtime-chain.md, 0016-turn-terminal-and-settlement-design.md, 0020-f018-thread-first-runtime.md, decision-packets/2026-11-12-dp-f018-surface-depth-readmodels.md]
related_features: [codeteam/F018]
source: "Clowder DraftStore/response-draft-settlement; F018 F-15 gap"
---

# ResponseDraftStore contract

> 目的：把 F-15 的 durable streaming 存储层契约钉死。`response_drafts` 表已有
> 0007 §4.3.2；本文补 **Store interface、写/合并/seq、生命周期、删除失败、重连读取、
> orphan/清理和测试**。实现按本文落 R2。

## 0. 结论先行

1. **一行一个 attempt/turn**：`attempt_id` 1:1，`turn_execution_id` 1:1；没有 draft 历史。
2. **全量 snapshot upsert，不做 SQL delta merge**：`WorkerEventSink` 在内存累积
   text/thinking/tool events，flush 时写完整 snapshot；Store 只做 `seq` CAS。
3. **一个 writer**：只有 `WorkerEventSink` 写；T2/T4 只删；Hub 只读。
4. **无 TTL**：draft 活到 R terminal；T2 删除失败不阻塞 R terminal，但 attempt 保持
   `response_pending`，由 T4 重试删除后再 settle。
5. **删除后不允许复活**：T2 删除后的 late flush 返回 `deleted`，不重建 draft。

## 1. 现状与缺口（F-15）

已有：

- `0007` §4.3.2 的 `response_drafts` 表：`attempt_id` / `turn_execution_id` 1:1，
  `content` / `content_blocks_json` / `tool_events_json` / `thinking` / `seq` / 时间。
- `0007` §3.6.1 的行为草图：stream → draft；`message_end` 覆盖；T2 删除；T4 恢复。

缺：

- `ResponseDraftStore` interface（create/upsert/get/delete/orphan）。
- 全量 snapshot 与 `seq` CAS 的精确语义；重复/乱序/删除后 late flush。
- T2 删除失败与 T4 重试的边界；R terminal 与 draft 删除的顺序。
- Hub 重连读取、thread 列表、orphan 清理、测试矩阵。

## 2. Clowder 参考

- `IDraftStore`：`upsert` / `getByThread` / `delete` / `deleteByThread`；Redis 实现用
  `draft:{userId}:{threadId}:{invocationId}` hash + thread 索引。
- F117 KD-21/KD-23：**不设 TTL**。draft 活到 R terminal；删除失败由 response-pending
  账本在下次 settlement 重试，而不是让 draft 过期。
- `response-draft-settlement.ts`：R 已 terminal 时只删 draft + clear pending；R
  processing 时从 draft 提交 R，再删 draft、clear pending。

codeteam 的适配：

- 单 SQLite 行，不建 thread index 表；`response_drafts(thread_id, updated_at)` 索引。
- 用 `turn_execution_id` / `attempt_id` 而不是 `userId+threadId+invocationId`；user
  从 parent/thread 派生，draft 不存 userId。
- 需要 `seq`：Clowder 的 flush 是 upsert 全量 field；codeteam 加单调 `seq` 防乱序/
  重复 flush 覆盖新内容。

## 3. 数据模型

沿用 `0007` §4.3.2：

```ts
interface ResponseDraft {
  attemptId: string;
  turnExecutionId: string;
  parentInvocationId: string;
  threadId: string;
  agentId: string;
  content: string;
  contentBlocks: unknown[];
  toolEvents: unknown[];
  thinking: string | null;
  seq: number;              // draft snapshot version，不是 messages.seq
  createdAt: number;
  updatedAt: number;
}
```

不存 `userId`、`rich`、`metadata`、message `seq`。`rich` 在 T2 由最终 text/contentBlocks
生成；draft 不是 message history。

## 4. Store interface

```ts
type DraftWriteOutcome =
  | "applied"
  | "stale"          // seq <= 当前 seq，旧/重复 flush
  | "not_found";     // 行不存在（未 create 或已被 T2/T4 删除）

interface DraftSnapshotInput {
  attemptId: string;
  turnExecutionId: string;
  parentInvocationId: string;
  threadId: string;
  agentId: string;
  content: string;
  contentBlocks: unknown[];
  toolEvents: unknown[];
  thinking: string | null;
  seq: number;
  now: number;
}

interface ResponseDraftStore {
  /** T1 dispatch tx：幂等 create；同 identity 返回 existing，不同 identity conflict。 */
  create(input: Omit<DraftSnapshotInput, "seq" | "now"> & { now: number }): {
    outcome: "created" | "replayed" | "conflict";
    draft: ResponseDraft | null;
  };

  /** WorkerEventSink flush：全量 snapshot；seq 必须严格递增。 */
  upsertSnapshot(input: DraftSnapshotInput): {
    outcome: DraftWriteOutcome;
    draft: ResponseDraft | null;
  };

  getByTurn(turnExecutionId: string): ResponseDraft | null;
  getByAttempt(attemptId: string): ResponseDraft | null;
  getByThread(threadId: string, opts?: {
    limit?: number;
    cursor?: string;
  }): ResponseDraft[];

  /** T2/T4：幂等删除；不存在返回 already_absent。 */
  delete(turnExecutionId: string): { outcome: "deleted" | "already_absent" };
  deleteByThread(threadId: string): number;

  /** 只返回 R 已 terminal 或 turn 已 terminal 的残留 draft；用于清理。 */
  listOrphans(olderThan: number, limit?: number): ResponseDraft[];
}
```

`create` 的 identity = `attemptId + turnExecutionId`；同 identity 的 `parentInvocationId`/
`threadId`/`agentId` 必须一致，否则 `conflict`。

## 5. 写/合并语义

### 5.1 单一 writer

- `WorkerEventSink` 是唯一写者；它同时持有该 turn 的内存 accumulator。
- `TurnExecution` 唯一 running + `RpcConnection.prompting` 保证同一 turn 不会有两个
  provider writer；Store 不做跨 writer 合并。

### 5.2 全量 snapshot，不在 Store 做 delta merge

- text delta：accumulator `content += delta`；
- thinking：accumulator `thinking += delta`；
- tool start/end：按 `toolId` 在 accumulator 合并（start 创建，end 更新 status/result）；
- `message_end`：用最终 text/tool events 覆盖 accumulator，避免 delta 重复。
- flush：`seq = 当前 draft.seq + 1`（首次从 1 开始；dispatcher/Sink 启动时用
  `getByTurn` 读当前值），调用 `upsertSnapshot` 写完整 snapshot。seq 允许有 gap，
  不要求连续，只要求严格递增。

不在 Store 提供 `appendText` / `upsertToolEvent`：SQLite 的 JSON 合并会引入顺序/并发
复杂度，且 Clowder 的 DraftStore 本来就是 upsert 全量。Store 只负责“最新 snapshot 胜出”。

### 5.3 seq CAS

`upsertSnapshot` 在一个 `ControlTransaction` 内：

1. `UPDATE response_drafts SET content=..., content_blocks_json=..., tool_events_json=...,
   thinking=..., seq=:seq, updated_at=:now WHERE turn_execution_id=:id AND seq < :seq`；
2. 影响 1 行 → `applied`；
3. 影响 0 行：行存在且 `seq >= :seq` → `stale`；行不存在 → `not_found`。

规则：

- 同 seq 重复 flush → `stale`（幂等，不覆盖）；
- 低 seq 乱序 → `stale`；
- 高 seq 正常 → `applied`；
- 行已被 T2/T4 删除 → `not_found`，**不重建**；late flush 只记 warning/telemetry。
- `content_blocks_json` / `tool_events_json` 是完整数组，不是增量。

### 5.4 删除后的 late flush

T2/T4 删除 draft 后，provider/worker 的 late event 可能仍到达 `WorkerEventSink`。Store
返回 `not_found`；Sink 不得再 `create`，只记录 `draft_deleted_late_flush`。这防止
terminal 后幽灵 draft 复活。

## 6. 生命周期与事务

### 6.1 T1 dispatch

与 `invocation_attempts` / processing R / `TurnExecution.createRunning` 同一事务：

```text
create({
  attemptId, turnExecutionId, parentInvocationId, threadId, agentId,
  content: "", contentBlocks: [], toolEvents: [], thinking: null,
  now
})
```

`create` 幂等：同 identity 的 replay 返回 existing draft；不同 identity `conflict`。
draft 初始 `seq=0`。

### 6.2 stream

每 100ms / 4KB（provisional）flush 一次 `upsertSnapshot`；seq 递增。没有客户端时仍写
draft，因为刷新/崩溃恢复依赖它，而不是依赖 socket。

### 6.3 T1 child terminal

T1 **不写/不删 draft**。child terminal 只写 TurnExecution/credential/attempt projection/
settlement=`response_pending`；draft 继续保留给 T2/T4。

### 6.4 T2 response commit

顺序：

1. `commitLifecycleResponseTerminal(R, draft.body, child terminal status)`；
2. `settleLifecycleResponseInputs(R)`；
3. `draftStore.delete(turnExecutionId)`；
4. `attempt.setSettlement('settled')` + `clearResponsePending`；
5. A2A successor。

删除失败：

- R 已 terminal 不回滚；**不**执行第 4 步；
- attempt 保持 `response_pending`，T4 下次只重试 delete + settle，不重复提交 R；
- 这是 Clowder F117 KD-21/23 的同一语义：draft 先消失，turn 才离开 pending ledger。

### 6.5 T4 recovery

`ResponseRecoveryService` 对 `response_pending`：

1. 读 attempt → R → draft；
2. R processing：用 draft snapshot 提交 R terminal + settle inputs；
3. R 已 terminal：跳过 R commit；
4. `delete(turnExecutionId)`；
5. `setSettlement('settled')` + `clearResponsePending`。

- R processing 但 draft 不存在 → `response_missing` recovery：R failed + typed system
  message + `terminalReason='response_missing'`；不伪造空正文。
- R terminal 但 draft 已不存在 → 只 clear pending。
- delete 失败 → 保留 `response_pending`，下次再试。

### 6.6 崩溃窗口

| 崩溃点 | 结果 | 恢复 |
|---|---|---|
| create 后、首次 flush 前 | 空 draft；child running/appended | startup reaper → T1；T4 用空 draft 提交 failed/interrupted R |
| flush 后、T1 前 | draft 有部分正文；child running | startup reaper → T1；T4 从 draft 提交 |
| T1 后、T2 前 | child terminal；attempt response_pending；draft 保留 | T4 提交 R |
| T2 R terminal 后、delete 前 | R terminal；draft 残留 | T4 只 delete + settle |
| delete 后、settle/clear 前 | draft 已删；attempt response_pending | T4 只 clear pending |
| delete 失败 | R terminal；draft 残留；attempt response_pending | T4 重试 delete |

## 7. 保留、orphan 与清理

- **无 TTL**：draft 活到 R terminal；不设 `expires_at`。
- T2/T4 delete 是唯一正常删除路径；thread 删除走 `deleteByThread`。
- `listOrphans(olderThan)` 只返回：
  - 对应 TurnExecution 已 terminal（或 parent/thread 已删除），且
  - R 已 terminal（或不存在），且
  - `updated_at < olderThan` 的 draft。
- orphan 清理由 startup/T4/reaper 的 bounded sweep 执行；删除失败保留，下次再试。
- 不在 read path 自动删除；Hub 读不到 terminal R 的 draft（read model 过滤）。
- v1 不设 draft 大小硬上限；provider output 本身有界，T2 message store 的 body 限制
  是最终防线。若 T2 因 body 超限失败，R 以 failed 结束，draft 由 T4 删除。

## 8. 读取与 Hub 重连

- `getByTurn(turnExecutionId)`：刷新/重连时按 turn 精确取 draft；返回 `seq`/content/
  blocks/toolEvents/thinking/updatedAt。
- `getByThread(threadId, {limit, cursor})`：live/queue read model 用；按 `updated_at`
  asc，cursor 稳定；只返回仍存活 draft。
- Hub 合并规则：processing R + draft 渲染为 processing bubble；以 `seq` 去重；
  `seq <= draft.seq` 的事件丢弃；`complete` 用 `responseMessageId` 替换。
- Store 不做 R 状态过滤；read model 必须过滤 R 已 terminal 的残留 draft，不渲染；
  这些残留由 `listOrphans` / T4 清理。
- 访问控制：draft 不存 userId；调用方必须已通过 thread access；Store 不做跨 user
  visibility filter。

## 9. 测试矩阵

- create：同 identity replay；不同 parent/thread/agent conflict；dispatch 事务回滚无 draft。
- upsert：seq 递增 applied；同 seq stale；低 seq stale；高 seq applied；行删除后
  `not_found` 且不重建。
- snapshot：text/thinking/toolEvents 全量替换；toolId 合并在 Sink 层；message_end
  覆盖不重复。
- delete：幂等；deleteByThread；删除后 late flush 不复活。
- T2：R terminal 后 delete 成功 → attempt settled + clear pending；delete 失败 →
  response_pending 保留；T4 只重试 delete，不重复 R commit。
- T4：R processing + draft → 提交 R；R terminal + draft → 只删/清；draft missing +
  R processing → response_missing；draft missing + R terminal → 只清 pending。
- crash：create/flush/T1/T2/delete 各窗口。
- 并发：同 turn 重复 flush；parallel children 各自 draft；multi_mention N children
  per-child draft；不同 turn 相同 agent/thread 不串行化。
- 读取：getByTurn/getByThread 排序/cursor；terminal R 的 draft 不在 read model。

## 10. 非目标

- 不建 per-delta message 行；draft 不是 history。
- 不做 draft 历史/版本链；只保留最新 snapshot。
- 不做跨 user draft；不做 rich/metadata 持久化（T2 生成）。
- 不做多 writer 合并；provider/worker 单写由 TurnExecution/worker binding 保证。
- 不做 draft TTL；orphan 清理不是 TTL。

## 11. Clowder 映射

| 类型 | Clowder | codeteam | 关系 |
|---|---|---|---|
| 读模型 | `DraftRecord` | `ResponseDraft` | `ResponseDraft` 是 `DraftRecord` 的 codeteam 投影 |
| 写输入 | `DraftRecord`（直接作为 `upsert(draft)` 入参） | `DraftSnapshotInput` | Clowder 没有独立 input 类型；codeteam 把写侧 `seq`/`now` 拆出来 |
| Store port | `IDraftStore` | `ResponseDraftStore` | 同一语义；codeteam 扩展 `getByTurn`/`getByAttempt`/`listOrphans` |
| 实现 | `DraftStore` / `RedisDraftStore` | SQLite `ResponseDraftStore`（待实现） | 存储适配 |
| 写结果 | `void \| Promise<void>` | `DraftWriteOutcome` | codeteam 需要 `applied/stale/not_found`，Clowder upsert 不返回结果 |

`DraftSnapshotInput` 不是 Clowder 的独立类型；它对应 `IDraftStore.upsert(draft: DraftRecord)`
的入参字段。`ResponseDraft` 对应 `DraftRecord`，但去掉了 `userId/metadata/extra`，
增加了 `attemptId/turnExecutionId/parentInvocationId/agentId/contentBlocks/seq`。

| 维度 | Clowder | codeteam | 判断 |
|---|---|---|---|
| record key | `userId + threadId + invocationId` | `attemptId + turnExecutionId`；user 从 parent/thread 派生 | 身份适配；codeteam 单 user v1，不把 userId 写进 draft |
| 创建时机 | route stream 首次 flush 时 lazy `upsert` | T1 dispatch 事务显式 `create` 空 snapshot | 有意差异：codeteam 有 attempt/TurnExecution/R 的 FK/1:1，需同事务建行 |
| 写入 | `upsert(draft)` 全量 snapshot | `upsertSnapshot(seq)` 全量 snapshot | 语义相同；codeteam 加 seq CAS |
| 字段 | content/toolEvents/thinking/metadata/extra | content/contentBlocks/toolEvents/thinking | codeteam 不存 metadata/extra/rich；T2 从最终正文生成 rich |
| 读取 | `getByThread(userId, threadId)` | `getByThread(threadId, cursor/limit)` + `getByTurn` + `getByAttempt` | 存储适配；codeteam settlement 用显式 attempt/turn 定位 |
| 删除 | `delete(userId, threadId, invocationId)` / `deleteByThread` | `delete(turnExecutionId)` / `deleteByThread` | 语义相同，key 不同 |
| TTL | 无 TTL（F117 KD-21/23） | 无 TTL | 相同 |
| R terminal 后删除 | route commit R → delete draft → clear pending | T2 R terminal → delete draft → attempt settled + clear pending | 相同顺序；codeteam 拆成 T2/T4 owner |
| 删除失败 | 保留 response-pending，下次 settlement 重试 | 保留 `response_pending`，T4 只重试 delete + settle | 相同 |
| settlement | `settleResponseFromDraft` 按 thread+invocationId 读 draft，提交 R，再 delete/clear | T2 `RouteResponseCommitter` + T4 `ResponseRecoveryService`；读 draft 提交 R，delete/clear | 语义相同；owner 拆分 |
| orphan 清理 | Redis thread index 在 `getByThread` 时顺手清理 stale member | `listOrphans` + `deleteByThread` | 存储适配；SQLite 无 Redis index |
| seq | 无 seq；Redis 后写覆盖，`updatedAt` 只做时间 | `seq` 严格递增 + CAS | codeteam 扩展：防重复/乱序 flush + 重连去重 |
| 多 user 隔离 | userId 作为 key 的一部分 | thread access + user 派生；draft 不存 userId | v1 单 user 有意简化；multi-user 再加 userId/ACL |

### 11.1 语义相同的部分

- 一个 child turn 只有一份 draft；不是 message history。
- flush 写全量 snapshot（Clowder `upsert`；codeteam `upsertSnapshot`）。
- 不设 TTL；draft 活到 R terminal。
- R terminal 后删除 draft；删除失败保留 pending，下次 settlement 重试。
- Hub 刷新/重连从 processing R + draft 恢复；不把每个 delta 写成 message。

### 11.2 为什么不做逐行照抄

- **存储不同**：Clowder 是 Redis hash + thread index；codeteam 是 SQLite 单表 + FK，
  所以需要 `getByTurn`/`getByAttempt`、`listOrphans` 和 `deleteByThread`。
- **身份不同**：Clowder 的 draft key 用 child `invocationId`；codeteam 的 child 坐标是
  `turnExecutionId`，attempt 是投递台账，两者都要能定位 draft。
- **创建时机不同**：Clowder 没有 attempt/TurnExecution FK，可以首次 flush lazy create；
  codeteam 在 T1 dispatch 事务里建空 draft，保证 attempt/R/child/draft 原子绑定。
- **事件顺序不同**：codeteam 的 stream 事件经 control socket/批处理，可能重复/乱序，
  所以加 `seq` CAS；Clowder Redis 版本没有这个字段，按后写覆盖。
- **settlement owner 不同**：codeteam 已拍 T2 route/committer、T4 recovery；Clowder 的
  settlement 更集中。draft 的读写语义保持不变，只拆 owner。

### 11.3 `metadata` / `extra` 的作用与取舍

- `metadata`：`MessageMetadata` 是 provider/model/sessionId/usage/diagnostics/
  subexecution events 等 carrier。Clowder route 每次 flush 用
  `mergeMessageMetadataSnapshots` 写入 draft，注释用途是 F5 recovery；但当前
  `messages.ts` 的 draft 读取路径只合并 `extra.outputLayout`，**没有消费
  `draft.metadata`**；R settlement 也是从 route state/response 取 metadata，不是从
  draft 取。它更像历史/预留字段。
- `extra.outputLayout`：`MessageOutputLayoutV1` 是富输出的布局引用（owner/runs/order/
  contentRevision），不是第二份正文；`messages.ts` 用它恢复 streaming message 的
  布局。
- codeteam v1：没有 output-layout projection；最终 `extra.rich` 在 T2 由最终
  text/contentBlocks 生成；provider/model/usage 在 `invocation_attempts`。因此
  draft 不存 `metadata`/`extra`，不损失 R settlement 或 live text/tool 恢复。
- 如果以后产品要求“流式中显示 provider/model/usage 或富布局”，再给 draft 加一个
  小的 `extra` 扩展；不要现在整包复制 Clowder 的 metadata。

## 12. 参考

- `0007` §3.6.1（durable stream）、§4.3.2（`response_drafts` 表）、§3.9（T1/T2/T3/T4）。
- `0016` §5.3（T2/T4 事务边界）、§5.4（错误/取消/重试）。
- `0015` §3.2 F-15；`decision-packets/2026-11-12-dp-f018-surface-depth-readmodels.md` §5。
- Clowder `packages/api/src/domains/cats/services/stores/ports/DraftStore.ts`、`RedisDraftStore.ts`、
  `response-draft-settlement.ts`。

[宪宪/deepseek-flash🐾]
