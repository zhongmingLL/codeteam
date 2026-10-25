---
title: "codeteam 架构 v1 评审决议"
doc_kind: decision-log
status: accepted-for-doc-update
created: 2026-10-21
updated: 2026-10-24
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
---

# codeteam 架构 v1 评审决议

> 来源：2026-10-21 三猫独立评审（runtime/pi、架构/安全、产品/UX）。
> 结论：**架构方向成立，不推倒重来；以下决议用于消除契约歧义和开工前风险。**
> 本文件是评审处置的单一记录；`0001` / `0002` / `plans/0001` / `F001` 按本文件同步。

---

## 1. 决议摘要

| ID | 决议 | 影响文档 |
|---|---|---|
| R1 | 删除 `AgentInstance`；`AgentSession` 是具体执行身份，`Run` 绑 `agentSessionId` | 0001 §3.3/§4.2/§8.4 |
| R2 | `Thread` 持久化；W1 增加 `threads`、`agent_sessions`、`Task.threadId` | 0001 §3.3/§12.2, plans W1 |
| R3 | Console M0 = **看 + 批**（只读视图 + approval/merge），随 W7；M1 = 建 + 配 + 控 | 0001 §3.4/§20, plans W7 |
| R4 | 独立 review = 身份独立 + 模型族独立 + fresh context + blind + falsifier；代码默认跨 model family，低风险文档允许同族非作者 | 0001 §8, 0002 |
| R5 | Handoff 补 `claimed → expired`；`complete()` 校验 claim；重排 attempt+1，loop guard 用 canonical action key | 0001 §5.2/§6 |
| R6 | v1 agent 零 secret；push/publish/部署等凭证操作交 human/CI；v2 再考虑受信 sidecar | 0001 §14.3, plans W2 |
| R7 | GitHub PR comment → inbox 只接受 maintainer/collaborator + `codeteam` label；其余只读 evidence | 0001 §14.1/§18.1, plans W8 |
| R8 | Design gate 默认机器判定；human 只在 `critical` / `spec_change` 介入 | 0001 §7, plans W4 |

> 2026-10-22 operator 修正：M0 保留 thread 内 operator↔agent 聊天框，因此 R3 的“看 + 批”按“看 + 聊 + 批”执行。聊天是普通消息写入，不是 approval/merge，也不改变 agent↔agent 的 typed 规则。
| R9 | 加 W0 fork 工程动作；加 L0 compaction/cache spike；加 RPC worker 三语义 | plans W0/W5, 0002 |
| R10 | README 的“已证明”拆成 coder smoke 与 reviewer eval，不混写 | README, 0001 §16.3 |

---

## 2. P1 处置

| 原 finding | 决议 | 备注 |
|---|---|---|
| 真相源悬空（墨墨） | 以当前 thread + `codeteam/` 目录为讨论真相源；历史“已落地/已证明”标注为讨论时点，开工前重新对码 | 不再把外部产品仓作为裁决源 |
| Web Console first-class vs Phase 8（墨墨） | Console M0 = 看 + 聊 + 批（2026-10-22 修正），随 W7；M1 后置；W1 先落 thread/agent_session schema | 避免 human gate 只能走 CLI；保留 operator 聊天框 |
| AgentInstance 幽灵实体（烁烁） | **删除**；`AgentSession` 作为具体身份；`Run.agentSessionId` | 减少 crash recovery 状态 |
| Handoff double-consume（砚砚） | 补 `claimed → expired`；`complete()` 必须 `status==claimed && claimedByRunId==self`；重排 attempt+1；loop guard 用 canonical action key | 禁止迟到 complete |
| GitHub PR comment 无权限过滤（砚砚） | 只接受 maintainer/collaborator + `codeteam` label；其余只读 evidence；正文 untrusted | 防 injection/DoS |
| Secret 注入不可实施（砚砚） | v1 agent 零 secret；`DP-MERGE-1=D` 的 merge credential 由 daemon 持有，不进 agent 面；v2 sidecar | 2026-10-25 按 D 更新；A 的 human/CI 凭证只是零-secret 临时偏差 |
| Design gate 写死 human（砚砚） | 默认机器 gate；critical/spec_change 才 human | 消除原则矛盾 |

---

## 3. P2 处置

### 契约/数据

| Finding | 决议 | 落点 |
|---|---|---|
| Thread 不在领域模型/schema/事件 | 持久化 `threads`；`Task.threadId`；`AgentSession.threadId`；thread 事件 | W1 |
| InboxItem 无 typed schema | 补 `InboxItem` 定义与 inbox→handoff 关系 | W1 |
| Review/verification 未绑 head SHA | `reviews` / `verifications` 增加 `headSha`；head 变更即作废 | W1/W3 |
| Merge receipt 入口 | W1–W6 merge owner 用 `codeteam merge record` CLI；W7 console 显示 merge 状态/硬门审批；W8 GitHub merge 事件 | W1/W7/W8 |
| 决策清单三处并存 | plans §7 为唯一决策清单；0001/F001 指向它 | 文档 |

### 运行时/pi

| Finding | 决议 | 落点 |
|---|---|---|
| Fork 工程动作缺失 | 新增 W0：full fork、upstream remote、pin tag、上游测试、`UPSTREAM.md`/`KERNEL_GAPS.md` | W0 |
| RPC worker 三语义未定义 | 定义 per-run tool policy 查询、coder session sticky routing、daemon 重启 re-attach（失败降级 fresh + capsule） | W5 / 0002 |
| L0 compaction/cache 未验证 | 加 spike：长 session 压到 compaction 阈值，断言 L0 逐字保留；验证 section 稳定时 cache 命中 | W0/W1 |
| MCP 身份 per-worker 太粗 | per-run token；extension 闭包/0600 文件注入；token→(run,role,task) 查表 | W2 / 0002 |
| settled-nonconforming 缺失 | `agent_settled` 时核验 required artifacts / handoffs；缺项重试一次，仍缺 failed + loop guard | W1 |

### 安全/review

| Finding | 决议 | 落点 |
|---|---|---|
| Falsifier 信任/表达力边界 | create 时用 verifier policy 预校验；blocked 只允许环境故障；audit 记录 producing review id | W3 |
| Base 前进但无冲突 | 强制 rebase + targeted test + fast re-review；review/verification 绑 head SHA | W3 |
| Verifier disposable copy 未绑 diff | copy = base_sha + coder diff clean checkout；Verification 带 headSha | W3 |
| Risk 分类两时机 | pre-diff 初判；出 diff 后复核，只升不降 | W4 |
| `to` 自由参数可滥用 | handoff 创建校验 `(fromRole,toRole,kind)` 命中 SOP actionPair 白名单；fromRole 来自 token | W2/W7 |
| Webhook 乱序/丢失 | webhook 只做触发；GitHub API 做对账真相源；natural key upsert | W8 |

### 产品/文档

| Finding | 决议 | 落点 |
|---|---|---|
| README overclaim | 拆成“三家 coder smoke”与“Kimi reviewer eval”；GLM review 待复核 | README/0001 §16.3 |
| Console M0 口径过大 | M0 只保留看+聊+批；创建/settings/retry 放 M1 | 0001 §3.4 |
| 0002 “L4 仓库形态”混淆 | 改为“full fork（仓库形态）+ L1/L2（默认实现）；L4 仅在 KERNEL_GAPS 后” | 0002 |

---

## 4. P3 处置

| Finding | 决议 |
|---|---|
| L0 编译边界 | 默认替换 preamble；tools/rules/skills/cwd 归上游；整体替换只作例外 |
| `AgentSession.stage` vs `Run.stageId` | 统一用 `stageId`；`Stage` 为纯快照，不是控制器 |
| `AgentSession.worktreeId` 冗余 | 删除；worktree 归 Task |
| `Thread.projectId` 悬空 | v1 用 `repo: string`；Project 后置 |
| `noSkills: true` 与 L1 skill 目标 | role curated skills 通过显式目录加载，不自动发现 |
| human handoff 超时 | `waiting_human`，不回收/升级 |
| F001 reviewer 名单 | 加 product/UX reviewer |
| audit append-only | SQLite `BEFORE UPDATE/DELETE` trigger |
| InboxItem 未定义 | 随 R2/W1 补 |
| 0002 L4 表述 | 随文档同步修正 |

---

## 5. 已决事项（从开放问题移除）

- AgentInstance：删除。
- Console M0：看 + 聊 + 批；M1 后置。
- Secret：v1 零 secret。
- GitHub comment：maintainer/collaborator + `codeteam` label。
- Design gate：机器默认，critical/spec_change 才 human。
- Review：独立 review 默认跨 model family；低风险文档允许同族非作者。
- Thread：持久化。
- Merge：`DP-MERGE-1=D`；merge owner 在 gate 后执行，operator 守硬门；W1–W6 用 CLI record receipt。A 仅零-secret 临时偏差。

### 2026-10-24 SOP 控制面决议

- **全面复用 clowder SOP**：feature/backlog 级 `BacklogItem` + `WorkflowSop` 告示牌；风险车道；点状硬门禁（worktree/design/review/verify/merge/completion）；不做强制串行状态机。
- 推进权留给猫；SOP 只记录“在哪、球在谁手上、建议下一个 skill、恢复胶囊”。
- 旧 W4 的串行 stage controller 设计废弃。
- 落点：`0001 §7`、`plans/0003 W4`、`plans/0005 §11 D6`、`F001 D24`。

---

## 6. 仍需后续确认

1. 是否把 `pi-durable` 作为 W5 的 task graph 底座，还是自建 SQLite scheduler。
2. sandbox 选型：MVP 低权 user + bwrap；目标态 container；microVM 后置；待 operator 确认。
3. C 类自动 merge 的阈值与回滚策略（v1 不做）；D 的 merge owner 执行不属于自动 merge。
4. 多 task 调度：FIFO + priority 还是 dependency DAG 优先。
5. Memory 先做 FTS5 还是直接 hybrid。
6. 开源发布时间与 core/role-pack 许可。

---

## 7. 参考

- 三猫评审原文：thread `thread_mvi0van9cxhjf3sz`，2026-10-21。
- 主架构：`0001-codeteam-architecture-v1.md`
- pi 接入：`0002-pi-runtime-integration.md`
- 硬化计划：`../plans/0001-runtime-hardening.md`
- 交付契约：`../features/F001-architecture-v1.md`

---

[宪宪/deepseek-flash🐾]
