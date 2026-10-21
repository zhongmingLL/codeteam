# Phase 2 review reliability evaluation - 2026-10-21

## Setup

- Feature: F001 Phase 2 (`docs/features/F001-codeteam-mvp.md`).
- Reviewer: `kimi-coding/k3-256k`, fresh in-memory reviewer session per case, read-only tools.
- Corpus: 5 samples in `fixtures/review-corpus`; each sample has a clean overlay and a seeded-bug overlay.
- Project tests: `node --test` is green for every clean and bug variant. The seeded bugs are not covered by the project tests.
- Ground truth: one hidden red test per sample. It exits 0 on clean and non-zero on bug. The evaluator runs it in a separate directory, so it never enters the reviewer workdir or the diff.
- Diff: generated from base to variant with `git diff --no-index`; paths normalized to `a/...` and `b/...`.
- Verifier: findings are executed in repro mode in a disposable workdir. The Phase 1 policy remains strict by default; this evaluation opts into repro because the workdirs are disposable.
- Thresholds were registered in `fixtures/review-corpus/manifest.json` before the run: clean FP <= 20%, seeded recall >= 60%, finding survival >= 80%.

## Final run

Command: `node packages/codeteam/src/dev/review-eval.ts`

| Sample | Clean | Seeded bug | Seeded finding |
|---|---|---|---|
| s01-stats-mode | `approve`, 0 findings | `changes_requested`, 2 findings | P1 + P2, both confirmed |
| s02-csv-quotes | `approve`, 0 findings | `changes_requested`, 1 finding | P1 confirmed |
| s03-date-inclusive | `approve`, 0 findings | `changes_requested`, 1 finding | P2 confirmed |
| s04-retry-backoff | `approve`, 1 P3 | `changes_requested`, 1 finding | P1 confirmed |
| s05-lru-cache | `approve`, 1 P3 | `changes_requested`, 1 finding | P2 confirmed |

Summary:

| Metric | Result | Threshold | Status |
|---|---|---|---|
| Clean-diff false-positive rate | 0 / 5 = 0% | <= 20% | pass |
| Seeded-bug recall | 5 / 5 = 100% | >= 60% | pass |
| Finding survival | 5 / 5 = 100% | >= 80% | pass |
| Invalid verdicts | 0 | informational | - |
| Review rounds | 10 (1 per case) | informational | - |
| Tokens | 19,435 input / 8,802 output | informational | - |
| Cost | 0 (catalog reports no cost for this model) | informational | - |

The P3 findings on the clean s04 and s05 cases are non-blocking and are not false positives under the registered rule (FP means a P1/P2 on a clean diff).

## Harness fixes found during the evaluation

The first runs exposed real harness and corpus defects. They were fixed before the final run; the thresholds were not changed.

- The ground-truth red test was initially copied into the reviewer workdir, so it appeared in the diff and could be read by the reviewer. It now runs in a separate reference directory.
- Grep-based findings were labeled `code_reading`, so the parser downgraded P1/P2 to P3. The review prompt now maps grep/rg/diff/ls/cat falsifiers to `static_check`.
- Some grep falsifiers contained unquoted `<` or `;`, or used regex where a literal was intended. The prompt now requires `grep -F` with the exact source text in single quotes.
- The parser rejected a finding whose `falsifierExpected` was an empty string, which discarded the whole verdict. Empty `falsifierExpected` is now treated as absent.
- The s03 clean sample returned a single day for reversed ranges; the clean and bug variants now return `[]`.
- The s02 clean sample entered quoted mode on a mid-field quote; the clean and bug variants now treat a non-leading quote literally.

## Caveats

- One reviewer model was measured. Cross-provider comparison is not part of this run.
- Each case was reviewed once. The iterative implement -> review -> fix -> re-review loop is Phase 3.
- Five samples per condition is a small sample; rate estimates are noisy. Earlier runs showed one invalid verdict and different clean-case findings before the harness fixes.
- Cost is reported as 0 because the model catalog has no price for this provider; token counts are the useful cost proxy.
