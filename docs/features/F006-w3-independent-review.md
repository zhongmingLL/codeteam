---
feature_ids: [codeteam/F006]
title: "F006: W3 独立 Review 证据链"
status: done
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
- 独立 review：砚砚在 `c0c7a6c3` Approved（PR comment `#issuecomment-6458628666`）；
  墨墨 eval/可理解性 Approved。15 条 inline findings 全部处置并 resolve。
- 合入：PR #43 merge `b66b8be43cc87cc2ba53cc5d5c971aeb2b14885`（`codeteam-work`）；
  CI 4/4 pass。F006 完成状态仍留 operator/vision close，不把 merge 当 accepted。
- 独立愿景守护（烁烁，非作者非 reviewer）：有条件放行——唯一条件为 F006
  follow-up ledger 固化 residual；条件已折入下方 ledger。

### Follow-up ledger（W4）

| # | 项 | 去向 |
|---|---|---|
| 1 | envelope free-text 故意子串嵌入（二阶对抗；等值匹配防不住；主作弊通道已由 risk 派生封死） | W4 test vectors / W5–W7 运行时隔离 |
| 2 | 盲评的「reviewer 实际没看过 transcript」只能靠声明 + free-text 精确匹配；结构构造不冒充盲评自证 | W5/W7 独立 session/上下文载体 |
| 3 | `not_current` / `not_executable` disposition 未落 durable audit | W4/W5 audit |
| 4 | live corpus 接线：`sandbox=true` 且 seeded `decided>0` 才允许 survival 计入门槛；fixture 不能下模型家族结论 | W4/W6 live corpus（n≥20 重跑） |
| 5 | blocked 到期扫描 / 升级 human 的调度未接（已持久化 `blockedExpiresAt` + `isBlockedExpired`） | W4 gate / W5 scheduler |
| 6 | 高风险 human gate 只是 policy 输出，不是 approval/merge 执行器 | W4/W7 approval 接线 |
| 7 | verify 只接受当前 worktree HEAD；不自动创建 disposable verification checkout | W4/W5 disposable verification worktree |
| 8 | migration 007/008 不回填旧 reviews 的 base/profile/round/envelope（旧数据 legacy 读，freshness fail closed） | 需要时单独 migration；不猜测回填 |
| 9 | 新 worktree 初始缺 generated model data（根级 build/tsc 需 hydrate/copy pinned 基线） | bootstrap 流程；本次已复验 |

### close 条件

- [x] operator 确认 F006 accepted/done（2026-10-28，消息
  `0001793157685891-003518-01d06537`："确认"）：「F006（W3 独立 Review 证据链）：
  代码合入并通过两轮独立 review（砚砚 code/security/falsifier Approved @
  `c0c7a6c3`，墨墨 eval/可理解性 Approved，15/15 resolved，CI 4/4）；0003 §W3
  验收逐条达成；eval 为 synthetic fixture smoke（n=10，不作模型家族结论，live
  挂 W4/W6 n≥20）；盲评为结构构造 + 泄漏检查，运行时隔离由 W5/W7 加强；已知
  缺口与 residual 按 F006 follow-up ledger 挂账。」

### 关闭记录（2026-10-28）

operator 确认后 F006 → `done`，W3 收口完成。vision guard 烁烁有条件放行，唯一
条件（三条 residual + 报告 §6 七行去向固化为 W4 follow-up ledger）已由 PR #45
（merge `06f6af63c`）折入并复核；砚砚 code/security/falsifier 与墨墨 eval 均
Approved，PR #43 merge `b66b8be43`，CI 4/4。

## Timeline

| 日期 | 事件 |
|---|---|
| 2026-10-28 | W3 merged (PR #43, `b66b8be43`) |

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
