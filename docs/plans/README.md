---
title: "codeteam 执行计划索引"
doc_kind: index
status: reviewed
created: 2026-10-21
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
---

# codeteam 执行计划索引

> 上游：`architecture/0001`–`0003`、`plans/0001-runtime-hardening.md`。
> 本目录把 W0–W8 拆成可执行、可评审、可验收的计划。每个 W 都必须有 evidence，不以“代码写完”作为完成。

## 执行顺序

```text
W0a 外部仓 bootstrap + 文档迁移 + 基线对码 + L0 spike + session export + 供应链最小
  ↓
W1 控制面数据模型（先过继承矩阵）
  ↓
W2 权限/身份/沙箱  +  W3 独立 review（并行）
  ↓
W4 SOP 复用 / Design Gate（W3 ReviewPolicy 落地后）
  ↓
【dogfood gate：W0–W4 真实跑 2–3 个小 task 到 merge 完成（local merge service 执行；`DP-MERGE-2=A`；阶段一用 `codeteam thread` CLI 聊天，不依赖 Web）】
  ├── W5 多 task + RPC + A2A/custody 复用（W0b 必须先完成）
  ├── W6 Memory/Eval 继承 + 代码适配
  ├── W7a headless API/CLI/事件重放 → W7b 前端壳（C → A）
  └── W8 Forge connector（依赖 W7a）

W0b upstream/CI 治理：与 W1–W4 并行，W5 前完成
```

## 文档映射

| 文档 | 覆盖 | 主要评审视角 |
|---|---|---|
| [`0001-runtime-hardening.md`](0001-runtime-hardening.md) | 高层 W0–W8、验收总表、风险、仍需确认 | operator + 三猫 |
| [`0005-plan-review-resolutions.md`](0005-plan-review-resolutions.md) | 三猫评审 P1/P2 处置、已修正项、下一轮决策 | operator + 三猫 |
| [`0006-clowder-reuse-plan.md`](0006-clowder-reuse-plan.md) | clowder feature 复用盘点：35 cell、Batch 0 归属、Batch 1 P0 卡、Drop 清单 | operator + 三猫 |
| [`0007-architecture-plan-coverage.md`](0007-architecture-plan-coverage.md) | 架构卡 / Decision Packet → W 任务/验收/风险覆盖矩阵；本轮缺口修复记录 | operator + 三猫 |
| [`0002-w0-w2-foundation.md`](0002-w0-w2-foundation.md) | W0 fork/L0、W1 数据模型、W2 权限/身份/沙箱 | 烁烁（W0）+ 砚砚（W2） |
| [`0003-w3-w4-review-sop.md`](0003-w3-w4-review-sop.md) | W3 独立 review、W4 SOP 复用/Design Gate | 砚砚（review/security）+ 墨墨（流程/Product） |
| [`0004-w5-w8-scale-product.md`](0004-w5-w8-scale-product.md) | W5 调度/RPC、W6 memory/eval、W7 Console、W8 GitHub | 烁烁（W5）+ 墨墨（W7）+ 砚砚（W8） |

## W0–W8 一览

| W | 目标 | 主交付 | 门禁 |
|---|---|---|---|
| W0 | W0a 前置验证；W0b 治理 | W0a：外部仓 fork/bootstrap、文档迁移、基线对码、L0 compiler/spike、session export、供应链；W0b：`UPSTREAM.md`/`KERNEL_GAPS.md`/CI | W0a 先于 W1；W0b W5 前完成 |
| W1 | 控制面数据模型完整 | `backlog_items`/`workflow_sops`/`queue_entries` + `threads`/`messages`/`agent_profiles`/`agent_sessions`/`stages`/`run_events`/`artifacts`/`inbox`/`approvals`/`custody_events`/`waits`/review 等 schema | 继承矩阵 + migration + crash recovery |
| W2 | 真实 repo 安全 | per-run token、零 secret、低权 user/bwrap（MVP）/ container（目标态）、命令/路径策略 | 威胁测试 + audit |
| W3 | review 是独立验证 | ReviewPolicy、modelFamily、盲评、falsifier、headSha | FP/recall/survival |
| W4 | SOP 不拖慢小改动 | 全面复用 clowder SOP：`WorkflowSop` 告示牌 + 风险车道 + 点状硬门禁（worktree/design/review/verify/merge/completion） | gate 触发/剪枝证据；task done ≠ feature completion |
| W5 | 多 task + RPC 可运营 | ADR-043/F117 dispatch queue + A2A 执行链（AgentRouter/routeSerial/routeParallel 复用，invokeSingleCat 换 invokeSingleAgent→pi kernel）+ F139 schedule + task readiness/DAG、A2A tool surface、Ball custody/wait、budget、worktree pool、RPC 三语义 | single queue、A2A chain、并发/依赖/crash/re-attach/custody replay |
| W6 | 记忆可回源、eval 可决策 | 继承 memory/eval + 代码 adapter；不新建 evidence store | source ref + 多 provider + 代码域指标 |
| W7 | operator 能真正用 | W7a headless API/CLI/事件重放；W7b Console（dogfood C → 产品 A） | 真实 thread/diff/review/聊天/审批 |
| W8 | GitHub/GitLab 工作流闭环 | ForgeAdapter、webhook/API 对账、comment 门禁 | issue/PR/CI/comment + 幂等 |

## 复用优先级（单一入口）

复用分档统一以 [`../reuse/REUSE-MATRIX.md`](../reuse/REUSE-MATRIX.md) 为单一入口；本文件不再维护第二套 P0/P1/P2/Drop 表。

`landed + consumed` / `contract-frozen` / `sunset` 等状态口径保留为各 cell 卡 `Current truth` 的输入，不再单独排序。默认复用 > 适配 > 新建；新建必须说明 clowder 版本为什么不适用，并以“更快到 W0–W4 dogfood”为判断标准。

## 每个 W 的完成定义

1. **代码/文档交付**：落到具体文件/接口/迁移。
2. **可运行证据**：命令、测试、日志、截图或 artifact。
3. **独立 review**：作者不是 reviewer；代码 review 默认跨 model family。
4. **验收记录**：写到 `docs/reports/` 或对应 plan 的 Results 段。
5. **回滚路径**：schema/配置/部署改动有明确回滚方式。

## 评审分工

- **烁烁**：W0 fork/L0、W5 RPC worker/session/调度。
- **砚砚**：W2 权限/沙箱、W3 review/falsifier、W8 GitHub 安全。
- **墨墨**：W4 SOP 复用/Design Gate、W7 Console/operator UX、文档一致性。
- **operator**：范围、merge policy/硬门、sandbox 默认、开源发布；routine merge 按 `DP-MERGE-1=D` 由 merge owner 执行。

## 状态

> **Review routing（operator 2026-10-27）**：代码/安全/测试覆盖 review 默认找砚砚；烁烁负责 L0/session/fork 专项；愿景守护必须既非作者也非 reviewer。

> 三猫评审已完成；4 个 P1 与已接受的 P2/P3 已修入计划正文，详见 `0005-plan-review-resolutions.md`。W6、W7 载体、D1（notify-but-not-block）、D3（sandbox）已确认；D2 dogfood 里程碑延后到 W4 前拍板，不阻塞 W0a。全量覆盖审计（2026-10-25）：14/14 架构卡、10/10 Decision Packet 均有 plans 落点，见 `0007-architecture-plan-coverage.md` §1.1/§5；三猫 v2 复审全部 accept，`0007` 冻结为 DP→plans 唯一对账索引。

| W | 状态 | 备注 |
|---|---|---|
| W0 | W0a closed (F002, operator signoff) + W0c done (F003) | W0b 治理已生效；W1 runtime 启动前置已满足 |
| W1 | in progress (F004 umbrella) | schema + F004a merged (`7d7f2b0c`)；F004b work/SOP/artifacts in progress |
| W2 | planned | 待权限/身份/沙箱 |
| W3 | planned | 待独立 review 实现 |
| W4 | planned | clowder SOP 复用 + point gates + approval CLI + 最小 thread CLI；merge D / skill migration 契约已冻结 |
| W5 | planned | 待 scheduler/RPC |
| W6 | planned | memory/observability/harness-eval 契约已冻结；继承 + 代码 adapter |
| W7 | planned | W7a headless → W7b Console（C → A）；前端复用基线 `DP-WEB-1=B`（classic）；`thread-chat-surface`/`thread-navigation` 在 W7b 前补卡 |
| W8 | planned | github-signals W8 契约已冻结；待 Forge connector |

---

[宪宪/deepseek-flash🐾]
