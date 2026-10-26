---
title: "W0–W8 clowder feature 复用盘点计划"
doc_kind: plan
status: approved
created: 2026-10-24
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
---

# W0–W8 clowder feature 复用盘点计划

> 目标：以 `docs/architecture/ownership/cells/` 的 35 个架构 cell 为权威分类，锁定 W0–W4 的 P0 复用清单，再补 W5–W7 的 P1 清单和 Drop 清单。
>
> 决策矩阵：`../reuse/REUSE-MATRIX.md`；cell 工作清单：`../reuse/ownership-cell-reuse.tsv`；逐篇清单：`../reuse/reuse-inventory.tsv`。

## 1. 范围

- 35 个 ownership cell；323 篇 feature 文档（不含 `TEMPLATE.md`）。
- 103 篇已有显式 `Architecture cell:`；220 篇 legacy 已在 Batch 0 补齐归属。
- 输出：R0 直接复用 / R1 适配复用 / R2 仅借鉴 / N1 暂不复用 / N2 明确不复用 + P0/P1-active/P1-defer/Drop。
- 不输出：具体代码移植实现（W0a/W1/W4/W5 各自执行）。

## 2. 非目标

- 不为 220 篇 legacy 逐篇写深挖报告；只做归属和必要的历史/当前真相对照。
- 不把 `done` 当可复用；abandoned/frozen/superseded 必须追当前真相。
- 不重开已拍板方向（A2A tool-call-first、clowder SOP 复用、ADR-043/F117 dispatch queue（F122 历史）、TaskItem 底座）。

## 3. 批次与产出

| 批次 | 内容 | 产出 | 门禁 |
|---|---|---|---|
| Batch 0 | 35 cell 初始映射 + 220 legacy 归属 | `ownership-cell-reuse.tsv` + `reuse-inventory.tsv` | 35/35 cell 有 decision；323/323 feature 有 cell 或 legacy 原因 |
| Batch 1 | P0 10 cells + `sop-bulletin` P0 slice | `reuse/<cell>.md` ×10 + `reuse/sop-bulletin.md` | current truth + code path + 决策/优先级；operator 签字 |
| Batch 2 | P1-active 10 cells（非首个闭环阻塞） | 3 张已收口（github-signals/memory/observability）；余 7 张卡待 W4 dogfood | 已收口 3 张有 approved 卡；余 7 张可在 W4 dogfood 报告后签字 |
| Batch 3 | P1-defer 4 cells + Drop 11 cells | revisit + drop 清单 | operator 一次确认 |

## 4. 工作分解

### Batch 0：盘点（宪宪，先做）

1. 校验 103 篇显式 `Architecture cell:` token 解析（多 cell 保留 secondary）。
2. 220 篇 legacy 按 canonical features / topics / code anchors 归属；无法归属标 `legacy/unclassified` 并写原因。
3. 标出 abandoned/frozen/superseded/sunset；不把 done 自动视为可复用。
4. 生成 `ownership-cell-reuse.tsv`（35 行）和 `reuse-inventory.tsv`（323 行，含 architecture_cell/cell_source）。

**Batch 0 结果（2026-10-24）**：

- 323/323 feature 有 cell 或 `legacy/unclassified` + 原因。
- 归属来源：explicit 103 / canonical 25 / manual 83 / topic 109 / unclassified 3。
- `legacy/unclassified` 仅 3 条：F010（mobile client，Drop candidate）、F094（文档债务，无 runtime cell）、F181（reserved placeholder）。
- `reuse-inventory.tsv` 的 `decision` / `priority` / `current_truth` 已在 Batch 1 签字后按 cell default + carve-outs 回填；逐 feature 细分仍可在 Batch 2/3 调整。

### Batch 1：P0 10 cells + `sop-bulletin` slice（宪宪起草，烁烁/砚砚/墨墨分面 review）

`dispatch`、`ball-custody`、`bubble-pipeline`、`identity-session`、`approval-index`、`harness-eval`、`callback-auth`、`managed-work`、`plugin`、`runtime-deployment`。其中 `dispatch` 的复用对象是 A2A 执行链，不是单张 Queue 表；唯一执行内核替换点是 `invokeSingleCat → invokeSingleAgent → pi kernel`。

外加 `sop-bulletin`：`WorkflowSop` / `BacklogItem` 数据契约、CAS、`codeteam_update_workflow` / `get_workflow_sop`；board/rich-block UI 仍归 `hub-action-surface` P1-active。

每张卡 ≤1 页：canonical + explicit features + status；current truth；decision/priority；codeteam mapping；code surface；extension/risks；reviewer + operator 签字。

### Batch 2：P1-active 10 cells（非首个闭环阻塞）

`code-intelligence`、`github-signals`、`hub-action-surface`、`human-disposition-feedback`、`mcp-surface-governance`、`memory`、`observability`、`routing-context`、`thread-chat-surface`、`thread-navigation`。

### Batch 3：P1-defer + Drop

- P1-defer（decision 仍为 N1）：`action-plane`、`capability-evolution-control`、`community-ops`、`portable-governance`。
- Drop：`cat-life-settings`、`collaborative-content-plane`、`collective-runtime`、`concierge-surface`、`local-host-recovery`、`live-meeting`、`owner-page-action`、`proactive-relationship-loop`、`signal-intake`、`transport`、`visible-cafe-render`。
- 一页清单：cell、F-id、理由、是否 watch；operator 一次确认，不逐篇审。

## 5. 验收

- [x] 35/35 cell 有 decision/priority/owner/reviewer。
- [x] 323/323 feature 有 cell 或 legacy/unclassified + 原因。
- [x] 103 篇显式 cell 映射无解析错误；多 cell 保留 secondary。
- [x] 10 张 P0 cell 卡 + `sop-bulletin` slice 完成，每张有 current truth + code path/缺代码说明 + 决策 + 优先级。
- [ ] 10 张 P1 卡完成（可晚于 W0a）。
- [x] Drop/P1-defer 清单有理由，operator 一次确认。
- [x] 复用矩阵能被 W0a/W1/W4/W5 直接引用；不需要再翻 feature 文档才能做复用判断。

## 6. 风险

| 风险 | 缓解 |
|---|---|
| 220 篇 legacy 逐篇读，时间失控 | 只做归属；不深挖；Drop 一页过 |
| `done` 误当可复用 | 每 cell 查 ADR/代码/当前 owner；abandoned/frozen 单列 |
| cell 边界重叠 | 每篇一个 primary cell，secondary 只做交叉引用 |
| 复用决策没有 owner | 每 cell 固定 author/reviewer/operator 签字 |
| 旧 feature 文档与当前实现不一致 | current truth 以 ADR/代码为准，feature 文档只作历史 |
| 35 cell 太多，operator 审不过来 | 按 P0/P1-active/P1-defer/Drop 四档；P0 逐 cell 签，Drop 一页过 |

## 7. 下一步

1. ~~完成 Batch 0：35 cell 初始映射 + 220 legacy 归属。~~（已完成）
2. ~~起草 Batch 1 的 10 张 P0 卡 + `sop-bulletin` slice。~~（draft 11/11 已落 `reuse/`）
3. ~~三猫 review + `sop-bulletin` 补审已完成，P1/P2 处置已回写；operator 逐卡签字。~~（2026-10-24 已签）
4. P0 锁定后 W0a 直接引用；P1-active 已收口 3/10，余 7 项在 W4 dogfood 后补，P1-defer 按 revisit trigger 处理。
5. 下一层：按 `architecture/0004-reuse-architecture-review-plan.md` 做 Wave A 10 个架构项（A1×4 + A2×3 + A3×3）的组件级梳理与变量表；Wave B 4 项已提前 approved，余 7 项待 W4 dogfood。

> 状态：approved；Batch 0 已完成（323/323 有归属或理由）；Batch 1 的 10 张 P0 卡 + `sop-bulletin` slice 已于 2026-10-24 由 operator 签字；Batch 2 已收口 3/10，余 7 项待 W4 dogfood；Batch 3 已确认。
