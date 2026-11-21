---
title: "F020 W7b thin Hub M0 — clowder Hub 调研与实施计划"
doc_kind: plan
status: draft-for-review
created: 2026-11-21
updated: 2026-11-21
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
feature: F020
related_plans: [0022-codeteam-web-surface.md, 0029-f016c-m1-execution.md]
source_decision: "DP-WEB-2=C (2026-11-21)"
---

# F020 W7b thin Hub M0

来源：operator 2026-11-21 决定 `DP-WEB-2=C` —— 参考 clowder Hub 的设计，
自建 thin first-party Hub；classic Hub 只保留为可选兼容客户端。F016c-M1 的
headless API 已交付，是唯一数据面。

目标：给 operator 一个本地单用户、A2A-first 的“看 + 聊”页面：能看 thread、
发消息、看 queue、看谁在忙、看 agent 状态。M0 不做 rich cards/approval/
workspace/events；先把核心动线做顺。

## 1. 调研：clowder Hub 做对了什么

### 1.1 设计语言

- **暖编辑感 + Linear 精密结构**：奶油画布、暖墨、衬线大标题（weight 400、
  负字距）、单一赭红强调；4px 节奏、32px 控件、发丝线而不是阴影、四级表面
  阶梯（canvas → surface-1 → surface-2 → surface-3）。引 clowder `DESIGN.md`。
- **外框安静，内容最亮**：sidebar/世界栏是最暗的一层；对话工作面次之；输入框、
  作品/文档纸面最亮。分区靠表面差 + 发丝线，不靠大段空白。
- **颜色只花在三种意思**：是谁（agent 身份色）、什么状态（8px 圆点 + 文字）、
  有多少（量条）。状态永远有文字，不靠颜色单独表达。
- **两种声音**：衬线只用于页面标题/空态/仪式；正文、列表、按钮用无衬线；
  ID/路径/SHA 用等宽。正文 14px，阅读栏 15px/1.7。
- **控件/圆角**：按钮/输入 32px、8px 圆角；消息气泡 12px，不是大圆角。

### 1.2 信息架构

- **外壳**：世界栏（52）→ sidebar（约 300）→ 阅读栏（720）→ 可选右栏
  （320–360）；顶栏 52。
- **sidebar**：品牌/新对话、搜索、thread 列表。thread row 的信息层级：
  标题 → 参与者头像/名字 → 最近活跃时间 → 状态（执行中/已回复/等你决定/出错）；
  @你、未读数、置顶/标签/分组是 clowder 的增强，M0 不做。
- **chat**：顶栏（thread 标题、项目、参与者、状态/操作）；阅读栏消息流；
  底部 composer；queue/live 在 composer 上方/顶栏内。
- **composer**：多行输入、@/收件人选择、发送/停止、queue 预览、草稿；
  M0 只保留“收件人 + 文本 + 发送”，附件/语音/whisper 不做。
- **空态**：衬线 22px 标语 + 一句说明 + 一个主动作；新对话页的输入框就是主动作。
- **注意力**：要你动手 > 新消息 > 进行中 > 安静；M0 只做“进行中/出错”两类状态。

### 1.3 交互细节值得借

- 消息：agent 用 32px 头像 + 名片牌（名字 13px/600）+ 正文，不画重气泡框；
  用户消息右对齐、整块浅底；时间戳 muted；processing 占位可见。
- queue：已确认但未投递的用户输入以“排队中”条显示，位置/目标可读；空队列隐藏。
- live：执行中那一行用淡蓝底 + agent 头像/名字 + “执行中 · N 分”，完成/出错
  换成绿/红 + 文字；不靠动画抢注意力。
- 窄屏：sidebar 抽屉；composer 固定底部；按钮/目标不放不下时整段省略 + 悬停全名。
- 键盘：焦点环 2px + 2px offset；Enter 发送、Shift+Enter 换行；Esc 关弹层。

### 1.4 为什么不能直接截取

- `packages/web/src/components`：约 **3,005 个文件 / 86k 行**；chat 相关
  （含 hooks/stores）约 100k 行。
- `AppShell`/`ChatContainer`/`ChatInput` 与 `chatStore`、`useSocket`、
  `api-client`、rich 渲染深度耦合；截组件会拖入整套状态/事件/鉴权。
- 实测把 classic Hub 接到我们的 daemon：shell 能起，但一加载打了 29 个
  M1 之外的 endpoint（`threads/default`、health/ready、concierge、game、
  draft、vote、read receipts…），核心聊天不可直接用。
- 结论：**借设计，不借状态面**。

### 1.5 借 / 不借

| 借 | 不借 |
|---|---|
| 外壳比例、sidebar/阅读栏布局、thread row 信息层级 | 世界栏、ActivityBar、多 shell（classic/v2） |
| 暖纸/发丝线/单一强调色/4px/32px 的 token 结构 | 猫 persona 色、猫头像、猫味装饰、品牌资产 |
| agent 名片牌、用户右对齐块、processing 占位 | rich cards、attachments、approval、memory、mission、signals |
| queue strip、live 执行行、空态/窄屏规则 | labels/pinning/grouping、未读/read receipts、search 全文 |
| 键盘/焦点/对比度/状态不靠颜色单独表达 | Socket.IO/event store、Clowder feature-ID 目录 |

## 2. 产品形态（M0）

### 2.1 布局

```text
┌──────────────┬──────────────────────────────────────────┐
│ sidebar 280  │ top bar 52: title · project · live pill  │
│ brand        ├──────────────────────────────────────────┤
│ + 新对话     │ reading column 720                       │
│ search       │   message list                           │
│ thread rows  │                                          │
│              ├──────────────────────────────────────────┤
│              │ queue strip (collapsed when empty)       │
│              │ composer: 发给 [agent ▾] + text + send   │
└──────────────┴──────────────────────────────────────────┘
```

- 无世界栏、无右栏；live/queue 先放在顶栏/输入框上方，避免 M0 过早做三栏。
- 窄屏 < 900px：sidebar 变抽屉；阅读栏 100%；composer 固定底部。
- 空态：sidebar 无 thread 时给“还没有对话”+ 新对话；chat 无消息时给 thread
  intro（标题/项目/参与者 + 一句提示）。

### 2.2 路由

- `/`：最近 thread 或新对话空态；无 thread 时显示新对话 hero。
- `/thread/:threadId`：chat。
- `/relogin`：401 重连页（显示 `superagentteam auth console-link` 命令）。
- `/agents`（M0.5）：agent 列表/状态；M0 先做 header 的 agent 弹层。
- 不做 settings/workspace/approval 路由。

### 2.3 数据与状态

- 只用 F016c-M1 API：`/api/session`、`/api/threads`、`/api/messages`、
  `/api/threads/:id/queue|live`、`/api/agents`、`/api/config`。
- M0 无 Socket.IO：用轮询。
  - threads：10s；messages：2s（thread 可见且页面可见）；queue/live：2s；
  - 页面 hidden 时暂停；单飞（禁止重叠请求）；错误指数退避到 30s。
  - **游标方向**：M1 `/api/messages` 只有 `before`（向旧）游标，没有 forward/
    incremental。轮询的正确策略是“拉最新窗口整体 replace”，不发明增量语义；
    `before` 只在“加载更早”时使用。`200 {messages:[], hasMore:false,
    query_warnings:["invalid_cursor"]}` 表示游标损坏，UI 必须清掉游标并重拉最新窗口，
    不能当成 thread 为空清空历史。
  - session 是 15min idle 滑动 + 8h absolute；轮询让 idle 不过期，但 8h 封顶仍会在
    活跃使用中途 401。401 必须保留当前草稿/滚动位置并进 `/relogin`；H4 专门走查。
- 发送：`idempotencyKey = crypto.randomUUID()` 每次发送意图生成；重试复用同一 key；
  新消息新 key。POST 202 后刷新 messages+queue，不做乐观消息；发送中显示本地
  “发送中” chip；失败保留草稿 + 重试按钮。
- 目标：M0 只允许 0/1 个 agent。0 = 自动路由（显示“自动”）；1 = 显式 target；
  >1 由 UI 阻止（API 会 422 `use_multi_mention`）。
- agent 状态：`/api/agents` 的全局汇总（idle/working/offline）；thread header 的
  live pill 用 `/live`，并注明“thread 内状态”。
- thread create：表单要求真实 `projectPath`（无 `default` 哨兵）；标题可选。
  M1 create 只校验非空；first-party Hub 与 daemon 同机，M0.5 可把本地路径存在性/
  绝对路径检查提前到 create，把运行期 `worker_start_failed` 换成 create 时的诚实错误。
- 401：进入 `/relogin`；不自动 `default-user`；不无限重试。
- 无 read state/unread API：M0 不做未读数，sidebar row 只显示“进行中”点。

### 2.4 交互契约

- 发送：Enter 发送，Shift+Enter 换行；空文本禁用；发送中禁用重复提交；
  queue receipt 后滚动到对应消息（若已出现在历史）。
- 选择 thread：更新 URL；sidebar active 高亮；移动端关闭抽屉。
- 新对话：侧栏“+ 新对话”打开轻量 dialog（projectPath 必填、标题可选）；
  创建成功后跳到 `/thread/:id`。
- 空/错误：thread 404 → “对话不存在” + 返回；401 → relogin；网络错误 →
  保留当前内容 + 顶部重试条；不要白屏。
- 消息渲染：M0 纯文本 + 简单代码块；**禁止 `dangerouslySetInnerHTML`**；代码块走
  纯文本节点或 sanitization 后的 highlighter。React 默认转义是底线，不是可关闭项。
- 键盘/读屏：按钮有 aria-label；焦点环可见；状态文字可读；动画 respect
  `prefers-reduced-motion`。

## 3. 技术设计

### 3.1 栈与承载（Decision Packet）

| 选项 | 内容 | 取舍 |
|---|---|---|
| **A（推荐）** | **Vite + React + TS + Zustand + CSS Modules/CSS vars** | 轻、快、无 SSR 需求；生产由 daemon 同源服务，天然无 CORS/cookie host 问题 |
| B | Next.js App Router + 独立 3000 server + /api 反代 | 与 clowder/0022 默认一致；但 SSR 用不上，依赖/构建/代理更重 |
| C | 手写 HTML/vanilla | 最轻，但达不到目标视觉/交互质量 |

推荐 A：本地单用户 SPA，不需要 SSR；`packages/superagentteam-web` 产出静态
dist，生产由 daemon 在 `/` 服务，`/api` 同源；开发用 Vite 3000 + proxy 到 daemon。
这样 console-link 的 cookie host 与页面 host 一致，S1 的 G5 问题在产品 UI 上消失。
classic Hub 兼容仍可用独立 3000 + 反代，作为可选客户端。

> 这是技术取舍，不改变 operator 已选的 C；若评审认为 Next.js 的路由/生态值得
> 多付依赖，可改 B，目录/域边界不变。

### 3.2 包结构

沿用 `0022` 的目录/边界，落为：

```text
packages/superagentteam-web/
├── src/
│   ├── app/                  # 路由/页面组合（Vite + react-router）
│   ├── domains/
│   │   ├── thread/           # api/store/components
│   │   ├── chat/
│   │   ├── a2a/              # queue/live
│   │   └── agent/
│   ├── components/{ui,layout}/
│   ├── lib/{api,polling,format}/
│   ├── styles/tokens.css
│   └── main.tsx
├── test/                     # vitest + testing-library
└── package.json              # @superagentteam/web
```

- 只 import `@superagentteam/shared` 类型；不 import daemon 内部。
- `app/` 只做路由/组合；domain 拥有自己的 api/store/components。
- 全局 store 只放 session/theme/toast。

### 3.3 API client 与 session

- `apiFetch<T>(path, init)`：`credentials: 'include'`；JSON；写请求带
  `x-csrf-token`（从 `/api/session` 的 csrfToken）；401 抛 typed `unauthorized`；
  错误体 `{error,message}` 转成可展示错误；不改 identity header。
- session store：启动时 `GET /api/session`；401 → `/relogin`；成功后保存
  `{userId, csrfToken}`；`/relogin` 提供命令 + “我已完成，重试”按钮。
- 开发 proxy：Vite `/api`、`/auth/console` → daemon 3011；`hubOrigin` 设为
  `http://localhost:3000`。生产：daemon 同源，`hubOrigin` 为 daemon origin。
- Vite proxy 不改写 Origin；daemon 看到 `Origin: http://localhost:3000`，必须与
  `hubOrigin` 匹配。H0 加“从 Vite origin 发起写请求通过 origin check”的测试。
- 写请求幂等键：`crypto.randomUUID()`；重试复用；不要用时间戳。

### 3.4 设计 token

`styles/tokens.css` 定义（浅色先，暗色 token 同步留好）：

- `--st-canvas: #fffbf6`、`--st-surface-1: #fcf7f0`、`--st-surface-2: #f7f2ea`、
  `--st-surface-3: #efe9e3`、`--st-hairline: #e5dfd5`、`--st-ink: #141413`、
  `--st-body: #3d3d3a`、`--st-muted: #5f5d57`、`--st-primary: #b05f45`、
  `--st-primary-active: #8f4730`、`--st-primary-soft: #f3e3da`。
- 字体：display 用 Source Serif 4/Songti/Georgia；body 用 Inter/PingFang/
  Noto Sans；mono 用 JetBrains Mono/ui-monospace。
- 4px 间距；32px 控件；8px 按钮/输入圆角；12px 气泡/卡片；发丝线 1px。
- 暗色先只做 token 占位（`[data-theme=dark]`），M0.5 再验收；M0 默认浅色。
- 不复制猫 persona 色/头像；agent 的 `color` 若来自 catalog，只用于名字/小点，
  不铺大面积。

### 3.5 构建 / CI / 供应链

- 新包加入 `packages/*` workspace；根 `build:offline`、`check`、`test` 增加 web
  步骤（或 web 自己的 build/test 被 workspace 命令覆盖）。
- 依赖：React、React DOM、react-router-dom、Zustand、Vite、@vitejs/plugin-react、
  Vitest、@testing-library/react、jsdom。**精确 pin**，更新 lockfile；跑
  `check:pinned-deps`、`check:runtime-deps`、`supply-chain`。
- 本项目安装走 `npm install --ignore-scripts`；H0 必须实测 esbuild/Vite 的平台包在
  该模式下可用。若某依赖需要 install script，在 §6 显式记 exception 并提供替代方案，
  不让 CI 第一天红。
- 根 `check` 增加 `tsc -p packages/superagentteam-web/tsconfig.json --noEmit`
  与 biome；新增 web 构建到 `build:offline`；CI `build-check-test` 覆盖。
- 这是新的依赖面，PR 需 supply-chain/非作者 review；在 `UPSTREAM.md` 记录
  下游新增（不改 upstream 文件）。
- 不用 Tailwind/MUI/大型组件库；CSS Modules + tokens，减少依赖与风格漂移。

## 4. 工作单元

| 单元 | 可观察结果 | 改动位置 | 验证 |
|---|---|---|---|
| H0 脚手架 + token + API/session | 页面能启动；无 session 进 relogin；console-link 后 `/api/session` 200；Vite-origin 写请求过 origin check | `packages/superagentteam-web/{package.json,vite.config.ts,src/main.tsx,src/app,src/lib/api,src/styles}`；根 build/check 脚本 | `npm install --ignore-scripts` 后 web build/unit；浏览器手验；Vite-origin POST 测试 |
| H1 shell + sidebar + threads | 看到 thread 列表；创建/选择/搜索；空态 | `domains/thread/*`、`components/layout/*` | thread store/api 单测；浏览器 smoke |
| H2 chat + composer | 历史可见；发送 202；消息出现；双击不双发；最新窗口 replace；坏 cursor 清游标重拉；纯文本/代码块不注入 HTML | `domains/chat/*`、`components/Composer`、`MessageRow` | send/idempotency、cursor replace、invalid_cursor 单测；浏览器 smoke |
| H3 queue/live/agents | queue strip、live pill、agent 状态；轮询不重叠 | `domains/a2a/*`、`domains/agent/*`、`lib/polling` | polling 单测；浏览器 smoke |
| H4 打磨 | 空/错/加载、窄屏、键盘、暗色 token、reduced motion；8h absolute 中途 401 保留草稿并进 relogin | `app/*`、`styles/*`、`components/ui/*` | 1440/1024/390 手验；键盘走查；对比度检查；8h 401 走查 |
| H5 承载 + CI | daemon 在 `/` 服务 SPA；console-link 跳 `/`；未知 `/api/*` 返回 JSON 404（静态 catch-all 不吞 API）；根 build/check/test 绿 | daemon static serving、CLI redirect、根脚本、CI | `npm run build:offline`、`npm run check`、`./test.sh`；`GET /api/unknown` JSON 404；浏览器 smoke |

每个行为单元先写 RED（Vitest/Testing Library 或浏览器 smoke），再实现；纯样式/
文档走格式/截图检查。

## 5. 验收

- **会话**：无 cookie 打开 → relogin；`superagentteam auth console-link` → Hub；
  `/api/session` 200；401 不落 `default-user`。
- **thread**：空态 → 新建（projectPath 必填）→ 列表出现 → 选择 → 详情；
  404/403 有可展示错误；无 `"default"` 哨兵。
- **chat**：发消息 → 202 receipt → 历史出现；同 key 重试不双发；不同内容 409
  显示“这条已发送过”；空 thread/空消息有明确空态。
- **queue/live**：queue strip 显示排队/位置；`/live` 显示 agent/status/耗时；
  agents 全局状态可见；无请求重叠/无 busy loop。
- **边界**：不读 `control.db`；不 import daemon；M1 endpoint 无 404；M0 不注册
  Socket.IO/不承诺 streaming。
- **视觉/可用性**：1440/1024/390 可用；键盘可完成发送；焦点环/对比度/状态文字；
  reduced motion 下不跑动画。
- **静态/API 边界**：SPA fallback 不吞 `/api/*`；`GET /api/不存在` 返回 JSON 404，
  不是 index.html。
- **构建**：web build/typecheck/test、根 `check`/`build:offline`、CI 绿；依赖
  pin/supply-chain 通过；`npm install --ignore-scripts` 下 Vite/esbuild 可用。

## 6. 风险与未决

- **新依赖面**：React/Vite 是新的供应链面；精确 pin + supply-chain review。
  若评审认为成本过高，可先做更小的静态页，但会牺牲目标体验。
- **轮询 vs streaming**：M0 无事件，processing 占位最多晚一个 poll；可接受。
  M2 events 落地时替换 polling，不改域名/组件边界。
- **富内容**：M0 只渲染纯文本/简单代码块；rich cards/attachments 后续。
- **未读/read state**：M1 无 API，M0 不做未读；sidebar 只显示“进行中”。
- **窄屏**：sidebar 抽屉 + composer 固定底部需要真实 390 走查。
- **静态服务安全**：daemon 服务 SPA 时防路径穿越、正确 content-type/cache；
  只服务 dist，不服务任意文件。SPA fallback 与 `/api/*` 必须硬分界。
- **install script**：`npm install --ignore-scripts` 下 esbuild/Vite 平台包若不可用，
  在 §6 记 exception，不用“先跑 postinstall 再说”的方式绕过供应链门禁。
- **projectPath 存在性**：M1 create 只校验非空；M0.5 在 daemon 同机场景补本地路径
  存在性检查，避免运行期 `worker_start_failed`。
- **classic Hub 兼容**：F020 不再以 real-Hub E2E 为 M2 前置；classic 兼容作为
  可选轨道，真实 Hub 的两个事实（projectPath 表单、mentions 值域）仍在
  `0029 §5` 的挂账里，由兼容轨道/操作员环境处理。
- **0022 栈默认**：0022 默认 Next.js；本计划推荐 Vite，需在评审时确认并更新
  0022 的“若不用 Next.js”段，不影响域/目录边界。

## 7. 非目标（M0）

- rich cards/attachments/whisper、approval、memory/mission/signals、workspace/
  artifacts、labels/pinning/grouping、games/bootcamp、multi-shell、Socket.IO
  events、cancel、multi_mention UI、全文搜索、未读/read receipts。
- 不复制 clowder 的 feature-ID 页面目录、不 import clowder runtime。
- 不做多用户/远程部署；本地单用户。

## References

- `docs/architecture/decision-packets/2026-11-21-dp-web-2-thin-hub.md`
- `docs/features/F020-thin-hub-m0.md`
- `docs/plans/0022-codeteam-web-surface.md`
- `docs/plans/0029-f016c-m1-execution.md`
- `docs/reports/2026-11-21-f016c-m1-s5-closeout.md`
- clowder `DESIGN.md`、`packages/web/src/components/AppShell.tsx`、
  `ThreadSidebar/ThreadItem.tsx`、`ChatContainer.tsx`、`ChatInput.tsx`、
  `MessageBubble.tsx`

[宪宪/deepseek-flash🐾]
