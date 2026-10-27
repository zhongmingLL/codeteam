# W3 独立 Review 证据链实现报告（2026-10-28）

> 范围：`docs/plans/0003-w3-w4-review-sop.md` §W3。基线 `codeteam-work`
> `cbca59473`（W2 关闭后）。实现 worktree：`../codeteam-w3-review`。
> 状态：实现与本地验证完成；独立 review 待砚砚（代码/安全/falsifier）与
> 墨墨（eval/流程可理解性）覆盖本报告对应的 exact HEAD。

## 1. 交付内容

| 契约 | 落点 | 行为 |
|---|---|---|
| Model family 受控枚举 | `src/review/model-family.ts` | deepseek/glm/kimi/qwen/gemini/openai/anthropic；未知或声明不一致 fail closed |
| ReviewPolicy | `src/review/policy.ts` | 不同 session/profile；代码/高风险不同 family + fresh + blind；低风险文档同族标 `same_family_fresh`；无跨族 reviewer → blocked/human_required |
| 盲评 envelope | `src/review/envelope.ts` | 只带 task/stage/head/base/diff/test/AC/impact/constraints/previous findings/policy；author 身份、模型、persona、transcript、summary 不进入；构造后做 key/value 泄漏检查 |
| Finding/falsifier 预校验 | `src/review/findings.ts` | P1/P2 的 evidenceKind 必须可执行；falsifier 解析、过 verifier policy、只引用 worktree 相对路径；单条失败降 P3 |
| Falsifier 执行 | `src/review/falsifier.ts` | confirmed/rejected 由真实退出码决定；spawn/timeout/output cap → blocked；blocked 到期可升级 human |
| Head SHA 绑定 | `src/review/head.ts` + `ReviewStore` | review/verification head 必填；review 要求 `commit:<sha>` 的 `commit_created` audit；verification 绑定 producing review + exact head；head/base 变化返回 stale + fast re-review |
| Schema 接线 | `migrations/007-review-evidence.ts` + `ReviewStore` | reviews 增 `base_sha`、author/reviewer profile、`risk_class`、`policy_json`；新写入要求 base/profile/risk，session 的 profile/model/family/task 必须与 `agent_sessions` 一致（author 须为 coder session）；旧行 additive 兼容 |
| 公共入口 | `src/review/service.ts` | `recordReview` → policy/envelope/finding/store；`verifyFinding` → falsifier/store；`assessFreshness` → 失效判断 |
| Audit | `policy/exec.ts` + `policy/git.ts` | verifier 命令 audit 带 `producingReviewId`；commit audit 可带 taskId/runId |
| Eval corpus | `test/fixtures/review-corpus/cases.json` + `src/review/eval.ts` | 5 clean + 5 seeded；glm/qwen 两族 fixture observation；真实 falsifier 执行 |

## 2. 验证证据

### 2.1 包内测试

```bash
NODE_ENV=development npm --prefix packages/codeteam-daemon test
```

- 结果：**21 passed | 1 skipped（22 files）**；**159 passed | 1 skipped（160 tests）**。
- 新增 W3 测试：policy 7、envelope 4、findings 7、head 5、corpus 1、service 4，共 28 条。
- 既有 W1/W2 回归全部保持绿；1 skipped 为需要显式 env 的真实 repo first-run。

CI 同款 codeteam 三包车道：

```bash
NODE_ENV=development npm test --workspace @codeteam/pi-adapter \
  --workspace @codeteam/skills --workspace @codeteam/daemon
```

- adapter：15 passed / 1 skipped；skills：15 passed；daemon：159 passed / 1 skipped。

### 2.2 定向测试

```bash
NODE_ENV=development npm --prefix packages/codeteam-daemon test -- control-review
```

- 结果：**5 files / 23 tests passed**（不含 service；service 单独 4/4）。

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

- 结论：harness 按预注册门槛通过；falsifier 能把 clean 误报 reject、把 seeded
  finding confirm，也能把错误 falsifier reject。
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
- P1/P2 falsifier 不可解析、命令不在 verifier allowlist、绝对路径或 `..` →
  单条降 P3；review 其余 finding 仍可记录。
- 命令正常完成但退出码不符合期望 → `rejected`，不伪造 `blocked`。
- 只有 spawn 失败/timeout/output cap/无 exit code → `blocked`。
- review 的 headSha 无 commit audit → 拒绝写入。
- verification 的 finding/review/head 任一不匹配 → 拒绝写入。

## 5. 已知缺口与后续

| 缺口 | 影响 | 去向 |
|---|---|---|
| 盲评的“reviewer 实际没看过 transcript”只能靠 `reviewerContext.blind/fresh/transcriptExcluded` 声明 + envelope 值泄漏检查 | 运行时上下文隔离不是 W3 单独能证明的 | W5/W7 接线时用独立 session/上下文载体继续加强 |
| eval corpus 是 fixture observation | 不能下模型家族结论 | 接真实 reviewer 输出，n≥20 后重跑 |
| blocked 到期扫描/升级 human 的调度未接 | 目前只提供 `isBlockedExpired` + 到期时间 | W4 gate / W5 scheduler |
| 高风险 human gate 只是 policy 输出 | 不是 approval/merge 执行器 | W4/W7 approval 接线 |
| migration 007 不回填旧 reviews 的 base/profile | 旧数据按 legacy 读，freshness 会 fail closed | 不猜测回填；需要时单独 migration |
| 新 worktree 初始缺 generated model data | 直接跑根级 build/tsc 会失败，属环境 bootstrap | 从同 pinned 基线 hydrate/copy 后复验；本次已通过 |

## 6. 回滚

- migration 007 只 additive 加列/索引，不回写/删除旧行；回滚到 W3 前代码时旧
  列可忽略。
- W3 新入口不改变既有 `ReviewStore` 的旧调用语义（除 head audit 强校验）；
  如需回滚，删除 `src/review/` 与新的 `review` export，保留 W1/W2 表。

## 7. 结论

W3 的六项核心契约（ReviewPolicy、盲评 envelope、finding/falsifier、headSha
绑定、reviews/verifications 接线、eval corpus）已在本地实现并通过定向与包内
回归。独立 review 仍未发生；本报告不声明 `reviewed`、`merged` 或 `accepted`。

[宪宪/deepseek-flash🐾]
