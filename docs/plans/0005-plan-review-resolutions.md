---
title: "W0–W8 计划评审决议"
doc_kind: decision-log
status: accepted
created: 2026-10-21
updated: 2026-10-24
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
---

# W0–W8 计划评审决议

> 来源：三猫对 `plans/README.md` + `0002` / `0003` / `0004` 的独立评审。
> 结论：计划结构成立；4 个 P1 与已接受的 P2/P3 已修入计划正文。W6、W7 载体、D1（notify-but-not-block）、D3（sandbox）已确认；仅 D2 dogfood 里程碑待拍板，不阻塞 W0a。

---

## 1. 已修正的 P1

| # | Finding | 修正 |
|---|---|---|
| P1-1 | L0 compiler / adapter 升级没有 W 归属，runs 缺 `l0_revision` | W0 增加 “L0 compiler v0 + spike”；W1 加 `runs.l0_revision`；0001 schema 同步 |
| P1-2 | W5 没有 RPC worker harness 交付物 | W5 增加 harness task/deliverable/acceptance：启动、extension 装配、token 0600、JSONL、事件回流、关停 |
| P1-3 | fast lane 术语冲突：docs-only 与“小 bug 走 fast lane”不可同时成立 | 拆成 `docs-lane` 与 `small-change-lane`；small-change 仍走独立 review/verify/merge（当时按 A 记录；2026-10-25 `DP-MERGE-1=D` 后由 merge owner 执行） |
| P1-4 | approval/merge 端点没有鉴权模型，run token 可能绕过 human gate | 新增 operator / run / webhook 三 auth 域；当时按 A 记录 merge/approval 只接受 operator；`DP-MERGE-1=D` 后拆为 approval decide operator + merge-owner capability |

## 2. 已修正的 P2

| Finding | 修正 |
|---|---|
| W1 验收混入 W7 的 Console M0 | 改为“只读查询接口有 store 级测试覆盖，字段足够渲染 M0”；页面验收留在 W7 |
| W7 假依赖 W6，M0 被 memory 拖住 | W7/M0 只依赖 W1 + W3；W6 outcome data 仅用于 M1 |
| W5 缺 worker liveness | worker registry 加 heartbeat/lease；stale → claimed runs interrupted、sessions `re_attach_pending`、禁止死 sticky；验收拆 daemon crash / worker crash |
| W5 per-run policy 失败模式 | control plane 不可用时 fail-closed：deny 非只读工具，只读工具按 allowlist |
| W0 L0 spike 方法学不清 | 定死 mock provider / recording proxy、auto + 手动 compact、SDK `systemPromptOverride` 通道 |
| pi session export 未验证 | W0 增加跨进程 resume/export 验证；不支持则 W5 迁移改为 fresh+capsule，sticky 作为硬约束 |
| handoff claimed-expiry 无字段 | W1 加 `claimed_lease_until` / `last_heartbeat_at`；0001 schema 同步 |
| coder git policy / headSha 来源 | W2 增加 `git add/commit/status/diff` 白名单 + commit wrapper 捕获 sha 进 audit；W3 验收要求 headSha 可回溯 |
| token 落盘与撤销 | token 放 `/run/codeteam/tokens/` 前缀硬 deny；terminal/interrupted 撤销；恢复测试禁止旧 token late-complete |
| modelFamily 防错 | 受控枚举静态文件；`reviews` 记录 author/reviewer model+family 四元组；W3 验收要求配置错误可审计 |
| falsifier 三态语义 | 单条 finding 降级，不整条 review 拒绝；`blocked` 仅限基础设施故障；正常完成 exit≠expected 一律 confirmed/rejected |
| W8 inbound 门禁只盖 comment | issue/PR/comment/check 统一门禁：maintainer/collaborator 是必要条件；label/mention 只作叠加 opt-in |
| webhook 去重无持久化 | W1/W8 增加 `forge_deliveries`（delivery id / natural key / status）；验收重启后重放仍去重 |
| eval 小样本误用 | 门槛保留但标注：n≥20 前只作 smoke，不用于 model family 结论 |
| bwrap 网络限制 | D3=A 附网络边界：MVP agent 网络开放为已知威胁；container 目标态再做 allowlist；W0a WSL2 预检 |
| W0 供应链最小项 | CI 加 lockfile 完整性 + dependency audit（失败阻断）；写明 `--ignore-scripts` 理由 |
| W6 纠错/遗忘通路 | 默认 human 确认；禁止 agent 链式“自我纠错”写回 evidence store |
| 0002 L4 表述混淆 | 已改为 full fork（仓库形态）+ L1/L2（默认实现）；L4 仅 KERNEL_GAPS 后 |

## 3. 已修正的 P3

| Finding | 修正 |
|---|---|
| `runs` 同时有 `agent_session_id` / `session_id` | 删除 `runs.session_id`；规定 runs 不直连 pi session，一律 join `agent_sessions` |
| W5 tool_call hook 失败模式 | 已并入 W5 三语义：control plane 不可用 fail-closed |
| W0 fork 仓内拓扑缺纪律 | 增加 `packages/codeteam-*` 目录约定；上游文件只在 KERNEL_GAPS patch 中改动 |
| W1 只到表名粒度 | 明确 0001 §12.2 是列级真相源；W1 演进必须回写 |
| F001 reviewers 未同步 | F001 reviewers 增加 product/UX reviewer |
| W3/W4 并行口径不一致 | 统一为：W4 在 ReviewPolicy 接口冻结后与 W3 尾部并行；review gate 等 ReviewPolicy 落地 |
| sandbox 默认三种写法 | 统一为：MVP 低权 user + bwrap；目标态 container；microVM 后置；待 operator 确认 |
| “仍需确认”清单漂移 | 以 `plans/0001 §7` 为单一来源；architecture §21 只引用，不复制 |

## 4. 待 operator 拍板

已确认：

- **W6 = 继承 + 代码适配**（W6A memory/evidence P0、W6B eval/outcome P0、W6C lessons/decisions P1、cue/context P2），不另建 memory/eval 系统。
- **W7 前端载体 = C → A（前提：W0a Hub 承载 spike 通过）**：dogfood 接入现成 clowder Hub；产品期同构契约 + 复用/fork 组件。W7 拆 W7a（headless）/ W7b（前端壳）。若 spike 显示需要 clowder-ai 侧改动，作为独立 operator 授权项。
- **high 风险 = B（notify-but-not-block）**：spec+plan 进 thread 时间线并通知，不阻塞；不同意用 `spec_change` 拉回。
- **sandbox = A（附网络边界修正）**：MVP 低权 user + bwrap；agent 进程网络开放为已知威胁模型边界；目标态 container 再做 allowlist。

1. **MVP dogfood 里程碑（已拍 `DP-MERGE-2=A`）**：阶段一（W0–W4）= merge service（local `MergeExecutor`）+ `merge record` + `approval` CLI + 最小 thread CLI（`thread list/show/post/tail`），用真实仓库跑 4 个 task（或指定 3 条 lane）到 merge service 完成（`DP-MERGE-1=D`，D-first，不做 A-interim）；阶段二（W7a）= C Hub 体验。达标后再启动 W5。
   - 推荐：作为 W5 的硬前置。
   - 2026-10-23 修正：产品代码在外部 codeteam 仓；clowder-ai 只能作为隔离的 dogfood 目标仓，不把产品代码写进 clowder-ai；daemon 数据/ worktree 在仓外，分支不 push，结束清理。

## 5. 结论

- 计划可以进入 W0；W0/W1/W2/W3 的契约已足够开工。
- W5–W8 的规模化和 Console 提前/后置，建议在 W4 dogfood 报告后由 operator 拍板。
- 下一步：先做 W0a（外部仓 fork/bootstrap + 文档迁移 + 基线对码 + L0/session/供应链 + Hub 承载 spike + bwrap/worktree 预检），再 W1 schema；W0b upstream/CI 治理并行，W5 前完成。

## 6. 2026-10-22 operator 修正

- **Thread Model 直接复用 clowder**：Thread、`Message`、`RichBlock`、Ball custody、`Approval Hub`、Mission Hub 沿用 clowder 语义；codeteam 只把 cat session 映射成 role `AgentSession`，agent↔agent 分支保持 typed handoff/event。operator↔agent 用普通 `Message` 聊天，不把 typed A2A 语义强加给聊天。
- **Console M0 修正**：M0 = 看 + 聊 + 批。thread chat 是普通消息写入，不改变 task 状态，也不获得 approval/merge 权限。
- **设计继承**：默认复用 clowder 已验证的 thread/message/rich block/handoff/approval/memory 概念；只剔除 voice、IM 网关、社交 feed 等与代码交付无关的能力。新增差异必须说明代码交付理由。
- **已确认直接沿用**：`Message`、`RichBlock`、Ball custody、`Approval Hub`、Mission Hub、Memory/Eval、Skill/SOP；codeteam 只加代码字段和 gate，不另起同名概念。
- **复用分档**：以 [`../reuse/REUSE-MATRIX.md`](../reuse/REUSE-MATRIX.md) 为单一入口；Round 2/3 的旧 P0/P1/P2 表已被 cell 级分档取代。`landed + consumed` / `contract-frozen` / `sunset` 状态口径保留为矩阵 `Current truth` 的输入。

## 7. Round 2/3 评审处置

| # | Finding | 处置 |
|---|---|---|
| P1 | A2A 三对象在 agent lane 无落点 | 0004 W5 增加 Queue Entry / History Message / Active Run 的双 lane 映射与四个控制映射 |
| P1 | `approvals` 丢 F246 双锚 / resolution-materialization / stale 语义 | 0001 §12.2 扩字段；0002 W1 验收补三锚与 stale |
| P1 | dogfood 缺 critical design / spec_change 的 operator 入口 | 0003 W4 增加 `approval list/show/approve/reject`，唯一审批读写通路 |
| P1 | W7 前端载体未决 | 已定 C（dogfood 接入现成 Hub）→ A（产品同构 + 复用/fork）；W7 拆 W7a/W7b |
| P1 | 复用表缺状态维度 | plans/README 加状态列；简报/concierge 标 sunset，cue/context 标 contract-frozen |
| P2 | RunStatus 缺 `canceled`；HandoffStatus 缺 `withdrawn` | 0001 枚举与 §5.2/§5.3 状态机补齐 |
| P2 | custody/waits 枚举与 trigger 缺失 | 0001 §12.2 固定 kind、append-only trigger、`expected_signal`、双计时器规则 |
| P2 | approval 单一数据源未规定 | 0001 §14.2：审批只能来自 `approvals`；message richBlocks 不得生成审批项 |
| P2 | W0 fork 阻塞 dogfood | fork 上移 W0a bootstrap；W0b 只做 upstream/CI 治理 |
| P2 | 继承矩阵放到 W6 太晚 | 前置为 W1 入场门禁 |
| P2 | README 依赖图仍线性 | 改为 W0a → W1 → (W2∥W3) → W4 → dogfood gate → 并行后续 |
| P3 | F233 不变量、队列比较子、双计时器、forge/messages 列、文案残留 | 已补入 W5 验收、§12.2 与 plans/README |

## 8. 待拍板 Decision Packets

工作区边界（2026-10-23 澄清）：`clowder-ai/codeteam/` 只是讨论产物暂存区，不是开发仓；产品代码迁到外部新建 codeteam 仓；dogfood 可以把 clowder-ai 当目标仓，但只能在隔离 worktree 里跑 task，不把 codeteam 产品代码写进 clowder-ai。

### D1：high 风险是否 notify-but-not-block

**问题**：数据迁移/auth/schema/public API 这类 high 风险任务，在 implement 前是否让 operator 看到一次 spec+plan？

| 选项 | 价值 | 代价 | 风险 |
|---|---|---|---|
| A 维持现状 | 最快、operator 负担最低 | 无额外流程 | 方向错误到 merge 才发现，返工已付 |
| **B notify-but-not-block（推荐）** | 提前看到方向，不阻塞实现 | 多一条通知/时间线 | 通知可能被忽略 |
| C high 也 human gate | 最稳 | 每个 high 任务等 operator | 拖慢 dogfood，回到逐日审批 |

**已拍板：B。** spec+plan 自动进 thread 时间线并通知；operator 不同意时用 `spec_change` 拉回。
**不拍板默认**：A。
**可逆性**：策略开关，可随时切换。

### D2：MVP dogfood 里程碑

**问题**：首个 dogfood 用什么仓库、跑哪些 task、什么算通过？

| 选项 | 价值 | 代价 | 风险 |
|---|---|---|---|
| **A clowder-ai 隔离 worktree + 4 个 task（推荐；产品代码在外部仓）** | 真实、搭好即可跑 | 需要严格隔离，不碰 main | 仓库污染/误操作 |
| B 专用 dogfood 仓/fixture | 最安全 | 真实性低，集成问题暴露少 | 通过但生产不可用 |
| C 外部个人仓 | 真实、贴近使用 | 配置/授权成本 | 外部数据边界 |

**推荐**：A，但前提是产品代码在外部 codeteam 仓；clowder-ai 只作为 dogfood 目标仓。4 个 task 分别覆盖 docs-lane、small-change-lane、普通 bug+test、design-gated；或明确指定 3 条必测 lane。task 候选提前预登记 3–4 个。
**通过标准**：第 0 步用 `codeteam backlog create/dispatch` 创建 3–4 个 backlog item 并 dispatch；全部由 local merge service 在 dogfood 隔离分支完成（`DP-MERGE-1=D` / `DP-MERGE-2=A`）；0 P0/数据丢失/越权 merge；routine merge 的 operator touch = 0；至少一次 crash recovery；至少一次 hard-gate approval CLI；记录 time-to-green、merge-owner latency、failure/unknown、operator hard-gate wait、cost；交付 **dogfood 摩擦记录**（operator 的卡点/缺失信息），直接喂 W7a 功能清单。
**边界**：daemon 数据在仓外；worktree 在外部目录；分支不 push；结束后清理分支/worktree，只保留 artifact 与报告；进入 clowder-ai main 必须由 operator 发起并走 clowder-ai 自己的 PR/review。
**不拍板默认**：A（隔离 worktree，不 push main）。
**可逆性**：换仓库不影响架构。

### D3：sandbox 默认

**问题**：MVP 的代码执行默认用哪层隔离？

| 选项 | 价值 | 代价 | 风险 |
|---|---|---|---|
| **A 低权 user + bwrap（推荐）** | 快、够 local dogfood | 依赖 bwrap，隔离弱于 container | 本机边界仍需谨慎 |
| B 默认 container | 隔离更强 | 启动/运维重，拖慢 dogfood | 环境问题先于产品问题 |
| C 只低权 user、不上 sandbox | 最快 | 隔离最弱 | 真实 repo 风险高，不建议 |

**已拍板：A（附网络边界修正）。** MVP 低权 user + bwrap；目标态 container；microVM 后置。
**网络边界**：bwrap 不能同时做到“默认关网 + loopback MCP + provider API”。MVP 显式接受 agent 进程网络开放为已知威胁模型边界，靠零 secret + 路径 policy + audit 兜底；container 目标态再做 allowlist。W0a 先做 WSL2 bwrap 预检，不可用则 D3 重开。
**其他边界**：token 目录硬 deny；run token 不得触达 approval/merge。
**可逆性**：可升级到 container，不影响 schema/契约。

## 9. 2026-10-23 工作区评审处置

| 问题 | 处置 |
|---|---|
| W0a “新建仓”与 W0b “fork pi” 互斥 | fork 上移到 W0a bootstrap；W0b 只做 upstream/CI 治理 |
| 基线来源仓未命名、无对码报告 | W0a 显式命名来源；新增基线对码报告（reuse vs fresh），W1 引用 |
| 外部仓缺安全基线 | W0a 加 main 保护、required checks、禁 force push、CI secrets 只在 CI |
| 文档迁移无 DoD、双真相源 | 外部仓 docs 镜像；旧目录转只读快照；外部仓生成自己的 plans/README |
| C 方案未验证、dogfood 前端口径矛盾 | dogfood 阶段一 CLI；阶段二 W7a C Hub；W0a 加 Hub 承载 spike；C→A 以 spike 为条件 |
| bwrap 网络条款不可实现 | D3=A 附网络边界：MVP agent 网络开放为已知威胁；container 目标态再 allowlist；W0a WSL2 预检 |
| 低权 user × worktree 属主 | W0a 预检 worker 可写、reviewer 只读；禁止 chmod 777 |
| D2 边界/通过标准不足 | 4 个 task 覆盖 4 lane；摩擦记录；merge 目标为 dogfood 隔离分支；数据/worktree 仓外、分支不 push、结束清理 |

## 10. 2026-10-24 A2A 路由讨论

**已确认（前一轮）**：A2A 讨论可以是自然语言 `Message`（由 `a2a_send` 投递）；责任转移必须是 typed control。operator↔agent 聊天不是 A2A。

**本轮结论**：operator 于 2026-10-24 认可 A（tool-call-first）；discussion 与 control 都走 typed tool，文本 `@` 不作路由权威。

### D5：A2A 路由权威

**问题**：codeteam 基于单 kernel pi，A2A 的收件人由什么决定？

| 选项 | 价值 | 代价 | 风险 |
|---|---|---|---|
| **A tool-call-first（推荐；已拍板）** | 单 kernel 下最确定；schema/身份/幂等/审计统一；无“句中 @ 算不算”的歧义 | 弱模型可能漏调 tool | 漏调时表现为显式失败，而不是静默错投 |
| B hybrid：discussion 允许行首 @，control 必须 tool | 对弱模型更宽容；讨论更自然 | 两套入口，规则更难记；行首 @ 仍可能被误当责任转移 | 讨论与控制边界模糊 |
| C 复刻 clowder 文本 @ 主路径 | 与 clowder 行为一致 | codeteam 是单 kernel，收益低；多 provider 下解析成本高 | 重演 inline @ / “说了等于做了”事故 |

**推荐**：A。

**理由**：

1. pi 是单 kernel，extension/MCP 都是原生 surface，tool call 比文本协议可靠。
2. tool call 能做 target 授权、schema 校验、幂等、审计；文本解析做不到同等确定性。
3. 讨论与责任转移用不同工具，避免“一句话完成传球”。
4. 弱模型的漏调可以变成显式 `missing_a2a_tool_call` + 一次 schema 纠错提示；按 provider 记录 tool-call 成功率，低于门槛就不授予自主 handoff 权限。

**已拍板：A（2026-10-24 operator 认可）。** 讨论/控制都走 tool；文本 @ 只作可见标记。
**边界**：operator 在 thread 里仍可自然语言聊天；daemon 把需要行动的 operator 消息转 typed `inbox`，不要求 operator 调 tool。
**可逆性**：工具面与 daemon API 解耦；若后续证明弱模型不可用，可加“discussion 允许行首 @”作为 B，不影响 control 面。

> 状态：已生效。`0001 §2.4/§6.5`、`0002 §5.2` 与 `0004 W5` 中的内容进入 v1 契约；若后续证明弱模型不可用，按选项 B 重新评估 discussion 层，不改 control 层。

## 11. 2026-10-24 SOP 控制面：全面复用 clowder SOP

**已拍板（2026-10-24）：全面复用 clowder SOP。**

- 作用域：feature/backlog 级 `BacklogItem` + `WorkflowSop`。
- 推进权：留给猫；SOP 是告示牌，不是控制器。
- 硬门禁：只锁高风险点（worktree / design / review / verify / merge / completion）。
- 不新增 SOP stage；`verify` 是 review/merge 的 gate。
- 不另建 SOP eval 平台；复用 clowder 的 predicate evaluator 契约，telemetry 从执行数据派生。

### D6：SOP 控制面模型（已拍板）

| 选项 | 结果 |
|---|---|
| A 强制串行状态机 | 否决：clowder 300+ feature 的实践证明会把猫变成 workflow node |
| B gate-enforced lanes + bulletin board | 未单独采纳：执行层保留 gate 的部分被 D 吸收；SOP 层按 clowder 全量复用 |
| C 纯告示牌 | 否决：代码交付仍需点状硬门禁 |
| **D 全面复用 clowder SOP（拍板）** | **采纳**：feature/backlog 级 WorkflowSop + 风险车道 + 点状 gate + resume capsule；不实现第二套 SOP |

**理由**：clowder 已自主开发 300+ feature，SOP 的价值是“外化上下文和接力棒，不外包判断力”。codeteam 应复用已验证的 `sop-definitions`、`WorkflowSop`、`BacklogItem`、五轴风险、merge-gate/worktree/design gate/completion，而不是重新发明流程引擎。

**边界**：W0a/W1 不受影响；W1 增加 `backlog_items` / `workflow_sops`；W4 按复用契约实现。

> 状态：已生效。旧 W4 的串行 stage controller 设计废弃；详细契约见 `architecture/0001 §7` 与 `plans/0003 W4`。

## 12. 2026-10-24 三猫复核处置

三猫只审 D6 / AgentProfile / A2A tool-call-first 的契约后果。结论：方向成立；P1 集中在 5 个点，已修入文档。

| # | 发现 | 来源 | 处置 |
|---|---|---|---|
| P1-1 | `development.yaml` “直接复用”不可执行；predicate 参数写死 clowder 基础设施 | 烁烁/砚砚/墨墨 | 改 **派生目录（fork catalog）**；predicate 中性化；Redis 规则 drop/replace；W4 加去坐化清单 |
| P1-2 | `TaskStatus` 双写（`running/cancelled` vs clowder `todo/doing/blocked/done`） | 烁烁/墨墨 | 收敛为 clowder 四枚举 + `disposition(canceled/abandoned)`；更新 §4.2 / W1 |
| P1-3 | `Stage` 仍是控制器残壳 + `tasks.stage` 与 `WorkflowSop.stage` 同名 | 砚砚 | `Stage` 降级纯快照（run/lane/status）；`tasks.stage`→`tasks.lane`；`Run.attempt`；加“gate 不以 stage 迁移触发”验收 |
| P1-4 | W8/§18.1 `issue → task/thread` 与 backlog 必填冲突 | 墨墨 | 改为 issue → `BacklogItem` → dispatch → thread → task；W8 验收同步 |
| P1-5 | dogfood 第一步没有 backlog create/dispatch 入口 | 墨墨 | W4/W7a 加 `codeteam backlog create/dispatch/list`；D2 通过标准加第 0 步 |
| P2-1 | merge-gate 5 条被误读为 merge 执行授权 | 砚砚 | 明确“证据清单，不是执行授权”；agent 只能 `approval_request` |
| P2-2 | risk “只升不降”失去机器挂点 | 砚砚 | merge gate 增加 `risk-consistency` predicate |
| P2-3 | Artifact → ThreadArtifactDTO 投影契约缺失 | 砚砚 | W7a 加 kind 映射 + `sourceMessageId` + 账本/视图声明 |
| P2-4 | pending-wake 可能出现第二队列 | 墨墨 | 唯一 pending-wake = ADR-043/F117 `Queue Entry`（F122 历史）；`handoff`/`inbox` 是 source，同一 drain |
| P2-5 | §8.1 角色矩阵无控制面工具，allowlist 会锁死 A2A/SOP | 墨墨 | 角色矩阵加控制面工具列；actionPair 管时机 |
| P2-6 | C 兼容子集缺 backlog/workflow-sop，Hub 看不到 board | 墨墨 | 兼容子集加只读投影；§3.4 board/thread 投影口径修正 |
| P3 | probe redis、`Run.sessionId`、`ThreadPhase`、lease 命名、`SopChecks`、`approval_request`、custody 对账、operator steer、旧 stage 词汇、event kinds、capsule 写入主体 | 三猫 | 已写入 §4.4 W1 矩阵补充项；旧词汇/event/capsule 随 W1 收敛 |

> 结论：D6 方向不变；P1 全部是契约级修正，已落盘。W1 入场门禁继续以 `architecture/0001 §4.4` 继承矩阵为准。

## 13. 2026-10-24 Role 动态 registry（提案）

**背景**：`Role` 写成 TS 闭集不好；clowder 可以动态创建 family 的猫，codeteam 也应允许在 architect/coder/reviewer/verifier 之外定义 writer 等 role。

**提案（待 operator 确认）**：

- `type Role = string`；内置 architect/coder/reviewer/verifier 为代码常量；自定义 role（writer、researcher 等）存 `roles` registry，前端 M1 创建。
- `AgentProfile.role` 是 primary role；`AgentSession.role` / `Run.role` / `Handoff.fromRole,toRole` 使用 role id；未知/禁用 role fail closed。
- `human` 不是 Role，是 `actorKind`；approval decide 由 operator credential；routine merge 由 merge-owner capability（`DP-MERGE-1=D`）。
- review 独立性看 profile + session + modelFamily，不看 role；同一 profile 换 role/session 仍不算独立 review。
- 新增 writer 等 role 只加 registry 数据，不改核心代码；SOP 只引用 role id / actionPair。

**落点**：`0001 §2.3/§4.2/§8.1–8.2/§12.2`；W1 增加 `roles` 表；W7 M1 创建/编辑 role；F001 D27。

> 状态：提案，待 operator 确认。

## 14. 2026-10-24 Dispatch queue / A2A 执行链 / Task 系统 / F139 schedule 复用

**问题**：codeteam 是否复用 clowder 的统一调度队列、Task 系统和统一 schedule？

**结论：复用，但要分两层。**

- **ADR-043 / F117 Phase D = dispatch queue（F122 历史）**：唯一 pending-wake 账本；一条 source 一条 Queue Entry，`targets[]` 多目标不拆行；`dispatchRefs`/response bubble/Active Run/steer/one terminal 复用。
- **A2A 执行链**：`A2A ingress → Queue Entry → QueueProcessor → AgentRouter → routeSerial/routeParallel → invokeSingleCat → AgentMessage/response/terminal`；codeteam 复用 1–6/8–10 段，唯一替换 `invokeSingleCat → invokeSingleAgent → pi kernel`。queue 多 recipient 恒 parallel，`ideate` 只作直调兜底。
- **Task 系统 = clowder `TaskItem` 底座**：kind/subjectKey/title/why/owner/status/relatedFeatureId/dispatchGate/probe/entrustedWork/deploymentWait 复用；codeteam 只加 backlogItemId/repo/base/worktree/branch/risk/lane/budget；`goal`→`why`，`featureId`→`relatedFeatureId`。
- **F139 = proactive schedule**：`TaskSpec_P1`（Trigger/Admission/Run/State/Outcome）+ `RunLedger` + cron/interval/event；触发后生成 Queue Entry，不直接起 run。
- **codeteam-specific = task readiness/admission**：priority、dependency DAG、budget/quota、worktree pool、worker capacity；只决定哪条 task 可 enqueue/claim，不另建执行队列或 comparator。
- `handoff(pending)` / `inbox(pending)` 是 Queue Entry 的 source/admission，不是第二队列。
- F122 当前以 ADR-043 + F117 Phase D 的 single-ledger 为准；F122 文档旧 per-target 拆行 / steer 预留是历史。

**落点**：`0001 §4.4.1/§12.6`；`plans/0004 W5`；`F001 D28/D30`。

> 状态：已由 `architecture/reuse-review/dispatch.md` A1-3 v2 复审；W5 按此实现。

---

[宪宪/deepseek-flash🐾]
