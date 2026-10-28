---
title: "W5a A2A 投递与球权内核实现报告"
doc_kind: report
status: in_progress
created: 2026-10-28
updated: 2026-10-28
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
feature: "codeteam/F008"
---

# W5a A2A 投递与球权内核实现报告

> 契约与 AC 单一真相源：`docs/plans/0004-w5-w8-scale-product.md` §W5。
> 本报告只记录 W5a 的当前实现证据、边界和剩余风险；不把 W5b/W5c 的
> passing tests 冒充完成。

## 交付

- migration 011：`queue_entries.status` 增加 `withdrawn`；`runs.queue_entry_id`
  改为 durable correlation（queue 行删除后保留 id）。
- `DispatchService`：唯一 `queue_entries` drain、multi-recipient parallel、
  one terminal、response bubble final body、dispatch ref `settled`、
  guide/stop/interrupt/cancel。
- `A2AToolHandlers`：`a2a_send` / `handoff_create` / `handoff_claim` /
  `handoff_complete` / `handoff_withdraw`；principal 绑定、strict input、
  target/session 校验、`control_ref` 回填、可见 `→ @target`、handoff
  idempotency、success/missing eval metric。
- `projectCustody`：custody event replay + holder/blocked/expired/completed
  投影 + anomaly 告警；blocked `completes` / `bounces_back_to_owner` 两态。
- `WaitContractService`：wait source / SLA / expected signal / owner fence
  校验；`user_cancel` owner 校验；不裁决 handoff expiry。

## 验证（fresh commands）

在 `/home/ming/agent/codeteam-w5a`，基线 `aa0840f8c` /
`feat/w5a-a2a-dispatch-custody`：

```bash
NODE_ENV=development npm --prefix packages/codeteam-daemon test
# 35 passed | 1 skipped test files
# 287 passed | 1 skipped tests

NODE_ENV=development npx vitest --run \
  packages/codeteam-daemon/test/control-dispatch.test.ts \
  packages/codeteam-daemon/test/control-a2a-tools.test.ts \
  packages/codeteam-daemon/test/control-custody-wait.test.ts
# 3 files / 23 tests passed

NODE_ENV=development npx tsc --noEmit -p packages/codeteam-daemon/tsconfig.build.json
# pass

NODE_ENV=development npx tsc --noEmit -p tsconfig.json
# pass（hydrate pinned model catalog 之后）

NODE_ENV=development npm run build:offline
# pass（含 @codeteam/daemon）

NODE_ENV=development npx biome check <W5a touched files>
# 19 files checked, no fixes applied
```

Pinned catalog hydrate：

```bash
curl -fsSL -o /tmp/pi-catalog-w5a.json \
  'https://pi.dev/api/models/revisions/sha256-7604547f5421e98e8416a4c96b7c0db5644bc6fe4b7cb60daf7a3b429d5b17ac?types=chat,image,classifier'
node packages/ai/scripts/hydrate-model-catalog.ts /tmp/pi-catalog-w5a.json
# pass；check:model-data 在 build:offline 中输出 "Generated model data is valid."
```

## 测试覆盖

- `control-dispatch.test.ts`：single Queue Entry + multi recipient parallel；
  one response bubble per run；重复 terminal 幂等；guide；stop；interrupt
  （canceled + retry run）；cancel queued（withdrawn）；executor failure；
  A2A depth；missing tool schema correction；routeSerial。
- `control-a2a-tools.test.ts`：a2a_send 消息/queue/marker；forge/controlRef
  拒绝；handoff create + control_ref + custody dispatched；idempotency replay；
  per-holder claim / safe_wait / candidate / withdraw；missing observation
  只一次且不路由。
- `control-custody-wait.test.ts`：single/parallel custody replay；returned；
  expired；blocked 两态；wait source/SLA/signal/fence fail closed；owner
  cancel；wait 不裁决 handoff expiry。
- schema/migration：更新 W1 queue ref 断言；migration matrix 仍从 v3 旧库
  升级并保留 thread/message/task/run/handoff 行。

## Intentional divergence

1. **transport-neutral tool surface**：W5a 只交 in-process typed handlers，
   不新增 HTTP/MCP server。W7a 负责从 per-run token 派生同一个
   `RunPrincipal` 并暴露 transport；这是 W4 D1/D2 的延续。
2. **fake executor boundary**：W5a 的 `AgentExecutor` 是 injectable fake；
   真实 `pi --mode rpc`、per-run token 注入、JSONL 事件回流归 W5b。W5a
   不声称真实 implement→review 全链路已跑通。
3. **blocked human target**：custody blocked 两态由 store/control-plane
   fixture 验证；agent tool 的 blocker direction 仍受
   `assertHandoffDirection` 白名单约束，没有 human profile 时不会被伪造。
4. **run queue correlation**：W1 的 `runs.queue_entry_id` FK 会在 queue 行
   cutover 删除后置 NULL，破坏“可回溯”。W5a migration 011 去除该 FK，
   保留 id；`RunStore.create` 仍在应用层校验 entry 存在。

## 未完成 / 不能由本 slice 声称完成

- RPC worker harness、per-run token 注入、worker registry、sticky routing、
  re-attach、liveness、stale worker 处置（W5b）。
- task readiness/DAG、budget/quota、worktree pool、F139 schedule、daemon
  lifecycle、deployment wait、PR tracking/managed-work（W5c）。
- 真实 provider tool-call 成功率的跨 run 聚合/看板（W6 eval 闭环）。
- HTTP/MCP transport 与 token 身份派生（W7a）。

## 风险

| 风险 | 处置 |
|---|---|
| queue/runs 重建 migration 影响旧库 | migration 011 保留行、foreignKeysOff + FK check；migration matrix 覆盖 v3 升级 |
| 两个并行 target 的 claim 重入 | dispatch 逐 target 重新 claim；测试覆盖 2 recipient 同时启动 |
| tool args 伪造 from/control_ref | strict allowed keys + principal 绑定；测试覆盖 |
| wait 变成第二过期裁决器 | wait service 不调用 handoff expire；测试覆盖 |
| W5a 被误读为 W5b 完成 | 计划/F008/本报告均写明 fake executor 与未完成项 |

## 回滚

- migration 011 是 queue/runs 表重建；本地 dev DB 回滚需重建（无生产数据）。
- 代码为新增 `dispatch/`、`a2a/`、`custody/` service；回滚到
  `aa0840f8c` 基线即可。
