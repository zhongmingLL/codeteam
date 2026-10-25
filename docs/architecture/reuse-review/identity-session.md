---
title: "identity-session 架构复用检视"
doc_kind: architecture-review
status: approved
created: 2026-10-24
updated: 2026-10-24
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
operator_signoff: "approved 2026-10-24 (D2=A)"
source_cell: identity-session
source_card: ../../reuse/identity-session.md
template: ../0004-reuse-architecture-review-plan.md
---

# identity-session 架构复用检视

## 1. 总结

### 1.1 clowder feature 范围

- cell：`identity-session`
- canonical：F032 / F088 / F136 / F171 / F183 / F211 / F231 / F262 / F291 / F296 / F299 / F320 / F322
- **P0 范围**：稳定身份形状、`AgentProfile`/`AgentSession`、Session Chain 连续性、动态 role registry、review 独立性输入。
- **P1/P2 边界**：F231 user profile layers（P1-active）、F296 context epoch/presentation（P1-defer）、F299 request-generation/thread access（P1/W7）、F306/F322 runtime interaction（P1）、F211 external runtime（P1）、provider 多账号（P1）、connector binding（P1，transport 已 Drop）、F209 entity registry（out-of-scope）。

### 1.2 codeteam 复用总结

| 组件 | 立场 | 一句话 |
|---|---|---|
| `CatConfig` / roster 形状 | `adapt now` | 保留稳定身份字段；丢掉 codeteam 不需要的 UI/voice/breed 字段 |
| `AgentRegistry` | `adapt now` | 复用 profileId → AgentService 的运行时映射 |
| `RoleId` / role registry | `codeteam-new` | 1 profile = 1 primary role；多能力 = 多 profile；继承 F032 动态 roster 模式，不是类型复用 |
| `AgentProfile` | `adapt now` | 稳定身份；primary role + provider/model/family + roleDescription + tool policy + restrictions |
| `AgentSession` / `SessionRecord` | `extend now` | 复用 SessionRecord 全字段，新增 task/stage/profile/role/effectiveToolPolicy；不建第二 session store |
| Session Chain | `reuse now` + store adapt | active/sealing/sealed、seq、restore CAS、capsule 语义复用；codeteam store 用 SQLite |
| provider account | `defer→P1` | P0 只保留 profile provider/model；多账号 F320 P1 |
| connector binding | `defer→P1` | codeteam v1 不做 IM 网关；W7 只用 userId/threadId |
| bubble identity | `borrow` / reference-only | `BubbleStableIdentity` 归 bubble-pipeline；本卡只引用 tuple |
| runtime session / context epoch / request-generation / runtime interaction | `defer→P1` | 不进 W1 表结构 |
| F231 user profile | `defer→P1` | P0 不读取 clowder 私有 profile；`CODETEAM_DATA_DIR` 独立 |
| F209 entity registry | `out-of-scope` | 只作 memory 检索锚点，不是 roster truth |

### 1.3 已确认的决策

| # | 决策 |
|---|---|
| D1 | **A**：1 profile = 1 primary role；多能力 = 多 profile。角色单数化是 codeteam-new 的建模决策，不冒充 F032 类型复用。 |
| D2 | **A**：review/verify 都用 `evidence-collection`（可执行取证）；policy 集只有 `coding | evidence-collection`；允许 read/exec/screenshot(gated)/artifact/evidence/隔离 evidence worktree 写；禁 merge/approve/push/production-write/secret-read/被审 worktree 写；exec 受 W2 command/path policy 约束；review 执行证据不关闭 finding，falsifier 仍由 verifier 处置。 |
| D3 | **A**：`agent-config.json` 是 bootstrap/seed 真相，`agent_profiles` 表是运行时真相；启动只 upsert 新 profile，不覆盖人工变更，冲突 audit + 告警。 |
| D4 | **A**：保留 optional `chainKey` 作为稳定会话锚；codeteam 格式 `ct:<threadId>:<profileId>`，不复制 clowder `bg:` 格式。 |
| D5 | **A**：`permissionMode` 标 `codeteam-new`；headless 权限真相 = W2 tool policy + bwrap + approvals；native 交互模式只在未来 native carrier 出现时再接。 |

## 2. clowder 架构

### 2.1 架构图

```text
                         ┌──────────────────────────────┐
                         │ cat-config.json / CatRegistry│
                         └──────────────┬───────────────┘
                                        │ catId
                                        ▼
                              ┌──────────────────┐
                              │  AgentRegistry   │
                              └────────┬─────────┘
                                       │ AgentService
                                       ▼
  provider account resolver ──► launch descriptor / session
                                       │
  ConnectorThreadBindingStore ────────┤ external chat/thread
                                       │
                              ┌────────▼─────────┐
                              │ SessionChainStore│  per thread × cat
                              └────────┬─────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
  SessionRecord                 ContextEpochOwner /             RuntimeSessionStore
  active/sealing/sealed         PresentationLedger (F296)       (F211 external)
        │
        ├── TranscriptWriter / RequestGenerationProjector (F299)
        └── ThreadAccessPolicy (F299) ── sessions/transcript/invocations/theater

  ProfileRepository (F231) ── capsule / relationship primer / corpus
  BubbleStableIdentity (F183) ── frontend bubble identity
```

### 2.2 数据流

1. **启动**：`cat-config.json` 加载 roster；`AgentRegistry` 按 catId 注册 `AgentService`；provider account resolver 准备 launch snapshot。
2. **调用**：actual cat routing → effective role/provider/model/effort/speed → `SessionChainStore` 取 active session（per thread × cat）→ L0 compile（roleDescription + restrictions）→ provider launch → Run/response bubble/transcript。
3. **连续性**：SessionRecord `active → sealing → sealed`；seal 时写 transcript/digest/capsule；下一 session 从 capsule/bootstrap 恢复。
4. **上下文**：F296 `ContextEpochOwner` 以 `user × cat × thread` 为 scope 维护 epoch；`PresentationLedger` 管 presentation ceiling/delivery；F299 的 request-generation 记录 provider-bound 输入。
5. **读取**：F299 `thread-access-policy` 先给 thread/user scope，再按记录 userId 过滤。
6. **外部 runtime**：F211 `RuntimeSessionStore` 记录 cascade/conversation id、lifecycle、identity history；不是 roster truth。

### 2.3 状态机 / 生命周期

| 对象 | 状态 | 约束 |
|---|---|---|
| `SessionRecord` | `active → sealing → sealed` | 同一 `(threadId, catId)` 只有一个 active；sealing 写 transcript/digest；sealed 不可变 |
| `AgentProfile`（clowder: cat roster） | `active / disabled` | disabled 不再路由；历史 session 只读 |
| `RuntimeSessionMetadata` | `active / runtime_seal_pending / runtime_conflict_pending / sealed` | external runtime 的身份历史；不是 roster truth |
| `ContextEpochState` | `scope_first_seen / fresh / replaced / unknown / binding_mismatch / resumed / context_compacted / replay` | 只接受 provider 权威 compaction；token drop 只作 telemetry |
| `ThreadAccessDecision` | `200 thread/user` 或 `403` | owner / shared_default / external_runtime_anchor / user_index；记录级二次过滤 |

### 2.4 关键数据结构

| 结构 | 关键字段 | 作用 |
|---|---|---|
| `CatConfig` | `id/name/displayName/provider/clientId/defaultModel/carrier/roleDescription/personality/restrictions/sessionChain/contextWindow/accountRef` | 稳定 roster/身份配置 |
| `SessionRecord` | `id/seq/status/threadId/catId/userId/cliSessionId/nativeSessionBinding/contextHealth/capacityPin/sealReason/compressionCount/continuityCapsule/chainKey/latestResumeSessionId/createdAt/updatedAt/sealedAt` | 执行 session 真相 |
| `NativeSessionBinding` | `carrier/cliSessionId/l0Hash/workspaceRoot/profileHome/model/permissionMode/agentName` | native carrier 的 launch 身份；不含 L0 正文 |
| `ConnectorThreadBinding` | `connectorId/externalChatId/threadId/userId/hubThreadId` | 外部 chat/thread ↔ Clowder thread |
| `ContextEpochRecord` | `scopeKey/contextEpoch/contextMode/boundRuntimeSessionId/consumedCompactionEventIds/version` | `user×cat×thread` 的 projection generation |
| `ThreadAccessDecision` | `status/scope/basis/userId/visibleThreads` | session/transcript/invocation/theater 的统一读权限 |
| `RuntimeSessionMetadata` | `sessionId/runtime/runtimeSessionId/threadId/catId/identityHistory/lifecycle` | external runtime 身份与 lifecycle |
| `BubbleStableIdentity` | `threadId/actorId/canonicalInvocationId/bubbleKind` | 前端 bubble 去重/合并身份 |

### 2.5 Current truth 与代码路径

| 子边界 | 当前真相 | 代码/文档锚点 |
|---|---|---|
| roster/config | landed + consumed | `/home/ming/agent/clowder-ai/packages/shared/src/types/cat.ts:61`、`/home/ming/agent/clowder-ai/packages/api/src/config/cat-config-loader.ts` |
| AgentRegistry | landed + consumed | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/agents/registry/AgentRegistry.ts` |
| Session Chain | landed + consumed | `/home/ming/agent/clowder-ai/packages/shared/src/types/session.ts:56`、`/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/stores/ports/SessionChainStore.ts` |
| bubble identity | landed + consumed | `/home/ming/agent/clowder-ai/packages/shared/src/types/bubble-pipeline.ts`、`/home/ming/agent/clowder-ai/docs/features/F183-bubble-pipeline-architecture-consolidation.md` |
| connector binding | landed + consumed；codeteam P1 | `/home/ming/agent/clowder-ai/packages/shared/src/types/connector.ts:132`、`/home/ming/agent/clowder-ai/packages/api/src/infrastructure/connectors/ConnectorThreadBindingStore.ts` |
| runtime session | landed + consumed；codeteam P1 | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/runtime-session/RuntimeSessionMetadata.ts`、`/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/runtime-session/RuntimeSessionStore.ts` |
| context continuity | landed；codeteam P1-defer | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/session/context/ContextEpochOwner.ts`、`/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/stores/ports/ContextEpochStore.ts` |
| thread access | landed + consumed；codeteam W7 | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/session/thread-access-policy.ts` |
| request-generation | landed + consumed；codeteam P1 | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/session/transcript-index/RequestGenerationProjector.ts` |
| runtime interaction | landed + consumed；codeteam P1 | `/home/ming/agent/clowder-ai/packages/api/src/domains/runtime-interaction/` |
| user profile | landed；codeteam P1-active | `/home/ming/agent/clowder-ai/packages/api/src/domains/cats/services/profile/ProfileRepository.ts`、`/home/ming/agent/clowder-ai/packages/shared/src/profile-contract.ts` |

## 3. codeteam 架构

### 3.1 架构图

```text
  agent-config.json (seed, immutable by default)
          │
          ▼
  AgentProfile store (runtime truth; operator-managed)
          │  id = own stable handle, role = primary role
          ├──────────────► roles registry (RoleId; codeteam-new)
          │
          ▼
  AgentSession (extends SessionRecord)
    ├─ profileId / threadId / taskId / stageId / role
    ├─ effectiveToolPolicy (resolved from session.role at run start)
    ├─ chainKey = ct:<threadId>:<profileId>   (optional stable anchor)
    ├─ continuityCapsule / catHandoffNote / sealReason / contextHealth
    └─ piSessionId = cliSessionId / nativeSessionBinding.cliSessionId
          │
          ▼
  Run: agentSessionId + role + provider/model/modelFamily + l0_revision

  L0 compiler: roleDescription + restrictions
               (NO F231 profile capsule in P0)
  W7: ThreadAccessPolicy (userId scope; record-level filter)
```

### 3.2 数据流

1. **Seed/启动**：`agent-config.json` 只 upsert 新 profile；已有 `agent_profiles` 行的人工变更（status/restrictions）不被覆盖；冲突写 audit + 告警。
2. **调用**：profile routing → `AgentSession` active（per thread × profile）→ `effectiveToolPolicy` 按 session.role 解析并落快照 → L0 compile（roleDescription + restrictions）→ provider launch → Run。
3. **连续性**：SessionRecord `active/sealing/sealed`；task 切换 seal 旧 session；`stageId` 是 run 启动时更新的 mutable 快照，不参与 session 身份/chain seq；`chainKey` 用于 provider id 轮换后的 re-attach。
4. **review/verify**：run 使用 `evidence-collection` policy；可执行测试/截图(gated)/证据采集，但不能 merge/approve/push/production-write/secret-read、不能写被审 worktree；review 执行证据不关闭 finding。
5. **W7 读取**：`ThreadAccessPolicy` 给 user/thread scope，记录级再过滤；不在 route 里重写 owner/default 检查。

### 3.3 状态机 / 生命周期

| 对象 | 状态 | 约束 |
|---|---|---|
| `AgentProfile` | `active / disabled` | disabled 不再路由；已有 session 只读历史 |
| `AgentSession` | `active → sealing → sealed` | 复用 SessionRecord；同一 `(threadId, profileId)` 只有一个 active |
| `Run` | `running → completed / canceled / interrupted / failed` | Run 是执行终态；role/tool policy/modelFamily 用实际值 |
| `effectiveToolPolicy` | `coding / evidence-collection` | run 启动时按 session.role 解析；review/verify 强制 evidence-collection；删除孤儿 `reviewer` 值 |

### 3.4 关键数据结构（与 clowder 对比）

| clowder | codeteam | 立场 | 关键差异 |
|---|---|---|---|
| `CatConfig` | `AgentProfile` | `adapt now` | `id` 是自有 stable handle（不是直接沿用 clowder catId）；`clowder_cat_id` 仅 provenance；省掉 avatar/color/mention/voice/breed；保留 `roleDescription`/restrictions/provider/model |
| clowder per-cat roles list | `AgentProfile.role` + `roles` registry | `codeteam-new` | clowder 1 cat : N roles；codeteam 1 profile : 1 primary role；多能力 = 多 profile |
| `SessionRecord` | `AgentSession` | `extend now` | 全字段默认复用；新增 taskId/stageId/profileId/role/effectiveToolPolicy；`id` 直接复用；`scopedInvocation`/`externalImport` 显式排除；`compressionObservation` 随 F296 P1 |
| `AgentRegistry` | `AgentRegistry` | `adapt now` | target 从 catId 改为 profileId |
| `BubbleStableIdentity` | reference-only | `borrow` | 渲染归 bubble-pipeline；tuple 用 `(threadId, profileId, canonicalInvocationId, bubbleKind)` |
| `ConnectorThreadBinding` | 不建 | `defer→P1` | transport Drop；W7 只用 userId/threadId |
| `ContextEpochRecord` / `PresentationLedger` | 不建 | `defer→P1` | P0 只复用 SessionRecord capsule |
| `RuntimeSessionMetadata` | 不建 | `defer→P1` | v1 用 `AgentSession.piSessionId` |
| `ThreadAccessDecision` | 复用 | `defer→W7` | W7 读取 session/transcript 时接入 |
| `ProfileScope` / F231 | 不读 | `defer→P1` | `CODETEAM_DATA_DIR` 独立；不复制 clowder `profiles/` |
| F209 `entity_id` | 不复用 | `out-of-scope` | 只作 memory 检索锚点 |

**SessionRecord 字段对账**（默认全量复用，只列差异）：

- 复用：`id/seq/status/threadId/catId→profileId（rename）/userId/cliSessionId/nativeSessionBinding/workingDirectory/workspaceFingerprint/contextHealth/capacityPin/lastUsage/messageCount/sealReason/catHandoffNote/compressionCount/appliedPolicy/hybridProgress/continuityCapsule/consecutiveRestoreFailures/latestResumeSessionId/chainKey/createdAt/updatedAt/sealedAt`。
- 显式排除：`scopedInvocation`（collective 一次性执行）、`externalImport`（Clowder 本地导入）。
- Defer P1：`compressionObservation`、context epoch/presentation、runtime session、request-generation、runtime-interaction。
- v1 单 operator：`userId` 可固定为当前 principal，但仍保留列以兼容多用户。

### 3.5 变量定义表

#### Contract

| 变量 | 类型 | 默认/当前 | owner | clowder 来源 | codeteam 决定 | 备注 |
|---|---|---|---|---|---|---|
| `AgentProfile.id` | `string` | 自有 handle，如 `coder-deepseek` | identity-session | 参照 `CatConfig.id` 形状 | `rename/new` | 全局唯一；不绑定 clowder catId；`clowder_cat_id` 仅 provenance |
| `AgentProfile.clowder_cat_id` | `string?` | null | identity-session | `CatConfig.id` | `new` | 可重复，不参与唯一性；迁移审计用 |
| `AgentProfile.role` | `RoleId` | primary role | identity-session | F032/F167 动态 roster 模式 | `codeteam-new` | 1 profile = 1 primary role；多能力 = 多 profile |
| `RoleId` | `string` | builtin + custom | identity-session | 动态 roster 模式 | `codeteam-new` | `roles` 表；未知/disabled fail closed |
| `BUILTIN_ROLES` | const | architect/coder/reviewer/verifier | identity-session | 无直接类型来源 | `codeteam-new` | 继承 F032/F167 动态 roster 模式 |
| `ActorKind` | enum | operator/agent/system | identity-session | F032 相邻概念 | `codeteam-new` | `human` 不是 role |
| `AgentProfile.roleDescription` | `string` | 角色说明 | identity-session | `CatConfig.roleDescription` | `reuse` | L0 主输入；必须进契约表 |
| `AgentProfile.displayName` | `string` | 展示名 | identity-session | `CatConfig.displayName` | `reuse` | 可变，不作身份 |
| `AgentProfile.provider/model/modelFamily` | `string` | profile 默认 | identity-session | `CatConfig.provider/defaultModel` | `adapt now` | session/run 记实际值；profile 只是默认 |
| `AgentProfile.toolPolicyProfile` | `string` | 默认策略 | identity-session | `CatConfig.restrictions`/工具策略 | `adapt now` | 解析为 effectiveToolPolicy |
| `AgentProfile.restrictions` | `string[]` | `[]` | identity-session | `CatConfig.restrictions` | `reuse` | L0 注入；不能靠模型自报 |
| `AgentSession.id` | `string` | SessionRecord.id | identity-session | `SessionRecord.id` | `rename` | 不建第二 session 身份 |
| `AgentSession.profileId/threadId/taskId/stageId` | `string` | — | identity-session | SessionRecord + codeteam new | `extend now` | task/stage 是代码交付扩展 |
| `AgentSession.role` | `RoleId` | profile primary role | identity-session | 动态 roster 模式 | `extend now` | 本次执行 role；必须解析 effectiveToolPolicy |
| `AgentSession.piSessionId` | `string` | — | identity-session | `SessionRecord.cliSessionId` / `NativeSessionBinding.cliSessionId` | `rename` | provider 恢复键 |
| `AgentSession.chainKey` | `string?` | null | identity-session | `SessionRecord.chainKey` 语义 | `extend now` | codeteam 格式 `ct:<threadId>:<profileId>`；不复制 `bg:` |
| `BubbleStableIdentity` | tuple | — | bubble-pipeline | `/home/ming/agent/clowder-ai/packages/shared/src/types/bubble-pipeline.ts` | `borrow` | `(threadId, profileId, canonicalInvocationId, bubbleKind)`；本卡 reference-only |

#### State

| 变量 | 类型 | 默认/当前 | owner | clowder 来源 | codeteam 决定 | 备注 |
|---|---|---|---|---|---|---|
| `AgentProfile.status` | enum | `active` | identity-session | roster/config | `reuse` | disabled fail closed |
| `AgentSession.status` | enum | `active` | identity-session | `SessionStatus` | `reuse` | active/sealing/sealed |
| `AgentSession.seq` | number | 0-based | identity-session | `SessionRecord.seq` | `reuse` | per thread/profile chain |
| `AgentSession.contextHealth` | object | optional | identity-session | `SessionRecord.contextHealth` | `reuse` | 最近 invocation 健康 |
| `AgentSession.capacityPin` | object | optional | identity-session | `SessionRecord.capacityPin` | `reuse` | 只 shrink；新 session 才 expand |
| `AgentSession.lastUsage/messageCount` | object/number | optional/0 | identity-session | `SessionRecord` | `reuse` | 显示/预算 |
| `AgentSession.sealReason` | enum | optional | identity-session | `SessionRecord.sealReason` | `reuse` | `threshold/manual/error/cat_initiated_handoff` + string |
| `AgentSession.compressionCount` | number\|null | null | identity-session | `SessionRecord.compressionCount` | `reuse` | null = 历史未知 |
| `AgentSession.compressionObservation` | object | optional | identity-session | `SessionRecord.compressionObservation` | `defer→P1` | F296 补齐前不建 |
| `AgentSession.appliedPolicy/hybridProgress` | object | optional | identity-session | `SessionRecord` | `reuse` | policy-local progress |
| `AgentSession.continuityCapsule` | unknown | optional | identity-session | `SessionRecord.continuityCapsule` | `reuse` | 跨 compact/seal/resume |
| `AgentSession.catHandoffNote` | object | optional | identity-session | F225 | `reuse` | seal 前持久化 |
| `AgentSession.consecutiveRestoreFailures` | number | 0 | identity-session | F118 | `reuse` | circuit breaker |
| `AgentSession.workspaceFingerprint` | string | provider-scoped | identity-session | `SessionRecord.workspaceFingerprint` | `reuse` | resume 判定 |
| `AgentSession.latestResumeSessionId` | string? | null | identity-session | `SessionRecord.latestResumeSessionId` | `extend/reuse` | provider 轮换恢复 |
| `AgentSession.effectiveToolPolicy` | enum | `coding` | identity-session | codeteam-new | `extend now` | `coding/evidence-collection`; run 启动快照 |

#### Config

| 变量 | 类型 | 默认/当前 | owner | clowder 来源 | codeteam 决定 | 备注 |
|---|---|---|---|---|---|---|
| `AGENT_CONFIG_PATH` | path | `config/agent-config.json`（外部仓 seed） | identity-session | `cat-config.json` 形状 | `rename/new` | 不再叫 cat-config；seed 真相；运行时数据走 `CODETEAM_DATA_DIR` |
| `CODETEAM_DATA_DIR` | path | `~/.local/state/codeteam` | config（唯一权威定义） | `CAT_CAFE_DATA_DIR` 形状 | `new` | 独立数据根；不读 clowder 私有 profile；其他卡只引用不重定义 |
| `AgentProfile.sessionChain` | boolean | true | identity-session | `CatConfig.sessionChain` | `reuse` | 关闭时单 session |
| `AgentProfile.contextWindow` | number | provider default | identity-session | `CatConfig.contextWindow` | `reuse` | Auto/Manual；profile 默认 |
| `SessionPolicySnapshot` | object | clowder 起点 | identity-session | F24/F225 | `reuse` | 0.75/0.85/12000/4000 是起点参数，W0a 按 pi 窗口重校准 |
| `MODEL_FAMILY_CATALOG` | file/enum | 受控枚举 | identity-session | W3 决议 | `codeteam-new` | family 不在 profile 自由配置；改动走 review + audit |
| `carrier` | enum | `pi` | identity-session | `CatConfig.carrier` | `codeteam-new` | v1 固定 pi；多 carrier 随 F211 P1 |
| `effort/speed intent` | object | P1 | identity-session | F262/F291 | `defer→P1` | thread-level；W1 不建列 |
| `accountRef/accountBindingMode` | string/enum | P1 | provider-account | F136/F171/F320 | `defer→P1` | 多账号 P1 |

#### Security

| 变量 | 类型 | 默认/当前 | owner | clowder 来源 | codeteam 决定 | 备注 |
|---|---|---|---|---|---|---|
| `ReviewerIndependence` | tuple | `(profileId, sessionId, modelFamily)` | identity-session | F032/F013 | `adapt now` | 不得只看 role；profile 经 author_session_id → agent_sessions.profile_id join；不在 reviews 冗余 profile 列 |
| `AgentSession.effectiveToolPolicy` | enum | `coding` | identity-session | codeteam-new | `extend now` | review/verify = `evidence-collection`；准入检查 |
| `review/verify policy` | capability set | evidence-collection | identity-session | codeteam-new | `new` | allow read/exec/screenshot(gated)/artifact/evidence/evidence-worktree-write；deny merge/approve/push/production-write/secret-read/reviewed-worktree-write；exec 受 W2 command/path policy 约束 |
| `AgentProfile/roles 写权限` | principal | operator credential | identity-session | W2 auth matrix | `new` | M1 前 CLI 唯一写入方；变更落 audit |
| `AgentSession ↔ per-run token` | cross-ref | token.agentSessionId | callback-auth | F174 | `reuse` | token 归 callback-auth；claim 用本卡身份坐标 |
| `ThreadAccessDecision` | object | W7 | identity-session | F299 | `defer→W7` | owner/shared_default/external_runtime_anchor/user_index |
| `AuditContext.owner` | tuple | P1 | runtime-interaction | F306 | `defer→P1` | `(userId, threadId, catId, invocationId)` |
| `permissionMode` | enum | codeteam-new | identity-session | 无 pi 对应 | `codeteam-new` | headless = tool policy + bwrap + approvals；native 仅未来 carrier |

#### Observability

| 变量 | 类型 | 默认/当前 | owner | clowder 来源 | codeteam 决定 | 备注 |
|---|---|---|---|---|---|---|
| `contextHealth` | object | optional | identity-session | `SessionRecord.contextHealth` | `reuse` | 最近 invocation 健康 |
| `sealReason` | enum | optional | identity-session | `SessionRecord.sealReason` | `reuse` | 全枚举 + string |
| `catHandoffNote` | object | optional | identity-session | F225 | `reuse` | 五件套交接 |
| `compressionObservation` | object | P1 | identity-session | `SessionRecord.compressionObservation` | `defer→P1` | F296 |
| `runtimeSession.identityHistory` | array | P1 | identity-runtime-session | F211 | `defer→P1` | model/provider 变化历史 |
| `request-generation evidence` | event | P1 | request-generation | F299 | `defer→P1` | immutable provider-bound bytes |
| `bubbleIdentity` | tuple | reference | bubble-pipeline | `BubbleStableIdentity` | `borrow` | 本卡只引用，不定义渲染 |

### 3.6 明确不做

- 不建 `AgentInstance`。
- 不建第二套 session/context store；`AgentSession.id = SessionRecord.id`。
- 不把 callback auth 当 session identity。
- 不把 F209 entity alias 当 roster truth。
- 不把 F231 私有 profile 写入 tracked 配置或共享数据根；P0 不复制 `profiles/`。
- 不在 P0 实现 external runtime session registration / context epoch / request-generation / runtime interaction。
- 不把 review/verify 限制成“只读”；它们需要 evidence-collection 执行权限，可在隔离 evidence worktree 写临时测试，但不得有 merge/approve/push/production-write/secret-read，也不得写被审 worktree。
- **evidence worktree** 是 disposable copy 的泛化：review/verify 取证共用，格式 = base_sha + head diff clean checkout；同 task 峰值 ≤2 份，计入 W5 pool。

## 4. 风险与回滚

| 风险 | 级别 | 处置 |
|---|---|---|
| profile 与 session 合成 AgentInstance | P1 | `agent_profiles` / `agent_sessions` 两张表；不引入 instance |
| AgentSession 与 SessionRecord 双身份 | P1 | `AgentSession.id = SessionRecord.id`；不建第二 store |
| review 独立性只看 role，或 review/verify 带 merge/approve 权限 | P1 | `ReviewerIndependence` 三元组 + `effectiveToolPolicy` evidence-collection 准入；临时写只限隔离 evidence worktree，exec 受 W2 约束 |
| roster seed 覆盖运行时人工变更 | P1 | config seed + table runtime truth；只 upsert 新 profile，冲突 audit |
| 读取 clowder 私有 profile | P1 | `CODETEAM_DATA_DIR` 独立；F231 P1-active；P0 不复制 `profiles/` |
| provider session id 轮换导致 W5 re-attach 断 | P2 | `chainKey = ct:<threadId>:<profileId>` 作为稳定锚 |
| `permissionMode` 误用 F325 carrier 概念 | P2 | 标 codeteam-new；headless 用 W2 tool policy + bwrap + approvals |
| 代码锚点不可达/来源写错 | P2 | 交卡前 grep；来源写错即验收不过 |

回滚：

- `roles` / `agent_profiles` / `agent_sessions` 都是新增表；回滚到 W1 基线即可，不迁移 clowder 数据。
- `CODETEAM_DATA_DIR` 独立；回滚不影响 clowder `CAT_CAFE_DATA_DIR`。
- 如果 session 扩展字段出问题，保留 SessionRecord 核心字段与主键，仅回退新增列；不重建 session 链。

## 5. Review 与签字

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | W0/W1 schema、SessionChain、迁移、AgentSession 扩展 | accept（Round 2；P2/P3 已回写） |
| 砚砚 | 权限、roster 真相源、effectiveToolPolicy、fail-closed | accept（Round 2；D2=A 由 operator 定，B 方案记为备选） |
| 墨墨 | W7 Console、role/profile UX、模板结构、文档一致性 | accept（Round 2；P2/P3 已回写） |
| operator | A1-1 样张是否可作为后续架构卡模板 | [x] 已签（2026-10-24，D2=A） |

> Round 2 review `111e7c8b-d55e-43c7-bcda-fc10a6d2a218` 已完成；D2=A 由 operator 拍板，A1-1 作为后续架构卡模板。

[宪宪/deepseek-flash🐾]
