---
feature_ids: [codeteam/F004d]
related_features: [codeteam/F004]
title: "F004d: W1 custody / waits / approval / review / merge"
status: in-progress
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
reviewers: []
created: 2026-10-28
updated: 2026-10-28
---

# F004d: W1 custody / waits / approval / review / merge

> F004 umbrella 的交付切片。F004 是单一 AC/契约源；本文件只加 slice-specific
> AC，不复制 W1 Acceptance。项目作用域 ID 为 `codeteam/F004d`。

## Why

F004c 让 run 可创建、可终结、可 cutover。F004d 补齐控制面的治理面：
typed handoff/custody、wait 唤醒契约、operator approval、独立 review /
finding / verification、merge receipt，以及 budget/eval/forge delivery
的持久化。没有这一层，W3/W4/W5 只能各自拼 custody 和审批状态。

## What

- `HandoffStore`：create/claim/heartbeat/completion candidate/verified commit/
  withdraw/expire/release；per-holder claims、custody events（append-only）、
  audit；single/parallel 模式。
- `WaitStore`：timer/event/managed_command waits；expected signal、owner fence、
  SLA、auto-renew、canonical `wait_terminations`。
- `ApprovalStore`：request/decide/materialize；stale 判定；effect reservation
  与 succeeded effect ref 1:1；rejected note；merge/design/spec 单 open。
- `ReviewStore`：review + findings + verifications；P1/P2 无可执行 falsifier
  自动降 P3；author/reviewer session 独立；cross-family 校验。
- `MergeStore`：base/head/merge SHA、accepted approval 链接、receipt。
- `BudgetStore` / `EvalStore` / `ForgeDeliveryStore`：预算快照、eval 指标、
  webhook delivery 去重与处理状态。
- F004c P3：credential `tokenHash` 64-hex + salt 最小形状校验。

## Acceptance

- [x] single handoff pending→claimed→candidate→consumed；verified 前置；
  custody events 顺序为 created/claimed/completion_candidate/completed。
- [x] single holder 冲突、parallel per-holder claim、release 后回 pending、
  withdraw/expire terminal 均有测试。
- [x] wait timer/event 创建、event expected signal、单 active series、
  termination canonical event、auto-renew gN→gN+1、重复 terminate fail closed。
- [x] approval open→accepted/rejected；rejected 必须带 note；stale 不可 decide；
  effectRef 必须等于 reservation；materialization 状态持久化。
- [x] review finding P1/P2 无 falsifier 降 P3；same-session 拒绝；cross-family
  同族拒绝；verification 记录 headSha/command/exit code。
- [x] merge 只接受 accepted approval；同一 approval 至多一个 merge。
- [x] budget/eval/forge delivery 创建/查询/去重；forge processed 标记。
- [x] credential token hash 形状校验；F004c P3 收口。
- [x] `npm --prefix packages/codeteam-daemon test`、根级 `tsc --noEmit`、
  Biome 通过。
- [ ] 非作者 review（砚砚）与 merge。

## Out of scope

- startup recovery / interrupted run sweep / old-DB backfill / Console M0
  read models（F004e）。
- W2 权限与 operator-only auth enforcement；本 slice 只保存 actor 坐标。
- W3 verifier/resolver；本 slice 记录 evidence refs，不替 W3 判真。
- Console UI（W7）。

## Evidence

- `npm --prefix packages/codeteam-daemon test`：6 个测试文件、66/66 通过。
- `npx tsc --noEmit -p tsconfig.json`：通过。
- `npx biome check --write packages/codeteam-daemon/src/control ...`：clean。
- PR：当前 thread 路由与 review 记录；合入后回写。

## Risk

数据/契约面。无新 migration；使用 F004 schema 的 handoff/waits/approval/
review/merge 表。W1 的 handoff commit 接受一个 verified candidate 后释放
其他 holder claims；parallel holder quorum/outcome 聚合留给 W3/W5 custody
hardening。状态迁移与 operator-only 授权仍在 store/app 层，W2/W3 下沉。

[宪宪/deepseek-flash🐾]
