---
title: "F018 — R3 execution plan (cross-thread / multi_mention)"
doc_kind: plan
status: in-progress
created: 2026-11-20
updated: 2026-11-20
owner: "宪宪 (DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 墨墨 (Qwen 3.8 Flash), 砚砚 (GLM 5.3 Flash, standby)]
feature: F018
source_plan: "docs/plans/0020-f018-thread-first-runtime.md#r3--cross-thread-a2a"
source_handover: "docs/reports/2026-11-19-f018-r2-closeout.md"
---

# F018 — R3 execution plan（cross-thread / multi_mention）

> 契约源是 `0020 §R3`、`0007 §3.8`、`0005 §5`（E3–E21）与 `0013` 幂等映射。
> 本文件只做执行切片，不复制契约；R2 已交付 same-thread runtime、T1–T4、
> retry/recovery 与 `buildA2ARuntime` 组装根。
>
> **R3 执行结果**：R3-0/R3-a/R3-b/R3-c/R3-d 均已交付；
> 交付坐标、出口证据与 R4/R5 遗留见
> `docs/reports/2026-11-20-f018-r3-closeout.md`。

## 0. 结论先行

- 五片：R3-0（A2A tool/schema 基座）→ R3-a（post/cross_post）→
  R3-b（multi_mention create/fan-out）→ R3-c（aggregate/callback/timeout/recovery）
  → R3-d（CLI + 出口证据 + R3 close-out）。
- 全部从 `superagentteam-work` 开短命分支 PR；作者不自审，按风险选一个
  非作者 reviewer。R3-0/R3-b 偏契约与 orchestrator，R3-a/R3-c 偏工具面与
  恢复面，R3-d 偏出口验收。
- 复用优先（operator 指令）：Clowder 的 `post_message`/`cross_post_message`/
  `multi_mention` 工具契约、`MultiMentionOrchestrator` 与
  `multi-mention-state-machine` 作为参考实现；只换 store/transport/auth，
  不引 Clowder runtime/Redis 依赖。

## 1. 切片

### R3-0 A2A tool/schema 基座（本片）

- `migrations/005-multi-mention.ts`：按 `0007 §3.8` 建
  `multi_mention_requests` / `multi_mention_responses` / `multi_mention_callbacks`
  （含 CHECK/FK/unique index）；down 反序 drop。
- `packages/superagentteam-shared/src/types/multi-mention.ts`：status/transition
  constants、request/response/callback/status DTO、2–3 targets、timeout 3–20、
  callback depth 1–2；从 `types/index.ts` 导出。
- `domains/multi-mention/store.ts`：createRequest（`source_record_id` 唯一 +
  replay）、getRequest、setStatus（状态机）、recordTargetOutcome
  （first-write-wins，received/failed）、recordTargetResponse
  （只改 response_state）、create/updateCallback、listExpired/listPendingCallbacks、
  status read。
- `domains/a2a/access.ts`：thread access 判定（同 user、未 soft-deleted、
  target thread 有 projectPath）与 `targetKey` 去重；供 post/cross_post/
  multi_mention 共用。
- `domains/a2a/tool-claims.ts`：`intentHash` 稳定序列化与 claim replay helper
  （复用 `InvocationCredentialStore`，不新增第二套 claim store）。
- 测试：migration up/down、状态机非法转移、first-write-wins、request replay、
  callback unique、thread access 负例。

### R3-a post_message / cross_post_message

- `A2AToolService.postMessage` / `crossPostMessage`：targets 0/1、body ≤32 KiB、
  `replyTo` 校验、A2A depth/loop guard、`piExtToolCallId` claim replay。
- 单 target：message + queue entry + dispatchRefs 同事务（复用 ingress 的
  admission 语义）；message-only：只写 message，不建 queue/parent。
- cross-post：target thread 同 user、未删除、有 projectPath；写
  `extra.crossPost`；同 thread → `use_post_message`；多 target →
  `use_multi_mention`。
- 首次 child completed → 现有 T1 participant 写入；target 可以是 caller 自己。
- 出口：E3/E5/E6/E8/E10 的核心负例。

### R3-b multi_mention create / fan-out

- `A2AToolService.multiMention` + `MultiMentionOrchestrator.create`：
  targets 2–3、callbackTo enabled 且不在 targets、timeout 3–20、
  anti-cascade、callback/a2a depth ≤2/15。
- 同事务：request + source message（`[Multi-Mention from ...]`）+
  1 queue entry + 1 parent + N child TurnExecution；`piExtToolCallId` claim
  反查 requestId。
- T3 collector 在每个 child terminal 调 `recordTargetOutcome`；T2/T4 调
  `recordTargetResponse`（只改 response_state）；status running→partial。
- 出口：E4 的 fan-out/status/children 负例。

### R3-c aggregate / callback / timeout / recovery

- terminal：aggregate system message + `multi_mention_callbacks(pending)`；
  `deliverCallback` 建 callback queue/parent/child（同 thread，depth ≤2）；
  callback 结果不改 group。
- timeout：`MultiMentionOrchestrator.settleExpired(now)` 由现有单 reaper 驱动；
  已 received 的 response 不丢；`allFailed` 派生。
- startup：`MultiMentionRecovery` 只重试 pending callback；未过期 request 留给
  reaper；已过期 settle；terminal first-write-wins。
- `MultiMentionStatusReader`（CLI/W7a 读面，不新增 model-facing tool）。
- 出口：E11/E16/E21 的核心负例。

### R3-d CLI + 出口证据 + R3 close-out

- `thread post --to` 去 `--task` 依赖；CLI help/read model 同步。
- E3/E4/E5/E6/E8/E10/E11/E16/E21 逐项证据（mock + 一条真实 pi RPC 参数面）；
  记录 exact command/cwd/SHA/result。
- R3 close-out 报告 + R4 移交清单；同步 F018 feature/plan 状态。

## 2. 每片出口（统一）

- `NODE_ENV=development npm run build:offline` 通过。
- 受影响测试全绿；新行为先 RED 后 GREEN。
- `check-legacy-boundary` + `check:doc-index` + `git diff --check` 通过。
- 非作者 review 覆盖 exact HEAD；P1/P2 修复后由提出 finding 的 source 覆盖。
- 新 schema migration 必须有 up/down 测试；旧 dev DB 不动。

## 3. review 分工（按风险，不按文件数）

| 片 | 主 review | 关注面 |
|---|---|---|
| R3-0 | 烁烁 | schema/状态机/tool claim 契约；migration down |
| R3-a | 烁烁 | 工具输入/输出、queue/dispatchRefs、cross-post access |
| R3-b | 墨墨 | multi_mention orchestrator、fan-out、anti-cascade |
| R3-c | 墨墨 + 烁烁 | aggregate/callback/timeout/recovery；callback queue/child |
| R3-d | 墨墨 | CLI/出口证据/close-out 真相 |

砚砚 standby，可在额度允许时接非作者 review；作者宪宪不自审。

## 4. 复用地图

| 能力 | Clowder 参考 | 本仓映射 |
|---|---|---|
| post/cross_post 工具契约 | `packages/mcp-server` 工具面 / `packages/api/src/routes/threads.ts` | `domains/a2a` tool service + 现有 Message/Queue store |
| multi_mention 状态机 | `packages/api/src/domains/cats/services/agents/routing/multi-mention-state-machine.ts` | `types/multi-mention.ts` 常量 + `MultiMentionStore.setStatus` |
| multi_mention orchestrator | `MultiMentionOrchestrator.ts`（in-memory） | SQLite durable `multi_mention_*` store + T3 hooks |
| callback 语义 | `callback-tools.ts` / `callback-multi-mention-routes.ts` | `multi_mention_callbacks` + callback queue/parent/child |

只复用结构与语义；不引入 Clowder 包、Redis、transport 或部署假设。

## 5. 风险与处置

| 风险 | 处置 |
|---|---|
| 新 tool surface 与 legacy `control.ts` 混用 | R3 新 handler 只走 `domains/a2a`；不在 legacy control server 注册退役工具 |
| 多 target fan-out 写成第二个 scheduler | 只复用现有 queue/parent/child/T3；不建第二套队列 |
| callback 递归/风暴 | depth ≤2 + anti-cascade + queue cap；由单 reaper 驱动 timeout |
| cross-thread 越权 | 同 user + thread active + projectPath；E8 负例 |
| 状态机/replay 漂移 | `multi_mention_requests.source_record_id` unique + claim intentHash |
| 范围失控 | 不在 R3 做 cross-thread multi_mention、agent-created thread、MCP |

## 6. 验收映射

- E3 cross-thread post；E5 participants；E6 agent body `@` 不路由；
  E8 thread access 负例；E10 replay/conflict。
- E4 fan-out/status/aggregate/callback child/allFailed；
  E11 depth/loop guard；E16 multi_mention status/timeout；
  E21 cancel/retry 收敛。
- R4 拥有 E17/E20；R5 做 cutover/close。

