---
feature_ids: [superagentteam/F023]
related_features: [superagentteam/F020, superagentteam/F021, superagentteam/F022]
title: "F023: W7b thin Hub M1-B — thread rename"
status: done
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [墨墨 (Qwen 3.8 Flash), 砚砚 (GLM 5.3 Flash)]
vision_guard: 墨墨 (Qwen 3.8 Flash)
created: 2026-11-21
updated: 2026-11-21
source_feature: "superagentteam/F020"
---

# F023: W7b thin Hub M1-B — thread rename

> F022 M1-A 已交付未读/已读。M1-B 先做最小、可逆的管理能力：operator 能把
> system/agent 自动生成的 thread 标题改成自己认得的名字。归档/删除、agent
> 配置编辑、retry/cancel 留在后续 slice，不与本刀混。

## 用户结果

- Thread header 上可以直接重命名；保存后 sidebar 立即同步。
- reload 后新标题仍在；`titleSource` 记为 `user`。
- 空标题/纯空白被拒绝并给出人话错误；保存中按钮锁定；Esc 取消。
- 未命名 thread 仍显示「未命名对话」，重命名入口不隐藏。

## 范围

1. `ThreadStore.updateTitle(id, title, titleSource, now)`；只更新 `title`/
   `title_source`/`updated_at`，不 touch `last_active_at`。
2. `PATCH /api/threads/:id`：CSRF + owner + deleted 404；body `{title}` 必须
   是非空字符串（trim 后）；成功后 publish `thread` 并返回更新后的 ThreadView。
3. Web ThreadApi/Store `rename(threadId, title)`；ThreadPage header inline edit
   （保存/取消/错误/锁定）。
4. Sidebar 通过既有 thread store/SSE refresh 自动收敛；不新增同步通道。

## 非目标

- 归档/软删/恢复、批量整理、标签、置顶；这些单独 slice。
- Agent config 编辑、retry/cancel、全文搜索、rich cards。
- 不改变 thread id、message identity、unread/read 语义。

## 验收标准

- 创建 thread → 在 header 重命名 → sidebar 与 header 同时更新；reload 仍新名。
- `titleSource` 变为 `user`；`lastActiveAt` 不因重命名变化。
- 空/纯空白标题 → 400 `invalid_input`，UI 保留输入并显示错误。
- 非 owner → 403；不存在/已 deleted → 404；无 CSRF → 403。
- 重命名成功 publish `thread`，同 active thread 的另一个 tab 收敛。
- Daemon targeted tests、web tests、隔离 daemon+Vite 浏览器 smoke 全绿。

## 实施单元

1. `ThreadStore.updateTitle` + store test（不改 lastActiveAt）。
2. `PATCH /api/threads/:id` + API tests（成功/CSRF/owner/404/空标题/publish）。
3. Web api/store rename + ThreadPage inline edit + tests。
4. 隔离 smoke：创建 → 重命名 → sidebar 更新 → reload 保持。

## 关键契约

- `title` 存 trim 后的非空字符串；不加服务端长度上限（本地单用户，UI 限 200）。
- `titleSource = "user"`；不修改 `threads.last_active_at`。
- 重命名是幂等 PATCH；重复提交同标题不产生额外副作用。
- 不改变 ThreadView 既有字段；只更新 title/titleSource/updatedAt。

## 进展

- 2026-11-21：`ThreadStore.updateTitle`、`PATCH /api/threads/:id`（CSRF/owner/
  deleted/空标题校验、publish `thread`）、web ThreadApi/Store rename 与
  ThreadPage inline edit 已实现。
- 验证：daemon `npm test` = 869 passed / 3 skipped；web `npm test` = 79 passed
  / 22 files；web build（typecheck + Vite）= pass；`check:doc-index` = pass。
- 浏览器 smoke（隔离 daemon + Vite）：打开 thread → 重命名
  `F022 Unread Smoke` → `F023 Renamed Smoke` → header 与 sidebar 同步 →
  reload 后仍保持。
- 2026-11-21：PR #156 merged as `15d8ab9f5`；墨墨/砚砚双面 approve @
  `4aee2a75c`，无 P1/P2/P3。F023 实现完成。
- **Close-out（2026-11-21 operator 确认）**：PR #156 merged `15d8ab9f5`，
  双面 review approve @ `4aee2a75c`；F023 状态 done。

[宪宪/deepseek-flash🐾]
