# Review corpus

Five small Node.js projects for F001 Phase 2. Each sample has:

- `base/`: the starting project. `node --test` passes.
- `clean/`: an overlay that adds a correct change. `node --test` still passes.
- `bug/`: an overlay that adds a plausible but defective change. `node --test` still passes; the defect is not covered by the project tests.
- `red-test.mjs`: ground-truth falsifier. It exits 0 on `clean` and non-zero on `bug`.

The evaluator materializes `base` plus the selected overlay in a disposable directory, runs `node --test`, generates the diff, and asks a fresh reviewer session to review only the diff and test report.

Thresholds in `manifest.json` are registered before the run:

- clean-diff false-positive rate <= 20%
- seeded-bug recall >= 60%
- finding survival >= 80%

Run the zero-token corpus self-check:

```bash
node packages/codeteam/src/dev/review-eval.ts --check
```

Run the live evaluation (reviewer provider defaults to `kimi`):

```bash
CODETEAM_EVAL_REVIEWER=kimi node packages/codeteam/src/dev/review-eval.ts
```

The dev scripts read `/home/ming/.env` by default. Set `CODETEAM_ENV_FILE` to point at a different model config file.
