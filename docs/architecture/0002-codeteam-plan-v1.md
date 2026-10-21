# codeteam 实施方案 v1

> 状态：可开工方案，待 co-creator 对 3 个边界拍板。
> 来源：v0 strawman + 烁烁（kernel/runtime）、砚砚（review/security/eval）的 review；梵花猫的 SOP/A2A 补问已重新分发。
> 原则：先把「可测量的一小段」做成实物，再扩大；不先造平台。
> 2026-10-21 架构修订：不再从零建 kernel / tool / session。codeteam 作为 `earendil-works/pi` 的下游 fork，数据面使用 `@earendil-works/pi-coding-agent` SDK；下面的 Phase 门禁和控制面设计仍有效，数据面实现以 `0003-pi-fork-strategy.md` 和 MVP 方案为准。

## 1. 从 v0 到 v1 的硬修正

v0 的骨架保留：确定性 SOP、工件真相源、role/model/instance 解耦、单 task 单 worktree 单写者、task 内 typed handoff。

v1 吸收以下修正：

1. **权限第一层在工具实现，不在 hook。** `beforeToolCall` 只做第二层策略判定和审计；shell 的 cwd、timeout、minimal env 是工具构造参数。进程崩溃时 hook 不能当安全边界。
2. **持久化范围扩大。** 除 agent messages 外，`steer()` / `followUp()` 队列、待处理 inbox、stage checkpoint 都要落库并可重放。
3. **stage 边界 = Run 边界 = checkpoint 边界。** 历史 stage 只保留 artifact + verdict；resume 只重建当前 stage 的未完成 Run。长任务不拖整段历史。
4. **`convertToLlm` 是唯一投影入口。** 任何进模型的内容都必须经过投影；SOP 事件、审计、UI 状态不得绕过。reviewer fresh context 就是「新 Run + 只注入 envelope + artifact 引用」。
5. **eval 前移。** 没有 seeded-bug 数据集和 clean-diff 负对照，就无法验证「跨 provider review 是否有效」。eval 是 Phase 0/1 的验收方式，不是 Phase 3 的能力。
6. **review 靠证据链，不靠换 provider。** 跨 provider 是必要非充分；盲评、fresh context、finding 带 falsifier、由证据关闭，才是主要杠杆。
7. **风险不能由 author 自评。** `Task.risk` 由机器规则 + 人类 override 决定；author 自评 low risk 走 fast lane 是 gate bypass 后门。
8. **审计记全量 args + 截断输出。** 只记 args hash 无法回答「它到底跑了什么」。
9. **scheduler 事件驱动 + dirty-bit drain。** 不轮询；保持「queue 非空且可执行时不可能没有 drain」的不变量。
10. **SQLite 不存泛化 message 概念。** 只有 task / stage / run / run_event / artifact / handoff / inbox。Agent transcript 是 run_event，不是聊天消息实体。
11. **A2A schema 前移。** handoff 表、`status`（pending/claimed/consumed/expired）、one terminal per run、deadline 从 Phase 0 schema 开始；Phase 3 只开放编排入口，不重新造表。
12. **SOP 要有异常转移边。** 增加 typed `spec_change` / `plan_revision` 请求边：agent 提请，orchestrator 按机器可判规则裁定。状态机开放转移、封闭验收，门禁闭死但路径留口。
13. **gate 自身也要被评测。** 每个 gate 记录通过率与 block 原因分布；连续通过率 >95% 且从未真正 block 的 gate 标记为剪枝候选，不靠事后辩论。
14. **startup recovery 要判 interrupted。** admitted-but-client-gone 的 Run 标记 `interrupted` 并重新入队；只重建 messages 不够，否则 zombie Run 会占槽、任务静默挂起。
15. **A2A 四条硬规则。** 单槽 CAS（double claim 第二个返回 safe_wait）；one terminal per run（同代 replay 返回已提交结果）；无 expected artifact 不唤醒；deadline 到期回收，loop guard 按 `(subject, action pair)` 计数而不是消息条数。

## 2. 最终架构

```text
SDK / RPC / CLI / TUI / ACP
        │
        ▼
packages/codeteam
  Orchestrator: task lifecycle · SOP engine · scheduler · A2A bus · budgets
        │
        ▼
pi-coding-agent SDK (forked)
  AgentSession · built-in tools · SessionManager · compaction · extensions · MCP
        │
        ▼
pi-agent-core (forked)
  Agent loop · tools · events · convertToLlm · transformContext · hooks
        │
        ▼
pi-ai (forked)
  deepseek · moonshotai · zai · kimi-coding
        │
        ▼
State: pi SessionManager (agent transcript) + codeteam SQLite (task/run/artifact/handoff) + git worktrees
```

### 2.1 核心对象

```text
Task 1 ── N Stage 1 ── N Run 1 ── N RunEvent
  │                       │
  └── N Artifact          └── N ToolCallRecord (event payload)
  └── N Handoff
  └── N InboxItem
```

- `Task`：用户可见工作单元，绑定 repo / baseRef / worktree / branch / risk / budget。
- `Stage`：SOP 阶段，拥有 entry criteria、required artifacts、exit gate。
- `Run`：一次 role agent 调用，绑定 provider/model/sessionId/usage。
- `RunEvent`：append-only 事件流，含 agent message、tool call、gate result。
- `Artifact`：spec/plan/diff/test-report/review/merge-receipt/verification。
- `Handoff`：typed A2A 控制面消息，不是聊天。
- `InboxItem`：待处理的 steer/followUp/human guidance，持久化后可重放。

### 2.2 SQLite 表

```sql
tasks(id, goal, repo, base_ref, worktree, branch, risk, status, stage, budget_json, created_at)
stages(id, task_id, name, status, entry_criteria_json, exit_gate_json, started_at, ended_at)
runs(id, task_id, stage_id, role, provider, model, session_id, parent_run_id, status, usage_json, started_at, ended_at, terminal_at)
run_events(id, run_id, seq, kind, payload_json, created_at)
artifacts(id, task_id, run_id, kind, revision, path, content_json, created_at)
handoffs(id, task_id, kind, from_role, to_role, status, payload_json, idempotency_key, reply_to, deadline, attempt, loop_key, terminal_at, created_at)
inbox(id, task_id, run_id, kind, payload_json, status, created_at, consumed_at)
```

注意：没有 `messages` 表。Agent 的对话记录是 `run_events(kind='agent_message')`，它服务于 resume 和审计，不服务于聊天 UI。

## 3. packages/codeteam 内部结构（在 pi fork 内）

```text
packages/codeteam/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    orchestrator.ts       # task lifecycle / scheduler
    adapters/
      pi-session.ts       # createAgentSession 工厂 + role prompt + tools
    roles/
      architect.ts
      coder.ts
      reviewer.ts
      verifier.ts
    sop/
      types.ts
      workflow.ts
      gates.ts
      risk.ts
    a2a/
      envelopes.ts
      bus.ts
      scheduler.ts
    control-store/
      db.ts               # SQLite task/run/artifact/handoff/inbox
      schema.ts
      store.ts
    review/
      envelope.ts
      finding.ts
      falsifier.ts
    eval/
      fixtures.ts
      runner.ts
      metrics.ts
    tools/
      run-tests.ts        # codeteam 自定义工具；其余用 pi 内建
      request-review.ts
      report-blocker.ts
  fixtures/
    seeded-bugs/
      bug-01-state-overwrite/
      bug-02-off-by-one/
      bug-03-boundary/
      bug-04-race/
      bug-05-security/
  docs/
    architecture/
```

## 4. Phase 0：kernel / tool / session / provider 闭环

### 交付物

1. 以 pi v1.3.0 为 base 的 fork；新增 `packages/codeteam`；跑通上游 `./test.sh`。
2. `createAgentSession` adapter：coder / reviewer / verifier 三种 role session，配置 model、tools、SessionManager。
3. `codeteam models`：复用 pi `ModelRuntime`，列出 role 默认 provider/model、auth 状态、context window、reasoning 支持。
4. Control store：SQLite task / stage / run / artifact / handoff / inbox；pi SessionManager 只管 agent transcript，不替代 control store。
5. 工具：复用 pi 内建 read / bash / edit / write / grep / find / ls；新增 codeteam 自定义 `run_tests` / `request_review` / `report_blocker`。
6. 权限层：pi 默认没有内建权限系统，codeteam 必须在 tool 实现/extension 层加 deny-by-default、路径 containment、env 白名单、审计；这是 fork 后第一批 kernel/coding-agent 改动之一。
7. 一个 fixture repo：一个 failing test + 一行可修复 bug。
8. A2A/SOP 控制面：handoff schema、单槽 CAS、one terminal、deadline、loop guard、startup recovery；用 fake role 的 vitest wire test 验证，零 token。

### 必做的安全基线

- shell deny-by-default 白名单：只读命令、task branch 上的 git add/commit、带 timeout 的测试命令；其余人工审批。
- 禁止启发式黑名单作为安全边界；命令可组合，黑名单给的是假安全感。
- `apply_patch` / `write_file` 先 canonicalize，再判定在 worktree 内；拒绝 `../` 和 symlink 逃逸。
- 读路径 denylist：`.env*`、`*.pem`、`id_rsa*`、credentials 类路径；输出进模型前做 secret 形状 redact。
- shell 使用 minimal env（PATH/HOME/LANG + 显式白名单）；API key 不进 shell。
- 真实 repo 首次使用就用专属低权 OS 用户跑 agent；容器化留到 Phase 4。
- 审计记全量 args + 截断输出 + exit code + duration + cwd；不记 hash 代替 args。

### 验收

- 3 个 provider（DeepSeek / Moonshot / ZAI）都能完成同一个 fixture 任务：读文件 → patch → targeted test → 产出 diff + test-report。
- 至少 2/3 provider 通过；失败要有结构化 error，不是空回包。
- `SIGKILL` 后 resume：从 Task → current stage artifacts → current stage incomplete run events 重建，任务能继续完成。
- 危险命令（递归删除、`git push`、`curl | sh`）被拒；审计能还原完整命令。
- 测试证明所有模型输入都经过 `convertToLlm`，不存在绕过路径。

### 记录指标

`tool_call_success_rate`、`patch_valid_rate`、`provider_error_rate`、`input/output tokens`、`cost_usd`、`latency_ms`、`resume_correctness`。

## 5. Phase 1：seeded-bug 单 agent 数据

### 数据集

fixture repo 植入 5 个已知 bug，每个配一条红测试和 ground truth patch：

1. 错误路径覆盖状态
2. off-by-one
3. 未处理的边界
4. 竞态/顺序问题
5. 安全类（路径穿越或权限绕过）

### 运行

- Coder 单 stage 单 Run：读文件 → 定位 → edit/write → 从 git diff 捕获 patch → targeted test → test-report artifact。
- 5 bugs × 3 providers = 15 runs；不接 reviewer。
- 至少 3 个 run 做 `SIGKILL` / resume 测试。

### 验收

- 至少一个 provider 达到 4/5 修复通过。
- 所有 run 有可复现的 patch、test-report、usage。
- 失败归因清楚：模型 tool calling、工具、上下文、测试环境，四类分开。
- 如果 provider 失败率 > 50%，不进入 Phase 2；先修 kernel/tool。

### 产出

一张 15 行的指标表 + 一段结论：哪个 provider 适合 coder，哪个适合 reviewer，哪个需要 fallback。模型-角色映射在这里决定，不靠直觉。

## 6. Phase 2：review 证据链与 FP 负对照

### Review 机制

- reviewer 独立 agent 实例，fresh context，只拿 envelope + artifact 引用。
- 盲评：review_request 不携带 author 的 model/role 身份。
- finding schema 强制证据：

```ts
type Finding = {
  severity: 'P1' | 'P2' | 'P3';
  file?: string;
  line?: number;
  claim: string;
  evidenceKind: 'red_test' | 'repro_command' | 'static_check' | 'code_reading' | 'judgment';
  falsifier: string;
  required_action: string;
};
```

- P1/P2 没有可执行证据 → 自动降级 P3。
- verifier 执行 `falsifier`；证据成立 = finding 成立，证据不成立 = finding 撤销。findings 由证据关闭，不由 reviewer 再审关闭。
- review_request 附机械生成的 impact surface：changed symbols 的 callers、affected tests（先 `rg`，后续可升 LSP）。

### 负对照

- 5 个 seeded bugs：测 review recall（coder 遗留的坑 reviewer 抓到几个）。
- 5 个 clean diffs：测 false-positive 率（reviewer 在干净 diff 上编造多少 finding）。
- 每个 finding 过 falsifier：测 finding survival。

### 预注册门槛（先定后测，不事后改）

建议初始门槛：

- clean-diff FP rate <= 20%
- seeded-bug review recall >= 60%
- finding survival rate >= 80%
- 每个 task 的 review 成本不超过 coder 成本的 50%

未达门槛 → reviewer 默认关闭，只作为 advisory；迭代后再开。达标 → 进入 Phase 3。

## 7. Phase 3：SOP engine + A2A

### SOP

- `defineWorkflow` 定义 stages、entry criteria、required artifacts、exit gate。
- 风险分类机器可判：路径（auth/payment/migration/core）、新增依赖、public API 变更、diff 规模、测试变更；人类可 override，author 不能自评。
- fast lane 只允许：纯 docs/注释、无代码路径、无依赖变更。任何触码/触测试改动至少走 evidence-only review。
- gate 失败回到指定 stage，并生成结构化 finding；不允许「原地口头通过」。

### A2A

schema 已在 Phase 0 落地；本阶段只开放编排入口、真实角色路由和端到端 handoff。

- 第一版只做 task 内 typed handoff。
- `@architect` / `@coder` / `@reviewer` 是入口语法；内部解析成 envelope。
- 事件驱动 + dirty-bit drain；不轮询。
- 每个 handoff 有 idempotency key、reply_to、deadline、expected artifact。
- 乒乓保护：同一对角色连续 handoff 超过 N 次 → 升级 human 或触发 plan revision。
- 状态更新走 run_event，不唤醒 agent；只有需要行动才产生 handoff。
- 异常转移：`spec_change` / `plan_revision` 由 agent 提请、orchestrator 裁定；不允许用永久 blocker 代替正常回退。

### 端到端验收

- 一个 seeded bug 走完 implement → review → verify → human merge。
- 一个小功能走完 architect → design gate → implement → review → verify。
- reviewer 非作者、盲评、fresh context；所有 finding 由 falsifier 关闭。
- 任何 gate 不能被 author agent 自评绕过。

## 8. Phase 4：接口与加固

- `codeteam run` / `task list|show|resume|cancel` / `review` / `eval` / `events --json`。
- TUI：stage、role、tool call、diff、findings、budget。
- ACP / HTTP JSON events：IDE 接入。
- 多 task 调度；容器化 sandbox；插件工具。
- 模型路由按 Phase 1/2 数据迭代，不写死。

## 9. 明确不做

- 不做猫猫人格、语音、日记、signals、社交记忆、富聊天 UI。
- 不做分布式 A2A / 跨 repo 调度，直到单 task 闭环稳定。
- 不做自动 merge protected branch；MVP 永远人工 merge。
- 不自研 agent loop；fork pi，`pi-agent-core` / `pi-coding-agent` 可直接改。优先在 `packages/codeteam` 和 extensions 里做，只有语义确实需要时才 patch kernel。
- 不在 codeteam 里存泛化 message / thread 实体。

## 10. 立即可执行

不依赖 API key、现在就能做：

0. Bootstrap：fork pi v1.3.0，新增 `packages/codeteam`，跑通上游 `./test.sh`。
1. A2A/SOP 控制面 wire test：fake role 驱动 coder → reviewer → rework → verifier，测单槽 CAS、one terminal、loop guard、crash recovery、非法转移拒绝。零 token，今天可跑。
2. `packages/codeteam` 的 `package.json` / `tsconfig.json` / `vitest.config.ts`。
3. `control-store/` SQLite schema + store + inbox。
4. `adapters/pi-session.ts`：用 `createAgentSession` 创建 coder / reviewer / verifier session，配置 model、tools、SessionManager。
5. fixture repo + failing test；coder 用 pi 内建 read/bash/edit/write 跑通。

需要 key 才能做：

6. 三 provider 的 live smoke test。
7. Phase 1 的 15 runs 指标。

需要 co-creator 拍板：

8. codeteam 作为 pi 下游 fork + SDK/library（推荐），还是保持独立仓、只把 pi 当 npm dependency？前者适合深改 kernel，后者同步更简单但侵入性弱。
9. MVP 是否接受「agent 只出 diff/证据，人负责 merge protected branch」？（推荐接受）
10. Phase 0/1 先用「修 bug」还是「加小功能」？（推荐修 bug）

## 11. 风险与停止条件

| 风险 | 停止/回退条件 |
|---|---|
| 三 provider tool calling 不稳定 | 失败率 > 50% 时停，先修 kernel/tool，不进入 review |
| reviewer 幻觉导致信任崩塌 | FP rate 未达预注册门槛时关闭 reviewer，只保留 advisory |
| 上下文爆炸 | stage 内 Run 预算超限必须 checkpoint；不允许硬撑 |
| SOP 官僚化 | 小改动走 fast lane；发现 gate 不产生信息增益就删 gate |
| 安全越界 | 任一危险命令绕过白名单 = P0，停止真实 repo 使用，先修权限 |
| 范围蔓延 | 出现 message/thread/UI 实体 = 设计告警，回到「纯 code agent」边界 |
| 静默空转 | handoff 只认行 CAS；deadline 到期回收；startup 把 lost client 的 Run 判 interrupted 重排 |

## 12. 一句话

先用 5 个 seeded bugs 证明「kernel + tool + session + 3 providers」能稳定修 bug，再用 clean diffs 证明「review 不是表演」，最后才把 SOP/A2A 接上。这个顺序能保证每一步的失败都能归因，而不是把模型、工具、流程混在一起猜。
