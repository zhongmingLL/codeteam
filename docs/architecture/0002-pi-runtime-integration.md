---
title: "codeteam × pi 运行时接入"
doc_kind: architecture
status: draft-for-review
created: 2026-10-21
updated: 2026-10-24
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
audience: [architect, implementer, reviewer]
---

# codeteam × pi 运行时接入

> 基线注记（2026-10-26）：本文的 pi 包/API/RPC 事实最初按 v1.3.0 讨论；当前基线改为 v1.4.0（`4a080252f06caf63a525d7873c5d94d3c23887e0`）。W0a spike 时以 v1.4.0 代码重新对码，行号与行为可能漂移；v1.4.0 的变化集中在 durable/chord/telemetry/model catalog，未见直接破坏 SDK/extension 的声明，但必须用 L0/session spike 实测。若 L0/session 行为不成立，回退 v1.3.0 并把差异写入 `KERNEL_GAPS.md`。

> 本文回答三个问题：
> 1. codeteam 需要多深地改 pi？
> 2. 新增 tool、A2A、memory recall、L0 system prompt 分别走哪条 surface？
> 3. `pi-coding-agent` RPC 和 clowder 的 spawn CLI 是什么关系？

---

## 1. 结论

- **codeteam 不需要为了新增 tool、A2A、memory recall 去 fork kernel。**
- 需要的是三层组合：**MCP server（共享能力）+ pi extension（per-agent harness）+ RPC/SDK（host 控制）**。
- `pi --mode rpc` 是长驻子进程 + JSONL 命令/事件协议，**不是内核 API**；它不能注册 tool，tool 必须在启动时由 extension 或 MCP 加载。
- 真正需要 fork 的只有：**进程内强制权限、session/agent loop 语义、RPC 协议、性能**；v1 可以用 sandbox + adapter 绕过。
- 当前 codeteam 采用 **fork 整个 pi monorepo + SDK-first**：`packages/codeteam` 拥有控制面，pi 拥有 agent loop / tools / session。

---

## 2. pi 的包与 surface

| 包 | 能力 | codeteam 用法 |
|---|---|---|
| `@earendil-works/pi-ai` | 统一多 provider API、模型目录、auth、streaming | DeepSeek / Kimi / GLM / Qwen 模型网关 |
| `@earendil-works/pi-agent-core` | 薄 agent loop、事件流、工具执行、`prepareRequest` / `finishTurn`、`beforeToolCall` / `afterToolCall` | 需要自定义 loop 时用；当前不直接用 |
| `@earendil-works/pi-coding-agent` | CLI/TUI/SDK/RPC、内置工具、session、compaction、skills、MCP、extensions | 主要数据面；`createAgentSession` + extensions |
| `@earendil-works/pi-durable` | durable conversation/task、child task、task graph、subagent、crash resume、documents、env | 未来 task graph / subagent 底座；experimental |
| `@earendil-works/chord` | 跨进程对象、replicated state、hot reload、RPC | 未来 console / 多 worker 实时状态 |
| `@earendil-works/pi-mcp` | 独立 MCP client，stdio/HTTP/OAuth | 自定义 MCP bridge / durable MCP bridge |
| `@earendil-works/pi-env` | 远程执行环境、SSH daemon | 未来远程 worker |
| `@earendil-works/pi-telemetry` | 遥测契约、span/metrics | eval / observability |
| `@earendil-works/pi-evals` | eval 工具 | review corpus / provider matrix |

关键差异：

- `pi-coding-agent` 更完整：skills、MCP、codemode、TUI、session、内置工具；适合 coding worker。
- `pi-durable` 更像团队底座：durable tasks、child tasks、subagents、task graph；但没有 built-in MCP，需要 bridge。
- 两者不是替代关系。当前 codeteam 用 `pi-coding-agent` SDK；未来可在 task graph 层引入 durable。

---

## 3. 集成层次

| 层 | 方式 | 能做什么 | 不能做什么 | 内核改动 |
|---|---|---|---|---|
| L0 | npm dependency + SDK | 创建 session、选模型/工具/session manager | 改 loop/session/tool 内部 | 0 |
| L1 | extension / pi package | 注册 tool、hooks、MCP、provider、context 注入 | 改 AgentSession 内部 scheduling | 0 |
| L2 | SDK / RPC host | prompt/steer/follow-up、事件流、session 管理 | 动态注册 tool（RPC） | 0 |
| L3 | `pi-durable` | durable task、child task、subagent、crash resume | 完整 coding-agent UI/skills | 0（experimental） |
| L4 | fork kernel patch | 改 loop、session 格式、tool 实现、权限层 | 上游同步成本 | 1 |

当前选择：**full fork（仓库形态）+ L1/L2（默认实现）；L4 仅在 `KERNEL_GAPS.md` 证明后**。更准确地说：

- **full fork 是仓库形态**：monorepo 锁步、可测试、保留未来 patch 权利。
- **SDK/extension-first 是开发纪律**：默认在 `packages/codeteam`、extension、MCP、SDK 层实现。
- **kernel 默认 read-only**：零 patch 是合法稳定状态；只有 `KERNEL_GAPS.md` + failing spike 证明公开 surface 做不到时才 patch。

---

## 4. RPC 是什么，不是什么

### 4.1 模式对比

| 模式 | 进程边界 | 生命周期 | 控制能力 | 自定义 tool |
|---|---|---|---|---|
| Print | 子进程 | 一次性 | 给 prompt，收最终文本 | 启动时 extension/MCP |
| JSON | 子进程 | 一次性 | 给 prompt，收 JSONL 事件 | 启动时 extension/MCP |
| RPC | 子进程 | 长驻 | prompt/steer/follow_up/abort、模型、session、fork/clone、compact、bash、事件流 | 启动时 extension/MCP；RPC 不能注册 tool |
| SDK | 同进程 | 长驻 | 直接 TypeScript API、`customTools` / `extensionFactories` | 可注入 custom tools |
| Durable | 库/同进程 | 持久 task | child task、subagent、documents、crash resume | durable `defineTool` |

### 4.2 RPC 命令集

`pi --mode rpc` 支持：

- `prompt` / `steer` / `follow_up` / `abort` / `clear_queue`
- `new_session` / `switch_session` / `fork` / `clone`
- `get_state` / `get_messages` / `get_entries` / `get_tree`
- `set_model` / `cycle_model` / `get_available_models`
- `set_thinking_level` / `compact` / `set_auto_compaction` / `set_auto_retry`
- `bash` / `abort_bash`
- `get_session_stats` / `export_html`
- `get_commands`

没有 `register_tool`。自定义 tool 必须通过：

```bash
pi --mode rpc \
  --extension /opt/codeteam/codeteam-extension.ts \
  --no-context-files
```

或安装 pi package：

```bash
pi install ./codeteam-pi-package
```

### 4.3 与 clowder spawn CLI 的关系

- 相同点：都是子进程；都有进程生命周期、stdout/stderr、session 恢复问题。
- 不同点：RPC 是**长驻、双向、JSONL 协议**；clowder 是 CLI 一次性调用 + 自己解析 NDJSON。
- RPC 提供 `agent_settled` 作为明确 idle 信号；clowder 只能从 stdout/exit/超时推断。
- RPC 仍然需要 codeteam 自己做 worker supervisor、配额、重试、回收；它不提供多 agent 调度。
- RPC 是本地特权通道；`bash` 命令可在 host 执行，不要暴露给不可信客户端。

---

## 5. 新增 tool 的五种方式

### 5.1 MCP server（共享能力首选）

独立进程，pi 通过 stdio/HTTP 连接：

```json
{
  "mcpServers": {
    "codeteam": {
      "command": "node",
      "args": ["/opt/codeteam/mcp-server.js"],
      "exposure": "direct"
    }
  }
}
```

- tool 名：`mcp__<server>__<tool>`。
- exposure：`direct` / `deferred` / `codemode` / `hidden`，默认 `codemode`。
- 适合：`a2a_send` / `handoff_*`、`workitem_*`、`artifact_*`、`memory_*`、`review_*`。
- `backlog_*` / `workflow_*`：feature/backlog 级 SOP 作用域与告示牌；`codeteam_update_workflow` / `codeteam_get_workflow_sop` 用 CAS 写入、owner-scoped 读取，只共享信息，不控制流程。
- `a2a_send` / `handoff_*` 只服务 agent↔agent；operator↔agent 聊天走 daemon 的 thread message API，不伪装成 A2A。
- 优点：跨 agent/跨 CLI 共享、语言无关、可独立沙箱。
- 缺点：多一次 IPC/HTTP；需要 token/身份；不能直接访问 pi session 内部。
- 安全：tool 参数不要带 `from` 身份；服务端从 token 派生。

### 5.2 pi extension tool（per-agent 首选）

```ts
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function createA2ASendTool(token: string) {
  return defineTool({
    name: "a2a_send",
    label: "Send A2A message",
    description: "Send a discussion message to codeteam agents. Does not transfer custody.",
    promptSnippet: "Send a discussion message to another agent",
    parameters: Type.Object({
      kind: Type.String(),
      targets: Type.Array(Type.String()),
      taskId: Type.String(),
      body: Type.String(),
      replyTo: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, args, _signal, _onUpdate, _ctx) {
      const res = await fetch("http://127.0.0.1:4100/a2a/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(args),
      });
      return {
        content: [{ type: "text", text: await res.text() }],
        details: { status: res.status },
      };
    },
  });
}

export default function codeteamExtension(config: { token: string }) {
  return (pi: ExtensionAPI) => {
    pi.registerTool(createA2ASendTool(config.token));
  };
}
```

`handoff_create` 与 claim/complete/withdraw 用同样的 extension 注册方式，但必须走 daemon 的 control-plane 校验；它们不是 `a2a_send` 的别名。

加载：

```bash
pi --mode rpc --extension /opt/codeteam/extension.ts
# 或
pi install ./codeteam-pi-package
```

> token 由 daemon 在创建 run/session 时 per-run 铸造，经 extension factory 闭包注入；不要放 `process.env`，否则同 worker 内多个 run 会共享身份。

**A2A 工具面（tool-call-first，已拍板 A）**

pi agent 只暴露两个核心 A2A 工具，避免弱模型在多个近似工具间选错：

| tool | 语义 | 关键参数 |
|---|---|---|
| `a2a_send` | 讨论/通知 | `kind`（question/answer/proposal/finding/status）、`targets`、`body`、`reply_to?` |
| `handoff_create` | 责任转移 | `kind`、`to`、`task_id`、`stage_id`、`subject`、`action_pair`、`expected_artifact`、`deadline`、`idempotency_key` |

- `a2a_send` 只写 `messages`，不改变 custody。
- `handoff_create` 由 daemon 校验方向白名单、expected artifact、deadline 与 loop guard，写 `handoffs` + `custody_events`，并生成一条可见 `Message` 外壳。
- claim/complete/withdraw 由 `handoff_*` 工具暴露；必须校验 `claimedByRunId` 与 token 身份。
- `from` 身份从 per-run token 派生，tool args 不允许声明。
- 正文里的 `@` 不参与路由；daemon 不解析它。漏调 tool 只记 `missing_a2a_tool_call`，不自动推断目标。
- tool 投递成功后，daemon 在可见消息上补 `→ @target` 标记，保证 operator 看见路由结果。

extension 还能：

- `pi.registerMcpServer(name, config)`：动态加 MCP server。
- `pi.registerProvider(name, config)`：模型/provider 路由。
- `pi.registerVirtualModel(...)`：按请求路由模型。
- `pi.on("tool_call", ...)`：阻断/改参数。
- `pi.on("tool_result", ...)`：脱敏/替换/写证据。
- `pi.on("context", ...)` / `context_with_system`：改模型上下文。
- `pi.on("before_agent_start", ...)`：替换/追加 system prompt。
- `pi.on("agent_settled", ...)`：收尾归档。
- `pi.sendUserMessage(...)` / `sendMessage(...)`：主动注入消息。
- `pi.events`：extension 间通信。

### 5.3 SDK custom tool（同进程、最强控制）

```ts
const { session } = await createAgentSession({
  cwd,
  model,
  modelRuntime,
  customTools: [myTool],
  extensionFactories: [myExtension],
  resourceLoader,
});
```

SDK 不自动加载 built-in MCP/codemode/tool_search；需要手动加：

```ts
import {
  createMcpExtension,
  createCodemodeExtension,
  createToolSearchExtension,
} from "@earendil-works/pi-coding-agent";
```

### 5.4 durable `defineTool`（团队任务型 tool）

```ts
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";

const claim = defineTool({
  name: "workitem_claim",
  description: "Claim a work item for this agent.",
  parameters: Type.Object({
    workItemId: Type.String(),
    requestId: Type.String(),
  }),
  replay: "safe", // 只有真正幂等才设 safe
  async execute(args, api, context) {
    const result = await claimWorkItem(args.workItemId, args.requestId);
    return { output: [{ type: "text", text: result.status }], details: result };
  },
});

const registry = createRegistry();
registry.install(defineExtension({ name: "codeteam-work", tools: [claim] }));
```

关键字段：

- `replay: "safe" | "unsafe"`：崩溃后是否允许重跑；默认 unsafe。
- `callers: ["model" | "tools"]`：谁能调用。
- `deferred: true`：由 `tool_search` 加载。
- `structuredOutputSchema`：嵌套调用/脚本的机器可读结果。
- `executionMode`：串行/并行。
- `outputLimits`：输出上限。

durable 没有 built-in MCP；需要 `pi-mcp` + `defineTool` 写 bridge，或用 coding-agent worker 负责 MCP。

### 5.5 Skills / prompt templates

不算 tool，但很重要：

- `SKILL.md`：按需加载的流程/知识。
- prompt template：复用输入文本。
- 适合 SOP、review checklist、角色契约。
- clowder 的 `cat-cafe-skills/*/SKILL.md` 大部分可以直接改成 pi skill。

---

## 6. L0 system prompt

### 6.1 clowder 的 L0 问题

clowder 面对多个 CLI：

- Claude 有 `--system-prompt-file`；
- Codex 有 `developer_instructions`；
- OpenCode 有 `instructions`；
- AGY / Antigravity 没有公开 native system channel，只能 prompt prepend；
- 没有 native channel 的载体，压缩后 L0 可能丢失；
- 每个 CLI 默认 prompt 不同，需要审计和 carry-over；
- home 文件 / root md 可能造成双重注入和化石身份。

### 6.2 pi 的 L0 通道

**CLI**

```bash
pi --system-prompt /opt/codeteam/prompts/coder-l0.md \
   --no-context-files
```

- `--system-prompt` 替换默认 preamble。
- `--append-system-prompt` 追加。
- `--no-context-files` 关闭 `AGENTS.md` / `CLAUDE.md` 自动加载。

实现细节：`--system-prompt` 走 `customPrompt`，替换 preamble，但保留 tools/rules/skills/cwd sections。若要整体替换，用 extension `before_agent_start`。

**SDK**

```ts
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  noContextFiles: true,
  systemPromptOverride: () => compiledL0,
  appendSystemPromptOverride: () => [],
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

**Extension**

```ts
pi.on("before_agent_start", async (event) => {
  return {
    systemPrompt: event.systemPrompt + `\n\n## Task\n${taskCapsule}`,
  };
});
```

返回 `systemPrompt` 是整体替换；要追加就拼 `event.systemPrompt`。

**Durable**

```ts
const L0 = defineExtension({
  name: "codeteam-l0",
  sections: [
    section("preamble", () => compiledL0, { tag: false }),
    section("work_item", (input) => input.read(WorkItemDoc)?.capsule),
  ],
});
```

`configure({ instructions })` 可以设置 per-conversation 指令；sections 每次 request 重新渲染。

### 6.3 压缩免疫

pi 的 `CompactionEntry` 保存 `systemMessage` checkpoint：

- 压缩时，旧 system messages 被完整 checkpoint 替代；
- summary 只替代旧对话，不替代 system prompt；
- 下次 request 用 checkpoint 作为 leading system message。

所以 L0 放在 native system prompt 后，不会因为 compaction 丢失。这正是 clowder F203 想要的效果。

> 这条是 pi 源码/文档层面的 claim，仍需要 W0/W1 spike 实证：长 session 压到 compaction 阈值，断言 L0 逐字出现在 compaction 后首个 request 的 system 里；顺手验证 section 稳定时 cache 命中。未验证前，D9 只能算 target，不算已证明。

### 6.4 双重注入

要避免：

- `AGENTS.md` / `CLAUDE.md` 自动加载；
- `APPEND_SYSTEM.md`；
- provider home 文件（`~/.codex/AGENTS.md`、`~/.gemini/GEMINI.md`）；
- 同一个 system prompt 既在 argv 又在 user message prepend。

建议：

- `noContextFiles: true` / `--no-context-files`。
- `appendSystemPromptOverride: () => []`。
- 如果需要项目约定，把它作为显式 L2 artifact 注入，而不是隐式 home 文件。
- 在 run metadata 记录 L0 revision/hash。

---

## 7. Context 注入与 memory recall

### 7.1 coding-agent

- `context`：替换发给模型的 messages。
- `context_with_system`：连 system 一起替换。
- `before_agent_start`：替换 system prompt。
- `tool_result`：捕获/脱敏 tool 输出。
- `message_end` / `agent_settled`：归档。
- `session_start`：注入 resume capsule。

### 7.2 durable

- `GenerationTask.beforeRequest`：替换 messages。
- `section()`：动态 prompt section。
- `docs`：持久状态。
- `beforeTool` / `afterTool`：tool 策略/证据。

### 7.3 Memory 形态

- 按需：MCP `memory_search` / `memory_get`。
- 自动：小 capsule（task/AC/最近决策/相关文件），不要塞整段历史。
- 证据库：SQLite FTS5 + optional embedding；provenance/revision。
- 不要把 pi session compaction 当知识库；它只是上下文压缩。

---

## 8. A2A 的两种落法

### 8.1 同一 durable Harness（in-process）

`pi-durable` 的 `subagent` 示例已经接近 A2A：

- 每个 subagent 是独立 conversation；
- `spawn` / `send` / `stop` / `status`；
- `steer` / `followUp` 投递；
- reporter task 把答案回传；
- 重启后继续，消息不重复；
- task graph 可见。

适合：一个 codeteam daemon 管所有 agent、单进程/单机。

限制：durable 没有 built-in MCP；要 MCP 就写 bridge。

### 8.2 独立 RPC workers + MCP mailbox（推荐 MVP）

```text
Agent A ── MCP a2a_send / handoff_create ──► codeteam daemon
                                      │
                                      ├── SQLite mailbox
                                      └── RPC prompt/steer/follow_up
                                                │
                                                ▼
                                            Agent B
```

- MCP server 负责 A2A/workitem/artifact/memory。
- daemon 持久化消息、lease、deadline。
- 通过 RPC 唤醒目标 agent。
- 进程隔离好；适合 N 个 worker。
- 需要 codeteam 自己写 worker supervisor。

工具入口与 extension 相同：`a2a_send` / `handoff_create`。MCP 只是跨 provider 的 transport，不改变 A2A 契约；两者命中同一 daemon API，身份都从 per-run token 派生。

### 8.3 pi-coding-agent 自带 subagent extension

- 支持 single/parallel/chain；
- 每个 subagent 是独立 pi 进程；
- agent 定义是 markdown；
- 没有 durable 状态、没有共享 memory、没有 team lease。

可以借鉴 agent 定义格式，但不要把它当团队真相层。

### 8.4 Dispatch 与 pi 内核的边界

codeteam 的 A2A 执行链是 **A2A ingress → Queue Entry → QueueProcessor → AgentRouter → routeSerial/routeParallel → invokeSingleAgent → pi kernel**。pi 接在 `invokeSingleAgent` 这一层，不接在 Queue 或 route 层：

- `routeSerial`/`routeParallel` 复用 clowder 的 A2A chain、worklist、serial/parallel 判定；不要因为换 pi 就重写路由层。
- `invokeSingleAgent` 负责 per-run token、AgentSession/profile、L0/context、skills/tool policy、cwd/prompt、pi SDK/RPC/MCP 启动；这是唯一执行内核替换点。
- pi 输出统一归一为 `AgentMessage` 流；QueueProcessor 只消费该流并写 `messages.dispatch_refs_json` + `runs`/`run_events`，不直接依赖 pi 内部事件名。
- 同一 `agentSessionId` 的后续 run 必须 sticky 到同一 worker（或显式 fresh+capsule）；dispatch 层不感知 pi session 细节，只认 session binding。

---

## 9. 内核入侵矩阵

| 需求 | 推荐实现 | 改内核？ |
|---|---|---|
| 新增 tool | MCP / extension / SDK customTools / durable defineTool | 否 |
| A2A | MCP mailbox / durable subagent | 否 |
| memory recall | MCP + context hook / durable beforeRequest | 否 |
| work item / lease | codeteam control plane / durable task | 否 |
| evidence capture | extension tool_result / agent_settled / RPC events | 否 |
| 角色工具策略 | tool_call hook + `--tools` | 否（advisory） |
| 硬隔离 | container / microVM / 低权用户 | 否（外部） |
| 模型路由 | provider extension / models.json / virtual model | 否 |
| durable resume | pi-durable | 否（experimental） |
| 改 agent loop | pi-agent-core hooks / SDK | 通常否 |
| 改 session 格式 / RPC 协议 | fork / upstream | 可能需要 |
| 进程内强制权限 | fork / upstream | 可能需要 |

### 9.1 真正需要 fork 的条件

1. 需要在 tool 执行前改变 built-in tool 的实现，而不只是 block。
2. 需要 native subagent / role lifecycle，而不是多个 session。
3. 需要改 session/run 的终态、resume、queue、compaction 语义。
4. 需要改 agent loop 的 turn/tool batch 顺序。
5. 需要把权限模型下沉到所有工具实现的公共层。

没有这些，不要碰 kernel。

---

## 10. 当前 codeteam 的接入方式

`packages/codeteam/src/adapters/pi-session.ts`：

```ts
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  appendSystemPrompt: [role.systemPrompt],
  ...(extensionFactories ? { extensionFactories } : {}),
});
```

- coder：`SessionManager.create(cwd, ...)`，持久。
- reviewer/verifier：`SessionManager.inMemory(cwd)`，fresh。
- tools 按 role allowlist。
- `customTools` / `extensionFactories` 可注入。
- 当前 role prompt 走 `appendSystemPrompt`；下一步应改为 L0 compiler + `systemPromptOverride`，并记录 L0 revision。
- `noSkills: true` 是当前隔离手段；目标态改为 role curated skills 白名单加载，不靠 pi 自动发现。
- MCP/工具身份用 per-run token，不用 per-worker env。
- 当前是 SDK 同进程形态；RPC worker 化前先定 10.2 的三条语义。

### 10.1 目标 adapter

```ts
interface CodeteamSessionOptions {
  role: Role;
  taskId: string;
  stageId: string;
  l0: string;
  tools: string[];
  customTools?: ToolDefinition[];
  extensionFactories?: ExtensionFactory[];
  session: "persistent" | "fresh";
  sandbox: SandboxProfile;
}
```

Adapter 负责：

- 解析 role/model/tool policy；
- 编译/加载 L0；
- 创建 pi session；
- 注册 codeteam custom tools；
- 注入 task capsule；
- 订阅事件并写 run_events；
- 执行 sandbox profile；
- 处理 crash/resume。

---

### 10.2 RPC worker 化决策

当前 adapter 是 SDK 同进程；目标部署是 N 个 RPC worker。迁移前必须定三条：

1. **per-run tool policy**：role-per-worker 固定 extension 白名单；`tool_call` hook 用 run token 向 control plane 查询当前 stage/risk 的 policy，不在 worker 启动时把工具集写死。禁止“所有 worker 全量工具、只靠 prompt 约束”。
2. **session 亲和**：coder 持久 session 必须 sticky 到同一个 worker；multi-task scheduler 不能把同一 `agentSessionId` 的后续 run 派到另一个 worker。若必须迁移，用 pi session export/import。
3. **re-attach**：daemon 重启后按 `agentSessionId` 找回 `piSessionId`，向对应 worker 重挂；失败则显式降级为 fresh session + task capsule 重注入，并记录 `session_reattach_failed` 事件，不能静默失忆。

这三条写进 W5 验收；在它们定完之前，不要提前做 RPC worker 迁移。

## 11. 常见坑

- **MCP 默认 `codemode`，不是 `direct`**：要模型直接调用，显式设 `exposure: "direct"` 或 `toolExposure`。
- **RPC 不能注册 tool**：必须 `--extension` / `pi install` / MCP。
- **SDK 不自动加载 built-in MCP/codemode**：要手动加 `createMcpExtension()`、`createCodemodeExtension()`、`createToolSearchExtension()`。
- **pi 没有内置 permission system**：extension `tool_call` 是 advisory；真正的隔离靠 sandbox。
- **跨 provider 不等于跨模型**：review policy 用 `modelFamily`；同一 model 换网关不算 cross-model。
- **durable 的 tool 默认 `replay: "unsafe"`**：有副作用的 tool 要做幂等/requestId。
- **durable 没有 built-in MCP**：需要 bridge。
- **RPC stdout 只放协议**：日志走 stderr；注意 JSONL 分帧、背压、`agent_settled`。
- **RPC 一个进程一个 session**：N 个 agent 就 N 个 worker，或者用 SDK/durable。
- **`--system-prompt` 不是整体替换**：它替换 preamble，保留 tools/rules/skills/cwd；整体替换用 `before_agent_start`。
- **system prompt 不要放动态时间/随机数**：会破坏 prompt cache。
- **`AGENTS.md` / `CLAUDE.md` 会自动加载**：要单源 L0 就 `--no-context-files`。
- **pi 版本要 pin**：extension API 和 durable 都在演进；业务代码不要直接依赖 pi session 类型，过 adapter。

---

## 12. 一句话

**pi 把 clowder 当年只能在 CLI 外面做的事，变成了 extension/SDK/RPC/MCP 的受支持 surface。codeteam 的接入策略是：能用 MCP 就用 MCP 共享，能用 extension 就用 extension 做 per-agent harness，宿主用 RPC/SDK 控制；只有 kernel 语义真的表达不了时才 fork。**

---

[宪宪/deepseek-flash🐾]
