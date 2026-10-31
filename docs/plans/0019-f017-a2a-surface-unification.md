---
title: "F017 — A2A surface unification plan（Phase A/B/C）"
doc_kind: plan
status: draft
created: 2026-10-31
updated: 2026-10-31
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
source_decision: "operator decision 2026-10-31, coordination decision:a2a-surface-unification"
feature: F017
---

# F017 — A2A surface unification

> 本计划先冻结 Phase A 的 contract/design，再进入实现。Phase A 的第一动作是
> 只读 Clowder AI 的 `post_message` / `cross_post_message` / action successor /
> queue ledger / thread access / custody events，输出 contract 草案、harness
> 不变量和 E2E 矩阵，交 operator 确认 Phase A 边界；确认前不写产品代码。

## 目标与边界

目标态：

- 模型面只有 `codeteam_post_message` / `codeteam_cross_post_message` 两个入口。
- `post_message` 用 discriminated union 表达 discussion / handoff；custody
  字段完整才接受，缺字段 typed reject。
- `cross_post_message` 与 `post_message` 共享 optional custody union；带
  custody 时必须解析 target task/thread/session/token，写跨 thread custody/
  return/recovery，缺坐标 typed reject。
- 旧 `a2a_send` / `handoff_*` 模型面移除；底层 handler/state machine 在迁移期
  保留为 internal primitive。
- SOP/skill 定义交接方向与责任；harness 校验授权/custody，不硬编码方向矩阵。

不做：

- F016a/b/c 回改；MCP ingress；`multi_mention` 聚合；两套模型面长期并存。

> Full cross-thread custody / return-recovery 归 F017，不另立第二个
> cross-thread feature；F016a/b/c 不回改。

## Phase A — Clowder reference audit + contract/design

第一动作（在新 thread 完成）：

1. 读 Clowder AI 参考实现：`post_message`、`cross_post_message`、action
   successor/lease、queue ledger、thread access、custody events 相关工具与测试；
   引用路径/行号，不把 Clowder 当运行依赖。
2. 读 codeteam 现有 A2A/custody/queue/dispatch/worker token 代码和 F016a
   E2E，列出硬不变量与需要拆分的层。
3. 输出 contract 草案：
   - `codeteam_post_message` schema：discussion/handoff union、custody 必填字段、
     target/profile/session/thread scope、idempotency、loop guard、typed errors。
   - `codeteam_cross_post_message` schema：message + custody 两种分支；
     target task/thread/session/token 解析、ACL、depth、provenance、跨 thread
     custody events、return/recovery；缺坐标的 typed reject。
   - harness invariants 与 SOP/skill 授权模型：方向/序列如何声明、harness 如何
    校验、peer @ 如何路由。
   - 迁移/兼容：旧模型面移除顺序、internal handler 保留范围、删除条件。
   - E2E 场景矩阵：same-thread discussion、same-thread custody handoff、
     cross-thread message-only、cross-thread custody、return/recovery、peer @、
     SOP coder→reviewer→coder→verifier、negative/typed errors。
4. 把 contract 草案交 operator 确认 Phase A 边界；确认前不进入 Phase B。

Phase A 出口：operator 书面确认 contract、custody union、harness 不变量与
迁移删除条件。

## Phase B — facade + harness

- 实现 `codeteam_post_message` / `codeteam_cross_post_message` facade。
- 把 custody 校验、scope、idempotency、loop guard、audit 收进 harness。
- 迁移 worker prompt、tool policy/allowlist、tests。
- 移除 `codeteam_a2a_send` / `codeteam_handoff_*` 的模型面注册；底层 handlers
  保留为 internal primitive。
- 真实 pi RPC + mock provider E2E；不把 handler 测试冒充 E2E。

## Phase C — full E2E + cleanup

- 同 thread discussion/custody、cross-thread message-only、cross-thread
  custody、return/recovery、peer @、SOP 交接全场景 E2E。
- 删除旧 alias/primitive；docs/BACKLOG 收口；记录迁移完成。
- 确认 full cross-thread custody 已在 F017 内闭环，不再拆到另一个 feature。

## 开放问题（Phase A 冻结）

- custody union 的 discriminator/必填字段/可选字段；discussion 与 handoff 的
  边界如何 typed 表达。
- `cross_post_message` 的 target task 解析：显式 taskId、当前 thread 的
  non-done task、还是目标 thread 的唯一 task；ACL 如何校验。
- 跨 thread custody 的 source/target task 双坐标、target run/session/token、
  custody events、return/recovery 和失败语义。
- SOP/skill 方向模型的数据形状：在 skill 里写序列，还是 harness 读
  workflow/SOP；如何避免再次硬编码 role 矩阵。
- peer @ 的路由：文本 `@handle` 如何映射到 profile/thread；是否只允许显式
  target profile。
- 迁移窗口：旧模型面何时删除；internal handler 的保留/删除条件；是否需要
  短期 alias。
- idempotency 命名空间、loop guard、cross-thread depth、audit 事件形状。

## 风险与回滚

- 两套模型面并存会提高模型选择成本和语义漂移；Phase B 必须有明确删除条件，
  不能无限期保留 alias。
- 把 custody 塞进普通 message 可能导致“消息送达 = 责任转移”的误读；union
  必须 typed，且缺字段 fail closed。
- cross-thread custody 的坐标/授权缺失时必须 typed reject；不要用 fallback
  把它悄悄降级成 discussion，也不要把 full A2A 再拆到另一个 feature。
- SOP/skill 方向模型如果过弱，harness 会重新变成硬编码；Phase A 必须让
  operator 确认授权来源。
- 回滚以 Phase 为单位：Phase B 可保留 internal handlers 回退到旧模型面；
  Phase C 删除前必须确认新面 E2E 全绿。

## 依赖与顺序

1. F016a closed（A2A/custody/queue 基线）。
2. cross-thread A2A v1 message-only 调研结论作为历史输入；operator 已明确
   F017 覆盖完整 A2A，Phase A 必须更新/替代 ADR 的 message-only 边界。
3. F017 Phase A → operator 确认 → Phase B → Phase C；F016b/F016c 独立推进。

## Review

- 烁烁：A2A/dispatch/queue/peer @ 路由。
- 砚砚：custody/auth/security/typed reject。
- 墨墨：SOP/skill 方向模型、reuse/process、operator 体验。
- 宪宪：feature ownership、contract 与 F016 边界。

[宪宪/deepseek-flash🐾]
