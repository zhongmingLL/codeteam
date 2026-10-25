---
cell: bubble-pipeline
title: "P0 复用卡：Bubble Pipeline"
doc_kind: reuse-card
status: approved
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_signoff: "approved 2026-10-24"
created: 2026-10-24
updated: 2026-10-24
---

# P0 复用卡：Bubble Pipeline

## 结论

| 项 | 值 |
|---|---|
| decision | **R1 适配复用** |
| priority | **P0** |
| codeteam W | W1 / W7 |
| 一句话 | 一条 provider 事件只投影成一个可见 bubble；codeteam 复用消息身份与 dispatchRefs，不另造聊天层。 |
| operator 签字 | [x] 已签（2026-10-24） |

## 覆盖

- canonical: F177 / F183 / F254 / F264 / F322
- explicit: F117 / F177 / F201 / F220 / F224 / F229 / F247 / F254 / F294 / F299 / F306 / F325
- Batch 0 legacy 归属：bubble continuity、message identity、CLI output、callback message 等（见 inventory 中 `architecture_cell=bubble-pipeline`）。

## Current truth

- **单一投影边界**：provider-normalized semantic event → 用户可见 bubble；服务器 message identity、named-message writer、live/hydration convergence 与 terminal projection 都在这一层收口。
- **实际投递与消息正文分家**：`dispatchRefs[]` 记录 source×target 的真实投递与 response identity；bubble 只消费这些事实，不从 Queue 字段猜终态。
- **代码面**：`bubble-event-adapter.ts`、`BubbleReducer.ts`、`useAgentMessages.ts`、`useChatHistory.ts`、`useSocket.ts`、`MessageDispatchAvatars.tsx`。
- **不采用**：前端直接写消息、双 write-path、用 provider 成功或日志文本推断 delivered/handled。

## codeteam mapping

- W1：`messages` 持久化聊天；`rich_blocks_json` 承载富块；`dispatch_refs_json` 关联 source×target；`runs` 持 response bubble / terminal 真相。
- W7：Hub 只做只读投影；`Run` terminal + `Message` 投影成一条 response bubble；one terminal per run。
- P0 锁定范围 = W1 的 message identity + `dispatch_refs_json` 契约（不建则二次迁移）；bubble reducer 与前端收敛是 W7 工作，不阻塞 dogfood。
- 证据不全时显示 `unknown`，不显示 `running`（沿用 `hasExactLifecycleProcessingDispatch` 的 fail-closed 语义）。
- 不新增：第二套 message store、第二套 bubble reducer、Hub 反向成为 review/merge 真相源。

## 风险与回滚

- **风险 P1**：codeteam 自建 socket/history/send 路径，导致 live 与 hydration 分叉、ghost bubble。
- **风险 P2**：把 terminal 结果写回 bubble 文本，导致无法从证据账本恢复。
- **回滚**：bubble/pipeline 是投影层；回滚只影响 W7 展示，不影响 `messages` 与 `runs` 真相。

## Review

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | message identity、reconcile、W1/W5 交叉 | accept（本轮已处置） |
| 砚砚 | 跨 thread 可见性、消息伪造边界 | accept（本轮已处置） |
| 墨墨 | W7 聊天/气泡体验、one terminal | accept（本轮已处置） |
| operator | cell 级决策 | [x] 已签（2026-10-24） |

[宪宪/deepseek-flash🐾]
