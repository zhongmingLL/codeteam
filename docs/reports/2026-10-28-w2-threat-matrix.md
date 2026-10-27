# W2 威胁矩阵（2026-10-28）

> 对照 `docs/plans/0002` §W2 Acceptance 与已合入切片（F005a–d），逐条列
> 威胁 → 测试锚点 → 结果。真实 repo 首跑与 container 目标态另行标注。

| # | 威胁 | 测试锚点 | 结果 |
|---|---|---|---|
| 1 | 非 allowlist 命令 | `control-policy.test.ts` denies commands outside the allowlist | ✅ |
| 2 | shell 元字符 / 注入 | `control-policy.test.ts` same | ✅ |
| 3 | `node -e` / 任意 node 脚本 | `control-policy.test.ts` denies node eval | ✅ |
| 4 | `..` 路径穿越 | `control-policy.test.ts` denies path traversal | ✅ |
| 5 | symlink 逃逸 | `control-policy.test.ts` same（realpath 越界） | ✅ |
| 6 | hardlink 改写/读取 | `control-policy.test.ts` denies secret paths（nlink>1） | ✅ |
| 7 | secret 文件（`.env*`/`*.pem`/`id_rsa*`/`credentials.*`/`.ssh`/`.git`） | `control-policy.test.ts` | ✅ |
| 8 | daemon 数据面（dataDir/tokens/credentials/control.db/artifacts） | `control-policy.test.ts` | ✅ |
| 9 | reviewer 写被审 worktree | `control-policy.test.ts` restricts reviewer writes | ✅ |
| 10 | 非 coder 执行 `git add/commit` | `control-commit-handoff.test.ts` coder-only | ✅ |
| 11 | git 任意写（`--output`/`--file`/`--pathspec-*`/`--exec-path`） | `control-policy.test.ts` git write primitives | ✅ |
| 12 | 跨 run token 冒用 | `control-auth.test.ts` keeps two runs isolated | ✅ |
| 13 | 读 token 文件 | `control-policy.test.ts` denies data-plane token path | ✅ |
| 14 | interrupted run 的 token 完成 handoff | `control-recovery.test.ts` prevents interrupted completion | ✅ |
| 15 | 伪造 approval rich block | `control-schema.test.ts` forbids approval rich blocks | ✅ |
| 16 | 伪造 operator principal | `control-operator.test.ts` separates principals | ✅ |
| 17 | merge credential 重放/换绑/过期 | `control-operator.test.ts` merge credential binding | ✅ |
| 18 | 沙箱内可见宿主 home/dataDir | `control-sandbox.test.ts` mounts only worktree + system roots | ✅ |
| 19 | timeout 后孤儿进程继续写 | `control-sandbox.test.ts` kills the sandboxed process tree | ✅ |
| 20 | audit 被篡改 | `control-schema.test.ts` append-only | ✅ |
| 21 | 命令 audit 缺字段 | `control-exec.test.ts` records command audit entries | ✅ |

## 未覆盖 / 已知边界（如实）

- **网络开放**：MVP `--share-net` 是 D3=A 的已知边界，不是 allowlist；container 目标态再补。
- **专用低权 OS user**：未创建（需 root 预置）；当前是非 root 用户 + bwrap namespaces。
- **真实 repo first-run**：未跑——需要 operator 的 dogfood repo 与授权。
- **TOCTOU 原子 open**：沙箱内 `O_NOFOLLOW/openat2` 未做，随真实 repo 首跑验证。

[宪宪/deepseek-flash🐾]
