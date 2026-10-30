---
feature_ids: [codeteam/F015]
related_features: [codeteam/F008, codeteam/F009]
title: "F015: A2A E2E Foundation"
status: done
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash)]
vision_guard: 墨墨 (Qwen 3.8 Flash)
created: 2026-10-30
updated: 2026-10-30
source_plan: "docs/plans/0017-a2a-e2e-foundation.md"
source_report: "docs/reports/2026-10-30-a2a-e2e-foundation.md"
---

# F015: A2A E2E Foundation

> 本 feature 是 A2A readiness report 的 P0 实现切片，不是 W7 wave close。
> W7a 剩余的 read/wait extension tools、operator API/Console 与 W7 wave
> operator signoff 仍待后续。

## Why

`docs/reports/2026-10-29-a2a-e2e-readiness.md` 的结论是：codeteam 的 A2A
handler 语义已有实现和 in-process 测试，但没有生产 composition root 把
store、dispatch、worker 接起来；真实 producer 的 source message 缺 `taskId`，
没有 AgentSession/worktree 生产入口，worker 工具面没有 `a2a_send`/
`handoff_*`，`handoff_complete` 也没有生产完成器。因此当时**不能**跑真实
handler/daemon/worker A2A E2E。

## What

- production composition root：`startDaemon` 打开 `ControlStore`，启动
  `WorkerRuntime`、`DispatchService`、drain/sweep 与 startup recovery。
- producer/task 绑定：`thread post --to` 要求 `--task`；`backlog dispatch`
  原子创建 work task；未 prepare 时 `dispatch_not_ready` defer，不 dead-letter。
- `task prepare` 幂等创建 worktree lease + active AgentSession；`session list/show`
  可查。
- worker 五工具（`a2a_send` + `handoff_*`）经 0600 control socket，token →
  credential → run/session/worker → principal → handler。
- server-owned handoff terminal resolver；`handoff_complete` 只写 candidate，
  agent 不能自签 verified。
- `a2a_send` requestId 幂等、canonical loop guard、non-holder 最小化、
  execution role、empty allowlist fail-closed。

## Acceptance / Evidence

- [x] P0-1 producer/task 绑定：`cli-producer-binding.test.ts` 覆盖 backlog
  message taskId、thread post taskId、未 prepare defer、无 dead-letter。
- [x] P0-2/3 AgentSession/worktree 入口：`task prepare` 幂等创建/复用
  sessions；真实 worker 使用该 worktree。
- [x] P0-4 worker A2A tool surface：`control-a2a-control.test.ts`、
  `control-a2a-worker-e2e.test.ts`、`daemon-a2a-e2e.test.ts`。
- [x] P0-5 worker roster/A2A 认知：`workers/prompt.ts` 注入 peers、A2A 规则、
  assigned handoff；真实 worker E2E 能选 tool/claim/complete。
- [x] P0-6 terminal resolver：`control-handoff-terminal.test.ts`；真实 worker
  E2E handoff consumed。
- [x] S1 token→principal→handler：wrong worker/foreign run/non-A2A tool/
  allowlist 拒绝。
- [x] S2 credential 边界：A2A tool 不能借 token 调 merge/approval。
- [x] S4 requestId ledger：migration 016 + replay/conflict 测试。
- [x] P1-1 execution role、P1-2 loop guard/parallelIntent/non-holder。
- [x] 真实 CLI → daemon → 真实 `pi --mode rpc` + mock provider E2E：
  `test/daemon-a2a-e2e.test.ts`，含负路径与 cold-boot recovery。

## Close record

- PR #72 squash merged at `b941dde32804814917ab68230c0d9bb74e614c61`；
  close PR #73 merged at `5c30f2200a33a5073c88ac2a7e7c295b2e42ad1a`。
- Reviewed heads：`fa29a1bcc`（烁烁基础面）、`c8f929a5f`（砚砚 fix 复审、
  墨墨刷新 guard）。
- 烁烁 A2A/session/worker approved；砚砚 identity/custody/security approved；
  墨墨 vision guard pass。
- Post-merge：daemon 82 files passed / 2 skipped，542 tests passed / 2 skipped；
  build 与官方 biome gate 通过。
- Residual 与 `docs/plans/0017-a2a-e2e-foundation.md` §6 一致。

## Residual

- worktree 目前是隔离文件目录 lease，不是真实 git worktree clone：W7a/ops。
- drain loop 是短轮询 + dirty flag，跨进程 producer 无事件通知：W7a transport。
- MCP/stdio、HTTP/WS/SSE、Console/W7b：MCP 已按 #74 决策移出 v1；HTTP/Console 归 W7a/W7b。
- cross-thread A2A、`handoff_return`/`handoff_replace`、parallel 全 holder
  终端策略：后续独立 slice。
- guide 的真实 RPC steer/follow_up：W7a run control。
- per-profile provider account/credential 路由、OS 级孤儿 pi 进程 supervisor：
  ops/accounts design。

## Relationship to W7a

F015 交付了 5 个 A2A/custody extension tools；W7a 剩余的 8 个 read/wait
extension tools 与 typed auth reason、multi-active credential、wait owner
fence、read/wait 实现是后续 extension-first slice。MCP server 不在 v1；
仅在出现命名的、不能加载 pi extension 的外部 consumer 时做 conditional
sibling adapter（`docs/reports/2026-10-30-mcp-vs-extension-tool-necessity.md`）。

## Out of scope

- MCP/stdio/HTTP/WS/SSE、Console/W7b、W8。
- cross-thread A2A、live provider 质量验收、第二套 queue/message/handoff store。

[宪宪/deepseek-flash🐾]
