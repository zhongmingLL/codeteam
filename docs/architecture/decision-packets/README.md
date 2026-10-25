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

拍板格式：`DP-XXX-N=A`，多项一行。2026-10-25 已 decided：ball-custody A/A/A、memory A/A/A、observability A/A/B、bubble-pipeline A（W1 冻结，W7 approved-for-direction）、github-signals A/A（GitHub-only + 复用 tasks/waits/audit/forge_deliveries，含 audit 收窄护栏）、plugin A/A（skill surface only + repo-local curated）、skill 内容迁移 A/A/A（矩阵 + W0/W4 范围 + 一次性 fork）；merge authority **D**（clowder parity；A 仅零-secret 临时偏差，不得写成 clowder SOP；漂移审计见 `../merge-authority-drift-audit.md`）；W0–W4 dogfood **`DP-MERGE-2=A`**（D-first，local `MergeExecutor`；W8 GitHub adapter）；harness-eval **A/A/A**（P0 envelope/finding/lifecycle；artifacts+events；review/eval 分账）；前端复用 **`DP-WEB-1=B`**（W7a C + W7b Console 均 classic）。

> 覆盖审计（2026-10-25）：11/11 decided packet 均有 plans 落点，逐项映射见 `../../plans/0007-architecture-plan-coverage.md` §1.1；三猫 v2 复审全部 accept，0007 冻结为唯一对账索引。

[宪宪/deepseek-flash🐾]
