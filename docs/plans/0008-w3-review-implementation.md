---
title: "W3 独立 Review 证据链实施计划"
doc_kind: plan
status: implemented
created: 2026-10-28
updated: 2026-10-28
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
source: "docs/plans/0003-w3-w4-review-sop.md §W3"
---

# W3 独立 Review 证据链实施计划

> 本计划把 `0003-w3-w4-review-sop.md` §W3 的契约落到 `packages/codeteam-daemon`。
> W3 的验收仍以 `0003` 为单一真相源；本文件只写实现拆分、契约落点和验证映射。

## 目标与范围

让代码 review 从“另一个模型说行不行”变成可审计的独立验证：

- `ReviewPolicy` 校验 author / profile / session / modelFamily，family 使用静态受控枚举。
- `review_request` 构造器只暴露盲评 envelope，不携带 author 身份、模型、persona 或 transcript。
- Finding 创建时用 verifier 同一 policy 预校验 falsifier；单条 P1/P2 不可执行时降 P3。
- Falsifier 由 verifier 执行，finding 由证据关闭；blocked 只用于基础设施故障并按期升级 human。
- `reviews` / `verifications` 的 `head_sha` 可回溯到 coder commit audit；head/base 变化使旧证据失效。
- 建立 5 clean + 5 seeded 的 eval corpus；至少两个 reviewer model family 的对照数据，n<20 只作 smoke。

不在本阶段：

- W4 SOP stage 告示牌、gate 路由、merge executor。
- W5 多 task scheduler / worker pool / worktree pool。
- 真实外部模型调用与生产数据；eval corpus 先以可复现 fixture 验证 harness。

## 关键契约与决定

### 1. Model family 是静态受控枚举

- 新增 `packages/codeteam-daemon/src/review/model-family.ts`。
- 只接受注册表内的 family；模型名可解析时，声明的 family 必须与解析结果一致。
- 未知模型 / family 直接 `invalid_input`，不静默接受。
- `provider` 不参与跨模型判断；同一模型换网关仍是同一 family。

### 2. ReviewPolicy 是独立验证的唯一入口

- `ReviewRisk = low_risk_docs | code | high_risk`。
- `code` / `high_risk` 必须不同 profile、不同 session、不同 modelFamily、fresh + blind。
- `low_risk_docs` 允许同 family，但必须标 `same_family_fresh`，且仍有不同 profile/session。
- 同 profile 换 session 不算独立；同 session 直接拒绝。
- 没有可用跨族 reviewer：普通代码返回 `blocked`；高风险返回 `human_required`；不静默降级。
- 高风险额外要求 verifier + human gate。

### 3. 盲评 envelope

- 只携带 task / stage / headSha / baseSha、diff artifact、test/CI evidence、acceptance criteria、
  impact surface、constraints、修复轮 previous findings、policy 摘要。
- 不携带 author session/profile/model/modelFamily/provider/persona/transcript/summary。
- 构造器同时做 head audit 回溯和 policy 评估；`previousFindings` 只在 round>1 出现。
- 构造后执行 key/value 泄漏检查，author 身份值出现在 envelope 中即拒绝。

### 4. Finding 预校验与降级

- P1/P2 的 `evidenceKind` 必须是 `red_test | repro_command | static_check` 且 falsifier 可解析、
  过 verifier policy、只引用 worktree 内相对路径。
- 任一条不满足只把该 finding 降 P3，不拒绝整条 review；降级原因写 audit。
- `code_reading` / `judgment` 可作 P3 证据，不作为 P1/P2 的可执行 falsifier。
- Falsifier 语法为无 shell 的 argv 字符串；引号内空白允许，shell 元字符拒绝。

### 5. Falsifier 执行与 blocked 生命周期

- verifier 用现有 `runCommand` + verifier `ToolPolicy` 执行，audit 带 `producingReviewId`。
- 默认期望：`red_test` / `repro_command` 非零，`static_check` 零；finding 可显式覆盖。
- 退出码符合期望 → `confirmed`；命令正常完成但不符合 → `rejected`。
- spawn 失败、timeout、output cap → `blocked`；blocked 记录到期时间，到期升级 human。
- 策略拒绝不是 blocked：预校验阶段降 P3；执行阶段视为契约错误，不伪造 finding 结论。

### 6. Head SHA 绑定与失效

- `reviews.head_sha` / `verifications.head_sha` 必填且格式校验。
- `ReviewStore.create` 要求 `commit:<head_sha>` 的 `commit_created` audit 存在；可带 taskId 时校验归属。
- `verifications` 必须绑定 finding 所属 review，且 head 必须等于 review head。
- head 变化：旧 review + 旧 verification 全部失效，要求 fast re-review。
- base 前进（head 未变）：review 失效，要求 rebase + targeted test + fast re-review。
- 失效是读模型判断，不 UPDATE 历史 review 行；审计历史保持 append-only。

### 7. Eval corpus

- `packages/codeteam-daemon/test/fixtures/review-corpus/cases.json`：5 clean + 5 seeded。
- 每个 case 有 glm / qwen 两个 reviewer family 的 fixture observation。
- harness 用真实 verifier policy 执行每条 finding 的 falsifier；survival 只计
  seeded findings，clean confirmed FP 不进 survival，避免指标互相污染。
- 预注册门槛：clean FP ≤ 20%、seeded recall ≥ 60%、survival ≥ 80%。
- n=10 cases（20 family-case observations）只作 smoke；报告明确不能据此下模型家族结论。

## 工作单元

### W3-1 Model family registry + ReviewPolicy

改动位置：

- `packages/codeteam-daemon/src/review/model-family.ts`
- `packages/codeteam-daemon/src/review/policy.ts`

可观察结果：给定 author/reviewer/risk，返回 `allowed | blocked | human_required`、review mode、
violations；未知 family / 声明不一致被拒绝。

验证：`test/control-review-policy.test.ts`。

### W3-2 盲评 envelope + head 回溯

改动位置：

- `packages/codeteam-daemon/src/review/envelope.ts`
- `packages/codeteam-daemon/src/review/head.ts`

可观察结果：envelope 只含允许字段；author 身份/模型/transcript 不出现；headSha 无 commit audit 时拒绝；
round=1 携带 previous findings 时拒绝。

验证：`test/control-review-envelope.test.ts`。

### W3-3 Finding/falsifier 预校验 + 执行

改动位置：

- `packages/codeteam-daemon/src/review/findings.ts`
- `packages/codeteam-daemon/src/review/falsifier.ts`
- `packages/codeteam-daemon/src/policy/exec.ts`（audit 增 `producingReviewId`）

可观察结果：P1/P2 无有效 falsifier 降 P3；shell 元字符/绝对路径/`..` 拒绝；
confirmed/rejected/blocked 三态由真实退出码和基础设施状态决定；blocked 到期可升级。

验证：`test/control-review-findings.test.ts`。

### W3-4 Schema 与 store 接线

改动位置：

- `packages/codeteam-daemon/src/control/migrations/007-review-evidence.ts`
- `packages/codeteam-daemon/src/control/migrations/008-review-round-decision.ts`
- `packages/codeteam-daemon/src/control/migrations/index.ts`
- `packages/codeteam-daemon/src/control/stores/types.ts`
- `packages/codeteam-daemon/src/control/stores/reviews.ts`
- `packages/codeteam-daemon/src/policy/git.ts`（commit audit 可带 taskId/runId）

可观察结果：reviews 记录 baseSha、author/reviewer profile、riskClass、policy snapshot；
verification 绑定 producing review + exact head；head 变化可计算失效。

验证：schema/migration/store 相关测试 + `test/control-review-head.test.ts`。

### W3-5 ReviewService 公共入口

改动位置：

- `packages/codeteam-daemon/src/review/service.ts`
- `packages/codeteam-daemon/src/review/index.ts`
- `packages/codeteam-daemon/src/index.ts`

可观察结果：`recordReview` 串起 policy → envelope → finding 预校验 → store；`verifyFinding`
串起 finding/review 校验 → falsifier 执行 → verification 落库；`assessFreshness` 返回失效原因。

验证：service 集成测试 + 现有 governance/read-model 回归。

### W3-6 Eval corpus + 报告

改动位置：

- `packages/codeteam-daemon/test/fixtures/review-corpus/cases.json`
- `packages/codeteam-daemon/test/control-review-corpus.test.ts`
- `docs/reports/2026-10-28-w3-review-evidence.md`

可观察结果：10 个 case 的真实 falsifier 执行结果，按 family 汇总 FP/recall/survival；
门槛断言通过；报告写清 smoke 边界与未覆盖项。

验证：`npm --prefix packages/codeteam-daemon test -- control-review-corpus`。

## 验收映射（`0003` §W3）

| Acceptance | 实现落点 | 验证 |
|---|---|---|
| 代码 review 的 author session 与 reviewer session 不同 | `policy.ts` + `reviews.ts` CHECK | policy tests + schema test |
| author/reviewer profile 不同；同 profile 换 session 不算独立 | `policy.ts` + service 派生 profile | policy tests |
| 普通代码 modelFamily 不同；低风险文档有 `same_family_fresh` | `policy.ts` + `reviews.review_mode` | policy tests |
| family 配置错误可审计（受控枚举 + 四元组） | `model-family.ts` + reviews 四元组/policy snapshot | policy + store tests |
| review_request 不含 author model/identity/transcript | `envelope.ts` | envelope tests |
| P1/P2 无可执行 falsifier 自动降 P3 | `findings.ts` + store | finding tests |
| clean FP ≤20% / seeded recall ≥60% / survival ≥80%（n<20 smoke） | corpus + harness | corpus test |
| 至少 2 个 model family 对照数据 | corpus observations | corpus test |
| headSha 变化使旧证据失效 | `head.ts` + freshness | head tests |
| 每个 review_request 的 headSha 可回溯 coder commit audit | `head.ts` + store guard | head tests |

## 验证命令

```bash
# 定向
NODE_ENV=development npm --prefix packages/codeteam-daemon test -- control-review

# 包内全量
NODE_ENV=development npm --prefix packages/codeteam-daemon test

# 类型与格式
NODE_ENV=development npx tsc --noEmit -p tsconfig.json
NODE_ENV=development npx biome check packages/codeteam-daemon
```

## 风险与已知缺口

| 风险 / 缺口 | 处置 |
|---|---|
| 盲评 envelope 不能自动证明 reviewer 没看过 author transcript | 记录 `reviewerContext.blind/fresh/transcriptExcluded` 声明 + envelope 值泄漏检查；运行时上下文隔离由 W5/W7 接线继续加强 |
| fixture corpus 不是 live model 评测 | 报告标 smoke；harness 可直接接真实 reviewer 输出，n≥20 后再做 family 结论 |
| migration 007/008 只 additive 加列，旧 reviews 的 base/profile/round/envelope 为空 | 新写入路径强制；旧数据按 legacy 读，不做回填猜测 |
| blocked 到期升级 human 依赖 daemon 调度 | W3 提供 `isBlockedExpired` + 到期时间；定时扫描随 W5/W4 gate 接线 |
| 高风险 human gate 是 policy 输出，不是审批执行器 | 返回 `human_required`；approval/merge 执行仍由 W4/W7 负责 |

## 状态

- 2026-10-28：计划建立并完成 TDD 实现。
- 2026-10-28：首轮独立 review（砚砚）Changes Requested；修订处置 P1 #1–#3、
  P2 #4/#6/#8/#15 与 P3 #5/#7/#9–#14。
- 2026-10-28：包内 **171 passed / 1 skipped**；新增 W3 测试 40 条；Biome clean；
  `build:offline` 与根级 `tsc --noEmit` 通过。证据报告：
  [`docs/reports/2026-10-28-w3-review-evidence.md`](../reports/2026-10-28-w3-review-evidence.md)。
- 待独立 review（砚砚代码/安全/falsifier；墨墨 eval/流程）覆盖 exact HEAD；未声明
  merged / accepted。

[宪宪/deepseek-flash🐾]
