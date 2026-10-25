---
cell: github-signals
title: "P1 复用卡：GitHub Signals"
doc_kind: reuse-card
status: approved
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
review_request: "2ee84938-532c-4ae6-9f93-2e4f0f1f7402"
operator_signoff: "DP-GH-1=A, DP-GH-2=A (2026-10-25)"
created: 2026-10-25
updated: 2026-10-25
---

# P1 复用卡：GitHub Signals

## 结论

| 项 | 值 |
|---|---|
| decision | **R1 适配复用** |
| priority | **P1（Wave B；W8 Forge connector）** |
| codeteam W | W8（GitHub PR/issue/check evidence + typed wait predicate）；W5（F139 schedule seam） |
| 一句话 | GitHub 是外部真相；codeteam 只持久化 collector frontier/baseline、typed wait predicate 与 matched outcome，不把 GitHub 事实当球权/投递真相。 |
| operator 签字 | [x] `DP-GH-1=A` / `DP-GH-2=A`（2026-10-25）；W8 GitHub-only 契约冻结 |

## 覆盖

- canonical: F133（CI/CD signals）、F140（PR review feedback/conflict/issue comments）、F280（typed GitHub wait predicate）。
- explicit secondary: F304（admission/liveness）；F139/F202 只提供 schedule/TaskSpec_P1 接缝；F141/F168 的 community case 真相仍归 `community-ops`。
- v1 取用：PR/issue 外部事实采集、per-source cursor/frontier、registration baseline snapshot、typed predicate resolver、compact matched-delta renderer、webhook HMAC + delivery-id 去重、API 对账；默认 polling 主路径，webhook opt-in + 反代/tunnel 到 loopback。
- v1 明确不含：community-ops event log/case state、delivery/wake 生命周期（归 `ball-custody` + `dispatch`）、GitHub App/MCP 工具、IMAP/email 路径、GitLab v1、outbound comment/check 写入、auto-merge/rebase、raw body 进 wake、token 进模型。

## Current truth

- **外部真相**：GitHub PR/issue/check/review/comment 是外部事实；webhook 只做触发，API 才是对账真相。采集事实不裁决责任、不直接投递、不决定 merge。
- **两类状态**：collector frontier/cursor/fingerprint 是采集幂等状态；registration baseline snapshot 是“从哪里开始观察”的起点；二者不能混成通知游标。
- **typed wait**：F280 把等待建模为 `when[]` predicate + baseline + matched delta + outcome；one-shot/generation、owner fence、delivery outbox 归 `ball-custody`。
- **身份/受众**：server 在注册时从 GitHub metadata 派生 subject author/maintainer/reviewer/issue participant；身份不明时 over-deliver 并显式告警，不静默丢评论。
- **已知边界**：empty rollup 永远 pending；`cancelled` 既非 pass 也非 fail；billing/spending-limit 是 `external_infrastructure`；review dismissal 是原地状态变化，不能只靠 decision cursor。
- **代码面**：`GitHubWaitPredicateCatalog`、`GitHubWaitBaselineReader`、`GitHubWaitRenewalBaseline`、`GitHubWaitLifecycleService`、`ReviewFeedbackTaskSpec`、`IssueCommentTaskSpec`、`CiCdCheckTaskSpec`/`CiCdRouter`、`ConflictCheckTaskSpec`、`GitHubRepoWebhookHandler`、`github-schedule-factories`。

## codeteam mapping

- W8 v1 = GitHub-only `ForgeSignalAdapter`：`gh` CLI / REST/GraphQL 读事实；webhook 只触发；`forge_deliveries` 做 delivery-id 去重；API 按 natural key（repo + PR/issue number）对账。
- 每个 tracked PR/issue 对应 `tasks.kind='pr_tracking'|'issue_tracking'` + `tasks.subject_key`；collector state 写 `tasks.automation_state_json`；wait contract 写 `waits.baseline_json`/`continuation_json`/`outcome_json`。
- `waits.kind='event'`；`wait_source_ref` 指向 GitHub subject；`expected_signal` 是 typed predicate summary；`owner_fence_json` 由 ball-custody 签发。
- 采集器只产出 facts/matched delta；`ball-custody` 持久化 outcome，`dispatch`/`bubble-pipeline` 负责 Queue 与 message。GitHub signals 不写 `handoffs`、不写 `messages`、不直接唤醒。
- 身份/受众、self-echo、setup-noise、per-surface cursor 全部按 clowder F140/F280 语义适配；不建第二套评论审计/通知账本。

## 风险与回滚

- **P1**：webhook 伪造/重放 → HMAC + delivery-id 去重 + API 对账；payload 不当真相。
- **P1**：cursor 丢失或投递失败导致丢事件/重复唤醒 → collection/delivery 分离；cursor 只在 durable observation/outcome 后推进；outcome 按 outcomeId 幂等。
- **P1**：identity 不明时静默丢评论 → over-deliver + `identityUnknown` 告警；不接受“静默无覆盖”。
- **P1**：empty rollup 被当 pass、cancelled 被当 fail → 固定 pending/external_infrastructure 语义。
- **P2**：review dismissal 只靠 cursor 漏掉 → 每轮 fetch 全量 reviews + verdict map。
- **P2**：rate limit/越权 repo → 只轮询已注册/allowlist subject；budget + backoff + `gh repo view` 校验。
- **P2**：同 subject 并发/重复注册 → `tasks(subject_key)` partial unique + replay 既有 task/wait。
- **P2**：webhook 公网端点撞 A1-4 loopback → 默认 polling；webhook opt-in + 反代/tunnel TLS。
- **P2**：no-match 轮询写 audit 洪水 → audit 只记 state-changing；frontier 只在 collector state/metrics。
- **P2**：tracking status 只有 push 自述 → tasks+waits 纯派生只读投影，落 W7a。
- **P2**：token 泄露 → daemon-only、最小 scope、redaction；模型不可见。
- **回滚**：关闭 GitHub plugin schedules + webhook；已写 collector state/waits 保留；不迁移 clowder 历史，不建第二 store。

## Review

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | collector/TaskSpec、cursor/frontier、CI/conflict、W5 seam | accept；P2 register 幂等 + P3×2 已回写 |
| 砚砚 | webhook HMAC、permission gate、token、identity/audience、fail-closed | accept-with-modify；P2 webhook 部署拓扑 + P3×5 已回写 |
| 墨墨 | operator 可读的 matched delta、tracking status、issue/PR UX | accept-with-modify；P2 audit 收窄 + tracking status pull 面，P3×5 已回写 |
| operator | W8 范围 / 存储 / provider scope | 已签 `DP-GH-1=A` / `DP-GH-2=A`（2026-10-25） |

[宪宪/deepseek-flash🐾]
