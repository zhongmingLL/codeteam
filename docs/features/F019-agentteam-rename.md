---
feature_ids: [agentteam/F019]
related_features: [codeteam/F018]
title: "F019: AgentTeam rename (platform / team / SOP)"
status: in_progress
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
vision_guard: 墨墨 (Qwen 3.8 Flash)
created: 2026-11-16
updated: 2026-11-16
source_plan: "docs/plans/0023-f019-agentteam-rename.md"
source_decision: "operator 2026-11-16: rename as independent F019 before F018 R1-0; AgentTeam is the generic A2A team runtime, codeteam was one code team/SOP"
---

# F019: AgentTeam rename

> 这不是品牌换皮，而是把**平台层**和**team/SOP 层**分开：
>
> - **AgentTeam**：通用 A2A team runtime、team profiles、SOP bindings、surfaces。
> - **Team**：成员、角色、协作方式、SOP、workspace/tool policy 的组合；code team
>   只是其中一个 team。
> - **SOP**：development / research / ops / review 等工作流，挂在 team 上，不写进
>   A2A runtime 内核。
> - **A2A runtime**：thread/invocation/queue/turn/worker/credential，所有 team 共用。

## Why

`codeteam` 把平台名字绑在了一个 team/SOP 上。2026-11-16 operator 明确：

1. 未来不仅需要 code team / code SOP，还需要其他 team、其他 SOP；产品要构建
   “team + 多种 A2A 协作方式 + 可插拔 SOP” 的平台。
2. 时间点合适：task-first 设计已被否定，F018 刚把 runtime 收敛成通用 A2A
   collaboration 雏形；此时改名可以避免把 `codeteam` 的 code 语义带进通用平台。

F019 是独立 feature，不混入 F018；F018 R1-0 在 F019 完成前暂停。

## 命名矩阵

| 面 | 目标 |
|---|---|
| 产品/平台 | **AgentTeam** |
| npm scope | `@agentteam/*` |
| 包目录 | `packages/agentteam-*` |
| env | `AGENTTEAM_*`；旧 `CODETEAM_*` 读 fallback |
| 数据/配置 | `~/.agentteam` / `.agentteam/`；旧 `.codeteam` dual-read |
| CLI | `agentteam`；`codeteam` 保留 wrapper |
| 模型工具 | `agentteam_*`；`codeteam_*` 保留 alias |
| 仓库/分支 | `zhongmingLL/agentteam`、`agentteam-work`；最后迁移 |
| feature namespace | 新/活跃文档用 `agentteam/Fxxx`；历史/legacy 保留 `codeteam/Fxxx` |
| code team | “code team” / team profile 名，不再占用平台 namespace |

## 范围

- 文档/品牌：`CODETEAM.md` → `AGENTTEAM.md`（旧路径 stub）、README、AGENTS、
  CLI help、当前 canonical docs 的显示名与 feature namespace。
- 包：`packages/codeteam-*` → `packages/agentteam-*`；`@codeteam/*` →
  `@agentteam/*`；import/build/tsconfig/package-lock 同步。
- 运行时标识：env/data/config 新名 + 旧名双读；新写入走新名。
- CLI/工具：`agentteam` + `codeteam` wrapper；`agentteam_*` + `codeteam_*` alias。
- 仓库/分支：repo rename、`agentteam-work`、CI/protection；最后做。
- 历史/legacy：只加边界/索引，不重写历史文档；`docs/legacy/task-first/` 保持原名。

## 非目标

- 不改 F018 A2A runtime 语义、DDL、状态机或验收矩阵。
- 不在 F019 实现新的 team profile / SOP engine；只留命名与扩展边界。
- 不硬切模型工具名、不删除旧数据路径、不重写历史/legacy 文档。
- 不改 `@earendil-works/pi-*` 上游包；仓库仍是 pi downstream fork。

## 验收

- `@agentteam/*` 包构建通过；daemon/skills/pi-adapter import 无旧 scope。
- `agentteam` CLI 可运行；`codeteam` wrapper 仍可用。
- `AGENTTEAM_*` 新写入；`CODETEAM_*` fallback 测试通过。
- `~/.agentteam` 新数据根；旧 `.codeteam` dual-read/迁移测试通过；无数据丢失。
- 工具注册同时有 `agentteam_*` 与 `codeteam_*` alias；模型面文档使用新名。
- 当前 canonical docs 的显示名/namespace 更新；历史/legacy 文档不被重写。
- repo/branch rename 后 CI、branch protection、PR 链接可查；GitHub redirect 生效。
- `check:doc-index`、build、受影响测试通过；非作者 review 覆盖 exact HEAD。

## 风险

- **模型工具名**：`codeteam_*` 是模型面契约；必须保留 alias，不能硬切。
- **数据路径**：`CODETEAM_DATA_DIR` / `~/.codeteam` 是持久化根；必须 dual-read
  或迁移；当前无真实用户数据，但仍要保留回滚。
- **分支保护**：`codeteam-work` 改名会影响 CI/protection/PR；放最后。
- **文档 churn**：3200+ `codeteam` 引用；只改当前 canonical，历史/legacy 保留。
- **F018 返工**：R1-0 必须等 F019.1–F019.3 完成；否则 `@codeteam/shared` 会再改。

## 阶段

| 阶段 | 内容 | 出口 |
|---|---|---|
| F019.0 | 命名矩阵、feature/plan、0021/0022 目标名 | 文档一致；不改代码 |
| F019.1 | 文档/品牌、feature namespace、AGENTS/README | 当前 canonical 用 AgentTeam；历史保留 |
| F019.2 | 包/目录/scope/import/build/lock | `@agentteam/*` 构建通过 |
| F019.3 | env/data/config 双读 + CLI/tools alias | 兼容测试通过；旧入口可用 |
| F019.4 | repo/branch/CI/protection | operator/ops 执行；redirect 可查 |
| F019.5 | 清理旧 alias、R5 归档 | 弃用窗口结束 |

## 依赖与顺序

```text
F018 design accepted (86310de24)
  → F019.0–F019.3
  → F018 R1-0 (agentteam naming)
  → F018 R1-a–d
  → F019.4 repo/branch rename（可与 R1 并行但最后）
```

[宪宪/deepseek-flash🐾]
