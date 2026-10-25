---
title: "DP-MERGE-1: codeteam merge 权限重新讨论"
doc_kind: decision-packet
status: decided
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related_cards:
  - ../skill-migration.md
  - ../reuse-review/approval-index.md
research: ../operator-responsibility-research.md
operator_decision: "DP-MERGE-1=D (2026-10-25)"
decision_note: "D is the target contract. Interim A is allowed only if zero-secret blocks the D credential/role contract, must be explicitly labeled, and must not be written as clowder SOP. Detailed auth/approval/custody deltas are tracked in ../merge-authority-drift-audit.md for three-cat review."
---

# DP-MERGE-1: codeteam merge 权限

## 0. 一句话

**Operator 2026-10-25 决定：`DP-MERGE-1=D`。** codeteam 采用 clowder parity：routine own-PR merge 由 gate 后的 merge owner（猫/daemon role）执行；operator 只守愿景/第三方/不可逆/凭证/runtime/外部发布等硬门。C 类无人逐次 gate 的自动合并不做。若零-secret 暂时支持不了 daemon merge credential，A 只能作明确标注的临时偏差，不能写成 clowder SOP。

## 1. 这个决定在哪里出现过

| 文档 | 原文/位置 | 状态含义 |
|---|---|---|
| `features/F001-architecture-v1.md:144` | D7：**v1 human merge**，理由“不可逆操作先保守” | F001 status `reviewed`；无 operator_signoff 字段 |
| `architecture/0003-review-resolutions.md:121` | “Merge：v1 human merge；W1–W6 用 CLI record receipt” | status `accepted-for-doc-update`；三猫评审决议，不是 operator 签字 |
| `architecture/0001-codeteam-architecture-v1.md:710` | #11：任何不可逆操作（merge protected branch、push、删除数据、force push）必须走 human/policy gate | 架构不变量 |
| `architecture/0001-codeteam-architecture-v1.md:773` | Run 权限允许 `approval_request`，不允许 `approval:decide` / `merge:record` | auth 矩阵 |
| `architecture/0001-codeteam-architecture-v1.md:1638` | merge/approval decide 端点只接受 operator credential；run token 403 | auth 矩阵 |
| `architecture/0001-codeteam-architecture-v1.md:1914` | “人工触发合并，GitHub 只作为证据和交付出口” | §18.1 v1 范围 |
| `plans/0003-w3-w4-review-sop.md:230` | `merge` gate = policy + human；clowder merge-gate 5 条 + exact HEAD continuity + merge receipt | plan status `reviewed` |
| `plans/0003-w3-w4-review-sop.md:233` | merge-gate 5 条是证据清单，不是执行授权；执行权 operator-only，agent 只能 `approval_request` | plan 内的架构假设 |
| `plans/0004-w5-w8-scale-product.md:517` | W8 acceptance：merge 仍由 human/policy gate 触发 | plan status `reviewed` |
| `plans/0001-runtime-hardening.md:420` | “自动 merge：v1 保持 human merge；自动 merge 阈值与回滚策略后置” | plan status `reviewed` |

**关键结论**：这些文档反复记录了“v1 human merge”，但**没有一份带 operator_signoff 的 merge authority 决策**。2026-10-24 operator 拍的是“全面复用 clowder SOP”（`plans/0003-w3-w4-review-sop.md:170`），不是“merge 由谁执行”的独立拍板。所以它应被视为**已记录的架构默认**，而不是已签死的 operator 决定；现在重新讨论是正确的。

### 1.1 clowder operator 一手调研

详见 `../operator-responsibility-research.md`。关键事实：

- `docs/SOP.md:72` 的不可逆清单只列“合**第三方** PR”，没有 routine own-PR merge。
- `cat-cafe-skills/merge-gate/SKILL.md:37`：evidence 闭合后由**在场 merge owner** 执行 `gh pr merge`。
- `docs/SOP.md:235-258`：artifact-only PR 由非作者猫自决 squash merge，operator 不在 reviewers / 不需 sign-off。
- `docs/features/F217-merge-gate-integrity.md:23`、`:33`、`:142-143`：operator 拍板私有仓靠 main-green + 本地 gate + 跨猫 review 家规；猫可 self-merge，operator 接受 <1% 风险。
- operator 的硬门是愿景/scope/F 号、第三方 PR、不可逆 Git 操作、圣域/生产数据、凭证/secret、runtime 生命周期、外部发布、Approval Hub 决策与升级。

**所以 clowder 的 operator 不是“每 PR merge 按钮”；codeteam 的 operator-only 是更严的 codeteam 默认，不是 clowder 继承。**

## 2. 当前默认的理由（我的理解）

1. **不可逆性**：merge protected branch 是 v1 少有的不可逆操作；先保守。
2. **零 secret 边界**：v1 agent 不持有 GitHub/merge token；凭证操作归 human/CI（0003 P1 Secret 条款）。
3. **auth 矩阵**：run token 只能 `approval_request`；`approval:decide` / `merge:record` 只接受 operator credential。
4. **证据与授权分离**：merge-gate 5 条是“证据清单”，不是“执行授权”；两者分离防止 agent 用 gate 自证权限。
5. **没有自动 merge 的阈值/回滚策略**：0003 §6 明确“自动 merge 的阈值与回滚策略（v1 不做）”。
6. **W8 outbound 后置**：GitHub merge 事件只作为证据/交付出口；outbound 写操作需 human/policy gate。
7. **dogfood 度量（A 默认时期）**：W0–W4 原来要跑到 human merge，把 human intervention 作为真实成本记录而不是隐藏；`DP-MERGE-1=D` 后改为记录 merge-owner latency + operator hard-gate wait，human intervention 仅作对照。

## 3. 选项

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（当前默认；仅作零-secret v1 临时偏差）** | Operator 决策 + 执行 merge（CLI/Console）；agent 只准备 evidence + `approval_request`；agent 无 merge 凭证 | 最强安全边界；零 secret；human 终门清晰 | operator 成为 merge 瓶颈；time-to-green 含人工延迟 |
| B | Operator 批准 **exact HEAD/base** 的 merge；daemon/CLI 用短时效、最小 scope 凭证执行；approval one-shot、绑定 exact HEAD，HEAD 变化即 stale；仍不是 auto-merge | 保留 human 决策，减少手工执行；可度量 approval→merge 延迟 | 新凭证/approval materialization/失败恢复/rollback 契约；更适合 W7/W8 |
| C | 策略自动 merge：gates 全绿后无人逐次批准 | 最快 | 不可逆风险；无 v1 rollback 策略；违反零 secret/凭证边界；不建议 v1 |
| **D（目标态推荐，clowder parity）** | merge owner（猫/daemon）在 gate 通过后执行 merge；operator 只处理硬门（第三方 PR、不可逆 Git 操作、close feat、圣域、runtime、凭证、外部发布） | 最接近 clowder SOP；operator 不成为每 PR 瓶颈 | 需要 daemon-held 短时效 merge credential + merge-owner role + risk policy + audit；W7/W8 安全契约 |

## 4. Operator 决定与解释

**决定：D（clowder parity）。** operator 不应成为每 PR 的 merge 按钮；merge 由 gate 后的 merge owner 执行，operator 守硬门。**v1 若零-secret 还不能安全支持 daemon merge credential，则 A 只能作为明确标注的临时 codeteam 偏差**，跑 W0–W4 dogfood 并记录 operator merge 等待；D 的 credential/role/risk-policy/audit 契约仍必须在 W7/W8 前补齐。B 是“operator 想保留 per-merge 人类决策、但减少手工执行”的中间态，不采用；C 不进 v1。

**D 的解释边界**：

- “merge owner 执行”不等于“无人 gate”：merge-gate 证据、非作者 review、exact HEAD、falsifier、merge receipt 全部保留。
- “merge owner 执行”不等于“C 自动 merge”：仍有一个具名 merge owner 在证据闭合后执行。
- “operator 守硬门”：第三方 PR、不可逆 Git 操作、close feat、圣域/生产数据、runtime 生命周期、凭证/secret、外部发布仍需 operator 授权。
- “零 secret”只约束 agent/模型面；daemon-held 短时效 merge credential 是独立受信通道，不能进 prompt/log/model。

无论最终执行模型（A/B/C/D 讨论时点），以下不变量不变：

- merge-gate 5 条是证据清单，不是执行授权；
- exact HEAD + review provenance + 非作者 review + falsifier 证据；
- agent 不能 self-approve，不能伪造 approval；
- merge receipt/audit 必须可追溯；
- `merge-gate` 内容迁移的 `MS-MERGE-1..8` 必须保留；D 只改“执行段”，不改证据段；`MS-MERGE-8` 是 operator 硬门清单。

## 5. 对 skill migration 的影响

- `merge-gate` 仍判 **W**；按 **D** 重写为“merge-owner runbook + operator 硬门 + agent evidence checklist”。
- skill 教“gate 后由 daemon `service:merge-owner` 执行”，不教无人 gate 的自动合并；`gh pr merge` 只在 merge service 执行段出现，不能成为 agent 自由命令。
- 硬门清单（第三方/不可逆/close/圣域/runtime/凭证/外部发布）必须在 skill 内显式列出。
- 零-secret 只约束 agent/模型面；daemon merge credential 的获取/使用/撤销必须在 runtime 契约里写清。

## 6. 决定后的六个契约

按 D 落地前必须补齐，进入 W7/W8 安全契约：

1. **merge-owner role**：谁有资格在 gate 后执行；是否绑定 AgentProfile/role；与 implementer/reviewer 的隔离。
2. **credential model**：daemon-held、短时效、最小 scope、按 repo/branch 限定；不进 prompt/log/model；失败/泄露撤销。
3. **auth matrix delta**：`merge:record`/`merge:execute` 从 operator-only 改为 merge-owner capability；approval decide 仍 operator-only；run token/agent-key 仍不能任意 merge。
4. **approval semantics**：routine own-PR merge 是否还需要 `approvals(kind='merge')`，还是只保留给硬门 / 第三方 PR；`merges` receipt 仍是效果真相。
5. **custody / predicate**：merge stage 由谁持球、是否需要 merge-owner lease、`pr_merged` 与 merge receipt 的关系；`task_done` 仍等 merge 完成，但不等 operator 按钮。
6. **receipt schema**：`approvedBy` 是否改为 `mergeOwner`/`executedBy` + `gateEvidenceRef`；如何保留 exact HEAD/base/strategy、失败/unknown、rollback。

### 6.1 三猫 review 后的冻结建议（2026-10-25）

1. **role**：`service:merge-owner`（daemon service principal），不是 agent；`mergeOwnerProfileId ≠ implementerProfileId`。
2. **credential**：per-merge short-TTL，绑 `(repo, PR, exact HEAD)`；mint 前置 = daemon 服务端 E1–E5 核验；执行后立即撤销；审计 credential id/HEAD/result；无长期 standing token。
3. **auth**：`approval:decide` operator-only；`merge:execute` daemon-internal，无 MCP/REST 暴露；`merge:record` daemon 同事务写；run token/agent-key 403。
4. **approval**：Q1=A；routine merge 不创建 approval；`merge` kind 只留 hard-gate。
5. **custody/predicate**：无 agent handoff/lease；`merges` 执行记录 + CAS/status；terminal truth = receipt `succeeded`；`pr_merged` 是外部观察事实，不进 10 kinds，不作 v1 custody predicate；`task_done` 等 receipt。
6. **receipt**：`executed_by`/`gate_evidence_ref`/`review_ref`/`status`/`failure_ref`；`approvals.decided_by` 不动；HEAD 变化 → stale + 重走 gate。

> 三猫 review：烁烁 accept-with-modify（D-27 + gate-first 注）、砚砚 accept-with-modify（P1-1 daemon E1–E5 + merge owner ≠ implementer + credential）、墨墨 accept-with-modify（D-28/D-29 + MS-MERGE-8 + Q6 UX）。Q4 的 handoff 分歧按 service principal 合成为 `merges` 执行记录；handoff 保留为未来 agent merge-owner 备选。

## 7. 决定后的落地顺序

1. 冻结本决定与解释边界（本 packet）。
2. 完成全量文档漂移审计：`../merge-authority-drift-audit.md`。
3. 三猫讨论并处置漂移（2026-10-25 完成：均 accept-with-modify，P1/P2 已回写）。
4. 按 §6.1 冻结 D 的六个契约，再进入 W7/W8；W0/W4 其他 skill 迁移不阻塞。
5. `DP-MERGE-2=A` 已确认（2026-10-25）：W0–W4 dogfood 采用 D-first，先落 local `MergeExecutor` adapter；W8 再接 GitHub adapter。不做 A-interim。

[宪宪/deepseek-flash🐾]
