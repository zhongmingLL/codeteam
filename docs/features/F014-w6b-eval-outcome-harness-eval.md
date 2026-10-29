---
feature_ids: [codeteam/F014]
title: "F014: W6b Eval / Outcome / Harness Eval"
status: review
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [墨墨 (Qwen 3.8 Flash), 砚砚 (GLM 5.3 Flash)]
created: 2026-10-29
updated: 2026-10-29
---

# F014: W6b Eval / Outcome / Harness Eval

> W6 总契约以 `docs/plans/0004-w5-w8-scale-product.md` §W6 为单一真相源；
> 本 feature 承接 6B Eval/Outcome + 6F Harness Eval。详细冻结见
> [`docs/plans/0016-w6b-eval-outcome-harness-eval.md`](../plans/0016-w6b-eval-outcome-harness-eval.md)。

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
  verifications/merges/budgets/messages` 派生，落 `evals`；记录 outcome、
  first-pass review、findings/轮次、tokens/cost/latency、human intervention、
  代码域指标和 W6a source refs。
- **Eval corpus / matrix**：多 provider/repo、synthetic/live 分账、n<20 只作
  smoke、live recall 无 ground truth 时为 null。
- **Harness-eval registry**：`evals/domains/*.yaml` 严格加载；`evalAgent`
  解析到 active `role='eval'` profile；缺 profile/role/thread fail closed。
- **Envelope/lifecycle**：`EvalAgentInvocationPacket` →
  `VerdictHandoffPacket`；v1/v2 lifecycle root 与 `eval-verdict`/
  `eval-finding`/`eval-snapshot`/`eval-attribution` 不可变 artifact；
  `eval_lifecycle_events` append-only + 11 transition actor matrix + 并发 seq。
- **`evals` 扩展**：domain/bundle/verdict/window/measurement/status/reasons；
  `task_id` 可 NULL；non-ok 必填 reasons。
- **读面**：publish 同事务写 domain system thread verdict 消息；CLI
  `eval list/open/overdue/show/accept-sunset`；`delete_sunset` 未 operator
  accept 不执行；`cvo_suppressed` operator-only。

## Acceptance

- [ ] AC-1: 每个 terminal task 的 outcome episode 落 `evals`，含
      outcome/review/findings/cost/latency/human/code metrics 与 source refs。
- [ ] AC-2: 至少 2 provider / 2 repo 的 eval 数据与模型-角色矩阵报告。
- [ ] AC-3: synthetic 与 live 严格分账；n<20 只作 smoke；synthetic 永不冒充
      模型家族结论。
- [ ] AC-4: registry 可加载；`evalAgent` 解析 active `role='eval'` profile；
      缺 role/profile/thread fail closed。
- [ ] AC-5: verdict envelope + immutable artifacts；重放相同幂等、不同内容
      conflict。
- [ ] AC-6: `eval_lifecycle_events` append-only + transition guard + 并发 seq；
      review/eval 两本账；不建第二套 verdict/case/finding 表。
- [ ] AC-7: `evals` 扩展；`insufficient/no_data/degraded` reasons 在 evals 与
      消息头可见。
- [ ] AC-8: publish 同事务写 domain system thread verdict 消息。
- [ ] AC-9: CLI `list/open/overdue/show/accept-sunset`；未 accept 的
      `delete_sunset` 保持 awaiting，不执行删除。
- [ ] AC-10: `cvo_suppressed` / accept-sunset operator-only；run token / eval
      actor 不能写 terminal。
- [ ] AC-11: eval 自由文本 secret 扫描；无 findingKey 消息标 observation
      report。
- [ ] AC-12: 不碰 W6a memory.db/index、W6c trace/log/tool-usage store；
      不提前做 W7/W8/W5 scheduler。

## Implementation（2026-10-29）

- 计划与冻结契约：
  [`0016-w6b-eval-outcome-harness-eval.md`](../plans/0016-w6b-eval-outcome-harness-eval.md)。
- 代码落点：
  - `packages/codeteam-daemon/src/eval/`：contract、registry、episodes、
    report、lifecycle、artifacts、publish、redaction。
  - `packages/codeteam-daemon/src/control/migrations/015-w6b-eval.ts`：
    `evals` 扩展 + `eval_lifecycle_events` + append-only triggers。
  - `packages/codeteam-daemon/src/cli/eval.ts`：
    `eval list/open/overdue/show/accept-sunset`。
  - `evals/domains/*.yaml`：两个 dormant domain 样本，fresh install 可加载但不
    silent-fire。
  - `docs/reports/2026-10-29-w6b-eval-corpus.md`：2 provider × 2 repo 的
    synthetic smoke report，明确非 live 结论。
- 关键不变量：
  - outcome episode 只落 `evals`，同 bundle 多 snapshot 只取最新；
    synthetic/live 分账，live n<20 或 non-ok episode 不进入质量结论。
  - `eval_lifecycle_events` 是唯一 case log；11 transitions × actor matrix
    （含 `escalated` 五个来源态、`reeval_failed` 回退、`cvoSuppressed`
    packet 拒绝）；terminal 只能 operator/system；`delete_sunset` 未 operator
    accept 保持 awaiting，且不执行删除。
  - publish 在 `BEGIN IMMEDIATE` 内写 eval + `verdict_opened` + system thread
    message；artifact 0600/wx/digest 校验；自由文本 secret 扫描 fail closed。
  - review `reviews/findings/verifications` 与 eval lifecycle 两本账，测试
    断言生命周期写入不改变 review 表计数。
- 验证（`/home/ming/agent/codeteam-w6b`）：
  - `NODE_ENV=development npm run build:offline`：exit 0。
  - `packages/codeteam-daemon`：**76 files passed + 2 skipped；517 tests
    passed + 2 skipped**。
  - root `tsc --noEmit`：exit 0；`biome check`（W6b changed files）：clean。
  - `check-runtime-deps` / `check-pinned-deps` / `check-ts-relative-imports` /
    `check-entry-graphs`：pass。
- Review：墨墨（eval/harness reuse/process）→ 砚砚（provenance/eval
  credibility/security）待进行；merge 后再更新 close record。

## Dependencies

- W1 control schema（`tasks`/`runs`/`reviews`/`findings`/`verifications`/
  `merges`/`budgets`/`messages`/`artifacts`）。
- W3 review evidence chain。
- W5 task outcome / run usage 数据。
- W6a `EvidenceSourceRef` control ref 字符串格式（只消费格式，不读 memory.db）。
- W6c trajectory/tool-usage DTO 的 correlation key 语义（不读其 store）。
