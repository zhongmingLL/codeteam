---
title: "DP-A3: ball-custody 拍板包"
doc_kind: decision-packet
status: decided
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related_card: ../reuse-review/ball-custody.md
review_request: d9b81c9e-fe57-4e23-a77d-d6130308fd03
operator_decision: "DP-A3-1-1=A, DP-A3-1-2=A, DP-A3-1-3=A (2026-10-25)"
---

# DP-A3: ball-custody 拍板包

> **DP-MERGE-1=D 影响注（2026-10-25）**：Q4 已收敛——merge 不采用 agent handoff/lease，由 daemon merge service 执行，terminal truth = `merges` receipt；`task_done` 语义不变——等 merge 完成，不等 operator。

> **Operator 决定（2026-10-25）**：`DP-A3-1-1=A`、`DP-A3-1-2=A`、`DP-A3-1-3=A`。本 packet 已冻结；三张卡按此收口。

## 0. 一句话

A3-1 架构卡已完成三猫 review 与 P1/P2/P3 回写；operator 已拍 **A / A / A**，本 packet 冻结。

## 1. 先看结论

| 决策 | 选项 | 推荐 | 影响面 | 不拍的后果 |
|---|---|---|---|---|
| DP-A3-1-1 parallel 完成时机 | A=首个 verified success 立即 consumed；B=全 holder terminal 才 consumed | **A** | W1 parallel claim/完成验收、sibling run 取消 | parallel 完成语义未定，W1 不能冻结 |
| DP-A3-1-2 SOP→custody 映射 | A=implement 普通 handoff、review action custody；B=implement 用 task_done | **A** | W1 implement handoff 完成时机、是否悬置到 merge | 第一个 implement handoff 可能悬空 |
| DP-A3-1-3 operator 行首 @ | A=ingress 解析成 typed inbox；B=只支持 Console picker | **A** | W7a operator UX、inbox 入队 | operator 聊天 @ 仍无落点（不阻塞 A3-1 冻结） |

## 2. DP-A3-1-1：parallel 首个 verified success 是否立即终结

**背景**：parallel handoff 有 ≥2 holders，各自独立 claim。一个 holder 已产出 verified success 时，另一个 holder 可能还在跑。

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | 首个 verified success 立即 `consumed`；sibling claims release；sibling runs 由 control plane `canceled`；写 `handoff.parallel_unfinished` 观察事件 | 完成时点确定；不让沉默/慢 holder 挂住已完成 action；剩余 review 仍可在 thread 看到 | 在飞的 sibling run 被取消，token 可能已花；不是“全员意见到齐” |
| B | 所有 holder terminal 且任一 success 才 `consumed`；沉默 holder 由 claim lease/heartbeat recovery 收敛 `unavailable` | 保留完整 parallel 聚合；与 clowder parity | 完成时点依赖 recovery sweep；慢 holder 会延迟 action；需额外测试与 `handoff_silent_holder_converged_total` |

**review 表态**：烁烁 A、砚砚 A、墨墨 B（2:1）。

**推荐理由**：codeteam 的 parallel 是执行单元 fan-out，不是“全员意见是交付物”的 quorum；action success 的定义是责任已完成，不是所有并行意见到齐。若选 B，必须同时接受“完成等 recovery”的时序依赖与额外验收。

**历史备选（已拍 A，不再适用）**：若当时未拍，A3-1 保持 in_review，W1 parallel claim/完成实现不冻结；不阻塞 memory/observability review。

## 3. DP-A3-1-2：v1 SOP stage → custody 映射

**背景**：predicate catalog 只开放 `review_delivered` / `task_done`。implement 的 custody 如果在 diff+test report 交付时 discharge，而 `task_done` 要等 merge 完成（D 下不等 operator），两者语义不同。

| 选项 | 映射 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | `impl`=普通 handoff（artifact 交付即 consumed）；`review`=action custody `review_delivered`；`merge`=A2-3 approval（A3-1 时点；`DP-MERGE-1=D` 后改为 daemon merge service，无 approval/handoff）；`verify`=普通 handoff/Phase C；`task_done` 保留但不自动配给 implement | W1 可立即实现；impl custody 不悬置到 merge | impl 没有 typed predicate，完成靠 artifact + 调用方/verifier 确认 |
| B | `impl`=action custody `task_done` | 与 F167 task-backed custody 更一致 | task_done 等 merge；holder run 结束后 custody 可能悬置，需要 reattach/新 run 收口 |

**推荐理由**：codeteam 的 impl 交付物是 diff + test report，不是 merge；`task_done` 是 task 生命周期，不是 impl handoff 的完成条件。GLM review 已把这条列为 W1 前必须决定。

**如果今天不拍**：W1 建表可以先做，但第一个 implement handoff 的完成路径会由实现者自行猜；不阻塞 memory/observability review。

## 4. DP-A3-1-3：operator 行首 @ 的 typed inbox 落点

**背景**：agent 正文 @ 不能路由（tool-call-first）；但 operator 在 thread chat 行首 @ 是自然习惯。若不解析，operator 只能靠 Console picker 或观测计数。

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | daemon ingress 把 operator thread 行首 @（或 Console recipient picker）解析成 typed `inbox(humanGuidance|followUp)`；消息本体不改写 | operator 习惯有真实落点；解析在 ingress，不伪造 custody | 多一个 ingress 解析面；需要 W7a 落点 |
| B | 只支持 Console recipient picker；line-start @ 不解析 | 实现更窄 | CLI/聊天框 @ 仍无入口 |

**推荐理由**：这是 operator UX 的暗坑，不解决会在 dogfood 时反复出现“@ 了但没人接”。落点归 A2-1 inbox / A1-3 dispatch，A3-1 只声明“agent 正文 @ 不产生 custody”。

**如果今天不拍**：不阻塞 A3-1 冻结；但 W7a 需要一行功能清单。若选 B，请在 W7a 明确“只支持 picker”。

## 5. 不需要拍、已回写的项

- P1-1 parallel claim：已改为 `handoff_holder_claims` per-holder 子账本；single/parallel claim、return、replace、recovery、security、observability 全部同步。
- P2 枚举/挂点：0001 §4.3/§5.2/§12.2、plans/0002 W1、plans/0004 已更新；旧 `custody_events.kind` 删除。
- P2/P3 其余：SOP 映射、sibling run cancel、reattach dispatch、W1 验收措辞、predecessor FK、publish_claimed_at、action_family catalog、值班措辞等已回写。

## 6. 拍板记录

2026-10-25 operator：`DP-A3-1-1=A, DP-A3-1-2=A, DP-A3-1-3=A`。W1 按 A/A/A 冻结。

[宪宪/deepseek-flash🐾]
