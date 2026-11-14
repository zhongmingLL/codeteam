---
title: "F018 — R1 execution plan (schema/migration + legacy cutover)"
doc_kind: plan
status: draft-for-review
created: 2026-11-14
updated: 2026-11-14
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
feature: F018
source_architecture: "docs/architecture/0005-thread-first-runtime.md; docs/architecture/0007-a2a-runtime-chain.md"
source_plan: "docs/plans/0020-f018-thread-first-runtime.md"
source_review: "docs/architecture/0018-v1-global-design-review.md"
---

# F018 — R1 execution plan

> 设计基线：`86310de24`（PR #86）。operator 2026-11-14 选择路径 A：
> 先修 `supply-chain` → merge #86 到 `codeteam-work` → 从 `codeteam-work`
> 开 R1。本文只拆 R1 的可执行工作、legacy cutover 和后续阶段门禁；
> 设计契约仍以 `0005`/`0007` + 分册为准，本文不新增契约。

## 0. 执行顺序

```text
0. supply-chain fix（node-forge 1.4.2 → 1.4.3）
   ↓
1. merge PR #86（设计契约 + 本文）
   ↓
2. R1-a  migration harness + catalog/thread/message
   ↓
3. R1-b  invocation/attempt + queue/admission
   ↓
4. R1-c  credential/auth + draft + session/worker
   ↓
5. R1-d  legacy preflight + migration drill + R1 gate
   ↓
6. R2 same-thread runtime → R3 cross-thread/multi_mention
   → R4 guard/observation/recovery → R5 cutover
```

R1 只建 schema/store/migration，不启动 provider dispatch；R1 的各 PR 必须是
additive migration，不能提前让 runtime 读新表。

## 1. 前置：路径 A

### 1.1 supply-chain fix（独立 PR）

- 分支：`fix/supply-chain-node-forge`，target `codeteam-work`。
- 现状：`package-lock.json` 中 `node-forge` 是 `1.4.2`，父依赖是
  `@earendil-works/gondolin@0.12.0`（`node-forge: ^1.3.3`）。
- 修复目标：锁到 `node-forge@1.4.3`（当前 latest，advisory 范围为
  `<=1.4.2`）；优先通过更新父依赖/override 产生干净 lock，不用 audit allowlist
  掩盖。
- 验证：`node scripts/npm-audit.mjs`、`NODE_ENV=development npm run build:offline`、
  受影响包测试；确认没有引入新的 audit advisory。
- review：非作者 review；merge 到 `codeteam-work` 后再动 #86。

### 1.2 merge PR #86

- #86 当前 head `86310de24`，设计契约已由三猫收口；合并前用
  `codeteam-work` 更新分支（strict base policy），重跑
  `changes` / `mcp-conformance` / `build-check-test` / `supply-chain`。
- 设计契约（`docs/architecture/`）不再改；本文是 plan，不是契约变更。
- merge 后再从 `codeteam-work` 开 R1 worktree。

### 1.3 R1 worktree

```text
git fetch origin
git worktree add /home/ming/agent/codeteam-f018-r1 \
  -b feat/f018-r1-schema origin/codeteam-work
```

- 安装：`NODE_ENV=development npm install --ignore-scripts`。
- 基线：`NODE_ENV=development npm run build:offline`；定向测试先跑受影响包。
- 数据：只使用隔离 dev/test 数据目录；不指向生产用户数据。
- 契约文档在 R1 期间冻结；需要改契约时先单独 review，不在代码 PR 里顺手改。

## 2. Task-first legacy 处置

单一清单仍是 `docs/architecture/0006-task-first-legacy.md`。本计划只定义
执行顺序，不复制清单。

### 2.1 代码

| 类别 | 处置 |
|---|---|
| `dispatch/service.ts`、`scheduling/`、`review/`、`merge/`、`gates/`、`sop/`、`managed-work/`、`deployment-wait/`、`custody/` | `legacy-frozen`：只有阻挡 A2A runtime 的 bug 才修；不扩展、不重构、不新增字段 |
| task-scope token、task-bound worker/prompt/policy 分支 | `legacy-frozen`：v1 另写 thread/invocation 路径；旧路径停写 |
| `a2a_send` / `handoff_*` handlers | `retired`：v1 不注册、不保留 alias；只保留 `post_message` / `cross_post_message` / `multi_mention` / `thread_context` |
| `cli/task.ts`、task read models | `legacy-frozen`：v1 不依赖；历史只读 |

### 2.2 数据表与列

- `tasks` / `stages` / `backlog_items` / `workflow_sops` / `handoffs` /
  `custody_events` / `budgets` / `reviews` / `merges` / `worktree_leases` /
  `waits` / `inbox` 等：`legacy-read-only`；v1 runtime 不读不写、不双写。
- legacy 列（`agent_sessions.task_id/profile_id/role`、`threads.repo/phase/
  backlog_item_id/status`、`invocation_credentials.task_id`、`messages.task_id`、
  `queue_entries.source_record_id`、`a2a_requests.task_id`、`runs.role`）不再加语义；
  R5 再决定归档/删除。
- 迁移前先 drain/terminal 有 running invocation 的 session；旧表快照必须可用于
  migration down。

### 2.3 文档

- **不删除历史文档，避免链接腐烂。** 在原文加 boundary banner + frontmatter
  `status: historical` / `legacy-frozen`：
  - `0001` / `0003` / `0004` / `0006` / `0015`：historical/reference/legacy；
  - F004–F011、F015/F016a 的 task-first 部分：`legacy-frozen`；
  - `0005`/`0007`/分册/`0020`/`0021` 是当前入口。
- `docs/README.md` 和 `0000-architecture-map.md` 只指向当前 canonical；历史文档
  保留在索引的 historical/legacy 行。
- `BACKLOG.md` 保留旧 feature 行并标 frozen；F018 是 active 行。
- R5 时可把历史文档移动到 `docs/archive/task-first/`，但必须同时更新索引/链接；
  在此之前不做物理移动。

### 2.4 验收

- E13：v1 registry 不存在 `a2a_send` / `handoff_*`。
- E14：v1 runtime 不读不写 `tasks/handoffs/custody/reviews/merges`。
- E15：session 迁移跳过 running invocation，等 terminal 后处理。
- 迁移 preflight 报告：projectPath 为空、running session、无法映射的 legacy
  message/agent profile 必须列出，不静默丢。

## 3. R1 工作单元

R1 拆成 4 个可独立 review 的切片；每个切片 additive migration，runtime 暂不读新表。

### R1-a — migration harness + catalog/thread/message

**交付**

- schema version 表 + migration runner + up/down 测试 + legacy fixture。
- `.codeteam/agent-catalog.json` / `.codeteam/accounts.json` 加载与校验；
  `AgentConfig`（含 `mentionPatterns`）、`AccountConfig`、`AgentRegistry`
  `mentionIndex`（跨 agent 唯一，碰撞 fail closed）。
- `threads`（created_by/project_path/title_source/last_active_at/deleted_at）、
  `thread_participants`、`messages` 新列（content/toolEvents/lifecycle/thinking/
  deleted/extra/mentions_user）、`agent_read_state`。

**测试**

- 空库 + legacy fixture 的 migration up/down。
- catalog 加载、pattern 唯一性/disabled/registry 缺、defaultModel 属于 account.models。
- thread owner/projectPath、message preflight、legacy 列只读。
- `check:doc-index` 不因新增文档失败。

**出口**：R1-a migration 可在旧快照上 up/down；新表可写但不被 runtime 读取。

### R1-b — invocation/attempt + queue/admission

**交付**

- `invocation_records`、`turn_executions`、`invocation_attempts` DDL + stores。
- 身份契约：`invocationId`（parent）、`parentInvocationId`（child FK）、
  `turnExecutionId`、`attemptId`；`sourceRecordId`/`messageId` 分离。
- `delivery_state`：`queued → starting → appended → handled|failed|interrupted|
  canceled`，加 `queued → failed(target_invalid)` 受控分支。
- `invocation_queue`、`queue_admissions`；claim/retire/release/withdraw/
  restoreExpiredClaims；per-thread cap 5、priority/FIFO。

**测试**

- create/replay/conflict；同 session 唯一 active delivery；`markStarting`
  backstop；retry append-only；旧 attempt 不可改写。
- admission receipt replay/conflict；claim CAS；queue cap；expired claim restore。
- parent 聚合读规则：latest attempt + canonical TurnExecution；`retryablePending`。

**出口**：R1-b store 级测试通过；queue/admission 不依赖 task 表。

### R1-c — credential/auth + draft + session/worker

**交付**

- `invocation_credentials` 重写：allowedTools、`toolCallClaims`、state/disposition；
  token scope 从 task 改 child TurnExecution/thread/agent/session。
- `response_drafts` 单 `DraftRecord` + create/upsert/get/delete/orphan；Phase B 事务
  原子绑定 R/child/draft。
- `agent_sessions` 单 active + `workers`/`worker_bindings` + delivery cursor ack/reset。
- `toolCallClaims` replay：同 `piExtToolCallId` 同 payload replay，不同 intent conflict。

**测试**

- 跨 thread / 错 user / 错 agent token 负例；credential terminalize。
- draft create 幂等/conflict；全量 snapshot；late flush 不复活；orphan 清理。
- 同 thread×agent 不双开；worker binding generation；ack 只在 child terminal +
  `promptDelivered=true`。

**出口**：R1-c auth/draft/session 负例通过；v1 不再 mint task-scope token。

### R1-d — legacy preflight + migration drill + R1 gate

**交付**

- legacy 表只读冻结；running session drain/terminal；projectPath/消息/profile
  preflight 报告。
- migration drill：旧库快照 → up → 抽样读 → down → 恢复。
- E14/E15 证据；R1 结果记录到本文或 `docs/reports/`。

**出口**

- `NODE_ENV=development npm run build:offline` 通过。
- 受影响测试 + migration up/down 通过。
- v1 runtime 不读不写 legacy 表；旧 code path 停写。
- 非作者 review 覆盖 R1 exact HEAD；merge 到 `codeteam-work`。

## 4. R1 PR 策略

- 分支：`feat/f018-r1-a-schema` / `-b-invocation-queue` / `-c-auth-draft-session` /
  `-d-legacy-gate`，全部 target `codeteam-work`，短生命周期。
- 每个 PR 自带 migration + tests + evidence；不把多个切片塞进一个超大 PR。
- R1-a 先合，R1-b/c 基于 R1-a；R1-d 最后。
- 代码 review 走非作者 fresh-context；R1 schema/auth 面找砚砚，验收/文档找墨墨，
  session/worker/queue 集成找烁烁。
- 只有改动 `docs/architecture/` 契约文档时才需要重新锚设计 verdict；纯代码/计划
  变更不沿用本轮 docs verdict 代替代码 review。

## 5. R2–R5 阶段门禁

| 阶段 | 范围 | 出口 |
|---|---|---|
| R2 Same-thread runtime | QueueProcessor、AgentRouter/runAgentTurn、Phase A/B、T1–T4、WorkerPool、draft stream、recovery | E1/E2/E7/E9/E12/E13/E18/E19/E22；真实 pi RPC + mock provider |
| R3 Cross-thread / multi_mention | post/cross_post、multi_mention orchestrator、callback child、thread access、participants | E3/E4/E5/E6/E8/E10/E11/E16/E21 |
| R4 Guard / observation / recovery | depth 15、queue cap、ping-pong、idempotency、observation、restart/cancel/retry | E17/E20 |
| R5 Cutover | CLI/daemon 切 A2A runtime、旧 code delivery 归档、F018 close | A2A runtime 单一真相；vision guard + operator |

## 6. 验证、review、回滚

- 每单元 TDD：先 RED，再 GREEN；真实 provider E2E 不拿 handler 测试冒充。
- 命令基线：`NODE_ENV=development npm run build:offline`；
  `NODE_ENV=development ./test.sh`；docs 改动跑 `check:doc-index` + `git diff --check`。
- 合并前必须有：受影响测试、migration up/down、legacy preflight、非作者 review。
- 回滚：R1 每个 migration 必须可 down；旧库快照保留到 R5；不 dual-write。
- 证据：每个 R1 PR 记录 schema diff、migration 日志、测试输出；R1 close 记录
  E14/E15 和 legacy 冻结报告。

## 7. 风险与待拍板

| 风险 | 处置 |
|---|---|
| `node-forge` supply-chain 阻塞 #86 | 路径 A：先独立 dependency PR；不用 admin override |
| 旧数据迁移丢字段/丢 session | preflight + 快照 + up/down drill；unknown 显式报告 |
| auth scope 从 task 改 invocation | 跨 thread/user/agent 负例；token 只绑 child/thread/agent/session |
| SQLite 单写者事务边界 | Phase A/Phase B、T1–T4 按契约拆；不合成一个大事务 |
| worker/provider E2E 不稳定 | fake clock + mock provider + 真实 pi RPC 双层；失败重试有界 |
| multi_mention callback/queue cap | R3 用 fake clock + 单 reaper 测试；cap/depth 实测后再调 |
| 范围失控 | legacy 表只读；不恢复 Task/worktree/review/merge/custody |

**需要 operator 确认**

1. R1 按 a/b/c/d 四个 PR 切片，还是单分支多 commit？（建议四片）
2. legacy 文档 R5 前只加 banner、不移动；R5 再决定是否归档到 `docs/archive/`。
3. migration drill/数据快照的保留窗口与 cutover 窗口。

## 8. 第一批动作

1. 开 `fix/supply-chain-node-forge`，node-forge 1.4.3 + audit/build 验证，单独 PR。
2. supply-chain 绿后更新 #86、merge 到 `codeteam-work`。
3. 从 `codeteam-work` 开 R1-a worktree；先落 migration harness + catalog/thread/
   message。
4. 第一个 checkpoint：migration up/down + catalog/thread/message review。
5. checkpoint 通过后进 R1-b；R1-a 的 schema 命名冻结，不在后续切片改契约。

## 9. R1 完成定义

- R1-a/b/c/d 全部 merge；migration up/down 在 legacy 快照上通过。
- E14/E15 有可运行证据；v1 runtime 不读不写 legacy 表；旧 code path 停写。
- auth/draft/session/queue store 级测试通过；无 task-scope token 新写。
- 非作者 review 覆盖 R1 exact HEAD；无 P0/P1 未处置。
- R2 可以从 `codeteam-work` 直接开，不需要再补 R1 schema。

[宪宪/deepseek-flash🐾]
