---
title: "clowder feature 复用矩阵"
doc_kind: matrix
status: approved
created: 2026-10-24
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
---

# clowder feature 复用矩阵

> **2026-10-24 operator 签字**：P0 10 cells + `sop-bulletin` slice；P1-active 10；P1-defer 4；Drop 11。Batch 1 的 11 张卡全部 approved；Batch 2 已收口 3/10（github-signals/memory/observability），余 7 项待 W4 dogfood；Batch 3 已确认。

> 目标：对 `docs/features/` 的全部 feature 做一次完整分类，输出“可复用 / 暂不复用 / 明确不复用 + 优先级”，作为 codeteam W0–W8 的复用决策单一入口。
>
> **分类基准不是自造族，而是 `docs/architecture/ownership/cells/` 的 35 个架构 cell。** 每个 feature spec 本来就应该引用 `Architecture cell:`；cell 的 frontmatter 已给出 canonical features、summary 和 code anchors。

## 1. 规模与现状（2026-10-24）

- feature docs：323 篇（不含 `TEMPLATE.md`）。
- ownership cells：35 个。
- 显式 `Architecture cell:`：103 篇。
- 未标注 cell 的 legacy：220 篇（多为早期 F001–F100；Batch 0 已按 canonical features / topics 归属，无法归属的标 `legacy/unclassified` 并写原因）。
- 状态分布：done 167 / in-progress 38 / spec 17 / idea 2 / frozen 2 / 其他。
- **done ≠ 可复用**：存在 `done (abandoned)`、`frozen/superseded`、`sunset`；分类必须看当前真相源（ADR / 代码 / 当前 owner）。

工作清单：

- `codeteam/reuse/ownership-cell-reuse.tsv`：35 个 cell 的初始映射（cell / canonical / explicit features / codeteam W / decision / priority / notes）。
- `codeteam/reuse/reuse-inventory.tsv`：323 篇 feature 的逐篇清单（含 `architecture_cell` / `cell_source`；Batch 1 签字后已按 cell default + carve-outs 回填 `decision` / `priority` / `current_truth`；逐 feature 细分仍可在 Batch 2/3 调整）。

## 2. 决策口径

| 决策 | 含义 | 典型例子 |
|---|---|---|
| **R0 直接复用契约** | 语义、契约、状态机直接复用；codeteam 只换 store/transport | dispatch cell（ADR-043/F117；F122 历史）、approval-index |
| **R1 适配复用** | 同一概念，需要代码交付字段/适配层 | TaskItem 底座、ball-custody、review/harness-eval、identity-session |
| **R2 仅借鉴模式** | 不搬契约，借鉴设计，codeteam 自建 | 部分 UI 组件、eval 方法 |
| **N1 暂不复用** | 有价值但不在 W0–W4 狗粮范围；写 revisit trigger | capability-evolution-control、community-ops |
| **N2 明确不复用** | 与代码交付无关或明确 non-goal；写原因 | live-meeting、visible-cafe-render、cat-life-settings |

优先级（operator 2026-10-24 给了 P0=SOP/基础设施、Drop=与 code agent 无关；“阻塞 W0–W4 首个闭环”是宪宪按“快速到 dogfood”收紧，待签字确认）：

- **P0**：SOP 相关 + 核心基础设施，且是 W0–W4 代码 agent 闭环必须复用。不是所有 SOP/基础设施都自动 P0；只有阻塞首个闭环的才进 P0。
- **P1**：与 code agent 相关，但不是 W0–W4 首个闭环的阻塞项；分两档：`P1-active`（相关且后续会接入，可能在 W2/W4 局部使用）与 `P1-defer`（原 N1/P2，保留 revisit trigger）。
- **Drop**：与 code agent 无关，明确不进入路线图。

## 3. 35 个 ownership cell

### P0（SOP + 核心基础设施，10 个 cell + 1 个 P0 slice）

| Cell | 覆盖 | Canonical features | codeteam W | 决策 | 备注 |
|---|---|---|---|---|---|
| `dispatch` | thread 持久 Queue Entry / targets / claim / steer / wake；A2A 执行链 | F047, F117, F167, F175, F177, F185, F247, F254, F264, F280, F295 | W1/W5 | **R0** | 当前真相 ADR-043 + F117 Phase D；F122 旧文档历史；A2A 链复用只换 invoke 内核 |
| `ball-custody` | 球权、wait、action lease、managed hold | F167, F233, F254, F280 | W1/W5 | **R1** | `Handoff`/`custody_events` 映射；状态真相在 handoffs |
| `bubble-pipeline` | provider event → visible bubble / dispatchRefs / terminal | F177, F183, F254, F264, F322 | W1/W7 | **R1** | W1 需要 response bubble/terminal 投影 |
| `identity-session` | Agent identity、session、context continuity、thread access | F032, F088, F136, F171, F183, F211, F231, F262, F291, F296, F299, F320, F322 | W0/W1/W7 | **R0/R1** | AgentProfile/AgentSession/L0；P0 只取身份/session/role，F231/F296 个人 lane 不在卡内 |
| `approval-index` | operator approval aggregation / producer registry | F246 | W4/W7 | **R0/R1** | approval decide operator-only；routine merge 按 `DP-MERGE-1=D` 走 merge-owner capability；双锚 |
| `harness-eval` | harness contract、review verdict、eval/repair | F192, F266, F267, F278, F313 | W3/W6 | **R1** | P0 只取 verdict envelope/finding/lifecycle；F266/F267/F278 R2，F311 不进 |
| `callback-auth` | invocation credential / agent-key / callback principal | F174, F178 | W2 | **R1** | per-run token / 零 secret |
| `managed-work` | admission / attempt identity | F275 | W1/W5 | **R1** | 映射 Task/Run identity；不新建 work surface；F073 主题归属在此，SOP 契约本体见 `sop-bulletin` slice |
| `plugin` | plugin/package inventory、resource activation、skill surface | F202, F247, F285, F290, F292 | W0/W4 | **R1** | P0 只取 skill surface；package admission/grants/marketplace P1-defer |
| `runtime-deployment` | daemon lifecycle / readiness / deployment identity | F300, F323 | W0/W5 | **R1** | codeteam daemon 的启停/readiness 证据 |

> P0 依据：`dispatch` / `bubble-pipeline` / `identity-session` / `callback-auth` / `managed-work` / `plugin` / `runtime-deployment` 属核心基础设施；`ball-custody` / `approval-index` / `harness-eval` 属 SOP 闭环。只有阻塞 W0–W4 首个代码 agent 闭环的才进 P0。

> **P0 slice：`sop-bulletin`**（跨 `hub-action-surface` + `managed-work`，不新增 ownership cell）。卡在 `reuse/sop-bulletin.md`，覆盖 `WorkflowSop` / `BacklogItem` 数据契约、CAS、`codeteam_update_workflow` / `get_workflow_sop`；board/rich-block UI 仍归 `hub-action-surface` 的 P1-active。F073 的主题归属仍是 `managed-work`，但 SOP 契约本体由这张 P0 卡负责。

### P1-active（非首个闭环阻塞，10 个 cell）

| Cell | 覆盖 | Canonical features | codeteam W | 决策 | 备注 |
|---|---|---|---|---|---|
| `code-intelligence` | convention graph / repo-specific extractor / freshness | F242 | W3/W4 | **R1** | 代码影响面/约定图；不是 dogfood 阻塞 |
| `github-signals` | GitHub PR/issue/check signals / wait predicate | F133, F140, F280 | W8 | **R1** | 只读 evidence + 对账 |
| `hub-action-surface` | Hub rich blocks / actions / board / artifact surface | F022, F063, F096, F120, F131, F223, F232, F284, F290, F299, F307, F310, F322 | W7 | **R1** | Mission Hub/Approval Hub 只读投影；SOP 数据契约见 `sop-bulletin` P0 slice |
| `human-disposition-feedback` | structured human why / feedback receipts | F281 | W4/W7 | **R1** | 审批/反馈证据 |
| `mcp-surface-governance` | MCP identity / exposure / resource lifecycle | F286 | W2/W5 | **R1** | codeteam MCP tools 的边界 |
| `memory` | evidence index / recall / session digest / cue | F102, F152, F209, F221, F227, F231, F255, F260, F263, F271, F276, F282, F287, F321 | W6 | **R1** | 只取代码证据相关；个人记忆 drop |
| `observability` | OTel / telemetry / invocation trajectory | F153, F299, F150, F130 | W6/W7 | **R1** | 复用 raw telemetry；轨迹 UI 可选 |
| `routing-context` | live routing context / availability / preferences | F293 | W3/W5 | **R1** | role/provider routing；不替代 dispatch |
| `thread-chat-surface` | thread chat runtime / composer / timeline | F229 | W7 | **R1** | M0 前端；C→A |
| `thread-navigation` | thread labels / pins / sidebar / filters | F057, F095, F187, F277, F297 | W7 | **R1** | M0 thread 导航 |

> P1-active 依据：与 code agent 相关，但不阻塞 W0–W4。`code-intelligence` / `github-signals` / `memory` / `observability` / `routing-context` / `mcp-surface-governance` 属扩展基础设施或代码能力；`hub-action-surface` / `thread-chat-surface` / `thread-navigation` 属 operator surface；`human-disposition-feedback` 属 SOP 扩展。
>
> 两个 hook：① `mcp-surface-governance` 的 identity/exposure 子集已被 P0 `callback-auth` 覆盖；W2 验收显式引用 F286 三条不变量（同一工具面不双暴露、admission 前不暴露、exposure tier 显式）。② `human-disposition-feedback` 不阻塞首闭环；W1 `approvals` 先加 `decided_note` 自由文本，结构化 F281 why 在 W4+ 接入。

### P1-defer（4 个 cell，原 N1/P2）

| Cell | Codeteam W | 决策 | 暂不复用原因 / revisit trigger |
|---|---|---|---|
| `action-plane` | W8+ | N1 | 企业动作/外部 CLI；需要 outbound 时再看 |
| `capability-evolution-control` | W6+ | N1 | F311 evolution program；codeteam 自身演化后再看 |
| `community-ops` | W8+ | N1 | 社区运营；只有做开源 outbound 时再看 |
| `portable-governance` | — | N1 | 项目治理 bootstrap；≥3 仓库或非 operator 执行时再看 |

> P1-defer 依据：与 code agent 相关或可服务代码 agent，但当前不复用；保留 revisit trigger，不归入 Drop。

### Drop（11 个 cell）

| Cell | 明确不复用原因 |
|---|---|
| `cat-life-settings` | 私人时间/日记；与代码交付无关 |
| `collaborative-content-plane` | 协同内容编辑；非代码交付 |
| `collective-runtime` | collective/social runtime；非代码交付 |
| `concierge-surface` | 猫猫球/concierge；非代码交付 |
| `local-host-recovery` | operator 本机 host recovery；codeteam 不接管 |
| `live-meeting` | 会议 copilot；非代码交付 |
| `owner-page-action` | 页面动作；非代码交付 |
| `proactive-relationship-loop` | 关系/主动陪伴 loop；非代码交付 |
| `signal-intake` | 外部信号/会议 intake；非代码交付；仅保留“非 GitHub 外部事件源”revisit 条件 |
| `transport` | IM 网关 non-goal；通用 delivery 已由 dispatch P0 覆盖 |
| `visible-cafe-render` | 看得见的猫咖渲染；非代码交付 |

> Drop 依据：与 code agent 的交付闭环无关；不进入路线图，不保留 W0–W8 复用义务。

> 35 个 cell 的完整 canonical/explicit features 和初始 W/decision/priority 见 `ownership-cell-reuse.tsv`。本表是决策视图，TSV 是工作清单。P1-defer 的 decision 统一为 N1（暂不复用），priority 统一记 P1。

## 4. 执行批次

### Batch 0：cell 级盘点（先做）

- 35 个 cell 全部有初始 decision/priority（本文件 + TSV）。
- 103 篇显式 `Architecture cell` 校验 token 解析。
- 220 篇 legacy 按 canonical features / topics / code anchors 补齐；无法归属的标 `legacy/unclassified`，写原因。
- 产出：`ownership-cell-reuse.tsv` + `reuse-inventory.tsv`。

**Batch 0 结果**：323/323 有 cell 或 `legacy/unclassified` + 原因；归属来源为 explicit 103 / canonical 25 / manual 83 / topic 109 / unclassified 3。

### Batch 1：P0 10 个 cell + 1 个 P0 slice

`dispatch`、`ball-custody`、`bubble-pipeline`、`identity-session`、`approval-index`、`harness-eval`、`callback-auth`、`managed-work`、`plugin`、`runtime-deployment`。

外加 `sop-bulletin`（P0 slice，跨 `hub-action-surface` + `managed-work`）。

每 cell 一页 `codeteam/reuse/<cell>.md`：

- canonical + explicit features + status；
- current truth（ADR/代码路径/当前 owner）；
- R0/R1/R2/N1/N2 + P0/P1-active/P1-defer/Drop；
- codeteam 扩展/风险/回滚；
- reviewer + operator 签字。

### Batch 2：P1-active 10 个 cell

`code-intelligence`、`github-signals`、`hub-action-surface`、`human-disposition-feedback`、`mcp-surface-governance`、`memory`、`observability`、`routing-context`、`thread-chat-surface`、`thread-navigation`。

### Batch 3：P1-defer 4 个 + Drop 11 个

- P1-defer：一页 revisit trigger 清单。
- Drop：一页 non-goal 理由清单。
- operator 一次确认，不逐篇审。

## 5. 每张 cell 决策卡的必填字段

```yaml
cell: dispatch
canonical_features: [F047, F117, F167, ...]
explicit_features: [F117, F167, F224, ...]
current_truth: docs/decisions/043-... + F117 Phase D
decision: R0
priority: P0
codeteam_mapping: W1 queue_entries / W5 dispatch adapter
code_surface: packages/api/.../InvocationQueue.ts
extension: target 从 cat 换成 profile/session
risks: [F122 旧文档历史语义, Redis vs SQLite]
revisit_trigger: null
owner: 宪宪
reviewers: [烁烁, 砚砚]
```

### Current truth 状态口径

| 状态 | 含义 | 在卡里的用法 |
|---|---|---|
| `landed + consumed` | 契约已在 clowder 落地并被真实 consumer 使用 | 卡可直接写“直接复用契约” |
| `landed, cutover partial` | 核心 adapter 已落地，production writer/cutover 仍部分关闭 | 卡必须写清 codeteam 侧开关与回滚 |
| `in-progress / partial` | 实现未完成 | 卡只能写“适配复用”，不得写成已可用 |
| `contract-frozen` | 契约已冻结，runtime 未落地 | 按“新建工作量”估算，不能当现成能力 |
| `sunset / failed-close` | 已 sunset 或明确失败关闭 | 不继承；只保留历史证据 |

## 6. 覆盖与质量门禁

- [x] 35/35 cell 有 decision/priority/owner/reviewer。
- [x] 323/323 feature 有 cell 或 `legacy/unclassified` + 原因。
- [x] 103 篇显式 cell 映射无解析错误；多 cell 保留 secondary。
- [ ] 每个 P0/P1 卡（含 `sop-bulletin` slice）有 current truth + code path（或明确“无代码/仅文档”）。
- [x] 每个 Drop 有明确 non-goal 理由。
- [ ] 每个 R0/R1 卡必须列 security invariants 继承清单：哪些 principal/授权/失败语义随契约一起搬，哪些明确不采用。
- [ ] 不允许“done 就复用”；abandoned/frozen/superseded 必须标当前真相。

## 7. 分工

| 角色 | 负责 |
|---|---|
| 宪宪 | cell 映射、矩阵、P0 卡起草、跨 cell 一致性 |
| 烁烁 | code/status/current truth、W0/W5、迁移 |
| 砚砚 | 安全/治理、W2/W3/W8、drop 风险 |
| 墨墨 | operator UX、W4/W7、优先级与文档一致性 |
| operator | P0/P1/Drop 最终签字 |

## 8. 下一步

1. ~~完成 Batch 0：35 cell 初始映射 + 220 legacy 归属。~~（已完成，见 §1 与 `reuse-inventory.tsv`）
2. Batch 1 的 10 张 P0 卡 + `sop-bulletin` slice 已起草（`reuse/`）；三猫 review + `sop-bulletin` 补审完成，P1/P2 处置已回写；operator 已于 2026-10-24 逐卡签字。
3. ~~operator 逐卡签字（10 张 cell 卡 + `sop-bulletin` slice）。~~（2026-10-24 已签）
4. P0 签完即可锁定 W0a 的复用清单；P1 不阻塞 W0a。
5. 下一层：按 `architecture/0004-reuse-architecture-review-plan.md` 做 Wave A 10 个架构项（A1×4 + A2×3 + A3×3）的组件级复用/适配/重写与变量表梳理；P1-active 10 个中 3 个已收口（github-signals/memory/observability），余 7 个（code-intelligence/hub-action-surface/human-disposition-feedback/mcp-surface-governance/routing-context/thread-chat-surface/thread-navigation）在 W4 dogfood 后补。

> 状态：approved。Batch 0 已完成：323/323 有 cell 或 `legacy/unclassified` + 原因；220 legacy 的归属来源为 canonical 25 / manual 83 / topic 109 / unclassified 3。Batch 1 的 10 张 P0 卡 + `sop-bulletin` slice 已于 2026-10-24 由 operator 签字；Batch 2 已收口 3/10，余 7 项待 W4 dogfood；Batch 3 已确认。
