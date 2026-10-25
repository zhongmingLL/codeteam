---
title: "plugin 架构复用检视"
doc_kind: architecture-review
status: approved
created: 2026-10-25
updated: 2026-10-25
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
review_request: "e3168435-73d6-4a82-a840-979596c21466"
operator_signoff: "DP-PLUGIN-1=A, DP-PLUGIN-2=A (2026-10-25)"
source_cell: plugin
source_card: ../../reuse/plugin.md
template: ../0004-reuse-architecture-review-plan.md
---

# plugin 架构复用检视

## 1. 总结

| 项 | 结论 |
|---|---|
| clowder feature 范围 | F202（Plugin Manager / Host-governed framework）、F247（cloud cat / Host adapter seam）、F285（official-plugin seam）、F290（collective runtime boundary）、F292（signal-intake boundary）；以及 F038/F041/F228/F239/F301 的 skill discovery/mount 历史。 |
| codeteam 复用总结 | **R1 适配复用，v1 只取 skill surface**：curated `SKILL.md` + `manifest.yaml` 路由，经 pi `resourceLoader` 的 role allowlist 加载。package admission / install / grants / Broker / supervised runtime / marketplace / plugin manager 全部 P1-defer/out-of-scope。 |
| codeteam W | W0（role-curated skill loading）+ W4（SOP `nextSkill` 建议加载）；不进入 W1/W5 的 plugin runtime。 |
| 一句话 | v1 的“plugin”不是插件市场，而是**角色可加载的 curated skill 目录**：frontmatter 是元数据单一权威，manifest 只做路由；索引常驻、正文按需；skill 不执行代码、不改 tool policy、不碰凭证。 |
| 明确不含 | 插件包 admission/install/update/uninstall、marketplace/catalog、Host inventory、grants、Broker session、supervised runtime、外部 executable、F247 cloud-cat provider、F285 physical limb、F290 collective、F292 signal intake、第二套 skill/plugin registry。 |

> **Skill 内容迁移不在本卡范围**：逐 skill 适用性矩阵、Clowder 依赖替换与迁移门禁见 `../skill-migration.md`。没有矩阵行 + 静态检查 + 非作者 review + dry-run 的 skill，不得进入 `codeteam/skills/manifest.yaml`。

**组件立场**

| 组件 | 立场 | codeteam 处理 |
|---|---|---|
| `SKILL.md` + `manifest.yaml` | `reuse now` | 目录名=skillId；frontmatter 是 name/description/triggers 的**唯一权威**；manifest 只留 category/not_for/output/next/sop_step 等路由维度 |
| pi `DefaultResourceLoader` | `reuse now` | 当前 `noSkills: true` 是隔离基线；目标态改为 role curated allowlist 显式加载，不靠自动发现；索引常驻、正文按需 |
| `PluginManifest` / `PluginResourceDef` | `borrow` | 只参考声明式 resource 形状；codeteam v1 不加载 `plugin.yaml`，不建 PluginRegistry |
| `PluginRegistry` / `PluginResourceActivator` | `borrow` | 借用 path containment、SKILL.md 存在性、mount conflict 校验的思路；不接 plugin capability/inventory |
| `skill-manage` / `skill-sync-engine` / `skill-mount` | `defer→P1` | v1 用 project-level curated roots；多项目 symlink cascade、drift resolver、global mount 后置 |
| `PluginManagerService` / `PluginInventoryStore` / `HostBrokerControlPlane` | `out-of-scope` | 不进入 v1；没有 package admission / grants / runtime lease / config/auth/intent/live 四轴 |
| `PluginManager` Console/Agent/MCP surfaces | `out-of-scope` | v1 不提供插件市场/管理面；skill 选择走 role policy + SOP，不走 plugin manager |
| GitHub/GitLab connector、physical limb、cloud cat、meeting intake | `out-of-scope` | 属 github-signals / mcp-surface-governance / identity-session / collective-runtime / signal-intake |
| 第二套 skill/plugin registry | `forbidden` | 只允许一份 curated skill catalog + pi loader；不建 route-local 或 per-plugin registry |

## 2. clowder 架构（skill surface）

### 2.1 架构图

```text
repo-local plugin package (plugin.yaml)
  ├─ id / name / version / description / icon
  ├─ config fields (value-only; secrets by env)
  └─ resources[]
       ├─ skill: path → <plugin>/skills/<name>/
       ├─ mcp / limb / schedule → other cells
       └─ permission/admission → PluginManager / Broker (not this v1)
            │
            ▼
PluginRegistry.scan()
  ├─ parse plugin.yaml (strict)
  ├─ id == directory name; env safety
  └─ manifest map (no runtime authority)
            │
            ▼
PluginResourceActivator.activateSkill()
  ├─ resolve path inside plugin root (realpath)
  ├─ require SKILL.md directory
  ├─ addSkill(): capability entry + symlink mount
  └─ config write before mount; rollback on failure
            │
            ▼
skills/skill-manage + skill-sync-engine + skill-mount
  ├─ curated manifest + SKILL.md metadata
  ├─ project/global mount points (F228/F239/F301)
  └─ drift detection / conflict classification
            │
            ▼
pi DefaultResourceLoader
  └─ currently noSkills: true; target role curated skills
```

### 2.2 数据流

1. **Declare**：plugin package 的 `plugin.yaml` 用 `resources[]` 声明 `type:'skill'` + relative `path`；manifest 只表达声明，不授予权限。
2. **Scan**：`PluginRegistry.scan()` 读取 `plugins/<dir>/plugin.yaml`，校验 id/name/version、目录名一致、env 安全；manifest 进内存 map，不是安装/运行真相。
3. **Activate**：`PluginResourceActivator.activateSkill()` 要求 skill resource 是目录、含 `SKILL.md`、realpath 在 plugin root 内；然后 `addSkill()` 写 capability entry 并创建 mount symlink。
4. **Mount**：`skill-sync-engine` 按 mount rules 建/清 symlink；`classifyMountPath` 区分 managed/foreign/broken；冲突不覆盖。
5. **Load**：pi `DefaultResourceLoader` 当前 `noSkills: true`；目标态由 role curated allowlist 显式提供 skill 路径，不依赖自动发现。分成两级：**index**（id/name/description/triggers/next）常驻 context；**body**（SKILL.md 正文）按需读取。
6. **Use**：agent 从 index 看见自己有哪些 skill；需要时按需读正文。`manifest.yaml` 只提供 category/not_for/output/next/sop_step 路由维度，不再复制 description/triggers；`nextSkill` 只是建议，不强制加载。
7. **Drift**：`SKILL.md`/manifest 内容 hash 变化 → reload；缺失/不可读 → drop with warning；不把 stale 内容当 current。
8. **No runtime**：skill 不是 executable；不启动子进程、不注册 MCP、不创建 Broker session、不写 plugin live state。

### 2.3 状态机 / 生命周期

**A. Skill manifest / package**

```text
declared ──parse ok──► validated ──path/mount ok──► mountable
   │                       │
   └── parse fail ─────────┴── path escape / missing SKILL.md / env collision ──► skipped（warning）
```

- `plugin.yaml` 是声明，不是安装/运行真相；scan 成功不等于 enabled/live。
- `id == directory name`；env 名不得撞系统前缀/其他 plugin；manifest 不含 user secrets。

**B. Skill index / body load**

```text
discovered ──validate────► indexed（index 进 context）──allowlist──► body loaded（按需正文）
    │                         │                                      │
    └── missing ──► absent    └── hash drift ──► re-index ────────────┘
```

- 只有 index + `SKILL.md` 文本进入 skill surface；skill 目录里的脚本/资源默认只读，不自动执行。
- `indexed` 是 per-session；`body loaded` 是 per-turn。二者都不是 plugin runtime health。

**C. Mount**

```text
unmounted ──mount rule──► mounted(managed)
    ▲                         │
    └── disable/cleanup ◄─────┘
```

- `managed` symlink 只指向 allowlisted skill root；foreign/broken 不覆盖。
- project-level root 优先；global/HOME mount 不是 v1 默认。

### 2.4 关键数据结构

```ts
// packages/shared/src/types/plugin.ts:63,78,94
interface PluginResourceDef {
  type: 'skill' | 'mcp' | 'limb' | 'schedule';
  factoryId?: string;
  optional?: boolean;
  path?: string;
  name?: string;
  command?: string;
  args?: string[];
  transport?: string;
  url?: string;
}

interface PluginManifest {
  id: string; name: string; version: string;
  description?: string | { default: string; translations: Record<string,string> };
  icon?: string | { type: 'svg' | 'png'; src: string };
  config: ValueConfigField[];
  healthCheck?: { limbCommand?: string; mcpProbe?: string };
  resources: PluginResourceDef[];
}
```

```ts
// packages/api/src/skills/skill-meta.ts:50,67
interface SkillMeta {
  category?: string;
  description?: string;
  triggers?: string[];
  requiresMcp?: string[];
}
// SKILL.md frontmatter: name / description / triggers（唯一权威）
// manifest.yaml: category / not_for / output / next / sop_step（只做路由；不复制 description/triggers）
```

### 2.5 Current truth 与代码路径

| # | 事实 | 代码/文档锚点 |
|---|---|---|
| T1 | manifest 声明 skill resource 的相对 path；`plugin.yaml` 只声明 resource，不授予权限 | `packages/shared/src/types/plugin.ts:63`、`:78`；`packages/api/src/plugins/weixin-mp/plugin.yaml:29` |
| T2 | `PluginRegistry.scan()` 校验 id/目录名、env safety；scan 成功不等于运行 | `packages/api/src/domains/plugin/PluginRegistry.ts:36`、`:103`、`:181` |
| T3 | manifest parser 校验 id/version、resource type、env denylist、unsafe path | `packages/api/src/domains/plugin/plugin-manifest.ts:15`、`:50`、`:143`、`:171` |
| T4 | activateSkill 要求 skill 目录含 SKILL.md，realpath 在 plugin root 内 | `packages/api/src/domains/plugin/PluginResourceActivator.ts:94`、`:302` |
| T5 | addSkill 先写 capability config，再 mount；mount 失败回滚 config | `packages/api/src/skills/skill-manage.ts:145`、`:278` |
| T6 | mount 分类 managed/foreign/broken；冲突不覆盖 | `packages/api/src/skills/skill-sync-engine.ts:35` |
| T7 | mount target 由 standard/custom mount rules 生成 | `packages/api/src/utils/skill-mount.ts:63` |
| T8 | SKILL.md frontmatter 是 description/triggers 的单一来源；unreadable ≠ absent | `packages/api/src/skills/skill-meta.ts:50`、`:67` |
| T9 | pi `DefaultResourceLoader` 当前 `noSkills: true`；目标是 role curated allowlist | `codeteam/architecture/0002-pi-runtime-integration.md:517`、`:522`、`:536` |
| T10 | `nextSkill` 是 SOP 建议，不强制加载 | `codeteam/plans/0003-w3-w4-review-sop.md:195`、`:198` |
| T11 | full plugin framework 的 Manager/Broker/inventory 是另一个 owner 面 | `packages/api/src/domains/plugin/manager/plugin-manager-service.ts:184`；`packages/api/src/domains/plugin/host-inventory/index.ts`；`packages/api/src/domains/plugin/host-broker/index.ts` |
| T12 | plugin manager public ops 是 install/set-enabled/uninstall 等完整生命周期 | `packages/shared/src/types/plugin.ts:130`、`:139` |
| T13 | F202 full framework 含 manifest/admission/inventory/config/auth/intent/live；v1 不取 | `docs/features/F202-plugin-framework.md`；`docs/architecture/ownership/cells/plugin.md` |
| T14 | F285 official plugin / F247 cloud cat / F290 collective / F292 signal intake 是边界外 | `docs/architecture/ownership/cells/plugin.md` |
| T15 | 多项目 skill mount / drift / cascade 是 F228/F239/F301 历史能力，v1 defer | `docs/features/F228-multi-project-skill-mount-management.md`、`F239-skill-mount-home-hygiene.md`、`F301-scoped-skill-sync.md` |

### 2.5.1 上游已知缺口 → 本卡处置

| # | 上游缺口 | 影响 | 本卡处置 |
|---|---|---|---|
| G1 | manifest 可能被当权限/健康 | 假 enabled / 假 live | manifest 只声明；loaded 是 per-session；不接 plugin runtime |
| G2 | scan 成功不等于 mount/load 成功 | 假 skill 可用 | 三态分离：validated / mounted / loaded；失败显式 warning |
| G3 | skill path 可含 `..`/绝对路径/symlink escape | 越界读文件 | realpath containment + reject absolute/..；只读 root 内 |
| G4 | SKILL.md 可能缺失/不可读 | 静默空 skill | unreadable ≠ absent；missing/unreadable 都 fail closed 并观测 |
| G5 | 自动发现/HOME mount 可能跨项目泄漏 | skill 串项目/隐私泄漏 | v1 project-level curated roots + role allowlist；不自动扫 HOME |
| G6 | symlink mount 冲突可能覆盖 foreign skill | 误删/覆盖用户文件 | managed/foreign/broken 分类；冲突不覆盖 |
| G7 | skill 内容可含 prompt injection/secret | agent 被劫持/泄密 | curated allowlist + secret scan + skill 不改变 tool policy/permission |
| G8 | skill 目录可能含 executable/scripts | 自动执行风险 | v1 只加载 SKILL.md/文本；不自动执行脚本；脚本仅作为只读引用 |
| G9 | `nextSkill` 被当强制链 | 越权加载/流程僵化 | `nextSkill` 只是建议；role allowlist 是硬边界 |
| G10 | full plugin framework 的 install/update/marketplace 被误带入 | 范围膨胀/外部代码进 API | v1 明确 out-of-scope；P1-defer 单独评审 |
| G11 | F247/F285/F290/F292 的 provider/limb/collective/signal 被塞进 skill surface | 第二套 registry/权限 | 边界外；各自 cell 拥有；skill 不提供这些能力 |
| G12 | loader 自动发现导致 ghost skill | 不可审计 | `noSkills: true` 基线；显式 allowlist 加载；list/load 可对账 |
| G13 | manifest 与 SKILL.md 双写 description/triggers，fork 继承手工同步债 | index 与正文分叉、静默 drift | frontmatter 是 name/description/triggers 唯一权威；manifest 只留路由维度；重复字段 → invalid |
| G14 | 全文常驻 L1 会撞上下文预算；不常驻则 agent 不知道有什么 skill | 体验/预算二选一 | 两级：index 常驻、body 按需；`skill_indexed` 与 `skill_body_loaded` 分口径 |
| G15 | `nextSkill` 建议被 allowlist 拒绝时不可见 | operator 看板与 agent 行为打架 | `next_skill_skipped_by_policy` 观测/会话 notice；建议≠强制 |
| G16 | skill 目录不在 agent 可读面，多文件 skill 引用是死链 | skill 正文“参见 xxx”不可达 | v1 只走 SKILL.md 单文件正文；fork 时多文件 skill 合并或明确不可达 |
| G17 | realpath 基准用字面 catalog root，checkout symlink 误判 | 误杀/漏放 | 基准用 `realpath(catalog_root)` |

## 3. codeteam 架构（v1 skill surface）

### 3.1 架构图

```text
repo-local curated skills (codeteam/skills or forked cat-cafe-skills)
  ├─ manifest.yaml: skill catalog / routing / next
  └─ <skill>/SKILL.md: content + frontmatter
            │
            ▼
SkillCatalog (read-only)
  ├─ validate skillId/dir/path/size
  ├─ parse SKILL.md frontmatter + manifest entry
  └─ hash content; missing/unreadable typed
            │
            ▼
role SkillPolicy (server-side)
  ├─ allowlisted skill ids per AgentProfile/role
  └─ no skill => not loaded; no implicit fallback
            │
            ▼
pi DefaultResourceLoader (noSkills:true baseline)
  ├─ index injection: id/name/description/triggers/next
  └─ body load: SKILL.md on demand (per-turn)
            │
            ▼
AgentSession L1 context
  ├─ skill index resident
  └─ skill body loaded on demand; no executable, no tool-policy mutation
```

### 3.2 数据流

1. **Catalog**：codeteam 维护一份 curated skill catalog（fork `cat-cafe-skills/manifest.yaml` 或项目内 `skills/manifest.yaml`）；每个 entry 指向一个含 `SKILL.md` 的目录。catalog 只存 skillId/path/category/not_for/output/next/sop_step/sourceKind；description/triggers 不复制，加载时从 frontmatter 读。
2. **Validate**：启动/会话前读取 catalog；skillId 必须匹配目录名；path 必须是 catalog root 内相对路径；`SKILL.md` 必须存在且可读；超 size/secret 命中 → skip。manifest 里若仍出现 description/triggers → `invalid_manifest`（防止双源 drift）。
3. **Policy**：role/AgentProfile 的 `restrictions_json.skills` 给 allowlist；只有 allowlisted skill 能进入 loader；SOP 的 `nextSkill` 只是建议，不能绕过 allowlist；allowlist 引用不存在的 skillId → 启动 warning。
4. **Load**：`pi DefaultResourceLoader` 以 `noSkills: true` 为基线，显式注入 curated skill **index**；正文按需读取。具体 loader 注入 API 由 W0 spike 验证（skills dir 选项或显式列表）；失败记 `KERNEL_GAPS.md`，不改 kernel。mid-session loader 动态注入不是 v1 承诺。
5. **Use**：agent 从 index 看见 allowlisted skills；需要时按需读正文。skill content 只进入 prompt/context；不改 tool allowlist、不授予 MCP/limb/schedule、不创建 runtime。
6. **Drift**：会话前按 `SKILL.md` hash/`mtime` 校验 index；正文读取时复验 hash；变化则 re-index/reload；缺失/不可读则从 session skill set 移除并告警，不保留 stale 文本。
7. **nextSkill**：建议经 agent 的 **repo read** 实现——SKILL.md 在仓库内，agent 用 read 工具直接读取建议的 skill 文件；allowlist 只管 session 启动的自动注入，不管 repo 内文件读取（后者归 repo read policy）。建议不在 allowlist 时记 `next_skill_skipped_by_policy`。
8. **Audit/metrics**：记录 index/body load success/failure/missing/drift/latency；只在 security-relevant failure（path escape/secret/invalid manifest/unknown allowlist）写 audit；不把每个 skill load 写 audit。
9. **No plugin lifecycle**：没有 install/enable/uninstall、没有 inventory/Broker/grants、没有 plugin live state；文件系统 + role policy 是全部 v1 状态。

### 3.3 状态机 / 生命周期

**A. Catalog entry**

```text
declared ──path/skillId/SKILL.md ok──► validated ──index ok──► indexed
   │                                      │
   ├── path escape / missing / unreadable ┴──► invalid（skip + warning）
   ├── secret/size reject ───────────────────► rejected（skip + audit）
   └── manifest 复制 description/triggers ───► invalid_manifest（skip + warning）
```

**B. Session skill set**

```text
role policy ──allowlisted──► candidate
   │                           │
   ├── not allowlisted ──► absent（不加载）
   └── validated ──► indexed（index 进 context）
                        │
                        ├── body requested ──► body loaded（per-turn；复验 hash）
                        ├── hash drift ──► re-index ──► body reload
                        └── missing/unreadable ──► removed from set
```

**C. Mount (only if a mount layer is enabled)**

```text
unmounted ──project-level mount rule──► mounted(managed)
    ▲                                      │
    └── disable/cleanup ◄───────────────────┘
```

- v1 默认不启用 global/HOME symlink cascade；如启用 mount，managed/foreign/broken 分类与冲突不覆盖必须保留。

### 3.4 关键数据结构与存储

| 数据 | clowder | codeteam | 立场 |
|---|---|---|---|
| skill catalog | `cat-cafe-skills/manifest.yaml` | `codeteam/skills/manifest.yaml`（fork/curated） | `adapt` |
| skill content | `<skill>/SKILL.md` | 同 | `reuse` |
| skill metadata | SKILL.md frontmatter + manifest（clowder 有手工同步债） | **frontmatter 唯一权威**；manifest 只留 category/not_for/output/next/sop_step | `adapt` |
| role allowlist | plugin-managed capabilities / `skills` | `agent_profiles.restrictions_json.skills` | `adapt` |
| mount state | capabilities config + symlinks | v1 默认无；P1 再接 F228/F239/F301 | `defer→P1` |
| plugin inventory | `PluginInventoryStore` | none | `out-of-scope` |
| plugin runtime | Broker/supervised process | none | `out-of-scope` |
| plugin lifecycle | `PluginManagerService` | none | `out-of-scope` |

**§12.2 回写清单**

- **无新表/新列**：v1 只用现有 `agent_profiles.restrictions_json`（新增 `skills: string[]` 约定） + 文件系统 skill catalog；不建 `plugin_registry` / `skill_inventory` / `skill_mount` 表。
- `agent_profiles.restrictions_json.skills` 是 server-side allowlist，不接受 agent 自报；空数组 = 不加载任何 skill。
- `SKILL.md`/`manifest.yaml` 是仓库文件，不是 DB 行；`skillId` 是目录名，`name` 必须一致。frontmatter 是 name/description/triggers 唯一权威；manifest 重复字段 → invalid。
- `nextSkill` 只是 SOP 建议，不写入 skill 状态；不强制加载。建议经 repo read 落地，mid-session loader 注入不是 v1 承诺。
- `SkillCatalogEntry.sourceKind ∈ builtin|curated`；v1 不接受 marketplace/external package。
- skill 目录不在 agent 可读面；只有 SKILL.md 文本经 index/body 进入 context。fork 时多文件 skill（SKILL.md + references/*.md）必须合并为单文件，否则“参见 xxx”是死引用。
- `tips_exempt` 是 clowder 专属 flag，codeteam v1 **drop**，不进入 SkillManifest。
- v1 不做 plugin package/config/auth/intent/live 四轴；未来接 full plugin framework 时另开卡，不回流本卡。

```ts
// codeteam convention, no new table
interface SkillPolicy {
  allowedSkills: readonly string[]; // server-side allowlist; empty = none
}

interface SkillCatalogEntry {
  skillId: string;
  path: string;          // relative to catalog root
  sourceKind: 'builtin' | 'curated';
  category?: string;
  notFor?: readonly string[];
  output?: string;
  next?: readonly string[]; // advisory only
  sopStep?: string;
}

interface SkillIndexState {
  skillId: string;
  state: 'absent' | 'validated' | 'indexed' | 'invalid' | 'rejected';
  hash?: string;
  reason?: 'missing' | 'unreadable' | 'path_escape' | 'secret' | 'too_large' | 'invalid_manifest' | 'metadata_duplicate';
}

interface SkillBodyState {
  skillId: string;
  state: 'not_loaded' | 'loaded' | 'stale';
  hash?: string;
}
```

### 3.5 变量定义表

#### contract

| 变量 | 类型 | 默认/值域 | owner | clowder 来源 | 决定 | 说明 |
|---|---|---|---|---|---|---|
| `SkillId` | string | `^[a-z0-9][a-z0-9-]*$` | plugin/skill surface | skill directory + manifest | `reuse` | 目录名=skillId；禁止 `..`/绝对路径 |
| `SkillCatalogEntry` | object | skillId/path/sourceKind/category/not_for/output/next/sop_step | plugin | `cat-cafe-skills/manifest.yaml` | `adapt` | manifest 只做路由；不复制 description/triggers |
| `SkillManifest` | object | name/description/triggers | plugin | `SKILL.md` frontmatter | `reuse` | frontmatter 是元数据唯一权威；name 必须匹配目录；`tips_exempt` drop |
| `PluginResourceDef` | object | type/path/name/... | plugin（reference） | `packages/shared/src/types/plugin.ts:63` | `borrow` | 只参考声明形状；v1 不加载 plugin.yaml |
| `SkillPolicy` | object | allowedSkills[] | identity-session + plugin | `agent_profiles.restrictions_json` | `new`（convention） | server-side allowlist；空=不加载 |
| `SkillIndexState` | enum | absent/validated/indexed/invalid/rejected | plugin | codeteam-new | `new` | per-session index；不是 plugin live health |
| `SkillBodyState` | enum | not_loaded/loaded/stale | plugin | codeteam-new | `new` | per-turn body；复验 hash |
| `SkillHash` | string | sha256 | plugin | codeteam-new | `new` | drift/reload；不进 DB |
| `SkillSourceKind` | enum | `builtin` / `curated` | plugin | codeteam-new | `new` | 落地在 `SkillCatalogEntry.sourceKind`；v1 不接受 marketplace/external package |

#### state

| 变量 | 状态机/约束 | owner | 失败语义 |
|---|---|---|---|
| `agent_profiles.restrictions_json.skills` | server-side allowlist；空=不加载 | identity-session/plugin | 非 allowlisted → absent；不隐式 fallback |
| `SkillIndexState` | absent→validated→indexed；invalid/rejected 不加载 | plugin | missing/unreadable → fail closed + metric |
| `SkillBodyState` | not_loaded→loaded；hash 变化→stale/reload | plugin | stale 正文不保留；missing 从 set 移除 |
| allowlist 引用不存在的 skillId | 启动 warning；不静默 | plugin | unknown id → warning + `skill_allowlist_unknown_total` |
| `nextSkill` 不在 allowlist | 建议 skip，但可见 | plugin/SOP | `next_skill_skipped_by_policy` notice/metric |
| `manifest` | catalog 条目必须指向存在目录；不得重复 description/triggers | plugin | invalid entry skip + warning；duplicate metadata → invalid_manifest |
| `skill mount` | managed/foreign/broken；冲突不覆盖 | plugin/P1 | 冲突 skip；不删 foreign |
| plugin inventory/live | 不存在 | out-of-scope | 任何 plugin install/enable 请求 → 拒绝/不提供 |

#### config

| 变量 | 默认 | owner | 决定 | 说明 |
|---|---|---|---|---|
| `CODETEAM_SKILLS_DIR` | `codeteam/skills`（或 fork 的 cat-cafe-skills） | plugin | `new` | curated catalog root；只读 |
| `CODETEAM_SKILLS_MANIFEST` | `<skills-dir>/manifest.yaml` | plugin | `new` | catalog 索引；不存在则空 catalog，不自动扫 |
| `CODETEAM_SKILL_MAX_BYTES` | 262144 | plugin | `new` | 单 SKILL.md/文件上限；超限 reject |
| `CODETEAM_SKILL_LOAD_TIMEOUT_MS` | 5000 | plugin | `new` | 单 skill 校验/读取预算 |
| `CODETEAM_SKILL_SECRET_SCAN` | 1 | plugin | `new` | 加载前基础 secret pattern 扫描；复用 W2 audit 同款 pattern；命中 reject+audit |
| `CODETEAM_SKILL_ALLOW_HOME_MOUNT` | 0 | plugin | `new` | v1 默认禁止 HOME/global symlink；显式 opt-in 才接 mount 层 |
| `CODETEAM_SQLITE_BUSY_TIMEOUT_MS` | 见 plans/0002 W1 | 全局 | `reference` | 与 skill surface 无直接 DB 写；仅共享配置 |

#### security

| 变量/规则 | 值/来源 | owner | 失败语义 |
|---|---|---|---|
| `skillPathContainment` | `realpath(skill)` 必须在 `realpath(catalog_root)` 内；拒绝绝对路径/`..` | plugin | path escape → rejected + audit |
| `skillSymlinkPolicy` | managed target 必须在 allowlisted root；foreign/broken 不覆盖 | plugin | symlink escape → reject；不删 foreign |
| `skillExecutablePolicy` | v1 只加载 SKILL.md/文本；不自动执行 scripts | plugin | executable/auto-run → 拒绝 |
| `skillAgentReadBoundary` | skill 目录不在 agent 可读面；只有 SKILL.md 文本经 index/body 进入 context | plugin + W2 | agent 直接读 skill 目录 → 不在 v1 面；多文件 skill 必须合并 |
| `skillSupplyChain` | 第一防线 = curated + repo PR review；secret scan 是最后防线，不是准入条件 | plugin + review | 外部 skill 未经 review 不进 catalog；scan 命中 → reject |
| `skillSecretScan` | basic pattern scan；命中 reject | plugin | secret → rejected + audit；不写 log 正文 |
| `skillPromptInjectionBoundary` | skill 内容不能改变 tool policy/permission/custody | plugin + identity-session | skill 声称提权 → 忽略 + 记录 |
| `skillMetadataSingleSource` | frontmatter 是 name/description/triggers 唯一权威 | plugin | manifest 重复字段 → invalid_manifest |
| `skillSourceKind` | catalog entry 只能是 builtin/curated | plugin | marketplace/external → reject |
| `skillPolicyServerSide` | allowlist 只从 server-side profile/role 读 | identity-session | agent 自报 allowlist → 422/拒绝 |
| `skillCrossProjectIsolation` | 默认 project-level root；不扫 HOME/其他项目 | plugin | 跨项目路径 → reject |
| `skillManifestNoSecrets` | manifest 不存 user secrets | plugin | 明文 secret → reject |
| `skillNoRuntime` | 不启动子进程/不建 Broker/不注册 MCP | plugin | runtime 请求 → out-of-scope/拒绝 |

#### observability

| 变量/事件 | 值/来源 | owner | 说明 |
|---|---|---|---|
| `skill_index_total` | counter/skill/state | plugin | index 成功/失败 |
| `skill_body_load_total` | counter/skill/state | plugin | 正文按需加载成功/失败 |
| `skill_load_failed_total` | counter/skill/reason | plugin | missing/unreadable/path/secret |
| `skill_manifest_invalid_total` | counter/reason | plugin | catalog 条目失效 |
| `skill_drift_total` | counter/skill | plugin | hash 变化/reload |
| `skill_load_latency_ms` | histogram/skill/stage | plugin | index/body 分口径 |
| `skill_secret_rejected_total` | counter/skill | plugin | secret scan 命中 |
| `skill_cross_project_rejected_total` | counter | plugin | 越界路径 |
| `skill_allowlist_unknown_total` | counter/role/skill | plugin | allowlist 悬空引用 |
| `skill_metadata_duplicate_total` | counter/skill | plugin | manifest 重复 description/triggers |
| `next_skill_skipped_by_policy_total` | counter/role/skill | plugin/SOP | nextSkill 被 allowlist 拒绝 |
| `skill_indexed` | gauge/role | plugin/identity | 当前 session index 大小 |
| `skill_body_loaded` | gauge/session | plugin/identity | 当前 turn 已加载正文数 |

### 3.6 明确不做

- 不做 plugin package admission/install/update/uninstall/marketplace/catalog；这些是 F202 P1-defer，不进入 v1。
- 不做 PluginRegistry / PluginInventoryStore / HostBrokerControlPlane / supervised runtime / grants；v1 没有 plugin live state。
- 不加载 `plugin.yaml` 作为运行时 manifest；它只作声明式 resource 形状参考。
- 不把 manifest/enabled flag 当权限或健康；skill 是否 loaded 只看 per-session loader 结果。
- 不做自动 skill discovery、HOME/global 默认 mount、多项目 symlink cascade；这些是 F228/F239/F301 P1-defer。
- 不自动执行 skill 目录里的 scripts；skill 内容不能改变 tool policy、permission、custody、approval。
- 不让 manifest 复制 description/triggers；frontmatter 是唯一权威，重复字段直接 invalid。
- 不把全文常驻 L1；index 常驻、body 按需；`nextSkill` 经 repo read 落地，不承诺 mid-session loader 注入。
- 不让 agent 直接读 skill 目录；v1 只有 SKILL.md 文本经 index/body 进入 context，多文件 skill 必须合并。
- 不把 `tips_exempt` 带进 codeteam；它是 clowder 专属 flag，v1 drop。
- 不把 F247 cloud-cat provider、F285 physical limb、F290 collective、F292 signal intake 塞进 skill surface。
- 不建第二套 skill/plugin registry；catalog + role allowlist + pi loader 是唯一路径。
- 不把 skill 内容/secret 写入 log/audit 正文；只记 skillId/hash/reason。

### 3.7 与相邻 cell 的边界

- `identity-session` owns AgentProfile/role/allowlist 的 server-side 投影；plugin 只消费 `restrictions_json.skills`。
- `pi runtime` owns `DefaultResourceLoader`/session；plugin 只提供 curated skill paths，不绕过 `noSkills:true` 基线。
- `SOP/bulletin` owns `nextSkill` 建议；plugin 不强制加载，allowlist 是硬边界；建议经 repo read 落地，mid-session loader 注入不是 v1 承诺。
- `W0 adapter` owns pi loader 注入 API 验证（skills dir 选项或显式列表）；失败记 `KERNEL_GAPS.md`，plugin 不改 kernel。
- skill 目录不在 agent 可读面；只有 index + SKILL.md 文本进入 context；多文件 skill fork 时合并为单文件。
- `harness-eval` owns skill 质量/eval；plugin 只加载，不评价。
- `mcp-surface-governance` owns MCP tool identity/exposure；skill 不注册 MCP。
- `callback-auth` owns credentials；skill 不读 token/secret。
- `hub-action-surface`/Console owns 管理面；v1 不提供 plugin manager UI。
- `F202/F247/F285/F290/F292` 的完整能力各归其 cell；plugin v1 只取 skill surface。

## 4. 风险与回滚

| 风险 | 级别 | 处置 |
|---|---|---|
| manifest 当权限/健康 | P1 | manifest 只声明；loaded per-session；不接 plugin live state |
| 外部 executable 进 API process | P1 | v1 无 package/runtime；skill 只读文本，不自动执行 |
| path traversal/symlink escape | P1 | realpath containment + reject absolute/..；foreign/broken 不覆盖 |
| prompt injection via skill content | P1 | curated allowlist；skill 不改 tool policy/permission；secret scan |
| cross-project skill leakage | P1 | project-level root；不扫 HOME；跨项目路径 reject |
| manifest/frontmatter 双源 drift | P1 | frontmatter 唯一权威；manifest 重复字段 invalid；`skill_metadata_duplicate_total` |
| 全文常驻 L1 撞上下文预算 | P2 | index 常驻、body 按需；`skill_indexed`/`skill_body_loaded` 分口径 |
| `nextSkill` 建议被 allowlist 拒绝但不可见 | P2 | `next_skill_skipped_by_policy` notice/metric |
| missing/unreadable skill 静默 | P2 | typed missing/unreadable；fail closed + metric |
| stale skill | P2 | hash/mtime drift → reload；missing 从 session set 移除 |
| `nextSkill` 强制链/mid-session 注入假设 | P2 | 只作建议；repo read 落地；mid-session loader 注入非 v1 承诺 |
| realpath 基准用字面 root | P2 | 用 `realpath(catalog_root)` 比较 |
| skill 目录不可读/多文件死链 | P2 | v1 只走单文件 SKILL.md；fork 时合并 references |
| allowlist 悬空引用 | P3 | session warning + `skill_allowlist_unknown_total` |
| W0 loader 注入 API 未验证 | P3 | W0 spike 验证；失败记 `KERNEL_GAPS.md` |
| plugin scope creep | P2 | v1 boundary 写死；F202/F247/F285/F290/F292 另卡 |
| secret in skill/manifest | P1 | basic secret scan + reject + audit；不写正文 |
| role allowlist drift | P2 | server-side profile；会话前复验；空=不加载 |

**回滚**：全量关闭把 `CODETEAM_SKILLS_MANIFEST` 指回空/基线；单角色回退直接清该 profile 的 `restrictions_json.skills`。均回到无 skill 基线；不迁移 plugin/skill 数据；不删除仓库 skill 文件。

## 5. Review 与签字

> Review request `e3168435-73d6-4a82-a840-979596c21466`（2026-10-25，三猫）。结论：烁烁 accept；砚砚 accept；墨墨 accept-with-modify。**无 P1**；3×P2 + 11×P3 已回写。Operator 2026-10-25 拍 **`DP-PLUGIN-1=A`（skill surface only）、`DP-PLUGIN-2=A`（repo-local curated + role allowlist + project root）**；W0/W4 skill surface 契约冻结。

| 角色 | 关注面 | 结论 |
|---|---|---|
| 烁烁 | pi resourceLoader/skill discovery/load state/W0/W4 seam | accept；P2 nextSkill 生效路径 + P3×2 已回写 |
| 砚砚 | path containment/symlink/executable/prompt injection/secret/cross-project | accept；P3×4 已回写（realpath 基准、skill 目录不可读/多文件、注入供应链、secret scan 定位） |
| 墨墨 | operator/agent skill 体验、manifest 可读性、无 marketplace 混淆、DP-PLUGIN-1/2 | accept-with-modify；P2 metadata 单源 + index/body 两级，P3×5 已回写 |
| operator | DP-PLUGIN-1 scope / DP-PLUGIN-2 source-mount | 已签 `DP-PLUGIN-1=A` / `DP-PLUGIN-2=A`（2026-10-25） |

**Findings disposition**

| # | 来源 | Finding | 处置 |
|---|---|---|---|
| P2-1 | 烁烁 | `nextSkill` 只有“建议”的否定语义，没有 advice→加载机制；pi mid-session 注入能力未验证 | **已修**：nextSkill 经 agent repo read 落地；allowlist 只管 session 启动注入，不管 repo read；mid-session loader 注入非 v1 承诺 |
| P2-1 | 墨墨 | manifest 与 SKILL.md 双写 description/triggers，无 precedence；fork 继承 clowder 手工同步债 | **已修**：frontmatter 是 name/description/triggers 唯一权威；manifest 只留 category/not_for/output/next/sop_step；重复字段 → invalid_manifest |
| P2-2 | 墨墨 | 只有单一 loaded 状态；全文常驻会撞 context 预算，不常驻则 agent 不知道有什么 skill | **已修**：`indexed`（index 常驻）→ `loaded`（正文按需，per-turn）；`skill_indexed`/`skill_body_loaded` 分口径 |
| P3-1 | 烁烁 | allowlist 引用不存在的 skillId 静默 absent | **已回写**：session 启动 warning + `skill_allowlist_unknown_total` |
| P3-2 | 烁烁 | W0 未验证 pi loader 注入 API | **已回写**：W0 spike 验证 skills dir/显式列表；失败记 `KERNEL_GAPS.md` |
| P3-1 | 砚砚 | realpath 基准若用字面 catalog root 会误判 | **已回写**：用 `realpath(catalog_root)` 比较 |
| P3-2 | 砚砚 | skill 目录不在 agent 可读面；多文件 references 是死链 | **已回写**：v1 只走单文件 SKILL.md；fork 时多文件 skill 合并 |
| P3-3 | 砚砚 | prompt injection 供应链假设未写明 | **已回写**：第一防线 = curated + repo PR review；`skillSupplyChain` 行 |
| P3-4 | 砚砚 | secret scan 被误当准入条件 | **已回写**：secret scan 是最后防线，不是准入；命中 reject+audit |
| P3-1 | 墨墨 | `SkillSourceKind` 无落点字段 | **已回写**：`SkillCatalogEntry.sourceKind ∈ builtin / curated`；v1 拒绝 marketplace |
| P3-2 | 墨墨 | nextSkill 被 allowlist 拒绝时不可见 | **已回写**：`next_skill_skipped_by_policy_total` + 会话 notice |
| P3-3 | 墨墨 | `tips_exempt` 无 codeteam 语义 | **已回写**：v1 drop，不进入 SkillManifest |
| P3-4 | 墨墨 | secret scan pattern 集来源未引 | **已回写**：复用 W2 audit 同款 pattern 扫描 |
| P3-5 | 墨墨 | 回滚只写全量 off | **已回写**：补单角色回退（清 profile `restrictions_json.skills`） |

### 待拍板

| DP | 选项 | 推荐 | 不拍的后果 |
|---|---|---|---|
| DP-PLUGIN-1 v1 scope | A=skill surface only；B=full plugin framework（manager/inventory/broker/runtime/marketplace） | **A** | B 会把外部包/运行时/市场拖进 W0/W4，范围与攻击面暴涨 |
| DP-PLUGIN-2 skill source/mount | A=repo-local curated `SKILL.md` + `manifest.yaml`（catalog 只做路由），role allowlist，project-level root，无 HOME/global symlink；B=plugin.yaml package + 多项目 symlink cascade | **A** | B 会带回 plugin manifest 权限面与跨项目 mount 泄漏风险 |

**Review 重点**

1. skill-only surface 是否满足 W0/W4；`SKILL.md` + `manifest.yaml` 是否足够，是否需要 codeteam 自有 skill manifest。
2. pi `DefaultResourceLoader` + role allowlist 是否足以阻止自动发现/ghost skill；`noSkills:true` 的替换路径是否清楚。
3. path containment/symlink/executable/prompt-injection/secret/cross-project 是否闭环；v1 是否应允许 HOME/global mount。
4. `nextSkill` 与 role allowlist 的边界是否清楚；SOP 是否可能被当成强制加载。
5. full plugin framework（F202/F247/F285/F290/F292）边界是否清楚；有没有把 marketplace/Broker/runtime 误带入 v1。

[宪宪/deepseek-flash🐾]
