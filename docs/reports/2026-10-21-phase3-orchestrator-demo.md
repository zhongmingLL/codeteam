# Phase 3 typed handoff orchestrator demo - 2026-10-21

## Setup

- Seeded bug: `fixtures/review-corpus/samples/s01-stats-mode/bug` (mode returns the maximum value and mutates its input).
- Coder: `deepseek/deepseek-flash`.
- Reviewer: `kimi-coding/k3-256k`, fresh in-memory reviewer session for every review round.
- Verifier: Phase 1 verifier in repro mode, disposable workdirs. The reviewer never sees the ground-truth red test.
- Control plane: `ControlPlane` with 30-minute handoff deadlines and loop limit 10.
- Runner: `packages/codeteam/src/dev/phase3-demo.ts`.

## Flow

The orchestrator used seven typed handoffs and the stage machine `implement -> review -> verify -> implement -> review -> verify`.

| # | Kind | From -> To | Status |
|---|---|---|---|
| 1 | `handoff` | human -> coder | consumed |
| 2 | `review_request` | coder -> reviewer | consumed |
| 3 | `verdict` | reviewer -> verifier | consumed |
| 4 | `verdict` | reviewer -> coder | consumed |
| 5 | `review_request` | coder -> reviewer | consumed |
| 6 | `verdict` | reviewer -> verifier | consumed |
| 7 | `review_request` | verifier -> human | pending (merge gate) |

The first review raised two blocking findings and one non-blocking finding:

1. P1: `mode()` returns the last element after sorting, i.e. the maximum, not the most frequent value.
2. P2: `mode()` mutates the caller's array through in-place `values.sort(...)`.
3. P3: the new `mode()` has no test coverage.

The verifier confirmed the two blocking findings on the initial (buggy) revision:

- `grep -F -n 'return values[values.length - 1];' src/stats.js` -> exit 0 (confirmed)
- `grep -F -n 'values.sort((a, b) => a - b);' src/stats.js` -> exit 0 (confirmed)

The coder fixed `src/stats.js` without modifying tests. The second review approved. The verifier then re-ran the same falsifiers on the fixed revision:

- both blocking falsifiers -> exit 1, closed as `resolved`
- the P3 test-coverage finding remains explicitly open: one `code_reading` finding is `blocked`, one static check is `still_confirmed`

The task stops at `verify` with a pending human merge handoff. It is not auto-merged.

## Result

- Outcome: `awaiting_merge`.
- Review rounds: 2.
- Author instance: `coder:deepseek:ffc74527-e4b4-417a-bdc3-4a985300c6b7`.
- Reviewer instance: `reviewer:kimi:b9239ef3-3cb9-4da7-95ac-0a37688496b8`.
- The reviewer instance differs from the author instance; each review used a fresh session.
- P1/P2: both `resolved` by evidence.
- P3: `blocked` / `still_confirmed`, non-gating and recorded for follow-up.
- Merge handoff: `handoff-7`, pending.

Raw result: `docs/reports/2026-10-21-phase3-orchestrator-demo.json`.

## Verification

- `npm run check` passes.
- 66 codeteam tests pass, including 7 orchestrator tests and 5 finding-closure tests.
- The orchestrator tests cover the happy path, author self-review rejection, verifier blocked, still-confirmed findings, review-loop limit, approve-first, and P3 closure.

## Caveats

- P3 findings are recorded and explicitly closed as blocked or still-confirmed, but they do not gate the merge. Only P1/P2 gate.
- The coder was told not to modify tests, so the test-coverage P3 remains open by design.
- One seeded sample and one coder/reviewer model pair were used. This demonstrates the handoff loop, not a statistical result.
- The human merge gate is intentionally pending; the demo does not merge.
