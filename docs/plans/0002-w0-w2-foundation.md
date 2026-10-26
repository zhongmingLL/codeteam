---
title: "W0–W2 基础计划：fork、数据模型、权限"
doc_kind: plan
status: reviewed
created: 2026-10-21
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash)]
---

# W0–W2 基础计划

> 覆盖：W0a 前置验证（含 fork/bootstrap）+ W0b upstream/CI 治理、W1 控制面数据模型、W2 权限/身份/沙箱。
> 这三项是后续 W3–W8 的地基；任何一项没有 evidence，不进入下一阶段。

---

## W0. W0a 前置验证 + W0b Fork 治理 + W0c daemon 最小生命周期面

### Goal

把“full fork（仓库形态）+ SDK/extension-first（默认实现）”变成可运行、可同步、可回滚的工程基线，并验证 L0 压缩免疫不是纸面 claim。

> 分段（加速 dogfood）：**W0a（阻塞 W1）** = 外部 codeteam 仓 fork + bootstrap + 文档迁移 + 基线对码 + L0 compiler/spike + pi session 跨进程能力 + 供应链最小项 + W0a 预检；**W0b（可并行，W5 前完成）** = upstream/CI 治理。W0–W4 dogfood 不依赖 W0b。`clowder-ai/codeteam/` 只放讨论产物，不在其中开发。

### Preconditions

- Node.js >= 22.19。
- 可访问 `earendil-works/pi` 上游；本地有可用的 npm/pnpm 环境。
- 确认当前产品代码的实际形态：npm dependency、monorepo workspace、还是混合。
- 确认没有把外部产品仓当作讨论真相源；本计划以当前 thread + `codeteam/` 文档为准。

### Tasks

**W0a（阻塞 W1）**

0. **外部仓 bootstrap + fork**
   - 外部仓 = fork `earendil-works/pi`；pin `v1.4.0`（`4a080252f06caf63a525d7873c5d94d3c23887e0`），记录 SHA。
   - `main` 跟踪 codeteam 发布，`codeteam-work` 做开发；加 `upstream` remote。
   - 仓内拓扑：codeteam 自有包放 `packages/codeteam-*`；上游文件只在 `KERNEL_GAPS.md` 列出的 patch 中改动。
   - **谁执行**：需要 operator 给仓库名/路径/remote；猫执行建仓骨架、初始 commit、CI 骨架。不要等人工建仓。
   - **文档迁移 DoD**：外部仓 `docs/{architecture,plans,features}` 与现结构镜像，内部相对链接不改写；迁移 commit 同时生成外部仓自己的 `plans/README.md`；clowder-ai 侧旧目录 README 改写为“真相源已迁至 `<repo>@<commit>`，本目录只读历史”，此后不再更新。
   - **基线对码报告**：显式命名来源仓/路径；逐资产列 control plane/store/adapter/verifier/eval/CLI 的 可复用/需适配/丢弃；给出 reuse vs fresh 建议。W1 migration 以该报告为输入。
   - **仓库安全基线**：main 分支保护（required PR + required check：上游测试 + codeteam 测试）、禁 force push、CI secrets 只放 CI；验收留可查证据（branch protection API / CI 配置）。
   - 不在 `clowder-ai/codeteam/` 写 codeteam 代码。

1. **工程形态与供应链**
   - 确认 workspace/lockfile/build 命令：`npm install --ignore-scripts`、`npm run build:offline`、`./test.sh`。
   - 跑通上游测试与 codeteam 测试；记录失败项是环境限制还是代码问题。
   - 供应链最小项：CI 校验 lockfile 完整性 + dependency audit（失败阻断）；`npm install --ignore-scripts` 的理由写入 `UPSTREAM.md`。

2. **L0 compiler v0 + spike**
   - 实现 L0 compiler v0：role 模板 + 治理段编译，产出 `l0_revision` hash；通过 SDK `systemPromptOverride` 注入。
   - 选一个长 session，持续到 compaction 阈值（auto 与手动 `compact` 各测一遍）。
   - 用 mock provider / recording proxy 抓出站 request body，断言 compiled L0 文本逐字出现在 compaction 后首个 request 的 system 里。
   - 验证 section 稳定时 prompt cache 命中；如果 cache 不可观测，至少记录 request 的 system section hash。
   - 记录使用的 pi 版本、session 文件、compaction entry、断言日志。
   - 失败则记入 `KERNEL_GAPS.md` 第一条，并停止把 D9 标为“已证明”。
   - 同时验证 pi session 是否能跨进程 resume/export；不支持则 W5 的迁移策略改为 fresh+capsule。

2b. **Curated skill surface spike（plugin 卡 W0 契约）**
   - 2026-10-25 operator 拍 `DP-PLUGIN-1=A` / `DP-PLUGIN-2=A`；本 spike 是 W0 skill surface 的冻结契约。
   - **内容迁移门禁**：每个进入 catalog 的 skill 必须有 `architecture/skill-migration.md` 矩阵行 + 静态检查 + 非作者 review + dry-run 证据；没有行不允许加载。
   - 建立 `codeteam/skills/manifest.yaml`（fork/瘦身 `cat-cafe-skills/manifest.yaml`）：entry 只留 `skillId/path/sourceKind/category/not_for/output/next/sop_step`；description/triggers 从 `SKILL.md` frontmatter 读，不双写。
   - 验证 pi `DefaultResourceLoader` 的 skill 注入 API（skills dir 选项或显式列表）；`noSkills:true` 仍为基线，仅 allowlist 注入；失败记 `KERNEL_GAPS.md`，不改 kernel。skill path 必须 `realpath(catalog_root)` containment、拒绝绝对路径/`..`；curated allowlist + secret scan；skill 不改 tool policy/permission。
   - 验证两级语义：index（id/name/description/triggers/next）常驻、body（SKILL.md 正文）按需；多文件 skill 在 fork 时合并为单文件。
   - 验证 role allowlist（`agent_profiles.restrictions_json.skills`）：空=不加载、悬空 id=warning、`nextSkill` 经 repo read 且被 allowlist 拒绝时可见。

3. **W0a 预检**
   - bwrap 预检：本机（含 WSL2）unprivileged userns 是否可用；不可用则 D3=A 当场降级/重开，不等 W2。
   - 低权 user × worktree 属主预检：worker 能写、review/verify 的 task worktree 只读；取证写仅限隔离 evidence worktree；禁止用 chmod 777 绕过。
   - **Hub 承载 spike**：用现成 clowder Hub 机制展示一个外部 thread + 消息收发 + 一张 `approvals` 卡；输出“clowder 侧所需改动清单（可为空）”。需要 clowder-ai 改动时，作为独立 operator 授权项，不混进 codeteam 产品代码。

**W0b（与 W1–W4 并行，W5 前完成）**

4. **上游治理**
   - 建 `UPSTREAM.md`：当前 tag/commit、已修改 kernel 文件、同步日期、冲突处理。
   - 建 `KERNEL_GAPS.md`：每个 kernel patch 的理由、测试、上游 diff、是否可上游化、回滚方式。
   - 初始状态允许“零 kernel patch”；这不是缺口，是合法状态。

5. **CI 与同步纪律**
   - 上游测试 + codeteam 测试 + 最小 fixture 三层。
   - 每次同步 upstream 后必须全跑；不允许只跑 codeteam 测试。
   - 证据挂到 main 的 required check；W5 前必须生效。

**W0c（daemon 最小生命周期面，阻塞 W1 runtime 启动）**

6. **daemon state + boot ledger**：`CODETEAM_DATA_DIR` 下的 daemon state 文件；启动时 realpath 校验 installation root、派生 installationId、`beginBoot` 写 bootId/bootSequence/runningRevision；单写者 fence 先于 beginBoot。
7. **readiness + loopback health**：daemon 只在实际可用后 `markReady`；loopback `/health` 供探测与 deployment wait predicate；未声明服务不得写 ready。
8. **最小安全生命周期记录**：`requested → stopping → stopped/failed`，复用 exclusive claim/frozen identity/executor independence；不做 W5 的完整授权/复验链。

### Deliverables

- 外部仓骨架、fork 与 `upstream` remote。
- 文档迁移 receipt + 外部仓 `plans/README.md`。
- 基线对码报告（reuse vs fresh）。
- 仓库安全基线证据（branch protection / required checks）。
- `UPSTREAM.md`、`KERNEL_GAPS.md`。
- L0 spike 报告（命令、日志、session/compaction 证据）。
- Curated skill surface spike 报告（loader 注入 API、index/body、allowlist/repo-read、多文件合并）。
- bwrap / worktree 属主 / Hub 承载预检报告。
- CI 配置与可复现命令。
- W0c：daemon state/boot ledger schema、loopback health endpoint、最小生命周期记录与测试。

### Acceptance

- [x] `git remote -v` 有 upstream；pin 的 tag/commit 写入 `UPSTREAM.md`。
- [x] 外部仓 `docs/` 结构镜像；旧目录 README 已转为只读快照指针；外部仓有自己的 `plans/README.md`。
- [x] 基线对码报告已产出，明确 reuse vs fresh，并被 W1 引用（`docs/reports/2026-10-27-f002-baseline-reuse-map.md`）。
- [x] main 分支保护、required checks、禁 force push 有可查证据；CI secrets 不在仓内。
- [x] 上游测试 + codeteam 测试有可复现命令和结果。
- [x] L0 在 compaction 后逐字保留；否则 D9 降级并记 KERNEL_GAPS。
- [x] Curated skill surface：index/body 两级可加载；allowlist 空=不加载、悬空 id 有 warning；`nextSkill` 经 repo read 且 skip 可见；无自动发现/HOME mount。
- [x] W0 只验证 role loader/allowlist 与 unknown-role fail closed；`eval`/`compress` 的 seed 与 AgentProfile 在 W1 落，不在 W0 硬编码。
- [x] bwrap / 低权 worktree 属主预检有结论；不可用则 D3 已重开。
- [x] Hub 承载 spike 有结论：外部 thread + 消息 + 审批卡可展示，或列出 clowder 侧改动清单。
- [x] 没有未说明的 kernel patch。
- [x] lockfile 完整性 + dependency audit 在 CI 中阻断失败；`--ignore-scripts` 有记录理由。
- [x] 任何人按文档能在干净 checkout 复现构建与测试。
- [x] W0c：daemon 启动写 boot 记录、ready 前不对外承诺、stale/running 判定有测试；最小 lifecycle 记录能安全停在 `stopped/failed`。
- [x] W0c：`CODETEAM_DATA_DIR` 为唯一数据根；boot ledger/daemon state 落在仓外 0700/0600。

> W0c 的两项不属于 F002，已由 F003（`docs/features/F003-w0c-daemon-lifecycle.md`）完成；W1 runtime 启动前置已满足，证据见
> 该 feature 的 Evidence 段。

### Risks

| 风险 | 缓解 |
|---|---|
| fork 漂移，越改越难同步 | 零 patch 优先；patch 必须小、独立、有测试 |
| 只 fork `coding-agent` 导致 kernel 版本错位 | full monorepo fork；不采用 partial fork |
| 外部仓出生方式冲突 | fork 属于 W0a bootstrap；W0b 只做治理 |
| 建仓/迁移双真相源 | 迁移 commit 一次性完成；旧目录转只读快照 |
| bwrap 在 WSL2 不可用 | W0a 预检；不可用则 D3 降级/重开 |
| Hub 承载 C 假设不成立 | W0a/W1 做 Hub spike；C→A 以 spike 为条件 |
| L0 claim 不成立 | spike 先行；失败就记 KERNEL_GAPS，不用文档掩盖 |
| CI 只跑 codeteam 测试 | 明确上游测试为必跑项 |

### Review focus

- 烁烁：fork 形态、upstream 同步、L0 compaction/cache spike 是否可复现。
- 砚砚：是否有未记录的内核改动、供应链/许可风险。

---

## W1. 控制面数据模型

### Goal

把当前 `task/run/handoff` 扩成完整控制面，并给 Console M0 提供真实 thread 数据源。

> 基线对码输入：`docs/reports/2026-10-27-f002-baseline-reuse-map.md`。旧实现不可得，按 fresh
> baseline 处理：W1 用合成 fixture，无 backfill；不继承任何未经验证的“已落地”资产。

### Target tables

- `threads`（+ `backlog_item_id` / `phase`；A2-1 定义）
- `messages`（`thread_id`、`author_kind`、`author_id`、`kind`、`body_md`、`rich_blocks_json`、`dispatch_refs_json`、`reply_to`、`control_ref`、`seq`、`updated_at`）
- `queue_entries`（ADR-043/F117 single pending-wake ledger；F122 为历史文档；完整 18 列见 0001 §12.2：source_id/source_record_id/source_kind/targets/author_intent/priority/source_category/order_key/revision/fence_refs/claim_id/claim_owner_run_id/claim_expires_at/status/updated_at 等）
- `backlog_items`（feature/backlog 级 SOP 作用域；复用 clowder BacklogItem 形状；`created_by_kind` 含 `system`，仅 W8/forge inbound 初始 open|suggested）
- `workflow_sops`（`backlog_item_id` 为 key；stage / baton / nextSkill / resumeCapsule / checks / version；W1 的 `checks` 只接受 `attested|unknown`）
- `work_admissions`（work_id PK；owner/producer/ref/initial_attempt/admitted_at；TTL=0）
- `work_attempts`（attempt_id PK；work_id/attempt_number/executor_profile_id/created_at/executor_bound_at）
- `run_managed_work_bindings`（run_id PK；work_id/attempt_id/bound_at；A1-3 run cutover 同事务）
- `tasks`（clowder TaskItem 底座 + 代码交付扩展：`thread_id`、`backlog_item_id`、`related_feature_id`、repo/base/worktree/branch/risk/lane/budget）
- `stages`（纯快照：lane/status/started_at/ended_at；无 entry/exit/criteria/attempt）
- `roles`（动态 role registry：内置 architect/coder/reviewer/verifier；seed `eval`/`compress`；前端可加 writer 等）
- `agent_profiles`（稳定逻辑身份：role/provider/model/family/tool policy/restrictions）
- `agent_sessions`
- `invocation_credentials`（per-run callback credential：hash+salt、run/task/role/session/profile/thread 坐标、active/terminal、`last_refresh_at`、tombstone 30d）
- `runs`（`queue_entry_id`、`agent_session_id`、`parent_run_id`、`source_id`、`recipient_profile_id`、`chain_metadata_json`、`model_family`、`l0_revision`）
- `run_events`
- `thread_events`
- `artifacts`
- `handoffs`（F167 custody 列、generation/revision、terminal predicate、holder outcomes、return/dispatch delivery；single-mode claim summary）
- `handoff_holder_claims`（per-holder claim：profile/run/generation/lease/heartbeat/status）
- `custody_events`（append-only handoff custody 审计；`handoff.*` 枚举；无新球 ID）
- `waits`（per-generation；timer / event-backed / managed command + `wait_source_ref` + `expected_signal` + owner fence + SLA）
- `wait_terminations`（canonical `wait.terminated` append-only 事件）
- `inbox`
- `approvals`（F246：kind ∈ merge/design_gate/spec_change/blocker/budget_pause；origin/card/effect refs；resolution + materialization_json；decided_at/note；expiry=stale；单表 canonical）
- `reviews`（`head_sha`、`review_mode`、author/reviewer model + family 四元组）
- `findings`
- `verifications`（`head_sha`、`producing_review_id`）
- `merges`
- `budgets`
- `evals`
- `forge_deliveries`（`delivery_id`、`natural_key`、`status`、`retry_count`、`processed_at`）
- `audit`

> 列级真相源是 `architecture/0001 §12.2`。本节是执行摘要；W1 演进必须回写 §12.2，不另起一套列定义。

### Migration strategy

采用 additive migration，不做一次性破坏性重写：

1. **Add**：新表/新列先加，旧代码可继续读。
2. **Dual-write**：新路径写新表；旧路径暂时保留，必要时双写。
3. **Backfill**：从旧 `tasks/runs/handoffs` 生成 thread/agent_session/stage 投影；每个旧 task 生成 task-backed backlog item；`workflow_sop` 从 `kickoff` 或 `unknown` 开始，不猜 stage。
4. **Cutover**：读路径切到新表；旧表只做兼容视图或保留只读。
5. **Rollback**：每个 migration 有 down 或向前兼容策略；cutover 前备份 SQLite。

### Tasks

**W1 入场门禁**：先完成 `architecture/0001 §4.4` 的 clowder primitive → codeteam field 继承矩阵（逐对象：源→字段→差异→理由；每个字段标 `reused` 或 `code-delivery-specific`）；未完成不开始建表。重点钉死 TaskStatus、Task.ownerCatId、Run vs ActiveRun、Handoff vs action lease/custody、Artifact vs ThreadArtifactDTO 五处差异。

1. 写 schema + migration + down/rollback 说明。
2. 定义 repository/service 接口；所有状态更新走 CAS（version/updated_at/status）。
3. 建 `threads` / `roles` / `agent_profiles` / `agent_sessions`；`agent_sessions.profile_id` + `role`；`Task.threadId`；thread 事件；`runs.l0_revision`。
3b. **动态 role seed + AgentProfile 契约**：seed `roles` 至少 `architect/coder/reviewer/verifier/eval/compress`（status active；不是 enum）；`AgentProfile` 字段 `id/role/display_name/provider/model/model_family/tool_policy_profile/status/clowder_cat_id`，其中 `clowder_cat_id` 只作 provenance；seed `eval`/`compress` profile（role 分别为 `eval`/`compress`，provider/model 可配置，不硬编码模型）；registry 加载时把 `evalAgent.profileId` 解析到 `role='eval'` 且 active 的 profile，缺失/禁用 fail closed；新增 role 不改核心代码。
4. 建 `messages` + `queue_entries`（ADR-043/F117 single ledger；F122 为历史文档）；`messages.dispatch_refs_json` 记录 source×target 投递；`messages.seq` 为 thread-scoped 服务端分配可见序（`UNIQUE(thread_id,seq)`，`BEGIN IMMEDIATE`）；`messages.reply_to` 只指向同 thread；`runs.queue_entry_id` 指向 claim 的 entry；`runs.response_message_id` 是 response bubble 唯一身份（partial unique），`runs.execution_kind ∈ ordinary|routing_guard`；`messages.kind='agent_response'` 与 `response_message_id` 同事务；`handoff`/`inbox` 是 source，不另建队列；`kind` 区分 chat/question/answer/proposal/finding/status/handoff/verdict/approval_request；`control_ref` 指向 typed handoff/review/approval。message identity 契约按 `DP-BUBBLE-1=A` 冻结；W7 只读投影为 approved-for-direction。
5. 建 `backlog_items` / `workflow_sops`；`WorkflowSop` 只校验 schema + version CAS，不校验 stage 迁移；`Task` 必须绑定 backlog item；`checks_json` 只接受 `attested|unknown`。
5b. backlog dispatch（`approved→dispatched`）在一个 SQLite 事务里写 backlog status + thread（`backlog_item_id`/`phase`）+ kickoff message + queue entry + audit；`dispatch_attempt_id` 唯一索引做幂等；不移植 Redis dispatch lock。
5c. SQLite 基线：WAL、foreign keys、`CODETEAM_SQLITE_BUSY_TIMEOUT_MS=5000`（全局唯一权威定义，其他卡只引用）。
5d. 建 `work_admissions` / `work_attempts` / `run_managed_work_bindings`；SOP first insert + admission/attempt 同事务；A1-3 run cutover 绑定 primary implementer（v1 `role='coder'`、`task.kind='work'`；thread 或 run.task 任一绑定到 producer_ref）并写 run binding；review/verify run 不绑；retry=sticky（先读 attempt 绑定再选 profile）；确定性 bind 冲突消费 target，不留在 queue；raw IDs 不进公共 DTO。
6. 建 `stages` 纯快照 / `run_events`；`stages.status` 只允许 `active|passed`，无迁移规则；`runs.attempt` 记重试；run terminal 在同一事务。
7. 建 `artifacts`；内容 hash、临时文件 + fsync + rename、metadata。
8. 建 `inbox`；typed kind：`steer | followUp | humanGuidance`。
9. 建 `approvals`；双锚 `origin_ref`/`card_ref`、`resolution`/`materialization` 分离、`effect_ref`、expiry=stale 不自动拒绝。
10. 建 `reviews/findings/verifications`；`head_sha`、`review_mode`、author/reviewer `model` + `model_family` 四元组、`producing_review_id`。
11. 建 `merges`；`approved_by`、`receipt_ref`。
12. 建 `budgets/evals`；per-task/provider 维度。
13. 建 `handoffs` 的 custody 列（generation/revision、canonical_action_key、terminal_predicate_json、completion_candidates/holder_outcomes、return/dispatch delivery、claim summary）与 `handoff_holder_claims`（per-holder claim）；建 `audit` + append-only trigger。
14. 建 `custody_events`、per-generation `waits`、`wait_terminations`；handoff kind 用 `handoff.*` 枚举 + append-only trigger；event wait 必须有 `expected_signal`，所有 wait 必须有 `wait_source_ref`/SLA/owner fence，否则 fail closed。
15. 建 `forge_deliveries`（delivery id / natural key / status / retry_count / processed_at）；测试 daemon 重启后重放 delivery 仍被去重。
16. 写迁移测试：空库、旧库、部分迁移、crash 后重跑。
17. 写恢复测试：running run → interrupted；单 holder claim stale + proof → 回 pending（同 generation，不判 expired）；explicit deadline → expired；expired handoff 不 late-complete；interrupted run 的 token 不得 complete 任何 handoff；parallel 一个 holder interrupted 不影响其他 holder。

### Deliverables

- migration files + schema docs。
- repository interfaces / store implementations。
- migration/rollback test suite。
- 旧数据 backfill 报告（数量、无法归属的项、处理方式）。

### Acceptance

- [ ] 继承矩阵已完成：每个 clowder primitive 有“源→codeteam 字段→差异→理由”，未完成不进入实现。
- [ ] Task/Run/Handoff/Artifact 的每个新增字段都有 `code-delivery-specific` 理由；不存在第二套 queue/custody/message/SOP。
- [ ] 空库能从零建全；旧库能迁移且不丢 task/run/handoff。
- [ ] 迁移策略按基线对码报告执行：reuse 走旧库迁移；fresh 用合成 fixture，backfill 标 N/A。
- [ ] `threadId` / `agentSessionId` / `headSha` / `reviewMode` 可查询。
- [ ] `roles` 是动态 registry：内置 architect/coder/reviewer/verifier；seed `eval`/`compress`；前端可创建 writer 等自定义 role，不改核心代码；未知/禁用 role fail closed。
- [ ] `eval`/`compress` AgentProfile 可创建并被 registry/运行时分派解析；`evalAgent.profileId` 解析到 `role='eval'` active profile；缺 role/profile fail closed；`clowder_cat_id` 不参与授权/唯一性。
- [ ] `agent_profiles` 可注册多个 agent（同一 role 多个 profile）；`agent_sessions.role` 可回溯；不引入 AgentInstance。
- [ ] `WorkflowSop` 以 `backlogItemId` 为 key；stage 写入只做 schema + CAS，不做迁移校验；task 必须绑定 backlog item。
- [ ] backlog 状态机含 operator `open→approved` 直达；正常 `done` 只从 `dispatched` 进；`approved/open/suggested→done` 仅 import/override（reason+audit）。
- [ ] `tags_json` 更新 operator-only；SOP 存在时 anchor tag 不可移除；feature 解析多匹配 422，不取 first。
- [ ] `created_by_kind='system'` 仅用于 W8/forge inbound 的初始 open|suggested，后续 approve/dispatch 仍走 operator；`messages.kind` 含 `backlog_kickoff`。
- [ ] tasks CHECK/FK migration 顺序：先 FK、完成 task-backed backfill、再加 CHECK；存量违规报告，不静默改绑。
- [ ] SOP first insert + admission/attempt 同事务；既有/completion SOP 不 retro-admit；确定性 ID 重试幂等。
- [ ] run cutover bind-once：只允许 primary implementer；same idempotent / different 409 / partial fail closed；review/verify run 不绑 attempt 1；retry=sticky（先读 attempt 绑定再选 profile）。
- [ ] bind 确定性冲突（409/partial/mismatch）消费 queue target + typed deliveryFailure + audit + operator blocker；只有 transient/busy 保留 claim retry。
- [ ] `workId`/`attemptId` 不出现在 Task/Run/Queue/MCP/REST/Web/Community；contract test 覆盖。
- [ ] `checks_json` 只写 `attested|unknown`；`verified` 在 W4 `sop_check_evidence` 落地前一律 422 `verified_requires_evidence`。
- [ ] backlog dispatch 无 orphan thread：backlog/thread/kickoff/queue 单事务；`dispatch_attempt_id` 唯一；retry 幂等。
- [ ] `task create` 缺 `backlog_item_id` → 404 `backlog_not_imported`；不隐式物化 backlog item。
- [ ] SQLite WAL/foreign_keys/`CODETEAM_SQLITE_BUSY_TIMEOUT_MS=5000` 已落基线；busy 只重试一次，仍 busy 返回 503。
- [ ] 唯一 pending-wake = `queue_entries`；`handoff`/`inbox` 是 source；不存在第二队列；`runs.queue_entry_id` 可回溯。
- [ ] A2A 执行链可追溯：A2A ingress → queue_entries → QueueProcessor → AgentRouter → routeSerial/routeParallel → invokeSingleAgent；`routeSerial/routeParallel` 不重写，`invokeSingleCat` 是唯一替换点。
- [ ] queue 多 recipient 恒 parallel；`ideate` 只作直调兜底；`routeIntent` 只读 typed 字段，不解析正文 `#ideate`/`@`。
- [ ] `runs.chain_metadata_json` 持久化 `a2aCount/maxDepth/streakPair`；`runs` partial unique index 保证 `(source_id, recipient_profile_id)` 至多一个 running run。
- [ ] `tasks` 复用 clowder `TaskItem` 底座（kind/subjectKey/title/why/owner/status/relatedFeatureId/dispatchGate/probe/entrustedWork/deploymentWait），代码字段仅作扩展；`goal`/`featureId` 不另存。
- [ ] task done 不自动把 `workflow_sops.stage` 改成 `completion`；feature completion 走独立 gate。
- [ ] `TaskStatus` 使用 clowder `todo/doing/blocked/done` + `disposition(canceled/abandoned)`；不存在 `running/cancelled` 双枚举。
- [ ] 不存在以 stage 迁移为触发点的 gate 执行路径；gate 只挂工具/端点边界。
- [ ] run lane/stage/handoff 的关键状态迁移在一个事务里。
- [ ] crash 后恢复不会产生 zombie run 或 late-complete。
- [ ] 重启后重放的 forge delivery 命中 `forge_deliveries`，不重复派发。
- [ ] interrupted run 的旧 token 不能完成任何 handoff。
- [ ] schema migration 可回滚/向前兼容。
- [ ] thread/timeline/diff/review 的只读查询接口有 store 级测试覆盖，字段足够渲染 Console M0；实际页面验收留在 W7。
- [ ] `messages.seq` 在 `BEGIN IMMEDIATE` 内分配且 `UNIQUE(thread_id,seq)`；`runs.response_message_id` partial unique；一个 run 一个 response；orphan response 有 health 告警；`reply_to` 不跨 thread。
- [ ] operator chat 消息可持久化、按 thread 回放；需要 agent 行动的聊天生成 typed inbox，不产生 handoff。
- [ ] A2A 讨论消息可持久化；`messages.kind` 与 `control_ref` 能把讨论和 typed handoff/review/approval 关联起来。
- [ ] approval request / decision / expiry 可持久化并查询；Approval Hub 能直接消费，不需要另建审批表。
- [ ] approval 支持 origin/card/effect 三锚；`card_ref` 指向 `approval_pointer`；accepted 与 materialization succeeded 分离；succeeded 必须 `effect_ref`；过期变 stale，不自动 reject；rejected 必须 `decided_note`。
- [ ] approval request 有 `idempotency_key` 唯一约束 + merge/design/spec 同 task 至多一个 open；`effect_reservation_ref` 与 owner receipt `approval_id` 1:1；materialize principal 按 kind 限定，run token/agent-key 403。
- [ ] RunStatus 含 `canceled`；HandoffStatus 含 `withdrawn`；cancel/stop 与 recovery interrupted 可区分。
- [ ] custody event 可重放为当前 holder / blocked / expired 投影；事件账本 append-only，无新的球 ID 原语；replay 只对账 `handoffs`，不反向裁决。
- [ ] custody kind 用 `handoff.*` 枚举、append-only trigger、state×event 测试齐备；不存在旧 `claim|complete|withdraw|expire|steer|escalate|hold|wake` 并存。
- [ ] `handoff_holder_claims` 支持 single/parallel per-holder claim；`handoffs.status='claimed' ⇔ active claim exists` 由 contract test 锁定；一个 active run 至多 claim 一个 handoff。
- [ ] wait 按 `(wait_id,generation)` 一行、同 series 至多一个 active；`wait_source_ref` + SLA + owner fence 必填；event 型必须有 `expected_signal`，缺失 fail closed。
- [ ] `wait_terminations` append-only、`(wait_id,generation)` 唯一、user_cancel actor=owner；auto-renew 同事务装 gN+1；缺 owner fence 走 `legacy_unfenced` no wake。
- [ ] `messages.rich_blocks_json` 不含 approval kind；审批项只能来自 `approvals`。

### Risks

| 风险 | 缓解 |
|---|---|
| 一次性改表导致旧数据丢失 | additive + dual-write + backfill + rollback |
| thread 归属靠猜 | 无法确定的旧数据标 `unknown`，不伪造 |
| review/verification 没绑 headSha | 所有 review/verification 必填 `head_sha` |
| audit 被静默修改 | append-only trigger + 备份 |

### Review focus

- 墨墨：thread 模型是否能支撑 Console M0；`threadId` 与 task 的关系是否清楚。
- 砚砚：`headSha`、audit、merge receipt 的完整性。
- 烁烁：schema 与 pi session/agent session 的边界。

---

## W2. 权限、身份与沙箱

### Goal

把“策略层”变成“工具实现 + OS 边界”，并让身份粒度到 run，而不是 worker 进程。

### Identity model

```text
daemon
  ├── run R1: token T1 -> (runId=R1, taskId=T1, role=coder, agentSessionId=S1)
  ├── run R2: token T2 -> (runId=R2, taskId=T2, role=coder, agentSessionId=S2)
  └── MCP server: token -> binding lookup
```

- token 在创建 run/session 时铸造，per-run，不跨 run 复用。
- SDK：extension factory 闭包注入。
- RPC：`/run/codeteam/tokens/<runId>.token`（0600）注入；该目录前缀做硬 deny，不做 pattern 匹配。
- **不放 env**；同 worker 内多个 run 不能共享身份。
- tool args 不携带 `from` / `role`；服务端从 token 派生。
- handoff 创建时校验 `(fromRole,toRole,kind)` 命中 SOP actionPair 白名单。
- run terminal / interrupted 时显式撤销 token；恢复流程先生成新 token，不复用旧凭据。

**callback auth 落地补充（A1-2）：**

- `invocation_credentials` 用 SQLite 实现 F174：token hash+salt、run/task/role/agentSession/profile/thread 坐标、`owner_auth_provenance`、`callback_allowlist`、active/terminal、`last_refresh_at`、terminal tombstone 30d；active 不设短 TTL。
- liveness 两段式：stale heartbeat 只产生 candidate；v1 独立证据 = `run_events` 最新事件时间 + daemon 可见的 worker 子进程存活（`runs.status` 不作 proof）+ exact runId fence 才 `stale_invocation`；unknown retain，read 路径不吊销；worker lease 归 W5。
- 凭据只接受 header；body/query 一律 401 `invalid_token`；agent 读自身 token 文件走 tool policy 403。
- operator credential v1 = 本地 `CODETEAM_DATA_DIR/credentials/operator.key`（0600，`codeteam auth init` 签发，rotation 即撤销）；CLI 直接签名，W7 走 `auth console-link` 的 loopback-only 短时效 session token。同源 = 同一 operator principal/签发体系，不是同一载体；approval decide 只接受 operator principal；routine merge 按 `DP-MERGE-1=D` 由 daemon `service:merge-owner` 执行，per-merge short-TTL credential。
- agent-key 契约可复用，但 v1 不签发、不建 `agent_keys` 表；P1 external/IDE direct 再开。

### Secret model

v1：**agent 进程零 secret**。

- push / publish / 部署 / 云操作由 human 或 CI 执行。
- agent 只产出 diff / evidence / PR 描述。
- 不允许“把 secret 放在工具调用时注入”的模糊承诺；工具执行是子进程，secret 会进 env/argv/stdin。
- v2 若必须让 agent 调 secret API，使用受信 sidecar 在网络层注入 header，agent 不可见。

### Sandbox

- MVP 默认：低权 OS user + bwrap；目标态默认：container；microVM 后置；最终选型待 operator 确认。
- 只挂载 task worktree；不挂载 home、SSH、云凭证。
- **网络边界（D3=A 的已知限制）**：bwrap 的 netns 是二值，不能同时做到“默认关网 + loopback MCP + provider API”。MVP 显式接受 agent 进程网络开放为已知威胁模型边界，靠零 secret + 路径 policy + audit 兜底；目标态 container 再做真 allowlist。
- review/verify 使用 evidence-collection：task worktree 只读，取证写仅限隔离 evidence worktree；同 task 峰值 ≤2 份，计入 W5 pool。
- 资源限制：CPU / memory / disk / wall time / output bytes。
- 真实 repo first-run 用低权 user/sandbox；最坏只损失 worktree。

### Dogfood target boundary

- daemon 数据（SQLite / artifact / token）固定在仓外目录（如 `~/.local/state/codeteam/`），绝不放目标仓内。
- worktree root 用独立目录（如 `~/.codeteam/worktrees/<target>/`）；不写到目标仓内部。
- dogfood 分支只在本地 worktree，不 push 远端；进入 clowder-ai main 必须由 operator 发起并走 clowder-ai 自己的 PR/review 流程。
- dogfood 结束清理 worktree/branch，只保留 artifact 与报告。

### Command / path policy

- shell deny-by-default；只读命令 allowlist。
- 禁止 shell operators：`; | & < > \` $ \n #`。
- 禁止 `node -e`；repro 模式只允许 `node --test`。
- timeout、output cap、minimal env、audit。
- 写路径 canonicalize + realpath；拒绝 `..`、symlink/hardlink 逃逸。
- 读路径 deny：`.env*`、`*.pem`、`id_rsa*`、credentials、`.git`（仅工具层禁止读取内部对象；`git` CLI 子命令按 coder policy 放行）。
- token 目录 `/run/codeteam/tokens/` 做前缀硬 deny，不依赖文件名 pattern。
- **coder git policy**：`git add/commit/status/diff` 白名单；禁止 push/remote/config/checkout 主仓。commit 由 wrapper 代理执行，捕获 `head_sha` 写入 audit，供 `reviews.head_sha` 回溯。
- falsifier 预校验失败时只降级该 finding（P1/P2 → P3），不整条 review 拒绝；`blocked` 仅限基础设施故障（无法启动、timeout、output cap、二进制不存在），命令正常完成且 `exit != expected` 一律 confirmed/rejected；blocked 到期升级 human。

### Audit

- full args（不是 hash）、cwd、exit code、duration、stdout/stderr tail。
- env allowlist、artifact refs、actor/run/task/handoff/agentSession ID。
- `producingReviewId`（verifier 执行 reviewer 提供的 falsifier 时）。
- append-only trigger；agent 不可修改。

### Tasks

1. 实现 per-run token 铸造/绑定/撤销。
2. 改造 MCP server：token→binding 查表；拒绝 tool args 身份。
3. 改 coder/reviewer/verifier 工具 wrapper：路径/命令/env/resource limit。
4. 实现 coder git policy + commit wrapper，确保每个可 review 的 `head_sha` 都有 audit 来源。
5. 接 container/低权用户 profile；写 Docker/bwrap/等效 profile。
6. 实现 handoff 方向白名单与 `fromRole` token 校验。
7. 实现 audit append-only trigger 与 producingReviewId。
8. 写威胁测试：危险命令、路径逃逸、symlink/hardlink、secret dump、跨 run 身份冒用、agent 读取自身 token 文件、interrupted token 复用。
9. 写威胁测试：agent 在 `messages.rich_blocks_json` 中伪造 approval 卡，不得产生可审批项。
10. 建 `invocation_credentials` SQLite 表（含 `last_refresh_at`）+ per-run token 铸造/撤销/terminal tombstone；实现 header-only 凭据与 liveness candidate（run_events + worker process + exact runId）。
11. 实现本地 operator credential（`codeteam auth init`、0600、rotation 即撤销）与 `auth console-link`（W7a loopback-only 短时效 session token）；同源 principal，不同载体。

### Deliverables

- token service / binding store。
- sandbox profile + 启动脚本。
- command/path policy + tests。
- coder git policy + commit wrapper。
- audit schema + trigger + tests。
- 威胁测试报告。

### Acceptance

- [ ] 同 worker 内两个 run 的 MCP token 不能互相冒用。
- [ ] 危险命令、路径逃逸、symlink/hardlink、secret 路径全部拒绝。
- [ ] agent 读取自身 token 文件被拒绝；interrupted run 的 token 不能完成 handoff。
- [ ] 缺/伪造 operator 凭据调 approval decide / hard-gate merge 返回 403；run token/agent-key 调 approval decide / merge:execute 同样 403；routine merge 只由 daemon `service:merge-owner` 执行。
- [ ] callback credential 只接受 header；body/query 返回 401 `invalid_token`。
- [ ] stale lease/heartbeat 只产生 liveness candidate；无独立证据时 token 保持 active。
- [ ] review/verify 不能写被审 worktree、不能 merge/approve/push/production-write/secret-read；取证写仅限 evidence worktree；coder 不能 push/merge。
- [ ] `messages.rich_blocks_json` 不产生 approval 项；伪造审批卡被拒绝。
- [ ] coder 只能 `git add/commit/status/diff`；commit sha 可从 audit 回溯并写入 `reviews.head_sha`。
- [ ] agent 进程无 secret；凭证操作只走 human/CI。
- [ ] MVP 网络边界已记录为“agent 进程网络开放”的已知威胁模型；不得声称 bwrap 已实现 allowlist；container 目标态再补 allowlist。
- [ ] daemon 数据在仓外目录；dogfood worktree 在外部目录；分支不 push；结束后 cleanup。
- [ ] audit 不可 UPDATE/DELETE；能还原完整命令。
- [ ] 真实 repo first-run 在 sandbox/低权用户下完成并记录。

### Risks

| 风险 | 缓解 |
|---|---|
| 权限 wrapper 仍有逃逸 | 工具实现层 + OS sandbox；不只靠 hook |
| container 太重 | MVP 低权 user + bwrap；目标态 container；microVM 后置 |
| token 被模型读取 | 专用目录前缀硬 deny + 威胁测试；terminal/interrupted 立即撤销 |
| test code 可写/联网 | v1 接受为已知边界；verifier 只在 disposable copy + sandbox 跑 |

### Review focus

- 砚砚：per-run token、零 secret、路径/命令策略、audit 不可篡改。
- 烁烁：SDK/RPC 注入方式、worker 生命周期、re-attach 前置条件。

---

## 依赖与顺序

- W0a 先于 W1：形态确认 + L0 + session export + 供应链最小项决定 import/lockfile/CI。
- W0b（upstream/CI 治理；fork 已在 W0a 完成）与 W1–W4 并行，W5 前硬完成；不阻塞 dogfood。
- W1 先于 W2 的 audit/review 记录：没有 schema，安全证据无处落。
- W2 与 W3 可并行，但 W3 的 falsifier 执行依赖 W2 的 policy wrapper。
- W2 未完成前，不接真实 repo；只跑 fixture。

## 总体验收

- W0 的 L0 spike 有证据；W1 的 migration 可回滚；W2 的威胁测试全绿。
- 三份报告落到 `docs/reports/`（或本目录的 Results 段）。
- 非作者 review；代码 review 默认跨 model family。

---

[宪宪/deepseek-flash🐾]
