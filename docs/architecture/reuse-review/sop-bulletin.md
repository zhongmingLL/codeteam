---
title: "sop-bulletin 架构复用检视"
doc_kind: architecture-review
status: approved
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
source_cell: sop-bulletin
source_card: ../../reuse/sop-bulletin.md
template: ../0004-reuse-architecture-review-plan.md
---

# sop-bulletin 架构复用检视

## 1. 总结

| 项 | 结论 |
|---|---|
| clowder feature 范围 | F073 P1/P2/P3/P4（SOP 告示牌、resume capsule、点状 gate、skill 导航）；F015 / F040 / F049 / F058 / F076 的 backlog 数据面。F073 P0 hooks 不在本卡。 |
| codeteam 复用总结 | **R0 契约复用 + R1 存储/授权适配**。`BacklogItem` + `WorkflowSop` 仍是 feature/backlog 级告示牌；Redis→SQLite、catId→AgentProfile、Redis Lua→SQLite 事务。 |
| codeteam W | W1（表、store、CAS、backlog 生命周期）；W4（routes、MCP tools、CLI、SOP fork catalog、gate 证据）。 |
| 一句话 | 复用告示牌契约，不复制 Redis 实现；同时关掉 clowder 的两个上游缺口：可选 CAS 与无证据的 `checks=verified`。 |
| 明确不含 | Mission Hub board/rich-block UI、F073 P0 hooks、F073 P2 handoff/ack/timeout、docs 自动导入、跨项目治理、eval 平台。 |

**组件立场**

| 组件 | 立场 | codeteam 处理 |
|---|---|---|
| `WorkflowSop` / `ResumeCapsule` / `SopChecks` 类型 | `reuse now` | 字段逐一对齐；`updatedBy` 的值域改为 codeteam actor ref |
| `SopStage` / `SopDefinition` / `development.yaml` | `reuse now` | stage id 与 predicate 类型复用；fork catalog 后本地化参数 |
| `BacklogItem` / suggestion / lease / dependencies | `reuse now` | 形状复用；`catId`→`agentProfileId`、`ownerCatId`→`ownerProfileId` 等身份字段 rename |
| `WorkflowSopStore` port | `adapt now` | SQLite store；version CAS 强制；owner scope 进 port；A2-2 再加 managed-work admission |
| `BacklogStore` port | `adapt now` | SQLite 单事务；operator credential；status CAS；不移植 Redis dispatch lock |
| HTTP / callback routes | `adapt now` | strict owner auth；agent 只能 suggest + attested/unknown SOP 写入；operator 才能 approve/dispatch/done |
| MCP tools `update_workflow` / `get_workflow_sop` | `adapt now` | 改 `codeteam_*` 前缀，schema 语义对齐；不新增字段/状态 |
| Redis keys / Lua / dispatch lock | `drop` | SQLite `BEGIN IMMEDIATE` + status/version CAS 取代 |
| `sop_check_evidence` | `codeteam-new` | W4 的 verified 证据锚；公共 `WorkflowSop` 形状不变 |
| `audit` 作为 backlog/SOP 事件账本 | `reuse` | 复用 0001 §12.2 的 append-only `audit`；不再在 backlog 行里塞 `audit_json` |
| Mission Hub board / rich-block / Console 时间线 | `out-of-scope` | 归 `hub-action-surface` P1-active；本卡只交数据契约与只读投影 |
| docs 自动导入（F040/F058 importer） | `out-of-scope` | W1 只支持显式 operator create/import；不从 docs 反推状态 |
| F073 P2 handoff / ack / timeout | `out-of-scope` | 归 A3-1 `ball-custody`；SOP 只存 `batonHolder` 这个路牌 |
| F073 P0 hooks / P4 hook 集成 | `out-of-scope` | 归 pi/L0 hooks 与 W1/W2 运行时；SOP 不执行流程 |
| F076 跨项目治理 | `defer→P1` | 只保留 `projectId` 形状；跨项目语义已被 F152 supersede |

### 1.1 W4 实现边界（2026-10-28）

W4 的 operator surface 先落 CLI，不新增 HTTP/MCP transport：CLI 直接调用
`ControlStore` / SOP/gate service，不绕过 store，也不建第二状态机。W7a 复用
同一 service 暴露 HTTP/事件，届时只加 transport，不重写语义。agent 回复的
production runner 仍归 W5；W4 dogfood 用 W1 的 `messages` / `queue_entries` /
`cutoverQueueEntry` 验证 durable 投递链，不把 W5 runner 塞进 W4。

实现计划与证据见 `plans/0009-w4-sop-gates-implementation.md` 与
`reports/2026-10-28-w4-sop-gates.md`。

W7a 前置 residual：`SopCheckEvidenceStore` 的 evidenceRef 解析必须下沉到 store
边界或收窄 store 写入面；HTTP requester 必须从鉴权 principal 派生，不接受
`--requester` 这类声明身份。二者在 W7a 动 HTTP 前复核。

## 2. clowder 架构

### 2.1 架构图

```text
Mission Hub UI / cat_cafe_update_workflow / get_workflow_sop
        │
        ▼
workflow-sop routes
  ├─ GET/PUT /api/backlog/:itemId/workflow-sop
  └─ GET/POST /api/callbacks/{get,update}-workflow-sop
        │  owner scope + feature binding + strict callback auth
        ▼
IWorkflowSopStore
  ├─ get(backlogItemId)
  └─ upsert(backlogItemId, featureId, input, updatedBy, ownerUserId)
        │  Lua CAS_UPSERT + first-create managed-work admission
        ▼
Redis workflow:sop:{backlogItemId}
Redis managed-work:admission:{workId} / attempt:{attemptId}

Backlog Center
  ├─ create / suggest / decide / dispatch / lease / done
  ▼
IBacklogStore
  ├─ status transitions + audit array
  ├─ dispatch lock (30s, token CAS delete)
  └─ atomicDispatch Lua
        ▼
Redis backlog:item:{id} / backlog:items:user:{userId}
        │
        └─ ThreadStore.linkBacklogItem(threadId, backlogItemId)  ← best-effort reverse link
```

### 2.2 数据流

1. **Backlog 生命周期**：operator/agent 创建 `BacklogItem(status=open)` → cat 提交 claim suggestion（`suggested`）→ operator approve/reject → approve 后 dispatch 到 thread（`dispatched`）→ 完成（`done`）。dispatch 步骤会生成 thread、kickoff message、`dispatchAttemptId`/`pendingThreadId`/`kickoffMessageId` 检查点，并把 thread 反向挂到 backlog item。
2. **SOP 读**：`get_workflow_sop` 先按 thread 找 `thread.backlogItemId`，再 owner-scope 校验 backlog item，最后读 `workflow:sop:{backlogItemId}`。没有 thread 绑定或 SOP 时 404。
3. **SOP 写**：`update_workflow` 支持显式 `backlogItemId` 或 `featureId` 解析。解析优先级：thread binding → 用户 backlog 中唯一的 `feature:<id>` tag → 同一 thread 的 work task（显式 `relatedFeatureId`）物化 task-backed item。写入前校验 feature tag；`upsert` 用 Lua 做 version CAS；首次创建非 `completion` 的 `development` SOP 时，同脚本创建 `WorkAdmission` + `WorkAttempt`。
4. **告示牌消费**：猫读 `stage` / `batonHolder` / `nextSkill` / `resumeCapsule` / `checks` 后自己决定下一步；`sop-definitions` 的 hard rules/pitfalls 由 skill/hook 读取，`WorkflowSop` store 不执行 predicate。
5. **Gate 回写**：clowder 的路由允许调用者直接写 `checks` 的 `attested|verified|unknown`；store 不校验 `verified` 是否有机器证据。这是本卡要修的缺口，不是可复用契约。

### 2.3 状态机 / 生命周期

**A. Backlog status（真实状态机）**

```text
open ──suggest──► suggested ──approve──► approved ──dispatch──► dispatched ──done──► done
                        │
                        └──reject──► open

lease: 仅 dispatched 可 acquire；active → released / reclaimed（过期）
```

- `suggestClaim` 只允许 `open`；同一 item 已有 pending suggestion 时，同 cat 幂等返回，换 cat 409。
- `decideClaim` 只允许 `suggested` + pending；reject 回 `open`，approve 进 `approved`。
- `markDispatched` / `atomicDispatch` 只允许 `approved`；已 dispatch 到同一 thread+phase 幂等，换 thread 409。
- `markDone` 在 clowder **没有状态前置校验**：任意 status 都能直接变 `done`（上游缺口 G4）。
- clowder 没有 operator 从 `open` 直接 approve 的路径；codeteam 增加该路径（G15）。
- `lease` 只允许 `dispatched`；TTL 默认 60s，路由上限 24h；active lease 属于别的 cat 时拒绝。

**B. WorkflowSop version（单调版本，不是状态机）**

```text
version 1 ──update(expectedVersion=1)──► version 2 ──update(expectedVersion=2)──► ...
```

- 首次创建：`stage=kickoff`、`batonHolder=updatedBy`、`checks` 全 `unknown`、`version=1`。
- 更新：字段做局部 merge；`resumeCapsule` 的 `done` 数组是替换而非追加；`version+1`。
- `stage` 是 7 个车道 id，**不做迁移校验**；`fresh_context` 可选；`completion` 在 clowder 也没有 gate。
- clowder 的 `expectedVersion` 可选：缺省为 `-1`，Lua 跳过 CAS，最后写者赢（上游缺口 G1）。

**C. checks 生命周期（clowder 只有值，没有证据）**

```text
unknown ──attest──► attested ──(no gate)──► verified
   ▲                                          │
   └──────────── head/revision change ────────┘
```

- `unknown` 是默认；`attested` 是猫声明；`verified` 本应表示系统验证，但 clowder 的路由/store 不校验证据来源，任何调用者都能写 `verified`（上游缺口 G2）。

### 2.4 关键数据结构

```ts
// packages/shared/src/types/workflow-sop.ts:23
interface WorkflowSop {
  featureId: string;
  backlogItemId: string;
  sopDefinitionId: 'development';
  stage: SopStage;
  batonHolder: string;
  nextSkill: string | null;
  resumeCapsule: ResumeCapsule;
  checks: SopChecks;
  version: number;
  updatedAt: number;
  updatedBy: string;
}

// workflow-sop.ts:8,10,16
type CheckStatus = 'attested' | 'verified' | 'unknown';
interface ResumeCapsule { goal: string; done: readonly string[]; currentFocus: string; }
interface SopChecks {
  remoteMainSynced: CheckStatus;
  qualityGatePassed: CheckStatus;
  reviewApproved: CheckStatus;
  visionGuardDone: CheckStatus;
}
```

```ts
// packages/shared/src/types/backlog.ts:59
interface BacklogItem {
  id: string; userId: string; projectId?: string;
  title: string; summary: string;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  tags: readonly string[];
  status: 'open' | 'suggested' | 'approved' | 'dispatched' | 'done';
  createdBy: CatId | 'user';
  suggestion?: BacklogClaimSuggestion;   // backlog.ts:9
  lease?: BacklogLease;                  // backlog.ts:21
  dispatchedThreadId?: string;
  dispatchedThreadPhase?: ThreadPhase;
  dispatchAttemptId?: string;
  pendingThreadId?: string;
  kickoffMessageId?: string;
  createdAt: number; updatedAt: number;
  approvedAt?: number; dispatchedAt?: number; doneAt?: number;
  dependencies?: BacklogDependencies;    // backlog.ts:161
  audit: readonly BacklogAuditEntry[];   // backlog.ts:51
}
```

```ts
// packages/shared/src/types/sop-definition.generated.ts:9
type DevelopmentSopStageId =
  | 'kickoff' | 'impl' | 'quality_gate' | 'fresh_context'
  | 'review' | 'merge' | 'completion';
```

### 2.5 Current truth 与代码路径

| # | 事实 | 代码锚点 |
|---|---|---|
| T1 | `WorkflowSop` 以 `backlogItemId` 为 key，字段就是上面 11 个；`sopDefinitionId` 目前只有 `development` | `packages/shared/src/types/workflow-sop.ts:23`、`packages/shared/src/types/sop-definition.generated.ts:6` |
| T2 | stage 是 7 个车道 id，不是串行状态机；`fresh_context` 可选 | `packages/shared/src/types/sop-definition.generated.ts:9`、`sop-definitions/development.yaml:9` |
| T3 | 写 store 用 Lua 做 CAS；`expectedVersion` 缺省 `-1` 时跳过 CAS | `packages/api/src/domains/cats/services/stores/redis/RedisWorkflowSopStore.ts:53`、`:68`、`:228` |
| T4 | 首次创建 `development` 且 `stage != completion` 时，同 Lua 创建 managed-work admission/attempt；`completion` 首次创建跳过 | `RedisWorkflowSopStore.ts:75`、`:211` |
| T5 | `upsert` 先在 JS 读旧值再拼新对象，Lua 只校验版本；带 `expectedVersion` 时并发不同字段更新会有一个 409，缺省则一个被覆盖 | `RedisWorkflowSopStore.ts:179`、`:196` |
| T6 | callback 写路径要求 strict owner auth；`updatedBy` 取 `record.catId`，没有 catId 时为 `unknown` | `packages/api/src/routes/callback-workflow-sop-routes.ts:282`、`:288`、`:361` |
| T7 | featureId → backlogItemId 解析有 thread binding → 唯一 feature tag → task-backed item 三段；task-backed 会自动物化 backlog item | `callback-workflow-sop-routes.ts:172`、`:194`、`:238`、`:340` |
| T8 | 写前用 backlog item 的 `feature:<id>` tag 校验 feature binding；PUT 路径同样校验 | `callback-workflow-sop-routes.ts:55`、`packages/api/src/routes/workflow-sop.ts:88` |
| T9 | HTTP PUT 的 `updatedBy` 是 `userId`；版本冲突返回 409 + currentState | `packages/api/src/routes/workflow-sop.ts:107`、`:110` |
| T10 | Backlog status 5 值；suggestion/lease/audit/dependencies 都是 `BacklogItem` 的嵌套字段 | `packages/shared/src/types/backlog.ts:4`、`:59` |
| T11 | `suggestClaim`/`decideClaim`/lease 是 read-modify-write；dispatch 有 30s token lock + 原子 Lua | `RedisBacklogStore.ts:534`、`:576`、`:723`、`:1044` |
| T12 | `markDone` 从任意 status 直接写 done，没有完成 gate | `RedisBacklogStore.ts:698`、`packages/api/src/routes/backlog.ts:900` |
| T13 | dispatch 是 saga：persist attemptId → create thread → persist pendingThreadId → kickoff message → atomicDispatch → best-effort link；thread 已建但 pendingThreadId 未落时会 orphan | `packages/api/src/routes/backlog.ts:181`、`:207`、`:264` |
| T14 | 所有 backlog HTTP 路由只做 `resolveUserId`；`createdBy` / `catId` 可由 body 提供，没有 operator credential 区分 | `packages/api/src/routes/backlog.ts:308`、`:315`、`:327`、`:632`、`:672`、`:900` |
| T15 | lease 默认 60s、路由上限 24h；`catId` 由 body 提供 | `packages/api/src/routes/backlog.ts:753`、`:869` |
| T16 | thread 有 `phase` 与 `backlogItemId`，store 支持 `updatePhase` / `linkBacklogItem`；0001 `threads` 目标 schema 还没有这两列 | `packages/api/src/domains/cats/services/stores/ports/ThreadStore.ts:230`、`:232`、`:761`、`:762` |
| T17 | MCP 工具读出 `threadId/backlogItemId/workflowSop`，写入走 `/api/callbacks/update-workflow-sop` | `packages/mcp-server/src/tools/callback-tools.ts:3887`、`:4506`、`:2576` |
| T18 | `sop-definitions` 由 YAML codegen；输出 `sop-definition.generated.ts` | `scripts/sop-definitions.mjs:12`、`package.json:112` |
| T19 | 0001 §12.2 已按本卡回写（2026-10-25）：`backlog_items` 扩列、`threads` 两列、`thread_events`/§7.3 修正；`workflow_sops` 保持 11 列 | `codeteam/architecture/0001-codeteam-architecture-v1.md` §12.2 |

### 2.5.1 上游已知缺口 → 本卡处置

| # | 上游缺口（实证） | 影响 | 本卡处置 |
|---|---|---|---|
| G1 | `expectedVersion` 可选，缺省 `-1` 跳过 CAS（`RedisWorkflowSopStore.ts:228`） | 并发更新最后写者赢，`resumeCapsule` 可能被静默覆盖 | codeteam 更新强制 `expectedVersion`；缺省/不匹配 → 409 + currentState。首次创建用 `INSERT ... ON CONFLICT DO NOTHING`，冲突返回已有行 |
| G2 | 任何调用者可写 `checks.*=verified`，无证据校验（`callback-workflow-sop-routes.ts:282`、`routes/workflow-sop.ts:64`） | `verified` 可被伪造，review/merge gate 失真 | 拆写权：agent/operator 只能写 `attested|unknown`；`verified` 只由 daemon gate writer 写，必须带 `sop_check_evidence` 证据 + subject revision；否则 422 `verified_requires_evidence` |
| G3 | `stage=completion` 没有 gate；任意调用者可写（`routes/workflow-sop.ts:64`） | task done 可能被误当 feature completion | codeteam 写 `completion` 必须满足 backlog `status=done` + operator actor；W4 再加 completion gate 证据；否则 422 `completion_gate_required` |
| G4 | `markDone` 从任意 status 直接 done（`RedisBacklogStore.ts:698`） | open/suggested item 可被跳过流程直接完成 | codeteam 正常只允许 `dispatched→done`；`approved/open/suggested→done` 只走 import/operator override（显式 `--reason` + audit）；`done` 终态不可回退 |
| G5 | backlog HTTP 路由只做 user identity；`createdBy`/`catId` 由 body 提供（`routes/backlog.ts:308`、`:327`、`:632`） | agent 可伪造 actor 或越权 dispatch | codeteam actor 从 credential/token 派生；create/approve/dispatch/done/reclaim 只接受 operator credential；agent 只走 `backlog/suggest` → `suggested` |
| G6 | task-backed item 自动物化（`callback-workflow-sop-routes.ts:172`） | 缺 backlog item 时静默造一条，破坏单一真相源 | codeteam **drop** 该 fallback；task create 缺 backlog item → 404 `backlog_not_imported`；只允许显式 operator create/import |
| G7 | dispatch 多步 saga + best-effort thread link（`routes/backlog.ts:181`、`:207`） | crash 可能 orphan thread / 半 dispatch | codeteam 单 SQLite 事务：backlog CAS + thread insert + kickoff message + queue entry + audit；`dispatch_attempt_id` 唯一索引做幂等；无 orphan |
| G8 | `upsert` JS 读旧值 + Lua 只校验版本（`RedisWorkflowSopStore.ts:179`） | 并发不同字段更新会丢一个 | codeteam SQL `UPDATE ... WHERE backlog_item_id=? AND version=?` + rowcount；read-modify-write 在 `BEGIN IMMEDIATE` 内；409 返回当前行 |
| G9 | `checks` 不绑定 head/revision；`verified` 可跨版本残留 | 旧 review/merge 证据被当成当前证据 | codeteam `sop_check_evidence.subject_revision` 绑定 head/review/merge/artifact；读时 revision 不匹配 → 有效值降为 `unknown` + `stale_evidence`；不静默保留 verified |
| G10 | `resumeCapsule` 无大小/必填约束；stage 变更可不带 capsule | 行无限增长；冷启动无信息 | codeteam 限制 `goal/currentFocus` 长度、`done` 条数与总字节；stage 变更必须带非空 `currentFocus`（首次创建可默认 backlog title）；否则 422 |
| G11 | `batonHolder` 任意 string；不校验 profile | 可能写不存在的 handle | codeteam 只接受 active `AgentProfile.id` 或 `operator`；仍是**路牌，不授予球权**；A3-1 才管 handoff/lease |
| G12 | `audit` 是 `BacklogItem` 内嵌数组，无上限 | item 行无限增长，事件不可独立查询 | codeteam 用 0001 的 append-only `audit` 表投影 `BacklogItem.audit`；newest-first、读上限 100、`audit_truncated`+cursor；不新增 `backlog_events` |
| G13 | `get(backlogItemId)` 本身不做 owner scope；靠 route 校验 | 直接复用 store 可能跨用户读 | codeteam `get(ownerUserId, backlogItemId)` 进 port；跨 owner 统一 404，不泄露存在性 |
| G14 | docs importer 会按 feature doc 状态自动 mark done（`routes/backlog.ts:334`） | 外部 docs 成为运行时真相，误标 done | codeteam W1/W4 **不做 docs 自动同步**；只保留显式 operator import；docs 是引用，不是运行时状态源 |
| G15 | backlog actor 只有 `cat|user`；W8/forge inbound 的服务 actor 没有合法 `createdBy`（`codeteam/plans/0004-w5-w8-scale-product.md:466`） | system/forge 无法合法建 item，或被逼冒充 operator | codeteam `created_by_kind` 加 `system`；只准初始 `open|suggested`，actor=`system:forge:<provider>`，后续 approve/dispatch 仍走 operator |

## 3. codeteam 架构

### 3.1 架构图

```text
Web Console / CLI / agent MCP tools
  ├─ operator: backlog create/approve/dispatch/done/lease reclaim
  ├─ agent: backlog suggest, workflow update (attested/unknown)
  └─ gate writer: checks verified (with evidence)
        │
        ▼
Fastify routes + callback routes
  ├─ assertOperatorCredential（backlog 生命周期）
  ├─ requireCallbackAuth(strict owner)（agent SOP / suggest）
  └─ owner scope + feature binding
        │
        ▼
SOP / Backlog services
  ├─ BacklogService：status CAS + dispatch transaction
  ├─ WorkflowSopService：version CAS + field authority + read projection
  └─ SopCheckEvidenceService：verified evidence only
        │
        ▼
SQLite control store
  ├─ backlog_items
  ├─ workflow_sops
  ├─ sop_check_evidence（W4）
  ├─ threads（+ backlog_item_id / phase）
  ├─ tasks（work → backlog_item_id NOT NULL）
  └─ audit（append-only backlog/SOP event ledger）

Source-controlled fork catalog（指未来 codeteam 仓；clowder-ai/codeteam/ 只放设计稿）
  codeteam/sop-definitions/development.yaml
        │  scripts/sop-definitions.mjs
        ▼
  sop-definition.generated.ts（stage ids / rules / suggested skills）
```

### 3.2 数据流

1. **Operator create**：Console/CLI → operator credential → `INSERT backlog_items(status=open, created_by_kind='operator')` + audit。显式 `--status done|dispatched` 只走 import 路径，必须带 `--reason` 和 actor。W8/forge inbound 用 `created_by_kind='system'`、actor=`system:forge:<provider>`，只准初始 `open|suggested`。
2. **Agent suggest**：`codeteam_backlog_suggest` callback → run token → 派生 `agentProfileId`/`userId`/`threadId` → `UPDATE ... WHERE status='open'` 写 suggestion + `suggested` + audit。同 profile 重复 suggest 幂等返回；换 profile 409。agent 无 approve/dispatch 权。
3. **Operator approve**：两条合法路径：① `open → approved`（operator 直接立项确认，audit `approved_without_suggestion`）；② `suggested → approved`（必须有 pending suggestion，audit `approved`）。approve 与 dispatch 是两个命令；CLI `--dispatch` 便利写两条 audit。
4. **Dispatch**：单事务 `UPDATE backlog_items ... WHERE status='approved'` + `INSERT threads(backlog_item_id, phase)` + `INSERT messages(kind='backlog_kickoff')` + `INSERT queue_entries(source_kind='backlog_dispatch')` + audit。提交后 QueueProcessor 才投递；`dispatch_attempt_id` 唯一索引保证重试幂等。
5. **Task create**：只允许绑定已存在的 `backlog_item_id`；缺 item → 404 `backlog_not_imported`。不隐式造 item；不把 thread 当 backlog。
6. **SOP update**：agent/operator → 解析 backlog item（thread binding → 唯一 feature tag → 显式 backlogItemId）→ 校验 owner/feature/expectedVersion/stage authority/check authority/capsule → `UPDATE workflow_sops ... WHERE version=?` + audit；`completion` 另加 gate。feature tag 多匹配 → 422 `ambiguous_feature`，不得取 first；`tags_json` 更新 operator-only，SOP 已存在时 anchor tag（匹配 `workflow_sops.feature_id`）不可移除 → 422 `feature_anchor_locked`。
7. **SOP read**：按 thread 或 item 读；一个读事务里取 `workflow_sops` + 最新 `sop_check_evidence` + `backlog_items`；投影有效 `checks`（fresh verified 或 unknown + reason）。公共 `BacklogItem.audit` 投影 newest-first，最多 100 条；超限返回 `audit_truncated: true` + cursor，全量审计走 operator CLI。
8. **Gate write**：daemon gate writer → `recordCheckEvidence(backlogItemId, check, evidenceKind, evidenceRef, subjectRevision)` → `INSERT sop_check_evidence` + audit（`subject='workflow_sop:<id>'`, `action='check_verified'`）；`checks_json` 的 verified 由读投影得出，不靠 agent 写。W7a 订阅 audit 事件，不拿 `workflow_sops.version` 当失效信号。
9. **Board projection**：W7a 只读 `backlog_items × workflow_sops × sop_check_evidence`；不反向写。Mission Hub board UI 归 `hub-action-surface` P1；投影带 `audit_truncated`/cursor，不把“没显示”演成“没发生”。

### 3.3 状态机 / 生命周期

**A. Backlog status（codeteam 收紧）**

```text
open ──suggest──► suggested ──approve──► approved ──dispatch──► dispatched ──done──► done
  │                    │
  │                    └──reject──► open
  └──operator direct approve──► approved

违规：
  open/suggested/approved ──done──► 409（import/operator override 例外，需 reason + audit；正常 done 只准 dispatched→done）
  approved ──suggest──► 409
  dispatched ──approve──► 409（幂等返回同 thread 除外）
  同 profile 重复 suggest ──► 幂等返回；换 profile ──► 409
```

- `open→approved` 是 operator 直接立项确认，audit `approved_without_suggestion`；`suggested→approved` 必须有 pending suggestion，audit `approved`。
- `done` 是终态；需要复活时新建 item，用 `dependencies.evolvedFrom` 指回旧 item，不 reopen。正常 `done` 只从 `dispatched` 进入；`approved/open/suggested→done` 只走 import/operator override（reason + audit）。
- `tags_json` 更新只接受 operator；SOP 已存在时 anchor tag 不可移除（422 `feature_anchor_locked`）。
- W8/forge inbound 的 `created_by_kind='system'` 只准初始 `open|suggested`；这是权限门禁后的**显式 admission 路径**（G15），不是 G6 的隐式物化；后续 approve/dispatch 仍走 operator，`user_id` 归 operator，audit 记原始 forge actor。
- `lease` 只允许 `dispatched`；W1 建列，W5 才启用 acquire/heartbeat/reclaim；dogfood 单 writer 允许 `lease=null`。
- `thread.phase` 与 `backlog_items.dispatched_thread_phase` 在 dispatch 事务里同时写；两者不一致是 bug。

**B. WorkflowSop version（codeteam CAS）**

```text
insert v1 ──update(expectedVersion=1)──► v2 ──update(expectedVersion=2)──► v3
   │                                         │
   └─ conflict: existing row returned         └─ mismatch → 409 + currentState
```

- 更新必须带 `expectedVersion`；首次创建用 `INSERT ... ON CONFLICT DO NOTHING`，已存在则返回当前行（幂等）。
- `stage` 仍是告示牌车道；除 `completion` 外不做迁移校验。W1 的 `completion` 需要 backlog `done` + operator actor；W4 再加 completion gate 证据（`visionGuardDone=verified` / merge receipt）。
- `resumeCapsule` 每次 stage 变更必须带非空 `currentFocus`；`done` 数组替换，不自动追加；`goal` 首次创建为空时用 backlog title 填充。
- 0001 §7.3 已回写为“stage 变更必须写 resumeCapsule；纯 checks/nextSkill 更新可选”；gate writer 的 verified 回写不要求 agent 重写 capsule。
- `workflow_sops.version` 只随 agent/operator 的 SOP 字段更新递增；`sop_check_evidence` 是 append-only，verified 投影变化不 bump version。需要 CAS 的客户端只看 SOP 字段；evidence 新鲜度看 `subject_revision` / `recorded_at`。

**C. Check lifecycle（codeteam 证据化）**

```text
unknown ──agent/operator attest──► attested
   ▲                                   │
   │                                   └─ daemon gate + evidence ──► verified(subjectRevision)
   │                                                                        │
   └──────────────── subject revision changed / evidence stale ─────────────┘
```

- `unknown`：无声明、无证据；默认。
- `attested`：agent/operator 声明；写 `audit`，不写 evidence。
- `verified`：只由 daemon gate writer 写；必须有 `sop_check_evidence` 行，`subject_revision` 必须匹配当前 review/merge/artifact revision；读时新鲜才显示 `verified`，否则 `unknown` + `stale_evidence`。
- `checks_json` 只存 agent/operator 的 assertion（`attested|unknown`）；有效 verified 由 evidence 投影，不落成可被 agent 覆盖的字段。W1 先拒绝 `verified`（422 `verified_requires_evidence`）；W4 建 evidence 表后才允许 gate writer 写。
- evidence 写入同事务追加 audit（`subject='workflow_sop:<id>'`, `action='check_verified'`）；W7a 订阅 audit 事件，不拿 `workflow_sops.version` 当失效信号。

**D. Dispatch transaction / crash matrix**

| 时点 | 结果 |
|---|---|
| 事务前崩溃 | 无变化；可重试 |
| 事务中崩溃 | SQLite 回滚；无 orphan thread / 半 dispatch |
| 事务提交后、QueueProcessor 前 | backlog/thread/message/queue 都已持久；QueueProcessor 恢复后投递；`dispatch_attempt_id` 防重 |
| 事务提交后、thread 反向链接前 | 反向链接在**同一事务**内，不存在这个时点 |

### 3.4 关键数据结构（与 clowder 对比）

| clowder | codeteam | 立场 | 关键差异 |
|---|---|---|---|
| `WorkflowSop`（`workflow-sop.ts:23`） | `workflow_sops` | `reuse now` | 11 字段逐一对齐；`updatedBy` 存 actor ref；`featureId` 是首次创建的 anchor，更新请求只需匹配 backlog item 的任一 feature tag；anchor tag 在 SOP 存在时不可移除 |
| `ResumeCapsule`（`:10`） | `resume_capsule_json` | `reuse now` | 字段不变；加 size/条数上限（codeteam-new） |
| `SopChecks`（`:16`） | `checks_json` + evidence 投影 | `adapt now` | 公共形状不变；verified 不再由 agent 直接写；W4 加 `sop_check_evidence` |
| `BacklogItem`（`backlog.ts:59`） | `backlog_items` | `reuse now` | 形状复用；`catId`→`agentProfileId`、`user`→`operator`、新增 `system`（forge inbound）；audit 从全局表投影 |
| `BacklogClaimSuggestion`（`:9`） | `suggestion_json` | `reuse now` | `catId`→`agentProfileId`；status 三态不变 |
| `BacklogLease`（`:21`） | `lease_json` | `reuse now` | `ownerCatId`→`ownerProfileId`；TTL 边界；W5 启用 |
| `BacklogAuditEntry`（`:51`） | `audit` 表投影 | `reuse now` | actor kind `cat|user` → `agent|operator|system`；不内嵌 JSON；newest-first + `audit_truncated` + cursor |
| `BacklogDependencies`（`:161`） | `dependencies_json` | `reuse now` | `evolvedFrom`/`blockedBy`/`related` 不变；W5 DAG 直接消费 `blockedBy` |
| `SopDefinition` / stage ids | fork catalog + generated TS | `reuse now` | stage id/skill/severity/predicate 类型复用；predicate 参数本地化 |
| `IWorkflowSopStore` | `WorkflowSopStore`（SQLite） | `adapt now` | `get(owner,id)`、`update` 强制 CAS、`recordCheckEvidence`；A2-2 加 admission 方法 |
| `IBacklogStore` | `BacklogStore`（SQLite） | `adapt now` | 单事务/status CAS/operator auth；drop dispatch lock |
| Redis keys / Lua | SQLite 事务 | `drop` | 无 `workflow:sop:*`、`backlog:item:*`、无 Lua |
| `Thread.backlogItemId` / `phase` | `threads.backlog_item_id` / `phase` | `reuse now` | 0001 需补两列；`linkBacklogItem` 的 best-effort 改为同事务 |
| `Task.backlogItemId` | `tasks.backlog_item_id` | `reuse now` | work task 必须非空；FK + CHECK；不新增 `dependsOn` |
| — | `sop_check_evidence` | `codeteam-new` | W4 证据锚；只存 verified，不存 asserted |
| 0001 `audit` | `audit` | `reuse` | append-only；backlog/SOP 事件统一落这里 |

**SOP catalog 本地化（fork catalog）**

| clowder 规则/参数 | codeteam 处理 | 立场 |
|---|---|---|
| `repository: cat-cafe` / `branch: main` | 换成当前 `Task.repo` / `base_ref`，不硬编码仓名 | `adapt now` |
| `REDIS_URL:6398/6399` env_check | drop；codeteam 不引入 Redis；需要时换成 SQLite/`CODETEAM_DATA_DIR` 路径检查 | `drop` |
| `pnpm check:features` / `cat-cafe-runtime` / `pnpm convention-graph` | 换成 codeteam 等价命令（`pnpm gate` / `check` / 自建 convention 查询）；每条改写留 diff | `adapt now` |
| `co_creation_docs_lane` | W1/W4 out-of-scope；codeteam docs lane 后续再定 | `out-of-scope` |
| `design_gate_evidence` globs | 换成 codeteam `packages/*/src/routes/**` / consumer/caller 路径 | `adapt now` |
| `manual_only` / `handle_check` / `sha_dedup` / `command_sequence` | 语义原样保留；只换参数/命令 | `reuse now` |

#### 3.4.3 §12.2 回写清单

**1. `backlog_items`：从当前 12 列扩为完整形状**

```sql
backlog_items(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('p0','p1','p2','p3')),
  tags_json TEXT NOT NULL CHECK (json_valid(tags_json)),
  status TEXT NOT NULL CHECK (status IN ('open','suggested','approved','dispatched','done')),
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('agent','operator','system')),
  created_by_id TEXT NOT NULL,
  suggestion_json TEXT CHECK (suggestion_json IS NULL OR json_valid(suggestion_json)),
  lease_json TEXT CHECK (lease_json IS NULL OR json_valid(lease_json)),
  dependencies_json TEXT CHECK (dependencies_json IS NULL OR json_valid(dependencies_json)),
  dispatched_thread_id TEXT,
  dispatched_thread_phase TEXT CHECK (dispatched_thread_phase IN ('coding','research','brainstorm')),
  dispatch_attempt_id TEXT,
  pending_thread_id TEXT,
  kickoff_message_id TEXT,
  approved_at INTEGER,
  dispatched_at INTEGER,
  done_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_backlog_items_user_updated ON backlog_items(user_id, updated_at DESC);
CREATE INDEX idx_backlog_items_status ON backlog_items(status);
CREATE UNIQUE INDEX idx_backlog_items_dispatch_attempt
  ON backlog_items(dispatch_attempt_id) WHERE dispatch_attempt_id IS NOT NULL;
```

- 不存 `audit_json`；`BacklogItem.audit` 从全局 `audit` 表按 `subject='backlog_item:<id>'` 投影，newest-first、读上限 100；超限返回 `audit_truncated: true` + cursor，全量审计走 operator CLI。
- `dispatch_attempt_id` 唯一索引 = dispatch 幂等键；重试同 attempt 返回已有 thread。
- `tags_json` 至少含 `feature:<id>`；feature 解析用 `json_each(tags_json)`，多匹配 → 422 `ambiguous_feature`，不得取 first；W1 数据量小，不另建 feature 表。
- `tags_json` 更新 operator-only；SOP 已存在时，匹配 `workflow_sops.feature_id` 的 anchor tag 不可移除（422 `feature_anchor_locked`）。
- `created_by_kind='system'` 只用于 W8/forge inbound 的初始 `open|suggested`；actor 记 `system:forge:<provider>`，后续 approve/dispatch 仍走 operator。

**2. `workflow_sops`：列不变，补约束/索引**

```sql
workflow_sops(
  backlog_item_id TEXT PRIMARY KEY REFERENCES backlog_items(id) ON DELETE CASCADE,
  feature_id TEXT NOT NULL,
  sop_definition_id TEXT NOT NULL CHECK (sop_definition_id IN ('development')),
  stage TEXT NOT NULL CHECK (stage IN ('kickoff','impl','quality_gate','fresh_context','review','merge','completion')),
  baton_holder TEXT NOT NULL,
  next_skill TEXT,
  resume_capsule_json TEXT NOT NULL CHECK (json_valid(resume_capsule_json)),
  checks_json TEXT NOT NULL CHECK (json_valid(checks_json)),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE INDEX idx_workflow_sops_feature ON workflow_sops(feature_id);
```

- 不新增 `created_at`/`deleted_at`/`user_id`；创建时间由 audit 记录；owner scope 通过 `JOIN backlog_items ON user_id` 校验。
- `feature_id` 是首次创建的 anchor，更新不改写；更新请求的 `featureId` 必须匹配 backlog item 的任一 `feature:<id>` tag（不要求等于 anchor），否则 422 `feature_mismatch`。非 anchor feature 更新时 audit 记 `feature_anchor` + `feature_requested`。
- `checks_json` 只存 `attested|unknown`；`verified` 由 evidence 投影，不落成可覆盖字段。
- **2026-10-25 A2-2 增量**：`work_admissions.producer_ref` 对 backlog item 是 `RESTRICT`，平时 backlog item 不可删；`workflow_sops ON DELETE CASCADE` 只在显式 purge 路径可达。purge 必须先清 admission/attempt/binding，不能反向依赖 cascade 静默清身份。

**3. `threads`：补 backlog 反向链接与 phase**

```sql
threads(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  repo TEXT,
  status TEXT NOT NULL,
  phase TEXT CHECK (phase IN ('coding','research','brainstorm')),
  backlog_item_id TEXT REFERENCES backlog_items(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_threads_backlog_item ON threads(backlog_item_id) WHERE backlog_item_id IS NOT NULL;
```

- `backlog_item_id` 是 dispatch 事务内写的反向链接；不再 best-effort。
- `phase` 与 `backlog_items.dispatched_thread_phase` 必须一致；不一致由 dispatch 事务回滚。

**4. `tasks`：work task 必须绑定 backlog item（不改列）**

```sql
-- 在 tasks 表加：
CHECK (kind <> 'work' OR backlog_item_id IS NOT NULL)
FOREIGN KEY (backlog_item_id) REFERENCES backlog_items(id) ON DELETE RESTRICT
```

- `pr_tracking` 等非 work task 可不绑；work task 缺 item → 404 `backlog_not_imported`，不隐式造 item。
- 不新增 `dependsOn`；W5 DAG 读 `backlog_items.dependencies_json.blockedBy`。
- migration 顺序：先加 FK（不带 CHECK）、完成 task-backed backfill，再加 CHECK；SQLite 无 `NOT VALID`，顺序不可颠倒；存量违规行先标 `backlog_not_imported` 报告，不静默改绑。

**5. `sop_check_evidence`：W4 新表（W1 不建；W1 拒绝 `verified`）**

```sql
sop_check_evidence(
  id TEXT PRIMARY KEY,
  backlog_item_id TEXT NOT NULL REFERENCES backlog_items(id) ON DELETE CASCADE,
  check_name TEXT NOT NULL CHECK (check_name IN ('remoteMainSynced','qualityGatePassed','reviewApproved','visionGuardDone')),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('git_sync','quality_gate','review','vision_guard')),
  CHECK (
    (check_name = 'remoteMainSynced' AND evidence_kind = 'git_sync') OR
    (check_name = 'qualityGatePassed' AND evidence_kind = 'quality_gate') OR
    (check_name = 'reviewApproved' AND evidence_kind = 'review') OR
    (check_name = 'visionGuardDone' AND evidence_kind = 'vision_guard')
  ),
  evidence_ref TEXT NOT NULL,
  subject_revision TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_sop_check_evidence_dedupe
  ON sop_check_evidence(backlog_item_id, check_name, subject_revision, evidence_ref);
CREATE INDEX idx_sop_check_evidence_latest
  ON sop_check_evidence(backlog_item_id, check_name, recorded_at DESC);
```

- 只存 verified 证据，不存 `attested`；`attested` 只看 audit。
- `check_name` 与 `evidence_kind` 的映射：`remoteMainSynced→git_sync`、`qualityGatePassed→quality_gate`、`reviewApproved→review`、`visionGuardDone→vision_guard`；SQL CHECK + 应用层双重校验，W4 应用层仍校验 `evidence_ref` 可解析。
- `subject_revision` 绑定 head SHA / merge SHA / artifact revision；读时 revision 不匹配 → 有效 `verified` 降为 `unknown` + `stale_evidence`。
- W1 只落 `checks_json`（`attested|unknown`）；W4 migration 建本表并开启 gate writer；`completion` 的 W1 门槛是 backlog done + operator，W4 再加 `visionGuardDone`/merge receipt 证据。

**6. `audit` / `thread_events`：事件归属修正**

- `audit` 表不变，加索引 `CREATE INDEX idx_audit_subject_ts ON audit(subject, ts);`。
- `BacklogItem.audit`、SOP 更新事件、check evidence 写入都写 `audit`；`subject='backlog_item:<id>'` / `'workflow_sop:<id>'`。
- `check evidence` 写入同事务追加 `audit(action='check_verified')`；W7a 订阅 audit，不轮询 `workflow_sops.version`。
- `BacklogItem.audit` 投影 newest-first、最多 100 条；超限返回 `audit_truncated: true` + cursor，全量审计走 operator CLI。
- **修正 0001 的旧写法**：`thread_events.kind` 不再承担 backlog 全生命周期。`created/suggested/approved/rejected` 发生在 thread 之前，不能写 `thread_events`；board 时间线读 `audit`。`thread_events` 只在 thread 存在后写 `backlog_item_dispatched` / `backlog_item_done` / `workflow_sop_updated` 投影事件。
- 不新增 `backlog_events` 表。

**7. `messages` / `queue_entries`：dispatch 只组合，不改 schema**

- kickoff message 用 `author_kind='system'`、`author_id='backlog-dispatch'`、`kind='backlog_kickoff'`、`idempotency_key='kickoff:<itemId>:<dispatchAttemptId>'`；0001 的 `messages.kind` 值域补 `backlog_kickoff`；`messages` 表不加列。
- queue entry 用 `source_kind='backlog_dispatch'`、`source_record_id=backlog_item.id`；`source_kind` 的最终枚举归 A1-3，A2-1 只新增该值。
- dispatch 事务写 `backlog_items` + `threads` + `messages` + `queue_entries` + `audit`；QueueProcessor 在提交后投递。

#### 3.4.4 存储替代：Redis Lua → SQLite 事务

| 操作 | clowder 机制 | codeteam 机制 | 事务边界 / 失败语义 |
|---|---|---|---|
| SOP 更新 | JS 读旧值 + Lua version CAS | `BEGIN IMMEDIATE` + `SELECT version` + `UPDATE ... WHERE version=?` + audit | 同事务；rowcount=0 → 409 + currentState；崩溃回滚，无半更新 |
| SOP 首次创建 | Lua 同时建 SOP + admission/attempt | `INSERT ... ON CONFLICT DO NOTHING` + audit；A2-2 在同一事务加 admission/attempt | 冲突返回已有行；不产生重复 SOP |
| Backlog transition | RMW + status guard | `BEGIN IMMEDIATE` + 读当前行 + 校验 + `UPDATE ... WHERE status=?` + audit | 同事务；status 不匹配 → 409；无 Redis lock |
| Dispatch | 30s lock + atomicDispatch Lua + 多步 thread/message/link | 单事务：backlog CAS + thread + kickoff message + queue entry + audit | 提交前崩溃全回滚；提交后 QueueProcessor 恢复；`dispatch_attempt_id` 防重 |
| Lease | 4 段 Lua | W5 单事务读/校验/更新 `lease_json` | W1 只建列；W5 启用；不移植 Lua |
| 读 SOP | Redis GET | 单读事务：SOP + 最新 evidence + backlog | 一致快照；不混合版本 |

> clowder 的 Redis dispatch lock 在 codeteam **drop**：SQLite `BEGIN IMMEDIATE` 已给单写者串行化；再叠 token lock 是多余机制。多进程 busy → `CODETEAM_SQLITE_BUSY_TIMEOUT_MS` 内重试一次，仍 busy 返回 503，不无限重试。

### 3.5 变量定义表

#### contract

| 变量 | 类型 | 默认/值域 | owner | clowder 来源 | 决定 | 说明 |
|---|---|---|---|---|---|---|
| `BacklogItemId` | TEXT | opaque sortable id | backlog | `backlog.ts:59`、`BacklogStore.ts:95` | `reuse` | 不改成 UUID；保持可排序 |
| `BacklogStatus` | enum | `open/suggested/approved/dispatched/done` | backlog | `backlog.ts:4` | `reuse` | 5 值不变；迁移规则 codeteam 收紧 |
| `BacklogPriority` | enum | `p0/p1/p2/p3` | backlog | `backlog.ts:3` | `reuse` | 不变 |
| `ThreadPhase` | enum | `coding/research/brainstorm` | backlog/thread | `backlog.ts:5` | `reuse` | 写 `threads.phase` + `dispatched_thread_phase` |
| `BacklogSuggestionStatus` | enum | `pending/approved/rejected` | backlog | `backlog.ts:6` | `reuse` | 不变 |
| `BacklogLeaseState` | enum | `active/released/reclaimed` | backlog | `backlog.ts:7` | `reuse` | W5 启用 |
| `WorkflowSopKey` | TEXT | `backlog_item_id` | sop | `workflow-sop.ts:23` | `reuse` | 一条 backlog item 一条 SOP |
| `SopDefinitionId` | enum | `development`（v1） | sop | `sop-definition.generated.ts:6` | `reuse` | 新增 definition 需 codegen + migration |
| `SopStage` | enum | 7 个 stage id | sop | `sop-definition.generated.ts:9` | `reuse` | 不新增 stage；`fresh_context` 可选 |
| `CheckStatus` | enum | `attested/verified/unknown` | sop | `workflow-sop.ts:8` | `reuse`（形状）/`adapt`（语义） | verified 证据化 |
| `ResumeCapsule` | object | `goal/done/currentFocus` | sop | `workflow-sop.ts:10` | `reuse` + limits | `done` 替换语义；加长度上限 |
| `SopChecks` | object | 4 个 check | sop | `workflow-sop.ts:16` | `reuse`（形状） | verified 由 evidence 投影 |
| `BacklogDependencies` | object | `evolvedFrom/blockedBy/related` | backlog | `backlog.ts:161` | `reuse` | W5 DAG 读 `blockedBy` |
| `WorkflowSop.version` | INTEGER | ≥1，单调 +1 | sop | `workflow-sop.ts:33` | `reuse` | 更新必须带 expectedVersion |
| `BatonHolder` | TEXT | active AgentProfile.id 或 `operator` | sop | `workflow-sop.ts:28` | `adapt` | 路牌，不授予球权 |
| `NextSkill` | TEXT/null | null = suggestedSkill | sop | `workflow-sop.ts:30` | `reuse` | 建议，不强制加载；不校验安装态 |
| `UpdatedBy` | TEXT | `agent:<profile>`/`operator:<id>`/`system:<gate>` | sop | `workflow-sop.ts:35` | `adapt` | 从 auth 派生，不取 body |
| `FeatureId` | TEXT | `feature:<id>` tag | sop/backlog | `callback-workflow-sop-routes.ts:55` | `reuse` | anchor 首次创建后不可改写；更新匹配任一 tag；anchor tag 不可移除 |
| `CreatedBy` | actor | `agent:<profile>`/`operator`/`system:forge:<provider>` | backlog | `backlog.ts:68` | `adapt` | system 只准初始 open|suggested；从 auth/来源派生 |
| `DispatchAttemptId` | TEXT | opaque | backlog | `backlog.ts:73` | `reuse` + unique | dispatch 幂等键 |
| `SopCheckEvidence` | row | verified only | sop | codeteam-new | `new` | W4 证据锚 |

#### state

| 变量 | 状态机/约束 | owner | 失败语义 |
|---|---|---|---|
| `backlog_items.status` | `open→suggested→approved→dispatched→done`；`open→approved` operator 直达；reject 回 open；done 终态且只从 dispatched 进 | backlog | 非法迁移 409；不静默改状态 |
| `backlog_items.suggestion_json.status` | `pending→approved/rejected` | backlog | pending 以外不可再 decide |
| `backlog_items.lease_json.state` | `active→released/reclaimed`；仅 dispatched | backlog | 非 dispatched 409；过期才可 reclaim |
| `workflow_sops.version` | 单调 +1；CAS mandatory | sop | 冲突 409 + currentState |
| `workflow_sops.stage` | 7 值；仅 completion 有 gate | sop | completion 缺证据 422 |
| `checks.*` | `unknown→attested→verified`；verified 需 evidence | sop | 无证据 verified 422；stale 降 unknown |
| `dispatch_attempt_id` | unique；同 attempt 幂等 | backlog | 重复 dispatch 返回已有 thread |
| `thread.backlog_item_id` | nullable；dispatch 后指向 item | thread | 与 item 不一致是 bug；事务回滚 |

#### config

| 变量 | 默认 | owner | 决定 | 说明 |
|---|---|---|---|---|
| `CODETEAM_SOP_DEFINITIONS_DIR` | `sop-definitions`（源仓相对） | sop | `new` | fork catalog 源；构建时 codegen，不从 clowder 运行时 import |
| `CODETEAM_SOP_RESUME_CAPSULE_MAX_BYTES` | 16384 | sop | `new` | goal+done+currentFocus 总字节上限；超限 422 |
| `CODETEAM_SOP_NEXT_SKILL_MAX` | 128 | sop | `new` | nextSkill 长度上限 |
| `CODETEAM_BACKLOG_LIST_LIMIT` | 200 | backlog | `new` | 列表查询上限，防无界返回 |
| `CODETEAM_BACKLOG_AUDIT_READ_LIMIT` | 100 | backlog | `new` | `BacklogItem.audit` 投影上限 |
| `CODETEAM_BACKLOG_LEASE_TTL_MS` | 60000，max 86400000 | backlog | `adapt` | 对齐 clowder 路由默认/上限；W5 启用 |
| `CODETEAM_SQLITE_BUSY_TIMEOUT_MS` | 见 plans/0002 W1（唯一权威） | 全局 SQLite | `reference` | plans/0002 W1 定义 5000；本卡只引用，不重复定义 |
| `CODETEAM_DATA_DIR` | 见 A1-1（唯一权威） | config | `reference` | 本卡只引用；SOP/backlog 数据在 SQLite，不放文件根 |

#### security

| 变量/规则 | 值/来源 | owner | 失败语义 |
|---|---|---|---|
| `operatorCredential` | A1-2：本地 `operator.key` 0600 + `codeteam auth init` | auth/backlog | backlog create/approve/dispatch/done/reclaim 缺/伪造 → 403，不降级 |
| `callbackRunToken` | A1-2：per-run token，strict owner auth | auth/sop | agent suggest/SOP update 缺 strict owner → 403 `strict_owner_auth_required` |
| `ownerUserId` | 从 credential/token 派生 | auth | 跨 owner 读写统一 404，不泄露存在性 |
| `actorRef` | `agent:<profile>` / `operator:<id>` / `system:<gate>` | auth | 只从凭据派生；body 里的 actor 字段拒绝 |
| `checkWriteAuthority` | agent/operator → `attested|unknown`；gate writer → `verified` | sop | 越权 422 `verified_requires_evidence`；不 fail-open |
| `verifiedEvidenceRef` | `sop_check_evidence.evidence_ref` + `subject_revision` | sop | 缺 evidence/revision → 422；不写 verified |
| `completionGate` | W1：backlog `done` + operator；W4：再加 completion evidence | sop/backlog | 缺任一 → 422 `completion_gate_required` |
| `backlogDoneGate` | 正常只允许 `dispatched→done`；`approved/open/suggested→done` 只走 import/operator override（reason+audit） | backlog | 非法 → 409；不静默 done |
| `featureBinding` | `tags_json` 含 `feature:<featureId>` | sop/backlog | 不匹配 → 422 `feature_mismatch` |
| `featureAnchorLock` | SOP 存在时 anchor tag 不可移除；tags 更新 operator-only | sop/backlog | 移除 → 422 `feature_anchor_locked` |
| `batonHolderValidation` | active AgentProfile.id 或 `operator` | sop | 未知/禁用 → 422；不授予球权 |
| `noImplicitBacklogItem` | task create 必须有现成 backlog item | backlog | 缺失 → 404 `backlog_not_imported`；不物化 |

#### observability

| 变量/事件 | 值/来源 | owner | 说明 |
|---|---|---|---|
| `audit` | append-only `audit` 表；subject/action/actor/args/ts | audit | backlog/SOP/check 每次 mutation 同事务写；不可 UPDATE/DELETE；BacklogItem.audit newest-first、100 条、`audit_truncated`+cursor |
| `thread_events.kind` | `backlog_item_dispatched` / `backlog_item_done` / `workflow_sop_updated` | thread | 只在 thread 存在后写投影事件；pre-thread 事件读 audit |
| `backlog_transition_total` | counter `{from,to,result}` | backlog | 观测非法迁移、CAS 失败 |
| `workflow_sop_cas_conflict_total` | counter | sop | 版本冲突率；异常升高说明 agent 并发写法有问题 |
| `sop_verified_write_rejected_total` | counter | sop | 伪造/缺证据 verified 写入 |
| `workflow_sop_check_verified` | audit event | sop | evidence 写入同事务写 audit；W7a 订阅，不轮询 version |
| `sop_check_stale_total` | counter `{check}` | sop | verified 因 revision 变化失效 |
| `backlog_dispatch_total` | counter `{result}` | backlog | 成功/幂等/冲突/回滚 |
| `sop_update_total` | counter `{field}` | sop | stage/baton/capsule/checks 更新面 |
| log 内容 | `backlog_item_id`、`version`、`changed_fields`、长度 | sop/backlog | 不记录完整 resumeCapsule/正文；避免敏感代码细节进日志 |

### 3.6 明确不做

- 不做第二套 SOP 状态机 / stage controller；`stage` 仍是告示牌，只有 `completion` 写入有 gate。
- 不新增 stage、skill、predicate 类型；fork catalog 只本地化参数。
- 不做 Mission Hub board / rich-block / Console 时间线；归 `hub-action-surface` P1-active。
- 不做 F073 P0 hooks、P2 handoff/ack/timeout、P4 hook 集成；分别归运行时 hooks、A3-1、W1/W2。
- 不做 docs 自动导入 / F040 聚合 / F058 importer / F076 跨项目治理；W1 只显式 create/import。
- 不做 eval 平台；A3-3 `harness-eval` 负责 eval。
- 不移植 Redis key/Lua/dispatch lock；SQLite 事务 + status/version CAS 取代。
- 不做 task-backed 隐式 backlog item；task create 缺 item fail closed。
- 不允许 agent approve/dispatch/done/reclaim，也不允许 agent 写 `verified`。
- 不新增第二套 audit/backlog/thread 表；`audit` 是唯一 append-only 事件账本。
- 不做 per-feature SOP；一条 backlog item 只有一条 `WorkflowSop`。

## 4. 风险与回滚

| 风险 | 级别 | 处置 |
|---|---|---|
| 把 SOP 写成 controller，猫变 workflow node | P1 | `stage` 迁移不校验；只有 `completion` + `verified` check 是写入 gate；代码 review 固定这条 |
| `verified` 仍可被 agent 伪造 | P1 | 写权拆分 + `sop_check_evidence` + 422 测试；W1 先拒绝 verified，W4 才启用 |
| dispatch 半事务 / orphan thread | P1 | 单 SQLite 事务 + `dispatch_attempt_id` 唯一索引 + crash matrix 测试 |
| 缺 backlog item 时静默物化，破坏单一真相源 | P1 | drop task-backed fallback；`task create` 404；测试覆盖 |
| dogfood 主路径被 gate 卡死（operator 建 item 无法 approve） | P2 | operator `open→approved` 直达；import/override 只留作例外路径 |
| `threads` 两列与 A1-3 的 schema 冲突 | P2 | A2-1 拥有 `threads.backlog_item_id/phase`；A1-3 只引用；合并前 grep 0001 §12.2 |
| `sop_check_evidence` 与 A3-3 gate 证据重复 | P2 | A2-1 只存 SOP check 的 verified 证据；A3-3 消费 `review/merge/verification` 表，不复制 |
| audit 投影无上限 | P2 | 读上限 100；分页/全量审计走 operator CLI；不在 item 行内嵌 |
| docs importer 误标 done | P2 | W1/W4 不做 docs 自动同步；只显式 import；F040/F058 语义 out-of-scope |
| `resumeCapsule` 过大/无信息 | P2 | 长度/字节限制 + stage 变更要求 currentFocus；422 |
| `batonHolder` 被误当球权 | P2 | 文档/字段说明明确“路牌，不授予球权”；A3-1 才管 handoff/lease |
| `projectId` 跨项目语义提前引入 | P3 | W1 只保留列；无跨项目 UI/治理；F076 已 supersede |

**回滚**：`backlog_items`/`workflow_sops`/`sop_check_evidence` 是新增/扩展表；回滚到 W1 基线即可。`threads` 两列、`tasks` CHECK 可用 migration down 回滚；不迁移 clowder Redis 数据。`audit` 只追加，回滚不清空（保留证据）。

## 5. Review 与签字

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | W1 schema、SQLite 事务/CAS、backlog 生命周期、dispatch 崩溃矩阵 | accept；P2 anchor tag 锁定 + P3 migration 顺序已回写 |
| 砚砚 | operator/agent 权限、`verified` 证据、owner scope、fail-closed | accept-with-modify；P2-1 `open→approved` + P3 批已回写 |
| 墨墨 | operator UX、SOP 告示牌语义、board 投影、docs importer 边界 | accept-with-modify；P2-1/P2-2/P2-3 + P3 批已回写 |
| operator | A2-1 架构卡是否可签 | [x] 已签（2026-10-25） |

> Review request `c934705b-ad43-449c-87e0-963cef37b64b`（2026-10-25，三猫，无 P1）。Review disposition：Kimi P2 anchor tag 锁定 → §3.2#6/§12.2#1；Kimi P3 migration 顺序 → §12.2#4；Glm P2-1 operator `open→approved` → §3.2#3/§3.3A；Glm P3 `messages.kind`/plans 挂点/suggest 幂等/verified 事件 → §12.2#7、plans/0003 W4、§3.2#2、§3.3C；Qwen P2-1 同 Glm；Qwen P2-2 `created_by_kind=system` → §12.2#1；Qwen P2-3 0001 回写 → 0001 §12.2/§7.3；Qwen P3 version 游标/多匹配/audit 截断/check 映射/`approved→done`/reject 图 → §3.2#6-8、§12.2#1/#5/#6、§3.3A。

> operator 于 2026-10-25 签字，A2-1 冻结为 W1/W4 实现契约。

**Review 重点**

1. `BacklogItem` / `WorkflowSop` 字段映射是否完整；`catId→agentProfileId` 等 rename 是否有遗漏。
2. SQLite 事务/status CAS 是否覆盖 Redis Lua 的并发语义；dispatch 单事务 crash matrix 是否成立。
3. `checks=verified` 的写权拆分 + `sop_check_evidence` 是否足够；是否与 W3/W4 gate 证据重复或冲突。
4. backlog 生命周期、operator credential、agent suggest 边界是否安全；是否会把 dogfood 卡死。
5. `stage=completion` gate、`markDone` gate、drop task-backed implicit item 是否影响 W1/W4 dogfood。
6. §12.2 diff 与 plans/0002 W1、plans/0003 W4 的挂点是否一致；是否有未排期的新范围。

**交卡前自检**

- [x] 组件图、数据流、状态机、存储/并发、失败恢复五段齐全。
- [x] 每个组件有 `reuse now` / `adapt now` / `extend now` / `drop` / `out-of-scope` 立场。
- [x] 变量表覆盖 contract/state/config/security/observability 五层。
- [x] 所有代码锚点 grep 可达（交卡后跑锚点检查）。
- [x] 风险与回滚写清；安全变量写明失败语义。
- [x] §12.2 回写清单完整；W1/W4 plan 挂点已核对。

[宪宪/deepseek-flash🐾]
