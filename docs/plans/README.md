---
title: "codeteam 执行计划索引"
doc_kind: index
status: reviewed
created: 2026-10-21
updated: 2026-10-31
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
| [`0008-w3-review-implementation.md`](0008-w3-review-implementation.md) | W3 ReviewPolicy / 盲评 / falsifier / headSha / eval corpus 实施拆分与验收映射 | 砚砚（代码/安全/falsifier）+ 墨墨（eval/流程） |
| [`0002-w0-w2-foundation.md`](0002-w0-w2-foundation.md) | W0 fork/L0、W1 数据模型、W2 权限/身份/沙箱 | 烁烁（W0）+ 砚砚（W2） |
| [`0003-w3-w4-review-sop.md`](0003-w3-w4-review-sop.md) | W3 独立 review、W4 SOP 复用/Design Gate | 砚砚（review/security）+ 墨墨（流程/Product） |
| [`0004-w5-w8-scale-product.md`](0004-w5-w8-scale-product.md) | W5 调度/RPC、W6 memory/eval、W7 Console、W8 GitHub | 烁烁（W5）+ 墨墨（W7）+ 砚砚（W8） |
| [`0010-w5a-a2a-dispatch-custody.md`](0010-w5a-a2a-dispatch-custody.md) | W5a A2A 投递与球权内核实施计划、投影契约、AC 映射 | 烁烁（A2A/session/custody）+ 砚砚（code/security） |
| [`0011-w5b-rpc-worker-runtime.md`](0011-w5b-rpc-worker-runtime.md) | W5b RPC worker harness、worker registry/sticky/re-attach、失败重试与 AC 映射 | 烁烁（A2A/session/worker）+ 砚砚（code/security） |
| [`0014-w6a-memory-evidence.md`](0014-w6a-memory-evidence.md) | W6a Memory / Evidence 回源：独立 memory.db、evidence/source-ref 契约、recall/trigger/digest、redaction、AC 映射 | 墨墨（memory/reuse/真实路径）+ 砚砚（provenance/redaction） |
| [`0015-w6c-observability-trajectory.md`](0015-w6c-observability-trajectory.md) | W6c observability/trajectory、F150/F130 parity、redaction/trace/log 契约冻结、AC 映射 | 砚砚（security/redaction/provenance）+ 墨墨（reuse/真实路径/可解释性） |
| [`0016-w6b-eval-outcome-harness-eval.md`](0016-w6b-eval-outcome-harness-eval.md) | W6b Eval/Outcome + Harness Eval：outcome episodes、corpus/matrix、registry、verdict/lifecycle、evals 扩展、CLI 读面、AC 映射 | 墨墨（eval/harness reuse/process）+ 砚砚（provenance/eval credibility/security） |
| [`0017-a2a-e2e-foundation.md`](0017-a2a-e2e-foundation.md) | A2A E2E Foundation：production composition root、producer/task 绑定、session/worktree 入口、worker A2A tools、terminal resolver、requestId/loop guard、真实 CLI/daemon/worker E2E | 烁烁（A2A/session/worker）+ 砚砚（identity/custody/security）+ 墨墨（vision guard） |
| [`0018-f016a-a2a-ingress-e2e.md`](0018-f016a-a2a-ingress-e2e.md) | F016a：8 类 ingress × scenario real RPC E2E、P0 工具面（5 现有 + thread_context）、withdraw/parallel/loop guard/typed error、F016b/F016c 边界 | 烁烁（dispatch/queue/terminal）+ 砚砚（auth/custody/withdraw）+ 墨墨（vision guard） |
| [`0019-f017-a2a-surface-unification.md`](0019-f017-a2a-surface-unification.md) | F017：统一 post_message/cross_post_message、custody union、harness 不变量、SOP/skill 方向模型、A/B/C 迁移 | 烁烁（A2A/queue）+ 砚砚（custody/auth）+ 墨墨（SOP/reuse） |

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
| W1 | closed (F004, operator confirmed) | schema + F004a–e all merged；84/84 at close（current tip 122/122）；收口清单见 F004 umbrella |
| W2 | closed (F005, operator confirmed) | F005a–e 全合入（131/131）；真实 repo 首跑已记录；墨墨愿景守护有条件放行；operator 已显式确认 bwrap + 零 secret MVP 边界；residual 按 ledger 挂 W5/executor hardening |
| W3 | closed (F006, operator confirmed) | `0008` + F006；包内 171 passed / 1 skipped；砚砚 code/security + 墨墨 eval 均 Approved；CI 4/4；烁烁愿景守护有条件放行，follow-up ledger（W4）已补；operator 已确认 F006 accepted/done |
| W4 | closed (F007, operator confirmed) | PR #47 `4743137c9` + PR #48 `772dd1741`；264 passed / 1 skipped；22/22 AC；vision guard 烁烁 approve；W7a residuals tracked（`0009` / F007） |
| W5 | closed (W5a/W5b/W5c core/W5d; operator confirmed) | F008/`0010` + F009/`0011`（W5b closed）+ F010/`0012`（W5c core closed，PR #52 `959ef7e76`）+ F011/`0013`（W5d closed：PR #56 `168e67dd0` reviewed HEAD `dfb872d9c`；烁烁 post-merge P2 修复 PR #59 `125ba4f81` reviewed HEAD `d96ca039b`，APPROVED；operator signoff `0001793204552090-003817-65582a68`） |
| W6 | closed (W6a/W6b/W6c; operator confirmed) | W6a/F012 PR #62 `c82b0679c`；W6c/F013 PR #63 `12c546854`；W6b/F014 PR #66 `b74952ac2`；operator signoff `0001793276746238-003935-3d7a01c4` |
| W7 | in_progress | W7a A2A E2E foundation merged（F015，PR #72 `b941dde32`）；F016a ingress/tool E2E merged（PR #81 `bc778185e`）；F016b wait、F016c headless API/Hub 兼容待做；W7b Console 后置，复用基线 `DP-WEB-1=B`（classic） |
| W8 | planned | github-signals W8 契约已冻结；待 Forge connector |

---

[宪宪/deepseek-flash🐾]
