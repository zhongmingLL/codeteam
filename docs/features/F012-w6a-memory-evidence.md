---
feature_ids: [codeteam/F012]
related_features: [codeteam/F004, codeteam/F011]
title: "F012: W6a Memory / Evidence 回源"
status: review
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [墨墨 (Qwen 3.8 Flash), 砚砚 (GLM 5.3 Flash)]
created: 2026-10-29
updated: 2026-10-29
---

# F012: W6a Memory / Evidence 回源

> W6a 交付切片。实施计划与冻结契约见
> [`docs/plans/0014-w6a-memory-evidence.md`](../plans/0014-w6a-memory-evidence.md)；
> schema annex 见 [`docs/architecture/memory-schema.md`](../architecture/memory-schema.md)。

## Why

W5 已 closed。W6 横跨 memory/eval/observability，若单 thread 推进会出现三套
evidence adapter。W6a 先把 **code evidence / source-ref 契约**和独立
`memory.db` 冻结，让 W6b（Eval/Outcome + Harness Eval）与 W6c
（Observability/Trajectory）消费同一份 evidence，而不是各自复制索引。

## What

- `packages/codeteam-daemon/src/memory/`：独立 `CODETEAM_MEMORY_DB`、schema、
  index worker、file/control evidence adapter、FTS5/BM25 passage recall、
  source ref/drill-down、coverage/degraded/stale、session digest、6 个 retrieval
  trigger、内容级 secret redaction。
- `codeteam memory` CLI：`index | status | recall | read | digest | trigger`。
- 冻结契约：`EvidenceSourceRef` / `EvidenceItem` / `EvidenceHit` / `Coverage` /
  `RetrievalTrigger`（`src/memory/contract.ts`）。

## Acceptance

- [x] AC-1 独立 memory DB：`CODETEAM_MEMORY_DB` 生效；无 ATTACH；control DB
  不被写；删除 memory.db 可 rebuild。证据：`memory-schema.test.ts`。
- [x] AC-2 代码 evidence adapter：file 与 control 七类 source 都有 canonical
  `sourceRef`；不新建 truth store。证据：`memory-index.test.ts`、
  `memory-control.test.ts`。
- [x] AC-3 FTS/BM25 + passages：中英文查询命中；passage 级 recall；短查询
  lexical fallback。证据：`memory-schema.test.ts`、`memory-recall.test.ts`。
- [x] AC-4 source ref + drill-down：每个 hit 有 sourceRef + drillDown；read 按
  anchor 返回 passages。证据：`memory-recall.test.ts`。
- [x] AC-5 coverage/degraded/stale：空结果带 `indexed_scope_only`；无索引/索引
  中/失败/control 缺失都有原因；source 变更标 stale。证据：
  `memory-recall.test.ts`、`memory-control.test.ts`。
- [x] AC-6 六个 retrieval trigger：kickoff/design/impl/review/verify/merge/
  completion 的 kinds/query/context block 正确；只含 code evidence。证据：
  `memory-triggers.test.ts`。
- [x] AC-7 secret redaction + path deny：pattern/entropy 命中 skip+audit；绝对
  前缀 deny；read/recall/digest 出口二次脱敏。证据：`memory-redaction.test.ts`、
  `memory-index.test.ts`、`memory-recall.test.ts`。
- [x] AC-8 session digest：run/session digest 有 task/events/reviews/
  verifications/merges + sourceRefs。证据：`memory-digest.test.ts`。
- [x] AC-9 CLI 边界：`memory index/status/recall/read/digest/trigger` 可运行、
  JSON 稳定；recall/digest not-found 为 exit 0，调用方读 JSON `found`/`coverage`。证据：`cli-memory.test.ts`。
- [x] AC-10 契约冻结：`contract.ts` 导出、计划文档 §3 与实现一致；W6b/W6c
  可直接 import。证据：`packages/codeteam-daemon/src/index.ts` 导出 +
  `0014` §3。

## Evidence

- `npm --prefix packages/codeteam-daemon test`：60 files passed / 2 skipped；
  422 tests passed / 2 skipped（2026-10-29，worktree `codeteam-w6a`）。
- `npx tsc --noEmit -p packages/codeteam-daemon/tsconfig.build.json`：通过。
- `biome check`（memory src + tests + CLI wiring）：clean。
- 新增测试：8 个文件、42 个测试（schema/redaction/index/control/recall/
  triggers/digest/CLI）。
- 独立 review：墨墨（memory/reuse/真实路径）与砚砚（provenance/redaction）均在 `aa78adcb8` 给出 approved-with-findings；P2/P3 修复后待复核新 HEAD。
- PR：#62（`feat/w6a-memory-evidence` → `codeteam-work`，基线 `6ac622ad0`）。

## Review follow-ups (2026-10-29)

第一面（墨墨，memory/reuse/真实路径）与第二面（砚砚，provenance/redaction）均在
`aa78adcb8` 给出 approved-with-findings；无 P1/blocker。

- **P2 high_entropy 误报整篇 skip**：`redaction.ts` 改为按 `/` 分段逐段评估、
  `-` 不参与 class 计数、`sha(1|256|512)?-<hex>` 显式豁免；新增真实串
  RED→GREEN（F011 path、W5a report `sha256-<hex>`）。真实 repo index：
  114 sources / 0 errors，原两篇 skip 文档均恢复索引。
- **P2 digest 出口绕过 redaction**：`digest.ts` 对 `verifications[].command`、
  `task.title`、`task.why` 套 `redactSecrets`；RED→GREEN。
- **P3 isStale artifacts 未过 path policy**：统一 `evaluateMemoryPath`；新增测试。
- **P3 digest 缺 `merges` 表守卫**：补 `hasTable`，缺表降级为空列表；新增测试。
- **P3 metadata_json 存未扫描 provenance**：artifact `provenance_json` 写入前
  redact；schema annex 注明 W7 surfacing 前必须再过 redact；新增断言。
- **P3 digest rc=0 语义**：在 `0014` §7 与 schema annex 记录 W7 必须读 JSON
  `found`/`coverage`，不得用 exit code 判断源存在。
- **P3 keywords round-trip**：`keywords` 改用 U+001F 分隔，读取对 legacy
  whitespace 回退；新增含空格 keyword 测试。

## Out of scope

- 6B Eval/Outcome、6F Harness Eval；6E Observability/Trajectory + F150/F130。
- 6C lessons/decisions 写面；6D cue plane/context presentation。
- 个人记忆、diary/dream、person/relationship、跨项目偏好。
- thread messages / run_events 对外 evidence scope（session digest 例外：按
  canonical control 数据即时读取，不写入 memory.db）。
- W7 read API/Console。

## Risk

数据/契约面。memory.db 是纯派生索引，control/file 仍是 truth；删除 memory.db
即回滚。control adapter 只读 canonical DB，不新增 migration。主要风险是
secret 泄漏与 stale 被当 current，已由索引 skip、出口 redaction、coverage/
per-hit stale 覆盖；待独立 review 覆盖最终实现。

[宪宪/deepseek-flash🐾]
