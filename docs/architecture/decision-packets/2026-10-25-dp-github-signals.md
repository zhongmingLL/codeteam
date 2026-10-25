---
title: "DP-GH: github-signals 拍板包"
doc_kind: decision-packet
status: decided
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related_card: ../reuse-review/github-signals.md
operator_decision: "DP-GH-1=A, DP-GH-2=A (2026-10-25)"
---

# DP-GH: github-signals 拍板包

> **DP-MERGE-1=D 影响注（2026-10-25）**：Q4 已收敛——`pr_merged` 只作 merge 的外部观察事实，不作 v1 custody predicate；terminal truth 是 `merges` receipt。不影响 DP-GH-1/2 的 GitHub-only + 四落点结论。

> **Operator 决定（2026-10-25）**：`DP-GH-1=A`、`DP-GH-2=A`。本 packet 已冻结；github-signals 卡按 GitHub-only + 复用四落点收口。
>
> 来源：`../reuse-review/github-signals.md`（approved）；三猫 review request `2ee84938-532c-4ae6-9f93-2e4f0f1f7402`。结论：烁烁 accept、砚砚 accept-with-modify、墨墨 accept-with-modify；无 P1，4×P2 + 12×P3 已回写。

## 0. 一句话

W8 的 GitHub signal 层只做 **GitHub-only** 的外部事实采集 + typed wait predicate；observation 状态复用现有 `tasks`/`waits`/`audit`/`forge_deliveries`，不建第二账本。推荐 **A/A**。

## 1. 先看结论

| 决策 | 选项 | 推荐 | 影响面 | 不拍的后果 |
|---|---|---|---|---|
| DP-GH-1 v1 provider scope | A=GitHub-only；B=GitHub+GitLab | **A** | W8 范围、predicate 语义、测试成本 | GitLab 假承诺或 W8 范围膨胀 |
| DP-GH-2 observation provenance/store | A=复用 tasks/waits/audit/forge_deliveries（audit 只记 state-changing）；B=新 `github_observations` 表 | **A** | 第二账本风险、审计/回放、operator 可读性 | B 会把第二账本换个地方涨；A 需要收窄护栏 |

## 2. DP-GH-1：v1 provider scope

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | GitHub-only；`ForgeAdapter` 只留 provider seam，GitLab defer | 10 个 predicate 全是 GitHub 语义（mergeState/verdict/delivery-id）；W8 可交付；不假承诺 | 未来接 GitLab 需要第二套 adapter/predicate 适配 |
| B | GitHub+GitLab v1 | 一次覆盖两个 forge | GitLab 的 review/merge/CI 语义与 GitHub 不同；W8 范围与测试矩阵翻倍，容易把 GitHub 特有坑（draft reset、billing zero-step）重新交学费 |

**推荐 A**：三猫一致认为 GitHub-only 是正确的最小可交付；`ForgeAdapter` 保留 seam 即可，不把“支持 GitLab”写进 v1 承诺。

## 3. DP-GH-2：observation provenance/store

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | `tasks.automation_state_json` 存 collector state；`waits.baseline_json/continuation_json/outcome_json` 存 wait；`audit` 只记 state-changing observation；`forge_deliveries` 做 webhook dedup | 单一真相；不建第二事件账本；四类状态各归其位；崩溃按旧 cursor 重采、outcomeId 幂等 | 需要严格约束 audit 写入面，避免 no-match 轮询洪水 |
| B | 新建 `github_observations` 表存 observation/event | 查询/回放看似更直接 | 复制 audit + automation_state 的职责；与“不建第二事件账本”冲突；仍要处理 cursor/outcome 幂等 |

**推荐 A + 护栏**：

- `audit` 只记 **state-changing** observation：matched outcome、terminal、rearm_failed、cursor 迁移里程碑、dedup 拒绝、permission-denied；no-match tick 只写 collector state/fingerprint + metrics。
- `tasks.automation_state_json` 只存 review/ci/conflict/issue collector state；不复制 `await`/`waitOutcome`。
- `forge_deliveries` 按 `(provider, delivery_id)` claim；失败 rollback 让 GitHub retry。
- tracking status 是 `tasks` + `waits` 的纯派生只读投影，不建第三套 status store。

## 4. 已定的 W8 护栏（不需要再拍，但随本次签字冻结）

- **默认 polling，webhook opt-in**：A1-4 daemon 只绑 loopback；`CODETEAM_GITHUB_WEBHOOK_ENABLED=0` 默认关；启用时经 operator 反代/tunnel TLS 到 loopback，反代来源需可信判定。
- **HMAC**：constant-time compare；webhook body 1MB 上限/413；secret 存 config 0600 或 env，不进 agent 面/日志。
- **注册幂等**：`tasks(subject_key)` partial unique；同 subject 同 kind register replay 既有 task/wait。
- **token 通道**：A1-2 禁 per-run agent token 进 env；GitHub read token 走 daemon→gh 受信子进程 env 是另一条通道。
- **identity/permission 快照**：注册时点冻结；运行时降权不追溯，over-deliver 有意覆盖；Phase C 多用户重审。
- **GitHub review ≠ W3 reviews**：外部 facts 只进 waits/task collector state；内部 ReviewPolicy 独立。
- **`pr_merged` 预留**：v1 10 kinds 不含；只作 merge 的外部观察事实；W8 若需要独立 merge 观察再接 `ActionTerminalPredicate`，不另造 catalog。

## 5. 不拍的后果

- DP-GH-1 不拍：W8 无法冻结 provider scope；GitLab 可能被误写进交付承诺。
- DP-GH-2 不拍：observation 落点继续悬空；实现者可能自建 `github_observations`，把第二账本带回来。
- 两项都不影响 Wave A 已签契约，但 W8 的 collector 层不能开工。

## 6. 拍板记录

Operator 已回复 `DP-GH-1=A, DP-GH-2=A`（2026-10-25）。本 packet 不再等待输入。已执行：

1. `reuse-review/github-signals.md` → `status=approved`，写 `operator_signoff`。
2. `reuse/github-signals.md` → `status=approved`，写 `operator_signoff`。
3. 0004 计划与 0001 §12.2 同步；`codeteam/architecture/decision-packets/README.md` 标记 decided。

[宪宪/deepseek-flash🐾]
