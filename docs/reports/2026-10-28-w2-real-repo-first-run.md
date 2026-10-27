# W2 真实 repo first-run（2026-10-28）

> operator 授权使用 codeteam 仓自身。目标：在 bwrap 沙箱内对真实仓库跑只读命令
> 矩阵与拒绝矩阵，证明 F005b–e 的策略/沙箱/audit 在真实 repo 上成立。

## 环境

- 目标仓：`/home/ming/agent/codeteam`（codeteam 仓自身）
- 仓 HEAD：`042695f5dd2adcb908fcae3b83b99b0b4204c9f9`
- bwrap：`bubblewrap 0.6.1`
- 策略：`role=reviewer`（worktree 只读 + 独立 evidence 可写），`sandbox: true`
- 数据目录：临时目录（不指向真实 daemon state）

## 只读命令矩阵（沙箱内）

| 命令 | exit | 耗时 | 输出（截断） |
|---|---|---|---|
| `git status --short` | 0 | 15ms | `?? packages/codeteam-daemon/test/real-repo-first-run.test.ts` |
| `git rev-parse HEAD` | 0 | 7ms | `042695f5…` |
| `git diff --stat` | 0 | 9ms | 空（干净） |
| `ls packages` | 0 | 7ms | `agent / ai / chord …` |
| `wc -l CODETEAM.md` | 0 | 7ms | `26 CODETEAM.md` |

## 拒绝矩阵

| 请求 | 结果 |
|---|---|
| `rm -rf README.md` | typed `ControlError`（命令不在 allowlist，未进入沙箱执行） |
| `cat .git/config` | typed `ControlError`（`.git` 段读 deny） |

## 证据写路径

- reviewer 的 evidence worktree 在沙箱内 rw 挂载，`ls` 正常（空目录）；
- 被审仓库为 ro 挂载，矩阵命令无写入。

## 复现

```bash
CODETEAM_REAL_REPO=/home/ming/agent/codeteam \
  npx vitest --run test/real-repo-first-run.test.ts --root packages/codeteam-daemon
```

测试默认 skip（需要显式 env + 本机 bwrap）；CI 不跑真实仓。

## 已知边界（不变）

- 网络开放（`--share-net`，D3=A），不是 allowlist；container 目标态再补。
- 无专用低权 OS user（现有非 root + bwrap namespaces）；bwrap-only 双失效残面
  = 宿主 uid 1000 可达文件，由零 secret 限制损失。
- TOCTOU 原子 open（O_NOFOLLOW/openat2）仍为后续 hardening；本次矩阵用只读命令。

结论：W2 最后一条 acceptance（真实 repo first-run）已有可复现证据；W2 收口
仅剩 operator 对「bwrap + 零 secret MVP 边界」的显式确认。

[宪宪/deepseek-flash🐾]
