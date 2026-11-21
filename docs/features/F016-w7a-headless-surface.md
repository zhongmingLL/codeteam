---
feature_ids: [codeteam/F016]
related_features: [codeteam/F015]
title: "F016: W7a headless surface + A2A ingress E2E"
status: in_progress
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash)]
vision_guard: 墨墨 (Qwen 3.8 Flash)
created: 2026-10-31
updated: 2026-11-21
source_plan: "docs/plans/0018-f016a-a2a-ingress-e2e.md"
source_report: "docs/reports/2026-10-31-f016-a2a-dispatch-tool-priority.md"
---

# F016: W7a headless surface + A2A ingress E2E

> F016 是 W7a 的 umbrella。F015 只交付了 5 个 A2A/custody extension
> tools 和一条真实 RPC 主链；F016 先把 **8 类 queue ingress × 场景** 接到
> 同一条 queue/dispatch/worker 链上跑真实 E2E，再补 headless API/事件重放和
> Hub 兼容子集。Console M0 是 W7b，不是 F016。

> **2026-11-21 re-scope after F018 done.** F018 已把 runtime 切成纯 A2A；
> F016b/F016c 的旧 wait/custody 与 backlog/approval Hub 面不再按原样成立。
> 当前提案见 `docs/plans/0028-f016-w7a-rescope.md`：建议 F016c-M1 先做，
> F016b wait 暂缓到真实 caller；legacy 面诚实空读/501，不在本轮补新能力。
> operator 2026-11-21 已签字 D1=A / D2=A / D3=A：F016c-M1 先做，
> F016b defer；legacy 面板先隐藏；F016c-M1 另开执行 plan。

> **2026-11-21 F016c-M1 close-out.** S0–S5 已合入：session、thread、message、
> queue/live、agents/cats/config 的 headless 读面 + legacy 空壳/501 + headless
> E2E 已交付。真实 classic Hub 的浏览器 E2E 未在本机执行（无运行中的 Hub），
> 验收步骤与 P3 总账见 `docs/reports/2026-11-21-f016c-m1-s5-closeout.md`。
> F016c-M2（Socket.IO events + history refetch）与 F016b wait 仍未交付。

## Why

`docs/reports/2026-10-31-f016-a2a-dispatch-tool-priority.md` 的结论是：
codeteam 已有 8 类 queue ingress，但真实 RPC E2E 主要覆盖 backlog dispatch
和 extension A2A + cold-boot recovery；operator thread post、schedule、
deployment wait、interrupt/retry、parallel/withdraw/blocked handoff 仍缺真实
覆盖。Clowder 真正产生 A2A queue entry 的 MCP tools 只有 3 个，codeteam 已有
`a2a_send` + `handoff_*`，不应再加三个入口；真正缺的 P0 read tool 是
`thread_context`。因此 F016 的重点不是“凑 13 个工具”，而是 ingress ×
scenario 的真实 E2E 和 typed 失败语义。

## 工具命名

所有通过 pi extension 注册的工具统一 `codeteam_` 前缀，不保留无前缀别名：

- F015 的 5 个工具在 F016a 重命名：`codeteam_a2a_send`、
  `codeteam_handoff_create`、`codeteam_handoff_claim`、
  `codeteam_handoff_complete`、`codeteam_handoff_withdraw`。
- F016a 新增：`codeteam_thread_context`。
- F016b：`codeteam_message_get`、`codeteam_handoff_events`、
  `codeteam_wait_arm`、`codeteam_wait_status`、`codeteam_wait_cancel`。
- 调研报告里的工具名是逻辑名；注册名一律加 `codeteam_`。worker prompt、
  tool policy/allowlist、control socket 的 `toolName`、测试和文档同步更新。
  F015 文档保留历史名，F016a 负责重命名。

> 以上是 F016a/F016b 的历史命名。F019.5 后新工具必须用 `superagentteam_*`；
> F016b 的 `codeteam_wait_*` / handoff 工具在当前 re-scope 下不实现。

## 用户可见结果

- operator 的 `thread post --to`、backlog dispatch、schedule、retry 和
  extension A2A 都落到同一条 queue/dispatch/worker 链，关键路径有真实 pi RPC
  E2E；失败有 typed 原因，不静默 dead-letter。
- worker 能读取 bounded `codeteam_thread_context`，reviewer 不再只依赖 prompt 里的
  source message。
- handoff withdraw / parallel / loop guard / requestId / execution role 的
  语义有真实 E2E；cross-thread 明确拒绝，不伪装支持。
- F016c 完成后，外部进程/Console 可通过 daemon API + Socket.IO live events
  读取 A2A 的 thread/message/agent/queue 投影；backlog/approval/workflow SOP
  属于 legacy，本轮只做诚实空读/501 或显式降级，不做新 A2A 能力。

## 交付切片

| Slice | 范围 | 状态 |
|---|---|---|
| F016a | P0 ingress × scenario real RPC E2E；现有 5 tools（重命名为 `codeteam_*`）+ `codeteam_thread_context`；withdraw queue cleanup；cross-thread negative；typed error/auth matrix | done（PR #81，`bc778185e`） |
| F016b | 旧 wait/handoff 三件套；re-scope 后建议 deferred，等真实 caller 再立纯 A2A wait | re-scope（plan 0028 D1；暂缓） |
| F016c | W7a daemon API + Socket.IO live events + history refetch + Hub 兼容最小面 | re-scope proposed（plan 0028；建议 M1 先做） |

W7b Console M0 独立立项，不进 F016；M1 继续后置。

## 验收标准

以 [`docs/plans/0018-f016a-a2a-ingress-e2e.md`](../plans/0018-f016a-a2a-ingress-e2e.md)
的 AC 为 F016a 单一清单；F016b/F016c 在各自 plan 建立后补 AC。F016 umbrella
只在以下条件都满足时 close：

- [ ] F016a P0 ingress/custody 场景真实 RPC 通过；typed 失败、幂等、parallel、
  withdraw、冷启动恢复都有证据。
- [ ] `codeteam_thread_context` 按 principal.threadId 过滤，bounded/cursor/hasMore 正确；
  cross-thread 拒绝。
- [ ] wait 是否交付由 plan 0028 D1 决定；如交付，必须是纯 A2A wait，
  不恢复 custody/handoff 旧三件套。
- [ ] F016c 的 daemon API、Socket.IO live events、history refetch 收敛和
  Hub 兼容 contract tests 通过；SSE/replay log 不在当前 scope，未支持功能
  显式隐藏/降级。
- [ ] 不新增第二套 queue/message/handoff store；不引入 MCP ingress。

## 当前进展

- 2026-10-31：F016a S0 已合入（PR #79 / `2954b4447`）——F015 的 5 个工具
  统一注册为 `codeteam_*`，无无前缀 alias。
- 2026-10-31：F016a S1-S3 已实现并本地全量验证：ingress 真实 RPC E2E
  （I1/I2/I4/I6/I8/I10）、A2A/custody E2E（A2/A6/A7/A9）、D4 withdraw
  queue cleanup、`codeteam_thread_context` bounded/anchor/cursor + cross-thread
  negative、typed error/auth matrix。`codeteam-daemon` 86 files / 563 tests
  passed，2 skipped。F016a 已 closed（PR #81 / `bc778185e`），进入 F016b
  （wait scheduler）。
- 2026-11-21：F018 已 done，F016b/F016c 进入 re-scope；提案见
  `docs/plans/0028-f016-w7a-rescope.md`。F016c-M1 建议优先，F016b 暂缓；
  旧 `codeteam_wait_*` / handoff events 与 Hub backlog/approval P0 不再按原样实现。
- 2026-11-21：operator 签字 D1=A / D2=A / D3=A；F016c-M1 执行计划
  `docs/plans/0029-f016c-m1-execution.md` 已起草，待砚砚/墨墨 review。
  代码未开始。
- 2026-11-21：S0 冻结报告 `docs/reports/2026-11-21-f016c-m1-s0-freeze.md`
  已起草（DTO/session/owner gate/idempotency/error/contract tests），待
  砚砚/墨墨 review；代码仍未开始。

## 非目标

- MCP server/ingress（#74 extension-first；未来 sibling adapter 只在命名外部
  consumer 出现时做）。
- cross-thread A2A、`multi_mention` 聚合、`thread_list`/
  `thread_participants`/`task_list`。
- Console M0/M1（W7b）、W8 Forge connector。
- handoff expiry 自动 sweep、managed command wait（F016b/P1 或后续）。

## 依赖与风险

- F016a 的历史依赖是 F015 queue/dispatch/worker/custody；F016c re-scope 后
  依赖 F018 A2A runtime（`f018.db`、Thread/Invocation）与 daemon composition
  root，不再依赖 task/custody 新写入。
- 最大风险是把 wait 当薄 wrapper、把 in-process 测试冒充 real RPC、以及
  withdraw 清理 queue 时误伤已 claimed holder；对应决定见 plan 0018。
- Hub/API 兼容面由独立调研 thread 提供 contract；F016c 在调研结论回来前不
  锁 endpoint 形状。

## Evidence

- 调研报告：`docs/reports/2026-10-31-f016-a2a-dispatch-tool-priority.md`
  （PR #77，merge `aba19b7e7`；砚砚 auth/custody、烁烁 dispatch semantics 双审）。
- F015 基线：`docs/features/F015-a2a-e2e-foundation.md`。

[宪宪/deepseek-flash🐾]
