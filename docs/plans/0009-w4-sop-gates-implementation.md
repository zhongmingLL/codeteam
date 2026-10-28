---
title: "W4 SOP 复用与点状 Gate 实施计划"
doc_kind: plan
status: implemented
created: 2026-10-28
updated: 2026-10-28
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
source: "docs/plans/0003-w3-w4-review-sop.md §W4"
---

# W4 SOP 复用与点状 Gate 实施计划

> 本计划把 `0003-w3-w4-review-sop.md` §W4 落成可实施、可验收的切片。
> W4 的契约与验收仍以 `0003` 为单一真相源；本文件只写实现落点、依赖、
> 切片顺序和验证映射。实现遇到契约冲突时回 `0003` / `sop-bulletin.md`，
> 不在代码里另造一套语义。

## 目标与边界

目标是让 codeteam 的 feature/backlog 级 SOP 与代码交付门禁真正可用：

- `BacklogItem` + `WorkflowSop` 是 feature/backlog 级告示牌；stage 不串行、
  不反写执行 lane。
- `checks=verified` 只能由带 `sop_check_evidence` 的 gate writer 写入；
  stale evidence 读为 `unknown`。
- 点状 gate 只消费已有证据：worktree / design / review / verify /
  risk-consistency / merge / completion。
- operator 能用 CLI 完成 backlog → dispatch → thread 对话 → approval →
  merge receipt 的一轮 dogfood。

不在 W4：

- 第二套 SOP 状态机、stage 控制器、第二套 message/thread store。
- W5 的 QueueProcessor / AgentRouter / worktree pool / 多 task 调度。
- W7a 的 headless HTTP API / Console；W8 的 GitHub adapter。
- 自动 merge（C 类）；routine merge 必须经过 gate 后的
  `service:merge-owner` 执行。

## 两个显式 scope 决定

### D1. W0–W4 的 operator surface 是 CLI，不是 HTTP/MCP

`0003` §W4 任务 2/7/11 写的是 routes + MCP tools + CLI。codeteam 当前没有
控制面 HTTP server，也没有对应 MCP server；W7a 才拥有 headless API。
W4 的 dogfood 验收明确要求“operator 不需要 Web 也能完成一轮对话”。

因此 W4 先落 **service + CLI**，暂不新增 HTTP/MCP surface：

- CLI 直接调用 `ControlStore` / 新 service，不绕过 store，不建第二状态机。
- W7a 复用同一 service 方法暴露 HTTP/事件；届时只加 transport，不重写语义。
- 在 W4 报告里把这一点列为 intentional divergence，并要求 W7a 回读。

### D2. agent 回复的 production runner 归 W5，W4 验证的是 durable 投递链

W4 的最小 thread CLI 只负责 operator 侧：`list/show/post/tail`。agent 回复
由 W1 的 `messages` / `queue_entries` / `cutoverQueueEntry` 持久化链路承载；
真实模型执行器（QueueProcessor → AgentRouter → pi kernel）是 W5。

W4 dogfood 测试使用测试内的 agent executor 调 `cutoverQueueEntry` 写入
真实的 `agent_response`，再由 CLI `thread tail` 读出；不伪造 CLI 输出，
也不把 W5 runner 塞进 W4。报告必须把这个边界写清楚。

## 关键契约

### 1. SOP catalog 是 fork，不是运行时依赖

- 源：clowder `sop-definitions/development.yaml` + codegen 语义。
- 落点：`sop-definitions/development.yaml`、
  `scripts/sop-definitions.mjs`、`packages/codeteam-daemon/src/control/
  sop-definition.generated.ts`。
- stage id 固定 7 个：`kickoff/impl/quality_gate/fresh_context/review/
  merge/completion`。不新增 stage。
- predicate 参数去 clowder 化：不出现 `cat-cafe`、Redis 6398/6399、
  `pnpm check:features`、clowder docs globs；换成 codeteam 路径/命令或
  显式 `unknown`。
- codegen 输出可重复生成；`node scripts/sop-definitions.mjs --check` 检查
  drift（生成后不改手写文件）；daemon catalog test 直接跑该检查。

### 2. checks 写权与证据

- `workflow_sops.checks_json` 只允许 `attested|unknown`；SQL trigger +
  应用层双重拒绝 `verified`。
- `sop_check_evidence` 只存 verified 证据：
  `(backlog_item_id, check_name, evidence_kind, evidence_ref,
  subject_revision, recorded_by, recorded_at)`。
- `check_name × evidence_kind` 固定映射：
  `remoteMainSynced→git_sync`、`qualityGatePassed→quality_gate`、
  `reviewApproved→review`、`visionGuardDone→vision_guard`；SQL CHECK +
  应用层双重校验。
- `evidence_ref` 必须可解析到 canonical 行：`git:<sha>`、
  `review:<id>`、`merge:<id>`、`verification:<id>`、`artifact:<id>`、
  `message:<id>`。解析失败 → 422，不写证据。
- 读投影：最新 evidence 的 `subject_revision` 与调用方给出的 current
  revision 不一致 → 有效值降 `unknown` + `stale_evidence`；不静默显示
  verified。CLI `sop show --head-sha` 提供 current revision。
- evidence 写入同事务追加 `audit(action='check_verified')`；
  `workflow_sops.version` 不因 evidence 变化 bump。

### 3. completion 是唯一有写入 gate 的 stage

`stage=completion` 必须同时满足：

1. backlog `status=done`；
2. actor 是 operator（`updatedBy` 以 `operator:` 开头）；
3. `visionGuardDone` 有 fresh `vision_guard` evidence；
4. 该 backlog 下的 task 至少有一条 `status=succeeded` 的 merge receipt。

缺任一 → 422 `completion_gate_required`，不写 stage。其他 stage 仍是告示牌，
不做迁移校验。

### 4. 点状 gate 只产出判断，不造状态机

- `worktree`：main/base 双向同步 + 隔离边界；unknown 事实 fail closed。
- `design`：spec/AC/User Journey/risk 完整；机器默认，`critical` 或
  `spec_change` 才要求 human approval。
- `review`：exact HEAD/base 的非作者独立 approve；当前 P1/P2 全部有
  terminal falsifier closure。
- `verify`：P1/P2 falsifier 在 exact HEAD 执行；`confirmed` 未关闭 →
  block；`blocked` 未到期 → block；到期 → block + 升级提示。
- `risk-consistency`：declared lane/risk 只能升级、不能降级；与 diff stats
  不一致 → block 或升级。
- `merge`：组合 worktree/review/verify/risk；exact HEAD continuity；
  routine 由 `service:merge-owner` 执行；hard gate 才要 accepted merge
  approval。
- `completion`：backlog done + vision guard + merge receipt + acceptance。
- 每次 `gate check` / merge preflight 写 `audit(action='gate_evaluated')`，
  供 telemetry 派生；不新建 eval 平台。

### 5. merge receipt 契约

按 `merge-authority-drift-audit.md` §9：

- `merges` 增 `executed_by` / `gate_evidence_ref` / `review_ref` /
  `status(succeeded|failed|unknown)` / `failure_ref` / `hard_gate` /
  `strategy` / `repo` / `pr_ref`。
- routine merge：`executed_by='service:merge-owner'`、
  `gate_evidence_ref`/`review_ref` 非空、`approval_id IS NULL`。
- hard gate：`hard_gate=1` 且 `approval_id` 指向 accepted merge approval。
- exact HEAD 变化 → 不执行，回 gate；执行前 re-check `headSha`。
- local `MergeExecutor`：git merge + branch/receipt reconciliation；W8 只换
  adapter。

### 6. 审批只有一条写通路

- `approvals` 是唯一 human gate 表；CLI `approval request/list/show/
  approve/reject` 是唯一读写面。
- `approve`/`reject` 要求 operator key proof；agent/run token 没有该面。
- `approval request` 只创建 open 行；`approve` 只写 resolution，不直接改
  task/lane/stage。effect materialization 归 W7/W8 对应 owner。

### 7. thread CLI 不建第二 message store

- `thread list/show/post/tail` 只读写 W1 `threads` / `messages` /
  `queue_entries`。
- `thread post` 写一条 `author_kind='user'` 的 message；带 `--to` 时同事务
  admit queue entry（`source_kind='conversation_input'`）。
- `thread tail --after-seq` 轮询；`--follow` 持续 tail。默认一次输出，
  不把 CLI 变成 daemon。
- thread 创建仍只走 `backlog dispatch`；不新增第二建 thread 通路。

## 切片

### W4a — SOP / backlog 契约与证据

| 单元 | 落点 | 可观察结果 | 验证 |
|---|---|---|---|
| W4a-1 SOP catalog | `sop-definitions/development.yaml`、`scripts/sop-definitions.mjs`、generated TS | 7 stage / checks / skills / predicate 可 codegen；无 clowder 参数 | `control-sop-catalog.test.ts` + `npm run generate:sop-definitions` drift check |
| W4a-2 evidence schema | 009 migration、`SopCheckEvidenceStore` | verified 只能带 evidence；stale 读 unknown；audit 同事务 | migration/schema + store tests |
| W4a-3 SOP service | `src/sop/service.ts` | projection、capsule limits、baton validation、completion gate | `control-sop-service.test.ts` |
| W4a-4 backlog read model | `BacklogStore` audit projection + CLI `backlog show` | audit newest-first / 100 / truncated cursor | store + CLI tests |
| W4a-5 backlog CLI | `backlog create/list/show/approve/dispatch/done/override-done` | operator 能建 item、approve、dispatch；缺 item task fail closed | CLI integration |

### W4b — gates / approval / merge

| 单元 | 落点 | 可观察结果 | 验证 |
|---|---|---|---|
| W4b-1 risk classifier | `src/gates/risk.ts` | 五轴 + assurance + lane；只升不降 | `control-gate-risk.test.ts` |
| W4b-2 gate evaluators | `src/gates/*.ts` | worktree/design/review/verify/merge/completion 可判 pass/block + findings | gate unit tests |
| W4b-3 gate service | `src/gates/service.ts` | 从 store/git 组证据；写 `gate_evaluated` audit | service integration |
| W4b-4 approval CLI | `src/cli/approval.ts` | request/list/show/approve/reject；operator proof | CLI + auth tests |
| W4b-5 merge receipt | 010 migration、`MergeStore`、local `MergeExecutor` | routine/hard gate 分支；失败/冲突不留半 merge | temp git repo tests |
| W4b-6 gate telemetry | `src/gates/telemetry.ts` + CLI | pass/block 原因分布 + pruning candidate | telemetry test |

### W4c — thread CLI / dogfood

| 单元 | 落点 | 可观察结果 | 验证 |
|---|---|---|---|
| W4c-1 thread CLI | `src/cli/thread.ts` | list/show/post/tail；post 可入 queue；tail after-seq/follow | CLI integration |
| W4c-2 dogfood | `test/cli-dogfood.test.ts` | backlog create→approve→dispatch→thread show/post→agent_response→tail→approval→merge receipt | 真实 CLI + temp git repo |
| W4c-3 docs/report | F007 + W4 report | AC 映射、scope 决定、W5/W7 边界 | 文档检查 |

## 依赖与顺序

1. W4a 先冻结 SOP/backlog 契约（schema + service + CLI 基础），W4b/W4c 都
   依赖它。
2. W4b 的 review gate 依赖 W3 `ReviewStore` / falsifier 语义；不重写 W3。
3. W4b 的 merge gate 依赖 W3 review evidence + W1 approvals/merges；
   local `MergeExecutor` 在 W4 落地。
4. W4c 依赖 W4a backlog dispatch（W1 已有）和 W4b approval/merge CLI；
   thread CLI 可并行开工，但 dogfood 测试最后跑。
5. 每个切片独立 commit；全量 tests/build 通过后才请求 review。

## AC 映射（`0003` §W4）

| # | Acceptance | W4 落点 | 验证 / 备注 |
|---|---|---|---|
| 1 | WorkflowSop 以 backlogItemId 为 key；stage 写入不做迁移校验 | W1 已有 + W4a service | store tests |
| 2 | verified 无 evidence → 422；agent/operator 只能 attested/unknown；stale → unknown | W4a-2/3 | evidence tests |
| 3 | check_name × evidence_kind SQL + 应用层双重校验；evidence_ref 可解析 | W4a-2 | migration + store tests |
| 4 | check_verified 同事务 audit；W7a 订阅 audit | W4a-2 | transaction test |
| 5 | completion 缺 backlog done + completion gate → 422；markDone 不能跳 | W1 + W4a-3 | completion tests |
| 6 | sop_check_evidence 只存 SOP check 证据 | W4a-2 | schema test |
| 7 | roles 动态 registry | W1 已有 | 回归 |
| 8 | 无 clowder 专属 predicate | W4a-1 | catalog static test |
| 9 | task 只能绑定已存在 backlog item；task done 不改 stage | W1 已有 | 回归 |
| 10 | backlog CLI create/dispatch；task create 缺 item fail closed | W4a-5 | CLI + store tests |
| 11 | docs/小改动按风险车道 | W4b-1 | risk tests |
| 12 | design gate 机器默认；critical/spec_change 才 human | W4b-2 | design gate tests |
| 13 | review/verify/merge gates 有 exact HEAD evidence；P1/P2 closed | W4b-2/3 | gate tests |
| 14 | merge gate 校验 declared lane/risk vs diff stats | W4b-2 | risk-consistency tests |
| 15 | merge-gate 5 条只作证据清单；routine merge 由 merge-owner 执行 | W4b-5 | merge executor tests |
| 16 | completion 需要 vision guard + acceptance + merge receipt | W4a-3 | completion tests |
| 17 | resume capsule 冷启动可读；CAS 冲突可检测 | W1 + W4a-3 | service tests |
| 18 | approval materialize CAS service | W1 已有；W4 只做 decide CLI | approval tests；materialize 由 W7/W8 owner 接 |
| 19 | approval 只写 approvals；无旁路 | W4b-4 | CLI tests |
| 20 | gate 通过率/block 原因可查询；剪枝候选报告 | W4b-6 | telemetry tests |
| 21 | operator backlog create/dispatch + thread list/show/post/tail | W4c-1 | CLI integration |
| 22 | dogfood：dispatch → post → tail → approval/merge | W4c-2 | CLI dogfood test；agent runner 归 W5（D2） |

## 验证命令

```bash
# 定向
NODE_ENV=development npm --prefix packages/codeteam-daemon test -- control-sop control-gate cli-dogfood
NODE_ENV=development node scripts/sop-definitions.mjs --check

# 包内全量
NODE_ENV=development npm --prefix packages/codeteam-daemon test

# 类型 / 格式 / 构建
NODE_ENV=development npx biome check packages/codeteam-daemon
NODE_ENV=development npx tsc --noEmit -p tsconfig.json
NODE_ENV=development npm run build:offline
```

## 风险与回滚

| 风险 | 路 | 处置 |
|---|---|---|
| SOP 又变成控制器 | P1 | stage 不校验迁移；只有 completion/evidence 写入 gate；code review 固定 |
| verified 仍可伪造 | P1 | 写权拆分 + evidence_ref 解析 + SQL CHECK + 422 测试 |
| merge CLI 绕过 gate | P1 | `merge execute` 先跑 gate service；receipt 要求 gate evidence ref + service principal |
| worktree gate 误伤本地 dogfood | P2 | unknown → block 但给出精确 reason；operator 可显式 `--allow-unsynced-base` 仅用于隔离验收，audit |
| CLI 成为第二状态机 | P2 | CLI 只调 service/store；不复制状态判断 |
| agent reply 被误读为 W4 已接 runner | P2 | D2 + 报告边界；dogfood 证据写明 cutover 而非模型调用 |
| approval 被 agent 伪造 | P1 | operator key proof；agent/run token 无 CLI 面；store 仍只写 approvals |

回滚：migration 009/010 是 additive；CLI/service 是新增文件；回滚到
`1669f50f4` 基线即可，不迁移外部数据，不清 audit。

## Review focus

- 砚砚：gate 证据链、review/verify exact HEAD、approval/merge 权限域、
  worktree/risk fail-closed。
- 墨墨：SOP 告示牌是否仍可读、operator CLI 体验、design gate/fast lane、
  dogfood 路径是否真的不需要 Web。

## Results（2026-10-28，merged；follow-up/close pending）

- 实现落点：SOP catalog/evidence/service、gates、approval/backlog/thread/task CLI、
  local MergeExecutor、gate telemetry；详见
  [`../reports/2026-10-28-w4-sop-gates.md`](../reports/2026-10-28-w4-sop-gates.md)。
- 验证：daemon **264 passed / 1 skipped**（W4 合计 93 条，follow-up 新增 60 条）；
  CLI dogfood
  1 条真实端到端；adapter 15 passed / 1 skipped；skills 15 passed；
  `build:offline`、根级 tsc、Biome、静态检查全通过。
- 砚砚 code/security/gate review **Approved** @ `5b3eba634`，delta **Approved** @ `90761ab5e`
  （7 P3 non-blocking）；P3-2/3/4/5/6/7 已修，P3-1 留 W7a 前置 residual；
  墨墨 SOP/process/Product review **changes_requested → delta Approved** @
  `0a8eb2b99`；P2-1/P2-2/P2-3 已补并实测。
- PR #47 **merged** at `4743137c9`（reviewed HEAD `0a8eb2b99`），CI 4/4 green。
- Follow-up 新增：backlog 5×操作矩阵 35、SOP completion 17 组合、标准代码车道
  review→merge E2E 1、CLI 失败路径 7、dogfood `auth init` 也 spawn CLI；
  daemon 从 204 增至 264 passed。
- Follow-up 抓到并修复：`suggested` 换 profile 的 error code 应为 `conflict`；
  store completion gate 漏 backlog `done` 检查；`MergeExecuteResult` 增 `reviewRef`。
- W7a residuals：store 层 evidenceRef 解析下沉；HTTP requester 从鉴权派生。
- 待 follow-up PR merge → 愿景守护（非作者非 reviewer）→ operator close；尚未
  accepted/closed。

