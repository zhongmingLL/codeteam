---
title: "DP-SKILL: skill 内容迁移拍板包"
doc_kind: decision-packet
status: decided
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related_plan: ../skill-migration.md
discussion_request: "3ab79e77-62c2-43d1-92ea-31c466a6efc2"
operator_decision: "DP-SKILL-1=A, DP-SKILL-2=A, DP-SKILL-3=A (2026-10-25); merge-gate content migration now follows DP-MERGE-1=D"
---

# DP-SKILL: skill 内容迁移拍板包

> **Operator 决定（2026-10-25）**：`DP-SKILL-1=A`、`DP-SKILL-2=A`、`DP-SKILL-3=A`。本 packet 已冻结；skill 矩阵按 A/A/A 收口。`merge-gate` 内容迁移按后续 **`DP-MERGE-1=D`** 重写（gate 后 merge owner 执行，operator 守硬门；C 类自动合并不做）。
>
> 背景：clowder SOP 由 `cat-cafe-skills/` 承载；plugin 卡只定加载器。此前 W4 只写了“复制几个 SKILL.md 与 gate 语义”，**没有系统讨论 skill 内容迁移**。`../skill-migration.md` 已补 61-skill 矩阵（讨论后 8 reuse / 20 adapt / 1 rewrite / 18 defer / 14 drop），并加入 `must-survive` registry 与路由对账门禁。
>
> 三猫讨论已回（烁烁/砚砚/墨墨均 A/A/A）：矩阵回写 4 行 R→A、1 行 X→D、memory target 钉 message connector，并新增 must-survive + 路由对账。待 operator 签。

## 0. 一句话

skill 内容迁移按“逐 skill 矩阵 + fork/adapt + 门禁”走；v1 只迁 W0/W4 核心 dev/SOP；codeteam 一次性 curated fork，不自动同步 clowder。推荐 **A/A/A**。

## 1. DP-SKILL-1：迁移策略

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | 逐 skill 矩阵 + fork/adapt；R/A/W/D/X 五态；每个 skill 有 sha256、adaptation、review、dry-run | 保留 proven 方法；不把 Clowder 债/假命令带进来；可审计 | 需要逐 skill 工作量 |
| B | 从空白只写当前需要的 skill | 最干净；没有历史包袱 | 丢掉大量已验证的方法/SOP，重复踩坑 |
| C | 全量 copy 后逐步修 | 起步快 | 假命令/不可用工具/Clowder 权限假设先进入 agent；后续难清理 |

**推荐 A**：codeteam 需要 clowder 的 SOP 经验，但不能继承它的工具/路径/权限假设。矩阵是“保留方法、替换实现”的最小成本路径。

## 2. DP-SKILL-2：v1 范围

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | 只迁 W0/W4：tdd/debugging/writing-plans/worktree/quality-gate/context + merge-gate/feat-lifecycle/review 族/co-creation-docs 等 | 与 W0/W4 dogfood 对齐；范围可控 | W5-W8 skill 后续再补 |
| B | 61 个全迁 | 一次覆盖所有面 | UI/媒体/社区/生活 skill 大量不适用；攻击面与维护成本暴涨 |
| C | 只迁通用方法（drop 所有 Clowder 特定 skill） | 最安全 | 丢掉 merge/feat/review/SOP 核心，codeteam 退化成通用 coding agent |

**推荐 A**：W0/W4 是当前 dogfood 目标；UI/社区/媒体等按目标 W defer。

## 3. DP-SKILL-3：upstream 同步

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | 一次性 curated fork + 显式 upstream review；codeteam 自己持有适配后的 skill | 适配结果稳定；clowder 变更不会自动覆盖 codeteam 语义 | 需要人工看 upstream 变更 |
| B | 持续自动同步 clowder skill | clowder 改进自动进入 codeteam | clowder 的工具/路径/权限假设会重新灌回；适配层被覆盖 |

**推荐 A**：codeteam 与 clowder 的 schema/工具/merge 权限已经分化，自动同步会把已修掉的假设带回来。clowder 只作参考源，不当事后真相。

## 4. 已定的门禁（随签字冻结）

- 没有矩阵行 + 静态检查 + 非作者 review + dry-run 的 skill，不得进入 `codeteam/skills/manifest.yaml`。
- A/W 行必须有 `must-survive` ID，非作者 review 逐条验在场；`next/triggers/not_for` 出边必须对账，不得指向 X 或未落地 D。
- `merge-gate` 是 rewrite，不是 copy：DP-MERGE-1=D（gate 后 merge owner 执行 + operator 硬门）、无 C 类自动合并、无 cloud review 无限循环。
- `feat-lifecycle`/`request-review`/`receive-review`/`quality-gate`/`worktree`/`writing-skills` 是 adapt，不是原样复制。
- 媒体/IM/生活/Collective/插件市场/内容制作 15 项 drop；W5/W6/W7/W8 的 17 项 defer。
- 单文件 `SKILL.md`；frontmatter 是 name/description/triggers 唯一权威；`tips_exempt` drop。

## 5. 不拍的后果

- DP-SKILL-1 不拍：skill 迁移没有可审计路径，可能变成全量 copy 或空白重写。
- DP-SKILL-2 不拍：W0/W4 与 61 个 skill 的范围混在一起，UI/媒体/社区债拖慢 dogfood。
- DP-SKILL-3 不拍：clowder upstream 变更可能自动覆盖 codeteam 适配，回归已修问题。
- W0/W4 skill 加载面已冻结，但**没有内容迁移门禁就不能开工**。

## 6. 拍板记录

Operator 已回复 `DP-SKILL-1=A, DP-SKILL-2=A, DP-SKILL-3=A`（2026-10-25）。本 packet 不再等待输入。已执行：

1. `skill-migration.md` → `status=approved`，写 `operator_signoff`。
2. S0 6 个核心 skill 进入迁移；W0/W4 skill gate 生效。
3. 三猫 review 矩阵细节；不通过的行回改，不进入 catalog。

[宪宪/deepseek-flash🐾]
