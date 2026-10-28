---
cell: observability
title: "P1 复用卡：Observability / Trajectory"
doc_kind: reuse-card
status: approved
operator_signoff: "DP-OBS-1=A, DP-OBS-2=A, DP-OBS-3=B (2026-10-25)"
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
created: 2026-10-25
updated: 2026-10-29
---

# P1 复用卡：Observability / Trajectory

## 结论

| 项 | 值 |
|---|---|
| decision | **R1 适配复用** |
| priority | **P1（2026-10-25 operator 提前到 A3）** |
| codeteam W | W6（runtime telemetry/health + F150 tool counters + F130 log governance）；W7（operator trajectory/observability surface） |
| 一句话 | 复用 F153 raw OTel/redaction/allowlist 与 F299 `inv:<invocationId>` trajectory 读面；F150/F130 在 W6 做 parity，但保持独立 store，只按现有 correlation key join，不复制事件。 |
| operator 签字 | [x] A/A/B（2026-10-25）；W6 含 F150/F130 parity |

## 覆盖

- canonical: F153 / F299 / F150 / F130
- v1 取用：F153（OTel init、instruments、metric allowlist、A-D redaction、local trace store、`/ready`、telemetry routes）、F299（`inv:` trajectory read model、drill-down）、F150（`tool_usage_counters`）、F130（Pino/JSON logs + rotation/retention/redaction）。
- v1 明确 drop：F299 完整 semantic card UI（先做只读 trajectory 读面）、F192 eval verdict/measurement、F233 值班简报/feat 轨迹重建。

## Current truth

- **F153**：OTel SDK init；`metric-allowlist` 强制属性白名单；A-D 四类 redaction；`LocalTraceStore` 是 24h/10k span 内存 ring，按 traceId/HMAC invocationId/cat 查询；Prometheus 默认开，OTLP 可选；`/ready` 与 `/api/telemetry/*` 是 operator 入口。
- **F299**：唯一 human-facing invocation trajectory；`inv:<invocationId>` 是 cross-owner join key；trajectory 从 canonical transcript/run truth 投影，不复制事件；drill-down 到 trace/evidence。
- **F150**：Redis `tool-stats:{date}:{catId}:{category}:{toolName}` 独立 counter；不是 F153 projection。
- **F130**：Pino stdout + rolling `api.log`，独立 `REDACT_PATHS`；OTel log 不替代 Pino。
- **F233**：feat trajectory failed-close；不得从非 canonical ledger 重建 trajectory。

## codeteam mapping

- v1 = **local-first observability**：OTel local trace ring + Prometheus snapshot + `/ready`；OTLP 默认关，只作为可选 export。
- trajectory = 从 codeteam `runs`/`run_events`/`messages`/`queue_entries` 的 canonical truth 投影；`inv:<invocationId>` join trace；不建第二事件账本。
- 红action：A-D 边界在 telemetry init；不把 raw prompt/credential/token 写入 trace/log；invocationId HMAC 后再进 trace store。
- F150/F130：W6 建独立 `tool_usage_counters` + `/api/tool-usage`；日志走 JSON/Pino 文件 + rotation/retention + `REDACT_PATHS` + `/api/logs/tail`；保持独立 store/redaction，只按 correlation key join。
- 失败：telemetry init 失败只降级 observability，不阻塞 control plane；`/ready` 必须明确 telemetry 状态，不能把“没初始化”报成 healthy。

### W6c implementation status（2026-10-29，F013 / plan 0015）

- **F153 适配**：不引入 `@opentelemetry/*`；按 pi 的 vendor-neutral telemetry 语义
  （显式 context、无全局 span）实现本地 OTel-shaped DTO + 10k/24h ring +
  Prometheus 文本快照；pi-telemetry 包不成为运行时依赖（callback 适配器不提供
  ring 投影/淘汰）。A-D redaction、metric label
  allowlist、tool span metadata allowlist 在 ingest 边界；OTLP/HTTP JSON exporter
  默认关，启用需显式 endpoint。HMAC salt 为 `<dataDir>/telemetry-salt`（0600）。
- **F299 适配**：`TrajectoryService` 只读 `runs`/`run_events`/`messages`/
  `queue_entries`；`inv:`=`runs.id`；ring miss 返回 `trace_unavailable:ring_miss`，
  telemetry 关闭返回 `telemetry_disabled`。轨迹步骤只带 allowlist 元数据与内容
  digest+bytes，不内联正文。
- **F150 适配**：SQLite `tool_usage_events`（幂等键=`run_events.id`）+
  `tool_usage_counters`（day/profile/category/tool 主键）；`toolUsage.report()`
  冻结为 W6b/W7a 可消费契约；retention 默认 90 天。无 Redis 依赖。
- **F130 适配**：0600 JSONL `logs/daemon.log` + 大小轮转 + 天数/文件数保留 +
  `tail()`；字段为 Pino-compatible JSON，但不引入 `pino` 依赖。日志保留本地
  correlation id；trace 的 Class C 标识才 HMAC。
- **readiness**：daemon `GET /ready` 同时报告 control-plane 与 telemetry 组件；
  telemetry degraded 时仍 200 + `status:"degraded"`；control-plane 未 ready 才 503。
  `GET /metrics` 提供 Prometheus 快照；`/health` 保持 W5d 契约。
- **明确后置**：`/api/telemetry/traces`、`/api/invocations/:id/trajectory`、
  `/api/tool-usage`、`/api/logs/tail` 的 operator auth/HTTP/Console 面归 W7a；
  `/request-generations` 归 W7+。契约冻结在
  `packages/codeteam-daemon/src/observability/contracts.ts`。

## 风险与回滚

- **P1**：raw prompt/credential 进入 trace/log。处置：redaction 在 init 边界；metric allowlist；trace store 只存 redacted DTO。
- **P1**：从非 canonical ledger 重建 trajectory，重复 F233 LL-099。处置：trajectory 只读 `runs`/`run_events`/`messages`/`queue_entries`；不建第二事件账本。
- **P2**：telemetry 开销/采样影响 control plane。处置：默认 local ring + bounded metrics；OTLP 可选、采样可配。
- **P2**：F150/F130 被误当 OTel projection。处置：独立 counter 表/文件 store 与 redaction；只按现有 key join。
- **P2**：tool counter 双计数/日志泄密。处置：counter 幂等 increment；日志独立 REDACT_PATHS + rotation/retention。
- **回滚**：关闭 OTel/trajectory 读面即可；不影响 control-plane 表。已写 trace/log 按 retention 清理，不迁移 clowder telemetry。

## Review

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | OTel init/instruments、local trace、`/ready`、correlation | accept；P2/P3 已回写 |
| 砚砚 | redaction/A-D、HMAC、secret/tenant、fail-closed | accept-with-modify；P2/P3 已回写 |
| 墨墨 | operator trajectory、trace drill-down、W7 可读性 | accept-with-modify；P1/P2/P3 已回写 |
| operator | telemetry backend / trajectory scope / tool-log scope | 已签：A/A/B（2026-10-25） |

[宪宪/deepseek-flash🐾]
