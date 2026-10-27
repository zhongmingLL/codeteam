---
title: "codeteam 架构 v1 — repo-native code agent team"
doc_kind: architecture
status: draft-for-review
created: 2026-10-21
updated: 2026-10-26
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
audience: [operator, architect, implementer, reviewer]
---

# codeteam 架构 v1

> 本文是 2026-10-21 讨论的 consolidated 架构稿。它把“为什么做、系统怎么分层、对象怎么定义、pi 怎么接、安全边界在哪、下一阶段怎么走”写成一份可实施文档。
>
> **本仓 `docs/` 是 codeteam 项目的文档真相源。** 讨论历史和评审记录可在 clowder-ai thread 中追溯；文中“已落地/已证明”是讨论时点声明，开工前需要重新对码基线。本文负责给出一张完整的技术地图，并明确哪些已落地、哪些是目标态。
>
> **工作区边界：** 本仓是 codeteam 代码与契约真相源；`clowder-ai/codeteam/` 只保留迁移前的讨论历史，不再作为开发依据。

---

## 1. 定位、边界与 clowder 关系

**codeteam 是什么**

**codeteam 是一个 repo-native、headless-first、durable 的 code agent team runtime：复用 clowder 的风险车道 SOP（告示牌 + 点状硬门禁，猫保留推进权），用可替换的角色 agent 做判断，用 git worktree 和 artifact ledger 保证可恢复、可审查、可验证。**

**与 clowder-ai 的关系**

codeteam 不是另起一套团队协作模型，也不是要和 clowder-ai 区别对立。clowder-ai 本身已经是一个经过实践验证的 code team；codeteam 以它为基座，保留对代码交付有用的概念、契约和 UX，参考它的代码设计，优先复用而不是重写，以快速产品化为第一目标。

默认复用：thread、`Message`、`RichBlock`、Ball custody、`Approval Hub`、Mission Hub、Memory/Eval、Skill/SOP。只替换代码交付直接需要的层：

- role agent session 替代猫 session；
- A2A 使用 typed control plane；
- git worktree、sandbox、review/verification gate 成为一等公民。

新增差异必须说明它解决哪个代码交付问题；不能说明的，优先沿用 clowder 的既有概念，不为了“看起来更像 code agent”而重新发明。

复用优先级固定为：**默认复用 > 适配 > 新建**。默认复用概念、命名、状态机、API 契约和 UX 模式；只有代码交付需要时才适配（在原概念上加字段/约束），不另起同名新概念；确需新建时，必须写清 clowder 版本为什么不适用、影响范围和回退方案，并经 operator 确认。

判断标准再加一条：**能否让 W0–W4 dogfood 更快到 merge 完成**。能直接复用就不要自研；新建层必须证明它减少总交付时间，而不是只增加架构完整性。

codeteam 是独立 runtime。这里的“默认复用”指把 clowder 已验证的语义/schema/状态机/UX 模式移植到 codeteam 自己的 store，**不是共用 clowder 数据库**；“不另建同名概念”不等于“不建新表”。只有 W7 前端载体选 C/A 时才发生数据面连接。

`headless-first` 指运行时不依赖 UI，不等于取消 operator surface；thread chat、rich block、approval 仍是一等能力。

**保留与不做**

它只保留对“把代码做对”有直接贡献的部分：

- 开发 SOP、风险分级、阶段门禁
- 角色分工、独立 review、证据闭环
- task / stage / run / artifact / handoff 的单一真相源
- A2A 式交接走 typed control plane；operator↔agent 保留 thread 聊天框，两条通道不混用
- 可观测、可评测、可回滚

明确不做：

- 猫猫人格、家庭名册、语音、日记、signals、社交记忆
- IM 网关、群聊/社交 feed、社交/IM 用途的独立聊天产品、多租户 Hub、插件市场（thread 内 operator↔agent 聊天框保留；GitHub/GitLab forge connector 不在此列，见 §18.1）
- 让 agent 自行豁免 review 或自行认定完成；review 必要性由 risk/SOP 决定，完成由 acceptance + evidence + independent review/verification + merge receipt 决定。agent 可以声明“我完成了”、提请 review 或升级，但不能绕过 gate。
- 把任何单个 CLI 的 transcript 直接当团队真相源；transcript 只作调试/证据输入。团队真相是 control store + typed artifacts + review/verification/merge records。

这两条限制的是“自证”和“transcript 当 canonical state”，不是 agent 在 stage 内的判断，也不是 transcript 作为调试证据的价值。

---

## 2. 设计原则

### 2.1 猫保留推进权，机器只锁高风险 gate

这是 codeteam 从 clowder 继承的第一原则。SOP 是告示牌：它记录当前车道、球在谁手上、建议下一个 skill、恢复胶囊，但不推动 agent 走固定阶段。

agent 拥有流程推进权和车道内判断；机器只在高风险点强制 gate（worktree / design / 已选中的 review / merge / completion）。agent 可以提出 `spec_change` / `plan_revision`，但不能绕过已选中的硬 gate。

写在 prompt 里的流程是建议；写在 hard gate 里的约束才是机器强制。不要把每个阶段都做成必须调用的状态机节点。

### 2.2 工件是真相源，transcript 是调试材料

阶段之间传 `spec`、`plan`、`diff`、`test-report`、`review`、`verification`、`merge-receipt`，不传整段聊天记录。

直接收益：

- reviewer 拿到的是可审查的 diff 和证据，不是作者的思维链
- 上下文不会被历史 tool output 撑爆
- task 可以跨 session、跨模型、跨天恢复
- 门禁可以机器校验，而不是靠另一个模型“感觉一下”

### 2.3 Role、Model、AgentSession 三者解耦

- **Role**：职责目录 id，不是闭集枚举；内置 architect / coder / reviewer / verifier，可在前端/配置新增 writer、researcher 等自定义 role。`human` 不是 Role，是 `actorKind`。
- **Model Policy**：按 role + stage + risk 选 provider / model / model family。
- **AgentProfile**：稳定逻辑身份；承载 primary role、默认 provider/model/family、工具策略和 restrictions；一个 role 可以有多个 profile（如 reviewer-glm / reviewer-kimi）。
- **AgentSession**：某个 profile 在某个 thread/task/stage 以某个 role 的具体 pi session，绑定 provider/model、piSessionId 和运行状态。

v1 引入 `AgentProfile`，不引入 `AgentInstance`。`AgentProfile` 是稳定身份，`AgentSession` 是执行身份；不要把它们合成一个有生命周期的“实例”。

与 clowder 对齐：clowder 的“猫”是稳定注册身份（`catId` + `CatConfig`）加每次 session/invocation，并没有 `CatInstance` 实体；`CatConfig` 承载 name/displayName/provider/model/roleDescription/restrictions 等长期属性，session 承载执行。codeteam 的 `AgentProfile` 对应 `CatConfig`/`catId`，`AgentSession` 对应 cat session/invocation。review 独立性必须同时看 profile + session + modelFamily；同一 profile 换 session 不算独立。

这样 DeepSeek / Kimi / GLM / Qwen 可以换、可以降级、可以做交叉 review，而 SOP 不变。

### 2.4 A2A 是控制面，operator 聊天不是 A2A

每次交接都必须是可校验的 envelope：谁、对哪个 task/stage、期望什么 artifact、什么时候到期、失败了怎么回收。

没有“收到”“谢谢”“我看一下”这类空转消息。状态更新走事件日志，不唤醒 agent；只有需要对方行动时才产生 handoff。

本节只约束 **agent↔agent**。operator 在 thread 里对 agent 的自然语言聊天是正常通信，不走 handoff；当聊天需要 agent 行动时，daemon 把它转成 typed `inbox`（`steer | followUp | humanGuidance`）并唤醒对应 AgentSession。agent 的回复作为 `Message` 回到 thread，不伪装成 handoff。

agent↔agent 也分两层：**讨论消息**是 `Message`（由 `a2a_send` 写入；问题、回答、提案、finding、status），不产生 custody 变化；**责任转移**必须走 typed `Handoff`/`Event`，声明 subject、action、expected artifact、deadline。讨论消息不能声明完成、不能转移球权、不能替代 handoff。

**路由权威在 tool call，不在文本。** codeteam 不复刻 clowder 的行首 `@` 文本路由：agent 只能通过 `a2a_send` / `handoff_create` 等 typed tool 指定 target；正文里的 `@`、箭头、角色名都只是普通文本，不产生投递。daemon 不解析自然语言推断收件人，也不把“让 reviewer 看”当成一次隐式路由。tool 投递成功后，daemon 在可见 `Message` 上补路由标记（如 `→ @reviewer-glm`），让 operator 看见“谁被唤醒”。如果 agent 只在正文写了交接意图而没调 tool，daemon 只记录 `missing_a2a_tool_call` 观测信号，仍不自动路由。

这条只约束 **agent↔agent**。operator 的自然语言指令可以作为 trusted routing input：daemon 把它转成 typed `inbox` 并落 audit；“不解析正文”不应用来切断 M0 聊天框的 steer。

> 状态：2026-10-24 operator 已认可 A（tool-call-first），见 `plans/0005-plan-review-resolutions.md` §10 D5「A2A 路由权威」；本条进入 v1 契约。

### 2.5 单 task、单 worktree、单写者

一个 task 绑定一个 git worktree 和一个 branch。同一阶段只有一个写者 role。并行只发生在明确允许的只读/分析阶段，或由 orchestrator 显式分片。

这避免多 agent 同时改同一片代码，也避免“谁最后写谁算”。

### 2.6 Findings 由证据关闭

reviewer 可以提出 finding，但 P1/P2 必须带可执行 falsifier。verifier 执行 falsifier；证据确认则 finding 成立，证据不成立则 finding 被撤销。

review 不是“另一个模型说行不行”，而是“证据是否支持这个 claim”。

### 2.7 机器可判定的 gate，人类只保留不可逆决策

- 机器 gate：schema、路径、依赖、测试、diff、证据、review verdict
- 人类 gate：merge protected branch、删除数据、force push、改生产配置、跨 task 的 scope 决策

### 2.8 Fork-capable, SDK-first

**Fork 是仓库形态，SDK-first 是开发纪律；两者不是同一层决策，也不矛盾。**

- **仓库形态**：fork 整个 pi monorepo，保持 monorepo 版本锁步，避免只 fork `coding-agent` 造成 kernel/上层版本错位。
- **默认开发方式**：优先在 `packages/codeteam`、extension、MCP、SDK 层实现。
- **kernel 默认只读**：零 kernel patch 是完全合法的稳定状态；只有 `KERNEL_GAPS.md` 证明公开 surface 做不到时才 patch。
- **为什么 full fork**：保留未来深改权利、统一版本、方便跑上游测试；不是为了“fork 后必须改”。
- **如果短期不维护 fork**：可以先 npm dependency + extensions，等第一个 kernel gap 出现再 fork；代价是未来多一次迁移。

| 决策 | 选择 | 说明 |
|---|---|---|
| 仓库形态 | full fork | monorepo 锁步、可测试、可 patch |
| 默认写码位置 | `packages/codeteam` / extension / MCP | 尽量不碰 kernel |
| kernel 默认状态 | read-only | 零 patch 是合法状态 |
| patch 触发 | `KERNEL_GAPS.md` + failing spike | 没有证据不 patch |
| 上游同步 | `upstream` remote + pin tag | 定期 rebase + 全量测试 |

### 2.9 L0 压缩免疫，动态上下文按需注入

身份、角色契约、治理规则、客观性指令放在 native system prompt；task capsule、artifact 摘要、memory recall 放在 per-turn context。

### 2.10 可观测是默认能力，不是事后补丁

每个 task / stage / run / handoff / artifact / review finding 都有稳定 ID、时间、成本、证据和 trace 关系。失败必须能归因，不能只留下“模型没做好”。

---

## 3. 系统上下文与分层

```text
┌──────────────────────────────────────────────────────────────┐
│ Interfaces                                                    │
│ Web Console · CLI · daemon JSON events · MCP server              │
│ GitHub/GitLab webhook · ACP (later) · TUI                        │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│ Control Plane                                                 │
│ Orchestrator · SOP engine · scheduler · A2A bus · budgets     │
│ risk classifier · policy · recovery · artifact ledger         │
└──────────────────────────────┬───────────────────────────────┘
                               │ typed handoff / run commands
┌──────────────────────────────▼───────────────────────────────┐
│ Role Runtime                                                  │
│ architect · coder · reviewer · verifier · human               │
│ role prompt · tool policy · model policy · output schema      │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│ Agent Kernel                                                  │
│ pi-coding-agent SDK / RPC · pi-agent-core · pi-ai             │
│ loop · tools · events · compaction · model gateway            │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│ Tool Plane                                                    │
│ fs · patch · shell · git · rg · test · lsp                    │
│ permission wrapper · sandbox · timeout · audit · MCP bridge   │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│ State                                                         │
│ SQLite control store · pi session JSONL · git worktrees       │
│ content-addressed artifact store · append-only event log      │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│ Observability & Eval                                          │
│ run events · tool audit · token/cost · gate metrics · corpus  │
└──────────────────────────────────────────────────────────────┘
```

### 3.1 当前实现 vs 目标态

| 层 | 已落地 | 目标态 |
|---|---|---|
| Control plane | task / run / handoff；per-holder claim CAS、one terminal、deadline、loop guard、crash recovery | `backlog_items`/`workflow_sops`、artifact、inbox、review/verification、budget、multi-task scheduler |
| SOP | task/run/handoff 控制面；SOP 告示牌尚未接入 | 全面复用 clowder `WorkflowSop` + 风险车道 + 点状硬门禁；不做强制串行状态机 |
| Role runtime | coder / reviewer / verifier；architect 已有定义 | role registry（内置 4 + 自定义 writer 等）+ role-model matrix 数据化 |
| pi adapter | `createAgentSession`；coder 持久化，reviewer/verifier fresh | L0 compiler、context capsule、custom tools、MCP、RPC worker |
| Review | typed verdict、finding、falsifier、closure | 盲评、impact surface、clean-diff 负对照扩大 |
| Eval | clean/seeded corpus、FP/recall/survival | 多 provider、多 repo、真实 task outcome |
| Security | verifier strict/repro policy、worktree containment | OS sandbox / container、secret redaction、network policy |
| Interface | CLI phase3-demo、CI | Web Console、daemon JSON events、MCP server、GitHub/GitLab webhook、ACP adapter |

### 3.2 Operator Surface

Operator 不从 pi session 直接接入，而是通过 codeteam 的 control plane：

```text
Web Console ──REST/WS──┐
CLI ──────────REST/WS──┤
GitHub/GitLab ─webhook─┼──► Codeteam Daemon ──► SQLite / Artifacts
MCP client ────HTTP────┘           │
                                   ├── A2A bus / handoff
                                   └── AgentSession(threadId, taskId, role, stageId)
                                              │
                                              ▼
                                         pi session
```

- **Web Console**：first-class operator surface；只调 daemon API/WebSocket，不直接读 SQLite，不直接操作 pi session。
- **CLI**：同一套 API 的自动化入口；适合脚本、CI、远程操作。
- **GitHub/GitLab**：工作入口 + 证据源 + 交付出口，不是 IM 网关。
- **MCP**：外部 agent/tool 的接入面；身份由 token 派生，不由 tool args 声明。

### 3.3 Thread Model：直接复用 clowder，cat session → role AgentSession

Thread Model 本身不改造；沿用 clowder 的 thread 心智模型，只把“猫 session”映射成“角色 agent session”，并绑定 task/stage：

| clowder | codeteam | 说明 |
|---|---|---|
| `thread` | `Thread` | operator 看到的工作空间；持久化 |
| `cat` | `AgentProfile`（含 role） | 稳定逻辑身份；一个 role 可以有多个 profile；不再有 AgentInstance |
| `cat session` | `AgentSession` | 某个 role 在某个 thread/task/stage 的 pi session |
| `role` | `Role`（动态目录 id） | 内置 architect/coder/reviewer/verifier；前端/配置可加 writer 等自定义 role；human 是 actorKind |
| `message` | `Message`（operator↔agent + agent↔agent 讨论）/ `Event`·`Handoff`（工作转移） | 讨论用 Message；责任转移用 typed Handoff |
| `ball custody` | Ball custody（由 `Handoff` 实现） | holder / 接 / 退 / 升 / hold / wake；代码 gate 叠加在 custody 上 |
| `rich block` | `RichBlock` | 统一 kind 结构，Message 与 Artifact 都可携带 |
| Mission Hub | Mission Hub board | 当前 `WorkflowSop.stage`、持球 role、待审批；board = `BacklogItem × WorkflowSop` 投影，thread 列表是下钻 |
| `backlog item` | `BacklogItem` | SOP 作用域；feature doc 关联；task 是它下面的工作项 |
| `workflow sop` | `WorkflowSop` | feature/backlog 级告示牌：stage / baton / nextSkill / resumeCapsule / checks |
| Approval Hub | Approval Hub | design/merge/不可逆操作；Approval inbox 是它的投影 |
| memory / eval | Memory / Eval | thread recall、evidence search、session digest、task outcome、lessons、eval harness |
| skill | Skill；SOP = clowder `WorkflowSop` | 复用 clowder `SKILL.md`；SOP 不另造一套 |

Thread 内有两类消息，不混用：

- **Message**：operator↔agent 以及 agent↔agent 的讨论消息，允许自然语言和 RichBlock；可带 `kind`（question/answer/proposal/finding/status）；可以触发 `inbox`，但它本身不是交付真相，不转移 custody。
- **Handoff / Event**：agent↔agent 的 typed 控制消息，必须有 subject、action、expected artifact、deadline/terminal 语义；不接受“收到/谢谢”这类空转，也不能用讨论消息替代。

`Message` 直接沿用 clowder `message` 概念；不为“code agent”另造一套聊天模型。

**SOP 作用域直接复用 clowder：** `BacklogItem` + feature doc 是 feature/backlog 级作用域；`WorkflowSop` 是挂在其上的告示牌（stage / baton / resumeCapsule / checks）。`Task` 只是 backlog item 下的工作项；task 完成不等于 feature completion。SOP 推进权留给猫，硬门禁只在 worktree/design/review/merge/completion 等高风险点。

```ts
interface Thread {
  id: string;
  title: string;
  repo: string;            // v1 用 repo；Project 后置
  backlogItemId?: string;  // SOP 作用域
  taskIds: string[];       // 通常一个 active task
  activeTaskId?: string;
  createdAt: number;
}

interface Message {
  id: string;
  threadId: string;
  taskId?: string;
  authorKind: "operator" | "agent" | "system";
  authorId: string;        // operator id 或 agentSessionId
  kind: "chat" | "question" | "answer" | "proposal" | "finding" | "status" | "handoff" | "verdict" | "approval_request" | "approval_pointer" | "backlog_kickoff" | "agent_response" | "system"; // kind 值域变更必须同步 §12.2
  body: string;
  richBlocks?: RichBlock[]; // 复用 clowder rich block 结构；v1 至少支持一个
  replyTo?: string;
  controlRef?: string;     // 可选：handoff/review/approval 的 typed 记录 id
  createdAt: number;
}

interface AgentProfile {
  id: string;
  role: Role;              // primary role；一个 role 可有多个 profile
  displayName: string;
  provider: string;
  model: string;
  modelFamily: string;
  toolPolicyProfile: string;
  restrictions?: string[];
  status: "active" | "disabled";
  createdAt: number;
  updatedAt: number;
}

interface AgentSession {
  id: string;
  threadId: string;
  taskId: string;
  profileId: string;       // 稳定逻辑身份；同一 profile 的 session 仍算同一 agent
  role: Role;              // 本次 session 使用的 role；可不同于 profile primary role
  stageId: string;         // 指向纯快照 Stage；Run 也绑 stageId
  piSessionId: string;
  provider: string;
  model: string;
  modelFamily: string;     // deepseek / glm / kimi / qwen / claude / gpt / gemini
  status: "idle" | "running" | "blocked" | "closed";
}
```

`RichBlock` 直接复用 clowder 的 `{ id, kind, v }` 结构；codeteam 只增加代码相关 kind（diff/test/review/approval），不另造 Chat block / Artifact card 两套类型。

#### 复用优先级（单一入口）

复用分档统一以 `reuse/REUSE-MATRIX.md` 为单一入口；本文件不再维护第二套 P0/P1/P2/Drop 表。Round 2/3 的“直接复用/代码侧适配”语义保留为原则：默认复用 > 适配 > 新建；新建必须说明 clowder 版本为什么不适用、影响范围和回退方案，并经 operator 确认。

原则：

- **Thread 是 operator 的工作视图，Task/Artifact 是真相源。**
- 一个 thread 可以有多轮 task、多个 role session；UI 看到 thread，底层状态仍是 task/stage/run/handoff。
- 一个 AgentSession 必须同时绑定 `profileId + threadId + taskId + role + stageId`，避免“同一个 thread 里谁的 session 做了什么”变成猜测。
- **Thread 持久化**：W1 建 `threads` + `agent_profiles` + `agent_sessions`，`Task.threadId`；否则 Console 只能自建第二真相源。
- thread 可以来自 operator 创建、GitHub issue/PR（经 backlog dispatch）、或外部 MCP 请求。

### 3.4 Web Console：M0 / M1

Web Console 是 first-class operator surface，但分两档，避免“first-class”变成一次性大工程。

| 能力 | Console M0 | Console M1 |
|---|---|---|
| Thread 列表 / 详情（Mission Hub 下钻） | ✅ | ✅ |
| 时间线：handoff / run / artifact / gate | ✅ | ✅ |
| Mission Hub board（BacklogItem × WorkflowSop） | ✅（只读） | ✅ |
| 当前 `WorkflowSop.stage` / 持球 role | ✅ | ✅ |
| Diff viewer | ✅ | ✅ |
| Test / CI / review verdict / findings | ✅ | ✅ |
| **Thread chat（operator↔agent）** | ✅ | ✅ |
| **Approval / merge 操作** | ✅（唯一不可逆写操作） | ✅ |
| 创建 thread/task | ❌ | ✅ |
| 修改 role/model/budget/sandbox | ❌ | ✅ |
| Retry / cancel / rollback | ❌ | ✅ |
| GitHub issue/PR 链接管理 | 只读 | ✅ |
| Memory / eval dashboard | ❌ | ✅ |

- **M0 = 看 + 聊 + 批**：operator 能看 thread、diff、证据，能在 thread 聊天框里直接和当前 agent 对话，能做 design 审批 / merge 状态与硬门审批。
- **M1 = 建 + 配 + 控**：创建任务、改配置、重试/取消、GitHub 管理。
- M0 随 W7 交付；W1 必须先落 thread/agent_session schema，否则 Console 没有真实数据源。
- **前端载体（已定，前提：Hub 承载 spike 通过）**：dogfood 期选 C——codeteam daemon 实现 clowder Hub 兼容子集，接入现成 Hub；产品期选 A——同构契约 + 复用/fork Hub 组件。B 自建 Console 必须书面论证。W7a（headless API/鉴权/事件重放/CLI）可前置，W7b（前端壳）后置。
- 明确不做：猫猫人格、语音、社交 feed、IM 网关、独立聊天客户端。保留 thread 内 operator↔agent 聊天框；Web Console 仍是“工作驾驶舱”，不做群聊室。

---

## 4. 领域模型

### 4.1 对象关系

```text
AgentProfile 1 ── N AgentSession 1 ── N Run

Thread 1
  ├── N Message
  ├── N Task 1 ── N Stage 1 ── N Run 1 ── N RunEvent
  │                 │                       │
  │                 ├── N Artifact          └── N ToolAudit
  │                 ├── N Handoff
  │                 ├── N InboxItem
  │                 └── N Review 1 ── N Finding 1 ── N Verification
  └── N AgentSession 1 ── N Run
```

`Thread` 是 operator 视图；`Message` 是 operator↔agent 的聊天记录；`Task/Stage/Run/Artifact` 是交付真相；`AgentProfile` 是稳定逻辑身份，`AgentSession` 是具体执行身份。

### 4.2 核心类型

```ts
type Role = string; // 动态 role id；内置 + 自定义
const BUILTIN_ROLES = ["architect", "coder", "reviewer", "verifier"] as const;
type BuiltinRole = (typeof BUILTIN_ROLES)[number];
type ActorKind = "operator" | "agent" | "system"; // human 不是 Role

// clowder SOP 告示牌车道：feature/backlog 级，不是强制串行状态机
type SopStage =
  | "kickoff"
  | "impl"
  | "quality_gate"
  | "fresh_context"
  | "review"
  | "merge"
  | "completion";

// task/run 执行车道：SOP stage 的子集；verify 是 gate，不是 lane
type RunLane = "impl" | "quality_gate" | "fresh_context" | "review" | "merge";

type CheckStatus = "attested" | "verified" | "unknown";

interface ResumeCapsule {
  goal: string;
  done: string[];
  currentFocus: string;
}

interface SopChecks {
  remoteMainSynced: CheckStatus;
  qualityGatePassed: CheckStatus;
  reviewApproved: CheckStatus;
  visionGuardDone: CheckStatus;
}

interface BacklogItem {
  // minimal projection; W1 reuses the full clowder BacklogItem shape (suggestion/lease/audit/...)
  id: string;
  userId: string;
  projectId?: string;
  title: string;
  summary: string;
  priority: "p0" | "p1" | "p2" | "p3";
  tags: string[];          // 至少含 feature:<id>
  status: "open" | "suggested" | "approved" | "dispatched" | "done";
  dispatchedThreadId?: string;
  pendingThreadId?: string;
  createdAt: number;
  updatedAt: number;
}

interface WorkflowSop {
  featureId: string;
  backlogItemId: string;
  sopDefinitionId: "development";
  stage: SopStage;
  batonHolder: string;
  nextSkill: string | null;
  resumeCapsule: ResumeCapsule;
  checks: SopChecks;
  version: number;
  updatedAt: number;
  updatedBy: string;
}

type TaskStatus = "todo" | "doing" | "blocked" | "done";
type RunStatus = "running" | "completed" | "canceled" | "interrupted" | "failed";
type HandoffStatus = "pending" | "claimed" | "consumed" | "withdrawn" | "expired";

interface Thread {
  id: string;
  title: string;
  repo: string;
  taskIds: string[];
  activeTaskId?: string;
  createdAt: number;
}

interface QueueEntry {
  id: string;
  threadId: string;
  sourceId: string;
  sourceRecordId: string;
  sourceKind: ActorKind | "connector";
  targets: string[];       // 仍待投递的 profile/session；多目标不拆行
  authorIntentByTarget?: Record<string, "guide" | "interrupt" | "next_work">;
  priority: "urgent" | "normal";
  sourceCategory?: string;
  orderKey?: string;
  revision: number;
  fenceRefs: Array<{ kind: "wait" | "action_lease" | "deployment_wait"; ownerRef: string }>;
  status: "queued" | "claimed" | "processing" | "terminal" | "withdrawn";
  claimId?: string;
  claimOwnerRunId?: string;
  claimExpiresAt?: number;
  enqueuedAt: number;
  updatedAt: number;
}

interface Task {
  // clowder TaskItem base（复用）
  id: string;
  kind: "work" | "pr_tracking" | "issue_tracking";
  threadId: string;
  subjectKey: string | null;
  title: string;
  why: string;
  ownerCatId?: string;
  status: TaskStatus;
  createdBy: "operator" | "agent" | "system";
  userId?: string;
  sourceMessageId?: string;
  sourceSummaryId?: string;
  relatedFeatureId?: string;
  detectedFeatureIds?: string[];
  dispatchGate?: unknown;
  probe?: unknown;
  resolveMode?: "completes" | "bounces_back";
  entrustedWork?: unknown;
  deploymentWait?: unknown;
  automationState?: unknown;
  createdAt: number;
  updatedAt: number;

  // code-delivery extension（codeteam-specific）
  backlogItemId: string;   // SOP 作用域
  repo: string;
  baseRef: string;
  baseSha: string;
  worktree: string;
  branch: string;
  risk: "low" | "medium" | "high" | "critical"; // assuranceLevel
  riskAxes: ("behavior" | "data" | "security" | "contract" | "irreversible")[];
  disposition?: "canceled" | "abandoned"; // 与进度正交；不是 TaskStatus 值
  lane: RunLane;           // 执行车道快照；SOP 告示牌是 WorkflowSop.stage
  budget: Budget;
}

interface Stage {
  // 纯快照：只记录某次 run 在哪个 lane、是否通过；不含 entry/exit/criteria/attempt。
  id: string;
  taskId: string;
  lane: RunLane;
  status: "active" | "passed";
  startedAt: number;
  endedAt?: number;
}

interface AgentSession {
  id: string;
  threadId: string;
  taskId: string;
  profileId: string;       // 稳定身份；同一 profile 换 role/session 仍算同一 agent
  role: Role;
  stageId: string;         // 指向纯快照 Stage；不是 SOP 控制器
  piSessionId: string;
  provider: string;
  model: string;
  modelFamily: string;
  status: "idle" | "running" | "blocked" | "closed";
}

interface Run {
  id: string;
  taskId: string;
  queueEntryId: string;    // 从 ADR-043/F117 Queue Entry claim 而来（F122 为历史文档）
  stageId: string;         // 指向纯快照 Stage
  attempt: number;
  role: Role;
  agentSessionId: string;
  provider: string;
  model: string;
  modelFamily: string;
  status: RunStatus;
  handoffId?: string;
  startedAt: number;
  terminalAt?: number;
  usage?: Usage;
}

interface RunEvent {
  id: string;
  runId: string;
  seq: number;
  kind:
    | "message"
    | "tool_call"
    | "tool_result"
    | "gate"
    | "handoff"
    | "review"
    | "verification"
    | "error";
  payload: unknown;
  ts: number;
}

`RunEvent.kind="message"` 表示 run 内部的 agent/control 事件；operator 聊天不进 run_events，统一落 `messages`。

interface Artifact {
  id: string;
  taskId: string;
  runId?: string;
  kind:
    | "spec"
    | "plan"
    | "diff"
    | "test-report"
    | "review"
    | "verification"
    | "merge-receipt"
    | "log";
  sha256: string;
  path: string;
  mediaType: string;
  bytes: number;
  provenance: {
    producedByRunId?: string;
    command?: string;
    baseSha?: string;
    headSha?: string;
  };
  createdAt: number;
}

interface Handoff {
  id: string;
  taskId: string;
  stageId: string;
  kind:
    | "handoff"
    | "review_request"
    | "verdict"
    | "blocker"
    | "spec_change"
    | "plan_revision"
    | "question";
  fromRole: Role;
  toRole: Role;
  status: HandoffStatus;
  subject: string;
  actionPair: string;
  expectedArtifact: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  replyTo?: string;
  deadline: number;
  attempt: number;
  claimedByRunId?: string;
  claimedAt?: number;
  terminalAt?: number;
  result?: Record<string, unknown>;
}

interface InboxItem {
  id: string;
  taskId: string;
  runId?: string;
  kind: "steer" | "followUp" | "humanGuidance";
  payload: Record<string, unknown>;
  status: "pending" | "consumed" | "expired";
  createdAt: number;
  consumedAt?: number;
}

interface Review {
  id: string;
  taskId: string;
  runId: string;
  headSha: string;
  authorSessionId: string;
  reviewerSessionId: string;
  reviewerModelFamily: string;
  reviewMode: "cross_family" | "same_family_fresh";
  verdict: "approve" | "changes_requested" | "blocked";
  findings: Finding[];
  createdAt: number;
}

interface Finding {
  severity: "P1" | "P2" | "P3";
  file?: string;
  line?: number;
  claim: string;
  evidenceKind:
    | "red_test"
    | "repro_command"
    | "static_check"
    | "code_reading"
    | "judgment";
  falsifier: string;
  falsifierExpected?: "zero" | "nonzero";
  requiredAction: string;
}

interface Verification {
  findingIndex: number;
  headSha: string;
  producingReviewId: string;
  status: "confirmed" | "rejected" | "blocked";
  reason: string;
  command?: string;
  cwd?: string;
  exitCode?: number;
  durationMs?: number;
  stdoutTail?: string;
  stderrTail?: string;
}
```

### 4.3 不变量

1. 一个 task 同时最多一个 active writer run。
2. 一个 handoff 的 claim 是 per-holder：single mode 只有一个 claim；parallel 每个 holder 各自 claim。非 holder run 返回 `safe_wait`；同一 holder 的不同 run 返回 `safe_wait`；expired/consumed 后旧 claim 不得再 complete。
3. 一个 run / handoff 只有一个 terminal；重复 terminal 返回已提交结果。
4. handoff 必须声明 `expectedArtifact`，否则不唤醒接收者。
5. handoff / run 状态迁移只能通过 control plane；非法迁移拒绝。SOP `stage` 是告示牌，不做强制迁移。
6. artifact 不可变；新版本产生新 artifact id。
7. reviewer `agentSessionId` 必须不同于 author；代码 review 还要求 `modelFamily` 不同。低风险文档允许同族非作者，但必须标记 `reviewMode: "same_family_fresh"`。
8. P1/P2 finding 必须带可执行 falsifier；否则自动降级 P3。
9. finding 只由 verifier 证据关闭，不由 reviewer 再审关闭。
10. task `done` 必须有 merge receipt 或人类验收记录。
11. routine own-PR merge 走 merge gate + merge owner；push/删除数据/force push/第三方 merge 等不可逆操作必须走 human/policy gate。
12. pi session 是 transcript，不是 task/artifact/handoff 的真相源。
13. 一个 thread 可以有多个 task；v1 约定通常一个 active task，任务与 thread 通过 `Task.threadId` 绑定。
14. review / verification 必须绑定 `headSha`；head 变化即作废，必须重跑。
15. audit 只追加；SQLite 层用 trigger 拒绝 UPDATE/DELETE。

### 4.4 clowder 执行真相 → codeteam 扩展

codeteam 没有第二套执行真相。`Task` / `Run` / `Handoff` / `Artifact` 是 clowder 执行原语的**代码交付扩展**：

| clowder 原语 | codeteam | 关系 | codeteam 新增 | 复用/不新增 |
|---|---|---|---|---|
| `TaskItem`（`task.ts:190`） | `Task` | 扩展 | `backlogItemId` + `repo` / `baseRef` / `baseSha` / `worktree` / `branch` / `risk` / `riskAxes` / `budget` | kind/subjectKey/title/why/owner/status/relatedFeatureId/dispatchGate/entrustedWork/probe/deploymentWait 复用 clowder 语义 |
| `LifecycleQueueEntry` + `LifecycleActiveRun`（`message-lifecycle.ts:380`）+ `LifecycleResponseBubble`（`:363`） | `Run` | 执行终态 durable 超集；pre-claim wake 在 `queue_entries`，QueueEntry 不是 Run 的一部分 | `role`、`agentSessionId`、`provider/model/family`、`l0_revision`、`handoffId`、`usage` | one terminal、cancel/interrupt、queue/dispatch 语义复用 |
| `ActionSuccessorMetadata`（`action-successor.ts:221`）+ `BallCustodyEvent`（`ball-custody.ts`）+ `waits` | `Handoff` | 代码交付 typed envelope | `expectedArtifact`、`actionPair`、`fromRole/toRole`、`deadline` | custody / claim / terminal / lease / wait 语义复用 |
| `ThreadArtifactDTO`（`thread-artifact.ts:14`）/ `RichBlock` | `Artifact` | 视图 vs 证据账本 | `sha256`、`path`、`mediaType`、`provenance`、kind=`spec/plan/diff/test-report/review/verification/merge-receipt` | operator 可见性复用 ThreadArtifactDTO/RichBlock；Artifact 账本不替代 Message/Attachment |
| `Message`（`message.ts:98`） | `Message` | 直接复用 | — | 不另造聊天层 |
| `BacklogItem`（`backlog.ts:59`） | `BacklogItem` | 直接复用 | — | 不另造 feature/backlog |
| `WorkflowSop`（`workflow-sop.ts:23`） | `WorkflowSop` | 直接复用 | — | 不另造 SOP 告示牌 |
| ADR-043 / F117 Phase D Dispatch Queue Entry | `QueueEntry` | 直接复用契约 | — | 唯一 pending-wake 账本；`handoff`/`inbox` 只是来源/投影，不另造队列（F122 为历史文档） |
| F139 `TaskSpec_P1` + `RunLedger` | `ScheduleTask` / `ScheduleRun` | 直接复用语义 | 代码域 trigger/admission adapter | 只用于主动 schedule；不替代 dispatch queue |
| Approval / Wait | Approval / Wait | 直接复用 | 代码交付 gate 的 approval kind | 不另造审批/等待 |

判定规则：

1. 每个 codeteam 字段必须能映射到 clowder 原语，或明确标为 `code-delivery-specific`。
2. 不能映射、也不能说明代码交付必要性的字段，删除。
3. 不允许出现两套 queue/dispatch、两套 custody、两套 approval、两套 message、两套 SOP。
4. `Run` 是 `LifecycleActiveRun` + `LifecycleResponseBubble` 的 durable 超集，不是第二个调度器。
5. `Artifact` 是证据账本，不是 thread artifact 视图的替代；两者通过 `sourceMessageId` / `artifactRef` 关联。
6. 唯一 pending-wake 真相 = ADR-043/F117 Phase D Dispatch Queue Entry（F122 为历史文档）；operator/agent/connector 都产生同一种 Queue Entry。`handoff(pending)`/`inbox(pending)` 是 entry 的来源/投影，不是两个队列；`Run` 是执行终态超集，不是第三队列。

W7a 必须提供 **artifact → ThreadArtifactDTO 投影契约**：`spec/plan/diff/test-report/review/verification/merge-receipt` 映射到 Hub 可见 type（默认 `code`/`file`；新增枚举需 operator 定）；每个 evidence artifact 的 `provenance_json` 至少含 `sourceMessageId`；声明“账本权威、视图只读”，不能让 Hub 面板反向成为 review/merge 真相源。

### 4.4.1 A2A 执行链（dispatch 灵魂链）

dispatch 的复用对象不是一张 Queue 表，而是整条执行链：

| 段 | clowder | codeteam | 处置 |
|---|---|---|---|
| 1 A2A ingress | `post_message`/`cross_post_message`/`multi_mention` → `InvocationQueue.send` | `a2a_send`/`handoff_create`/多 recipient → `QueueService.admit` | 语义复用；工具/recipient 形状适配 |
| 2 Admission | `QueueLedgerEntry` | `queue_entries` | Redis→SQLite |
| 3 Drain/claim | `InvocationQueue`/`QueueProcessor` | `QueueWorker`/`Dispatcher` | SQLite claim/CAS |
| 4 Route strategy | `AgentRouter.routeExecution` | `RoutingService` | queue 多 recipient 恒 parallel；`ideate` 只作直调兜底 |
| 5 Serial route | `routeSerial` + `WorklistRegistry` | `runSerial` | 编排复用；chain metadata 持久化 |
| 6 Parallel route | `routeParallel` | `runParallel` | 编排复用 |
| 7 Single execution | `invokeSingleCat` | `invokeSingleAgent` → pi kernel | **唯一执行内核替换点** |
| 8 Child lifecycle | `TurnExecutionRecord` + `InvocationRecord` | `runs`/`run_events` + `parent_run_id` | 适配 |
| 9 Delivery | `MessageStore.dispatchRefs[]` | `messages.dispatch_refs_json` | 适配 |
| 10 Recovery/control | `StartupReconciler`/`InvocationOwnerReaper`/Steer/halt | SQLite recovery + liveness | 适配 |

边界：第 1–6、8–10 段是 provider 无关的编排语义，**复用**；第 7 段 `invokeSingleCat → invokeSingleAgent` 是唯一需要替换执行内核的地方。`routeIntent` 只接受 typed tool 字段，不解析正文 `#ideate`/`@`（D23）。`WorklistRegistry` 的 `a2aCount/maxDepth/streakPair` 持久化到 `runs.chain_metadata_json`，重启不清零。

W1 必须在继承矩阵里钉死的差异：

- `TaskStatus`：已收敛为 clowder `todo/doing/blocked/done` + `disposition(canceled/abandoned)`；`running` 映射 `doing`，不新增进度枚举。
- `Task.ownerCatId` vs `AgentProfile`/`role`：owner 是稳定身份（profile）还是本次执行角色（role），必须明确。
- `Run` vs `LifecycleActiveRun`：`Run` 是 durable 超集，禁止再建第二套 queue/active-run。
- `Handoff` vs action lease + ball custody：`pending/claimed/consumed/withdrawn/expired` 要映射到 clowder 的 claim/terminal/wait 语义，不另造 custody 账本。
- `Artifact` vs `ThreadArtifactDTO`：一个是证据账本，一个是 operator 视图；不能让 thread artifact 面板成为 review/merge 的真相源。
- `TaskProbeSpec`：`http_get` 复用；`redis_exists` drop/replace（codeteam 不引入 Redis）。
- `ThreadPhase`：按已签 A2-1 `sop-bulletin` 卡复用 clowder
  `coding/research/brainstorm`，同时写 `threads.phase` 与
  `backlog_items.dispatched_thread_phase`；它是 dispatch/UI phase，不是
  `tasks.lane` 代码车道，也不触发 gate。
- `SopChecks`：每项映射到点状 gate 的 `verified` / `attested` 来源，避免成为自报字段。
- Run 权限：允许 `approval_request`（只创建 proposal），不允许 `approval:decide`；routine merge 只能走 daemon `merge:execute`（`DP-MERGE-1=D`，无 MCP/REST 暴露），不开放任意 `merge:record`。
- `custody_events`：状态真相在 `handoffs`；重放必须与 handoffs 对账，偏差告警。
- `BacklogItem.dispatchedThreadId` / `kickoffMessageId`：optional，避免实现第二条建 thread 通路。
- operator steer：daemon 不解析 agent 正文；operator 自然语言可作为 trusted routing input 并落 audit。
- lease 命名：`itemLease`（backlog item）与 `workerLease`（worker heartbeat）分开，避免混淆。

### 4.4.2 W1 字段继承矩阵（入场门禁）

> **状态（2026-10-28）**：W1 entry-gate 初稿，等待非作者 review。矩阵未过
> review、五处关键差异未确认前，不开始建表。
>
> **判定口径**：`reused` = 语义/契约来自 clowder 原语，允许改列名、改
> store/transport；`code-delivery-specific` = 只为代码交付新增，必须写清
> 为什么 clowder 原语不够。没有来源、也说不清代码交付必要性的字段删除。
>
> **源锚点**使用 clowder 仓内相对路径；不把本地参考 checkout 路径、凭据或
> 运行时部署假设写进产品文档。

#### 4.4.2.1 判定口径与边界

1. 每个 codeteam 字段必须落到 `reused` 或 `code-delivery-specific`；不允
   许“看起来像 clowder”但没有语义来源的字段。
2. 不允许第二套 queue/dispatch、custody、approval、message、SOP。唯一
   pending-wake 仍是 `queue_entries`；唯一 custody 状态真相仍是
   `handoffs`；审批唯一真相仍是 `approvals`。
3. `AgentProfile` 是稳定逻辑身份，`AgentSession` 是执行身份；`role` 不是
   身份。`clowder_cat_id` 只作 provenance，不参与唯一性/授权。
4. 执行真相与视图分离：`artifacts` 是证据账本，`ThreadArtifactDTO` 是只
   读投影；`runs` 是执行终态，`LifecycleActiveRun` 是 live 视图；`messages`
   是聊天正文，`run_events` 是调试/事件流。
5. 代码交付字段必须能说明“为什么 clowder 原语不够”，否则不进入 W1。

#### 4.4.2.2 D-W1-1：TaskStatus

| codeteam | clowder 源 | 处置 | 差异 / 理由 |
|---|---|---|---|
| `tasks.status` | `TaskStatus`：`todo / doing / blocked / done`（`packages/shared/src/types/task.ts:26`） | reused | 四值原样复用；`running` 映射 `doing`，不新增进度枚举 |
| `tasks.disposition` | 无同名 TaskItem 字段；终止语义参考 `BallEuthanasiaKind`（`packages/shared/src/types/ball-custody.ts`） | code-delivery-specific | `canceled / abandoned` 是终止处置，不是第五个进度状态；`status=done` 表示关闭，`disposition` 解释关闭方式 |

规则：

- `status=done` 且 `disposition IS NULL` = 正常完成；正常完成仍必须有
  merge receipt 或人类验收记录。
- `status=done` 且 `disposition IN (canceled, abandoned)` = 非正常关闭；
  必须有 decision/audit，不能伪装成正常完成。
- `disposition` 非空时 `status` 必须是 `done`；`disposition` 不能和
  `todo/doing/blocked` 并存。
- 不引入 `running` / `cancelled` 双枚举；`doing` 覆盖进行中，取消/放弃
  走 `disposition`。
- clowder 的 `frozen / degraded / abandoned` 球权终止语义不复用到
  `TaskStatus`；`frozen/degraded` 不是 codeteam task 的终止态。

#### 4.4.2.3 D-W1-2：Task.ownerCatId

| codeteam | clowder 源 | 处置 | 差异 / 理由 |
|---|---|---|---|
| `tasks.owner_profile_id` | `TaskItem.ownerCatId`（`task.ts:203`）的稳定身份语义 | reused | owner 是稳定逻辑身份；codeteam 用 `AgentProfile.id`，不是 catId、role 或 session |
| `tasks.created_by` | `TaskItem.createdBy`（`CatId / 'user' / 'system'`） | reused | 单列保留 typed actor；`system` 仅 W8/forge inbound 初始 admission，后续 approve/dispatch 仍走 operator；不拆成第二套 actor 表 |
| `agent_profiles.clowder_cat_id` | clowder catId（`CatId`） | reused（仅 provenance） | 可重复、不唯一、不参与授权；profile 与 cat 不是 1:1 |
| `tasks.owner_profile_id` 的 role/session 关系 | `AgentProfile.role` / `AgentSession.role` | code-delivery-specific 边界 | role 是本次执行角色，session 是执行身份；换 role/session 不改变 owner；不存在 `owner_role` / `owner_session` 列 |

规则：

- `owner_profile_id` 可空；空表示无主 task，不伪造 owner。
- 同一 profile 换 session 仍是同一 owner；review 独立性看
  profile + session + modelFamily，不看 owner/role。
- `owner_profile_id` 外键指向 `agent_profiles(id)`；`clowder_cat_id` 不建
  唯一索引，也不用于权限判断。
- `created_by` 的 `system` variant 不是 owner；它只记录 inbound/import 的 actor
  来源，避免把 forge 事件伪装成 operator。

#### 4.4.2.4 D-W1-3：Run vs LifecycleActiveRun / ResponseBubble

`runs` 是 `LifecycleActiveRun` + `LifecycleResponseBubble` 的 durable 执行
终态超集；不建 `active_runs`、`run_inputs` 或第二套 response 表。

| codeteam `runs` 字段 | clowder 源 | 处置 | 差异 / 理由 |
|---|---|---|---|
| `id` | `LifecycleActiveRun.invocationId`（`message-lifecycle.ts:380`） | reused | run id 即 invocation id，保持 child lineage |
| `task_id` | 无 ActiveRun 字段 | code-delivery-specific | 代码交付 run 必须绑定 task；thread 关系经 task/session 解析 |
| `queue_entry_id` | `LifecycleActiveRun.inputEntryIds[]` | reused（v1 单输入） | v1 一个 run claim 一个 queue entry；不复制 `inputMessageIds[]`；append-to-active-run 不在 W1 |
| `stage_id` | 无 ActiveRun 字段 | code-delivery-specific | 指向 `stages` 纯快照；不是 gate 控制器 |
| `attempt` | 无同名字段；retry 语义 | code-delivery-specific | 重试计数；run terminal 不复活，重试新建 run |
| `role` | 执行角色 | reused | role 是本次执行角色，不是 owner |
| `agent_session_id` | `LifecycleActiveRun` 的 invocation/session 语义 | reused | 只经 `agent_sessions` join，不直连 pi session |
| `parent_run_id` | parent invocation（`InvocationRecord`） | reused | A2A child lineage |
| `source_id` | source message/entry identity | reused | 与 `queue_entries.source_id` 对齐 |
| `recipient_profile_id` | `LifecycleActiveRun.targetId` | reused | catId → profile id；多 recipient 各自 run |
| `chain_metadata_json` | `WorklistRegistry` 的 `a2aCount/maxDepth/streakPair` | reused | 持久化链深/乒乓计数；重启不清零 |
| `provider` / `model` / `model_family` | provider/model 执行快照 | reused | 用于 review 独立性与审计 |
| `l0_revision` | 无 clowder 字段 | code-delivery-specific | L0 compiler 版本；压缩免疫证据锚 |
| `status` | `LifecycleResponseBubble.status` + ActiveRun terminal | reused | `processing→running`；`completed/failed/canceled/interrupted` 原样；one terminal |
| `response_message_id` | `LifecycleResponseBubble.id` | reused | 一个 run 一个 response；partial unique |
| `execution_kind` | 无 clowder 字段 | code-delivery-specific | `ordinary / routing_guard`；W7 标“系统辅助” |
| `handoff_id` / `approval_id` | 无 ActiveRun 字段 | code-delivery-specific | typed control 关联；不替代 handoff/approval 真相 |
| `started_at` / `terminal_at` | `LifecycleActiveRun.startedAt` / `ResponseBubble.completedAt` | reused | terminal 时间；interrupted 也落 terminal |
| `usage_json` | provider usage snapshot | reused | token/cost 用量；不是 budget 真相 |

明确不复制到 `runs` 的字段：

- `LifecycleActiveRun.threadId`：不存 `runs.thread_id`；经 `tasks.thread_id`
  或 `agent_sessions.thread_id` 解析。W1 contract test 必须锁
  `tasks.thread_id == agent_sessions.thread_id`，避免双真相。
- `LifecycleActiveRun.inputMessageIds[]` / `privateInputEntryIds[]`：不复制；
  source 由 `queue_entry_id` 指向的 entry 及其 message 解析；private input
  走 `inbox` typed `humanGuidance`，不造第二输入表。
- `LifecycleResponseBubble.body`：落 `messages` response body；run 不存正文。
- `LifecycleResponseBubble.dispatchRefs`：落 `messages.dispatch_refs_json`；
  run 不存第二份 delivery refs。
- `LifecycleResponseBubble.latestInputTimelineOrderAt` / `reason`：v1 不存；
  需要诊断时从 `run_events` 读；append 能力未进 W1。

规则：

- `runs` 的 `(source_id, recipient_profile_id) WHERE status='running'` 建
  partial unique index；违例是 bug，不是可重试状态。
- `response_message_id` 是 response bubble 唯一身份；`messages.kind='agent_response'`
  与 `runs` INSERT 同事务；orphan response 由 health 告警。
- `RunStatus` 只允许 `running / completed / canceled / interrupted / failed`；
  `canceled` 是 operator 控制终态，`interrupted` 只由 recovery/lease 合成。

#### 4.4.2.5 D-W1-4：Handoff vs action lease + ball custody

`Handoff` 是 `ActionSuccessorMetadata`（`packages/shared/src/types/action-successor.ts:221`）
+ `ActionSuccessorLease`（`packages/api/src/domains/ball-custody/action-successor-state-machine.ts:119`）
+ `BallCustodyEvent`（`packages/shared/src/types/ball-custody.ts:49`）
+ `UnifiedAwaitStateV1`（`packages/shared/src/types/wait-contract.ts:25`）的代码交付 typed envelope。
状态真相在 `handoffs`；`custody_events` 只做 append-only 审计；`waits` 只驱动唤醒。

| codeteam | clowder 源 | 处置 | 差异 / 理由 |
|---|---|---|---|
| `handoffs.id` | `ActionSuccessorLease.leaseId` | reused | 一个 handoff 对应一个 action lease；`waits.owner_fence.leaseId` 指向它 |
| `task_id` / `stage_id` | 无 lease 字段 | code-delivery-specific | 代码交付 handoff 绑 task/stage；stage 只是快照 |
| `kind` | `actionFamily` | reused | review/merge/investigate/implement/verify/vision_guard |
| `from_role` / `to_role` | 无 lease 字段；clowder 用 holderCatIds | code-delivery-specific | SOP actionPair 需要 role 方向白名单；holder 身份仍用 profile |
| `status` | `ActionSuccessorLeaseStatus` + custody events + wait outcome | reused（映射） | `pending / claimed / consumed / withdrawn / expired` 是对 lease 状态 + claim + terminal + wait 的 typed 投影；不新增 custody 账本 |
| `subject` | 无同名字段；显示标签 | code-delivery-specific | 人类可读 subject；`subject_ref` 才是身份 |
| `subject_ref` | `ActionSuccessorIdentity.subjectRef` | reused | canonical subject identity；不造新球 ID |
| `action_family` / `successor_slot` / `mode` / `parallel_intent` | `ActionSuccessorMetadata` | reused | single/parallel 校验原样复用；parallel 必须有 intent |
| `owner_user_id` | lease owner | reused | operator owner scope |
| `canonical_action_key` | `canonicalizeActionIdentity` | reused | partial unique live index；同一 action identity 同时最多一个 pending/claimed |
| `holder_profile_ids_json` | `holderCatIds[]` | reused | catId → profile id；single 一个，parallel 多个 |
| `holder_thread_id` | `holderThreadId` | reused | 投递/回收 thread |
| `predecessor_profile_id` / `predecessor_thread_id` | `predecessorCatId` / `predecessorThreadId` | reused | return-to-predecessor |
| `claim_origin` / `issuer_standing_evidence_ref` | `claimOrigin` / `issuerStandingEvidenceRef` | reused | existing_standing 必须有 grounding evidence |
| `generation` / `revision` | lease generation/revision | reused | CAS 与 replacement lineage |
| `dispatch_id` | lease dispatchId | reused | 投递身份 |
| `terminal_predicate_json` | `CanonicalActionTerminalPredicate` | reused | new handoff 必须有 typed predicate；不继承 `legacy_predicate_absent` |
| `completion_candidates_json` / `holder_outcomes_json` | `completionCandidates` / `holderOutcomes` | reused | candidate 不是 complete；resolver 证据后才 commit |
| `return_transitions_json` / `replacement_transitions_json` | 对应 lease 字段 | reused | return/replace 历史 |
| `return_delivery_*` / `dispatch_delivery_*` | 对应 lease 字段 | reused | 投递状态/重试/SLA |
| `terminal_actor_ref` / `terminal_reason` / `terminal_evidence_ref` | lease evidence/terminal | reused（拆分） | 通用 `evidenceRefs[]` 拆成 terminal/dispatch/return 专用 ref；不复制正文 |
| `expected_artifact` | 无 lease 字段 | code-delivery-specific | 代码交付必须声明 expected artifact；否则不唤醒接收者 |
| `deadline` | `UnifiedAwaitStateV1.expiresAt` 的显式终止语义 | code-delivery-specific | action lease 本身没有 wall-clock deadline；codeteam handoff 需要显式 deadline；claim lease stale 只触发 run recovery |
| `payload_json` / `idempotency_key` / `reply_to` | lease/message identity | reused | replay 幂等与回复锚 |
| `attempt` | lease attempt/replay | reused | expired 重排必须 attempt+1 |
| `claimed_by_run_id` / `claimed_at` / `claimed_lease_until` / `last_heartbeat_at` | single-mode claim summary | reused | single mode 摘要；parallel 以 `handoff_holder_claims` 为准 |
| `terminal_at` / `result_json` / `created_at` | lease terminal/result/createdAt | reused | one terminal；replay 返回原结果 |
| `updated_at` | 无独立列；revision CAS | code-delivery-specific | 不存 updated_at，更新走 revision CAS；避免双 CAS 源 |

Handoff 状态映射：

| codeteam status | 证据 | 规则 |
|---|---|---|
| `pending` | lease 存在、无 active holder claim | 责任未领取；唤醒账本在 `queue_entries` |
| `claimed` | 至少一个 active `handoff_holder_claims` | single 一个，parallel 每 holder 一条；非 holder `safe_wait` |
| `consumed` | lease completed + terminal result | 幂等 replay 返回原结果 |
| `withdrawn` | operator/author 显式撤回 | terminal；记录 actor+reason；不再唤醒 |
| `expired` | explicit deadline/operator | terminal；不得 late-complete；重排 attempt+1 |

`ActionSuccessorLeaseStatus` 的 `replaceable` 不作为 codeteam 的第五个
status；它映射到 pending/replacement transition。`BallCustodyEvent` 映射：

| codeteam `custody_events` | clowder `BallCustodyEvent` | 处置 | 差异 / 理由 |
|---|---|---|---|
| `id` | `sourceEventId` | reused | 幂等去重键 |
| `subject_ref` | `subjectKey` | reused | 复用 `ball:thread:` / `ball:task:` 派生口径，不造球 ID |
| `kind` | `BallEventKind` | reused（前缀映射） | 统一为 `handoff.*` 枚举：created/dispatched/claimed/returned/replaced/completion_candidate/completed/parallel_unfinished/withdrawn/expired/recovered |
| `classification` | `state-changing / informational` | reused | 原样 |
| `payload_json` / `ts` | `payload` / `at` | reused | 原样 |
| `handoff_id` / `generation` / `seq` / `actor_ref` | 无同名字段 | code-delivery-specific | 审计索引/对账；状态真相仍在 `handoffs`，重放必须对账 |

`handoff_holder_claims`：`handoff_id/profile_id/generation/run_id/status/claimed_at/lease_until/last_heartbeat_at/released_at/release_reason`
复用 action lease 的 per-holder claim 语义；`status` 收敛为
`active / released / interrupted`；`run_id` 必须 active run；一个 active run
至多 claim 一个 handoff。

`waits`：`wait_id/generation/subject_ref/kind/wait_source_ref/expected_signal/baseline_json/continuation_json/owner_fence_json/status/expires_at/auto_renew/sla_until/outcome_json/outcome_delivery/publish_claimed_at/consumed_at/approval_id/created_at/terminalized_at`
复用 `UnifiedAwaitStateV1` + F280；`kind ∈ timer / event / managed_command`；
event 型必须有 `expected_signal`；所有 wait 必须有 `wait_source_ref` +
SLA + owner fence，缺一 fail closed。`wait_terminations` 是 canonical
append-only `wait.terminated` 事件；`(wait_id,generation)` 唯一；
`user_cancel` actor 必须是 owner。

#### 4.4.2.6 D-W1-5：Artifact vs ThreadArtifactDTO

| codeteam `artifacts` | 来源 | 处置 | 差异 / 理由 |
|---|---|---|---|
| `id` | 无 clowder artifact 账本 | code-delivery-specific | 内容不可变；新版本新 id |
| `task_id` / `run_id` | 无 clowder artifact 账本 | code-delivery-specific | 证据归属 task/run |
| `kind` | `ThreadArtifactType` 仅作投影提示 | code-delivery-specific | `spec / plan / diff / test-report / review / verification / merge-receipt`；不是 ThreadArtifactType 子集 |
| `sha256` / `path` / `media_type` / `bytes` | 无 clowder artifact 账本 | code-delivery-specific | 内容 hash + 临时文件 + fsync + rename；证据可重放 |
| `provenance_json` | `ThreadArtifactDTO.sourceMessageId` 等 | code-delivery-specific | 至少含 `sourceMessageId`；可含 actor/profile/run/command；不复制正文 |
| `approval_id` | F246 1:1 effect receipt | reused | `approvals.effect_reservation_ref` 1:1；succeeded 必须有 effect_ref |
| `created_at` | 无 clowder artifact 账本 | code-delivery-specific | 证据创建时间 |

`ThreadArtifactDTO` 是 operator 视图，不是表：

| ThreadArtifactDTO 字段 | 投影来源 | 处置 | 差异 / 理由 |
|---|---|---|---|
| `type` | `artifacts.kind` → `image/file/code/pr/audio/video/widget` | reused（投影） | 默认 `code`/`file`；新增枚举需 operator 定 |
| `name` | `path` / artifact title | reused（投影） | 显示名，不是身份 |
| `catId` | `provenance_json.actor_profile_id` → profile 的 `clowder_cat_id` | reused（投影） | 仅 provenance；profile 无 catId 时为 null |
| `createdAt` | `artifacts.created_at` | reused（投影） | 排序键 |
| `sourceMessageId` | `provenance_json.sourceMessageId` | reused（投影） | 跳回原消息；证据 artifact 必填 |
| `url` | artifact store URL / 外链 | code-delivery-specific（投影） | 视图 URL；不是账本身份 |
| `publicationItem` / `ref` / `fileLedgerRef` / `work` | artifact provenance / publication | reused（投影） | 只读；不反向成为 review/merge 真相源 |

规则：

- `artifacts` 是证据账本；`ThreadArtifactDTO` 是只读投影。Hub 面板不能反
  向成为 review/merge 真相源。
- `spec/plan/diff/test-report/review/verification/merge-receipt` 默认映射
  `file` 或 `code`；新增 Hub 可见 type 需 operator 定。
- 每个 evidence artifact 的 `provenance_json` 至少含 `sourceMessageId`；
  `artifactRef` 是消息/Review/Merge 回指 artifact 的稳定引用。

#### 4.4.2.7 其余 W1 对象字段矩阵

**0. Task**

| codeteam 字段 | clowder 源 | 处置 | 差异 / 理由 |
|---|---|---|---|
| `tasks.id` / `kind` / `thread_id` / `subject_key` / `title` / `why` / `status` / `created_by` / `created_at` / `updated_at` | `TaskItem.id/kind/threadId/subjectKey/title/why/status/createdBy/createdAt/updatedAt`（`task.ts:190`） | reused | `why` 替代 `goal`；`status` 见 D-W1-1；`createdBy` 单列见 D-W1-2 |
| `tasks.owner_profile_id` | `TaskItem.ownerCatId` | reused | 见 D-W1-2；owner 是 profile，不是 role/session |
| `tasks.automation_state_json` / `deployment_wait_json` / `probe_json` / `resolve_mode` / `entrusted_work_json` / `related_feature_id` / `detected_feature_ids_json` / `dispatch_gate_json` / `user_id` / `source_message_id` / `source_summary_id` | `TaskItem.automationState/deploymentWait/probe/resolveMode/entrustedWork/relatedFeatureId/detectedFeatureIds/dispatchGate/userId/sourceMessageId/sourceSummaryId` | reused | shape 复用；`probe.http_get` 复用，`redis_exists` drop/replace；`relatedFeatureId` 替代 `featureId` |
| `tasks.backlog_item_id` | 无 TaskItem 字段 | code-delivery-specific | work task 必须绑 backlog item；`CHECK (kind <> 'work' OR backlog_item_id IS NOT NULL)` |
| `tasks.repo` / `base_ref` / `base_sha` / `worktree` / `branch` | 无 TaskItem 字段 | code-delivery-specific | 代码交付目标、基线、worktree、分支 |
| `tasks.risk` / `risk_axes_json` | 无 TaskItem 字段 | code-delivery-specific | 五轴风险 + assurance level；merge gate 输入 |
| `tasks.lane` | 无 TaskItem 字段 | code-delivery-specific | 当前代码车道快照；不是 `WorkflowSop.stage` |
| `tasks.budget_json` | 无 TaskItem 字段 | code-delivery-specific | per-task budget 快照；真正账本在 `budgets` |
| `tasks.disposition` | 无 TaskItem 字段 | code-delivery-specific | 见 D-W1-1；取消/放弃不改四值 status |
| `tasks.goal` / `tasks.feature_id` | `TaskItem.why` / `relatedFeatureId` 已覆盖 | not separate columns | 不另存 goal/featureId；避免双真相 |

**A. Thread / Message / Queue**

| codeteam 字段 | clowder 源 | 处置 | 差异 / 理由 |
|---|---|---|---|
| `threads.id` / `title` / `created_at` | `Thread.id/title/createdAt`（`ThreadStore.ts:201`） | reused | 直接身份/显示/创建时间 |
| `threads.repo` | `Thread.projectPath` | reused | 改写为目标 repo 路径；产品文档不写本地参考路径 |
| `threads.phase` | `Thread.phase`（`ThreadPhase`） | reused | `coding / research / brainstorm`；dispatch 同时写 `backlog_items.dispatched_thread_phase`；不是 `tasks.lane` |
| `threads.backlog_item_id` | `Thread.backlogItemId` | reused | dispatch 单事务写；`ON DELETE SET NULL` |
| `threads.status` | 无 clowder Thread.status | code-delivery-specific | `active / archived`；无 gate；archived 仍可读 |
| `threads.updated_at` | `Thread.lastActiveAt` 是活动时间 | code-delivery-specific | 行 mutation/CAS 时间；不与 last activity 混用 |
| `messages.id` / `thread_id` / `created_at` / `updated_at` | `Message.id/threadId/createdAt/updatedAt`（`message.ts:98`） | reused | 直接身份 |
| `messages.author_kind` / `author_id` | `Message.sender` union | reused | 拆 union；保留 user/agent/external/plugin/system |
| `messages.body_md` | `Message.content` 文本部分 | reused | 扁平 Markdown；rich blocks 分开；不建第二 message store |
| `messages.rich_blocks_json` | `MessageContent` / RichBlock | reused | JSON 投影；不含 approval kind |
| `messages.dispatch_refs_json` | `LifecycleMessageMetadata.dispatchRefs` | reused | source×target 实际投递；terminal 仍以 runs 为准 |
| `messages.task_id` | 无 Message.taskId | code-delivery-specific | 代码交付聊天绑定 task；可空 |
| `messages.kind` | 无 Message.kind | code-delivery-specific | chat/question/answer/proposal/finding/status/handoff/verdict/approval_request/agent_response/backlog_kickoff/approval_pointer |
| `messages.reply_to` | 无 Message.replyTo | code-delivery-specific | 只允许同 thread；跨 thread 用 access-checked navigation ref |
| `messages.control_ref` | 无 Message.controlRef | code-delivery-specific | daemon 在 typed control 创建后回填；agent 不能手填 |
| `messages.seq` | `orderKey` 是展示排序 | code-delivery-specific | thread-scoped 可见序；`UNIQUE(thread_id,seq)`；`BEGIN IMMEDIATE` 分配 |
| `queue_entries.id` / `thread_id` / `priority` / `enqueued_at` | `LifecycleQueueEntryBase.id/threadId/priority/enqueuedAt`（`message-lifecycle.ts:33`） | reused | 单 pending-wake 账本 |
| `queue_entries.source_id` / `source_record_id` / `source_kind` | `from` union / `sourceRecordId` / `kind` | reused | 扁平 source identity；不存 inline payload |
| `queue_entries.targets_json` | `targets[]` | reused | profile/session id；多 recipient 一行，不拆行 |
| `queue_entries.author_intent_json` | `authorIntentByTarget` | reused | 每 target 意图；路由只读 typed 字段 |
| `queue_entries.source_category` | clowder source category | reused | a2a/review/continuation/backlog_dispatch |
| `queue_entries.order_key` | `position` / order list | reused | SQLite 显式排序键 |
| `queue_entries.revision` | `version` | reused | 行 CAS/replay |
| `queue_entries.fence_refs_json` | F254/F167/F280 fence refs | reused | 只运输 refs；不复制 fence 正文 |
| `queue_entries.status` | `QueueLedgerStatus` | reused | queued/claimed/processing；terminal 行同事务删除；不落 durable tombstone |
| `queue_entries.claim_id` / `claim_owner_run_id` | clowder claim | reused | 短 cutover claim |
| `queue_entries.claim_expires_at` | `claimedAt` + recovery threshold | code-delivery-specific | SQLite 自到期列；clowder 无同名列 |
| `queue_entries.updated_at` | 无 clowder 行 updatedAt | code-delivery-specific | 行 mutation/CAS |

**B. Backlog / SOP / managed work**

| codeteam 字段 | clowder 源 | 处置 | 差异 / 理由 |
|---|---|---|---|
| `backlog_items.id` / `user_id` / `project_id` / `title` / `summary` / `priority` / `tags_json` / `status` / `suggestion_json` / `lease_json` / `dependencies_json` / `dispatched_thread_id` / `dispatched_thread_phase` / `dispatch_attempt_id` / `pending_thread_id` / `kickoff_message_id` / `approved_at` / `dispatched_at` / `done_at` / `created_at` / `updated_at` | `BacklogItem`（`backlog.ts:59`） | reused | 全形状复用；`audit` 不内嵌，从全局 `audit` 投影；`suggestion/lease/dependencies` 用 JSON |
| `backlog_items.created_by_kind` / `created_by_id` | `BacklogItem.createdBy` | reused（枚举扩展 `system`） | 拆 CatId/user；`system` 仅 W8/forge inbound 初始 `open/suggested`，后续 approve/dispatch 仍走 operator |
| `workflow_sops.backlog_item_id` / `feature_id` / `sop_definition_id` / `stage` / `baton_holder` / `next_skill` / `resume_capsule_json` / `checks_json` / `version` / `updated_at` / `updated_by` | `WorkflowSop`（`workflow-sop.ts:23`） | reused | 告示牌+CAS 原样；`stage` 不做迁移校验 |
| `workflow_sops.checks_json` 的 `verified` | `SopChecks` / `sop_check_evidence`（W4） | code-delivery-specific 限制 | W1 只写 `attested/unknown`；`verified` 由 gate 证据投影，agent 不能自报 |
| `work_admissions.work_id` / `owner_user_id` / `producer_kind` / `producer_ref` / `initial_attempt_id` / `admitted_at` | F275 `WorkAdmission` | reused | TTL=0；确定性 work id |
| `work_attempts.attempt_id` / `work_id` / `attempt_number` / `executor_profile_id` / `created_at` / `executor_bound_at` | F275 `WorkAttempt` | reused | `executor_profile_id` 由 catId 适配为 profile；attempt 1 初始 unbound |
| `run_managed_work_bindings.*` / `task_managed_work_bindings.*` | F275 invocation/task binding | code-delivery-specific | server-private；raw workId/attemptId 不进公共 DTO |

**C. Role / AgentProfile / AgentSession / credential**

| codeteam 字段 | clowder 源 | 处置 | 差异 / 理由 |
|---|---|---|---|
| `roles.id` / `label` / `description` / `status` / `created_at` / `updated_at` | `Role = string` 动态 registry | code-delivery-specific 存储 | role 语义复用；表是 codeteam registry；内置 architect/coder/reviewer/verifier，seed eval/compress；未知/禁用 fail closed |
| `agent_profiles.id` | `catId` + `CatConfig` 的稳定身份 | code-delivery-specific handle | codeteam 自有稳定 id；不直接沿用 clowder catId |
| `agent_profiles.role` | `CatConfig`/role registry | reused | primary role；一个 profile 一个 primary role |
| `agent_profiles.display_name` / `provider` / `model` / `model_family` / `role_description` / `restrictions_json` / `status` | `CatConfig` | reused | R1 适配；model_family 是 review 独立性依据 |
| `agent_profiles.tool_policy_profile` | 无 CatConfig 同名字段 | code-delivery-specific | 工具策略 profile 名；由 W2 解析 |
| `agent_profiles.clowder_cat_id` | clowder catId | reused（provenance） | 可重复、不唯一、不参与授权 |
| `agent_profiles.created_at` / `updated_at` | 无 CatConfig 行时间 | code-delivery-specific | registry 审计 |
| `agent_sessions.id` / `thread_id` / `seq` / `status` / `cli_session_id` / `native_session_binding_json` / `context_health_json` / `capacity_pin_json` / `seal_reason` / `compression_count` / `continuity_capsule_json` / `chain_key` / `latest_resume_session_id` / `created_at` / `updated_at` / `sealed_at` | `SessionRecord`（`session.ts:56`） | reused | 全字段复用；结构化字段用 JSON 列承载；`scopedInvocation`/`externalImport` 显式不继承 |
| `agent_sessions.task_id` / `stage_id` / `profile_id` / `role` / `effective_tool_policy` / `pi_session_id` / `provider` / `model` / `model_family` | SessionRecord 扩展 | code-delivery-specific / adapted | `pi_session_id` 映射 `cliSessionId`；session role 可不同于 profile primary role；effective policy 落快照 |
| `invocation_credentials.id` / `token_hash` / `token_salt` / `run_id` / `task_id` / `role` / `agent_session_id` / `agent_profile_id` / `thread_id` / `user_id` / `owner_auth_provenance` / `parent_run_id` / `tool_policy_json` / `state` / `disposition` / `last_refresh_at` / `expires_at` / `created_at` / `updated_at` | F174 `InvocationRecord` | reused | SQLite 实现；active 无短 TTL，terminal tombstone 30d；`owner_auth_provenance ∈ strict/compat/unknown`，managed-work bind 只 strict |

**D. Run / event / stage**

| codeteam 字段 | clowder 源 | 处置 | 差异 / 理由 |
|---|---|---|---|
| `runs.*` | 见 §4.4.2.4 | mixed reused / code-delivery-specific | 不建第二 active-run/response 表 |
| `run_events.id` / `run_id` / `seq` / `kind` / `payload_json` / `ts` | `TurnExecutionRecord` / `InvocationRecord` 事件语义 | code-delivery-specific | child event stream；不替代 run terminal truth |
| `thread_events.id` / `thread_id` / `seq` / `kind` / `payload_json` / `ts` | thread projection events | code-delivery-specific | 只写 thread 已存在后的 `backlog_item_dispatched/backlog_item_done/workflow_sop_updated`；聊天不落这里 |
| `stages.id` / `task_id` / `lane` / `status` / `started_at` / `ended_at` | 无 clowder Stage 原语 | code-delivery-specific | 纯快照；`status active/passed`；无 entry/exit/criteria/attempt；gate 不以 stage 迁移触发 |

**E. Wait / Inbox / Approval**

| codeteam 字段 | clowder 源 | 处置 | 差异 / 理由 |
|---|---|---|---|
| `waits.*` | `UnifiedAwaitStateV1` + F280 | reused | 见 §4.4.2.5；timer/event/managed_command；event 必须有 expected_signal；所有 wait 必须有 wait_source_ref/SLA/owner fence |
| `wait_terminations.*` | `WaitTermination` canonical event | reused | append-only；`(wait_id,generation)` 唯一；user_cancel actor=owner |
| `inbox.id` / `task_id` / `run_id` / `kind` / `payload_json` / `status` / `created_at` / `consumed_at` | clowder inbox/steer 语义 | code-delivery-specific 存储 | `kind ∈ steer / followUp / humanGuidance`；不产生 handoff；operator chat 行动才生成 |
| `approvals.id` / `thread_id` / `task_id` / `kind` / `idempotency_key` / `origin_ref_json` / `card_ref_json` / `resolution` / `materialization_json` / `effect_reservation_ref` / `effect_ref` / `payload_json` / `requested_by` / `decided_by` / `decided_at` / `decided_note` / `expires_at` / `created_at` / `updated_at` | F246 Approval | reused（`kind` 扩展） | 单表 canonical；`kind ∈ merge/design_gate/spec_change/blocker/budget_pause`；双锚；resolution/materialization 分离；expiry=stale；decide operator-only |

**F. Review / Merge / Budget / Eval / Forge / Audit**

| codeteam 字段 | clowder 源 | 处置 | 差异 / 理由 |
|---|---|---|---|
| `reviews.id` / `task_id` / `run_id` / `head_sha` / `author_session_id` / `author_model` / `author_model_family` / `reviewer_session_id` / `reviewer_model` / `reviewer_model_family` / `review_mode` / `verdict` / `findings_json` / `created_at` | harness-eval review verdict envelope | code-delivery-specific 存储 | `head_sha` 硬绑定；`review_mode ∈ cross_family / same_family_fresh`；代码默认 cross_family |
| `findings.id` / `review_id` / `index` / `severity` / `file` / `line` / `claim` / `evidence_kind` / `falsifier` / `falsifier_expected` / `required_action` | harness-eval finding | reused | P1/P2 必须有可执行 falsifier；否则降 P3 |
| `verifications.id` / `finding_id` / `head_sha` / `producing_review_id` / `status` / `reason` / `command` / `cwd` / `exit_code` / `duration_ms` / `stdout_tail` / `stderr_tail` / `created_at` | verifier/falsifier 语义 | reused | 证据关闭 finding；`producing_review_id` 追溯 |
| `merges.id` / `task_id` / `base_sha` / `head_sha` / `merge_sha` / `policy` / `approved_by` / `receipt_ref` / `approval_id` / `created_at` | merge policy/receipt | code-delivery-specific 存储 | 复用 merge gate 语义；routine merge 由 daemon merge-owner 执行 |
| `budgets.id` / `task_id` / `tokens_limit` / `tokens_used` / `cost_limit` / `cost_used` / `wall_time_limit_ms` / `wall_time_used_ms` | per-task/provider budget | code-delivery-specific | 代码交付资源边界 |
| `evals.id` / `task_id` / `provider` / `model` / `role` / `metrics_json` / `created_at` | eval dimensions | code-delivery-specific 存储 | 复用 eval 方法，不建第二 evidence store |
| `forge_deliveries.id` / `provider` / `repo` / `delivery_id` / `natural_key` / `status` / `retry_count` / `received_at` / `processed_at` | github-signals / webhook delivery | code-delivery-specific 存储 | `(provider, delivery_id)` claim；重启去重 |
| `audit.id` / `actor` / `action` / `subject` / `args_json` / `result` / `ts` | clowder audit | reused（存储适配） | append-only trigger；backlog/SOP/approval mutation 同事务追加 |

#### 4.4.2.8 明确不继承的 clowder 字段/能力

| clowder 字段/能力 | 处置 | 理由 / revisit trigger |
|---|---|---|
| `TaskProbeSpec.redis_exists` | drop / replace | codeteam 不引入 Redis；`http_get` 复用。需要外部状态探测时用 HTTP/命令 adapter，不恢复 Redis 依赖 |
| `Message.status`（pending/streaming/error） | not stored | 消息行是 durable final body；流式/错误是 run/bubble 投影。W7 若需要断线续流，读 `run_events`，不把 message 变双状态表 |
| `LifecycleActiveRun.inputEntryIds[]` 的 append 能力 | v1 drop | 一个 run 一个 `queue_entry_id`；append-to-active-run 不在 W1。W7 真实需要时再评估 `run_inputs`，不提前造表 |
| `LifecycleActiveRun.inputMessageIds[]` / `privateInputEntryIds[]` | not stored | 由 queue entry source / inbox 解析；不复制第二输入身份 |
| `LifecycleResponseBubble.body` / `dispatchRefs` 作为 run 列 | not stored | body 落 `messages`；delivery 落 `messages.dispatch_refs_json`；run 不存正文/第二 delivery 账本 |
| `Run.sessionId` 第二字段 | drop | 统一 `agent_session_id`；不保留两个 session 字段 |
| `Run.updated_at` | drop | 用 status/revision/terminal_at；避免双 CAS 源 |
| `ActionSuccessorLeaseStatus.replaceable` | 不作为 codeteam status | 映射 pending/replacement transition；codeteam status 不增加第五值 |
| `terminalPredicateState.legacy_predicate_absent` | not inherited | 新 handoff 必须有 typed terminal predicate；legacy 只用于 clowder 历史数据 |
| `SessionRecord.scopedInvocation` / `externalImport` | v1 drop | codeteam session 不承接 clowder 的一次性 scoped/external import；W5 re-attach 再评估 |
| `Thread` 的 participants/createdBy/pinned/favorited/titleSource/mentionActionabilityMode/routingPolicy 等 | W1 slice 不持久化 | W1 只建 thread 身份/phase/backlog 链接；参与者从 messages/agent_sessions 派生；UI metadata 归 W7 |
| `BacklogItem.audit` 内嵌 | not stored | 统一从全局 `audit` 投影；避免第二 audit 账本 |
| clowder Redis queue 的 durable tombstone / per-target 行 / F122 steer 预留 | not inherited | SQLite 同库 cutover 单事务；单行多 recipient；terminal 行删除；F122 是历史 |
| `agent_keys` 表 | v1 not built | callback credential 够用；P1 external/IDE direct 再开 |
| `ThreadArtifactDTO` 作为表 | not a table | 只读投影；账本权威在 `artifacts` |
| `tool_usage_counters` / telemetry traces | W6/W7 | 不阻塞 W1；按 observability 卡单独落 |
| `clowder_cat_id` 作为唯一/授权键 | not allowed | 只作 provenance；授权看 profile/session/credential |
| `LifecycleQueueEntryBase.ownerAuthProvenance` 作为 `queue_entries` 列 | not duplicated | admission 时解析，cutover 时 mint 到 `invocation_credentials.owner_auth_provenance`；managed-work bind 只接受 strict；Queue 不存第二份 auth provenance |

#### 4.4.2.9 入场门禁检查项

矩阵 review 时必须逐项确认；未确认不得建表：

1. `queue_entries` 不重复存 `owner_auth_provenance`；cutover 时 mint 到
   `invocation_credentials`，managed-work bind 只接受 `strict`。contract
   test 覆盖 compat/unknown 不绑定。
2. `runs` 不存 `thread_id`；`tasks.thread_id == agent_sessions.thread_id`
   由 contract test 锁定；不一致 fail closed。
3. `handoffs.deadline` 是显式 deadline；claim lease/heartbeat stale 只触
  发 run interrupted recovery，不判 custody expired。
4. `threads.phase` 是 clowder dispatch/UI phase；`tasks.lane` 是代码车道；
   两者不互换、不互相推导；thread phase 与 backlog dispatched phase 不一
   致时 dispatch 事务回滚。
5. `messages.status` 不持久化；W7 只从 `runs.status` / `run_events` 投影
   streaming/terminal，不从 message 行猜。
6. `artifacts.kind` → `ThreadArtifactType` 默认映射 `file`/`code`；新增
   Hub 枚举需 operator 定，不由 W1 自创。
7. `owner_profile_id` 是唯一 owner 字段；不存在 `owner_role` /
   `owner_session`；换 role/session 不改变 owner。
8. `custody_events` 与 `handoffs` 重放对账；偏差告警，不反向裁决；wait
   canonical 终止只在 `wait_terminations`。
9. `§12.2` 的 `agent_sessions` DDL 是摘要；迁移时必须按 `SessionRecord`
   全字段展开（或明确 JSON 列），不能把摘要当完整列清单。`seq` /
   `cli_session_id` / `context_health_json` / `seal_reason` /
   `compression_count` / `continuity_capsule_json` / `sealed_at` 等必须有
   落点。

---

## 5. 状态机

> 本节区分两类状态：Task / Run / Handoff 是执行状态机；`WorkflowSop.stage` 是 feature/backlog 级告示牌，不是状态机。

### 5.1 SOP Stage 与 Task / Run Lane

SOP stage 是 feature/backlog 级告示牌，不是 task 状态机：

```text
WorkflowSop.stage: kickoff / impl / quality_gate / fresh_context / review / merge / completion
```

- 猫读告示牌后自己决定下一步；没有强制迁移。
- `stage` 只记录“当前在哪”，不产生 gate。
- `completion` 只挂 feature/backlog item，不挂在 task 上。

Task / Run 执行车道：

```text
Task: todo / doing / blocked / done + disposition(canceled/abandoned)
Run:  running / completed / canceled / interrupted / failed
Lane: impl / quality_gate / fresh_context / review / merge
```

- `verify` 是 review/merge 的 gate，不是 lane。
- 点状硬门禁：worktree / design / review / verify / merge / completion（见 §7.5）。
- task `done` 必须有 merge receipt 或人类验收记录；它不等于 feature completion。

### 5.2 Handoff

```text
pending ──claim──► claimed ──complete──► consumed
   │                  │
   │                  ├──all holder claims released/interrupted──► pending
   │                  └──explicit deadline──► expired
   ├──withdraw──► withdrawn
   └──deadline──► expired

claimed ──one holder interrupted──► claimed / pending（其他 holder claim 保留）
```

- `pending`：等待接收者 claim。
- `pending` 的唤醒账本在 `queue_entries`；`handoffs.pending` 只表示责任未领取，不是第二队列。
- `claimed`：至少一个 holder claim 是 active；single mode 一个，parallel 每个 holder 各自一条。非 holder run `safe_wait`；同一 holder 的第二个 run `safe_wait`。
- `consumed`：有 terminal result，幂等 replay 返回原结果。
- `withdrawn`：operator/author 显式撤回；terminal，记录 actor+reason，不再唤醒接收者。
- `expired`：terminal；**不得再 complete**。重排必须 `attempt+1`；新建 handoff 时复用 canonical action key 给 loop guard。
- `expire` 只由 explicit deadline/operator 触发；claim lease/heartbeat stale 只触发 run interrupted recovery（该 holder claim 置 interrupted；全部 claim 释放/中断后回 pending），不要把 worker 崩溃误判为 custody 死亡。不要把健康长任务按墙钟硬切。
- 原 run 迟到的 `complete` 必须失败，并返回 `safe_wait` / `terminal_handoff`。

### 5.3 Run

```text
running ──► completed
   │
   ├──► canceled      (operator stop/cancel; actor=operator)
   ├──► interrupted   (crash / startup recovery / expired claim)
   └──► failed        (model/tool/policy terminal error)
```

`canceled` 是用户控制的终态，不是 crash；`interrupted` 仅由 recovery/lease 合成。`interrupted` 的 run 不产生 terminal artifact；它持有的 handoff 回到 `pending`，未投递 target 的 pending-wake 仍由 `queue_entries` 负责。

### 5.4 风险分级

风险分两个维度：**五轴风险面**（behavior / data / security / contract / irreversible）+ **assurance level**（light / standard / high / critical）。author 不能自评低风险绕过 §7.4 的风险车道。

| 风险面 | 命中信号 | 最低 assurance | 动作 |
|---|---|---|---|
| behavior | 用户可见行为、runtime 逻辑、bug 回归 | standard | 可观察 RED + targeted 验证 |
| data | 生产数据、迁移、持久化语义 | high | 持久化/迁移验证 + 独立高风险 review |
| security | auth、权限、secret、注入、DoS/资源边界 | high | 安全边界测试 + cloud/context-blind 扫描 |
| contract | API / MCP schema / 事件格式 / 外部依赖 | high | 契约测试 + consumer census |
| irreversible | 删除、force push、合第三方 PR、close feat | critical | operator 授权 + 机器门禁 |

规则：

- 只升不降；post-diff 复核命中新风险面时升档。
- author 不能自评低风险；必须机器分类。
- 纯 docs / 注释 / 无代码路径走 docs-lane，可 evidence-only review 或按 classifier direct push。

---

## 6. A2A 协议

### 6.1 Envelope

```ts
interface HandoffEnvelope {
  id: string;
  taskId: string;
  stageId: string;
  kind: HandoffKind;
  fromRole: Role;
  toRole: Role;
  subject: string;
  actionPair: string;        // 例如 "coder->reviewer:review"
  expectedArtifact: string;  // 没有它不唤醒
  payload: Record<string, unknown>;
  idempotencyKey: string;
  replyTo?: string;
  deadline: number;
}
```

### 6.2 消息类型

| kind | 方向 | 语义 |
|---|---|---|
| `handoff` | role → role | 交接一个阶段或子任务 |
| `review_request` | author → reviewer | 请求独立 review，携带 diff/test-report/impact surface |
| `verdict` | reviewer → coder/human | typed verdict + findings |
| `blocker` | any → human/orchestrator | 需要外部决策或环境修复 |
| `spec_change` | any → orchestrator | 请求修改 spec，回到设计/计划 |
| `plan_revision` | any → orchestrator | 请求修改 plan，回到设计/计划 |
| `question` | any → human/role | 需要澄清，带 deadline |

### 6.3 硬规则

1. **Per-holder claim CAS**：single mode 一个 active claim；parallel 每个 holder 各自一个 active claim。非 holder run 或同一 holder 的第二个 run 返回 `safe_wait`。
2. **One terminal per run / handoff**：同一 run / handoff 的 terminal 只提交一次；重复提交返回原结果。
3. **Expected artifact**：没有期望产物，不允许创建 handoff。
4. **Deadline / lease**：explicit deadline 到期才 expired；claim lease/心跳 stale 只产生 liveness candidate，确认 run interrupted 后释放该 holder claim（全部释放后回 pending），不把健康长任务按墙钟硬切。
5. **Loop guard**：按 canonical `(subject, actionPair)` 计数，不按消息条数；重排 attempt 不换 key；超过阈值升级 human。
6. **No empty ACK**：状态更新写 event，不产生 handoff，不唤醒 agent。
7. **Blind review**：`review_request` 不携带 author 的模型/身份；reviewer 只看 diff、约束、证据。
8. **Fresh context**：reviewer/verifier 使用新 session，不共享 author 的 transcript。
9. **Idempotency**：每个 handoff 带 `idempotencyKey`；重复投递返回原结果。
10. **Event-driven drain**：scheduler 由 handoff/run/deadline 事件驱动；dirty-bit 保证“有可执行工作就一定会 drain”。
11. **Complete validation**：`complete()` 必须校验 exact active holder claim（profile + run + generation）属于 self；expired/consumed 或非 active claim 一律拒绝。
12. **Direction allowlist**：`(fromRole, toRole, kind)` 必须命中 SOP actionPair 白名单；`fromRole` 从 token 派生，不能由 tool args 声称。
13. **Re-dispatch**：expired 后重排用 `attempt+1`；新建 handoff 时保持 canonical action key，避免换 subject 绕过 loop guard。
14. **Human handoff**：发给 human 的 `question` / approval 超时转 `waiting_human`，不回收、不升级给不存在的更高主体。

### 6.4 当前实现

`packages/codeteam/src/control-plane.ts` 已实现：

- `createHandoff` 检查 `expectedArtifact`、deadline、loop guard。
- `claim` 实现 per-holder CAS / `safe_wait` / replay。
- `complete` 实现 one terminal per run。
- `finishRun` / `recoverInterruptedRuns` 把 interrupted run 的 handoff 放回 pending。
- `expire` 回收 deadline。
- `hydrate` 从 SQLite 恢复 task/run/handoff/loop count/sequence。

目标态还要补：

- `claimed → expired` 的 lease 语义和 late-complete 拒绝。
- `complete` 的 `claimedByRunId` 校验。
- `(fromRole,toRole,kind)` 方向白名单和 token 派生身份。
- 重排 attempt+1 与 canonical loop-guard key。

### 6.5 入口：tool-call-first

A2A 的讨论与控制走不同入口，二者都只认 typed tool：

| 入口 | 作用 | 落库 |
|---|---|---|
| `a2a_send(kind=question/answer/proposal/finding/status, targets, body, reply_to?)` | 讨论、通知、请求澄清 | `messages`；不改变 custody |
| `handoff_create(kind, to, taskId, stageId, subject, actionPair, expectedArtifact, deadline, idempotencyKey)` | 责任转移；`kind` 复用 §6.2 typed kinds | `handoffs` + `custody_events` + 可见 `Message` 外壳 |
| `handoff_claim/complete/withdraw` | 领取、收口、撤回 | handoff 状态机；one terminal |
| `approval_request` | 人类审批 | `approvals`；不得由聊天正文生成 |

`review_request` / `verdict` 是 `handoff_create` 的 typed kind，不单独造工具；`approval_request` 只写 `approvals`，不伪装成 A2A handoff。

同名 `question` 在两层语义不同：`a2a_send(question)` 是讨论性提问，不产生 custody；`handoff_create(question)` 是带 deadline 的 typed request，必须产生 custody 并计入 loop guard。

硬规则：

1. **target 只来自 tool 参数**，由 daemon 校验目标授权；正文不参与路由。
2. **`Message.control_ref` 只能由 daemon 写入**：只有 typed control 记录真实创建后才回填，agent 不能手填。
3. **讨论不改变 custody**：`a2a_send` 不能声明完成、不能转移球权；只有 `handoff_*` / `verdict` / `approval` 能。
4. **投递失败返回 typed error**：不允许“假装已通知”。
5. **可见性不退化**：tool 投递成功后 daemon 在消息上补 `→ @target` 标记；operator 在 thread 时间线能看到路由结果。
6. **弱模型兜底不做文本猜测**：tool 调用失败时，daemon 给 agent 一次带 schema 的纠错提示（`tool_call_retry_hint`），但不根据正文自动路由；若某 provider 的 tool-call 成功率低于 eval 门槛，该 profile 不获得自主 handoff 权限，只能提交 proposal，由 orchestrator 路由。
7. **同一 daemon API，两种 transport**：同进程 pi agent 用 extension，跨 provider agent 用 MCP；两者命中同一 A2A API，`from` 身份从 per-run token 派生，tool args 不允许声明。

---

## 7. SOP 引擎：全面复用 clowder SOP

> 2026-10-24 operator 拍板：**全面复用 clowder SOP**。clowder 已自主开发 300+ feature，SOP 的核心是“推进权留给猫，只锁高风险 gate”，不是强制状态机。codeteam 不再维护第二套 SOP 控制面。

复用的理由不是“少写代码”，而是 clowder 的 SOP 已经在 300+ feature 上自主运行：告示牌解决冷启动，风险车道防止过度流程化，点状 gate 守住真实高风险点。codeteam 的差异只在代码交付证据（artifact / review / verification / merge receipt），不在 SOP 本身。

### 7.1 复用边界

codeteam 的执行层是 clowder 执行原语的代码交付扩展（`Task` / `Run` / `Handoff` / `Artifact`，见 §4.4），不是第二套真相；SOP 层直接复用 clowder：

| clowder 组件 | codeteam 用法 |
|---|---|
| `sop-definitions/development.yaml` + codegen | **派生目录（fork catalog）**：复制为 codeteam 自己的 YAML；复用 schema/stage id/suggested skill/severity/predicate TYPE；predicate 参数（repo/branch/port/command/globs/cwd）按 codeteam target 中性化；Redis 专属规则 drop/replace |
| `WorkflowSop`（feature/backlog 级） | 直接复用字段：`featureId`、`backlogItemId`、`stage`、`batonHolder`、`nextSkill`、`resumeCapsule`、`checks`、`version` |
| `codeteam_update_workflow` / `codeteam_get_workflow_sop`（对齐 clowder `cat_cafe_*`） | 同 schema/语义；CAS 写入、owner-scoped 读取 |
| `BacklogItem` + feature doc | SOP 作用域；task 是 backlog item 下的工作项 |
| 五轴风险 | behavior / data / security / contract / irreversible |
| merge-gate / worktree / design gate / completion | 点状硬门禁；codeteam 只补代码交付所需的 artifact/review/verify 证据 |

> 工具名可以带 `codeteam_` 前缀，但 schema/语义逐字段对齐 clowder；不新增字段或状态。

> `development.yaml` 不是“原样 import”：stage id/skill/severity/predicate 类型复用，但 `repository: cat-cafe`、`REDIS_URL:6398`、`pnpm check:features`、`cat-cafe-runtime` 等 clowder 专属参数必须参数化或替换；每条改动进 W1 继承矩阵。

**“派生目录（fork catalog）”的定义**：把 clowder 的 `sop-definitions/development.yaml` 复制成 codeteam 自己的 `sop-definitions/development.yaml`。它不是运行时 import，也不是 fork clowder 仓库，而是“一次性复制 + 独立演进”：

- **保持不变**：YAML schema、stage id 集合、suggested skill 字段、severity 枚举、predicate 类型（`git_state_predicate` / `command_pattern` / ...）、owner 结构、codegen。
- **本地化**：predicate 参数（repo/branch/port/command/globs/cwd）、clowder 专属规则（Redis/仓库名/家规命令）。
- **版本关系**：codeteam 目录独立版本化；上游 clowder 变更按需 cherry-pick，不自动跟随。

明确不引入：

- 不新增 SOP stage。`verify` 是 review/merge 的 falsifier gate，不单列 lane。
- 不做强制串行 stage 控制器；不引入 `defineWorkflow` 的第二套 SOP。
- 不另建 SOP eval 平台；复用 `SopDefinition` / `SopTrace` / predicate evaluator 契约，作为可选离线复盘。
- 代码域 trace 字段（diff/test/artifact）作为 `SopTrace` 扩展，不改 clowder predicate 类型/severity 语义。
- 不把 task done 当 feature completion。
- 不复刻 clowder 的 voice / IM / social 能力。

### 7.2 作用域：feature/backlog 级

- `BacklogItem` 是 SOP 作用域；`WorkflowSop` 以 `backlogItemId` 为 key。
- `Task` 是 backlog item 下的工作项；`Task.backlogItemId` 必须存在，feature 绑定用 clowder `Task.relatedFeatureId`。
- codeteam `Task` 是代码工作项（worktree/branch/repo），不是 clowder 毛线球的替代；它必须挂在一个 `BacklogItem` 下。
- `WorkflowSop.stage` 是 feature/backlog 级的告示牌，不是 task 的执行状态。
- `Run` / `Stage`（纯快照）可以继续表示 task 的执行生命周期；它们不是 SOP 控制器，不得反向覆盖 `WorkflowSop.stage`；gate 不以 stage 迁移触发。
- `completion` 只在 feature/backlog 级触发；task 完成 = merge receipt，不等于 feature completion。
- `BacklogItem.status` / lease / dispatch 是 clowder backlog 生命周期，不是 SOP stage 控制器；两者独立，不要互相覆盖。
- 若 codeteam 暂时没有 `BacklogItem`，先补 `BacklogItem`；`parentTaskId` 只能作为迁移过渡，不作为长期 SOP 作用域。

### 7.3 告示牌，不是控制器

- `WorkflowSop` 存 stage / baton / nextSkill / resumeCapsule / checks / version；写入只校验 schema + version CAS，不校验 stage 迁移。
- 猫读告示牌后自己决定下一步；SOP 不推着猫走。
- `nextSkill` 是建议，不是强制加载；`checks` 的 `attested | verified | unknown` 区分猫声明和系统验证。
- 冷启动/压缩后先读 `resumeCapsule`，再继续。
- `stage` 变更必须写 `resumeCapsule`（goal / done / currentFocus），并发用 `expectedVersion` CAS；纯 checks/nextSkill 更新可选带 capsule。gate writer 的 verified 回写不要求 agent 重写 capsule。
- `resumeCapsule` 写入主体：agent 主动更新；run terminal 时 orchestrator 可从 stage/run_events 合成草稿，agent 确认后入板。降级 profile 允许“确认草稿”这种低自由度写法。
- `batonHolder` 存唯一 handle（profile/cat id），不存展示名。

### 7.4 风险车道

直接复用 clowder 的 stage id 和按需车道：

| 车道 | 触发 | 不因什么触发 |
|---|---|---|
| `kickoff` / Design Gate | 新 feature、方向未定、价值取舍 | 每个 task |
| `impl` | tracked code、skill、SOP、脚本、第一方执行面 | 纯 docs 已自判 light |
| `quality_gate` | 所有交付的自检 | 为了报告完整跑无关全仓测试 |
| `fresh_context` | 作者判断上下文盲点高 | 非 trivial 自动触发 |
| `review` | 需要独立验证的代码/治理/契约面 | 已选 cloud 仍固定叠 local |
| `merge` | PR/branch policy 需要合入 | 自动重跑全套 |
| `completion` | 用户可见/愿景变化的 feature close | 每个 PR |

- `verify` 不单列 lane：它是 `review` / `merge` 的 falsifier gate。
- `docs-lane` / `small-change-lane` 作为风险车道的子集保留；直接复用 clowder 的 co-creation docs lane 和产品快车道。
- 风险五轴：behavior / data / security / contract / irreversible；只升不降；author 不能自评低风险。
- `assuranceLevel` 与 `route` 分开：审查强度按风险选，验证范围按影响面选。

### 7.5 点状硬门禁

只在 clowder 已验证的高风险点强制：

| Gate | 触发 | 证据 |
|---|---|---|
| `worktree` | 开 worktree 前 | main 双向同步、隔离边界 |
| `design` | design gate 命中 | spec + AC + User Journey（用户可感知时）+ risk |
| `review` | 选中独立 review | 非作者 + modelFamily + fresh + blind + falsifier |
| `verify` | review/merge 的 falsifier | 命令 + exit code + log |
| `risk-consistency` | merge 前 | declared lane/risk vs diff stats；不一致升级车道或 block |
| `merge` | 合入前 | merge-gate 5 条 + exact HEAD review continuity + merge receipt |
| `completion` | feature close | acceptance + vision guard + check:features / 等价检查 |

- **merge-gate 5 条是证据清单，不是 merge 执行授权。** operator 2026-10-25 拍 `DP-MERGE-1=D`：routine own-PR merge 由 gate 后的 merge owner 执行，operator 守硬门；C 类自动 merge 不做，A 仅零-secret 临时偏差。agent 仍不能绕过 gate 自行 merge。
  > 2026-10-25 状态注：D 的 auth / approval / custody / receipt 差量见 `architecture/merge-authority-drift-audit.md`；三猫已 accept-with-modify，D 六契约按审计 §9 冻结；`DP-MERGE-2=A`（W0–W4 D-first，local `MergeExecutor`）。
- 机器 gate 只守确定性证据；语义判断留给 author / reviewer / guardian。
- 没有证据的 manual rule 只做 advisory/eval，不伪装成 runtime block。
- codeteam 的 artifact / schema / test 是上述 gate 的证据类型，不新增 stage。

### 7.6 与执行层的关系

- `Task` / `Run` / `Handoff` / `Artifact` 仍是执行真相；`WorkflowSop` 是流程告示牌。
- `Run.stageId` 指向纯快照 `Stage`；`Stage.lane` 记录这次 run 服务的车道（如 `impl` / `review` / `merge`），不表示 SOP 状态机。
- `Handoff` 的 one terminal / CAS / loop guard 不变；它们不是 SOP 推进器。
- `completion` 需要 feature/backlog 实体；如果 codeteam 目前只有 task，先补 `BacklogItem`；`parentTaskId` 仅作迁移过渡。
- `verify` 作为 gate，由 verifier 执行 falsifier；它可以产生 `verification` artifact，但不单独占一个 SOP stage。

### 7.7 复用清单与不复制清单

复用：

- `sop-definitions/development.yaml` 的 schema/codegen/骨架；规则内容 fork 后中性化，不直接 import clowder predicate 参数
- `WorkflowSop` type/store/CAS/routes
- `cat_cafe_update_workflow` / `get_workflow_sop` 语义
- `BacklogItem` + feature doc scope
- 五轴 risk + `assuranceLevel` / `route`
- `merge-gate` 5 条 / `worktree` / Design Gate / `completion`
- `cat-cafe-skills/{merge-gate,worktree,feat-lifecycle,quality-gate,request-review}` 的 SKILL.md 与 gate 语义
- `resumeCapsule` / baton / checks
- `SopDefinition` / `SopTrace` / predicate evaluator（可选离线 eval）

不复制：

- `eval:sop` 的 scheduled eval 运营（已 dormant；只保留契约）
- clowder 的 voice / IM / social / 个人记忆能力
- 任何“强制串行 stage 控制器”
- 另起一套 SOP 状态、表、工具或 eval 平台

### 7.8 Gate 自身也要被评测

- 从 `run_events` / `reviews` / `verifications` / `merges` 派生 gate telemetry。
- 记录通过率、block 原因分布、false block / false pass、修复成本。
- 连续通过率 >95% 且从未真正 block 的 gate 标记为剪枝候选。
- 不新建 SOP eval 平台；需要时复用 clowder 的 predicate evaluator 对 trace 做离线复盘。

> 状态：2026-10-24 operator 拍板，已生效。D6 结论为“全面复用 clowder SOP”；旧 §7 的串行 `defineWorkflow` 设计废弃。

---

## 8. 角色运行时

### 8.1 角色矩阵

| Role | 职责 | 代码/只读工具 | 控制面工具 | 上下文 | 输出 |
|---|---|---|---|---|---|
| Architect | 澄清目标、拆解、风险、spec/plan | read/grep/find/ls/git | `backlog:read`、`workflow:read/update`、`a2a_send`、`artifact_put(spec/plan)` | 项目文档 + 相关代码 + 当前 task | `spec` + `plan` + `acceptanceCriteria` |
| Coder | 实现、修改、targeted tests、自检 | read/bash/edit/write/grep/find/ls | `backlog:read`、`workflow:update`、`a2a_send`、`handoff_create(review_request)`、`artifact_put(diff/test/selfCheck)` | task capsule + plan + 相关文件 | `diff` + `testReport` + `selfCheck` |
| Reviewer | 独立审查 diff、找风险、给 verdict | read/bash(targeted tests/evidence)/grep/find/ls | `backlog:read`、`workflow:read`、`a2a_send`、`handoff_complete(verdict)`、`artifact_put(review)` | diff + test-report + impact surface + 约束 | typed `ReviewVerdict` |
| Verifier | 执行 falsifier/验收/回归 | read/bash/grep/find/ls | `a2a_send`、`handoff_complete(verification)`、`artifact_put(verification)` | findings + 命令 + 证据 | `Verification[]` |

矩阵管“能不能调”；`(fromRole,toRole,kind)` / actionPair 白名单管“此刻该不该调”。agent 不能调用 `approval:decide`；routine merge 只能由 merge-owner capability 执行，普通 run token 不能自行 `merge:record`（`DP-MERGE-1=D`）。

`Human` 不是 agent Role：operator/human 是 `actorKind`，审批/merge 由 operator credential 授权。

自定义 role 示例（可从前端创建，用于研究/设计/写作/运维等任务）：`researcher`、`designer`、`writer`、`data-analyst`、`security-auditor`、`release-manager`、`incident-responder`、`evaluator`。SOP 只是 role 目录的一个 consumer，不是定义者。

Role 目录：内置 architect/coder/reviewer/verifier 是代码常量；自定义 role（writer 等）存 `roles` 表，前端 M1 创建，不改核心代码。SOP `development.yaml` 只引用 role id / actionPair，不定义 role。

自定义 role 的 `description` 作为 L1 role prompt 输入；工具权限仍由 `AgentProfile.toolPolicyProfile` 决定，不在 role 上重复。

### 8.2 角色不是人格

Role prompt 只写职责、边界、输出契约，不写“你是一只猫”。role 可以换模型、换 provider、换 profile/session，但职责和输出 schema 不变。自定义 role（writer）只加 registry 数据，不改核心代码。

### 8.3 实例隔离

- Coder：持久 session，允许跨 turn 记住实现上下文。
- Reviewer：fresh in-memory session，只注入 review envelope + artifact 引用。
- Verifier：fresh in-memory session，只注入 findings + 命令。
- Architect：持久或 fresh 均可，默认只读。

### 8.4 独立 review

“非作者 review”只描述身份独立，不够。codeteam 统一用 **独立 review**：

| 约束 | 回答的问题 | 不满足会怎样 |
|---|---|---|
| **身份独立** | reviewer 是不是作者本人/同一 profile/同一 session？ | 自审，review 无效 |
| **模型族独立** | reviewer 和 author 是不是不同 model family？ | 同源盲区 |
| **上下文独立** | reviewer 是否 fresh context / 盲评？ | 被作者思路带偏 |
| **证据独立** | finding 是否有可执行 falsifier？ | review 变成感觉 |

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

| 风险 | 身份 | 模型 | 上下文 | 证据 |
|---|---|---|---|---|
| 低风险文档 | 非作者 + 不同 profile | 同族可接受，标 `same_family_fresh` | fresh 可选 | source check |
| 普通代码 | 非作者 + 不同 profile/session | **必须不同 model family** | fresh | falsifier |
| 高风险/安全/数据 | 非作者 + 不同 profile + 独立 session | **必须不同 model family** | blind + fresh | falsifier + verifier + human gate |

规则：

- 用 `modelFamily`，不用 `provider`。同一模型换网关不算跨模型。
- reviewer 必须同时满足：不同 profile、不同 session、代码 review 不同 modelFamily；同一 profile 换 session 不算独立。
- `modelFamily` 是受控枚举（静态映射），不进入 per-task/per-run 配置；`reviews` 记录 author/reviewer model + family 四元组供审计。
- DeepSeek 写 → GLM/Kimi/Qwen review 是默认；DeepSeek 写 → 另一个 DeepSeek session 只能算 `same_family_fresh`，不能宣称 cross-model。
- 没有可用跨族 reviewer：普通代码 `blocked`；高风险直接 human review；不得静默降级后当 cross-model 通过。
- 跨模型不是免证据金牌；finding 仍要 falsifier，verifier 执行后才关闭。

### 8.5 模型-角色矩阵

不要把 model id 写死在业务代码里。用逻辑别名：

```yaml
models:
  architect:
    default: deepseek/deepseek-v4-pro
    fallback: kimi-coding/k3-256k
  coder:
    default: kimi-coding/k3-256k
    fallback: deepseek/deepseek-flash
  reviewer:
    default: zai/glm-5.2
    fallback: kimi-coding/k3-256k
  verifier:
    default: deepseek/deepseek-flash
    fallback: kimi-coding/k3-256k
```

`modelFamily` 是静态受控枚举，不随 per-task/per-run 配置改；review policy 用 family 判定，不用 provider。模型-角色矩阵的 default/fallback 由 eval 决定，不靠直觉。记录每个 provider 的 tool-call 成功率、patch 有效率、review FP/recall、成本、延迟。

---

## 9. pi 运行时接入

> 更细的 pi surface、L0、MCP、RPC、durable 见 [`0002-pi-runtime-integration.md`](0002-pi-runtime-integration.md)。

### 9.1 为什么是 pi

- MIT，开源，可 fork，可审计。
- `pi-ai` 原生覆盖 DeepSeek / Kimi / GLM / Qwen 等 provider。
- `pi-coding-agent` 提供 SDK、RPC、CLI、TUI、内置工具、session、compaction、extensions、MCP。
- `pi-agent-core` 提供薄 agent loop、事件流、工具执行 hooks、`prepareRequest` / `finishTurn`。
- `pi-durable` 提供 durable task / child task / task graph / subagent 的候选底座（experimental）。
- 比“spawn Claude Code/Codex CLI”更适合深改：codeteam 需要 SOP、角色、A2A、review 证据链，这些需要 kernel 生命周期入口。

### 9.2 集成层次

| 层 | 方式 | 用途 |
|---|---|---|
| L0 | npm dependency + `pi-coding-agent` SDK | 轻量集成，快速验证 |
| L1 | extension / pi package | custom tools、policy、context、L0 注入 |
| L2 | SDK / RPC host | 控制 session、prompt/steer/follow-up、事件流 |
| L3 | `pi-durable` | durable task / child task / subagent / crash resume |
| L4 | fork kernel patch | 只有 SDK/extension 表达不了时才做 |

当前选择：**full fork（仓库形态）+ SDK/extension-first（默认实现）；L4 仅在 `KERNEL_GAPS.md` 证明后；`packages/codeteam` 拥有控制面。**

### 9.3 当前 adapter

`packages/codeteam/src/adapters/pi-session.ts`：

- `createCodeteamSession({ role, model, modelRuntime, ... })`
- `DefaultResourceLoader` 关闭上游 extensions/skills/prompts/themes/context files，避免隐式注入。
- `appendSystemPrompt` 注入 role prompt。
- coder 默认持久 `SessionManager`；reviewer/verifier 默认 `SessionManager.inMemory()`。
- `tools` 按 role allowlist。
- 支持 `customTools` / `extensionFactories`。

### 9.4 L0 与上下文

- L0：role contract、治理规则、客观性 carry-over、工具/safety 说明。
- L1：stage skill / SOP 指令。
- L2：task capsule、artifact 摘要、memory recall、环境信息。

pi 的 native system prompt surface：

- CLI：`--system-prompt <text|path>`、`--append-system-prompt`、`--no-context-files`
- SDK：`DefaultResourceLoader({ systemPromptOverride, appendSystemPromptOverride: () => [], noContextFiles: true })`
- Extension：`before_agent_start` 返回 `systemPrompt` 做整体替换/追加
- Durable：`section()` + `configure({ instructions })`

压缩免疫：pi 的 `CompactionEntry` 保存 `systemMessage` checkpoint；system prompt 不会随旧对话被摘要掉。

### 9.5 工具

- 复用 pi 内置 `read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`。
- codeteam 自定义：`run_tests`、`request_review`、`report_blocker`、`task_done`、`artifact_put`、`artifact_get`、`codeteam_update_workflow`、`codeteam_get_workflow_sop`。
- MCP：`a2a_send` / `handoff_*`、`backlog_*` / `workflow_*`、`workitem_*`、`artifact_*`、`memory_*`、`review_*`。
- 权限：`tool_call` hook + 工具实现层的路径/命令/环境约束；真正的硬边界是 sandbox。

### 9.6 Kernel patch 政策

只有以下情况才 patch kernel：

1. 需要在 tool 执行前改变 built-in tool 的实现，而不只是 block。
2. 需要 native subagent / role lifecycle，而不是多个 session。
3. 需要改 session/run 的终态、resume、queue、compaction 语义。
4. 需要改 agent loop 的 turn/tool batch 顺序。
5. 需要把权限模型下沉到所有工具实现的公共层。

每条 patch 必须有：理由、测试、上游 diff 说明、是否可上游化、回滚方式。

---

## 10. Prompt 与上下文架构

### 10.1 分层

```text
L0 — native system prompt（压缩免疫）
  - role contract / identity
  - governance / hard rules
  - objective tool & safety guidance
  - capability wakeup（只保留与代码交付相关的）

L1 — stage prompt（按需加载）
  - SOP stage instructions
  - role-specific skill
  - review/verification checklist

L2 — task context（每轮/每阶段注入）
  - goal / acceptance criteria
  - current stage / previous artifact refs
  - relevant repo files / diff / test report
  - memory recall / lessons
  - environment constraints
```

### 10.2 L0 内容

L0 不应该包含所有 SOP 细节。它只放：

- 身份与角色契约
- 五条铁律/治理规则
- 协作与 handoff 基本纪律
- 工具使用与安全反射
- 代码哲学（愿景驱动、质量门禁）
- 能力唤醒索引（与代码交付相关的 skill）

不放入：

- 当前 task 细节
- 当前 diff / 测试日志
- 时间戳、随机数、会破坏 prompt cache 的内容
- 大段 SOP 流程（放 L1 skill）

### 10.3 编译与缓存

- L0 单一真相源：`prompts/l0/<role>.md` 或编译模板。
- 每次编译产出 hash/revision；agent run 记录 L0 revision。
- system prompt sections 稳定；只改变真正变化的 section。
- 不要把当前时间、随机 ID 放进 L0；放 L2。
- 用 pi 的 section diff/patch 机制保持 prompt cache 命中。
- L0 编译边界：默认只替换 preamble；tools/rules/skills/cwd 归上游，不冻结；整体替换 `before_agent_start` 只作例外。

### 10.4 防止双重注入

- 关闭自动 context files：`noContextFiles: true` / `--no-context-files`。
- 关闭 `APPEND_SYSTEM.md`：`appendSystemPromptOverride: () => []`。
- 如果确实要加载 `AGENTS.md`，把它作为显式 L2 artifact，而不是隐式 home 文件。
- 避免 clowder 的 `~/.codex/AGENTS.md` / `~/.gemini/GEMINI.md` 化石身份问题。

### 10.5 Prompt injection

repo 内容、issue 文本、依赖 README 都可能包含“忽略之前指令”之类的注入。处理原则：

- 把 repo 内容标记为 untrusted data，不当作 system/developer 指令。
- 工具权限和 sandbox 是硬边界；不要靠 prompt 让模型“不要执行危险命令”。
- reviewer 只看 evidence，不执行 author 的指令。
- 对外部 claim 做 source-audit，不把搜索结果当事实。

---

## 11. Memory 与知识

### 11.1 从最小闭环开始

不要一上来搬 clowder 的八层记忆。codeteam v1 只需要：

1. **项目文档 / skills**：`AGENTS.md`、`docs/`、`skills/`，作为显式上下文。
2. **Evidence store**：task / run / artifact / decision / lesson，SQLite + 内容寻址。
3. **检索**：SQLite FTS5；需要时加 embedding / hybrid。
4. **决策/教训记录**：带 provenance、revision、适用条件。
5. **上下文注入**：task start / lane change / review / merge 时检索。

### 11.2 写入策略

- 不自动把聊天摘要写成 truth。
- 知识写入必须显式：`propose | defer | abstain`。
- 每条记忆有 source ref、confidence、scope、created/updated、owner。
- 派生索引可重建，不夺权。

### 11.3 检索触发

| 时机 | 注入 |
|---|---|
| Kickoff / task start | 相关项目约定、历史 task、已知坑 |
| Design / plan | 相关架构/决策、受影响模块 |
| Impl | 当前文件、相关测试、最近 diff、编码约定 |
| Review | acceptance criteria、impact surface、历史 finding 模式 |
| Review + verify gate | 验收命令、环境约束、回归样本 |
| Merge | 风险清单、rollback 方案 |
| Completion | 验收/愿景证据、遗留风险 |

### 11.4 复用与裁剪

默认复用 clowder 中与代码交付相关的 memory/eval 能力：thread recall、evidence search、session digest、task outcome、lessons、eval harness。

不搬：

- profile / taste / relationship memory
- diary / dream / private time
- 全量聊天记忆作为长期记忆/检索源（thread 内 operator↔agent 对话仍持久化为 Message，但不自动升级为交付真相）
- 自动写到长期库的“反思”
- 多租户知识图谱

这些等真实需求出现再加，不提前造。

---

## 12. 状态与持久化

### 12.1 真相层级

```text
Git                        代码真相
SQLite control store       task/stage/run/handoff/artifact/review/merge 真相
SQLite chat store          messages（operator↔agent 对话；不是交付真相）
Artifact store             证据内容（hash-addressed）
pi session JSONL           agent transcript（调试材料）
Memory index               派生索引（可重建）
```

### 12.2 SQLite 目标 schema

当前实现只有 `tasks` / `runs` / `handoffs`。目标态：

```sql
threads(id, title, repo, status, phase, backlog_item_id, created_at, updated_at)
messages(id, thread_id, task_id, author_kind, author_id, kind, body_md, rich_blocks_json, dispatch_refs_json, reply_to, control_ref, seq, created_at, updated_at)
queue_entries(id, thread_id, source_id, source_record_id, source_kind, targets_json, author_intent_json, priority, source_category, order_key, revision, fence_refs_json, status, claim_id, claim_owner_run_id, claim_expires_at, enqueued_at, updated_at)
backlog_items(id, user_id, project_id, title, summary, priority, tags_json, status, created_by_kind, created_by_id, suggestion_json, lease_json, dependencies_json, dispatched_thread_id, dispatched_thread_phase, dispatch_attempt_id, pending_thread_id, kickoff_message_id, approved_at, dispatched_at, done_at, created_at, updated_at)
workflow_sops(backlog_item_id, feature_id, sop_definition_id, stage, baton_holder, next_skill, resume_capsule_json, checks_json, version, updated_at, updated_by)
sop_check_evidence(id, backlog_item_id, check_name, evidence_kind, evidence_ref, subject_revision, recorded_by, recorded_at)  -- W4
work_admissions(work_id, owner_user_id, producer_kind, producer_ref, initial_attempt_id, admitted_at)
work_attempts(attempt_id, work_id, attempt_number, executor_profile_id, created_at, executor_bound_at)
run_managed_work_bindings(run_id, work_id, attempt_id, bound_at)
task_managed_work_bindings(task_id, work_id, attempt_id, bound_at)
tasks(id, kind, thread_id, subject_key, title, why, owner_profile_id, status, created_by, user_id, source_message_id, source_summary_id, related_feature_id, detected_feature_ids_json, dispatch_gate_json, probe_json, resolve_mode, entrusted_work_json, deployment_wait_json, automation_state_json, backlog_item_id, repo, base_ref, base_sha, worktree, branch, risk, risk_axes_json, disposition, lane, budget_json, created_at, updated_at)
stages(id, task_id, lane, status, started_at, ended_at)
roles(id, label, description, status, created_at, updated_at)
agent_profiles(id, role, display_name, provider, model, model_family, tool_policy_profile, role_description, restrictions_json, status, clowder_cat_id, created_at, updated_at)
agent_sessions(id, thread_id, task_id, profile_id, role, stage_id, pi_session_id, effective_tool_policy, chain_key, provider, model, model_family, status, created_at, updated_at)
invocation_credentials(id, token_hash, token_salt, run_id, task_id, role, agent_session_id, agent_profile_id, thread_id, user_id, owner_auth_provenance, parent_run_id, tool_policy_json, state, disposition, last_refresh_at, expires_at, created_at, updated_at)
runs(id, task_id, queue_entry_id, stage_id, attempt, role, agent_session_id, parent_run_id, source_id, recipient_profile_id, chain_metadata_json, provider, model, model_family, l0_revision, status, response_message_id, execution_kind, handoff_id, approval_id, started_at, terminal_at, usage_json)
run_events(id, run_id, seq, kind, payload_json, ts)
thread_events(id, thread_id, seq, kind, payload_json, ts)
artifacts(id, task_id, run_id, kind, sha256, path, media_type, bytes, provenance_json, approval_id, created_at)
handoffs(id, task_id, stage_id, kind, from_role, to_role, status, subject, subject_ref, action_family, successor_slot, mode, parallel_intent, owner_user_id, canonical_action_key, holder_profile_ids_json, holder_thread_id, predecessor_profile_id, predecessor_thread_id, claim_origin, issuer_standing_evidence_ref, generation, revision, dispatch_id, terminal_predicate_json, completion_candidates_json, holder_outcomes_json, return_transitions_json, replacement_transitions_json, return_delivery_state, return_delivery_evidence_ref, return_delivery_attempt_count, return_delivery_sla_until, return_delivery_last_attempt_at, return_delivery_overdue_observed_at, dispatch_delivery_state, dispatch_delivery_attempt_count, dispatch_delivery_last_attempt_at, dispatch_delivery_reservation_json, dispatch_delivered_message_id, dispatch_failure_reason, dispatch_failure_evidence_ref, terminal_actor_ref, terminal_reason, terminal_evidence_ref, expected_artifact, payload_json, idempotency_key, reply_to, deadline, attempt, claimed_by_run_id, claimed_at, claimed_lease_until, last_heartbeat_at, terminal_at, result_json, created_at)
handoff_holder_claims(handoff_id, profile_id, generation, run_id, status, claimed_at, lease_until, last_heartbeat_at, released_at, release_reason)
custody_events(id, subject_ref, handoff_id, generation, seq, classification, kind, actor_ref, payload_json, ts)
waits(id, wait_id, generation, subject_ref, kind, wait_source_ref, expected_signal, baseline_json, continuation_json, owner_fence_json, status, expires_at, auto_renew, sla_until, outcome_json, outcome_delivery, publish_claimed_at, consumed_at, approval_id, created_at, terminalized_at)
wait_terminations(event_id, wait_id, generation, wait_kind, reason, actor_json, subject_ref, owner_user_id, owner_profile_id, thread_id, at, disposition_ref)
inbox(id, task_id, run_id, kind, payload_json, status, created_at, consumed_at)
approvals(id, thread_id, task_id, kind, idempotency_key, origin_ref_json, card_ref_json, resolution, materialization_json, effect_reservation_ref, effect_ref, payload_json, requested_by, decided_by, decided_at, decided_note, expires_at, created_at, updated_at)
reviews(id, task_id, run_id, head_sha, author_session_id, author_model, author_model_family, reviewer_session_id, reviewer_model, reviewer_model_family, review_mode, verdict, findings_json, created_at)
findings(id, review_id, index, severity, file, line, claim, evidence_kind, falsifier, falsifier_expected, required_action)
verifications(id, finding_id, head_sha, producing_review_id, status, reason, command, cwd, exit_code, duration_ms, stdout_tail, stderr_tail, created_at)
merges(id, task_id, base_sha, head_sha, merge_sha, policy, approved_by, receipt_ref, approval_id, created_at)
budgets(id, task_id, tokens_limit, tokens_used, cost_limit, cost_used, wall_time_limit_ms, wall_time_used_ms)
evals(id, task_id, provider, model, role, metrics_json, created_at)
forge_deliveries(id, provider, repo, delivery_id, natural_key, status, retry_count, received_at, processed_at)
audit(id, actor, action, subject, args_json, result, ts)
```

补充：

- `audit` 用 `BEFORE UPDATE/DELETE ... RAISE(ABORT)` trigger 保证 append-only。
- `roles` 是动态 role registry：内置 architect/coder/reviewer/verifier 为代码常量，自定义 role（writer、`eval`、`compress` 等）由 registry/前端 M1 创建；`agent_profiles.role` / `agent_sessions.role` / `runs.role` / `handoffs.from_role,to_role` 引用它；未知/禁用 role fail closed。`eval`/`compress` 不是硬编码 enum；新增 role 不改核心代码。角色单数化（1 profile = 1 primary role）是 codeteam-new 的建模决策，不冒充 clowder 类型复用。
- `agent_profiles` 是稳定逻辑身份；`id` 是自有稳定 handle（不直接沿用 clowder catId），`clowder_cat_id` 仅 provenance、可重复且不参与唯一性；`role` 是 primary role；`agent_sessions.profile_id` 指向它。不要引入 `AgentInstance` 运行实例。
- `agent_sessions` 默认全字段复用 `SessionRecord`（id/seq/status/cliSessionId/nativeSessionBinding/contextHealth/capacityPin/sealReason/compressionCount/continuityCapsule/chainKey/latestResumeSessionId/createdAt/updatedAt/sealedAt 等），额外加 task_id/stage_id/profile_id/role/effective_tool_policy/chain_key；`scopedInvocation`/`externalImport` 显式排除。不要再造第二 session store。
- `agent_sessions.role` 是本次 session 使用的 role，可不同于 profile primary role；`effective_tool_policy` 由 session.role 解析并落快照；review 独立性仍看 profile + session + modelFamily，不看 role。
- `invocation_credentials` 是 per-run callback credential：只存 token hash+salt；active 无 TTL，terminal tombstone 30d；`last_refresh_at` 持久化 candidate 所需的新鲜度；`owner_auth_provenance ∈ strict|compat|unknown` 在 mint 时落列，managed-work bind 只接受 strict。liveness 采用 candidate + independent proof + exact runId fence；v1 独立证据 = `run_events` 最新事件时间 + daemon 可见的 worker 子进程存活（`runs.status` 本身不作 proof）；worker lease 归 W5。agent-key 契约可复用但 v1 不建 `agent_keys` 表。
- `tasks` 复用 clowder `TaskItem` 底座（kind/subjectKey/title/why/owner/status/createdBy/source/relatedFeatureId/dispatchGate/probe/entrustedWork/deploymentWait），再追加代码交付字段（backlog_item_id/repo/base/worktree/branch/risk/riskAxes/disposition/lane/budget）。`why` 替代 `goal`，`relatedFeatureId` 替代 `featureId`；`owner_profile_id` 指 `AgentProfile.id`，不是 role/session；不另造任务系统。work task 必须绑 backlog item：`CHECK (kind <> 'work' OR backlog_item_id IS NOT NULL)` + FK `ON DELETE RESTRICT`；migration 先加 FK、完成 task-backed backfill 再加 CHECK（SQLite 无 `NOT VALID`）。
- `backlog_items` 复用 clowder `BacklogItem` 全形状（suggestion/lease/audit/dependencies/dispatch 检查点/三态时间戳）；`created_by_kind ∈ agent|operator|system`，`system` 只用于 W8/forge inbound 的初始 `open|suggested`。`tags_json` 至少含 `feature:<id>`；feature 解析多匹配 fail closed；SOP 存在时 anchor tag 不可移除。`BacklogItem.audit` 从全局 `audit` 表投影（newest-first、100 条、`audit_truncated`+cursor），不内嵌 `audit_json`。`tasks.backlog_item_id` 必须存在。
- `workflow_sops` 以 `backlog_item_id` 为 key；11 字段复用；`stage` ∈ clowder `SopStage`（kickoff/impl/quality_gate/fresh_context/review/merge/completion）。它只是告示牌，不做 stage 迁移校验。`version` 强制 CAS；`checks_json` 只存 `attested|unknown`，`verified` 由 `sop_check_evidence` 读投影；owner scope 通过 `JOIN backlog_items.user_id` 校验，不复制 `user_id`。
- backlog item purge 必须先清 `work_admissions`/`work_attempts`/bindings；平时 `work_admissions.producer_ref RESTRICT` 让 backlog item 不可删，`workflow_sops ON DELETE CASCADE` 只在显式 purge 路径可达，不能反向依赖 cascade 静默清身份。
- `sop_check_evidence`（W4）是 verified 的唯一证据锚：`check_name × evidence_kind` 由 SQL CHECK 固定；`subject_revision` 绑定 head/merge/artifact revision，失配读为 `unknown + stale_evidence`；`evidence_ref` 只引用 review/merge/verification，不复制正文。
- `work_admissions`/`work_attempts`（W1）是 managed-work identity ledger：`work_id` 从 `(owner_user_id,'workflow_sop_v1',backlog_item_id)` 确定性派生；attempt 1 在 admission 时 `executor_profile_id=null`，bind 只取 `runs.recipient_profile_id`；TTL=0，不删除。`initial_attempt_id` 不做 FK（互相引用），两行同事务写 + 读时 bundle 校验。
- `run_managed_work_bindings`/`task_managed_work_bindings`（W1/W5）是私有 binding：不写 `runs`/`tasks` 公共列；run 与 A1-3 cutover 同事务；task 只允许 `kind='pr_tracking'`，`tasks.kind` 在 binding 存在期间不可变（trigger 兜底）；raw `workId/attemptId` 不进 Task/Run/Queue/MCP/REST/Web/Community。
- `threads` 的 `phase` 与 `backlog_item_id` 由 dispatch 单事务写；`backlog_item_id` 是反向链接，不再 best-effort；`ON DELETE SET NULL`，不级联删 thread。
- `tasks.status` ∈ clowder `todo/doing/blocked/done`；取消/放弃走 `tasks.disposition ∈ canceled|abandoned`，不新增进度枚举。`tasks.lane` 是当前车道快照。
- `tasks(kind=pr_tracking|issue_tracking)` 的 `subject_key` 加 partial unique 索引：同一 subject 同 kind 注册 replay 既有 task/wait；不同 kind 允许（`pr:`/`issue:` 前缀不同）。并发注册以唯一索引兜底，不产生双 task/双 wait/双唤醒。
- `stages` 是纯快照（`lane`、`status ∈ active|passed`、`started_at/ended_at`），不含 entry/exit/criteria/attempt；`runs.stage_id` 是唯一链接，`runs.attempt` 记重试。gate 不以 stage 迁移触发。
- 唯一 pending-wake = `queue_entries`；`handoffs` / `inbox` 是 typed source/admission，不建第二 queue。
- `completion` 是 feature/backlog 级 gate；task 完成只产生 merge receipt，不自动完成 `workflow_sops.stage=completion`。
- `messages` 持久化 operator↔agent 的聊天；需要 agent 行动时另生成 typed `inbox`，聊天本身不是交付真相。`messages.kind` 值域含 `backlog_kickoff`（backlog dispatch 的系统 kickoff 消息）、`agent_response`（run 的 exact response bubble）、`approval_pointer`（审批导航）。
- `queue_entries` 是 ADR-043 + F117 的唯一 pending-wake 账本（F122 是历史文档，不作为现行语义）；`handoffs` / `inbox` 是它的 typed source/admission，不再各建队列。多目标只在 `targets_json` 中，不拆行。`fence_refs_json` 只存 wait/lease/deployment owner 的 refs，不复制 fence 正文；`claim_id` 复用 clowder，`claim_expires_at` 是 SQLite 短 claim 的自到期列（clowder 用 `claimedAt` + recovery threshold，无同名列）。
- `messages.dispatch_refs_json` 记录 source×target 的实际投递；`runs.queue_entry_id` 指向它 claim 的 Queue Entry。多 target append 的 read-modify-write 必须在 `BEGIN IMMEDIATE` 内；Queue pending 不是 delivery。
- `messages.seq` 是 thread-scoped 可见 message 创建序，`NOT NULL` + `CHECK(seq > 0)` + `UNIQUE(thread_id, seq)`；服务端在 `BEGIN IMMEDIATE` 内分配，不信任客户端。迁移顺序：add nullable → backfill per thread → rebuild 为 NOT NULL → 建 unique 索引；不接受长期 nullable。seq 不是内容 revision：同一 message 的 stream/rich block/terminal 更新不改 seq，断线追新由 W7 reconnect 全量 snapshot 兜底（v1 不新增 `content_revision`）。
- `messages.reply_to` 必须指向同 thread message；跨 thread 不允许 reply/复制，只允许经目标 thread access check 的导航引用（return carrier/dispatchRef）。
- `runs.response_message_id` 是 response bubble 的唯一身份：一个 run 一个 response，partial unique；response message 以 `messages.kind='agent_response'` 标记，INSERT 与 `runs` INSERT 同 `BEGIN IMMEDIATE` 事务。`messages.kind='agent_response'` 但无 `runs.response_message_id` 指向的行 = orphan，health 告警，不自动删除。`runs.execution_kind ∈ ordinary|routing_guard`；W7 按它标“系统辅助”。
- response terminal body 与 `dispatch_ref.phase=settled` 优先同事务；若分居两事务，投影以 `runs.status` terminal 为真相，允许短暂 terminal+unsettled 中间态，不判 unknown；terminal 后 late stream 幂等拒绝。
- 2026-10-25 bubble-pipeline `DP-BUBBLE-1=A`：上述 W1 message identity schema（`messages.seq` / `runs.response_message_id` / `runs.execution_kind` / `dispatch_refs_json`）已冻结；W7 timeline/UX 契约为 `approved-for-direction`，W4 dogfood 后可按实测修订文案/恢复入口，不改 W1 identity/schema。
- `thread_events` 是 thread 级事件流（创建/状态/归属变化），不承载聊天正文；聊天统一落 `messages`。`thread_events.kind` 只写 thread 已存在后的投影事件：`backlog_item_dispatched` / `backlog_item_done` / `workflow_sop_updated`。`backlog_item_created/suggested/approved/rejected` 发生在 thread 之前，不能写 `thread_events`；board 时间线读 `audit`。
- `audit` 加索引 `(subject, ts)`；backlog/SOP/check 每次 mutation 同事务追加，append-only；`check_verified` 事件用 `subject='workflow_sop:<id>'`，W7a 从 audit 订阅，不把 `workflow_sops.version` 当失效信号。
- agent↔agent 讨论写 `messages`（`author_kind=agent`，`kind` 标记问题/回答/提案/finding/status）；责任转移另写 `handoff` 等控制面记录，并用 `control_ref` 关联。
- `messages.control_ref` 只能由 daemon 在 typed control 记录创建后写入；不接受 agent 手填，也不从正文 `@` 推导 target。
- `approvals` 复用 clowder F246 契约，但 codeteam 只有这一张 canonical 表（不建 5 个 producer store / query aggregation）：`kind ∈ merge|design_gate|spec_change|blocker|budget_pause`；`origin_ref_json`（message/event）+ `card_ref_json`（system-authored `approval_pointer` message）+ `effect_ref`（owner receipt）三锚；`resolution(open|accepted|rejected|closed_without_decision)` 与 `materialization_json`（not_started/outcome_unknown/in_progress(attemptRef)/succeeded/failed(failureRef,retryable)）分离。`accepted` 不是成功；`succeeded` 必须 `effect_ref`，且 `effect_ref` 只能配 succeeded。`expires_at` 到点只 stale，不自动 reject；decide stale → 409。
- approval 1:1 effect receipt：`effect_reservation_ref` 在 claim 时预分配（新 owner 行 id）；`merges`/`runs`/`artifacts`/`waits` 各加 `approval_id TEXT UNIQUE` 回指 approvals；`succeeded` 时 `effect_ref = effect_reservation_ref`，receipt `created_at > decided_at`；禁止引用 accept 之前已存在的 artifact/review。`idempotency_key` 非空唯一，且 merge/design/spec 同一 task 至多一个 open。materialization principal：merge=daemon merge service（`DP-MERGE-1=D`：routine merge 无 approval；hard-gate 由 operator approve + daemon 执行）；design/spec/blocker/budget=daemon control plane；run token/agent-key 403。accepted 卡死时 operator 可 abandon 为 failed(`operator_abandon`, retryable=false)。
- `approvals` 的 `requested_by`/`decided_by`/`decided_at` 从 auth 派生；`rejected` 必须 `decided_note`；结构化 F281 why 在 W4+ 接入，不阻塞首闭环。`payload_json` 只作展示，不存 secrets。
- Approval inbox 唯一数据源是 `approvals`；`messages.rich_blocks_json` 的 kind 不含 approval，agent 不能通过聊天伪造审批项；`messages.kind='approval_pointer'` 只做导航。request/decide/materialization 同事务写 audit；effect owner 仍是 merge/review/artifact/task/budget 的唯一真相。
- `handoffs` 的状态真相是 `status`：terminal 优先；否则有 active `handoff_holder_claims` → `claimed`，无 active claim → `pending`。`claimed_by_run_id/claimed_at/claimed_lease_until/last_heartbeat_at` 只做 single-mode summary；parallel 以 per-holder claim 子账本为准。`canonical_action_key` 的 partial unique live index 保证同一 action identity 同时最多一个 pending/claimed handoff；fresh revision 新建 terminal 旧行之外的新行，`generation=1`。
- `handoff_holder_claims` 是 per-holder claim 子账本：`status ∈ active|released|interrupted`；`generation` 必须等于 handoff generation；一个 active run 至多 claim 一个 handoff；claim lease/heartbeat 只服务 liveness，不是 action custody TTL。
- `custody_events.kind ∈ handoff.created|handoff.dispatched|handoff.claimed|handoff.returned|handoff.replaced|handoff.completion_candidate|handoff.completed|handoff.parallel_unfinished|handoff.withdrawn|handoff.expired|handoff.recovered`；`classification ∈ state-changing|informational`；per-handoff `seq` 单调；与 `audit` 一样加 `BEFORE UPDATE/DELETE ... RAISE(ABORT)`，append-only。
- `waits.kind ∈ timer|event|managed_command`；event 型必须有 `expected_signal`，否则 fail closed；所有 kind 必须有 `wait_source_ref`/`sla_until`/`owner_fence_json`。`waits` 只驱动唤醒；过期裁决只看 handoff explicit deadline，claim lease stale 只触发 run interrupted recovery。
- `custody_events` 是 append-only handoff custody 审计，复用 clowder F233 的事件语义；不引入新的“球 ID”，投影从事件与引用推导。状态真相在 `handoffs`；重放必须与 `handoffs` 对账，偏差告警。wait 的 canonical 终止事实在 `wait_terminations`，不塞进 `custody_events`。
- `waits` 按 `(wait_id,generation)` 一行：`id='wait:<wait_id>:g<generation>'`，同 series 至多一个 `active`；`owner_fence_json` 只能是 `containing_task` 或 `action_successor`，不可从 mutable task 字段重建；`auto_renew=1` 时 match 同事务 terminalize gN + insert gN+1。`wait_terminations` 是 canonical `wait.terminated` 事件（user_cancel 严格 actor=owner），与 `waits.outcome_json` 同事务写；缺 exact owner fence 的旧 wait 迁移为 `legacy_unfenced`，no message/no queue/no wake。
- `memory` 是独立 `CODETEAM_DATA_DIR/memory.db` 派生索引，不是 control store；表定义见 `codeteam/architecture/memory-schema.md`，不写进本 §12.2。禁 ATTACH control/memory 跨库 join；memory.db 不进 control 备份清单。
- `telemetry_trace_spans` 是 **optional（v1 default off）；db: control**；DDL 见 A3-3 observability。启用时必须带 retention sweep 与 `hmac_invocation_id`/`salt_version`；不启用则无此表。
- `tool_usage_counters(day, profile_id, category, tool_name, count, first_seen_at, last_seen_at)` 是 F150 独立 counter（db: control），不是 OTel projection；只记 metadata，retention 由 `CODETEAM_TOOL_USAGE_RETENTION_DAYS` sweep。F130 日志是 `CODETEAM_LOG_DIR` 下的 JSON/Pino 文件，不进 DB。
- `runs` 不直连 pi session：一律经 `agent_session_id` join `agent_sessions`，避免双 session 字段边界不清。
- `reviews` / `verifications` 的 `head_sha` 是被审版本的硬绑定；head 变化即作废。
- `reviews` 记录 author/reviewer 的 model + family 四元组，供跨族 review 审计。
- `forge_deliveries` 持久化 webhook delivery id / natural key / retry_count / processed_at；daemon 重启后仍能去重与对账。
- GitHub signals v1（2026-10-25 review）：默认 polling 主路径；webhook opt-in（`CODETEAM_GITHUB_WEBHOOK_ENABLED=0`），经 operator 反代/tunnel TLS 终止后转发到 A1-4 的 loopback daemon；HMAC 用 constant-time compare，body 有上限；`forge_deliveries` 按 `(provider, delivery_id)` claim。
- GitHub signals 的 collector state 只写 `tasks.automation_state_json`（review/ci/conflict/issue），不复制 `await`/`waitOutcome`；wait contract 在 `waits.baseline_json`/`continuation_json`/`outcome_json`。`audit` 只记 state-changing observation（matched/terminal/rearm_failed/migration/dedup/permission-denied），no-match tick 不写 audit。
- GitHub tracking status 是从 `tasks(kind=pr_tracking|issue_tracking)` + `waits` 的纯派生只读投影（observing/stopped(reason)/unarmed + predicates/generation/expires/last outcome/lag），不建第三套 status store；W7a 读面。
- GitHub review/CI 事实只进 `waits.outcome_json` / `tasks.automation_state_json`，不写 W3 `reviews` 表；`reviews` 是内部 ReviewPolicy 的 verdict。GitHub tracking waits 显式写 `expires_at`（默认 7d），非 GitHub event wait 的“缺省无时间终止”不适用于它。
- 2026-10-25 operator 拍 `DP-GH-1=A` / `DP-GH-2=A`：W8 v1 GitHub-only；observation 复用 `tasks`/`waits`/`audit`/`forge_deliveries`，不建第二账本；audit 只记 state-changing observation；webhook 默认关、经反代/tunnel 到 loopback；tracking status 从 tasks+waits 派生。
- 2026-10-25 operator 拍 `DP-PLUGIN-1=A` / `DP-PLUGIN-2=A`：v1 plugin 只取 **skill surface**——repo-local curated `SKILL.md` + 瘦身 `manifest.yaml`，frontmatter 是 name/description/triggers 唯一权威，manifest 只留 category/not_for/output/next/sop_step；role allowlist 在 `agent_profiles.restrictions_json.skills`；index 常驻、正文按需；`nextSkill` 经 repo read，不承诺 mid-session loader 注入；无 plugin inventory/registry/Broker/runtime/marketplace，无 HOME/global mount；`tips_exempt` drop；skill 目录不在 agent 可读面，多文件 skill fork 时合并。**无新表/新列**。
- `verifications.producing_review_id` 记录 falsifier 来自哪个 review，防止 reviewer 通过 verifier 间接执行任意命令而无法追溯。
- `inbox` 的 `kind` 必须是 typed：`steer | followUp | humanGuidance`。

### 12.3 事务与并发

- SQLite WAL 模式；foreign keys on。
- 每个 run lane 迁移、handoff claim、run terminal 在一个事务里提交。
- 所有状态更新使用 compare-and-set（version / updated_at / status）。
- artifact 写入先写临时文件，fsync，rename，再写 metadata；内容 hash 校验。
- 单 task 单写者用 worktree lock + `queue_entries` claim 双重保护；worker lease 是 W5 worker registry 的扩展，不在 W1 造旁路 lease 表。
- `(source_id, recipient_profile_id)` 至多一个 `status='running'` 的 run：由 cutover 单事务保证，并用 partial unique index 兜底；违例是 bug，不是可重试状态。
- 多进程访问同一 SQLite 时，用短事务 + busy timeout；不要长事务持有锁。

### 12.4 恢复算法

启动时：

1. 读取所有 `running` runs。
2. 与活跃 worker 集合比对；不在集合里的标记 `interrupted`。
3. 释放其 claimed handoff，回到 `pending`。
4. 扫描过期 handoff，标记 `expired` 并重排/升级。
5. 重建 loop guard 计数。
6. 触发 dirty-bit drain。

当前实现 `recoverInterruptedRuns` + `hydrate` 已覆盖核心逻辑；目标态需要把 stage/artifact/inbox 一起纳入。

### 12.5 保留与 GC

- `run_events`：按 task 保留；完成后可归档压缩。
- artifacts：完成后保留 diff/test/review/merge；中间 tool output 可 TTL。
- pi session：按 task 保留；过期 session 可导出为 artifact 后删除。
- worktree：merge/close 后清理；失败 task 保留现场。
- 默认不删除 audit。

### 12.6 调度层：ADR-043/F117 dispatch queue + A2A 执行链 + F139 schedule

codeteam 的调度分三层，不能合并：

| 层 | clowder 真相源 | codeteam 用法 | 不做什么 |
|---|---|---|---|
| Dispatch queue | ADR-043 / F117 Phase D（F122 历史） | 所有 pending work（operator/agent/connector）落 Queue Entry；`targets[]`、`dispatchRefs`、response bubble、Active Run、steer、one terminal | 不另造执行队列；`handoff`/`inbox` 只是来源/投影 |
| Task readiness / admission | codeteam-specific | priority、dependency DAG、budget/quota、worktree pool、worker capacity；决定哪条 task 可以 enqueue/claim | 不另造 drain/comparator |
| Proactive schedule | F139 `TaskSpec_P1` + `RunLedger` | cron/interval/event 维护任务（CI 轮询、stale 清理、repo scan）；触发后生成 Queue Entry | 不作为即时 task dispatch；不另造 cron poller |

规则：

1. **唯一 pending-wake 真相 = Queue Entry**；`handoff(pending)` / `inbox(pending)` 只是 typed source/admission，不是第二队列。
2. **唯一 drain/comparator = ADR-043/F117 dispatch queue**；task priority/DAG 只决定 admission 顺序，不能另起 poller。
3. **F139 只用于主动 schedule**；TaskSpec 的 Trigger/Admission/Run/State/Outcome 复用，代码域只加 adapter。
4. **codeteam-specific**：task DAG、worktree pool、budget、worker registry/sticky/re-attach 保留，但必须通过 Queue Entry 执行。
5. F122 旧文档中的 per-target 拆行 / steer 预留是历史；当前以 ADR-043 + F117 Phase D 的 single-ledger 为准。
6. **queue 多 recipient 恒 parallel**：`QueueProcessor` 按 `recipients>1 ? parallel : serial` 分派，不看 intent；`ideate` 只在无 `targetDispatchMode` 的直调路径作兜底。链式 serial 来自“每跳独立 source + 单 recipient”的结构。
7. **routeIntent 只读 typed 字段**：`a2a_send`/`multi_mention` 显式传入；不解析正文 `#ideate`/`@`（D23）。
8. **A2A chain metadata 持久化**：`runs.chain_metadata_json` 保存 `a2aCount/maxDepth/streakPair`；重启后 reaper/drain 用同口径。
9. **单 active run 兜底**：`runs` 的 `(source_id, recipient_profile_id) WHERE status='running'` partial unique index；违例是 bug。

---

## 13. Workspace 与 Git

### 13.1 单 task 单 worktree

```text
repo/
  .git/
  worktrees/
    task-123/        # branch codeteam/task-123
```

- `base_ref` / `base_sha` 在 task 创建时固定。
- 每个 task 一个 branch；不允许两个 task 共用同一个 worktree。
- coder 在 worktree 内修改；review/verify 的 task worktree 只读挂载；取证写仅限隔离 **evidence worktree**（disposable copy 的泛化）。
- evidence worktree 的基准固定为 **base_sha + coder diff 的 clean checkout**，不含 uncommitted 修改；同 task 峰值 ≤2 份，计入 W5 pool。
- merge 前检查 base 是否前进：
  - 冲突 → 回到 implement；
  - 无冲突但 base 前进 → 强制 rebase + targeted test + fast re-review；旧 review/verification 作废。
- 任何 review/verification artifact 必须绑定 `headSha`；head 变化即失效。

### 13.2 Diff 与证据

- `git diff --binary <base_sha>...<head_sha>` 生成 diff artifact。
- 记录 changed files、insertions/deletions、renamed files。
- test report 记录 exact command、cwd、exit code、duration、stdout/stderr tail。
- review request 只带 diff + test report + impact surface + 约束，不带 author transcript。
- review/verification 记录 `headSha` 和 `producingReviewId`；恢复时先校验 head 是否仍匹配。

### 13.3 Merge

v1：agent 只出 diff/evidence；gate 通过后由 merge owner（`DP-MERGE-1=D`：daemon service principal，非 agent）执行 merge protected branch；operator 只守硬门。

最小录入通道：

- **W1–W6**：`codeteam merge record` CLI 录入 `baseSha/headSha/mergeSha` + `executedBy`/`gateEvidenceRef`/`reviewRef`/`status`/`failureRef`；`DP-MERGE-1=D` 的 Q5 已冻结，`approvals.decidedBy` 不动。
- **W7**：Console M0 审批/merge 卡片。
- **W8**：GitHub merge 事件生成 merge receipt artifact；merge owner 执行路径可直接观察 PR merged truth。
- **MergeExecutor adapter**：W0–W4 dogfood 用 local adapter（git merge + branch/receipt reconciliation）；W8 用 GitHub adapter（PR merge API + reconciliation）；两者共用 `merges` receipt、`service:merge-owner`、服务端 E1–E5 核验与 audit，不建第二套 merge 路径。

C 类自动 merge 的前置条件（D 的 merge owner 执行不属于自动 merge）：

- 连续 N 个 task 的 review FP/recall 达标
- verifier 覆盖关键风险
- merge policy 明确
- 可一键回滚

### 13.4 CI

- verifier 执行项目定义的 exact commands。
- CI 作为独立证据源，不能由 agent 自报“测试通过”。
- CI log 作为 artifact，hash 绑定 commit SHA。
- 外部 CI 失败时，task 回到 implement/review，而不是假装通过。

---

## 14. 安全模型

### 14.1 威胁模型

- repo / issue / PR comment / 依赖中的 prompt injection
- 第三方 PR comment 触发 task/handoff（webhook 验签只证明来自 GitHub，不证明有权限）
- 模型执行危险 shell 命令
- 路径穿越 / symlink / hardlink 逃逸
- secret 泄露到模型上下文、env 或日志
- 恶意依赖 / supply chain
- reviewer 被 author 的 summary 带偏
- reviewer 通过 falsifier 让 verifier 执行任意命令
- agent 自评低风险绕过 gate
- 多 agent 同时写同一 worktree
- 外部 MCP server 伪造身份 / token 粒度不足

### 14.2 身份与授权

- Operator：唯一可做不可逆决策的主体。
- **AgentSession 是具体执行身份**；每个 run 生成 per-run token，绑定 `(runId, taskId, role, agentSessionId)`。
- MCP server 从 token 派生身份，tool args 不携带 `from` / `role`；服务端查表授权，不信任模型声明。
- per-run token 由 daemon 在创建 run/session 时铸：
  - SDK：extension factory 闭包注入；
  - RPC：`/run/codeteam/tokens/<runId>.token`（0600）注入；目录前缀硬 deny；
  - **不要放 env**，避免同 worker 内跨 run 冒用。
- run terminal / interrupted 时显式撤销 token；恢复流程生成新 token，不复用旧凭据。
- Reviewer/verifier 不能修改源码；工具 allowlist 强制。
- routine own-PR merge 走 merge gate + merge owner；push/delete/force-push/第三方 merge 需要 human/policy gate。

鉴权矩阵：

| Auth domain | Credential | 可调用 |
|---|---|---|
| Operator | Console/CLI 登录凭据 | thread chat / approve / 硬门 merge / 配置 / 不可逆操作 |
| Run | per-run token | MCP 工具、agent 回复、read/artifact/memory、`approval_request`（仅创建 proposal）；**不可** approval decide / merge |
| Forge | webhook HMAC | W8 inbound 事件；不可直接改 work state |

approval decide 端点只接受 operator credential；routine merge 只由 daemon `merge:execute`（`DP-MERGE-1=D`）执行，无 MCP/REST 暴露；run token 访问 approval decide/merge execute 必须 403；MCP 工具面不暴露 approval decide/merge execution，但允许 `approval_request` 创建 proposal。

thread chat 是普通消息写入，不属于不可逆操作：operator 用 operator credential，agent 回复由 daemon 以 run token 归属写入；两者都不获得 approval decide / merge-owner 权限。

Approval inbox 的唯一数据源是 `approvals` 表；`messages.rich_blocks_json` 不允许产生 approval 项，agent 伪造审批卡不得进入可审批列表（W2 威胁测试）。

### 14.3 Sandbox

pi 没有内置 permission system；extension 的 `tool_call` 是 advisory，不是硬边界。生产级隔离：

- 每个 worker 一个 container / microVM / 低权 OS user；D3=A 已定：MVP **低权 user + bwrap**，目标态 **container**，microVM 后置。
- 只挂载 task worktree，不挂载整个 home。
- **MVP 网络边界**：bwrap 的 netns 是二值，不能同时做到“默认关网 + loopback MCP + provider API”。MVP 显式接受 agent 进程网络开放为已知威胁模型边界，靠零 secret + 路径 policy + audit 兜底；目标态 container 再做真 allowlist。
- daemon 数据（SQLite / artifact / token）固定在仓外目录；dogfood worktree 用外部目录，分支只在本地，进入目标仓 main 必须走 operator + 目标仓自己的 PR/review。
- review/verify 的 task worktree 只读挂载；取证写仅限隔离 evidence worktree。
- **v1 agent 进程零 secret**：push、publish、部署等凭证操作交 human/CI 执行；agent 只产出 diff/evidence。
- v2 如果确实需要 agent 调 secret API，用受信 sidecar 在网络层注入 header，agent 不可见。
- 资源限制：CPU / memory / disk / wall time / output bytes。

### 14.4 文件与命令策略

当前 `verifier/policy.ts` 已实现：

- worktree + realpath containment
- 拒绝 absolute path、`..`、secret path、symlink escape
- read-only executable allowlist：`grep` / `rg` / `diff` / `ls` / `cat`
- 拒绝 shell operators：`; | & < > \` $
 #`
- 拒绝 dangerous flags（如 `rg --pre`）
- strict 模式禁止 Node；repro 模式只允许 `node --test`
- timeout / output cap / minimal env / audit

补充规则：

- finding 创建时用 verifier 同一 policy 预校验 falsifier 可执行性；失败只降级该 finding（P1/P2 → P3），不整条 review 拒绝。
- `blocked` 仅限基础设施故障（无法启动、timeout、output cap、二进制不存在）；命令正常完成且 exit≠expected 一律 confirmed/rejected；blocked 到期升级 human。
- falsifier 只能引用 worktree 内相对路径；audit 记录 `producingReviewId`。
- GitHub issue / PR comment → task/inbox 统一要求 maintainer/collaborator；label/mention 只作叠加 opt-in，不单独放行；其余只落只读 evidence。

已知边界：

- test code 仍可写文件/联网；Phase 4 需要 OS sandbox / 低权用户。
- coder 的 `bash` 仍比 verifier 宽；需要 permission wrapper 下沉到工具实现。
- 真实 repo 首次使用必须用专属低权用户；最坏情况是浪费一个 worktree，不是损坏资产。

### 14.5 Prompt injection

- repo 内容、issue、PR comment、依赖 README 都标记为 untrusted data。
- 不执行其中的“指令”，只把它当事实来源。
- 工具权限和 sandbox 是硬边界。
- review/verification 只看 evidence，不执行 author 的指令。
- 外部 claim 走 source-audit。
- GitHub comment 正文进 prompt 前必须经过权限门禁和 untrusted 包装。

### 14.6 审计

记录：

- full args（不是 hash）
- cwd
- exit code
- duration
- stdout/stderr tail（截断）
- 环境白名单
- artifact refs
- actor / run / task / handoff / agentSession ID
- `producingReviewId`（verification 执行 reviewer 提供的 falsifier 时）

审计日志不可由 agent 修改；只追加。SQLite 层用 `BEFORE UPDATE/DELETE ... RAISE(ABORT)` trigger 防篡改。

---

## 15. 失败处理与恢复

### 15.1 失败分类

| 类别 | 例子 | 处理 |
|---|---|---|
| Model error | provider 5xx、context overflow | retry/backoff、降模型、compact |
| Tool error | 命令失败、文件不存在 | 结构化 tool result，agent 自修 |
| Policy denial | 危险命令、路径逃逸 | 返回拒绝原因，agent 换方案 |
| Timeout | 测试/构建超时 | 终止、记录、升级或重试 |
| Crash | 进程被杀、机器重启 | startup recovery，run interrupted，handoff 回 pending |
| Stale lease | claim 后无心跳 | deadline/lease expiry 回收 |
| Duplicate delivery | 重复 handoff / terminal | idempotency key + one terminal |
| Missing artifact | required artifact 不存在 | gate fail，回到上一 stage |
| Settled nonconforming | agent 正常结束但缺 required artifact/handoff | 结构化重试一次；仍缺 failed + loop guard |
| Merge conflict | base 前进 | 回到 implement，重新 rebase/test |

### 15.2 重试策略

- 每个 run 有 max attempts。
- 模型错误：指数退避 + fallback provider。
- 工具错误：不自动重试有副作用的命令；只重试幂等读取。
- 超过 max attempts：创建 `blocker` handoff，升级 human。
- 失败 run 保留 run_events 和 audit，不覆盖。

### 15.3 幂等

- handoff `idempotencyKey` 唯一。
- `complete` 已 consumed 返回原结果。
- artifact 内容 hash 去重。
- MCP `a2a_send` / `handoff_create` 带 requestId，服务端去重。
- 任何外部副作用工具必须声明 `replay: "safe" | "unsafe"`（durable 语义）。

### 15.4 回滚

- worktree 丢弃 / branch reset（人类授权）。
- artifact 版本不可变；回滚产生新 task 或新 attempt。
- merge 回滚用 revert，不用 force push。
- schema 迁移必须可回滚或向前兼容。

---

## 16. 可观测性与 Eval

### 16.1 事件

至少记录：

- `task_created` / `stage_changed` / `run_started` / `run_terminal`
- `thread_created` / `thread_updated` / `agent_session_started` / `agent_session_closed`
- `handoff_created` / `claimed` / `consumed` / `expired`
- `tool_call` / `tool_result` / `policy_denied`
- `gate_result` / `review_verdict` / `finding_verification`
- `artifact_created` / `merge_receipt`
- `budget_warning` / `budget_exhausted`
- `recovery` / `interrupted`

### 16.2 指标

- task 成功率
- first-pass review 通过率
- review FP rate / recall / finding survival
- time to green
- cost per merged change
- human intervention rate
- crash recovery correctness
- tool error rate
- gate pass/block 分布
- per-provider / per-role 指标

### 16.3 Eval 语料

- seeded bugs：测修复能力和 review recall
- clean diffs：测 false positive
- 负对照：reviewer 不应该在干净 diff 上编造 P1
- 多 provider：DeepSeek / Kimi / GLM / Qwen
- 多 repo：fixture + 真实小仓
- 预注册门槛，不事后调整

当前 Phase 2 eval：5 clean + 5 seeded，reviewer 仅 `kimi-coding/k3-256k`，clean FP 0/5，seeded recall 5/5，finding survival 5/5。GLM/Kimi 的 review smoke 是独立证据，不并入 eval；下一步扩大并加入多 provider。

### 16.4 Gate 健康

- 每个 gate 的通过率、block 原因、false block/pass。
- 连续 >95% 通过且从未 block 的 gate 标记剪枝候选。
- 不要让 gate 变成流程装饰。

---

## 17. 部署与运维

### 17.1 单机 MVP

```text
codeteam daemon
  ├── SQLite control store
  ├── scheduler / A2A bus
  ├── artifact store
  ├── MCP server (team/backlog/sop/workitem/artifact/memory)
  └── N pi RPC workers (architect/coder/reviewer/verifier)
        └── git worktrees + sandbox
```

- Node.js >= 22.19（pi 要求）。
- SQLite + 文件系统即可；不引入 Redis/消息队列。
- 每个 worker 一个 pi 进程或 SDK session。
- 默认单机；远程 worker 后续加。

### 17.2 远程 worker

- worker 通过 HTTPS/SSH 接 daemon。
- artifact 上传到内容寻址存储。
- 每个 worker 一个 sandbox；daemon 不直接执行 shell。
- lease/heartbeat；失联回收。

### 17.3 资源与预算

- per-task token/cost/wall-time budget。
- per-provider concurrency limit。
- per-worktree disk quota。
- 超预算：pause + human 决策，不静默继续。

### 17.4 备份与恢复

- SQLite 定期备份；WAL checkpoint。
- artifact store 只追加；备份 manifest。
- worktree 可重建；保留 diff/commit 即可。
- 恢复演练：从 SQLite + artifacts 重建 task 状态。

### 17.5 升级

- pin pi tag/commit；`UPSTREAM.md` 记录。
- SQLite schema migration；向前兼容。
- 双版本 dual-run 验证；可回滚。
- 每次升级跑上游测试 + codeteam 测试 + fixture E2E。

### 17.6 配置示例

```yaml
project: my-repo
repo: /home/me/code/my-repo
worktreeRoot: /home/me/code/.codeteam/worktrees
models:
  architect: deepseek/deepseek-v4-pro
  coder: kimi-coding/k3-256k
  reviewer: zai/glm-5.2
  verifier: deepseek/deepseek-flash
roles:
  reviewer:
    tools: [read, grep, find, ls]
    freshContext: true
  verifier:
    tools: [read, bash, grep, find, ls]
    freshContext: true
policy:
  merge: merge_owner
  sandbox: container
  shell: deny-by-default
budgets:
  taskTokens: 500000
  taskCostUsd: 5
  wallTimeMinutes: 60
```

---

## 18. 从 clowder 继承什么，裁剪什么

判断标准不是“是否 clowder”，而是“是否服务于代码交付”。能服务于代码交付的 clowder 概念默认保留；只有与代码交付无关的能力才 drop。

| 决策 | clowder 特性 | codeteam |
|---|---|---|
| 保留 | typed handoff / 球权 / one terminal / deadline / loop guard / startup recovery | 作为 A2A control plane 的核心 |
| 保留 | thread 消息 / operator↔agent 聊天 | `Message` + typed inbox；A2A 仍走 handoff |
| 保留 | 独立 review、证据闭环、merge gate、风险路由 | review/verifier 的基础 |
| 保留 | SOP 作为告示牌 + 点状 gate，不做强制 stage controller | `WorkflowSop` + gate + skill |
| 保留 | L0 压缩免疫、记忆证据可回源、eval 数据驱动 | prompt/context/eval 设计 |
| 保留 | GitHub/GitLab forge connector | 工作入口 + 代码证据源 + 交付出口，不是 IM |
| 保留 | Web Console 作为 operator surface | 见 §3.4 M0/M1；dogfood 期 C（接入现成 Hub），产品期 A（同构 + 复用/fork 组件） |
| 简化 | 40 文件球权状态机 | per-holder claim CAS + handoff 状态机 |
| 简化 | 45 个 prompt hooks | pi `context` / `before_agent_start` / sections |
| 简化 | 八层记忆 | evidence + FTS + decision/lesson |
| 简化 | eval hub | task outcome 表 + 少量指标 |
| 后续 | 多项目、远程 worker、scheduler、完整 console 扩展、插件包 | 等单 task 闭环稳定后再做 |
| 不做 | 猫猫人格、voice、日记、meeting、video、IM 网关（飞书/Telegram/微信/钉钉）、群聊/社交 feed、marketplace、多租户 | 与代码交付无关；thread 内 operator↔agent 聊天与 Forge connector 单独保留 |

### 18.1 Forge Connector：GitHub/GitLab 不是 IM 网关

GitHub connector 不应该归到 IM 网关。两者架构位置不同：

| 类型 | 例子 | 作用 | codeteam |
|---|---|---|---|
| IM 网关 | 飞书、Telegram、微信、钉钉 | 人的聊天入口/通知出口 | 后续可选，不是核心 |
| Forge connector | GitHub、GitLab、Gitea | 工作入口 + 代码证据源 + 交付出口 | **应该做，first-class** |

职责：

- **Inbound**：issue、PR、review comment、CI/check、merge 事件 → `Task` / `Handoff` / `InboxItem`
- **Outbound**：review verdict、finding、test report、PR 状态、artifact 链接 → PR comment / check / status
- **Evidence**：PR head SHA、CI 结果、review 状态、merge commit → `Artifact`
- **Trigger**：issue opened、PR updated、review submitted、CI completed → scheduler 事件
- **Identity**：GitHub App / token 绑定项目；webhook 验签；delivery id 幂等；模型不能持有 operator token

v1 范围：

1. issue → `BacklogItem(status=suggested/approved)` → dispatch → thread → task
2. PR → review/merge evidence
3. CI → verification artifact
4. issue / PR comment → task / review feedback / inbox：仅 maintainer/collaborator；label/mention 只作叠加 opt-in；其余只读 evidence
5. merge owner 在 gate 后触发/执行合并；GitHub 只作为证据和交付出口

Webhook 只做触发，GitHub API 做对账真相源：收到事件时若对应 task 不存在，主动 fetch API 按 natural key（repo + issue/PR number）upsert；delivery id 持久化到 `forge_deliveries` 做重启后去重，不能解决乱序/丢失。

不做：自动 force push、C 类自动 merge、让模型直接持有 GitHub token；D 的 merge owner 执行通过 daemon 受信 credential，不是模型持 token。放在 W8 Forge Connector 下，作为第一个 Forge adapter；不要和 IM 网关捆在一起。

具体参考：

- F167：lease/handoff/ping-pong → 简化为 handoff CAS + loop guard。
- F275：work identity → task/stage/run/artifact 的稳定 ID。
- F280：wait contract → handoff deadline + inbox。
- F203：native L0 → pi native system prompt。
- F102/F188：evidence memory → SQLite evidence + provenance。
- F192：eval → task outcome + review corpus。
- F073：SOP guardian → WorkflowSop + gate。
- F217：merge gate → merge policy + merge owner + operator hard gates（`DP-MERGE-1=D`）。

---

## 19. 开源与 fork 策略

### 19.1 仓库

- fork 整个 `earendil-works/pi` monorepo，pin `v1.4.0`（`4a080252f06caf63a525d7873c5d94d3c23887e0`）。
- **Fork 是仓库形态，SDK-first 是默认开发方式；kernel 默认只读，零 patch 是合法状态。**
- `packages/codeteam` 是控制面，不重写 pi 工具/session。
- `packages/agent` / `packages/coding-agent` 只在必要时改。
- `packages/ai` 尽量不改；provider 已覆盖目标模型。

### 19.2 Patch 政策

每条 kernel patch 必须有：

1. 为什么 SDK/extension 做不到。
2. 对应测试。
3. 与上游的 diff 说明。
4. 是否可上游化。
5. 回滚方式。

维护 `KERNEL_GAPS.md`：当前 patch 列表、状态、上游 issue/PR。

### 19.3 上游同步

- `upstream` remote。
- 定期 fetch/rebase 到新 tag。
- 每次同步跑上游 `./test.sh` + codeteam vitest + fixture E2E。
- `UPSTREAM.md` 记录 tag/commit/修改文件/同步日期/冲突处理。
- 不直接改 `node_modules`；不复制上游源码到 `src/vendor` 后手工 diff。

### 19.4 许可与品牌

- 保留 MIT LICENSE 和上游 attribution。
- codeteam 自己的代码可以用 MIT/Apache-2.0；角色包/skill 可以单独许可。
- 不使用 pi 商标造成混淆；保留 “built on pi” 说明。
- 供应链：pin 依赖、lockfile、审计、最小权限。

### 19.5 包拆分

建议：

- `@codeteam/core`：控制面、SOP 契约适配（WorkflowSop/BacklogItem）、A2A、review、verifier、eval。
- `@codeteam/pi-adapter`：session factory、L0 compiler、context injection、custom tools。
- `@codeteam/cli`：CLI/daemon。
- `@codeteam/mcp`：MCP server（team/backlog/sop/workitem/artifact/memory）。
- `@codeteam/skills`：角色 skill / SOP pack。
- `@codeteam/eval`：corpus + scoring + report。

---

## 20. 路线图

### Phase 0–4（已落地）

- Phase 0：控制面 wire test、SQLite、pi SDK adapter、provider smoke。
- Phase 1：verifier + permission wrapper。
- Phase 2：clean/seeded review eval。
- Phase 3：typed handoff + SOP 编排 + merge gate（历史表述；现行按 `DP-MERGE-1=D` 的 merge owner 执行）。
- Phase 4：CLI adapter + CI。

### Phase 5：运行时硬化（W0–W3）

- W0a：外部仓 fork/bootstrap + 文档迁移 + 基线对码 + L0 compaction/cache spike；W0b：upstream/CI 治理并行。
- W1：backlog_items / workflow_sops / threads / messages / roles / agent_profiles / agent_sessions / stages（纯快照）/ run_events / artifacts / inbox / approvals / reviews / verifications / merges / budgets schema。
- W2：权限 wrapper 下沉 + 低权 user/bwrap（MVP，网络开放为已知边界）/ container（目标态，allowlist）+ per-run token + 零 secret。
- W3：独立 review（modelFamily + fresh + blind + falsifier）+ head SHA 绑定 + falsifier policy 预校验。

### Phase 6：SOP 复用（W4）

- 全面复用 clowder SOP：feature/backlog 级 `WorkflowSop` + `BacklogItem` + 风险车道 + 点状硬门禁。
- Design Gate：机器默认，critical/spec_change 才 human。
- risk classifier 两段式：pre-diff 初判 + post-diff 复核，只升不降。
- spec_change / plan_revision 审批。
- gate 自身 eval。
- merge policy 可配置。

### Phase 7：多 task + memory/eval（W5–W6）

- W5：复用 A2A 投递内核 + Ball custody/wait contract + 多 task 调度 + RPC worker 三语义（per-run policy、session 亲和、re-attach）。
- W6：复用 clowder memory/eval primitives（thread recall、evidence search、session digest、task outcome、lessons、eval harness）；检索按需 FTS5 / hybrid。
- task outcome episodes。
- 多 provider / 多 repo 语料。
- model-role matrix 数据化。

### Phase 8：产品化（W7–W8）

- W7：W7a headless API/鉴权/事件重放/CLI（可前置）；W7b 前端壳。dogfood 期 C（接入现成 Hub），产品期 A（同构 + 复用/fork 组件）；M0 = 看 + 聊 + 批，M1 后置。
- W8：GitHub/GitLab Forge connector 只读 evidence + comment 权限门禁 + API 对账；outbound comment/check 后置。
- daemon JSON events + MCP server。
- remote workers、多项目、插件/角色包。

### 路线图映射

| Phase | Workstream |
|---|---|
| Phase 5 | W0 / W1 / W2 / W3 |
| Phase 6 | W4 |
| Phase 7 | W5 / W6 |
| Phase 8 | W7 / W8 |
| 后续 | 完整 console 扩展、多项目、远程 worker |

### 验收指标

- first-pass review 通过率
- review FP/recall/survival
- time to green
- cost per merged change
- human intervention rate
- crash recovery correctness
- task success rate
- gate block reasons

## 21. 开放问题

已在 `0003-review-resolutions.md` 决议的事项不再列为开放问题（AgentInstance、Console M0、secret、GitHub comment 门禁、design gate、独立 review、Thread 持久化、merge receipt 路径）。

开放问题以 `plans/0001-runtime-hardening.md §7` 为单一来源；本节不再复制清单，避免两份文档漂移。

---

## 22. 附录

### A. 当前代码映射

| 能力 | 文件 |
|---|---|
| 控制面 | `packages/codeteam/src/control-plane.ts` |
| 类型 | `packages/codeteam/src/types.ts` |
| SQLite | `packages/codeteam/src/sqlite-store.ts` |
| Workflow | `packages/codeteam/src/workflow.ts` |
| pi adapter | `packages/codeteam/src/adapters/pi-session.ts` |
| Phase3 orchestration | `packages/codeteam/src/orchestrator.ts` |
| Review parser | `packages/codeteam/src/review/parser.ts` |
| Verifier policy | `packages/codeteam/src/verifier/policy.ts` |
| Finding closure | `packages/codeteam/src/verifier/closure.ts` |
| Eval scoring | `packages/codeteam/src/eval/scoring.ts` |
| CLI demo | `packages/codeteam/src/cli.ts` |

### B. 术语

- **Task**：用户可见的工作单元。
- **BacklogItem**：feature/backlog 级工作项，是 SOP 的作用域；复用 clowder 形状。
- **WorkflowSop**：feature/backlog 级 SOP 告示牌（stage/baton/nextSkill/resumeCapsule/checks）；不是控制器。
- **Stage**：纯快照（run/lane/status），不是 SOP 控制器；SOP stage 在 `WorkflowSop` 中，是告示牌。
- **Role**：动态 role id（内置 architect/coder/reviewer/verifier；前端可加 writer 等自定义 role）；不是闭集枚举。
- **AgentProfile**：稳定逻辑身份（对应 clowder catId + CatConfig）；`role` 是 primary role；一个 role 可有多个 profile。
- **AgentSession**：某个 profile 在 thread/task/stage 以某个 role 的一次执行；同一 profile 换 session 不算独立 review。
- **Run**：一次 role agent 调用。
- **Message**：operator↔agent 以及 agent↔agent 的讨论消息；责任转移用 Handoff，不用讨论消息替代。
- **RichBlock**：复用 clowder rich block 结构，挂到 Message 或 Artifact。
- **Ball custody**：谁持有当前工作；由 Handoff 状态机实现，叠加代码 gate。
- **Approval**：Approval Hub 的 proposal/card/owner decision/expiry。
- **Handoff**：typed A2A 控制消息。
- **daemon halt**：A1-4 的进程树级生命周期操作，由 external executor 执行；不是 run 级取消。
- **run halt/cancel**：A1-3 的 run 级终止，认 durable running + liveness witness；daemon halt 后 run 由 recovery 收敛为 interrupted，两个 halt 不互调。
- **Artifact**：不可变证据文件。
- **Finding**：reviewer 提出的 claim + falsifier。
- **Verification**：verifier 执行 falsifier 的结果。
- **Gate**：机器/人类可判定的点状门禁；不以 stage 迁移触发。
- **L0**：压缩免疫的 native system prompt。
- **L1**：按需加载的 stage/role skill。
- **L2**：每轮/每阶段注入的 task context。

### C. 参考

- 本目录架构：`README.md`、`0001`–`0003`；当前 thread 为讨论真相源
- pi 文档：`packages/coding-agent/docs/sdk.md`、`extensions.md`、`mcp.md`、`rpc.md`、`compaction.md`
- pi durable：`packages/durable/README.md`
- clowder 协同：`docs/architecture/collaboration-landscape.md`、`docs/features/F167-a2a-chain-quality.md`、`docs/features/F203-native-system-prompt-l0.md`

---

[宪宪/deepseek-flash🐾]
