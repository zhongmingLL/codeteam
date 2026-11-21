---
title: "F016 — W7a re-scope after A2A runtime v1"
doc_kind: plan
status: accepted
created: 2026-11-21
updated: 2026-11-21
owner: "宪宪 (DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash), 烁烁 (Kimi K3, standby)]
feature: F016
source_plan: "docs/plans/0018-f016a-a2a-ingress-e2e.md"
source_architecture: "docs/architecture/0005-thread-first-runtime.md"
source_report: "docs/reports/2026-10-31-clowder-hub-api-compat.md"
related_features: [codeteam/F016, codeteam/F018]
---

# F016 — W7a re-scope after A2A runtime v1

> 本文只做 scope 重对齐与决策建议，不写产品代码。F016b/F016c 的实现必须在
> 本文的 D1/D2/D3 得到 operator 签字后另开执行 plan；F018 已 done，不能把
> task-first/custody 重新带回 A2A runtime。

## 0. 结论先行

1. **F016b/F016c 写于 F018 之前，坐标已过期。** 旧 F016b 的 wait 三件套依赖
   handoff/custody；旧 F016c 的 Hub P0 包含 backlog/approval/workflow SOP。
   F018 之后这些都不是 A2A runtime 的新能力，而是 frozen legacy。
2. **建议先做 F016c-M1（Hub/headless API），再做 M2 live events；F016b 暂缓。**
   F018 已把 CLI/daemon 打通；当前最缺的是 operator 可用的 Hub/headless 面。
   wait 目前没有真实 caller，先做容易变成“为工具而工具”。
3. **F016c-M1 只读/写 A2A 面**（thread/message/agent/queue），legacy 面
   （backlog/approval/workflow SOP）诚实空读或 501，不在本轮补新能力。
4. **F016b 如未来有真实 caller，另立纯 A2A wait 设计**：锚定 thread/invocation，
   owner fence，精确 cancel；不恢复 `codeteam_wait_*` / handoff events。

## 1. 为什么必须 re-scope

| 旧 F016 假设 | F018 后的真实坐标 | 影响 |
|---|---|---|
| F016b 做 `codeteam_wait_*` / `codeteam_handoff_events` | custody/handoff 已 retired；A2A v1 不做 | 旧工具不应实现；wait 需重新定义或 defer |
| F016c Hub P0 含 backlog/approval/workflow SOP | 这些在 `control.db` legacy，A2A runtime 不读写 | 不能作为新 A2A 功能；只能诚实空读/501 或显式 legacy 只读 |
| 工具名 `codeteam_*` | F019.5 后新工具用 `superagentteam_*` | 新工具不得恢复旧前缀 |
| Task/run 是执行锚 | Thread/Invocation/TurnExecution 是执行锚 | Hub API 必须按 thread/invocation 投影，不假设 task |
| SSE/replay 是 W7a 目标 | Hub 实际是 Socket.IO + history refetch | 不造 SSE/replay log；做 durable history + live events + watermark |

## 2. 决策点

### D1 — wait 是否进入当前开发

| 选项 | 内容 | 评价 |
|---|---|---|
| **A（建议）** | 暂缓 F016b；等真实 caller 出现再立项 | 避免无调用方的工具与表；当前没有 A2A wait caller |
| B | 做纯 A2A wait：thread/invocation terminal 或 callback；owner fence；精确 cancel | 需要新设计/新表/新 API，不是旧三件套的薄包装 |
| C | 恢复旧 custody/handoff wait | **不做**；违反 F018 纯 A2A 边界 |

### D2 — Hub 的 legacy 面怎么处理

| 选项 | 内容 | 评价 |
|---|---|---|
| **A（建议，operator 2026-11-21 已签）** | backlog/approval/workflow SOP 返回诚实的空读或 501；Hub 先隐藏这些面板 | 不伪造、不把 legacy 带进 A2A；当前阶段不需要 legacy 视图 |
| B | 显式 legacy 只读：从 `control.db` 读，标注 frozen/read-only | 需要额外授权与清晰边界；不能写 |
| C | 把 backlog/approval/workflow SOP 重新实现成 A2A 功能 | **不做**；这是新 feature，不是 F016 re-scope |

### D3 — 顺序

| 选项 | 内容 | 评价 |
|---|---|---|
| **A（建议）** | F016c-M1 → F016c-M2 → cancel 授权 → hardening | operator 最先拿到可用 Hub/headless 面 |
| B | F016b 先做纯 A2A wait | 没有真实 caller，收益不确定 |
| C | 只做 post-F018 hardening | 不能解决 operator 可见面缺失 |

## 3. F016c-M1（建议先做）

### 3.1 API 面（只读/写 A2A）

| 面 | endpoint | 数据源 | 说明 |
|---|---|---|---|
| session | `GET /api/session` | console-link / operator session | 独立 cookie + CSRF；无匿名 fallback |
| threads | `GET /api/threads?view=sidebar` | `f018.db` threads/messages | 可先不做 presence；ETag 可后补 |
| thread detail | `GET /api/threads/:id` | `f018.db` | 404 表示不存在 |
| thread create | `POST /api/threads` | `f018.db` | 最小版；idempotencyKey 可后补 |
| messages | `GET /api/messages?threadId=&limit=&before=` | `f018.db` messages | cursor 按 message seq/时间适配 |
| message append | `POST /api/messages` | `OperatorMessageIngress` | M1 admission 必须要求/生成 idempotencyKey，复用 `thread post` 的 messageId replay 语义；不后补 |
| queue read | `GET /api/threads/:id/queue` | `f018.db` queue/invocation | 断线 reconcile 必需；先诚实空读再补投影 |
| cats/config | `GET /api/cats` / `GET /api/config` | `f018.db` agent catalog | 只作显示与默认配置，不作授权 |

### 3.2 Legacy 面（本轮不实现）

- backlog items / workflow SOP / approval pending/settled/decide / tasks /
  artifacts / labels / workspace：返回诚实的空读或 501，并在 Hub 先隐藏
  （operator 2026-11-21）；当前阶段不接 legacy 视图。
- 不读 `control.db` 作为 A2A 面的数据源；legacy 只读若要做，必须单独授权并
  标注 frozen。

### 3.3 Auth / 安全

- console-link → 独立 browser session cookie；SameSite/Origin allowlist；
  所有写操作 CSRF；无 cookie/无效 session 直接 401，不落 `default-user`。
- 写 message 必须走 `OperatorMessageIngress`，并补 idempotencyKey；不能直接
  复用 legacy message append 的宽松边界。
- `cancel_invocation` 是第一个真实 operator cancel caller，但**不在 M2 交付**；
  它必须与 P3 的授权层同 PR，不能先出现一个无授权的 Hub cancel 入口。
  授权谓词：operator session 必须是目标 thread 的 owner；target invocation
  必须属于该 thread；无跨 thread、无 agent 代签；`actionId` 幂等；映射到
  该 invocation 的 `cancelTarget`/`cancelRequest`（F018 报告 §6 的 cancel
  caller 缺口）。

## 4. F016c-M2（live events）

最小事件面：

- `join_room` / `leave_room`（thread room；无 cookie 直接 disconnect）
- `agent_message`（同一 response messageId；文本 replace；done/error 终态）
- `intent_mode` / `spawn_started`（invocation 开始）
- `thread_updated` / `thread_created`（sidebar invalidation）

> `cancel_invocation`（client→server）不在 M2 交付；它必须与 §3.3 的授权层
> 同 PR（P3），M2 不注册该事件、不对 Hub 承诺。

明确不做：

- SSE 事件总线；
- 服务端 WS replay log；
- queue 控制面 / task / approval / artifact / guide / voice 事件。

断线语义：durable history + live event seq watermark + refetch；`seqEpoch`
用 daemon bootId，客户端 gap/epoch change 时重取 history，不靠 replay。

## 5. F016b（暂缓）

- 不实现 `codeteam_wait_*` / `codeteam_handoff_events`。
- 如果未来出现真实 caller，另立纯 A2A wait 设计：wait 锚定 thread/invocation
  或 callback，owner fence，精确 cancel；不恢复 custody/handoff。
- 该设计应作为新 feature/plan，不塞回 F016b 旧范围。

## 6. 工作拆分

| 阶段 | 交付 | 门禁 |
|---|---|---|
| P0 | 本文 + operator D1/D2/D3 签字 | docs review；不写代码 |
| P1 | F016c-M1 API + contract tests | 砚砚 API/security；墨墨 user-facing |
| P2 | F016c-M2 events + reconnect convergence（不含 `cancel_invocation`） | real Hub/headless E2E；无 cookie 负例 |
| P3 | cancel 授权 + Hub cancel 映射（`cancel_invocation` 与授权同 PR） | 与第一个真实 caller 一起落；M2 不注册该事件 |
| P4 | post-F018 hardening 小批（session id 碰撞、heartbeat env、observation 等） | 小 PR，按需穿插 |

## 7. 验收

- 本文先由砚砚（API/security）与墨墨（vision/UX）review，operator 对 D1/D2/D3
  签字后，才开 F016c-M1 执行 plan。
- F016c-M1/M2 的验收必须包含：A2A 面只读 `f018.db`、不读写 `control.db`；
  legacy 面诚实空读/501；无 `default-user` fallback；写操作 CSRF/幂等；
  message append 的 idempotencyKey 在 M1 admission 生效；M2 不暴露未授权
  `cancel_invocation`；cancel 只在 P3 与授权层同 PR；断线后 history 收敛；
  无 custody/task-first 回潮。

## 8. 非目标

- custody/handoff/wait 旧三件套；
- TaskItem/worktree/code delivery/review/merge/SOP gate；
- backlog/approval/workflow SOP 的新 A2A 实现；
- SSE/replay log、Hub v2、MCP ingress、Console M0；
- 任何新的 task-first/legacy 表读写。

## 9. 已拍板（2026-11-21）

Operator 签字：

- **D1=A**：暂缓 F016b wait；等真实 caller 再立纯 A2A wait。
- **D2=A**：legacy 面板先隐藏；当前阶段不需要 legacy 只读或重造。
- **D3=A**：F016c-M1 先做，随后 M2。

F016c-M1 另开执行 plan；F016b 保持 deferred，直到出现真实 caller。

## References

- `docs/features/F016-w7a-headless-surface.md`
- `docs/plans/0018-f016a-a2a-ingress-e2e.md`
- `docs/reports/2026-10-31-clowder-hub-api-compat.md`
- `docs/architecture/0005-thread-first-runtime.md`
- `docs/reports/2026-11-21-f018-r5-final.md`

[宪宪/deepseek-flash🐾]
