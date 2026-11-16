---
title: "Task-first legacy index — code and docs boundary"
doc_kind: index
status: legacy-frozen
created: 2026-11-16
updated: 2026-11-16
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related_features: [codeteam/F017, codeteam/F018]
canonical: "docs/architecture/0005-thread-first-runtime.md; docs/architecture/0007-a2a-runtime-chain.md"
---

# Task-first legacy index

> 这是 task-first code 与 docs 的统一 legacy 边界。旧代码在
> `packages/codeteam-daemon/src/legacy/task-first/`；旧文档在
> `docs/legacy/task-first/`。两者都不是 F018 实现基线。
>
> 新开发只读 `0005`/`0007` + 分册 + `0020`/`0021`。

## 1. 状态标记

| 标记 | 含义 | 允许动作 |
|---|---|---|
| `legacy-frozen` | 旧代码冻结 | 只有阻挡 A2A runtime 的 bug 才修 |
| `legacy-read-only` | 旧表/旧数据只读 | v1 runtime 不读不写、不双写 |
| `retired` | 从运行面移除 | 不注册、不保留 alias |
| `historical` | 历史文档/审计 | 只做追溯，不作实现依据 |
| `moved` | 文档已物理移动 | 旧路径只留 stub |

## 2. 代码边界

目标：`packages/codeteam-daemon/src/legacy/task-first/`

| 目录 | 内容 |
|---|---|
| `a2a/` | 旧 `a2a_send` / `handoff_*` handlers、request dedupe、旧 principal/terminal |
| `dispatch/`、`scheduling/` | task-first dispatch、provisioning、budget、worktree pool |
| `review/`、`merge/`、`gates/`、`sop/` | code delivery review/merge/SOP gates |
| `managed-work/`、`deployment-wait/`、`custody/` | managed work、deployment wait、custody/wait |
| `cli/` | task-first CLI commands |
| `control/migrations/` | 旧 001-016 migrations |
| `control/stores/` | 旧 control-plane stores |
| `control/stores/types.ts` | 旧类型总表 |
| `policy/handoffs.ts`、`auth/merge-credential.ts`、`workers/control.ts` | task/merge/custody 专用路径 |

旧路径兼容：
- `control/stores/types.ts` 只留 `@deprecated` re-export barrel。
- `control/migrations/index.ts` 只留 legacy migration barrel。
- 其他旧路径不保留目录 shim；旧代码 import 显式指向 `legacy/task-first/`。

## 3. 文档边界

目标：`docs/legacy/task-first/`

| 文档类别 | 处置 |
|---|---|
| 纯 task-first feature 文档（如 F006–F011、F015/F016a 的 code delivery 部分） | 物理移到 `docs/legacy/task-first/features/`；旧路径留 `status: moved` stub |
| 纯 task-first plan 切片 | 物理移到 `docs/legacy/task-first/plans/`；旧路径留 stub |
| 混合文档（F004/F005 的 thread/message/queue 核心、F016b/F016c、W0–W8 计划） | 留在原位，加 `legacy`/`historical` 边界；task-first 部分链到本索引 |
| 参考文档（`0001`/`0002`/`0012`） | 留原位标 `[reference]` |
| 历史审计（`0003`/`0004`/`0015`） | 留原位标 `[historical]` |
| `0006-task-first-legacy.md` | legacy 入口，主体链接到本索引 |

## 4. 与 canonical 的映射

| 旧域 | 当前 canonical |
|---|---|
| Task / Run / Stage / Handoff / Custody | `0005` 方向；F018 v1 不做 |
| 旧 Queue / Run / Event | `0007` InvocationQueue / InvocationRecord / TurnExecution / InvocationAttempt |
| 旧 `agent_profiles` / `roles` | `0008` AgentConfig / AgentRegistry |
| 旧 thread shape | `0009` Thread |
| 旧 session shape | `0010` AgentSession |
| 旧 identity 名 | `0011` Identity contract |
| 旧 idempotency | `0013` Idempotency key map |
| 旧 run terminal / attempt | `0016` Turn terminal & settlement |
| 旧 draft/response | `0017` ResponseDraftStore |
| 旧 queue/run read models | `0007` QueueView / LiveInvocationView / MessageDispatchSummary |

## 5. 迁移规则

1. 代码和文档同批移动；旧路径 stub 只做 re-export/link，不承载新逻辑。
2. `check-legacy-boundary` 禁止新 v1 code import legacy path/barrel；旧代码只 import
   legacy 或 compatibility barrel。
3. `@codeteam/shared` 不吸收 legacy 类型；新契约从 `0007`/`0011`/`0016`/`0017`
   重新定义。
4. R5 再归档/删除；R1-0 只移动 + stub，不删除历史。
5. 任何从 legacy 复活的能力必须另立 feature，从 A2A runtime 出发。

[宪宪/deepseek-flash🐾]
