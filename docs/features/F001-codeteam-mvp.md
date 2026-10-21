# F001: codeteam MVP - control plane, verifier, review gates

Status: operator-approved; Phase 1 accepted; Phase 2 accepted; Phase 3 reviewer-approved (`42cba12`), awaiting operator acceptance
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
- codeteam tests pass (currently 43 after Phase 1 fixes).
- DeepSeek, Kimi, and GLM each complete the fixture task; test file unchanged.
- Kimi and GLM reviewers both approve a clean diff and reject a bad diff with blocking findings.

### Phase 1 - verifier and permission wrapper (operator-accepted)

Implementation: `packages/codeteam/src/verifier`. Review found 2 P1 and 4 P2. Fixes in `659c6a6` were approved by the same non-author reviewer after 23 independent probes; 6/6 P1/P2 findings are closed.

Backlog carried forward: P3-1 residual (oversized output still returns `blocked`), P3-3 parser fail-closed, per-executable flag allowlist upgrade, and hardlink residual. The last two are Phase 4 sandbox work.

Operator accepted Phase 1 on 2026-10-21.

Deliver:

- A verifier runner that executes only findings with executable evidence (`red_test`, `repro_command`, `static_check`).
- Strict mode: read-only commands only; no Node execution.
- Repro mode: read-only commands plus `node --test` only; `node -e`, `--eval`, and code-loading flags are blocked.
- Tool/permission policy: worktree + realpath containment, per-executable dangerous flag policy, nested secret path checks, timeout, output cap, minimal env, audit log (full args + truncated output).
- Finding closure states: evidence confirmed, evidence rejected, or blocked; no reviewer re-review loop.

Acceptance:

- Dangerous commands and path escapes are rejected by tests.
- A bad-diff finding's falsifier is executed and its exit code/output is recorded.
- Verifier tool surface exposes no write primitives; strict mode executes no Node. Repro mode allows `node --test` only in a disposable worktree and is opt-in. Test code can still write/network; this is a known boundary until Phase 4 OS sandbox/low-privilege user, and the verifier must not be enabled on a real repo before that.
- A finding is closed only by evidence.

### Phase 2 - review reliability sample (operator-accepted)

Deliver:

- 5 clean diffs and 5 seeded bugs, each with ground truth and a red test.
- FP rate, recall, finding survival, review rounds, and cost metrics.

Acceptance:

- Clean-diff FP rate <= 20%.
- Seeded-bug review recall >= 60%.
- Finding survival >= 80%.
- Thresholds are registered before the run, not adjusted after seeing results.

Result (2026-10-21): 5 clean + 5 seeded samples, reviewer `kimi-coding/k3-256k`. Clean FP 0/5 = 0%, seeded recall 5/5 = 100%, finding survival 5/5 = 100%, 0 invalid verdicts, 10 review rounds, 19,435 input / 8,802 output tokens. Report: `docs/reports/2026-10-21-phase2-review-eval.md`.

Reviewer 砚砚 approved `83bdf20` after `npm run check`, 19/19 scoring/parser tests, and 10/10 corpus self-check cases. P3 follow-ups: configurable env file, archived raw result, stricter recall matching, and real review rounds in Phase 3.

Operator accepted Phase 2 on 2026-10-21.

### Phase 3 - SOP and A2A integration (reviewer-approved, awaiting operator acceptance)

Deliver:

- Deterministic workflow transitions with typed `spec_change` / `plan_revision` edges.
- Handoff-driven implement -> review -> verify loop.
- Non-author review and human merge gate.

Acceptance:

- One seeded bug runs end-to-end through typed handoffs.
- Reviewer is a different agent instance with fresh context.
- Illegal transitions and author self-review are rejected.
- Every finding is closed by a falsifier or explicitly blocked.

Result (2026-10-21): the `s01-stats-mode` seeded bug ran through 7 typed handoffs (`implement -> review -> verify -> implement -> review -> verify`), 2 review rounds. The reviewer instance differed from the author; P1/P2 were resolved by falsifiers; P3 findings were recorded as blocked/still-confirmed and are non-gating. The task stops at a pending human merge handoff. Report: `docs/reports/2026-10-21-phase3-orchestrator-demo.md`.

Reviewer 烁烁 approved `42cba12` after `npm run check` and 66/66 tests. Two P2 hardening items moved to Phase 4: a port exception should create a typed blocker handoff, and coder/reviewer provider inequality should be enforced or validated.

### Phase 4 - interface and CI

Carryover hardening from Phase 3 review:

- On a coder/reviewer/verifier port exception, create a typed blocker handoff before rethrowing.
- Enforce or validate that the reviewer provider differs from the coder provider.
- Add orchestrator tests for port failure and test-file modification; fix blocker `fromRole`; degrade reviewer prompt errors to a blocked verdict.

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
- Review routing: serial handoffs use a line-start `@cat` on its own line; that is the wake. In this thread, Multi-Mention aggregation output arrived as an external message and did not wake the author, so `multi_mention` is reserved for parallel fan-out, not serial review dispatch.

## Current baseline

- Remote: `zhongmingLL/codeteam`, default branch `codeteam`, root snapshot `fd8ba44`.
- Local work branch: `codeteam-work` from `origin/codeteam`.
- Local `codeteam` branch retains the pi v1.3.0 parent history at `def9bdc`.
- Current checks: `npm run check`, 66 codeteam tests, 3/3 provider live smoke, Kimi/GLM review smoke.
- Phase 2 corpus: `fixtures/review-corpus` (5 samples, clean + seeded variants) is implemented; the final run passed the registered thresholds.
- Reports: `docs/reports/2026-10-21-gate-b-smoke.md`, `docs/reports/2026-10-21-review-smoke.md`, `docs/reports/2026-10-21-phase2-review-eval.md`, `docs/reports/2026-10-21-phase2-review-eval.json`, `docs/reports/2026-10-21-phase3-orchestrator-demo.md`, `docs/reports/2026-10-21-phase3-orchestrator-demo.json`.

## Risks and blockers

- Permission wrapper is the highest-risk Phase 1 item; it must be tested before any real-repo use.
- Review FP/recall is currently one sample per condition; Phase 2 must expand it.
- Remote history is a snapshot due to the shallow checkout and proxy failures; this does not block feature work, but full history needs a separate operator-approved strategy.
- GLM uses the Anthropic-compatible endpoint; its OpenAI endpoint returns model access denied for this key.
