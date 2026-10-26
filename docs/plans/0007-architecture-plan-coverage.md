---
title: "架构卡 / Decision Packet → plans 覆盖矩阵"
doc_kind: index
status: reviewed
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
---

# 架构卡 / Decision Packet → plans 覆盖矩阵

## 0. 用途

回答一个问题：**我们 review 过的架构卡和 operator 拍过的决定，是否都能在 plans 里找到可执行落点、验收和回滚？**

规则：一张卡/一个 DP 至少要有

1. 对应 W 章节的任务/交付物；
2. 至少一条 acceptance；
3. 风险/回滚或明确的 defer。

没有落点的卡不能进入实现；只在卡里写、不在 plan 里排，视为覆盖缺口。

## 1. 覆盖矩阵

| 架构项 / 决策 | 状态 | plans 落点 | 覆盖 | 备注 |
|---|---|---|---|---|
| A1-1 `identity-session` | approved | `0002 W1`（threads/roles/agent_profiles/agent_sessions）、`0002 W2`（identity/session）、`0003 W4`（thread CLI） | ✅ | `roles` 动态 registry；W1 新增 eval/compress seed；W4 补最小 thread 聊天落点 |
| A1-2 `callback-auth` | approved | `0002 W2` callback auth 落地补充、`0002 W1` invocation_credentials | ✅ | per-run token / operator credential / 3 auth 域 |
| A1-3 `dispatch` | approved | `0002 W1` queue_entries/messages；`0004 W5` A2A 执行链 | ✅ | 单 pending-wake ledger |
| A1-4 `runtime-deployment` | approved | `0002 W0c` daemon lifecycle/readiness；`0004 W5` deployment wait | ✅ | loopback/ready/boot ledger |
| A2-1 `sop-bulletin` | approved | `0003 W4` WorkflowSop/gates | ✅ | stage 告示牌 + CAS |
| A2-2 `managed-work` | approved | `0002 W1` 5d；`0004 W5` sticky retry | ✅ | work_admissions/attempt + bind-once |
| A2-3 `approval-index` | approved | `0002 W1` approvals；`0003 W4` approval CLI；`0004 W7` Approval Hub | ✅ | 三锚/effect receipt/5 kinds |
| A3-1 `ball-custody` | approved | `0004 W5` custody/wait | ✅ | F167/F233/F280；DP-A3-1 A/A/A |
| A3-2 `memory` | approved | `0004 W6` 6A | ✅ | file evidence subset；DP-MEM A/A/A |
| A3-3 `observability` | approved | `0004 W6` 6E；`0004 W7` 只读面 | ✅ | DP-OBS A/A/B；F150/F130 parity |
| Wave B `bubble-pipeline` | approved | `0002 W1` messages identity；`0004 W7` timeline/live-hydration | ✅（本轮补） | DP-BUBBLE-1=A：W1 identity 冻结；W7 approved-for-direction |
| Wave B `github-signals` | approved | `0004 W8` + 2026-10-25 hardening + GS-1..GS-10 实施切片 | ✅ | DP-GH A/A；`pr_merged` 外部观察；GS review `8290c9ca…` 烁烁 accept、砚砚/墨墨 accept-with-modify，P2/P3 已回写 |
| Wave B `plugin` | approved | `0002 W0` 2b curated skill surface；`0003 W4` skill surface | ✅ | DP-PLUGIN A/A |
| Wave B `harness-eval` | approved | `0001 W6` + `0004 W6` 6F | ✅（本轮补） | DP-HE A/A/A；P0 envelope/finding/lifecycle |
| Skill 内容迁移 | approved | `0003 W4` + S0 批次；`0002 W0` 2b 门禁 | ✅（本轮补） | 矩阵 + must-survive + review/dry-run |
| Merge authority D | decided | `0003 W4`；`0001 W4/W7/W8`；`0004 W7/W8`；`0005` | ✅（本轮补） | merge owner execute；operator 硬门；C 不做 |
| DP-MERGE-2=A | decided | `0001 W4`；`0004 W7`；`0005` | ✅ | W0–W4 local `MergeExecutor`；W8 GitHub adapter |
| 动态 roles `eval`/`compress` | operator clarified | `0002 W1` 3b + acceptance；`0001 W6`；`0004 W6` 6F | ✅（本轮补） | 不是 enum；AgentProfile + roles table |
| Wave B 其余 7 项 | not started | `0004` §6 Wave B 清单 | ⏸ defer | code-intelligence / hub-action-surface / human-disposition-feedback / mcp-surface-governance / routing-context / thread-chat-surface / thread-navigation；等 W4 dogfood/按需启动。`thread-chat-surface`/`thread-navigation` 在 W7b/Console M0 前补卡；W7a 只做必要的 server-side 投影。这两个 cell 只 defer 前端壳/投影，不 defer server-side 能力（messages/seq/DP-BUBBLE-1 已在 W1 冻结） |
| W7b 前端复用基线 | decided `DP-WEB-1=B` | `0004 W7` + `2026-10-25-dp-web-baseline.md` | ✅ | W7a C + W7b Console 均 classic；v2 推迟到后续 DP/计划 |
| F311 capability evolution | excluded | — | ⛔ drop | 不在 codeteam v1 |
| F266/F267/F278 全量治理 | R2 borrow | `0004 W6` 6F 明确不做 | ⏸ defer | v1 只 borrow 形状；不搬 repair/issuer/inbox |

### 1.1 Decision Packet → plans 落点

审计范围：`architecture/decision-packets/` 下 11 个 `status=decided` packet。

| DP | 结论 | plans 主落点 | 覆盖 |
|---|---|---|---|
| `DP-A3-1-1/2/3` | A/A/A | `0002 W1` custody/claim；`0004 W5` Ball custody/wait；`0004 W7` operator @ 转 typed inbox | ✅ |
| `DP-MEM-1/2/3` | A/A/A | `0004 W6` 6A；`architecture/memory-schema.md` | ✅ |
| `DP-OBS-1/2/3` | A/A/B | `0004 W6` 6E；`0004 W7` 只读面 | ✅ |
| `DP-BUBBLE-1` | A | `0002 W1` message identity；`0004 W7` timeline/live-hydration | ✅ |
| `DP-GH-1/2` | A/A | `0004 W8` + GS-1..GS-10 | ✅ |
| `DP-PLUGIN-1/2` | A/A | `0002 W0` 2b；`0003 W4` skill surface | ✅ |
| `DP-HE-1/2/3` | A/A/A | `0001 W6`；`0004 W6` 6F | ✅ |
| `DP-SKILL-1/2/3` | A/A/A | `0002 W0` 2b；`0003 W4` S0 批次 | ✅ |
| `DP-MERGE-1` | D | `0001 W4/W7/W8`；`0003 W4`；`0004 W7/W8`；`0005` | ✅ |
| `DP-MERGE-2` | A | `0001 W4`；`0004 W7`；`0005` | ✅ |
| `DP-WEB-1` | B | `0004 W7`（W7a C + W7b Console 均 classic） | ✅ |

卡片级决定（A2-1/A2-2/A2-3）没有单独 packet 文件，落点见上表对应行；`DP-A2-2-1=A`（sticky retry）在 `0004 W5` task 18 + acceptance。

`DP-WEB-1` 已由 operator 拍 B；11/11 decided packet 均有 plans 落点。

### 1.2 卡片级决定登记

> 仅登记跨 plan 的关键卡级决定；完整卡内决定以对应卡为准。

| 卡级决定 | 卡锚 | plans 落点 |
|---|---|---|
| A1-1 动态 roles `eval`/`compress` | `identity-session` | `0002 W1` 3b |
| A1-3 D23 routeIntent typed / 正文 @ 不作路由 | `dispatch` | `0004 W5` A2A tool surface |
| A1-4 daemon loopback / webhook opt-in | `runtime-deployment` + `github-signals` | `0004 W8` GS-6 |
| A2-1 G15 `system:forge:<provider>` + `humanGuidance` inbox | `sop-bulletin` G15 | `0004 W8` GS-2/GS-7；`0001 §12.2` |
| A2-2 `DP-A2-2-1=A` managed-work sticky retry | `managed-work` | `0004 W5` task 18 + acceptance |
| A2-2 loop guard / 五轴风险 | `managed-work` | `0003 W4` Gate model |
| A2-3 effect receipt 1:1 | `approval-index` | `0002 W1` approvals；`0003 W4` approval CLI |
| A3-1 `DP-A3-1-3=A` operator @ → typed inbox | `ball-custody` | `0004 W7` thread chat / ingress |

## 2. 本轮发现并修复的缺口

| # | 缺口 | 修复 |
|---|---|---|
| 1 | `0003 W4` 仍写 `merge-gate` pending `DP-MERGE-1` | 改为 `DP-MERGE-1=D` / `DP-MERGE-2=A`；merge-owner runbook + local `MergeExecutor` + `MS-MERGE-1..8` |
| 2 | `0002 W1` roles 只写“前端可加 writer”，没有 eval/compress seed 与 AgentProfile 契约 | 新增 W1 3b：seed `architect/coder/reviewer/verifier/eval/compress`；AgentProfile 字段/解析/fail-closed；W0 只验证 loader |
| 3 | `0002 W1` messages 缺 `seq`/`reply_to`/`runs.response_message_id`/`execution_kind` | 补 target table/task/acceptance；response bubble identity 与 orphan health 入门禁 |
| 4 | `0004 W6` 没吸收 harness-eval 卡（只有 0001 W6 有） | 新增 `6F Harness Eval` + tasks 13–17 + acceptance |
| 5 | `0004 W7` 仍把 merge 卡写成 operator 操作；缺 bubble timeline/eval CLI | 改为 hard-gate approval + merge execution status；补 timeline/live-hydration；补 `merge run`/`eval` CLI |
| 6 | `0004 W8` 缺 `pr_merged`/merge terminal truth 边界 | 补 `pr_merged` 外部观察、`merges` receipt 是 terminal truth；同步清掉 W8 Inbound 旧 `merge → merge receipt` 正文 |
| 7 | `0004 W6` 动态 role 未落 plan | 6F 明确 `evalAgent` 指向 `role='eval'` AgentProfile；不是 catId |
| 8 | `0004`/`0004-reuse-architecture-review-plan` 仍写 Wave B 全部等 W4 dogfood | 改为“4 项已提前 approved（bubble-pipeline/github-signals/plugin/harness-eval）；余 7 项待 W4 dogfood” |
| 9 | `REUSE-MATRIX`/`0006` 仍写 P1-active 10 项全部在 W4 后补 | 改为“3/10 已收口（github-signals/memory/observability）；余 7 项待 W4 dogfood” |
| 10 | 多个具体 DP ID 只在 0007 出现，plan 正文没有回指 | `0002 W1` 补 `DP-BUBBLE-1=A`；`0003 W4` 补 `DP-SKILL-1/2/3=A/A/A`；`0004 W5` 补 `DP-A3-1-1/2/3=A/A/A`；`0004 W6` 6A/6E 补 `DP-MEM`/`DP-OBS`；`0004 W7` 补 `DP-A3-1-3=A` |
| 11 | `codeteam/README.md` 缺 0005/0007/decision-packets/skill-migration/memory-schema/merge audit 索引 | 补齐文档索引 |
| 12 | A2-2 sticky retry 只有 acceptance 行、没有 task 行；烁烁 P1 初判为“任务/验收均未落” | 复核确认 `0004 W5` acceptance 已有；补 task 18 + bind-once 测试行，§1.1 精确引用 |
| 13 | W0–W4 纯 CLI 阶段没有 operator↔agent thread 聊天落点（墨墨 P2-1） | `0003 W4` 增 `codeteam thread list/show/post/tail` task/deliverable/acceptance；thread 创建仍只走 backlog dispatch；`0004 W7` 注明 W4 CLI → W7a API → W7b surface |
| 14 | `messages.kind='agent_response'` 未回写 0001 `Message.kind` 枚举（烁烁/砚砚 P3） | 0001 enum 补 `agent_response`；§4 加“kind 值域变更必须回写 0001” |
| 15 | 卡片级决定无登记面（墨墨 P3-1） | 新增 §1.2 卡级决定登记表 |
| 16 | thread-chat-surface/navigation defer 容易被误读为“server-side 能力也 defer”（墨墨 P3-2） | Wave B 备注补“只 defer 前端壳/投影，不 defer server-side 能力（messages/seq/DP-BUBBLE-1 已在 W1 冻结）” |
| 17 | 砚砚 P3-2：plugin realpath/secret scan 未在 plan 正文显式 | `0002 W0` 2b + `0003 W4` skill 迁移补 containment/allowlist/secret scan；github timing-safe/secret 已在 GS-6 确认无残留 |
| 18 | W7b 未明确复用 classic 还是 v2；classic 已 frozen，v2 仍 in-progress | 已拍 `DP-WEB-1=B`：W7a/W7b 均 classic；v2 推迟；`0004 W7` 任务/验收已改 |

## 3. 仍需注意的边界

- Wave B 其余 7 项没有逐项 W 任务，这是有意的 **defer**，不是遗漏；启动时再按同一模板补卡和 plan 条目。
- `bubble-pipeline` W7 是 **approved-for-direction**，W4 dogfood 后可按实测修订文案/恢复入口，但 W1 message identity 不改。
- `harness-eval` 的完整 DDL/权限矩阵在架构卡；plans 只冻结任务/验收，不复制整张卡。
- 所有 `codeteam/` 仍是 untracked 文档；未 commit/push。
- P3 观测项（2026-10-25 复审后）：github-signals 的 `crypto.timingSafeEqual`/webhook secret 存储在 `0004 W8` GS-6 与 acceptance；plugin 的 realpath containment/allowlist/secret scan/供应链第一防线在 `0002 W0` 2b 与 `0003 W4`；`messages.kind` 在 `0001:288` + §12.2。当前无未登记阻塞性 P3。
- W7b 前端复用基线已拍 `DP-WEB-1=B`：W7a/W7b 均 classic；v2 不进入 v1；不影响 W1–W7a server-side。
- W0–W4 dogfood 的 operator 交流 = **CLI thread chat**（`backlog dispatch` 建 thread → `thread post/tail`）；不依赖 Web，但不是无聊天。若要求首个 dogfood 就有浏览器聊天，需把 W7a C 体验前置，属于阶段顺序变更，需 operator 重拍。

## 4. 验证方法

- 新增架构卡/DP 时，必须同时在本矩阵加一行；没有行不进入实现。
- 每个 W 的 acceptance 至少引用一个卡/DP 的关键契约。
- 三轮 review 后，`0004` 的 Wave B 状态与 `decision-packets/README.md` 对账。
- 回写 = 改 plan 正文的 task/acceptance/risk 行，不只在索引或注里声明；抽查用 grep 验证。
- `messages.kind` 值域变更必须同步回写 `0001` `Message.kind` 与 §12.2 说明。
- 卡片级决定必须登记到 §1.2；否则“无 orphan decision”只对 packet 成立。

## 5. 全量审计记录（2026-10-25）

- **范围**：`architecture/reuse-review/` 14 张 approved 卡 + `architecture/decision-packets/` 11 个 decided packet + `plans/0001`–`0007`。
- **结果**：14/14 卡有 plans 落点；11/11 decided packet 有 §1.1 落点。
- **本轮修复**：Wave B 提前 approved 与剩余 defer 的口径统一；P1-active 3/10 已收口口径统一；关键 DP ID 回指到 W 章节；README 索引补齐；补 A2-2 task 18、W0–W4 thread CLI、`agent_response` 枚举、§1.2 卡级决定登记、defer 注；`DP-WEB-1=B` 收口。
- **三猫 review 结论**：砚砚 accept；烁烁 accept-with-modify（A2-2 task 缺口，复核确认 acceptance 已在，补 task 18）；墨墨 accept-with-modify（W0–W4 thread CLI 缺口 + 3×P3）。上述 findings 已回写。
- **v2 复审**：烁烁/砚砚/墨墨全部 accept；P1/P2 关闭；砚砚 2 条可选 P3 已挂 §3；`0007` 冻结为 DP→plan 唯一对账索引。
- **新增 decided**：`DP-WEB-1=B`（W7a C + W7b Console 均 classic；v2 推迟）。
- **有意保留的 defer**：Wave B 其余 7 项（含 `thread-chat-surface`/`thread-navigation`）；W7 `approved-for-direction`；memory thread messages 索引 defer→W6+；F266/F267/F278 只 R2 borrow；F311 不进 v1。
- **边界**：`codeteam/` 仍是 untracked 文档；本审计不改实现代码、不 commit/push。

[宪宪/deepseek-flash🐾]
