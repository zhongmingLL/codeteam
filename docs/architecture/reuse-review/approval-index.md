---
title: "approval-index 架构复用检视"
doc_kind: architecture-review
status: approved
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
source_cell: approval-index
source_card: ../../reuse/approval-index.md
template: ../0004-reuse-architecture-review-plan.md
---

# approval-index 架构复用检视

> **DP-MERGE-1=D 影响注（2026-10-25）**：三猫 review 已收敛 Q1=A（routine merge 不创建 approval；`merge` kind 只留 hard-gate）、Q3（approval:decide operator-only；merge:execute daemon-internal）、Q5（`merges` 增 executed_by/gate_evidence_ref/status/failure_ref）。本卡所有 merge approval / materialization principal 段按此解释；详见 `../merge-authority-drift-audit.md` §9。

## 1. 总结

| 项 | 结论 |
|---|---|
| clowder feature 范围 | F246 Approval Hub（producer catalog、registry/adapter、`originRef` + `approvalCardRef` 双锚、Resolution × Materialization、stale expiry、operator-only decide）；related F128/F139/F193/F221/F225/F231/F260/F266/F276/F292/F306/F321 只作模式参考。 |
| codeteam 复用总结 | **R0/R1 契约复用 + 单表适配**。复用 producer catalog 形状、双锚、Resolution × Materialization、stale/operator-only 语义；codeteam 不建 5 个 producer store，`approvals` 是唯一 human-gate 真相表。 |
| codeteam W | W1（`approvals` 表、request/decide/materialization 契约）；W4（CLI `approval list/show/approve/reject`）；W7（Hub 只读投影 + operator decide）。 |
| 一句话 | 所有**跨 owner 副作用的** human gate 只写 `approvals`；`origin_ref` 回答“什么触发”、`card_ref` 回答“在哪审批”、`effect_ref` 回答“副作用由谁证明”；accepted 不等于 succeeded。`completion` 是 operator-direct SOP gate，不进 approvals。 |
| 明确不含 | F246 的 12 个 feature producer、per-producer canonical stores/query aggregation、legacy `staged/anchored/tombstoned` publication、chat approval rich block、push notification、F281 结构化 why、eval verdict。 |

> **completion 边界**：F246 准入条件 #3 的“已认证 operator 当场同步直执”不进 Hub；A2-1 的 `completion` 由 operator + `sop_check_evidence` 承担，不是孤儿审批项。W8 outbound 若将来新增跨 owner human gate，扩本 catalog 的 kind，不另造审批机制。
>
> **KD-21 说明**：F246 KD-21 反对的是“为已有 canonical store 的 proposal 再建中央状态”，会制造影子状态与迁移债。codeteam 的 5 个 gate 没有既有 proposal store；`approvals` 本身就是唯一 canonical proposal，effect truth 仍在 merges/runs/artifacts/waits，因此单表是“唯一一份状态”，不是第二中央 store。

**组件立场**

| 组件 | 立场 | codeteam 处理 |
|---|---|---|
| `ApprovalProducerCatalogEntry` / producer catalog | `reuse now` | codeteam 5 个 gate producer：`merge` / `design_gate` / `spec_change` / `blocker` / `budget_pause` |
| `ApprovalOriginRef` / `ApprovalCardRef` / `ApprovalEnvelope` | `reuse now` | 双锚形状复用；`card_ref` 指向 pointer message，不指向 approval rich block |
| `Resolution` / `Materialization` | `reuse now` | 四态 resolution + 五态 materialization；`accepted ≠ succeeded`；`effect_ref` 是 owner receipt |
| `ApprovalIngress` staged/anchored/tombstoned | `drop` | 同库 SQLite 单事务写 `approvals` + pointer message + audit，不需要 publication 状态机 |
| per-producer adapter/registry | `adapt now` | 单 `ApprovalsStore` + 静态 catalog；一个 `POST /api/approvals/:id/decide`；不建 5 个 store |
| `ApprovalHubItem` / `SettledApprovalHubItem` | `reuse now` | W7 只读投影；`open/stale/settled`；`materialization` 独立展示 |
| operator credential | `reuse now` | A1-2 `operator.key` / console-link；只有 operator 能 decide |
| chat approval rich block | `drop` | `messages.rich_blocks_json` 不含 approval；只允许 `approval_pointer` 指向 Hub |
| legacy `legacy_unanchored` | `out-of-scope` | codeteam greenfield 无历史；不做 backfill/re-attestation |
| F246 12-feature registry | `out-of-scope` | 只保留 5 个 codeteam gate；不迁 F128/F225/F276 等 |
| push notification / IM | `out-of-scope` | Hub 是 pull surface；提醒走 `waits`/audit，不造 push channel |
| F281 结构化 why / eval | `defer→W4+` | v1 `decided_note` 自由文本；结构化 why/eval 后接 |

## 2. clowder 架构

### 2.1 架构图

```text
Producer route / callback
        │  canonical proposal staged
        ▼
ApprovalIngress.publish
  ├─ validate origin（message-required / message-or-event）
  ├─ persist approval card（chat message + rich block）
  ├─ commit envelope: originRef + approvalCardRef
  └─ fan-out Hub socket / chat broadcast
        │
        ▼
ApprovalPublication = staged | anchored | tombstoned | legacy_unanchored
        │
        ▼
ApprovalProducerRegistry
  ├─ one adapter per producer
  ├─ listPending(user)
  └─ normalize legacy status → Resolution × Materialization
        │
        ▼
ApprovalHubItem / SettledApprovalHubItem

Producer decision endpoint
  ├─ operator only
  └─ accepted / rejected / closed_without_decision
        │
        ▼
effect owner receipt（merge / review / artifact / task / budget）
        │
        ▼
materialization: not_started → outcome_unknown / in_progress → succeeded / failed
```

### 2.2 数据流

1. **发布**：producer 在自己的 canonical store 预留 proposal；`ApprovalIngress.publish` 校验 origin（message 或 event）、按 producer `sourcePolicy` 决定是否必须 message origin，持久化 approval card，再把 `originRef` + `approvalCardRef` 写回 canonical publication。card 是 Hub 可见性的 commit point；card 失败必须 abort/tombstone，不能留下 Hub-visible orphan。
2. **聚合**：Hub 通过 per-producer adapter `listPending(user)` 读 canonical stores；registry 校验 producer binding/lifecycle version，拒绝 missing/extra producer；legacy raw status 在 adapter 边界归一为 `Resolution × Materialization`，不进入 renderer。
3. **决策**：producer 自己的 decision endpoint 只接受 operator；`accepted` 只是决议事实，不是副作用成功。
4. **物化**：effect owner 执行 merge/review/task/budget 等副作用，写 owner receipt；`materialization` 独立从 `not_started` 到 `in_progress`/`succeeded`/`failed`/`outcome_unknown`。只有 owner-backed `effectProofRef` 才能升级 `succeeded`。
5. **过期**：`expires_at` 到点只让 item 变 stale，不自动 reject；operator 刷新/重新提议。
6. **历史**：settled 保留双锚与决定人/时间；withdrawn/superseded/stale/expired 只在 adapter 边界归为 `closed_without_decision`。

### 2.3 状态机 / 生命周期

**A. Resolution × Materialization（canonical v1）**

```text
resolution:
  open ──accept──► accepted ──reject──► rejected
    │                  │
    └──close───────────┴──► closed_without_decision

materialization（只有 accepted 可离开 not_started）:
  not_started ──claim──► in_progress(attemptRef)
       │                     ├──owner receipt──► succeeded(effectProofRef)
       │                     ├──failure────────► failed(failureRef, retryable)
       │                     └──crash──────────► outcome_unknown
       └──accepted without proof──► outcome_unknown
```

- `accepted` 不是 success；`succeeded` 必须有 owner-backed `effectProofRef`。
- `rejected/closed_without_decision` 只能 `not_started`。
- `outcome_unknown` 由恢复读 owner receipt 收敛：有 proof → succeeded；无 proof → 重试或 failed，不伪造成功。
- `failed.retryable` 决定是否可重试；非 retryable 保持 accepted + failed，等待 operator/owner。

**B. Publication（clowder）**

```text
staged ──card persisted + envelope committed──► anchored
   │
   ├──pre-card failure──► tombstoned
   └──legacy no anchor──► legacy_unanchored
```

- codeteam **drop** 这层：`approvals` + pointer message 同库同事务；没有 staged/tombstoned 中间态。

**C. Producer/writer epoch（clowder Phase I）**

```text
legacy_active → draining → fenced → v1_active
```

- codeteam greenfield 无 legacy writer；**drop** epoch 表。未来迁移 clowder approvals 时再引入。

### 2.4 关键数据结构

```ts
// packages/shared/src/types/approval-hub.ts:30
type ApprovalOriginRef =
  | { kind: 'message'; threadId: string; messageId: string }
  | { kind: 'event'; anchor: string; summary: string; threadId?: string };

// :34
interface ApprovalCardRef { threadId: string; messageId: string; }

// :39
interface ApprovalEnvelope {
  canonicalProposalId: string;
  sourceFeatureId: ApprovalProducerId;
  ownerUserId: string;
  requesterCatId: string;
  originRef: ApprovalOriginRef;
  approvalCardRef: ApprovalCardRef;
  createdAt: number;
}

// :109
interface ApprovalHubItem extends ApprovalLifecycleProjection {
  proposalId: string;
  sourceFeatureId: ApprovalProducerId;
  requesterCatId: string;
  ownerUserId: string;
  summary: string;
  detail: Record<string, unknown>;
  navigation: ApprovalNavigation;
  inlineApprovable: boolean;
  expiresAt?: number;
  createdAt: number;
}
```

```ts
// packages/shared/src/types/approval-lifecycle.ts:5,8
type ApprovalResolution = 'open' | 'accepted' | 'rejected' | 'closed_without_decision';
type ApprovalMaterialization =
  | { state: 'not_started' }
  | { state: 'outcome_unknown' }
  | { state: 'in_progress'; attemptRef: string }
  | { state: 'succeeded'; effectProofRef: string }
  | { state: 'failed'; failureRef: string; retryable: boolean };
```

### 2.5 Current truth 与代码路径

| # | 事实 | 代码锚点 |
|---|---|---|
| T1 | `ApprovalProducerId` 是 registry 的稳定 ID；catalog 是 producer 的静态真相 | `packages/shared/src/types/approval-hub.ts:13`、`packages/shared/src/approval-producer-catalog.ts:70` |
| T2 | `originRef` 支持 message/event 两种来源；message 必须 threadId+messageId | `approval-hub.ts:30`、`:136` |
| T3 | `approvalCardRef` 固定 threadId+messageId；card 是 Hub 可见性 commit point | `approval-hub.ts:34`、`:150`、`ApprovalIngress.ts:91`、`:162` |
| T4 | `ApprovalPublication` 有 staged/anchored/tombstoned/legacy_unanchored；pre-card 失败 abort，post-card 失败可恢复 | `approval-hub.ts:54`、`ApprovalIngress.ts:23`、`:91`、`:162` |
| T5 | `ApprovalIngress.publish` 校验 origin、按 producer `sourcePolicy` 要求 message，persist card 后 commit envelope | `ApprovalIngress.ts:64`、`:69`、`:108`、`:212` |
| T6 | registry 要求每个 producer 一个 adapter + lifecycle contract version；missing/extra fail closed | `packages/api/src/domains/approval-hub/ApprovalProducerRegistry.ts:33`、`:36`、`:52`、`:55` |
| T7 | Hub `listPending` 聚合 per-producer adapters，并在边界归一 legacy status | `ApprovalProducerRegistry.ts:70`、`:76`、`:100` |
| T8 | resolution 四态；materialization 五态；只有 accepted 可离开 not_started | `packages/shared/src/types/approval-lifecycle.ts:5`、`:8`、`:23`、`:30` |
| T9 | legacy approved 无 owner proof 只能归一为 `accepted + outcome_unknown`，不能直接 succeeded | `approval-lifecycle.ts:63`、`:76`、`:78` |
| T10 | producer catalog 含 sourcePolicy/decisionSurface/systemOriginExemption/history/humanDispositionReasonCodes | `approval-producer-catalog.ts:9`、`:21`、`:22`、`:57` |
| T11 | 只有 operator 能 decide；agent/run token 只能 request，不能 approval decide；routine merge 只能走 merge-owner capability（`DP-MERGE-1=D`） | `codeteam/architecture/reuse-review/callback-auth.md:51`、`:166`、`:271`、`:273` |
| T12 | 0001 `approvals` 已有 origin/card/effect refs、resolution/materialization、decided_note、expires_at；缺 `decided_at`、JSON 形状/CHECK | `codeteam/architecture/0001-codeteam-architecture-v1.md:1419`、`:1457` |
| T13 | W1 验收要求 approval request/decision/expiry 可持久化、三锚、accepted/materialization 分离、stale 不自动 reject | `codeteam/plans/0002-w0-w2-foundation.md:254`、`:255` |
| T14 | W7 只读 Hub；approval decide 只接受 operator credential；routine merge 走 merge-owner capability；MCP 不暴露 approval decide/merge execution | `codeteam/plans/0004-w5-w8-scale-product.md:371`、`:372`、`:373` |

### 2.5.1 上游已知缺口 → 本卡处置

| # | 上游缺口（实证） | 影响 | 本卡处置 |
|---|---|---|---|
| G1 | clowder 的 canonical state 分散在各 producer store，Hub 只做 query aggregation（F246 KD-3/KD-21） | 照搬会为 5 个 codeteam gate 造 5 个 store + registry + adapter，纯 ceremony | codeteam 只有 `approvals` 一张 canonical 表；catalog 静态、decision 单端点；不建 per-producer store/aggregation |
| G2 | `ApprovalIngress` 有 staged/anchored/tombstoned publication 状态（`approval-hub.ts:54`、`ApprovalIngress.ts:91`） | 同库 SQLite 会多一套中间态 | codeteam 用单事务写 `approvals` + pointer message + audit；**drop** publication 状态机 |
| G3 | chat card 是 Hub 可见性 commit point（F246 KD-14） | approval rich block 可被伪造/过期 | codeteam `messages.rich_blocks_json` 不含 approval；只写 `approval_pointer`，权威项只来自 `approvals` |
| G4 | legacy raw status 需要 adapter 归一，approved 无 proof 只能 outcome_unknown（`approval-lifecycle.ts:63`） | greenfield 无 legacy，但容易把 accepted 当 success | codeteam v1 直接存 canonical resolution/materialization；accepted 不自动 succeeded；`effect_ref` 必须有 owner receipt |
| G5 | F246 catalog 有 12 个 feature producers | 照搬会把 codeteam 做成通用审批中心 | codeteam catalog 只保留 5 个 gate producer：merge/design_gate/spec_change/blocker/budget_pause |
| G6 | clowder 每个 producer 有自己的 decision endpoint | 5 端点 + 5 auth 面 | codeteam 单一 `POST /api/approvals/:id/decide`，operator-only；effect 执行仍归各 owner |
| G7 | `accepted` 与 `materialization` 分离，但 UI/CLI 容易只显示 accepted（F246 KD-19） | 假完成 | codeteam Hub/CLI 同时展示 `resolution` + `materialization`；succeeded 必须 `effect_ref`；accepted+not_started 显示“待执行” |
| G8 | expiry 到点只 stale、不自动 reject（F246 KD-5） | 自动 reject 会错误关闭上下文 | codeteam `expires_at` 只影响 projection；decide stale → 409 `approval_stale`，operator 刷新/重新提议；resolution 仍 open |
| G9 | `sourceMessageId` 曾兼任 origin/card 两种语义（F246 KD-13） | 无法精确回溯 | codeteam `origin_ref_json` + `card_ref_json` 双锚；`card_ref` 指向 pointer message；`effect_ref` 第三锚 |
| G10 | system origin exemption 是 capability gate，不是 runtime proof（F246 catalog 注释） | 可能被 producer 误声明 | codeteam v1 无 system pseudo-user；所有 producer `system_origin_exemption='forbidden'`；event origin 用 anchor/summary |
| G11 | F246 Phase I 有 producer writer epoch（KD-20） | greenfield 无 legacy | codeteam **drop** epoch；未来迁移 clowder approvals 时另立 |
| G12 | `inlineApprovable` 需要 min fields，不能靠 feature 自报（F246 KD-4） | 空卡可一键批 | codeteam `inline_approvable` 由 payload 的 summary/impact/action 计算；缺 → false |
| G13 | Hub 是 pull surface，不是 push notification | 容易把审批提醒做成第二通道 | codeteam 提醒走 `waits`/audit；不造 push/IM；Hub 只读 |
| G14 | F281 结构化 why 尚未接入 | 拒绝理由不可度量 | v1 `decided_note` 自由文本；rejected 必填；W4+ 再接结构化 |
| G15 | `ApprovalCardCommittedError` 处理 post-card commit failure | 同库单事务可消除 | codeteam 同事务写 approvals + pointer + audit；card/pointer 失败整体回滚，不需要 post-card 错误类型 |
| G16 | F246 的 12 producer adapter 是 internal-only，不暴露 MCP | codeteam 容易误开 decide 工具 | codeteam MCP 只暴露 `approval_request`（create）；approval decide 只在 operator CLI/Console；merge execution 在 merge-owner surface（`DP-MERGE-1=D`） |

## 3. codeteam 架构

### 3.1 架构图

```text
Agent callback / MCP approval_request
        │  strict owner auth + producer kind + origin
        ▼
ApprovalService.request
  ├─ validate catalog kind + sourcePolicy
  ├─ validate origin (message owner/thread OR event anchor/summary)
  ├─ INSERT approvals(resolution=open, materialization=not_started)
  ├─ INSERT messages(kind='approval_pointer', card_ref)
  ├─ UPDATE approvals.card_ref_json
  └─ audit approval_requested
        │  one SQLite transaction
        ▼
Approval Hub / CLI list
  ├─ open / stale / settled
  ├─ resolution + materialization displayed separately
  └─ navigation: origin_ref / card_ref

Operator decide
  POST /api/approvals/:id/decide (operator credential only)
  ├─ CAS resolution='open'
  ├─ accepted / rejected / closed_without_decision
  ├─ decided_by/at/note + audit
  └─ no materialization in this transaction

Effect owner
  merge / review / task / budget executor
  ├─ claim accepted+not_started → in_progress(attemptRef, effect_reservation_ref)
  ├─ execute effect
  ├─ write effect_ref + succeeded
  └─ failure / crash → failed / outcome_unknown
        │
        ▼
Approval Hub projection (W7)
```

### 3.2 数据流

1. **Request**：agent 经 callback/MCP `approval_request`（strict owner auth）或 operator CLI 发起；`kind` 必须命中 catalog；`origin_ref` message 需 owner/thread 匹配，event 需 anchor/summary；`idempotency_key = kind + ':' + origin anchor`（调用方也可显式提供，服务端校验非空）；同一事务写 `approvals`（open/not_started）、`messages(kind='approval_pointer')`、`card_ref`、audit。指针失败 → 整体回滚，无 orphan。
2. **List**：Hub/CLI 读 `approvals`（open + settled）；`expires_at < now && resolution='open'` → projection stale；不自动 reject；不读 chat approval rich block。
3. **Decide**：operator credential only；CAS `resolution='open'`；accepted/rejected/closed_without_decision；`decided_by` 从 credential 派生；rejected 必须 `decided_note`；stale 拒绝 decide；audit。**不**在同一事务执行副作用。重试语义：`resolution` 已等于请求值 → 幂等返回当前态；已为异值 → 409。
4. **Materialize**：effect owner 对 accepted+not_started 做 CAS → in_progress(attempt_ref, effect_reservation_ref)；`effect_reservation_ref` 是预分配的新 owner receipt 行 id（daemon 签发，不接受调用方自带）；owner 创建行时写 `approval_id`（UNIQUE），执行；成功写 `effect_ref = effect_reservation_ref` + succeeded；失败写 failed(failure_ref,retryable)；crash → outcome_unknown。**principal**：merge → daemon merge service（hard-gate 由 operator approve + daemon 执行；routine merge 无 approval）；design_gate/spec_change/blocker/budget_pause → daemon control plane；run token/agent-key 对 materialization 一律 403。
5. **Recovery**：outcome_unknown 按 `effect_reservation_ref` + owner `approval_id` 精确读 receipt；receipt 存在且 `created_at > decided_at` → succeeded；不存在 → 重试或 failed；in_progress 的 attempt_ref/reservation 幂等；不同 attempt/reservation 冲突。
6. **Close**：withdraw 只允许 requester 本人；`closed_without_decision` 的 operator close 只接受 operator credential；settled 保留；不删除。accepted 卡死时 operator 可 abandon：`materialization_json={state:'failed',failureRef:'operator_abandon',retryable:false}`，audit `approval_abandoned`。
7. **Hub**：W7 只读投影；decide 只走 operator CLI/Console；MCP 不暴露 decide/merge。

### 3.3 状态机 / 生命周期

**A. Resolution × Materialization（codeteam）**

```text
open ──operator accept──► accepted ──effect owner──► materialization
  │                          │
  ├──operator reject──► rejected（note required）
  └──close────────────► closed_without_decision

accepted + not_started
  ├──claim──► in_progress(attemptRef)
  │             ├──effect_ref──► succeeded
  │             ├──failure─────► failed(retryable?)
  │             └──crash───────► outcome_unknown
  └──no effect yet─────────────► accepted + not_started（not success）
```

- `accepted` 只是决议；`succeeded` 必须有 `effect_ref`（owner receipt）。
- `rejected/closed_without_decision` 只能 `not_started`。
- `outcome_unknown` 可收敛到 succeeded/failed；不伪造成功。
- `failed.retryable=false` 保持 accepted+failed，等 operator/owner；不自动重开。

**B. Expiry**

```text
open + expires_at < now ──► stale projection（resolution 仍 open）
stale decide ──► 409 approval_stale
operator refresh ──► 新 approval 或更新 expires_at（audit）
```

- 不自动 reject；`closed_without_decision` 只由显式 close/withdraw/supersede。

**C. Transaction / crash matrix**

| 操作 | 事务边界 | 崩溃结果 |
|---|---|---|
| Request | `approvals` insert + pointer message insert + card_ref update + audit 同事务 | 回滚：无 approval/pointer；重试同 idempotency key |
| Decide | CAS resolution open→accepted/rejected + decided fields + audit 同事务 | 回滚：仍 open；重试同 decision 幂等 |
| Materialize claim | CAS accepted+not_started→in_progress + attempt_ref + audit 同事务 | 回滚：仍 not_started；可重试 |
| Materialize success | owner effect 已提交 → effect_ref + succeeded + audit 同事务 | 崩溃后 outcome_unknown；恢复读 owner receipt 收敛 |
| Close | open→closed_without_decision + audit 同事务 | 回滚：仍 open |

### 3.4 关键数据结构（与 clowder 对比）

| clowder | codeteam | 立场 | 关键差异 |
|---|---|---|---|
| `ApprovalProducerId` / catalog（`approval-hub.ts:13`、`approval-producer-catalog.ts:70`） | `approval_kind` + static catalog | `reuse now` | 5 个 codeteam gate：merge/design_gate/spec_change/blocker/budget_pause |
| `ApprovalOriginRef`（`:30`） | `origin_ref_json` | `reuse now` | message/event 两种；message 校验 owner/thread |
| `ApprovalCardRef`（`:34`） | `card_ref_json` | `adapt now` | 指向 `messages(kind='approval_pointer')`，不是 approval rich block |
| `ApprovalEnvelope`（`:39`） | `approvals` row | `adapt now` | 单表；`canonicalProposalId`→`id`；`sourceFeatureId`→`kind` |
| `ApprovalResolution`（`approval-lifecycle.ts:5`） | `resolution` | `reuse now` | 四态；open 仍 open on expiry |
| `ApprovalMaterialization`（`:8`） | `materialization_json` + `effect_ref` | `reuse now` | succeeded 用 `effect_ref` 列，不复制 effectProofRef |
| `ApprovalHubItem`（`:109`） | W7 projection | `reuse now` | 只读；resolution/materialization 分开展示 |
| `ApprovalIngress` publication（`ApprovalIngress.ts:64`） | `ApprovalService.request` | `drop` | 同库单事务；无 staged/anchored/tombstoned |
| per-producer adapter/registry | static catalog + single store | `adapt now` | 不建 5 个 store；registry 只校验 catalog kind |
| `systemOriginExemption`（catalog） | forbidden | `drop` | v1 无 system pseudo-user；event origin 显式 |
| operator credential | A1-2 `operator.key`/console-link | `reuse now` | approval decide 只接受 operator；routine merge 由 daemon `service:merge-owner` 执行（无 MCP/REST 暴露） |
| `legacy_unanchored` / writer epoch | out-of-scope | `drop` | greenfield 无 legacy |

**Producer catalog（codeteam 5 gates）**

| kind | source policy | effect owner | decision surface | system origin |
|---|---|---|---|---|
| `merge` | `message-required` | `merges` | `approval_hub` | `forbidden` |
| `design_gate` | `message-required` | `reviews` / `artifacts` | `approval_hub` | `forbidden` |
| `spec_change` | `message-required` | `artifacts` / `thread_events` | `approval_hub` | `forbidden` |
| `blocker` | `message-or-event` | `tasks` / `waits` | `approval_hub` | `forbidden` |
| `budget_pause` | `message-or-event` | `budgets` | `approval_hub` | `forbidden` |

#### 3.4.3 §12.2 回写清单

**1. `approvals` 表：重命名 JSON 列 + 补 `decided_at` + 约束**

```sql
approvals(
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('merge','design_gate','spec_change','blocker','budget_pause')),
  idempotency_key TEXT,
  origin_ref_json TEXT NOT NULL CHECK (json_valid(origin_ref_json)),
  card_ref_json TEXT NOT NULL CHECK (json_valid(card_ref_json)),
  resolution TEXT NOT NULL CHECK (resolution IN ('open','accepted','rejected','closed_without_decision')),
  materialization_json TEXT NOT NULL CHECK (json_valid(materialization_json)),
  effect_reservation_ref TEXT,
  effect_ref TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  decided_note TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (resolution = 'open' AND decided_by IS NULL AND decided_at IS NULL)
    OR (resolution <> 'open' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CHECK (resolution <> 'rejected' OR (decided_note IS NOT NULL AND length(trim(decided_note)) > 0)),
  CHECK (idempotency_key IS NULL OR length(trim(idempotency_key)) > 0),
  CHECK (resolution = 'accepted' OR json_extract(materialization_json,'$.state') = 'not_started'),
  CHECK (json_extract(materialization_json,'$.state') IN ('not_started','outcome_unknown','in_progress','succeeded','failed')),
  CHECK (effect_ref IS NULL OR json_extract(materialization_json,'$.state') = 'succeeded'),
  CHECK (json_extract(materialization_json,'$.state') <> 'succeeded' OR effect_ref IS NOT NULL),
  CHECK (json_extract(materialization_json,'$.state') NOT IN ('in_progress','outcome_unknown','succeeded') OR effect_reservation_ref IS NOT NULL),
  CHECK (json_extract(materialization_json,'$.state') <> 'succeeded' OR effect_ref = effect_reservation_ref),
  CHECK (json_extract(materialization_json,'$.state') <> 'in_progress' OR json_extract(materialization_json,'$.attemptRef') IS NOT NULL),
  CHECK (json_extract(materialization_json,'$.state') <> 'failed' OR (json_extract(materialization_json,'$.failureRef') IS NOT NULL AND json_extract(materialization_json,'$.retryable') IS NOT NULL))
);

CREATE INDEX idx_approvals_open ON approvals(resolution, expires_at);
CREATE INDEX idx_approvals_kind ON approvals(kind, resolution);
CREATE INDEX idx_approvals_thread ON approvals(thread_id, created_at DESC);
CREATE UNIQUE INDEX idx_approvals_idempotency ON approvals(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX idx_approvals_one_open_gate ON approvals(task_id, kind)
  WHERE resolution='open' AND task_id IS NOT NULL AND kind IN ('merge','design_gate','spec_change');
```

- Rename：`origin_ref`→`origin_ref_json`、`card_ref`→`card_ref_json`、`materialization`→`materialization_json`；add `decided_at`。
- `materialization_json` states：`not_started` / `outcome_unknown` / `in_progress(attemptRef)` / `succeeded`（`effect_ref` 列是 proof）/ `failed(failureRef,retryable)`。
- `effect_reservation_ref` 是 claim 时预分配的 **新 owner receipt 行 id**（`merge:<id>` / `run:<id>` / `artifact:<sha>` / `wait:<id>`）；`in_progress/outcome_unknown/succeeded` 必填；`succeeded` 时 `effect_ref = effect_reservation_ref`。
- `effect_ref` 是 owner receipt；`succeeded` 必填；`not_started` 必须 null；owner receipt 行创建时间必须晚于 `decided_at`（应用层 + audit）。
- 1:1 绑定：`merges` / `runs` / `artifacts` / `waits` 各加 `approval_id TEXT UNIQUE REFERENCES approvals(id)`；effect owner 新建 receipt 行时写 `approval_id`，recovery 按 `effect_reservation_ref`/`approval_id` 精确对账。`thread_event` 不作 effect_ref（投影不是 owner truth）。
- `card_ref_json` 必须有；指向 `messages(kind='approval_pointer')`。pointer 由 system 写（`author_kind='system'`, `author_id='approval-index'`, `control_ref='approval:<id>'`），不是 agent approval card；`rich_blocks_json` 不含 approval。
- `expires_at` 只影响 projection；不写 resolution。

**2. `messages.kind` 补 `approval_pointer`**

- `messages.kind` 值域加 `approval_pointer`；`messages.rich_blocks_json.kind` **不含** approval；pointer message 只做导航，权威项在 `approvals`。
- 同一事务写 pointer + approvals；pointer 失败整体回滚。

**3. `thread_events.kind`**

- 可选投影：`approval_requested` / `approval_decided` / `approval_materialized`；只在 thread 存在时写；完整事件读 audit。
- 不新增 `approval_events` 表。

**4. `effect_ref` owner 映射**

| kind | business effect | receipt owner | effect_ref 示例 |
|---|---|---|---|
| `merge` | merge receipt | `merges` | `merge:<mergeId>` |
| `design_gate` | first implement run / design artifact | `runs` / `artifacts` | `run:<runId>` / `artifact:<newSha>` |
| `spec_change` | `workflow_sops` 回 plan / spec revision | `artifacts` / `runs` | `artifact:<newSha>` / `run:<runId>` |
| `blocker` | task blocked / wait | `waits` | `wait:<waitId>` |
| `budget_pause` | budget paused | `waits` | `wait:<waitId>` |

- **1:1 receipt**：claim 时预分配 `effect_reservation_ref`（新 owner 行 id）；owner 行创建时 id 必须等于该 reservation，并写 `approval_id`（UNIQUE）；`succeeded` 时 `effect_ref = effect_reservation_ref`；recovery 按 reservation/approval_id 精确对账。
- **post-decision**：receipt 行 `created_at > decided_at`；禁止引用 accept 之前已存在的 review/artifact（design/spec 必须用批准后的新 run 或新 revision）。
- `approvals` 只存 ref，不复制 owner 正文/状态；owner 仍是 effect truth。`thread_event` 不作 effect_ref（投影不是 owner truth）。

### 3.5 变量定义表

#### contract

| 变量 | 类型 | 默认/值域 | owner | clowder 来源 | 决定 | 说明 |
|---|---|---|---|---|---|---|
| `ApprovalId` | TEXT | opaque | approval-index | `ApprovalEnvelope.canonicalProposalId` | `rename` | 单表主键 |
| `ApprovalKind` | enum | `merge/design_gate/spec_change/blocker/budget_pause` | approval-index | `ApprovalProducerId` | `adapt` | 5 个 codeteam gate |
| `ApprovalOriginRef` | object | message/event | approval-index | `approval-hub.ts:30` | `reuse` | message origin 校验 owner/thread |
| `ApprovalCardRef` | object | `{threadId,messageId}` | approval-index | `approval-hub.ts:34` | `adapt` | 指向 approval_pointer |
| `ApprovalResolution` | enum | `open/accepted/rejected/closed_without_decision` | approval-index | `approval-lifecycle.ts:5` | `reuse` | accepted ≠ succeeded |
| `ApprovalMaterialization` | object | 5 states | approval-index | `approval-lifecycle.ts:8` | `reuse` | succeeded 用 `effect_ref` |
| `EffectRef` | TEXT/null | owner receipt | effect owner | `ApprovalMaterialization.effectProofRef` | `adapt` | 独立列；`effect_reservation_ref` 预分配，succeeded 时二者相等 |
| `Payload` | JSON | bounded summary/detail | approval-index | `ApprovalItem.detail` | `adapt` | display only；不含 secrets |

#### state

| 变量 | 状态机/约束 | owner | 失败语义 |
|---|---|---|---|
| `approvals.resolution` | open→accepted/rejected/closed；CAS | approval-index | 非法/过期 409；不静默 |
| `approvals.materialization_json` | not_started→in_progress→succeeded/failed；accepted 才能离开 not_started | effect owner | 缺 proof 不 succeeded；crash→outcome_unknown |
| `approvals.effect_reservation_ref` | claim 时预分配；in_progress/outcome_unknown/succeeded 必填 | effect owner | 缺失 → 不能 claim；owner receipt id 必须匹配 |
| `approvals.effect_ref` | succeeded 必填；其他 null | effect owner | 缺/伪造 → 拒绝 succeeded |
| `approvals.idempotency_key` | 非空唯一；`kind:origin anchor` | approval-index | 重复 → 幂等返回已有；冲突 → 409 |
| `approvals.expires_at` | open + now>expires → stale projection | approval-index | decide stale → 409 `approval_stale`；不自动 reject |
| `approvals.decided_note` | rejected 必填 | approval-index | 空 note → 422 |
| `approvals.card_ref_json` | 必须指向 live `approval_pointer` | approval-index | 缺失/删除 → 500/health |
| `approvals.origin_ref_json` | message owner/thread 或 event anchor/summary | approval-index | 不匹配 → 422 |

#### config

| 变量 | 默认 | owner | 决定 | 说明 |
|---|---|---|---|---|
| `CODETEAM_APPROVAL_EXPIRY_MS` | 86400000（24h） | approval-index | `new` | 可为 null；到点只 stale |
| `CODETEAM_APPROVAL_PAYLOAD_MAX_BYTES` | 16384 | approval-index | `new` | payload 上限；超限 422 |
| `CODETEAM_APPROVAL_NOTE_MAX` | 2000 | approval-index | `new` | decided_note 上限 |
| `CODETEAM_APPROVAL_LIST_LIMIT` | 200 | approval-index | `new` | Hub/CLI 列表上限 |
| `CODETEAM_SQLITE_BUSY_TIMEOUT_MS` | 见 plans/0002 W1（唯一权威） | 全局 SQLite | `reference` | request/decide/materialize 事务使用 |
| `CODETEAM_DATA_DIR` | 见 A1-1（唯一权威） | config | `reference` | approvals 在 SQLite，不放文件根 |

#### security

| 变量/规则 | 值/来源 | owner | 失败语义 |
|---|---|---|---|
| `operatorCredential` | A1-2 `operator.key`/console-link | auth/approval | decide 缺/伪造 → 403；run token/agent-key → 403 |
| `agentRequestOnly` | MCP 只暴露 `approval_request` | approval-index | agent 调 decide/merge → 403/不存在 |
| `materializationPrincipal` | merge → daemon merge service（hard-gate operator approve + daemon execute；routine merge 无 approval）；design/spec/blocker/budget → daemon control plane | effect owner | run token/agent-key 调 materialize → 403；attempt/reservation 由 daemon 签发 |
| `closePrincipal` | withdraw 仅 requester；closed_without_decision 仅 operator | approval-index | 其他 principal → 403 |
| `budgetPauseRequester` | `kind='budget_pause'` + event origin 可由 `requested_by='service:budget-guard'` 发起 | approval-index | 仅该 kind/origin；service 不能 decide/materialize |
| `acceptedAbandon` | operator-only abandon：accepted → failed(`operator_abandon`, retryable=false) | approval-index | 非 operator → 403；audit |
| `requestIdempotency` | `idempotency_key` 非空唯一；同 kind/task 的 merge/design/spec 至多一个 open | approval-index | 重复 request → 幂等/409；不产生双卡 |
| `originOwnerMatch` | message origin 的 owner/thread 与 principal 一致 | approval-index | 不匹配 → 422；system pseudo-user forbidden |
| `cardPointerOnly` | `messages.rich_blocks_json` 不含 approval | approval-index | 聊天审批卡 → 不可审批；contract test |
| `bodyActorRejected` | requested_by/decided_by 从 auth 派生 | approval-index | body actor → 422 |
| `effectProof` | `effect_ref` owner receipt | effect owner | 无 proof 不 succeeded；伪造 → 拒绝 |
| `staleDecision` | expires_at < now && open | approval-index | decide → 409 `approval_stale`；不自动 reject |
| `payloadBounds` | summary/impact/action/detail 上限 | approval-index | 超限 422；不存 secrets |

#### observability

| 变量/事件 | 值/来源 | owner | 说明 |
|---|---|---|---|
| `approval_requested` | audit；id/kind/origin/card/requester | approval-index | request 同事务 |
| `approval_decided` | audit；id/resolution/decided_by/note | approval-index | decide 同事务 |
| `approval_materialization_started` | audit；id/attempt_ref | effect owner | claim |
| `approval_materialization_succeeded` | audit；id/effect_ref | effect owner | 必须 owner receipt |
| `approval_materialization_failed` | audit；id/failure_ref/retryable | effect owner | 失败 |
| `approval_stale_total` | counter | approval-index | open 过期数 |
| `approval_accepted_not_materialized_total` | counter | approval-index | accepted+not_started/outcome_unknown |
| `approval_decision_latency_ms` | histogram | approval-index | request→decision |
| `approval_orphan_total` | health | approval-index | card/origin 缺失、succeeded 无 effect_ref |

### 3.6 明确不做

- 不做 5 个 per-producer canonical stores / query aggregation；`approvals` 是唯一 human-gate 表。
- 不做 chat approval rich block；只做 `approval_pointer`；审批项只来自 `approvals`。
- 不做 staged/anchored/tombstoned publication 状态；同库单事务。
- 不做 legacy `legacy_unanchored` backfill / writer epoch；greenfield 无历史。
- 不做 F128/F225/F231/F260/F266/F276/F292/F306/F321 的 producer 迁移；只保留 codeteam 5 个 gate。
- 不做 push/IM notification；提醒走 waits/audit，Hub 是 pull。
- 不做 agent decide/merge；agent 只能 request。
- 不做 accepted=succeeded；materialization 必须 owner proof。
- 不做 expiry 自动 reject；只 stale。
- 不做 F281 结构化 why / eval；v1 decided_note 自由文本。

## 4. 风险与回滚

| 风险 | 级别 | 处置 |
|---|---|---|
| accepted 被当成功，merge/design 假完成 | P1 | resolution/materialization 分离；succeeded 必须 `effect_ref`；Hub/CLI 分开展示 |
| 聊天卡伪造审批项 | P1 | `messages.rich_blocks_json` 不含 approval；只 `approval_pointer`；唯一数据源 `approvals` |
| agent/run token 越权 decide/merge | P1 | approval decide 只接受 operator credential；routine merge 只走 merge-owner capability；MCP 不暴露 decide/merge execution；403 测试 |
| expiry 自动 reject，错误关闭上下文 | P1 | expires 只 stale；decide 409；显式 close 才 closed_without_decision |
| body actor 冒充 operator/requester | P1 | requested_by/decided_by 从 auth 派生；body 字段拒绝 |
| materialization 伪造 owner proof | P1 | `effect_ref` 必须解析到 owner receipt；无 proof 不 succeeded |
| request 与 pointer/card 半写 | P1 | approvals + pointer + card_ref + audit 同事务；失败整体回滚 |
| 5 个 producer 无 owner/registry 漂移 | P2 | 静态 catalog + kind CHECK + runtime registry fail closed；unknown kind 422 |
| payload 过大/泄密 | P2 | payload 上限、summary/detail 白名单；不存 secrets |
| stale/closed 历史丢失 | P2 | 不删除；settled 保留；closed_without_decision 显式审计 |
| 未来迁移 clowder approvals 时 legacy 混入 | P3 | greenfield 不做；迁移另立 epoch/backfill，不混 v1 |

**回滚**：`approvals` 是 W1 表；回滚到 W1 基线即可。`messages.kind`/`thread_events.kind` 只加值；effect owner 表不变。不迁移 clowder 历史 approvals；不回滚已写 audit。

## 5. Review 与签字

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | W1 表/事务、producer catalog、materialization 状态机、CAS | accept；P2 completion 边界 + P2 idempotency 已回写 |
| 砚砚 | operator-only decide、double anchor、effect proof、fail-closed | accept-with-modify；P2 materialization principal + P3 批已回写 |
| 墨墨 | operator UX、Hub/CLI 投影、stale/history、pointer card | accept-with-modify；P1-1 effect 1:1 + P2 idempotency + P3 批已回写 |
| operator | A2-3 架构卡是否可签 | [x] 已签（2026-10-25） |

> Review request `c7e62ae7-2b1f-47cb-b6e7-8ad3c6427d48`（2026-10-25，三猫）。Review disposition：Kimi P2 completion → §1 边界（operator-direct，不进 catalog）；Kimi/Qwen P2 idempotency → §3.4.3#1；Qwen P1-1 effect receipt 1:1 → §3.3B/§3.4.3#1/#4；Glm P2 materialization principal → §3.2#4/§3.5；Glm/Qwen P3 batch → KD-21 论证/completion 注/decide retry/close principal/spec effect owner/abandon/budget requester/§3.5 与 plans；无 reviewer 要求 re-review。

> operator 于 2026-10-25 签字，A2-3 冻结为 W1/W4/W7 实现契约。

**Review 重点**

1. 单表 `approvals` 替代 5 个 producer store 是否成立；是否制造了第二审批真相。
2. `origin_ref` / `card_ref` / `effect_ref` 三锚是否完整；`card_ref` 指向 `approval_pointer` 是否满足“精确回溯”和“防伪造”。
3. `resolution` / `materialization` 分离是否真的能阻止 accepted 假完成；`effect_ref` owner receipt 是否足够。
4. `expires_at` stale 不自动 reject、stale decide 409、close 语义是否自洽。
5. operator-only decide / agent request-only / MCP 不暴露 decide/merge execution / merge-owner capability 是否覆盖越权面（`DP-MERGE-1=D`）。
6. §12.2 diff 与 plans/0002 W1、plans/0004 W7 挂点是否一致；有没有未排期的新范围。

**交卡前自检**

- [x] 组件图、数据流、状态机、存储/并发、失败恢复五段齐全。
- [x] 每个组件有 `reuse now` / `adapt now` / `drop` / `out-of-scope` / `defer` 立场。
- [x] 变量表覆盖 contract/state/config/security/observability 五层。
- [x] 所有代码锚点 grep 可达（交卡后跑锚点检查）。
- [x] 风险与回滚写清；安全变量写明失败语义。
- [x] §12.2 回写清单完整；W1/W4/W7 plan 挂点已核对。

[宪宪/deepseek-flash🐾]
