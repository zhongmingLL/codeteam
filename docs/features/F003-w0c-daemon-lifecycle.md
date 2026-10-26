---
feature_ids: [F003]
related_features: [F002]
topics: [daemon, lifecycle, readiness, boot-ledger]
doc_kind: spec
created: 2026-10-27
---

# F003: W0c daemon 最小生命周期

> Status: done (CONDITIONAL-free; see Evidence) | Owner: 宪宪 | Design inherited from `docs/plans/0002-w0-w2-foundation.md` §W0c.

## Why

W1 的控制面需要一个可启动、可停止、可探测的本地 daemon。没有 boot ledger 和 readiness，
“runtime 已启动”只能靠进程存在来宣称，无法区分 starting / ready / stopped / failed。W0c 是
W1 runtime 启动的前置门禁，也是 W5 部署等待谓词的最小底座。

## What

- `@codeteam/daemon` 包：`CODETEAM_DATA_DIR` 下的 daemon state + append-only boot ledger。
- 启动时 realpath 校验 installation root，派生稳定 `installationId`。
- 单写者 fence 先于 `beginBoot`；写 `bootId` / `bootSequence` / `runningRevision`。
- loopback `/health`：只有实际可用并 `markReady` 后才返回 200 ready。
- 最小安全生命周期：`requested → ready → stopping → stopped/failed`，非法迁移 fail closed。

## Acceptance Criteria

- [x] AC-1 数据根：`CODETEAM_DATA_DIR` 缺失时 fail closed；目录创建为 0700，state/ledger 文件为 0600。
- [x] AC-2 installation identity：同一 realpath 得到同一 `installationId`；不同 root 不同；不把 host path 写进 ID。
- [x] AC-3 boot ledger：`beginBoot` 追加 `bootId/bootSequence/runningRevision`；重启后 sequence 递增；ledger 只追加不改写。
- [x] AC-4 单写者：同一 data dir 的第二个 daemon 启动失败（`already_running`）；死进程留下的 fence 可安全回收并留痕。
- [x] AC-5 readiness：未 `markReady` 时 `/health` 返回 503 starting；声明服务全部就绪后返回 200 ready。
- [x] AC-6 生命周期：`stop()` 走 stopping→stopped 并释放 fence；非法迁移 fail closed，不写 ready。
- [x] AC-7 隔离：测试只用临时目录；没有生产数据、没有固定端口冲突。

## Dependencies

- W0a（F002）已收口；本特性不依赖 pi kernel。
- W1 runtime 启动以本特性为前置。

## Risk

- 低。新增独立包，不改 kernel、不改 CI 必检项；回滚为删除包与 build 链一行。

## Open Questions

- W5 的完整授权/复验链不在本特性范围；这里只做最小生命周期。

## Evidence (2026-10-27)

| Check | Command | Result |
|---|---|---|
| Package build | `NODE_ENV=development npm run build --workspace @codeteam/daemon` | exit 0 |
| Daemon tests | `NODE_ENV=development npm test --workspace @codeteam/daemon` | 1 file, 10 tests pass |
| Mutation check | force `/health` to 200 before ready | the readiness test fails (1 failed / 9 passed), then restored |
| Root check | `NODE_ENV=development npm run check` (after pinned-catalog hydrate) | exit 0 |
| Audit | `node scripts/npm-audit.mjs` | exit 0 |

The tests cover: missing `CODETEAM_DATA_DIR`, 0700/0600 modes, installation identity, boot sequence
across restarts, concurrent-start rejection, dead-fence reclaim, 503→200 readiness, service
declaration failures, stop/fence release/late-readiness rejection, and a failed boot when the port is
taken.

Known boundary: the fence is a best-effort single-writer guard; W5 may harden the stale-fence race.
