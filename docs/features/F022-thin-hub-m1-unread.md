---
feature_ids: [superagentteam/F022]
related_features: [superagentteam/F020, superagentteam/F021, superagentteam/F016]
title: "F022: W7b thin Hub M1-A — unread/read state"
status: done
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [墨墨 (Qwen 3.8 Flash), 砚砚 (GLM 5.3 Flash)]
vision_guard: 墨墨 (Qwen 3.8 Flash)
created: 2026-11-21
updated: 2026-11-21
source_feature: "superagentteam/F020"
---

# F022: W7b thin Hub M1-A — unread/read state

> F020 M0、F021 M0.5、F016c-M2 已交付。M1 的「建 + 配 + 控」先从最小的
> 注意力面开始：operator 能看出哪些 thread 有新的 agent 回复，并在真正阅读后
> 清除。不引入通知、rich cards、cancel/retry 或 agent 配置编辑。

## 用户结果

- Sidebar 每个 thread 显示未读数；自己发的消息不算未读，已删除消息不计数。
- 打开 thread 后未读清除；刷新/重开浏览器后仍保持已读。
- Thread 打开但页面隐藏，或滚在历史里时，新到的 agent 消息仍计未读；
  回到最新且页面可见时自动清除。
- 没有未读时不显示 badge；未读状态不只靠颜色表达。

## 范围

1. Daemon migration `006-thread-read-state`：`(user_id, thread_id)` 主键、
   `last_read_seq`、`updated_at`；mark-read 单调不回退。
2. `/api/threads` 与 `/api/threads/:id` 增加 `unreadCount`；只统计
   `author_kind != 'user'` 且未删除、`seq > last_read_seq` 的消息。
3. `POST /api/threads/:id/read`：CSRF；body `{ messageId? }`；messageId 必须
   属于该 thread，省略时读到当前最新 seq；返回 `{ threadId, unreadCount }`。
4. Web：`ThreadView.unreadCount`；sidebar 未读 badge；ThreadPage 在打开与
   「跟随最新且可见」时 mark read。
5. Mark read 成功后发布 `thread` invalidation，让其他 tab 的 sidebar 收敛。

## 非目标

- 多用户/跨 operator、通知/推送/email、unread 偏好设置。
- Rich cards/attachments、cancel/retry、agent config 编辑、全文搜索；
  这些留在 M1 后续 slices。
- 不把 `messages.seq` 暴露到 MessageView；read API 用 messageId 解析游标。

## 验收标准

- 新 thread 有 agent 回复后，`GET /api/threads` 的 `unreadCount > 0`；
  `POST /api/threads/:id/read` 后为 0；reload 后仍为 0。
- 自己发的消息不增加 unreadCount；soft-deleted 消息不计数。
- 同一 thread 的旧 messageId 重复 mark read 不会让游标回退。
- 同一 active thread 的两个 tab：tab A 读到最新后，tab B 经 `thread` SSE
  事件清除未读；其他 sidebar 在 10s 轮询内收敛。
- Thread 打开但页面 hidden 时到达 agent 消息 → 未读增加；回到 visible 且
  followingLatest 时清除。
- 滚在历史（followingLatest=false）时到达 agent 消息 → 未读增加；
  「回到最新」后清除。
- 403/404/CSRF/invalid messageId 均有 typed 错误；mark read 幂等。
- Daemon targeted tests、web tests、隔离数据目录的浏览器 smoke 全绿。

## 实施单元

1. Migration 006 + `ThreadStore` read-state 方法 + store tests。
2. Threads/read route projections + read endpoint + API tests（含 CSRF/owner/
   messageId 归属/单调性）。
3. Web thread api/store + sidebar badge + ThreadPage mark-read effect + tests。
4. 隔离 smoke：建 thread、seed agent 回复、未读出现、打开清除、reload 保持；
   hidden/滚动行为由 web unit tests 覆盖。

## 关键契约

- `unreadCount = COUNT(messages WHERE thread_id=? AND seq > last_read_seq
  AND deleted_at IS NULL AND author_kind != 'user')`。
- `markRead` 使用 `MAX(last_read_seq, resolvedSeq)`，永不回退。
- Read cursor 按 `(user_id, thread_id)` 隔离；单用户本地部署仍显式带
  session user。
- 不改变 thread/message identity、排序或 MessageView 的 seq-free 契约。

## 进展

- 2026-11-21：feature 立项；migration 006、thread read state、`unreadCount`
  projection、`POST /api/threads/:id/read`、sidebar badge 与 ThreadPage
  mark-read effect 已实现。
- 2026-11-21：浏览器 smoke（隔离 data dir + daemon + Vite）通过：home 出现
  `1 条未读` → 打开 thread 后清除 → reload 后仍保持已读。
- 2026-11-21：smoke 中发现并修复“读完又被 10s 列表旧响应写回未读”的竞态；
  thread store 增加 list request sequencing，旧响应不再覆盖 read 后的状态。
- 验证：daemon `npm test` = 866 passed / 3 skipped；web `npm test` = 77 passed
  / 22 files；web build（typecheck + Vite）= pass；`check:doc-index` = pass。
- Hidden、followingLatest=false、旧 cursor 不回退、旧列表响应竞态均有 web
  unit tests 覆盖。
- 2026-11-21：PR #154 merged as `a6ae8e40f`；墨墨/砚砚双面 approve（含 P3
  delta @ `31d982da2`：badge `role="status"` + mark-read 失败重试）。
  F022 实现完成。
- **Close-out（2026-11-21 operator 确认）**：PR #154 merged `a6ae8e40f`
  （含 P3 delta `31d982da2`），双面 review approve；F022 状态 done。

[宪宪/deepseek-flash🐾]
