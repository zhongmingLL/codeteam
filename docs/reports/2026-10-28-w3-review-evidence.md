# W3 独立 Review 证据链实现报告（2026-10-28）

> 范围：`docs/plans/0003-w3-w4-review-sop.md` §W3。基线 `codeteam-work`
> `cbca59473`（W2 关闭后）。实现 worktree：`../codeteam-w3-review`。
> 状态：首轮独立 review（砚砚）Changes Requested；本修订处理 P1 #1–#3、P2
> #4/#6/#8/#15，并一并收口 P3 #5/#7/#9–#14。修订后的 exact HEAD 待复验。

## 1. 交付内容

| 契约 | 落点 | 行为 |
|---|---|---|
| Model family 受控枚举 | `src/review/model-family.ts` | deepseek/glm/kimi/qwen/gemini/openai/anthropic；未知或声明不一致 fail closed |
| ReviewPolicy | `src/review/policy.ts` | 不同 session/profile；代码/高风险不同 family + fresh + blind；低风险文档同族标 `same_family_fresh`；risk 由 changedFiles 派生（auth/security/migration/schema/token 等路径自动升高风险），不再由调用方声明；无跨族 reviewer → blocked/human_required |
| 盲评 envelope | `src/review/envelope.ts` | 只带 task/stage/head/base/diff/test/AC/impact/constraints/previous findings/policy；author 身份、模型、persona、transcript、summary 不进入；free-text 只做精确身份匹配，避免子串误伤；fix round 必须引用已存储的 `previousReviewId`，previous findings 从该 review 派生 |
| Finding/falsifier 预校验 | `src/review/findings.ts` | P1/P2 的 evidenceKind 必须可执行；falsifier 解析（POSIX 双引号语义）、过 verifier policy、检查 `--flag=path`/绝对路径/`..`/node 危险 flags；单条失败降 P3；P3 文本不再硬抛，且不会被 verifyFinding 执行 |
| Falsifier 执行 | `src/review/falsifier.ts` | 默认走 sandbox；confirmed/rejected 由真实退出码决定；spawn/timeout/output cap → blocked；`blockedExpiresAt` 持久化 |
| Head SHA 绑定 | `src/review/head.ts` + `ReviewStore` | review/verification head 必填；`commit:<sha>` audit 必须绑定同一 task；verification 绑定 producing review + exact head；verify 前检查当前 worktree HEAD 等于 review head，否则返回 `not_current` 不落证据；head/base 变化返回 stale + fast re-review |
| Schema 接线 | `migrations/007-review-evidence.ts` + `008-review-round-decision.ts` + `ReviewStore` | reviews 增 base/profile/risk/policy + round/stage/previous_review_id/envelope/decision；verifications 增 blocked_expires_at；新写入要求 session 的 profile/model/family/task 与 `agent_sessions` 一致（author 须为 coder session）；旧行 additive 兼容 |
| 公共入口 | `src/review/service.ts` | `recordReview` 校验 diff artifact 与 impactSurface 一致后派生 risk；`verifyFinding` 返回 typed `verified/not_executable/not_current`；`assessFreshness` → 失效判断 |
| Audit | `policy/exec.ts` + `policy/git.ts` | verifier 命令 audit 带 `producingReviewId`；commit audit 强制 taskId/runId，head 证据可做任务级绑定 |
| Eval corpus | `test/fixtures/review-corpus/cases.json` + `src/review/eval.ts` | 5 clean + 5 seeded；glm/qwen 两族 fixture observation；真实 falsifier 执行；case id/file key 做 traversal 校验 |

## 2. 验证证据

### 2.1 包内测试

```bash
NODE_ENV=development npm --prefix packages/codeteam-daemon test
```

- 结果：**21 passed | 1 skipped（22 files）**；**171 passed | 1 skipped（172 tests）**。
- 新增 W3 测试：policy 7、envelope 6、findings 10、head 7、corpus 2、service 8，共 40 条。
- 既有 W1/W2 回归全部保持绿；1 skipped 为需要显式 env 的真实 repo first-run。

CI 同款 codeteam 三包车道：

```bash
NODE_ENV=development npm test --workspace @codeteam/pi-adapter \
  --workspace @codeteam/skills --workspace @codeteam/daemon
```

- adapter：15 passed / 1 skipped；skills：15 passed；daemon：171 passed / 1 skipped。

### 2.2 定向测试

```bash
NODE_ENV=development npm --prefix packages/codeteam-daemon test -- control-review
```

- 结果：**6 files / 40 tests passed**（含 service）。

### 2.3 类型与格式

```bash
NODE_ENV=development npx biome check packages/codeteam-daemon
# → Checked 101 files. No fixes applied.
```

```bash
NODE_ENV=development npm run build:offline
NODE_ENV=development npx tsc --noEmit -p tsconfig.json
# → build:offline pass；tsc pass
```

说明：新 worktree 初始缺少 gitignored generated model data；本次从同一 pinned
基线的主 checkout 复制 `packages/ai/src/providers/data/`（非提交内容）后，
`build:offline` 与根级 `tsc --noEmit` 均通过。

CI `check` 的静态子集也通过：

```bash
npm run check:pinned-deps
npm run check:runtime-deps
npm run check:ts-imports
npm run check:entry-graphs
npm run check:install-lock:coding-agent
npm run check:browser-smoke
```

均 exit 0；Biome：`Checked 101 files. No fixes applied.`

## 3. Eval corpus 结果

预注册门槛（写在 `cases.json`）：clean FP ≤ 20%、seeded recall ≥ 60%、
survival ≥ 80%。n=10 cases / 20 family-case observations，**只作 smoke**。

| Family | clean obs | clean FP | FP rate | seeded obs | detected | recall | confirmed | rejected | blocked | survival |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| glm | 5 | 1 | 20% | 5 | 5 | 100% | 6 | 0 | 0 | 100% |
| qwen | 5 | 0 | 0% | 5 | 4 | 80% | 4 | 1 | 0 | 80% |
| overall | 10 | 1 | 10% | 10 | 9 | 90% | 10 | 1 | 0 | 90.9% |

- 结论：harness 按预注册门槛通过。clean 误报是通过 **confirmed** 被计入（glm
  clean-5 的 `grep -q TODO` 在含 TODO 的文件上退出 0，被 confirm），不是被
  reject；qwen seeded-5 的错误 falsifier 被 reject。
- **survival 口径**：`confirmed / (confirmed + rejected)`。confirmed FP 也进入
  分子，所以 survival 不能单独当 precision 使用，必须与 clean FP 一起读。本次
  glm survival 100% 包含 1 个 confirmed FP；overall 90.9% 也包含该 FP。
- **限制**：observation 是 fixture/corpus 数据，不是 live model reviewer 输出。
  不能据此得出 glm 优于 qwen 或任意模型家族能力结论；n≥20 的真实 reviewer 运行
  才进入下一档结论。harness 已可直接接真实 reviewer finding 输出。

复现：

```bash
NODE_ENV=development npx vitest run test/control-review-corpus.test.ts \
  --reporter=verbose --silent=false --root packages/codeteam-daemon
```

## 4. Fail-closed 语义

- 同 session / 同 profile / 代码同 family / session 记录的 profile/model/family
  与 review 声明不一致 / fresh=false / blind=false /
  transcript 未排除 → 不产生 `allowed` review。
- 未知 model family 或 model 与声明 family 不一致 → `blocked`，不静默通过。
- 无跨族 reviewer：普通代码 `blocked`；高风险 `human_required`。
- risk 由 diff artifact 的 changed files 派生；`impactSurface.changedFiles` 与
  diff 不一致、diff artifact 缺失/非 diff → 拒绝写入；auth/security/migration/
  schema/token 等路径自动升为 `high_risk`。
- P1/P2 falsifier 不可解析、命令不在 verifier allowlist、绝对路径或 `..` →
  单条降 P3；review 其余 finding 仍可记录。
- `--require=/abs/x.js`、`--import=../../x` 等 flag-attached path 与 node 危险
  flags 被拒绝；falsifier 默认走 sandbox（`bwrap` 不可用 → blocked）。
- P3/降级 finding 不会被执行：`verifyFinding` 返回 `not_executable`，不落
  verification；Falsifier 解析/策略拒绝不再中断整条验证链。
- 命令正常完成但退出码不符合期望 → `rejected`，不伪造 `blocked`。
- 只有 spawn 失败/timeout/output cap/无 exit code → `blocked`；
  `blockedExpiresAt` 落库，到期扫描按持久化值升级。
- review 的 headSha 无 commit audit 或 audit 未绑定同一 task → 拒绝写入；
  verify 时当前 worktree HEAD 与 review head 不一致 → `not_current`，不落证据。
- verification 的 finding/review/head 任一不匹配 → 拒绝写入。

## 5. 首轮 review 处置（2026-10-28）

| Finding | 处置 |
|---|---|
| P1 #1 risk 由调用方声明 | `ReviewService` 读取 diff artifact，校验 `impactSurface.changedFiles` 与 diff 一致，再用 `classifyReviewRisk` 从 changed files 派生 risk；auth/security/migration/schema/token 等路径自动 high_risk |
| P1 #2 flag path + sandbox | 校验 `--flag=path`、绝对路径、`..`、node 危险 flags；node path targets 纳入 policy；`executeFalsifier` 默认 sandbox，`ReviewService` 默认 sandbox |
| P1 #3 severity-gated validation | 统一结构化 falsifier 校验；P1/P2 失败降 P3；P3 文本不硬抛；`verifyFinding` 只执行 P1/P2 可执行 finding |
| P2 #4 verify 未 pin head | 新增 current-head resolver；worktree HEAD 与 review head 不一致 → `not_current`，不落 verification |
| P2 #6 降级 finding 不可验证 | `verifyFinding` 返回 typed `not_executable`，不抛异常、不落错误证据 |
| P2 #8 blockedExpiresAt 未持久化 | migration 008 增 `verifications.blocked_expires_at`；store/service 转发；`isBlockedExpired` 优先读持久化值 |
| P2 #15 报告 FP/survival 语义写反 | 已改写：clean FP 由 confirmed 计入；survival 分子含 confirmed FP，不能单独当 precision |
| P3 #5 task binding 死代码 | `commitWithAudit` 强制 taskId/runId；`assertHeadTraceable` 对 taskId 要求 audit 绑定 |
| P3 #7 双引号 backslash | 按 POSIX 语义只转义 `\\`、`"`、`$`、`` ` ``、换行 |
| P3 #9/#10 isCurrent/head trace 不一致 | `isCurrent` 对 undefined/null base fail closed；store 复用 `assertHeadTraceable` |
| P3 #11 envelope 泄漏检查误伤/漏检 | 移除 write-only transcript/summary；free-text 精确匹配；移除 `headAudit` 返回；violations 使用稳定 code，不嵌作者模型 |
| P3 #12 previousFindings 零校验 | round>1 必须有 `previousReviewId`，previous findings 从存储 review 派生并与调用方声明精确对账 |
| P3 #13 envelope/round/decision 未持久化 | migration 008 增 round/stage/previous_review_id/envelope_json/decision_json；`Review` 可回读 |
| P3 #14 corpus 路径逃逸 | case id 白名单 + file key 绝对路径/`..` 校验 |

## 6. 已知缺口与后续

| 缺口 | 影响 | 去向 |
|---|---|---|
| 盲评的“reviewer 实际没看过 transcript”只能靠 `reviewerContext.blind/fresh/transcriptExcluded` 声明 + envelope 值泄漏检查 | 运行时上下文隔离不是 W3 单独能证明的 | W5/W7 接线时用独立 session/上下文载体继续加强 |
| eval corpus 是 fixture observation | 不能下模型家族结论 | 接真实 reviewer 输出，n≥20 后重跑 |
| blocked 到期扫描/升级 human 的调度未接 | 目前持久化 `blockedExpiresAt` 并提供 `isBlockedExpired` | W4 gate / W5 scheduler |
| 高风险 human gate 只是 policy 输出 | 不是 approval/merge 执行器 | W4/W7 approval 接线 |
| verify 只接受当前 worktree HEAD 等于 review head；不自动创建 disposable checkout | 防止错误树证据，但需要调用方准备对应 worktree | W4/W5 disposable verification worktree |
| migration 007/008 不回填旧 reviews 的 base/profile/round/envelope | 旧数据按 legacy 读，freshness 会 fail closed | 不猜测回填；需要时单独 migration |
| 新 worktree 初始缺 generated model data | 直接跑根级 build/tsc 会失败，属环境 bootstrap | 从同 pinned 基线 hydrate/copy 后复验；本次已通过 |

## 7. 回滚

- migration 007/008 只 additive 加列/索引，不回写/删除旧行；回滚到 W3 前代码时旧
  列可忽略。
- W3 新入口不改变既有 `ReviewStore` 的旧调用语义（除 head audit 强校验）；
  如需回滚，删除 `src/review/` 与新的 `review` export，保留 W1/W2 表。

## 8. 结论

W3 的六项核心契约（ReviewPolicy、盲评 envelope、finding/falsifier、headSha
绑定、reviews/verifications 接线、eval corpus）已在本地实现并通过定向与包内
回归。首轮独立 review 为 **Changes Requested**；本修订已处置全部 P1/P2 与
P3 findings，待砚砚在修订后的 exact HEAD 复验。本报告不声明 `reviewed`、
`merged` 或 `accepted`。

[宪宪/deepseek-flash🐾]
