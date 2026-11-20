---
title: "F018 — R4 execution plan (loop guard / observation / multi-agent / recovery)"
doc_kind: plan
status: in-progress
created: 2026-11-20
updated: 2026-11-20
owner: "宪宪 (DeepSeek Flash)"
reviewers: [墨墨 (Qwen 3.8 Flash), 烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash, standby)]
feature: F018
source_plan: "docs/plans/0020-f018-thread-first-runtime.md#r4--loop-guard--observation--多-agent"
source_closeout: "docs/reports/2026-11-20-f018-r3-closeout.md"
---

# F018 — R4 execution plan

> 契约源是 `0020 §R4`、`0007 §3.8`（thread_context / E17）、`0005 §5`
> （E12/E17/E20）与 `docs/reports/2026-11-20-f018-r3-closeout.md` 的 R4 遗留表。
> R3 已交付 post/cross_post/multi_mention 与 four-tool allowlist；R4 不重做。

## 0. 结论先行

- 四片：R4-a `thread_context` → R4-b loop guard → R4-c multi_mention
  cancellation/recovery 收敛 → R4-d observation + restart E2E + close-out。
- R4-a 先补契约四工具中唯一缺的读工具；它不新增 queue/写入面，可独立验。
- R4-b 用 durable `turn_executions.causal` 重建 A2A lineage；warn/block 阈值按
  DP-F018SURFACE-2=A（同 pair 连续 2 warn / 4 block，实质 tool/长输出豁免）。
- R4-c 收 R3 review 挂账：逐 target cancel/retry、all-target cancellation 语义、
  `callbackFailed` 原子性、backfill `responseState` 实判、`queue_admission_conflict` 死码、
  `content` 长度校验。
- R4-d 做 observation（4 工具名 + mention 负例）、多 agent thread E2E、
  restart/recovery（E20）与 R4 close-out。

## 1. 切片

### R4-a `thread_context`（本片）

- shared DTO：`ThreadContextInput` / `ThreadContextMessageView` / `ThreadContextResult`。
- `domains/a2a/thread-context.ts`：
  - `threadId?` 省略 = caller thread；显式 thread 必须存在、同 user、未 soft-deleted；
  - `anchor?` 是 thread 内 messageId；`before`/`after` 0-50；`limit` 1-200 默认 50；
  - `cursor` 是 opaque continuation，不能与 `anchor` 同用；
  - 可见性复用 `HistoryAssembler.visibleTo`；默认排除 deleted；processing R 带
    `lifecycle.status`；
  - 不 ack delivery cursor、不创建 queue entry；
  - 输出按 seq 升序，`hasMore`/`nextCursor` 只表示更旧窗口。
- `MessageStore` 增加 bounded window 读方法（before/after anchor），不在 service 里
  全量拉 thread。
- 测试：current/explicit thread、access 负例、anchor 窗口、cursor 分页、
  visibility（targeted/own response）、invalid anchor/cursor/window。

### R4-b loop guard

- `domains/a2a/loop-guard.ts`：从 caller `TurnExecution` 的 causal 链 durable
  重建 A2A lineage；同 unordered pair 连续 short/no-substantive 计数；
  ≥2 warn、≥4 `loop_guard` block；substantive tool（非路由/非 hold）或
  输出 >200 chars 重置为 1。
- 接到 `A2AToolService` / `MultiMentionOrchestrator.create` 的 admission 前；
  depth 15 已在 R3，保持。
- 测试：short ping-pong 2/4、substantive 豁免、pair 切换重置、restart 后 lineage
  仍可重建、warn 不写 queue。

### R4-c multi_mention cancellation / recovery

- 逐 target cancel → response failed；全 target cancel → request failed
  （对齐 `0007 §3.8`；当前 T3 全 cancel 仍收 done+allFailed，需改实现或文档决策）。
- retry 只重派 failed/interrupted；canceled 不 retry；callback 不因 group retry 重开。
- `callbackFailed` 的 updateCallback + marker message 同事务。
- backfill `responseState` 按 R 实际 lifecycle 判（terminal/pending/missing）。
- `queue_admission_conflict` 死码与 `content` 长度校验一并收。

### R4-d observation + restart E2E + close-out

- observation：识别 4 个新工具名；agent final response / A2A body `@` 负例不误报；
  operator 正文 `@` 正例；disabled pattern 负例（E12）。
- 多 agent thread：一个 message、一个 parent、N child、N response（按 0007 §3.8）。
- restart/recovery E2E：cutoff/protected、response_pending、expired claim restore、
  callback pending 恢复、不重复 terminal（E20）。
- R4 close-out 报告 + R5 移交清单。

## 2. 每片出口（统一）

- `NODE_ENV=development npm run build:offline` 通过。
- 受影响测试全绿；新行为先 RED 后 GREEN。
- `check-legacy-boundary` + `check-doc-index` + `git diff --check` 通过。
- 非作者 review 覆盖 exact HEAD；P1/P2 修复后由提出 finding 的 source 覆盖。

## 3. review 分工

| 片 | 主 review | 关注面 |
|---|---|---|
| R4-a | 烁烁 | 读面/分页/可见性/无副作用 |
| R4-b | 墨墨 + 烁烁 | durable lineage、阈值、substantive 豁免 |
| R4-c | 墨墨 | cancel/retry 状态机、callback 收敛、事务 |
| R4-d | 墨墨 | observation/restart E2E/close-out |

砚砚额度恢复后 standby；作者宪宪不自审。

## 4. 明确不做

- 不新增 model-facing cancel API 之外的第五个工具；`thread_context` 是契约四工具之一。
- 不在 R4 做 daemon/CLI 全面 cutover（R5）。
- 不引入 Clowder runtime/Redis；只复用语义。

[宪宪/deepseek-flash🐾]
