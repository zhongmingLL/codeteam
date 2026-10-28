---
feature_ids: [codeteam/F013]
title: "F013: W6c Observability / Trajectory"
status: in_review
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
created: 2026-10-29
updated: 2026-10-29
---

# F013: W6c Observability / Trajectory

> W6 总契约以 `docs/plans/0004-w5-w8-scale-product.md` §W6 为单一真相源；
> 本 feature 只承接 6E Observability/Trajectory + F150/F130 parity。详细
> 冻结见 [`docs/plans/0015-w6c-observability-trajectory.md`](../plans/0015-w6c-observability-trajectory.md)。

## Why

W5 已让 daemon 能并行跑 task、worker 和 custody，但 operator 仍看不到“这轮
发生了什么”：没有本地 trace、没有单次 invocation 的可重放轨迹、没有 tool
使用统计，也没有可轮转/保留的结构化日志。直接照搬 clowder 的 OTel/Pino/
Redis 会引入第二套 truth store 和外部依赖；本 slice 只复用契约与语义，落在
codeteam 的 SQLite + 本地文件边界内。

## What

- **Telemetry runtime**：HMAC salt 0600 文件；A-D redaction；metric label
  allowlist；tool span metadata allowlist；local OTel-shaped trace ring
  （10k spans / 24h）；Prometheus 文本快照；OTLP 默认关。
- **Trajectory**：只从 canonical `runs`/`run_events`/`messages`/
  `queue_entries` 投影；`inv:` = `runs.id`；ring miss 显式
  `trace_unavailable`。
- **F150 parity**：`tool_usage_counters` 幂等 increment + retention +
  report 契约；event id 作为幂等键。
- **F130 parity**：0600 JSONL 日志 + rotation/retention + redaction + tail
  契约。
- **Readiness**：daemon `/ready` 显式报告 telemetry 组件状态；`/metrics`
  提供 Prometheus 快照；`/health` 保持 W5d 契约。
- **W6b/W7a 契约**：冻结 trace/trajectory/tool-usage/log 只读 DTO，
  W7a 只加 HTTP/auth/Console 适配。

## Acceptance

- [ ] AC-1: trace ring 默认 10k/24h，可查询；Prometheus 快照可渲染；
      `/ready` 与 `/metrics` 可用。
- [ ] AC-2: OTLP 默认关；启用需显式 endpoint；HMAC salt 0600；权限不符
      fail closed。
- [ ] AC-3: trajectory 只读 canonical 四表；`inv:`=`runs.id`；trace
      命中/`ring_miss`/`telemetry_disabled` 三态明确。
- [ ] AC-4: A-D redaction + metric/tool span allowlist；raw prompt/diff/
      file content/credential 不进 trace/log；有 leak tests。
- [ ] AC-5: 同一 `run_events.id` 重复记录 tool usage 只计一次；retention
      可清理；report 可按时间/profile/category 聚合。
- [ ] AC-6: JSONL 日志 0600、rotation、retention、tail；A/B redaction。
- [ ] AC-7: W6b 可消费的只读契约冻结并有 contract tests；W7a 未提前接
      HTTP/Console。
- [ ] AC-8: telemetry init 失败只降级，不阻塞 daemon；`/ready` 不把未初始化
      报成 healthy。
- [ ] AC-9: 不建第二 truth store；不碰 W6a memory.db/evidence adapter。
- [ ] AC-10: `/request-generations` 明确留 W7+。

## Current progress（2026-10-29，PR #63，待独立 review）

- 代码落点：`packages/codeteam-daemon/src/observability/`（contracts/redaction/
  salt/trace-store/tracer/metrics/otlp/logs/trajectory/runtime）、
  `src/control/stores/tool-usage.ts` + migration 014、daemon `/ready` `/metrics`、
  worker event sink/executor 接线、W6b/W7a 只读契约导出。
- PR：[`#63`](https://github.com/zhongmingLL/codeteam/pull/63)，
  base `codeteam-work` @ `6ac622ad0`；CI 5/5 pass（`changes` /
  `check-contributor` / `supply-chain` / `mcp-conformance` /
  `build-check-test`）。
- 本地验证：
  - `NODE_ENV=development npm run build:offline`：exit 0。
  - `npx tsc --noEmit`（root）：exit 0。
  - `npx biome check`（changed files）：clean。
  - `packages/codeteam-daemon`：**62 files passed + 2 skipped；430 tests
    passed + 2 skipped**（含 11 个 W6c observability test files）。
- 尚未完成：独立非作者 review（砚砚 security/redaction/provenance；墨墨
  reuse/真实路径/可解释性）、PR/merge、operator 可见验收。不得把本段当作
  feature close。

## Dependencies

- W1 control schema（`runs`/`run_events`/`messages`/`queue_entries`）。
- W5b worker event sink / W5d daemon `/health`。
- pi `@earendil-works/pi-telemetry` 的 vendor-neutral 语义（只借契约，不引
  外部 OTel SDK）。
- W6a 的 source-ref 契约仅在 evidence drill-down 需要时消费；本 slice 不
  依赖 memory.db。

## Risk

- trace/log 泄密：ingest 边界 redaction + allowlist + leak tests。
- ring 被误当账本：契约显式 `trace_unavailable`；trajectory 以 canonical
  表为唯一真相。
- telemetry 阻塞 control plane：init 失败降级；OTLP fire-and-forget。
- 并行编号冲突：W6a `0014`/`F012`、W6c `0015`/`F013`、W6b `0016`/`F014`
  预留；冲突时以先 merge 为准并重编号。

## Out of scope

- W6a memory/evidence、W6b eval/harness-eval、W7 HTTP/Console、
  W8 GitHub。
- trace 持久化、第二事件账本、跨进程 trace aggregation、Pino 依赖、
  `/request-generations`。
