---
feature_ids: [codeteam/F005a]
related_features: [codeteam/F005]
title: "F005a: per-run token 铸造、绑定与撤销"
status: done
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash)]
created: 2026-10-28
updated: 2026-10-28
---

# F005a: per-run token 铸造、绑定与撤销

> F005（W2）的第一个切片。W2 的验收清单仍以
> [`docs/plans/0002`](../plans/0002-w0-w2-foundation.md) §W2 为单一真相源；
> 本文件只加 slice-specific AC。

## Why

W1 已落 `invocation_credentials` 账本（token hash+salt、run/task/role/session
坐标、active/terminal），但没有任何运行时路径：没有铸造、没有校验、没有
绑定解析。F005a 把这张表变成可用的 per-run 身份：token 只在 run 启动时铸造
一次，服务端从 token 派生身份，工具参数不携带身份字段。

## What

- **migration 006**（additive）：`invocation_credentials.callback_allowlist_json`
  + `token_hash` 唯一索引。
- **mint**（`mintInvocationCredential`）：只为 `running` run 铸造；坐标取自
  run/agent_session/task（不接受调用方自报）；随机 32B secret + 16B salt，
  只存 `sha256(salt:secret)`；token 形如 `ct1.<credentialId>.<secret>`；
  可选落盘 `<dataDir>/tokens/<runId>.token`（0600，原子写）。
- **resolver**（`resolveInvocationToken`）：解析 → 校验 secret（常量时间）→
  校验 active/未过期 → 返回 binding 坐标；绝不相信 tool args 的身份字段。
- **header-only**（`extractInvocationToken`）：只接受 `Authorization: Bearer`；
  query/body 携带 token 一律 `invalid_token`。
- **liveness 两段式**（`assessInvocationLiveness`）：无独立证据时保留
  （active/candidate）；`workerAlive=false` + `run_events` 陈旧 + exact runId
  fence 才判 `stale_invocation`；read 路径不吊销。
- **撤销**（`revokeCredentialsForRun`）：run terminal/interrupted 时把 active
  凭据 terminalize，幂等。
- **tombstone sweep**（`sweepCredentialTombstones`）：terminal 超过 30 天删除，
  active 不动；删除量写 audit。

## Acceptance

- [x] migration 006 additive 落地；旧库升到 version 6 不丢数据。
- [x] mint 只接受 running run；坐标从 run/session/task 派生，明文 token 不落库。
- [x] token 文件 0600、目录 0700、原子写（temp→fsync→rename）。
- [x] resolver：malformed / unknown / wrong-secret / terminal / expired 全部
  typed `invalid_token`。
- [x] header-only：query/body 携带 token 一律拒绝；大小写 header 与数组值兼容。
- [x] 两个 run 的 token 互不冒用；binding 坐标与 run 一致。
- [x] liveness 矩阵：unknown 保留、stale+dead+fence → `stale_invocation`、
  runId 不匹配 → candidate。
- [x] run terminal 撤销凭据且幂等；30d tombstone sweep 只删 terminal。
- [x] `npm --prefix packages/codeteam-daemon test` 93/93（10 files；新增 9）；
  包 build 与 Biome 通过。
- [x] 非作者安全 review（砚砚 approve @ `dece1c1d`，93/93 独立复跑）与 merge
  （PR #29，`4c30a94f`）。

## Out of scope

- MCP server 本体与 token→binding 接线（W7a 复用本 resolver）。
- `callback_allowlist` 的工具层强制（F005b/F005c）。
- worker lease / 多进程 worker registry（W5）；本切片只提供 liveness 判定函数。
- operator credential（F005c）。

## Evidence

- 测试：`packages/codeteam-daemon/test/control-auth.test.ts`（9 条：mint/文件权限/
  resolver 五类拒绝/header-only/跨 run 隔离/liveness 矩阵/撤销幂等/tombstone/
  non-running 拒绝）。
- Review：砚砚 approve @ `dece1c1d`（migration 006、CSPRNG/常量时间、跨 run
  结构隔离、header-only 全绿；timing dummy hash 不要求，属可选 P3）。
- Merge：PR #29 合入 `codeteam-work`（`4c30a94f`），CI 5/5 绿。
- Review 转出的跟进：F005b deny 枚举补 `$CODETEAM_DATA_DIR/tokens/`（token 实际
  落点）与「空 allowlist = deny-all」契约，已写入 F005 文档；`userId` 哨兵值
  记为 v1 已知项。
- 根级 `tsc --noEmit` 在本次宿主机因内存不足被系统终止（swap 已满）；改用
  daemon 包 build（src）+ 含 test 的 scoped tsc：仅命中 `daemon.test.ts` 一条
  既有 unknown 类型问题，本切片文件零错误。此限制在 PR 中如实披露。

[宪宪/deepseek-flash🐾]
