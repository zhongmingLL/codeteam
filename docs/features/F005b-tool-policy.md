---
feature_ids: [codeteam/F005b]
related_features: [codeteam/F005]
title: "F005b: 工具策略（命令/路径 deny-by-default）"
status: in-progress
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: []
created: 2026-10-28
updated: 2026-10-28
---

# F005b: 工具策略（命令/路径 deny-by-default）

> F005（W2）的工具策略切片。验收仍以 `docs/plans/0002` §W2 为单一真相源；
> 本文件只记录本批交付与剩余项。

## Why

F005a 给了 per-run 身份，但 agent 仍可以执行任意命令、读任意文件。W2 要求
「策略层变成工具实现」：命令 deny-by-default、路径 canonicalize、secret 与
daemon 数据面不可读、review/verify 不能写被审 worktree。

## What（本批：策略决策层）

- `createToolPolicy({role, dataDir, worktreeRoot, evidenceRoot?})`：
  - coder：读/写 worktree
  - reviewer/verifier：读 worktree（只读）+ 写独立 evidence worktree
- 路径策略（`assertReadablePath` / `assertWritablePath`）：
  - 拒绝 `..` 段、realpath 后越出允许根（symlink 逃逸）
  - hardlink（`nlink > 1` 的文件）拒绝
  - deny 名：`.env*`、`*.pem`、`id_rsa*`
  - deny 段：`.ssh`、`credentials`、`.git`（工具层禁读 git 内部对象）
  - deny 数据面：`<dataDir>/tokens`、`credentials`、`control.db`、`artifacts`、
    `/run/codeteam/tokens`
- 命令策略（`evaluateCommand`）：
  - allowlist：`git/ls/cat/head/tail/wc/grep/node`
  - shell 元字符（`; | & < > \` $ 换行 #`）一律拒绝
  - `node` 只允许 `--test`；`git` 只允许 `add/commit/status/diff`，禁
    `-C`/`-c`/`--git-dir`/`--work-tree`/`--no-index` 等逃逸 flag
  - 资源 envelope：`timeoutMs`、`maxOutputBytes`；env 只保留 allowlist
  - 读命令的路径参数过路径策略；`git add` 的参数按写路径校验
- 命令执行器（`runCommand`）：
  - spawn（`shell:false`）+ 最小 env + timeout（SIGKILL）+ output cap（超限即停）
  - TOCTOU 第二层：执行前对路径参数做 canonical + `dev/ino` 快照复查
  - spawn 失败 → typed `command_failed`
- coder commit wrapper（`commitWithAudit`）：
  - 记录 pre/post HEAD；`git rev-parse --verify` 验对象；parent 链必须包含
    pre HEAD，防伪造 `head_sha` 回溯链
  - 成功后写 audit `commit_created`（previousHead / headSha / paths / cwd）
- handoff 方向白名单（`assertHandoffDirection`）：
  - `fromRole` 只从 token binding 派生，函数签名不接受调用方声明
  - `(fromRole,toRole,kind)` 命中 actionPair 白名单（默认集 + 可注入 SOP 集）
  - `git show` 仅允许 `-s/--no-patch`，`rev-parse`/`show` 进只读白名单
  - cwd 必须落在允许根内（无路径参命令也不能在任意目录跑）

## Remaining in F005b

- 无（等待 review/merge 收口）。

## Acceptance（本批）

- [x] coder/reviewer/verifier 的读写根与 evidence worktree 分离。
- [x] 危险命令、非 allowlist 命令、shell 元字符全部拒绝。
- [x] `node -e` / 任意 node 脚本拒绝；`node --test` 放行。
- [x] `git push/remote/config/checkout/reset` 与逃逸 flag 拒绝。
- [x] `..`、symlink 逃逸、hardlink、`.env*`、`*.pem`、`id_rsa*`、`.ssh/`、
      `credentials/`、`.git/` 内部对象、daemon 数据面全部拒绝。
- [x] reviewer 写 evidence 放行、写被审 worktree 拒绝。
- [x] 命令 envelope 带 timeout/output cap / 最小 env。
- [x] 执行器：spawn 落地、timeout SIGKILL、output cap、`command_failed` typed。
- [x] 执行器 TOCTOU 第二层：canonical + dev/ino 快照复查。
- [x] commit wrapper：pre/post HEAD + parent 链 + audit 回溯；伪造 head_sha 链拒绝。
- [x] handoff 方向白名单：fromRole 从 token binding 派生，声明式伪造结构性消除。
- [x] cwd 根包含校验（P3，executor review 顺手）。
- [x] review 收口：`git diff --output/-o/--pathspec-*` 任意写原语拒绝；`git commit -F`
  路径按读策略校验。
- [x] review 收口：`git commit --file=` / `-F<path>` attached 形态同样走读策略；
  `--exec-path=` 进入前缀 deny。
- [x] review 收口：写路径 lstat——悬空 symlink / hardlink 目标拒绝。
- [x] review 收口：`credentials.json` / `credentials.yaml` 等 basename 拒绝。
- [x] review 收口：commit message 的 `#` 消息位豁免，其余 shell 元字符照旧拒绝。
- [x] 包内 115/115、包 build、Biome 通过。
- [ ] 非作者安全 review（砚砚）与 merge。

## Out of scope

- sandbox/OS 边界（F005d）；本批只做工具层策略。
- MCP server 接线（W7a）。
- 真实 repo 的 sandbox first-run（F005d）。
- 子进程进程组 kill（SIGKILL 只杀直接子进程）——executor hardening follow-up；
  W2 命令形态简单，F005d sandbox 一并处理。

[宪宪/deepseek-flash🐾]
