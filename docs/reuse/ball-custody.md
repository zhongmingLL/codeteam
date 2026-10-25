---
cell: ball-custody
title: "P0 复用卡：Ball Custody"
doc_kind: reuse-card
status: approved
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_signoff: "approved 2026-10-24"
created: 2026-10-24
updated: 2026-10-24
---

# P0 复用卡：Ball Custody

## 结论

| 项 | 值 |
|---|---|
| decision | **R1 适配复用** |
| priority | **P0** |
| codeteam W | W1 / W5 |
| 一句话 | 复用球权/action lease/wait 的契约，codeteam 只把责任对象映射成 Handoff / Run / Wait。 |
| operator 签字 | [x] 已签（2026-10-24） |

## 覆盖

- canonical: F167 / F233 / F254 / F280
- explicit: F117 / F167 / F233 / F254 / F323 / F324
- Batch 0 legacy 归属：agent orchestration、hold/wait 相关旧 feature（见 inventory 中 `architecture_cell=ball-custody`）。

## Current truth

- **F233**：append-only `BallCustodyEventLog` 是唯一内部真相；`BallCustodyProjection` 可重建；7 状态球生命周期由纯函数状态机约束。
- **F167**：`ActionSuccessorLease` 以 tenant + subject + action family + slot 为键，负责 claim / return / replace / terminal predicate；完成必须走 `recordCompletionCandidate` → `ActionSubjectTruthResolver` → `commitCompletionVerdict(verified)`。
- **F280**：`AwaitState` 负责 typed wait、owner fence、expiry、one-shot consume 和 canonical cancel；GitHub 事实仍归 `github-signals`。
- **F254**：旧 attention/closure/supplement 机制已退役；历史事件只作证据，不恢复通知或新责任。普通 A2A 投递归 `dispatch`。
- **代码面**：`ActionSuccessorLeaseStore.ts`、`ActionSuccessorAdmissionService.ts`、`BallCustodyProjection.ts`、`ball-custody-events.ts`、`wait-continuation-carrier.ts`、`ManagedCommandWakeRecoverySweep.ts`。

## codeteam mapping

- `Handoff` = clowder `ActionSuccessorMetadata` + `BallCustodyEvent` + `waits` 的代码交付 typed envelope，新增 `expectedArtifact` / `actionPair` / `fromRole,toRole` / `deadline`。
- `Handoff` 是 A2A 执行链的 typed source；真正唤醒仍走 `queue_entries`，`handoffs`/`custody_events` 不内置第二队列。
- 完成路径：`handoff complete` = candidate；verifier evidence = resolver 输入；`commit` 才落 `consumed`。
- `custody_events` 复用 F233 事件语义，只作 append-only 审计；状态真相在 `handoffs`，重放必须对账。
- `waits` 复用 F280：timer / event / managed_command 都必须有 `wait_source_ref` 与 SLA，缺证据 fail closed。
- 不新增：第二套 custody store、新球 ID、恢复 F254 attention/closure/supplement 责任。

## 风险与回滚

- **风险 P1**：把旧 ball custody 账本当执行裁决，导致 `handoffs` 与 `custody_events` 双真相。
- **风险 P2**：wait 与 handoff deadline 双计时器冲突；裁决只认 handoff deadline/lease，wait 只驱动唤醒。
- **回滚**：`handoffs` / `custody_events` / `waits` 均为新增表；回滚到 W1 基线即可，不影响 clowder 侧账本。

## Review

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | action lease / wait / managed command 语义 | accept（本轮已处置） |
| 砚砚 | 权限、cancel authority、过期与重放 | accept（本轮已处置） |
| 墨墨 | operator 可见的 hold/wait 状态 | accept（本轮已处置） |
| operator | cell 级决策 | [x] 已签（2026-10-24） |

[宪宪/deepseek-flash🐾]
