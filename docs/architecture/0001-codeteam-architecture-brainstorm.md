# codeteam 架构头脑风暴 v0

> 状态：讨论稿，不是已批准方案。
> 目标：把「基于 pi-agent-core 的纯 code agent」收敛成一个可验证的架构 strawman，供团队挑错。
> 事实核验：2026-10-21，基于 `@earendil-works/pi-agent-core@1.3.0`、`@earendil-works/pi-ai@1.3.0` 与本地 `clowder-ai` 仓。

## 1. 一句话定位

**codeteam 是一个 repo-native、headless-first 的编码代理运行时：用确定性 SOP 管流程，用可替换的角色 agent 做判断，用 git worktree 和工件账本保证可恢复、可审查、可验证。**

它不是 clowder-ai 的换皮，也不是一个新的聊天操作系统。它只保留对「把代码做对」有直接贡献的部分：

- 开发 SOP 与风险分级
- 角色分工与独立 review
- 任务、运行、工件、门禁的单一真相源
- A2A 式交接，但交接是结构化控制面，不是自由群聊
- 可观测、可评测、可回滚

明确不做：猫猫人格、家庭名册、语音、日记、signals、社交记忆、富聊天 UI、多租户 Hub。未来若要接入 clowder-ai，走 F241 的 `agentProvider` 插件方向，而不是把两套运行时糊在一起。

## 2. 最重要的设计判断

### 2.1 确定性流程，概率性工人

SOP 引擎拥有阶段迁移、门禁和终止条件；agent 拥有阶段内的推理、工具调用和代码修改权。

如果让 agent 自己决定「要不要设计、要不要 review、什么时候算完成」，它迟早会跳门禁。clowder-ai 的经验已经说明：写在 prompt 里的流程是建议，写在状态机里的流程才是约束。

### 2.2 工件是真相源，transcript 是调试材料

阶段之间传 `spec`、`plan`、`diff`、`test-report`、`review`、`merge-receipt`，不传整段聊天记录。这样做的直接收益：

- reviewer 拿到的是可审查的 diff 和证据，不是作者的思维链
- 上下文不会被历史 tool output 撑爆
- 任务可以跨 session、跨模型、跨天恢复
- 门禁可以机器校验，而不是靠另一只模型「感觉一下」

### 2.3 角色、模型、agent 实例三者解耦

- **Role**：职责、工具权限、输出 schema、门禁责任
- **Model policy**：按 role + stage + risk 选 provider/model
- **Agent instance**：某个 role 在某个任务里的具体运行，绑定 session 和预算

这样 DeepSeek/Kimi/GLM 可以换、可以降级、可以做交叉 review，而 SOP 不变。

建议 reviewer 必须是独立 agent 实例，使用 fresh context；architect 与 coder 也通过工件交接，不共享整段 transcript。角色实例的隔离程度可以按风险调整，但「作者不能审自己」不调整。

### 2.4 A2A 是控制面，不是聊天室

每次交接都必须是可校验的 envelope：

```ts
type Handoff =
  | { kind: 'handoff'; taskId: string; stage: Stage; from: Role; to: Role; artifacts: ArtifactRef[]; expected: string }
  | { kind: 'review_request'; taskId: string; from: Role; to: Role; diff: ArtifactRef; criteria: string[] }
  | { kind: 'verdict'; taskId: string; from: Role; to: Role; verdict: 'approve' | 'changes_requested' | 'blocked'; findings: Finding[] }
  | { kind: 'blocker'; taskId: string; from: Role; to: Role; reason: string; evidence: ArtifactRef[] }
  | { kind: 'question'; taskId: string; from: Role; to: Role | 'human'; question: string; deadline?: number };
```

没有「收到」「谢谢」「我看一下」这类空转消息。状态更新走事件日志，不唤醒 agent；只有需要对方行动时才产生 handoff。

### 2.5 单任务单 worktree 单写者

一个 task 绑定一个 git worktree 和一个 branch。同一阶段只有一个写者 role。并行只发生在明确允许的只读/分析阶段，或者由 orchestrator 显式分片。这样避免多 agent 同时改同一片代码，也避免「谁最后写谁算」。

### 2.6 为什么不用 Claude Code / Codex / OpenCode 当内核

它们是完整的 agent runtime，自带 loop、session、权限、工具和 UI 假设。复用它们能更快，但 codeteam 的核心差异是 SOP 状态机、角色交接和模型策略；这些需要深入 kernel 生命周期。`pi-agent-core` 更薄，hooks 足够，代价是持久化、沙箱、编排要自己补。

CLI / ACP 只是 codeteam 的接入层，不是内核。未来若要兼容 Claude Code / Codex / OpenCode，可以把它们作为外部 provider 或工具接入，而不是让它们拥有 codeteam 的 SOP 和 task 真相源。

## 3. 分层架构

```text
┌──────────────────────────────────────────────────────────────┐
│ Interfaces                                                    │
│ CLI / TUI / ACP / HTTP JSON events                            │
├──────────────────────────────────────────────────────────────┤
│ Orchestrator                                                  │
│ Task lifecycle · SOP engine · scheduler · A2A bus · budgets   │
├──────────────────────────────────────────────────────────────┤
│ Role Runtime                                                  │
│ architect · coder · reviewer · verifier                       │
│ role prompt + tool policy + model policy + output schema      │
├──────────────────────────────────────────────────────────────┤
│ Agent Kernel                                                  │
│ @earendil-works/pi-agent-core                                 │
│ loop · tool execution · events · steering · hooks             │
├──────────────────────────────────────────────────────────────┤
│ Model Gateway                                                 │
│ @earendil-works/pi-ai                                         │
│ deepseek · moonshotai(-cn) · zai(-coding-cn) · kimi-coding     │
├──────────────────────────────────────────────────────────────┤
│ Tool Plane                                                    │
│ fs · patch · shell · git · rg · test · lsp                    │
│ permission engine · sandbox · timeout · audit                 │
├──────────────────────────────────────────────────────────────┤
│ State                                                         │
│ SQLite (tasks/runs/messages/artifacts/verdicts/events)        │
│ git worktrees · artifact files · append-only audit log        │
└──────────────────────────────────────────────────────────────┘
```

### 3.1 Kernel 边界

`pi-agent-core` 已经提供：

- `Agent` 状态机与事件流（`agent_start` / `turn_start` / `message_*` / `tool_execution_*` / `agent_end`）
- `AgentTool` 定义、TypeBox 参数校验、parallel/sequential 工具执行
- `beforeToolCall` / `afterToolCall` 钩子
- `transformContext` / `convertToLlm` 上下文转换
- `prepareRequest` / `finishTurn` / `prepareNextTurn` 生命周期钩子
- `steer()` / `followUp()` 队列
- `sessionId` 透传，便于 provider 缓存

Kernel 不提供、必须我们自己补：

- session 持久化与 resume
- 多 agent / subagent 编排
- SOP 状态机与门禁
- 权限、沙箱、审批
- MCP / 插件工具注册
- repo map、检索、上下文压缩
- UI / CLI / ACP
- 评测与成本治理

建议在 kernel 外做一层薄适配，不要 fork `pi-agent-core`。pin 版本，所有对 kernel 的依赖集中在 `src/kernel/`，方便未来替换或贡献上游。

### 3.2 Model Gateway 边界

`pi-ai` 已经原生覆盖目标 provider：

| 目标 | Provider id | 环境变量 | 备注 |
|---|---|---|---|
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | 目录含 `deepseek-flash`、`deepseek-v4-pro`，1M context |
| Kimi / Moonshot | `moonshotai` / `moonshotai-cn` | `MOONSHOT_API_KEY` | 目录含 `kimi-k2.6`、`kimi-k2.7-code` |
| Kimi Coding | `kimi-coding` | `KIMI_API_KEY` | 目录含 `k3`、`k3-256k`，适合 coding subscription |
| GLM / ZAI | `zai` / `zai-coding-cn` | `ZAI_API_KEY` / `ZAI_CODING_CN_API_KEY` | 目录含 `glm-4.7`、`glm-5-turbo`、`glm-5.2` |

注意：这些是 pi-ai 1.3.0 目录里的 id；codeteam 的配置应使用逻辑别名（`architect.default`、`coder.default`、`reviewer.default`），不要在业务代码里散落硬编码 model id。模型目录会变，能力矩阵要可测。

### 3.3 Role Runtime

建议 MVP 四个角色：

| Role | 职责 | 主要工具 | 典型模型策略 |
|---|---|---|---|
| Architect | 澄清目标、拆解、设计门禁、写 spec/plan | read/glob/grep/git/ask_human | DeepSeek V4 Pro / Kimi K3，高 reasoning |
| Coder | 实现、修改、跑 targeted tests、自检 | fs/apply_patch/shell/git/test | Kimi K2.7 Code / K3-256K / DeepSeek Flash |
| Reviewer | 独立审查 diff、给 verdict、找风险 | read/grep/git diff/test evidence | GLM-5.2 / Kimi，必须与 author 不同 provider |
| Verifier | 跑验收、核对证据、检查回归 | shell/test/git/artifact read | 便宜快模型，按风险升级 |

角色不是人格。role prompt 只写职责、边界、输出契约；不写「你是一只猫」。角色输出尽量结构化，例如 reviewer 必须返回：

```json
{
  "verdict": "changes_requested",
  "findings": [
    {
      "severity": "P1",
      "file": "src/foo.ts",
      "line": 42,
      "claim": "这里在错误路径上覆盖了原状态",
      "evidence": "tests/foo.test.ts 的 failure case 未覆盖",
      "required_action": "补 red test 并修复"
    }
  ]
}
```

### 3.4 SOP Engine

SOP 不是一份长 prompt，而是一组可执行定义：

```ts
const development = defineWorkflow({
  id: 'development',
  stages: [
    stage('intake', { required: ['goal'], next: 'design' }),
    stage('design', { when: risk.ambiguous, required: ['spec'], gate: 'human', next: 'plan' }),
    stage('plan', { required: ['plan'], next: 'implement' }),
    stage('implement', { writer: 'coder', required: ['diff', 'self_check'], next: 'review' }),
    stage('review', { reviewer: notAuthor, required: ['review'], onChanges: 'implement', next: 'merge' }),
    stage('merge', { gate: 'mergePolicy', required: ['merge_receipt'], next: 'verify' }),
    stage('verify', { required: ['verification'], next: 'close' }),
  ],
});
```

关键点：

- stage 有 entry criteria / required artifacts / exit gate
- gate 是机器可判定的，失败就回到指定 stage
- `notAuthor` 是硬约束，reviewer 不能是作者
- 风险路由决定是否走 design / independent review / security review / full verify
- 小改动走 fast lane，不为了流程而流程

### 3.5 A2A Bus

MVP 不需要分布式消息队列。SQLite 表 + 进程内 scheduler 足够：

- `handoff` / `review_request` / `verdict` / `blocker` / `question` 都是持久化行
- 每个 handoff 有 `idempotency_key`、`reply_to`、`deadline`、`expected_artifact`
- scheduler 只唤醒「需要行动」的 handoff
- 同一 task 的 handoff 形成 DAG；orchestrator 拒绝非法迁移
- 乒乓保护：同一对角色连续 handoff 超过 N 次，升级到 human 或重新设计

外部 A2A（跨 task、跨进程、跨产品）以后再加。第一版只做本 task 内的角色交接，避免过早发明协议。

对人类和 IDE 可以暴露 `@architect` / `@coder` / `@reviewer` 这种入口语法；内部必须先解析成 typed envelope，再由 orchestrator 路由。`@` 是入口，不是协议本身。

### 3.6 Tool Plane

MVP 工具：

- `read_file` / `list_dir` / `glob` / `grep` / `rg`
- `apply_patch`（改已有文件走 patch，不直接覆盖）
- `write_file`（新文件）
- `shell`（cwd、timeout、输出上限、环境白名单）
- `git_status` / `git_diff` / `git_log` / `git_branch`
- `run_tests`（识别包管理器，优先 targeted tests）
- `lsp_diagnostics`（可选，但对大 repo 很值）
- `request_review` / `report_blocker` / `task_done`（控制工具）

安全边界：

- 工作区根目录限制；默认不允许访问 repo 外路径
- 命令分级：只读命令 allowlist；破坏性命令、网络安装、`git push`、`rm -rf`、`sudo` 需要审批
- 不把完整环境变量传给 shell；secret 不进模型上下文
- 每个工具调用记录：args hash、cwd、exit code、duration、输出摘要
- sandbox 接口先做 `local` 实现（cwd + timeout + resource limits），后续加 container/seatbelt/bubblewrap

`pi-agent-core` 的 `beforeToolCall` 是实现权限引擎的天然入口；不要在 prompt 里求模型「不要执行危险命令」。

### 3.7 Session / Context

`Agent` 的 messages 只在内存里。我们需要：

- 每条 `AgentMessage` 落库；resume 时重建 `initialState.messages`
- `transformContext` 做压缩：保留 system prompt、最近 N 轮、当前工件摘要、当前文件切片；旧 tool output 折叠成摘要
- `convertToLlm` 过滤掉 SOP 事件、UI 状态、审计消息，只把模型需要的内容送进 LLM
- `prepareRequest` 在每次请求前从 canonical store 重建上下文，避免漂移
- repo map：先做 `rg --files` + 目录树 + 最近 diff；需要时再加 tree-sitter/LSP 索引
- 每个 stage 结束做一个 checkpoint（artifact + git commit 或 patch），支持回滚

### 3.8 Observability / Eval

从第一天就记录：

- provider / model / role / stage
- input/output tokens、cache tokens、cost、latency
- tool call 次数、失败率、耗时
- gate 结果、review findings、fix 轮次
- 最终测试结果与人类是否接受

`codeteam eval` 用固定 fixture repo 跑任务集（修 bug、加小功能、重构、review），比较通过率、成本、时间。模型-角色映射要靠评测决定，不靠直觉。

## 4. 核心对象

```ts
type Task = {
  id: string;
  goal: string;
  repo: string;
  baseRef: string;
  worktree: string;
  branch: string;
  risk: 'low' | 'medium' | 'high';
  status: 'todo' | 'running' | 'blocked' | 'done' | 'cancelled';
  currentStage: Stage;
  budget: { tokens?: number; usd?: number; wallClockMs?: number };
};

type Run = {
  id: string;
  taskId: string;
  stage: Stage;
  role: Role;
  provider: string;
  model: string;
  sessionId: string;
  parentRunId?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  usage: Usage;
};

type Artifact = {
  id: string;
  taskId: string;
  kind: 'spec' | 'plan' | 'diff' | 'test-report' | 'review' | 'merge-receipt' | 'verification';
  revision: string;
  path?: string;
  content: unknown;
  createdByRunId: string;
};
```

`Task` 是用户可见的工作单元；`Run` 是一次 agent 调用；`Artifact` 是阶段间可审查的产物。三者分开，避免把「聊了什么」当成「做了什么」。

## 5. 建议的 MVP

### 目标

在一个真实 git repo 里，用 CLI 完成一次「小功能或修 bug」的端到端交付：

1. `codeteam run "<goal>"` 创建 task 和 worktree
2. Architect（可跳过）产出短 plan
3. Coder 读代码、改代码、跑 targeted tests
4. Reviewer（不同 provider）只看 diff + 测试证据，给 verdict
5. Coder 处理 findings，Verifier 复跑
6. CLI 输出最终 diff、测试证据、review verdict
7. 人类决定是否 merge

### 必须验证的假设

- 三个 provider 在同一个 tool schema 下都能稳定 tool calling
- 跨 provider review 能发现作者模型的真实问题，而不是互相客套
- 工件驱动的上下文比整段 transcript 更省 token、更可恢复
- 确定性 SOP + 单写者不会把开发速度拖死
- 权限引擎能挡住危险 shell，而不妨碍正常开发

### 明确不做（MVP）

- 分布式 A2A / 跨 repo 调度
- 自动 merge 到 protected branch
- 自研模型 / 自研 agent loop
- 富 UI / 语音 / 人格
- 大型插件市场

## 6. 分阶段路线

| 阶段 | 内容 | 验收信号 |
|---|---|---|
| Phase 0 | Kernel spike：pi-agent-core + pi-ai 三 provider + tool loop + streaming | 三个 provider 都能完成同一道小修 bug；记录 tool calling 差异 |
| Phase 1 | 单 agent CLI：read/patch/shell/test、session 落库、resume、权限引擎 | 真实 repo 端到端修一个 bug；中断后可恢复 |
| Phase 2 | SOP engine + architect/coder/reviewer + worktree + artifacts | 小功能走完 implement→review→verify；reviewer 非作者 |
| Phase 3 | A2A bus + 风险路由 + 交叉模型 review + eval harness | 评测集通过率/成本可比较；乒乓和空转被阻断 |
| Phase 4 | TUI / ACP / 多 task 调度 / sandbox 强化 / 插件工具 | IDE 或终端可用；高危命令默认拒绝 |

## 7. 主要风险

| 风险 | 表现 | 缓解 |
|---|---|---|
| 过度编排 | 多 agent 互相客套、token 烧穿、任务变慢 | 确定性 SOP、typed handoff、单写者、只唤醒需要行动的人 |
| Kernel 早期 | pi-agent-core API 变化、缺持久化/沙箱 | pin 版本、薄适配层、集成测试、必要时贡献上游 |
| 模型差异 | tool calling / 流式 / reasoning 行为不一致 | provider capability matrix、按模型跑 eval、fallback |
| 上下文爆炸 | 大 repo、长任务、tool output 污染 | repo map、检索、工件摘要、压缩、输出落盘 |
| 安全 | shell 执行、secret 泄漏、越界写 | 权限引擎、sandbox、审批、env 白名单、审计 |
| SOP 官僚化 | 小改动也要 design/review/full test | 风险分级、fast lane、可回滚的小改动直接做 |
| Review 形式化 | 同族模型共享盲点、reviewer 只复述 diff | 跨 provider、fresh context、只看证据、要求 P1/P2 具体 finding |
| 范围蔓延 | 又长成 clowder-ai | 明确非目标、MVP 切片、每个阶段只加一个能力 |

## 8. 和 clowder-ai 的关系

复用概念，不复用壳：

- 复用：开发 SOP、风险路由、独立 review、任务/运行/工件分离、A2A 交接、审计与评测
- 不复用：猫猫人格、家庭名册、语音、日记、signals、社交记忆、富聊天 UI、多租户 Hub

如果未来 codeteam 要进 clowder-ai，最干净的方式是作为 F241 的 `agentProvider` / reference runtime：clowder-ai 拥有 thread、身份、路由、UI、安全边界；codeteam 拥有 repo 执行、SOP、角色 agent 和代码工具。不要把两套 task/session 真相源合并。

## 9. 留给团队的问题

请每只猫重点回答自己那一面，并明确给出「同意 / 反对 / 替代方案」：

1. **边界**：codeteam 先做独立 CLI，还是直接做 clowder-ai 的 provider？独立产品是否会导致重复造 thread/session/UI？
2. **SOP**：确定性状态机是否过于刚性？哪些 stage 应该允许 agent 自决跳过？fast lane 的边界怎么定？
3. **多 agent**：architect/coder/reviewer 应该是独立 agent 实例，还是一个 agent 切换 role？reviewer 必须 fresh context 吗？
4. **A2A**：第一版只做 task 内 typed handoff 是否足够？哪些场景真的需要跨 task/跨进程 A2A？
5. **模型策略**：三角色如何映射到 DeepSeek/Kimi/GLM？交叉 review 的最小规则是什么？是否需要保留一个非国产模型作为盲点对照？
6. **安全**：MVP 的 shell 权限模型做到什么程度才敢给真实 repo 用？local sandbox 够不够？
7. **MVP**：如果只能先做一条端到端链路，应该选「修 bug」还是「加小功能」？为什么？

## 10. 参考与核验

- `@earendil-works/pi-agent-core@1.3.0` README / `dist/*.d.ts`：Agent、AgentTool、事件、hooks、steering/follow-up、sessionId。
- `@earendil-works/pi-ai@1.3.0` README / provider catalog：DeepSeek、Moonshot、ZAI、Kimi Coding provider 与模型目录；TypeBox tool schema；usage/cost。
- 本地 `clowder-ai/docs/SOP.md`：风险路由、Design Gate、review 去叠加、merge-gate、Alpha 验收。
- 本地 `clowder-ai/docs/architecture/a2a-protocol.md`：消息生命周期、handoff、单 terminal、队列与恢复。
- 本地 `clowder-ai/docs/features/F241-agent-provider-plugin.md`：`clowder-code` reference runtime；KD-5 明确 pi 作为 runtime core 的方向。

> 这份文档只回答「怎么搭」，不回答「第一行代码写哪」。下一步应先做 Phase 0 spike，用三个 provider 跑同一道真实任务，拿到 tool calling / 成本 / 延迟 / 失败模式的实际数据，再决定角色映射和 SOP 粒度。
