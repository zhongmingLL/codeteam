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
> `codeteam_cross_post_message`；两者共享同一个 optional custody union，
> harness 做确定性验证。F017 要解决 **完整 A2A**：同 thread 与跨 thread 的
> 消息、custody/handoff、return/recovery 都在本 feature 内；message-only 只是
> 无 custody 的子集。旧 `a2a_send` / `handoff_*` 的模型面注册逐步移除，底层
> handler/state machine 在迁移期保留为 internal primitive。

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

> **2026-10-31 operator 进一步明确：** `codeteam_cross_post_message` 不只是
> message；当前 F017 就是把 A2A 全部解决，包括跨 thread custody/handoff。
> cross-thread A2A v1 ADR 的 message-only 结论只是输入，不是 F017 的最终边界。

## 目标态

- **`codeteam_post_message`**：discriminated union。
  - 无 `custody` = 普通讨论消息，不产生 handoff。
  - 有 `custody` = handoff；字段必须完整，缺字段 typed reject，不降级。
- **`codeteam_cross_post_message`**：同样使用 optional custody union。
  - 无 `custody` = 跨 thread 讨论消息。
  - 有 `custody` = 跨 thread handoff；必须解析 target task/thread/session/token，
    写跨 thread 交付记录与 custody events，并支持 return/recovery。
- 模型面只保留这两个入口；旧 `a2a_send`/`handoff_*` 的 `registerTool`
  移除，底层 handler/state machine 作为 internal primitive 保留到迁移完成。
- harness 校验 target/profile/session/thread scope、custody 完整性、SOP/
  authorization、idempotency、loop guard、typed error、audit；server-owned
  terminal，agent 不能自签 verified。

## 分阶段

| Phase | 范围 | 出口 |
|---|---|---|
| A | Clowder reference audit + contract/design：冻结 `post_message`/`cross_post_message` schema、共享 custody union、跨 thread custody 的 task/thread/session/token 坐标、harness invariants、SOP/skill 方向模型、迁移/兼容方案 | contract 草案 + 不变量 + E2E 矩阵；operator 确认 Phase A 边界 |
| B | facade + harness 实现；prompt/allowlist/tests 迁移；移除 `a2a_send`/`handoff_*` 模型面注册；底层 handlers 保留 | 新入口真实 RPC E2E；旧模型面不再注册 |
| C | 完整 E2E：同 thread、cross-thread message-only、cross-thread custody、return/recovery、peer @、SOP 交接；docs/BACKLOG 收口；删除旧 alias/primitive | 目标态验收；无两套模型面 |

## Harness 不变量

- `post_message` 的 custody 是 discriminated union；无 custody 是 discussion，
  有 custody 是 handoff；缺字段 typed reject，不静默降级。
- target/profile/session/thread scope 必须校验；cross-thread custody 必须解析
  target task/thread/session/token，缺任一坐标 typed reject，不能静默降级成
  message-only。
- server-owned terminal；agent 不能自签 verified。
- idempotency、loop guard、typed errors、audit；失败不静默降级/死信。
- SOP/skill 定义方向与交接责任；harness 校验“这个 handoff 是否被 SOP/
  authorization 允许”，而不是只认一张硬编码 role 表。
- peer @ 是产品愿景：所有 agent 都能 `@` 另一个 agent；开发场景的交接序列
  由开发 SOP/skill 约束，harness 负责授权/custody 验证。

## 非目标

- 修改 F016a；F016b wait / F016c Hub API 仍按原计划独立推进。
- MCP ingress、`multi_mention` 聚合、硬编码方向矩阵。
- 在两套模型面长期并存；迁移窗口要尽量短且有明确删除条件。

> Full A2A / cross-thread custody / return-recovery 归 F017；F016a/b/c 不回改，
> 也不另立第二个 cross-thread feature。

## 验收方向

Phase A 结束后由 operator 确认 contract；Phase B/C 的精确 AC 在 plan 0019
和 Phase A contract 中冻结。F017 close 的最低条件：

- [ ] 模型面只注册 `codeteam_post_message` / `codeteam_cross_post_message`；
  旧 `a2a_send`/`handoff_*` 不再出现在 worker tool registry。
- [ ] custody union 的 discussion/handoff 分支、typed reject、server-owned
  terminal、idempotency/loop guard/audit 均有 E2E。
- [ ] peer @ + SOP 方向模型可表达 coder→reviewer→coder→verifier，且 harness
  不把方向硬编码成单一 role 矩阵。
- [ ] cross-thread message-only E2E；cross-thread custody E2E（target task/
  thread/session/token、custody events、return/recovery）；缺坐标 typed reject。
- [ ] F016a/b/c 未被回改；迁移期 internal handlers 的保留/删除有记录。

## 依赖与输入

- F016a 已 closed；F017 不依赖 F016b/F016c。
- cross-thread A2A v1 调研的 message-only 结论作为**历史输入**；operator 已
  明确 F017 要覆盖完整 A2A，Phase A 必须更新/替代该 ADR 的 message-only 边界，
  不能把它当最终实现契约。
- Clowder AI 参考实现只读：`post_message`、`cross_post_message`、
  action successor、queue ledger、thread access、custody events。
- 详细拆解见 `docs/plans/0019-f017-a2a-surface-unification.md`。

[宪宪/deepseek-flash🐾]
