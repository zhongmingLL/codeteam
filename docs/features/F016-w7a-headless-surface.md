---
feature_ids: [codeteam/F016]
related_features: [codeteam/F015]
title: "F016: W7a headless surface + A2A ingress E2E"
status: in_progress
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash)]
vision_guard: 墨墨 (Qwen 3.8 Flash)
created: 2026-10-31
updated: 2026-10-31
source_plan: "docs/plans/0018-f016a-a2a-ingress-e2e.md"
source_report: "docs/reports/2026-10-31-f016-a2a-dispatch-tool-priority.md"
---

# F016: W7a headless surface + A2A ingress E2E

> F016 是 W7a 的 umbrella。F015 只交付了 5 个 A2A/custody extension
> tools 和一条真实 RPC 主链；F016 先把 **8 类 queue ingress × 场景** 接到
> 同一条 queue/dispatch/worker 链上跑真实 E2E，再补 headless API/事件重放和
> Hub 兼容子集。Console M0 是 W7b，不是 F016。

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

## 用户可见结果

- operator 的 `thread post --to`、backlog dispatch、schedule、retry 和
  extension A2A 都落到同一条 queue/dispatch/worker 链，关键路径有真实 pi RPC
  E2E；失败有 typed 原因，不静默 dead-letter。
- worker 能读取 bounded `codeteam_thread_context`，reviewer 不再只依赖 prompt 里的
  source message。
- handoff withdraw / parallel / loop guard / requestId / execution role 的
  语义有真实 E2E；cross-thread 明确拒绝，不伪装支持。
- F016c 完成后，外部进程/Console 可通过 daemon API + 事件重放读取同一套
  thread/approval/backlog 投影；F016a 不依赖 W7b。

## 交付切片

| Slice | 范围 | 状态 |
|---|---|---|
| F016a | P0 ingress × scenario real RPC E2E；现有 5 tools（重命名为 `codeteam_*`）+ `codeteam_thread_context`；withdraw queue cleanup；cross-thread negative；typed error/auth matrix | done（PR #81，`bc778185e`） |
| F016b | wait scheduler + `codeteam_wait_arm`/`codeteam_wait_status`/`codeteam_wait_cancel`；P1 `codeteam_message_get`/`codeteam_handoff_events`；owner fence | next |
| F016c | W7a daemon HTTP API、WS/SSE、事件 cursor/snapshot/replay、Hub 兼容子集、artifact/telemetry 只读 API | discovery（报告已合入，scope signoff pending） |

W7b Console M0 独立立项，不进 F016；M1 继续后置。

## 验收标准

以 [`docs/plans/0018-f016a-a2a-ingress-e2e.md`](../plans/0018-f016a-a2a-ingress-e2e.md)
的 AC 为 F016a 单一清单；F016b/F016c 在各自 plan 建立后补 AC。F016 umbrella
只在以下条件都满足时 close：

- [ ] F016a P0 ingress/custody 场景真实 RPC 通过；typed 失败、幂等、parallel、
  withdraw、冷启动恢复都有证据。
- [ ] `codeteam_thread_context` 按 principal.threadId 过滤，bounded/cursor/hasMore 正确；
  cross-thread 拒绝。
- [ ] wait 三件套与最小 scheduler 在 F016b 交付；不把“三个 tool”当 wait 完成。
- [ ] F016c 的 daemon API/WS/SSE、事件重放和 Hub 兼容 contract tests 通过；
  未支持功能显式隐藏/降级。
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

## 非目标

- MCP server/ingress（#74 extension-first；未来 sibling adapter 只在命名外部
  consumer 出现时做）。
- cross-thread A2A、`multi_mention` 聚合、`thread_list`/
  `thread_participants`/`task_list`。
- Console M0/M1（W7b）、W8 Forge connector。
- handoff expiry 自动 sweep、managed command wait（F016b/P1 或后续）。

## 依赖与风险

- 依赖 F015 的 queue/dispatch/worker/custody；依赖 W1 queue store、W5 worker
  runtime；不依赖 W7 API。
- 最大风险是把 wait 当薄 wrapper、把 in-process 测试冒充 real RPC、以及
  withdraw 清理 queue 时误伤已 claimed holder；对应决定见 plan 0018。
- Hub/API 兼容面由独立调研 thread 提供 contract；F016c 在调研结论回来前不
  锁 endpoint 形状。

## Evidence

- 调研报告：`docs/reports/2026-10-31-f016-a2a-dispatch-tool-priority.md`
  （PR #77，merge `aba19b7e7`；砚砚 auth/custody、烁烁 dispatch semantics 双审）。
- F015 基线：`docs/features/F015-a2a-e2e-foundation.md`。

[宪宪/deepseek-flash🐾]
