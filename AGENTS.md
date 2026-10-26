# codeteam project instructions

## Project truth

- This is a downstream mirror of `earendil-works/pi`, pinned at `v1.4.0`.
- `docs/` is the project documentation source of truth. Start with `CODETEAM.md`, `docs/README.md`, `docs/plans/README.md`, and `docs/features/F001-architecture-v1.md`.
- `main` is the pi release baseline. `codeteam-work` is the default development branch. Feature branches are short-lived and target `codeteam-work`; releasing to `main` is a separate PR.
- Never force-push, rewrite `main`, or merge without the applicable review and verification evidence.

## Scope and boundaries

- Product code lives in this repository. Do not write codeteam product code into clowder-ai.
- Prefer `packages/codeteam-*`, extensions, MCP servers, and SDK adapters. Keep the pi kernel read-only unless a reproducible failure is recorded in `KERNEL_GAPS.md`.
- Treat any upstream file change as a downstream divergence; record it in `UPSTREAM.md` and keep the diff minimal.
- Use isolated development and test data only. Never point experiments at production user data.

## Reuse and reference implementation

- Before implementing a capability that reuses Clowder AI, read
  `docs/reuse/REUSE-MATRIX.md` and the matching `docs/reuse/<cell>.md` card.
  The card's `Current truth`, `代码面`, `codeteam mapping`, and risks are the
  implementation contract.
- Read the named Clowder AI source files as a **reference implementation**, not
  as a runtime dependency. Copy the contract and semantics; adapt storage,
  transport, auth, and execution wiring to codeteam.
- Local reference checkout: `${CLOWDER_AI_SOURCE:-/home/ming/agent/clowder-ai}`
  (read-only). This is a local-only path; never embed it in product code, docs,
  CI, or generated artifacts.
- Do not add clowder-ai packages, data stores, credentials, or deployment
  assumptions to codeteam. If the reference needs a Clowder-only prerequisite,
  record it as `unknown` or adapt it; do not import it.
- Record every intentional divergence in the PR. If the divergence changes the
  reuse decision, update the cell card and `REUSE-MATRIX.md`.
- If the card is stale or missing a code path, fix the card first; do not
  silently invent a new implementation.

## Before working

- Read the relevant docs and the current task or backlog item.
- Read `docs/SOP.md` in full before planning or editing. It is the project-local,
  generic Clowder AI development SOP baseline.
- Load the matching Clowder skill when its trigger applies: `feat-lifecycle`,
  `writing-plans`, `worktree`, `tdd`, `debugging`, `quality-gate`,
  `request-review`, `receive-review`, `merge-gate`.
- Keep `docs/SOP.md` generic. codeteam-specific commands, branches and
  constraints belong in this file and `docs/plans/`.
- If this file and `docs/SOP.md` differ on project facts, this file wins.
  Safety, identity, review and irreversible-action boundaries are never relaxed.
- Check `git status` and use an isolated worktree for code changes.
- For pi package work, also read `docs/upstream/pi-development-rules.md`. That file contains upstream pi rules; this file adds codeteam-specific rules.

## Commands

- Install: `NODE_ENV=development npm install --ignore-scripts`.
- Hydrate generated model data from the pinned catalog revision; see `UPSTREAM.md`.
- Build: `NODE_ENV=development npm run build:offline`.
- Test: `NODE_ENV=development ./test.sh`; prefer targeted package tests while iterating.
- Known WSL2 and host deviations: `docs/reports/2026-10-26-pi-v1.4.0-baseline.md`.

## Git and review

- Stage explicit paths. Do not use `git add -A` or `git add .`.
- Do not commit unless the task authorizes it. Do not bypass hooks.
- Every review finding must state severity and stance.
- Docs changes may go direct to `codeteam-work` when reversible. Code changes need risk-matched verification and non-author review.
