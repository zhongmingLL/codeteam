---
title: "W5a A2A 投递与球权内核实施计划"
doc_kind: plan
status: closed
created: 2026-10-28
updated: 2026-10-28
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash)]
source: "docs/plans/0004-w5-w8-scale-product.md §W5 Tasks 1–3"
---

# W5a A2A 投递与球权内核实施计划

> 本计划把 `0004` §W5 Tasks 1–3 落成可实施、可验收的 W5a 切片。W5 契约
> 与验收仍以 `0004` 为单一真相源；本文件只写落点、投影契约、依赖、顺序与
> 验证映射。实现遇到契约冲突时回 `0004` / `F001` / reuse 卡，不在代码里
> 另造语义。
>
> W5b（RPC worker runtime）与 W5c（运营调度 / managed-work）不在本计划；
> W5a 冻结的契约由 source thread 决定何时开后续 thread。

## 目标与可见结果

W5a 完成后，codeteam 具备一条可测试的 A2A 投递内核：

- operator、agent、handoff 三种来源都映射为**同一种** `queue_entries`；
  `handoff` / `inbox` 只是来源或控制载荷，不是第二队列。
- 一条 Queue Entry 的多 recipient 恒 parallel；每个 recipient 有一条 durable
  `Run` 与恰好一个 response bubble，terminal 只收口一次。
- agent 讨论走 `a2a_send`，责任转移走 `handoff_create` / `handoff_*`；正文
  `@` 无路由权威。投递成功后有可见 `→ @target`，失败返回 typed error。
- custody 由 `handoffs` 状态真相 + `custody_events` 审计重放；blocked 必须
  声明 `completes` / `bounces_back_to_owner`；wait 缺证据 fail closed。
- guide / interrupt / cancel / stop 都有 durable 语义，不靠正文解析或另一个
  调度器。

本 slice 的 transport 是 **in-process typed service + tool handler surface**。
W7a 负责把同一 handler 暴露成 HTTP/MCP；W5a 不新增 HTTP server、不新增 MCP
server、不把 CLI 当 agent tool。这是 W4 D1/D2 的延续，不是新的 target-state
偏离。

## 两个显式 scope 决定

### D1. W5a 不接真实 pi kernel executor

`0004` 把 `invokeSingleAgent → pi kernel` 定为唯一执行内核替换点，但 RPC
worker harness、token 注入、JSONL 事件回流归 W5b。W5a 冻结并测试
`AgentExecutor` 边界：

```ts
interface AgentExecutor {
  execute(request: DispatchExecutionRequest, signal: AbortSignal): Promise<AgentExecutionResult>;
}
```

W5a 用确定性 fake executor 验证 queue/run/bubble/one-terminal/control 语义；
W5b 用 RPC executor 替换同一接口，不改 dispatch 投影。W5a 不声称“真实
implement→review 全链路”已完成；该验收留在 W5b。

### D2. `a2a_send` 的 sender 身份由调用绑定，不从 tool args 读

tool handler 在创建时绑定一个 `RunPrincipal`（由 run/session/task 派生）；
tool input 只允许 target、body、kind、replyTo 等字段。任何 `from*`、
`controlRef`、`ownerUserId`、`canonicalActionKey` 字段都按 unknown field
拒绝。W7a 接 HTTP/MCP 时从 per-run token 解析同一 `RunPrincipal`，不把
args 自报身份当授权。

## 冻结的投影契约

### 1. Queue Entry

- 唯一 pending-wake 账本 = `queue_entries(status='queued')`。不新增
  `pending`/`claimed` 之外的 queue 表。
- `source_id` 唯一；一条 source message 最多一条 entry。
- `targets_json` 多 recipient 单行；claim 是整条 entry 的短时 claim。
- `cutoverTarget` 是 dispatch 的原子交接：target 从 entry 移除，生成一条
  Run + 一个 response bubble；最后一个 target 移除后 entry 删除。
- `withdrawn` 是 queue entry 的 terminal 状态，只用于**未 claim** 的 cancel。
  多 target 取消一个 target 时保留其他 target；最后一个 target 取消时整行
  置 `withdrawn`。`withdrawn` 不再被 drain，不删除审计。
- `runs.queue_entry_id` 是 durable correlation，不是删除时置 NULL 的弱引用。
  queue 行在最后一个 target cutover 后删除，但 run 仍保留原 entry id 以便
  audit 回溯。migration 011 重建 queue/runs 时保留行并移除此 FK。
- 不引入 hidden priority。比较子只有 `urgent > normal` + `order_key` +
  `enqueued_at`（现有 store 已实现）。

### 2. Run / response bubble / one terminal

- 一个 Run 只对应一个 `queue_entry_id`、一个 `recipient_profile_id`、
  一个 `response_message_id`。
- `agent_response` message 在 run cutover 时创建，是该 target 的唯一
  response bubble；terminal 时 final body 原地写入，不新增第二条 bubble。
- `runs.status ∈ running/completed/canceled/interrupted/failed`；terminal
  只能由 dispatch service / recovery 写。重复 terminal 返回已提交结果，
  不新增 event、不重复 settle dispatchRefs。
- terminal 后：
  - response bubble body 为 final body；
  - source message 的 `dispatch_refs_json` append 一条 `phase='settled'`；
  - `run_events` append 一条 terminal 投影 payload（复用现有 `message`
    event kind，不新增 schema 枚举）。
- `canceled` 只来自显式 operator stop / interrupt；`interrupted` 只来自
  recovery / liveness。W5a 不把普通 agent 失败写成 interrupted。

### 3. Handoff / custody

- `handoffs` 是状态真相；`custody_events` append-only，仅审计与重放对账。
- 创建 handoff 必须经过 `handoff_create`：写 `handoffs` + 可见 `handoff`
  message + `control_ref` + queue entry（holder targets），并 append
  `handoff.dispatched`。`a2a_send` 不产生 handoff、不改 custody。
- `fromRole` / `ownerUserId` / `fromProfileId` 从绑定 principal 派生；
  `toRole` 从目标 active session 的 execution role 派生；方向走
  `assertHandoffDirection` 白名单。
- `(taskId, idempotencyKey)` 重复创建返回原 handoff / message / queue 投影；
  同 key 不同 intent 返回 `conflict`，不追加第二套 message/custody。
- single：一个 holder；parallel：≥2 holder。per-holder claim 继续使用
  `handoff_holder_claims`；non-holder / 同 holder 第二 run 返回 `safe_wait`。
- completion 路径保持 candidate → verified commit；tool `handoff_complete`
  只记录 candidate，不自行把 agent 自述升级成 verified。
- `blocked` 不是第五个 handoff status。`kind='blocker'` 的 active handoff
  必须在 payload 声明 `blockedOnResolve ∈ completes|bounces_back_to_owner`；
  custody projection 输出 blocked 两态及 owner profile，缺声明 fail closed。
- 重放从 event seq 重建 holder 集合/blocked/expired/completed；与
  `handoffs` 实际状态不一致时返回 anomalies 告警，不反向裁决状态。

### 4. Wait

- `waits` 只驱动唤醒，不裁决 handoff expiry。
- 所有 wait 必须有：
  - typed `wait_source_ref`（`<kind>:<id>` 形状）；
  - `sla_until` 为正整数；
  - exact `owner_fence`：`containing_task` 或 `action_successor`。
- `event` 与 `managed_command` 还必须有 `expected_signal`；缺任一证据
  fail closed（`invalid_input`），不写 active wait。
- `user_cancel` 终止只允许 owner；非 owner 返回 `forbidden`。
- handoff 过期只由 explicit deadline / operator / recovery 触发；W5a 的
  wait service 不调用 `handoffs.expire`。

### 5. A2A tool surface

统一 handler 名称与 input：

| tool | 语义 | 落库 | 不做什么 |
|---|---|---|---|
| `a2a_send` | 讨论/通知/澄清 | `messages` + `queue_entries` | 不改 custody、不接受 handoff intent |
| `handoff_create` | 责任转移 | `handoffs` + `custody_events` + message + queue | 不接受自报 from/owner |
| `handoff_claim` | holder 接球 | per-holder claim | 非 holder 返回 `safe_wait` |
| `handoff_complete` | 提交完成候选 | completion candidate + custody event | 不自行 verified commit |
| `handoff_withdraw` | 作者/owner 撤回 | handoff terminal + custody event | 不接受第二 actor 身份 |

- `a2a_send.kind ∈ question|answer|proposal|finding|status`；其他 kind 拒绝。
- target 必须是 active profile，且在同一 task/thread 有 active session；
  不存在 / disabled / 跨 thread 一律 typed error。
- 成功 message body 末尾由 daemon 追加 `→ @<displayName>`（按 target 顺序）；
  该 marker 只是投影，不参与路由。
- 成功 `a2a_send` / `handoff_create` 写一条 eval metric
  `a2a_tool_call_success=1`；漏调 tool 只记录一次
  `missing_a2a_tool_call` audit + eval metric，并返回一次 schema correction；
  绝不自动建 queue / handoff。第二次观察不重复。
- blocker handoff 的 `blockedOnResolve` 两态在 custody 投影与 store fixture
  中验证；human target 的 A2A direction 仍受 `assertHandoffDirection` 白名单
  约束，没有 human profile 时不能由 agent tool 伪造。

## 实施切片

### W5a-1 Queue withdrawal + terminal settle 基础

| 单元 | 落点 | 可观察结果 | 验证 |
|---|---|---|---|
| W5a-1.1 queue `withdrawn` + run correlation | migration 011 + `QueueStore.withdrawTarget` | 未 claim target 取消后 queue status/target 正确；drain 忽略；queue 删除后 run 仍保留 entry id | migration + store tests |
| W5a-1.2 message final body | `MessageStore.setBody`（CAS） | response bubble 原地获得一次 final body | store test |
| W5a-1.3 dispatch settle | `DispatchService.settleRun` | run terminal + bubble + dispatch ref + terminal event 原子收口 | fake executor tests |

### W5a-2 Dispatch queue adapter / A2A soul chain

| 单元 | 落点 | 可观察结果 | 验证 |
|---|---|---|---|
| W5a-2.1 route primitives | `src/dispatch/route.ts` | `routeParallel` 真并发；`routeSerial` 顺序可组合 | unit tests |
| W5a-2.2 drain | `src/dispatch/service.ts` | dirty-bit event-driven drain；一 entry 多 target → 多 Run | integration |
| W5a-2.3 control | 同上 | guide→inbox；stop→canceled；interrupt→canceled+新 run；cancel queued→withdrawn | control tests |
| W5a-2.4 recovery boundary | 复用 W1 recovery | claim release / interrupted 不抢 custody expiry | existing + new assertion |

### W5a-3 A2A tool surface

| 单元 | 落点 | 可观察结果 | 验证 |
|---|---|---|---|
| W5a-3.1 principal | `src/a2a/principal.ts` | run→task/session/profile/role/user 派生；不一致 fail closed | unit |
| W5a-3.2 tools | `src/a2a/tools.ts` | strict input、target 校验、visible marker、control_ref | handler tests |
| W5a-3.3 missing observation | `src/a2a/observation.ts` | 一次 correction；不建 queue；audit+eval 一次 | observation tests |

### W5a-4 Ball custody projection / blocked

| 单元 | 落点 | 可观察结果 | 验证 |
|---|---|---|---|
| W5a-4.1 replay | `src/custody/projection.ts` | holder/expired/completed/blocked 可重放；anomalies 告警 | replay tests |
| W5a-4.2 blocked on-resolve | `src/a2a/tools.ts` + projection | `completes` / `bounces_back_to_owner` 两态 | tool + projection tests |

### W5a-5 Wait contract

| 单元 | 落点 | 可观察结果 | 验证 |
|---|---|---|---|
| W5a-5.1 arm validation | `src/custody/waits.ts` | source/SLA/fence/expected signal 缺一 fail closed | unit matrix |
| W5a-5.2 terminate authority | 同上 | user_cancel 非 owner forbidden；不碰 handoff expiry | unit |

## AC 映射（`0004` §W5，仅 W5a 适用项）

| # | Acceptance | W5a 落点 | 验证 / 边界 |
|---|---|---|---|
| 1 | 只有一个 pending-wake Queue Entry 账本；handoff/inbox 是 source | W5a-2/W5a-3 | 断言没有第二队列表；handoff 只写 queue source |
| 2 | A2A one terminal / 原地 response bubble / event-driven drain / guide-interrupt-cancel-stop | W5a-2 | fake executor + control tests |
| 3 | A2A 灵魂链：多 recipient 恒 parallel；routeSerial/routeParallel 不复写 | W5a-2.1/2.2 | 并发观测 + 单 recipient 结构 |
| 4 | `runs.chain_metadata_json` 持久化 A2A 深度；partial unique 单 running | W1 已有 schema；W5a 写入 chainMetadata | queue integration |
| 5 | 责任转移只能由 handoff_create/handoff_* 发起；正文不投递 | W5a-3 | forgery + observation tests |
| 6 | `a2a_send` 不改 custody；control_ref 只由 daemon 回填 | W5a-3 | handler tests |
| 7 | 投递成功后 `→ @target`；失败 typed error | W5a-3 | handler tests |
| 8 | 弱模型工具失败只一次 schema correction，不进文本路由 | W5a-3.3 | observation tests |
| 9 | operator stop → canceled；cancel queued → withdrawn | W5a-1.1/2.3 | control tests |
| 10 | custody event 可重放；blocked 两态有测试 | W5a-4 | replay tests |
| 11 | wait 缺 source/SLA fail closed；event 缺 expected signal fail closed | W5a-5 | matrix tests |
| 12 | waits 不独立裁决 handoff 过期 | W5a-5 | wait/handoff separation test |

不在 W5a 的 `0004` 验收：RPC harness 全链路、worker registry/sticky/re-attach、
readiness/DAG、预算、worktree pool、F139 schedule、daemon lifecycle、
deployment wait、PR tracking/managed-work。它们由 W5b/W5c 承接，不能由
本 slice 的 passing tests 冒充完成。

## 测试清单

新增 `packages/codeteam-daemon/test/control-dispatch.test.ts`、
`control-a2a-tools.test.ts`、`control-custody-wait.test.ts`：

- single Queue Entry + multi recipient parallel + one response bubble per run。
- 重复 terminal 幂等；body 不二次写；dispatch refs 不重复。
- guide / stop / interrupt / cancel queued 四操作矩阵。
- executor 失败 → run failed + bubble 存在。
- custody replay：single、parallel、returned、expired、blocked completes、
  blocked bounces-back；anomaly 告警。
- wait matrix：缺 source / 缺 SLA / event 缺 signal / 坏 fence /
  非 owner user_cancel / handoff 不因 wait 过期。
- tool matrix：未知 target / disabled target / 跨 thread / 伪造 from /
  手填 control_ref / a2a_send 改 custody / handoff 缺 expected artifact /
  handoff idempotency replay 与 conflict。
- observation：意图文本无 tool → 一次 missing audit + correction；第二次无；
  无 queue 变化。

定向命令：

```bash
NODE_ENV=development npm --prefix packages/codeteam-daemon test -- control-dispatch control-a2a-tools control-custody-wait
NODE_ENV=development npx tsc --noEmit -p tsconfig.json
NODE_ENV=development npx biome check packages/codeteam-daemon
```

全量：`NODE_ENV=development npm --prefix packages/codeteam-daemon test`；
合入前再跑 `NODE_ENV=development npm run build:offline`。

## 依赖与顺序

1. W5a-1 先加 queue terminal 最小 schema 与 settle 基础；后续测试都依赖。
2. W5a-2 建在现有 `ControlStore.cutoverQueueEntry` / `RunStore` /
   `MessageStore` 上，不重写 store 状态机。
3. W5a-3 依赖 W5a-2 的 queue admission 和 W1 handoff store；不依赖 W5b
   RPC。
4. W5a-4/5 可与 W5a-2/3 并行实现，但最终用同一组 integration tests 验证
   handoff/wait 的边界。
5. W5a 完成后先做非作者 review：烁烁 A2A/session/custody，砚砚
   code/security。W5a 契约冻结后才由 source thread 提议 W5b/W5c。

## Review residual ledger

| # | 项 | 去向 |
|---|---|---|
| 1 | `WaitContractService.arm` 与 stop/interrupt/guide/cancel 的 actor 仍是调用方字符串；W5a in-process 可接受 | W7a 必须与 per-run token → principal 一起绑定 |
| 2 | `a2aDepth` 只持久化，无软上限 | W5c 预算/DAG 前加上限或准入 |
| 3 | observation 意图正则为启发式，可能误触发一次 correction | W6 eval 调优 |

## 风险与回滚

| 风险 | 路 | 处置 |
|---|---|---|
| 复用 Queue 却重写路由，丢 A2A 语义 | P1 | route 原语 + 并发/one-terminal 测试；不新增 scheduler |
| handoff 与 custody 双真相 | P1 | handoffs 状态真相；projection 只读 + anomaly |
| wait 变成第二过期裁决器 | P1 | wait service 不调用 expire；测试锁定 |
| tool args 伪造 sender/control_ref | P1 | handler 绑定 principal；unknown field 拒绝 |
| queue `withdrawn` migration 破坏 FK | P1 | 新表 copy/drop/rename + foreign_keysOff + FK check |
| W5a 冒充 W5b 完成 | P2 | 计划/F008/report 明确 fake executor 边界 |

回滚：migration 011 是 queue 表重建，但保留原行；代码是新增 service；回滚
到 `aa0840f8c` 基线即可。若 migration 已应用到本地 dev DB，回滚需重建 dev
DB（无生产数据）。

## Current progress（2026-10-28）

- 实施计划与 F008 已建立；migration 011（queue withdrawn + run queue
  correlation）已落。
- `DispatchService` / route primitives / A2A tool handlers / custody projection
  / wait contract 已实现。
- 定向测试：`control-dispatch` 12、`control-a2a-tools` 9、
  `control-custody-wait` 6（27/27）；包内全量 35 files passed + 1 skipped，
  291 tests passed + 1 skipped；根级 `tsc` 与 `build:offline` 通过。证据见
  `docs/reports/2026-10-28-w5a-a2a-dispatch-custody.md`。
- 明确未做：真实 pi kernel executor、RPC harness、worker registry/sticky/
  re-attach、readiness/DAG、预算、worktree pool、F139、daemon lifecycle、
  deployment wait、PR tracking/managed-work。W5b/W5c 不得由本 slice 的测试
  冒充完成。

## Close（2026-10-28）

- PR #50 merged into `codeteam-work` at
  `d9d3d96639db57579bcd712a8fdec8d1839b2722`; reviewed HEAD
  `4892da95edad883619a314fc243298fc414f84db`; base `aa0840f8c`.
- Reviews: 烁烁 A2A/session/custody approve; 砚砚 code/security approve; both
  cover the final HEAD. P1 cross-task custody hijack and P2 poison/multi-target
  regression were closed with negative tests.
- Vision guard: 墨墨 approved the merged state (non-author, non-reviewer).
- Post-merge daemon acceptance: 35 files passed + 1 skipped, 291 tests passed
  + 1 skipped; CI 4/4 green.
- W5a contract is frozen. W5b RPC worker runtime and W5c operational scheduling
  remain out of scope and should be proposed from the source thread, not inferred
  from this slice.
