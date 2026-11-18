---
feature_ids: [superagentteam/F019]
related_features: [codeteam/F018]
title: "F019: SuperAgentTeam rename (platform / team / SOP)"
status: done
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
vision_guard: 墨墨 (Qwen 3.8 Flash)
created: 2026-11-16
updated: 2026-11-18
source_plan: "docs/plans/0023-f019-superagentteam-rename.md"
source_decision: "operator 2026-11-16: rename as independent F019 before F018 R1-0; SuperAgentTeam is the generic A2A team runtime, codeteam was one code team/SOP"
---

# F019: SuperAgentTeam rename

> 这不是品牌换皮，而是把**平台层**和**team/SOP 层**分开：
>
> - **SuperAgentTeam**：通用 A2A team runtime、team profiles、SOP bindings、surfaces。
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
| 产品/平台 | **SuperAgentTeam** |
| npm scope | `@superagentteam/*` |
| 包目录 | `packages/superagentteam-*` |
| env | `SUPERAGENTTEAM_*`（F019.5 已移除 `CODETEAM_*` fallback） |
| 数据/配置 | `~/.superagentteam` / `.superagentteam/`（F019.5 已移除 `.codeteam` dual-read） |
| CLI | `superagentteam`（F019.5 已移除 `codeteam` wrapper） |
| 模型工具 | `superagentteam_*`（F019.5 已移除 `codeteam_*` alias） |
| skills | `superagentteam-*`（F019.5 已移除 `codeteam-*` alias） |
| 仓库/分支 | `zhongmingLL/superagentteam` / `superagentteam-work`（均已改名） |
| feature namespace | 新/活跃文档用 `superagentteam/Fxxx`；历史/legacy 保留 `codeteam/Fxxx` |
| code team | “code team” / team profile 名，不再占用平台 namespace |

## 范围

- 文档/品牌：`CODETEAM.md` → `SUPERAGENTTEAM.md`（旧路径 stub）、README、AGENTS、
  CLI help、当前 canonical docs 的显示名与 feature namespace。
- 包：`packages/codeteam-*` → `packages/superagentteam-*`；`@codeteam/*` →
  `@superagentteam/*`；import/build/tsconfig/package-lock 同步。
- 运行时标识：env/data/config 只使用新名；F019.5 在确认无运行数据/消费者后移除了旧名 fallback/dual-read。
- CLI/工具：只保留 `superagentteam` CLI 与 `superagentteam_*` / `superagentteam-*` 名称。
- 仓库/分支：repo + default branch rename 已完成（`zhongmingLL/superagentteam` / `superagentteam-work`；旧 repo URL 301，branch 名不 redirect）；CI/protection/required checks 已验证。
- 历史/legacy：只加边界/索引，不重写历史文档；`docs/legacy/task-first/` 保持原名。

## 非目标

- 不改 F018 A2A runtime 语义、DDL、状态机或验收矩阵。
- 不在 F019 实现新的 team profile / SOP engine；只留命名与扩展边界。
- F019.5 在审计确认无运行数据/消费者后移除旧 alias；不重写历史/legacy 文档。
- 不改 `@earendil-works/pi-*` 上游包；仓库仍是 pi downstream fork。

## 验收

- `@superagentteam/*` 包构建通过；daemon/skills/pi-adapter import 无旧 scope。
- `superagentteam` CLI 可运行；`codeteam` wrapper 已移除。
- 只读取 `SUPERAGENTTEAM_*`；旧 `CODETEAM_*` 被忽略。
- 只使用 `~/.superagentteam` 数据根；旧 `.codeteam` 不再读取。
- 工具/skill 只注册 `superagentteam_*` / `superagentteam-*`；旧 alias 不可调用。
- 当前 canonical docs 的显示名/namespace 更新；历史/legacy 文档不被重写。
- repo + default branch rename 后 CI、branch protection、PR 链接可查；旧 repo URL
  redirect 生效；新 branch protection/required checks 已验证。
- `check:doc-index`、build、受影响测试通过；非作者 review 覆盖 exact HEAD。

## 风险

- **模型工具名**：F019.5 已移除 `codeteam_*` alias；审计确认无活跃消费者。
- **数据路径**：F019.5 已移除 `CODETEAM_DATA_DIR` / `~/.codeteam`；审计确认无运行数据。
- **分支保护**：F019.4 branch rename 已完成，protection/required checks 跟随并验证。
- **文档 churn**：3200+ `codeteam` 引用；只改当前 canonical，历史/legacy 保留。
- **F018 返工**：R1-0 必须等 F019.1–F019.3 完成；否则 `@superagentteam/shared` 会再改。

## 阶段

| 阶段 | 内容 | 出口 |
|---|---|---|
| F019.0 | 命名矩阵、feature/plan、0021/0022 目标名 | 文档一致；不改代码 |
| F019.1 | 文档/品牌、feature namespace、AGENTS/README | 当前 canonical 用 SuperAgentTeam；历史保留 |
| F019.2 | 包/目录/scope/import/build/lock | `@superagentteam/*` 构建通过 |
| F019.3 | env/data/config 双读 + CLI/tools alias（迁移期） | 兼容测试通过；旧入口可用 |
| F019.4 | repo + default branch rename 完成；CI/protection 跟随 | 旧 repo URL 301；`superagentteam-work` protection verified |
| F019.5 | 清理旧 alias、R5 归档 | alias 已移除；无旧名消费者；F019 done |

## 依赖与顺序

```text
F018 design accepted (86310de24)
  → F019.0–F019.3
  → F018 R1-0 (superagentteam naming)
  → F018 R1-a–d
  → F019.4 repo + default branch rename done
```

[宪宪/deepseek-flash🐾]
