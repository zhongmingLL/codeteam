---
title: "observability 架构复用检视"
doc_kind: architecture-review
status: approved
operator_signoff: "DP-OBS-1=A, DP-OBS-2=A, DP-OBS-3=B (2026-10-25)"
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
source_cell: observability
source_card: ../../reuse/observability.md
template: ../0004-reuse-architecture-review-plan.md
---

# observability 架构复用检视

## 1. 总结

| 项 | 结论 |
|---|---|
| clowder feature 范围 | F153（OTel init/instruments/metric allowlist/A-D redaction/local trace/`/ready`/telemetry routes）、F299（`inv:<invocationId>` trajectory 读面）、F150（tool usage counters）、F130（Pino log governance）。 |
| codeteam 复用总结 | **R1 适配复用**。复用 F153 的 raw telemetry/redaction/allowlist 与 F299 的 `inv:` trajectory 读面；F150/F130 按 operator DP-OBS-3=B 在 W6 做 parity，保持独立 store，只按现有 correlation key join，不复制事件。 |
| codeteam W | W6（telemetry/health/trace + F150 tool counters + F130 log governance）；W7（operator trajectory/observability surface）。 |
| 一句话 | codeteam 只做 local-first observability：trace/metrics/health 在本地 bounded store，trajectory 从 canonical run/message truth 投影，不建第二事件账本。 |
| 明确不含 | F299 完整 semantic card UI、F192 eval verdict、F233 值班简报/feat 轨迹重建、跨租户 telemetry backend。F150/F130 已由 DP-OBS-3=B 纳入 W6 parity。 |

**组件立场**

| 组件 | 立场 | codeteam 处理 |
|---|---|---|
| `initTelemetry` / instruments / metric allowlist | `reuse now` | 本地 OTel init；allowlist 保留；OTLP 默认关 |
| A-D redaction（span/log） | `reuse now` | init 边界 redaction；raw prompt/credential/token 不入 trace/log |
| `LocalTraceStore` | `reuse now` | bounded in-memory ring（默认 10k spans/24h）；query by traceId/HMAC invocationId/profileId |
| `MetricsSnapshotStore` / `/api/telemetry/*` | `adapt now` | local snapshot + read-only routes；operator 可查 |
| F299 trajectory `inv:` | `adapt now` | 从 codeteam runs/run_events/messages 投影；不复制事件 |
| `TrajectoryPanel` full semantic cards | `defer→W7+` | P0 只做 invocation trajectory + trace drill-down |
| F150 tool usage counters | `adapt now` | W6 建独立 `tool_usage_counters`（day/profile/category/tool/count）+ 只读 route；不是 OTel projection |
| F130 Pino logs | `adapt now` | W6 结构化 JSON/Pino + rotation/retention + REDACT_PATHS + 只读 tail；与 OTel 独立 |
| F192/F233 eval/简报 trajectory | `drop` | 不重建非 canonical trajectory |
| OTLP/Prometheus | `adapt now` | Prometheus local 默认；OTLP 可选，不阻塞启动 |

## 2. clowder 架构

### 2.1 架构图

```text
API code / route / tool span
        │  OTel SDK
        ▼
RedactingSpanProcessor / RedactingLogProcessor
  ├─ Class A credentials
  ├─ Class B prompt/tool args
  ├─ Class C identifiers → HMAC
  └─ Class D safe metadata
        │
        ├─ LocalTraceStore (in-memory ring, 24h/10k)
        ├─ Prometheus exporter + MetricsSnapshotStore
        ├─ optional OTLP trace/metric/log exporters
        └─ /api/telemetry/traces / step-summary / metrics

F299 invocation trajectory
  ├─ /api/invocations/:invocationId/trajectory
  ├─ /api/invocations/:invocationId/request-generations
  │  (clowder only; codeteam v1 defers request-generations)
  └─ invariant join key: inv:<invocationId>

F150 tool-stats (Redis)     F130 Pino api.log
  └─ independent stores/redaction; join only by existing keys
```

### 2.2 数据流

1. **Telemetry init**：启动时校验 HMAC salt；失败则关闭 OTel SDK 并记录 error，不阻塞 API。Redaction 必须始终生效，即使 OTLP 关闭。
2. **Spans/metrics**：instrumentation 生成 span/metric；metric attribute allowlist 在 SDK View 层强制；span/log 经 redactor 后进 local ring 或 exporters。
3. **Trace query**：operator 用 traceId 或 raw invocationId + HMAC 查询 local ring；返回 redacted DTO，不返回 raw prompt/credential。
4. **Trajectory**：F299 用 `inv:<invocationId>` 从 canonical transcript/run truth 投影；drill-down 到 trace/evidence；不复制事件。
5. **Tool stats/logs**：F150 从 `ToolUsageCounter.recordToolUse()` 写 Redis counter；F130 Pino 双写 stdout/api.log；二者有独立 retention/redaction，不能假设从 telemetry 可推导。
6. **Health**：`/ready` 汇合 runtime readiness 与 telemetry state；telemetry 未初始化要显式 degraded，不报 healthy。

### 2.3 状态机 / 生命周期

**A. Telemetry state**

```text
disabled ──init success──► enabled ──shutdown──► disabled
   │                         │
   │                         ├──HMAC salt invalid──► disabled + error
   │                         └──exporter failure──► enabled + degraded
   └──OTLP off（default）──► local-only enabled
```

**B. Trace retention**

```text
span stored ──age > maxAge(24h)──► evicted
      │
      └──count > maxSpans(10k)──► oldest evicted
```

**C. Trajectory read**

```text
invocationId → canonical run/message/transcript truth
  ├─ trajectory DTO（semantic before raw）
  ├─ trace drill-down by traceId/inv:
  └─ if truth unavailable → explicit unavailable, not reconstructed
```

### 2.4 关键数据结构

```ts
// packages/api/src/infrastructure/telemetry/local-trace-store.ts:12,43,69,70,72
interface TraceSpanDTO { traceId; spanId; name; attributes; startTime; endTime; status; ... }
interface TraceQueryFilter { traceId?; invocationId?; catId?; limit?; }
// codeteam: catId→profileId/actorRef
const LOCAL_TRACE_STORE_DEFAULT_MAX_SPANS = 10_000;
const LOCAL_TRACE_STORE_DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// packages/api/src/infrastructure/telemetry/init.ts:32,91
interface TelemetryConfig { enabled?; debugMode?; otlpEnabled?; ... }
function initTelemetry(config?: TelemetryConfig): TelemetryHandle;

// packages/api/src/infrastructure/telemetry/metric-allowlist.ts:50,98
const ALLOWED_METRIC_ATTRIBUTES: ReadonlySet<string>;
function createMetricAllowlistViews(): ViewOptions[];
```

### 2.5 Current truth 与代码路径

| # | 事实 | 代码锚点 |
|---|---|---|
| T1 | `initTelemetry` 校验 HMAC salt；失败关闭 OTel；redaction 在 OTLP 关闭时仍生效 | `packages/api/src/infrastructure/telemetry/init.ts:91`、`:106`、`:132`、`:147` |
| T2 | metric allowlist 在 SDK View 层强制；非允许属性丢弃 | `packages/api/src/infrastructure/telemetry/metric-allowlist.ts:50`、`:92`、`:98`、`:111` |
| T3 | A-D redaction 覆盖 span attributes/events 与 log records | `packages/api/src/infrastructure/telemetry/redactor.ts:15`、`:74`、`:101`、`:145` |
| T4 | `LocalTraceStore` 是 24h/10k 内存 ring；按 traceId/HMAC invocationId/cat 查询 | `packages/api/src/infrastructure/telemetry/local-trace-store.ts:12`、`:69`、`:70`、`:72`、`:96` |
| T5 | `/api/telemetry/traces`、`/traces/stats`、`/step-summary` 是只读 operator 路由 | `packages/api/src/routes/telemetry.ts:56`、`:83`、`:108`、`:119` |
| T6 | F299 唯一 trajectory 路由：`/api/invocations/:invocationId/trajectory` 与 `/request-generations`（clowder；codeteam v1 只取前者，generations defer） | `packages/api/src/routes/invocation-trajectory-routes.ts:60`、`:93` |
| T7 | `inv:<invocationId>` 是 cross-owner join key；trajectory 从 canonical transcript/run truth 投影 | `docs/architecture/ownership/cells/observability.md` Canonical Owner |
| T8 | F150 tool-stats 是 Redis 独立 counter；F130 是 Pino 独立 log；不是 F153 projection | `docs/architecture/ownership/cells/observability.md` Canonical Owner |
| T9 | F233 feat trajectory failed-close；不得从非 canonical ledger 重建 trajectory | `docs/features/F233-ball-custody-observability.md:14`；observability cell Do NOT Unify With |
| T10 | codeteam 0001 当前无 telemetry/trajectory 表；A3-3 是首个 observability schema | `codeteam/architecture/0001-codeteam-architecture-v1.md` §12.2（无 telemetry 表） |

### 2.5.1 上游已知缺口 → 本卡处置

| # | 上游缺口 | 影响 | 本卡处置 |
|---|---|---|---|
| G1 | local trace store 是内存 ring，重启丢 | 不能做历史审计 | v1 接受；需要历史时可选 OTLP/持久化，不在 v1 建第二事件账本 |
| G2 | OTLP 可选、Prometheus 默认 | 外部 backend 不确定 | local-first；OTLP 只做 optional export |
| G3 | trajectory 依赖 transcript/run truth | 缺 truth 时无法重建 | 显式 unavailable；不从日志/receipt/trace spans 猜；messages 是 canonical 投影源 |
| G4 | F150/F130 独立 store/redaction | 容易误当 telemetry projection | 保持独立；只按现有 key join |
| G5 | redaction 覆盖 Span attributes/events | 新 instrument 可能漏 | init 边界 + allowlist + contract test |
| G6 | F299 完整 semantic cards 是大 UI | W7 范围膨胀 | P0 只做 trajectory + trace drill-down；semantic cards 后接 |
| G7 | telemetry init 失败可能被当 healthy | 假健康 | `/ready` 显式 telemetry degraded；不阻塞 API |
| G8 | F233 简报已 sunset | 不要重建值班/feat 轨迹 | drop；trajectory 只从 canonical truth 读 |

## 3. codeteam 架构

### 3.1 架构图

```text
codeteam API / run / queue / tool call
        │  OTel SDK (local-first)
        ▼
Redacting processors
  ├─ A-D redaction
  ├─ metric allowlist
  └─ HMAC invocation/thread identifiers
        │
        ├─ LocalTraceStore (bounded ring)
        ├─ MetricsSnapshotStore + /ready
        └─ optional OTLP export (off by default)

Tool usage (independent)
  └─ tool_usage_counters(day, profile, category, tool, count) + /api/tool-usage

Structured logs (independent)
  └─ JSON/Pino files + rotation/retention + REDACT_PATHS; /api/logs/tail

Trajectory read model
  ├─ runs / run_events / messages / queue_entries (canonical truth)
  ├─ inv:<invocationId> join trace
  └─ /api/invocations/:invocationId/trajectory

Structured logs (independent)
  └─ JSON/Pino + REDACT_PATHS + invocationId/threadId/traceId correlation
```

### 3.2 数据流

1. **Init**：daemon 启动 `initTelemetry`；OTLP 默认关；HMAC salt 从 `CODETEAM_DATA_DIR/telemetry/hmac-salt`（0600）读取，缺失/无效 → telemetry disabled + error，API 继续。salt 本体不进 env（W2 零 secret）；env 只承载文件路径。
2. **Instrument**：route/queue/run/tool 边界生成 span/metric；metric 只带 allowlist 属性；span/log 先 redaction 再导出。
3. **Trace query**：operator credential / console session 用 traceId 或 raw invocationId（服务端 HMAC）查询 local ring；run token 403；返回 redacted trace DTO；limit 有界。`TraceQueryFilter.profileId`/`actorRef` 替代 clowder catId。
4. **Trajectory**：`inv:<invocationId>` = `inv:` + `runs.id`（路由参数就是 run id，不造独立 invocation 实体）；`/api/invocations/:invocationId/trajectory` 从 `runs`/`run_events`/`messages`/`queue_entries` 读 canonical truth；`inv:` join trace；不复制事件。`/request-generations` 在 codeteam 没有 canonical source，v1 `defer→W7+`。trace ring miss 返回 `trace_unavailable`，不静默省略 drill-down。
5. **Health**：`/ready` 返回 control plane + telemetry 状态；telemetry disabled/degraded 携带 degraded 标记但 `ready=true` 不因此失败（readiness=服务可用，不是 telemetry gate）。
6. **Logs**：W6 结构化 JSON/Pino 文件；rotation + retention + 独立 `REDACT_PATHS`；invocationId/threadId/traceId 作为 correlation；`/api/logs/tail` 只读、operator/console 限定；不与 trace store 合并。
7. **Tool stats**：W6 建独立 `tool_usage_counters`（day/profile/category/tool/count），从 tool invocation boundary/`run_events` 记录，**不是 OTel projection**；`/api/tool-usage` 只读聚合；保留 `CODETEAM_TOOL_USAGE_RETENTION_DAYS`；跨 run 滚动统计也走此表，不另造 F150 store。

### 3.3 状态机 / 生命周期

**A. Telemetry**

```text
disabled ──init success──► local-only ──OTLP config──► local+OTLP
   │                          │
   │                          ├──exporter failure──► degraded
   │                          └──shutdown──────────► disabled
   └──HMAC invalid──► disabled + error
```

**B. Trace ring**

```text
span stored ──age > 24h──► evicted
      │
      └──count > 10k──► oldest evicted
```

**C. Trajectory**

```text
invocationId → canonical run/message truth ──► trajectory DTO
  ├─ trace drill-down by inv:/traceId
  ├─ invocation missing ──► 404
  ├─ canonical read failure ──► unknown/degraded（可重试）
  └─ trace ring miss ──► trace_unavailable（不静默省略）
```

**D. Tool usage counters**

```text
tool invocation ──increment──► tool_usage_counters(day, profile, category, tool)
  ├─ read: /api/tool-usage（operator/console）
  └─ retention: day < now - CODETEAM_TOOL_USAGE_RETENTION_DAYS ──► delete
```

- counter 是独立聚合，不是 OTel projection；同一 tool invocation 只 increment 一次（idempotency key 由 run/tool event 派生）。
- 只记录 metadata（tool/category/count/time），不记录 args/content。

**E. Structured logs**

```text
log write ──► JSON/Pino file (CODETEAM_LOG_DIR)
  ├─ rotation at CODETEAM_LOG_MAX_BYTES
  ├─ retention > CODETEAM_LOG_RETENTION_DAYS ──► delete
  └─ /api/logs/tail（operator/console；redacted）
```

### 3.4 关键数据结构与存储

| clowder | codeteam | 立场 | 关键差异 |
|---|---|---|---|
| `TraceSpanDTO` / `LocalTraceStore` | same shape; local ring | `reuse` | 24h/10k bounded；重启丢；不建第二事件账本 |
| `TelemetryConfig` / `initTelemetry` | `initTelemetry` | `adapt` | OTLP default off；HMAC salt 必填 |
| metric allowlist | same | `reuse` | 只允许安全属性 |
| A-D redaction | same | `reuse` | span/log 同源 |
| `/api/telemetry/*` | read-only routes | `adapt` | operator/CLI query |
| F299 trajectory | `/api/invocations/:id/trajectory` | `adapt` | 从 codeteam runs/messages 读；`inv:`=`runs.id`；request-generations defer |
| F150 tool stats | `tool_usage_counters` | `adapt` | day/profile/category/tool/count；独立 counter，不是 OTel projection |
| F130 logs | JSON/Pino files | `adapt` | 独立 rotation/retention/redaction；`/api/logs/tail` |

**§12.2 回写清单（W6/W7）**

```sql
-- 不建 telemetry 事件表；trajectory 是 read model。
-- 可选：local trace 持久化（v1 不做）
telemetry_trace_spans(
  trace_id TEXT NOT NULL,
  span_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hmac_invocation_id TEXT,
  salt_version INTEGER NOT NULL DEFAULT 1,
  attributes_json TEXT NOT NULL CHECK (json_valid(attributes_json)),
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  status TEXT,
  stored_at INTEGER NOT NULL
);
CREATE INDEX idx_trace_spans_trace ON telemetry_trace_spans(trace_id);
CREATE INDEX idx_trace_spans_invocation ON telemetry_trace_spans(hmac_invocation_id);
CREATE INDEX idx_trace_spans_stored ON telemetry_trace_spans(stored_at);

-- history 只在 opt-in 时启用；v1 默认用内存 ring；启用必须带 retention sweep。

-- F150 parity：独立 tool usage counter（control DB；W6）
tool_usage_counters(
  day TEXT NOT NULL,                 -- UTC YYYY-MM-DD
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  category TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (day, profile_id, category, tool_name)
);
CREATE INDEX idx_tool_usage_day ON tool_usage_counters(day);
CREATE INDEX idx_tool_usage_profile ON tool_usage_counters(profile_id, day);
```

- 标注：`telemetry_trace_spans` 是 **optional（v1 default off）；db: control**；启用时必须带 retention sweep（与 ring 同界，如 24h/7d），否则不建。
- 如果启用，`hmac_invocation_id` + `salt_version` 让 operator 用 invocation 做跨重启 drill-down；salt 换版后旧行查不到是已知边界。
- trajectory 不建表；从 `runs`/`run_events`/`messages`/`queue_entries` 读。
- F150 `tool_usage_counters` 是独立 counter 表，不是 OTel projection；retention 由 `CODETEAM_TOOL_USAGE_RETENTION_DAYS` sweep。
- F130 日志是文件存储（`CODETEAM_LOG_DIR`），不进 DB；rotation/retention/redaction 独立。

### 3.5 变量定义表

#### contract

| 变量 | 类型 | 默认/值域 | owner | clowder 来源 | 决定 | 说明 |
|---|---|---|---|---|---|---|
| `TraceSpanDTO` | object | trace/span/name/attrs/time/status | observability | `packages/api/src/infrastructure/telemetry/local-trace-store.ts:12` | `reuse` | redacted only |
| `TraceQueryFilter` | object | traceId/invocationId(HMAC)/profileId/actorRef/limit | observability | `packages/api/src/infrastructure/telemetry/local-trace-store.ts:43` | `adapt` | catId→profileId/actorRef；raw invocation 先 HMAC |
| `TelemetryConfig` | object | enabled/debug/otlp/saltFile | observability | `packages/api/src/infrastructure/telemetry/init.ts:32` | `adapt` | OTLP default off；salt 从 0600 文件读 |
| `InvocationTrajectory` | read model | `inv:<id>` + canonical truth | observability | F299 | `adapt` | 不复制事件 |
| `MetricAttribute` | allowlist | safe keys | observability | `packages/api/src/infrastructure/telemetry/metric-allowlist.ts:50` | `reuse` | 非 allowlist 丢弃 |
| `RedactionClass` | enum | A/B/C/D | observability | `packages/api/src/infrastructure/telemetry/redactor.ts:15` | `reuse` | A credentials/B prompt/C HMAC/D safe |
| `CorrelationKey` | string | invocationId/traceId/threadId | observability | F153/F299 | `reuse` | join only; no copy |

#### state

| 变量 | 状态机/约束 | owner | 失败语义 |
|---|---|---|---|
| `telemetry.state` | disabled/local-only/local+OTLP/degraded | observability | init failure → disabled + error；不阻塞 API |
| `trace store` | 24h/10k bounded ring | observability | evict oldest；stats 可见 |
| `trajectory` | canonical truth only | observability | invocation missing → 404；read failure → unknown/degraded；ring miss → trace_unavailable；不重建 |
| `redaction` | A-D at init boundary | observability | 未 redact 的属性不得导出 |
| `metric allowlist` | allowlist only | observability | 非允许属性丢弃 |
| `tool_usage_counters` | day bucket；同一 tool invocation 只 increment 一次；retention sweep | observability | 重复 increment → 去重；超期删除；不是 OTel projection |
| `logs` | JSON/Pino file；rotation/retention/redaction | observability | 超期删除；secret 命中 → redact/skip |

#### config

| 变量 | 默认 | owner | 决定 | 说明 |
|---|---|---|---|---|
| `CODETEAM_TELEMETRY_ENABLED` | 1 | observability | `new` | 0=完全关闭；API 仍可用 |
| `CODETEAM_TELEMETRY_OTLP_ENABLED` | 0 | observability | `adapt` | 1=需要 endpoint；默认 local-only |
| `CODETEAM_TELEMETRY_HMAC_SALT_FILE` | `${CODETEAM_DATA_DIR}/telemetry/hmac-salt` | observability | `new` | 0600 文件；salt 本体不进 env；缺失/无效 → telemetry disabled |
| `CODETEAM_TELEMETRY_TRACE_MAX_SPANS` | 10000 | observability | `reuse` | ring 上限 |
| `CODETEAM_TELEMETRY_TRACE_MAX_AGE_MS` | 86400000 | observability | `reuse` | 24h |
| `CODETEAM_TELEMETRY_METRICS_SNAPSHOT_MS` | 30000 | observability | `reuse` | metrics snapshot |
| `CODETEAM_TELEMETRY_DEBUG` | 0 | observability | `reuse` | 仅本地 debug；禁止生产 |
| `CODETEAM_TELEMETRY_TRACE_RETENTION_MS` | 86400000 | observability | `new` | 仅 optional trace 表启用时使用；必须配 sweep |
| `CODETEAM_TOOL_USAGE_RETENTION_DAYS` | 30 | observability | `new` | tool counter 保留天数；定时 sweep |
| `CODETEAM_TOOL_USAGE_CATEGORIES` | tool,skill,mcp | observability | `new` | F150 category 白名单 |
| `CODETEAM_LOG_DIR` | `${CODETEAM_DATA_DIR}/logs` | observability | `new` | F130 日志目录 |
| `CODETEAM_LOG_RETENTION_DAYS` | 14 | observability | `new` | 日志保留天数 |
| `CODETEAM_LOG_MAX_BYTES` | 52428800 | observability | `new` | 单日志文件 rotation 上限 |
| `CODETEAM_LOG_REDACT_PATHS` | credentials/token/prompt 等 | observability | `new` | F130 独立 REDACT_PATHS |
| `CODETEAM_SQLITE_BUSY_TIMEOUT_MS` | 见 plans/0002 W1 | 全局 | `reference` | 可选 trace 表使用 |

#### security

| 变量/规则 | 值/来源 | owner | 失败语义 |
|---|---|---|---|
| `telemetryRedaction` | A-D classes | observability | raw secret/prompt → 不导出；contract test |
| `hmacInvocationId` | server-side HMAC | observability | raw invocationId 不直接匹配 store |
| `idHmacPolicy` | invocation/thread 跨域 ID HMAC；runId/taskId/handoffId/waitId/profileId 等 opaque UUID 可 raw | observability | 不把内部 UUID 全 HMAC/全裸；contract test |
| `metricAllowlist` | explicit keys | observability | 非允许属性丢弃 |
| `toolSpanAttributeAllowlist` | 入：tool 名、参数 schema 键名、target path、exit code、bytes/duration、artifact ref；不入：diff/file content/prompt/output 正文 | observability | 违反 → 丢弃/redact；contract test；DP-OBS-2 前提 |
| `traceReadScope` | owner/thread/tenant | observability | 跨 tenant → 403/空 |
| `telemetryReadPrincipal` | operator credential / console session；run token 403 | observability | 与 A1-4 lifecycle CLI-only 对称 |
| `toolUsageReadPrincipal` | operator credential / console session；run token 403 | observability | W7 工具统计只读 |
| `logReadPrincipal` | operator credential / console session；run token 403 | observability | `/api/logs/tail` 只读 |
| `toolUsageMetadataOnly` | 只记录 tool/category/count/time；不记录 args/content | observability | 违反 → 不写 counter |
| `hmacSaltFile` | `CODETEAM_DATA_DIR/telemetry/hmac-salt` 0600；不是认证凭证，是低敏混淆盐 | observability | env 只放路径；salt 缺失 → telemetry disabled |
| `debugMode` | local-only; production off | observability | production debug → 拒绝/警告 |
| `trajectoryAuthority` | canonical runs/messages only | observability | 非 canonical → 不重建 |
| `logRedaction` | independent REDACT_PATHS | observability | 与 OTel 独立；不互相替代 |

#### observability

| 变量/事件 | 值/来源 | owner | 说明 |
|---|---|---|---|
| `telemetry_init_state` | gauge/status | observability | enabled/local-only/OTLP/degraded |
| `trace_store_spans` / `trace_store_dropped_total` | gauge/counter | observability | ring 容量/丢弃 |
| `telemetry_redaction_total` | counter/class | observability | redaction 次数 |
| `metric_attribute_dropped_total` | counter | observability | allowlist 丢弃 |
| `trajectory_read_total` / `trajectory_unavailable_total` | counter | observability | F299 读面 |
| `telemetry_trace_query_latency_ms` | histogram | observability | trace query |
| `telemetry_export_failures_total` | counter | observability | OTLP/Prometheus failure |
| `tool_usage_increment_total` | counter/category/tool | observability | F150 计数 |
| `tool_usage_retention_swept_total` | counter | observability | 超期删除 |
| `log_rotation_total` / `log_retention_swept_total` | counter | observability | F130 文件生命周期 |
| `log_redaction_total` | counter/path-class | observability | F130 redaction |

### 3.6 明确不做

- 不建第二套 telemetry/event store；trace ring + canonical runs 是唯一来源。
- 不从 F130 日志、queue 投递 receipt、trace spans 等**非 canonical 账本证据**重建 trajectory（F233 LL-099 教训）；`runs`/`run_events`/`messages`/`queue_entries` 是 canonical 表，从它们读是确定性投影，不是重建。定义：**重建 = 从非一手账本拼推测性轨迹；投影 = 从 canonical 表确定性派生。**
- 不把 F150 tool stats / F130 logs re-home 到 OTel store。
- 不做 F192 eval verdict / Eval Hub。
- 不做 F233 值班简报 / feat 轨迹重建。
- 不在生产开 debug exporter；不导出 raw prompt/credential。
- 不做跨租户 telemetry backend；local-first。

### 3.7 DP-OBS-1：telemetry backend

| 选项 | 行为 | 取舍 |
|---|---|---|
| **A（推荐）** | local-first：LocalTraceStore + Prometheus snapshot + `/ready`；OTLP 默认关；salt 走 0600 文件；optional trace 表启用时带 retention + `hmac_invocation_id`/`salt_version` | 无外部依赖；隐私边界清楚；ring 重启自清本身是隐私收益；重启丢 span 粒度（可接受） |
| B | OTLP-first：外部 collector 为默认 backend | 历史可查；但需要外部依赖、运维、跨租户/redaction 面 |

### 3.8 DP-OBS-2：trajectory 范围

| 选项 | 行为 | 取舍 |
|---|---|---|
| **A（推荐）** | P0：`/api/invocations/:id/trajectory` + trace drill-down；`/request-generations` 无 canonical source，defer→W7+；semantic cards 后接 | W7 可控；先满足“看猫这轮干了什么”；无假 P0 |
| B | 完整 F299 semantic card UI / 多面板 | 体验完整；W7 范围大，依赖 transcript/UI 更多 |

- DP-OBS-2=A 的前提：tool span 只按 `toolSpanAttributeAllowlist` 带元数据（tool 名/参数键名/target path/exit code/bytes/duration/artifact ref），不带 diff/file content/prompt/output 正文；否则 drill-down 打开空壳或不安全正文。
- `/request-generations` 的 codeteam 等价源（run attempt + provider-call `run_events`）未定义，v1 不挂假 P0；W7+ 有源再开。

### 3.9 DP-OBS-3：tool stats / logs

> **Operator 决定（2026-10-25）：B。** W6 做 F150/F130 parity；A 仅保留为历史备选，不再按 A 实施。

| 选项 | 行为 | 取舍 |
|---|---|---|
| A（未选） | v1 不建 F150 tool-stats；W6 指标从 `runs`/`run_events` 派生；日志用独立 JSON/Pino + correlation | 范围最小；不制造第二统计账本 |
| **B（operator 已选）** | W6 建 `tool_usage_counters` + `/api/tool-usage`；F130 结构化日志 + rotation/retention/`REDACT_PATHS` + `/api/logs/tail` | 统计/日志 parity 完整；W6 增两个独立 store/retention/redaction |

- 实施边界：`tool_usage_counters` 是独立 counter，不是 OTel projection；只记 metadata，不记 args/content。F130 日志是文件存储，不进 DB；与 OTel 独立 redaction/correlation。
- W6 验收必须包含：counter 幂等 increment、retention sweep、log rotation/retention、`/api/tool-usage` 与 `/api/logs/tail` 的 operator/console 权限、run token 403。

## 4. 风险与回滚

| 风险 | 级别 | 处置 |
|---|---|---|
| raw prompt/credential 进 trace/log | P1 | A-D redaction + allowlist + contract test |
| 从日志/receipt/trace spans 重建 trajectory | P1 | 只读 canonical runs/run_events/messages/queue；重建≠投影；invocation missing 404、read failure unknown、ring miss trace_unavailable |
| telemetry init 失败被当 healthy | P1 | `/ready` 显式 degraded；不阻塞 API |
| HMAC salt 走 env 被子进程继承 | P1 | salt 走 `CODETEAM_DATA_DIR/telemetry/hmac-salt` 0600；env 只放路径 |
| tool span 只有 name/duration 或放开正文 | P1 | `toolSpanAttributeAllowlist` 元数据白名单；diff/file content/prompt/output 不入；contract test |
| optional trace 表缺 invocation 索引 | P2 | `hmac_invocation_id` + `salt_version` + 索引；启用带 retention |
| request-generations 无 canonical source 却进 P0 | P2 | v1 defer→W7+；有 run attempt/provider-call 源再开 |
| trace ring 重启丢历史 | P2 | v1 接受；需要时 opt-in trace 表/OTLP，不建第二事件账本 |
| telemetry 开销影响 API | P2 | bounded ring + sample + local-first |
| F150/F130 被误当 telemetry projection | P2 | 独立 store/redaction；只按 correlation key join |
| debug exporter 泄露 | P1 | production 禁止；startup warning/refuse |

**回滚**：关闭 `CODETEAM_TELEMETRY_ENABLED` / trajectory 路由即回到无 observability 基线；不删除 control-plane 表。可选 trace 表可单独 drop。不迁移 clowder telemetry。

## 5. Review 与签字

> Review request `1a1730c7-b982-43c2-a864-361ce35c50b2`（2026-10-25，三猫）。结论：烁烁 accept；砚砚/墨墨 accept-with-modify。P1-1 源表述冲突、P2 HMAC salt/tool span/generations/optional trace 列已回写。Operator 2026-10-25 拍 `DP-OBS-1=A`、`DP-OBS-2=A`、`DP-OBS-3=B`。

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | OTel init/instruments、local trace、`/ready`、correlation | accept；P2 HMAC salt 文件 + P3×4 已回写 |
| 砚砚 | redaction/A-D、HMAC、tenant/secret、fail-closed | accept-with-modify；P2 tool span allowlist + P3×5 已回写 |
| 墨墨 | operator trajectory、trace drill-down、W7 可读性 | accept-with-modify；P1 源表述、P2 optional trace 列/generations、P3×5 已回写 |
| operator | DP-OBS-1/2/3 | 已签：A/A/B（2026-10-25）；W6 含 F150/F130 parity |

**Findings disposition**

| # | 来源 | Finding | 处置 |
|---|---|---|---|
| P1-1 | 墨墨 | “不从消息/队列重建”与 trajectory 读取源字面冲突 | **已修**：§3.6 定义“重建=非一手账本拼轨迹；投影=canonical 表确定性派生”；runs/run_events/messages/queue_entries 是投影源 |
| P2 | 烁烁 | HMAC salt 走 env 与 W2 零 secret 冲突 | **已修**：salt 走 `CODETEAM_DATA_DIR/telemetry/hmac-salt` 0600；env 只放路径 |
| P2 | 砚砚 | B 类 tool span 白名单缺失，drill-down 空壳或泄密 | **已修**：`toolSpanAttributeAllowlist` 元数据白名单 + contract test；DP-OBS-2 前提 |
| P2 | 墨墨 | optional trace 表缺 invocation 索引 | **已修**：加 `hmac_invocation_id`/`salt_version` + 索引；启用带 retention |
| P2 | 墨墨 | `/request-generations` 无 canonical source 却进 P0 | **已修**：v1 defer→W7+；DP-OBS-2 同步 |
| P3 | 烁烁/砚砚/墨墨 | invocation=runs.id、/ready ready=true、catId→profileId、§12.2 标注、404/unknown 拆分、trace_unavailable、W7 可读性、salt version、degraded 横幅、ID raw/HMAC 策略、read auth、retention、ring miss | **已回写**：见 §3.2/§3.4/§3.5/§3.6 |

**Review 重点**

1. local-first telemetry（无持久 trace）是否满足 W0-W7；何时需要 opt-in trace 表。
2. trajectory P0 范围是否够“看猫这轮干了什么”；request-generations 延后、semantic cards 后接是否可接受。
3. A-D redaction / metric allowlist / `/ready` 是否覆盖 codeteam 的 secret 面。
4. F150/F130 parity（DP-OBS-3=B）的独立 counter/log store、retention、权限是否清楚。
5. §12.2 可选 trace 表与 W6/W7 挂点是否一致。

[宪宪/deepseek-flash🐾]
