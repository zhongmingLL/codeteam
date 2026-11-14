---
title: "DP-F018R: Operator routing / per-agent pipeline 拍板包"
doc_kind: decision-packet
status: decided
created: 2026-11-09
updated: 2026-11-09
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related: ../../architecture/0007-a2a-runtime-chain.md
related_features: [codeteam/F018]
operator_decision: "DP-F018R-1=A, DP-F018R-2=A, DP-F018R-3=A (2026-11-09)"
---

# DP-F018R: Operator routing / per-agent pipeline 拍板包

> Operator 已拍：`DP-F018R-1=A`、`DP-F018R-2=A`、`DP-F018R-3=A`。本 packet 已冻结。

## 0. 一句话

operator 的行首 `@` 是 operator 侧的 A2A admission；没有 `@` 时沿用 Clowder 的“上一次 human 选择”隐式路由。per-agent 处理从 routeSerial 抽成 `runAgentTurn`，route 只保留 parallel/serial 调度。

## 1. 结论

| 决策 | 选项 | 结果 | 影响 |
|---|---|---|---|
| DP-F018R-1 无 @ 路由 | A=Clowder 链；B=只做上一选择+default | **A** | operator 不必每条消息都 @；上一次 human 选择优先 |
| DP-F018R-2 Message target | A=持久化 `targetAgentIds`；B=从 queue 反查 | **A** | 隐式路由有 durable 依据 |
| DP-F018R-3 per-agent pipeline | A=抽 `runAgentTurn` + `routeAgents(mode)`；B=删 serial | **A** | routeSerial 的 per-agent 能力保留，route 只做调度 |

## 2. DP-F018R-1：无 @ 的隐式路由

### Clowder 的做法

`AgentRouter.resolveImplicitTargetPreview` 的优先级：

```text
1. 当前消息 @
2. #ideate + 多个 preferred
3. concierge + preferred
4. 最近一条 human message 的 mentions
5. 最近健康回复过的 participant
6. preferred participant
7. 任意健康 participant
8. thread.preferredCats[0]
9. default cat
```

关键语义（`last-user-mentions.ts`）：

> The last Human choice lasts until another Human mention. Queued inputs count immediately; A2A and system messages never change that choice.

### codeteam v1 的链路

```text
1. 当前 operator message 的行首 @
2. 最近一条 user message 的 targetAgentIds
3. 最近成功响应过的 agent（TurnExecution completed）
4. thread participants 的第一个（加入顺序）
5. AgentRegistry defaultAgentId
6. 都没有 → typed reject no_target
```

v1 不做 `preferredCats` / `routingPolicy`；participants 顺序就是简化偏好。

## 3. DP-F018R-2：Message 持久化 targetAgentIds

- 只有 `authorKind="user"` 的消息写 `targetAgentIds`；
- 值是本次 admission 实际选中的 agent targets（不是原始 @ 文本）；
- agent/system 消息不写；
- 后续无 @ 消息读取“最近一条 user message 的 targetAgentIds”；
- 与 message + queue entry 同事务写入。

## 4. DP-F018R-3：runAgentTurn + routeAgents(mode)

```text
routeAgents(mode)
  ├─ parallel: mergeStreams(targets.map(runAgentTurn))
  └─ serial:   for target of targets:
                 result = runAgentTurn(target, priorResponses)
                 priorResponses.push(result)
```

`runAgentTurn` stages：

1. resolve AgentConfig
2. ensure AgentSession + worker lease
3. build context（thread/participants/recent messages/priorResponses）
4. createRunning TurnExecution
5. create InvocationCredential
6. build prompt
7. invoke pi worker
8. persist response + usage
9. transitionTerminal + collector + parent aggregate + credential terminalize
10. release worker lease + tracker slot

routeSerial 的历史责任拆解：

| routeSerial 内容 | 去处 |
|---|---|
| session/prompt/context/invoke/response/terminal | `runAgentTurn` |
| serial order / priorResponses | `routeAgents(mode="serial")` |
| guide/concierge/memory/SOP/entity nudge | `runAgentTurn` feature hooks；v1 不挂 |
| 静态 worklist 不 push 新 target | 保留：A2A hop 是新 queue entry |

## 5. 不需要拍、已自决的边界

- 行首 @ 解析在 `OperatorMessageIngress`，QueueProcessor/Router 不再解析；
- 未知/歧义/disabled handle → fail closed，不静默当普通文本；
- operator target 只由 agent tools 传入，operator 自己不发 operator target；
- operator target 只通知/可见，不创建 parent/TurnExecution；
- v1 先启用 parallel；serial 是同一个 `runAgentTurn` 的薄循环，保留接口但不默认启用。

## 6. 落点

- `0007 §3.0`：Operator ingress + target resolution；
- `0007 §3.5`：AgentRouter + runAgentTurn + routeAgents；
- `0007 §4`：`messages.target_agent_ids_json`；
- `0007 §9/§11`：验收与决策记录；
- `0005`：Message/Queue 与 runtime 链路；
- `0009`：participants 作为隐式路由候选。

[宪宪/deepseek-flash🐾]
