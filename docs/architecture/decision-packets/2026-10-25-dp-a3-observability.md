---
title: "DP-A3: observability 拍板包"
doc_kind: decision-packet
status: decided
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
related_card: ../reuse-review/observability.md
operator_decision: "DP-OBS-1=A, DP-OBS-2=A, DP-OBS-3=B (2026-10-25)"
---

# DP-A3: observability 拍板包

> **Operator 决定（2026-10-25）**：`DP-OBS-1=A`、`DP-OBS-2=A`、`DP-OBS-3=B`。本 packet 已冻结；observability 卡按 A/A/B 收口，W6 做 F150/F130 parity。

## 0. 一句话

observability v1 推荐 local-first：本地 trace ring + Prometheus snapshot + `/ready`；trajectory 从 canonical run/message truth 投影；F150/F130 在 W6 做 parity 但保持独立 store。Operator 已拍：**A / A / B**。

## 1. 先看结论

| 决策 | 选项 | 推荐 | 影响面 | 不拍的后果 |
|---|---|---|---|---|
| DP-OBS-1 backend | A=local-first + OTLP 可选；B=OTLP-first | **A** | W6 依赖/运维/隐私 | 需要外部 collector，W6 启动成本上升 |
| DP-OBS-2 trajectory | A=P0 `inv:` + trace drill-down（request-generations defer）；B=完整 F299 semantic cards | **A** | W7 范围/体验 | W7 范围膨胀，先做全量 UI 会拖慢 M0 |
| DP-OBS-3 tool stats/logs | A=v1 不建 F150，日志独立；B=W6 做 F150/F130 parity | **B（operator 2026-10-25）** | W6/W7 范围 | 多两个独立 store/retention/redaction |

## 2. DP-OBS-1：telemetry backend

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | LocalTraceStore（10k/24h）+ Prometheus snapshot + `/ready`；OTLP 默认关；salt 走 0600 文件；optional trace 表带 `hmac_invocation_id`/`salt_version`/retention | 无外部依赖；隐私边界清楚；ring 重启自清是隐私收益；W6 可交付 | 重启丢 span 粒度；历史审计有限 |
| B | OTLP-first：外部 collector 为默认 backend | 历史可查；可接统一观测平台 | 需要外部依赖、运维、跨租户/redaction 面 |

**推荐理由**：codeteam W0-W7 是单机 dogfood，本地 bounded trace 足够排查“这轮发生了什么”；需要历史时再开 OTLP，不在 W6 引外部依赖。

## 3. DP-OBS-2：trajectory 范围

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| **A（推荐）** | P0：`/api/invocations/:id/trajectory` + trace drill-down；`/request-generations` 无 canonical source，defer→W7+；semantic cards 后接 | W7 可控；满足“看猫这轮干了什么”；无假 P0 | 暂无“第 N 次模型请求”视图；没有完整 F299 多面板/语义卡 |
| B | 完整 F299 semantic card UI / 多面板 | 体验完整 | W7 范围大；依赖 transcript/UI 更多 |

**推荐理由**：先交付可读 trajectory + trace 证据，再按 operator 真实使用补 semantic cards；避免为了 UI parity 拖慢 M0。`/request-generations` 在 codeteam 没有等价 canonical source，v1 不挂假 P0；tool span 必须按 `toolSpanAttributeAllowlist` 只带元数据（tool/参数键名/path/exit code/bytes/duration/artifact ref），不带 diff/file content/prompt/output 正文。

## 4. DP-OBS-3：tool stats / logs

| 选项 | 行为 | 价值 | 代价 |
|---|---|---|---|
| A（未选） | v1 不建 F150 tool-stats；W6 指标从 `runs`/`run_events` 派生；日志用独立 JSON/Pino + correlation | 范围最小；不制造第二统计账本 | 暂时没有工具使用看板 |
| **B（operator 已选）** | W6 建 `tool_usage_counters` + `/api/tool-usage`；F130 结构化日志 + rotation/retention/`REDACT_PATHS` + `/api/logs/tail` | 统计/日志 parity 完整 | W6 增两个独立 store/retention/redaction |

**实施边界**：F150/F130 在 clowder 是独立 store，不是 telemetry projection；codeteam W6 按 B 做 parity，但保持独立存储/redaction，只按 correlation key join。`tool_usage_counters` 只记 metadata，不记 args/content；F130 日志是文件，不进 DB。

## 5. 不需要拍、已定的边界

- A-D redaction 在 telemetry init 边界；raw prompt/credential/token 不导出；B 类 tool span 走元数据白名单。
- metric allowlist 只允许安全属性；非允许属性丢弃。
- trajectory 只从 canonical `runs`/`run_events`/`messages`/`queue_entries` 投影；不建第二事件账本。
- `inv:<invocationId>` = `inv:` + `runs.id`；request-generations defer→W7+；ring miss 显示 `trace_unavailable`。
- telemetry init 失败只降级 observability，不阻塞 control plane；`/ready` 显式 degraded。
- F150/F130 W6 parity：`tool_usage_counters` + 日志文件独立 store/redaction；只按 invocationId/traceId/threadId join。

## 5.1 Review 已回写

- 墨墨 P1-1：把“不从消息/队列重建”改成“不从日志/receipt/trace spans 等非 canonical 证据重建”；runs/run_events/messages/queue_entries 是确定性投影源。
- 烁烁 P2：HMAC salt 改 0600 文件，env 只放路径；`/ready` ready=true 不因 telemetry degraded 失败。
- 砚砚 P2：tool span 元数据白名单；diff/file content/prompt/output 不入 trace。
- 墨墨 P2：optional trace 表加 `hmac_invocation_id`/`salt_version` + 索引；request-generations 无 source，v1 defer。
- P3 批：404/unknown 拆分、trace_unavailable、W7 语义先于原始、salt version、degraded 横幅、ID raw/HMAC 策略、read auth、retention、ring miss。

## 6. 拍板记录

2026-10-25 operator：`DP-OBS-1=A, DP-OBS-2=A, DP-OBS-3=B`。W6/W7 按 A/A/B 冻结。

[宪宪/deepseek-flash🐾]
