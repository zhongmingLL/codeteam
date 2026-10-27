---
feature_ids: [F002]
related_features: [F001]
topics: [w0a, bootstrap, l0, pi-session, skill-surface, sandbox-preflight, hub-spike, supply-chain]
doc_kind: spec
status: in-progress
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: []
created: 2026-10-26
updated: 2026-10-27
---

# F002: W0a 下游基线与运行时能力验证

> Status: spec | Owner: 宪宪 | Gate: W1 入场前
>
> 本 feature 承接 `docs/plans/0002-w0-w2-foundation.md` 中 **W0a 的剩余验收**。
> W0b（完整 upstream/CI 治理）、W0c（daemon 最小生命周期面）和 W1+ 不在本 feature 内。
> F002 完成 = W0a evidence pack 通过独立 review，W1 可以开始（W0c 仍单独阻塞
> W1 runtime 启动）。
>
> **Scope confirmed (2026-10-26):** operator confirmed F002 owns the entire W0a gate.

---

## Why

F001 已冻结架构契约，W0a 是阻塞 W1 迁移/建表的硬门禁（W0c 单独阻塞 runtime 启动）。
当前仓库已经完成了一部分
W0a：pi `v1.4.0` pin、`upstream` remote、文档迁移、基线构建验证和零 kernel patch
骨架都已存在。但后续 W1/W2 真正依赖的运行时能力仍然只是文档 claim，不是可复现证据：

- L0 在 auto/manual compaction 后是否逐字保留；
- pi session 能否跨进程导出/恢复；
- curated skill surface 能否只按 allowlist 注入；
- bwrap、低权 worktree、Hub 承载是否可用；
- 旧 codeteam 资产到底复用还是 fresh 重建。

同时，准备 F002 时发现了三个会直接影响 W1 的基线缺口：

| 缺口 | 当前事实 | 影响 |
|---|---|---|
| 计划真相源未入仓 | `.gitignore:43` 的 `plans/` 规则让 `docs/plans/` 被忽略；`git ls-files docs/plans` 为空 | 干净 clone 看不到 W0–W8 计划，F001/README 的链接会断 |
| CI 不覆盖开发分支 | `.github/workflows/ci.yml` 只监听 `main` 的 push/PR | 功能分支合入 `codeteam-work` 前不会跑 CI |
| 保护规则不完整 | `main` 无 required status checks，`codeteam-work` 未保护 | “required check” 只是文档声明，不能阻断坏合入 |

如果不先补 F002，W1/W2 会建立在未验证的 L0/session/skill/沙箱假设上，迁移策略也可能
基于不存在的“旧基线”做错方向。

## 结果

完成后，operator 应该能拿到：

1. 一份可复现的 **W0a evidence pack**，每个 spike 都有命令、日志/哈希、结论和回退；
2. 一个能阻断坏合入的 CI/分支保护基线，覆盖 `main` 和 `codeteam-work`；
3. 一份 **baseline reuse map**，明确 control plane/store/adapter/verifier/eval/CLI
   哪些复用、哪些适配、哪些丢弃，作为 W1 migration 的输入；
4. 对 L0、session export/resume、skill allowlist、bwrap/worktree、Hub 承载的
   **go / conditional / no-go** 结论；
5. W1 入场决定：PASS、CONDITIONAL（带缺口 owner 和 fallback）或 FAIL。

## 当前基线

| 项目 | 事实 | 证据 |
|---|---|---|
| 仓库形态 | `origin=zhongmingLL/codeteam`，`upstream=earendil-works/pi`，pin `v1.4.0` @ `4a080252f06caf63a525d7873c5d94d3c23887e0` | `UPSTREAM.md` |
| 分支 | `main` 为发布基线，`codeteam-work` 为开发分支 | `CODETEAM.md` / `UPSTREAM.md` |
| 构建 | `npm install --ignore-scripts`、pinned catalog、`build:offline` 通过 | `docs/reports/2026-10-26-pi-v1.4.0-baseline.md` |
| 全量测试 | `./test.sh` 在 WSL2 上 exit 1；失败集中在 env daemon、clipboard、auth-storage、model-runtime | 同上 |
| kernel patch | 零 patch | `KERNEL_GAPS.md` |
| codeteam 包 | 还没有 `packages/codeteam-*` | `packages/` |
| CI | 只覆盖 `main`；npm audit 仅定时运行 | `.github/workflows/ci.yml` / `npm-audit.yml` |
| 分支保护 | `main` 无 required checks；`codeteam-work` 未保护 | `gh api .../branches/main/protection` |
| 计划文档 | `docs/plans/` 被 `.gitignore` 忽略 | `git check-ignore -v docs/plans/README.md` |

## Scope

### In scope（W0a 剩余门禁）

1. **真相源与工程基线**：计划文档入仓、干净 checkout 复现、CI 覆盖开发分支、最小供应链门禁、分支保护证据。
2. **Baseline reuse map**：逐资产盘点 control plane/store/adapter/verifier/eval/CLI，给出 reuse/adapt/discard 与 W1 migration 输入。
3. **L0 compiler v0 + spike**：确定性编译、native system prompt 注入、auto/manual compaction 后逐字保留、section hash/cache 证据。
4. **pi session 跨进程能力**：export/resume 实测；不支持则写 `KERNEL_GAPS.md` 并把 W5 迁移策略改为 fresh+capsule。
5. **Curated skill surface spike**：manifest、index/body 两级、allowlist、path containment、secret scan、多文件合并、role allowlist。
6. **W0a 预检**：bwrap、低权 user × worktree 属主、Hub 承载兼容性。
7. **Gate evidence**：汇总报告、独立 review、W1 入场决定、相关文档回写。

### Out of scope

- W0b 的完整 upstream 同步治理、跨 OS CI 矩阵和长期 audit 运营；F002 只补 W0a 必需的最小阻断门禁。
- W0c 的 daemon boot ledger / readiness / 生命周期记录。
- W1 schema、migration、backfill。
- W2 的完整 sandbox 实现；F002 只做可用性预检和降级结论。
- W3 review policy/eval、W4 SOP、W5 RPC worker、W7 Console、W8 Forge。
- 在 `clowder-ai/codeteam/` 写 codeteam 产品代码；Hub spike 若需要 clowder 改动，只输出改动清单，另行授权。
- 没有可复现失败的 kernel patch；没有授权的生产数据、secret、force push、自动 merge。

## Phases

F002 不要求一个 PR 做完。每个 Phase 用独立 worktree/PR，最后一个 gate report 统一验收。

### Stage log

| Date | Stage | Result |
|---|---|---|
| 2026-10-26 | spec | F002 created; operator confirmed F002 = whole W0a gate |
| 2026-10-27 | kickoff | baseline docs/plans commit `8fab3265b`; Phase 0 worktree opened |
| 2026-10-27 | impl Phase 0 | docs/plans + CI + protection + supply-chain evidence (`7b213ba49`); zod exception pending security review |
| 2026-10-27 | review fix | P1 catalog pin/CI hydrate + empty job deferral; P2 AGENTS rule; P3 report path hygiene |
| 2026-10-27 | Phase 0 merged | PR #1, squash `6a198a526`; Phase 1 worktree opened |
| 2026-10-27 | impl Phase 1 (partial) | L0 compiler v0 + native resource-loader helper; compaction/session spike pending |
| 2026-10-27 | impl Phase 1 core | L0/session evidence complete: 10/10 adapter tests, manual/auto compaction, cross-process resume; P2 test-strength fix, approved after re-cover |
| 2026-10-27 | Phase 1 merged | PR #2, squash `bee299a96`; review approved at `9e9022b4e`; AC-6–AC-11 satisfied |
| 2026-10-27 | impl Phase 2 | Curated skill catalog + allowlist injection; review P2 (in-skill symlink escape) and P3 (SKILL.md scan bypass) fixed; fork/import merge deferred to W4 |
| 2026-10-27 | impl Phase 3 | W0a preflight: bwrap/PID/net isolation available; worker rw / reviewer ro / evidence separate; Hub thread + card live; approvals aggregate 503 noted |
| 2026-10-27 | impl Phase 4 | Baseline reuse map: no old code found; fresh baseline for 6 assets; W1 inputs recorded |
| 2026-10-27 | impl Phase 5 | Gate pack: CONDITIONAL PASS; AC-18 review pending; W0c remains outside F002 |
| 2026-10-27 | Phase 5 review | Gate pack approved by 烁烁 at `79ae95ac5`; 2 P3 folded; AC-18/AC-19 ticked |
| 2026-10-27 | audit correction | Skill catalog N1/N2 rows added to the migration matrix; fresh repo-local catalog deviation recorded |
| 2026-10-27 | verification addendum | Provider HTTP E2E added: local Anthropic-shaped SSE server + real session loop; L0 observed in the outbound request |

### Phase 0 — 真相源与工程基线

**目标**：让“文档真相源 + CI + 保护规则”先成立，后续 spike 才有可信落点。

1. 修复 `docs/plans/` 未入仓：
   - 把 `.gitignore` 的 `plans/` 收窄为 `/plans/`（只忽略根目录 `plans/`），或在明确理由下
     force-add `docs/plans/*.md`；
   - 验证 `git check-ignore` 不再命中 `docs/plans/`，`git ls-files docs/plans` 非空；
   - 若改 `.gitignore`，按 upstream divergence 记录到 `UPSTREAM.md`。
2. 干净 checkout 复现：
   - `NODE_ENV=development npm install --ignore-scripts`；
   - 按 `UPSTREAM.md` hydrate pinned model catalog；
   - `NODE_ENV=development npm run build:offline`；
   - `NODE_ENV=development ./test.sh`；
   - 记录 WSL2/host 差异，CI 使用受支持的 Linux runner，不在 WSL2 上宣称全绿。
3. CI 最小门禁：
   - 触发条件覆盖 `main` 和 `codeteam-work` 的 push/PR；
   - Phase 0 必跑：upstream 测试、lockfile 完整性、生产依赖 audit；
   - codeteam 包测试 job 延后到 Phase 1，首个 `packages/codeteam-*` 包出现时再加入；Phase 0 不保留空的同名 job；
   - CI 先从 `nix/model-catalog.json` hydrate pinned catalog，再跑 `build:offline` 和测试，避免 live catalog 漂移；
   - audit 复用仓库已有 `scripts/npm-audit.mjs`，不新建第二套审计；
   - 失败阻断，不把 audit 只放在每日 schedule。
4. 分支保护：
   - `main` 和 `codeteam-work` 都要求 PR、required checks、禁 force push/删除；
   - 用 `gh api` 输出作为 evidence，不用“我设置过了”作为 proof。
5. 安全边界：
   - CI secrets 只放 CI；仓库内不出现 token/密钥；
   - 测试只使用隔离数据目录，不指向生产用户数据。

**Exit evidence**：干净 clone 日志、CI run、`gh api` protection JSON、`git ls-files docs/plans`。

### Phase 1 — L0 compiler v0 + compaction/cache spike

> Phase 1 implementation status (2026-10-27): core evidence complete and merged (PR #2, squash
> `bee299a96`); independent review approved at `9e9022b4e` after the P2 assertion fix. AC-6–AC-11
> are satisfied. AC-18 stays open until the Phase 5 gate pack is reviewed as a whole.

**目标**：把 D9“L0 放 native system prompt，压缩免疫”从 target 变成可复现事实，或明确失败。

1. 新建 `packages/codeteam-pi-adapter`（包名 `@codeteam/pi-adapter`），先只承担 W0a 需要的边界：
   - `src/l0/compiler.ts`：role 模板 + 治理段 → `{ text, revision }`；
   - `revision` = 对规范化 bytes 做 SHA-256；输入只允许稳定内容，不放时间、随机数、host path；
   - `src/l0/templates/{coder,reviewer,verifier}.md`：最小角色模板，后续再由 W1/W4 扩展；
   - `src/session/resource-loader.ts`：`DefaultResourceLoader` + `createAgentSession`；
   - `src/session/session.ts`：export/resume 的薄封装，不把 pi session 类型泄漏给控制面。
2. L0 注入：
   - `systemPromptOverride: () => compiledL0.text`；
   - `noContextFiles: true`；
   - `appendSystemPromptOverride: () => []`；
   - `noSkills: true` 保持基线，skill surface 在 Phase 2 单独开；
   - 断言 `compiledL0.text` 作为连续片段出现在 `session.systemPrompt`，且没有
     `AGENTS.md`/`CLAUDE.md`/APPEND_SYSTEM 双重注入。
3. 出站 request 捕获：
   - 用 pi 的 `createProvider`/`createModels` 测试模式或本地 recording provider 捕获 request body；
   - 不依赖真实 API key；记录 system section hash；
   - 若 provider cache 指标不可观测，明确写 `cache_observability=unavailable`，至少给出 system hash 稳定性证据。
4. Compaction spike：
   - 长 session 跑到 auto compaction 阈值，auto 与手动 `session.compact()` 各测一遍；
   - 断言 compaction 后首个 request 的 system 仍包含完整 L0；
   - 记录 session 文件、compaction entry、request 摘要、命令和断言日志。
5. Session export/resume：
   - 用 `AgentSessionRuntime` / `SessionManager` 导出 session JSONL；
   - 启动第二个进程，用 `runtime.importFromJsonl()` 恢复；
   - 验证消息历史、model/thinking、L0 revision 和可继续 prompt；
   - 不支持则记录 `KERNEL_GAPS.md`，并回写 W5：迁移改为 fresh + capsule，不能静默失忆。
6. 失败处理：
   - v1.4.0 失败时先按 `UPSTREAM.md` 的 fallback 测 v1.3.0；
   - 仍失败则记录 D9 降级/替代方案，不把未验证 claim 写成“已证明”；
   - 只有可复现失败 + 最小测试 + upstreamability/rollback 才允许 kernel patch。

**Exit evidence**：`docs/reports/2026-10-27-f002-phase1-l0-compiler.md` + 单测/集成测试。

### Phase 2 — Curated skill surface spike

> Phase 2 implementation status (2026-10-27): catalog, allowlist injection, containment, secret
> scan, and empty/dangling behavior are implemented and tested. AC-12 stays open for the
> fork/import multi-file merge, which is deferred to W4 with a named revisit trigger.

**目标**：验证 role curated skills 能按 allowlist 注入，且不恢复 pi 自动发现/HOME mount。

1. 建 catalog：`packages/codeteam-skills/manifest.yaml`（按 `packages/codeteam-*` 约定；
   若 operator 要求根 `skills/`，在实现前统一）。
   - entry 只保留 `skillId/path/sourceKind/category/not_for/output/next/sop_step`；
   - description/triggers 从 `SKILL.md` frontmatter 读，不双写。
2. 加载器：
   - 验证 pi `DefaultResourceLoader` 的显式 skills 注入 API；
   - `noSkills: true` 仍是基线，只有 allowlist 注入；
   - 不自动发现、不挂 HOME、不加载全量 cat-cafe skills。
3. 安全：
   - skill path 必须 `realpath(catalog_root)` containment；
   - 拒绝绝对路径、`..`、symlink escape；
   - curated allowlist + secret scan；
   - skill 不改 tool policy/permission。
4. 两级语义：
   - index（id/name/description/triggers/next）常驻；
   - body（`SKILL.md` 正文）按需加载；
   - 多文件 skill 在 fork/import 时合并为单文件，并记录合并结果。
5. Role allowlist：
   - 空 allowlist = 不加载；
   - 悬空 skill id = warning；
   - `nextSkill` 经 repo read，被 allowlist 拒绝时可见 skip 原因。

**Exit evidence**：`docs/reports/2026-10-27-f002-phase2-skill-surface.md` + loader 测试。

### Phase 3 — W0a 预检

> Phase 3 implementation status (2026-10-27): preflight complete. bwrap userns isolation works on
> this WSL2 host; the low-privilege mount model is kernel-enforced; the Hub hosts this thread and a
> rich card. Distinct-uid reviewer validation and the approval producer are W2/W4 entry checks.

**目标**：给 W2 的 sandbox 和 W7 的 Hub 承载提供真实 go/no-go，而不是假设。

1. bwrap：
   - 在 WSL2 和受支持 Linux 上检查 unprivileged user namespace；
   - 记录命令、输出和是否可创建隔离 mount/pid/net；
   - 不可用则重开 D3，写清降级方案和影响，不等 W2 才发现。
2. 低权 user × worktree：
   - worker 能写自己的 task worktree；
   - reviewer/verifier 对 task worktree 只读；
   - evidence 写入独立目录；
   - 不用 `chmod 777` 绕过。
3. Hub 承载 spike：
   - 用现成 clowder Hub 展示一个外部 thread + 消息收发 + 一张 `approvals` 卡；
   - 输出“clowder 侧所需改动清单”（可为空）；
   - 需要 clowder-ai 改动时只作为独立 operator 授权项，不混进 codeteam 产品代码。

**Exit evidence**：`docs/reports/2026-10-27-f002-w0a-preflight.md`。

### Phase 4 — Baseline reuse map

> Phase 4 implementation status (2026-10-27): no runnable codeteam code exists on this host.
> The six-asset matrix records a fresh baseline; W1 uses synthetic fixtures and no backfill.

**目标**：给 W1 一个明确的“复用还是 fresh”输入，避免迁移策略建立在猜测上。

1. 定位旧 codeteam 实现来源仓/路径/commit。当前本机 `clowder-ai/codeteam/` 只有文档，
   未找到 `packages/codeteam/src/control-plane.ts`；实现前必须确认来源，不能默认存在。
2. 对以下资产逐项列矩阵：
   - control plane；
   - store；
   - pi adapter；
   - verifier；
   - eval；
   - CLI。
3. 每项写：源路径/commit → 能力 → `reuse | adapt | discard` → 理由 → W1 migration 输入。
4. 如果旧实现不可获得，明确声明 **fresh baseline**：W1 用合成 fixture，不走旧库 backfill；
   不伪造“已落地”资产。

**Exit evidence**：`docs/reports/2026-10-27-f002-baseline-reuse-map.md`，并在 W1 计划中引用。

### Phase 5 — Gate evidence 与独立 review

> Phase 5 implementation status (2026-10-27): gate pack written with a **CONDITIONAL PASS**
> decision; AC-18/AC-19 stay unchecked until the non-author review returns.

1. 写 `docs/reports/2026-10-27-f002-w0a-gate.md`：
   - AC 逐条证据；
   - 每个 spike 的 pass/conditional/fail；
   - fallback、未解决缺口、owner；
   - W1 入场决定。
2. 回写：
   - `UPSTREAM.md`：基线、divergence、fallback；
   - `KERNEL_GAPS.md`：spike 失败/patch 状态；
   - `docs/architecture/0002-pi-runtime-integration.md`：L0/session 的实测结论；
   - `docs/plans/README.md` 与 `docs/plans/0002-w0-w2-foundation.md`：W0a 状态与结果；
   - `BACKLOG.md`：F002 状态。
3. 独立 review：作者不能自审。默认请烁烁覆盖 fork/L0/session；只有在确实产生 kernel patch
   或 CI 安全边界改动时，再加砚砚覆盖供应链/安全面。
4. Gate 决定：
   - **PASS**：W1 可以开始；
   - **CONDITIONAL**：W1 可以开始，但必须有具名缺口 owner、fallback 和复验条件；
   - **FAIL**：W1 不开始，先修 W0a。

## Acceptance Criteria

- [x] **AC-1 计划真相源入仓**：`git ls-files docs/plans` 包含 `README.md` 和 0001–0007；干净 clone 能看到这些文件；`git check-ignore docs/plans/README.md` 不再命中。
- [x] **AC-2 干净 checkout 可复现**：按 `UPSTREAM.md` 的 install/catalog/build/test 命令在干净 checkout 跑通；WSL2/host 特例有记录，CI 使用受支持 runner。
- [x] **AC-3 CI 覆盖开发分支**：`codeteam-work` 的 PR 会触发 CI；Phase 0 required checks 至少包含 upstream 测试、lockfile 完整性、生产依赖 audit；Phase 1 首个 codeteam 包落地后确认 root `npm test --workspaces` 已在 `build-check-test` 中执行 adapter 测试，因此不再新增重复的 `codeteam-package-tests` job。
- [x] **AC-4 分支保护可查**：`main` 与 `codeteam-work` 都要求 PR + required checks，禁 force push/删除；`gh api` 输出存档。
- [x] **AC-5 供应链最小项**：`npm ci --ignore-scripts` 校验 lockfile；audit 失败会阻断 PR；`--ignore-scripts` 理由在 `UPSTREAM.md`；仓内无 secret。
- [x] **AC-6 L0 编译确定性**：同一 role/治理输入得到同一 `l0_revision`；无时间、随机数、host path；单测覆盖。
- [x] **AC-7 L0 native 注入**：L0 作为连续片段出现在 `session.systemPrompt`；`noContextFiles` 生效；`appendSystemPromptOverride` 为空；没有 AGENTS/CLAUDE 双重注入。
- [x] **AC-8 Auto compaction 保留 L0**：auto compaction 后首个出站 request 的 system 逐字包含 L0；有 request 捕获和断言日志。
- [x] **AC-9 Manual compaction 保留 L0**：手动 `session.compact()` 后同样逐字保留；有独立证据。
- [x] **AC-10 Cache/hash 证据**：section 稳定时 system hash 稳定；cache 指标不可观测时明确记录 `cache_observability=unavailable`，不伪造命中。
- [x] **AC-11 Session export/resume 结论**：跨进程 export → import → continue 成功，或有精确失败记录 + W5 fresh+capsule fallback 回写。
- [ ] **AC-12 Curated skill surface**：manifest schema、index/body、allowlist 空=不加载、悬空 id warning、path containment、secret scan、多文件合并均有测试/证据；无自动发现/HOME mount。（catalog 合并与注入已测；fork/import 多文件合并未实现，owner W4，见 Phase 2 报告）
- [x] **AC-13 bwrap 预检**：WSL2/受支持 Linux 的 unprivileged userns 结论明确；不可用时 D3 已重开并写清降级。（本机 userns + bwrap mount/PID/net 均可用；D3 未重开，宿主缺 userns 时按报告 fallback 触发）
- [x] **AC-14 低权 worktree 预检**：worker 可写、reviewer/verifier 只读、evidence 隔离；没有 chmod 777。（worker rw / reviewer ro 由 mount namespace 内核强制，evidence 独立；verifier 复用 reviewer 只读路径未单独起进程；独立 OS 用户验证留给 W2/CI）
- [x] **AC-15 Hub 承载结论**：外部 thread + 消息 + approval 卡可展示，或给出 clowder 侧改动清单；没有未授权的 clowder-ai 改动。（thread + 消息 + rich card 实证；approval 生产者为 W4/W7 codeteam 侧；clouder 侧清单已记录）
- [x] **AC-16 Baseline reuse map**：control plane/store/adapter/verifier/eval/CLI 六类资产都有源、能力、reuse/adapt/discard、理由；W1 计划引用；无来源时明确 fresh baseline。（六类资产矩阵已产出；旧代码全盘不存在，声明 fresh baseline；W1 计划已引用）
- [x] **AC-17 Zero unrecorded kernel patch**：没有未记录的 kernel 改动；任何 patch 都有可复现失败、测试、upstreamability、rollback。（`git diff 4a080252f..HEAD --diff-filter=M --name-only -- packages/` 只有 `coding-agent/package.json` + `install-lock/package-lock.json`，已记 `UPSTREAM.md`；零删除、零 kernel source 改动）
- [x] **AC-18 独立 review**：非作者 reviewer 覆盖最终 evidence pack；P1/P2 已修复并由提出者覆盖；没有 self-approve。（烁烁 approve `79ae95ac5`；Phase 1 P2、Phase 2 P2/P3 均由提出者覆盖）
- [x] **AC-19 Gate 决定**：`w0a-gate` 报告给出 PASS/CONDITIONAL/FAIL；W1 入场决定和 fallback 已记录。（CONDITIONAL PASS：schema 可开始，runtime 启动等 W0c；见 gate 报告 §6）
- [x] **AC-20 数据安全**：所有测试使用隔离目录/合成 fixture；没有生产用户数据、没有仓内 secret、没有不可逆操作。（测试全部 `mkdtemp` 隔离；无生产数据；仓内无 secret——假 key fixture 运行时拼接；无不可逆操作）

## Deliverables

- `docs/features/F002-w0a-foundation-gate.md`（本文件）
- `docs/reports/2026-10-27-f002-w0a-gate.md`
- `docs/reports/2026-10-27-f002-phase1-l0-compiler.md`
- `docs/reports/2026-10-27-f002-phase2-skill-surface.md`
- `docs/reports/2026-10-27-f002-w0a-preflight.md`
- `docs/reports/2026-10-27-f002-baseline-reuse-map.md`
- `packages/codeteam-pi-adapter/`：L0 compiler、pi session adapter、session runtime 薄封装、测试
- `packages/codeteam-skills/manifest.yaml` + 最小 curated skill 样本
- CI/workflow 与 branch protection 变更
- `UPSTREAM.md` / `KERNEL_GAPS.md` / `docs/architecture/0002` / `docs/plans/*` / `BACKLOG.md` 回写

## Dependencies

- F001 架构契约已 reviewed；本 feature 不重新讨论架构方向。
- operator 提供/确认旧 codeteam 实现来源；若不可获得，确认 fresh baseline。
- operator 或 repo admin 执行/确认 branch protection；如果当前 token 无权限，记录阻塞而不是伪造。
- 受支持的 Linux CI runner；WSL2 只作本地预检，不作为全量测试绿证。
- Hub spike 需要现成 clowder Hub；若需改 clowder-ai，另走 operator 授权。

## Risks

| 风险 | 影响 | 缓解 |
|---|---|---|
| L0 在 v1.4.0 上不成立 | D9 失效，W1/W5 设计要改 | 先测 v1.4.0；失败按 `UPSTREAM.md` 回退 v1.3.0；仍失败则记 KERNEL_GAPS 并重开 D9 |
| session export/resume 不支持 | W5 迁移会静默失忆 | 先验证；不支持就明确 fresh+capsule，不把“应该可以”写进计划 |
| skill loader API 与文档不符 | W0 skill surface 卡住 | 以 v1.4.0 源码/实测为准；失败记 KERNEL_GAPS，不擅自改 kernel |
| bwrap 在 WSL2 不可用 | W2 sandbox 假设失效 | W0a 预检即重开 D3；给出降级/替代方案，不等 W2 |
| Hub 需要 clowder 改动 | 范围溢出到另一仓 | 只输出改动清单；作为独立 operator 授权项，不混入 codeteam 产品代码 |
| 旧 codeteam 源码不可得 | W1 migration 方向错误 | 明确 fresh baseline，用合成 fixture，不伪造旧数据 backfill |
| CI 只绿在本地/WSL2 | 合入证据不可信 | 受支持 Linux runner + required checks；WSL2 差异单独记录 |
| F002 范围过大 | 拖慢 W1 | 按 Phase 独立 worktree/PR；每个 Phase 有 exit evidence；失败可 conditional gate，不硬撑 |

## Open Questions

1. ~~**F002 是否就是整个 W0a gate？**~~ 已确认（2026-10-26）：F002 = 整个 W0a gate；实现按 Phase 拆 PR。
2. **旧 codeteam 实现在哪里？** 需要来源仓/路径/commit；本机 `clowder-ai/codeteam/` 只有文档。
   若没有，确认按 fresh baseline 进入 W1。
3. **Hub spike 是否授权 clowder-ai 改动？** 默认不授权：F002 只输出改动清单；需要改动时单独找 operator。
4. **zod advisory 例外需要独立 security review**：`GHSA-mrhx-c7xc-m3w5` 当前只在未发布 sandbox example 的 `@anthropic-ai/sandbox-runtime` 路径上触发；合并前需要砚砚复核，W2 sandbox 前必须重审。

## Committed Files

### Baseline commit (2026-10-27)

```text
.gitignore
AGENTS.md
BACKLOG.md
CLAUDE.md
GEMINI.md
UPSTREAM.md
docs/README.md
docs/SOP.md
docs/decisions/.gitkeep
docs/discussions/.gitkeep
docs/features/.gitkeep
docs/features/F002-w0a-foundation-gate.md
docs/features/TEMPLATE.md
docs/plans/0001-runtime-hardening.md
docs/plans/0002-w0-w2-foundation.md
docs/plans/0003-w3-w4-review-sop.md
docs/plans/0004-w5-w8-scale-product.md
docs/plans/0005-plan-review-resolutions.md
docs/plans/0006-clowder-reuse-plan.md
docs/plans/0007-architecture-plan-coverage.md
docs/plans/README.md
docs/reuse/README.md
```

### Phase 0 commit (2026-10-27)

```text
.github/workflows/ci.yml
UPSTREAM.md
docs/features/F002-w0a-foundation-gate.md
docs/reports/2026-10-27-f002-phase0-baseline.md
package.json
package-lock.json
packages/coding-agent/package.json
packages/coding-agent/install-lock/package-lock.json
scripts/npm-audit.mjs
```

### Phase 0 status commit (2026-10-27)

```text
BACKLOG.md
docs/features/F002-w0a-foundation-gate.md
```

### Phase 0 review delta commit (2026-10-27)

```text
.github/workflows/ci.yml
AGENTS.md
UPSTREAM.md
docs/features/F002-w0a-foundation-gate.md
docs/reports/2026-10-27-f002-phase0-baseline.md
nix/model-catalog.json
```

### Phase 1 commit (2026-10-27)

```text
package.json
package-lock.json
UPSTREAM.md
docs/features/F002-w0a-foundation-gate.md
docs/reports/2026-10-27-f002-phase1-l0-compiler.md
packages/codeteam-pi-adapter/README.md
packages/codeteam-pi-adapter/package.json
packages/codeteam-pi-adapter/tsconfig.build.json
packages/codeteam-pi-adapter/src/index.ts
packages/codeteam-pi-adapter/src/l0/compiler.ts
packages/codeteam-pi-adapter/src/l0/templates/coder.md
packages/codeteam-pi-adapter/src/l0/templates/reviewer.md
packages/codeteam-pi-adapter/src/l0/templates/verifier.md
packages/codeteam-pi-adapter/src/session/resource-loader.ts
packages/codeteam-pi-adapter/test/l0-compiler.test.ts
packages/codeteam-pi-adapter/test/resource-loader.test.ts
```

### Phase 1 session/compaction commit (2026-10-27)

```text
package-lock.json
docs/features/F002-w0a-foundation-gate.md
docs/reports/2026-10-27-f002-phase1-l0-compiler.md
packages/codeteam-pi-adapter/README.md
packages/codeteam-pi-adapter/package.json
packages/codeteam-pi-adapter/src/index.ts
packages/codeteam-pi-adapter/src/session/session.ts
packages/codeteam-pi-adapter/test/fixtures/resume-session.mjs
packages/codeteam-pi-adapter/test/session-compaction.test.ts
```

### Phase 1 P2 fix commit (2026-10-27)

```text
docs/features/F002-w0a-foundation-gate.md
docs/reports/2026-10-27-f002-phase1-l0-compiler.md
packages/codeteam-pi-adapter/test/fixtures/resume-session.mjs
packages/codeteam-pi-adapter/test/session-compaction.test.ts
```

### Phase 1 closeout (2026-10-27)

| Item | Evidence |
|---|---|
| Independent review | 烁烁 (non-author) approved `9e9022b4e`; P2 (`messageCount > 0` proving nothing) fixed and re-covered by the same reviewer |
| Required checks | `build-check-test` pass 8m6s, `supply-chain` pass 24s, `mcp-conformance` pass 1m1s on `9e9022b4e` |
| Adapter tests in CI | `@codeteam/pi-adapter` 3 files / 10 tests pass inside `build-check-test` (`npm test --workspaces`), including the cross-process resume case |
| Non-required failure | `generate` fails on the fork because the `v1.4.0` tag is absent; documented in PR #2, not part of branch protection |
| Merge | PR #2 squash `bee299a96` into `codeteam-work` |

Implementation divergences from the Phase 1 spec draft (semantics unchanged):

- Session files live in `src/session/*` instead of the draft's `src/adapters/*` paths.
- Resume uses `SessionManager.open()` plus `createAgentSessionWithL0`, not
  `AgentSessionRuntime.importFromJsonl()`; the cross-process, no-silent-amnesia conclusion is the same.
- No dedicated `codeteam-package-tests` job: root `npm test --workspaces` already runs the adapter
  tests inside `build-check-test`, proven by the CI log.

AC-1–AC-5 evidence (verified 2026-10-27 on `bee299a96`):

| AC | Fresh check |
|---|---|
| AC-1 | `git ls-files docs/plans` = 8 files; `git check-ignore docs/plans/README.md` no match |
| AC-2 | PR #2 `build-check-test` green on a clean GitHub runner; WSL2 deviations recorded in the Phase 0 report |
| AC-3 | PR #2 ran CI on `codeteam-work`; required checks = `build-check-test`, `supply-chain`, `mcp-conformance`; adapter tests executed inside `build-check-test` |
| AC-4 | `gh api .../branches/{main,codeteam-work}/protection`: 3 required checks, `strict=true`, force-push and deletion disabled |
| AC-5 | `supply-chain` runs `npm ci --ignore-scripts`, `npm-audit.mjs`, and `npm audit signatures`; no secrets in repo |

### Phase 2 commit (2026-10-27)

```text
package.json
package-lock.json
tsconfig.json
UPSTREAM.md
docs/features/F002-w0a-foundation-gate.md
docs/reports/2026-10-27-f002-phase2-skill-surface.md
packages/codeteam-pi-adapter/src/session/resource-loader.ts
packages/codeteam-pi-adapter/src/session/session.ts
packages/codeteam-pi-adapter/test/skills-surface.test.ts
packages/codeteam-skills/README.md
packages/codeteam-skills/manifest.yaml
packages/codeteam-skills/package.json
packages/codeteam-skills/tsconfig.build.json
packages/codeteam-skills/skills/codeteam-review/SKILL.md
packages/codeteam-skills/skills/codeteam-verify/SKILL.md
packages/codeteam-skills/src/catalog.ts
packages/codeteam-skills/src/index.ts
packages/codeteam-skills/src/manifest.ts
packages/codeteam-skills/test/catalog.test.ts
```

### Phase 3 commit (2026-10-27)

```text
docs/features/F002-w0a-foundation-gate.md
docs/reports/2026-10-27-f002-w0a-preflight.md
```

### Phase 4 commit (2026-10-27)

```text
docs/features/F002-w0a-foundation-gate.md
docs/reports/2026-10-27-f002-baseline-reuse-map.md
docs/plans/0002-w0-w2-foundation.md
```

### Phase 5 commit (2026-10-27)

```text
BACKLOG.md
KERNEL_GAPS.md
UPSTREAM.md
docs/architecture/0002-pi-runtime-integration.md
docs/features/F002-w0a-foundation-gate.md
docs/plans/0002-w0-w2-foundation.md
docs/plans/README.md
docs/reports/2026-10-27-f002-w0a-gate.md
packages/codeteam-skills/test/catalog.test.ts
```

## Phase 0 Review Delta

| Finding | Disposition |
|---|---|
| P1 `codeteam-package-tests` red by construction / duplicate / missing build | Deferred the empty job to Phase 1; `build-check-test` now hydrates the pinned catalog and uses `build:offline`; required checks reduced accordingly. |
| P1 7 `packages/ai` failures | Fixed by moving the catalog pin to `sha256-7604547f...`; targeted `classifier-models` + `cloudflare-workers-ai-system-one` tests pass (22/22). |
| P2 AGENTS.md docs-direct-push conflict | Updated: direct docs push only when protection permits; otherwise short-lived PR unless operator explicitly authorizes. |
| P3 absolute local path in Phase 0 report | Replaced with `$CODETEAM_WORKTREE`-style reference. |

## Review Plan

- 作者自检：按 `quality-gate` 检查 F002 的 AC、证据和范围，不以“计划写完”作为完成。
- 独立 review：烁烁主审 fork/L0/session；若产生 kernel patch 或 CI 安全边界改动，再加砚砚覆盖供应链/安全面。
- 每个 finding 必须有 severity + stance；P1/P2 修复后由 active source 覆盖。
- 合入路径：Phase PR 进 `codeteam-work`；release 到 `main` 另走 PR，不混在一起。

## Definition of Done

F002 完成必须同时满足：

1. AC-1 到 AC-20 都有 fresh command run + output/证据；
2. 没有 P1/P2 未关闭；
3. `w0a-gate` 报告给出明确 PASS/CONDITIONAL/FAIL 和 W1 入场决定；
4. `UPSTREAM.md`、`KERNEL_GAPS.md`、`docs/architecture/0002`、`docs/plans/*` 与
   `BACKLOG.md` 已回写；
5. 没有生产数据、仓内 secret、未授权 kernel patch 或未授权 clowder-ai 改动；
6. 每个 Phase 的代码变更可回滚（≤1 commit 的局部回滚，或明确的数据/配置恢复路径）。

以下情况不算完成：

- 只在 WSL2 本地跑绿，CI 没跑；
- 只读代码断言 L0 保留，没有出站 request 捕获；
- session resume 只在同一进程内成功；
- skill surface 仍依赖 pi 自动发现或 HOME；
- baseline reuse map 没有来源 commit，却写成“可复用”；
- 用 conditional gate 掩盖没有 owner/fallback 的失败。

---

[宪宪/deepseek-flash🐾]
