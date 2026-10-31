---
feature_ids: [codeteam/F017]
related_features: [codeteam/F015, codeteam/F016]
title: "F017: A2A surface unification — post_message / cross_post_message"
status: spec
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
vision_guard: 墨墨 (Qwen 3.8 Flash)
created: 2026-10-31
updated: 2026-10-31
source_plan: "docs/plans/0019-f017-a2a-surface-unification.md"
source_decision: "operator decision 2026-10-31, coordination decision:a2a-surface-unification"
---

# F017: A2A surface unification — post_message / cross_post_message

> F017 是独立的 A2A 模型面重构，不修改 F016a，也不把 F016b/F016c 拉进来。
> 目标态是 **两个模型入口**：`codeteam_post_message` 和
> `codeteam_cross_post_message`；custody 由 `post_message` 的可选 union 表达，
> harness 做确定性验证。旧 `a2a_send` / `handoff_*` 的模型面注册逐步移除，
> 底层 handler/state machine 在迁移期保留为 internal primitive。

## Why

当前模型面有 `codeteam_a2a_send` + 4 个 `codeteam_handoff_*` 工具，方向矩阵
硬编码在 role 表里；实际使用中 architect→architect review 会被直接
`forbidden`，而模型自己完全有能力判断“这次交接是否合理”。operator 的决定是：

- 统一成 `codeteam_post_message` / `codeteam_cross_post_message` 两个入口；
- 由模型判断是否带 custody，harness 只做确定性校验；
- 开发场景的方向/序列由 SOP/skill 写清（coder → reviewer，review 完
  reviewer → coder，完成后 coder → 未参与开发的验收 agent），不把方向
  矩阵硬编码成只允许 coder→reviewer；
- 避免 `a2a_send`/`handoff_*` 与新入口长期并存，否则模型选择成本和语义
  漂移都会变大。

## 目标态

- **`codeteam_post_message`**：discriminated union。
  - 无 `custody` = 普通讨论消息，不产生 handoff。
  - 有 `custody` = handoff；字段必须完整，缺字段 typed reject，不降级。
- **`codeteam_cross_post_message`**：v1 只做 message-only 跨 thread 投递；
  带 custody 直接 `forbidden`。跨 task handoff 另立 feature。
- 模型面只保留这两个入口；旧 `a2a_send`/`handoff_*` 的 `registerTool`
  移除，底层 handler/state machine 作为 internal primitive 保留到迁移完成。
- harness 校验 target/profile/session/thread scope、custody 完整性、SOP/
  authorization、idempotency、loop guard、typed error、audit；server-owned
  terminal，agent 不能自签 verified。

## 分阶段

| Phase | 范围 | 出口 |
|---|---|---|
| A | Clowder reference audit + contract/design：冻结 `post_message`/`cross_post_message` schema、custody union、harness invariants、SOP/skill 方向模型、迁移/兼容方案 | contract 草案 + 不变量 + E2E 矩阵；operator 确认 Phase A 边界 |
| B | facade + harness 实现；prompt/allowlist/tests 迁移；移除 `a2a_send`/`handoff_*` 模型面注册；底层 handlers 保留 | 新入口真实 RPC E2E；旧模型面不再注册 |
| C | 完整 E2E：同 thread、cross-thread message-only、peer @、SOP 交接；docs/BACKLOG 收口；删除旧 alias/primitive | 目标态验收；无两套模型面 |

## Harness 不变量

- `post_message` 的 custody 是 discriminated union；无 custody 是 discussion，
  有 custody 是 handoff；缺字段 typed reject，不静默降级。
- target/profile/session/thread scope 必须校验；cross-thread v1 只 message-only，
  带 custody 直接 `forbidden`。
- server-owned terminal；agent 不能自签 verified。
- idempotency、loop guard、typed errors、audit；失败不静默降级/死信。
- SOP/skill 定义方向与交接责任；harness 校验“这个 handoff 是否被 SOP/
  authorization 允许”，而不是只认一张硬编码 role 表。
- peer @ 是产品愿景：所有 agent 都能 `@` 另一个 agent；开发场景的交接序列
  由开发 SOP/skill 约束，harness 负责授权/custody 验证。

## 非目标

- full cross-task handoff v1（另立 feature；需要 source/target task 双坐标、
  target run/session/token、跨 task custody、return/recovery）。
- 修改 F016a；F016b wait / F016c Hub API 仍按原计划独立推进。
- MCP ingress、`multi_mention` 聚合、硬编码方向矩阵。
- 在两套模型面长期并存；迁移窗口要尽量短且有明确删除条件。

## 验收方向

Phase A 结束后由 operator 确认 contract；Phase B/C 的精确 AC 在 plan 0019
和 Phase A contract 中冻结。F017 close 的最低条件：

- [ ] 模型面只注册 `codeteam_post_message` / `codeteam_cross_post_message`；
  旧 `a2a_send`/`handoff_*` 不再出现在 worker tool registry。
- [ ] custody union 的 discussion/handoff 分支、typed reject、server-owned
  terminal、idempotency/loop guard/audit 均有 E2E。
- [ ] peer @ + SOP 方向模型可表达 coder→reviewer→coder→verifier，且 harness
  不把方向硬编码成单一 role 矩阵。
- [ ] cross-thread v1 message-only E2E；带 custody 的 cross-thread typed
  `forbidden`；full cross-task handoff 仍不在 v1。
- [ ] F016a/b/c 未被回改；迁移期 internal handlers 的保留/删除有记录。

## 依赖与输入

- F016a 已 closed；F017 不依赖 F016b/F016c。
- cross-thread A2A v1 调研的 **message-only** 结论作为输入（ADR 仍 proposed；
  Phase A 只把它当边界输入，不当作已签实现契约）。
- Clowder AI 参考实现只读：`post_message`、`cross_post_message`、
  action successor、queue ledger、thread access、custody events。
- 详细拆解见 `docs/plans/0019-f017-a2a-surface-unification.md`。

[宪宪/deepseek-flash🐾]
