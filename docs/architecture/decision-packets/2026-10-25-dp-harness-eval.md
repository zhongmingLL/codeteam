---
title: "DP-HE: harness-eval v1 范围、存储与 review/eval verdict 边界"
doc_kind: decision-packet
status: decided
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related_card: ../reuse-review/harness-eval.md
source_card: ../../reuse/harness-eval.md
operator_decision: "DP-HE-1=A, DP-HE-2=A, DP-HE-3=A (2026-10-25)"
review_request: "763821ad-edc7-4958-a733-5724c808443f"
review_result: "烁烁 accept；砚砚 accept-with-modify；墨墨 accept-with-modify；无 reject；均同意 A/A/A；P1/P2 已回写"
---

# DP-HE: harness-eval v1 范围、存储与 verdict 边界

> **Operator 决定（2026-10-25）：`DP-HE-1=A`、`DP-HE-2=A`、`DP-HE-3=A`。** v1 只做 P0 envelope/finding/lifecycle；存储用 artifacts + `eval_lifecycle_events` + `evals` 扩展；code review 与 eval verdict 分两本账。本 packet 冻结。

## 0.1 大白话

`harness-eval` 是“定期评估 skill / SOP / 工具 / harness 到底有没有用”的能力。它的产出叫 **eval verdict**，不是 PR 的 code review verdict。

DP-HE 只问三件事：

| 编号 | 问题 | A（推荐） | B | C |
|---|---|---|---|---|
| `DP-HE-1` | v1 做多少？ | 只做最小闭环：verdict 信封 + finding 不可变 + 生命周期只追加 | A + F266 全量 repair 闭环 | 全量 eval 平台（F192+F266+F267+F278+F313） |
| `DP-HE-2` | 数据放哪？ | `artifacts` 存证据 + `eval_lifecycle_events` 存状态 + `evals` 存指标 | 新建 `eval_verdicts`/`eval_cases`/`eval_findings` 三张表 | 只塞进通用 `audit` |
| `DP-HE-3` | code review 与 eval verdict 合账吗？ | 不合：`reviews`/`findings` 是 PR review；eval 是独立周期评估 | 合成一张 verdict 表 | — |

**A/A/A 的意思**：v1 先把“一个 eval 从结论到 owner 响应、再到复评”的最小闭环跑通；不搬 clowder 的完整 repair/measurement/inbox 平台；不建第二套 review 账本。

## 0. 一句话

v1 只做 **verdict envelope + finding 不可变 + lifecycle append-only**；F266/F267/F278 治理按 R2 借鉴，F313 只借 finding/repair 形状。**code review verdict 与 harness eval verdict 分两本账。**

## 1. 为什么现在要拍

- harness-eval 源卡已签 R1/P0，但架构卡必须回答三个会改变 W3/W6 范围的问题：v1 做到哪、数据放哪、review/eval 是否共用 verdict。
- 如果直接搬 F266/F267/F278 全量控制面，W3/W6 会被 approval-gated repair、measurement issuer、Paw-Feel inbox 拖成一个大平台；如果只做 dashboard，又会重演“有 verdict、无 owner ask/re-eval”的假闭环。
- 这三项是 **scope/storage/identity** 取舍，不是实现细节；需要 operator 拍板后冻结 W3/W6 契约。

## 2. 选项

### DP-HE-1：v1 范围

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | P0 = verdict envelope + finding 不可变 + lifecycle append-only；F266/F267/F278 R2 borrow；F313 borrow | 最小可验证闭环；W3/W6 可开工；不搬平台 | 暂不提供完整 repair/measurement/Paw-Feel |
| B | A + F266 approval-gated repair 全链路 | 更接近 clowder production | W3/W6 增加 F246/approval/custody 依赖；范围大 |
| C | 全量 eval 平台（F192+F266+F267+F278+F313） | 功能最全 | 重平台；与“先跑通 code agent 闭环”冲突 |

### DP-HE-2：存储

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | `artifacts`（eval-* kinds）+ `eval_lifecycle_events` + `evals` 扩展 | 不建第二套 verdict/case/finding 表；immutable evidence 走 artifacts；lifecycle 单一 event log | 需要 `evals.task_id` nullable / W6 迁移 |
| B | 新 `eval_verdicts`/`eval_cases`/`eval_findings` 表 | 查询直观 | 三张新表 + 与 artifacts/audit 双真相风险 |
| C | 只复用 `audit` | 零新表 | audit 不是 canonical lifecycle；transition/authority 无处落 |

### DP-HE-3：review verdict 与 eval verdict

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | `reviews`/`findings` 是 code review 唯一真相；`eval_lifecycle_events` 是 harness eval 唯一真相 | 不混账；review 不被 eval 污染 | 两套表面/权限需分别维护 |
| B | 统一一张 verdict 表 | 表面少 | review/eval 语义、权限、生命周期不同；会制造假统一 |

## 3. Operator 决定

**决定：A / A / A。**

- **DP-HE-1=A**：v1 只做 P0 envelope/finding/lifecycle；F266/F267/F278 R2 borrow；F313 borrow。W6 先跑代码域 eval，不搬 Eval Hub/Paw-Feel。
- **DP-HE-2=A**：artifacts + `eval_lifecycle_events` + `evals` 扩展；不建 `eval_verdicts`/`eval_cases`/`eval_findings`。
- **DP-HE-3=A**：code review verdict 与 eval verdict 分两本账；W3 只复用 evidence/finding/falsifier 语义，不把 eval envelope 当 review verdict。

## 4. 选择后的影响

| 选择 | W3 | W6 | 风险 |
|---|---|---|---|
| A/A/A | review 表不变；只加 evidence/finding 纪律 | eval registry + artifacts + lifecycle events + code metrics | 需要守住“不搬全量治理” |
| B/A/A | review 表不变 | F266 closure 依赖 F246/custody | W6 范围明显变大 |
| A/B/A | review 表不变 | 新表多，迁移/双写风险 | 查询直观但总状态更多 |
| A/A/B | review 与 eval 合表 | 新表/权限混用 | 语义冲突 |

## 5. 不拍的后果

- 不拍默认 **A/A/A**；W6 可先做 registry/envelope/artifacts，但 lifecycle 表与 review/eval 边界不能冻结。
- 若选 B 范围的任一项，W6 需要重排依赖（F246 approval、F267 issuer、F278 duty），不阻塞 W0–W4。
- 不拍不会阻塞 W3 review 表与 W6 registry 草案；但 W6 eval lifecycle 不应先写实现。

## 6. 拍板方式

回复 `DP-HE-1=A/B/C`、`DP-HE-2=A/B/C`、`DP-HE-3=A/B`（可一行多项）。推荐 `DP-HE-1=A, DP-HE-2=A, DP-HE-3=A`。

## 7. Review 结果（2026-10-25）

- **烁烁（accept）**：同意 A/A/A；P2 `actor_kind` 残留 `'cat'` → 已改 `agent/operator/system/migration`；4×P3（`BEGIN IMMEDIATE` seq、读面 transition 校验、`evals.status` NULL 语义、caseId 重报续案）已回写。
- **砚砚（accept-with-modify）**：同意 A/A/A；P2-1 lifecycle 写权限矩阵（11 transition × actor）已补；P2-2 eval agent 生成文本 secret 扫描已补；4×P3（F267 v1-minimal result 字段子集、状态词映射、migration backfill 锚、insufficient reasons 进 evals）已回写。
- **墨墨（accept-with-modify）**：同意 A/A/A；P2-1 W6 operator 读面（thread verdict 消息 + CLI list/open/overdue/show）已补；P2-2 `delete_sunset` gate 两层化（publish 声明 vs 执行 accept）已修；4×P3（无 findingKey 消息头、insufficient/no_data 同权显示、skill 真相源、escalated 恢复键）已回写。

**结论：operator 2026-10-25 已拍 `DP-HE-1=A, DP-HE-2=A, DP-HE-3=A`；本 packet 冻结。**

[宪宪/deepseek-flash🐾]
