---
cell: harness-eval
title: "P0 复用卡：Harness / Eval"
doc_kind: reuse-card
status: approved
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_signoff: "approved 2026-10-24"
created: 2026-10-24
updated: 2026-10-24
---

# P0 复用卡：Harness / Eval

## 结论

| 项 | 值 |
|---|---|
| decision | **R1 适配复用** |
| priority | **P0** |
| codeteam W | W3 / W6 |
| 一句话 | 复用 review verdict / finding lifecycle / eval domain，codeteam 只加代码交付指标；F311 evolution control 不进入。 |
| operator 签字 | [x] 已签（2026-10-24） |

## 覆盖

- canonical: F192 / F266 / F267 / F278 / F313
- explicit: F167 / F192 / F218 / F222 / F223 / F236 / F244 / F245 / F253 / F254 / F266 / F267 / F268 / F278 / F303 / F305 / F313
- Batch 0 legacy 归属：review/falsifier、anti-drift、verifier、merge gate、eval 相关旧 feature（见 inventory 中 `architecture_cell=harness-eval`）。

## Current truth

- **F192**：harness contract / runtime eval；verdict handoff 是 decision-bearing packet，不是普通聊天消息。
- **F266**：verdict closure control plane；finding 保持 immutable，lifecycle identity 与 append-only transition delta 分离。
- **F267**：measurement validity / owner-backed issuance；没有 measurement certificate 不能解锁 gated eval domain。
- **F278**：paw-feel disposition inbox；raw signal 与 verdict identity 分离，`routed` 不等于 fixed。
- **代码面**：`VerdictHandoffPacket`、`lifecycle-root.json`、`eval:verdict-lifecycle`、`eval-case-v1`、`PawFeelDisposition`、`eval-domain`。

## codeteam mapping

- W3：review/falsifier/verifier 复用 F192 的 verdict 语义；finding 不可变，生命周期只追加。
- W6：eval domain / metrics 复用 F267 的 measurement validity；代码域只加 build/test/merge 指标。
- 本卡 P0 范围 = verdict envelope schema + finding 不可变 + lifecycle append-only；F266/F267/F278 治理机制按 R2 借鉴，W6 接 metrics 时再逐条引用。
- 不进入：F311 capability evolution control；codeteam 不做 evolution program 产品面。
- 不新增：第二个 evidence store、第二套 review verdict 账本、dashboard 式 eval。

## 风险与回滚

- **风险 P1**：把 eval 做成 dashboard，出现 verdict 但无 owner ask / re-eval plan。
- **风险 P2**：caller-authored evidence / 空 replay window 产生 healthy verdict。
- **回滚**：W3/W6 只消费 clowder verdict/eval 契约；回滚到 W3 baseline 即可，不迁移 clowder 历史 artifact。

## Review

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | W3 review 证据链、verdict handoff | accept（本轮已处置） |
| 砚砚 | measurement validity、fail-closed、权限 | accept（本轮已处置） |
| 墨墨 | operator 可见的 verdict/finding 闭环 | accept（本轮已处置） |
| operator | cell 级决策 | [x] 已签（2026-10-24） |

[宪宪/deepseek-flash🐾]
