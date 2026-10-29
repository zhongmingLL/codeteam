---
feature_ids: [codeteam/F014]
title: "F014: W6b Eval / Outcome / Harness Eval"
status: review
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [墨墨 (Qwen 3.8 Flash), 砚砚 (GLM 5.3 Flash)]
created: 2026-10-29
updated: 2026-10-29
architecture_review: "docs/architecture/reuse-review/harness-eval.md"
operator_decision: "A — align W6b to the approved reuse review (2026-10-29)"
---

# F014: W6b Eval / Outcome / Harness Eval

> W6 总契约以 `docs/plans/0004-w5-w8-scale-product.md` §W6 为单一真相源；
> 本 feature 承接 6B Eval/Outcome + 6F Harness Eval。详细冻结见
> [`docs/plans/0016-w6b-eval-outcome-harness-eval.md`](../plans/0016-w6b-eval-outcome-harness-eval.md)。
> 2026-10-29 operator 选择 A，已按 approved
> [`harness-eval` 架构复用检视](../architecture/reuse-review/harness-eval.md) 对齐。

## Why

W5 已经能跑 task、worker、review 和 merge，但“哪个模型/角色在什么 repo 上
交付得更好”仍然只能靠直觉。W6a 给了可回源的 evidence，W6c 给了 trajectory/
tool usage；W6b 要把这些 canonical 数据变成可决策的 eval：

- outcome episode 不再散落在聊天里；
- model-role matrix 由数据决定，synthetic fixture 不冒充 live 结论；
- harness eval 的 verdict 有 owner ask、SLA、re-eval plan 和 append-only
  case history，而不是一个 dashboard 数字；
- `delete_sunset` 这类不可逆判断必须经过 operator，eval agent 不能自签
  terminal。

## What

- **Task outcome episodes**：从 canonical `tasks/runs/reviews/findings/
  verifications/merges/budgets/messages/artifacts` 派生，落 `evals`；记录
  outcome、first-pass review、findings/轮次、tokens/cost/latency、human
  intervention、代码域指标和 W6a source refs。
- **Eval corpus / matrix**：多 provider/repo、synthetic/live 分账、n<20 只作
  smoke、live recall 无 ground truth 时为 null。
- **Harness-eval registry**：`evals/domains/*.yaml` 严格加载；`evalAgent`
  解析 active `role='eval'` profile，`handoffTargetResolver` 解析 active
  owner profile，system thread active；缺 profile/role/thread/owner fail closed。
- **Envelope/measurement**：approved 12-field `VerdictHandoffPacketV1`
  （四类 evidence refs、dailyTrend、rootCauseHypothesis、ISO 时间）+
  `EvalMeasurementResultV1`（F267 minimal，去 certificate 字段）。
- **Artifacts**：eval 证据走现有 `artifacts` 表（`task_id` 可 NULL + `eval-*`
  kinds），文件根 `${dataDir}/evals/bundles`；不建第二 artifact index。
- **Lifecycle**：`eval_lifecycle_events` append-only canonical case log；
  `actor_kind=agent|operator|system|migration`、prefixed actor_id、14 event
  types、same-case re-eval cycle、并发 seq、transition guard。
- **`evals` 扩展**：domain/bundle/verdict/window/measurement/status/reasons；
  `task_id` 可 NULL；non-ok 必填 reasons。
- **读面**：publish 同事务写 domain system thread verdict 消息；CLI
  `eval list/open/overdue/show/accept-sunset`；`delete_sunset` 未 operator
  accept 不执行；`cvo_suppressed` operator-only。

## Acceptance

- [x] AC-1: terminal task outcome episode 落 `evals`，含 outcome/review/
      findings/cost/latency/human/code metrics 与 W6a source refs。
- [x] AC-2: 2 provider / 2 repo synthetic corpus + 模型-角色矩阵报告。
- [x] AC-3: synthetic/live 分账；n<20 或 unknown family 只作 smoke；
      non-ok episode 不进质量结论；live recall=null。
- [x] AC-4: registry 严格加载；eval agent/owner/thread/model 解析；缺失/禁用
      fail closed；missing dir 返回 zero domains + warning。
- [x] AC-5: approved 12-field envelope + minimal measurement；eval 证据走
      `artifacts` 表；artifact 不可删除；重放幂等/异内容 conflict。
- [x] AC-6: `eval_lifecycle_events` append-only + actor/event matrix + 并发
      seq + same-case cycle；review/eval 两本账；无第二套 verdict/case/finding
      表。
- [x] AC-7: `evals` 扩展；`insufficient/no_data/degraded` reasons 在 evals 与
      消息头可见；legacy NULL 保留。
- [x] AC-8: publish 同事务写 domain system thread verdict 消息。
- [x] AC-9: CLI `list/open/overdue/show/accept-sunset`；未 accept 的
      `delete_sunset` 保持 awaiting，不执行删除。
- [x] AC-10: `cvo_suppressed` / accept-sunset operator-only；eval agent 不能
      自签 terminal；owner/operator/system authority 矩阵有正反测试。
- [x] AC-11: eval 自由文本 secret 扫描；无 findingKey 消息标 observation
      report；`cvoSuppressed`/unknown governance fail closed。
- [x] AC-12: 不碰 W6a memory.db/index、W6c trace/log/tool-usage store；
      不提前做 W7/W8/W5 scheduler。
- [x] AC-13: approved architecture alignment：actor_kind
      `agent/operator/system/migration`、`fix_recorded/main_landed/
      sla_escalated`、same-case cycle、artifacts 表唯一索引。

## Implementation（2026-10-29）

- 计划与冻结契约：
  [`0016-w6b-eval-outcome-harness-eval.md`](../plans/0016-w6b-eval-outcome-harness-eval.md)。
- 代码落点：
  - `packages/codeteam-daemon/src/eval/{contract,config,registry,episodes,
    report,lifecycle,artifacts,publish,redaction}.ts`。
  - `packages/codeteam-daemon/src/control/migrations/015-w6b-eval.ts`：
    `evals`/`artifacts` rebuild + `eval_lifecycle_events` + append-only triggers。
  - `packages/codeteam-daemon/src/cli/eval.ts`。
  - `evals/domains/*.yaml`：两个 dormant domain 样本。
  - `docs/reports/2026-10-29-w6b-eval-corpus.md`：2 provider × 2 repo
    synthetic smoke report。
- 验证：
  - `NODE_ENV=development npm run build:offline`：exit 0。
  - `packages/codeteam-daemon`：**77 files passed + 2 skipped；524 tests
    passed + 2 skipped**。
  - root `tsc --noEmit`：exit 0；biome changed files：clean。
  - runtime/pinned dependency、TS import、entry graph：pass。
- Review：墨墨（reuse/process）→ 砚砚（provenance/eval credibility/
  security）待进行；merge 后更新 close record。

## Review follow-up（2026-10-29，architecture-aligned re-review）

- **P2-A**：无 `findingKey` 的 `fix/build/delete_sunset` 现在 publish
  fail closed；只有 `keep_observe` 允许 observation report。
- **P2-B**：`getEvalCase`/`projectEvalCase` 读面严格重放每条 history event
  的 transition + actor authority；raw INSERT 非法 history 会 fail closed
  （新增 authority/transition 两条 raw INSERT 测试）。
- **P2-C**：`sla_escalated` 恢复六个合法来源态参数化测试；补 `migration`
  unwired 拒绝与未知 event type fail-closed 测试。
- **P3-D**：non-ok measurement 强制 `withdrawalConditions` 非空。
- **P3-E**：observation 消息头统一为 `no finding tracking`（对齐 approved §3.7）。
- **P3-F**：registry 补 `threadPolicy` 契约/解析；`metricGlossary`/fixtures/
  legacy task ids 保持。
- **P3-G**：补 raw event_type DB CHECK 测试。
- **P3-H**：CLI `overdue` 增加 escalated case 与 open case 同屏证据。
- **P3-I**：read-side replay 显式拒绝 seq≥1 的 raw `verdict_opened`。
- **P3-J**：`CODETEAM_EVAL_BUNDLES_DIR` 相对路径拒绝 `..`。
- **P3-K**：plan 记录 W7 composition 必须把 bundle cap/sample trace/SLA
  defaults 传入 publish/registry；W6b 无生产 publish caller。
- **P3-L**：caseId 保留 `\u001f` 分隔符并在 plan 记录抗碰撞理由。

## Dependencies

- W1 control schema（`tasks`/`runs`/`reviews`/`findings`/`verifications`/
  `merges`/`budgets`/`messages`/`artifacts`）。
- W3 review evidence chain。
- W5 task outcome / run usage 数据。
- W6a `EvidenceSourceRef` control ref 字符串格式（只消费格式，不读 memory.db）。
- W6c trajectory/tool-usage DTO 的 correlation key 语义（不读其 store）。
- approved `docs/architecture/reuse-review/harness-eval.md`（DP-HE-1/2/3=A）。
