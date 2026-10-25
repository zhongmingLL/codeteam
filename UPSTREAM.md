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
npm install --ignore-scripts
npm run build:offline
./test.sh
```

These checks prove the upstream build and tests. They do **not** prove the W0a acceptance items: L0 compaction preservation, session export/resume, and the Hub compatibility spike must be verified separately.
