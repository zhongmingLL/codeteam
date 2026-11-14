# Decision Packets

Operator 拍板包。每个 packet 只给价值取舍、推荐、证据和“不拍的后果”，不要求 operator 选技术实现。

| 日期 | Packet | 状态 | 关联卡 |
|---|---|---|---|
| 2026-10-25 | `2026-10-25-dp-a3-ball-custody.md` | decided: A/A/A | `../reuse-review/ball-custody.md` |
| 2026-10-25 | `2026-10-25-dp-a3-memory.md` | decided: A/A/A | `../reuse-review/memory.md` |
| 2026-10-25 | `2026-10-25-dp-a3-observability.md` | decided: A/A/B | `../reuse-review/observability.md` |
| 2026-10-25 | `2026-10-25-dp-bubble-1.md` | decided: A | `../reuse-review/bubble-pipeline.md` |
| 2026-10-25 | `2026-10-25-dp-github-signals.md` | decided: A/A | `../reuse-review/github-signals.md` |
| 2026-10-25 | `2026-10-25-dp-plugin.md` | decided: A/A | `../reuse-review/plugin.md` |
| 2026-10-25 | `2026-10-25-dp-skill-migration.md` | decided: A/A/A（merge-gate 已改按 DP-MERGE-1=D） | `../skill-migration.md` |
| 2026-10-25 | `2026-10-25-dp-merge-authority.md` | decided: D（三猫 accept-with-modify；D 六契约已冻结） | `../skill-migration.md` |
| 2026-10-25 | `2026-10-25-dp-merge-2.md` | decided: A（D-first；W0–W4 local MergeExecutor，W8 GitHub adapter） | `../merge-authority-drift-audit.md` |
| 2026-10-25 | `2026-10-25-dp-harness-eval.md` | decided: A/A/A（P0 envelope/finding/lifecycle；artifacts+events；review/eval 分账） | `../reuse-review/harness-eval.md` |
| 2026-10-25 | `2026-10-25-dp-web-baseline.md` | decided: B（W7a C + W7b Console 均 classic；v2 推迟） | `../../plans/0004-w5-w8-scale-product.md` |
| 2026-11-07 | `2026-11-07-dp-f018-queue-interfaces.md` | decided: A/B/A | `../0007-a2a-runtime-chain.md` |
| 2026-11-09 | `2026-11-09-dp-f018-tracker-reaper.md` | decided: B/B/A | `../0007-a2a-runtime-chain.md` |
| 2026-11-09 | `2026-11-09-dp-f018-operator-routing.md` | decided: A/A/A | `../0007-a2a-runtime-chain.md` |
| 2026-11-11 | `2026-11-11-dp-f018-auth-credential.md` | decided: A/A/B/A/A | `../0007-a2a-runtime-chain.md` |
| 2026-11-11 | `2026-11-11-dp-f018-a2a-tools.md` | decided: 1=A+（piExtToolCallId）/2=A/3=A/4=A/5=A | `../0007-a2a-runtime-chain.md` |
| 2026-11-11 | `2026-11-11-dp-f018-terminal-aggregate.md` | decided: 1=A/2=A/3=A/4=A/5=A/6=A/7=A | `../0007-a2a-runtime-chain.md` |
| 2026-11-11 | `2026-11-11-dp-f018-recovery-liveness.md` | decided: 1=A/2=A/3=A/4=A/5=A/6=A/7=A | `../0007-a2a-runtime-chain.md` |
| 2026-11-11 | `2026-11-11-dp-f018-operator-journey.md` | decided: A/B/E；C/D investigation complete | `../0007-a2a-runtime-chain.md`、`../0015-codeteam-operator-journey-audit.md` |
| 2026-11-12 | `2026-11-12-dp-f018-surface-depth-readmodels.md` | decided: 1/2/3；F-15 契约见 `0017` | `../0007-a2a-runtime-chain.md`、`../0015-codeteam-operator-journey-audit.md` |
| 2026-11-14 | `2026-11-14-dp-f018-global-review.md` | decided: MENTION-1=B/MM-1=B/IDEM-1=B/MM-2=A | `../0018-v1-global-design-review.md`、`../0007-a2a-runtime-chain.md`、`../0008-agent-config.md` |

拍板格式：`DP-XXX-N=A`，多项一行。2026-10-25 已 decided：ball-custody A/A/A、memory A/A/A、observability A/A/B、bubble-pipeline A（W1 冻结，W7 approved-for-direction）、github-signals A/A（GitHub-only + 复用 tasks/waits/audit/forge_deliveries，含 audit 收窄护栏）、plugin A/A（skill surface only + repo-local curated）、skill 内容迁移 A/A/A（矩阵 + W0/W4 范围 + 一次性 fork）；merge authority **D**（clowder parity；A 仅零-secret 临时偏差，不得写成 clowder SOP；漂移审计见 `../merge-authority-drift-audit.md`）；W0–W4 dogfood **`DP-MERGE-2=A`**（D-first，local `MergeExecutor`；W8 GitHub adapter）；harness-eval **A/A/A**（P0 envelope/finding/lifecycle；artifacts+events；review/eval 分账）；前端复用 **`DP-WEB-1=B`**（W7a C + W7b Console 均 classic）。

2026-11-11 新增：**`DP-F018AUTH=A/A/B/A/A`**（credential 绑 child TurnExecution；幂等 claim 放 credential 的 `toolCallClaims` map（原 `clientMessageIds`，随 DP-F018A2A-1 改名）；active 无 TTL + startup sweep；pi extension 只注册 F018 四工具）。

2026-11-11 新增：**`DP-F018A2A=A+/A/A/A/A`**（1=A+ 字段名 `piExtToolCallId`，pi extension 从 `toolCallId + toolName` 派生并注入；2=A multi_mention 一条 message + 一条 queue entry；3=A operator 只通知；4=A cross_post 同 user/active/projectPath/provenance；5=A 删除 `kind`）。

2026-11-11 新增：**`DP-F018TERM=A/A/A/A/A/A/A`**（all-canceled → canceled；auto-retry pending 保持非终态；tracker slot 每 child terminal 释放；terminal first-write-wins；requestRetry 由 QueueProcessor 编排且只 retry failed/interrupted；dispatchRefs 更新 latest attempt + failed entry abandon/TTL；parent 持久化 primaryTerminalError）。

2026-11-11 新增：**`DP-F018RECOVERY=A/A/A/A/A/A/A`**（startup 只结算上一进程 ended turn；zombie stale lease + owner absence；单 serialized reaper；zombie 收敛 child R→queue→parent→credential→slot；live projection 去重/evidence rank/过滤 terminal R；response_missing 独立 recovery；provider exit 5min grace + owner fence）。

2026-11-13 定稿：**`DP-F018SURFACE=A/A/A`**：post/cross 单 successor + `multi_mention`
唯一 fan-out；A2A depth 15 + per-thread queue cap 5 + substantive-aware ping-pong/
early-stop；F018 定义 `QueueView`/`LiveInvocationView`/`MessageDispatchSummary` domain
DTO。F-15 `ResponseDraftStore` 契约见 `../0017-response-draft-store.md`。

2026-11-14 定稿：**`DP-F018MENTION-1=B` / `DP-F018MM-1=B` / `DP-F018IDEM-1=B` /
`DP-F018MM-2=A`**。operator 用户消息允许正文任意 `@`；multi_mention callbackTo 创建
callback child；completed 跨 tool-call 重复风险 v1 接受；全 failed group 保持
`done + allFailed`。字段 `mentionPatterns` 本身已按 Clowder `CatConfig` 落地。

> 覆盖审计（2026-10-25）：11/11 decided packet 均有 plans 落点，逐项映射见 `../../plans/0007-architecture-plan-coverage.md` §1.1；三猫 v2 复审全部 accept，0007 冻结为唯一对账索引。

[宪宪/deepseek-flash🐾]
