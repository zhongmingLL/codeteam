---
feature_ids: [superagentteam/F021]
related_features: [superagentteam/F020, codeteam/F016]
title: "F021: thin Hub M0.5 hardening"
status: done
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [墨墨 (Qwen 3.8 Flash), 砚砚 (GLM 5.3 Flash)]
vision_guard: 墨墨 (Qwen 3.8 Flash)
created: 2026-11-21
updated: 2026-11-21
source_feature: "superagentteam/F020"
---

# F021: thin Hub M0.5 hardening

> F020 M0 已 close。F021 只收 M0 close packet 里仍在第一方 Hub 承诺内的
> 硬化项，不引入 M2 事件、不恢复 classic Hub 兼容面。

## 范围

1. **projectPath 真实目录校验**：thread create 要求绝对路径、存在且是目录；
   daemon 返回 typed `project_path_invalid` 422，Web 表单显示人话错误。
   replay 已存在 thread 时不重复做文件系统校验（保持幂等语义）。
2. **relogin 深链接**：401 时记住当前 thread URL；console-link 重新建立 session 后
   自动回到原 thread；只接受站内绝对路径，拒绝 `//` open redirect。
3. **证据补齐**：长 thread 的 saved-position 浏览器实测；真实 worker 的
   `/live` busy 状态 E2E（headless）+ LivePill/“已受理”现有单测组合。

## 非目标

- F016c-M2 SSE/Socket.IO events、history refetch。
- classic Hub 真实 E2E、CORS、mentions 值域、Hub projectPath 表单。
- F016b wait、rich cards/attachments/approval、未读、cancel。

## 验收

- 相对路径、不存在路径、文件路径均返回 422 `project_path_invalid`；合法目录 201；
  同一 idempotencyKey replay 仍 200。
- 401 → `/relogin` → console-link → 自动回到原 thread；恶意 `//host` 不跳转。
- 长 thread 滚动位置可恢复；真实 worker 运行期间 `/live` 有 active invocation，
  结束后为空；web 仍以 LivePill/已受理占位展示该 shape。

## 进展

- projectPath：daemon 校验绝对路径/存在/目录，新增 `project_path_invalid` 422；
  replay 已存在 thread 不重复做文件系统校验；Web 映射为
  “请填写一个存在的绝对目录路径”。negative/positive 测试已加。
- relogin 深链接：401 时记录站内 returnTo，session 恢复后自动回到原 thread；
  只接受站内绝对路径。浏览器实测 401 → relogin → console-link 自动回 thread，
  draft 仍在。
- 长 thread：隔离数据目录 seed 80 条消息，浏览器滚动窗口 50 条；滚到顶部后
  reload 恢复 `scrollTop=0`，首条为最新窗口的 seed 30。
- busy live：新增真实 pi worker + delayed mock provider E2E；运行期间
  `/live` 有 a1 active invocation、`/agents` 为 working，结束后 live 清空且
  响应 `BUSY_DONE` 落库。

**验证**：daemon 856 passed / 3 skipped、web 62 passed / 20 files、web typecheck 0、
build 296.14 kB / 93.27 kB gzip；实现已合入 `e478f5b9`。

> 兼容性注记（F021/砚砚 P3）：M0.5 起 create 的 `projectPath` 必须是绝对路径；
> M1 时代可能存在的相对路径 thread 不保证 replay（M1 只要求非空）。真实部署中
> 不存在这类数据，保留为一次性格式收紧记录。

> **Close-out（2026-11-21 operator 确认）**：F021 实现已合入 `e478f5b9`，
> 墨墨/砚砚双面 review approve；feature 状态 done。保留注记：M0.5 起路径格式
> 收紧、8h session 为清 cookie 模拟。

[宪宪/deepseek-flash🐾]
