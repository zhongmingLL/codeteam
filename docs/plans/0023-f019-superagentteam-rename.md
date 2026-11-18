---
title: "F019 — SuperAgentTeam rename execution plan"
doc_kind: plan
status: completed
created: 2026-11-16
updated: 2026-11-18
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: [烁烁 (Kimi K3), 砚砚 (GLM 5.3 Flash), 墨墨 (Qwen 3.8 Flash)]
feature: F019
related_features: [codeteam/F018]
source_architecture: "docs/features/F019-superagentteam-rename.md"
source_decision: "operator 2026-11-16: independent F019 before F018 R1-0"
---

# F019 — SuperAgentTeam rename execution plan

> F019 把平台名从 `codeteam` 迁到 **SuperAgentTeam**，并把 code team 降为 team profile，
> 不把 code 语义带进通用 A2A runtime。R1-0 在 F019.1–F019.3 完成前暂停。
>
> **2026-11-18：F019.5 已完成。** 下面 F019.3 的 alias/dual-read 描述是迁移期
> 历史记录，不再代表当前行为；当前状态以第 6 节和 F019 feature 为准。

## 0. 执行顺序

```text
0. F019.0 命名矩阵/文档冻结
1. F019.1 文档/品牌/namespace
2. F019.2 包/目录/scope/import/build
3. F019.3 env/data/config + CLI/tools alias
4. F018 R1-0（使用 superagentteam 命名）
5. F019.4 repo + default branch rename done；CI/protection verified
6. F019.5 alias 清理/R5 归档
```

## 1. F019.0 — 命名冻结

**交付**

- `F019-superagentteam-rename.md` + 本 plan；命名矩阵定稿。
- `0021`/`0022` 标注 F019 依赖；F018 R1-0 暂停。
- 当前 canonical docs 的 feature namespace 迁移规则：新/活跃用 `superagentteam/Fxxx`，
  历史/legacy 保留 `codeteam/Fxxx`。

**出口**：文档一致；不改代码；operator 确认命名矩阵。

## 2. F019.1 — 文档/品牌

**交付**

- `CODETEAM.md` → `SUPERAGENTTEAM.md`；旧路径 `status: moved` stub。
- 当前 canonical **入口** docs（`AGENTS.md`、`docs/README.md`、`docs/architecture/0000`、
  `docs/plans/README.md`、`CODETEAM.md` → `SUPERAGENTTEAM.md`）的显示名/canonical
  路径更新；历史/legacy 文档不重写。
- 活跃 feature frontmatter `feature_ids` 用 `superagentteam/Fxxx`；F001–F018 历史
  namespace 保留 `codeteam/Fxxx`，或加迁移说明。
- `BACKLOG.md` 的 F019 行；F001–F018 历史名保留。

**测试**

- `check:doc-index`、`git diff --check`；链接/stub 检查；`rg` 确认历史文档未被
  批量改写。

**出口**：当前入口显示 SuperAgentTeam；历史/legacy 可追溯；无断链。

## 3. F019.2 — 包/目录/scope

**交付**

- `packages/codeteam-daemon` → `packages/superagentteam-daemon`；
  `codeteam-skills` → `superagentteam-skills`；`codeteam-pi-adapter` →
  `superagentteam-pi-adapter`。
- `@codeteam/*` → `@superagentteam/*`；import、tsconfig、root build、workspace、
  package-lock 同步。
- 如需兼容：保留 `@codeteam/*` re-export 包或 workspace alias 一个弃用窗口。
- `AGENTS.md` legacy 路径 `packages/codeteam-daemon/src/legacy/task-first/` →
  `packages/superagentteam-daemon/src/legacy/task-first/`。

**测试**

- `NODE_ENV=development npm install --ignore-scripts`；
- `NODE_ENV=development npm run build:offline`；
- 受影响包测试；`check:ts-imports`、`check:entry-graphs`。

**出口**：`@superagentteam/*` 构建通过；无旧 scope 活 import；兼容 alias 可查。

## 4. F019.3 — env/data/config + CLI/tools

**交付**

- env：新 `SUPERAGENTTEAM_*`；旧 `CODETEAM_*` 读 fallback；无历史根时新写入创建新根，存在旧根时写随旧根，直至显式迁移。
- 数据/配置：新 `~/.superagentteam`、`.superagentteam/`；旧 `.codeteam` dual-read/迁移
  fixture；无真实用户数据，但仍保留回滚。迁移语义：旧根原地读，不自动复制；显式迁移
  是服务停止期间的手动目录改名。
- CLI：`superagentteam` bin；`codeteam` wrapper/symlink；help/输出改新名。
- tools：注册 `superagentteam_*`；保留 `codeteam_*` alias；模型面文档用新名。
- 工具名映射表：`codeteam_post_message` → `superagentteam_post_message` 等；
  `codeteam_*` 在弃用窗口内仍可调用。
- 同批更新 F018 active 契约文档（`0005`/`0007`/`0013`）的工具名/显示名，并对
  五轮 exact-HEAD verdict 做一次 re-anchor，避免代码改名后契约文档成为第二真相源。
- skills：`superagentteam-verify` / `superagentteam-review` 新 skill ID + 旧
  `codeteam-*` alias/next 映射；worker prompt 的 `codeteam_*` 工具名同批切换。

**测试**

- env fallback：只设 `CODETEAM_DATA_DIR` 仍能启动；只设 `SUPERAGENTTEAM_DATA_DIR` 走新路径。
- 数据 dual-read：旧 `.codeteam` fixture 可读；无历史根时新写入 `.superagentteam`；存在旧根时写随旧根，直至显式迁移。
- CLI：`superagentteam --help`、`codeteam --help` wrapper。
- tool registry：新旧名称都可调用；旧 alias 只做转发，不产生第二套语义。

**出口**：旧 env/data/CLI/tools 可用；新入口成为默认；无数据丢失。

## 5. F019.4 — repo/branch/CI/protection

**交付**

- GitHub repo `zhongmingLL/codeteam` → `zhongmingLL/superagentteam`，以及 default branch
  `codeteam-work` → `superagentteam-work`（2026-11-17 已完成）。旧 repo URL 301；
  branch 名不 redirect。
- remotes、CI triggers、branch protection、required checks 已跟随/更新并验证；PR
  链接/badges/docs 已更新；旧 `codeteam-work` 触发已移除。
- 旧 branch refs 需要更新；旧 repo 链接由 GitHub redirect 保留。

**测试**

- `gh api` 检查 `superagentteam-work` 的 protection/required checks（3 checks、strict、
  reviews=0、enforce_admins）；CI 在新 default branch 跑通；
- PR/issue/README 链接可解析；旧 repo URL 301 redirect 已验证，旧 branch 名不再解析。

**出口**：新 repo/branch 正常；旧 repo URL redirect；protection/required checks 跟随；
旧 branch refs 已更新。

**注意**：这是 operator/ops 操作；不自行 force-push 或改 protection 绕过 review。

## 6. F019.5 — alias 清理

- 2026-11-18 完成清理：删除 `CODETEAM_*` fallback/镜像、`~/.codeteam` dual-read、
  `codeteam` CLI bin、`codeteam_*` tool alias、`codeteam-*` skill alias。
- 审计证据：真实 home 无 `~/.codeteam` / `~/.superagentteam`；无 `CODETEAM_*` env；
  无 `codeteam` CLI；无 daemon 进程；无 shell/systemd/cron 消费者；仓库无
  `@codeteam/*` re-export 包；旧名消费者只剩兼容代码/测试/迁移文档。
- 历史/legacy 文档保留原样；R5 归档。内部域分隔常量（installation hash、signed
  payload 前缀）和旧 auth deny prefix 保留，不构成兼容 alias。

## 7. 验证与 review

- 每阶段：构建、受影响测试、`check:doc-index`、`git diff --check`。
- F019.2/F019.3 必须有兼容测试；F019.4 由 operator/ops 验证 protection。
- Review：砚砚（packages/auth/security）、墨墨（docs/UX/naming）、烁烁
  （runtime/CLI）；非作者 review 覆盖 exact HEAD。
- 分支：`feat/f019-superagentteam-rename` target `superagentteam-work`；短生命周期；
  显式 `git add <paths>`。

## 8. 风险与回滚

| 风险 | 处置 |
|---|---|
| 工具名硬切破坏模型 prompt | F019.5 审计确认无活跃消费者后移除 alias；反例测试覆盖旧名拒绝 |
| 数据路径断裂 | 审计确认无运行数据后移除 dual-read；文档要求旧根手动迁移 |
| 包 rename 导致 import/build 大面积断 | 分阶段 codemod + build/ts-imports；兼容 re-export |
| 分支 protection/CI 断 | F019.4 已完成；protection/required checks 跟随并验证 |
| 历史文档被误改 | 只改当前 canonical；legacy/historical 加边界，不批量替换 |
| F018 R1 返工 | R1-0 等 F019.1–F019.3；0021 目标名先冻结 |

## 9. 第一批动作

1. operator 确认命名矩阵；F019.0 文档冻结。
2. F019.1 文档/品牌/namespace；`CODETEAM.md` stub。
3. F019.2 包/目录/scope；build/import 绿。
4. F019.3 env/data/CLI/tools alias；兼容测试绿。
5. 回写 `0021` 目标名为 `@superagentteam/*`；解除 R1-0 暂停。
6. F019.4 repo + default branch rename 已完成；protection/required checks 已验证。
7. F019.5 alias 清理已完成；旧名反例测试、build、doc-index 通过。

[宪宪/deepseek-flash🐾]
