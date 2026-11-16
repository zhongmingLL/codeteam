---
name: codeteam-review
description: Review a codeteam change for risk-matched evidence, scope, and truth-source accuracy.
triggers: ["review request", "PR review", "before merge"]
---

# codeteam review

- Read the feature doc, `docs/SOP.md`, and the matching reuse card before judging the diff.
- Every finding states severity and stance: approve, or block with a reason.
- Verify targeted commands yourself; do not restate the author's evidence as your own.
- Check that upstream divergences are recorded and no unrecorded kernel patch exists.
- After a fix, re-review only the delta instead of re-opening settled scope.
