---
title: "clowder-ai operator 职责范围调研"
doc_kind: research
status: draft-for-decision
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
purpose: "为 DP-MERGE-1（codeteam merge authority）提供 clowder 一手职责证据"
---

# clowder-ai operator 职责范围调研

## 0. 结论先行

clowder 的 operator 是**人类 owner / 最终授权者**，不是日常执行队列：

- **operator 定**：愿景、scope、F 号、不可逆/外部动作、凭证/生产数据边界、runtime 生命周期授权、审批与升级。
- **猫执行**：已确认方向内的技术选择、实现、验证、review、**routine own-PR merge**。
- **operator 不承担**：每个 PR 的 merge 按钮、作者的 QA/截图劳动、技术 A/B 选择、所有技术细节的逐项批准。

因此，clowder 的 merge 权威不是“operator 逐次执行 merge”，而是“猫在 gate 通过后由 merge owner 执行，operator 只在硬排除/高风险/第三方/close 等边界介入”。codeteam 目前写的“operator-only merge”比 clowder 更严，是 codeteam 自己的默认，不是 clowder SOP 的直接继承。

## 1. operator 明确负责的范围

| 职责 | 证据 | 说明 |
|---|---|---|
| 愿景、scope、方向校准 | `docs/SOP.md:20-29`、`:162` | 和 operator 确认 feature 愿景；已确认方向内猫自主推进；愿景/范围/体验分叉才校准 |
| F 号分配 / 立项 | `docs/SOP.md:353`、`:534` | operator 拍板 F 号，猫执行分配；外部文档的任务清单不等于立项 |
| 不可逆/高风险动作 | `docs/SOP.md:72` | 不可逆 Git 操作、合第三方 PR、close feat、圣域 → 先拿 operator 授权 |
| 生产数据/迁移边界 | `docs/SOP.md:69`、`:76` | 生产操作另走授权边界；数据/迁移风险升档 |
| 凭证/secret/权限 | `docs/SOP.md:70`；`docs/features/F246-approval-hub.md:103` | operator principal 是严格授权面；secret/权限边界由 operator 掌控 |
| Runtime 生命周期授权 | `cat-cafe-skills/merge-gate/SKILL.md:471`；`quality-gate/SKILL.md:117` | 只有 operator 显式授权后才做 runtime 生命周期动作 |
| 外部发布/同步/第三方交付 | `docs/architecture/ownership/cells/action-plane.md:4`、`:55`；`docs/SOP.md:441` | operator-facing external release/sync 需要 durable receipt/lease；`--skip-validate` 是 operator override |
| Approval Hub 决策 | `docs/architecture/ownership/cells/approval-index.md:181-194` | strict operator principal；永久删除等 effect 需 operator settle |
| 跨猫僵局/阻塞升级 | `docs/SOP.md:23` | 解决不了的阻塞/外部依赖升级 operator；方向存疑停手重估 |

## 2. operator 明确不负责的日常执行

### 2.1 不是每个 PR 的 merge 执行者

| 证据 | 说明 |
|---|---|
| `cat-cafe-skills/merge-gate/SKILL.md:37` | “evidence 闭合后由**在场 merge owner** 执行 `gh pr merge --squash`；不再额外召唤一只猫只为按 merge 按钮。” merge owner 是执行猫，不是 operator |
| `cat-cafe-skills/merge-gate/SKILL.md:421-432` | Step 7 由当前执行体跑 `gh pr merge`，只由 PR truth 定性；没有“operator 按按钮”步骤 |
| `docs/SOP.md:235-258` | Artifact-only PR：满足 10 条硬条件后，任一非作者猫自决 squash merge；**operator 不在 reviewers / 不需 sign-off** |
| `docs/features/F217-merge-gate-integrity.md:23`、`:33` | 私有仓强制力 = main-green + 本地 gate + 跨猫 review 家规；“猫理论上能 self-merge”，operator 接受 <1% 风险 |
| `docs/features/F217-merge-gate-integrity.md:142-143` | KD-9/KD-10：operator 拍板不配 required reviews，靠家规和 main-green；merge 执行留在猫侧 |
| `docs/SOP.md:72` | 不可逆列表只列“合**第三方** PR”，没有“合自己的 PR”；routine own-PR merge 不在 operator 硬门 |
| `docs/SOP.md:76` | 作者可按风险选择 targeted 证据，**无需 operator 逐次豁免**；只有按风险要求的独立审查/不可逆授权不放宽 |

## 3. operator 不承担的日常职能

### 3.1 不是作者的 QA / 截图劳动

- `cat-cafe-skills/request-review/SKILL.md:71-74`：作者自己启动/复用 preview，走关键交互，记录 URL/操作/结果；**禁止把“请 operator 打开页面/截图”当 review 前置条件**。
- `cat-cafe-skills/quality-gate/SKILL.md:185`：前端功能 author 必须自走真实入口；不把缺截图转成 operator 的劳动。

### 3.2 不是技术 A/B 的路由器

- `docs/SOP.md:20-29`：确认愿景后，已确认方向内猫自主推进；只有愿景/权限/不可逆边界需要 operator。
- 猫应自决可逆技术选择；需要 operator 的是价值取舍/权限/不可逆，不是每个实现 A/B。

## 4. 对 codeteam 的含义

### 4.1 当前 codeteam 默认

codeteam 的 `operator-only merge` 出现在 `F001 D7`、`0003 §5`、`0001 §4.1/§14.2/§18`、`plans/0003` 等，是**更严的 codeteam 架构默认**：agent 零 secret、run token 不能 merge、merge/approval 端点只接受 operator credential。它比 clowder 的 routine cat merge 更保守，也没有独立 operator signoff。

### 4.2 四种可选模型

| 模型 | 行为 | 与 clowder 的关系 | 取舍 |
|---|---|---|---|
| **A. Operator decision + execution** | operator 决策并执行 merge；agent 只备 evidence + `approval_request` | **比 clowder 更严** | 最安全、零 secret；但 operator 成为每 PR 瓶颈，偏离 clowder 猫 merge 的 SOP |
| **B. Operator approves exact HEAD, daemon executes** | operator 批准 exact base/head/strategy；daemon 用短时效凭证执行；one-shot、HEAD stale | 中间态；仍保留 per-merge human decision | 降低手工执行；但 operator 仍是每 merge 决策者，不是 clowder parity |
| **C. Policy auto-merge after gates** | gates 全绿后无人逐次批准 | 比 clowder 更自动 | 不可逆风险、无 v1 rollback；不建议 |
| **D. Clowder parity: merge owner executes after gates** | 猫/merge-owner 在 gate 通过后执行 merge；operator 只处理硬门（第三方 PR、不可逆 Git 操作、close feat、圣域、runtime、凭证、外部发布） | **最接近 clowder SOP** | 需要 daemon-held 短时效 merge credential + merge-owner role + risk policy + audit；是 W7/W8 安全契约 |

### 4.3 我的建议

- **目标态选 D**：如果 codeteam 要继承 clowder 的 SOP 灵魂，operator 不应成为每 PR 的 merge 按钮；merge 应由 gate 后的 merge owner 执行，operator 守硬门。
- **v1 如果零-secret 还不能安全支持 merge owner 凭证**：先用 A 作为**明确标注的临时 codeteam 偏差**，跑 W0–W4 dogfood 并记录 operator merge 等待；不要把它写成“clowder SOP 本来如此”。
- **B 只在 operator 想保留 per-merge 人类决策、但减少手工执行时选**；C 不推荐。

## 5. 需要 operator 用这次调研拍的点

1. codeteam 是要继承 clowder 的“猫在 gate 后 merge”模型（D），还是保留更严的 operator-only（A）？
2. 如果选 D：是否接受 daemon-held 短时效 merge credential + merge-owner role + risk policy？这需要 W7/W8 单独安全契约。
3. 如果选 A/B：是否接受 operator 继续作为 per-merge 决策者/执行者，并把 merge 等待作为 dogfood 成本记录？

## 6. 参考

- `docs/SOP.md:20-29`、`:60-80`、`:232-262`、`:348-365`
- `cat-cafe-skills/merge-gate/SKILL.md:30-42`、`:421-432`
- `cat-cafe-skills/request-review/SKILL.md:71-74`
- `cat-cafe-skills/quality-gate/SKILL.md:117`、`:185`
- `docs/features/F217-merge-gate-integrity.md:20-33`、`:138-152`
- `docs/architecture/ownership/cells/approval-index.md:176-206`
- `docs/architecture/ownership/cells/action-plane.md:1-60`
- `codeteam/features/F001-architecture-v1.md:144`
- `codeteam/architecture/0003-review-resolutions.md:121`
- `codeteam/architecture/0001-codeteam-architecture-v1.md:710`、`:773`、`:1051`、`:1638`、`:1914`
- `codeteam/plans/0003-w3-w4-review-sop.md:230-233`
- `codeteam/plans/0004-w5-w8-scale-product.md:517`
- `codeteam/plans/0001-runtime-hardening.md:420`

[宪宪/deepseek-flash🐾]
