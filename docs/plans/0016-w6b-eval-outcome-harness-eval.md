---
title: "W6b Eval / Outcome / Harness Eval 实施计划与契约冻结"
doc_kind: plan
status: review
created: 2026-10-29
updated: 2026-10-29
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [墨墨 (Qwen 3.8 Flash), 砚砚 (GLM 5.3 Flash)]
source: "docs/plans/0004-w5-w8-scale-product.md §W6 6B/6F"
architecture_review: "docs/architecture/reuse-review/harness-eval.md"
operator_decision: "A — align W6b to the approved reuse review (2026-10-29)"
feature: F014
---

# W6b Eval / Outcome / Harness Eval

> 基线：`codeteam-work @ 49f9a140e`。W6a（F012 memory/evidence）与 W6c
> （F013 observability/trajectory）已 closed；本切片消费它们的冻结契约，但
> 不读写 memory.db、trace ring、tool-usage/log store。
>
> 2026-10-29 co-creator 选择 A：按 approved
> [`docs/architecture/reuse-review/harness-eval.md`](../architecture/reuse-review/harness-eval.md)
> 重构；本文件取代先前的窄契约版本。DP-HE-1/2/3=A/A/A 不变。

## 1. Goal

让 eval 能驱动 codeteam 的模型-角色选择，同时让 operator 看得见 verdict 的
责任闭环：

- 每个 terminal task 产出可回源的 outcome episode（落 `evals`，不建第二
  outcome store）。
- 多 provider / 多 repo 的 eval corpus 可生成代码域指标和模型-角色矩阵；
  synthetic fixture 与 live 数据严格分账，n<20 只作 smoke。
- harness-eval domain 由 YAML registry 声明；`evalAgent` 解析到
  `role='eval'` active `AgentProfile`，`handoffTargetResolver` 解析 active
  owner profile，缺失/禁用 fail closed。
- verdict 走 approved 12-field `VerdictHandoffPacketV1`；
  finding/verdict/measurement/lifecycle-root 作为现有 `artifacts` 表的
  immutable `eval-*` artifacts。
- `eval_lifecycle_events` 是 append-only canonical case log；review
  `reviews/findings/verifications` 与 eval lifecycle 两本账互不写入。
- publish 同事务写 domain system thread 人读 verdict 消息；CLI 从 events
  派生 `list/open/overdue/show`，`accept-sunset` 与 `cvo_suppressed`
  operator-only，`delete_sunset` 未 accept 不执行。

## 2. Scope

| 切片 | 内容 | 边界 |
|---|---|---|
| **W6b-A** | task outcome episode：从 canonical `tasks/runs/reviews/findings/verifications/merges/budgets/messages/artifacts` 派生，落 `evals` | 不复制 review 账本；只存 episode 投影与 source refs |
| **W6b-B** | eval corpus + 代码域指标 + 模型-角色矩阵；synthetic/live 分账，n<20 smoke | 不做 dashboard、不做自动模型路由 |
| **W6b-C** | `evals/domains/*.yaml` registry + eval agent/owner/thread 解析 + `CODETEAM_EVAL_*` config | 不做调度器；W5 scheduler 不接 |
| **W6b-D** | 12-field `VerdictHandoffPacketV1`、minimal measurement result、`artifacts` 表 eval-* 证据、`eval_lifecycle_events` | 不建 eval_verdicts/eval_cases/eval_findings；不建第二 artifact index |
| **W6b-E** | `evals` 扩展、publish 同事务 verdict 消息、CLI、same-case re-eval cycle | 不做 W7 HTTP/Console、Eval Hub UI、Paw-Feel、F246 repair |
| **W6b-F** | 测试：两本账、非法 lifecycle、secret 扫描、insufficient/no_data、无 findingKey、并发 seq、operator-only、same-case cycle | — |

## 3. Frozen contract v1

落点：`packages/codeteam-daemon/src/eval/contract.ts`。

### 3.1 Domain registry

文件：`evals/domains/*.yaml`（repo 根目录）。严格 YAML；未知字段 fail closed。

```ts
interface EvalDomainRegistryEntry {
  domainId: `eval:${string}`;
  displayName: string;
  descriptionForHuman?: string;
  metricGlossary?: Record<string, string>;
  systemThreadId: string;
  evalAgent: { profileId: string; role: "eval"; handle: string; model: string };
  frequency: "daily" | "weekly" | `every-${number}d`;
  triggerPolicy:
    | { mode: "time_only"; maxDetectionDelayHours: number }
    | { mode: "threshold_or_time"; cooldownHours: number; eventSource: string; threshold: Record<string, number> };
  sourceAdapter: "task_outcome" | "eval_corpus";
  sourceRefsKind: "task" | "review" | "merge" | "artifact" | "trajectory";
  handoffTargetResolver: { featureId: `F${number}`; ownerProfileId: string; threadLookup: "feature-thread" };
  sla: { acknowledgeHours: number; reevalWithinHours: number };
  fixtures?: Array<{ id: string; featureId: `F${number}`; path: string; skill?: string; signal?: string }>;
  legacyScheduledTaskIds?: string[];
  enabled: boolean;
  dormancy?: { reason: string; revivalPath: string; decisionRef: string };
}
```

- enabled domain 解析：`eval` role active、eval profile active/role eval/model
  匹配、owner profile active、system thread active；任一失败 fail closed。
- disabled domain 必须带 dormancy；不解析 placeholder identity。
- missing registry dir：strict loader fail closed；`loadEvalDomainRegistrySafe`
  返回零 domain + health warning（不 silent-fire）。
- config（`src/eval/config.ts`）：`CODETEAM_EVAL_DOMAINS_DIR`、
  `CODETEAM_EVAL_ENABLED=0`、`CODETEAM_EVAL_BUNDLE_MAX_BYTES=5MiB`、
  `CODETEAM_EVAL_SAMPLE_TRACE_LIMIT=20`、`CODETEAM_EVAL_ACK_HOURS_DEFAULT=24`、
  `CODETEAM_EVAL_REEVAL_HOURS_DEFAULT=72`、`CODETEAM_EVAL_RETENTION_DAYS=0`。
  W6b 不接 scheduler；`enabled` 只作为 registry/未来 scheduler gate。

### 3.2 Eval agent invocation

```ts
interface EvalAgentInvocationPacket {
  v: 1;
  invocationId: string;
  domainId: string;
  targetThreadId: string;
  evalAgentProfileId: string;          // clowder evalCat → codeteam profile
  evalAgentRole: "eval";
  instructions: {
    goal: string;
    publish: string;
    outputContract: "VerdictHandoffPacketV1";
    publishRequired: true;
  };
  context: {
    windowStartMs: number;
    windowEndMs: number;
    trendRefs: string[];
    verdictRefs: string[];
    sourceAdapter: string;
    sourceRefsKind: string;
    sourceRefs: string[];
    fixtures: EvalDomainFixture[];
    handoffTargetResolver: EvalDomainRegistryEntry["handoffTargetResolver"];
    sla: EvalDomainSla;
  };
}
```

- instructions 缺失不可发布；builder 总是提供 domain goal + publish guidance。
- `sourceRefs` 至少一个匹配 `sourceRefsKind` 的前缀；trajectory 用 `inv:`。

### 3.3 Verdict handoff

Approved 12-field envelope（codeteam 加 `v:1` 作为 adapter version）：

```ts
interface VerdictHandoffPacketV1 {
  v: 1;
  id: string;
  domainId: `eval:${string}`;
  findingKey?: string;
  createdAt: string;                   // ISO
  phenomenon: string;
  harnessUnderEval: { featureId: string; componentId: string; name: string };
  evidencePacket: {
    snapshotRefs: string[];            // 四类 refs 均 >= 1
    attributionRefs: string[];
    metricRefs: string[];
    sampleTraceRefs: string[];         // <= sampleTraceLimit
  };
  dailyTrend: {
    window: string;
    current: Record<string, number>;
    baseline: Record<string, number>;
    threshold: Record<string, number>;
    direction: "improved" | "regressed" | "flat" | "unknown";
  };
  rootCauseHypothesis: {
    summary: string;
    confidence: "low" | "medium" | "high";
    alternatives: string[];
  };
  verdict: "fix" | "build" | "keep_observe" | "delete_sunset";
  ownerAsk: {
    targetFeatureId: string;
    targetOwnerProfileId: string;      // codeteam mapping
    requestedAction: string;
  };
  governance?: { cvoAcceptRequired: boolean };
  acceptanceReevalPlan: { nextEvalAt: string; closureCondition: string };
  counterarguments: string[];
}
```

- `ownerAsk` 必须等于 registry `handoffTargetResolver` 的 feature/owner；不允许
  caller 自报别的 owner。
- `delete_sunset` 必须 `governance.cvoAcceptRequired=true`；其它 verdict
  不得声明 true。`cvoSuppressed` 不是 packet 字段；unknown governance key
  fail closed。
- 自由文本过内容级 secret 扫描；命中 fail closed。
- `findingKey` 是 case identity；没有它 = observation report，不建 case。

### 3.4 Measurement result

`publishEvalVerdict(store, { entry, packet, measurement, actor })` 接收独立
minimal result（F267 R2 borrow，去 certificate 字段）：

```ts
interface EvalMeasurementResultV1 {
  v: 1;
  kind: "eval_measurement_result";
  resultId: string;
  bundleId: string;
  domainId: string;
  generatedAt: string;                 // ISO
  status: "ok" | "insufficient" | "no_data" | "degraded";
  method: string;
  cohort: { ref: string; sha256: string; window: { startMs: number; endMs: number } };
  metrics: Array<{
    metricId: string;
    role: "primary_loss" | "guardrail";
    n: number;
    pointEstimate: number | null;
    evidenceStatus: "sufficient" | "insufficient";
  }>;
  decision: { status: "usable" | "insufficient"; reasons: string[]; withdrawalConditions: string[] };
  actionProposal: { action: EvalVerdictKind; rationale: string };
  measurementRef: string;
}
```

- `bundleId/domainId` 匹配 packet；`actionProposal.action` 匹配 packet verdict。
- `status=ok` ↔ `decision.status=usable`；non-ok ↔ `insufficient` 且 reasons
  非空。
- non-ok measurement 只允许 `keep_observe`（不把 insufficient/no_data 当
  healthy）。
- `evals.measurement_ref = measurement.measurementRef`；window/status/reasons
  同事务落 `evals`。

### 3.5 Artifacts

Eval 证据走现有 `artifacts` 表，不建第二个 artifact index：

- Approved 稿 §3.4 写“`artifacts.kind` 加值（不改表）”，但 W1 现有
  `artifacts.task_id NOT NULL` + kind CHECK 使 domain-level eval artifact 无法
  直接写入；migration 15 因此 rebuild `artifacts`（放宽 task_id + 加 eval
  kinds）。这是对稿子缺口的必要修正，不新增表。
- Migration 15 rebuild `artifacts`：`task_id` 可 NULL；`kind` 新增
  `eval-verdict` / `eval-lifecycle-root` / `eval-finding` / `eval-snapshot` /
  `eval-attribution` / `eval-measurement-result`；CHECK 要求 domain-level
  artifact 只能是 eval-*。
- `ControlStore.evalArtifacts` 是同一 `artifacts` 表的第二个实例，文件根为
  `${dataDir}/evals/bundles`（`CODETEAM_EVAL_BUNDLES_DIR` 默认）。
- `ArtifactStore.put`：task artifact 仍要求 `provenance.sourceMessageId`；
  eval artifact 要求 `provenance.evalVerdictId`，禁止 run binding。
- `ArtifactStore.delete` 拒绝 eval-*；`ArtifactGC` 保护 eval kinds。
- `evals.metrics_json.artifacts` 存 `artifactId/kind/sha256/bytes/path`；
  lifecycle event payload.refs 用 W6a `artifact:<id>`。
- 同一 verdict 重放使用 deterministic artifact id；内容不同 conflict。

### 3.6 Lifecycle events and projection

Schema（migration 15）：

```sql
eval_lifecycle_events(
  event_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  domain_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (... approved event list ...),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent','operator','system','migration')),
  actor_id TEXT NOT NULL,              -- 'agent:<profileId>' / 'operator:<id>' / 'system:<service>'
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json)='object'),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (case_id, seq)
);
-- BEFORE UPDATE/DELETE trigger -> RAISE(ABORT, 'append_only')
```

Event types：`verdict_opened`、`verdict_cycle_observed`、
`owner_acknowledged`、`action_planned`、`fix_recorded`、`main_landed`、
`reeval_requested`、`reeval_passed`、`reeval_failed`、`cvo_suppressed`、
`sla_escalated`、`owner_reassigned`、`migration`、`sunset_accepted`。
`live_active`/`monitoring` 是 W7/ops-gated；W6b service 不接受。

Status enum：open/acknowledged/action_planned/fix_landed/main_landed/
reeval_pending/monitoring/live_active/resolved/suppressed_with_reason/escalated；
W6b 只投影前 9 个可达状态。

Transition × actor matrix：

| event | allowed from | actor | resulting status |
|---|---|---|---|
| `verdict_opened` | —（publish 第一条） | `system:publish-pipeline` | `open` |
| `verdict_cycle_observed` | resolved | `system:publish-pipeline` | `open`（同一 case 新 cycle） |
| `owner_acknowledged` | open, escalated | agent=owner / operator | `acknowledged` |
| `action_planned` | open, acknowledged, escalated | agent=owner / operator | `action_planned` |
| `fix_recorded` | action_planned | agent=owner（W7 接 run-token binding）/ operator | `fix_landed` |
| `main_landed` | fix_landed | system=merge-owner / operator；full SHA | `main_landed` |
| `reeval_requested` | main_landed | `system:sla-reconciler`；dueAt 服务端派生 | `reeval_pending` |
| `reeval_passed` | reeval_pending | agent=eval / `system:eval-pipeline` | `resolved` |
| `reeval_failed` | reeval_pending | agent=eval / `system:eval-pipeline` | `action_planned`（monitoring→open 兼容） |
| `cvo_suppressed` | any non-terminal | operator | `suppressed_with_reason` |
| `sla_escalated` | open/ack/action/fix/main/reeval | `system:sla-reconciler` | `escalated` |
| `owner_reassigned` | any non-terminal | operator；target active | unchanged |
| `migration` | W6b unwired | migration | fail closed |
| `sunset_accepted` | any non-terminal, delete_sunset | operator | `resolved`（codeteam extension） |

- `owner_acknowledged/action_planned` 恢复 escalated；不能靠聊天/投递回执。
- `fix_recorded` 只记录修复；`main_landed` 必须有 full commit SHA；
  `reeval_requested.dueAt = case createdAt + reevalWithinHours`。
- same `(domainId, findingKey)` 新 verdict：仅当 case 已 resolved 时允许；
  追加 `verdict_cycle_observed`，不新开 case；case 未 resolved 时 conflict。
- 并发 seq：`BEGIN IMMEDIATE` 内读 case tail、CAS expectedSequence、插
  seq+1；`UNIQUE(case_id,seq)` + `event_id PK` 是第二道防线。
- overdue：open/acknowledged → ack deadline；action_planned/fix_landed/
  main_landed/reeval_pending/monitoring → reeval deadline；escalated 永远
  overdue；terminal false。

### 3.7 `evals` extension

Migration 15 rebuild `evals`：`task_id` 可 NULL；新增 `domain_id`、`bundle_id`、
`verdict_id`、`window_start_ms`、`window_end_ms`、`measurement_ref`、`status`
（`ok|insufficient|no_data|degraded`，NULL=legacy unknown；读面按
`no_data` 处理）、`reasons_json`。
non-ok 必须 reasons；`task_id`/`domain_id` 至少一个。legacy 行保留。

### 3.8 Task outcome episode

（保持不变）从 terminal runs 派生；identity
`eval-task-outcome-<sha256(payload)>`；bundle_id `task-outcome:<taskId>`；
outcome 映射 merged/abandoned/blocked/rejected/unknown；执行 run 的 usage /
latency / budget；human intervention = user messages；review FP/survival；
time-to-green = task.createdAt → first successful merge.mergedAt；
sourceRefs 使用 W6a `ControlEvidenceSourceRef` union（task/review/
verification/merge/artifact），`runId` 单列；同 bundle 只取最新 snapshot。

### 3.9 Corpus and model-role matrix

（保持不变）按 evidenceTier × provider × model × role × repo 分组；
synthetic 永远 smoke-only；live n<20 或 unknown family 不结论；non-ok
episode 只进 statusCounts/excluded；live recall 无 ground truth = null；
同 bundle 最新 snapshot；report window 按 `evals.window_*` 重叠筛选。

### 3.10 Read surface and CLI

Publish 同一 `BEGIN IMMEDIATE` 事务内：写 message、`evals`、`verdict_opened`
或 `verdict_cycle_observed`。消息头显示 measurement status/reasons、case
或 `observation report · no case tracking`、ownerAsk/SLA/counterarguments/
re-eval plan/artifact digest。

```text
codeteam eval list   [--domain <id>] [--status <status>] [--json]
codeteam eval open   [--domain <id>] [--json]
codeteam eval overdue [--domain <id>] [--json]
codeteam eval show   <caseId|verdictId> [--json]
codeteam eval accept-sunset <caseId|verdictId> --reason <text> [--expected-seq <n>] [--json]
```

- `list/open/overdue/show` 从 lifecycle events + evals 派生。
- `accept-sunset` 必须 operator credential；只 append `sunset_accepted`，
  不删除任何文件/配置；未 accept 的 delete_sunset 显示
  `awaitingSunsetDecision=true`。
- `cvo_suppressed` 没有 CLI 写入口；service 只接受 operator actor。

## 4. AC mapping

| AC | 交付 | 验证 |
|---|---|---|
| AC-1 outcome episode 落 `evals`，含 outcome/review/findings/cost/latency/human/code metrics | `eval/episodes.ts` | seeded task fixture；幂等；同 bundle 最新 snapshot |
| AC-2 至少 2 provider / 2 repo 的 eval 数据 + 模型-角色矩阵 | `eval/report.ts` + synthetic fixture | fixture 2×2；synthetic smoke |
| AC-3 synthetic 与 live 分账；n<20 只作 smoke | `EvalCorpusReport` | n=10 smoke；live n>=20 conclusion；non-ok excluded |
| AC-4 registry 可加载；evalAgent/owner/thread 解析；缺 profile/role/thread fail closed | `eval/registry.ts` + `evals/domains/*.yaml` | valid/invalid YAML；dormant；missing dir warning |
| AC-5 12-field envelope + measurement + immutable `artifacts` 表证据 | `eval/publish.ts` + `eval/artifacts.ts` | packet/measurement round-trip；artifact table id；delete denied |
| AC-6 lifecycle append-only + actor/event matrix + 并发 seq + same-case cycle | migration 15 + `eval/lifecycle.ts` | 14 event types；actor authority；trigger abort；cycle test |
| AC-7 `evals` 扩展 + non-ok reasons | migration 15 + `EvalStore` | DB CHECK + store；legacy NULL |
| AC-8 publish 同事务写 domain thread verdict 消息 | `eval/publish.ts` | eval+event+message；缺 thread 无残留 |
| AC-9 CLI list/open/overdue/show/accept-sunset；delete_sunset 两层门 | `cli/eval.ts` | CLI e2e；未 accept awaiting；accept 后 resolved |
| AC-10 cvo_suppressed / accept-sunset operator-only；eval 不能自签 terminal | lifecycle actors | owner/eval/system 尝试 forbidden；operator 成功 |
| AC-11 secret 扫描；无 findingKey 消息标 observation | `eval/redaction.ts` + publish | AWS/GitHub/PEM 样例；无 key marker |
| AC-12 review/eval 两本账；不建第二 verdict/case/finding/artifact store | schema + tests | review 表计数不变；无 eval_cases/eval_verdicts/eval_findings；artifacts 表唯一索引 |
| AC-13 approved 架构对齐：actor_kind agent/operator/system/migration；fix_recorded/main_landed/sla_escalated；same-case cycle；artifacts 表 | 全套 | contract tests + review |

## 5. Test matrix

| 文件 | 覆盖 |
|---|---|
| `control-eval-schema.test.ts` | migration 15、evals/artifacts 约束、legacy、append-only、表清单 |
| `control-eval-registry.test.ts` | YAML strict、evalAgent/owner/thread/model、dormancy、missing dir |
| `control-eval-episodes.test.ts` | episode 字段/幂等/reasons/sourceRefs；corpus report 2×2、synthetic/live、bundle 最新 |
| `control-eval-lifecycle.test.ts` | publish、14 event types、actor authority、same-case cycle、并发 seq、append-only、operator-only |
| `control-eval-redaction.test.ts` | secret 模式、消息/artifact 不落盘 |
| `cli-eval.test.ts` | list/open/overdue/show、accept-sunset、operator-only、未 accept 不执行 |

## 6. Boundaries and non-goals

- 不写 W6a `memory/**`、W6c `observability/**`；只复用 W6a 纯 `scanSecrets`
  工具与 `ControlEvidenceSourceRef` 类型，不打开 memory.db/index。
- 不建 `eval_verdicts` / `eval_cases` / `eval_findings`；`evals` 是 verdict/
  outcome store，`artifacts` 是证据索引，`eval_lifecycle_events` 是 case log。
- 不接 W5 scheduler / W7 HTTP/Console / W8 GitHub / Eval Hub UI / Paw-Feel /
  F246 repair / F311 evolution control。
- 不自动删除 harness；`delete_sunset` 只进入 awaiting decision，operator
  accept 后也只记录接受。
- `live_active`/`monitoring` 事件 W7/ops-gated；W6b fail closed。

## 7. Rollback

- 代码回滚到 W6b 前 baseline；migration 15 是 additive/rebuild 但保留旧行。
- 关闭 `CODETEAM_EVAL_ENABLED`，不启动 scheduler；已写 artifacts/events 保留。
- `artifacts`/`evals`/`eval_lifecycle_events` 可整体保留为历史，不影响
  `reviews/findings/verifications/merges`。

## 8. Risks

| 风险 | 缓解 |
|---|---|
| eval 过拟合 / synthetic 冒充 live | evidenceTier 分账、n<20 smoke、live recall=null |
| 第二套 verdict/case/finding/artifact store | `evals` + `artifacts` + lifecycle log；无新表/新目录 |
| eval agent 自签 closure | terminal 只能 operator/system；actor authority + run binding 后续 |
| delete_sunset 误执行 | publish 声明 + operator accept 两层；accept 只写事件 |
| secret 进 verdict 消息/artifact | publish 前内容级扫描，命中 fail closed |
| 并发 seq 重复/跳号 | BEGIN IMMEDIATE + UNIQUE(case_id,seq) + event_id PK |
| same-case cycle 污染旧 case | 仅 resolved 后允许；cycle event + 最新 verdict 投影 |

## 9. Implementation order

1. Migration 15 + artifacts/evals/lifecycle schema。
2. Contract/registry/config。
3. Episodes/report。
4. Lifecycle/publish/artifacts。
5. CLI。
6. Tests/build/biome。
7. 独立 review（墨墨 → 砚砚）与合入。

## 10. Implementation record（2026-10-29）

- Worktree：`/home/ming/agent/codeteam-w6b`，branch `feat/w6b-eval`。
- 代码：`src/eval/{contract,config,registry,episodes,report,lifecycle,artifacts,publish,redaction}.ts`；
  migration 15；`src/cli/eval.ts`；`evals/domains/*.yaml`。
- Artifacts：走 `artifacts` 表 + `${dataDir}/evals/bundles`；无
  `eval-artifacts/` 第二目录。
- 测试：daemon 全量 **516 passed / 2 skipped**；eval 定向 37/37。
- Root `tsc`、`build:offline`、biome、runtime/pinned dependency、TS import、
  entry graph 通过。
- 未做：W7 HTTP/Console、W5 scheduler 接线、live corpus materialization、
  Eval Hub UI、Paw-Feel、F246 repair、run-token fix binding。
- 已知限制：并发 seq 测试是双控制连接交替写入；多线程压力留给 W7/acceptance。
- 已知规模边界：`EvalStore.list` 5000 行、materialize 默认 500 task 是 v1
  安全上限；W7 加分页。
- 已知写入顺序：artifact 先落盘、DB 事务后写；DB conflict race 可能留下
  content-addressed 孤儿文件，不损坏既有证据，清理留给后续 GC。

[宪宪/deepseek-flash🐾]
