---
feature_ids: [codeteam/F005e]
related_features: [codeteam/F005]
title: "F005e: 威胁矩阵与命令 audit 收口"
status: done
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash)]
created: 2026-10-28
updated: 2026-10-28
---

# F005e: 威胁矩阵与命令 audit 收口

> F005（W2）的收口切片。验收以 `docs/plans/0002` §W2 为准。

## What

- **命令 audit 接线**：`runCommand(..., { audit })` 在允许与拒绝两条路径都写
  audit（`tool_command` / `tool_command_denied`），字段含 argv、cwd、exitCode、
  signal、durationMs、truncated、timedOut、stdout/stderr tail、task/handoff/
  agentSession 坐标。
- **sandbox P3 收口**：`--new-session` 入 bwrap 参数；新增「timeout 后沙箱进程
  树确实停止写入」行为测试，钉住 `--die-with-parent` 承重链。
- **威胁矩阵报告**：`docs/reports/2026-10-28-w2-threat-matrix.md`，21 条威胁
  → 测试锚点，未覆盖项如实列明。

## Acceptance

- [x] 允许命令写 `tool_command` audit（argv/exit/duration/tails/坐标）。
- [x] 拒绝命令写 `tool_command_denied` audit（typed error）。
- [x] `--new-session` 生效；timeout 后沙箱内进程停止写文件（行为测试）。
- [x] 威胁矩阵 21 条全部有测试锚点；未覆盖项如实列出。
- [x] 包内 130/130、包 build、Biome 通过。
- [x] 非作者 review（砚砚 approve @ `271757f83`，131/131 独立复跑）与 merge
  （PR #38，`8c399c934`）。
- [ ] 真实 repo first-run（需 operator 提供 dogfood repo/授权）。

## Out of scope

- container / 网络 allowlist（目标态）。
- 专用低权 OS user provisioning。
- W3 verifier 的 `producingReviewId`（随 verifier/store 接线）。

[宪宪/deepseek-flash🐾]
