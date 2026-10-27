---
feature_ids: [codeteam/F005]
title: "F005: W2 权限、身份与沙箱（kickoff）"
status: in-progress
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: []
created: 2026-10-28
updated: 2026-10-28
---

# F005: W2 权限、身份与沙箱（kickoff）

> 项目作用域 ID 是 `codeteam/F005`。验收清单以
> [`docs/plans/0002-w0-w2-foundation.md`](../plans/0002-w0-w2-foundation.md)
> §W2 为单一真相源；本文件只定切片、顺序与 slice-specific 验收，不复制第二套。

## Why

W1 已把 `invocation_credentials`、audit、review/merge/approval 的**账本**落表，
但没有任何运行时执行：token 没有铸造/校验路径，工具没有路径/命令策略，
sandbox 与 dogfood 边界还只是文字。W2 要把「策略层」变成「工具实现 + OS
边界」，并让身份粒度到 run，而不是 worker 进程——这是接真实 repo 的前置门禁
（§W2 依赖顺序：W2 未完成前只跑 fixture）。

## What（切片）

| Slice | 范围 | 依赖 |
|---|---|---|
| **F005a** 身份与 callback auth | per-run token 铸造/绑定/撤销；token→binding resolver + header-only 校验中间件（**MCP server 本体随 W7a 落地**，W7a 接线复用本 resolver；plan 0002 的「改造 MCP server」按可执行顺序解释为「先落 resolver」）；header-only（body/query 401）；liveness 两段式（run_events + worker 进程 + exact runId fence）；interrupted/terminal 立即撤销；token 目录前缀硬 deny；**additive migration 补 `callback_allowlist` 列**（plan A1-2 点名、W1 未建）；terminal tombstone 30d 清理 job 归 F005a（随启动 sweep） | W1 `invocation_credentials` |
| **F005b** 工具策略 | coder/reviewer/verifier wrapper：命令 deny-by-default + 只读 allowlist、shell 操作符禁止、`node -e` 禁止、timeout/output cap/minimal env；路径 canonicalize + realpath，拒绝 `..`/symlink/hardlink；读 deny 显式枚举（`.env*`、`*.pem`、`id_rsa*`、`.ssh/`、credentials、`.git` 内部对象、`/run/codeteam/tokens/`、**`$CODETEAM_DATA_DIR/tokens/`（F005a token 实际落点）**）**加 daemon 数据面整体**（`CODETEAM_DATA_DIR/credentials/`、`control.db`、`artifacts/`）；写路径策略覆盖 acceptance 7（review/verify 只写隔离 evidence worktree，被审 worktree 只读）；coder git policy（add/commit/status/diff）+ commit wrapper 写 `head_sha` audit；handoff `(fromRole,toRole,kind)` 白名单 + fromRole 从 token 派生 | F005a |
| **F005c** operator 与 service 凭据 | `codeteam auth init` 本地 operator.key（0600，rotation 即撤销）；approval decide 只接受 operator principal（run token/agent-key 403）；routine merge 由 `service:merge-owner` + per-merge short-TTL credential 执行 | F005a |
| **F005d** sandbox 与 dogfood 边界 | 低权 OS user + bwrap profile，只挂 task worktree；review/verify 以只读方式挂被审 worktree + 独立 evidence worktree（acceptance 7，同 task 峰值 ≤2 份计入 W5 pool）；网络边界按 D3=A 记录为已知威胁（agent 进程网络开放，不声称 allowlist）；daemon 数据/artifact/token 固定仓外目录，worktree root 独立；真实 repo first-run 记录 | F005b |
| **F005e** 威胁测试与 audit | 危险命令/路径逃逸/symlink/hardlink/secret dump/跨 run 冒用/读自身 token/interrupted token 复用/伪造 approval rich block（**强制已在 W1 messages 双触发器落地，本切片只补威胁测试**）；audit append-only + full args/cwd/exit/duration/tails + `producingReviewId`；威胁测试报告落 `docs/reports/` | F005a–d 同步 |

顺序：**F005a → F005b →（F005c ∥ F005d）→ F005e 收口**。a/b 是真实 repo 的
硬前置；c/d 可并行；e 每个 slice 边做边加，最后出一份矩阵报告。

### 契约注记（F005a review 收口）

- `callback_allowlist` 空数组 `[]` 是 **deny-all**；F005b/F005c 的消费方永远不得把
  空数组解释为 allow-all（fail-closed）。
- `credential.userId ?? "unpaired-user"` 是 v1 哨兵值（F005a P3 已知项）：W2 不
  引入真实用户体系，不据此做授权判断。

## 进展

- 2026-10-28：F005a 实现完成，进入安全 review：
  [`F005a-per-run-token.md`](F005a-per-run-token.md)（migration 006 + mint/verify/
  resolver + header-only + liveness + tombstone sweep，包内 93/93）。

## Slice-specific 验收（W2 全量见 plan）

- [ ] 同 worker 内两个 run 的 MCP token 不能互相冒用；tool args 身份字段一律忽略。
- [ ] 危险命令、路径逃逸、symlink/hardlink、secret 路径全部拒绝；拒绝有 typed error + audit。
- [ ] agent 读自身 token 文件被拒；interrupted run 的 token 不能完成 handoff。
- [ ] approval decide 对 run token/agent-key 返回 403；routine merge 只由 `service:merge-owner` 执行。
- [ ] callback credential 只接受 header；body/query 401 `invalid_token`。
- [ ] stale lease/heartbeat 只产生 liveness candidate，无独立证据不吊销。
- [ ] coder 只能 `git add/commit/status/diff`，commit sha 从 audit 回溯并写入 `reviews.head_sha`。
- [ ] review/verify 不能写被审 worktree；取证写只限隔离 evidence worktree；同 task 峰值 ≤2 份（计入 W5 pool）。
- [ ] agent 进程零 secret；daemon 数据与 worktree 都在仓外；dogfood 分支不 push。
- [ ] audit 不可 UPDATE/DELETE；能还原完整命令。
- [ ] 威胁测试矩阵全绿 + 报告落盘。

## 待 operator 确认

- sandbox 最终选型：MVP 默认低权 user + bwrap，目标态 container（microVM 后置）。
  本阶段按 MVP 执行；不把「网络 allowlist」写成已实现——它属于 container 目标态。
- 若 operator 选择提前上 container，F005d 的范围与验证层级需要重排。

## Out of scope

- W5 worker registry / lease / 多 task pool（本阶段单进程 + per-run 身份）。
- W7 Console 页面与 `auth console-link` 的实际前端（本阶段只做 CLI credential；
  loopback 短时效 session token 随 W7a）。
- microVM、密钥托管服务、agent 调 secret API（v2 sidecar 方案）。

## Evidence plan

- 每个 slice：实现 + typed errors + 威胁测试；非作者 review（砚砚安全/治理，
  烁烁 SDK/RPC 注入与 worker 生命周期）。
- F005e：`docs/reports/YYYY-MM-DD-w2-threat-matrix.md`，逐条 AC → 测试名 → 结果，
  并写明验证层级与最高未覆盖层。

[宪宪/deepseek-flash🐾]
