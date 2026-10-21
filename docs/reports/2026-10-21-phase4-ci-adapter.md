# Phase 4 CI and adapter - 2026-10-21

## Delivered

- CLI adapter: `packages/codeteam/src/cli.ts`.
  - `node packages/codeteam/src/cli.ts phase3-demo` runs the live Phase 3 demo.
  - `node packages/codeteam/src/cli.ts` prints usage and exits 1.
  - `npm run phase3-demo --workspace=@codeteam/core` is the package script equivalent.
- CI: `.github/workflows/codeteam-ci.yml` runs `npm ci --ignore-scripts`, `npm run hydrate:model-data`, `npm run check`, and the codeteam tests on push/pull request to `codeteam`. The upstream `ci.yml` is left unchanged.
- Branch workflow: `docs/operations/branching.md`. Pushes are fast-forward to `origin/codeteam`; no force push.
- Phase 3 hardening:
  - A coder/reviewer/verifier port exception now creates a typed blocker handoff with `code: "port_error"` and releases the run/handoff.
  - The orchestrator requires the reviewer provider to differ from the coder provider and emits `reviewer_provider_mismatch` otherwise.
  - Added tests for port failure, test-file modification, and same-provider review.
  - Blocker handoffs now record the role that raised them.
  - The demo degrades reviewer prompt/model errors to a `blocked` verdict.

## Adapter run

Command: `node packages/codeteam/src/cli.ts phase3-demo`

- Outcome: `awaiting_merge`.
- Rounds: 2.
- Coder: `deepseek/deepseek-flash`; reviewer: `kimi-coding/k3-256k`.
- Author provider: `deepseek`; reviewer provider: `kimi`.
- P1/P2: both confirmed on the initial revision and resolved after the fix.
- Merge handoff: pending human decision.

Raw result: `docs/reports/2026-10-21-phase4-adapter-demo.json`.

## Verification

- `npm run check` passes.
- 69 codeteam tests pass.
- The CLI usage path and the live adapter path were both exercised.

## Caveats

- CI does not call live model providers; the adapter demo remains a local acceptance run.
- The CI status is recorded after the workflow run on GitHub.
