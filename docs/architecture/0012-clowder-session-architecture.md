---
title: "Clowder session 架构全局梳理"
doc_kind: architecture
status: draft
created: 2026-11-11
updated: 2026-11-11
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related_features: [codeteam/F017, codeteam/F018]
source: "Clowder local reference checkout; paths below are repo-relative, not runtime dependencies"
---

# Clowder session 架构全局梳理

> 目的：先看 Clowder 的 session 系统整体如何分层、谁拥有什么、生命周期如何流转，
> 再决定 codeteam 哪些 contract 该复用、哪些该适配、哪些该明确推迟。
> 本文是 **reference architecture 分析**，不是 codeteam 的实现契约。

## 0. 结论先行

1. Clowder session **不是一个 store**，而是五层：存储适配器、domain store、
   生命周期服务、invocation/context、API/UI。
2. Clowder 没有 `AgentSessionStore` 这个类；`SessionStore` 是 Redis 适配器，
   真正的 domain 是 `SessionManager` + `SessionChainStore` + `DeliveryCursorStore`
   + `RuntimeSessionStore`。
3. `SessionRecord` 的核心不是“一行 active session”，而是
   **active → sealing → sealed + chain(seq) + restore + policy/compression**。
4. Delivery cursor、messageCount、restore failures 分别属于不同的生命周期，
   不能用一个“session 表”的字段语义糊过去。
5. codeteam 当前设计的最大问题不是字段少，而是**把 adapter、domain、lifecycle
   三层压成一层**，导致 DeliveryCursor、seal/restore、context policy 等没有正确归属。

## 1. 五层架构

```text
L0 存储适配器
  SessionStore (Redis)          session-id map / delivery/mention/seen cursor / cat state
  SessionChainStore (Redis)     session record / chain / active index / cli index / chainKey
  RuntimeSessionStore           external runtime metadata
  MessageStore / ThreadStore    messages / thread / participants / memory
  TranscriptWriter/Reader       sealed transcript / digest

L1 domain store / contract
  SessionManager                (userId, catId, threadId) -> sessionId
  SessionChainStore             SessionRecord lifecycle + chain + restore
  DeliveryCursorStore           delivery/mention/seen cursor semantics
  RuntimeSessionStore           runtime identity + lifecycle
  AgentRegistry / AgentState    roster + runtime cat state

L2 生命周期服务
  SessionSealer                 active -> sealing -> sealed; transcript/digest/thread memory
  SessionStrategy               handoff/compress/hybrid; thresholds; policy snapshot
  RuntimeSessionSealReaper      runtime seal pending drain/retry
  SessionCompactionSurface      context epoch / continuity after compaction

L3 invocation / execution
  AgentRouter -> routeSerial/Parallel -> invoke-single-cat
  session resolution / restore / seal / retry / session_init binding / messageCount
  AcpProcessPool                process pool / lease / session affinity

L4 context / history
  DeliveryCursorStore + MessageStore -> incremental context
  ContextAssembler / smart window / token budget / boundary / ack
  SystemPromptBuilder / prompt hooks / navigation / memory

L5 API / UI
  session-chain routes          list / restore / seal / unseal / import
  runtime-session routes/panel
  session strategy settings
```

**关键点**：L0 的 `SessionStore` 把多组 key 放在同一个 Redis 类里，是存储便利；
domain 边界在 L1。按类名把 codeteam `AgentSessionStore` 对到 Clowder `SessionStore`
会直接丢层。

## 2. 对象与 owner

| 对象 | 坐标 / 关键字段 | owner | 说明 |
|---|---|---|---|
| `SessionManager` 映射 | `(userId, catId, threadId) → sessionId` | session | Redis key，TTL 24h；内存 fallback；只是候选 runtime id |
| `SessionRecord` | `id/seq/status/threadId/catId/userId/cliSessionId/...` | session chain | durable session 真相；active/sealing/sealed；chain seq |
| `RuntimeSessionMetadata` | `sessionId/runtime/runtimeSessionId/threadId/catId/identityHistory/lifecycle` | external runtime | Antigravity/IDE 等外部 runtime 的身份与 lifecycle；不是 roster truth |
| `DeliveryCursor` | `(userId, catId, threadId) → cursor` | delivery | delivery/mention/seen 三个 namespace；单调 CAS |
| `AgentState` | catId → runtime state | roster/runtime | Clowder `SessionStore.getCatState/setCatState` 的 domain 归属 |
| `AcpLease` | client/poolKey/sessionId/canResume/release | execution | 进程池租约；可 multiplexing，带 session affinity |
| `Transcript` / `Digest` | sessionId → transcript/digest | session seal | sealed session 的可读历史与 handoff 材料 |

**一个容易混淆的点**：`SessionRecord.cliSessionId` 是 provider/CLI 的 runtime id；
`SessionManager` 的映射是它的快速索引；`SessionChainStore` 的 `id` 才是 Clowder 的
logical session id。三者不是同一个 id。

## 3. 生命周期

### 3.1 SessionRecord：active → sealing → sealed

`packages/shared/src/types/session.ts`：

- 同一 `(userId, catId, threadId)` 只有一个 active record；chain 按 `seq` 递增。
- `active`：当前可用；`sealing`：已请求封存，正在写 transcript/digest；
  `sealed`：不可变历史，可被 restore。
- `create` / `getOrCreateActive` 在 provider launch 前先建 logical node；
  `session_init` 只把 provider runtime id 绑到这个 node，不是创建门槛。
- `bindCliSessionId` / `bindCliSessionIdIfUnbound`：runtime id 绑定；CAS 防冲突。
- `transitionToSealing`：active → sealing，清 active pointer；可带 policy revision CAS。
- `SessionSealer.finalize`：写 transcript、digest、thread memory，再标 sealed；
  finalize 失败也会尝试 sealed（partial，可恢复），避免卡在 sealing。
- `restoreActiveSession`：sealed target → active；当前 active 被 displaced 成 sealing；
  必须确认 `expectedActiveSessionId`，并检查 busy；scopedInvocation 不可 restore。
- `scopedInvocation`：一次性 collective 执行，只作 trace，不是 home resume candidate。

### 3.2 RuntimeSession：external runtime 的第二条生命周期

`RuntimeSessionMetadata` / `RuntimeSessionStore`：

- 状态：`active → runtime_seal_pending → runtime_conflict_pending → sealed`。
- 记录 `runtimeSessionId`、`identityHistory`、drain result、retryCount、
  unexpected switch。
- `RuntimeSessionSealReaper` 扫描 `runtime_seal_pending`，drain 外部 runtime；
  成功或 unreachable 后 requestSeal + finalize；失败重试，最多 5 次。
- 这条 lifecycle 只属于 external runtime（Antigravity/IDE），不是普通 CLI session
  的必经路径；但说明 session 生命周期不止 SessionRecord 一条。

### 3.3 Context policy：handoff / compress / hybrid

`config/session-strategy.ts`：

- `handoff`：fillRatio 或 budget 达阈值 → seal，下一 session 从 bootstrap/capsule 恢复。
- `compress`：允许 provider 自己压缩，不主动 seal。
- `hybrid`：允许 N 次 compression，超过后 `seal_after_compress`。
- 每个 managed invocation 绑定一个 `SessionPolicySnapshot`（config/source/revision/
  execution status）；compression event 带 policy revision，stale revision 不归因。
- `capacityPin` 是 active session 的 shrink-only 容量约束；只有新 session 才能扩。
- `contextHealth`（usedTokens/windowTokens/fillRatio/source/usedFrom/measuredAt）
  驱动 warn/seal/compress 决策。

### 3.4 Invocation retry / circuit breaker

`invoke-single-cat.ts`：

- resume 失败 / provider session 丢失 / native binding 变化 → 删除 `SessionManager`
  映射、`consecutiveRestoreFailures += 1`、fresh 重试。
- `consecutiveRestoreFailures >= 3` → `SessionSealer.requestSeal + finalize` 旧 record，
  再 fresh；不是只清 binding。
- 有 substantive output 时把 `consecutiveRestoreFailures` 归零。
- imported history 必须 resume 同一个 `cliSessionId`，不允许静默替换。

### 3.5 messageCount / unseal safety

- 首次 user-visible output：`messageCount` 0 → 1（unseal safety）。
- `done` 时同一 invocation 不重复 +1；有 output 的 completed turn 最多 +1。
- 这个计数器用于“空 session 可被置换，有输出的 session 不能静默 seal/fold”。

## 4. 调用链

### 4.1 Invocation 如何解析 session

```text
sessionManager.get(userId, catId, threadId)
  -> candidate cliSessionId (Redis map, TTL 24h)

sessionChainStore.getChain/getActive(catId, threadId, userId)
  -> active SessionRecord 是权威
  -> chain 非空但无 active = 前一个已 sealed，不能 resume candidate

getOrCreateManagedSessionRecord(...)
  -> provider launch 前先建/取 logical node
  -> 可绑定已有 cliSessionId；冲突时建 unbound replacement

policy/runtime custody mutex
  -> policy:<user:cat:thread> 先拿，再拿 runtime:<cliSessionId>
  -> 重新 getOrCreateActive，避免 queued 期间 session 被 seal

provider 启动
  -> session_init(sessionId) -> bindCliSessionId(logicalId, sessionId)
  -> sessionManager.store(userId, catId, threadId, sessionId)
```

### 4.2 PreCompact / compression / seal

```text
provider PreCompact hook
  -> sessionChainStore.getByCliSessionId(cliSessionId)
  -> status must be active
  -> recordCompressionEvent(policy revision, invocationId)
  -> shouldTakeAction(fillRatio, ...)
       compress / hybrid -> allow_compress
       handoff / budget / max_compressions -> requestSeal + finalize
```

### 4.3 Done / messageCount

- `done` event：若无 stream error，按 output 情况更新 `messageCount`；
  重置 restore failures；写 usage/context health。
- `session_init` 之后 provider runtime id 与 logical session id 已绑定；
  `sessionManager` 只是可丢的快速索引。

### 4.4 Restore / unseal / import

- `POST /api/sessions/:sessionId/unseal`：sealed → active；
  当前 active 被 displaced 成 sealing；需要 `expectedActiveSessionId` 和 busy guard。
- `GET /api/threads/:threadId/sessions`：按 cat/thread 列 chain；
  runtime session summary 是附加投影。
- `externalImport`：用户显式采纳已有 native history；resume 时必须命中同一
  `cliSessionId`，否则拒绝替换。
- `backfillBoundSessionHistory`：恢复后补 thread/message 历史。

## 5. History / delivery cursor

`DeliveryCursorStore` + `MessageStore` + `route-helpers`：

- key = `(userId, catId, threadId)`；cursor 是 visibility cursor（v1 raw id /
  v2 `v2:<seq>:<messageId>`）。
- `getCursor` 取 max(memory, Redis) 并 canonicalize；`ackCursor` 单调 CAS；
  另有 mention ack / seen cursor 两个独立 namespace。
- 增量上下文：`getByThreadAfter(cursor)` → visibility/self/briefing/display-only
  filter → smart window/cold/hot → token budget trim → boundary。
- boundary 取已消费的最后一条（不是进入 prompt 的最后一条）；token trim 不阻塞 ack。
- ack 在 response 之后执行；serial 路径“regardless of error”也 ack，因为 prompt
  已组装并交付；overlay 路径等 successful done。核心语义：**不 ack 会无限重放；
  ack 太早会吞消息**。
- 同一 thread 不同 cat 各自一个 cursor；A 的 cursor 会越过对 A 不可见的定向消息。

## 6. Execution carrier

`AcpProcessPool`：

- key = `(projectPath, providerProfile)`；一个进程可被多个 lease 共享
  （multiplexing）；session affinity 通过 `sessionOwners` 保持。
- idle TTL + LRU + `maxLiveProcesses`；health check；stale lease generation。
- `AcpLease` 的 release 是幂等的；sealed session 不能 resume，返回 fresh carrier。
- 这与 codeteam 的 pi RPC 约束不同：pi v1 一进程一 session，没有 `session/new/load`；
  所以 codeteam 采用 ephemeral worker + durable binding 是合理适配，但不能把
  `WorkerPool` 当成 `AcpProcessPool` 的 1:1。

## 7. 失败与恢复矩阵

| 失败点 | Clowder 行为 | 关键证据 |
|---|---|---|
| resume 失败 / provider session 丢失 | 删除 mapping、failures+1、fresh 重试 | `invoke-single-cat.ts` retry 段 |
| failures >= 3 | requestSeal + finalize 旧 session，再 fresh | overflow circuit breaker |
| sealing 卡住 | `SessionSealer.reconcileStuck/reconcileAllStuck` 强制 finalize | SessionSealer |
| restore 目标非 sealed | 409 typed reject | session-chain route |
| restore 时 active 变化 | 409 `active_session_changed` | restore CAS |
| restore 时有 queued/running work | 409 `session_switch_busy` | session-chain route |
| runtime seal pending | drain/retry，max 5，再 seal | RuntimeSessionSealReaper |
| runtime unreachable | seal with `runtime_disconnected` | RuntimeSessionSealReaper |
| cursor 格式不一致 | canonicalizer + reconcile | DeliveryCursorStore |
| stale session index | 修复或 fail closed | RedisSessionChainStore |

## 8. codeteam 当前映射的问题

| codeteam 当前假设 | Clowder 实际 | 后果 |
|---|---|---|
| `AgentSessionStore` ≈ Clowder `SessionStore` | `SessionStore` 是 Redis adapter；domain 是 `SessionManager + SessionChainStore` | 丢失 DeliveryCursor、cat state、chain 的归属 |
| active + lightweight seal 一行就够 | SessionRecord 有 active/sealing/sealed + chain(seq) + restore | v1 保留 `seq/status/sealReason/sealedAt` 和 `active → sealed`；full seal/restore/chain 导航放 v2 |
| DeliveryCursor 是附属 | 它是 history 读边界，与 session identity 不同生命周期 | 容易在 reset/ack/restore 时吞消息或重放 |
| messageCount 只计有输出的 turn | 首次 output 0→1，done 只 +1 一次；无输出 completed turn 也 +1 | 计数偏高/偏低，影响 unseal safety |
| consecutiveResumeFailures 只是计数 | 3 次会 seal 旧 session + fresh | v1 已改为 lightweight seal + `seq+1`；只清 binding 会留下旧 logical session 继续被选中 |
| `WorkerPool` ≈ `AcpProcessPool` | ACP 长驻/multiplexing/lease；pi 一进程一 session | worker 语义可适配，但不能复用 lease/affinity 假设 |
| full seal/restore/policy/runtime session 都是 v2，可以先不管 | 它们反过来决定 SessionRecord 字段和状态机 | v1 已保留 lightweight seal 字段；full restore/chain 仍需迁移/扩展 |
| userId 可省 | Clowder 有 owner-scoped active index 和 cursor key | v1 单 user 可简化，但 owner 边界必须保留 |

## 9. 复用建议（按层，不按类名）

### v1 直接复用 contract

- 坐标：`(userId, catId, threadId)`；同一坐标只有一个 active logical session。
- logical session 在 provider launch 前创建；`session_init` 只绑定 runtime id。
- `cliSessionId` 是 provider runtime id，不是 logical session id。
- `messageCount` 语义：首次 output 0→1；done 时本 turn 未计数则 +1（无输出
  completed turn 也 +1），不重复。
- `consecutiveRestoreFailures` + 3 次 circuit breaker。
- delivery cursor 的 fetch-after / monotonic ack / boundary 语义。
- `SessionRecord` 的 `id/seq/status/workingDirectory/createdAt/updatedAt`；
  v1 已用 lightweight seal，full chain/restore 是 v2 扩展点。

### v1 适配

- Redis → SQLite；`SessionStore` adapter → `AgentSessionStore` domain row +
  `AgentReadStateStore` cursor row。
- `SessionManager` 映射 → `AgentSessionStore.getActive`（行本身就是映射）。
- `AcpProcessPool` → ephemeral `WorkerPool` + durable `worker_bindings`；
  pi v1 一进程一 session，不做 multiplexing。
- `DeliveryCursorStore` 的三 namespace → v1 只做 delivery；mention/seen 明确 v2。

### v1 明确推迟，但保留扩展点

- `SessionRecord` 的 sealing 中间态 / transcript / digest / restore / chain 导航；
- context strategy / policy snapshot / compression / capacity pin；
- RuntimeSessionStore / external runtime seal reaper；
- external import / native binding；
- handoff note / continuity capsule；
- context epoch / presentation ledger / request generation。

### 不要做

- 不要把 `AgentSessionStore` 做成 Clowder `SessionStore` 的 1:1 translation；
- 不要按类名对表；按 L0/L1/L2 的 owner 对表；
- 不要把 delivery cursor 塞回 session row 语义，也不要把 session 生命周期压成
  “永远 active”；
- 不要在 v1 假装生命周期不存在：v1 做 lightweight seal，full restore/chain
  可以不做，但接口/字段必须能扩展。

## 10. 开放问题

1. **已拍板（2026-11-11）**：v1 保留 `seq/status/sealReason/sealedAt`，做
   lightweight seal（`active → sealed + 新行 seq+1`）。
2. **已拍板（2026-11-11）**：v1 `messageCount` 按 Clowder：首次 output 0→1；
   done 时本 turn 未计数则 +1（无输出 completed turn 也 +1）。
3. v1 delivery cursor 用 numeric `messages.seq`，还是预留 visibility cursor
   `v2:<seq>:<messageId>` 的扩展点？
4. **已拍板（2026-11-11）**：`AgentState` 留在 0007 运行时层，不建 DB 表；
   多 thread 用 `(threadId, agentId)` 投影，`AgentState` 只做 per-agent 汇总。
   Clowder `SessionStore.getCatState/setCatState` 在参考仓 0 调用点，无遗漏。
5. v1 是否需要 `RuntimeSessionStore`？如果只跑 pi RPC，答案是 v2；如果未来接
   Antigravity/IDE，则现在就要留 key。

[宪宪/deepseek-flash🐾]
