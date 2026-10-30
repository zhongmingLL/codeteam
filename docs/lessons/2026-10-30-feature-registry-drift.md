---
title: "Feature registry drift across W1–W7"
doc_kind: lesson
status: active
created: 2026-10-30
updated: 2026-10-30
feature: F015
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
---

# Feature registry drift across W1–W7

## LL-010: A plan can execute without ever registering its feature

- **Observed**: F015 was used as the feature id inside
  `docs/plans/0017-a2a-e2e-foundation.md`, which landed with the implementation
  PR #72 (`b941dde32`), but no `docs/features/F015-*.md` existed and BACKLOG had
  no F015 row until the backfill PR #75. The same pattern produced the F004–F014
  feature docs while BACKLOG stayed at F003; `docs/README.md` also missed
  F010/F011/F012/F014/F015.
- **Root cause**: the work entered as "continue W7a / close the A2A readiness
  gap", not as "a new feature". The `feat-lifecycle` kickoff trigger is
  new-feature shaped, so plan continuation bypassed F registration. Plans and
  reports were the working truth; feature docs were written at
  implementation/close time, and the index row was never part of the kickoff
  artifact. A plan-local `feature: F015` label looked like registration, but no
  canonical feature doc or index row existed behind it.
- **Guardrail**: before implementation, the kickoff commit must contain the plan
  + `docs/features/Fxxx-*.md` + BACKLOG row + `docs/README.md` entry. A plan that
  declares `feature: Fxxx` must resolve to an existing top-level feature doc and
  BACKLOG row. `npm run check:doc-index` enforces the registry half mechanically;
  the kickoff rule covers the timing half.
- **Scope**: feature lifecycle / intake.

## LL-011: Index maintenance without a completeness check is invisible drift

- **Observed**: BACKLOG was last touched on 2026-10-27 (F003 close) and stayed
  there through F004–F015. `docs/README.md` drifted in parallel. No PR check
  failed, because the merge gate asked "does the change overclaim feature
  status?", not "is every feature present in the indexes?". The gap was found by
  the operator, not by a gate.
- **Root cause**: four overlapping truth surfaces (`docs/plans/README.md`,
  `docs/features/`, `BACKLOG.md`, `docs/README.md`) had no single completeness
  owner. Each implementation PR updated the surfaces it happened to touch. The
  generic `feat-lifecycle` completion step removes done rows and calls
  `pnpm check:features`, while codeteam keeps a full index and has no
  `check:features` script; that semantic conflict made BACKLOG look like a
  shared/hot layer that nobody owned. A policy added after the fact (PR #75) is
  not a gate.
- **Guardrail**: `scripts/check-doc-index.mjs` is wired into `npm run check` and
  the CI `build-check-test` job. It fails when a top-level feature doc lacks a BACKLOG row, a
  feature doc lacks a `docs/README.md` entry, a BACKLOG link is broken, or a plan
  `feature: Fxxx` has no feature doc/BACKLOG row. Close records must cite the
  check output.
- **Scope**: documentation truth / CI.

## Why the author missed it

- I read the plan/report and the feature doc for the task I was executing, but I
  never queried BACKLOG as a completeness check. The task-local truth looked
  complete, so the global index never entered my working set.
- `docs/README.md` was updated per-PR only when remembered; it was not a
  required artifact of the PR.
- At close I checked AC evidence and vision, not registry consistency. The merge
  gate's truth check was about overclaiming, not omissions.
- The generic skill's remove-done-row rule made BACKLOG feel like a hot layer
  owned by someone else. The codeteam full-index override existed only after the
  drift was found, so the default behavior during W1–W7 was ambiguity.

[宪宪/deepseek-flash🐾]
