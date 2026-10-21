# pi fork 策略

> 决策：codeteam 不再在空仓里重造 kernel / tool / session / CLI。直接 fork `earendil-works/pi`（v1.3.0，MIT），在同一个 monorepo 里新增 `packages/codeteam`，并允许修改 `packages/agent`、`packages/ai`、`packages/coding-agent` 的源码。
> 产品形态：**library / SDK first**，不是 CLI-first。CLI、TUI、RPC、ACP 都只是 adapter。

## 1. 为什么这个方向更好

`@earendil-works/pi-coding-agent` 已经是完整的 coding agent，不只是 kernel：

- `createAgentSession()` SDK：模型、thinking level、session manager、resource loader、tools 都可注入。
- 内建工具：read / bash / edit / write / grep / find / ls / powershell。
- `SessionManager`：持久化 JSONL、branch、compaction、session resume。
- `ModelRuntime` + `pi-ai`：DeepSeek / Moonshot / ZAI / Kimi Coding 等 provider 已覆盖。
- extensions / custom tools / MCP / RPC / JSON mode / CLI 都已存在。
- 上游明确说它 **skips sub-agents and plan mode**——这正是 codeteam 要补的差异点。

所以 codeteam 的核心工作不是重写工具层，而是：

1. 角色层：architect / coder / reviewer / verifier，每个角色一个可配置 session。
2. SOP 层：确定性 stage / gate / artifact / risk routing。
3. A2A 层：typed handoff、单槽 CAS、one terminal、deadline、startup recovery。
4. Review 层：盲评、fresh context、falsifier、clean-diff FP 负对照。
5. Eval 层：seeded bugs、三 provider 指标、模型-角色映射。

## 2. 为什么 fork，而不是 npm dependency

如果只做扩展，npm dependency + extensions 就够；但目标是后续可侵入 kernel：

- 需要在 `packages/agent` 里改 loop / state / queue / subagent 语义；
- 需要在 `packages/coding-agent` 里改 session factory、role-aware tools、review context 注入；
- 需要把 pi 的 session/compaction 当作 codeteam 的 agent transcript 底座；
- 需要控制版本和 patch 顺序，避免上游 release 把 codeteam 行为带跑。

fork 后可以直接改源码、加测试、跑上游测试套件；MIT 许可证允许，但必须保留 `LICENSE` 和上游归属。

## 3. 建议仓库布局

```text
codeteam/                      # fork of earendil-works/pi
  packages/
    ai/                        # upstream; provider / model catalog
    agent/                     # upstream; agent loop / state
    coding-agent/              # upstream; SDK / session / tools / CLI
    codeteam/                  # NEW: roles / SOP / A2A / eval / orchestrator
  docs/
    architecture/
    plans/
  UPSTREAM.md
```

`packages/codeteam` 通过 workspace 依赖使用 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`，不需要重新实现工具和 session。

## 4. 修改边界

**优先放在 `packages/codeteam`：**

- 角色定义、system prompt、模型策略、工具 allowlist
- SOP 状态机、gate、risk classifier
- A2A envelope、bus、scheduler、handoff CAS
- review envelope、falsifier、verifier
- eval fixtures、metrics、报告
- codeteam 自己的 SQLite 控制面（task / stage / run / artifact / handoff / inbox）

**只有必要时才改 `packages/coding-agent`：**

- role-aware `createAgentSession` 工厂
- 自定义工具 / extension 的注册入口
- session 投影与 review fresh-context 注入
- 需要改变 CLI/RPC 行为时

**只有语义确实需要时才改 `packages/agent`：**

- subagent / role scheduling
- queue / steering / finishTurn 语义
- 跨 session 的 run 生命周期

**`packages/ai` 尽量少改：**

- DeepSeek / Moonshot / ZAI / Kimi Coding 已经存在；先确认 auth 和模型目录，不急着改 provider。
- 只有新增 provider、修正兼容性、补 model metadata 时才动。

每一条 kernel patch 都要有：

1. 为什么 `packages/codeteam` 或 extension 做不到；
2. 对应测试；
3. 与上游的 diff 说明；
4. 是否可上游化（upstreamable）标记。

## 5. 上游同步

- 初始 pin：`v1.3.0`（commit `71023aec1546d6d677a65669c5665c0927ce0dd0`）。
- 加 `upstream` remote：`https://github.com/earendil-works/pi.git`。
- `codeteam` 分支保存我们的修改；同步时先 `git fetch upstream`，再 merge/rebase 到新 tag。
- 每次同步后跑上游 `./test.sh` + codeteam 自己的 vitest；不允许只跑 codeteam 测试。
- `UPSTREAM.md` 记录：当前 tag、commit、已修改的 kernel 文件、同步日期、冲突处理。
- 不直接改 `node_modules`；不把上游源码复制到 `src/vendor` 后再手工 diff。

## 6. 对 MVP 的影响

### 变简单

- Gate B 不需要自己写 read/patch/shell/session/compaction；直接用 `createAgentSession`。
- 三个 provider 的模型选择、auth、session 持久化、工具调用事件都可以复用。
- `SessionManager.inMemory()` 可用于 reviewer fresh context；持久化 session 可用于 coder resume。

### 变复杂

- 需要维护 fork 的上游同步。
- 需要理解 pi 的 session entry 格式和 compaction 语义。
- 需要决定 codeteam 的 SQLite 控制面与 pi session 的边界：**pi session 是 agent transcript；codeteam SQLite 是 task/run/artifact/handoff 真相源**。

## 7. MVP 的代码形态

```ts
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createCodeteamSession } from "@codeteam/core";

const coder = await createCodeteamSession({
  role: "coder",
  taskId,
  model: getModel("deepseek", "deepseek-v4-pro"),
  tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  sessionManager: SessionManager.create(cwd),
});

await coder.prompt("Fix the failing test in fixtures/bug-01 without changing the public API.");
```

reviewer 使用新的 in-memory session，只注入 review envelope 和 artifact 引用：

```ts
const reviewer = await createCodeteamSession({
  role: "reviewer",
  taskId,
  model: getModel("zai", "glm-5.2"),
  tools: ["read", "grep", "find", "ls"],
  sessionManager: SessionManager.inMemory(cwd),
  context: { envelope, artifacts },
});
```

## 8. 风险

| 风险 | 缓解 |
|---|---|
| fork 漂移，越改越难同步 | 先 extension / codeteam 包，再 kernel patch；每条 patch 有测试和上游 diff |
| 上游 v1.x 破坏性变化 | pin tag + 同步分支 + 全量上游测试；不追 main |
| 两套 session 真相源冲突 | 明确：pi session = transcript；codeteam SQLite = task/run/artifact/handoff |
| 过度修改 kernel | 先证明 extension 做不到；kernel patch 必须能独立解释 |
| 许可证/归属 | 保留 MIT LICENSE 和上游 attribution；文档记录来源 |

## 9. 下一步

1. 把当前空仓初始化为 pi 的下游 fork（或把 pi v1.3.0 作为 subtree/vendor，二选一，见下）。
2. 新增 `packages/codeteam`，先写控制面 wire test（零 token）。
3. 用 `createAgentSession` 做一个最小 coder session，跑 fixture 单 bug。
4. 再决定哪些改动需要进入 `packages/agent` / `packages/coding-agent`。

### fork 还是 subtree？

- **长期深改、要持续同步上游**：推荐 fork。历史、remote、PR、测试都最顺。
- **想保持 codeteam 仓独立、只偶尔同步**：用 git subtree 把 pi 放到 `vendor/pi`，但 workspace 和 lockfile 会更绕。

当前建议：**fork**。codeteam 本来就是一个新的下游产品，不需要假装成一个独立的小仓。
