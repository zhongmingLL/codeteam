---
title: "F016a — A2A ingress × scenario real RPC E2E 实施计划"
doc_kind: plan
status: draft
created: 2026-10-31
updated: 2026-10-31
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash)]
source: "docs/reports/2026-10-31-f016-a2a-dispatch-tool-priority.md"
feature: F016
---

# F016a — A2A ingress × scenario real RPC E2E

> 本计划把 A2A 调研的 P0 场景落成 F016a。目标不是重写 custody，也不是“再加
> 13 个工具”，而是让 8 类 ingress 都经过同一条
> `queue_entries → DispatchService → real pi RPC worker → A2A tool →
> handoff/custody → terminal/recovery` 链，并把 typed 失败、幂等和并行语义
> 用真实 RPC 测试钉住。
>
> 单一真相源：`docs/reports/2026-10-31-f016-a2a-dispatch-tool-priority.md`
> 的场景矩阵；实现遇到契约冲突先回写本计划，不在代码里另造 queue/dispatch。

## 目标与边界

完成后：

- I1 operator `thread post --to`、I2 operator multi-target、I3 backlog
  dispatch、I4 schedule tick、I6 worker retry/cold boot、I8 system ingress
  missing session、I10 cross-thread negative 都有真实 RPC 或 typed 负路径证据。
- A2 multi-target、A3 requestId replay/conflict、A5 claim/complete、A6
  withdraw、A7 parallel handoff、A9 loop guard、A10 execution role 和
  T1/T2/T3 terminal/dead-letter/poison 语义有真实 E2E 或明确 in-process
  对照；P0 不接受纯 handler 测试冒充。
- 新增 `thread_context` extension tool：bounded/anchor/cursor/hasMore，
  principal.threadId 过滤，cross-thread 拒绝。
- withdraw 的 queue cleanup 语义固定：pending targets 置 withdrawn（保留行 +
  `queue_withdrawn` audit），已 claimed holder 通过 claim 得到 typed
  `terminal_handoff`；author-only，non-author 拒绝。

不做：

- F016b 的 wait scheduler、`wait_arm/status/cancel`、`message_get`、
  `handoff_events`。
- F016c 的 HTTP/WS/SSE、事件重放、Hub 兼容子集、artifact/telemetry 读面。
- MCP ingress、cross-thread 支持、`multi_mention` 聚合、`thread_list`/
  `thread_participants`/`task_list`、Console/W7b、W8。
- 第二套 queue/message/handoff store；不把 in-process 测试当 real RPC。

## 冻结决定

### D1. 一条 queue ledger，multi-target 恒 parallel

沿用 W1 `queue_entries` 与 `DispatchService`；一条 source 一条 entry，
`id=queue:<sourceId>`，targets 去重。多 target 是同一 entry 的 parallel
runs，不新增 `multi_mention` 聚合器，也不新增第二队列。serial 由每跳单
target 结构保证。

### D2. P0 工具 = 现有 5 个 + `thread_context`

F015 的 `a2a_send`/`handoff_create`/`handoff_claim`/`handoff_complete`/
`handoff_withdraw` 不重写；F016a 只补真实 E2E 和缺口。新增唯一 P0 read
tool 是 `thread_context`。`message_get`/`handoff_events`/wait 三件套归
F016b；`thread_list`/`thread_participants`/`task_list` defer。13 是历史
基线，不是验收目标。

### D3. wait 是 F016b，不是三个薄 wrapper

`WaitContractService` 已有 contract，但缺 due 触发链路：没有 timer/event
wake producer，`WaitStore.consume` 没有生产调用，handoff deadline sweep 也
未接。F016a 不假装 wait 完成；F016b 必须连同最小 timer/event scheduler、
owner fence 和 `wait_cancel` exact owner 检查一起交付。

### D4. withdraw 清理 pending queue，不取消已 claimed holder

`handoff_withdraw` author-only。withdraw 时：

- pending queue targets 置 `withdrawn`（保留行 + `queue_withdrawn` audit），
  不删除行；
- 已 claimed holder 的 run 继续执行，`handoff_claim` 返回 typed
  `terminal_handoff`，不伪造 running holder 成功；
- non-author / 已 terminal handoff 拒绝；事件写 custody audit。

### D5. cross-thread A2A v1 不支持，只做 negative

handler 明确同 thread；cross-thread target 返回 typed reject，不写 queue/run。
真正跨 thread 需要 task/thread 授权模型，另开 decision；不把
`cross_post_message` 当已支持。

### D6. MCP ingress 不进 F016a

#74 已决定 v1 extension-first。未来 MCP 只能作为 sibling adapter 复用同一
handler/queue，不另造 queue entry 语义；F016a 不安装 MCP server。

### D7. system ingress missing session 必须 typed，不能静默丢唤醒

schedule/deployment/retry 等 system ingress 在 target 没有 active session
时，必须返回 typed defer/withdraw 并写 audit；不允许 silent dead-letter。
I8 虽是 P1，但因 correctness 纳入 S1。

## 实施切片与测试

### S1 — ingress / queue

- I1 operator thread post → real RPC：source message taskId、one queue、run(s)、
  response bubble；缺 `--task`/worktree/session 返回 typed failure 且不写 queue。
- I2 operator multi-target：one entry、2 runs parallel、2 bubbles；一个 target
  缺 session 时 typed withdraw，另一个仍执行。
- I3 backlog dispatch：保持现有真实 RPC 覆盖；not prepared defer，不
  dead-letter。
- I4 schedule tick：tick 只写 queue；drain 后真实 worker；paused/unready/
  duplicate/catch-up 负路径。
- I6 worker retry/cold boot：interrupted → retry queue → real worker；max
  attempts → dead-letter；不重复 retry。
- I8 missing session：typed defer/withdraw + audit。
- I10 cross-thread negative：typed reject，无 queue/run。

### S2 — A2A / custody

- A2 multi-target `a2a_send`：one entry、parallel runs、2 response bubbles；
  duplicate/depth limit 负路径。
- A3 requestId：same requestId same intent replay；different intent conflict；
  concurrent replay 无第二副作用。
- A5 claim/complete：candidate → run terminal → resolver consumed；non-holder/
  wrong run/missing evidence 拒绝。
- A6 withdraw：按 D4；补 claim-after-withdraw 的 `terminal_handoff` 断言。
- A7 parallel handoff：all verified → consumed；缺失 holder →
  `parallel_unfinished`；失败 holder → `waiting(parallel_holders_pending)`；
  两者断言分开。
- A9 loop guard：second live canonical action 拒绝；same idempotencyKey replay
  返回 existing。
- A10 execution role：direction 用 run.role，不泄漏 profile primary role。
- T1/T2/T3：one response bubble；duplicate terminal 幂等；poison target 不
  饿死 good target，坏 target withdraw + audit。

### S3 — read tools / error matrix

- `thread_context`：bounded window、anchor、cursor/hasMore；principal.threadId
  过滤；cross-thread negative；超大 thread 的 bounded 行为。
- Error/auth matrix：`a2a_depth_exceeded`、`loop_guard_live_handoff`、
  `conflict`、`invalid_state`、`forbidden`、daemon down fail-closed；
  handoff_events 的 principal thread/task scope（F016b 实现，本轮只留测试位）。
- audit/tool_usage：每个 mutating A2A tool 都有记录。

### 测试文件

- `daemon-a2a-ingress-e2e.test.ts`：I1/I2/I4/I6/I8/I10。
- `daemon-a2a-parallel-e2e.test.ts`：A2/A5/A6/A7/A9/A3/A10 + T1/T2/T3。
- `control-a2a-read-tools.test.ts`：`thread_context` scope/pagination/cursor。
- `control-a2a-errors.test.ts`：authz/idempotency/terminal/dead-letter typed
  error matrix，复用现有 fixture。

## AC

- [ ] I1/I2/I3/I4/I6/I8/I10 有 real RPC 或 typed negative 证据；不带纯
  in-process 冒充。
- [ ] A2/A3/A5/A6/A7/A9/A10 + T1/T2/T3 的 P0 断言通过；withdraw 语义按 D4。
- [ ] `thread_context` bounded/cursor/hasMore/thread scope 通过；cross-thread
  拒绝。
- [ ] typed error/auth matrix 覆盖 §S3；所有 mutating A2A tool 有 audit。
- [ ] 一条 queue ledger；multi-target parallel；无第二 queue/store。
- [ ] F016 feature doc、本 plan、BACKLOG row 在实现前已存在并被
  `npm run check:doc-index` 校验。

## 依赖与顺序

1. F015 merged（queue/dispatch/worker/custody 基线）。
2. F016a S1 → S2 → S3；S1/S2 可由不同猫在 disjoint 文件上并行，但 queue
   语义和 withdraw 决定必须先冻结。
3. F016b 在 F016a 后；F016c 等 Hub 调研结论。

## 风险与回滚

- withdraw 清理 queue 若误伤 claimed holder，会造成 running run 被取消；D4
  明确只清 pending，holder 走 claim typed terminal。
- schedule/deployment/retry 的 missing session 若 silent dead-letter，会丢
  唤醒；I8 typed + audit。
- 若 real RPC 测试成本过高，允许用现有 fake executor 做对照，但 P0 必须至
  少有一条真实 pi RPC + mock provider 路径；不能用 handler 测试替代。
- 回滚以 slice 为单位：S1/S2 独立 commit；不引入 schema migration 以外的新
  store；新 migration 必须 additive。

## Residual ledger

- wait 三件套 + minimal scheduler + owner fence → F016b。
- `message_get` / `handoff_events` / P1 read → F016b。
- handoff expiry 自动 sweep、managed command wait → F016b/P1。
- `thread_list` / `thread_participants` / `task_list` → defer。
- cross-thread A2A、MCP ingress、`multi_mention` 聚合 → 后续 decision。
- W7a HTTP/WS/SSE/Hub 兼容 → F016c（Hub 调研）。

## Review focus

- 烁烁：queue/dispatch/parallel/terminal/recovery 语义，I1/I2/I4/I6/I8/A2/A7/
  T1-T3。
- 砚砚：auth/custody/withdraw/owner fence/error matrix，A6/A9/A10/S3。
- 墨墨：vision guard 在 F016a close 时确认 operator/A2A 结果可理解；F016c
  Console 体验另审。

[宪宪/deepseek-flash🐾]
