# @codeteam/core

codeteam 的控制面：SOP、typed handoff、单槽 CAS、one terminal、deadline、loop guard、crash recovery。

这个包不直接调用模型。模型/工具/session 由 `@earendil-works/pi-coding-agent` 提供；本包负责“谁在什么时候可以把球传给谁，以及什么证据算完成”。

## 当前能力

- `ControlPlane`：task / run / handoff、单槽 CAS、one terminal、deadline、loop guard、startup recovery、stage 异常边。
- `SqliteControlStore`：`node:sqlite` 持久化，支持重启后 hydrate。
- `createCodeteamSession`：按 role 创建 pi `AgentSession`；coder 持久化，reviewer/verifier fresh context。
- `Phase3Orchestrator`：typed handoff 串 `implement -> review -> verify`，非作者 review、falsifier closure、human merge gate。
- `Phase 3 demo`：`node packages/codeteam/src/dev/phase3-demo.ts` 用 seeded bug 跑完整链路。
- CLI：`node packages/codeteam/src/cli.ts phase3-demo`（或 `npm run phase3-demo --workspace=@codeteam/core`）。

## 验证

```bash
# 首次：安装 + 离线构建上游 workspace
NODE_ENV=development npm install --ignore-scripts
NODE_ENV=development npm run build:offline

# codeteam 包
NODE_ENV=test npm run test --workspace=@codeteam/core
NODE_ENV=development npm run build --workspace=@codeteam/core
```
