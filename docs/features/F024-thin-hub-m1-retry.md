---
feature_ids: [superagentteam/F024]
related_features: [superagentteam/F020, superagentteam/F021, superagentteam/F022, superagentteam/F023]
title: "F024: W7b thin Hub M1-C — failed-invocation retry"
status: done
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [墨墨 (Qwen 3.8 Flash), 砚砚 (GLM 5.3 Flash)]
vision_guard: 墨墨 (Qwen 3.8 Flash)
created: 2026-11-21
updated: 2026-11-21
source_feature: "superagentteam/F020"
---

# F024: W7b thin Hub M1-C — failed-invocation retry

> M1-A unread、M1-B rename 已 close。M1-C 只做 Hub 能安全 surface 的控制动作：
> operator 对 failed/interrupted 的 agent 回复点「重试」，复用运行时已有的
> `requestRetry` 语义。abandon/running cancel 需要先定生命周期语义，不在本刀。

## 用户结果

- failed/interrupted 的 agent 回复旁出现「重试」；点击后同一 invocation 的
  failed/interrupted targets 重新排队，queue/live 在现有刷新链路里更新。
- 成功显示「已重新排队」；不可重试/没有可重试 target 显示 typed 错误，不静默。
- completed/canceled 回复没有重试入口；重试不会新建 invocation、不会改旧消息
  lifecycle、不会伪造成功。

## 范围

1. `POST /api/threads/:threadId/invocations/:invocationId/retry`：
   CSRF + owner + thread/invocation 归属校验；调用
   `runtime.processor.requestRetry(invocationId)`；202 admitted / 409 typed。
2. Web A2A api/store `retryInvocation`；MessageList 对 response lifecycle
   failed/interrupted 显示动作；单次点击锁 + typed 错误文案。
3. 成功后 publish `["queue","live"]`，复用现有 A2A store refresh。

## 非目标

- abandon、running cancel、worker abort；这些需要独立生命周期语义。
- retry completed/canceled；不修改 response message lifecycle。
- 指定部分 target 重试（先做全部可重试 targets）；agent config、archive、搜索。

## 验收标准

- Seed failed invocation（failed parent + settled failed attempt + queued entry）
  → retry 返回 202 `{status:"retrying", retriedAgentIds}`；parent 回 queued，
  queue entry 仍为同一 source/entry。
- completed / canceled / 已 queued 的 invocation → 409 `not_retryable`；
  无可重试 target → 409 `nothing_to_retry`；状态不发生部分写入。
- 跨 thread invocation → 404；非 owner → 403；deleted thread → 404；
  无 CSRF → 403。
- Web：只有 failed/interrupted 显示重试；成功后「已重新排队」，409 显示
  typed 文案；点击中禁用，不重复提交。
- daemon targeted/full tests、web tests、隔离 daemon+Vite 浏览器 smoke 全绿。

## 实施单元

1. `invocations` route + API tests（admitted/409/404/403/CSRF/归属）。
2. Web A2A api/store retry + MessageList action + tests。
3. 隔离 smoke：seed failed invocation → 重试 → queue/live/动作态可见。

## 关键契约

- 只 surface 既有 `requestRetry`：同 invocation、同 source message、同 queue
  entry；只在 failed/interrupted + settled 的 targets 上重试。
- 不改变 invocation/message identity；不写 response lifecycle；不新建
  invocation record。
- 状态变更以 HTTP 响应为准，UI 的「已重新排队」是瞬时动作态，不冒充持久状态。
- `retry` 不是幂等成功：重复提交返回 typed 409，由 UI 呈现。

## 进展

- 2026-11-21：`POST /api/threads/:threadId/invocations/:invocationId/retry`
  （CSRF/owner/thread+invocation 归属、`requestRetry` outcome 映射、queue/live
  publish）、web A2A api/store retry、MessageList failed/interrupted 动作与 typed
  错误文案已实现。
- 验证：daemon `npm test` = 872 passed / 3 skipped（含 3 条 F024 route tests）；
  web `npm test` = 83 passed / 22 files；web build（typecheck + Vite）= pass；
  `check:doc-index` = pass。
- 浏览器 smoke（隔离 daemon + Vite，seed failed invocation）：界面显示
  「回复失败」+「重试」→ 点击后「已重新排队」；DB 侧 invocation 变
  `queued` / `retry_count=1`，同一 queue entry 仍为 `queued`、target `a1`。
- 2026-11-21：PR #159 merged as `fffc32685`；墨墨/砚砚双面 approve @
  `e4ead3882`。状态：implementation merged，feature close 待 operator。
  abandon/running cancel 仍不在本刀。

## Known carry

- **P3（墨墨）**：点击重试后 invocation 进入 running，若此时 reload，旧 failed
  行的局部 `已重新排队` 动作态会复位，重试按钮短暂重现；点击会得到诚实的
  `not_retryable` 409，不改数据。修法已明确：MessageList 用既有
  `liveInvocations` 判定该 `parentInvocationId` 是否在跑，在跑时隐藏入口。
  close 前补或作为 F024 close 的具名 carry，不阻塞合并。
- **P3 修复（#161）**：MessageList 已用 `liveInvocations` 的
  `parentInvocationId` 集合给重试入口加 live gate；运行中隐藏「重试」，
  新增单测覆盖；#161 merged `cb5ef44d4`。该 carry 已关闭。

## Close-out

- 2026-11-21 operator 确认 close。主实现 PR #159 merged `fffc32685`，
  双面 review approve @ `e4ead3882`；P3 fix PR #161 merged `cb5ef44d4`，
  墨墨 delta approve @ `e161c4397`。
- F024 无剩余 carry。abandon / running cancel 明确 deferred 到独立平台 track，
  不计入本 feature。

[宪宪/deepseek-flash🐾]
