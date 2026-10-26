---
title: "W3–W4 审查与 SOP 计划：独立 review、design gate"
doc_kind: plan
status: reviewed
created: 2026-10-21
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
---

# W3–W4 审查与 SOP 计划

> 覆盖：W3 独立 review 证据链、W4 SOP/design gate。
> 核心：review 不是“另一个模型说行不行”，而是身份 + 模型 + 上下文 + 证据的独立验证。

---

## W3. 独立 Review 证据链

### Goal

让代码 review 默认跨 model family，盲评、fresh context、finding 由 falsifier 关闭；低风险文档允许同族非作者，但必须显式标记。

### ReviewPolicy

```ts
interface ReviewPolicy {
  requireDifferentAuthor: true;
  requireDifferentProfile: true;        // 同一 profile 换 session 仍算同一 agent
  requireDifferentModelFamily: boolean; // 代码 true；低风险文档可 false
  allowSameFamilyForLowRiskDocs: true;
  freshContext: true;
  blind: true;
  findingRequiresFalsifier: true;
}
```

### Model family matrix

| 风险 | 身份 | 模型 | 上下文 | 证据 |
|---|---|---|---|---|
| 低风险文档 | 非作者 + 不同 profile | 同族可接受，标 `same_family_fresh` | fresh 可选 | source check |
| 普通代码 | 非作者 + 不同 profile/session | **必须不同 model family** | fresh | falsifier |
| 高风险/安全/数据 | 非作者 + 不同 profile + 独立 session | **必须不同 model family** | blind + fresh | falsifier + verifier + human gate |

规则：

- 用 `modelFamily`，不用 `provider`。同一模型换网关不算跨模型。
- reviewer 必须同时满足：不同 profile、不同 session、代码 review 不同 modelFamily；同一 profile 换 session 不算独立。
- role 是职责，不是身份；同一 profile 换 role/session 仍不算独立 review。
- `modelFamily` 是受控枚举（静态文件，随代码 review）；不进入 per-task/per-run 配置，避免配置错误静默放宽跨族校验。
- `reviews` 记录 `(author_model, author_family, reviewer_model, reviewer_family)` 四元组，供事后审计。
- DeepSeek 写 → GLM/Kimi/Qwen review 是默认。
- DeepSeek 写 → 另一个 DeepSeek session 只能标 `same_family_fresh`，不能宣称 cross-model。
- 没有可用跨族 reviewer：普通代码 `blocked`；高风险直接 human review；不得静默降级后当 cross-model 通过。
- 跨模型不是免证据金牌；finding 仍要 falsifier。

### Review envelope

`review_request` 只携带：

- task / stage / headSha / baseSha
- diff artifact
- test report / CI evidence
- acceptance criteria
- impact surface（changed symbols/callers/affected tests）
- 约束（security/data/contract）
- previous findings（仅修复轮次）

不携带：

- author transcript / 思维链
- author model / provider / persona
- 作者的总结性“我已经验证了”

### Finding schema

```ts
interface Finding {
  severity: "P1" | "P2" | "P3";
  file?: string;
  line?: number;
  claim: string;
  evidenceKind: "red_test" | "repro_command" | "static_check" | "code_reading" | "judgment";
  falsifier: string;
  falsifierExpected?: "zero" | "nonzero";
  requiredAction: string;
}
```

规则：

- P1/P2 必须带可执行 falsifier；否则自动降 P3。
- finding 创建时用 verifier 同一 policy 预校验可执行性；单条 finding 降级 P3，不整条 review 拒绝。
- falsifier 只能引用 worktree 内相对路径。
- verifier 执行 falsifier；finding 由证据关闭。
- `blocked` 仅限基础设施故障（无法启动、timeout、output cap、二进制不存在）；命令正常完成且 `exit != expected` 一律 confirmed/rejected；blocked 到期升级 human。
- audit 记录 `producingReviewId`。

### Head SHA binding

- `reviews.head_sha` / `verifications.head_sha` 必填。
- `head_sha` 必须能回溯到 coder 的 commit audit；review_request 构造时校验该 sha 存在于 audit。
- base 前进即使无冲突，也要 rebase + targeted test + fast re-review。
- head 变化 → 旧 review/verification 全部作废。
- verifier disposable copy = `base_sha + coder diff` clean checkout，不含 uncommitted 修改。

### Eval corpus

- 5 clean diffs + 5 seeded bugs（起步）。
- 每个 finding 过 falsifier，测 finding survival。
- 至少 2 个 reviewer model family 的对照数据。
- 预注册门槛，不事后调整。

### Tasks

1. 在 schema 落 `reviews.review_mode` / `head_sha` / author/reviewer model + family 四元组。
2. 改 review_request 构造器：盲评、只带 artifact/constraints。
3. 实现 `ReviewPolicy` 校验：author / profile / session / modelFamily；family 用受控枚举静态映射。
4. 实现 finding policy 预校验 + 单条 finding 降级（P1/P2 → P3）。
5. 实现 falsifier 执行与 blocked 生命周期（仅基础设施故障；到期升级 human）。
6. 实现 headSha 绑定、coder commit audit 回溯与 base 前进后的 fast re-review。
7. 扩 eval corpus 到 2 个 model family；写报告，并标注 n<20 时只作 smoke。

### Deliverables

- ReviewPolicy + enforcement code。
- blind review envelope builder。
- finding/falsifier validator。
- headSha invalidation logic。
- eval report（FP/recall/survival，按 model family 分组）。

### Acceptance

- [ ] 代码 review 的 author session 与 reviewer session 不同。
- [ ] author 与 reviewer 的 profile 不同；同一 profile 换 session 不算独立。
- [ ] 普通代码 review 的 modelFamily 不同；低风险文档同族有 `same_family_fresh` 标记。
- [ ] family 配置错误可被审计发现（受控枚举 + 四元组）。
- [ ] review_request 不含 author model/identity/transcript。
- [ ] P1/P2 无可执行 falsifier 自动降 P3。
- [ ] clean FP ≤ 20%；seeded recall ≥ 60%；survival ≥ 80%（n≥20 前只作 smoke 门槛，不用于 model family 结论）。
- [ ] 至少 2 个 model family 的对照数据。
- [ ] headSha 变化使旧证据失效。
- [ ] 每个 review_request 的 headSha 可回溯到 coder 的 commit audit。

### Risks

| 风险 | 缓解 |
|---|---|
| “非作者”被当成充分条件 | ReviewPolicy 显式要求 modelFamily；文档统一用“独立 review” |
| family 映射配置错误 | 静态受控枚举 + 独立 review；reviews 记录四元组 |
| 跨族 reviewer 不可用 | blocked/human；不允许静默同族通过 |
| falsifier 表达力不足 | policy 预校验 + 允许 `static_check`/`code_reading` 降 P3；真实测试命令逐步扩 allowlist |
| reviewer 通过 verifier 执行任意命令 | falsifier policy + worktree 相对路径 + producingReviewId + sandbox |
| eval 过拟合 | clean/seeded 负对照 + 多 repo + 预注册门槛 |

### Review focus

- 砚砚：ReviewPolicy、falsifier 信任边界、headSha、blocked 生命周期。
- 墨墨：review UX/文档是否把“独立 review”讲清楚；低风险例外是否可理解。

---

## W4. SOP 与 Design Gate：全面复用 clowder SOP

### Goal

直接复用 clowder 已验证的 SOP 控制面：feature/backlog 级 `BacklogItem` + `WorkflowSop` 告示牌、风险车道、点状硬门禁、resume capsule/baton。codeteam 只补代码交付需要的 gate 证据（artifact/review/verification/merge），不再实现第二套 SOP 状态机。

> 2026-10-24 operator 拍板：全面复用 clowder SOP。作用域为 feature/backlog 级；推进权留给猫，只锁高风险 gate。旧 W4 的串行 stage 控制器设计废弃。
> SOP 契约本体（`WorkflowSop` / `BacklogItem` / CAS / routes）见 `reuse/sop-bulletin.md`；本计划只列实现步骤与验收。

### 作用域

- `BacklogItem` + feature doc 是 feature/backlog 级作用域。
- `WorkflowSop` 以 `backlogItemId` 为 key；`stage` ∈ clowder stage ids。
- `Task` 是 backlog item 下的工作项；`Task.backlogItemId` 必填，feature 绑定用 clowder `Task.relatedFeatureId`。
- task 完成 = merge receipt；feature completion = `completion` lane + vision guard + acceptance。

### Stage model（复用 clowder，不新增 stage）

clowder `sop-definitions/development.yaml` 的 stage id：

```text
kickoff / impl / quality_gate / fresh_context / review / merge / completion
```

- 这些是告示牌车道，不是必须串行的状态机。
- `Task` / `Run` 的执行 lane 是 `impl / quality_gate / fresh_context / review / merge`；执行 lane 不反写 SOP stage。
- `verify` 是 `review` / `merge` 的 falsifier gate，不单列 stage。
- `docs-lane` / `small-change-lane` / co-creation docs lane 是风险车道子集。

### WorkflowSop contract

复用字段：`featureId`、`backlogItemId`、`sopDefinitionId`、`stage`、`batonHolder`、`nextSkill`、`resumeCapsule`、`checks`、`version`、`updatedAt`、`updatedBy`。

- 写入只校验 schema + version CAS，不校验 stage 迁移。
- `nextSkill` 是建议，不强制加载。
- Skill surface（2026-10-25 operator 拍 `DP-PLUGIN-1=A` / `DP-PLUGIN-2=A`）：`nextSkill` 经 agent repo read 落地，allowlist 只管 session 启动注入；被 allowlist 拒绝时 `next_skill_skipped_by_policy` 可见。index 常驻、正文按需；不承诺 mid-session loader 注入。
- **skill 内容迁移**：W4 的 `merge-gate`/`feat-lifecycle`/`request-review`/`receive-review`/`quality-gate` 必须按 `architecture/skill-migration.md` 逐 skill 适配；不是 copy（`merge-gate` 是 rewrite）。`DP-SKILL-1/2/3=A/A/A` 已拍（矩阵 + W0/W4 范围 + 一次性 fork）；`DP-MERGE-1=D` / `DP-MERGE-2=A` 已拍：`merge-gate` 按 merge-owner runbook + operator 硬门 + evidence checklist 重写，证据段必须保留 `MS-MERGE-1..8`；W0–W4 用 local `MergeExecutor`。供应链第一防线 = curated + repo PR review；skill path 必须 `realpath(catalog_root)` containment、拒绝绝对路径/`..`、curated allowlist + secret scan；skill 不改 tool policy/permission。没有矩阵行/验证证据的 skill 不进入 catalog。
- **S0 迁移批次**：先迁 `tdd`/`debugging`/`writing-plans`/`worktree`/`quality-gate`/`context-self-management`；每个 skill 必须有矩阵行 + must-survive + 静态检查 + 非作者 review + dry-run + 路由对账。`eval-design`/`self-evolution`/`code-as-harness` 的真相源边界见 `reuse-review/harness-eval.md` §3.8。
- 冷启动/压缩后先读 `resumeCapsule`。
- `batonHolder` 存唯一 handle。
- W1 的 `checks_json` 只接受 `attested|unknown`；W4 建 `sop_check_evidence` 后，`verified` 只能由 gate writer 带 `evidence_ref + subject_revision` 写入。
- W1 的 `stage=completion` 门槛是 backlog `done` + operator；W4 再加 vision guard / merge receipt 证据。
- backlog `done` 只允许从 `approved|dispatched` 进入；import/operator override 必须带 reason + audit。

### Source artifacts（移植清单）

- `sop-definitions/development.yaml` + `scripts/sop-definitions.mjs` + codegen；复制为 codeteam 派生目录（fork catalog），predicate 参数去坐化。
- `packages/shared/src/types/workflow-sop.ts`。
- `packages/shared/src/types/backlog.ts`（`BacklogItem` / claim / lease / audit）。
- `packages/api/src/routes/workflow-sop.ts` / `callback-workflow-sop-routes.ts`。
- `packages/api/src/domains/cats/services/stores/ports/WorkflowSopStore.ts` + Redis store；codeteam 用 SQLite 适配，CAS/字段语义不变。
- `packages/api/src/domains/cats/services/stores/ports/BacklogStore.ts`。
- W4 migration：`sop_check_evidence`（verified 证据锚；W1 不建）+ gate writer 接口。
- `cat-cafe-skills/{merge-gate,worktree,feat-lifecycle,quality-gate,request-review}` 的 SKILL.md 与 gate 语义。
- `scripts/classify-gate-route.mjs` 的五轴/assurance 语义；codeteam 适配，不直接复制 clowder 专属规则。

**Predicate 去坐化清单**：`repository: cat-cafe` → task target repo/branch；`REDIS_URL:6398` → drop/replace（codeteam 不引入 Redis）；`pnpm check:features` / `cat-cafe-runtime` / clowder docs globs → codeteam 等价检查；每条改写进 W1 继承矩阵并留 diff 说明。

### Gate model（点状硬门禁）

| Gate | 类型 | 说明 |
|---|---|---|
| `worktree` | machine | main 双向同步 + 隔离边界 |
| `design` | machine + humanWhen | spec + AC + User Journey（用户可感知时）+ risk；critical/spec_change 才 human |
| `review` | machine | 非作者 + modelFamily + fresh + blind；P1/P2 closed |
| `verify` | machine | falsifier command + exit code + log |
| `risk-consistency` | machine | declared lane/risk vs diff stats；不一致升级车道或 block |
| `merge` | policy + merge owner | clowder merge-gate 5 条 + exact HEAD continuity + merge receipt；operator 硬门单独列 |
| `completion` | machine + human | acceptance + vision guard + check:features / 等价检查 |

- **merge-gate 5 条是证据清单，不是 merge 执行授权**；operator 2026-10-25 拍 `DP-MERGE-1=D`：routine merge 由 gate 后的 merge owner 执行，operator 守硬门；C 类自动 merge 不做，A 仅零-secret 临时偏差。
  > 2026-10-25 状态注：D 的 auth / approval / custody / receipt 差量见 `architecture/merge-authority-drift-audit.md`；三猫已 accept-with-modify，D 六契约按审计 §9 冻结；`DP-MERGE-2=A`（W0–W4 D-first，local `MergeExecutor`）。
- 机器 gate 只守确定性证据；语义判断留给 author / reviewer / guardian。
- manual-only rule 只做 advisory/eval，不伪装成 runtime block。
- codeteam 的 artifact / schema / test 是 gate 证据，不新增 stage。

### Design gate

复用 clowder `feat-lifecycle` Design Gate：

- 默认机器判定：spec schema 完整 + acceptance criteria + User Journey（用户可感知时）+ risk。
- human 只在 `risk==critical` 或 `spec_change` 时介入。
- 不允许把每个跨模块改动都卡 human。
- spec 可修订；通过 `spec_change` 回到设计/计划，不直接改实现。

### Risk classification（复用五轴）

behavior / data / security / contract / irreversible。

两段式：

1. **pre-diff**：路径、依赖、API/schema、数据迁移、security boundary。
2. **post-diff**：diff stats、changed files、test changes、public API changes。

- 只升不降；author 不能自评低风险。
- `assuranceLevel` 与 `route` 分开：审查强度按风险选，验证范围按影响面选。

### Fast lanes（复用 clowder）

- **co-creation docs lane**：显然 light 的 docs 可 direct push；拿不准或进入 worktree/PR/cloud 前用 classifier。
- **docs-lane**：纯 docs / 注释 / 无代码路径；evidence-only review 或按 classifier direct push。
- **small-change-lane**：小代码改动 + targeted test + 无 public API/schema/data/auth；不跳过独立 review/verify。
- **product fast lane**：低风险局部改动由作者从实现到合入后验证；hotfix、共享底座、硬边界不借快车道跳审。
- `merge-gate` 5 条始终适用。

### Exception edges

- `spec_change`：目标/约束变化，回设计/计划。
- `plan_revision`：实现中发现计划不可行，重新计划。
- `blocker`：环境/权限/外部依赖，升级 human。
- 不允许“原地口头通过”。

### Gate telemetry

- 从 `run_events` / `reviews` / `verifications` / `merges` 派生。
- 记录通过率、block 原因分布、false block / false pass、修复成本。
- 连续 >95% 通过且从未 block 的 gate 标记剪枝候选。
- 不新建 SOP eval 平台。

### Tasks

1. 复制 clowder `sop-definitions/development.yaml` + codegen，形成 codeteam 派生目录（fork catalog）；stage id/skill/severity/predicate 类型复用，predicate 参数中性化。
2. 移植 `WorkflowSop` type/store/CAS/routes + MCP 工具（`codeteam_update_workflow` / `get_workflow_sop`），语义与 clowder 一致。
3. 建 `backlog_items` + feature doc scope；`Task.backlogItemId` / `relatedFeatureId` 绑定。
4. 实现 `resumeCapsule` / baton / checks 投影与冷启动读取。
5. 实现点状 gate：worktree、design、review、verify、merge、completion。
6. 复用 clowder 五轴风险分类语义；author 不能自评。
7. 实现 `codeteam approval list/show/approve/reject`（operator 鉴权域）：唯一审批读写通路，覆盖 design gate、spec_change、blocker、budget-pause；agent 侧只写 `approvals`。
8. 实现 `codeteam backlog create/dispatch/list`（对齐 clowder `suggested→approved→dispatched`）；`task create` 缺 backlog item 时 fail closed。
9. 从 run_events/reviews/merges 派生 gate telemetry；不另建 eval 平台。
10. 测试：docs lane、small-change lane、design gate、critical human、spec_change、completion、resume capsule、CAS 冲突、backlog create→dispatch→task、role registry 扩展。
11. **最小 thread CLI（W0–W4 dogfood）**：`codeteam thread list/show/post/tail`；thread 创建仍只走 backlog dispatch，不新增第二建 thread 通路；`post` 写 `messages`，`--after-seq` 轮询或 live tail 看 agent 回复；operator 行首 @ 走 ingress typed inbox（`DP-A3-1-3=A`）；复用 W1 `messages`/`seq`/`queue_entries`，不建第二 message store。

**Dogfood operator 交互路径（W0–W4）**：`codeteam backlog create ...` → `codeteam backlog dispatch <id>`（建 thread + kickoff + queue）→ `codeteam thread list/show <threadId>` → `codeteam thread post <threadId> "..."` → `codeteam thread tail <threadId> --after-seq N`（看 agent 回复）→ `codeteam approval list/show/approve/reject` → `codeteam merge record`。这是 CLI 里的 thread chat，不是无交流；数据仍是 W1 `messages`/`seq`/`queue_entries`，W7a/W7b 只是换渲染面。

### Deliverables

- codeteam 派生 SOP 目录（clowder schema/codegen）+ `WorkflowSop` store/routes/tools。
- `backlog_items` + `workflow_sops` schema。
- `codeteam backlog create/dispatch/list` CLI。
- 点状 gate + approval CLI。
- resume capsule / baton 投影。
- gate telemetry 报告。
- 最小 thread CLI（`list/show/post/tail`）+ afterSeq/live tail。

### Acceptance

- [ ] `WorkflowSop` 以 `backlogItemId` 为 key；stage 写入不做迁移校验（告示牌）。
- [ ] `checks.*=verified` 无 `sop_check_evidence` 证据 → 422；agent/operator 只能写 `attested|unknown`；stale evidence 读为 `unknown`。
- [ ] `sop_check_evidence` 的 `check_name × evidence_kind` 由 SQL CHECK + 应用层双重校验；`evidence_ref` 可解析到 review/merge/verification。
- [ ] `check_verified` 同事务写 audit；W7a 订阅 audit，不用 `workflow_sops.version` 当失效信号；`BacklogItem.audit` 带 `audit_truncated`+cursor。
- [ ] `stage=completion` 缺 backlog done + completion gate → 422；`markDone` 不能从 open/suggested 直接跳，operator override 有 audit。
- [ ] `sop_check_evidence` 只存 SOP check 的 verified 证据；不复制 A3-3 的 review/merge/verification 表。
- [ ] `roles` 是动态 registry：内置 4 + 前端自定义 writer 等；未知/禁用 role fail closed；`human` 不是 Role。
- [ ] 不存在引用 clowder 专属 repo/port/command/globs 的 predicate；每条改写有 diff 说明。
- [ ] task 只能绑定已存在的 backlog item；task done 不自动改 `workflow_sops.stage=completion`。
- [ ] backlog CLI 能创建/dispatch；`task create` 缺 backlog item 时 fail closed，不隐式造 item。
- [ ] docs/小改动按 clowder 风险车道走，不被完整 SOP 拖慢。
- [ ] design gate 机器默认；critical/spec_change 才 human。
- [ ] review/verify/merge gates 有 exact HEAD evidence；P1/P2 closed。
- [ ] merge gate 校验 declared lane/risk vs diff stats；不一致升级或 block。
- [ ] merge-gate 5 条只作证据清单；routine merge 由 merge-owner capability 执行，普通 agent/run token 不能自行 merge。
- [ ] completion 需要 vision guard + acceptance + merge receipt。
- [ ] resume capsule 冷启动可读；CAS 冲突可检测。
- [ ] approval materialize CAS service：claim 预留 `effect_reservation_ref`、owner receipt `approval_id` UNIQUE、recovery 按 reservation 对账；run token/agent-key 对 materialize 403。
- [ ] approval 只写 `approvals`；不存在 CLI 直接改 task/lane 状态的旁路。
- [ ] gate 通过率/block 原因可查询；有剪枝候选报告。
- [ ] operator 能用 backlog create/dispatch 建 thread，再用 `codeteam thread list/show/post/tail` 发消息并看到 agent 回复；不新增第二建 thread 通路。
- [ ] dogfood 交互路径可走通：backlog dispatch 建 thread → thread post → thread tail 看回复 → approval/merge CLI；operator 不需要 Web 也能完成一轮对话。

### Risks

| 风险 | 缓解 |
|---|---|
| “复用”变成复制第二套 SOP | 固定同一 contract；不新增 codeteam-specific stage |
| 告示牌做成控制器 | 不做 stage 迁移校验；硬约束只在 gate |
| backlog/task 作用域混淆 | `Task.backlogItemId` 必填；feature 用 `relatedFeatureId`；completion 只挂 backlog item |
| design gate 又变成 human 瓶颈 | 机器默认；human 只 critical/spec_change |
| risk 自评后门 | author 不能自评；post-diff 只升不降 |
| gate 过多 | gate 自身 eval + 剪枝候选 |
| 审批出现第二真相源 | 所有 human gate 只写 `approvals`；CLI/Console 都是投影 |

### Review focus

- 烁烁：clowder SOP contract portability、`WorkflowSop` store/CAS、backlog 作用域。
- 砚砚：点状 gate、五轴风险、review exact HEAD、approval 权限域。
- 墨墨：Design Gate/operator 体验、resume capsule、fast lane 可理解性。

---

## 依赖与顺序

- W3 依赖 W1 的 `reviews/findings/verifications/head_sha` schema。
- W3 的 falsifier 执行依赖 W2 的 policy wrapper/sandbox。
- W4 依赖 W1 的 `backlog_items`/`workflow_sops`/artifact、W3 的 review gate。
- W4 可在 W3 的 ReviewPolicy 接口冻结后与 W3 尾部并行；W4 的 review gate 必须等 W3 ReviewPolicy 落地。
- W4 不实现第二套 SOP stage engine；只移植 clowder SOP contract + 代码交付点状 gate。

## 总体验收

- 代码 review 默认跨 model family；低风险文档同族有标记。
- finding 由 falsifier 关闭；无证据 P1/P2 不允许。
- design gate 机器默认；critical/spec_change 才 human。
- 小改动 fast lane 不被拖慢。
- `WorkflowSop` 是 feature/backlog 级告示牌；task done 不等于 feature completion。
- 报告落到 `docs/reports/`（或本目录 Results 段）。

---

[宪宪/deepseek-flash🐾]
