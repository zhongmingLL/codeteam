---
title: "codeteam skill 内容迁移计划"
doc_kind: plan
status: approved
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
source_snapshot: "cat-cafe-skills/ @ 2026-10-25 working tree; 61 个 SKILL.md"
discussion_request: "3ab79e77-62c2-43d1-92ea-31c466a6efc2"
operator_signoff: "DP-SKILL-1=A, DP-SKILL-2=A, DP-SKILL-3=A (2026-10-25)"
status_note: "DP-MERGE-1=D（2026-10-25）：merge-gate 按 merge owner 执行重写；A 仅零-secret 临时偏差；详细漂移见 merge-authority-drift-audit.md"
---

# codeteam skill 内容迁移计划

> **缺口确认**：此前只在 W4 写了“复制 `cat-cafe-skills/{merge-gate,worktree,feat-lifecycle,quality-gate,request-review}` 的 SKILL.md 与 gate 语义”，plugin 卡只定义了 skill 加载面。**没有系统讨论 skill 内容本身怎么迁移**。本文件补上这部分：逐 skill 的适用性矩阵、适配规则、验证门禁和迁移波次。

## 1. 结论

- clowder 的 SOP 确实由 `cat-cafe-skills/` 承载；但 61 个 skill 里只有一小部分是跨项目通用的方法（TDD、debugging、writing-plans、source-audit 等）。
- 大量 skill 绑定 Clowder 的工具、路径、角色、Hub/Console、GitHub MCP/App、Redis 6398、F167/F192/SOP 等；直接复制会让 codeteam agent “照 skill 做，但工具/路径不存在”。
- **迁移不是 copy，是逐 skill 的适用性判定 + 内容适配 + 验证。** 没有矩阵行的 skill 不允许进入 `codeteam/skills/manifest.yaml`。
- 讨论后分类：**8 reuse / 20 adapt / 1 rewrite / 18 defer / 14 drop**（三猫讨论的改判已回写）。

## 1.1 讨论焦点（operator 2026-10-25）

> `cat-cafe-skills` 是 clowder-ai SOP 开发的灵魂，不是普通文档。三猫讨论要审视“SOP 灵魂是否被保住”，不是只对文件做分类。

> 三猫讨论 request `3ab79e77-62c2-43d1-92ea-31c466a6efc2`（2026-10-25，进行中）；findings 回写后本矩阵再冻结。

> **讨论结论**：方向 accept-with-modify。矩阵缺两根轴，已补：① A/W 行必须有 `must-survive` 不变量清单，门禁做正向检查；② skill 间 `next/triggers/not_for` 路由必须对账，不得指向 X 或未落地 D。否则“灵魂条款”会以假命令/假路由两种形式蒸发。

> **merge-gate 定案**：operator 2026-10-25 拍 **`DP-MERGE-1=D`**：routine own-PR merge 由 gate 后的 merge owner 执行，operator 守硬门；C 类自动合并不做；A 仅零-secret 临时偏差。`merge-gate` 内容迁移按 D 重写；全量漂移见 `merge-authority-drift-audit.md`。

**不可丢的 SOP 原则**

- 风险分流，不是固定串行链；门禁按风险选择证据。
- 独立 review / fresh context / 非作者；exact HEAD 与 review provenance。
- routine merge 由 gate 后的 merge owner 执行；operator 守硬门（第三方/不可逆/close/圣域/runtime/凭证/外部发布）；不自动合并、不自动批准。
- 证据优先：验证命令、falsifier、真实产物，不以文字声明代替。
- 设计与范围先对齐（Design Gate / 真页面 / 用户旅程），再实现。
- worktree 隔离、收尾与具名续留；不污染主仓。
- skill 不能授予权限、不能伪造工具/命令；Skill 内容必须能在 codeteam 真实执行。
- 多 Agent 球权语言：接/退/升三选一；球权唯一凭据是 @ 或 hold 动作；状态描述不是球权声明。这是 W5 多 Agent skill 重写的不可丢锚点。

**必须进 S0/S1 的“灵魂” skill**

- `merge-gate`、`quality-gate`、`request-review`、`receive-review`、`fresh-context-review`；
- `feat-lifecycle`、`worktree`、`tdd`、`debugging`、`writing-plans`；
- `source-audit`、`self-evolution`、`code-as-harness`、`plain-language`、`tech-writing`、`writing-skills`。
- A/W 行的 `must-survive` 清单必须进 §6 正向检查；路由出边必须进 §6 路由对账。

**重点要挑战的矩阵行**

- `merge-gate` 判 W 是否过重/过轻；哪些证据/HEAD/provenance 条款必须原样保留？
- `feat-lifecycle`、`worktree`、`request-review`、`receive-review` 判 A 是否低估了 Clowder 特有路由/权限假设？
- `expert-panel`/`thread-orchestration`/`cross-cat-handoff` 判 D 是否把多 Agent SOP 灵魂推得太远？
- `co-creation-docs` A、`opensource-ops` A/W8、`self-evolution` A 的边界是否成立？
- 15 个 drop 里有没有其实承载 SOP 责任的（尤其 `capability-evolution`/`owner-friendly-plugin-development`/`learning-companion`）？

## 2. 目标与非目标

**目标**

1. 给每个 clowder skill 一个明确 decision：reuse / adapt / rewrite / defer / drop。
2. 给 adapt/rewrite 的 skill 写清 Clowder 依赖与 codeteam 替代物。
3. 定义静态检查 + 非作者内容 review + 真实 dry-run 的迁移门禁。
4. 按 W0/W4/W5/W6/W7/W8 分波迁移，避免一次性搬 61 个 skill。

**非目标**

- 不在本阶段重写所有 skill；只建立矩阵与首批 W0/W4 迁移。
- 不迁移 Clowder 的 Hub/Console/IM/媒体/Collective 产品面；它们不是 codeteam code agent 的 v1 能力。
- 不自动同步 clowder 后续 skill 变更；codeteam fork 后按显式 upstream review 更新。
- 不新建第二套 skill registry；仍走 `codeteam/skills/manifest.yaml` + role allowlist + pi loader。

## 3. 决策口径

| 代码 | 含义 | 处理 |
|---|---|---|
| **R** | Reuse | 内容基本通用；只做路径/命令/角色名的机械替换，静态检查通过即可 |
| **A** | Adapt | 方法成立，但工具/路径/角色/SOP/GitHub/UI 需要 codeteam 替代物；必须逐段改并 review |
| **W** | Rewrite | 核心假设不同（如 merge 权限、自动合并、cloud review 循环）；保留方法论，重写流程 |
| **D** | Defer | 目标 W 明确，但不在 v1；先在矩阵留位，进入该 W 时再迁移 |
| **X** | Drop | Clowder 产品面/生活面/媒体面，codeteam 不需要；永不进入 catalog |
| **N** | New | codeteam 新写的 skill，无 Clowder 迁移源；仍需矩阵行、静态检查、非作者 review 与 dry-run |

## 4. 初始迁移矩阵（61 skills）

> 行内 `target` 是计划迁移的 W；`owner` 是该 skill 内容适配的第一责任人。`R` 也需要静态检查，因为仍可能引用 `cat-cafe-skills/` 或 `docs/SOP.md`。所有 decision 是初始判定，逐 skill review 可改，但改判必须写理由。

| # | Skill | Family | Decision | Target | Clowder 依赖 / 风险 | codeteam 适配动作 | Owner |
|---|---|---|---|---|---|---|---|
| 1 | `anime-forge` | content | X | — | Remotion/Console/媒体交付 | 不做动画工作室；codeteam 不迁移 | — |
| 2 | `bootcamp-guide` | life | X | — | Clowder onboarding/thread 状态 | 不做新用户训练营 | — |
| 3 | `browser-automation` | ui | D | W7/W8 | 外部浏览器后端/登录态 | 等 W7/W8 验证/外部操作需要时再接 | 烁烁 |
| 4 | `browser-preview` | ui | D | W7 | Hub browser panel/localhost | codeteam W7 有自己的 preview 面再迁 | 墨墨 |
| 5 | `capability-evolution` | product | X | — | F311/Program/Approval | Clowder 产品进化 lane；方法论（verdict-driven loop）由 `self-evolution` A 行与 0004 评审循环继承，不是无声消失 | — |
| 6 | `co-creation-docs` | docs | A | W4 | `pnpm classify:co-creation-docs`/docs lane | 保留“文档 PR 快车道”方法论；替换为 codeteam docs lane/命令；删除“已选头像原图归档”Clowder 生活面触发段 | 宪宪 |
| 7 | `co-creation-storytelling` | content | X | — | Clowder 共创叙事/Console | 不做内容叙事产品；“时间线≠因果线”的取证警惕由 `tech-writing` A 行继承 | — |
| 8 | `code-as-harness` | harness | A | W3/W4 | F192/cat-cafe harness 例子 | 保留“重复摩擦→代码守护”方法论；替换为 codeteam eval/harness 路径；v1 friction 不依赖 F278 inbox（见 harness-eval 卡 §3.8） | 宪宪 |
| 9 | `collaborative-thinking` | process | R | W3/W4 | 少量 Clowder 术语 | 机械替换角色/工具名；保留 brainstorm/收敛方法 | 宪宪 |
| 10 | `collective-participation` | community | X | — | Collective/F195/Channel | collective-runtime 是 N2 Drop；不迁移 | — |
| 11 | `concept-demo-design` | ui | D | W7 | Hub rich block/browser | W7 产品面需要时再迁 | 墨墨 |
| 12 | `console-dev` | ui | D | W7 | Console/设计 token/浏览器证据 | codeteam W7 Console 另定 | 墨墨 |
| 13 | `context-self-management` | runtime | A | W0/W5 | `cat_cafe_*` handoff/thread 工具 | 替换为 codeteam session/handoff/context 工具；保留三轴自检 | 烁烁 |
| 14 | `convention-graph-discovery` | code | A | W3 | `pnpm convention-graph:code-consumers` 在 codeteam 不存在；code-intelligence 是 P1-active | 保留人工 discovery 方法；删工具命令段或标 defer；不伪造 code graph CLI | 宪宪 |
| 15 | `cross-cat-handoff` | multi-agent | D | W5 | cat/thread/handoff/queue | W5 多 Agent 时按 AgentProfile/threads/waits 重写 | 烁烁 |
| 16 | `cross-thread-sync` | multi-agent | D | W5 | cat/thread/cross-post | W5 多 thread 时按 codeteam thread 工具适配 | 烁烁 |
| 17 | `custody-recognition` | custody | A | W1/W5 | Task/waits/handoff/F167 | 保留“先核责任再开工”；替换为 codeteam task/waits | 烁烁 |
| 18 | `debugging` | dev | A | W0/W4 | F212 cliDiagnostics/debugRef 取证链；codeteam 用 run_events/pi session 导出 | 保留根因/假设验证方法；重写证据获取段，换成 codeteam run_events/session drill-down | 烁烁 |
| 19 | `deep-research` | research | A | W3/W4 | WebSearch/cloud provider/Clowder 报告路径 | 保留多源调研管线；替换 provider/命令/证据目录 | 宪宪 |
| 20 | `enterprise-workflow` | im | X | — | 企微/飞书/IM | codeteam 不做 IM 工作流 | — |
| 21 | `eval-design` | eval | R | W3/W6 | 少量 clowder 示例 | 保留指标/校准方法；替换 eval 存储路径；指标口径唯一真源 = registry `metricGlossary`（见 harness-eval 卡 §3.8） | 宪宪 |
| 22 | `expert-panel` | multi-agent | D | W5 | 多猫/rich block/语音/文档 | W5 多 Agent 后按 codeteam panel 重写 | 墨墨 |
| 23 | `feat-lifecycle` | sop | A | W4 | Feature docs/BACKLOG/Design Gate/F 号 | 保留生命周期；具体映射：ROADMAP→0004+`features/`、BACKLOG→`backlog_items`、Design Gate→A2-2；“先看真页面”依赖 W7 browser-preview，v1 删段/标 W7；S0 dry-run 前交映射表 | 墨墨 |
| 24 | `fresh-context-review` | review | A | W4 | merge-gate/review provenance | 保留 fresh-context finding 方法；替换 merge-gate 术语/命令 | 砚砚 |
| 25 | `guide-authoring` | ui | D | W7 | Guide Engine/Console/YAML | W7 Guide Engine 另定 | 墨墨 |
| 26 | `guide-interaction` | ui | D | W7 | Guide MCP/Console 状态 | W7 再迁 | 墨墨 |
| 27 | `hyperfocus-brake` | life | X | — | Clowder hook/health | 不做生活健康提醒 | — |
| 28 | `image-generation` | content | X | — | 图像生成/Hub 交付 | codeteam 核心不做内容生成 | — |
| 29 | `incident-response` | ops | A | W3/W4 | Clowder 规则/角色/incident 流程 | 保留止损/复盘方法；替换为 codeteam 责任链/审计 | 砚砚 |
| 30 | `knowledge-engineering` | docs | R | W3 | 少量 clowder 文档样例 | 保留知识工程方法；替换目录/命令 | 墨墨 |
| 31 | `learning-companion` | life | X | — | 共读/口播/学习记录 | 不做学习陪伴产品；“冷读说懂了≠人的理解”的消费者验证原则由 `plain-language` A 行保留 | — |
| 32 | `memory-navigation` | memory | D | W6 + message source connector | F188/F200/cat_cafe memory；A3-2 只冻结 file-evidence subset | 等 message-mode 检索源接入后再迁，不能只按 W6 编号；否则 dry-run 无工具 | 宪宪 |
| 33 | `memory-search-best-practices` | memory | D | W6 + message source connector | 同上 | 同上；先保留 file-evidence 子集用法 | 宪宪 |
| 34 | `merge-gate` | sop | W | W4 | `pnpm gate`/gh merge/cloud review/F 号 | 保留证据/风险/HEAD 方法论；must-survive `MS-MERGE-1..8` 必须逐条在场；执行模型 **DP-MERGE-1=D**：gate 后 merge owner 执行 + operator 硬门；C 类自动合并不做；A 仅零-secret 临时偏差 | 砚砚 |
| 35 | `open-source-teardown` | research | R | W3/W4 | 少量 clowder 示例 | 保留“从 README 追到代码”的方法；替换路径 | 宪宪 |
| 36 | `opensource-ops` | community | A | W8 | GitHub MCP/App/gh/PR/issue/community | W8 只保留 gh CLI + GitHub-only + 权限门禁；不迁移 MCP/App/IMAP | 砚砚 |
| 37 | `organize-threads` | ui | D | W7 | Hub labels/threads | W7 再迁 | 墨墨 |
| 38 | `owner-friendly-plugin-development` | plugin | D | P1 plugin-framework | Plugin Manager/Broker/Settings | v1 只做 skill surface；但源卡已把 full plugin framework 留 P1-defer，P1 开卡时需要这套开发方法论；X 与已签源卡冲突，改 D 留位 | — |
| 39 | `pencil-design` | ui | D | W7 | Pencil MCP/Console | W7 设计面另定 | 墨墨 |
| 40 | `plain-language` | writing | A | W4/W7 | refs/ 案例库是教学法本体；Not-for 指向 learning-companion(X)/guide-interaction(D)；口播/视频/原型依赖 W7+媒体 | 保留“讲人话”方法；适配 refs 案例；删除/改写 X/D 路由与 v1 不可用载体；must-survive `MS-PLAIN-1` | 墨墨 |
| 41 | `ppt-forge` | content | X | — | PPT/图片/Remotion | 不做内容制作 | — |
| 42 | `proactive-memory-judgment` | memory | X | — | F276/F282 person memory | codeteam memory 只做 file evidence；drop | — |
| 43 | `quality-gate` | sop | A | W4 | `pnpm gate`/Clowder check/Annex | 保留 spec 合规/愿景对照；替换 codeteam gate 命令/证据；must-survive `MS-QUAL-1`（无验证证据不得宣称完成） | 砚砚 |
| 44 | `receive-handoff-grounding` | custody | A | W4/W5 | handoff/GitHub/PR truth | 保留 claim→resolver→verdict；替换为 codeteam waits/custody | 砚砚 |
| 45 | `receive-review` | review | A | W4 | local/cloud review/merge-gate | 保留 Red→Green/收口；替换 reviewer routing/命令；must-survive `MS-REVIEW-1..5` | 砚砚 |
| 46 | `request-review` | review | A | W4 | cat reviewer/mailbox/PR packet | 保留风险匹配 review；替换为 codeteam AgentProfile/model family；must-survive `MS-REVIEW-1..5` | 砚砚 |
| 47 | `rich-messaging` | ui | D | W7 | Hub rich blocks/audio/gallery | W7 再迁 | 墨墨 |
| 48 | `schedule-tasks` | schedule | D | W5/W7 | `cat_cafe_*` schedule/Console | W5 F139 schedule adapter + W7 UI 后再迁 | 烁烁 |
| 49 | `self-evolution` | process | A | W3/W6 | F167/F192/Clowder evidence | 保留复盘/蒸馏；替换为 codeteam eval/lessons 路径；吸收 `capability-evolution` 的 verdict-driven-loop 段；lessons 走 file 源，不写 eval 账本（见 harness-eval 卡 §3.8）；must-survive `MS-SELF-1` | 宪宪 |
| 50 | `source-audit` | research | R | W3/W4 | 少量 clowder 示例 | 保留 claim ledger/三轴 verdict；替换文档路径 | 宪宪 |
| 51 | `sprite-forge` | content | X | — | atlas/desktop pet | 不做桌宠/角色动画 | — |
| 52 | `tdd` | dev | R | W0/W4 | 少量 clowder 命令 | 保留 Red-Green-Refactor；替换测试命令；§6#5 dry-run 必须真跑一次 RED→GREEN，不许只静态检查 | 烁烁 |
| 53 | `tech-writing` | writing | A | W4/W7 | `docs/lessons/12-no-boss-agent.md`/`01-sdk-to-cli.md` 是范本即技能；例子来自 clowder 事故现场 | 保留叙事/证据方法；换成 codeteam 自己的证据叙事范本，或 fork 时保留两篇作外部引用；must-survive `MS-TECH-1` | 墨墨 |
| 54 | `thread-orchestration` | multi-agent | D | W5 | cat/thread/queue/sub-thread | W5 按 codeteam thread/AgentProfile 重写 | 宪宪 |
| 55 | `ttfund-skills` | finance | X | — | 天天基金网关/API key | codeteam code agent 不需要 | — |
| 56 | `video-forge` | content | X | — | Remotion/Console | 不做视频工作室 | — |
| 57 | `vision-rescue` | process | R | W3/W4 | 少量 clowder 例子 | 保留五步突破框架；替换路径 | 宪宪 |
| 58 | `workspace-navigator` | ui | D | W7 | Hub workspace/file open | W7 再迁 | 墨墨 |
| 59 | `worktree` | dev | A | W0/W5 | Redis 6398/`pnpm worktree:new`/Clowder 目录；W2 coder git policy 只放行 add/commit/status/diff | 保留隔离/收尾/具名续留方法；worktree 创建/销毁归 daemon/operator CLI，skill 只教 worktree 内工作纪律（不外泄、收尾清单），不教 agent 管 worktree；must-survive `MS-WT-1` | 烁烁 |
| 60 | `writing-plans` | process | R | W4 | 少量 clowder 命令 | 保留计划/验收/工作单元；替换检查命令 | 宪宪 |
| 61 | `writing-skills` | harness | A | W0/W4 | `pnpm check:skills`/cat-cafe manifest/symlink | 保留价值门禁/软硬同重；替换为 codeteam catalog/静态检查/单文件规则；“写/改 MCP tool description”半段在 v1 无 MCP 编写面，删段或 defer；must-survive `MS-SKILL-1` | 宪宪 |

### 4.1 Must-survive registry（A/W 行的正向检查清单）

> 矩阵主体不重复长条款；A/W 行在“codeteam 适配动作”列引用 ID。§6 非作者 review 必须逐条确认在场，不能只验“没有 Clowder 残留”。

| ID | Skill | 不可丢弃的条款 |
|---|---|---|
| `MS-MERGE-1` | merge-gate | exact HEAD + review provenance：review 覆盖精确 HEAD；HEAD 变化只触发 provenance 判定，不自动 re-review |
| `MS-MERGE-2` | merge-gate | continuityProof C1/C2/C3：作者 delta / base 相关性 / targeted gates；机械派生物可桥接，语义 delta 回 active source |
| `MS-MERGE-3` | merge-gate | Report 载体铁则：verdict 后、merge 前不得向被审分支 commit review report（SHA 自噬环） |
| `MS-MERGE-4` | merge-gate | 封板协议：无状态信号源的“0 findings”没有不动点；5 轮/假阳性>50% 硬上限，终局交本地有状态 reviewer |
| `MS-MERGE-5` | merge-gate | 循环驱动指令改写：拉闸第一动作是改写持久化指令里的“0 P1/P2→merge”，否则会复活循环 |
| `MS-MERGE-6` | merge-gate | E1–E5 evidence validation 硬条件：任一适用项不满足即 BLOCKED |
| `MS-MERGE-7` | merge-gate | “动作类型不是选择或叠加理由”：风险分流，不是开了 PR 就三连 |
| `MS-MERGE-8` | merge-gate | operator 硬门七类清单（第三方 PR、不可逆 Git、close feat、圣域/生产数据、runtime 生命周期、凭证/secret、外部发布）+ 升级到 operator 的 Decision Packet 形态（价值取舍题，不给技术 A/B 题）必须逐字进 merge-owner runbook |
| `MS-REVIEW-1` | request-review / receive-review | 动作类型不是触发器；review 由风险/来源选择，不由“开了 PR”自动触发 |
| `MS-REVIEW-2` | request-review / receive-review | feedback 归属：findings 回提出它的 source；local/cloud 不串线 |
| `MS-REVIEW-3` | request-review / receive-review | Report 载体纪律：review report 不进被审分支 |
| `MS-REVIEW-4` | request-review / receive-review | clean-stop：verdict 是最后必达投递，不为出口 ACK 复入 |
| `MS-REVIEW-5` | request-review / receive-review | 共享 login 不得 self-approve；非作者 + receipt/merge 分离 |
| `MS-LIFE-1` | feat-lifecycle | 生命周期分段与真相对照：诉求→设计→实现→验收→真相同步；Feature vs TD 以 operator 可感知切 |
| `MS-WT-1` | worktree | worktree 隔离/不污染主仓/具名续留；创建/销毁归 daemon/operator CLI，skill 只教工作纪律 |
| `MS-QUAL-1` | quality-gate | 宣称完成必须有与影响面匹配的验证证据；spec 合规 + 愿景对照；空测试集合无资格支撑 verdict |
| `MS-PLAIN-1` | plain-language | 讲给没跟进过程的人；证据锚点；消费者验证（冷读说懂了≠人的理解） |
| `MS-TECH-1` | tech-writing | claim/证据边界；时间线≠因果线；范本即技能，不能只换路径 |
| `MS-SKILL-1` | writing-skills | 价值门禁：软硬同重；不写模型已知的通用教程；skill 不能膨胀回 61 |
| `MS-SELF-1` | self-evolution | 复盘/蒸馏 + verdict-driven loop（吸收 capability-evolution 的方法论） |
| `MS-OPEN-1` | opensource-ops | gh CLI + GitHub-only + permission gate + human/operator 终门；无 GitHub MCP/App/IMAP |


### 4.1 W0a repo-local authored skills（2026-10-27）

Phase 2 的 catalog 首版不是 `cat-cafe-skills/manifest.yaml` 的 fork/瘦身，而是两个新写的
repo-local skill。为满足“没有矩阵行不允许加载”，在此补行；完整内容迁移仍按 §7 波次在 W4 执行。

| # | Skill | Family | Decision | Target | Clowder 依赖 / 风险 | codeteam 适配动作 | Owner |
|---|---|---|---|---|---|---|---|
| N1 | `codeteam-verify` | delivery | N | W0a | 无迁移源；仅使用 codeteam 真实命令 | 新写；静态检查=path containment + secret scan；非作者 review=烁烁 Phase 2；dry-run=adapter/skills 测试 | 宪宪 |
| N2 | `codeteam-review` | review | N | W0a | 无迁移源；不含 Clowder 路由/权限假设 | 新写；同上；finding 需带 severity+stance | 宪宪 |

## 5. 内容适配规则

### 5.1 工具与路径

| Clowder 形态 | codeteam 替代 | 说明 |
|---|---|---|
| `cat_cafe_*` MCP tools | codeteam 对应 tool（`a2a_send`/`handoff_*`/`wait_*`/`thread_*`） | 无对应工具时 skill 必须删段或标 defer，不能留假命令 |
| `cat-cafe-skills/` | `codeteam/skills/` | 路径统一；skill 内引用改为相对路径 |
| `docs/SOP.md` | codeteam SOP/0004 计划 | 不引用不存在的文件 |
| `pnpm gate`/`pnpm check` | codeteam 对应 gate/check | 未落地前 skill 标 `defer`，不能写假命令 |
| `Redis 6398`/`pnpm worktree:new` | codeteam worktree pool/命令 | W0/W5 适配 |
| GitHub MCP/App/IMAP | `gh` CLI + W8 webhook/API | 只读 evidence；无 App/MCP |
| Hub/Console/Workspace | W7 对应面 | W0/W4 skill 不得依赖 |
| 猫名/三猫 | AgentProfile role | 角色可替换；不绑定具体 catId |
| F 号/ADR 号 | codeteam feature/ADR 或删除 | 保留 provenance 时写清来源；不悬空 |

### 5.2 治理语义

- **merge 权限**：目标契约是 D——gate 后由 daemon `service:merge-owner` 执行；operator 只守硬门。skill 必须教“merge-owner runbook + operator 硬门 + evidence checklist”，不得教无人 gate 的自动合并；A 的 operator 执行只作零-secret 临时偏差并显式标注。W0–W4 dogfood 用 local `MergeExecutor`，W8 用 GitHub adapter；skill 不绑定 adapter。merge-gate 重写必须自含审计 §1 的六条解释边界 + `MS-MERGE-8`，不依赖审计文档长期存在。
- **cloud review**：codeteam v1 没有 cloud review 无限循环；`merge-gate` 必须重写，不照搬 cloud 抽样终局逻辑。
- **A2A/球权**：codeteam 用 Queue/handoff/waits；skill 里的 `hold_ball`/`cat_cafe_post_message` 必须映射或删除。
- **审批**：`approvals` 是唯一 human gate；skill 不得教 agent 自批或伪造审批。
- **skill 权限**：skill 不能改 tool policy/permission；`writing-skills` 的权限边界要按 codeteam 重写。

### 5.3 格式

- 单文件 `SKILL.md`；多文件 references 在 fork 时合并，或标 `defer`。
- frontmatter 是 name/description/triggers 唯一权威；manifest 不复制这些字段。
- `tips_exempt` drop。
- `manifest.yaml` 只留 skillId/path/sourceKind/category/not_for/output/next/sop_step。

## 6. 迁移门禁

一个 skill 只有同时满足以下条件，才允许进入 `codeteam/skills/manifest.yaml`：

1. **矩阵行**：本文件有 decision/target/owner/adaptation；A/W 行必须引用至少一个 `must-survive` ID（§4.1）。
2. **源快照**：记录来源 `cat-cafe-skills/<skill>/SKILL.md` 的 sha256 与迁移日期。
3. **静态检查**：无未映射的 `cat_cafe_*` / `cat-cafe` / `CAT_CAFE_` / `docs/SOP.md` / `pnpm gate` / Hub/Console（W0/W4）/ `tips_exempt`；frontmatter name == 目录名；单文件；manifest 无重复 description/triggers；`check-codeteam-skills.mjs` 覆盖这些规则。
4. **非作者 review（正向）**：至少一只非作者审内容，确认“在 codeteam 没有不可用工具/假命令”，并逐条确认 §4.1 的 `must-survive` ID 在场；不能只验“Clowder 残留清零”。
5. **dry-run 证据**：在 W0/W4 的一个真实 task 里按 skill 执行一次；记录 agent 是否卡在缺失工具/路径；失败则回矩阵改 decision 或补替代物。`tdd` 必须真跑一次 RED→GREEN 循环，不能只静态检查。
6. **路由对账**：每个 skill 的 `next`/`triggers`/`not_for`/Use-when 出边必须对照矩阵 decision；不得指向 X 或未落地 D。`check-codeteam-skills.mjs` 把 inter-skill 引用图纳入校验；指向 X 的边必须删/改写，指向 D 的边必须标目标 W。

> `check-codeteam-skills.mjs` 是 S0 交付物之一；在它落地前，人工按本清单核。没有通过六门的 skill，不允许进入 catalog。

## 7. 迁移波次

| 波次 | 时点 | 技能 | 门禁 |
|---|---|---|---|
| **S0** | W0 前 | 矩阵 + 静态检查 + `tdd`/`debugging`/`writing-plans`/`worktree`/`quality-gate`/`context-self-management` | 6 个 skill 全部 R/A 完成并 dry-run |
| **S1** | W0/W4 | 其余 W0/W4：`merge-gate`（W）、`request-review`/`receive-review`/`fresh-context-review`/`feat-lifecycle`/`code-as-harness`/`source-audit`/`self-evolution`/`incident-response`/`vision-rescue`/`collaborative-thinking`/`plain-language`/`tech-writing`/`writing-skills`/`co-creation-docs`/`receive-handoff-grounding`/`custody-recognition` | 每个 skill 过 §6 六门（含 must-survive 与路由对账） |
| **S2** | W5 | `cross-cat-handoff`/`cross-thread-sync`/`thread-orchestration`/`expert-panel`/`schedule-tasks` | 多 Agent/thread/waits 落地后 |
| **S3** | W6 + message source connector | `memory-navigation`/`memory-search-best-practices`/`eval-design` | file-evidence subset + message-mode 检索源落地后；不能只按 W6 编号 |
| **S4** | W7 | `browser-preview`/`workspace-navigator`/`rich-messaging`/`guide-*`/`console-dev`/`pencil-design`/`concept-demo-design`/`organize-threads`/`browser-automation` | Console/Guide/Hub 面落地后 |
| **S5** | W8 | `opensource-ops` | GitHub-only W8 + gh CLI 权限门禁落地后 |
| **Drop** | — | 媒体/IM/生活/Collective/插件市场/内容制作 15 项 | 永不进入 catalog |

## 8. 分工

| 角色 | 负责 |
|---|---|
| 宪宪 | 迁移矩阵、跨 skill 一致性、S0/S1 编排、writing-skills/feat-lifecycle 适配 |
| 烁烁 | W0/W5 运行时工具/路径、worktree/tdd/debugging/context/schedule |
| 砚砚 | merge-gate/quality-gate/review/incident/opensource-ops/security 相关 skill |
| 墨墨 | operator UX/SOP/plain-language/tech-writing/guide/UI 相关 skill |
| operator | 矩阵与波次签字；S0/S1 门禁验收 |

## 9. 待拍板

| DP | 选项 | 推荐 | 不拍的后果 |
|---|---|---|---|
| DP-SKILL-1 迁移策略 | A=逐 skill 矩阵 + fork/adapt；B=从空白只写当前需要的 skill；C=全量 copy 后逐步修 | **A** | B 丢 proven 方法；C 把 Clowder 债/假命令带进 codeteam |
| DP-SKILL-2 v1 范围 | A=只迁 W0/W4 核心 dev/SOP；B=61 个全迁；C=只迁通用方法（drop 所有 Clowder 特定 skill） | **A** | B 范围爆炸；C 丢掉 merge/feat/review 等 SOP 核心 |
| DP-SKILL-3 upstream 同步 | A=一次性 curated fork + 显式 upstream review；B=持续自动同步 clowder skill | **A** | B 会把 Clowder 后续变更/工具假设重新灌回 codeteam |

## 9.1 三猫讨论回写

- **烁烁**：R 缺“在 codeteam 真实可执行”维度。`debugging` R→A（取证链换成 run_events/pi session）、`convention-graph-discovery` R→A（不存在 code graph CLI）、`worktree` 补 W2 条款（agent 无权创建/销毁 worktree）、`tdd` dry-run 必须真跑 RED→GREEN。
- **砚砚**：门禁只有负向“Clowder 残留清零”，缺正向“SOP 灵魂在场”。新增 `must-survive` registry（merge-gate 八条、review 五条等），非作者 review 逐条验；`merge-gate` 重写产物 = merge-owner runbook + operator hard gates + agent evidence checklist（DP-MERGE-1=D）。
- **墨墨**：缺 skill 间路由/证据依赖轴。新增路由对账门禁；`plain-language`/`tech-writing` R→A（refs/范本即技能、悬空路由）、`owner-friendly-plugin-development` X→D（P1 plugin-framework）、memory 双行 target 钉 message source connector、`feat-lifecycle`/`co-creation-docs`/`writing-skills` 的删段/映射具体化。
- 三个 DP：烁烁/砚砚/墨墨均 **A/A/A**。

## 10. 下一步

1. operator 拍 `DP-SKILL-1/2/3`。
2. 三猫讨论已完成；operator 拍后冻结矩阵与 must-survive registry。
3. S0 先迁 6 个核心 skill；每个 skill 填 sha256、adaptation diff、review/dry-run 证据。
4. 静态检查落地后，才允许 W0/W4 skill 进入 catalog。

[宪宪/deepseek-flash🐾]
