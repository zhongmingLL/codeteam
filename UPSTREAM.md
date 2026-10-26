# Upstream baseline

codeteam is a downstream mirror of the pi monorepo. It is **not** a GitHub-native fork (`isFork=false`); the upstream relationship is maintained through a Git remote.

## Pin

| Item | Value |
|---|---|
| Upstream | `https://github.com/earendil-works/pi` |
| Tag | `v1.4.0` |
| Commit | `4a080252f06caf63a525d7873c5d94d3c23887e0` |
| Release baseline branch | `main` |
| Development branch | `codeteam-work` |
| GitHub visibility | public |

The previous baseline was `v1.3.0` (`71023aec1546d6d677a65669c5665c0927ce0dd0`). It remains the fallback if the W0a L0/session spike fails on `v1.4.0`; a fallback must be recorded in `KERNEL_GAPS.md` with evidence, not silently switched.

## Branch model

- `main`: pinned pi release baseline. Protected; changes arrive through PRs only.
- `codeteam-work`: default development branch for codeteam work.
- `feature/*`: short-lived task branches, one per worktree/task.

## Sync with upstream

```bash
git fetch upstream --tags --prune
git log --oneline main..upstream/main | head -50
```

To move the baseline deliberately:

```bash
git checkout -b sync/pi-vX.Y.Z main
git merge --no-ff vX.Y.Z
# run the baseline checks, update UPSTREAM.md, then open a PR into main
```

Do not merge upstream directly into `codeteam-work` without first updating `main`; the release baseline is the version lock.

## Kernel policy

The kernel is read-only by default. `packages/codeteam-*`, extensions, MCP servers, and SDK adapters are the preferred implementation surfaces. A kernel patch is allowed only when a W0a/W1 spike has a reproducible failure and the patch is recorded in `KERNEL_GAPS.md`.

## Baseline verification

```bash
NODE_ENV=development npm install --ignore-scripts
NODE_ENV=development npm run build:offline
NODE_ENV=development ./test.sh
```

These checks prove the upstream build and tests. They do **not** prove the W0a acceptance items: L0 compaction preservation, session export/resume, and the Hub compatibility spike must be verified separately.

## Downstream divergences

- Root `AGENTS.md`: codeteam project instructions. The pi `v1.4.0` `AGENTS.md` is preserved at `docs/upstream/pi-development-rules.md` and applies to pi package work. Reason: F302 treats an existing root `AGENTS.md` as the canonical project guide and skips generation; keeping pi rules at root would leave codeteam-specific agent instructions unmaterialized.
- `.gitignore`: narrowed the upstream `plans/` rule to `/plans/` so `docs/plans/` is versioned as the project plan truth source; added local agent/tool state directories (`.cat-cafe/`, `.codex/`, `.gemini/`, `.kimi-code/`; `.claude/` was already ignored). Reason: a clean clone must contain the W0–W8 plans, while local agent state must never be committed.
- `.github/workflows/ci.yml`: added `codeteam-work` push/PR triggers, read-only workflow permissions, a blocking supply-chain job, and a pinned-catalog hydrate step before `build:offline`/tests. The empty `codeteam-package-tests` job is deferred to Phase 1, when the first `packages/codeteam-*` package exists. Reason: W0a required checks must cover the development branch without duplicating the full upstream test job or relying on a live model-catalog fetch.
- `package.json` / `packages/coding-agent/package.json`: bumped `undici` to `8.12.3` and overrode gondolin's `undici` to `6.29.1`; regenerated `packages/coding-agent/install-lock` and `package-lock.json`. Reason: fix unaccepted high advisories without a kernel patch.
- `scripts/npm-audit.mjs`: accepted `GHSA-mrhx-c7xc-m3w5` for `zod@3.25.76`, which is directly required only by the unpublished sandbox example (`@anthropic-ai/sandbox-runtime`). This exception needs independent security review before merge and must be revisited before W2 sandbox work or when the example upgrades to zod >= 4.6.6.
- `nix/model-catalog.json`: moved the pinned catalog from `sha256-7fe1b41f...` (v1.4.0 release pin) to `sha256-7604547f...` because the release pin lacks the System One classifier fixtures added in `7f225f25d` (`clef-omni`, `jev-1.14.0`, classifier compat). The new pin hash was verified against the immutable catalog body; targeted `packages/ai` tests pass after hydration. Reason: keep CI deterministic without a live catalog fetch while matching the v1.4.0 generator/tests.
