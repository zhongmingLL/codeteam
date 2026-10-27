---
feature_ids: [codeteam/F005d]
related_features: [codeteam/F005]
title: "F005d: sandbox MVP（bwrap profile）"
status: done
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash)]
created: 2026-10-28
updated: 2026-10-28
---

# F005d: sandbox MVP（bwrap profile）

> operator 已拍板走 MVP（低权 user + bwrap）；container 为目标态。验收以
> `docs/plans/0002` §W2 为准，本文件只记本批交付与已知边界。

## Why

F005b 的工具策略是用户态强制；如果进程本身能随意读宿主文件，策略就是唯一
防线。F005d 加 OS 边界：只挂 task worktree 与运行所需系统目录，不挂 home、
SSH、daemon 数据面。

## What

- `buildSandboxArgv(policy, execution, config)`：生成 bwrap 启动参数
  - `--die-with-parent --unshare-all`（pid/ipc/uts/cgroup/user 全隔离）
  - `--share-net`：**MVP 显式保留网络**（D3=A 已知边界；container 目标态再上
    allowlist）
  - 只 ro-bind 系统运行目录（`/usr`、`/bin`、`/sbin`、`/lib*`、`/usr/local`）
    + node 运行时前缀 + 少量 `/etc` 文件（hosts/resolv/nsswitch/passwd/group/localtime）
  - `--tmpfs /tmp`；worktree 按角色挂载：coder rw；reviewer/verifier
    ro worktree + rw evidence
  - `--chdir <cwd> -- <argv>`；**不挂 home / SSH / `<dataDir>` / credentials /
    tokens / artifacts**
- `runCommand(..., { sandbox: true | SandboxConfig })`：策略校验与 TOCTOU 复查
  之后，用 bwrap 启动；timeout/output cap 语义不变
- bwrap 缺失 → typed `command_failed`（显式提示安装）

## Acceptance

- [x] profile 只挂 worktree + 系统根；不含 home/SSH/daemon 数据面（builder 测试）。
- [x] reviewer worktree 只读、evidence 可写（builder 测试）。
- [x] `--share-net` 可显式关闭；MVP 默认保留网络并如实记录为已知边界。
- [x] 真实 bwrap 冒烟：`ls src` 与 `git status` 在沙箱内可运行（本机 bwrap 可用）。
- [x] bwrap 不可用时测试自动 skip；CI 仍跑 builder 单测。
- [x] 包内 127/127、包 build、Biome 通过。
- [x] 非作者安全 review（砚砚 approve @ `ea2068258`，127/127 独立复跑）与 merge
  （PR #37，`a503d4aa5`）。

## 已知边界（如实披露）

- **网络**：MVP 是「agent 进程网络开放」，不是 allowlist；`--share-net` 就是
  这个决定的实现。container 目标态再做真 allowlist。
- **低权 OS user**：当前以既有非 root 用户（uid 1000）运行，隔离靠 bwrap
  user/pid/net namespace；**没有**创建专用低权 OS 用户（需要 root 预置）。
- **真实 repo first-run**：尚未跑（需要 operator 的 dogfood repo/授权）；
  本批只证明 fixture 内沙箱可运行。
- TOCTOU 完全原子关闭仍需 sandbox 内的 O_NOFOLLOW/openat2（随真实 repo 首跑
  一起验证）。
- `--die-with-parent` 行为测试与 `--new-session` 在 F005e 收口（本切片 review
  转出项）。

## Out of scope

- container / microVM 目标态与网络 allowlist。
- 专用低权 OS user 的 provisioning。
- W5 worker pool 的资源配额（CPU/memory/disk）。

[宪宪/deepseek-flash🐾]
