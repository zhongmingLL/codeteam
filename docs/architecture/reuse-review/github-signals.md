---
title: "github-signals 架构复用检视"
doc_kind: architecture-review
status: approved
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
review_request: "2ee84938-532c-4ae6-9f93-2e4f0f1f7402"
operator_signoff: "DP-GH-1=A, DP-GH-2=A (2026-10-25)"
source_cell: github-signals
source_card: ../../reuse/github-signals.md
template: ../0004-reuse-architecture-review-plan.md
---

# github-signals 架构复用检视

> **DP-MERGE-1=D 影响注（2026-10-25）**：Q4 已收敛——merge terminal truth 是 `merges` receipt，`pr_merged` 只作外部观察事实，不进 v1 10 kinds，也不作 custody predicate。D 的 merge service 用 merge API response + reconciliation/`pr_merged` 观察双确认。详见 `../merge-authority-drift-audit.md` §9。

## 1. 总结

| 项 | 结论 |
|---|---|
| clowder feature 范围 | F133（CI/CD signals）、F140（PR review feedback / conflict / issue comments）、F280（typed GitHub wait predicate / baseline / matched delta）、F141/F168（community-ops 边界）、F304（admission/liveness）、F139/F202（schedule seam）。 |
| codeteam 复用总结 | **R1 适配复用**。复用 GitHub 外部事实采集、per-source frontier、registration baseline、typed predicate、matched-delta renderer、webhook HMAC/delivery-id 去重；codeteam 只把它们接到 `tasks`/`waits`/`audit`/`forge_deliveries`，不把 GitHub 事实当球权/投递真相。 |
| codeteam W | W8（Forge connector / GitHub signal evidence）；W5（F139 TaskSpec_P1 schedule seam）。 |
| 一句话 | GitHub 是外部真相；codeteam 存的是“观察到哪、从哪开始等、等到了什么”，不是“谁拥有工作、该投递给谁”。 |
| 明确不含 | community-ops event log/case state、delivery/wake 生命周期（归 ball-custody + dispatch）、GitHub App / GitHub MCP server、IMAP/email 路径、GitLab v1、outbound comment/check、auto-merge/rebase、raw body 进 wake、token 进模型、第二套 message/event store。 |

**组件立场**

| 组件 | 立场 | codeteam 处理 |
|---|---|---|
| `GitHubWaitPredicate` / `GitHubWaitPredicateKind` | `reuse now` | 10 个 typed kind + duplicate/limit/observer 校验原样复用；未知 kind fail closed |
| `GitHubPrWaitBaseline` / `GitHubIssueWaitBaseline` | `reuse now` | registration snapshot 进 `waits.baseline_json`；cursor 与 baseline 分离 |
| `GitHubWaitFacts` / `GitHubWaitMatchedDelta` | `reuse now` | 归一化 facts + compact delta + sourceRef；raw body 不进 wake |
| `GitHubWaitRenewalBaseline` / `planWaitRenewal` | `reuse now` | N+1 用同一 observation 建 baseline；rearm_failed 显式投递 |
| `github-wait-renderer` | `adapt now` | 只产 content + sourceRef + tracking status；必须保留 #1392 AC-7 三纪律（tracking 未来自述、identityUnknown 正常告警、delta 带 sourceRef/无 body）；message 写入归 bubble/dispatch |
| `GitHubWaitLifecycleService` | `adapt now` | 生命周期 owner 仍是 `ball-custody`；github-signals 只提供 facts/predicate seam |
| `ReviewFeedbackTaskSpec` | `adapt now` | cursor 只在 observation/outcome durable 后推进；不直接投递 |
| `IssueCommentTaskSpec` | `adapt now` | collection/delivery 双 cursor；waitFactComments 不被社区分类器吞掉 |
| `CiCdCheckTaskSpec` / `CiCdRouter` | `adapt now` | empty rollup=pending；cancelled 非 pass/fail；billing limit=external_infrastructure；stale snapshot 拒绝 |
| `ConflictCheckTaskSpec` | `adapt now` | 只有 matched conflict 才能授权 repo write；auto-resolve v1 out-of-scope |
| `GitHubRepoWebhookHandler` | `reuse now` | HMAC → filter → allowlist → validate → dedup → normalize；webhook 只触发。v1 默认 polling 主路径；webhook opt-in，经反代/tunnel TLS 到 loopback |
| `comment-cursors` / `fetch-paginated` / `gh-process` / `gh-cli-env` | `reuse now` | `gh` CLI 是 canonical GitHub path；token 只进 daemon 子进程 env |
| `github-schedule-factories` / GitHub plugin schedule registry | `adapt now` | W5 F139 TaskSpec_P1 seam；plugin 只注册 schedule，不拥有 signal 语义 |
| `GitHub App / GitHub MCP server` | `drop` | 不安装/不调用；读走 `gh` CLI，写后置且需 human/policy gate |
| `community-ops` event log / case projector | `out-of-scope` | GitHub facts 可被 community-ops 消费，但 case truth 不在本 cell |
| `signal-intake` 通用 admitted-signal plane | `out-of-scope` | 本 cell 是 GitHub-specific source；不合并成通用 signal store |
| 第二套 GitHub observation/event store | `forbidden` | 用 `tasks.automation_state_json` + `waits` + `audit` + `forge_deliveries`，不建平行账本 |

## 2. clowder 架构

### 2.1 架构图

```text
GitHub (external truth)
  ├─ webhook (HMAC, x-github-delivery) ──► trigger only
  └─ REST/GraphQL via gh CLI ────────────► reconciliation truth
            │
            ▼
GitHub collectors (F139 TaskSpec_P1)
  ├─ review feedback: inline / conversation / decision / review threads
  ├─ CI: PR rollup + failure details
  ├─ conflict: mergeState
  └─ issue comments
            │
            ▼
normalized GitHubWaitFacts + per-source cursors/fingerprints
            │
            ▼
F280 wait lifecycle (ball-custody owner)
  ├─ registration baseline snapshot
  ├─ typed predicate matcher (pure)
  ├─ matched delta + sourceRef
  ├─ outcome persistence / generation / one-shot / auto-renew
  └─ delivery via Queue + connector
            │
            ├─ dispatch/transport: delivery + owner wake
            ├─ community-ops: case truth (separate owner)
            └─ W7/W8: read-only evidence projection
```

### 2.2 数据流

1. **Register**：`register_pr_tracking` / `register_issue_tracking` 创建 `pr_tracking` / `issue_tracking` task；同一 admission 冻结 `when[]`、owner fence、SLA，并读取 baseline snapshot（headSha、per-source cursors、decision/verdicts、CI bucket/fingerprint、mergeState、issue state）。
2. **Collect**：webhook 先验签并做 delivery-id 去重，然后只作为触发；collector 用 `gh` CLI / API 重新读取 PR/issue 当前事实；乱序/丢失由 API reconciliation 补齐。
3. **Normalize**：adapter 把 GitHub 原始 payload 归一成 `GitHubWaitFacts`；per-source cursor 只覆盖各自的 ID 空间；raw body 只进 matcher 的受众/严重度判断，不进 owner message。
4. **Observe**：`GitHubWaitLifecycleService.observe` 用 baseline + facts 跑 `matchGitHubWaitPredicates`；匹配则持久化 outcome + matched deltas；cursor 只在 observation/outcome durable 后推进。
5. **Delivery**：outcome 进 delivery outbox，由 `ball-custody` + `dispatch`/bubble 投递；renderer 只产 compact delta + sourceRef + tracking status；GitHub signals 不直接写 message、不直接唤醒。
6. **Renewal**：自动续约时 N+1 baseline 从**同一个 observation** 构建，不用延迟的新 API 读取；`rearm_failed` 仍投递事件并明确告知“现在没有在观察”。
7. **Terminal**：PR merged/closed、issue closed 后 wait terminalize，tracking task 收口；社区 external-review 若要继续观察，必须由 community-ops 的显式 policy 申请，不靠 stale tracker。
8. **Identity/audience**：注册时从 GitHub metadata 派生 subject author / maintainer / reviewer / issue participant；身份不明时 over-deliver 并显式 `identityUnknown` 告警，不静默丢评论。

### 2.3 状态机 / 生命周期

**A. Tracking task + wait generation**

```text
registered ──observe(no match)──► active (same generation; quiet baseline update)
    │                                  │
    │                                  ├── match ──► outcome pending ──► delivered
    │                                  │                 │
    │                                  │                 └── auto_renew ──► active gN+1
    │                                  │                 └── one-shot/terminal ──► terminalized
    │                                  └── PR merged/closed / issue closed ──► terminalized
    └── expired / cancelled ───────────────────────────────────────────────► terminalized
```

- one outcome per wait generation；同一 outcomeId 重放收敛到同一行，不产生第二次 wake。
- `rearm_failed` 是独立结果：事件仍投递，但必须明确“tracking 已结束”。
- `auto_renew=1` 的 tracking wait 在 match 后同事务安装 gN+1；`auto_renew=0` 的 one-shot 直接 terminal。

**B. Source cursors**

```text
collection cursor ──durable observation/event──► advance
delivery cursor   ──queue admission / intentional echo──► advance
```

- inline / conversation / decision / issue comment 各有独立 ID 空间，不能用一个 combined cursor 排序。
- collection cursor 只在 durable observation 后推进；delivery 失败不倒退 collection，只让 delivery cursor 停住重试。
- cursor 永远不回退；stale source 不能把 cursor 拉回旧值。

**C. CI bucket**

```text
pending ──non-empty positive rollup──► pass
   │
   ├── non-empty failing rollup ──────► fail
   ├── billing/spending-limit zero-step ─► external_infrastructure
   └── empty rollup ──────────────────► pending（永不按时长晋升）
```

- `cancelled` 既不是 fail 也不是 pass；cancelled-only 仍是 pending。
- `pass` 至少需要一个真 positive check；空集合没有资格支撑 terminal verdict。

**D. Review verdict**

```text
decisionCursor + verdicts map
  ├─ new review above cursor ──► decision changed
  ├─ review of old HEAD after push ──► not a new approval of current HEAD
  └─ DISMISSED in place ──► verdict state change（cursor 不动，必须全量 fetch reviews）
```

**E. Conflict**

```text
MERGEABLE ──► CONFLICTING ──► matched pr_became_conflicting
     ▲                              │
     └──────── resolved ────────────┘（fingerprint 清空，允许 re-conflict）
```

**F. Webhook delivery**

```text
received ──HMAC ok──► dedup claim ──normalize──► admit/deliver ──► confirm
   │                       │                         │
   └── bad signature 403   └── duplicate skip        └── failure rollback（GitHub 可重试）
```

### 2.4 关键数据结构

```ts
// packages/shared/src/types/github-wait.ts:28,386,451,510,523
type GitHubWaitPredicate =
  | { kind: 'pr_head_changed' }
  | { kind: 'pr_review_result_available'; triggerCommentId?: number }
  | { kind: 'pr_review_decision_changed' }
  | { kind: 'pr_review_thread_changed'; reviewThreadIds: readonly string[] }
  | { kind: 'pr_ci_terminal' }
  | { kind: 'pr_became_conflicting' }
  | { kind: 'pr_conversation_comment_added'; authorLogins?: readonly string[]; audience?: GitHubCommentAudienceV1 }
  | { kind: 'pr_inline_comment_added'; authorLogins?: readonly string[]; audience?: GitHubCommentAudienceV1 }
  | { kind: 'issue_comment_added'; authorLogins?: readonly string[]; audience?: GitHubCommentAudienceV1 }
  | { kind: 'issue_author_commented' };

interface GitHubPrWaitBaseline {
  capturedAt: number;
  headSha: string;
  review?: { inlineCommentCursor: number; conversationCommentCursor: number; decisionCursor: number; decision?: string; verdicts?: GitHubReviewVerdicts; threads?: GitHubReviewThreadBaseline[] };
  ci?: { bucket: GitHubCiBaselineBucket; fingerprint: string };
  conflict?: { mergeState: string };
}

interface GitHubWaitMatchedDelta {
  kind: GitHubWaitPredicateKind;
  delta: string;
  sourceRef?: string;
  identityUnknown?: true;
}
```

```ts
// packages/shared/src/types/github-wait.ts:111,152
type GitHubCommentAudienceV1 =
  | { mode: 'everyone_but_self'; selfLogin: string }
  | { mode: 'subject_author_only'; subjectAuthorLogin: string }
  | { mode: 'unresolved_identity'; missing: readonly GitHubTrackingIdentityGap[] };

type GitHubNotificationPerspective =
  | { role: 'subject_author'; selfLogin: string }
  | { role: 'maintainer_or_reviewer'; selfLogin: string; subjectAuthorLogin: string; ground: GitHubReviewerGround }
  | { role: 'issue_participant'; selfLogin: string }
  | { role: 'unresolved'; missing: readonly GitHubTrackingIdentityGap[] };
```

```ts
// packages/shared/src/types/task.ts:152,164
interface PrAutomationState {
  ci?: CiAutomationState;
  conflict?: ConflictAutomationState;
  review?: ReviewAutomationState;
  closedAt?: number;
  await?: GitHubPrAwaitStateV1;       // clowder shape; codeteam drops from task JSON
  waitOutcome?: GitHubWaitOutcomeV1;  // clowder shape; codeteam keeps in waits
}

interface IssueWaitAutomationState {
  issue?: IssueAutomationState;
  closedAt?: number;
  await?: GitHubIssueAwaitStateV1;    // clowder shape; codeteam drops from task JSON
  waitOutcome?: GitHubWaitOutcomeV1;  // clowder shape; codeteam keeps in waits
}
```

### 2.5 Current truth 与代码路径

| # | 事实 | 代码/文档锚点 |
|---|---|---|
| T1 | 10 个 typed predicate kind；limit 从 catalog 派生；重复 kind 拒绝 | `packages/shared/src/types/github-wait.ts:28`、`:43`、`:386` |
| T2 | identity/audience 在注册时 server 派生；unresolved 有显式 missing 维度 | `packages/shared/src/types/github-wait.ts:111`、`:152` |
| T3 | baseline 分 PR/issue 形状；matched delta 带 sourceRef/identityUnknown；outcome 带 renewal/deliveryPriority | `packages/shared/src/types/github-wait.ts:451`、`:510`、`:523` |
| T4 | predicate schema 逐 kind strict；observer map 显式列出谁能观察；review-only wait 可被识别 | `packages/api/src/domains/github-signals/GitHubWaitPredicateCatalog.ts:34`、`:106`、`:122` |
| T5 | matcher 是 pure function；评论按 surface frontier；dismissal 用 verdict map 而非 cursor | `packages/api/src/domains/github-signals/GitHubWaitPredicateCatalog.ts:331`、`:355`、`:366` |
| T6 | registration baseline 分别取 inline/conversation/decision cursor；review 全量读取，不只 cursor | `packages/api/src/domains/github-signals/GitHubWaitBaselineReader.ts:52`、`:91`、`:92`、`:93` |
| T7 | N+1 baseline 用同一 observation 构建；HEAD 变化时 CI/mergeState 进入 unobserved/pending | `packages/api/src/domains/github-signals/GitHubWaitRenewalBaseline.ts:41`、`:44`、`:177`、`:196` |
| T8 | renderer 只输出 compact delta/sourceRef/tracking status；identityUnknown 有显式告警 | `packages/api/src/domains/github-signals/github-wait-renderer.ts:28`、`:52`、`:94` |
| T9 | lifecycle 持久化 outcome、generation、outbox；`unrecorded` 明确要求 source 重采 | `packages/api/src/domains/github-signals/GitHubWaitLifecycleService.ts:220`、`:414`、`:96` |
| T10 | review collector：每源 cursor；review 全量 fetch；cursor 只在 route 后提交 | `packages/api/src/infrastructure/email/ReviewFeedbackTaskSpec.ts:9`、`:64`、`:112`、`:452`、`:989` |
| T11 | issue collector：collection/delivery 双 cursor；waitFactComments 不被社区分类器吞掉 | `packages/api/src/infrastructure/email/IssueCommentTaskSpec.ts:10`、`:11`、`:43`、`:193` |
| T12 | CI collector 拒绝 stale snapshot；empty rollup 保持 pending | `packages/api/src/infrastructure/email/CiCdCheckTaskSpec.ts:119`、`:132`；`packages/api/src/infrastructure/email/CiCdRouter.ts:160` |
| T13 | CI bucket 含 external_infrastructure；billing zero-step 不当 code fail | `packages/api/src/infrastructure/email/ci-cd-contract.ts:3`、`:4`；`packages/api/src/infrastructure/email/CiCdRouter.ts:120` |
| T14 | conflict auto-resolve 只认 matched `pr_became_conflicting` | `packages/api/src/infrastructure/email/ConflictCheckTaskSpec.ts:62`、`:75` |
| T15 | webhook HMAC 403；delivery id 缺失 400、重复 skip；失败 rollback | `packages/api/src/infrastructure/connectors/github-repo-event/GitHubRepoWebhookHandler.ts:87`、`:111`、`:116` |
| T16 | GitHub pollers 由 plugin schedule factory 注册；factoryId 白名单 | `packages/api/src/domains/plugin/github-schedule-factories.ts`；`packages/api/src/plugins/github/plugin.yaml:31` |
| T17 | task automation state 分 PR/issue 形状，类型级隔离 ci/conflict/review/issue | `packages/shared/src/types/task.ts:152`、`:164` |
| T18 | 注册入口是 `register_pr_tracking` / `register_issue_tracking` | `packages/api/src/routes/callbacks.ts:5698`、`:5991` |
| T19 | community-ops 拥有 case/external-review；GitHub predicate 由本 cell 提供 | `docs/architecture/ownership/cells/community-ops.md:53`；`docs/architecture/ownership/cells/signal-intake.md:89` |
| T20 | `gh` CLI 是 canonical path；token 只进 daemon 子进程 env | `packages/api/src/infrastructure/github/gh-process.ts:13`、`:30`；`packages/api/src/infrastructure/github/gh-cli-env.ts:30` |
| T21 | `forge_deliveries` 已存在，用于 webhook delivery-id 去重/对账 | `codeteam/architecture/0001-codeteam-architecture-v1.md:1429`、`:1481`、`:1914` |
| T22 | empty rollup 永不晋升；cancelled 非 pass/fail；wakePolicy 只按 GitHub user.type 分类 | `docs/features/F133-cicd-tracking.md:7`；`docs/features/F140-github-pr-automation.md:196`、`:206` |
| T23 | GitHub MCP/App 工具已退役；配置迁移会过滤已知实现 | `packages/api/src/config/capabilities/retired-github-mcp.ts:67`、`:74` |
| T24 | A1-4 的 API 只绑 loopback；W8 webhook 不能直接打进来，v1 默认 polling、webhook opt-in + 反代/tunnel | `codeteam/architecture/reuse-review/runtime-deployment.md:56`、`:291` |
| T25 | A1-2 禁的是 per-run agent token 进 env；GitHub read token 走 daemon→gh 受信子进程 env 是另一条通道 | `codeteam/architecture/reuse-review/callback-auth.md:30`、`:45` |
| T26 | `audit` 默认不删除、`(subject,ts)` 索引；backlog 投影 newest-first 100 条，不能被高频 observation 洪水淹没 | `codeteam/architecture/0001-codeteam-architecture-v1.md:1462`、`:1514` |

### 2.5.1 上游已知缺口 → 本卡处置

| # | 上游缺口 | 影响 | 本卡处置 |
|---|---|---|---|
| G1 | webhook 只是触发，不是真相；payload 可乱序/伪造 | 直接用 payload 会误判状态 | API reconciliation 为真相；webhook 只触发；HMAC + delivery-id 去重 |
| G2 | collector cursor 被当通知 baseline | 会吞掉注册前/已过滤事件，或重复唤醒 | cursor 只做采集幂等；baseline 是独立 registration snapshot |
| G3 | review dismissal 原地改状态，cursor 不动 | 只按 cursor 取 review 会漏 dismissal | 每轮全量 fetch reviews + verdicts map；dismissal 单独匹配 |
| G4 | empty rollup 被按时长晋升为 pass | 无 CI 的仓库被误报绿灯 | empty rollup 永远 pending；pass 需真 positive check |
| G5 | cancelled run 被当 fail 或 pass | superseded run 假失败/假成功 | cancelled 非 fail 非 pass；cancelled-only 仍 pending |
| G6 | billing/spending-limit zero-step 被当 code fail | 外部基础设施问题误伤代码结论 | 单独 `external_infrastructure` bucket；不授权 merge |
| G7 | 身份/角色未知时静默丢评论 | owner 无法知道覆盖没建立 | over-deliver + `identityUnknown` 告警；不静默 drop |
| G8 | legacy combined comment cursor 跨 endpoint 不可比 | 迁移窗口漏事件或重复 | 每源从零 backfill + frozen snapshot frontier；历史 backfill 只 state-only |
| G9 | community-ops 需要 terminal 后继续观察 | 默认 tracker 收口会断掉社区 case | 显式 `continueDoneTracking`/policy hook；不在本 cell 默认续命 |
| G10 | GitHub App / GitHub MCP server 工具已退役 | 走旧工具会绕过 canonical path | `gh` CLI + webhook HMAC；不安装/不调用 GitHub MCP server / App |
| G11 | token 可能进模型/日志 | 凭证泄露 | daemon-only、最小 scope、redaction；模型不可见 |
| G12 | 采集事件与投递事件混成一个账本 | 重复投递/丢事件 | collection cursor + delivery cursor/outbox 分离；outcome 按 outcomeId 幂等 |
| G13 | GitLab 与 GitHub 语义不同 | 假承诺跨 provider | v1 GitHub-only；`ForgeAdapter` 只留 seam，不声明 GitLab 已支持 |
| G14 | PR 转回 draft 可能 dismiss 既有 reviews | 已批准状态静默蒸发 | verdict map 全量 fetch + `draft/reset` contract test；dismissal 作为 decision change |
| G15 | A1-4 API loopback 与 GitHub 公网 webhook 冲突 | W8 开工撞部署前提 | v1 默认 polling 主路径；webhook opt-in + 反代/tunnel TLS 到 loopback；`CODETEAM_GITHUB_WEBHOOK_ENABLED=0` |
| G16 | 每次 no-match observation 写 audit | 60s × 60 subjects 把 operator mutation 时间线挤出前 100 条 | audit 只记 state-changing observation；no-match 只写 collector state + metrics |
| G17 | 同 subject 并发/重复注册 | 双 task、双 wait、双唤醒 | `tasks(subject_key)` partial unique；同 kind 注册 replay 既有 task/wait |
| G18 | tracking status 只有 push 时自述 | operator 事后无法查询“还在观察吗” | tracking status 是 tasks+waits 的纯派生只读投影，不建第三套 status store |

## 3. codeteam 架构

### 3.1 架构图

```text
GitHub external truth
  ├─ POST webhook ──► HMAC + x-github-delivery ──► forge_deliveries dedup ──► trigger
  └─ gh CLI / REST/GraphQL ─────────────────────► API reconciliation truth
            │
            ▼
ForgeSignalAdapter (GitHub v1)
  ├─ PR review / CI / conflict / issue collectors
  ├─ normalized GitHubWaitFacts + sourceRef
  ├─ permission evidence (actor/association/label/mention)
  └─ collector state writer
            │
            ▼
tasks (kind=pr_tracking|issue_tracking)
  └─ automation_state_json: review/ci/conflict/issue cursors/fingerprints
            │
            ▼
waits (ball-custody owner)
  ├─ baseline_json: registration snapshot
  ├─ continuation_json: when[] / owner fence
  ├─ outcome_json: matched deltas / sourceRefs / renewal
  └─ generation / auto_renew / terminalized
            │
            ▼
dispatch + bubble-pipeline
  └─ Queue / connector message / owner wake
```

### 3.2 数据流

1. **Register**：MCP `register_pr_tracking` / `register_issue_tracking` → 先捕获 baseline snapshot（外部 API，含 per-source cursor/headSha/verdicts），再在**同一 SQLite transaction** 写 `tasks` row + `waits` row（`kind='event'`、`wait_source_ref`、`expected_signal`、`baseline_json`、`continuation_json`、owner fence、SLA）；外部 API 不包在长事务里，baseline 用 snapshot frontier 避免注册窗口丢事件。`tasks(subject_key)` 加 partial unique：同 subject 同 kind 注册返回既有 task/wait（replay），不同 kind 允许。
2. **Webhook trigger**：v1 默认 **polling 主路径**，webhook 是可选延迟优化（`CODETEAM_GITHUB_WEBHOOK_ENABLED=0`）。启用时：operator 配置的反代/tunnel 终止 TLS 后转发到 loopback；反代带可信来源标记（来源 IP/共享 header）；HMAC 验签 → `forge_deliveries` claim delivery id → 解析 repo/number → 不直接信 payload；触发对应 subject 的 API reconciliation。
3. **Poll/reconcile**：collector 按 subject 读取 GitHub 当前事实；per-source cursor/fingerprint 写入 `tasks.automation_state_json`；只轮询已注册/allowlist subject，不扫全仓。
4. **Normalize**：`ForgeSignalAdapter` 输出 `GitHubWaitFacts`；body 只用于受众/严重度判断，不写 wake；comment/author metadata 带 sourceRef。
5. **Observe**：`ball-custody` 的 wait lifecycle 调 `matchGitHubWaitPredicates`；matched 时持久化 outcome + matched deltas；`tasks.automation_state_json` 的 cursor 只在 durable observation/outcome 后推进。
6. **Deliver**：outcome 进 outbox；`dispatch`/bubble 按 `deliveryPriority` 投递；renderer 只产 compact content；GitHub signals 不写 `messages`、不直接 wake。
7. **Renew/terminal**：auto-renew 用同一 observation 安装 gN+1；one-shot/terminal 收口；PR merged/closed、issue closed 时 task/wait 终止；community-ops 只可通过显式 policy 续跟踪。
8. **Audit**：**只记 state-changing observation**（matched outcome、terminal、rearm_failed、cursor 迁移里程碑、dedup 拒绝、permission-denied）；no-match tick 只更新 collector state/fingerprint 与 metrics，不写 `audit`，避免把 operator 的 mutation 时间线挤出 newest-first 100 条。audit 不存 raw body/secrets；不建第二事件账本。
9. **Tracking status read model**：operator 的“还在观察吗”读面是 `tasks(kind=pr/issue_tracking)` + `waits` 的纯派生投影（registered predicates、generation、expires/SLA、last outcome+reason、observation lag、rearm 状态）；不建第三套 GitHub status store。字段口径与 renderer 的 `observing / stopped(reason) / unarmed` 三行一致，落点归 W7a。

### 3.3 状态机 / 生命周期

**A. Tracking task + wait**

```text
task: todo/doing ──register──► active ──terminal/expired──► done
wait: active gN ──match──► outcome pending ──deliver──► delivered
  │                         │
  │                         ├── auto_renew=1 ──► active gN+1（same observation baseline）
  │                         └── auto_renew=0 / terminal ──► terminalized
  └── no match + HEAD moved ──► active gN（quiet baseline follows HEAD）
```

- `waits.status` 是 canonical；`tasks.status` 只是 tracking task 生命周期，不替代 wait 状态。
- `waits.outcome_delivery` 是 pending/delivered/suppressed/queue_conflict/not_applicable；delivery 不是 success。
- `waits.generation` 每次 renewal +1；旧 generation 的 outcome 不得消费新 generation。

**B. Source cursor**

```text
inline cursor ─┐
conversation ──┼─► tasks.automation_state_json.review
decision ──────┘
issue comment ─► tasks.automation_state_json.issue
CI ────────────► tasks.automation_state_json.ci (headSha/lastFingerprint/lastBucket)
conflict ──────► tasks.automation_state_json.conflict (mergeState/lastFingerprint)
```

- 每源 cursor 单调；stale observation 不能回退。
- collection 与 delivery 分离：collection 只在 durable observation 后推进；delivery 失败只停 delivery cursor/outbox，不吞事件。

**C. Webhook delivery**

```text
received ──HMAC fail──► 403
   │
   └── HMAC ok ──► delivery-id claim
                       ├─ duplicate ──► skip
                       └─ new ──► trigger/reconcile ──► confirm
                                          └─ failure ──► rollback（GitHub retry）
```

**D. CI**

```text
pending ──positive non-empty──► pass
   ├── failing non-empty ─────► fail
   ├── billing zero-step ─────► external_infrastructure
   └── empty rollup ──────────► pending（不按时间晋升）
```

**E. Review**

```text
decisionCursor + verdicts map
  ├─ new review id > cursor ──► decision changed
  ├─ review of old HEAD after push ──► not current-HEAD approval
  ├─ DISMISSED in place ──► verdict state change（全量 reviews 才能看到）
  └─ PR → draft / review reset ──► dismissed verdicts 也按 decision change 报
```

- Contract test：PR 转 draft/reset 后，既有 approved/changes-requested verdict 的 dismissal 必须产出 decision change；不允许静默蒸发。

**F. Identity/audience**

```text
selfLogin + subjectAuthorLogin + reviewerGround
  ├─ self == author ──► everyone_but_self
  ├─ reviewer ground ──► subject_author_only
  ├─ issue ──► everyone_but_self
  └─ unresolved ──► unresolved_identity + identityUnknown warning
```

**G. Registration idempotency**

```text
register(subject, kind)
  ├─ same subject + same kind ──► replay existing task/wait（不新建）
  ├─ same subject + different kind ──► allow（subject_key 前缀不同）
  └─ concurrent insert ──► partial unique 冲突 → replay winner
```

### 3.4 关键数据结构与存储

| 数据 | clowder | codeteam | 立场 |
|---|---|---|---|
| tracking task | `TaskItem(kind=pr_tracking/issue_tracking)` | `tasks.kind` + `tasks.subject_key` + partial unique `(subject_key)` | `reuse` |
| collector state | `TaskItem.automationState` | `tasks.automation_state_json`（只存 review/ci/conflict/issue，不存 await/waitOutcome） | `adapt` |
| registration baseline | `GitHubPrWaitBaseline` / `GitHubIssueWaitBaseline` | `waits.baseline_json` | `reuse` |
| wait predicates | `continuation.when[]` | `waits.continuation_json.when[]` | `reuse` |
| matched outcome | `GitHubWaitOutcomeV1` | `waits.outcome_json` | `reuse` |
| wait lifecycle | `AwaitState` / `wait-state-machine` | `waits` + ball-custody state machine | `adapt` |
| webhook dedup | Redis delivery dedup | `forge_deliveries` | `adapt` |
| observation audit | event log / run_events | `audit`（只 state-changing：matched/terminal/rearm_failed/migration/dedup/permission-denied） | `adapt` |
| tracking status | none（renderer push 文本） | 从 `tasks` + `waits` 纯派生只读投影，无新表 | `new`（projection only） |
| delivery | Queue / MessageStore | `queue_entries` + `messages`（dispatch/bubble owner） | `out-of-scope` |
| community case | `CommunityEventLog` | none | `out-of-scope` |
| token | gh env / plugin config | daemon child env only | `reuse` |

**§12.2 回写清单**

- **无新表/新列**：v1 复用 `tasks.automation_state_json`、`waits.baseline_json/continuation_json/outcome_json`、`audit`、`forge_deliveries`。
- **新增 partial unique index**：`CREATE UNIQUE INDEX idx_tasks_tracking_subject ON tasks(subject_key) WHERE kind IN ('pr_tracking','issue_tracking')`；同 subject 同 kind 注册 replay 既有 task/wait，换 kind 允许（subject_key 前缀不同）。
- 约定：`tasks.kind ∈ pr_tracking|issue_tracking`；`tasks.subject_key` 复用 clowder `pr:<owner>/<repo>#<n>` / `issue:<owner>/<repo>#<n>`；`waits.kind='event'`；`wait_source_ref = github:pr:<owner>/<repo>#<n>` / `github:issue:<owner>/<repo>#<n>`；`baseline_json` 放 `GitHubPrWaitBaseline`/`GitHubIssueWaitBaseline`；`continuation_json.when[]` 放 typed predicates；`outcome_json` 放 `GitHubWaitOutcomeV1`。
- `tasks.automation_state_json` 只存 review/ci/conflict/issue collector state；**不复制** `await`/`waitOutcome`，避免与 `waits` 双真相。
- `audit.action='github.observed'`，`audit.subject='forge:<repo>#<n>'`；**只记 state-changing observation**，no-match tick 不写 audit；只存 sourceRefs/digests/permissionEvidence，不存 raw body/secret。
- tracking status 是 `tasks(kind=pr/issue_tracking)` + `waits` 的纯派生只读投影（observing / stopped(reason) / unarmed + predicates/generation/expires/last outcome/lag），不建第三套 status store；落 W7a。
- GitHub review/CI 事实只进 `waits.outcome_json` / `tasks.automation_state_json`，**不写 W3 `reviews` 表**；内部 ReviewPolicy 的 review 是独立流程。
- `pr_merged` 不在 v1 10 kinds；`ActionTerminalPredicate` 已有该 kind，W8 若需要独立 merge 观察再接 catalog；v1 只作 merge service 的外部观察事实，不作 custody predicate，不另造第二 catalog。

```ts
// codeteam mapping (not a new schema)
interface ForgeWaitContinuation {
  when: readonly GitHubWaitPredicate[];
  then?: string;
}

interface ForgeCollectorState {
  review?: { lastInlineCommentCursor?: number; lastConversationCommentCursor?: number; lastDecisionCursor?: number; verdicts?: GitHubReviewVerdicts; commentCursorMigrationPending?: boolean };
  ci?: { headSha?: string; lastFingerprint?: string; lastBucket?: GitHubCiBaselineBucket };
  conflict?: { mergeState?: string; lastFingerprint?: string };
  issue?: { lastCommentCursor?: number; lastDeliveredCursor?: number; issueState?: 'open' | 'closed' };
}

interface ForgeTrackingStatus { // read-only projection; no new store
  subjectRef: string;
  state: 'observing' | 'stopped' | 'unarmed';
  predicates: readonly GitHubWaitPredicateKind[];
  generation: number;
  expiresAt?: number;
  lastOutcome?: { reason: string; matched?: readonly GitHubWaitMatchedDelta[]; at: number };
  observationLagMs?: number;
  rearmState?: 'rearmed' | 'rearm_failed';
}
```

### 3.5 变量定义表

#### contract

| 变量 | 类型 | 默认/值域 | owner | clowder 来源 | 决定 | 说明 |
|---|---|---|---|---|---|---|
| `ForgeProvider` | enum | `github`（v1）；`gitlab` defer | forge/github-signals | W8 ForgeAdapter | `extend` | 只留 seam，不假承诺 GitLab |
| `ForgeSubjectRef` | string | `github:pr:<owner>/<repo>#<n>` / `github:issue:<owner>/<repo>#<n>` | github-signals | `GitHubWaitSubjectRef` | `adapt` | 内层复用 clowder `pr:<owner>/<repo>#<n>`；外层加 provider 前缀 |
| `GitHubWaitPredicateKind` | enum | 10 kinds | github-signals | `packages/shared/src/types/github-wait.ts:28` | `reuse` | 未知 kind fail closed |
| `GitHubWaitPredicate` | union | 见 §2.4 | github-signals | `packages/shared/src/types/github-wait.ts:386` | `reuse` | strict schema；duplicate kind 拒绝 |
| `GitHubWaitPredicateReserved` | enum | `pr_merged`（v1 不启用） | github-signals | `packages/shared/src/types/action-successor.ts:28` | `defer` | v1 tracking 不依赖；`pr_merged` 只作 merge 的外部观察事实，不作 v1 custody predicate；W8 再接 catalog，不另造 |
| `GitHubPrWaitBaseline` / `GitHubIssueWaitBaseline` | JSON | registration snapshot | github-signals | `packages/shared/src/types/github-wait.ts:451` | `reuse` | 进 `waits.baseline_json` |
| `GitHubWaitFacts` | object | head/review/ci/conflict/issue | github-signals | `GitHubWaitPredicateCatalog.ts` | `reuse` | 归一化事实；raw body 只给 matcher |
| `GitHubWaitMatchedDelta` | object | kind/delta/sourceRef/identityUnknown | github-signals | `packages/shared/src/types/github-wait.ts:510` | `reuse` | wake 只带 compact delta |
| `GitHubWaitOutcomeV1` | JSON | matched/renewal/deliveryPriority/terminalSubjectState | ball-custody + github-signals | `packages/shared/src/types/github-wait.ts:523` | `reuse` | 进 `waits.outcome_json`；terminalSubjectState 供 renderer 区分 merged/closed |
| `GitHubTrackingIdentity` / `GitHubNotificationPerspective` | object | server-derived | github-signals | `packages/shared/src/types/github-wait.ts:111`、`packages/shared/src/types/github-wait.ts:152` | `reuse` | 注册时冻结；unresolved 有告警 |
| `ForgeEvent` / `ForgeDelivery` | object | provider/kind/action/repo/number/deliveryId | github-signals | W8 plan | `adapt` | webhook 只触发；API 对账 |
| `ForgePermissionEvidence` | object | actor/association/label/mention/permission | github-signals | W8 plan | `extend` | 只做只读 evidence；label 不单独放行 |

#### state

| 变量 | 状态机/约束 | owner | 失败语义 |
|---|---|---|---|
| `tasks.kind` | `pr_tracking` / `issue_tracking` | github-signals | 其他 kind 不接 GitHub wait |
| `tasks.subject_key` | `pr:<owner>/<repo>#<n>` / `issue:<owner>/<repo>#<n>`；partial unique `(subject_key)` | github-signals | 非法/缺失 → 拒绝注册；同 subject 同 kind 并发 → replay winner |
| `tasks.automation_state_json.review.*Cursor` | 每源单调；不回退 | github-signals | stale source 不回退；持久化失败保留旧 cursor 重试 |
| `tasks.automation_state_json.review.commentCursorMigrationPending` | legacy combined cursor 迁移中；历史 backfill 只 state-only；**greenfield v1 恒 null/删除**，只留作 clowder 数据迁入预留 | github-signals | source 未到 snapshot frontier → 保持 pending，不投递历史；v1 不造永不触发的迁移分支 |
| `tasks.automation_state_json.ci.lastFingerprint` | `headSha:bucket`；HEAD 变化重置 | github-signals | stale snapshot 拒绝 |
| `tasks.automation_state_json.conflict.mergeState` | mergeState 迁移；resolved 清 fingerprint | github-signals | 非 matched conflict 不授权 write |
| `tasks.automation_state_json.issue.lastDeliveredCursor` | collection ≥ delivery；不倒退 | github-signals | delivery 失败保留 delivery cursor 重试 |
| `waits.status` | active → terminalized | ball-custody | 非法迁移 409；terminal 不复活 |
| `waits.generation` | 每次 renewal +1 | ball-custody | stale generation 不消费 |
| `waits.auto_renew` | tracking=1；one-shot=0 | ball-custody | rearm 失败仍投递并标注 |
| `waits.expires_at` | GitHub tracking 显式传 7d 默认；非 GitHub event wait 不受此默认 | github-signals + ball-custody | expired 仍 wake 并自述；缺省只在非 GitHub wait 表示无时间终止 |
| `waits.outcome_delivery` | pending → delivered/suppressed/queue_conflict/not_applicable | ball-custody | 非 pending 不重复投递 |
| `waits.owner_fence_json` | exact containing_task/action_successor | ball-custody | 缺失 → legacy_unfenced，no wake |
| `forge_deliveries.status` | claimed → processed/failed | github-signals | 重复 delivery id skip；失败可 retry |
| `trackingStatus` | tasks+waits 纯派生：observing/stopped(reason)/unarmed | W7a | 不建第三套 status store |

#### config

| 变量 | 默认 | owner | 决定 | 说明 |
|---|---|---|---|---|
| `CODETEAM_GITHUB_POLL_INTERVAL_MS` | 60000 | github-signals | `new` | PR/issue review/CI 轮询 |
| `CODETEAM_GITHUB_CONFLICT_INTERVAL_MS` | 300000 | github-signals | `new` | conflict 轮询更慢 |
| `CODETEAM_GITHUB_MAX_SUBJECTS_PER_TICK` | 60 | github-signals | `new` | 单 tick 上限，避免长尾 |
| `CODETEAM_GITHUB_WEBHOOK_SECRET` | 无默认 | W8/security | `new` | 缺失时 webhook 禁用，不 fail-open |
| `CODETEAM_GITHUB_WEBHOOK_ENABLED` | 0 | W8/security | `new` | v1 默认 polling 主路径；webhook opt-in |
| `CODETEAM_GITHUB_WEBHOOK_MAX_BODY_BYTES` | 1048576 | W8/security | `new` | 验签前读取上限；超限 413 |
| `CODETEAM_GITHUB_WEBHOOK_TRUSTED_PROXY_HEADER` | 无默认 | W8/security | `new` | 反代/tunnel 可信来源标记；缺失时不信任 forwarded 来源 |
| `CODETEAM_GITHUB_RATE_LIMIT_BACKOFF_MAX_MS` | 600000 | github-signals | `new` | 429 时指数退避上限；不降级为静默停采 |
| `CODETEAM_GITHUB_REPO_ALLOWLIST` | 空 | github-signals | `new` | 空=只接显式注册的 subject；repo-scan 必须显式 allowlist |
| `CODETEAM_GITHUB_WAIT_TTL_MS` | 604800000（7d） | github-signals | `new` | tracking waits 显式写 `expires_at`；与 A3-1“非 GitHub event wait 缺省无时间终止”有意区分 |
| `CODETEAM_GITHUB_IDENTITY_CACHE_TTL_MS` | 300000 | github-signals | `new` | self/author/reviewer ground 缓存 |
| `CODETEAM_GITHUB_LEGACY_CURSOR_BACKFILL` | 1 | github-signals | `new` | 旧 combined cursor 迁移；只 state-only |
| `CODETEAM_SQLITE_BUSY_TIMEOUT_MS` | 见 plans/0002 W1 | 全局 | `reference` | wait/task transaction |

#### security

| 变量/规则 | 值/来源 | owner | 失败语义 |
|---|---|---|---|
| `webhookHmac` | `x-hub-signature-256` + secret | github-signals | 验签失败 403；不处理 payload |
| `hmacCompare` | constant-time compare（`crypto.timingSafeEqual`） | W8/security | 长度不等/比较失败 → 403 |
| `webhookBodyLimit` | `CODETEAM_GITHUB_WEBHOOK_MAX_BODY_BYTES` | W8/security | 超限 413；验签前不无限读 body |
| `webhookSecretStorage` | A1-2 credential 管理：config 0600 或 env，二选一 | W8/security | 不进 agent 面/日志；缺失禁用 webhook |
| `webhookProxyTrust` | 反代/tunnel 终止 TLS；来源 IP/共享 header 可信判定 | W8/security | 无可信标记 → 拒绝，不把 forwarded 头当身份 |
| `deliveryIdDedup` | `forge_deliveries` 按 `(provider, delivery_id)` claim | github-signals | duplicate skip；失败 rollback 让 GitHub retry |
| `repoAllowlist` | configured repos + `gh repo view` 校验 | github-signals | 未登记/不存在 repo 拒绝 |
| `permissionGate` | maintainer/collaborator；label/@ 只叠加 | W8/community-ops | 无权限只写只读 evidence，不进 task/inbox |
| `untrustedBody` | raw comment body untrusted | github-signals | 不进 wake/prompt；只给 matcher 做受众/严重度 |
| `identityAudience` | server-derived perspective | github-signals | unresolved → over-deliver + warning，不静默丢 |
| `selfEcho` | exact self-authored skip | github-signals | echo 推进 cursor 但不投递 |
| `setupNoise` | exact bot login + conversation + setup body | github-signals | 只吞 setup-only；真实 bot review/人类评论不吞 |
| `tokenBoundary` | daemon child env only；min scope；A1-2“不放 env”只指 per-run agent token | W2/W8 | 模型/prompt/logs 不出现 token；GitHub read token 走受信 gh 子进程通道 |
| `identitySnapshot` | 注册时点冻结 perspective/permission；运行时降权不追溯 | github-signals | over-deliver 有意覆盖；Phase C 多用户重审“发给无权者”风险 |
| `registerIdempotency` | 同 subject 同 kind replay；partial unique 兜底 | github-signals | 并发注册 → 复用 winner，不双 task/双 wait |
| `subjectIsolation` | repo + number + owner | github-signals | 跨 tenant/repo 不泄漏 |
| `terminalTruth` | API facts + typed outcome | github-signals | webhook payload/正文不裁决 terminal |
| `noOwnership` | 不写 handoffs/不直接 wake | github-signals | 越权写 → 403/拒绝 |

#### observability

| 变量/事件 | 值/来源 | owner | 说明 |
|---|---|---|---|
| `github_observation_total` | counter/repo/source/result | github-signals | 采集成功/失败 |
| `github_observation_lag_ms` | histogram/source | github-signals | cursor 落后时间 |
| `github_wait_matched_total` | counter/kind/subject | github-signals | matched delta |
| `github_wait_expired_total` | counter/subject | ball-custody | wait 过期 |
| `github_wait_rearm_failed_total` | counter/subject | ball-custody | 续约失败 |
| `github_cursor_persist_failure_total` | counter/subject/source | github-signals | cursor 持久化失败 |
| `github_webhook_signature_rejected_total` | counter/repo | github-signals | 验签失败 |
| `github_webhook_body_rejected_total` | counter/repo/reason | github-signals | body 超限/读取失败 |
| `github_webhook_dedup_total` | counter/repo/reason | github-signals | duplicate delivery |
| `github_rate_limit_total` | counter/repo | github-signals | 429/rate limit |
| `github_identity_unknown_total` | counter/subject/missing | github-signals | identity unresolved |
| `github_ci_empty_rollup_total` | counter/repo/head | github-signals | empty rollup 持续 |
| `github_ci_external_infrastructure_total` | counter/repo/head | github-signals | billing/infra |
| `github_delivery_pending_total` | gauge/outcomeId | ball-custody | outbox pending |
| `github_register_replay_total` | counter/subject/kind | github-signals | 幂等注册命中 |
| `github_tracking_status_read_total` | counter/state | W7a | 只读 tracking status 投影 |
| `github_permission_denied_total` | counter/repo/actor | W8 | 无权限事件 |

### 3.6 明确不做

- 不建第二套 message/event/observation store；`tasks` + `waits` + `audit` + `forge_deliveries` 是唯一落点。
- 不拥有球权/投递：不写 `handoffs`、不写 `messages`、不直接唤醒；只产 facts/matched delta。
- 不复制 community-ops `CommunityEventLog`/case state；GitHub facts 只能被消费，不成为 case truth。
- 不安装/不调用 GitHub App / GitHub MCP server 工具；`gh` CLI 是 canonical path。
- 不恢复 IMAP/email review 路径；F140 Phase E 已下线。
- 不承诺 GitLab v1；只留 `ForgeAdapter` seam。
- 不把 webhook payload 当真相；API reconciliation 才是真相。
- 不让 webhook 直接暴露公网 daemon：v1 默认 polling，webhook opt-in + 反代/tunnel TLS 到 loopback。
- 不把 cursor 当 notification baseline；不把 collection failure 当 delivery failure（反之亦然）。
- 不把 no-match 轮询写进 `audit`；audit 只记 state-changing observation，避免淹没 operator mutation 时间线。
- 不把 empty rollup 晋升 pass；不把 cancelled 当 fail/pass；不把 billing zero-step 当 code fail。
- 不从 Bot/User、repo visibility、author role、comment prose 推断 actionability。
- 不把 raw comment body 放进 wake；不把 token 放进模型/prompt/logs。
- 不把 GitHub review/CI 事实写进 W3 `reviews` 表；内部 ReviewPolicy 是独立流程。
- 不把 `pr_merged` 提前塞进 v1 10 kinds；`ActionTerminalPredicate` 已有该 kind，W8 若需要独立 merge 观察再接；v1 的 terminal truth 是 `merges` receipt。
- 不建第三套 tracking status store；状态从 `tasks` + `waits` 纯派生，落 W7a。
- 不做 outbound comment/check、C 类 auto-merge/rebase；D 的 merge-owner execution 独立归 merge-gate/merge-owner contract。
- 不把“已匹配”当“已投递”或“已处理”；matched ≠ delivered ≠ handled。

### 3.7 与相邻 cell 的边界

- `ball-custody` owns `waits`/AwaitState/generation/owner fence/outcome delivery；github-signals provides predicates/facts/baseline.
- `dispatch` owns Queue/claim/delivery/wake；github-signals 不写 Queue、不直接 wake。
- `bubble-pipeline` owns message identity/dispatchRefs/timeline；github-signals 的 renderer 只产 content，不写 message。
- `community-ops` owns community case/external-review lifecycle；GitHub facts 只作为 source signal。
- `signal-intake` owns generic admitted-signal plane；本 cell 是 GitHub-specific，不合并。
- `plugin` owns GitHub schedule registration/activation；本 cell 提供 factory/task spec 语义。
- `runtime-deployment`/`observability` own runtime/telemetry；本 cell 只发 observation metrics。
- `tracking status` 是 `tasks(kind=pr/issue_tracking)` + `waits` 的纯派生只读投影（observing / stopped(reason) / unarmed + predicates/generation/expires/last outcome/lag），落 W7a；不建第三套 GitHub status store。
- `waits.expires_at` 对账：GitHub tracking wait 显式写 7d 默认；A3-1 的“非 GitHub event wait 缺省无时间终止”只适用于非 GitHub event wait。expired 仍按 renderer 自述 wake。
- webhook 部署：A1-4 的 daemon 只绑 loopback；v1 默认 polling 主路径，webhook opt-in 且必须经 operator 反代/tunnel TLS 终止后转发到 loopback，反代来源需可信判定。
- GitHub review/CI 事实不写 W3 `reviews` 表；W3 的 review 是内部 ReviewPolicy 的独立 verdict，两者只共享 subject/sourceRef，不共享真相。

## 4. 风险与回滚

| 风险 | 级别 | 处置 |
|---|---|---|
| webhook 伪造/重放 | P1 | HMAC + delivery-id dedup + API 对账；payload 不当真相 |
| cursor 丢失/重复唤醒 | P1 | collection/delivery 分离；cursor 只在 durable observation/outcome 后推进；outcome 按 outcomeId 幂等 |
| identity 不明静默丢评论 | P1 | over-deliver + `identityUnknown` 告警；不静默 drop |
| empty rollup 被当 pass | P1 | 永远 pending；pass 需真 positive check |
| cancelled 被当 fail/pass | P1 | cancelled 非 fail/pass；cancelled-only pending |
| review dismissal 漏报 | P1 | 全量 fetch reviews + verdict map；dismissal 单独匹配 |
| 同 subject 并发注册双 task/双 wait/双唤醒 | P2 | `tasks(subject_key)` partial unique；同 kind replay 既有 task/wait |
| webhook 公网端点撞 A1-4 loopback | P2 | v1 默认 polling；webhook opt-in + 反代/tunnel TLS 到 loopback；`CODETEAM_GITHUB_WEBHOOK_ENABLED=0` |
| no-match 轮询 audit 洪水 | P2 | audit 只记 state-changing observation；no-match 只写 collector state/metrics |
| tracking status 无 pull 面 | P2 | tasks+waits 纯派生只读投影；W7a，不建第三套 store |
| webhook body DoS/timing compare | P2 | constant-time compare + body 1MB 上限/413 |
| rate limit/脏 repo | P2 | 只轮询已注册/allowlist；budget/backoff；`gh repo view` 校验 |
| token 泄露 | P1 | daemon-only、min scope、redaction；模型不可见 |
| token 通道与 A1-2 字面冲突 | P3 | 消歧：A1-2 禁 per-run agent token；GitHub read token 走受信 gh 子进程 env |
| cross-tenant/repo 泄漏 | P1 | subject isolation + repo allowlist；不扫全仓 |
| stale/out-of-order webhook | P2 | API reconciliation + natural key upsert；不依赖 webhook 顺序 |
| legacy cursor 迁移漏事件 | P2 | 每源从零 backfill + frozen snapshot frontier；历史只 state-only |
| PR draft/reset dismissal 漏报 | P3 | verdict map 全量 fetch + draft/reset contract test |
| GitHub review 被误写 W3 reviews | P3 | 外部 facts 只进 waits/task collector state；内部 review 独立 |
| Phase C 多用户 over-deliver 发给无权者 | P3 | 注册时点快照声明；Phase C 重审 identity/permission 路由 |
| GitLab scope creep | P2 | v1 GitHub-only；`ForgeAdapter` seam 不声明支持 |
| 第二 event ledger | P1 | 只写 `tasks`/`waits`/`audit`/`forge_deliveries`；不建 `github_events` |

**回滚**：关闭 GitHub plugin schedules + webhook 即可停止采集；`tasks.automation_state_json`/`waits`/`audit`/`forge_deliveries` 保留，不做数据迁移；不删除已有 GitHub facts；不重建 clowder 历史。

## 5. Review 与签字

> Review request `2ee84938-532c-4ae6-9f93-2e4f0f1f7402`（2026-10-25，三猫）。结论：烁烁 accept；砚砚 accept-with-modify；墨墨 accept-with-modify。**无 P1**；4×P2 + 12×P3 已回写。Operator 2026-10-25 拍 **`DP-GH-1=A`（GitHub-only）、`DP-GH-2=A`（复用 tasks/waits/audit/forge_deliveries，含 audit 收窄与 webhook 默认 polling 护栏）**；W8 GitHub-only 契约冻结。

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | collector/TaskSpec、cursor/frontier、CI/conflict、W5 seam | accept；P2 register 幂等 + P3×2 已回写 |
| 砚砚 | webhook HMAC、permission gate、token、identity/audience、fail-closed | accept-with-modify；P2 webhook 部署拓扑 + P3×5 已回写 |
| 墨墨 | operator 可读的 matched delta、tracking status、issue/PR UX | accept-with-modify；P2 audit 收窄 + tracking status pull 面，P3×5 已回写 |
| operator | DP-GH-1 provider scope / DP-GH-2 observation store | 已签 `DP-GH-1=A` / `DP-GH-2=A`（2026-10-25） |

**Findings disposition**

| # | 来源 | Finding | 处置 |
|---|---|---|---|
| P2-1 | 烁烁 | 同 subject 并发/重复注册会双 task、双 wait、双唤醒 | **已修**：`tasks(subject_key)` partial unique；同 subject 同 kind replay 既有 task/wait；换 kind 允许 |
| P2-1 | 砚砚 | A1-4 daemon loopback 与 W8 公网 webhook 冲突；缺验签前 DoS 防护 | **已修**：v1 默认 polling；webhook opt-in `CODETEAM_GITHUB_WEBHOOK_ENABLED=0`，反代/tunnel TLS 到 loopback；constant-time compare + body 1MB/413 |
| P2-1 | 墨墨 | “每次 observation 进 audit” × 60s × 不删除 = audit 洪水，淹没 operator mutation 时间线 | **已修**：audit 只记 state-changing（matched/terminal/rearm_failed/migration/dedup/permission-denied）；no-match 只写 collector state/metrics；DP-GH-2 A 含此护栏 |
| P2-2 | 墨墨 | tracking status 只有 push 时自述，无 pull 面 canonical 查询 | **已修**：§3.7 定义 tasks+waits 纯派生只读投影（observing/stopped(reason)/unarmed + predicates/generation/expires/last outcome/lag），落 W7a |
| P3-1 | 烁烁 | GitHub review/CI 事实可能被误写 W3 `reviews` 表 | **已回写**：外部 facts 只进 waits.outcome_json / task collector state；内部 ReviewPolicy 独立 |
| P3-2 | 烁烁 | 429 无降频策略 | **已回写**：`CODETEAM_GITHUB_RATE_LIMIT_BACKOFF_MAX_MS` 指数退避上限 |
| P3-1 | 砚砚 | HMAC 未写 constant-time；webhook body 无上限 | **已回写**：`hmacCompare` + `webhookBodyLimit`（1MB/413） |
| P3-2 | 砚砚 | webhook secret 存储位置未对齐 A1-2 | **已回写**：config 0600 或 env 二选一；不进 agent 面/日志 |
| P3-3 | 砚砚 | token 通道与 A1-2 “不放 env”字面冲突 | **已回写**：A1-2 禁 per-run agent token；GitHub read token 走 daemon→gh 受信子进程 env |
| P3-4 | 砚砚 | identity/permission 快照是注册时点，运行时降权不追溯 | **已回写**：显式声明 over-deliver 有意覆盖；Phase C 多用户重审 |
| P3-5 | 砚砚 | `pr_merged` 未预留，W8 自动 merge evidence 会需要 | **已回写**：`GitHubWaitPredicateReserved`；v1 不启用；`pr_merged` 只作外部观察，不作 custody predicate；W8 若需要独立 merge 观察再接 `ActionTerminalPredicate`，不另造 catalog |
| P3-1 | 墨墨 | renderer 行未显式引用 #1392 AC-7 三纪律 | **已回写**：tracking future 自述、identityUnknown 告警、delta+sourceRef/无 body 三条进 renderer 立场 |
| P3-2 | 墨墨 | `GitHubWaitOutcomeV1` 缺 `terminalSubjectState` 可读性 | **已回写**：contract 行补 `terminalSubjectState`，renderer 区分 merged/closed |
| P3-3 | 墨墨 | PR draft/reset dismiss reviews 可能漏报 | **已回写**：§3.3E 加 draft/reset → decision change；matcher contract test 注 |
| P3-4 | 墨墨 | 7d TTL 与 A3-1 “缺省无时间终止”口径差异 | **已回写**：GitHub tracking wait 显式写 `expires_at`；非 GitHub event wait 不受影响；expired 仍自述 wake |
| P3-5 | 墨墨 | permission-denied 只有 metric，无 operator 自述 | **已回写**：audit state-changing 保留 permission-denied；`continueDoneTracking` policy 证据源挂接 |

### 已拍板

| DP | 选项 | 决定 | 结果 |
|---|---|---|---|
| DP-GH-1 v1 provider scope | A=GitHub-only；B=GitHub+GitLab | **A（2026-10-25）** | v1 GitHub-only；`ForgeAdapter` 只留 seam；GitLab defer |
| DP-GH-2 observation provenance/store | A=reuse `tasks`/`waits`/`audit`/`forge_deliveries`（audit 只记 state-changing）；B=new `github_observations` table | **A（2026-10-25）** | 不建第二账本；audit 收窄；webhook 默认 polling/opt-in |

**Review 重点**

1. 10 个 predicate + baseline + matched delta 是否足够覆盖 W8 的 PR/issue/CI/review/conflict 场景；有没有必须提前的 predicate。
2. collection/delivery cursor 分离、`forge_deliveries`、`audit` 是否足以避免丢事件/重复唤醒；有没有需要新表。
3. webhook HMAC + API 对账 + permission gate + identity/audience 是否闭环；unresolved 时 over-deliver 是否可接受。
4. empty rollup / cancelled / external_infrastructure / dismissal 的 terminal 语义是否完整；有没有假 pass/fail。
5. GitHub-only v1 + `ForgeAdapter` seam 是否满足 W8；community-ops/ball-custody/dispatch 边界是否清楚。

[宪宪/deepseek-flash🐾]
