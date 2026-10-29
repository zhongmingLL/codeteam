---
title: "W6b Eval / Outcome / Harness Eval 实施计划与契约冻结"
doc_kind: plan
status: review
created: 2026-10-29
updated: 2026-10-29
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [墨墨 (Qwen 3.8 Flash), 砚砚 (GLM 5.3 Flash)]
source: "docs/plans/0004-w5-w8-scale-product.md §W6 6B/6F"
feature: F014
---

# W6b Eval / Outcome / Harness Eval

> 基线：`codeteam-work @ 49f9a140e`。W6a（F012 memory/evidence）与 W6c
> （F013 observability/trajectory）已 closed；本切片消费它们的冻结契约，但
> 不读写 memory.db、trace ring、tool-usage/log store。
>
> 本文件冻结 W6b 的 v1 契约。修改 `src/eval/contract.ts` 的字段/语义必须同步
> 更新本文件与 F014；W7 只加 HTTP/auth/Console 适配，不另造 verdict/case/
> finding 表。

## 1. Goal

让 eval 能驱动 codeteam 的模型-角色选择，同时让 operator 看得见 verdict 的
责任闭环：

- 每个 terminal task 产出可回源的 outcome episode（落 `evals`，不建第二
  outcome store）。
- 多 provider / 多 repo 的 eval corpus 可生成代码域指标和模型-角色矩阵；
  synthetic fixture 与 live 数据严格分账，n<20 只作 smoke。
- harness-eval domain 由 YAML registry 声明；`evalAgent` 必须解析到
  `role='eval'` active `AgentProfile`，否则 fail closed。
- verdict 走 `EvalAgentInvocationPacket → eval agent → VerdictHandoffPacket`；
  finding/verdict/root artifact 不可变。
- `eval_lifecycle_events` 是 append-only case log；review
  `reviews/findings/verifications` 与 eval lifecycle 两本账互不写入。
- publish 同事务写 domain system thread 的人读 verdict 消息；CLI 从 events
  派生 `list/open/overdue/show`，`accept-sunset` 与 `cvo_suppressed`
  operator-only，`delete_sunset` 未 accept 不执行。

## 2. Scope

### 2.1 In scope

| 切片 | 内容 | 边界 |
|---|---|---|
| **W6b-A** | task outcome episode：从 canonical `tasks/runs/reviews/findings/verifications/merges/budgets/messages` 派生，落 `evals` | 不复制 review 账本；只存 episode 投影与 source refs |
| **W6b-B** | eval corpus + 代码域指标 + 模型-角色矩阵报告；synthetic/live 分账，n<20 smoke | 不做 dashboard、不做自动模型路由 |
| **W6b-C** | `evals/domains/*.yaml` registry + profile/thread 解析 | 不做调度器；W5 scheduler 不接 |
| **W6b-D** | `EvalAgentInvocationPacket` / `VerdictHandoffPacket` / immutable artifacts / `eval_lifecycle_events` | 不建 eval_verdicts/eval_cases/eval_findings 表 |
| **W6b-E** | `evals` 扩展、publish 同事务 verdict 消息、CLI `eval list/open/overdue/show/accept-sunset` | 不做 W7 HTTP/Console、Eval Hub UI、Paw-Feel、F246 repair |
| **W6b-F** | 测试：两本账、非法 lifecycle、secret 扫描、insufficient/no_data、无 findingKey、并发 seq、operator-only | — |

### 2.2 Out of scope

- W6a memory.db / index / recall adapter；只消费 `EvidenceSourceRef` 的
  `control` ref 字符串格式。
- W6c trace/log/tool-usage store；只消费其冻结 DTO 的 correlation key 语义。
- 6C lessons/decisions 写面、6D cue plane/context presentation。
- W7 HTTP/Console、W8 GitHub、W5 scheduler、Eval Hub UI、Paw-Feel inbox、
  F246 repair、F311 evolution control。
- 自动执行 harness 删除；`delete_sunset` 只记录 trial/decision，不删除任何
  harness 文件或配置。

## 3. Frozen contract v1

落点：`packages/codeteam-daemon/src/eval/contract.ts`。实现类与 store 不进
契约；下游只依赖这里的类型与语义。

### 3.1 Domain registry

Registry 文件：`evals/domains/*.yaml`（repo 根目录）。每文件一条：

```ts
type EvalDomainFrequency = "manual" | "daily" | "weekly";

interface EvalDomainRegistryEntry {
  domainId: `eval:${string}`;              // /^eval:[a-z0-9][a-z0-9-]*$/
  descriptionForHuman?: string;
  systemThreadId: string;                  // control threads.id
  evalAgent: string;                       // agent_profiles.id
  frequency: EvalDomainFrequency;
  triggerPolicy: {
    kind: "time_only" | "threshold_or_time";
    maxDetectionDelayHours: number;        // > 0
  };
  sourceAdapter: "task_outcome" | "eval_corpus";
  sourceRefsKind: "task" | "review" | "merge" | "artifact" | "trajectory";
  sla: {
    acknowledgementHours: number;          // > 0
    reevaluationHours: number;             // > 0
  };
  enabled: boolean;
  dormancy?: {                             // required iff enabled=false
    reason: string;
    revivalPath: string;
    decisionRef: string;
  };
}
```

- YAML 严格模式：未知字段、重复 `domainId`、空文件、非法 enum 一律 fail
  closed。
- `enabled: true` 时加载必须解析 `evalAgent`：profile 存在、`role='eval'`、
  profile `status='active'`、`eval` role `status='active'`、
  `systemThreadId` 存在且 `status='active'`。任一失败 fail closed。
- `enabled: false` 必须带 `dormancy`；它没有 action 权限，不解析 profile/
  thread，但 shape 仍严格校验。复活 = 人工改回 `enabled: true` 并通过上述
  解析。
- registry 只声明；scheduler 不在本切片。`triggerPolicy` 是下一个消费方的
  输入契约，不产生定时任务。

### 3.2 Eval agent invocation

```ts
interface EvalAgentInvocationPacket {
  v: 1;
  invocationId: string;                    // 幂等键
  domainId: string;
  targetThreadId: string;                  // = domain.systemThreadId
  evalAgent: string;                       // resolved active profile id
  evalAgentRole: "eval";
  instructions: {
    goal: string;
    sourceAdapter: EvalDomainRegistryEntry["sourceAdapter"];
    sourceRefsKind: EvalDomainRegistryEntry["sourceRefsKind"];
    outputContract: "VerdictHandoffPacketV1";
  };
  context: {
    windowStartMs: number;
    windowEndMs: number;                   // > start
    trendRefs: string[];
    verdictRefs: string[];
    sourceRefs: string[];                  // W6a control refs, e.g. task:<id>
    sla: EvalDomainRegistryEntry["sla"];
  };
}
```

`buildEvalAgentInvocationPacket()` 只读 registry、profile、thread，不创建
task/schedule/queue entry。eval agent 的真实唤醒留给 W5/W7；本切片验证 packet
可以被真实 eval profile 消费。

### 3.3 Verdict handoff

```ts
type EvalVerdictKind = "fix" | "build" | "keep_observe" | "delete_sunset";
type EvalMeasurementStatus = "ok" | "insufficient" | "no_data" | "degraded";

interface EvalMeasurementV1 {              // F267 v1-minimal；去 certificate 字段
  status: EvalMeasurementStatus;
  method: string;
  windowStartMs: number;
  windowEndMs: number;
  measurementRef: string;
  reasons: string[];                       // status != "ok" 时非空
  // 明确没有 certificateId / certificateRef / decisionProcedureVersionSetHash
}

interface VerdictFindingV1 {
  severity: "P1" | "P2" | "P3";
  claim: string;
  evidenceRefs: string[];                  // >= 1，W6a control/file refs
  falsifier?: string;
  requiredAction?: string;
}

interface VerdictHandoffPacketV1 {
  v: 1;
  id: string;                              // immutable verdictId
  domainId: string;
  bundleId: string;                        // /^[a-z0-9][a-z0-9._-]{0,127}$/
  createdAt: number;                       // epoch ms
  phenomenon: string;
  harnessUnderEval: { featureId: string; componentId: string; name: string };
  evidencePacket: {
    sourceRefs: string[];                  // >= 1
    summary: string;
    measurement: EvalMeasurementV1;
    snapshotRef?: string;
    attributionRef?: string;
  };
  rootCauseHypothesis: string;
  verdict: EvalVerdictKind;
  findingKey?: string;                     // /^[a-z0-9][a-z0-9._-]{0,127}$/
  findings: VerdictFindingV1[];
  ownerAsk: {
    targetFeatureId: string;
    targetOwnerProfileId: string;          // codeteam AgentProfile, not clowder catId
    requestedAction: string;
  };
  acceptanceReevalPlan: { nextEvalAt: number; closureCondition: string };
  counterarguments: string[];
  governance: {
    cvoAcceptRequired: boolean;            // delete_sunset 必须 true
    cvoSuppressed: boolean;                // publish 必须 false
  };
}
```

Rules:

- `findingKey` 是 case identity；没有它 = observation report，不建 case、
  不写 lifecycle、消息头标 `observation report · no case tracking`。
- `caseId = eval-case-v1-<sha256(domainId + "\u001f" + findingKey)>`。
- `delete_sunset` 必须 `cvoAcceptRequired=true`；publish 只记录
  `open(awaiting-sunset-decision)`，绝不执行删除。
- `cvoSuppressed=true` 的 packet 拒绝 publish；suppress 只能走 operator
  lifecycle action。
- 所有自由文本（phenomenon / summary / rootCause / finding claim /
  requiredAction / ownerAsk / counterarguments / reasons）在落盘前过内容级
  secret 扫描；命中 fail closed，不截断、不静默 redact。

### 3.4 Immutable artifacts

Publish 在 `dataDir/eval-artifacts/<verdictId>/` 写 0600 文件，目录 0700：

| 文件 | 内容 | 类型 |
|---|---|---|
| `verdict.json` | `VerdictHandoffPacketV1` 全文 | `eval-verdict` |
| `lifecycle-root.json` | `LifecycleRootArtifactV1/V2` | 根 artifact |
| `snapshot.json` | `evidencePacket`（含 measurement） | `eval-snapshot` |
| `attribution.json` | `rootCauseHypothesis` + `counterarguments` + measurement | `eval-attribution` |
| `finding-<index>.json` | 单条 `VerdictFindingV1` + verdictId | `eval-finding` |

文件用 `wx` 写入；同 verdictId 重放必须逐字节 digest 相同，否则 conflict。
`evals.metrics_json.artifacts` 记录每个文件的 `{ kind, path, sha256, bytes }`，
`lifecycle-root.json` 的 digest 同时写进 verdict 消息。artifact 不删除、不改写。

`LifecycleRootArtifact` v1 = 无 findingKey；v2 = 有 findingKey + caseId。
v3 的 friction findingBinding 不在 W6b，显式不实现。

### 3.5 Lifecycle events and projection

```ts
type EvalLifecycleStatus =
  | "open" | "acknowledged" | "action_planned" | "fix_landed"
  | "reeval_pending" | "monitoring" | "escalated"
  | "resolved" | "suppressed_with_reason";

type EvalLifecycleEventType =
  | "verdict_opened" | "owner_acknowledged" | "action_planned" | "fix_landed"
  | "reeval_requested" | "reeval_passed" | "reeval_failed"
  | "escalated" | "cvo_suppressed" | "sunset_accepted" | "resolved";

interface EvalLifecycleActor {
  kind: "eval" | "owner" | "operator" | "system";
  id: string;
}

interface EvalLifecycleEvent {
  eventId: string;
  caseId: string;
  seq: number;                             // >= 1, per case
  verdictId: string;
  domainId: string;
  type: EvalLifecycleEventType;
  actor: EvalLifecycleActor;
  reason: string;
  refs: string[];
  createdAt: number;
}
```

11 transitions × actor matrix：

| event | allowed from | actor | resulting status |
|---|---|---|---|
| `verdict_opened` | —（publish 第一条） | eval | `open` |
| `owner_acknowledged` | open, escalated | owner | `acknowledged` |
| `action_planned` | open, acknowledged | owner | `action_planned` |
| `fix_landed` | action_planned | owner | `fix_landed` |
| `reeval_requested` | fix_landed | owner | `reeval_pending` |
| `reeval_passed` | reeval_pending | eval | `monitoring` |
| `reeval_failed` | reeval_pending | eval | `open` |
| `escalated` | open, acknowledged, action_planned, fix_landed, reeval_pending | operator, system | `escalated` |
| `cvo_suppressed` | any non-terminal | operator | `suppressed_with_reason` |
| `sunset_accepted` | any non-terminal, verdict=delete_sunset | operator | `resolved` |
| `resolved` | monitoring, escalated | operator, system | `resolved` |

- `resolved` / `cvo_suppressed` / `sunset_accepted` 永远不能由 eval actor
  写入；eval agent 不能自签 terminal。
- `owner` actor 必须等于 verdict `ownerAsk.targetOwnerProfileId`；`eval`
  actor 必须等于 registry 解析出的 `evalAgent` profile id。
- 并发 seq：每次 append 在 `BEGIN IMMEDIATE` 内读取 case tail、校验
  `expectedSequence`、插入 `seq+1`；`UNIQUE(case_id, seq)` +
  `event_id PRIMARY KEY` 是第二道防线。`eventId` 重放同内容幂等返回，不同
  内容 conflict。
- read 面每次从 events 重新投影 status；不存 projection 表。
- `overdue`：非 terminal 且超过 verdict `createdAt + sla.acknowledgementHours`
  （尚未 acknowledged 类）或 `createdAt + sla.reevaluationHours`（已进入
  reeval）；`escalated` 永远 overdue。

### 3.6 `evals` extension

Migration 15 rebuild `evals`（SQLite 不能原地放宽 `task_id NOT NULL`）：

```sql
task_id TEXT,                    -- NULL 允许：domain-level verdict
domain_id TEXT,
bundle_id TEXT,
verdict_id TEXT,
window_start_ms INTEGER,
window_end_ms INTEGER,
measurement_ref TEXT,
status TEXT CHECK (status IS NULL OR status IN ('ok','insufficient','no_data','degraded')),
reasons_json TEXT,
CHECK (task_id IS NOT NULL OR domain_id IS NOT NULL),
CHECK (status IS NULL OR status = 'ok' OR
       (reasons_json IS NOT NULL AND json_type(reasons_json) = 'array'
        AND json_array_length(reasons_json) > 0))
```

- `status NULL` = legacy unknown；不把 NULL/insufficient/no_data 当 healthy。
- `bundle_id` 把同一 task/bundle 的多次 snapshot 串起来；读面取最新一条。
- Task outcome episode 使用 `domain_id NULL`、`bundle_id =
  task-outcome:<taskId>`、`measurement_ref = task:<taskId>`，不与 domain
  verdict 混用。
- `eval_lifecycle_events` 同 migration 新建；append-only trigger 禁止
  UPDATE/DELETE。

### 3.7 Task outcome episode

```ts
interface TaskOutcomeEpisodeMetricsV1 {
  v: 1;
  kind: "task_outcome_episode";
  synthetic: false;
  taskId: string;
  runId: string;
  repo: string | null;
  outcome: "merged" | "rejected" | "blocked" | "abandoned" | "unknown";
  firstPassReviewPass: boolean | null;
  reviewRounds: number;
  findings: { total: number; p1: number; p2: number; p3: number };
  verifications: { confirmed: number; rejected: number; blocked: number };
  tokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  humanInterventionCount: number;
  codeMetrics: {
    reviewFalsePositiveRate: number | null;
    findingSurvival: number | null;
    timeToGreenMs: number | null;          // task.createdAt → first successful merge.mergedAt
    costPerMergedChangeUsd: number | null;
  };
  sourceRefs: string[];                     // task:/run:/review:/verification:/merge:
  windowStartMs: number;
  windowEndMs: number;
}
```

- Episode 以 terminal `runs` 为种子（`completed | failed | canceled |
  interrupted`），identity 是 `eval-task-outcome-<sha256(payload)>`；payload
  相同幂等，变化则同一 `bundle_id` 下追加新 snapshot。
- `status`：critical evidence（review 或 merge）缺失 = `insufficient` +
  reasons；task 非 terminal = `no_data` + reasons（正常 materializer 只取
  terminal run）。
- `humanInterventionCount` = task 上 `author_kind='user'` 的 message 数。
- `tokens/cost/latency` 只从 run usage / run terminal 时间提取白名单数值键；
  缺失为 null，不猜。
- `reviewFalsePositiveRate` = rejected verifications / decided verifications；
  `findingSurvival` = confirmed / decided。没有 decided verification = null。
  live 数据不算 recall（没有 ground truth）；recall 只允许 synthetic corpus。

### 3.8 Corpus and model-role matrix

```ts
interface EvalCorpusObservation {
  evidenceTier: "live" | "synthetic";
  kind: "task_outcome" | "review_corpus";
  provider: string;
  model: string;
  modelFamily: string | null;
  role: string;
  repo: string;                            // "unknown" permitted for live
  status: EvalMeasurementStatus | null;
  taskOutcome?: TaskOutcomeEpisodeMetricsV1;
  reviewCorpus?: SyntheticReviewCorpusMetricsV1; // synthetic-only
}

interface EvalMatrixCell {
  evidenceTier: "live" | "synthetic";
  provider: string;
  model: string;
  modelFamily: string | null;
  role: string;
  repo: string;
  n: number;
  statusCounts: Record<EvalMeasurementStatus | "unknown", number>;
  excludedNonOk: number;
  smokeOnly: boolean;                      // synthetic || n < minSample
  conclusionAllowed: boolean;              // live && n >= minSample && modelFamily != null
  metrics: { ...aggregates...; reviewRecall: number | null };
}

interface EvalCorpusReport {
  v: 1;
  window: { startMs: number; endMs: number };
  minSample: number;                       // default 20
  cells: EvalMatrixCell[];
  warnings: string[];                      // no_live_data / synthetic_fixture / below_min_sample / ...
  codeDomain: { ...aggregate code metrics...; excludedNonOkEpisodes: number };
}
```

- 报告按 `evidenceTier × provider × model × role × repo` 分组，绝不把
  synthetic 和 live 混进同一格。
- 同一 `bundle_id` 的多次 outcome snapshot 只取最新一条（`created_at` 最大，
  同刻按 id），避免 late merge / 重算把同一 task 重复计数。
- 报告窗口按 `evals.window_start_ms/window_end_ms` 与目标窗口重叠筛选；
  legacy `window=NULL` 记录不进入窗口报告，避免用 materialize 时间冒充
  data window。
- `insufficient/no_data/degraded`（以及 legacy `status NULL`）只计入
  `statusCounts` / `excludedNonOk`，不进入质量指标或 `n`；报告加
  `non_ok_episodes_excluded` warning。
- `synthetic` 永远 `smokeOnly=true`，即使 n>=20；它只验证管道与阈值，不
  冒充模型家族结论。
- live n<20 或 model family 不可解析 = smoke only；`conclusionAllowed=false`，
  suppression reason 分别为 `below_min_sample` / `unknown_model_family`。
- live recall 无 ground truth = null；synthetic seeded corpus 可计算
  recall/FP/survival。

### 3.9 Read surface and CLI

Publish 同一 `BEGIN IMMEDIATE` 事务内：

1. insert `evals` verdict row；
2. insert `verdict_opened`（有 findingKey 时）；
3. append domain system thread `kind='verdict'` 消息。

消息内容（人读投影，不改 case 状态）：

- 头：domainId / verdict / measurement status / window / caseId 或
  `observation report · no case tracking`；
- `reasons`（非 ok 必显）；
- ownerAsk / SLA / counterarguments / re-eval plan；
- lifecycle-root digest + artifact manifest digest。

CLI：

```text
codeteam eval list   [--domain <id>] [--status <status>] [--json]
codeteam eval open   [--domain <id>] [--json]
codeteam eval overdue [--domain <id>] [--json]
codeteam eval show   <caseId> [--json]
codeteam eval accept-sunset <caseId> --reason <text> [--expected-seq <n>] [--json]
```

- `list/open/overdue/show` 从 `eval_lifecycle_events` + `evals` 派生，不读
  registry（SLA 在 publish 时存进 verdict metrics）。
- `accept-sunset` 必须 operator credential；只 append `sunset_accepted`，
  不删除任何文件/配置；未 accept 的 `delete_sunset` 永远显示
  `awaitingSunsetDecision=true`。
- `cvo_suppressed` 没有 CLI 写入口；service 只接受 operator actor。W7 若
  需要 UI，复用同一 service。

## 4. AC mapping

| AC | 交付 | 验证 |
|---|---|---|
| AC-1 outcome episode 落 `evals`，含 outcome/review/findings/cost/latency/human/code metrics | `eval/episodes.ts` + `EvalStore` 扩展 | seeded task fixture 断言全部字段与 sourceRefs；重放幂等 |
| AC-2 至少 2 provider / 2 repo 的 eval 数据 + 模型-角色矩阵 | `eval/report.ts` + synthetic fixture | fixture 报告 cell 覆盖 2×2；synthetic 标 smoke |
| AC-3 synthetic 与 live 分账；n<20 只作 smoke | `EvalCorpusReport` | n=12 cell `smokeOnly=true`；n>=20 live `conclusionAllowed=true`；synthetic n>=20 仍 smoke |
| AC-4 registry 可加载；evalAgent 解析 active `role='eval'`；缺 profile/role/thread fail closed | `eval/registry.ts` + `evals/domains/*.yaml` | valid/invalid YAML 测试；disabled+dormancy；active profile/thread 测试 |
| AC-5 invocation/verdict envelope + immutable artifacts | `eval/artifacts.ts` + publish | packet round-trip；artifact digest；重放不同内容 conflict |
| AC-6 `eval_lifecycle_events` append-only + transition/actor matrix + 并发 seq | migration 15 + `eval/lifecycle.ts` | 11 transitions 正/反测试；trigger UPDATE/DELETE abort；跨连接 seq 1..N |
| AC-7 `evals` 扩展 + non-ok reasons 必填 | migration 15 + `EvalStore` | DB CHECK 与 store 双层；legacy NULL status 保留 |
| AC-8 publish 同事务写 domain thread verdict 消息 | `eval/publish.ts` | eval+event+message 同时存在；缺 thread 时无残留 row；消息含 SLA/reasons/digest |
| AC-9 CLI list/open/overdue/show/accept-sunset；delete_sunset 两层门 | `cli/eval.ts` | CLI e2e；未 accept 显示 awaiting；accept 后 resolved；文件未删除 |
| AC-10 `cvo_suppressed` / accept-sunset operator-only；run token 不能写 lifecycle | lifecycle service actors | owner/eval/system 尝试 suppress/accept 全部 forbidden；operator 成功 |
| AC-11 secret 扫描；无 findingKey 消息标 observation | `eval/redaction.ts` + publish | AWS/GitHub/PEM/密码样例 fail closed；无 key 消息 marker |
| AC-12 review/eval 两本账；不建第二 verdict/case/finding 表 | schema + tests | lifecycle 写入后 `reviews/findings/verifications` count 不变；control tables 无 eval_verdicts/eval_cases/eval_findings |
| AC-13 insufficient/no_data/degraded reasons 在 evals 与消息头可见 | publish + CLI show | 三种 status 的 reasons 断言 |

## 5. Test matrix

| 文件 | 覆盖 |
|---|---|
| `control-eval-schema.test.ts` | migration 15、evals 约束、legacy 数据、append-only trigger、表清单 |
| `control-eval-registry.test.ts` | YAML strict、duplicate、enabled/dormant、profile role/status、thread 状态 |
| `control-eval-episodes.test.ts` | episode 字段、幂等、insufficient reasons、review/eval 分账、sourceRefs |
| `control-eval-report.test.ts` | 2 provider/2 repo、synthetic/live 分账、n<20 smoke、live recall null |
| `control-eval-lifecycle.test.ts` | publish、11 transitions、actor matrix、并发 seq、event 幂等、非法 history fail closed |
| `control-eval-redaction.test.ts` | secret 模式、消息/artifact 不落盘 |
| `cli-eval.test.ts` | list/open/overdue/show/accept-sunset、operator-only、未 accept 不执行 |

## 6. Boundaries and non-goals

- 不写 `packages/codeteam-daemon/src/memory/**`、`observability/**`、W6c
  stores；只读类型/ref 字符串。
- 不写 `reviews/findings/verifications` 表；eval lifecycle 是独立 append-only
  log。FK 只从 lifecycle -> `evals(verdict)`，不反向写 review。
- 不新建 `eval_verdicts` / `eval_cases` / `eval_findings`；`evals` 是 verdict
  store，case identity 由 domainId+findingKey 派生。
- 不接 scheduler、HTTP、Console、GitHub、Paw-Feel、F246。
- 不自动删除 harness；`delete_sunset` 只进入 awaiting decision，operator
  accept 后也只记录接受。

## 7. Rollback

- 代码回滚到 W6b 前 baseline 即可；migration 15 只新增 `eval_lifecycle_events`
  和 `evals` 新列，不删除旧数据。
- 新列对旧 reader 是可选字段；旧 `EvalStore` 仍可读 `task_id/provider/model/
  role/metrics_json/created_at`。
- `eval_lifecycle_events` 可整体保留为历史；回滚不迁移 clowder 历史 artifact。
- Artifact 目录 `dataDir/eval-artifacts/` 只增不改；回滚不删除已验证证据。

## 8. Risks

| 风险 | 缓解 |
|---|---|
| eval 过拟合 / synthetic 冒充 live | evidenceTier 分账、n<20 smoke、live recall=null、报告 warnings |
| lifecycle 成为第二套 verdict 账本 | `evals` 唯一 verdict store；caseId 派生；无 case/verdict/finding 表 |
| eval agent 自签 closure | terminal events 拒绝 eval actor；owner/operator/system 矩阵 |
| delete_sunset 误执行 | publish 仅记录 awaiting；accept-sunset 只写事件，不删除 |
| secret 进 verdict 消息/artifact | publish 前内容级扫描，命中 fail closed |
| 并发 seq 重复/跳号 | BEGIN IMMEDIATE + UNIQUE(case_id,seq) + event_id PK |
| publish 与消息不一致 | 同一事务插入 eval/event/message；缺 thread 整体失败 |

## 9. Implementation order

1. Migration 15 + `EvalStore` 扩展 + `eval/contract.ts`。
2. Registry loader + sample YAML。
3. Episodes + report（含 synthetic fixture）。
4. Lifecycle service + artifacts + publish（含 secret scan）。
5. CLI evals + operator accept-sunset。
6. Tests 全绿、build、biome、CLI e2e。
7. 独立 review（墨墨 → 砚砚）与合入。

## 10. Implementation record（2026-10-29）

- 代码已落在 `feat/w6b-eval` worktree；实现文件与 F014 Implementation 节一致。
- 定向测试：schema/registry/episodes/lifecycle/redaction/CLI + migration/schema
  全部通过；daemon 全量 514 passed / 2 skipped。
- Root `tsc`、`build:offline`、biome、runtime/pinned dependency、TS import、
  entry graph 检查通过。
- 未做：W7 HTTP/Console、W5 scheduler 接线、live corpus materialization、
  Eval Hub UI、Paw-Feel、F246 repair。
- 已知限制：并发 seq 测试用两个控制连接交替写入验证跨连接单调性；真正的
  多线程压力测试留给 W7/acceptance 环境。`delete_sunset` 只记录 accept，
  不执行 harness 删除。

[宪宪/deepseek-flash🐾]
