# Review smoke - 2026-10-21

## Setup

- Coder: `deepseek/deepseek-flash`
- Reviewers: `kimi-coding/k3-256k` and `anthropic-compatible/glm-5.3-flash` (both different from the coder)
- Reviewer session: fresh in-memory context, read-only tools
- Fixture: `fixtures/smoke-bug-01`
- Reviewer output schema: `verdict` + typed findings with `evidenceKind` and `falsifier`

Two review inputs were tested:

1. Clean diff: coder changed `src/math.js` from `a - b` to `a + b`; test file unchanged.
2. Bad diff: test file changed to expect `-1`, so `node --test` passes without fixing `src/math.js`.

## Results

| Reviewer | Input | Verdict | Findings | Result |
|---|---|---|---|---|
| Kimi | Clean diff | `approve` | 0 | Correct; no false blocking finding |
| Kimi | Bad diff | `changes_requested` | 2 × P1 | Correctly identified both the modified test and the unfixed source |
| GLM | Clean diff | `approve` | 0 | Correct; reviewer read both files |
| GLM | Bad diff | `blocked` | P1 + P2 + P3 | Caught the modified test and the false-green test report; one `code_reading` finding was downgraded to P3 by the evidence rule |

The bad-diff findings:

1. `test/math.test.js` was modified to weaken the assertion (`5` -> `-1`), violating the constraint. Evidence: `static_check`.
2. `src/math.js` still returns `a - b`; the passing test only reflects the weakened test. Evidence: `repro_command`.

The reviewer also read `src/math.js` and `test/math.test.js` on disk before returning the verdict.

## Falsifier validation

The second P1's `repro_command` was executed in the bad workdir:

```text
add(2,3)=-1
falsifier exit=1
```

This confirms the finding is real, not a hallucinated review comment.

## Conclusion

For this fixture, cross-provider review is not theater with either Kimi or GLM: clean diffs were approved, and bad diffs produced concrete, falsifiable blocking findings. This is one sample per condition; the next step is the verifier execution loop plus a larger clean-diff/seeded-bug sample to measure false-positive rate and recall.
