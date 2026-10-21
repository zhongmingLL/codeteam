# F001: codeteam MVP - control plane, verifier, review gates

Status: draft, awaiting operator sign-off
Owner: 宪宪 (architect/coder)
Reviewers: 砚砚 (review/security), 烁烁 (kernel/runtime)
Acceptance: co-creator

## Why

The first codeteam implementation was run as an architecture spike plus direct coding. It produced a working control plane, provider smoke, and review smoke, but it did not have a feature contract, phase acceptance criteria, a non-author code review gate, or a visible stage board. That is why the SOP appeared to break: the work was real, but it was not routed through the SOP.

This feature converts the agreed MVP into an enforceable delivery unit:

- phases with concrete acceptance criteria
- a named owner and non-author reviewers
- review and acceptance gates
- explicit operator-only decisions

Reference plan: `docs/plans/0001-mvp.md`.

## Scope

codeteam MVP on the pi v1.3.0 downstream fork:

1. Control plane and role-scoped pi sessions (Phase 0, implementation done).
2. Verifier falsifier execution with a permission wrapper (Phase 1).
3. Clean-diff/seeded-bug evaluation with FP/recall gates (Phase 2).
4. Deterministic SOP and typed A2A handoff orchestration (Phase 3).
5. CI and one external interface adapter (Phase 4).

## Non-goals

- TUI, ACP, multi-task scheduler, plugin marketplace, or auto-merge in this feature.
- Replacing pi's agent loop or rewriting its tool/session layer.
- Storing a generic chat/message entity in codeteam's data model.

## Phases and acceptance criteria

### Phase 0 - control plane and provider smoke (implementation done)

Delivered:

- SOP handoff primitive with single-slot CAS, one terminal per run, deadline, loop guard, and crash recovery.
- SQLite control store with hydrate.
- Role-scoped `createAgentSession` adapter.
- Review verdict schema/parser and cross-provider review smoke.
- `fixtures/smoke-bug-01`.

Acceptance:

- `npm run check` passes.
- codeteam tests pass (currently 19).
- DeepSeek, Kimi, and GLM each complete the fixture task; test file unchanged.
- Kimi and GLM reviewers both approve a clean diff and reject a bad diff with blocking findings.

### Phase 1 - verifier and permission wrapper (next)

Deliver:

- A verifier runner that executes only findings with executable evidence (`red_test`, `repro_command`, `static_check`).
- Tool/permission policy: worktree containment, command allowlist, timeout, output cap, minimal env, audit log (full args + truncated output).
- Finding closure states: evidence confirmed, evidence rejected, or blocked; no reviewer re-review loop.

Acceptance:

- Dangerous commands and path escapes are rejected by tests.
- A bad-diff finding's falsifier is executed and its exit code/output is recorded.
- The verifier cannot modify source files.
- A finding is closed only by evidence.

### Phase 2 - review reliability sample

Deliver:

- 5 clean diffs and 5 seeded bugs, each with ground truth and a red test.
- FP rate, recall, finding survival, review rounds, and cost metrics.

Acceptance:

- Clean-diff FP rate <= 20%.
- Seeded-bug review recall >= 60%.
- Finding survival >= 80%.
- Thresholds are registered before the run, not adjusted after seeing results.

### Phase 3 - SOP and A2A integration

Deliver:

- Deterministic workflow transitions with typed `spec_change` / `plan_revision` edges.
- Handoff-driven implement -> review -> verify loop.
- Non-author review and human merge gate.

Acceptance:

- One seeded bug runs end-to-end through typed handoffs.
- Reviewer is a different agent instance with fresh context.
- Illegal transitions and author self-review are rejected.
- Every finding is closed by a falsifier or explicitly blocked.

### Phase 4 - interface and CI

Deliver:

- One external adapter (CLI or daemon/JSON events; ACP later).
- CI for check and codeteam tests.
- Remote branch workflow that does not depend on a force push.

Acceptance:

- CI passes on the default branch.
- A new commit is pushed without history replacement.
- The adapter can run the Phase 3 demo.

## Review gates

- Design gate: this document plus the architecture plan require operator sign-off before Phase 1 starts.
- Phase review: author implements; a non-author reviewer reviews the phase diff and evidence. P1/P2 fixes are re-reviewed by the same reviewer. No self-merge.
- Feature acceptance: operator runs the demo and checks the phase acceptance criteria. Local test-green alone is not acceptance.
- Operator-only decisions: scope changes, remote history replacement, default branch changes, destructive operations, and auto-merge policy.

## Current baseline

- Remote: `zhongmingLL/codeteam`, default branch `codeteam`, root snapshot `fd8ba44`.
- Local work branch: `codeteam-work` from `origin/codeteam`.
- Local `codeteam` branch retains the pi v1.3.0 parent history at `def9bdc`.
- Current checks: `npm run check`, 19 codeteam tests, 3/3 provider live smoke, Kimi/GLM review smoke.
- Reports: `docs/reports/2026-10-21-gate-b-smoke.md`, `docs/reports/2026-10-21-review-smoke.md`.

## Risks and blockers

- Permission wrapper is the highest-risk Phase 1 item; it must be tested before any real-repo use.
- Review FP/recall is currently one sample per condition; Phase 2 must expand it.
- Remote history is a snapshot due to the shallow checkout and proxy failures; this does not block feature work, but full history needs a separate operator-approved strategy.
- GLM uses the Anthropic-compatible endpoint; its OpenAI endpoint returns model access denied for this key.
