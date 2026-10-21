# SDK vs fork：codeteam 应该怎么基于 pi 魔改

> 问题：直接使用 `@earendil-works/pi-coding-agent` 的 SDK，能否满足深改 kernel？还是应该 fork 源码、直接基于 `pi-coding-agent` 魔改？
> 结论：**SDK 是集成面，不是改内核的接口。要深改，fork 整个 `earendil-works/pi` monorepo；但 fork 后仍应 SDK-first，不要把所有东西都改在内核里。**

## 1. SDK 能做什么

`createAgentSession()` 暴露的边界：

- 选 model / thinking level / scoped models
- 传 `SessionManager`（持久化或 in-memory）
- 传 `ResourceLoader`（extensions / skills / prompts / themes / AGENTS files / system prompt）
- 选 built-in tools（allowlist / denylist / `noTools`）
- 注册 custom tools
- 传 `SettingsManager`（compaction、retry 等）
- 传 `ModelRuntime`（auth / models）
- 传 `cwd` / `agentDir`
- 订阅 session events、prompt、steer、followUp、abort、compact

Extension API 还能：

- `pi.on("tool_call")` 改参数或 block 执行
- `pi.on("tool_result")` 组合/改写结果
- `pi.on("context")` / `context_with_system` 改模型上下文
- `pi.on("before_agent_start")` 改 prompt / tools / guidelines
- `pi.on("session_before_compact")` 接管 compaction
- `pi.registerTool()` / `pi.registerCommand()` / `pi.registerProvider()` / `pi.registerVirtualModel()`
- `pi.setActiveTools()` / `pi.appendEntry()` / `pi.sendMessage()`

对 codeteam 的 roles / SOP / A2A / review / eval 来说，这些边界已经能覆盖大部分需求。

## 2. SDK 不能做什么

SDK 是公开契约，不是内核修改入口。它不能直接改：

- `Agent` 的 loop 顺序、turn 边界、tool batch 语义
- `SessionManager` 的 JSONL 格式、branch/compaction 持久化语义
- built-in tool 的内部实现（bash 怎么执行、edit 怎么写、路径怎么判）
- `AgentSession` 的内部 scheduling / retry / queue 细节
- `baseToolsOverride` 这类内部注入点（`AgentSession` 内部有，但 `CreateAgentSessionOptions` 没公开）
- 事件顺序、session 生命周期、subagent 生命周期（pi 明确不做 subagents）

如果 codeteam 的差异化只是“角色 + SOP + A2A + review”，SDK + extensions 很可能够。
如果差异化是“权限、沙箱、subagent、plan mode、session/run 语义”，就必须改源码。

## 3. Fork 粒度

| 方案 | 能改什么 | 主要问题 | 评价 |
|---|---|---|---|
| SDK + extensions，不 fork | 角色、工具、prompt、context、compaction hook、model routing | 改不了 loop/session/tool 内部 | 适合轻量定制，不适合深改 |
| 只 fork `packages/coding-agent` | CLI/session/tools/compaction 上层 | 依赖 `packages/agent`/`ai` 仍是 npm 版本，kernel 改不了 | **不推荐** |
| 只 fork `packages/agent` + `ai` | loop/state/provider | `coding-agent` 的 session/tools 仍是上游，集成会打架 | 只在特定 kernel patch 时考虑 |
| fork 整个 pi monorepo | 所有 packages 都可改 | 上游同步成本 | **推荐给深改** |
| patch-package / pnpm patch | 小修补 | 不适合结构性改动 | 只用于临时 hotfix |

### 为什么不能只 fork `pi-coding-agent`

`earendil-works/pi` 是 monorepo，`packages/coding-agent` 依赖同仓的：

- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-mcp`
- `@earendil-works/pi-tui`
- `@earendil-works/pi-codemode`

只 fork `coding-agent` 会得到“上层可改、kernel 不可改”的半成品；一旦要改 loop、tool execution、provider 或 session 语义，还是要 fork 其他包。直接 fork 整个 monorepo 更干净。

## 4. 推荐：platform fork + SDK-first

**fork 整个 `earendil-works/pi`（v1.3.0），新增 `packages/codeteam`，但优先用 SDK/extension 开发。**

这不是“全仓魔改”，而是：

1. **默认在 `packages/codeteam` 做**：roles、SOP、A2A、review、eval、control store。
2. **能用 extension 就在 extension 做**：权限拦截、custom tools、compaction 定制、prompt 注入、model routing。
3. **只有 SDK/extension 表达不了时才 patch kernel**：例如 permission-first tool 实现、subagent lifecycle、role-aware scheduling、session/run 语义。
4. **每个 kernel patch 都有测试、理由、上游 diff、是否可上游化标记**。

这样既有源码级自由，又不会把上游同步变成灾难。

## 5. codeteam 的改动应该放在哪

### `packages/codeteam`（默认）

- role prompt / model policy / tool allowlist
- SOP state machine / gate / risk
- A2A handoff / scheduler / CAS
- review envelope / finding / falsifier
- eval fixtures / metrics
- codeteam SQLite control store
- `createAgentSession` 工厂与 session 编排

### `packages/coding-agent`（按需）

- 暴露 `baseToolsOverride` 或 role-aware tool factory
- permission-aware tool wrapper（若 extension 层不够）
- review fresh-context 的 session 投影
- 需要改 CLI/RPC 行为时

### `packages/agent`（少改）

- subagent / role scheduling
- loop / turn / queue 语义
- 跨 session 生命周期

### `packages/ai`（尽量不改）

- DeepSeek / Moonshot / ZAI / Kimi Coding 已存在
- 只有新增 provider、修兼容性、补 model metadata 时才动

## 6. 什么时候必须 patch kernel

出现以下任一情况，并且 extension/SDK 经过 spike 证明做不到：

1. 需要在 tool 执行**之前**改变 built-in tool 的实现，而不只是 block。
2. 需要 native subagent / role lifecycle，而不是“codeteam 自己开多个 session”。
3. 需要改 session/run 的终态、resume、queue、compaction 语义。
4. 需要改 agent loop 的 turn/tool batch 顺序。
5. 需要把 codeteam 的权限模型下沉到所有工具实现的公共层。

没有这些，不要碰 kernel。

## 7. 上游同步

- pin `v1.3.0`（commit `71023aec1546d6d677a65669c5665c0927ce0dd0`）。
- `upstream` remote + `codeteam` 分支。
- `UPSTREAM.md` 记录 tag/commit/修改文件/同步日期。
- 每次同步跑上游 `./test.sh` + codeteam vitest。
- kernel patch 尽量小、独立、可回滚；能上游化的单独整理。

## 8. 最终建议

- **不要只 fork `pi-coding-agent`**；它是 monorepo 的一个 package，不是完整内核。
- **不要只靠 SDK 做“深改 kernel”**；SDK 只能改它暴露的生命周期。
- **推荐：fork 整个 pi monorepo，新增 `packages/codeteam`，SDK-first，必要处 patch kernel。**
- 如果团队短期只想验证产品，不想维护 fork：先用 SDK + extensions 做 codeteam 包，等出现第一个“SDK 表达不了”的硬需求再 fork；但这会多一次迁移。

一句话：**fork 是买“改内核的权利”，SDK-first 是“尽量不花这笔钱”。两者不冲突，组合起来才是可持续的魔改方式。**
