---
title: "开发 SOP（通用基线）"
doc_kind: sop
status: active
created: 2026-10-26
updated: 2026-10-26
source: "精简自 Clowder AI docs/SOP.md"
---

# 开发 SOP（通用基线）

> **适用范围。** 这是面向 Clowder AI agent 的通用、与项目无关的开发 SOP。
> 规划或改代码前先完整读一遍。
>
> **项目覆盖层。** 项目自己的命令、分支、环境和约束放在 `AGENTS.md` 与
> `docs/plans/`。如果项目规则和本基线在“项目事实”上冲突，以项目规则为准；
> 但安全、身份、review 和不可逆操作边界不允许因此放宽。
>
> **可选 skills。** 挂载了 Clowder skill 时，按触发加载对应 skill 看细节：
> `feat-lifecycle`、`writing-plans`、`worktree`、`tdd`、`debugging`、
> `quality-gate`、`fresh-context-review`、`request-review`、`receive-review`、
> `merge-gate`、`co-creation-docs`、`opensource-ops`。
>
> **维护。** 这是精简快照，不是 Clowder 原版 SOP。源文件有实质变化时重新
> 精简，不要让它静默漂移。

## 0. 30 秒决策卡

| 情况 | 默认动作 |
|---|---|
| 小、可逆、不碰共享底座 | 作者实现，跑受影响检查，合入。 |
| 普通 feature | 隔离 worktree，按风险选测试，自检，合入。 |
| 数据 / 安全 / 契约 / 不可逆 | 专门验证，并加一个对应风险面的独立 reviewer。 |
| 用户可见 feature close | close 前做独立愿景守护。 |
| 命令、依赖或环境不确定 | 先查仓库；仍不确定就写 `unknown`，不要猜。 |

## 1. 从结果出发

- feature 只有在约定的用户可见结果达成时才算完成。
- 不要因为代码写完、测试通过或 PR 存在就宣布完成。
- 方向、范围或体验不清楚时，先澄清结果再动手；不要用一个方便的局部任务
  替换不清楚的结果。
- 实现已经不再服务于原结果时，暂停并重新校准，不要硬把局部做完。

### 1.1 愿景驱动与阶段校准

- 和 operator / owner 确认 feature 愿景后：**没达成愿景 = 没完成**。不交
  半成品，不半路问“要不要继续”。
- 可以暂停的正当理由只有两类：
  - 解决不了的阻塞（技术限制、外部依赖）→ 升级 operator / owner；
  - 方向存疑（坐标系警报、scope 该砍）→ 暂停重估。
  判断力允许暂停，惰性不允许。
- 阶段成果、用户实际得到的变化、剩余差距和下一步要可见；按实际 truth delta
  同步，不用“计划完成度”代替真实变化。
- 已确认方向内自主推进；发现愿景、范围或体验解释分叉时及时校准，不等整项
  实现完才展示，也不在每次 Phase merge 后重复索要确认。
- 具体做法按 `feat-lifecycle` 的 Design Gate /「Phase 进度与方向校准」：先
  完成执行者能自决的准备，再拿具体稿、推荐和明确待判断点请 operator / owner
  共创；已确认且在仍覆盖范围内的决定直接复用。
- 小 feature（1–2 Phase）：不需要碰头，直接做到底 → 独立愿景守护 → close；
  大 feature 用明确 Phase 和 close gate。
- 需要 operator / owner 拍板的愿景、权限与不可逆边界照常遵守。

## 2. 五轴风险路由

只选真实风险支持的车道。文件数、diff 大小或“我写了代码”都不是风险轴。

| 风险轴 | 命中信号 | 最低动作 |
|---|---|---|
| 行为面 | 用户可见行为、runtime 逻辑、bug 回归 | 可观察 RED + targeted 验证；方向未定时才进 Design Gate。 |
| 数据面 | 线上用户数据、迁移、持久化语义 | 持久化或迁移验证 + 独立高风险 review；线上数据操作另走授权。 |
| 安全面 | auth、权限、secret、注入、DoS / 资源边界 | 安全边界测试 + context-blind 安全扫描；需要家里语义时再叠本地 review。 |
| 契约面 | API / MCP schema、事件格式、外部依赖 | 契约及受影响 consumer 测试 + 对应独立 review。 |
| 不可逆 | 删除、force push、合第三方 PR、close feature、受保护状态 | 先拿明确授权；机器门禁照常。 |

**元风险。** 改动碰到 merge gate、风险 classifier、门禁脚本、约束门禁自身的
SOP / skill，或其它自保护 harness 边界时，进入 high-assurance：必须由非作者
reviewer 覆盖最终实质内容。改门者不能自己放宽审判自己的门。

## 3. 按需车道

stage 名是告示牌车道，不是必须按顺序经过的状态机。

| 车道 | 适用场景 | 常用 skill |
|---|---|---|
| 立项 / Design Gate | 新 feature、UX / 架构方向未定、价值取舍 | `feat-lifecycle` |
| 计划 | 跨组件、状态对象、依赖或实现顺序不清 | `writing-plans` |
| 隔离 | 代码、skill、脚本或第一方执行面需要隔离 | `worktree` |
| 行为保护 | 新行为、bug，或现有精确检查未覆盖的逻辑 | `tdd` / `debugging` |
| 自检 | 所有交付；命令按风险选择 | `quality-gate` |
| Fresh-context 扫描 | 作者判断当前上下文盲点高 | `fresh-context-review` |
| 本地 review | 家里语境、治理 / skill / SOP、stateful diff | `request-review` |
| 云端 review | 安全、数据或契约风险需要 context-blind 扫描 | cloud review |
| 合入 | 变更准备进入受保护分支 | `merge-gate` |
| 愿景守护 | 用户可见或愿景变化的 feature close | `feat-lifecycle` |

## 4. 产品快车道

只在方向已确认、影响局部、一个 commit 可回滚时使用。

- 作者实现、打开真实入口、走关键用户交互、对照约定结果、附真实证据、
  跑受影响检查，然后合入。
- 默认不选独立 review，不跑 full gate。
- 共享底座、线上用户数据、持久化 / 迁移、受保护的运行态、auth / 权限 /
  secret、API / MCP / 事件契约、不可逆操作，仍然需要 review、验证和授权。
- hotfix 跨猫 review 和元风险规则继续有效。
- “开了 PR”“写了代码”“改了普通 package”不是加 review 或跑全套 gate 的理由。

## 5. Review

- 一旦选择 review，作者不能审自己。
- 默认只选一个合适的独立验证源：
  - 本地 peer：家里语境、治理 / skill / SOP 语义、stateful 实现判断；
  - 云端：需要 context-blind 的安全、数据或契约扫描；
  - 愿景守护：只在 feature close 触发。
- 只有两个风险面确实需要不同的人时才加第二只，并分别写明理由。
- 迭代只复审改动所在的风险面；routine fix 或 SHA-only 变化不重新拉稀缺
  reviewer。
- verdict 必须覆盖最终实质内容（exact SHA 或可机械证明的 continuity）；旧
  approval 不批准新的实质 HEAD。
- 每个 finding 必须有明确立场：P1/P2 blocking，P3 non-blocking，附理由。
  “修不修都行”不是 review。
- P1/P2 必须修复，并由提出 finding 的 active source 覆盖。局部修复获准
  不等于原结果已被接受。
- Review 要回读原始需求，不只看作者摘要；有可运行实物就看实物。
- verdict 之后不要再往被审分支加 review report / handoff 文档；用 PR
  comment 或 thread 消息。

## 6. Merge gate

合入前五条必须同时成立：

1. PR / 变更说明写清五轴风险，以及所选的验证和 review 来源。
2. 产品快车道有作者自检；否则至少有一个非作者独立 review verdict 覆盖本次
   变更。
3. 所有 P1/P2 已修复，并由 active source 覆盖。
4. Feature / backlog 真相不过度声称；变更集与实际改动文件、声明的结果一致。
5. 验证与影响面匹配。纯文档做文档检查；窄改跑受影响检查；targeted 覆盖不了
   风险时才跑项目 full gate。

另外：

- 不 force push，不改写受保护分支。
- 合入 main 不等于部署。碰到 live surface 时，分开声明 `main` 和 `live`；
  激活前拿明确授权。
- 用项目自己的 canonical merge 命令；项目要求非作者 review 就满足，不要绕。
- 合入后在隔离验收环境验证；不要拿线上用户数据做第一次测试。

## 7. Feature 生命周期

- **Kickoff：** 写清用户结果、验收标准（AC）和需求 checklist；方向未达成
  一致不开始实现。
- **Design Gate：** 新 feature、UX / 架构方向或价值取舍，先给具体方案并拿到
  决定，再实现。
- **Phase 进度：** 展示真实进度、用户可见变化、剩余差距和下一步；方向、
  范围或体验分叉时及时校准。
- **Close gate：** 每条 AC 都有证据和处置；用户可见或愿景变化的 feature
  需要独立愿景守护。
- 不要因为 PR merged 就 close；结果验证通过才 close。

## 8. 安全与数据

- 用隔离的开发 / 测试数据；不要把本地实验指向线上用户数据。
- 不删除持久化存储，不改 runtime 配置，除非明确授权。
- 不访问分配边界之外的服务或端口。
- 不可逆操作（删数据、force push、合第三方 PR、close feature、改线上数据
  边界）需要明确 operator 授权。
- 用自己的身份，不冒充其他 agent。
- 用户可见、可恢复的状态（thread / message / task / memory）默认持久化；
  TTL 需要明确 opt-in。

## 9. 约定面

改 MCP tool、skill manifest、route、workflow callback 等已索引约定面前：

- 先跑仓库的 convention graph / consumer census；`stale=true` 时先 reindex。
- 架构或契约 delta 记录：
  - canonical source：`path#symbol` 或 `doc#anchor`；
  - consumer evidence：可重跑命令 + 输出，或显式引用 + 为什么自动扫描无法
    表达该边界；
  - claim guard：claim -> test / lint / guard -> 什么条件下变红。
- 证据缺失就停在 Design Gate，不把第一次验证转嫁给 reviewer。

## 10. Hotfix 与 fallback

- Hotfix：必须由非作者 review，不允许 self-merge；两周后做升级 review，
  三选一：keep / tune / rollback。
- Fallback：同一文件新增 ≥3 层 fallback 时，触发坐标系自检；评估替代方案，
  并解释每层为什么不能去掉。
- 不要用临时脚手架掩盖缺失结果。明确授权的原型按原型交付，不冒充完整结果。

## 11. 证据与汇报

- 没有 fresh command run + output，不作完成声明。
- 记录 command、cwd、commit SHA、base、result 和 gap。
- UI 工作要打开真实入口，记录 URL、操作和结果；读代码不等于看效果。
- 区分 `implemented`、`verified locally`、`merged`、`live` 和 `accepted`。
- 没验证就说没验证；plan 或无关的 passing test 不是 proof。
- Handoff 包含：goal、scope、why、current state、evidence、risks / unknowns，
  以及下一棒 owner 和 action。

## 12. 可移植性

- 本 SOP 是通用的；不要在这里写项目特定路径、命令、端口或分支名。
- 项目事实放在 `AGENTS.md` 和 `docs/plans/`。
- 没挂载 Clowder skill 时，直接按本文件执行；缺的能力标 `unknown`。
- 项目规则和本基线冲突时，项目规则只覆盖项目事实；安全、身份、review 和
  不可逆操作边界不允许放宽。
