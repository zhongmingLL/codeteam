---
title: "codeteam architecture map — canonical docs and reading order"
doc_kind: index
status: active
created: 2026-11-14
updated: 2026-11-14
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related_features: [codeteam/F018]
---

# codeteam architecture map

## 0. 结论

**不合并成一个大文件。** 采用 **3 个整体视角文件 + 分册设计 + 历史/参考分层**：

1. **方向**：`0005-thread-first-runtime.md` — 为什么 thread-first、v1 边界、约束。
2. **V1 目标契约**：`0007-a2a-runtime-chain.md` — 组件、事务、数据模型、验收，是实现的 canonical contract。
3. **体验**：`0014-operator-message-journey.md` — operator 从发出消息到流式回复的完整 journey；解释“用户看到什么”，不替代机制契约。

分册设计：AgentConfig / Thread / Session / Identity / Idempotency / Terminal & Settlement / DraftStore。

历史与参考不删除，但明确边界：旧架构稿、审计、评审决议、legacy inventory、Clowder reference 不再作为实现基线。

## 1. 阅读顺序

新猫/新实现者按这个顺序读：

1. `0005-thread-first-runtime.md`：方向、范围、v1 不做什么。
2. `0007-a2a-runtime-chain.md`：V1 全链路和契约。
3. 按任务读分册：`0008` / `0009` / `0010` / `0011` / `0013` / `0016` / `0017`。
4. `0014-operator-message-journey.md`：用 operator journey 校验体验。
5. 需要 Clowder 对照时读 `reuse-review/`、`0012`、`0002` 的对应段落。
6. 历史审计/旧决议只做追溯：`0001` / `0003` / `0004` / `0006` / `0015`。

## 2. 真相源规则

| 层 | canonical | 冲突时 |
|---|---|---|
| 方向/范围 | `0005` | 0005 只解释 why/scope；具体机制以 0007 为准 |
| V1 runtime 机制 | `0007` | 0007 是实现基线；深挖章节以 0016/0017 为准并回链 0007 |
| domain contract | `0008`/`0009`/`0010`/`0011`/`0013` | 领域细节以对应文档为准；0007 负责集成 |
| 深挖设计 | `0016`/`0017` | 0016 管 terminal/settlement；0017 管 draft store |
| operator 体验 | `0014` | 解释体验；机制冲突以 0007/0016/0017 为准 |
| 历史/审计 | `0001`/`0003`/`0004`/`0006`/`0015` | 只做追溯，不得作为实现基线 |
| Clowder reference | `0002`/`0012`/`reuse-review/` | 只作参考；codeteam 契约以本仓文档为准 |
| 决策记录 | `decision-packets/` | 记录拍板；已拍结论已折入 canonical docs |

**规则：** 任何新设计先判断它属于哪一层；不要新增与 0005/0007 平行的“第二真相源”。历史文档保留原文，但加边界横幅。

## 3. V1 canonical chain

```text
Operator / Hub ingress（W7a transport）
  → MessageStore（StoredMessage）
  → InvocationQueue（admission/claim）
  → QueueProcessor（parent + tracker）
  → AgentRouter / routeAgents
  → runAgentTurn（composition root）
      → invoke-single-agent（T1：child terminal + credential + attempt projection）
      → WorkerEventSink → ResponseDraftStore（stream snapshot）
  → RouteResponseCommitter（T2：R terminal + draft delete + A2A successor）
  → QueueProcessor + collector（T3：parent aggregate + queue/retry + slot）
  → ResponseRecoveryService（T4：response_pending / response_missing）
  → read models（QueueView / LiveInvocationView / MessageDispatchSummary）
  → Hub projection（W7a）
```

## 4. 全局不变量

- Thread 是主聚合根；v1 没有 Task/custody/action/wait/code delivery。
- `InvocationRecord` 是消息级 parent；`TurnExecution` 是 child 执行唯一 canonical。
- `invocation_attempts` 是 `QueueTargetAttempt` 语义的投递/重试台账，不是第二套 child 状态。
- settlement 分 T1/T2/T3/T4：invoke / route-committer / QueueProcessor / recovery 各自单写。
- operator 不是 `QueueTarget`；agent 正文行首 `@operator` 只写 `mentionsUser`。
- `post_message`/`cross_post_message` 单 successor；`multi_mention` 是唯一多 target fan-out。
- A2A depth 15 + per-thread queue cap 5 + substantive-aware ping-pong + early-stop。
- `ResponseDraftStore` 无 TTL；T2 删除失败保留 `response_pending`，T4 只重试 delete + settle。
- Hub ingress/WS/SSE/replay 归 W7a/F016c；F018 只验收 daemon/CLI 与 domain DTO。

## 5. 2026-11-14 全局检视结论

### 已确认的单一链路

- 方向、V1 契约、operator 体验三层已经分离，不再让 0001 的旧 runtime 章节与 0005/0007 竞争。
- 0015 的 findings 已转为决策/审计记录；当前实现只读 0005/0007/0016/0017。
- 0014 保留为用户旅程视图；其机制描述如与 0007 冲突，以 0007 为准。

### 发现的重复/冲突与处置

| 问题 | 处置 |
|---|---|
| `0001` 旧 runtime/A2A/数据模型与 thread-first 冲突 | 标为 reference；runtime 章节由 0005/0007 取代，非 runtime 章节仅参考 |
| `0005` 含数据模型/执行链/验收摘要，与 `0007` 重复 | 保留为方向/范围；具体机制以 0007 为准 |
| `0014` 含组件机制描述，与 `0007` 重复 | 保留为体验/journey；机制以 0007/0016/0017 为准 |
| `0015` 是审计与决策证据，不是当前设计 | 标为 historical；不再作为实现基线 |
| `0003`/`0004` 是旧评审/计划 | 标为 historical；执行结果看 0005/0007/plans |
| `0006` 是 legacy inventory | 保留为 legacy-reference；不得据此写新代码 |
| `0002`/`0012` 是 pi/Clowder reference | 标为 reference；codeteam 契约以本仓 canonical docs 为准 |

### 仍然开放/待实现

- `0017 ResponseDraftStore` 仍是 `draft-for-review`，实现前需要非作者 review。
- W7a 的 Hub ingress/WS/SSE/replay 与 read DTO transport 尚未实现；F018 不能声称端到端。
- R2/R3/R4 的产品代码尚未开始；当前是 contract/design 完成，不是 implementation 完成。
- 0014 的“风险与待定项”只作为体验提醒；其中已拍项以 0007/0016/0017 为准。

## 6. 文档索引

| 文档 | 角色 | 状态 |
|---|---|---|
| `0005-thread-first-runtime.md` | 方向/范围 | accepted direction |
| `0007-a2a-runtime-chain.md` | V1 target contract | accepted |
| `0008-agent-config.md` | AgentConfig 分册 | draft-for-review |
| `0009-thread-model.md` | Thread 分册 | draft-for-review |
| `0010-session-model.md` | Session 分册 | accepted |
| `0011-identity-contract.md` | Identity 分册 | accepted |
| `0013-idempotency-key-map.md` | Idempotency 分册 | accepted |
| `0014-operator-message-journey.md` | operator 体验/journey | draft-for-review（非机制契约） |
| `0016-turn-terminal-and-settlement-design.md` | terminal/settlement 深挖 | accepted |
| `0017-response-draft-store.md` | draft store 深挖 | draft-for-review |
| `0001-codeteam-architecture-v1.md` | 旧总架构/参考 | reference（runtime 已 superseded） |
| `0002-pi-runtime-integration.md` | pi reference | reference |
| `0003-review-resolutions.md` | 旧评审决议 | historical |
| `0004-reuse-architecture-review-plan.md` | 复用梳理计划 | historical |
| `0006-task-first-legacy.md` | legacy inventory | legacy-reference |
| `0012-clowder-session-architecture.md` | Clowder session reference | reference |
| `0015-codeteam-operator-journey-audit.md` | operator journey 审计 | historical |
| `reuse-review/` | Clowder cell 参考卡 | reference |
| `decision-packets/` | 拍板记录 | decision log |

## 7. 维护规则

- 新增设计文档必须在本 map 登记；否则默认不是 canonical。
- 已拍决策只改 canonical docs + decision packet 状态；不要改历史审计原文来“假装当时就是对的”。
- 历史文档只加边界横幅，不重写历史结论。
- 每次 feature/Phase close 时检查本 map 的状态列，防止 stale。

[宪宪/deepseek-flash🐾]
