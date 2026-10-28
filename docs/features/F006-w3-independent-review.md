---
feature_ids: [codeteam/F006]
title: "F006: W3 独立 Review 证据链"
status: in-progress
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
created: 2026-10-28
updated: 2026-10-28
---

# F006: W3 独立 Review 证据链

> 项目作用域 ID 是 `codeteam/F006`。验收清单以
> [`docs/plans/0003-w3-w4-review-sop.md`](../plans/0003-w3-w4-review-sop.md) §W3 为
> 单一真相源；实施拆分与验证映射见
> [`docs/plans/0008-w3-review-implementation.md`](../plans/0008-w3-review-implementation.md)。

## Why

W2 已把 per-run 身份、工具策略、operator/service 凭据、sandbox 与 audit 落地。W3 要回答
的不是“有没有第二个模型看过”，而是：reviewer 是否真的独立（不同 profile/session/
model family）、拿到的上下文是否盲、finding 是否能被可执行证据关闭、旧 head 的证据是否
会失效。没有这一层，W4 的 review gate 只是形式，W5 的 A2A review 也没有可信证据链。

## What

- `ReviewPolicy`：author/profile/session/modelFamily 四维校验；family 静态受控枚举。
- 盲评 `review_request` envelope：只带 artifact、约束、验收与影响面。
- Finding schema 预校验：P1/P2 无有效 falsifier 单条降 P3；falsifier 只引用 worktree 相对路径。
- Falsifier 执行：confirmed / rejected / blocked 三态；blocked 仅基础设施故障并按期升级 human。
- `reviews` / `verifications` 的 `head_sha` 绑定 coder commit audit；head/base 变化使旧证据失效。
- 5 clean + 5 seeded eval corpus，至少两个 reviewer model family 的对照数据。

## Acceptance

以 `0003` §W3 Acceptance 为准；实施映射见 `0008`。本文件只记录 slice-specific 证据。

## Evidence plan

- 定向测试：`control-review-policy` / `control-review-envelope` / `control-review-findings` /
  `control-review-head` / `control-review-corpus`。
- 包内全量：`npm --prefix packages/codeteam-daemon test`。
- 类型/格式：根级 `tsc --noEmit`、`biome check packages/codeteam-daemon`。
- 报告：`docs/reports/2026-10-28-w3-review-evidence.md`（含 smoke 边界、fail-closed 语义、
  eval corpus 指标与未覆盖项）。

## 当前进展

- 2026-10-28：实现完成，进入独立 review。新增 `src/review/`（model-family /
  policy / envelope / findings / falsifier / head / service / eval）、migration
  007、`reviews`/`verifications` 接线与 5 clean + 5 seeded corpus。
- 包内 **171 passed / 1 skipped**；新增 W3 测试 40 条；Biome clean；
  `build:offline` 与根级 tsc 通过。
- 首轮独立 review（砚砚）Changes Requested：15 findings；P1 #1–#3、P2
  #4/#6/#8/#15 与 P3 #5/#7/#9–#14 已修订，待复验。
- Eval smoke（fixture observation，非 live 模型结论）：glm FP 20% / recall
  100% / survival 100%；qwen FP 0% / recall 80% / survival 80%；overall
  FP 10% / recall 90% / seeded survival 90%；预注册门槛通过。
- 独立 review 待砚砚（代码/安全/falsifier）与墨墨（eval/流程可理解性）覆盖
  exact HEAD；尚未 merge / accepted。

## Out of scope

- W4 SOP 告示牌、gate 路由、merge executor、approval CLI。
- W5 多 task scheduler / worker pool / A2A review 执行链。
- live model reviewer 调用；corpus 先以 fixture observation 验证 harness。
- 真实外部 repo / 生产数据。

## Risks

| 风险 | 缓解 |
|---|---|
| “非作者”被当成充分条件 | policy 显式要求 profile/session/modelFamily；文档统一用“独立 review” |
| family 映射配置错误 | 静态受控枚举 + 四元组 + policy snapshot；未知/不一致直接拒绝 |
| 跨族 reviewer 不可用 | 普通代码 `blocked`；高风险 `human_required`；不静默同族通过 |
| falsifier 表达力不足 | 可执行 kind 白名单 + policy 预校验 + 单条降 P3；真实命令逐步扩 allowlist |
| fixture corpus 被误读为 live 评测 | 报告明确 smoke、n<20、synthetic observation |

[宪宪/deepseek-flash🐾]
