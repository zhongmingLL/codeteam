---
title: "W6c Observability / Trajectory 实施计划"
doc_kind: plan
status: closed
created: 2026-10-29
updated: 2026-10-29
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
source: "docs/plans/0004-w5-w8-scale-product.md §W6 6E"
feature: F013
---

# W6c Observability / Trajectory 实施计划

> W6 总契约以 `0004` §W6 为单一真相源；本文件冻结 6E 的实现契约与 AC 映射。
> 计划编号与 feature 编号为并行安全预留：W6a 使用 `0014`/`F012`，W6c 使用
> `0015`/`F013`，W6b 使用 `0016`/`F014`。若 W6a 已占用不同编号，以实际
> merge 为准，本 slice 不改写他人文件。

## 0. 范围与切片

| 切片 | 内容 | 边界 |
|---|---|---|
| **W6c-A** | telemetry init、HMAC salt 0600、A-D redaction、metric allowlist、tool span metadata allowlist | 不新增外部 OTel/Pino 依赖；redaction 在 ingest 边界 |
| **W6c-B** | OTel-shaped local trace ring（10k spans / 24h）、span API、可选 OTLP exporter（默认关）、Prometheus snapshot | 只存 redacted DTO；ring 是缓存不是账本 |
| **W6c-C** | trajectory read model：只从 `runs`/`run_events`/`messages`/`queue_entries` 投影 | 不建第二事件账本；`inv:` = `runs.id`；miss 显式 `trace_unavailable` |
| **W6c-D** | F150 parity：`tool_usage_counters` 幂等 increment、retention、report 契约 | 独立 SQLite store；只按 `run_events.id`/`run_id` join |
| **W6c-E** | F130 parity：JSONL 日志文件、rotation/retention、redaction、tail 契约 | 独立文件 store；不得含 raw prompt/diff/file content |
| **W6c-F** | daemon `/ready` + `/metrics`、readiness 组件状态、executor/worker 接线 | `/health` 保持 W5d 契约不变；不做 W7 operator HTTP surface |

执行顺序：A → B → C/D/E 并行 → F 接线 → 契约测试 → review。

## 1. 目标与可见结果

1. 本地默认开启 telemetry：trace ring 可查最近 10k spans / 24h；Prometheus
   文本快照可抓取；`/ready` 明确报告 telemetry 各组件状态。
2. 任何 trace/log 写入都不包含 raw prompt、diff、file content、credential；
   外部 export 的系统标识先 HMAC。
3. `GET /ready` 在 control plane ready 但 telemetry degraded 时返回 200 +
   `status:"degraded"` + 组件原因；control plane 未 ready 返回 503。绝不把
   “telemetry 没初始化”报成 healthy。
4. 单次 run 的 trajectory 可从 canonical 表重放；trace ring 命中则附 redacted
   spans，未命中则 `trace_unavailable` + reason；`/request-generations`
   明确留 W7+。
5. `tool_usage_counters` 对同一 `run_events.id` 重复记录只计一次；report 可按
   时间/profile/category 聚合；旧数据按 retention 清理。
6. 日志为 0600 JSONL，按大小轮转、按天数/文件数保留；`tail` 只读返回
   redacted entries；无 raw content。
7. W6b 可直接消费冻结的 trajectory/tool-usage/log/trace DTO，不需要读
   私有实现细节；W7a 只加 HTTP/auth/Console 适配。

## 2. 冻结契约（W6b/W7a 消费面）

落点：`packages/codeteam-daemon/src/observability/contracts.ts`（只读 DTO +
query/result 类型）。实现类不进入契约。

### 2.1 Trace

```ts
type TraceAvailability = "available" | "trace_unavailable";
type TraceUnavailableReason = "ring_miss" | "telemetry_disabled";

interface TraceSpanDTO {
  traceId: string; spanId: string; parentSpanId?: string;
  name: string; kind: "internal" | "server" | "client";
  startTimeMs: number; endTimeMs: number; durationMs: number;
  status: { code: "unset" | "ok" | "error"; message?: string };
  attributes: Readonly<Record<string, string | number | boolean>>;
  events: readonly { name: string; timeMs: number; attributes?: Readonly<Record<string, string | number | boolean>> }[];
  storedAt: number;
  droppedAttributes: number;
}

interface TraceQuery {
  traceId?: string; invocationId?: string; profileId?: string;
  name?: string; startMin?: number; startMax?: number; limit?: number;
}

interface TraceQueryResult {
  availability: TraceAvailability;
  reason?: TraceUnavailableReason;
  spans: readonly TraceSpanDTO[];
  truncated: boolean;
}
```

- `TraceQuery.invocationId` 接收 raw `runs.id`；store 内部 HMAC 后匹配
  `invocation.id` 属性。调用方不得自行拼 `inv:`。
- ring miss 与 telemetry disabled 必须区分；不得返回空数组冒充 available。

### 2.2 Trajectory

```ts
interface InvocationTrajectory {
  inv: `inv:${string}`;                  // canonical runs.id
  run: { id; taskId; status; role; agentSessionId; provider; model;
         modelFamily; attempt; startedAt; terminalAt;
         usage: bounded token/cost metadata | null };
  task: { id; title; status } | null;
  thread: { id; title } | null;
  queueEntry: { id; sourceKind; priority; status; enqueuedAt } | null;
  sourceMessage: TrajectoryMessageRef | null;
  responseMessage: TrajectoryMessageRef | null;
  steps: readonly TrajectoryStep[];
  /** true 是“可能截断”信号（命中 MAX_STEPS），不是缺数证明。 */
  stepsTruncated: boolean;
  trace: TraceQueryResult;
}

interface TrajectoryMessageRef {
  id; kind; authorKind; authorId; seq; createdAt; bodyDigest; bodyBytes;
}

interface TrajectoryStep {
  seq: number; at: number; kind: RunEventKind; summary: string;
  attributes: Readonly<Record<string, string | number | boolean>>;
  source: { kind: "run_event"; id: string } | { kind: "message"; id: string };
}
```

- `TrajectoryStep.attributes` 只含 allowlist 元数据；`message` 的正文只以
  digest+bytes 出现，不内联。
- `steps` 以 `run_events.seq` 升序；`sourceMessage`/`responseMessage` 是
  canonical `messages` 引用，正文由 W7a 在 operator auth 下 drill-down。
- 读取路径不得写 control DB；不得产生新事件。

### 2.3 Tool usage

```ts
interface ToolUsageQuery { days?: number; from?: string; to?: string;
                           profileId?: string; category?: "native"|"mcp"|"skill" }
interface ToolUsageReport {
  period: { from: string; to: string };
  summary: { totalCalls: number; byCategory: Record<ToolCategory, number> };
  topTools: Array<{ name; category; count }>;
  daily: Array<{ date; native; mcp; skill }>;
  byProfile: Record<string, Record<ToolCategory, number>>;
}
interface ToolUsageRecordInput { eventId; runId; profileId; toolName; toolInput?; at? }
interface ToolUsageRecordResult { recorded: boolean; count: number }
```

- `eventId` 是幂等键（`run_events.id`）；重复 record 返回 `recorded:false`，
  不增加 count。
- `days<=0` 表示 all-time（受 retention 约束）；日期为 UTC。

### 2.4 Logs

```ts
interface LogTailQuery { limit?: number; level?: "debug"|"info"|"warn"|"error"; since?: string }
interface LogEntry { ts: string; level: LogLevel; event: string; fields: Record<string, unknown> }
interface LogTailResult { entries: readonly LogEntry[]; truncated: boolean; scannedFiles: number }
```

- entries 按时间升序返回；`truncated=true` 表示还有更多匹配未返回。
- 日志文件位置 `<dataDir>/logs/daemon.log`，轮转 `.1`…`.N`，0600。
- `JsonlLogStore` 默认 **strict fields**：只有 allowlist 的 operational key
  （id/role/status/token/count 等）透传；未知 key 一律 contentRef。调用方不得
  依赖未知 key 携带 prompt/diff/file content；显式 compat 模式只用于受控迁移。

### 2.5 Readiness

```ts
interface TelemetryReadiness {
  status: "ready" | "degraded" | "disabled";
  reason?: string;
  trace: { status; spanCount; maxSpans; maxAgeMs; reason? };
  metrics: { status; seriesCount; reason? };
  logs: { status; fileCount; reason? };
  otlp: { status: "disabled" | "enabled" | "degraded"; reason? };
}
```

`/ready` body = daemon identity（沿用 W5d）+ `status` + `telemetry`。
`/health` 不变；tool usage 可用性属于 control store read surface，由
W7a 在 operator auth 下暴露。

## 3. 决策与红线

| ID | 决策 | 理由 |
|---|---|---|
| **D1** | 不引入 `@opentelemetry/*` / `pino` 依赖；按 pi `@earendil-works/pi-telemetry` 的 vendor-neutral 语义（显式 context、无全局 span）实现本地 OTel-shaped DTO ring；不把 pi-telemetry 包作为运行时依赖 | pi v1.4.0 上游规则把 OTel 适配留给应用；其 callback 适配器不提供 ring 投影/淘汰；避免新增供应链与 bundle |
| **D2** | trace ring 是 in-memory cache，不是账本；重启丢失是预期，trajectory 以 canonical 表为准 | 复用卡 P1 风险：不建第二事件账本 |
| **D3** | trace 的 Class C 标识 HMAC；本地日志保留 Class C 关联 id，但 A/B 仍 redact | trace 可能 OTLP 外发；日志 0600 且本地排障需要 join key |
| **D4** | trace attributes 采用 **allowlist**（未知键丢弃并计数），不是 D 类透传 | 防止未来调用方误塞 raw content |
| **D5** | metric labels 只允许 bounded enum；未知 label 丢弃 | Prometheus cardinality/泄密边界 |
| **D6** | OTLP 默认关；启用需显式 endpoint；runtime tracer 必须实际持有 exporter 才报 `enabled`，否则 `degraded`；export 失败只降级不抛错 | local-first；不把“配置存在”谎报成“已接线”；telemetry 不阻塞 control plane |
| **D7** | `tool_usage_counters` 与 `run_events` 在同一次 tool_call 写入后记录；以 `run_events.id` 幂等 | F150 parity；独立 store、correlation key join |
| **D8** | trajectory 只读；`/request-generations` 不在本 slice | W6c 冻结投影，W7+ 再做 generation 视图 |

**红线**：raw prompt/diff/file content/credential 不进 trace 或 log；telemetry
init 失败不得阻止 daemon 启动；`/ready` 不得把未初始化报成 healthy；
不创建第二 truth store；不写入 W6a memory.db；不做 W7 HTTP/Console 读面。

## 4. A-D redaction 冻结表

| 类 | 例子 | trace | log | trajectory |
|---|---|---|---|---|
| **A credentials** | authorization/cookie/api_key/token/secret/password/private_key/signature/salt | `[REDACTED]` | `[REDACTED]` | 不出现 |
| **B business content** | prompt/body_md/diff/patch/file_content/tool_input/tool_result/stdout/stderr/thinking/text | 字符串→`[content:sha256:<16> len:<n>]`；其他→`[content:<type>]` | 同左 | 不内联；message 只给 digest+bytes |
| **C system identifiers** | run/task/thread/message/session/invocation/call/handoff/approval id | HMAC-SHA256(32 hex) | 保留原文（本地 0600） | 保留 canonical id 供 drill-down |
| **D operational metadata** | role/status/provider/model/tool name/category/phase/duration/counts | 只允许 allowlist 键 | 允许，但有 depth/size 上限 | 只允许 allowlist 键 |

- HMAC salt：`<dataDir>/telemetry-salt`，首次创建 32 random bytes，文件 0600、
  目录 0700；POSIX 上已存在但 group/other 可读 → fail closed（trace disabled）。
  不使用 dev fallback salt；测试显式注入 salt。
- Tool span metadata allowlist：`tool.name`、`tool.category`、`tool.phase`、
  `tool.call.id`（HMAC）、`tool.input.keys`（仅键名）、`tool.result.status`、
  `tool.duration_ms`。**不含 input/result body、command、file path、diff**。
- Metric label allowlist：`role`、`provider`、`model`、`model_family`、`status`、
  `tool.category`、`tool.name`、`event.kind`。**不含 run/thread/message id**。

## 5. 落点与 AC 映射

| AC（`0004` §W6 6E + kickoff） | 实现落点 | 验证 |
|---|---|---|
| AC-1 local trace ring 10k/24h；Prometheus snapshot；`/ready` | `observability/trace-store.ts`、`metrics.ts`、`runtime.ts`；`daemon.ts` `/ready` `/metrics` | unit + daemon HTTP test |
| AC-2 OTLP 默认关；启用后 runtime tracer→exporter 真接线；HMAC salt 0600 | `observability/otlp.ts`、`runtime.ts`、`salt.ts` | unit（默认零请求；runtime fetch-boundary；600/权限失败） |
| AC-3 trajectory 只读 canonical 表；`inv:`=`runs.id`；ring miss `trace_unavailable` | `observability/trajectory.ts` | projection test + no-write assertion |
| AC-4 A-D redaction + metric allowlist + tool span allowlist；raw content 不进 trace/log | `observability/redaction.ts`、`metrics.ts`、`tracer.ts`、`logs.ts` | redaction matrix + leak tests |
| AC-5 F150 parity：`tool_usage_counters` 幂等 + retention + report | migration `014`、`stores/tool-usage.ts`、event-sink 接线 | idempotency/retention/report tests |
| AC-6 F130 parity：JSONL + rotation/retention + tail | `observability/logs.ts` | rotation/retention/tail/redaction tests |
| AC-7 冻结 W6b 可消费只读契约；W7a 再接 HTTP/Console | `observability/contracts.ts` + `index.ts` export | contract type test + docs |
| AC-8 telemetry init 失败降级、不阻塞 control plane；`/ready` 显式 | `runtime.ts` + `daemon.ts` | failure-injection test |
| AC-9 不建第二 truth store；不碰 W6a memory.db/evidence adapter | 全 slice 只读 canonical 表；无 memory import | import/scan + test |
| AC-10 `/request-generations` 留 W7+ | 契约注释 + feature Out of scope | doc review |

## 6. 测试矩阵

| 测试 | 覆盖 |
|---|---|
| `observability-redaction.test.ts` | A/B/C/D；嵌套对象；depth/size；salt 缺失 fail closed；tool keys allowlist |
| `observability-trace.test.ts` | 10k cap、24h TTL、query by raw invocationId→HMAC、truncated、store 边界再校验、disabled/miss 区分 |
| `observability-metrics.test.ts` | counter/gauge/histogram、label allowlist、Prometheus escaping、snapshot、series cap |
| `observability-otlp.test.ts` | 默认关零请求；runtime tracer→exporter 集成；runtime fetch boundary；启用后 payload 是 redacted DTO；pending cap；失败降级 |
| `observability-trajectory.test.ts` | canonical 投影、步骤顺序、正文不内联、trace available/miss/disabled、只读 |
| `observability-tool-usage.test.ts` | 同 eventId 幂等、并发/事务、UTC 日界、retention、report 过滤 |
| `observability-logs.test.ts` | 0600、rotation、retention、tail 顺序/过滤/截断、A/B redaction、strict fields |
| `observability-salt.test.ts` | 0600/0700、权限漂移 fail closed、symlink 拒绝、竞态回读 |
| `observability-worker-sink.test.ts` | tool usage 幂等、tool span 元数据白名单、降级不抛 |
| `observability-ready.test.ts` | `/ready` ready/degraded/503；`/metrics`；`/health` 不回归 |
| `control-worker-executor.test.ts` | executor → run span / tool span / metrics 集成 |
| `control-schema.test.ts` 更新 | migration 014、表名 |

## 7. 风险与回滚

| 风险 | 处置 |
|---|---|
| trace/log 泄密 | ingest 边界 redaction + allowlist；leak tests；OTLP 只发 redacted DTO |
| ring 被误当账本 | 契约/trajectory 显式 `trace_unavailable`；文档标注 cache |
| telemetry 拖慢 control plane | bounded ring、同步 JSONL 小写入、OTLP fire-and-forget + timeout |
| 日志/Git 噪声 | 0600 + rotation/retention；不写 prompt/diff |
| migration 冲突 | 014 为 W6c 独占；W6a 不写 control migration；冲突时 rebase 重编号并说明 |
| 回滚 | 关闭 telemetry runtime 或删 `telemetry-salt`/`logs/`；`tool_usage_*` 表可保留（不影响 control）；不迁移 clowder telemetry |

## 8. 明确不做

- W6a：memory/evidence adapter、memory.db、FTS index、retrieval triggers。
- W6b：eval/outcome/harness-eval、eval lifecycle、model-role matrix。
- W7：`/api/trajectory`、`/api/telemetry/traces`、`/api/tool-usage`、
  `/api/logs/tail`、operator auth、Console UI、`/request-generations`。
- W8：GitHub/GitLab forge。
- 不做 trace 持久化、第二事件账本、跨进程 trace aggregation、Pino 依赖。

## 9. Results（2026-10-29）

- PR #63 squash merged into `codeteam-work` at
  `12c54685439a3b8cb92142bbac7a5d88764e1cea`；final reviewed HEAD
  `04d3f9382298e35c4bbecc4de39da378fd4564b5`。
- 砚砚 approved at `04d3f9382`（security/redaction/provenance）；墨墨 approved
  at `04d3f9382`（reuse/真实路径/可解释性）。P1 OTLP composition、P2 strict
  fields、6 P3 全部收口。
- Post-merge acceptance at `12c546854`：`build:offline` exit 0；daemon
  62 files + 437 tests passed / 2 skipped；root `tsc` / biome clean。
- Residual optional P3：dropped counters 未进 `/ready` telemetry payload，
  W7a Console 可展示，不阻塞。
