---
feature_ids: [codeteam/F009]
title: "F009: W5b RPC Worker Runtime"
status: done
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash)]
created: 2026-10-28
updated: 2026-10-28
---

# F009: W5b RPC Worker Runtime

> W5 契约与总验收以
> [`docs/plans/0004-w5-w8-scale-product.md`](../plans/0004-w5-w8-scale-product.md)
> §W5 为单一真相源；W5b 实施计划、冻结投影与 AC 映射见
> [`docs/plans/0011-w5b-rpc-worker-runtime.md`](../plans/0011-w5b-rpc-worker-runtime.md)。

## Why

W5a 已把 dispatch queue / one-terminal / response bubble / A2A tool surface /
custody / wait 冻结在可测试的 fake `AgentExecutor` 上。还没有真实 pi RPC
worker，也没有 worker registry、liveness、sticky、re-attach 或控制面工具策略。
W5b 把执行内核换成真实 worker，同时保持 W5a 的投影不变；它不碰 W5c 的
readiness/DAG/预算/worktree pool/daemon lifecycle/managed-work。

## What

- `pi --mode rpc` worker harness：启动包装、extension 装配、per-run token
  0600 注入、JSONL 严格分帧、事件回流 `run_events`、优雅关停。
- `RpcAgentExecutor` 替换 fake executor；worker crash / 可重试失败有 typed
  错误，one-terminal 与 response bubble 不变。
- worker registry：workerId/role/capacity/active sessions/heartbeat/lease；
  stale worker 的 running runs → interrupted，session → re_attach_pending。
- sticky routing `agentSessionId → workerId`；显式迁移优先 pi session 文件，
  失败 fresh + task capsule，记录 `session_reattach_failed`。
- 控制面 Unix socket：per-run token → policy；控制面不可用时非只读工具
  fail-closed，只读按 allowlist 继续。
- retry / dead-letter / human escalation：重试生成新 Queue Entry，不建第二队列。

## Acceptance

以 `0004` §W5 的 W5b 适用项为准；逐条映射见 `0011`。本文件只记录
slice-specific 证据，不把 W5c/W7a 项冒充完成。

## 当前进展

- 2026-10-28：W5b kickoff；`0011` 与 F009 建立；冻结 D1–D6、worker
  registry/capacity 投影与 RPC executor 契约。
- 2026-10-28：migration 012 + worker store/registry + RPC harness/extension +
  control plane + executor + retry/dead-letter/recovery/drain 实现完成。
- Review follow-up：烁烁 P2-1（lease 过期 online worker 不复用）与 P2-2
  （fresh 降级 response 正文标注）已修；P3 收口 body 措辞、死代码与
  run/session 一致性校验。
- Review follow-up #2：砚砚 P2-3（RPC 残留帧 max-frame 保护不可达）已修，
  并补无换行超限负例；P3 收口 heartbeat 冗余、`model_error` 有界重试、
  `read` 缺 path fail-closed。
- 验证：daemon 包 40 files passed + 2 skipped，316 tests passed + 2 skipped；
  W5b 定向 5 files + 1 skipped，25 tests + 1 skipped；daemon scoped
  `tsc --noEmit`、`build:offline`、Biome 通过。根级 `tsc --noEmit` 最终复跑
  被宿主内存终止（exit 137），与 F005a 同类环境限制。
- 真实 pi RPC + mock provider：implement→review、control-plane down
  （write deny / read continue）、真实 session 重挂均通过。
- 未通过项：env-gated live provider smoke 在本机因 OpenRouter key
  `401 Missing Authentication header` 未跑通；默认 skip，不作为 CI 门禁。
- 计划中的 residual ledger 见 `0011`。
- 验证报告：[`docs/reports/2026-10-28-w5b-rpc-worker-runtime.md`](../reports/2026-10-28-w5b-rpc-worker-runtime.md)。

## Close record（2026-10-28）

- **Merge**：PR #53 squash merged into `codeteam-work` at
  `aeb1bf834094975963b6f5bc4626f780430a3ac3`；reviewed HEAD
  `028785a137b0a1b9c0603332acbde3051e691641`，base `c30f9aafb`。
  Squashed tree 与 reviewed tree 同为 `8ff2cb656…`，kernel packages
  （coding-agent / ai / agent）零 diff。
- **Review**：烁烁 A2A/session/worker approve
  （`0001793195829430-003692-995023f1`）；砚砚 code/security approve
  （`0001793195864326-003694-85321350`）。P2-1（lease freshness）、
  P2-2（degraded 可见性）、P2-3（残留帧 max-frame 保护）均在最终 HEAD 闭合；
  无 open P1/P2。
- **Vision guard**：墨墨（非作者非 reviewer）approve
  （`0001793196631830-003697-9e8006eb`）；独立核实 tree-hash 一致、daemon
  316+2、W5b 25+1、Biome 干净，未发现 overclaim 或 W5c/W7a 冒领。
- **Post-merge acceptance**：merged tree 隔离环境 daemon 40 files passed +
  2 skipped，316 tests passed + 2 skipped；W5b 定向 25+1；Biome、scoped
  TSC、`build:offline` 通过；PR CI 4/4 green（run 40700930998）。
- **Boundary**：W5b 交付真实 `pi --mode rpc` executor、worker
  registry/sticky/re-attach、control plane/tool policy、retry/dead-letter；
  W5c readiness/DAG/预算/worktree pool/daemon lifecycle 与 W7a HTTP/MCP
  transport 仍不在本 feature。residual ledger 见 `0011`。

## Out of scope

- task readiness/DAG、预算、worktree pool/GC、F139、daemon lifecycle、
  deployment wait、PR tracking/managed-work（W5c）。
- HTTP/MCP transport（W7a）。
- 第二 queue / 第二 message store / 第二 worker registry。

