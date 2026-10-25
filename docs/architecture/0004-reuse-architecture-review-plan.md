---
title: "codeteam 复用架构梳理计划"
doc_kind: plan
status: approved
created: 2026-10-24
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
---

# codeteam 复用架构梳理计划

> 上游：`../reuse/REUSE-MATRIX.md`（已签字的分档）与 `../reuse/README.md`（11 张 P0 卡）。本文定义“要梳理哪些架构、按什么模板、按什么顺序、变量如何定义”，不展开具体实现。
>
> 2026-10-24 operator 确认：按本清单与模板推进，从 A1-1 `identity-session` 开始。

## 1. 目标与非目标

**目标**：对每个已签字的 P0 复用项，回答四个问题：

1. clowder 里这个能力的实现架构是什么（组件、数据流、状态机、存储、并发/恢复边界）。
2. codeteam 是全面复用、适配复用，还是必须重写；每个组件分别是什么立场。
3. 支撑这套架构的变量如何定义：类型、枚举、键、默认值、owner、权限、TTL/limit、迁移口径。
4. codeteam 侧需要新增/改名/删除哪些字段或配置，风险与回滚是什么。

**非目标**：

- 不在本阶段写实现代码或 migration。
- 不重新讨论 feature 是否复用；P0/P1/Drop 已由 `REUSE-MATRIX.md` 签字。
- 不对 P1-defer / Drop 做架构深挖；它们没有当前复用义务。

## 2. 范围

- **Wave A（现在做）**：A1×4 + A2×3 + A3×3，共 10 个架构项；A3 的 memory/observability 由 P1 提前。
- **Wave B（默认 W4 dogfood 后；4 项已由 operator 指定提前）**：11 个后补架构项，含原 A3 的 bubble-pipeline/harness-eval/plugin。已提前 approved：bubble-pipeline / github-signals / plugin / harness-eval；余 7 项仍等 W4 dogfood。
- **不做**：P1-defer 4（`action-plane`、`capability-evolution-control`、`community-ops`、`portable-governance`）与 Drop 11；只在 revisit trigger 触发时再开。

## 3. 统一产出模板

每个架构项产出一页 `codeteam/architecture/reuse-review/<item>.md`，固定五节，顺序不得打乱：

```md
# <item> 架构复用检视
## 1. 总结
- clowder feature 范围
- codeteam 复用总结：reuse / adapt / extend / defer / out-of-scope
## 2. clowder 架构
### 2.1 架构图
### 2.2 数据流
### 2.3 状态机 / 生命周期
### 2.4 关键数据结构
### 2.5 Current truth 与代码路径
## 3. codeteam 架构
### 3.1 架构图
### 3.2 数据流
### 3.3 状态机 / 生命周期
### 3.4 关键数据结构（与 clowder 对比）
### 3.5 变量定义表（contract/state/config/security/observability）
### 3.6 明确不做
## 4. 风险与回滚
## 5. Review 与签字
```

模板规则：

1. **默认全量复用，只列差异**：字段/契约默认按 clowder 全量复用；卡上只列 `rename` / `extend` / `drop` / `codeteam-new` 的差异。不复用也要显式写，不能 silent-keep。
2. **来源必须可证**：每个 code anchor / 类型来源必须 grep 可达；不可达锚点在交卡前修正。找不到代码的写“仅文档/无代码”。
3. **立场词统一**：`reuse now` / `adapt now` / `extend now` / `defer→P1` / `defer→W7` / `borrow` / `out-of-scope`；不得混用“reuse at W7”这类模糊词。
4. **两张图 + 三张结构**：clowder 和 codeteam 各一张架构图；各自必须有数据流、状态机、关键数据结构。没有图的卡不算完成。
5. **§12.2 回写清单**：卡片改变 `0001 §12.2` 的列/表时，§3.4 必须附 §12.2 diff 回写清单（改哪列、为什么、迁移口径），不能靠默契。交卡前必须逐列 grep 对比“卡内 diff 清单 ↔ 0001 §12.2”，缺一列即不算完成。
6. **`reuse now` 的反向门**：复用立场表里凡标 `reuse now`，必须回答“clowder 该形态是否含历史兼容、多用户、迁移窗口假设”。含这些假设的，降为 `adapt now` 或标 `out-of-scope`，不能把历史包袱当契约。
7. **上游已知缺口必须显式携带**：§2.5 必须有“上游已知缺口 → 本卡处置”对照；clowder 未闭环的授权/恢复/兼容问题不能当契约静默搬走，也不能只在风险表里一笔带过。
8. **跨卡共享 config 变量只定义一次**：`CODETEAM_DATA_DIR` 等全局变量以 A1-1/plans/0002 为唯一权威定义；其他卡只引用，不重定义默认值。
9. **卡 → Wn → plan 条目硬门**：卡片把某项划给 W0/W1/W5 等阶段时，对应 `plans/000n` 必须已有条目；没有就补计划，不能只写在架构卡里。
10. **存储形态替代要写事务边界**：用 SQLite 单库事务替代 Redis 时代的 terminal/receipt/对账锚时，必须写清“替代了哪个锚、事务边界、崩溃矩阵”，否则简化不成立。

## 4. 变量定义口径

每个架构项至少覆盖五层变量；缺一层要在卡里写“为什么不适用”。

| 层 | 要定义什么 | 例子 |
|---|---|---|
| `contract` | 类型、枚举、ID/键、必填/可选、版本 | `QueueEntryId`、`RoleId`、`BacklogStatus`、`ApprovalResolution` |
| `state` | 状态机字段、终态、幂等键、CAS 版本 | `queue.status`、`handoff.status`、`workflow_sops.version` |
| `config` | env、路径、端口、开关、limit、TTL、retry | `CAT_CAFE_DATA_DIR`、claim TTL、lease TTL、worktree root |
| `security` | principal、scope、授权域、审计 actor、失败语义 | operator credential、run token、agent-key、`AuthFailureReason` |
| `observability` | metric/log/trace 字段、事件 kind、health 证据 | `dispatchRefs`、run_events、readiness、audit |

变量表的硬要求：

- 每个变量必须有 owner 和 clowder 来源（文件/类型/ADR）；没有来源的变量标 `codeteam-new` 并说明必要性。
- 每个变量必须写 codeteam 决定：`reuse` / `rename` / `extend` / `new` / `drop`。
- 安全相关变量必须写清失败语义（fail-open / fail-closed）和谁能写。
- 迁移相关变量必须写默认值与回填方式；不能靠“运行时猜”。

## 5. Wave A：10 个架构项（A1×4 + A2×3 + A3×3）

### A1 基础层（先做）

| # | 架构项 | 覆盖 feature | clowder 架构面 | 变量重点（首批） | 初步立场 | 产出 |
|---|---|---|---|---|---|---|
| A1-1 | `identity-session` | F032/F088/F136/F171/F183/F211/F231/F262/F291/F296/F299/F320/F322 | AgentRegistry、SessionChainStore、ContextEpochOwner、cat-config、runtimeSession、profile/session 分层 | catId/profileId/sessionId/roleId、provider/model、L0 revision、context epoch、thread access | R0/R1：身份形状/session 连续性复用，AgentProfile/AgentSession 适配 | `codeteam/architecture/reuse-review/identity-session.md` |
| A1-2 | `callback-auth` | F174/F178 | InvocationRegistry、AgentKeyRegistry、sidecar provisioner、AuthFailureReason | token TTL/refresh、agent-key TTL/rotation/revocation、AuthFailureReason、principal scope | R1：契约复用，registry 改 SQLite | `codeteam/architecture/reuse-review/callback-auth.md` |
| A1-3 | `dispatch` | F047/F117/F167/F175/F177/F185/F247/F254/F264/F280/F295 | QueueLedger/Admission、RedisQueueLedgerStore、InvocationQueue、QueueProcessor、routes/queue | queueEntryId/sourceRecordId/sourceKind、targets[]、priority、claim TTL、dispatchRefs、terminal | R0：single-ledger 契约复用，store/target 适配 | `codeteam/architecture/reuse-review/dispatch.md` |
| A1-4 | `runtime-deployment` | F300/F323 | RuntimeDeploymentLedger、daemonStatePaths、deployment revision、per-boot readiness | deployment revision/build SHA、daemon ownership、boot identity、readiness、lifecycle operation record | R1：deployment identity/readiness 复用，daemon 适配 | `codeteam/architecture/reuse-review/runtime-deployment.md` |

> A1-1 已完成：`codeteam/architecture/reuse-review/identity-session.md`；2026-10-24 operator 确认 D2=A，样张作为 A1-2 起的格式基线。
> A1-2 已签：`codeteam/architecture/reuse-review/callback-auth.md`；Round 1 `9bf54439-c11a-4f6e-84f9-f6cbd759d640`、Round 2 `86d36c0c-0dd9-4a68-8cb7-3f133137580c`；三猫 Round 2 accept/modify，P2/P3 已回写；operator 2026-10-25 签。
> A1-3 已签：`codeteam/architecture/reuse-review/dispatch.md`；review request `aa667fe9-56ce-422c-bc8f-3fc881a614d4`；三猫放行，P1×1 + P2×3 + P3×13 已回写；operator 2026-10-25 签。
> A1-4 已签：`codeteam/architecture/reuse-review/runtime-deployment.md`；review request `457b0226-a235-4226-b4b4-279204545bf0`；三猫 accept-with-modify，P2/P3 已回写；operator 2026-10-25 签。
> A2-1 已签：`codeteam/architecture/reuse-review/sop-bulletin.md`；review request `c934705b-ad43-449c-87e0-963cef37b64b`（2026-10-25）；三猫无 P1，P2/P3 已回写，`0001 §12.2/§7.3` 已同步；operator 2026-10-25 签。
> A2-2 已签：`codeteam/architecture/reuse-review/managed-work.md`；review request `a02b5016-5cb6-463c-9cb3-485eb9ec1379`（2026-10-25）；三猫 review 完成；P1-1 字段 owner、P1-2 livelock、P2/P3 已回写；P1 retry **DP-A2-2-1=A sticky retry**；operator 2026-10-25 签。
> A2-3 已签：`codeteam/architecture/reuse-review/approval-index.md`；review request `c7e62ae7-2b1f-47cb-b6e7-8ad3c6427d48`（2026-10-25）；三猫无 reject；P1-1 effect receipt 1:1、P2 idempotency、P2 materialization principal、P3 批已回写；`0001 §12.2 approvals` 已同步；operator 2026-10-25 签。

### A2 SOP 与工作身份层

| # | 架构项 | 覆盖 feature | clowder 架构面 | 变量重点（首批） | 初步立场 | 产出 |
|---|---|---|---|---|---|---|
| A2-1 | `sop-bulletin` | F073/F015/F040/F049/F058/F076 + clowder SOP | WorkflowSopStore、BacklogStore、sop-definitions、CAS/version、update_workflow/get_workflow_sop | BacklogStatus、stage enum、version CAS、baton/nextSkill、resumeCapsule、checks attested/verified、dependencies、lease/audit | R0：数据契约/CAS 复用，CLI/authz 适配 | `codeteam/architecture/reuse-review/sop-bulletin.md` |
| A2-2 | `managed-work` | F275 | WorkAdmission/WorkAttempt、WorkflowSop first-persist、executor attribution | workId/attemptId、admission trigger、executor attribution、TaskOutcome refs | R1：identity 复用，Task/Run 映射 | `codeteam/architecture/reuse-review/managed-work.md` |
| A2-3 | `approval-index` | F246 | Approval Hub producer catalog、runtime registry、双锚、resolution/materialization | approval kind、origin/card/effect refs、resolution/materialization、expiry、decided_note、operator credential | R0/R1：approval 契约复用，gate kind 适配 | `codeteam/architecture/reuse-review/approval-index.md` |

### A3 责任、投影与评估层

| # | 架构项 | 覆盖 feature | clowder 架构面 | 变量重点（首批） | 初步立场 | 产出 |
|---|---|---|---|---|---|---|
| A3-1 | `ball-custody` | F167/F233/F254/F280 | BallCustodyEventLog/Projection、ActionSuccessorLease、AwaitState、managed-command recovery | subjectKey/actionFamily/slot、generation、lease TTL、terminal predicate、wait owner fence/outcome、cancel authority | R1：custody/lease/wait 复用，Handoff envelope 适配 | `codeteam/architecture/reuse-review/ball-custody.md` |
| A3-2 | `memory` | F102/F152/F209/F221/F227/F231/F255/F260/F263/F271/F276/F282/F287/F321 | EvidenceStore/Recall、session digest、library/cue plane、memory lifecycle metrics | evidence/anchor、collection scope、cue handle、sessionId、owner/privacy、recall metrics | R1：file-evidence subset；个人记忆/proactive/threads out-of-scope 或 defer | `codeteam/architecture/reuse-review/memory.md` |
| A3-3 | `observability` | F153/F299/F150/F130 | OTel telemetry、invocation trajectory、tool usage、Pino logs | trace/span/correlation keys、metric allowlist/redaction、trajectory ID、tool counters、log retention | R1：raw telemetry + trajectory + F150/F130 parity；不建第二事件账本 | `codeteam/architecture/reuse-review/observability.md` |

> A3-1：`codeteam/architecture/reuse-review/ball-custody.md`（status=approved，2026-10-25）；review request `d9b81c9e-fe57-4e23-a77d-d6130308fd03`（三猫）。三猫已回：烁烁 accept、砚砚 accept-with-modify、墨墨 accept-with-modify；P1-1 per-holder claim 已修，P2/P3 已回写。Operator 2026-10-25 拍 `DP-A3-1-1=A`、`DP-A3-1-2=A`、`DP-A3-1-3=A`。A3-1 冻结为 W1/W5/W7 契约。
> A3-2 memory：source card `codeteam/reuse/memory.md`；review `codeteam/architecture/reuse-review/memory.md`（status=approved，2026-10-25）；review request `347b68e0-8bf0-4b30-873d-597505cc8fd6`（三猫）。三猫已回（烁烁 accept / 砚砚 accept-with-modify / 墨墨 accept-with-modify）；P1-1 源类收窄为文件源，P2/P3 已回写；schema 移到 `architecture/memory-schema.md`。Operator 2026-10-25 拍 `DP-MEM-1=A`、`DP-MEM-2=A`、`DP-MEM-3=A`。A3-2 冻结为 W6/W7 契约。
> A3-3 observability：source card `codeteam/reuse/observability.md`；review `codeteam/architecture/reuse-review/observability.md`（status=approved，2026-10-25）；review request `1a1730c7-b982-43c2-a864-361ce35c50b2`（三猫，memory review 后按“依次”发起）。三猫已回（烁烁 accept / 砚砚 accept-with-modify / 墨墨 accept-with-modify）；P1-1 源表述、P2 HMAC salt/tool span/generations/optional trace 列已回写。Operator 2026-10-25 拍 `DP-OBS-1=A`、`DP-OBS-2=A`、`DP-OBS-3=B`；A3-3 冻结为 W6/W7 契约，W6 含 F150/F130 parity。

## 6. Wave B：11 个后补架构项

`code-intelligence`、`github-signals`、`hub-action-surface`、`human-disposition-feedback`、`mcp-surface-governance`、`routing-context`、`thread-chat-surface`、`thread-navigation`、`bubble-pipeline`、`harness-eval`、`plugin`。

每项复用同一模板。默认只在 W4 dogfood 报告后启动；operator 已指定提前 review 的 4 项（bubble-pipeline / github-signals / plugin / harness-eval）见下，其余 7 项仍等 W4 dogfood；均不阻塞 W0a/W1。

> Wave B 启动项：`bubble-pipeline` 已出 `codeteam/architecture/reuse-review/bubble-pipeline.md`（approved，2026-10-25）；review request `92a939a1-8e83-47d1-ae0c-24045d1b2472`（三猫）。三猫已回：烁烁 accept、砚砚 accept-with-modify、墨墨 accept-with-modify；**无 P1**，3×P2 + 12×P3 已回写（P2：response/runs 同事务 + orphan health、unknown missingEvidence 分层、reconnect 全量 snapshot）。Operator 2026-10-25 拍 `DP-BUBBLE-1=A`：**W1 冻结；W7 approved-for-direction（provisional until W4 dogfood）**。重点：W1 message identity + dispatchRefs + `messages.seq`/`runs.response_message_id`；W7 只读 timeline/live-hydration；F254 历史只读。
> 2026-10-25 operator 指定提前 review `bubble-pipeline`（Wave B 启动项）；当时其余 Wave B 项仍等 W4 dogfood，不因本项提前而整体提前。后续 `github-signals`/`plugin`/`harness-eval` 也由 operator 指定提前，见下；剩余 7 项仍等 W4 dogfood。
> Wave B 第二启动项：`github-signals` 源卡 `codeteam/reuse/github-signals.md`（approved）+ 架构卡 `codeteam/architecture/reuse-review/github-signals.md`（approved，约 670 行，T1–T26 锚点已核）；review request `2ee84938-532c-4ae6-9f93-2e4f0f1f7402`（三猫）。三猫已回：烁烁 accept、砚砚 accept-with-modify、墨墨 accept-with-modify；**无 P1**，4×P2 + 12×P3 已回写（P2：register 幂等、webhook loopback/opt-in 部署、audit 只记 state-changing、tracking status pull 面）。Operator 2026-10-25 拍 `DP-GH-1=A`（GitHub-only）、`DP-GH-2=A`（复用 tasks/waits/audit/forge_deliveries，含 audit 收窄护栏）；**W8 GitHub-only 契约冻结**。
> Wave B 第三启动项：`plugin` 架构卡 `codeteam/architecture/reuse-review/plugin.md`（approved，约 513 行，T1–T15 锚点已核）；源卡 `codeteam/reuse/plugin.md`（approved，P0 W0/W4）。review request `e3168435-73d6-4a82-a840-979596c21466`（三猫）。三猫已回：烁烁 accept、砚砚 accept、墨墨 accept-with-modify；**无 P1**，3×P2 + 11×P3 已回写（P2：nextSkill repo-read 生效路径、frontmatter 单源、index/body 两级）。Operator 2026-10-25 拍 `DP-PLUGIN-1=A`（skill surface only）、`DP-PLUGIN-2=A`（repo-local curated + role allowlist + project root）；**W0/W4 skill surface 契约冻结**。
> 2026-10-25 补齐 **skill 内容迁移**：`codeteam/architecture/skill-migration.md`（61-skill 矩阵；讨论后 **8 R / 20 A / 1 W / 18 D / 14 X**；operator 2026-10-25 拍 `DP-SKILL-1=A` / `DP-SKILL-2=A` / `DP-SKILL-3=A`）。三猫讨论 `3ab79e77-62c2-43d1-92ea-31c466a6efc2` 已回写：`debugging`/`convention-graph-discovery`/`plain-language`/`tech-writing` R→A，`owner-friendly-plugin-development` X→D，memory 双行 target 钉 message source connector；新增 `must-survive` registry（merge-gate 八条、review 五条等）与 skill 路由对账门禁。W0/W4 skill 开工门禁：矩阵行 + must-survive + 静态检查 + 非作者 review + dry-run + 路由对账，缺一不进 catalog。`merge-gate` 是 rewrite，不是 copy；operator 2026-10-25 拍 **`DP-MERGE-1=D`**：gate 后由 merge owner 执行，operator 守硬门；C 类自动合并不做，A 仅零-secret 临时偏差。

> Wave B 第四启动项：`harness-eval` 架构卡 `codeteam/architecture/reuse-review/harness-eval.md`（approved）；源卡 `codeteam/reuse/harness-eval.md`（approved R1/P0）。v1 范围 = verdict envelope + finding 不可变 + lifecycle append-only；F266/F267/F278 治理 R2 borrow；F313 只借 finding/repair 形状；F311 不进。review request `763821ad-edc7-4958-a733-5724c808443f`（三猫）；三猫已回：烁烁 accept、砚砚 accept-with-modify、墨墨 accept-with-modify；无 reject；P1/P2 已回写；operator 2026-10-25 拍 `DP-HE-1/2/3=A/A/A`（P0 范围 / artifacts+events 存储 / review-eval 分账）。

## 7. 推荐批次与依赖

| 批次 | 架构项 | 依赖 | 门禁 |
|---|---|---|---|
| A1 | identity-session、callback-auth、dispatch、runtime-deployment | 无（可并行） | 组件图 + 变量表 + 代码路径 + 三猫 review |
| A2 | sop-bulletin、managed-work、approval-index | A1 的 identity/auth | 数据契约 + CAS + 权限域 + 三猫 review |
| A3 | ball-custody、memory、observability | A1/A2 的 identity/session/dispatch/managed-work/approval | 状态机/证据边界 + 失败恢复 + 变量表 + 三猫 review |

依赖规则：

- `dispatch` 的 target 模型依赖 `identity-session` 的 profile/session 形状。
- `sop-bulletin` 的 admission 触发依赖 `managed-work` 的 WorkflowSop first-persist 语义。
- `ball-custody` 的 Handoff/lease/wait 依赖 `dispatch` 的 Queue Entry 与 terminal 语义。
- `memory` 的 evidence/session/cue 依赖 `identity-session` 的 session chain 与 `dispatch` 的 invocation/queue identity；个人记忆/proactive 生产端不在本批。
- `observability` 的 trajectory 依赖 `identity-session`/`dispatch` 的 invocation/run/queue correlation，以及 `ball-custody` 的 completion/custody refs。
- Wave B 的 `harness-eval` 仍依赖 `ball-custody` 的 completion resolver 与 `approval-index` 的 effect 边界。

## 8. 验收与分工

每个架构项完成定义：

- [ ] 组件图、数据流、状态机、存储/并发、失败恢复五段齐全。
- [ ] 逐组件给出 `全面复用 / 适配复用 / 重写` 立场和理由。
- [ ] 变量表覆盖 contract/state/config/security/observability 五层，且每个变量有 owner、来源、codeteam 决定。
- [ ] 代码路径可追到 cell doc 的 code anchors；找不到代码的写“仅文档/无代码”。
- [ ] 风险与回滚写清；安全变量写明 fail-open/fail-closed 与写权限。
- [ ] 三猫分面 review + operator 签字。

分工：

| 角色 | 负责 |
|---|---|
| 宪宪 | 架构卡起草、变量表、跨 cell 一致性 |
| 烁烁 | W0/W1/W5 代码真相、Queue/Identity/Runtime |
| 砚砚 | 安全/权限/W2/W3/W8、fail-closed |
| 墨墨 | operator UX/W4/W7、SOP/Approval 语义 |
| operator | 批次范围与架构卡最终签字 |

## 9. Operator 确认

- [x] 2026-10-25 operator 重排：A3-2~A3-4（`bubble-pipeline`/`harness-eval`/`plugin`）降 Wave B；Wave B 的 `memory`/`observability` 提到 A3，后续依次 review `memory`、`observability`。Wave A 现为 10 项，Wave B 为 11 项；其中 4 项已提前 approved，余 7 项待 W4 dogfood。
- [x] 2026-10-25 operator 拍板：ball-custody `A/A/A`、memory `A/A/A`、observability `A/A/B`；A3 层三卡 approved，W1/W6/W7 契约冻结。
- [x] 2026-10-25 bubble-pipeline 三猫 review 完成：烁烁 accept / 砚砚 accept-with-modify / 墨墨 accept-with-modify；无 P1，3×P2 + 12×P3 已回写。
- [x] 2026-10-25 operator 拍 `DP-BUBBLE-1=A`：W1 approved；W7 approved-for-direction（provisional until W4 dogfood）。
- [x] 2026-10-25 github-signals 三猫 review 完成：烁烁 accept / 砚砚 accept-with-modify / 墨墨 accept-with-modify；无 P1，4×P2 + 12×P3 已回写；operator 拍 `DP-GH-1=A` / `DP-GH-2=A`，W8 GitHub-only 契约冻结。
- [x] 2026-10-25 plugin 三猫 review 完成：烁烁 accept / 砚砚 accept / 墨墨 accept-with-modify；无 P1，3×P2 + 11×P3 已回写；operator 拍 `DP-PLUGIN-1=A` / `DP-PLUGIN-2=A`，W0/W4 skill surface 契约冻结。
- [x] 2026-10-25 补齐 skill 内容迁移矩阵（61 skills；讨论后 8 R / 20 A / 1 W / 18 D / 14 X），operator 拍 `DP-SKILL-1/2/3=A/A/A`；W0/W4 skill 内容迁移门禁已挂。
- [x] 2026-10-25 skill 内容迁移三猫讨论完成（request `3ab79e77-62c2-43d1-92ea-31c466a6efc2`）；findings 已回写：must-survive registry + 路由对账 + 4 行改判 + owner-friendly X→D。
- [x] 2026-10-25 `DP-MERGE-1` operator 拍 **D**（clowder parity）：merge owner 在 gate 后执行，operator 守硬门；C 类自动合并不做，A 仅零-secret 临时偏差。全量漂移审计见 `architecture/merge-authority-drift-audit.md`；三猫已 accept-with-modify，D 六契约按审计 §9 冻结。
- [x] 产出用统一模板；每项 1 页架构卡 + 1 张变量表，不写实现代码。
- [x] 批次按 A1 → A2 → A3 推进；A1 可并行，A2/A3 按依赖串行。
- [x] 变量表覆盖 contract/state/config/security/observability 五层。

## 10. 下一步

1. ~~确认本清单范围与模板。~~（2026-10-24 已确认）
2. ~~从 A1-1 `identity-session` 开始，产出第一张架构卡和变量表。~~（样张已出，Round 1 findings 已回写）
3. ~~A1-1 Round 2 复审。~~（已通过，D2=A）
4. ~~A1-2 `callback-auth` Round 2 已完成，P2/P3 已回写。~~（2026-10-25 operator 已签）
5. ~~A1-3 `dispatch` 已按 A2A 灵魂链重写并复审，findings 已回写；A1-4 `runtime-deployment` 已复审。~~（2026-10-25 operator 已签）
6. A1 层四卡齐；跨卡互指审计已完成：`CODETEAM_DATA_DIR` 唯一权威在 A1-1、`operator.key`/console-link 在 A1-2/A1-4、`queue_entries` + `runs` 新列在 A1-3/0001、halt 术语在 0001 §22。A2A 灵魂链已回写 README/F001/0001/plans 0001/0002/0004/0005/0006/plans README/reuse 卡。
7. ~~交 operator 批量签 A1-2/A1-3/A1-4。~~（2026-10-25 已批量签，A1 四卡全部 approved）
8. ~~A2-1 `sop-bulletin` 待签~~（2026-10-25 operator 已签）。
9. ~~A2-2 `managed-work` 待拍板~~（2026-10-25 operator 选 A sticky retry 并签；三猫 P1/P2/P3 已回写，0001 §12.2 已补四表 + `owner_auth_provenance`）。
10. ~~A2-3 `approval-index` 待签~~（2026-10-25 operator 已签）。**A2 层收口**：sop-bulletin / managed-work / approval-index 三卡全部 approved。
11. ~~A3-1 `ball-custody`~~：approved；operator 2026-10-25 拍 A/A/A；W1/W5/W7 契约冻结。
12. ~~A3-2 `memory`~~：approved；operator 2026-10-25 拍 A/A/A；W6/W7 契约冻结。
13. ~~A3-3 `observability`~~：approved；operator 2026-10-25 拍 A/A/B；W6/W7 契约冻结，W6 含 F150/F130 parity。
14. **Wave B `bubble-pipeline`**：`reuse-review/bubble-pipeline.md` approved；review request `92a939a1-8e83-47d1-ae0c-24045d1b2472`（三猫）；三猫已回（accept / accept-with-modify / accept-with-modify），无 P1，3×P2 + 12×P3 已回写；operator 2026-10-25 拍 `DP-BUBBLE-1=A`：**W1 冻结，W7 approved-for-direction（W4 dogfood 后按实测确认/修订）**。W1 可开工；W7 不阻塞 W4。其余 Wave B 项等 W4 dogfood/按需启动。
15. **Wave B `github-signals`**：源卡 `reuse/github-signals.md` + 架构卡 `reuse-review/github-signals.md`（approved，约 670 行；T1–T26 锚点已核）；review request `2ee84938-532c-4ae6-9f93-2e4f0f1f7402`（三猫）。三猫已回（accept / accept-with-modify / accept-with-modify），无 P1，4×P2 + 12×P3 已回写；operator 2026-10-25 拍 `DP-GH-1=A`（GitHub-only）/ `DP-GH-2=A`（复用 tasks/waits/audit/forge_deliveries，含 audit 收窄）；**W8 GitHub-only 契约冻结**。
16. **Wave B `plugin`**：源卡 `reuse/plugin.md`（approved）+ 架构卡 `reuse-review/plugin.md`（approved，约 513 行；T1–T15 锚点已核）；review request `e3168435-73d6-4a82-a840-979596c21466`（三猫）。三猫已回（accept / accept / accept-with-modify），无 P1，3×P2 + 11×P3 已回写；operator 2026-10-25 拍 `DP-PLUGIN-1=A`（skill surface only）/ `DP-PLUGIN-2=A`（repo-local curated + role allowlist + project root）；**W0/W4 skill surface 契约冻结**。
17. **Skill 内容迁移（跨 plugin/W0/W4）**：`architecture/skill-migration.md` 已补 61-skill 矩阵（讨论后 8 R / 20 A / 1 W / 18 D / 14 X）；三猫讨论完成，已加 `must-survive` registry 与路由对账门禁；`debugging`/`convention-graph-discovery`/`plain-language`/`tech-writing` R→A、`owner-friendly-plugin-development` X→D。Operator 2026-10-25 拍 `DP-SKILL-1=A`（矩阵+fork/adapt）/ `DP-SKILL-2=A`（v1 只迁 W0/W4）/ `DP-SKILL-3=A`（一次性 curated fork）。`merge-gate` 执行模型已拍 **`DP-MERGE-1=D`**；S0 先迁 tdd/debugging/writing-plans/worktree/quality-gate/context-self-management。
18. **Merge authority 漂移收口**：`architecture/merge-authority-drift-audit.md` 已列全量漂移并完成三猫 review（request `52960ac8-894c-49c8-9837-04e7a4be68ef`，均 accept-with-modify，无 reject）；P1/P2 已回写，D 六契约按审计 §9 冻结。
19. **`DP-MERGE-2=A` 已拍（2026-10-25）**：W0–W4 dogfood 采用 D-first；先落 `service:merge-owner` + per-merge credential + daemon E1–E5 + local `MergeExecutor` adapter，W8 再接 GitHub adapter。不做 A-interim。
    - 2026-10-25 追加：must-survive registry 增加 `MS-MERGE-8`（operator 硬门 + Decision Packet 形态），merge-gate 现为八条。
20. **Wave B `harness-eval` 已收口（2026-10-25）**：架构卡 `reuse-review/harness-eval.md` approved；`DP-HE-1/2/3=A/A/A` 已签；W6 冻结 verdict envelope + finding 不可变 + lifecycle append-only；`eval_lifecycle_events` + artifacts + `evals` 扩展；code review 与 eval verdict 分账；`eval`/`compress` 为动态 role，codeteam 不引入 catId。

**A3 层收口**：ball-custody / memory / observability 三卡 approved；Wave A 的 A1×4 + A2×3 + A3×3 全部完成。W1/W6/W7 可按已签 schema 开工；Wave B 11 项中 4 项已提前 approved（bubble-pipeline/github-signals/plugin/harness-eval），余 7 项等 W4 dogfood 后。

> 原 A3-2~A3-4（`bubble-pipeline`/`harness-eval`/`plugin`）已移至 Wave B，不阻塞 memory/observability。

[宪宪/deepseek-flash🐾]
