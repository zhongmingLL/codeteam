---
feature_ids: [F001]
title: "codeteam architecture v1 — consolidated runtime contract"
status: reviewed
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [operator, architecture reviewer, security reviewer, product/UX reviewer]
created: 2026-10-21
updated: 2026-10-26
---

# F001: codeteam 架构 v1

> 这不是一个代码 feature，而是下一阶段实现和 review 的架构契约。
> 目标：把 2026-10-21 的讨论收敛成可实施、可验收、可反驳的架构基线。
>
> 本文件是契约入口；细节以 `architecture/0001–0003`、`plans/README.md` 与 `plans/0001–0005` 为准。若发现冲突，先回写本文件再实施。
>
> **工作区边界：** 本文件位于 codeteam 仓 `docs/`，这里是代码与契约真相源；`clowder-ai/codeteam/` 只保留迁移前的讨论历史。

---

## Why

codeteam 已经有一个能跑的控制面、pi SDK adapter、review/verifier/eval 的 MVP。但当前文档分散在 `architecture/0001–0003` 与 `plans/0001–0005`，且存在三个缺口：

1. **目标态不完整**：artifact/run_event/inbox/stage 等控制面对象还没有冻结。
2. **pi 接入边界不清晰**：哪些走 SDK、哪些走 extension/MCP/RPC、哪些必须 fork，需要一张统一地图。
3. **下一阶段优先级不清**：权限/沙箱、review 证据链、多 task、memory 谁先谁后，容易再次“边做边补”。

本 feature 把这些收敛成一份 architecture contract，供实现和 review 使用。

---

## Scope

1. 冻结 codeteam 的定位、非目标、设计原则。
2. 冻结领域模型：BacklogItem / WorkflowSop / Thread / Message / QueueEntry / RichBlock / Task / Stage（纯快照）/ AgentProfile / AgentSession / Run / RunEvent / Artifact / Handoff / CustodyEvent / Wait / Approval / Inbox / Review / Finding / Verification / Merge / Budget；不再有 AgentInstance。
3. 冻结 A2A 与球权硬规则：真实执行链是 `A2A ingress → InvocationQueue/QueueLedgerAdmission → QueueProcessor → AgentRouter → routeSerial/routeParallel → invokeSingleCat → AgentMessage/response/terminal`；F117 投递内核是执行真相（Queue Entry / response bubble / Active Run、one terminal、event-driven drain）；F233 `custody_events` 只作 append-only 审计；保留单槽 CAS、expected artifact、deadline、loop guard、idempotency、claimed→expired、canceled/withdrawn 与 wait contract；A2A 路由权威为 tool-call-first（`a2a_send` 讨论 / `handoff_create` 控制，文本 @ 不路由）。codeteam 复用 1–6/8–10 段编排，唯一执行内核替换点是 `invokeSingleCat → invokeSingleAgent → pi kernel`。
4. 全面复用 clowder SOP：feature/backlog 级 `BacklogItem` + `WorkflowSop` 告示牌、风险车道、点状硬门禁（worktree/design/review/verify/merge/completion）、resume capsule/baton；不做强制串行状态机。design gate 机器默认，critical/spec_change 才 human。
5. 冻结 pi 接入层次：full fork（仓库形态）+ SDK/extension-first（默认实现）、extension/MCP/RPC、fork patch 条件。
6. 给出运行时硬化计划：W0a/W0b–W8、验收和风险。
7. 明确 clowder 特性的 keep / simplify / later / drop。
8. 冻结 operator surface：Web Console M0 = 看 + 聊 + 批、M1 = 建 + 配 + 控；Thread Model 直接复用 clowder，cat session → role AgentSession 只做角色适配；CLI/GitHub/MCP 入口。
9. 冻结 Forge connector：GitHub/GitLab 作为工作入口/证据源/交付出口，不归 IM；所有进控制面的事件仅 maintainer/collaborator 可入，label/mention 只是叠加 opt-in，不单独放行。
10. 冻结独立 review：身份 + model family + fresh context + blind + falsifier；代码默认跨 model family，低风险文档允许同族非作者。

非目标：

- 本 feature 不实现完整多 task scheduler / console / remote worker。
- 不重写 pi agent loop / tool layer / session。
- 不引入 voice / IM 网关（飞书/Telegram/微信/钉钉）/ 群聊社交 / 多租户；保留 thread 内 operator↔agent 聊天框；GitHub/GitLab forge connector 不在 non-goal 内。
- 不把 C 类自动 merge 作为 v1 目标；`DP-MERGE-1=D` 的 merge owner 执行不是自动 merge。

---

## 交付物

- [`architecture/0001-codeteam-architecture-v1.md`](../architecture/0001-codeteam-architecture-v1.md)
- [`architecture/0002-pi-runtime-integration.md`](../architecture/0002-pi-runtime-integration.md)
- [`plans/0001-runtime-hardening.md`](../plans/0001-runtime-hardening.md)
- [`architecture/0003-review-resolutions.md`](../architecture/0003-review-resolutions.md)
- [`plans/README.md`](../plans/README.md)
- [`plans/0002-w0-w2-foundation.md`](../plans/0002-w0-w2-foundation.md)
- [`plans/0003-w3-w4-review-sop.md`](../plans/0003-w3-w4-review-sop.md)
- [`plans/0004-w5-w8-scale-product.md`](../plans/0004-w5-w8-scale-product.md)
- [`plans/0005-plan-review-resolutions.md`](../plans/0005-plan-review-resolutions.md)

---

## 验收标准

### A. 架构完整性

- [ ] 能用一张图解释 Interfaces → Control Plane → Role Runtime → Agent Kernel → Tool Plane → State → Eval。
- [ ] BacklogItem / WorkflowSop / Thread / Message / QueueEntry / RichBlock / Task / Stage / AgentProfile / AgentSession / Run / Artifact / Handoff / CustodyEvent / Wait / Approval / Finding / Verification / Merge / Budget 的关系和 ID 规则明确。
- [ ] AgentProfile（稳定身份）与 AgentSession（执行身份）边界明确；同一 profile 换 session 不算独立 review。
- [ ] 每个状态机有合法迁移、terminal、异常边。
- [ ] A2A 硬规则有实现映射：完整执行链、F117 内核三对象、one terminal、claimed→expired、canceled/withdrawn、complete claim 校验、方向白名单、wait contract；`routeSerial/routeParallel` 复用，`invokeSingleCat` 是唯一替换点。
- [ ] A2A 责任转移只能由 `handoff_create` / `handoff_*` 发起；正文 `@` 不产生投递；`Message.control_ref` 只由 daemon 回填。
- [ ] SOP 以 feature/backlog 级 `BacklogItem` + `WorkflowSop` 为作用域；task 绑定 backlog item；task done 不等于 feature completion。
- [ ] `WorkflowSop.stage` 是告示牌，不做强制迁移；硬约束只在 worktree/design/review/verify/merge/completion gate。
- [ ] Task/Run/Handoff/Artifact 的每个字段能映射 clowder 原语或标 `code-delivery-specific`；不存在第二套 queue/custody/message/SOP。
- [ ] `Stage` 只是 `run/lane/status` 纯快照；不存在以 stage 迁移为触发点的 gate 执行路径。
- [ ] `Role` 是动态 registry：内置 architect/coder/reviewer/verifier；前端可创建 writer 等自定义 role，不改核心代码；`human` 不是 Role。
- [ ] 唯一 pending-wake = ADR-043/F117 Queue Entry（F122 为历史文档）；`handoff`/`inbox` 只是 source；F139 schedule 触发后生成 Queue Entry；不存在第二队列/第二个 cron poller。
- [ ] `Task` 复用 clowder `TaskItem` 底座（kind/subjectKey/title/why/owner/status/relatedFeatureId/dispatchGate/probe/entrustedWork/deploymentWait）；代码字段仅作扩展；不另造任务系统。
- [ ] `AgentProfile.role` 是 primary role；`AgentSession.role` 可不同；独立 review 看 profile + session + modelFamily，不看 role。
- [ ] SOP 的 stage/gate/risk/fast lane 有可执行定义。
- [ ] L0/L1/L2 prompt 分层和压缩免疫机制明确。
- [ ] 安全边界明确：工具策略、sandbox、secret、审计、不可逆操作。
- [ ] 独立 review 的 modelFamily / fresh / blind / falsifier 规则明确。
- [ ] 失败分类、恢复算法、幂等策略明确。

### B. pi 接入可实施性

- [ ] 新增 tool 的五种方式有代码示例和适用场景。
- [ ] L0 的 CLI/SDK/extension/durable 四种通道有说明。
- [ ] RPC / CLI / SDK / durable 的区别和限制明确。
- [ ] MCP exposure / identity / auth 的坑写明。
- [ ] fork patch 的触发条件和 patch 政策写明。
- [ ] 当前 `createCodeteamSession` 的差距（L0 compiler、context capsule、custom tools）写明。
- [ ] RPC worker 三语义（per-run policy、session 亲和、re-attach）写明。
- [ ] per-run token 与零 secret 边界写明。

### C. 下一阶段可执行性

- [ ] W0a/W0b–W8 有顺序、依赖、验收；W7a headless 先于 W7b。
- [ ] 每项工作有“必须证明什么”。
- [ ] 风险有缓解方案。
- [ ] 需要 operator 拍板的问题单独列出。

### D. Operator Surface 与 Forge

- [ ] 明确 Web Console / CLI / GitHub / MCP 四个 operator 入口。
- [ ] 明确 Thread Model 直接复用 clowder；cat session → role AgentSession 只做角色适配，并绑定 taskId/role/stage。
- [ ] 明确 Web Console 只通过 daemon API/WS 访问，不直接读 DB。
- [ ] 明确 GitHub/GitLab 是 Forge connector，不是 IM 网关。
- [ ] 明确 Console M0 = 看 + 聊 + 批；M1 = 建 + 配 + 控。
- [ ] 明确 `Message` 持久化与 operator chat → typed inbox 的转换；A2A 讨论用 Message，责任转移仍只走 typed handoff。
- [ ] W4 approval CLI 覆盖 critical design / spec_change / merge，且审批只写 `approvals`。
- [ ] W7 前端载体按 C（dogfood）→ A（产品），W7a headless 先于 W7b。
- [ ] 明确所有进控制面的 GitHub issue/comment 仅 maintainer/collaborator 可入；label/mention 只是叠加 opt-in，不单独放行。
- [ ] 明确 v1 只做 issue/PR/CI/comment 的只读 evidence + 人工 merge。

### E. Review 可反驳性

- [ ] 架构 reviewer 能指出至少一个不成立的假设或遗漏。
- [ ] 安全 reviewer 能指出至少一个权限/沙箱缺口。
- [ ] 实现 reviewer 能指出至少一个与当前代码不一致的地方。
- [ ] 所有 finding 有明确处置：accept / modify / reject。

---

## 关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | SOP 是告示牌 + 点状硬门禁；推进权留给猫 | 机器只锁高风险 gate；避免把猫变成 workflow node（2026-10-24 由 D24 细化） |
| D2 | artifact 是真相源，transcript 是调试材料 | 可审查、可恢复、可跨模型 |
| D3 | Role / Model / AgentSession 解耦 | 换 provider 不改 SOP；AgentSession 是具体身份 |
| D4 | A2A 工作转移是 typed control plane；A2A 讨论用 Message（由 `a2a_send` 投递）；operator↔agent 聊天不是 A2A | 讨论可自然语言，责任转移必须 typed；防空转、防丢球、防重复 |
| D5 | 单 task 单 worktree 单写者 | 避免并发写冲突 |
| D6 | finding 由证据关闭 | review 不是表演 |
| D7 | v1 merge owner execution（`DP-MERGE-1=D`）；operator 守硬门 | routine merge 不由 operator 逐次执行；A 仅零-secret 临时偏差；C 类自动 merge 不做 |
| D8 | full fork（仓库形态）+ SDK/extension-first（默认实现） | 保留深改权利，但 kernel 默认只读 |
| D9 | L0 放 native system prompt | 压缩免疫；需 W0 spike 实证 |
| D10 | 先做单 task 闭环，再做多 task/console | 防止平台先行 |
| D11 | Web Console M0 = 看 + 聊 + 批；M1 = 建 + 配 + 控 | operator 需要 thread 视图、聊天和审批入口 |
| D12 | GitHub/GitLab 是 Forge connector，不是 IM 网关 | 工作入口 + 代码证据 + 交付出口 |
| D13 | 独立 review = 身份 + model family + fresh + blind + falsifier | 代码默认跨族，低风险文档同族非作者 |
| D14 | v1 agent 零 secret | 凭证操作交 human/CI |
| D15 | 删除 AgentInstance；AgentProfile 是稳定身份，AgentSession 是执行身份，Run 绑 agentSessionId | 减少状态和恢复复杂度 |
| D16 | design gate 机器默认，critical/spec_change 才 human | 人类只保留不可逆决策 |
| D17 | 默认复用 clowder 已验证概念（Message、RichBlock、Ball custody、Approval Hub、Mission Hub、Memory/Eval、Skill/SOP） | 快速搭建产品；新建必须证明能加速 W0–W4 dogfood |
| D18 | W7 前端载体 = C（dogfood 接入现成 Hub）→ A（产品同构 + 复用/fork 组件），前提是 Hub 承载 spike 通过 | 不在 W7 从零写聊天客户端；B 自建需书面论证 |
| D19 | F117 投递内核是 A2A 执行真相；F233 `custody_events` 只作 append-only 审计 | 不把旧 ball custody 账本当执行裁决；不引入新球 ID |
| D20 | Approval Hub 复用 F246 双锚 / resolution-materialization / expiry=stale | 防止 approved 但无 effect proof、过期静默拒绝 |
| D21 | W0a 先于 W1；W0b 并行至 W5 前；W7a headless 先于 W7b | fork 不阻塞 dogfood；前端前后端解耦 |
| D22 | v1 引入 `AgentProfile`（稳定身份，对应 clowder catId + CatConfig）；`AgentSession` 是执行身份；不引入 AgentInstance | 支持多个 agent/跨 session 稳定身份，同时避免身份与运行状态混淆 |
| D23 | A2A 路由权威 = tool-call-first：讨论走 `a2a_send`，责任转移走 `handoff_create`；文本 `@` 只作可见标记，不作路由权威 | 单 kernel 下 tool call 可校验、可审计；避免 inline @ 与“说了等于做了” |
| D24 | SOP 全面复用 clowder：feature/backlog 级 `WorkflowSop` + 风险车道 + 点状硬门禁；不做强制串行状态机 | clowder 300+ feature 已验证“推进权留猫、只锁高风险 gate”；避免 codeteam 变成 workflow node |
| D25 | codeteam 的 `Task`/`Run`/`Handoff`/`Artifact` 是 clowder 执行原语的代码交付扩展，不是第二套真相 | 复用 `TaskItem`/`Lifecycle*`/action lease/custody 语义；只加代码交付字段 |
| D26 | `Stage` 降级为纯快照（run/lane/status），不是 SOP 控制器；gate 只挂工具/端点边界 | 防止串行控制器从 stage 表后门复活；避免 `Task.lane` 与 `WorkflowSop.stage` 混淆 |
| D27 | `Role` 是动态 registry：内置 4 个 + 前端自定义 writer 等；`human` 是 actorKind | 新增 role 不改核心代码；SOP 只引用 role id/actionPair |
| D28 | Dispatch queue = ADR-043/F117（F122 历史）；proactive schedule = F139 `TaskSpec_P1`；codeteam 只加 task readiness/DAG/budget/worktree，不建第二执行队列 | 复用已验证队列/schedule；避免 W5 另造 SQLite 队列或 cron poller |
| D29 | `Task` 复用 clowder `TaskItem` 底座；codeteam 只加 `backlogItemId` + repo/base/worktree/branch/risk/lane/budget | 不另造任务系统；`goal`→`why`，`featureId`→`relatedFeatureId` |
| D30 | A2A 执行链 = `A2A ingress → Queue Entry → QueueProcessor → AgentRouter → routeSerial/routeParallel → invokeSingleCat`；codeteam 只替换 `invokeSingleCat → invokeSingleAgent → pi kernel` | 复用已验证的入队/claim/serial/parallel/A2A chain；避免只复用 Queue 而重写路由层 |

---

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 架构过度完整、实现跟不上 | 文档变空话 | 每项标“已落地/目标态”；W1 先过继承矩阵，再建表 |
| 复用状态误判 | 把 contract-frozen/sunset 当 import-ready，拖慢 dogfood | 复用表带状态口径；sunset 不继承，contract-frozen 按新建计 |
| 权限 wrapper 不够硬 | 真实 repo 风险 | OS sandbox + 低权用户；first-run 只读 |
| review eval 样本小 | 结论过拟合 | 扩大 corpus；预注册门槛 |
| pi 上游漂移 | fork 同步成本 | pin tag + patch list + 上游测试 |
| 多 task 过早 | 复杂度爆炸 | W5 后置；先单 task |
| L0 内容漂移 | 行为不稳定 | 单源 + hash + eval |

---

## 开放问题

开放问题以 `plans/0001-runtime-hardening.md §7` 为单一来源；本节不复制清单。已决事项见 `architecture/0003-review-resolutions.md`，本轮计划评审处置见 `plans/0005-plan-review-resolutions.md`。

A2A 路由权威已于 2026-10-24 拍板 A（tool-call-first），见 `plans/0005-plan-review-resolutions.md` §10 D5「A2A 路由权威」；不再列为开放问题。

SOP 控制面已于 2026-10-24 拍板 D6=全面复用 clowder SOP，见 `plans/0005-plan-review-resolutions.md` §11；不再列为开放问题。

---

[宪宪/deepseek-flash🐾]
