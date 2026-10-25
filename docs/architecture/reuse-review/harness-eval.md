---
title: "harness-eval 架构复用检视"
doc_kind: architecture-review
status: approved
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
review_request: "763821ad-edc7-4958-a733-5724c808443f"
review_result: "accept (烁烁) / accept-with-modify (砚砚/墨墨); no reject; P1/P2 written back 2026-10-25"
operator_signoff: "DP-HE-1=A, DP-HE-2=A, DP-HE-3=A (2026-10-25)"
source_cell: harness-eval
source_card: ../../reuse/harness-eval.md
template: ../0004-reuse-architecture-review-plan.md
---

# harness-eval 架构复用检视

## 1. 总结

| 项 | 结论 |
|---|---|
| clowder feature 范围 | F192（eval 控制面）、F266（verdict closure）、F267（measurement validity）、F278（paw-feel disposition）、F313（analysis-to-outcome closure）。F311 evolution control 不在本卡。 |
| codeteam 复用总结 | **R1 适配复用**。P0 只取 **verdict envelope + finding 不可变 + lifecycle append-only**；F266/F267/F278 治理机制按 **R2 借鉴**，W6 接代码域 metrics 时再逐条引用；F313 只借 finding/repair 形状，不做 repair control plane。 |
| codeteam W | W3（review verdict / finding / falsifier 语义）；W6（eval domain registry、verdict lifecycle、代码域 metrics）。 |
| 一句话 | **code review verdict 与 harness eval verdict 是两本账**；codeteam 复用 eval 的 envelope/lifecycle 语义，不搬 Eval Hub、Paw-Feel Inbox 或 F313 全量 repair 控制面。 |
| 明确不含 | F311 capability evolution；F278 live duty/inbox（v1）；F266 approval-gated repair（v1）；F267 全量 birth-certificate issuer（v1）；Eval Hub UI（W6）；第二套 review verdict 账本；第二套 evidence store；dashboard-only eval；自动 fix/merge/suppress。 |

**组件立场**

| 组件 | 立场 | codeteam 处理 |
|---|---|---|
| `VerdictHandoffPacket` | `reuse now` | 12 字段 envelope 原样复用；evidence packet 四类 refs 非空；`delete_sunset` publish 必须声明 `cvoAcceptRequired=true`，执行前另需 operator accept |
| `LifecycleRootArtifact` | `reuse now` | v1/v2/v3 schema 复用；`caseId = sha256(domainId + findingKey)`；作为 immutable artifact 存储 |
| `EvalDomainRegistryEntry` | `adapt now` | YAML registry 复用；codeteam domain 清单、system thread、eval agent、SLA、source adapter 重新绑定 |
| `EvalCatInvocationPacket`（clowder 名）→ `EvalAgentInvocationPacket`（codeteam） | `adapt now` | 复用 invocation 形状；codeteam 的 eval agent / thread / publish guidance 重新接线 |
| `EvalLifecycleEvent` | `adapt now` | 复用 event 类型与状态语义；v1 只启用 W6 需要的 transition，未知/unwired fail closed |
| `projectReevalClosure` | `adapt now` | 复用 append-only projection；codeteam 的 case root/refs 重新绑定 |
| `MeasurementBundleResult` | `borrow` | W6 只存 minimal result（n/point/interval/status）；全量 certificate/issuer 留 R2 |
| `MeasurementBundleCertificate` | `defer→W6+` | 不在 P0；代码域 metrics 先走 minimal result，完整 birth certificate 后置 |
| `PawFeelDisposition*` | `borrow` | 只借 raw signal 与 verdict identity 分离；v1 不做 duty/inbox |
| `EvalRepairCaseAction` / `CanonicalRepairDispatch*` | `borrow` | 只借 finding/repair 形状；v1 不做 F246 审批派工 |
| `publish-verdict` generator / GitPublisher | `adapt now` | eval agent 不 direct git；codeteam 写 immutable artifacts + lifecycle events；Git PR 可选 |
| `Eval Hub` | `defer→W7` | W6 只落契约与只读 projection；W7 再做 operator surface |
| `TaskOutcomeEpisode` | `adapt now` | 复用 F275/F192 的 outcome/attribution 形状，作为 W6 代码域指标输入 |
| F311 evolution program | `drop` | codeteam 不做 evolution program 产品面 |

## 2. clowder 架构

### 2.1 架构图

```text
domain truth source（F153/F200/F275/...）
        │
        ▼
eval domain registry（docs/harness-feedback/eval-domains/*.yaml）
  ├─ systemThreadId / evalAgent / frequency / triggerPolicy
  ├─ sourceAdapter / sourceRefsKind
  └─ handoffTargetResolver / SLA / enabled / dormancy
        │
        ▼
eval agent invocation（instructions + trend/verdict refs + legacy cleanup）
        │
        ▼
VerdictHandoffPacket（12-field envelope + evidencePacket）
        │
        ▼
publish-verdict（schema/sourceRefs/generator adapter/GitPublisher）
        │
        ├─ verdict.md + snapshot/attribution/provenance
        └─ lifecycle-root.json（v1/v2/v3; caseId）
        │
        ▼
F266 closure event log（open → acknowledged → action_planned → fix_landed
  → main_landed → live_active → monitoring → reeval_pending → resolved
  + suppressed_with_reason / escalated）
        │
        ├─ Eval Hub / Workspace projection（read-only）
        ├─ owner response / action refs / re-eval refs
        └─ re-eval → pass/fail → closure or continue
```

### 2.2 数据流

1. **Signal capture**：业务域先把 ground truth/proxy signal 落到自己的真相源；F192 只消费，不拥有 canonical trace schema。
2. **Registry/schedule**：registry YAML 定义 domain、system thread、eval agent、frequency、trigger policy、source adapter、SLA；scheduler/manual trigger 只认 registry。
3. **Invocation**：按 domain 唤醒 eval agent，注入 domain instructions、publish guidance、selector 形状与 closure 语义；eval agent 产出 `VerdictHandoffPacket`。
4. **Publish**：MCP/route schema 校验 packet + sourceRefs；publish pipeline 在隔离 worktree 写 verdict/bundle；eval agent 不直接 `git add/commit/push`。
5. **Root/lifecycle**：`lifecycle-root.json` 固化 verdict identity、domain、harness、ownerAsk、re-eval plan；F266 以 append-only event log 承载 owner response / action / re-eval / closure。
6. **Owner response**：owner 接单、计划、修复/不修；每条转换带 immutable refs、actor、occurredAt、reason；聊天与 finding store 不是 canonical。
7. **Re-eval**：`nextEvalAt` 到期创建真实 re-evaluation task/lease；后续 eval pass/fail 关闭或延续当前 cycle。
8. **Projection**：Eval Hub/Workspace 只读 canonical lifecycle；不另造 Eval Hub store，不用聊天声明自闭环。

### 2.3 状态机 / 生命周期

F266 的 canonical lifecycle（`reeval-closure-schema.ts:26-40`）：

```text
verdict_opened → open
owner_acknowledged → acknowledged
action_planned → action_planned
fix_recorded → fix_landed
main_landed → main_landed
live_active → live_active
reeval_requested → reeval_pending
reeval_passed → resolved
reeval_failed → action_planned（actionable） / open（monitoring）
cvo_suppressed → suppressed_with_reason（terminal）
sla_escalated → escalated（可恢复）
```

- `resolved` / `suppressed_with_reason` 是 terminal；`escalated` 可由迟到处置恢复。
- 每个 `reeval_requested` cycle 固化当轮 eval-agent authority；registry/override 只影响未来 cycle。
- `dueAt` 由服务端从 domain `reevalWithinHours` 派生，调用方不能自报截止期。
- `case_ready_for_proposal` / `approval_proposed` / `approval_decided` / `approval_materialized` 是 F266/F313 的 approval-gated repair 扩展；v1 codeteam 不启用。
- `projectReevalClosure` 对 history 做严格 identity/authority/transition 校验；非法转换 fail closed（`reeval-closure.ts:124`）。

### 2.4 关键数据结构

```ts
// packages/api/src/infrastructure/harness-eval/verdict-handoff.ts:17-103
// clowder wire shape; codeteam adapter maps ownerAsk.targetOwnerCatId -> targetOwnerProfileId.
interface VerdictHandoffPacket {
  id: string;
  domainId: `eval:${string}`;
  findingKey?: string;
  findingBinding?: FindingBindingV1;
  repairTarget?: ResolvedRepairTargetV1;
  createdAt: string;
  phenomenon: string;
  harnessUnderEval: { featureId: string; componentId: string; name: string };
  evidencePacket: {
    snapshotRefs: string[];
    attributionRefs: string[];
    metricRefs: string[];
    sampleTraceRefs: string[];
  };
  dailyTrend: {
    window: string;
    current: Record<string, number>;
    baseline: Record<string, number>;
    threshold: Record<string, number>;
    direction: 'improved' | 'regressed' | 'flat' | 'unknown';
  };
  rootCauseHypothesis: { summary: string; confidence: 'low' | 'medium' | 'high'; alternatives: string[] };
  verdict: 'delete_sunset' | 'build' | 'fix' | 'keep_observe';
  ownerAsk: { targetFeatureId: string; targetOwnerCatId: string; requestedAction: string };
  governance?: { cvoAcceptRequired: boolean };
  acceptanceReevalPlan: { nextEvalAt: string; closureCondition: string };
  counterarguments: string[];
}
```

```ts
// packages/api/src/infrastructure/harness-eval/publish-verdict/lifecycle-root-artifact.ts:66-82
type LifecycleRootArtifact =
  | { schemaVersion: 1; verdictId; domainId; createdAt; verdict; harnessUnderEval; ownerAsk; acceptanceReevalPlan }
  | { schemaVersion: 2; ...v1; caseId: `eval-case-v1-${sha256}`; findingKey: string }
  | { schemaVersion: 3; ...v2; findingBinding; repairTarget; supersedes?: {...} };
```

```ts
// packages/api/src/infrastructure/harness-eval/domain/eval-domain-registry.ts:89-200
interface EvalDomainRegistryEntry {
  domainId: `eval:${string}`;
  displayName: string;
  descriptionForHuman?: string;
  metricGlossary?: Record<string, MetricGlossaryEntry>;
  systemThreadId: string;
  evalCat: { catId: string; handle: string; model: string };
  frequency: 'daily' | 'weekly' | `every-${number}d`;
  triggerPolicy?: { mode: 'time_only'; maxDetectionDelayHours: number }
    | { mode: 'threshold_or_time'; cooldownHours: number; eventSource: string; threshold: {...} };
  sourceAdapter: string;
  sourceRefsKind: string;
  threadPolicy: { role: 'working-home'; stateSot: 'registry'; allowedContent: [...] };
  legacyScheduledTaskIds: string[];
  handoffTargetResolver: { featureId: `F${number}`; ownerCatId: string; threadLookup: 'feature-thread' };
  sla: { acknowledgeHours: number; reevalWithinHours: number };
  fixtures: Array<{ id: string; featureId: `F${number}`; path: string; skill?: string; signal?: string }>;
  enabled: boolean;
  dormancy?: { reason: string; revivalPath: string; decisionRef: string };
}
```

> 上面是 clowder 源形状（`evalCat`/`ownerCatId` 是 clowder wire 字段）。codeteam adapter 映射：`evalCat → evalAgent`、`ownerCatId → ownerProfileId`；codeteam 内部 API/DB 不使用 `catId`。

```ts
// codeteam mapping（不新增 registry 文件格式）
interface CodeteamEvalDomainRegistryEntry
  extends Omit<EvalDomainRegistryEntry, 'evalCat' | 'handoffTargetResolver'> {
  evalAgent: { profileId: string; role: 'eval'; handle: string; model: string };
  handoffTargetResolver: { featureId: `F${number}`; ownerProfileId: string; threadLookup: 'feature-thread' };
}
```

**Role / agent mapping（codeteam）**

- `cat` 是 clowder 概念，不是 codeteam 身份。codeteam 身份 = `AgentProfile`（稳定逻辑身份）+ `AgentSession`（执行身份）+ 动态 `roles`。
- `eval`、`compress` 等都是 **动态 role**，由 `roles` table 注册；不是代码 enum，也不要求每个 role 固定一只模型。今天加 `eval`，以后加 `compress`/`vision_guard` 等都不改核心代码。
- registry 的 `evalAgent` 指向一个 `role='eval'` 的 `AgentProfile`；registry 校验该 role/profile 存在且 enabled，缺失 fail closed。clowder `evalCat` 只是 adapter 边界的 wire 字段。
- `VerdictHandoffPacket.ownerAsk.targetOwnerCatId` 是 clowder wire 字段；codeteam 内部映射为 `targetOwnerProfileId`，生命周期 actor 用 `agent:<profileId>`。codeteam 公共 API/DB 不存 `catId`。
- `EvalCatInvocationPacket` 是 clowder 源类型；codeteam 映射为 `EvalAgentInvocationPacket`，字段用 `evalAgentProfileId`/`targetOwnerProfileId`。
- `assignedEvalCatId` 映射为 `assignedEvalAgentProfileId`；`AgentProfile` 可保留 `clowder_cat_id` 仅作 provenance，不参与授权/唯一性。

Measurement result minimal（F267 R2 borrow，`measurement-bundle-schema.ts:221-267`）：

```ts
interface MeasurementBundleResult {
  kind: 'f267-measurement-bundle-result';
  schemaVersion: 1;
  resultId: string;
  certificateId: string;
  certificateRef: string;
  bundleId: string;
  domainId: string;
  generatedAt: string;
  cohort: { ref: string; sha256: string; window: { startMs: number; endMs: number } };
  baseline?: { ref: string; sha256: string };
  decisionProcedureVersionSetHash: string;
  metrics: Array<{
    metricId: string;
    role: 'primary_loss' | 'guardrail';
    n: number;
    pointEstimate: number | null;
    evidenceStatus: 'sufficient' | 'insufficient';
    uncertainty: Interval | Power | NotEstimable;
  }>;
  decision:
    | { status: 'usable'; reasons: []; withdrawalConditions: [] }
    | { status: 'insufficient'; reasons: string[]; withdrawalConditions: string[] };
  actionProposal: { action: 'keep_observe' | 'fix' | 'build' | 'delete_sunset'; rationale: string; interventionCard?: InterventionCard };
}
```

### 2.5 Current truth 与代码路径

| # | 事实 | 代码锚点 |
|---|---|---|
| T1 | Verdict envelope 是 12 字段 strict schema；evidence 四类 refs 缺一不得 cross-thread handoff | `verdict-handoff.ts:17`、`:104`、`:126` |
| T2 | `delete_sunset` publish 必须带 `governance.cvoAcceptRequired=true`；这是**声明 gate**，不是“operator 已 accept 才能 publish” | `verdict-handoff.ts:67-74` |
| T3 | friction child packet 必须同时有 `findingKey`/`findingBinding`/`repairTarget`，且只在 `eval:friction` | `verdict-handoff.ts:76-102` |
| T4 | `lifecycle-root.json` 有 v1/v2/v3；v3 带 `findingBinding`/`repairTarget`/`supersedes` | `lifecycle-root-artifact.ts:9`、`:66-82` |
| T5 | `caseId = eval-case-v1-<sha256(domainId + findingKey)>` | `lifecycle-root-artifact.ts:84` |
| T6 | registry 是 Y-lite：domainId 语法、trigger policy、SLA、enabled/dormancy 都由 schema 校验 | `eval-domain-registry.ts:3`、`:89-200` |
| T7 | clowder invocation packet 带 domain/thread/evalCat/instructions/context；codeteam 映射为 `EvalAgentInvocationPacket`（`evalAgentProfileId`）；缺失 instructions fail closed | `eval-cat-invocation.ts:21`、`:318` |
| T8 | lifecycle status enum 11 态；event union 含 open/ack/action/fix/main/live/monitor/reeval/closure/suppression/escalation | `reeval-closure-schema.ts:26-40`、`:53-249` |
| T9 | projection 严格校验 identity/authority/transition；非法 history fail closed | `reeval-closure.ts:124` |
| T10 | F266 case action / canonical dispatch / stale/blocked outcome 是 F313 repair 的接缝 | `eval-repair-approval-contracts.ts:32`、`:64`、`:83` |
| T11 | F267 certificate/result 分离；result 的 `decision=insufficient` 必须带 reasons + withdrawalConditions | `measurement-bundle-schema.ts:57`、`:221` |
| T12 | F278 的 signal/disposition 是 append-only event log；`routed` 不等于 business exit | `paw-feel-disposition/schema.ts:108`；F278 doc §90/§190 |
| T13 | F192 的 Eval Hub/closure 只是 projection；canonical 是 bundle + lifecycle event | F192 doc §21-75、§165-247 |
| T14 | F313 Phase D/E 仍有 open AC；不能把分析完成当 closure | F313 doc §214-290、§430-523 |

### 2.5.1 上游已知缺口 → 本卡处置

| 上游缺口 | 影响 | 本卡处置 |
|---|---|---|
| F266 legacy v1 roots / v1 epoch 未激活 | 不能直接照搬 production repair path | v1 只做 lifecycle append-only；approval-gated repair 留 R2 |
| F267 task-outcome `blocked_f275`（AC-C5..C8 open） | task-level success/latency 不能当已证明 | W6 只用 event/thread-level 或 managed-work 已绑定数据；不宣称 task-level 结论 |
| F267 全量 certificate/issuer 未迁移完 | 不能把每份 result 都当 usable | v1 只存 minimal result；`insufficient` 必须显式；全量证书留 W6+ |
| F278 duty/inbox 是 live product surface | 直接搬会引入新 operator 面 | v1 只借 signal/verdict identity 分离；不做 inbox |
| F313 Phase D/E open | 不能搬 repair control plane | v1 只借 finding/repair 形状；不做 F246 派工 |
| F192 Eval Hub 是 Clowder Console 面 | codeteam W6 没有 Console | W6 只落契约/只读 projection；W7 再做 surface |

## 3. codeteam 架构

### 3.1 架构图

```text
W3 code review（不混 eval verdict）
  diff + test report → ReviewVerdict（reviews）
    → Finding[]（findings, immutable）
    → Verification[]（verifications, append-only）

W6 harness eval（独立账本）
  codeteam/evals/domains/*.yaml（EvalDomainRegistryEntry）
    → EvalAgentInvocationPacket（clowder `EvalCatInvocationPacket` 的 codeteam 映射）
    → eval agent → VerdictHandoffPacket
    → artifacts:
        eval-verdict
        eval-lifecycle-root
        eval-finding
        eval-snapshot / eval-attribution
    → eval_lifecycle_events（append-only canonical case log）
    → evals（code-domain metrics + minimal measurement result）
    → W7 read-only projection（defer）
```

### 3.2 数据流

**W3 review flow**

1. coder 提交 diff + test report；ReviewPolicy 选择非作者 reviewer。
2. reviewer 产 `ReviewVerdict`（`reviews.verdict`）与 `findings`；finding 带 `evidenceKind`/`falsifier`/`falsifierExpected`/`requiredAction`。
3. verifier 执行 falsifier，写 `verifications`；finding 关闭只由证据决定。
4. `reviews`/`findings`/`verifications` 是 code review 的唯一真相；**不写 eval_lifecycle_events**。

**W6 eval flow**

1. runtime 读 `CODETEAM_EVAL_DOMAINS_DIR/*.yaml`，校验 registry；未知 domain/invalid trigger fail closed。
2. 按 frequency/triggerPolicy 生成 `EvalAgentInvocationPacket`；无 instructions/publish wiring 时不假装可跑。
3. eval agent 读趋势/verdict refs，产 `VerdictHandoffPacket`；evidencePacket 四类 refs 非空，`delete_sunset` 带 `cvoAcceptRequired=true` 声明（publish gate）；执行前另需 operator accept（execution gate）。
4. publish 只写 immutable artifacts：`eval-verdict`、`eval-lifecycle-root`、`eval-finding`、`eval-snapshot`、`eval-attribution`；eval agent 不直接 git write。
5. `eval_lifecycle_events` 以 `caseId` 为聚合键追加 `verdict_opened` 等事件；projection 只读派生 status/refs/due。
6. lifecycle 写权限按 §3.5 Security 的 `lifecycleWriteMatrix`：owner/target profile、fix run、operator、automation 各写自己的 transition；run token 只能写绑定到该 case work 的 `fix_recorded`，不能写 `cvo_suppressed`/`reeval_passed`/任意 case。
7. `reeval_requested` 由服务端按 domain SLA 派生 dueAt；到期创建 re-evaluation task（W6/W7 接 F167/waits）；后续 eval pass/fail 写 `reeval_passed`/`reeval_failed`。
8. `evals` 存 code-domain metrics（review FP/recall/survival、time-to-green、human intervention、cost per merged change）与 minimal measurement result；W7 只读投影。

**边界**

- code review verdict ≠ eval verdict：`reviews` 是内部 ReviewPolicy；`eval_lifecycle_events` 是 harness eval case。
- eval finding ≠ review finding：review finding 在 `findings`；eval finding 是 `artifacts.kind='eval-finding'`。
- eval verdict ≠ merge/approval：eval 不自动 fix/merge/suppress；需要动作时只产出 ownerAsk/repair refs。
- F278/F313 的 repair control plane 不在 v1；只保留 refs 形状，未来可接。

### 3.3 状态机 / 生命周期

codeteam v1 启用 F266 状态 enum 的**受控子集**；未知/unwired transition fail closed：

```text
verdict_opened → open
owner_acknowledged → acknowledged
action_planned → action_planned
fix_recorded → fix_landed
main_landed → main_landed
reeval_requested → reeval_pending
reeval_passed → resolved
reeval_failed → action_planned（actionable）
cvo_suppressed → suppressed_with_reason（operator only）
sla_escalated → escalated（可恢复）
```

- `live_active` / `monitoring` 是 W7/ops-gated；W6 不启用时 fail closed，不静默跳过。
- `resolved`/`suppressed_with_reason` 是 terminal；`escalated` 可由迟到处置恢复。
- 每条 event 带 `caseId`、`domainId`、`actor`、`occurredAt`、refs；`caseId` 从 `domainId+findingKey` 派生，不接受调用方自造。
- `reeval_requested.dueAt` 由服务端按 registry SLA 派生；调用方不能自报截止期。
- `fix_recorded` 只表示 owner 记录修复；`main_landed`/`live_active` 必须有 full commit SHA；不能拿聊天或 merge 单独当 closure。
- `delete_sunset` publish 不要求 operator 已 accept；case 在 operator accept 前停在 `open(awaiting-sunset-decision)` 可见态，任何 sunset 执行都必须有 operator accept；没有 accept 不得静默执行或删除 harness。
- `escalated` 的恢复键是授权 owner 的 `owner_acknowledged` / `action_planned`；恢复后回到对应 active 状态，不能靠聊天或投递回执。
- `eval_lifecycle_events` 的 projection 必须在读面严格重放校验 transition/authority；append-only 只保证“不改”，不保证“非法历史可读”；非法 history fail closed，不静默修复。
- 同 `(domainId, findingKey)` 再次 publish = 同一 case 追加 re-eval 周期，不得开新 case；`supersedes` 只用于 target/owner/authorization drift 或 fresh cycle，不用于普通重报。

### 3.4 关键数据结构（与 clowder 对比）

**新增表：`eval_lifecycle_events`（append-only canonical case log）**

```sql
eval_lifecycle_events(
  case_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  domain_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent','operator','system','migration')),
  actor_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (case_id, seq)
);
CREATE INDEX idx_eval_lifecycle_domain_due ON eval_lifecycle_events(domain_id, occurred_at);
-- BEFORE UPDATE/DELETE trigger -> RAISE(ABORT)
```

`actor_id` 统一带前缀：`agent:<profileId>` / `operator:<id>` / `system:<service>` / `migration:<source>`。clowder actor 映射：`cat→agent`、`cvo→operator`、`automation→system`、`migration` 同名；codeteam event schema 不保留 `cat/cvo/automation` 词。`event_type` 的 DB CHECK 镜像 `EvalLifecycleEventSchema`；迁移时由 codegen 生成，不能只靠 app 层。`seq` 分配在 `BEGIN IMMEDIATE` 内做 per-case `MAX(seq)+1`；PK(case_id,seq) 是安全带，写锁是前提。v1 lifecycle case 要求 `findingKey`；没有 `findingKey` 的 verdict 只做 `eval-verdict` artifact，不进入 case lifecycle。

**扩展 `evals`（不新建 eval_verdicts/eval_cases/eval_findings）**

```sql
ALTER TABLE evals ADD COLUMN domain_id TEXT;
ALTER TABLE evals ADD COLUMN bundle_id TEXT;
ALTER TABLE evals ADD COLUMN verdict_id TEXT;
ALTER TABLE evals ADD COLUMN window_start_ms INTEGER;
ALTER TABLE evals ADD COLUMN window_end_ms INTEGER;
ALTER TABLE evals ADD COLUMN measurement_ref TEXT;
ALTER TABLE evals ADD COLUMN status TEXT CHECK (status IN ('ok','insufficient','no_data','degraded'));
ALTER TABLE evals ADD COLUMN reasons_json TEXT;
-- domain-level eval: task_id nullable; task-level rows keep task_id
CREATE INDEX idx_evals_domain_window ON evals(domain_id, window_start_ms, window_end_ms);
```

**`artifacts.kind` 新增值（不改表）**

- `eval-verdict`：`VerdictHandoffPacket` JSON。
- `eval-lifecycle-root`：`lifecycle-root.json`。
- `eval-finding`：F313/F245 finding artifact。
- `eval-snapshot` / `eval-attribution`：evidence refs（不复制 raw trace）。
- `eval-measurement-certificate` / `eval-measurement-result`：F267 R2 证据（W6+）。

**不变**

- `reviews` / `findings` / `verifications` 保持 code review 真相；不写 eval case。
- `merges` 保持 merge receipt；eval 不自动写 merge。
- `audit` 仍是一般 mutation audit；eval lifecycle 的 canonical event 在 `eval_lifecycle_events`。

**v1-minimal MeasurementBundleResult（F267 borrow 裁剪）**

v1 不签发完整 certificate，不能照抄 clowder `MeasurementBundleResult` 的必填 `certificateId`/`certificateRef`/`decisionProcedureVersionSetHash`。W6 使用明确的 minimal 变体：

| 字段 | v1 处理 |
|---|---|
| `kind` / `schemaVersion` / `resultId` / `bundleId` / `domainId` / `generatedAt` | 保留 |
| `cohort` / `metrics` / `decision` / `actionProposal` | 保留 |
| `baseline` | 可选；缺失表示 owner 声明无 baseline |
| `certificateId` / `certificateRef` | **移除**；v1 不签发 certificate |
| `decisionProcedureVersionSetHash` | **移除**；v1 不承诺 judge/rubric 版本集 |

W6 若未来要签发完整 certificate，新增 `schemaVersion` 而不是把 null 塞进必填字段。

**三套状态词映射（投影层，不互相替代）**

| `evals.status` | measurement `decision.status` | metric `evidenceStatus` | 含义 |
|---|---|---|---|
| `ok` | `usable` | `sufficient` | 证据足以支持 action |
| `insufficient` | `insufficient` | `insufficient` | 有数据但判定力不足 |
| `no_data` | `insufficient`（not_estimable/no_data） | 无 metric 或 `insufficient` | 没有 eligible 数据/窗口；必须带 reasons |
| `degraded` | `insufficient`（coverage/degraded） | `insufficient` | 来源覆盖不全；不得当 healthy |

**§12.2 diff 回写清单**

| 变更 | 原因 | 迁移口径 |
|---|---|---|
| 新增 `eval_lifecycle_events` | F266 canonical lifecycle；append-only | W6 additive；空表；无历史迁移 |
| `evals.task_id` 允许 NULL（domain-level rows） | W6 需要 domain-level metrics，不能伪造 task | SQLite table rebuild；旧行不变；task-level 查询不受影响 |
| `evals` 加 `domain_id/bundle_id/verdict_id/window_start_ms/window_end_ms/measurement_ref/status/reasons_json` | 代码域 eval metrics + minimal measurement result | additive；旧行 null；Task-level 查询不变 |
| `artifacts.kind` 加 eval-* 值 | immutable verdict/finding/measurement 证据 | 只加值，不改表 |
| 不新增 `eval_verdicts`/`eval_cases`/`eval_findings` | 避免第二套 verdict/case/finding 账本 | 用 artifacts + eval_lifecycle_events + evals 投影 |

### 3.5 变量定义表

**Contract**

| 变量 | 类型 | 来源 | owner | 决定 |
|---|---|---|---|---|
| `VerdictHandoffPacket` | zod schema | `verdict-handoff.ts:17` | harness-eval | `reuse now`；12 字段 strict；evidence 四 refs 非空 |
| `LifecycleRootArtifact` | discriminated union v1/v2/v3 | `lifecycle-root-artifact.ts:66` | harness-eval | `reuse now`；caseId 由 domainId+findingKey 派生 |
| `EvalDomainRegistryEntry` | YAML schema | `eval-domain-registry.ts:89` | harness-eval | `adapt now`；codeteam domain 路径/thread/`evalAgent` 重新绑定 |
| `EvalLifecycleEvent` | discriminated union | `reeval-closure-schema.ts:53` | harness-eval | `adapt now`；v1 只启用受控 status 子集 |
| `MeasurementBundleResult` | zod schema | `measurement-bundle-schema.ts:221` | harness-eval | `borrow`；W6 minimal result，全量 certificate 后置 |
| `MeasurementBundleCertificate` | zod schema | `measurement-bundle-schema.ts:57` | harness-eval | `defer→W6+`；v1 不签发 full certificate |
| `EvalRepairCaseAction` | interface | `eval-repair-approval-contracts.ts:32` | harness-eval | `borrow`；v1 不接 F246 派工 |

**State**

| 变量 | 类型 | 默认 | owner | 决定 |
|---|---|---|---|---|
| `eval_lifecycle_events.case_id` | TEXT | — | harness-eval | `eval-case-v1-<sha256>`；不接受调用方自造 |
| `eval_lifecycle_events.seq` | INTEGER | 1..N | harness-eval | per-case 单调；PK(case_id,seq) |
| `eval_lifecycle_events.payload_json` | JSON | — | harness-eval | 只存 event payload/refs；raw trace 不进库 |
| `eval_lifecycle_events.actor_kind` | enum | `system` | harness-eval | `agent/operator/system/migration`；migration 必须带 `payload_json.sourceRef`，不能绕过 append-only |
| `evals.domain_id` | TEXT NULL | null | harness-eval | domain-level rows set；task-level rows may null |
| `evals.status` | enum NULL | null | harness-eval | `ok/insufficient/no_data/degraded`；NULL = legacy unknown，查询按 `no_data` 处理；insufficient/no_data 同事务写 `reasons_json` |
| `evals.measurement_ref` | TEXT NULL | null | harness-eval | 指向 `artifacts` 的 measurement result/certificate |
| `evals.reasons_json` | JSON NULL | null | harness-eval | `insufficient/no_data/degraded` 必填；记录 source/window/coverage reason |

**Config**

| 变量 | 默认 | owner | 决定 |
|---|---|---|---|
| `CODETEAM_EVAL_DOMAINS_DIR` | `codeteam/evals/domains` | harness-eval | repo-local YAML registry；missing dir = zero domains + health warning |
| `CODETEAM_EVAL_BUNDLES_DIR` | `${CODETEAM_DATA_DIR}/evals/bundles` | harness-eval | immutable bundle/evidence root；不进 control DB |
| `CODETEAM_EVAL_ENABLED` | `0` | harness-eval | W6 默认关；开启后 scheduler 才 pickup |
| `CODETEAM_EVAL_BUNDLE_MAX_BYTES` | 5 MiB | harness-eval | per-bundle cap；超限 fail closed |
| `CODETEAM_EVAL_SAMPLE_TRACE_LIMIT` | 20 | harness-eval | evidence refs 上限；不复制 raw trace |
| `CODETEAM_EVAL_ACK_HOURS_DEFAULT` | 24 | harness-eval | registry 未显式 SLA 时使用 |
| `CODETEAM_EVAL_REEVAL_HOURS_DEFAULT` | 72 | harness-eval | registry 未显式 SLA 时使用 |
| `CODETEAM_EVAL_RETENTION_DAYS` | 0 | harness-eval | 用户可见 verdict/lifecycle 默认 TTL=0；不得静默 GC |

**Security**

| 变量 | 类型 | 默认 | 决定 |
|---|---|---|---|
| `evalActor` | derived principal | auth | eval agent/owner/operator 从 callback/owner session 派生；不接受 body 自报 |
| `operatorSuppress` | capability | operator-only | `cvo_suppressed` 只能 operator credential；run token/agent-key 403 |
| `deleteSunsetPublishDeclaration` | invariant | required | `delete_sunset` packet 必须 `governance.cvoAcceptRequired=true`；缺声明 publish 失败 |
| `deleteSunsetExecutionAccept` | invariant | operator-only | 任何 sunset 执行前必须 operator accept；无 accept 时 case 停在 `open(awaiting-sunset-decision)` 可见态，不静默执行 |
| `evalBundlePath` | path allowlist | `${CODETEAM_EVAL_BUNDLES_DIR}` | 只允许该目录内 regular file；拒绝 `..`/symlink |
| `evalEvidenceRedaction` | invariant | true | snapshot/attribution 只存 refs/digests；raw prompt/tool payload/secret 不进 bundle |
| `evalGeneratedTextRedaction` | invariant | true | `phenomenon`/`rootCauseHypothesis.summary`/`counterarguments`/`ownerAsk.requestedAction` 等 agent 生成自由文本过内容级 secret 扫描；命中 → redact 占位或 fail+requeue；与 memory 卡共享 redaction util |
| `evalSelfApproval` | deny | true | eval agent 不能签自己的 terminal disposition/closure；非作者/独立 signer |

**Lifecycle 写权限矩阵**

| transition | 允许 actor | 约束 / 失败语义 |
|---|---|---|
| `verdict_opened` | `system:publish-pipeline` | 只能由 publish pipeline 写；调用方不能自报 |
| `owner_acknowledged` / `action_planned` | finding targetOwner profile（`agent:<profileId>`）或 operator | owner 必须来自 registry `handoffTargetResolver`；非授权 403 + audit |
| `fix_recorded` | 实现该 fix 的 run（`agent:<profileId>`，run token 绑 case work）或 operator | run token 必须绑同一 case/work；任意 run token 403 |
| `main_landed` | merge service / daemon（`system:merge-owner`）或 operator | 必须 full commit SHA；不能拿聊天/merge 单独当 closure |
| `reeval_requested` | `system:sla-reconciler` | dueAt 由服务端派生；调用方不能自报 |
| `reeval_passed` / `reeval_failed` | assigned eval agent（`agent:<profileId>`）或 `system:eval-pipeline` | 必须带 `assignedEvalAgentProfileId`/证据 ref；不能由目标 owner 自签 |
| `cvo_suppressed` | operator only | run token/agent-key 403；必须带 reason |
| `sla_escalated` | `system:sla-reconciler` | 同一 due item 幂等；不重复 escalation |
| `owner_reassigned` | operator only | 保留原 lifecycle history；不能改写旧 owner |
| `migration` | `migration:<source>` | 必须带 `payload_json.sourceRef`（bundle/snapshot）；只用于显式 backfill，不能绕过 append-only |

**Observability**

| 变量 | 类型 | 默认 | owner | 说明 |
|---|---|---|---|---|
| `eval_verdicts_total` | counter | — | harness-eval | by domain/verdict |
| `eval_lifecycle_transitions_total` | counter | — | harness-eval | by event_type/status |
| `eval_reeval_due_total` | gauge | — | harness-eval | open reeval_pending |
| `eval_reeval_overdue_total` | gauge | — | harness-eval | dueAt < now |
| `eval_findings_total` | counter | — | harness-eval | findingKey/analysisDisposition |
| `eval_measurement_insufficient_total` | counter | — | harness-eval | result.status=insufficient |
| `eval_bundle_publish_failed_total` | counter | — | harness-eval | schema/path/redaction failure |

### 3.6 明确不做

- 不做 F311 evolution program / capability evolution control。
- 不做 F278 live duty/inbox / Paw-Feel Disposition surface（v1）。
- 不做 F266 approval-gated repair / F246 派工（v1）；只留 refs 形状。
- 不做 F267 full birth-certificate issuer / measurement publication pipeline（v1）。
- 不做 Eval Hub UI / Console dashboard（W6）；W7 只读 projection。
- 不建第二套 review verdict 账本；`reviews` 仍是 code review 唯一真相。
- 不建第二套 evidence store；verdict/finding/measurement 都走 `artifacts`。
- 不用 `audit` 冒充 eval canonical lifecycle；`audit` 只做一般 mutation audit。
- 不自动 fix/merge/suppress；eval 只产出 ownerAsk/refs。
- 不把 `insufficient`/`no_data` 当 healthy；不把聊天声明当 closure。

### 3.7 W6 operator read surface（headless M0）

- **publish 同事务写人读 verdict 消息**：向 registry `systemThreadId` 写消息（ownerAsk / SLA / counterarguments / re-eval plan / artifact digest refs）；消息是投影，不是真相；消息编辑不改 case 状态。消息写失败 = publish 失败并重试，不能 store-only。
- **消息头必须和 verdict 同权重显示 measurement status**：`insufficient`/`no_data`/`degraded` 的 reasons 置顶；禁止只显示 `verdict=fix` 而把“证据不足”藏在 artifact。
- **无 `findingKey` 的 verdict**：消息头明确标“observation report · no finding tracking”；ownerAsk 只作 advisory，不计 SLA/case；若要求 owner 行动，publish 必须提供 `findingKey`，否则 fail closed。
- **CLI 最小读面**：`codeteam eval list` / `open` / `overdue` / `show <verdictId>`，全部从 `eval_lifecycle_events` + `evals` 派生；`escalated` 必须出现在 `overdue` 同屏。W7 projection 落地后 CLI 保留。
- **operator accept 面**：`codeteam eval accept-sunset <verdictId>`（operator credential）写 operator accept event；accept 前 case 保持 `open(awaiting-sunset-decision)` 可见态，任何 sunset 执行都不得发生。

### 3.8 Skill 真相源边界

| skill | 真相源 | 禁止 |
|---|---|---|
| `eval-design` | registry `metricGlossary` 是指标口径唯一真源；skill 教“怎么设计/校准” | 不教把自写 glossary 塞进 verdict；不复制第二套指标表 |
| `self-evolution` | lessons/decisions 走 file 源（memory 卡冻结口径） | 不为“沉淀”写 eval 账本；verdict 不是 lesson |
| `code-as-harness` | v1 friction 信号经 eval domain 注册或 agent 判定进入 | v1 不依赖 F278 inbox（未迁）；不把未迁移的 Paw-Feel 当运行时前提 |

## 4. 风险与回滚

| 风险 | 级别 | 处置 |
|---|---|---|
| code review verdict 与 eval verdict 混账 | P1 | `reviews`/`findings` 与 `eval_lifecycle_events` 分离；跨写测试 |
| eval 做成 dashboard，verdict 无 owner ask / re-eval plan | P1 | envelope 强制 ownerAsk/acceptanceReevalPlan；lifecycle open 直到 re-eval |
| caller-authored evidence / 空 replay window 产生 healthy verdict | P1 | evidencePacket 四类 refs 非空；`insufficient`/`no_data` 显式；不把沉默当 green |
| `delete_sunset` 声明缺失 / 执行未 accept | P1 | publish 校验 `cvoAcceptRequired=true`；执行前 operator accept；无 accept 保持可见 open 态，不静默执行 |
| eval agent 自签 terminal/closure | P1 | actor 派生 + 非作者 signer + operator suppress |
| 第二套 verdict/case/finding 表造成 split-brain | P1 | 只用 artifacts + eval_lifecycle_events + evals；不建 eval_verdicts/eval_cases/eval_findings |
| raw trace / secret 进 bundle/prompt | P1 | refs/digests only；path allowlist；redaction；bundle cap |
| eval agent 生成文本泄露 secret | P1 | 自由文本字段内容级 secret 扫描；命中 redact/fail+requeue；共享 memory redaction util |
| F266/F267/F278 全量机制提前搬入 | P2 | P0 只 envelope/finding/lifecycle；治理 R2 borrow；W6+ 再逐条引用 |
| eval 调度双触发 / legacy task 重复 | P2 | registry `legacyScheduledTaskIds` + enabled/dormancy；W6 不接旧任务 |
| 生命周期无限增长 | P2 | TTL=0 是默认；保留 audit/raw artifacts；W7 只读 projection；不做 silent GC |

**回滚**

- 关闭 `CODETEAM_EVAL_ENABLED`，停 scheduler；已写 artifacts/events 保留。
- `eval_lifecycle_events` 是 W6 additive 表；回滚到 W6 基线即可，不影响 `reviews`/`findings`/`merges`。
- `evals` 扩展列 additive；旧查询忽略 null。
- artifacts 只加 kind；不迁移 clowder 历史 bundle。

## 5. Review 与签字

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | W3 review/finding 语义、W6 DDL/state machine、eval_lifecycle_events 事务/索引 | accept；P2 actor_kind rename + 4×P3 已回写 |
| 砚砚 | measurement validity、insufficient/fail-closed、auth/operator suppress、bundle redaction | accept-with-modify；P2 lifecycle 写权限矩阵 + P2 生成文本 redaction + 4×P3 已回写 |
| 墨墨 | operator 可读 verdict/finding/closure、W7 projection、eval-design/self-evolution skill 边界 | accept-with-modify；P2 W6 读面 + P2 delete_sunset gate 两层化 + 4×P3 已回写 |
| operator | v1 scope / storage / W3-W6 boundary | [x] 已签 `DP-HE-1/2/3=A/A/A`（2026-10-25） |

**Review 结果**

- 三猫均同意 **A/A/A** 取舍；无 reject。
- 已回写：`actor_kind` 改 `agent/operator/system/migration`；`seq` 用 `BEGIN IMMEDIATE`；读面 transition 校验；`evals.status` NULL 语义；caseId 重报续案；F267 v1-minimal result 字段子集；三状态词映射；migration backfill 锚；`insufficient/no_data` reasons 进 `evals.reasons_json`；lifecycle 写权限矩阵；生成文本 secret 扫描；W6 thread 消息 + CLI 读面；`delete_sunset` publish 声明 vs 执行 accept 两层化；skill 真相源边界；escalated 恢复键。

**Review 重点**

1. `reviews`/`findings` 与 eval verdict 分账是否成立；有没有把 code review 变成第二套 eval。
2. `eval_lifecycle_events` 是否真的是 F266 canonical record，而不是 generic audit 的复制；append-only/transition guard 是否足够。
3. `evals` 扩展 vs 新 `eval_verdicts`/`eval_cases`/`eval_findings` 表；哪个更少 total state。
4. F266/F267/F278 R2 borrow 的边界是否清楚；v1 是否可能误把 `insufficient`/`no_data` 当 healthy。
5. `CODETEAM_EVAL_*` 默认值、bundle cap、TTL=0、operator suppress 是否 fail closed。

**待拍板**

- `DP-HE-1`：v1 范围 = A（P0 envelope/finding/lifecycle） / B（加 F266 closure） / C（全量 eval 平台）。
- `DP-HE-2`：存储 = A（artifacts + eval_lifecycle_events + evals 扩展） / B（新 eval_verdicts/eval_cases/eval_findings 表） / C（仅 audit）。
- `DP-HE-3`：review/eval verdict = A（两本账） / B（统一一张表）。

[宪宪/deepseek-flash🐾]
