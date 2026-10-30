---
topics: [backlog]
doc_kind: note
created: 2026-10-25
---

# Feature Roadmap

> **Rules**: Index of all project Features (idea/spec/in-progress/review/done); status is current truth.
> Details in `docs/features/Fxxx-*.md`.
> New feature: allocate the next `Fxxx`, create `docs/features/Fxxx-*.md`, and add a BACKLOG row before implementation.
> Done features keep their row (status done); do not remove them at close. See `AGENTS.md` for the codeteam override of the generic feat-lifecycle removal step.

| ID | Name | Status | Owner | Link |
|----|------|--------|-------|------|
| F001 | codeteam 架构 v1 | review | 宪宪 | [F001](docs/features/F001-architecture-v1.md) |
| F002 | W0a 下游基线与运行时能力验证 | done (cvo signoff) | 宪宪 | [F002](docs/features/F002-w0a-foundation-gate.md) |
| F003 | W0c daemon 最小生命周期 | done | 宪宪 | [F003](docs/features/F003-w0c-daemon-lifecycle.md) |
| F004 | W1 控制面数据模型 | done (operator confirmed) | 宪宪 | [F004](docs/features/F004-w1-control-plane-data-model.md) |
| F005 | W2 权限、身份与沙箱 | done (operator confirmed) | 宪宪 | [F005](docs/features/F005-w2-identity-sandbox.md) |
| F006 | W3 独立 Review 证据链 | done (operator confirmed) | 宪宪 | [F006](docs/features/F006-w3-independent-review.md) |
| F007 | W4 SOP 复用与点状 Gate | done (operator confirmed) | 宪宪 | [F007](docs/features/F007-w4-sop-gates.md) |
| F008 | W5a A2A 投递与球权内核 | done | 宪宪 | [F008](docs/features/F008-w5a-a2a-dispatch-custody.md) |
| F009 | W5b RPC Worker Runtime | done | 宪宪 | [F009](docs/features/F009-w5b-rpc-worker-runtime.md) |
| F010 | W5c 调度、资源与 F139 | done | 宪宪 | [F010](docs/features/F010-w5c-scheduling-resources.md) |
| F011 | W5d daemon lifecycle / deployment wait / managed work | done | 宪宪 | [F011](docs/features/F011-w5d-runtime-lifecycle-managed-work.md) |
| F012 | W6a Memory / Evidence 回源 | done | 宪宪 | [F012](docs/features/F012-w6a-memory-evidence.md) |
| F013 | W6c Observability / Trajectory | done | 宪宪 | [F013](docs/features/F013-w6c-observability-trajectory.md) |
| F014 | W6b Eval / Outcome / Harness Eval | done | 宪宪 | [F014](docs/features/F014-w6b-eval-outcome-harness-eval.md) |
| F015 | A2A E2E Foundation | done | 宪宪 | [F015](docs/features/F015-a2a-e2e-foundation.md) |
| F016 | W7a headless API / 事件重放 + Console M0 | planned (scope signoff pending) | 宪宪 | [plan 0004 §W7](docs/plans/0004-w5-w8-scale-product.md) |

> F016 是 W7a 的预留 feature 号；feature 文档在 W7a scope signoff 后创建。
