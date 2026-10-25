---
title: "Merge Authority D 漂移审计"
doc_kind: audit
status: reviewed
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
decision_ref: decision-packets/2026-10-25-dp-merge-authority.md
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
discussion_request: "52960ac8-894c-49c8-9837-04e7a4be68ef"
review_result: "accept-with-modify (烁烁/砚砚/墨墨), no reject; P1/P2 written back 2026-10-25"
---

# Merge Authority D 漂移审计

## 0. 结论先行

operator 2026-10-25 拍 **`DP-MERGE-1=D`**：routine own-PR merge 由 gate 后的 merge owner 执行，operator 只守硬门；C 类无人逐次 gate 的自动合并不做；A 仅作零-secret 临时偏差。

全量检查 `codeteam/` 后，漂移不是一句 “human merge” 的措辞问题，而是三层：

1. **直接表述漂移**：`F001`、`0001`、`0003`、`0004`、`0005`、`plans/0001–0005`、`README` 里仍把 routine merge 写成 operator-only / human merge。
2. **派生契约漂移**：`0001` auth matrix、`approval-index` 的 `merge` approval kind / materialization principal、`ball-custody` 的 merge custody、`github-signals` 的 `pr_merged` 理由、`merge record` 的 `approvedBy` 字段，都是按 A 写的。
3. **跨卡语义漂移**：routine merge 是否还需要 `approvals(kind='merge')`；merge owner 是否需要 lease/predicate；`pr_merged` 与 merge receipt 谁先谁后；W0–W4 dogfood 的 “human merge” 指标是否改成 “merge owner merge + operator 硬门等待”。

**结论：不能只改措辞。** 直接表述可以先修；auth / approval / custody / receipt / `pr_merged` 五处必须先经三猫 review，再冻结 D 的六个契约，否则 W7/W8 会同时存在 A 和 D 两套假设。

**Review 状态（2026-10-25）**：三猫均 `accept-with-modify`，无 reject。砚砚 P1-1（daemon 强制核验 E1–E5）已接受；Q4 的 custody 分歧按“merge owner = daemon service principal”合成为无 agent handoff 的 `merges` 执行记录。详见 §8。

## 1. D 的解释边界

以下四条是本审计的判据；若三猫认为解释有误，先改解释，再改文档。

1. **merge owner 执行 ≠ 无人 gate**：merge-gate 证据、非作者 review、exact HEAD、falsifier、merge receipt 全部保留。
2. **merge owner 执行 ≠ C 自动 merge**：仍有一个具名 merge owner 在证据闭合后执行；不是 gates 全绿无人决策。
3. **operator 守硬门**：第三方 PR、不可逆 Git 操作、close feat、圣域/生产数据、runtime 生命周期、凭证/secret、外部发布仍需 operator 授权。
4. **零 secret 只约束 agent/模型面**：daemon-held 短时效 merge credential 是独立受信通道，不能进 prompt/log/model；A 只是该通道落地前的临时偏差。
5. **gate 证据由 daemon 服务端核验**：`merge:execute` 的 mint 前置必须从 canonical 表核验 E1–E5（exact HEAD、非作者 review 覆盖 HEAD、无 open P1/P2、gate evidence、falsifier 闭合）；请求 body/agent 自述不算证据。
6. **D 比 clowder artifact-only lane 更严**：clowder `SOP.md:235-258` 的 artifact-only PR 可由非作者猫自决 squash merge、operator 不 sign-off；codeteam D 仍要求 gate 先行（证据闭合后 merge owner 才执行）。这是有意收紧，防止被援引为“去 gate 化”。

## 2. 审计范围与方法

- 范围：`codeteam/**/*.md`，含 features、architecture、plans、reuse、decision-packets。
- 方法：按 merge authority 关键词全量 grep，再逐处读上下文，区分“直接表述 / 派生契约 / 不受影响”。
- 关键词：`operator-only`、`human merge`、`v1 human merge`、`operator.*merge`、`merge owner`、`merge:record`、`approval:decide`、`auto-merge`、`自动 merge`、`merge receipt`、`approvedBy`、`pr_merged`、`human/policy gate`。
- 约束：`codeteam/` 仍 untracked；本审计只改文档，不 commit/push，不改实现代码。
- 行号说明：矩阵中的 `file:line` 是 2026-10-25 审计时点；后续编辑可能移位，以文件内段落和引用文本为准。

## 3. 漂移矩阵

### 3.1 直接表述（可按 D 直接修）

| ID | 锚点 | 现表述 | 漂移 | 处置 |
|---|---|---|---|---|
| D-01 | `features/F001-architecture-v1.md:144` | D7 `v1 human merge` | routine merge 不再是 operator 执行 | 改为 `v1 merge owner execution (D); operator hard gates; A only zero-secret interim` |
| D-02 | `features/F001-architecture-v1.md:52` | `不把自动 merge 作为 v1 目标` | 本身不漂移，但容易被读成“D 也是自动 merge” | 加一句：C 类自动 merge 不做；D 的 merge owner 执行不算 C |
| D-03 | `architecture/0003-review-resolutions.md:47` | `凭证操作 human/CI ... 与 human merge 一致` | 理由链按 A 写成 | 改为：v1 agent 零 secret；D 的 merge credential 由 daemon 持有，不进 agent 面 |
| D-04 | `architecture/0003-review-resolutions.md:61` | `Human merge receipt 无入口` | receipt 不再只来自 human | 改为 `Merge receipt 入口`：W1–W6 merge owner CLI；W7 Console 状态；W8 GitHub merge event |
| D-05 | `architecture/0003-review-resolutions.md:121` | `Merge：v1 human merge` | 直接矛盾 | 改为 `Merge：DP-MERGE-1=D；merge owner 执行，operator 守硬门；A 仅临时偏差` |
| D-06 | `architecture/0001-codeteam-architecture-v1.md:41` | `dogfood 更快到 human merge` | 里程碑口径按 A | 改为 `更快到 merge 完成` |
| D-07 | `architecture/0001-codeteam-architecture-v1.md:1051-1052` | `执行权始终 operator-only (D7 + §14.2)` | 直接矛盾 | 改为 D；保留 `merge-gate 5 条是证据清单` 与 `agent 不能自行绕过 gate` |
| D-08 | `architecture/0001-codeteam-architecture-v1.md:1110` | `审批/merge 由 operator credential 授权` | approval decide 仍 operator；routine merge 不是 | 拆成：approval decide → operator；routine merge → merge-owner capability |
| D-09 | `architecture/0001-codeteam-architecture-v1.md:1582` | `merge record ... + human 批准` | receipt 字段与语义按 A | 改为 merge owner 执行 + gate evidence；`approvedBy` 是否改名见 A-07 |
| D-10 | `architecture/0001-codeteam-architecture-v1.md:1629` | `任何 merge/push/delete/force-push 需要 human/policy gate` | routine merge 不再过 operator | 拆成：routine own-PR merge → merge gate + merge owner；push/delete/force-push/第三方 → operator |
| D-11 | `architecture/0001-codeteam-architecture-v1.md:1635` | Operator 行 `thread chat / approve / merge / 配置 / 不可逆操作` | merge 不再是 operator 日常 | 改为 `approve / 硬门 merge / 配置 / 不可逆操作` |
| D-12 | `architecture/0001-codeteam-architecture-v1.md:1639` | `merge/approval decide 端点只接受 operator credential` | merge 执行与 approval decide 混在一起 | 拆成两个 auth 面；见 Q3 |
| D-13 | `architecture/0001-codeteam-architecture-v1.md:1866` | `merge: human` | 角色矩阵按 A | 改为 `merge: merge_owner` |
| D-14 | `architecture/0001-codeteam-architecture-v1.md:1920` | `人工触发合并，GitHub 只作为证据和交付出口` | 直接矛盾 | 改为 `merge owner 在 gate 后触发/执行合并`；GitHub 仍是证据与出口 |
| D-15 | `architecture/0001-codeteam-architecture-v1.md:1935` | `merge policy + human gate` | 按 A | 改为 `merge policy + merge owner + operator hard gates` |
| D-16 | `architecture/0001-codeteam-architecture-v1.md:1996` | `Phase 3 ... human merge gate` | 历史路线图按 A | 加状态注：现行为 D；历史表述只作 provenance |
| D-17 | `architecture/0003-review-resolutions.md:136` | `自动 merge 阈值与回滚（v1 不做）` | 本身是 C 的问题，但未区分 D | 加一句：C 不做；D 的 merge owner 不是自动 merge |
| D-18 | `plans/0001-runtime-hardening.md:28,320,336,361,420` | `human merge gate` / `human merge receipt` / `merge 仍由 human/policy gate` / `W0–W4 到 human merge` / `v1 保持 human merge` | 整条 dogfood/路线图按 A | 改为 `merge owner execution`；C 自动 merge 仍后置 |
| D-19 | `plans/0003-w3-w4-review-sop.md:230,233-234` | `merge = policy + human`；`执行权 operator-only` | 直接矛盾 | 改为 D；证据清单条款保留 |
| D-20 | `plans/0004-w5-w8-scale-product.md:369,396,399,517` | `merge/approval 只接受 operator credential` / `human merge receipt` / `merge 仍由 human/policy gate` | 鉴权与 W8 验收按 A | 改为 D 的双 auth 面 + merge owner receipt |
| D-21 | `plans/0005-plan-review-resolutions.md:24,25,72,136` | `human merge` / `merge/approval 只接受 operator credential` / dogfood 到 human merge | 历史 P1 决议按 A | 保留 finding/决议历史，加 `DP-MERGE-1=D` 状态注并修验收口径 |
| D-22 | `README.md:41`；`plans/README.md:26,79` | dogfood 到 human merge；operator 负责 `merge/auto-merge` | 高层口径按 A | 改为 merge 完成；operator 负责 merge policy/hard gates，不负责每 PR merge |
| D-23 | `architecture/skill-migration.md:34,127,201,260` | 已在 2026-10-25 改为 D 口径 | 已处置 | 保留 must-survive；重写产物 = merge-owner runbook + hard gates + evidence checklist |
| D-24 | `architecture/decision-packets/2026-10-25-dp-skill-migration.md:58` | 已改为 D 口径 | 已处置 | 无 |
| D-25 | `reuse/callback-auth.md:46`；`architecture/reuse-review/callback-auth.md:166` | `merge/approval 只接受 operator credential` | approval decide 仍 operator；routine merge 不是 | 拆成 approval decide + merge-owner capability；已加影响注与行内修正 |
| D-26 | `plans/0002-w0-w2-foundation.md:322` | `merge/approval 只接受 operator principal` | 同上 | 已拆成 approval decide + daemon `merge:execute`（Q3 已冻结） |
| D-27 | `architecture/0001-codeteam-architecture-v1.md:1578` | `v1：agent 只出 diff/evidence，人类 merge protected branch` | 漏掉的直接锚（烁烁 P2） | 已改为 gate 后 merge owner（daemon service principal）执行，operator 守硬门 |
| D-28 | `reuse/REUSE-MATRIX.md:58` | `operator-only decide/merge` | P4 单一入口未入矩阵（墨墨 P2） | 已改为 approval decide operator-only；routine merge 走 merge-owner capability |
| D-29 | `architecture/reuse-review/callback-auth.md:39,53,275,308,321` | 影响注已加，但正文五处仍把 merge 挂在 operator credential 下 | 同卡注释与正文打架（墨墨 P2） | 已拆双 auth 面：approval decide vs merge:execute |

### 3.2 派生契约（需三猫 review 后改）

| ID | 锚点 | 现契约 | 为什么漂移 | 待决问题 |
|---|---|---|---|---|
| A-01 | `architecture/reuse-review/approval-index.md:197,200,211,221,268,271,330,470,515,546` | approval decide operator-only；`merge` 是 5 个 producer 之一；merge materialization principal = operator | routine merge 不再需要 operator approval；但 hard-gate merge 仍可能需要 | Q1：`merge` approval kind 只保留 hard-gate，还是 routine 也保留一个“gate evidence”壳？ |
| A-02 | `architecture/0001-codeteam-architecture-v1.md:1468` | `materialization principal: merge=operator`；`merges` 回指 approval | 同上 | Q1/Q5：merge receipt 是否仍绑定 approval_id |
| A-03 | `architecture/reuse-review/ball-custody.md:353,357,892` | `merge` = A2-3 approval；operator decide；`task_done` 等 human merge | merge custody 不是 approval；`task_done` 等的是 merge 完成，不是 operator 按钮 | Q4：merge stage 谁持球、要不要 lease、terminal predicate 是什么 |
| A-04 | `reuse/approval-index.md:40,57` | `merge/approval 只接受 operator credential` | 同上 | Q1/Q3 |
| A-05 | `architecture/reuse-review/github-signals.md:432,470,578,651` | `pr_merged` 不在 v1 10 kinds；理由“v1 人工 merge record 不依赖” | 理由按 A；D 下 merge owner 会直接观察 PR merge truth | Q4：`pr_merged` 仍不放进 10 kinds，还是作为 merge-owner terminal predicate 单独接？ |
| A-06 | `architecture/decision-packets/2026-10-25-dp-github-signals.md:60` | 同 A-05 | 同上 | 随 A-05 |
| A-07 | `plans/0004-w5-w8-scale-product.md:357-359`；`0001:1582` | merge receipt 字段 `baseSha/headSha/mergeSha/approvedBy/receiptRef` | `approvedBy` 暗含 operator 批准；D 需要 merge owner/gate evidence | Q5：改 `executedBy`/`mergeOwner` + `gateEvidenceRef`，还是保留 `approvedBy` 只改语义？ |
| A-08 | `0001:773,1108,1639`；`plans/0004:369,396` | run token 不能 `approval:decide`/`merge:record`；merge/approval 只接受 operator | D 需要 merge-owner capability，但不能放开给任意 run token | Q3：新 capability 名称、绑定对象、TTL、MCP 是否暴露 |
| A-09 | `plans/0001:361`；`plans/0005:72,136`；`README:41` | dogfood 到 human merge；记录 `human intervention` | D 下 routine merge 不是 human intervention | Q6：指标改成 merge-owner latency + operator hard-gate wait；是否保留 human intervention 作为对照 |
| A-10 | `plans/README.md:79` | operator 负责 `merge/auto-merge` | operator 不再负责每 PR merge | Q6：operator 行改为 `merge policy + hard gates`；auto-merge 仍为 C 的后置项 |
| A-11 | `architecture/0003-review-resolutions.md:47` | `v1 agent 零 secret；凭证操作 human/CI` | D 需要 daemon credential，不能由 human 手动每次提供 | Q2：daemon credential 的存储、TTL、scope、撤销、审计 |
| A-12 | `plans/0004:371,372,373` + `architecture/reuse-review/approval-index.md:200` | W7 Console 审批/merge 卡片；MCP 不暴露 merge/approval | D 下 Console 要区分 “hard-gate approval” 与 “merge owner execution status” | Q6：W7 UI 的 merge 卡片显示什么、谁可操作 |
| A-13 | `architecture/0001-codeteam-architecture-v1.md:1468,1639` | merge effect owner 是 operator；merge/approval 同一 auth 域 | D 下 merge effect owner 是 merge owner/daemon；approval decide 仍 operator | Q1/Q3：两套 auth 域如何隔离，如何防越权 |
| A-14 | `reuse/callback-auth.md`；`architecture/reuse-review/callback-auth.md`；`plans/0002` | callback auth 把 merge/approval 放在同一 operator principal 下 | D 需要独立的 merge-owner capability，同时不能放宽 approval decide | Q2/Q3：credential 载体、TTL、scope、撤销、审计 |

> A-01..A-14 的处置以 §4 各 Q 的“Review 结论”为准；A-14 的 credential 约束见 Q2。

### 3.3 不受影响（不要误改）

| ID | 条款 | 为什么不受 D 影响 |
|---|---|---|
| N-01 | merge-gate 5 条证据、exact HEAD、非作者 review、falsifier、merge receipt | D 只改“谁执行”，不改“证据够不够” |
| N-02 | approval decide 仍 operator-only；agent 只能 request | D 没把审批权交给 agent |
| N-03 | 第三方 PR、不可逆 Git 操作、close feat、圣域/生产数据、runtime 生命周期、凭证、外部发布 → operator 硬门 | 这是 D 明确保留的 operator 边界 |
| N-04 | C 类自动 merge 不做 | D 是“gate 后 merge owner 执行”，不是无人 gate |
| N-05 | agent/模型零 secret；token 不进 prompt/log/model | D 的 credential 是 daemon 受信通道，不是 agent token |
| N-06 | `completion` 仍是 feature/backlog 级 operator gate | merge 完成 ≠ feature completion |
| N-07 | GitHub permission gate / HMAC / identity / fail-closed | 属 github-signals，不受 merge authority 改变 |
| N-08 | `merges` 表仍是 merge receipt 的 canonical owner | D 只改执行者，不改 receipt 真相源 |

## 4. 需要三猫讨论的六个问题

### Q1. `approvals(kind='merge')` 还保不保留？

- **A**：routine own-PR merge 不再创建 approval；`merge` approval kind 只用于 hard-gate merge（第三方 PR、例外合入）。merge-gate 证据 + `merges` receipt 是 routine merge 的真相。
- **B**：routine merge 仍创建 `approvals(kind='merge')`，但 decision 由 merge owner 自动/半自动完成，operator 不看；缺点是制造一个“自批”的假 human gate。
- **C**：完全删除 `merge` approval kind；hard-gate merge 走 operator 的不可逆操作授权，不走 approvals。
- 我的倾向：**A**。它保留 hard-gate 的审计面，又不把 routine merge 变成假审批。

**Review 结论（三猫一致）：A。** routine merge 不创建 approval；`merge` kind 只保留给 hard-gate merge（第三方 PR/例外/不可逆）。routine merge 的真相 = gate evidence + `merges` receipt。B 的“merge owner 自批 approval”被明确拒绝（假 human gate）。

### Q2. merge-owner role 与 credential 怎么定？

- merge owner 是“在场执行猫”的 role，还是 daemon 的固定 role？
- credential 是 daemon-held GitHub token、GitHub App installation token，还是本地 `gh` 的受信通道？
- TTL / scope（repo、branch、merge method）/ 撤销 / 审计字段怎么定？
- 是否要求 merge owner ≠ implementer？是否要求 merge owner 已看过 review verdict？

**Review 结论（烁烁/砚砚一致，墨墨无异议）**：merge owner = `service:merge-owner`（daemon service principal），不是 agent；`mergeOwnerProfileId ≠ implementerProfileId`；per-merge minted short-TTL credential（GitHub App installation token 或 scoped gh token），绑 `(repo, PR, exact HEAD)`，TTL 分钟级，mint 前置 = daemon 服务端 E1–E5 核验，执行后立即撤销，审计记 credential id/HEAD/result；HEAD 变化 → credential 失效、重走 gate；不用长期 standing token。

### Q3. auth matrix 怎么拆？

- 建议拆成两个能力：`approval:decide`（operator-only）与 `merge:execute`（merge-owner only，绑定 subject/HEAD）。
- `merge:record` 是 merge-owner/daemon 写 receipt，还是继续 operator CLI？
- run token / MCP / agent-key 对这两个能力的 403 边界；是否需要新的 action lease。

**Review 结论**：拆双能力。`approval:decide` operator-only；`merge:execute` 是 daemon 内部 service action，无 MCP/REST 暴露；`merge:record` 由 daemon 在 execution receipt 同事务写入；run token/agent-key 对两者 403；operator CLI 保留 `codeteam merge run` 作手动触发/调试。

### Q4. merge custody / predicate 怎么定？

- `merge` stage 是由 merge owner 持球，还是普通 handoff？
- 需要 merge-owner lease 吗？如果需要，terminal predicate 是 `pr_merged` 还是 `merge receipt`？
- `task_done` 仍是“task 生命周期完成”，等 merge 完成但不等 operator；`impl` custody 仍在 diff/test report 交付时 discharge。
- `pr_merged` 是否只作为 merge-owner 的 terminal predicate，不进入 GitHub tracking 的 10 kinds？

**Review 结论（技术分歧已合成）**：不采用 merge-stage handoff/lease。理由：merge owner 是 daemon service principal，不是 agent；A3-1 的 `merge_owner` slot 保留给未来 agent merge-owner。v1 用 `merges` 执行记录 + CAS/status，terminal truth = `merges` receipt `succeeded`；成功必须由 merge API response + GitHub reconciliation/`pr_merged` observation 双确认。`pr_merged` 仍是外部观察事实，不进入 GitHub tracking 10 kinds，也不作为 v1 custody predicate。砚砚的 handoff 方案作为未来 agent merge-owner 的备选保留。

### Q5. merge receipt schema 怎么改？

- `approvedBy` 是否改为 `mergeOwner`/`executedBy` + `gateEvidenceRef`？
- exact HEAD/base/strategy 是否必须绑定？HEAD 变化如何处理（stale）？
- 失败/unknown/rollback 的 receipt 状态怎么表达？

**Review 结论**：`merges` 增 `executed_by`/`gate_evidence_ref`/`review_ref`/`status(succeeded|failed|unknown)`/`failure_ref`；routine CHECK `executed_by='service:merge-owner' AND gate_evidence_ref IS NOT NULL`；hard-gate CHECK `approval_id IS NOT NULL`；执行前 re-check `headSha == gate head`，不等则 stale abort + 重走 gate；`approvals.decided_by` 不动，receipt 是独立行。

### Q6. dogfood / W7 UX 口径怎么改？

- W0–W4 dogfood 的里程碑从 “human merge” 改成 “merge owner merge 完成”。
- 指标从 “human intervention” 拆成 `merge_owner_latency` + `operator_hard_gate_wait`；是否保留 human intervention 作对照？
- W7 Console 的 merge 卡片显示：gate evidence、merge owner、credential 状态、merge 结果、失败/unknown；hard-gate approval 单独显示。

**Review 结论**：dogfood 终点 = merge 完成（receipt committed）；指标拆 `merge_owner_latency` / `operator_hard_gate_wait` / `routine_merge_operator_touch_total`，`human_intervention` 保留作对照；W7 merge 卡第一行三态 `waiting-evidence|waiting-human|executing`，merge owner 必填、缺失显示 unknown，`executedBy` 与 approval 来源分两行，W8 增加 `merged-receipt-pending`；completion 真相源 = `merges` receipt + backlog/feature doc sync，merge owner 的“已合”报告不裁决 completion。

## 5. 建议处置顺序

1. **冻结 D 的解释边界**（本审计 §1；DP packet 已记录）。
2. **三猫 review 本审计**：按 §6 分面，给 accept / accept-with-modify / reject；每个 finding 标 P1/P2/P3。
3. **先修直接表述**（§3.1），再按 review 结论修派生契约（§3.2）。
3.5 **复审 grep 清零**：用 §2 关键词表复跑；重点检查“影响注已加、正文未改”的同卡邻近行（D-28/D-29 的漏法）。
4. **冻结 D 的六个契约**：role、credential、auth、approval、custody、receipt；再进 W7/W8。
5. **不阻塞**：W0/W4 其他 skill 迁移、Wave A 已签 schema、`merge-gate` 的 evidence must-survive 条款可继续。

## 6. 三猫分面 review 请求

> 讨论 request：`52960ac8-894c-49c8-9837-04e7a4be68ef`（2026-10-25，parallel，timeout 20m）。

- **烁烁**：`0001` auth matrix、`plans/0001`/`0004` dogfood 与 W8 验收、`ball-custody` merge custody、`pr_merged`/`task_done`、auth capability 命名。
- **砚砚**：daemon-held credential、`approval-index` 的 merge approval / materialization principal、operator hard gates、fail-closed、越权 403、receipt 审计。
- **墨墨**：operator 可读的 merge 状态、W7 Console 卡片、dogfood 指标、`merge-gate` skill 重写口径、`feat-lifecycle`/completion 与 merge 的边界。
- 共同检查：D 是否被误读成 C；routine merge 是否仍保留非作者 review/exact HEAD；third-party/irreversible 是否仍 operator；`approvedBy` 改名是否破坏已有 approval 契约。

## 7. 附录：审计证据

- 直接表述锚点：见 §3.1；共 26 组，覆盖 15 个文件。
- 派生契约锚点：见 §3.2；共 14 组，集中在 `approval-index`、`ball-custody`、`github-signals`、`callback-auth`、`0001` auth、`plans/0002`/`0004`。
- 不受影响条款：见 §3.3；merge-gate 证据段与 operator 硬门不因 D 改变。
- 本次未改实现代码；`codeteam/` 仍 untracked。

## 8. 三猫 review 结果（2026-10-25）

| 角色 | 结论 | Findings | 处置 |
|---|---|---|---|
| 烁烁 | accept-with-modify | P2：`0001:1578` 漏锚（D-27）；P3：artifact-only lane 是更松的对照，D 必须显式声明 gate-first 收紧；Q1=A / Q2=daemon principal / Q3=内部 capability / Q4=无 handoff / Q5=改名加字段 / Q6=指标拆分 | 全部接受；D-27 已修，§1#6 已加，Q4 与砚砚合成 |
| 砚砚 | accept-with-modify | P1：E1–E5 必须由 daemon 服务端强制核验（§1#5）；P2：merge owner ≠ implementer；P2：per-merge short-TTL credential；Q4 主张 merge-stage handoff + `pr_merged` predicate | P1/P2 全部接受；Q4 未采用 handoff 方案，按 service principal 合成为 `merges` 执行记录；handoff 保留为未来 agent merge-owner 备选 |
| 墨墨 | accept-with-modify | P2：REUSE-MATRIX + callback-auth 五处正文漏改（D-28/D-29），加 grep 复审步；P2：must-survive 缺 operator 硬门清单（MS-MERGE-8）；Q6 五条 UX/指标细节 | 全部接受；D-28/D-29 已修，§5#3.5 已加，MS-MERGE-8 已加，Q6 已写回 |

**冻结判断**：三猫均 `accept-with-modify`，无 reject；P1/P2 已回写，Q4 技术分歧已合成。D 的六个契约可按 §9 冻结。

## 9. D 六个契约（review 收敛）

1. **role**：`service:merge-owner`（daemon service principal），不是 agent；`mergeOwnerProfileId ≠ implementerProfileId`。
2. **credential**：per-merge short-TTL，绑 `(repo, PR, exact HEAD)`；mint 前置 = daemon 服务端 E1–E5 核验；执行后立即撤销；审计 credential id/HEAD/result；无长期 standing token。
3. **auth**：`approval:decide` operator-only；`merge:execute` daemon-internal，无 MCP/REST 暴露；`merge:record` daemon 同事务写；run token/agent-key 403。
4. **approval**：Q1=A；routine merge 不创建 approval；`merge` kind 只留 hard-gate。
5. **custody/predicate**：无 agent handoff/lease；`merges` 执行记录 + CAS/status；terminal truth = receipt `succeeded`；`pr_merged` 是外部观察事实，不进 10 kinds，不作 v1 custody predicate；`task_done` 等 receipt。
6. **receipt**：`executed_by`/`gate_evidence_ref`/`review_ref`/`status`/`failure_ref`；`approvals.decided_by` 不动；HEAD 变化 → stale + 重走 gate。

**hard gate**：第三方 PR、不可逆 Git、close feat、圣域/生产数据、runtime 生命周期、凭证/secret、外部发布 → operator；判定由五轴 risk classifier 在 admission 做，规则同时进 merge-gate skill 与 classifier。

**DP-MERGE-2=A（2026-10-25）**：W0–W4 dogfood 采用 D-first；merge service 先接 local `MergeExecutor` adapter（git merge + branch/receipt reconciliation），W8 再接 GitHub adapter；不做 A-interim。两者共用本 §9 的 `merges` receipt、`service:merge-owner`、E1–E5 契约。

[宪宪/deepseek-flash🐾]
