---
title: "DP-F018 Global Review — mention matching / multi_mention callback / completed dedupe / all-failed group"
doc_kind: decision
status: pending
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
created: 2026-11-14
updated: 2026-11-14
related_features: [codeteam/F018]
related: [0018-v1-global-design-review.md, 0007-a2a-runtime-chain.md, 0008-agent-config.md, 0013-idempotency-key-map.md]
operator_signoff: pending
---

# DP-F018 Global Review — 4 项待拍板

> 这份 packet 只给价值取舍、推荐和“不拍的后果”，不要求你选实现细节。
> 回复格式：`DP-F018MENTION-1=A, DP-F018MM-1=A, DP-F018IDEM-1=A, DP-F018MM-2=A`。
> 只要没有特别说明，推荐项就是安全默认；你只回复与推荐不同的项也可以。

## 0. 汇总

| ID | 问题 | 推荐 | 最晚决策点 |
|---|---|---|---|
| DP-F018MENTION-1 | `mentionPatterns` 只匹配行首，还是像 Clowder 用户消息一样匹配正文任意 `@` | **A：行首** | R2 |
| DP-F018MM-1 | `multi_mention.callbackTo` 只做 metadata，还是真正唤醒一个新 child | **A：metadata-only** | R3 |
| DP-F018IDEM-1 | 模型换新 `toolCallId` 重发同一 intent 时，是否做 completed 消息短窗口去重 | **A：做短窗口 intentHash 去重** | R3 |
| DP-F018MM-2 | 全部 target failed 的 multi_mention group 状态是 `done` 还是 `failed` | **A：done + all-failed 标记** | R3 |

## 1. DP-F018MENTION-1：`mentionPatterns` 的匹配范围

**背景**：AgentConfig 已从 `handle: string` 改为 Clowder `CatConfig` 的
`readonly mentionPatterns: readonly string[]`。字段本身不再需要拍板；需要拍的是
operator 消息里**在什么位置**匹配。

**选项**

- **A（推荐）行首匹配**：只解析行首 `@`（含列表/引用前缀），正文中间 `@` 不路由。
  保持 0007 现有 operator ingress 语义；E6 的“正文 @ 不路由”负例不变；误路由风险最低。
- **B（Clowder 用户消息行为）正文任意位置**：用户消息中的 `@` 也可路由。更接近
  Clowder 的 user-authored message 体验，但必须补代码块/URL 排除、token boundary、
  歧义、多 target 顺序和“正文 @ 不误路由”的负例矩阵。

**推荐 A**：v1 先把字段和 identity 做对，匹配范围保持可预测；B 作为后续增强。

**影响**：只改 0007 §3.0/§3.1 与 E6/E8；不改 schema、不改 AgentConfig 字段。

## 2. DP-F018MM-1：`multi_mention.callbackTo` 是否真的唤醒

**背景**：当前 v1 做完整 group lifecycle（status/timeout/aggregate），但 `callbackTo`
只作为聚合结果的地址/metadata，不创建新 child/queue。Clowder 的 callback 语义更主动。

**选项**

- **A（推荐）metadata-only**：聚合结果写一条 system message；callbackTo agent 下一轮
  从 thread 历史读取。无 cascade、无额外 queue/depth 风险；R3/R4 范围可控。
- **B（严格对齐 Clowder）**：callbackTo 触发一个新的 `post_message`-equivalent child。
  需要 anti-cascade、depth、queue cap、return/aggregate、失败重试和 callback 自身
  的 terminal 设计；R3/R4 明显变大。

**推荐 A**：v1 先保证 fan-out、timeout、聚合和可读性；callback cascade 留 v2。
如果选 B，必须补一份 callback child 的生命周期设计，不能只加一个字段。

**影响**：A 只改文案/验收；B 要改 0007 §3.8 multi_mention、E4/E17、0005 非目标。

## 3. DP-F018IDEM-1：completed 消息的跨 tool-call 重试去重

**背景**：`piExtToolCallId` 只覆盖同一个 tool call 的 transport retry。模型如果拿到
成功结果后重新生成一个新 `toolCallId`，再发一次相同 intent，claim 不会命中；
`a2a_duplicate_delivery` 只拦 queued/running，不拦已 completed 的 source。

**选项**

- **A（推荐）短窗口 intentHash 去重**：新增一个 `(threadId, senderAgentId,
  intentHash)` 的短期 receipt/index（例如 10 分钟 TTL）。命中已 completed source 时
  返回原 message/queue 结果；不同 intent 仍创建新消息。
- **B（接受风险）**：不做；只把风险写进 0013，E10 只测同一 tool call retry。

**推荐 A**：这是“同一 intent 不发两次”的最后一道防线，和 `piExtToolCallId` 解决的是
不同层；R3 前实现成本低，漏掉会产生重复 A2A 消息。

**影响**：A 需要 0013 补 key 分层、0007 §3.8 claim 流程、message/claim 存储字段和
completed replay 测试；B 只改文档。

## 4. DP-F018MM-2：全部 target failed 的 group 状态

**背景**：当前 `done` 定义为“全部 target 都有 outcome（received 或 failed 都算
accounted）”；`failed` 只表示 group admission/orchestrator 自身失败。所以全部 target
failed 的 group 也是 `done`，这和“全失败 = failed”的直觉不同。

**选项**

- **A（推荐）保留 Clowder accounted 语义**：group `done`；per-target failed 保留；
  status read/聚合正文额外给 `allFailed=true` 的派生标记。
- **B（直觉语义）全 failed → group `failed`**：需要改 `done`/`failed` 定义、状态机、
  E4/E17 和 callbackTo 的聚合文案。

**推荐 A**：与 Clowder 对齐，且不会丢失“部分成功”的 sibling 内容；用派生
`allFailed` 解决 UI/agent 的直觉问题。

**影响**：A 只改 status read/聚合正文；B 改 multi_mention 状态机和验收。

## 5. 已按默认处理、无需拍板的项

以下项已在 canonical docs 按低风险默认收口；如无否决，按现状进入 R1/R2：

- `queue_admissions` / parent source key 在 R1 加 `thread_id`，parent 用
  `(thread_id, source_record_id)` unique（v1 messageId 全局唯一，行为不变）。
- `response_missing`：R failed + typed system message；child/attempt delivery_state
  不改写，仍以 TurnExecution 为准。
- participants：首个 completed child 同事务写 `thread_participants`；failed/canceled
  不写（codeteam 有意偏离 Clowder admission-time）。
- `routing_guard`：v1 不创建；保留 enum 只为 Clowder 对齐。
- Issue/Task/custody/code delivery 继续不在 v1。

## 6. 不拍的后果

- DP-F018MENTION-1 不拍：R2 只能沿用行首匹配；如果后来要 B，需要重做 E6 和多 target
  解析测试，不影响数据。
- DP-F018MM-1 不拍：R3 只能按 metadata-only 实现；如果后来要 callback child，需要
  重开 group lifecycle 设计。
- DP-F018IDEM-1 不拍：R3 的重复 completed 消息风险保留；E10 只能证明同一 tool call
  的 replay，不能证明模型级重试。
- DP-F018MM-2 不拍：按 `done + allFailed` 实现；如果后来要 `failed`，改状态机和验收。

[宪宪/deepseek-flash🐾]
