---
title: "W6b Eval Corpus / Model-Role Matrix Report"
doc_kind: report
status: draft
created: 2026-10-29
updated: 2026-10-29
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
source: "docs/plans/0016-w6b-eval-outcome-harness-eval.md"
---

# W6b Eval Corpus / Model-Role Matrix Report

> **Evidence tier: synthetic fixture only.** This is a pipeline and threshold
> smoke report, not a live model-family conclusion. W6b ships the live reading
> seam (`evals` task outcome episodes + `buildEvalCorpusReport`), but the repo
> contains no live multi-provider corpus yet. Live conclusions require
> composition in W7/dogfood and n>=20 per cell.

## Fixture

- File: `packages/codeteam-daemon/test/fixtures/eval-corpus/observations.json`.
- 2 providers × 2 repos × 10 review cases = 40 synthetic cases (5 clean + 5
  seeded per cell).
- Consumers: `buildEvalCorpusReport({ syntheticObservations, minSample: 20 })`.
- Reproduce: `cd packages/codeteam-daemon && npx vitest --run test/control-eval-episodes.test.ts`.

## Model-role matrix (synthetic)

| provider | model | role | repo | n | clean FP rate | seeded recall | finding survival | blocked |
|---|---|---|---|---:|---:|---:|---:|---:|
| provider-a | glm-5 | reviewer | repo-a | 10 | 0.20 | 0.80 | 0.833 | 0 |
| provider-a | glm-5 | reviewer | repo-b | 10 | 0.00 | 1.00 | 1.000 | 0 |
| provider-b | qwen-3 | reviewer | repo-a | 10 | 0.40 | 0.60 | 0.667 | 1 |
| provider-b | qwen-3 | reviewer | repo-b | 10 | 0.20 | 0.80 | 0.833 | 0 |
| **overall** | — | reviewer | both | 40 | **0.20** | **0.80** | **0.826** | **1** |

Synthetic overall: 20 clean cases, 4 clean false positives; 20 seeded cases,
16 detected; 19 confirmed findings, 4 rejected, 1 blocked.

## Code-domain metrics

| metric | synthetic value | live value |
|---|---:|---|
| episodes | 40 synthetic review cases | 0 |
| merged episodes | n/a | 0 |
| review false-positive rate | 0.20 | null (no live data) |
| finding survival | 0.826 | null (no live data) |
| avg time-to-green | n/a | null |
| avg cost per merged change | n/a | null |
| human intervention rate | n/a | null |

## Warnings

- `no_live_data` — no live task-outcome episodes were present in the window.
- `synthetic_fixture_not_model_conclusion` — synthetic values cannot rank
  providers or model families.
- `below_min_sample` — every cell is n=10 < 20; smoke only.
- `non_ok_episodes_excluded` appears whenever live `insufficient`/`no_data`/
  `degraded` rows are present; those rows never feed quality conclusions.

## What this does not prove

- It does not prove one provider/model is better than another.
- It does not prove live review recall; live recall is `null` because there is
  no seeded ground truth in production episodes.
- It does not replace the W6b contract tests for lifecycle, provenance, or
  secret scanning.

## Live seam

`materializeTaskOutcomeEpisodes()` reads canonical
`tasks/runs/reviews/findings/verifications/merges/budgets/messages`, writes one
`evals` snapshot per task bundle, and keeps W6a `sourceRefs` for drill-down.
`buildEvalCorpusReport({ store })` only includes live episodes whose
`evals.status='ok'`; `insufficient`/`no_data`/`degraded` rows are counted as
excluded. A cell with live n>=20 and a resolvable model family is the first
point where the report allows a descriptive conclusion.

[宪宪/deepseek-flash🐾]
