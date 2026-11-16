---
title: "F018 — R1 execution plan (greenfield schema + legacy move)"
doc_kind: plan
status: draft-for-review
created: 2026-11-14
updated: 2026-11-16
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
> 开 R1。本环境无真实用户数据，R1 走 greenfield baseline；本文拆 R1 的可执行工作、
> legacy move 和后续阶段门禁；
> 设计契约仍以 `0005`/`0007` + 分册为准，本文不新增契约。

## 0. 执行顺序

```text
0. supply-chain fix（node-forge 1.4.2 → 1.4.3）
   ↓
1. merge PR #86（设计契约 + 本文）
   ↓
2. R1-0  legacy move + boundary（物理移到 legacy/，保留 shim/guard）
   ↓
3. R1-a  migration harness + catalog/thread/message
   ↓
4. R1-b  invocation/attempt + queue/admission
   ↓
5. R1-c  credential/auth + draft + session/worker
   ↓
6. R1-d  legacy move verification + greenfield baseline gate
   ↓
7. R2 same-thread runtime → R3 cross-thread/multi_mention
   → R4 guard/observation/recovery → R5 cutover
```

R1 只建 schema/store/migration，不启动 provider dispatch；本环境无真实用户数据，
R1 走 greenfield baseline：新库只建 F018 schema，不迁移 legacy 数据。

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

- 设计契约锚点是 `86310de24`；后续 plan commit（含本文）不改契约。合并前用
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
- 本环境无真实用户数据：R1 使用新的 `CODETEAM_DATA_DIR`/空库，不迁移旧库；
  旧 dev DB 仅作为本地参考，不进入测试/CI。
- 契约文档在 R1 期间冻结；需要改契约时先单独 review，不在代码 PR 里顺手改。

## 2. Task-first legacy 处置

单一清单仍是 `docs/architecture/0006-task-first-legacy.md`。本计划只定义
执行顺序，不复制清单。

### 2.1 代码

目标目录：`packages/codeteam-daemon/src/legacy/task-first/`。

| 类别 | 处置 |
|---|---|
| `dispatch/`、`scheduling/`、`review/`、`merge/`、`gates/`、`sop/`、`managed-work/`、`deployment-wait/`、`custody/` | 物理 `git mv` 到 `legacy/task-first/`；旧路径留 compatibility shim；不扩展、不重构 |
| `a2a_send` / `handoff_*` handlers | 移到 `legacy/task-first/a2a/`；v1 不注册、不保留 alias；`thread_context` 保留在 active path |
| legacy control stores（tasks/runs/handoffs/custody/budgets/reviews/merges/worktree-leases/schedules/waits/inbox/backlog/workflow-sops/sop-check-evidence 等） | 按依赖顺序移到 `legacy/task-first/control/stores/`；共享 `control/stores/types.ts` 留在原位并标 legacy types |
| `workers/`、`auth/` | 共享目录不整体移动；`workers/executor.ts`/`prompt.ts`/`tool-policy.ts`/`harness.ts` 的 task-bound 分支、`auth/mint.ts` 的 task-scope 分支加 boundary 标记，R1/R2 再拆 |
| `cli/task.ts`、task read models | 移到 `legacy/task-first/cli/`；旧 CLI 入口留 shim；v1 不依赖 |

- 旧路径 shim 只做 re-export，不承载新逻辑；例如
  `src/dispatch/index.ts` → `legacy/task-first/dispatch/index.ts`。
- 新 v1 code 不得 import legacy path 或 shim；由 `check-legacy-boundary` 强制。
- 文件不删除；R5 再归档/删除。

### 2.2 数据表与列

本环境**没有真实用户数据**，R1 走 greenfield baseline：

- 新 `CODETEAM_DATA_DIR` / 空库只建 F018 schema；legacy 表不进入新 baseline。
- 不做 legacy data preflight/up/down；旧 dev DB 只作本地参考，不迁移、不进 CI。
- legacy 列/表定义保留在历史 migration/文档里；v1 runtime 不读不写、不 dual-write。
- 如果未来出现有数据的部署，另立 migration plan；E15 在那个环境实现。

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
- E15：本环境 greenfield，不适用；记录为“有数据部署另行 migration plan”。
- 新 baseline 只创建 F018 表；旧表不出现在新库 schema。

### 2.5 R1-0 legacy move（先于 R1-a）

只写文档不够：上下文压缩可能让新 session 丢掉 legacy 警告。R1-0 在写新 runtime 前
完成物理移动 + 可执行边界，不删除旧代码：

1. **always-loaded 规则**：`AGENTS.md` 已加入项目级规则——task-first 路径
   `legacy-frozen`，F018 A2A runtime 不得 import/read/copy；实现只以
   `0005`/`0007`/分册为准，legacy 清单见 `0006`。R1-0 负责把这条规则变成
   代码标记和 CI guard。
2. **物理移动**：建 `src/legacy/task-first/` + `README.md`；按 `git mv` 移纯
   legacy 目录和 stores；旧路径留 re-export shim；更新 import/`index.ts` 导出。
3. **共享模块标记**：`workers/`、`auth/`、`control/stores/types.ts` 不整体移动，
   只给 task-bound 分支加 boundary 注释，避免拆坏 active 代码。
4. **机器 guard**：新增 `scripts/check-legacy-boundary.mjs` 并接入 CI/`check`：
   - v1 A2A entrypoints（`a2a/`、`thread/`、`invocation/`、`queue/` 新路径）
     不得 import `legacy/task-first/` 或旧 shim；
   - v1 tool registry 不得出现 `a2a_send` / `handoff_*`；
   - v1 runtime source 不得引用 `0006` 列出的 legacy 表/列。
5. **baseline allowlist**：现有共享入口如果仍 import legacy，必须显式列出文件、
   owner、移除阶段；新增 import 一律 fail。allowlist 只减不增。
6. **删除/归档留到 R5**：旧代码和 dev 数据保留可回滚；R5 再归档/删除；
   v1 不做 dual-write。

## 3. R1 工作单元

R1 拆成 R1-0 + 4 个可独立 review 的切片；每片独立 PR，additive migration，
runtime 暂不读新表。

### R1-0 — legacy move + boundary

**交付**

- `AGENTS.md` legacy rule；`src/legacy/task-first/README.md`。
- 纯 legacy 目录/stores 物理移到 `src/legacy/task-first/`；旧路径 compatibility
  shim；共享模块的 task-bound 分支 boundary 注释。
- `scripts/check-legacy-boundary.mjs` + CI/`check` 接线；baseline allowlist。
- E13/E14 的早期断言：retired tools 不进 v1 registry；v1 entrypoints 不 import
  legacy modules。

**测试**

- `npm --prefix packages/codeteam-daemon run build` + 该包测试通过；旧 CLI/daemon
  入口经 shim 仍可编译；无行为变化。
- guard 对当前 baseline 通过；故意新增一个 legacy import / retired tool 时 fail。
- allowlist 文件、owner、移除阶段可读；不允许通配整目录。

**出口**：legacy 代码物理隔离在 `legacy/task-first/`；旧入口经 shim 可回滚；
新 runtime 代码无法在 CI 中静默 import legacy。

### R1-a — migration harness + catalog/thread/message

**交付**

- schema version 表 + migration runner + up/down 测试 + 空库/new baseline fixture。
- `.codeteam/agent-catalog.json` / `.codeteam/accounts.json` 加载与校验；
  `AgentConfig`（含 `mentionPatterns`）、`AccountConfig`、`AgentRegistry`
  `mentionIndex`（跨 agent 唯一，碰撞 fail closed）。
- `threads`（created_by/project_path/title_source/last_active_at/deleted_at）、
  `thread_participants`、`messages` 新列（content/toolEvents/lifecycle/thinking/
  deleted/extra/mentions_user）、`agent_read_state`。

**测试**

- 空库 → new baseline 的 migration up/down；legacy 数据不参与。
- catalog 加载、pattern 唯一性/disabled/registry 缺、defaultModel 属于 account.models。
- thread owner/projectPath、message 映射/validation；新 baseline 不含 legacy 列。
- `check:doc-index` 不因新增文档失败。

**出口**：R1-a migration 可在空库上 up/down；新表可写但不被 runtime 读取。

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

### R1-d — legacy move verification + greenfield baseline gate

**交付**

- 验证 `legacy/task-first/` move + shims：旧 daemon/CLI 入口仍可编译，无行为变化。
- E13/E14 证据；新库只建 F018 表，legacy 表不出现在 new baseline。
- R1 结果记录到本文或 `docs/reports/`；E15 标记为“有数据部署另行 migration plan”。

**出口**

- `NODE_ENV=development npm run build:offline` 通过。
- 受影响测试 + 新 schema migration up/down 通过。
- v1 runtime 不读不写 legacy 表；旧 shim 仍可回滚；无行为变化。
- 非作者 review 覆盖 R1 exact HEAD；merge 到 `codeteam-work`。

## 4. R1 PR 策略

- 分支：`feat/f018-r1-0-legacy-move` / `-a-schema` / `-b-invocation-queue` /
  `-c-auth-draft-session` / `-d-greenfield-gate`，全部 target `codeteam-work`，短生命周期。
- 每个 PR 自带 tests + evidence；schema PR 额外带 migration；不把多个切片塞进一个超大 PR。
- R1-0 先合；R1-a 再合；R1-b/c 基于 R1-a；R1-d 最后。
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
- 合并前必须有：受影响测试、新 schema migration up/down、legacy boundary guard、
  非作者 review。
- 回滚：新 schema migration 必须可 down；旧 dev DB 不动；旧代码 shim 保留到 R5。
- 证据：每个 R1 PR 记录 schema diff/测试输出；R1 close 记录 E13/E14 和
  legacy move 报告；E15 标记为数据部署另行处理。

## 7. 风险与待拍板

| 风险 | 处置 |
|---|---|
| `node-forge` supply-chain 阻塞 #86 | 路径 A：先独立 dependency PR；不用 admin override |
| 上下文压缩后新 session 误用 legacy 代码 | R1-0：AGENTS.md 常驻规则 + 代码标记 + `check-legacy-boundary` CI guard；不靠记忆 |
| greenfield reset 丢掉 dev 数据 | 本环境无真实用户数据；新 `CODETEAM_DATA_DIR`，旧 dev DB 不动；E15 留给有数据部署 |
| legacy move 造成 import/构建 churn | R1-0 用 `git mv` + 旧路径 re-export shim；先跑 daemon build/tests；不删除 |
| auth scope 从 task 改 invocation | 跨 thread/user/agent 负例；token 只绑 child/thread/agent/session |
| SQLite 单写者事务边界 | Phase A/Phase B、T1–T4 按契约拆；不合成一个大事务 |
| worker/provider E2E 不稳定 | fake clock + mock provider + 真实 pi RPC 双层；失败重试有界 |
| multi_mention callback/queue cap | R3 用 fake clock + 单 reaper 测试；cap/depth 实测后再调 |
| 范围失控 | legacy 表只读；不恢复 Task/worktree/review/merge/custody |

**需要 operator 确认**

1. R1 按 R1-0 + a/b/c/d 五个 PR 切片，还是单分支多 commit？（建议五片）
2. legacy 文档 R5 前只加 banner、不移动；R5 再决定是否归档到 `docs/archive/`。
3. greenfield baseline 的旧 dev DB 处置：保留本地参考还是删除？（不影响 CI）

## 8. 第一批动作

1. 开 `fix/supply-chain-node-forge`，node-forge 1.4.3 + audit/build 验证，单独 PR。
2. supply-chain 绿后更新 #86、merge 到 `codeteam-work`。
3. 从 `codeteam-work` 开 R1-0 worktree；建 `legacy/task-first/`，`git mv` 纯 legacy
   目录/stores，旧路径留 shim；落 `check-legacy-boundary` + baseline allowlist。
4. R1-0 第一个 checkpoint：guard 能拦住新 legacy import/retired tool；旧代码仍可回滚。
5. R1-0 合后开 R1-a worktree；落 migration harness + catalog/thread/message。
6. R1-a checkpoint：migration up/down + catalog/thread/message review；通过后进 R1-b。

## 9. R1 完成定义

- R1-0/a/b/c/d 全部 merge；新 schema migration up/down 在空库上通过。
- legacy boundary guard 在 CI 常驻；新 runtime import legacy 会 fail。
- E13/E14 有可运行证据；v1 runtime 不读不写 legacy 表；旧 code path 停写；
  E15 标记为有数据部署另行 migration plan。
- auth/draft/session/queue store 级测试通过；无 task-scope token 新写。
- 非作者 review 覆盖 R1 exact HEAD；无 P0/P1 未处置。
- R2 可以从 `codeteam-work` 直接开，不需要再补 R1 schema。

[宪宪/deepseek-flash🐾]
