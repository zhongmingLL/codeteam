---
title: "codeteam Infra Readiness — Clowder AI 基础设施对标"
doc_kind: report
status: approved
created: 2026-10-30
updated: 2026-10-30
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [砚砚 (GLM 5.3 Flash), 烁烁 (Kimi K3), 墨墨 (Qwen 3.8 Flash)]
baseline: "codeteam-work@d33dd17fb2eafefdfd167036e4dc258012c9882d"
reference: "clowder-ai@5f8965e1e04dd3ac194cba53fa484bbc994d2dcd (read-only reference checkout; repo-relative paths only)"
scope: "read-only infra readiness analysis; no product code changes"
---

# codeteam Infra Readiness — Clowder AI 基础设施对标

> 只读调研。没有修改 codeteam 产品代码，也没有把 Clowder AI 作为运行依赖。
> 以下 Clowder 路径均相对于只读参考 checkout；codeteam 路径相对于本仓。
> 本次没有启动任一 runtime，也没有跑故障注入；结论来自源代码、计划、
> 运维脚本和现有报告的静态核对。

## 0. 结论先行

1. **codeteam 不是“没有基础设施”，而是“基础设施没有接到生产入口”。**
   W5d 已有 daemon identity、boot ledger、`/health`、StopOperationRecord、
   deployment wait；W6c 已有 `JsonlLogStore`、local trace ring、Prometheus
   文本快照、`/ready`、F150 tool usage；W1/W5 已有 SQLite WAL/migrations、
   artifact store、artifact GC、worktree pool/GC。缺的是把它们接到一个真实
   启停的 daemon 上，并补齐备份恢复、告警、runbook 和发布回滚。
2. **Clowder 本身也是 local-first，不是 ELK/Grafana/Kubernetes 堆栈。**
   F130 是四层本地日志文件 + `logs:health`；F153 是进程内 OTel + 本地
   trace ring + Prometheus 快照 + 可选 OTLP + Hub 内嵌读面 + burn-rate
   告警；数据恢复靠 Redis RDB/AOF + 起停快照 + 保留策略 + 外置备份；
   生命周期靠 runtime worktree、daemon state、StopOperationRecord、
   boot ledger 和 loopback health probe。codeteam 应当对标这套**本地优先
   的运维纪律**，而不是先上集中式日志/指标平台。
3. **最大的 P0 缺口是 W7a 的生产 bootstrap。** `startDaemon()` 目前是库
   函数，CLI 只有 `daemon status|stop`；没有 `daemon start`，没有
   supervisor 契约，也没有 build stamp。W5d 计划自己写明“restart CLI 的
   external start 未接 supervisor”；W6c 计划自己写明“生产 bootstrap 随
   W7a 接线，数据不是今天就在流动”。如果 W7a 只做 HTTP/Console 而不补
   这一层，W6c 的日志/trace/tool usage 仍不会在生产中产生。
4. **第二个 P0 是数据保护。** codeteam 的 control SQLite 是唯一真相，
   但当前没有 backup/restore 命令、没有备份 manifest、没有恢复演练、
   没有升级前快照。架构 §17.4 已承诺“SQLite 定期备份；WAL checkpoint；
   artifact store 备份 manifest；恢复演练”；W7 任务 9 只有一行
   “备份/恢复、schema migration、升级流程”，尚未变成可执行切片。
5. **第三个 P0 是配置与零 secret 启动前置。** v1 的 secret 策略是文件型
   零 secret：`operator.key` 0600、telemetry salt 0600、run token 目录
   0700；但仓内没有 `.env.example`、没有统一 config registry、没有启动
   preflight。operator 目前只能从复用卡和源码反推环境要求。
6. **第四个 P0 是可观测性接线，不是再设计一套可观测性。** `JsonlLogStore`
   当前只有测试和 runtime 构造调用，没有业务写入者；`/ready`/`/metrics`
   只在 `startDaemon()` 的测试 fixture 中真实运行；tool usage 只在
   `WorkerEventSink` 被 executor 构造时写入。需要把“写日志、写 metric、
   写 trace、写 tool usage”接进生产组合，并把 W7a 已承诺的只读 API 落地。
7. **优先级建议：**
   - **P0**：生产 bootstrap + supervisor 契约 + build stamp；备份/恢复 +
     升级/回滚；配置/secret preflight；可观测性接线 + 只读读面 + logs
     health。
   - **P1**：SLO/告警；运维 runbook/incident 流程；codeteam 自身版本/发布
     流程；进程/端口/worktree/artifact 的定期清理。
   - **P2**：日志 shipping/聚合；外部 Prometheus/OTLP/Grafana；trace 持久化；
     异地备份与自动恢复演练；多主机 supervisor。
   - **Drop**：Redis 运维、Clowder IM/桌面安装、默认 Grafana/ELK/K8s、
     daemon 内自重启、把 Clowder 的审计/取证层整套搬来。
8. **一句话给 operator：**“日志代码有、日志文件还没人写；生命周期记录有、
   daemon 还没人启动；备份计划有、备份命令还没有。W7a 前应先把这四条
   变成可操作的 CLI 和 runbook，而不是先接集中式日志平台。”

## 1. 调研范围与方法

### 1.1 基线

| 项 | 值 |
|---|---|
| codeteam 基线 | `codeteam-work@d33dd17fb2eafefdfd167036e4dc258012c9882d`（W6 closed） |
| codeteam 调研工作区 | 隔离 docs worktree，分支 `docs/infra-readiness-clowder-benchmark` |
| Clowder 参考 | 只读 checkout，HEAD `5f8965e1e04dd3ac194cba53fa484bbc994d2dcd` |
| Clowder 历史文档检索 | memory `project:cat-cafe`；当前源码/脚本/sysprompt/config 直接读只读 checkout |
| 数据边界 | 未读取 Clowder `.env`、账号、密钥或个人数据；未指向任何生产数据 |
| 变更边界 | 只新增本报告；无产品代码、配置、数据库或部署改动 |

### 1.2 读了什么

| 主题 | codeteam | Clowder 参考 |
|---|---|---|
| 架构与计划 | `docs/architecture/0001-codeteam-architecture-v1.md` §12/§15/§17、`docs/plans/0004-w5-w8-scale-product.md` W7、`docs/plans/0015-w6c-observability-trajectory.md`、`docs/plans/0013-w5d-runtime-lifecycle-managed-work.md` | `docs/features/F130-api-log-governance.md`、`docs/features/F153-observability-infra.md`、`docs/features/F150-tool-usage-stats.md`、`docs/features/F300-self-sensing-home-state-awareness.md`、`docs/features/F323-runtime-restart-coordination.md` |
| 生命周期 | `packages/codeteam-daemon/src/daemon.ts`、`src/state.ts`、`src/boot-ledger.ts`、`src/lifecycle/*`、`src/cli/daemon.ts` | `scripts/runtime-worktree.sh`、`scripts/start-dev.sh`、`scripts/daemon-state.mjs`、`scripts/lib/daemon-stop-operation.mjs` |
| 可观测性 | `packages/codeteam-daemon/src/observability/*`、`src/workers/event-sink.ts`、`src/control/stores/tool-usage.ts` | `scripts/logs-health.sh`、`packages/api/src/infrastructure/telemetry/*`、`packages/api/src/routes/telemetry.ts`、`packages/api/src/config/env-registry.ts` |
| 数据与恢复 | `packages/codeteam-daemon/src/control/database.ts`、`src/memory/database.ts`、`src/control/stores/artifacts.ts`、`src/scheduling/artifact-gc.ts`、`src/scheduling/worktree-pool.ts` | `scripts/user-redis.sh`、`scripts/user-redis-autobackup.sh`、`scripts/redis-backup-retention.mjs`、`scripts/thread-exports-sync.sh`、`scripts/find-redis-dumps.sh` |
| CI/发布 | `.github/workflows/ci.yml`、`package.json` | `.github/workflows/ci.yml`、`scripts/pre-merge-check.sh`、`.github/workflows/release-desktop.yml`、`.env.example`、`SETUP.md` |
| 复用契约 | `docs/reuse/REUSE-MATRIX.md`、`docs/reuse/runtime-deployment.md`、`docs/reuse/observability.md`、`docs/architecture/reuse-review/runtime-deployment.md`、`docs/architecture/reuse-review/observability.md` | 对应 feature/ADR/代码路径 |

### 1.3 本报告不声称什么

- 不声称 Clowder 的运维体系是“生产级完整方案”；它也有明显缺口（见 §3.5）。
- 不声称 codeteam 的 W5d/W6c 代码没有价值；它们已经有正确接缝，缺的是
  生产组合与运维面。
- 不声称任何备份/恢复/告警方案已经验证；本报告只给切片和验收条件。
- 不把 Clowder 的 Redis/账号/部署假设带进 codeteam。

## 2. codeteam 现状校准

### 2.1 已有能力

| 能力 | 落点 | 状态 | 真实边界 |
|---|---|---|---|
| daemon identity / readiness | `packages/codeteam-daemon/src/daemon.ts`、`src/state.ts` | 已实现（库） | `startDaemon()` 由调用方传 `installationRoot`/`runningRevision`；`/health`、`/ready`、`/metrics` 只在进程内 server 提供 |
| boot ledger / 单写者 fence | `src/boot-ledger.ts`、`src/fence.ts`、`src/paths.ts` | 已实现 | `CODETEAM_DATA_DIR` 必须显式给出；`stateFile`/`ledgerFile`/`lockFile` 0600/0700 |
| 停启生命周期 | `src/lifecycle/service.ts`、`src/lifecycle/*`、`src/cli/daemon.ts` | 已实现 | CLI 只有 `daemon status`、`daemon stop`；`restart` 的新进程启动是 external executor 责任，尚未提供 |
| deployment wait | `src/deployment-wait/*`、`src/cli/deployment.ts` | 已实现 | `revision_included` 使用精确 `runningRevision`；`runningRevision` 目前由调用方传入，没有 build stamp 解析 |
| control SQLite | `src/control/database.ts`、`src/control/migrations/*` | 已实现 | WAL、foreign_keys、busy_timeout、forward-only migrations；schema ahead fail closed；没有备份/恢复命令 |
| memory DB | `src/memory/database.ts` | 已实现 | 独立 `memory.db` 派生索引；架构 §12.2 明确“不进 control 备份清单” |
| artifact store | `src/control/stores/artifacts.ts` | 已实现 | 内容寻址 `<dataDir>/artifacts/<sha256>`；eval artifact 不可删 |
| artifact/worktree GC | `src/scheduling/artifact-gc.ts`、`src/scheduling/worktree-pool.ts` | 已实现 | 默认 dry-run；没有生产定时调用；worktree 内容仍由 executor checkout |
| structured logs | `src/observability/logs.ts` | 已实现（库） | 0600 JSONL、10MB/5 文件/14 天、strict fields、A/B redaction；**当前没有业务写入者** |
| trace ring | `src/observability/trace-store.ts`、`tracer.ts` | 已实现（库） | 10k spans / 24h、内存、重启丢失、默认 redacted DTO；OTLP 默认关 |
| metrics | `src/observability/metrics.ts`、`runtime.ts` | 已实现（库） | Prometheus 文本快照、label allowlist、series cap；没有 scrape 配置/alert rule |
| F150 tool usage | `src/control/stores/tool-usage.ts`、`src/workers/event-sink.ts` | 已接线（executor 构造时） | SQLite `tool_usage_events` + `tool_usage_counters`；90 天保留；没有 HTTP 读面 |
| trajectory | `src/observability/trajectory.ts` | 已实现（库） | 只读 `runs`/`run_events`/`messages`/`queue_entries`；没有 HTTP 读面 |
| CI | `.github/workflows/ci.yml` | 已启用 | scope classifier + build/check/test + supply-chain + MCP conformance；没有 codeteam 发布/升级流程 |

### 2.2 关键缺口

| 缺口 | 证据 | 影响 |
|---|---|---|
| 没有生产 `daemon start` | `packages/codeteam-daemon/src/cli/index.ts` 仅列出 `daemon status` / `daemon stop`；`startDaemon()` 只在测试/库调用 | W7a 的 HTTP/API 没有真实宿主；W5d 的 readiness/boot ledger 无法在生产产生 |
| 没有 supervisor 契约 | `docs/plans/0013...` 明写“restart CLI 的 external start 未接 supervisor”；`docs/plans/0004` W7 只写“W7 独立 supervisor/controller” | 进程崩溃/机器重启后无人拉起；操作员只能手工执行 |
| 没有 build stamp | `startDaemon()` 的 `runningRevision` 由调用方传入；仓内没有 `.build-commit` 解析器 | 无法证明“正在运行的是哪个构建”；deployment wait 的 revision 条件缺少可信来源 |
| 日志没有业务写入者 | `rg JsonlLogStore` 只命中 `runtime.ts`/测试；没有 `logs.append(...)` 调用 | 日志文件不会在生产出现；W6c 的 F130 parity 只是代码接缝 |
| `/ready`/`/metrics` 没有生产入口 | 只有 `startDaemon()` 内部 HTTP server；CLI 没有 start | operator 无法访问；Prometheus 无法抓取 |
| 没有日志聚合/shipping | `src/observability/logs.ts` 只写本地文件；无 exporter | 多主机/远程 worker 场景无法集中排障（但 v1 单机可接受本地文件） |
| 没有告警/SLO | 无 burn-rate/alert 代码；只有 `/ready` 和 metrics | 只能被动查看，不能主动发现磁盘满、队列堵、错误率升高 |
| 没有 dashboard | W7b 尚未开始；W7a 只有读 API 计划 | operator 没有“看”的界面；CLI/JSON 是唯一入口 |
| 没有备份/恢复 | 无 backup/restore 命令；架构 §17.4 只有承诺 | control.db 损坏/误删/升级失败时无法恢复；违反 P5“可验证才算完成” |
| 没有升级/回滚流程 | migrations 是 forward-only；没有升级前备份、版本 stamp、回滚脚本 | 升级失败可能只能手工修库；架构 §17.5 的“双版本 dual-run/可回滚”未落地 |
| 没有 `.env.example`/config registry | 仓根无 `.env.example`；环境变量散落在源码/复用卡（约 80+ 个 `CODETEAM_*`） | operator 无法可靠 provisioning；启动错误只能靠猜 |
| 没有 ops runbook | `docs/` 下没有 `ops/` 或 runbook；只有报告/计划 | 首次故障处理依赖个人记忆；与 Clowder `SETUP.md` 的 troubleshooting 仍有差距 |
| 没有 codeteam 自身发布流程 | `package.json` 继承 pi 的 release/publish 脚本；codeteam 包版本 `0.0.0` | 没有 codeteam 版本、changelog、制品、回滚目标 |

## 3. Clowder AI 基础设施对标

### 3.1 运行与部署

**Clowder 的入口与冻结模型**

- `pnpm start` → `scripts/start-entry.mjs` → `scripts/runtime-worktree.sh start`。
  runtime worktree 默认在项目旁的独立目录，fetch 一次 `origin/main`，冻结
  一个精确 SHA，ff-only 同步，再执行 build invariant；运行态是 **passive
  frozen**，不会因为源文件变化自动重启（`scripts/runtime-worktree.sh` 头部
  usage/contract）。
- `runtime-worktree.sh restart` 先做一次 ownership-verified stop，再走同一
  start 路径；`status` 读 runtime worktree 的 branch/head/dirty/ahead/behind；
  `daemon-status` 读 daemon state；`stop` 在确认 managed ownership 后停止。
- `scripts/start-dev.sh` 负责底层启动：profile（dev/production/opensource）、
  Redis 启停、API/前端/可选 sidecar、health wait、日志、daemon 模式、
  cleanup/trap。`--daemon` 写 `cat-cafe-daemon.log`，并在 `daemon-state`
  中记录 pid/ports/logFile/launchToken。
- **daemon state**（`scripts/daemon-state.mjs`）：state file + append-only
  boot ledger；启动前 `prepare`，启动后 `write`；`inspect` 区分
  running/missing/stale/mismatch；stale/foreign 不 ownership 不杀。
- **StopOperationRecord**（`scripts/lib/daemon-stop-operation.mjs`）：
  `requested → stopping → stopped → restart_authorized → restarted →
  reverified`，失败终态 `failed`/`stale_cleared`；独占 claim、frozen
  identity、executor 不在目标进程树、SIGTERM 后等整个进程集合消失、
  loopback health 复验。
- **部署身份**：installationId + deploymentId；`runningRevision` 只认启动时
  捕获的 build stamp，不拿磁盘 HEAD/远端 main 冒充；F300/F323 明确
  ready runtime 不等于 Task 完成。
- **外部执行者**：Web/Console 只提交 lifecycle intent/approval；实际启停由
  external executor 执行。`SETUP.md` 给出 systemd service 示例（`Restart=
  on-failure`），但仓库不自动安装 systemd unit；macOS 的 launchd 模板在
  F247 文档中出现，当前参考 checkout 的 `scripts/launchd/` 不存在，按
  upstream drift 处理，不当成可复用现成资产。
- **进程清理**：`scripts/cleanup-stale-dev-processes.mjs` 只按窄规则清理
  stale dev/MCP wrapper，`pnpm process:doctor` 是 dry-run，
  `pnpm process:cleanup` 才执行；Pencil/Chrome 等有保护规则，不做泛杀。

**对 codeteam 的结论**

- 复用 **契约**：installation/deployment identity、frozen build target、
  daemon state、boot ledger、StopOperationRecord、loopback health probe、
  external executor。
- 不复用 **形态**：runtime worktree 的 Git 同步、Clowder 的多端口
  API/Web/Redis、launchd/systemd 自动安装、PID 文件兼容迁移。
- codeteam 的 daemon 是单进程 control plane；W7a 需要的是 `daemon start`
  的外部执行者契约，不是把 Clowder 的 runtime worktree 搬进来。

### 3.2 可观测性 ops

**F130：四层本地日志**

| 层 | 载体 | 保留 | 职责 |
|---|---|---|---|
| 审计 | `data/audit-logs/*.ndjson` | 90 天 | 关键业务事件，不可变 |
| 取证 | `data/cli-raw-internal-archive/` | 3–7 天 | CLI 原始事件重放 |
| 运行 | `data/logs/api/*.log` | 14 天 | Pino 结构化 runtime log |
| 进程 | `data/logs/process/` | 7 天 | `start-dev.sh` stderr capture + 未迁移 console 兜底 |

- `scripts/logs-health.sh`：检查每层大小（>500MB 告警）、保留期漂移、
  最近 1 小时 `level=50` 错误数（>100 告警）；输出 `LOG_LEVEL` 和各层路径。
- Pino 配置独立 `REDACT_PATHS`；OTel log 不替代 Pino；MCP stdio 保留
  stderr（F130 KD-6）。

**F153：trace/metrics/readiness**

- OTel SDK init；metric attribute allowlist；A–D redaction（credential/
  business content/system identifier/operational metadata）；local trace ring
  10k/24h；Prometheus scrape + 可选 OTLP；`/ready`。
- Phase E：`LocalTraceStore`、`MetricsSnapshotStore`（30s 采样，720 snapshot
  cap，6h TTL）、`/api/telemetry/traces`、`/metrics`、`/metrics/history`、
  `/health`；所有 `/api/telemetry/*` 走 Hub session/cookie auth，不走公开
  `/ready` 模式。
- burn-rate alert（`packages/api/src/infrastructure/telemetry/burn-rate-monitor.ts`）：
  error rate、p95 latency、active invocations 阈值，默认
  `TELEMETRY_ALERT_ERROR_RATE=0.3`、`TELEMETRY_ALERT_P95_LATENCY_S=120`、
  `TELEMETRY_ALERT_ACTIVE_INVOCATIONS=50`；连续 3 次 breach 才触发，
  WebSocket 推送。
- 明确边界：F153 是 **descriptive observability**，不是 eval/质量判断；
  不引入 Grafana/Tempo/Sentry。

**F150：tool usage**

- Redis `tool-stats:*` counter + JSONL 冷存档；不是 F153 的派生投影。
- codeteam 已适配为 SQLite `tool_usage_events`/`tool_usage_counters`，
  幂等键 `run_events.id`，90 天保留。

**对 codeteam 的结论**

- 已有 W6c 的代码面与 F153/F130 语义一致；不要重写。
- 需要补的是 **接线与读面**：日志写入、`logs:health`、operator 只读 API、
  burn-rate 告警、W7b dashboard。
- 不应把“日志/trace/metrics 代码存在”当成“可观测性已交付”；验收必须看
  真实 daemon 运行后是否产生文件/序列/span。

### 3.3 数据与恢复

**Clowder 的数据面**

- Redis 是主数据面：`REDIS_DATA_DIR`（默认 `~/.cat-cafe/redis-dev`）、
  RDB + AOF（`user-redis.sh` 使用 `--appendonly yes`、`appendfsync everysec`）。
- 起停快照：`start-dev.sh` 在 pre-start/pre-stop 写 Redis 快照；
  `redis-backup-retention.mjs` 的保留策略是“最近 3 个 + 最近 7 天每天 1 个
  + 最老锚点 + manual 永不删”；不完整 RDB（缺 header/EOF envelope）不进
  恢复槽位，但仍保留供人工检查。
- 外置备份：`user-redis-autobackup.sh` 在 macOS launchd 上按 60 分钟跑
  `user-redis.sh backup`，复制到 iCloud/本地 offsite，默认保留 120 个
  offsite 快照；strict 模式失败可让任务失败。
- 线程导出：`thread-exports-sync.sh` 把 `thread-*.md` 同步到仓库/离机目录，
  生成 snapshot + `manifest.txt`（shasum），默认保留 30 个 snapshot。
- 灾难查找：`find-redis-dumps.sh` 扫本地路径、Time Machine、外置卷的
  `dump.rdb`。

**Clowder 恢复面的缺口**

- `scripts/user-redis.sh` 的 `restore` 子命令调用
  `scripts/redis-restore-from-rdb.sh`，但当前参考 checkout 中不存在该文件
  ——upstream 脚本漂移；不能把“有 restore 命令”当成已验证恢复链路。
- Clowder 没有 SQLite 控制库，也没有通用的“control DB + artifact manifest
  + schema version”恢复演练；codeteam 需要自己设计。
- `docs/ops/` 只有 2 篇（公开迁移说明、gate continuity claim），没有正式
  incident/backup runbook；`SETUP.md` 只有 troubleshooting/背景说明。

**对 codeteam 的结论**

- 可复用 **策略**：起停前快照、保留分层（recent/daily/oldest/manual）、
  完整性 envelope、offsite copy、manifest + dry-run restore。
- 不可复用 **存储机制**：codeteam 没有 Redis；必须用 SQLite online backup
  （`VACUUM INTO` 或等价）+ WAL checkpoint + artifact manifest。
- 先定义“备份清单”再写命令：control.db 是 mandatory；memory.db 是派生
  可重建；logs/traces 可选；tokens 不应备份；credentials 必须单独处理
  （见 §5.1 OPS-2）。

### 3.4 开发/CI/发布

**Clowder**

- CI（`.github/workflows/ci.yml`）：lint、build、public test shards、
  supply-chain、mcp conformance 等；PR 到 main 触发。
- 本地/合入门禁：`scripts/pre-merge-check.sh` 冻结 origin/main、分类
  targeted/reusable green/full、跑 build/tsc/test/lint/check；`pnpm gate`
  是 merge-gate 硬门禁。
- 配置：`.env.example` 约 11KB，按核心端口/owner/Redis/模型密钥/voice/
  Feishu/Telegram/workspace 等分组；`packages/api/src/config/env-registry.ts`
  是 env 元数据/敏感标记/可编辑性的单一来源；测试覆盖 env registry/example/
  port drift。
- 发布：`release-desktop.yml` 编排 macOS DMG + Windows 安装包；`build-binaries.yml`
  构建 pi 二进制/npm 包；`scripts/release.mjs`、`version:*`、`publish.mjs`
  有 lockstep 版本检查和 release notes。
- 安装：`scripts/install.sh` / `install.ps1` 一键安装；`SETUP.md` 有
  systemd 示例和 remote deployment 配置（`API_SERVER_HOST=0.0.0.0`、
  `FRONTEND_URL`、`DEFAULT_OWNER_USER_ID`）。

**codeteam**

- 已继承 pi 的 CI：scope classifier、`build:offline`、`check`、full test、
  supply-chain、MCP conformance。
- 没有 codeteam 自己的 release/version/changelog/制品流程；`package.json`
  的 `release:*`/`publish` 仍是 pi 的包发布逻辑，codeteam 包版本 `0.0.0`。
- 没有 codeteam 的 `.env.example`/env registry；没有 `doctor`/preflight。
- 结论：CI 不是 P0 缺口；**发布/升级流程**和**配置 preflight**是缺口。

### 3.5 Clowder 没有解决什么

| 缺口 | 证据 | 对 codeteam 的含义 |
|---|---|---|
| 没有集中式日志聚合/shipping | 依赖树只有 `@opentelemetry/exporter-prometheus`；没有 Loki/ELK/Datadog；F130 是本地文件 + logs:health | 不要以“对标 Clowder”为由先上 ELK；单机先用本地 JSONL + 读面 + logs health |
| 没有外部告警路由 | burn-rate 只通过 Hub WebSocket 推送；没有 Alertmanager/PagerDuty | 告警先落 operator inbox/Console；外部路由 P2 |
| 没有形式化 SLO | F153 有 burn-rate 阈值，但没有 SLO 文档/错误预算/告警 runbook | codeteam 需要自己定义最小 SLO（readiness/run success/queue lag） |
| 没有自动恢复演练 | Redis 备份有 retention/offsite，但 restore 脚本漂移；没有定期 restore drill | codeteam 的备份必须带 `--verify`/`--dry-run restore` 和演练记录 |
| 没有多主机 supervisor | systemd 只是示例；launchd 模板当前 checkout 缺失；生命周期执行者仍是外部宿主 | v1 单机 supervisor 足够；多主机 P2 |
| 没有 SQLite 控制库经验 | Clowder 是 Redis 主数据面 | codeteam 必须自己验证 SQLite online backup/WAL/迁移回滚 |

> 结论：Clowder 值得学的是“本地文件 + 明确保留 + 完整性校验 + 读面 +
> 外部执行者 + 备份策略”，不是“它有一套现成的集中式 ops 平台”。

## 4. Gap 矩阵

| # | 维度 | codeteam 现状 | Clowder 基线 | Gap | 决策 | 优先级 |
|---|---|---|---|---|---|---|
| 1 | 生产启动 | `startDaemon()` 库函数；CLI 无 start | `runtime-worktree.sh start` + `start-dev.sh --daemon` + daemon state | 无真实宿主/启动命令 | R1 适配 | **P0** |
| 2 | 进程监督 | 无 supervisor；W5d 只提供 stop/authorize/reverify | systemd 示例 + external executor；daemon state/boot ledger | 崩溃/重启后无人拉起 | R1 适配（外部 supervisor，不进 daemon） | **P0** |
| 3 | 构建/版本身份 | `runningRevision` 由调用方传；无 build stamp | 启动时捕获 build stamp；不认磁盘 HEAD | 无法证明 serving revision | R1 适配 | **P0** |
| 4 | readiness/health | `/health` `/ready` 库内 server | `/ready` + loopback health probe + service readiness | 无生产可抓取入口 | R1 适配 | **P0** |
| 5 | 日志写入 | `JsonlLogStore` 无业务调用者 | F130 四层日志 + Pino 全量迁移 | 日志文件不会产生 | R1 适配 | **P0** |
| 6 | 日志保留/健康 | 10MB/5 文件/14 天，库内 rotation | 14/7/90/7 天 + `logs:health` + 错误率 | 无健康检查/告警 | R1 适配 | **P0** |
| 7 | 日志聚合/shipping | 无 | 无（Clowder 也是本地文件） | 单机不阻塞；多主机才需要 | R2/P2 | **P2** |
| 8 | metrics 抓取 | Prometheus 文本快照，无 scrape 配置 | Prometheus exporter（默认开） + optional OTLP | 无人抓取/无 dashboard | R1 适配 | **P0/P1** |
| 9 | trace | 10k/24h ring，OTLP 默认关 | F153 local ring + optional OTLP | 无读面/无跨重启 | R1 适配 | **P0（读面）/ P1（持久化）** |
| 10 | 告警/SLO | 无 | burn-rate monitor + WebSocket alert | 无主动告警 | R1 适配 | **P1** |
| 11 | dashboard/读面 | W7a 计划只读 API；W7b 未开始 | Hub telemetry/trajectory/tool usage 面板 | operator 无法“看” | R1 适配 | **P0（API）/P1（UI）** |
| 12 | 备份 | 无 | Redis RDB/AOF 快照 + retention + offsite + manifest | control.db 无保护 | R1 适配（SQLite） | **P0** |
| 13 | 恢复/演练 | 无 | 有备份策略；restore 脚本漂移、无演练 | 无法证明可恢复 | R1 适配 | **P0** |
| 14 | 升级/回滚 | forward-only migrations；无升级流程 | versioned release + dual-run/rollback 承诺 | 升级失败无退路 | R1 适配 | **P0** |
| 15 | 配置/secret preflight | 无 `.env.example`/registry/doctor | `.env.example` + env registry + env tests | operator provisioning 靠猜 | R1 适配 | **P0** |
| 16 | 进程/端口/worktree 清理 | worktree/artifact GC 默认 dry-run，无定时 | `process:doctor/cleanup` + worktree reaper | 磁盘/端口泄漏 | R1 适配 | **P1** |
| 17 | 发布/版本 | 继承 pi release；codeteam `0.0.0` | release workflows + version scripts + changelog | 无 codeteam 制品/版本 | R1 适配 | **P1** |
| 18 | runbook/incident | 无 | `SETUP.md` troubleshooting + ops notes；无正式 runbook | 首次故障靠个人记忆 | R2/P1 | **P1** |
| 19 | 多主机/远程 worker ops | 未实现 | Clowder 也没有多主机 supervisor | 不阻塞 v1 | R2/P2 | **P2** |
| 20 | Redis 专项 | 无 Redis | Redis 备份/恢复/AOF/RDB | 不适用 | Drop | **Drop** |

> 决策口径沿用 `REUSE-MATRIX`：`R1` = 适配复用契约/语义；`R2` = 只借鉴
> 模式；`new` = codeteam 自建；`Drop` = 明确不做。本表是 ops 切片优先级，
> 不改变已签的 cell 卡决策。

## 5. 推荐实现切片

### 5.1 P0 切片

#### OPS-1 `ops-bootstrap` — 让 daemon 真正可启动、可监督、可证明版本

**为什么 P0**：没有真实 daemon，W7a API/Console、W6c 日志/trace、
W5d deployment wait 都只是测试 fixture；operator 无法完成一次真实运行。

**范围**

- `codeteam daemon start`（或 `codeteam daemon run --foreground`）：
  作为 external executor 入口，完成 `CODETEAM_DATA_DIR`/installation
  preflight、fence、生产 control-plane 组合、恢复、`startDaemon()`、
  `markReady()`、signal handling、graceful stop；不提供 daemon 内自重启。
- **恢复先于 ready**：start 路径先构造 `ControlStore` + `WorkerRuntime`，
  调用 `WorkerRuntime.recover({ activeRunIds })`；`activeRunIds` 来自当前
  worker registry，单机无 registry 时必须显式空集，不能跳过 recover。
  上一 boot 的 `running` runs 必须转 `interrupted`、`attached` sessions 转
  reattach-pending；recover 失败/不可证明时 fail closed，不 markReady。
  这是 W5d-M1 的最终接线点，不能继续悬空。
- **restart 链闭合**：提供 `codeteam daemon restart --op <opId>`（或
  `daemon start --resume-op <opId>`），同一 opId 串
  `authorizeRestart → stop → start → recordRestart → reverify`；
  `recordRestart` 必须用新 boot 的 state file、boot ledger、process
  identity 现场校验。start 只负责新 boot；restart 不能把
  `restart_authorized` 悬挂。
- supervisor 契约：文档给出 systemd/launchd 的 opt-in 示例（不自动安装）；
  `ExecStart` 只调用 `codeteam daemon run`，`Restart=on-failure` 是宿主
  责任；codeteam 不写第二 process registry。
- build stamp：构建时写 `.build-commit`（daemon；W7b 可加 web），启动时
  解析所有 declared service 的 stamp；不一致/缺失 → `runningRevision=null`
  并显示 unknown，不拿 checkout HEAD 回填。**类型必须 widening 为
  `string | null`**（`StartDaemonOptions`、state file、status JSON、
  deployment wait 全部按 null=unknown 处理）；禁止 sentinel 字符串，
  `revision_included` 不得匹配 null。
- `daemon status` 输出：state、pid、bootId/bootSequence、runningRevision、
  ready、healthPort、log path、data dir；`--json` 可机读。
- `/ready`/`/metrics` 在生产 server 中真实可达；`/health` 保持 W5d
  契约。
- `CODETEAM_DEPLOYMENT_SERVICES` 默认 `daemon`；未声明服务不得写 ready。

**AC**

- 在隔离 data dir 启动真实 daemon，`/ready` 200 + `status:"ready"`；
  `/metrics` 200 且有 `codeteam_telemetry_up`；
  `daemon status --json` 的 `runningRevision` 等于 build stamp。
- build stamp 缺失/两服务不一致 → `runningRevision=null` + typed unknown；
  不报 ready；state/status JSON 与 deployment wait 均按 null 处理。
- 已有 daemon 时 `start` 返回 typed `already_running`（error code 或 status
  字段）并非零退出，不启动第二个；stale state 只有身份可证时才清理；
  不可证时 fail closed。
- crash 重启 fixture：注入 running run + attached session → 重启 →
  `recover()` 在 `markReady()` 之前把二者转为 `interrupted` /
  reattach-pending；`/ready` 不早于 recovery 完成。
- authorized restart fixture：stop → `authorizeRestart` →
  `daemon restart --op` → `recordRestart`/`reverify` 同一 opId 闭环；
  缺 opId、身份不匹配、health 不匹配均 fail closed，不留
  `restart_authorized` 悬挂。
- SIGTERM → graceful stop，boot ledger 有 `stopping/stopped/exited(clean)`；
  SIGKILL 后重启 → boot ledger 无 exit 证据显示 unknown，不伪写 clean。
- supervisor 示例文档通过一次手工/容器 smoke（不要求在 CI 启动 systemd）。

**不做**：不在 daemon 内做 supervisor；不自动安装 systemd/launchd；不把
Web/API 启停私有化；不引入第二 process registry。

**风险**：PID 复用、端口冲突、启动失败误报 ready、build stamp 伪造。
处置：frozen identity/health body 校验、loopback only、stamp 由构建链写且
与 `UPSTREAM.md` 绑定。W5d-R2（pid 复用窄缝）保留为已知残留：身份不可证
时 fail closed 为 `already_running`/拒绝启动，不在本切片当新 bug 重挖。

#### OPS-2 `ops-data-protection` — 备份、恢复、升级、回滚

**为什么 P0**：control.db 是唯一真相；没有备份就谈“可恢复/可审查”不成立。
架构 §17.4 已承诺；W7 任务 9 需要落地。

**范围**

- `codeteam backup create [--out DIR] [--label]`：
  - SQLite online backup（`VACUUM INTO` 或 `node:sqlite` backup API）+ WAL
    checkpoint；不直接复制正在写的 `control.db`。
  - 备份 manifest：`backupVersion`、`createdAt`、`codeteamVersion`、
    `buildSha`、`schemaVersion`、每个文件的相对 data-dir 标识
    （如 `control.db`、`artifacts/<sha256>`）与 sha256/bytes；不存绝对
    路径。确需取证宿主路径时写单独的非可移植 sidecar，默认不生成、不进
    portable archive。artifact 文件按内容 hash 记录。
  - 备份目录 0700、文件 0600；不写 secret 明文（manifest 不包含 key 内容）。
- `codeteam backup list/verify`：列出备份、校验 manifest、校验 manifest
  中每个文件的 sha256；verify 失败非零退出。
- `codeteam restore --from DIR --dry-run|--apply`：
  - `--dry-run` 只读校验 schema 兼容性/文件完整性/目标目录为空或显式
    `--allow-overwrite`；
  - `--apply` 恢复到**新的 data dir**（或显式停止 daemon 后的空目录），
    不覆盖正在运行的 data dir；恢复后跑 `openControlDatabase` + 基础
    read model 校验（schema version、关键表 count、artifact hash）。
  - **运行态文件不回放**：`daemon-state.json`、`boot-ledger.jsonl`、
    `lifecycle/` 默认只作审计留存，restore 不把它们当作新 installation 的
    当前运行态。若显式导入，必须标 `imported:true` /
    `sourceInstallationId`，不得让旧 pid/ports/bootSequence 污染新 daemon。
- `codeteam backup prune`：保留策略可配置；建议默认“最近 7 个 + 最近 28 天
  每天 1 个 + manual 永不删”，与 Clowder 的 recent/daily/oldest/manual
  模式对齐（具体数字待 operator 拍）。
- **升级流程**：`codeteam upgrade preflight`（检查 schema、build stamp、
  disk、backup 是否存在）→ 停 daemon → `backup create` → 启动新版本 →
  `/ready` + `restore` 兼容性检查；失败回滚 = 恢复备份 + 启动上一版 build。
- **恢复演练**：`codeteam restore --dry-run` 可在 CI/本地 fixture 跑；
  真实演练记录写入 `docs/reports/` 或 runbook。

**AC**

- 在 fixture data dir 写入 control/artifact/memory/log 数据 → backup →
  verify 通过 → restore 到空目录 → `openControlDatabase` schema 版本一致、
  artifact sha256 一致、关键 task/run/approval 可读。
- 运行中 daemon 做 backup：不锁死写路径；backup 的 control.db 可打开；
  manifest 与文件一致。
- manifest 篡改/文件缺失 → verify/restore 失败；schema 比当前新 → restore
  拒绝；不静默降级。
- 备份/恢复日志/输出不包含 operator.key、run token、prompt/diff 正文。
- restore 到新 data dir 后，旧 `daemon-state.json`/boot ledger/lifecycle
  不冒充当前运行态；显式 imported 标注可见，未导入时新 daemon 从
  bootSequence=1 开始。
- 升级失败演练：用 fixture 模拟 build 启动失败 → restore 回旧备份 →
  旧 build 可启动；记录 command/result。

**备份清单建议**

| 路径 | 分类 | 默认 |
|---|---|---|
| `control.db` + WAL/SHM | 必需 | 备份（online backup，不直接 copy WAL） |
| `artifacts/` | 必需 | 备份（按 sha256 manifest） |
| `credentials/operator.key` / `operator.pub` | 敏感必需 | 备份时显式 `--include-credentials`；默认不打包，文档要求离线安全保管 |
| `lifecycle/`、`daemon-state.json`、`boot-ledger.jsonl` | 审计/恢复辅助 | 备份 |
| `telemetry-salt` | 敏感材料 | 默认备份以保持 trace HMAC 连续性；备份 archive 与 `credentials/` 同级保护；P2 offsite 必须加密；缺 salt 会使旧 `hmac_invocation_id` 失配并 fail closed |
| `memory.db` | 派生索引 | 默认不备份；可重建（架构 §12.2） |
| `logs/` | 可选 | 默认不备份；按需 |
| `tokens/` | 临时凭据 | 永不备份 |
| `state/auth.sqlite`（文档计划） | 当前代码未实现 | 等实现后再纳入；见 §8 D5 |

**风险**：备份 operator key 或 telemetry-salt 造成新的泄露面；SQLite
backup 与 daemon 并发写；restore 覆盖活动数据；schema 版本漂移。处置：
默认不打包 key、salt 按敏感材料保护、恢复仅允许空目录/显式 overwrite、
restore 前强制停 daemon、schema ahead 拒绝。

#### OPS-3 `ops-config-preflight` — 配置、secret、环境可 provisioning

**为什么 P0**：v1 零 secret + 文件型凭据；没有统一清单，operator 无法可靠
启动，也无法审计“哪些是 secret、哪些是配置”。

**范围**

- 新增 `.env.example`：只列 codeteam 实际使用的变量，按
  `core/data/auth/telemetry/logging/workers/memory/eval/github` 分组；
  secret 值留空并注明“文件型，不放 env”（operator.key、webhook secret 等
  例外按 W8 设计）。
- 新增单一 config registry（代码或生成文档）：变量名、类别、默认值、
  是否敏感、是否可热更新、消费者、owner。先覆盖 §2 的 `CODETEAM_*` 清单。
- `codeteam doctor [--json]`：
  - data dir 存在且 0700；control.db 可打开/schema 版本；memory.db 可选；
  - `credentials/operator.key`/`.pub` 0600；auth 可读；
  - `telemetry-salt` 0600 或显式 disabled；
  - log/artifact/worktree 目录可写；disk free 阈值；
  - 端口/installation root/deploymentId 合法；
  - 输出 typed pass/warn/fail，不输出 secret 内容。
- 启动时复用 doctor 的 fail-closed 检查；配置错误在启动前给出明确原因，
  不等到运行中崩。

**AC**

- 空环境启动：doctor 给出 missing data dir/operator key 的 typed 错误；
  按提示 `auth init` + 创建 data dir 后可启动。
- 权限漂移（data dir 0755、operator.key 0644、salt 0644）→ doctor fail /
  daemon fail closed；不自动“修复”而不告知。
- `doctor --json` 不包含 key/token 明文；CI 有 secret scan。
- `.env.example` 的每个变量都能在 registry/消费者中找到；无“文档有、代码
  不读”或“代码读、文档无”的漂移（加一个检查脚本）。

**不做**：不引入 Vault/KMS/云 secret manager；不把 key 放 env；不做通用
配置 UI（W7b 之后再说）。

#### OPS-4 `ops-observability-wiring` — 让日志/trace/metrics 真的流动

**为什么 P0**：W6c 的代码接缝已经存在；不接线就等于没有。

**范围**

- 生产组合 `startDaemon()` 创建 `ObservabilityRuntime`；daemon 生命周期
  （start/ready/stop/fail）、dispatch、worker start/end、tool call、
  gate/merge 关键事件通过 `JsonlLogStore.append` 写结构化日志；strict
  fields，未知键 redact。
- `WorkerEventSink` 已有 tool usage/tool span；确保 executor 生产路径
  注入 `observability` 和 `toolUsage`，错误降级不阻塞 control plane。
- `codeteam logs health`（或 `codeteam doctor logs`）：复用 F130
  `logs:health` 语义：每层大小、保留期漂移、最近 1 小时 error 数；输出
  config summary。
- W7a 只读 API（按 `docs/plans/0004` W7 任务 1/5）：
  `/api/logs/tail`、`/api/tool-usage`、`/api/telemetry/traces`、
  `/api/telemetry/health`、`/api/invocations/:id/trajectory`；operator/
  console auth，run token 403；所有响应 redacted。
- `/ready` 的 telemetry 组件状态在真实启动中可用；`/metrics` 可被本地
  Prometheus scrape（文档给 scrape 示例，不部署 Prometheus）。

**AC**

- 真实 daemon 跑一次 fixture task：`<dataDir>/logs/daemon.log` 出现
  结构化条目；`/api/logs/tail` 返回脱敏条目；`/api/tool-usage` 有计数；
  `/api/invocations/:id/trajectory` 可读；trace 命中或显式
  `trace_unavailable`。
- `/ready` 在 telemetry 组件失败时 200 + `degraded`，control plane 仍
  可用；不把未初始化报 healthy。
- 日志文件 0600、rotation/retention 生效；`logs health` 对超限/超期/错误率
  给出非零退出。
- 泄漏测试：prompt/diff/file content/credential 不出现在日志/trace/
  tool usage/tail 响应。

**不做**：不引入 Pino/OTel SDK（W6c 已决定）；不做第二事件账本；不把
dashboard 放进本切片（W7b）。

### 5.2 P1 切片

| 切片 | 内容 | 验收 |
|---|---|---|
| **OPS-5 SLO/告警** | 适配 burn-rate：error rate、p95 latency、active runs、queue lag、log growth、disk free、SQLite busy；告警落 operator inbox/Console，去重/静默；不接外部 pager | 阈值可配置；连续 breach 才触发；恢复自动清除；告警正文不含 raw content |
| **OPS-6 runbook/incident** | 启动/停止/重启；升级/回滚；备份/恢复；磁盘满；SQLite locked/corrupt；stuck queue；deployment wait unknown；日志/trace 排障；secret rotation；incident 模板 | 每个场景有 command、预期输出、失败处置、升级路径；至少一次本地演练记录 |
| **OPS-7 release/version** | codeteam 版本（semver）、changelog、release checklist、制品（CLI/daemon 包）、build stamp 与 tag 绑定；发布前跑 full gate；回滚目标明确 | `codeteam --version` 与 tag/build stamp 一致；release notes 有变更/风险/回滚；不破坏 SQLite |
| **OPS-8 hygiene** | `codeteam doctor` 扩展进程/端口/worktree/artifact 检查；定期 `artifact gc`/`worktree gc`/log prune；stale worker/lease 清理；磁盘水位 | dry-run 默认；显式 apply 有 audit；不杀非本 installation 进程；worktree 活跃 run 保护 |

### 5.3 P2 / 条件触发

| 项 | 触发条件 | 说明 |
|---|---|---|
| 日志 shipping/聚合 | 远程 worker、多 installation、或多主机 | 优先 OTLP logs 或 Vector/Fluent Bit；不以 ELK 为默认 |
| 外部 Prometheus/OTLP/Grafana | operator 需要跨主机/长期趋势 | codeteam 只提供 `/metrics`/OTLP contract；不内嵌后端 |
| trace 持久化 | 重启后追溯成为重复需求 | 可选 SQLite trace 表 + retention；先证明确有需要 |
| 异地备份/自动恢复演练 | 单机数据开始承载不可重建的工作 | 复用 Clowder 的 offsite copy + manifest 模式；加密/权限单独设计 |
| 多主机 supervisor/controller | 远程 worker/多 deployment | 仍由 external executor；不在 daemon 内建第二 supervisor |
| 集中式审计/取证层 | 合规或真实取证需求 | 当前 `run_events` + `audit` + JSONL 足够；不要提前复制 F130 四层 |

### 5.4 Drop

- Redis AOF/RDB/`redis:user:*`/`find-redis-dumps`：codeteam 无 Redis。
- Clowder 的 IM 网关、桌面安装包、语音/会议服务运维：与代码 agent 无关。
- 默认 Grafana/ELK/K8s/Prometheus server：codeteam 是 local-first 单机
  runtime；先把本地读面/文件/CLI 做好。
- daemon 内自重启/自升级：生命周期执行者必须在目标进程集合之外。
- 整套复制 Clowder 的审计/取证日志层：codeteam 已有 canonical
  `run_events`/`audit`，不需要第二套事件账本。

## 6. 推荐顺序

```text
OPS-3 config/secret preflight
        ↓
OPS-1 bootstrap + supervisor + build stamp
        ↓
OPS-4 observability wiring + read surfaces + logs health
        ↓
OPS-2 backup / restore / upgrade / rollback
        ↓
W7a dogfood（真实 thread/task/run/approval）
        ↓
OPS-5 alerting + OPS-6 runbook + OPS-7 release + OPS-8 hygiene
        ↓
P2（shipping / external backend / trace persistence / multi-host）
```

理由：先让 operator 能可靠启动并看到真实数据，再在数据开始积累前把备份
恢复做好；告警/dashboard 放在有真实指标和读面之后，避免为空指标设计告警。

## 7. Review focus

### 砚砚（security/ops/secret/backup）

- 备份是否默认打包 `operator.key`？建议默认不打包，显式 opt-in；备份文件
  0600、目录 0700；manifest 不含 secret 明文。
- restore 是否可能覆盖活动 data dir？必须只允许空目录或显式 overwrite，
  且 daemon 已停止。
- doctor/日志/tail 是否泄露 key/token/prompt/diff；telemetry salt 权限
  漂移是否 fail closed。
- SQLite online backup 的并发/一致性；WAL/SHM 处理；schema ahead 拒绝。
- supervisor 示例是否给错权限（不要 root 运行；不要 `Restart=always` 掩盖
  启动失败）。

### 烁烁（daemon/runtime/部署接口）

- `daemon start` 与 W5d StopOperationRecord/authorizeRestart/reverify 的
  接线：同一 opId、同一 frozen identity、executor 不在目标进程树。
- build stamp 解析与 `runningRevision`；混装/部分构建/缺失 stamp 的
  unknown 语义。
- PID 复用/端口冲突/双启动/daemon crash 的测试；worker `recover()` 必须
  在 `markReady` 前跑（W5d M1 未接线项）。
- 不建第二 process registry/supervisor；supervisor 只是 external executor
  的宿主。

### 墨墨（process/runbook/operator UX）

- operator 是否能按 runbook 完成：启动 → 发任务 → 看日志/trace/tool usage
  → 停/重启 → 备份 → 恢复 → 升级/回滚。
- 错误信息是否可读、是否告诉下一步；unknown 是否显式；不要把“文件存在”
  当“功能可用”。
- W7b dashboard 是否只读投影；是否与 CLI/JSON 一致。

## 8. 待 operator 决策

| # | 问题 | 建议 | 不决策的影响 |
|---|---|---|---|
| D1 | W7a 是否包含 `codeteam daemon start`（external executor CLI）？ | **包含**；只做 CLI/foreground，不做 daemon 内 supervisor | W7a API/Console 没有真实宿主；W6c 继续是“代码接缝” |
| D2 | 备份保留策略/是否默认备份 operator key？ | 默认 **7 个 recent + 28 天每日 + manual 永不删**；operator key 默认不打包，显式 `--include-credentials` | 备份可能过少或泄露面过大；无法定验收 |
| D3 | v1 是否明确单机、多主机 P2？ | **是**；v1 只支持单 installation/单 serving daemon | 容易过早设计多主机 supervisor/集中式后端 |
| D4 | 日志 shipping/集中式后端是否现在做？ | **不做**；先本地 JSONL + logs health + W7a 读 API；远程 worker 出现再触发 | 提前引入 ELK/Grafana，成本高且无真实需求 |
| D5 | `auth.sqlite` 与 `control.db` 的凭据归属？ | 以当前代码为准：invocation credentials 登记在 `control.db.invocation_credentials`，token 原文在 `tokens/`（永不备份），operator key 在 `credentials/`；`auth.sqlite` 尚未实现。修正 `docs/architecture/reuse-review/callback-auth.md` 的 `CODETEAM_AUTH_DB` 行，并同步修正 `runtime-deployment.md` 的 `backupScope`：改为 manifest 点名，显式排除 `tokens/`/`logs/`/`memory.db`，`credentials/` 单独 opt-in | 备份清单和恢复演练会按错误文档设计；按“全目录”实现会把 tokens 带进备份 |
| D6 | `memory.db` 是否进备份？ | **不进**；派生索引可重建；备份清单显式排除 | 与架构 §12.2 冲突；恢复后可能带入过期索引 |

> 这些是产品/数据边界决策，不是技术 A/B。若 operator 不逐条回答，建议按
> “建议”列执行；D5/D6 是文档一致性问题，可由架构 owner 在 W7a 前修正。

## 9. 证据与边界

### 9.1 codeteam 关键路径

| 主题 | 路径 |
|---|---|
| daemon 生命周期 | `packages/codeteam-daemon/src/daemon.ts`、`src/state.ts`、`src/boot-ledger.ts`、`src/paths.ts`、`src/fence.ts` |
| 停启 | `packages/codeteam-daemon/src/lifecycle/service.ts`、`src/lifecycle/health.ts`、`src/cli/daemon.ts` |
| deployment wait | `packages/codeteam-daemon/src/deployment-wait/*`、`src/cli/deployment.ts` |
| 控制库 | `packages/codeteam-daemon/src/control/database.ts`、`src/control/migrations/index.ts` |
| 可观测性 | `packages/codeteam-daemon/src/observability/{runtime,logs,trace-store,metrics,tracer,trajectory,contracts}.ts` |
| tool usage | `packages/codeteam-daemon/src/control/stores/tool-usage.ts`、`src/workers/event-sink.ts`、`src/workers/executor.ts` |
| artifact/worktree | `packages/codeteam-daemon/src/control/stores/artifacts.ts`、`src/scheduling/artifact-gc.ts`、`src/scheduling/worktree-pool.ts` |
| 架构承诺 | `docs/architecture/0001-codeteam-architecture-v1.md` §12.4/§12.5/§15/§17 |
| W7 计划 | `docs/plans/0004-w5-w8-scale-product.md` §W7（任务 9：备份/恢复、migration、升级） |
| W6c 边界 | `docs/features/F013-w6c-observability-trajectory.md`（生产 bootstrap 随 W7a） |
| W5d 边界 | `docs/plans/0013-w5d-runtime-lifecycle-managed-work.md`（external start 未接 supervisor） |
| 复用卡 | `docs/reuse/runtime-deployment.md`、`docs/reuse/observability.md`、`docs/architecture/reuse-review/runtime-deployment.md`、`docs/architecture/reuse-review/observability.md` |

### 9.2 Clowder 关键路径

| 主题 | 路径（相对参考 checkout） |
|---|---|
| runtime 启停 | `scripts/runtime-worktree.sh`、`scripts/start-dev.sh`、`scripts/start-entry.mjs` |
| daemon state / stop | `scripts/daemon-state.mjs`、`scripts/lib/daemon-stop-operation.mjs`、`scripts/lib/daemon-stop-record.mjs` |
| 日志治理 | `docs/features/F130-api-log-governance.md`、`scripts/logs-health.sh` |
| 可观测性 | `docs/features/F153-observability-infra.md`、`packages/api/src/infrastructure/telemetry/*`、`packages/api/src/routes/telemetry.ts` |
| tool usage | `docs/features/F150-tool-usage-stats.md` |
| Redis 备份 | `scripts/user-redis.sh`、`scripts/user-redis-autobackup.sh`、`scripts/redis-backup-retention.mjs`、`scripts/find-redis-dumps.sh` |
| 线程导出 | `scripts/thread-exports-sync.sh` |
| 配置 | `.env.example`、`packages/api/src/config/env-registry.ts`、`SETUP.md` |
| CI/合入 | `.github/workflows/ci.yml`、`scripts/pre-merge-check.sh` |
| 发布 | `.github/workflows/release-desktop.yml`、`scripts/release.mjs`、`scripts/publish.mjs` |
| 运行契约 | `docs/features/F300-self-sensing-home-state-awareness.md`、`docs/features/F323-runtime-restart-coordination.md` |

### 9.3 Clowder 已知漂移/缺口（不作为现成能力）

| 项 | 观察 | 处置 |
|---|---|---|
| ADR-039 文档 | `scripts/runtime-worktree.sh` 引用 `docs/decisions/039-runtime-passive-freeze.md`，当前 `docs/decisions/` 中没有该文件 | 以脚本 contract 为准；不把缺失文档当契约 |
| Redis restore | `scripts/user-redis.sh restore` 调用 `scripts/redis-restore-from-rdb.sh`，当前 checkout 无此文件 | 不把“有 restore 命令”当已验证能力；codeteam 自建 SQLite restore |
| launchd 模板 | F247 文档提到 `scripts/launchd/*.plist.template`，当前 checkout 无 `scripts/launchd/` | 不当成可复用资产；supervisor 示例由 codeteam 自己写 |
| 集中式 ops | 无 Loki/ELK/Grafana/Alertmanager 依赖 | 不先上集中式平台；本地读面优先 |
| 正式 runbook | `docs/ops/` 只有迁移说明/gate claim；无 incident/backup runbook | codeteam 自己写；可借鉴 `SETUP.md` troubleshooting |

### 9.4 验证状态

- 本次只读核对，**没有运行** codeteam/Clowder runtime、备份、restore、
  systemd/launchd 或故障注入。
- 因此本报告的 P0/P1 是“实现切片与验收条件”，不是“已验证交付”。
- 后续实现 PR 必须附：command、cwd、commit SHA、base、result、gap；
  备份/恢复切片必须有 fixture 恢复证据；bootstrap 切片必须有真实
  `/ready`/`/metrics` 证据。

---

## 10. Review follow-up（2026-10-30）

| Finding | Severity | 处置 |
|---|---|---|
| 砚砚 F1：telemetry-salt “不含 secret 用途”表述错误 | P2 | 改为“敏感材料”；默认备份、与 credentials 同级保护、P2 offsite 加密；缺 salt fail closed |
| 砚砚 F2：D5 漏了 `runtime-deployment.md` 的 `backupScope` 全目录表述 | P2 | D5 已点名两个文档；`backupScope` 改为 manifest 点名 + 显式排除 tokens/logs/memory.db，credentials 单独 opt-in |
| 砚砚 F3：manifest 的 `dataDir` 问号未定案 | P2 | 已定案：只存相对 data-dir 标识 + sha256；绝对路径只进非可移植取证 sidecar |
| 砚砚 F4：restore 对运行态文件的语义未写清 | P3 | 已写明运行态文件默认不回放；显式导入需标 `imported`/`sourceInstallationId` |
| 砚砚 F5：env 名简写与源码不符 | P3 | 改为 `TELEMETRY_ALERT_P95_LATENCY_S` / `TELEMETRY_ALERT_ACTIVE_INVOCATIONS` |
| 烁烁 F1：OPS-1 漏 W5d-M1 recover-before-markReady | P1 | OPS-1 范围/AC 已加入 `WorkerRuntime.recover({ activeRunIds })` 先于 `startDaemon()`/`markReady()`，并加 crash 重启 fixture |
| 烁烁 F2：`daemon start` 与 W5d restart 链另一半无归属 | P2 | OPS-1 增加 `daemon restart --op <opId>`（或 `start --resume-op`），同 opId 串 authorize→start→recordRestart→reverify |
| 烁烁 F3：`runningRevision=null` 与现状 string 类型冲突 | P2 | 明确 widening 为 `string` 或 `null`，state/status/deployment wait 全按 null=unknown，禁止 sentinel |
| 烁烁 F4：start 幂等 AC 与 fence throw 语义不一致 | P3 | AC 改为 typed `already_running` + 非零退出 |
| 烁烁 F5：W5d-R2 pid 复用窄缝 | P3 | 风险表记录为已知残留，身份不可证时 fail closed |

两位 reviewer 的 verdict 均为 approve（附修改项）；以上修改不改变 P0/P1
方向，也不需要新开 review 轮次。

[宪宪/deepseek-flash🐾]
